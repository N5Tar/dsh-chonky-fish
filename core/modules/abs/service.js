import { randomUUID } from 'node:crypto'

import { createState, updateState, nextReviewAt, applyFeedback, CORE_LIMITS } from './core.js'
import { sanitizeAbsConfig } from './config.js'
import { createAbsClock } from './clock.js'
import { restWindow, nextAwakeTime } from './rest.js'
import { renderActionPrompt, driveDemand } from './review.js'
import { selectAbsAction } from './selector.js'

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
export async function createAbsService({ store, activityStore, host, getConfig, readWorkStreak = () => null, now = Date.now, logger = console, timers = { setTimeout, clearTimeout } }) {
  if (!activityStore || ['recordWake','recordEvidence','recordTurn','query','startRuntime','touchRuntime','closeRuntime','recoverOpen','prune','setAnnotation','recordActionSelection','resolveActionSelection','actionContext','markActionVisible','close'].some(name => typeof activityStore[name] !== 'function')) throw new TypeError('ABS activity repository is required')
  if (typeof host.subscribeActivity !== 'function' || typeof host.subscribeObservation !== 'function' || typeof host.boundSessionId !== 'function' || typeof host.surfaceAction !== 'function' || typeof host.setActionSelectionLookup !== 'function') throw new TypeError('ABS host action contract is required')
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
  const boundOwnerSession = host.boundSessionId()
  if (boundOwnerSession) {
    try {
      const records = await store.records({ limit: 2000 })
      const ownerRows = records.filter(row => row?.type === 'Observation' && row.observation?.kind === 'owner_message'
        && row.observation?.sessionId === boundOwnerSession && Number.isFinite(Date.parse(row.realAt)))
      ownerRows.sort((a,b) => Date.parse(a.realAt) - Date.parse(b.realAt))
      const latest = ownerRows.at(-1)
      if (latest && (!state.lastOwnerMessage || state.lastOwnerMessage.sessionId !== boundOwnerSession
          || Date.parse(latest.realAt) > Date.parse(state.lastOwnerMessage.realAt ?? ''))) {
        state.lastOwnerMessage = { at: latest.at, realAt: latest.realAt, sessionId: boundOwnerSession,
          seq: latest.observation.seq, sourceKind: 'user' }
      }
    } catch (error) { logger.warn?.('[abs] could not hydrate bound-session owner interaction from audit metadata', error) }
  }
  startupRecords.push({ type: 'Recovery', at: iso(clock.now()), realAt: iso(clock.realNow()), mode: state.mode })
  await store.commit(state, startupRecords)
  activityStore.recoverOpen()
  host.setActionSelectionLookup({ find: key => activityStore.findActionSelection(key) })
  const activityRuntimeId = activityStore.startRuntime({ at: iso(initialReal) })
  activityStore.prune({ before: iso(initialReal - 180 * 86400000) })
  let lastActivityPruneDay = iso(initialReal).slice(0, 10)
  const activityHeartbeat = setInterval(() => {
    if (closed) return
    try {
      const realAt = clock.realNow()
      activityStore.touchRuntime({ runtimeId: activityRuntimeId, at: iso(realAt) })
      const day = iso(realAt).slice(0, 10)
      if (day !== lastActivityPruneDay) {
        activityStore.prune({ before: iso(realAt - 180 * 86400000) })
        lastActivityPruneDay = day
      }
    }
    catch (error) { logger.warn?.('[abs] activity coverage heartbeat failed', error) }
  }, 60000)
  activityHeartbeat.unref?.()

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
    const target = wait === null || !Number.isFinite(wait) || realNow + wait > 8640000000000000 ? null : nextAwakeTime(realNow + Math.ceil(wait), config().restHours)
    const realWaitMs = target === null ? null : target - realNow
    return { timeScale: clock.timeScale, realNow: iso(realNow), virtualNow: iso(virtualNow), paused: clock.timeScale === 0, rest: restWindow(realNow, config().restHours), realWaitMs, nextWakeRealAt: target === null ? null : iso(target) }
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
    if (restWindow(clock.realNow(), cfg.restHours).resting) return { due: false, reason: 'REST_HOURS' }
    if (cfg.mode === 'off') return { due: false, reason: 'ABS_OFF' }
    if (!manual && state.nextWakeAt && Date.parse(state.nextWakeAt) > Date.parse(at)) return { due: false, reason: 'NOT_DUE' }
    if (cfg.mode === 'shadow') return { due: false, previewDue: true, reason: 'SHADOW_PREVIEW_ONLY' }
    if (state.activationAllowedAt && Date.parse(state.activationAllowedAt) > Date.parse(at)) return { due: false, reason: 'ACTIVATION_COOLDOWN' }
    return { due: true, reason: 'DUE' }
  }
  function arm() {
    timers.clearTimeout(timer)
    if (!started || closed || poisoned) return
    const cfg = config()
    const rest = restWindow(clock.realNow(), cfg.restHours)
    const untilDue = clock.timeScale === 0 || cfg.mode === 'off' ? null : rest.resting ? Date.parse(rest.resumeAt) - clock.realNow() : state.nextWakeAt ? clock.delayUntil(Date.parse(state.nextWakeAt)) : 0
    // Convert the ABS deadline back to a real delay; never queue a burst of missed reviews.
    const delay = cfg.timeScale !== clock.timeScale || cfg.mode !== state.mode ? 250 : Math.max(250, Math.min(30000, untilDue ?? 30000))
    timer = timers.setTimeout(() => {
      if (closed) return
      const latest = config(), due = !state.nextWakeAt || Date.parse(state.nextWakeAt) <= clock.now()
      if (state.mode !== latest.mode || (latest.mode !== 'off' && latest.timeScale > 0 && due && !restWindow(clock.realNow(), latest.restHours).resting)) {
        void service.wake('timer').catch((error) => logger.warn?.('[abs] wake failed', error)).finally(arm)
      } else if (latest.timeScale !== clock.timeScale) {
        void service.syncClock().catch((error) => logger.warn?.('[abs] clock update failed', error)).finally(arm)
      } else arm()
    }, delay)
    timer?.unref?.()
  }
  function selectAction({ mode = config().mode, realAt = clock.realNow(), sessionId = host.boundSessionId() } = {}) {
    const context = sessionId ? activityStore.actionContext() : { remindedWorkStreakIds: [] }
    let workStreak = null
    try { workStreak = readWorkStreak() } catch (error) { logger.warn?.('[abs] work streak unavailable', error) }
    return selectAbsAction({ now: realAt, mode,
      currentSessionId: sessionId,
      ownerInteraction: state.lastOwnerMessage?.sourceKind === 'user' ? state.lastOwnerMessage : null,
      socialGap: reviewDemand().social, curiosityGap: reviewDemand().curiosity,
      workStreak, remindedWorkStreakIds: context.remindedWorkStreakIds })
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
        state.lastOwnerMessage = { at, realAt, sessionId: observation.sessionId, seq: observation.seq, sourceKind: 'user' }
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
  async function ingestActivity(activity) {
    return serial(async () => {
      if (activity.kind === 'activity_visible' && activity.reviewId && activity.sessionId && activity.selectionId) {
        await activityStore.markActionVisible({ selectionId: activity.selectionId, reviewId: activity.reviewId, sessionId: activity.sessionId, turn: activity.turn, at: activity.at })
      }
      if (activity.kind === 'activity_turn' && activity.reviewId && activity.sessionId) {
      await activityStore.recordTurn({ reviewId: activity.reviewId, sessionId: activity.sessionId, turn: activity.turn,
          status: activity.turnStatus ?? 'pending', claimStatus: activity.claimStatus ?? 'unknown', inputStatus: activity.inputStatus ?? 'unknown',
          attribution: activity.attribution ?? 'unlinked', diagnostic: activity.turnDiagnostic ?? null })
      }
      if (activity.kind === 'activity_attempt' && activity.reviewId && activity.attribution && activity.sessionId) {
        await activityStore.recordAttempt({ evidenceId: activity.sessionId + ':' + activity.seq, reviewId: activity.reviewId,
          sessionId: activity.sessionId, turn: activity.turn, seq: activity.seq, callId: activity.callId,
          activity: activity.activity, at: activity.at, attribution: activity.attribution })
      }
      if (activity.kind === 'exploration' && activity.reviewId && activity.attribution && activity.sessionId) {
        const status = activity.result === 'failed' ? 'failed'
          : ['unverified_activity','explore_no_usable_content'].includes(activity.result) ? 'unverified' : 'verified'
        await activityStore.recordEvidence({ evidenceId: activity.sessionId + ':' + activity.callSeq, reviewId: activity.reviewId,
          sessionId: activity.sessionId, turn: activity.turn, seq: activity.callSeq, callSeq: activity.callSeq, resultSeq: activity.resultSeq, callId: activity.callId,
          activity: activity.activity ?? 'tool', status, at: activity.at, attribution: activity.attribution, sources: activity.sources ?? 0 })
      }
    })
  }
  const unsubscribeObservation = host.subscribeObservation((observation) => {
    void ingestObservation(observation).catch((error) => logger.warn?.('[abs] observation failed', error))
  })
  const unsubscribeActivity = host.subscribeActivity((activity) => {
    void ingestActivity(activity).catch((error) => logger.warn?.('[abs] activity record failed', error))
  })

  const service = {
    inspect: () => {
      return {
        ...clone(state),
        clock: clock.snapshot(),
        clockView: clockView(),
        storageUncertain: poisoned,
        running: !closed,
        config: config(),
      }
    },
    activities: ({ from, to, limit = 100, offset = 0, snapshotAt, snapshotSeq, outcome } = {}) => activityStore.query({ from, to, limit, offset, snapshotAt, snapshotSeq, outcome, now: clock.realNow() }),
    annotateActivity: input => activityStore.setAnnotation({ ...input, at: iso(clock.realNow()) }),
    environment: () => host.environment(),
    syncClock() { return serial(async () => { await synchronizeClock(); return clockView() }).finally(arm) },
    async records(limit = 200) { return store.records({ limit: Math.min(1000, Math.max(1, Number(limit) || 200)) }) },
    wake(cause = 'manual') {
      return serial(async () => {
        await synchronizeClock()
        let at = iso(clock.now()), realAt = iso(clock.realNow())
        const cfg = config(), wakeId = id()
        await syncMode(at, cfg)
        if (cfg.mode === 'off') {
          await activityStore.recordWake({ episodeId: wakeId, wakeAt: realAt, cause, mode: 'off', gateReason: 'ABS_OFF', reviewStatus: 'not_due',
            stateAtWake: { social: state.drives.social.satisfaction, curiosity: state.drives.curiosity.satisfaction } })
          return { wakeId, mode: 'off', reason: 'ABS_OFF' }
        }
        if (paused()) {
          await activityStore.recordWake({ episodeId: wakeId, wakeAt: realAt, cause, mode: cfg.mode, gateReason: 'TIME_PAUSED', reviewStatus: 'skipped',
            stateAtWake: { social: state.drives.social.satisfaction, curiosity: state.drives.curiosity.satisfaction } })
          return { wakeId, mode: cfg.mode, reason: 'TIME_PAUSED' }
        }
        updateWithLedger(at, cfg)
        at = iso(clock.now()); realAt = iso(clock.realNow())
        const manual = cause === 'manual'
        const gate = reviewGate(at, config(), manual)
        const records = [{ type: 'WakeRecord', wakeId, cause, at, mode: cfg.mode, gate: gate.reason }]
        let result = { wakeId, mode: cfg.mode, delivered: false, reason: gate.reason }
        let activityEpisode = { episodeId: wakeId, wakeAt: realAt, cause, mode: cfg.mode, gateReason: gate.reason,
          reviewStatus: gate.due ? 'pending' : 'not_due', turnStatus: 'unknown', claimedStatus: gate.due ? 'pending' : 'not_claimed',
          inputStatus: gate.due ? 'pending' : 'not_appended', attribution: 'unlinked',
          stateAtWake: { social: state.drives.social.satisfaction, curiosity: state.drives.curiosity.satisfaction } }
        if (gate.due || gate.previewDue) {
          const selectionId = id(), sessionId = host.boundSessionId()
          const selection = selectAction({ mode: cfg.mode, realAt: clock.realNow(), sessionId })
          const reviewId = gate.due && selection.intent ? id() : null
          const messageId = gate.due && selection.intent ? id() : null
          activityEpisode = { ...activityEpisode, reviewId, sessionId, messageId,
            reviewStatus: gate.due && selection.intent ? 'pending' : 'not_due',
            claimedStatus: gate.due && selection.intent ? 'pending' : 'not_claimed',
            inputStatus: gate.due && selection.intent ? 'pending' : 'not_appended' }
          await activityStore.recordWake(activityEpisode)
          const persistedSelection = await activityStore.recordActionSelection({ selectionId, episodeId: wakeId, reviewId, sessionId, messageId,
            intent: selection.intent, reason: selection.reason, score: selection.score, workStreakId: selection.workStreakId,
            mode: cfg.mode, at: realAt })
          const actionDispatch = gate.due && cfg.mode === 'active' && selection.intent
            && persistedSelection.dispatchStatus === 'reserved'
          if (!actionDispatch) {
            const reason = persistedSelection.dispatchStatus === 'suppressed' ? persistedSelection.reason
              : gate.due ? selection.reason : gate.reason
            const gateReason = String(reason || gate.reason).toUpperCase().slice(0,64)
            activityEpisode = { ...activityEpisode, gateReason, reviewStatus: 'skipped', claimedStatus: 'not_claimed', inputStatus: 'not_appended' }
            records.push({ type: 'ActionSelectionRecorded', at, realAt, wakeId, selectionId, intent: selection.intent, reason,
              score: selection.score, dispatchStatus: persistedSelection.dispatchStatus })
            result = { wakeId, delivered: false, reason, actionSelection: persistedSelection }
          } else {
            // Re-check all ABS gates after asynchronous session resolution and immediately before followup.
            const canDeliver = () => paused() ? 'TIME_PAUSED'
              : config().mode !== 'active' ? 'MODE_NOT_ACTIVE'
                : restWindow(clock.realNow(), config().restHours).resting ? 'REST_HOURS'
                  : host.boundSessionId() !== sessionId ? 'SESSION_BINDING_CHANGED' : null
            let acceptance
            const blocked = canDeliver()
            try {
              acceptance = blocked ? { accepted: false, definitive: true, status: 'rejected', reason: blocked }
                : await host.surfaceAction({ text: renderActionPrompt({ intent: selection.intent,
                  currentSessionId: sessionId, socialGap: reviewDemand().social, previousSocialGap: state.lastReview?.demand?.social,
                  ownerInteraction: state.lastOwnerMessage, workMinutes: selection.workMinutes }),
                  intent: selection.intent, selectionId, reviewId, messageId, expectedSessionId: sessionId, canDeliver })
            } catch (error) {
              acceptance = { accepted: false, definitive: false, status: 'unknown', reason: 'enqueue-outcome-unknown' }
              logger.warn?.('[abs] action enqueue outcome is ambiguous', error)
            }
            await synchronizeClock()
            at = iso(clock.now()); realAt = iso(clock.realNow())
            const dispatchStatus = acceptance.definitive === true && acceptance.accepted !== true ? 'released'
              : acceptance.status === 'accepted' ? 'enqueued' : 'unknown'
            const resolvedSelection = await activityStore.resolveActionSelection({ selectionId, dispatchStatus, at: realAt, reason: acceptance.reason ?? null })
            activityEpisode = { ...activityEpisode, sessionId, messageId,
              reviewStatus: dispatchStatus === 'enqueued' ? 'accepted' : dispatchStatus === 'unknown' ? 'reconcile' : 'failed',
              gateReason: dispatchStatus === 'released' ? String(acceptance.reason ?? 'ENQUEUE_REJECTED').toUpperCase().slice(0,64) : 'DUE',
              claimedStatus: 'pending', inputStatus: 'pending' }
            state.lastReview = { reviewId, at, realAt, status: dispatchStatus === 'enqueued' ? 'delivered' : dispatchStatus === 'unknown' ? 'reconcile' : 'failed',
              sessionId, messageId, reason: acceptance.reason ?? null, demand: reviewDemand(), actionSelectionId: selectionId, intent: selection.intent }
            records.push({ type: 'ActionDispatch', at, realAt, reviewId, selectionId, intent: selection.intent, dispatchStatus, reason: acceptance.reason ?? null })
            result = { wakeId, reviewId, delivered: dispatchStatus === 'enqueued', reason: acceptance.reason ?? dispatchStatus, actionSelection: resolvedSelection ?? persistedSelection }
          }
        }
        state.nextWakeAt = gate.reason === 'REST_HOURS' ? state.nextWakeAt ?? at : computeNextWake(at, config())
        records[0].nextWakeAt = state.nextWakeAt
        records[0].nextWakeRealAt = clockView().nextWakeRealAt
        await save(records)
        await activityStore.recordWake(activityEpisode)
        return result
      }).finally(arm)
    },
    start() { started = true; arm() },
    async close() {
      timers.clearTimeout(timer)
      clearInterval(activityHeartbeat)
      started = false
      closed = true
      unsubscribeObservation?.()
      unsubscribeActivity?.()
      await queue
      if (activityRuntimeId) activityStore.closeRuntime({ runtimeId: activityRuntimeId, at: iso(clock.realNow()) })
      await host.close?.()
      await activityStore.close()
      await store.close()
    },
  }
  return service
}
