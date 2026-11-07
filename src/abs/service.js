import { randomUUID } from 'node:crypto'

import { createState, updateState, nextReviewAt, applyFeedback, CORE_LIMITS } from './core.js'
import { sanitizeAbsConfig } from './config.js'
import { createAbsClock } from './clock.js'
import { renderSelfReview, driveDemand } from './review.js'

const clone = (value) => structuredClone(value)
const minute = 60000
const id = () => randomUUID()
const iso = (value) => new Date(value).toISOString()

/**
 * Single serialized state owner.
 *
 * The self-review model has no action decision: a wake updates internal state,
 * renders a natural-language self-review and (in active mode) hands that review
 * to the fish's existing conversation. Feedback comes only from observed facts.
 */
export async function createAbsService({ store, host, getConfig, now = Date.now, logger = console, timers = { setTimeout, clearTimeout } }) {
  const restored = store.read()
  const initialReal = now()
  let state = restored ?? createState(iso(initialReal), { ...sanitizeAbsConfig(getConfig()), mode: 'shadow' })
  let queue = Promise.resolve(), closed = false, timer = null, poisoned = false, started = false
  const config = () => sanitizeAbsConfig(getConfig())
  const clock = createAbsClock({
    realNow: now,
    snapshot: state.clock ?? null,
    initialVirtualMs: Math.max(initialReal, Date.parse(state.updatedAt)),
    scale: config().timeScale,
  })

  const startupRecords = []
  if (clock.timeScale !== config().timeScale) {
    const previous = clock.timeScale
    clock.setScale(config().timeScale)
    startupRecords.push({ type: 'ClockScaleChanged', previous, timeScale: clock.timeScale, at: iso(clock.now()), realAt: iso(clock.realNow()), cause: 'startup-config' })
  }
  const legacy = {
    motivations: state.motivations?.length ?? 0,
    executions: state.executions?.length ?? 0,
    proposalIds: state.proposalIds?.length ?? 0,
    history: state.history?.length ?? 0,
  }
  if (legacy.motivations || legacy.executions || legacy.proposalIds || legacy.history) {
    startupRecords.push({ type: 'StateMigrated', at: iso(clock.now()), realAt: iso(clock.realNow()), archived: legacy })
    state.motivations = []
    state.executions = []
    state.proposalIds = []
    state.history = []
  }
  state.mode ??= config().mode
  state.observations ??= []
  state.feedbackKeys ??= []
  state.changeLedger ??= []
  state.nextWakeAt ??= null
  delete state.lastInternalProposalAt
  state.clock = clock.snapshot()
  startupRecords.push({ type: 'Recovery', at: iso(clock.now()), realAt: iso(clock.realNow()), mode: state.mode })
  await store.commit(state, startupRecords)

  function serial(fn) {
    const result = queue.then(() => { if (closed) throw new Error('ABS_CLOSED'); if (poisoned) throw new Error('ABS_STORAGE_UNCERTAIN'); return fn() })
    queue = result.catch(() => {})
    return result
  }
  async function save(records = []) {
    if (poisoned) throw new Error('ABS_STORAGE_UNCERTAIN')
    state.clock = clock.snapshot()
    state.revision = (state.revision ?? 0) + 1
    const realAt = iso(clock.realNow())
    try { await store.commit(state, records.map((record) => ({ realAt, ...record }))) }
    catch (error) { poisoned = true; timers.clearTimeout(timer); throw error }
  }
  function ledger(row) {
    state.changeLedger.push({ realAt: iso(clock.realNow()), ...row })
    state.changeLedger = state.changeLedger.slice(-200)
  }
  function updateWithLedger(at, cfg) {
    const before = Object.fromEntries(Object.entries(state.drives).map(([key, drive]) => [key, drive.satisfaction]))
    updateState(state, at, cfg)
    for (const [driveId, drive] of Object.entries(state.drives)) {
      if (drive.satisfaction !== before[driveId]) ledger({ reason: 'natural_decay', driveId, before: before[driveId], after: drive.satisfaction, delta: drive.satisfaction - before[driveId], timeScale: clock.timeScale })
    }
  }
  async function synchronizeClock() {
    const timeScale = config().timeScale
    if (clock.timeScale === timeScale) return false
    const previous = clock.timeScale
    clock.setScale(timeScale)
    updateWithLedger(iso(clock.now()), config())
    await save([{ type: 'ClockScaleChanged', previous, timeScale, at: iso(clock.now()), realAt: iso(clock.realNow()) }])
    return true
  }
  function clockView() {
    const virtualNow = clock.now(), realNow = clock.realNow()
    const wait = state.mode === 'off' || !state.nextWakeAt ? null : clock.delayUntil(Date.parse(state.nextWakeAt))
    const realWaitMs = wait === null || !Number.isFinite(wait) || realNow + wait > 8640000000000000 ? null : Math.ceil(wait)
    return { timeScale: clock.timeScale, realNow: iso(realNow), virtualNow: iso(virtualNow), paused: clock.timeScale === 0, realWaitMs, nextWakeRealAt: realWaitMs === null ? null : iso(realNow + realWaitMs) }
  }
  function paused() { return clock.timeScale === 0 || config().timeScale === 0 }
  async function syncMode(at, cfg) {
    if (state.mode === cfg.mode) return false
    const previous = state.mode
    state.lastNonOffMode = cfg.mode === 'off' ? previous : cfg.mode
    state.mode = cfg.mode
    if (cfg.mode === 'active') {
      state.activationAllowedAt = iso(Date.parse(at) + cfg.activationCooldownMinutes * minute)
      state.nextWakeAt = state.activationAllowedAt
    }
    await save([{ type: 'ModeChanged', at, previous, mode: cfg.mode, activationAllowedAt: state.activationAllowedAt ?? null }])
    return true
  }
  function reviewDemand() {
    return { social: driveDemand(state.drives.social), curiosity: driveDemand(state.drives.curiosity) }
  }
  function computeNextWake(at, cfg) {
    let next = Date.parse(nextReviewAt(state, at, cfg))
    if (cfg.mode === 'active' && state.activationAllowedAt) {
      const allowed = Date.parse(state.activationAllowedAt)
      if (allowed > Date.parse(at)) next = Math.max(next, allowed)
    }
    const lastReal = state.lastReview?.status === 'delivered' ? Date.parse(state.lastReview.realAt) : null
    if (cfg.mode === 'active' && lastReal !== null && cfg.reviewMinRealGapMinutes > 0) {
      const remaining = cfg.reviewMinRealGapMinutes * minute - (clock.realNow() - lastReal)
      if (remaining > 0) next = Math.max(next, clock.now() + remaining * (clock.timeScale || 0))
    }
    return iso(next)
  }
  function reviewGate(at, cfg, manual) {
    if (cfg.mode !== 'active') return { due: false, reason: cfg.mode === 'shadow' ? 'SHADOW_PREVIEW_ONLY' : 'ABS_OFF' }
    if (state.activationAllowedAt && Date.parse(state.activationAllowedAt) > Date.parse(at)) return { due: false, reason: 'ACTIVATION_COOLDOWN' }
    if (!manual && state.nextWakeAt && Date.parse(state.nextWakeAt) > Date.parse(at)) return { due: false, reason: 'NOT_DUE' }
    return { due: true, reason: 'DUE' }
  }
  function arm() {
    timers.clearTimeout(timer)
    if (!started || closed || poisoned) return
    const cfg = config()
    const untilDue = clock.timeScale === 0 || cfg.mode === 'off' ? null : state.nextWakeAt ? clock.delayUntil(Date.parse(state.nextWakeAt)) : 0
    // Convert the ABS deadline back to a real delay; never queue a burst of missed reviews.
    const delay = cfg.timeScale !== clock.timeScale || cfg.mode !== state.mode ? 250 : Math.max(250, Math.min(30000, untilDue ?? 30000))
    timer = timers.setTimeout(() => {
      if (closed) return
      const latest = config(), due = !state.nextWakeAt || Date.parse(state.nextWakeAt) <= clock.now()
      if (state.mode !== latest.mode || (latest.mode !== 'off' && latest.timeScale > 0 && due)) {
        void service.wake('timer').catch((error) => logger.warn?.('[abs] wake failed', error)).finally(arm)
      } else if (latest.timeScale !== clock.timeScale) {
        void service.syncClock().catch((error) => logger.warn?.('[abs] clock update failed', error)).finally(arm)
      } else arm()
    }, delay)
    timer?.unref?.()
  }
  function preview() {
    return { realAt: iso(clock.realNow()), text: renderSelfReview({ state }), demand: reviewDemand() }
  }
  async function ingestObservation(observation) {
    return serial(async () => {
      await synchronizeClock()
      const cfg = config()
      const at = iso(clock.now()), realAt = observation.at
      const key = `obs:${observation.kind}:${observation.sessionId}:${observation.seq}`
      if (state.feedbackKeys.includes(key)) return false
      const records = [{ type: 'Observation', at, realAt, observation: clone(observation) }]
      updateWithLedger(at, cfg)
      const driveId = observation.kind === 'owner_message' ? 'social' : 'curiosity'
      const before = state.drives[driveId].satisfaction
      let feedback = null, reason = observation.result ?? observation.kind
      if (observation.kind === 'owner_message') {
        state.lastOwnerMessage = { at, realAt }
        feedback = applyFeedback(state, { driveId: 'social', delta: cfg.feedback.ownerMessageGain, key, at, config: cfg })
      } else if (observation.kind === 'exploration') {
        if (observation.result !== 'unverified_activity') state.lastExploration = { resultKind: observation.result, at, realAt, sources: observation.sources ?? 0, activity: observation.activity }
        if (observation.result === 'explore_content_found') {
          feedback = applyFeedback(state, { driveId: 'curiosity', delta: cfg.feedback.explorationGain, key, at, config: cfg })
        } else if (observation.result === 'local_content_found') {
          const evidenceKey = `evidence:${observation.evidenceKey}`
          const turnKey = `local-turn:${observation.sessionId}:${observation.turn}`
          if (!/^[a-f0-9]{64}$/.test(observation.evidenceKey ?? '') || !Number.isSafeInteger(observation.turn)) reason = 'unverified_activity'
          else if (state.feedbackKeys.includes(evidenceKey)) reason = 'duplicate_evidence'
          else if (state.feedbackKeys.includes(turnKey)) reason = 'local_turn_limit'
          else if (state.feedbackKeys.length + 3 > CORE_LIMITS.maxDedupeIds) reason = 'feedback_capacity'
          else {
            feedback = applyFeedback(state, { driveId: 'curiosity', delta: cfg.feedback.explorationGain, key, at, config: cfg })
            if (feedback) state.feedbackKeys.push(evidenceKey, turnKey)
          }
        }
      }
      if (!feedback && state.feedbackKeys.length < CORE_LIMITS.maxDedupeIds) state.feedbackKeys.push(key)
      if (feedback) state.drives[feedback.driveId].lastFeedbackRealAt = realAt
      const after = state.drives[driveId].satisfaction
      if (!feedback && state.feedbackKeys.length >= CORE_LIMITS.maxDedupeIds) reason = 'feedback_capacity'
      ledger({ realAt, reason, driveId, before, after, delta: after - before, activity: observation.activity, observationId: key })
      state.observations.push({ id: key, kind: observation.kind, resultKind: observation.result ?? null, at, realAt, sources: observation.sources ?? 0, activity: observation.activity, feedbackDelta: after - before, feedbackReason: reason })
      state.observations = state.observations.slice(-CORE_LIMITS.maxObservations)
      if (feedback) records.push({ type: 'FeedbackApplied', at, driveId: feedback.driveId, delta: after - before, requestedDelta: feedback.delta, effectKey: feedback.effectKey, source: observation.kind })
      await save(records)
      return true
    }).finally(arm)
  }
  const unsubscribeObservation = host.subscribeObservation?.((observation) => {
    void ingestObservation(observation).catch((error) => logger.warn?.('[abs] observation failed', error))
  })

  const service = {
    inspect: () => {
      return {
        ...clone(state),
        clock: clock.snapshot(),
        clockView: clockView(),
        reviewPreview: renderSelfReview({ state }),
        storageUncertain: poisoned,
        running: !closed,
        config: config(),
        permissionMode: 'existing-full-access',
      }
    },
    preview,
    environment: () => host.environment(),
    syncClock() { return serial(async () => { await synchronizeClock(); return clockView() }).finally(arm) },
    async records(limit = 200) { return store.records({ limit: Math.min(1000, Math.max(1, Number(limit) || 200)) }) },
    wake(cause = 'manual') {
      return serial(async () => {
        await synchronizeClock()
        let at = iso(clock.now()), realAt = iso(clock.realNow())
        const cfg = config(), wakeId = id()
        await syncMode(at, cfg)
        if (cfg.mode === 'off') return { wakeId, mode: 'off', reason: 'ABS_OFF' }
        if (paused()) return { wakeId, mode: cfg.mode, reason: 'TIME_PAUSED' }
        updateWithLedger(at, cfg)
        at = iso(clock.now()); realAt = iso(clock.realNow())
        const manual = cause === 'manual'
        const gate = reviewGate(at, config(), manual)
        const records = [{ type: 'WakeRecord', wakeId, cause, at, mode: cfg.mode, gate: gate.reason }]
        let result = { wakeId, mode: cfg.mode, delivered: false, reason: gate.reason }
        if (gate.due) {
          const reviewId = id()
          const reviewText = renderSelfReview({ state })
          // Re-check pause/mode after rendering and before the real model turn.
          if (paused() || config().mode !== 'active') {
            records.push({ type: 'ReviewSkipped', at: iso(clock.now()), wakeId, reason: paused() ? 'TIME_PAUSED' : 'MODE_NOT_ACTIVE' })
            result = { wakeId, reviewId, delivered: false, reason: paused() ? 'TIME_PAUSED' : 'MODE_NOT_ACTIVE' }
          } else {
            const acceptance = await host.surfaceReview({ text: reviewText, reviewId })
            await synchronizeClock()
            at = iso(clock.now()); realAt = iso(clock.realNow())
            const delivered = acceptance.accepted === true
            state.lastReview = {
              reviewId, at, realAt, status: delivered ? 'delivered' : 'failed',
              sessionId: acceptance.sessionId ?? null,
              messageId: acceptance.messageId ?? null,
              reason: acceptance.reason ?? null,
              demand: reviewDemand(),
              text: reviewText.slice(0, 8000),
            }
            records.push({
              type: delivered ? 'ReviewDelivered' : 'ReviewFailed',
              at, realAt, reviewId, acceptance,
              text: reviewText.slice(0, 2000),
            })
            result = { wakeId, reviewId, delivered, reason: delivered ? 'DELIVERED' : acceptance.reason ?? 'REVIEW_NOT_ACCEPTED' }
          }
        }
        state.nextWakeAt = computeNextWake(at, config())
        records[0].nextWakeAt = state.nextWakeAt
        records[0].nextWakeRealAt = clockView().nextWakeRealAt
        await save(records)
        return result
      }).finally(arm)
    },
    start() { started = true; arm() },
    async close() {
      timers.clearTimeout(timer)
      started = false
      closed = true
      unsubscribeObservation?.()
      await queue
      await host.close?.()
      await store.close()
    },
  }
  return service
}
