import { randomUUID, createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { readFileSync } from 'node:fs'

import { platform } from '../../../shared/platform/index.js'
import { isFishHeader } from '../../../../core/modules/proactive/identity.js'
import { isChannelUserMessage } from '../../../../core/modules/social/policy.js'

const text = (value) => typeof value === 'string' && value.trim().length > 0
const OBSERVED_TOOL_NAMES = new Set(['web_search','read','read_image','write','edit','bash'])
const SYNTHETIC_CONTEXT_SOURCES = new Set(['runtime-context','time-context'])
const ABS_ACTION_SOURCE = 'chonkyfish-abs-action'
const ACTION_INTENTS = new Set(['chat_owner','remind_rest','continue_interest'])
const TURN_ERROR_CODES = new Map([
  ['TRANSPORT','TRANSPORT'], ['TRANSPORT_TIMEOUT','TIMEOUT'], ['TIMEOUT','TIMEOUT'], ['ETIMEDOUT','TIMEOUT'],
  ['QUOTA','QUOTA'], ['RATE_LIMIT','RATE_LIMIT'], ['RATE_LIMITED','RATE_LIMIT'], ['AUTH','AUTH'],
  ['UNAUTHORIZED','AUTH'], ['INVALID_REQUEST','INVALID_REQUEST'],
])
const NO_DISPATCH_TOOL_CODES = new Set(['ABORTED_BEFORE_DISPATCH','TOOL_ABORTED_BEFORE_DISPATCH','TOOL_NOT_STARTED'])
const httpUrl = (value) => { try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false } }
const isoTime = (value) => Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString() : new Date().toISOString()
const toolErrorCode = (error) => String(error?.code ?? '').toUpperCase()

function turnDiagnostic(reason, turn) {
  if (!turn.inputSeen || !turn.stepSeen) {
    const code = reason?.kind === 'aborted' ? 'ABORTED' : reason?.kind === 'interrupted' ? 'INTERRUPTED' : reason?.kind === 'blocked' ? 'BLOCKED' : 'NOT_EXECUTED'
    return { phase: 'not_executed', code }
  }
  const phase = turn.toolCalls === 0 ? 'before_tools' : turn.calls.size > 0 ? 'during_tools' : 'after_tools'
  switch (reason?.kind) {
    case 'error': return { phase, code: TURN_ERROR_CODES.get(String(reason.error?.code ?? '').toUpperCase()) ?? 'MODEL_ERROR' }
    case 'aborted': return { phase, code: 'ABORTED' }
    case 'interrupted': return { phase, code: 'INTERRUPTED' }
    case 'blocked': return { phase, code: 'BLOCKED' }
    case 'completed': return null
    default: return { phase, code: 'TURN_ERROR' }
  }
}

/**
 * Host adapter for ABS-selected action prompts.
 *
 * It binds an already-selected action to the current fish session and observes
 * linked objective facts without changing the session's tool capabilities.
 */
export function createAbsHost({ ctx, resources }) {
  const listeners = new Set()
  const activityListeners = new Set()
  const turns = new Map()
  const pendingReviews = new Map()
  let actionLookup = null
  let closed = false
  const service = (name) => { try { return ctx.get(name) } catch { return undefined } }
  const fish = (session) => isFishHeader(session?.header, { workspaceRoot: resources.paths.workspace, pathSemantics: platform })

  /** Panel-reported conversation. Read-only: the proactive module owns this file. */
  function boundSessionId() {
    try {
      const parsed = JSON.parse(readFileSync(resources.paths.proactive, 'utf8'))
      return typeof parsed.activeSessionId === 'string' && parsed.activeSessionId.trim() ? parsed.activeSessionId.trim() : null
    } catch { return null }
  }

  function liveAgent(sessionId) {
    const agents = service('agents')?.list?.() ?? []
    return agents.find((agent) => fish(agent.session) && String(agent.session.id) === sessionId) ?? null
  }

  function trustedAction(selectionId, sessionId, messageId, sourceIntent) {
    if (typeof actionLookup?.find !== 'function' || !text(selectionId) || !text(messageId)) return null
    let selection
    try { selection = actionLookup.find({ selectionId, sessionId, messageId }) } catch { return null }
    if (!selection || selection.sessionId !== sessionId || selection.messageId !== messageId || selection.selectionId !== selectionId
        || selection.intent !== sourceIntent || !['reserved','enqueued','unknown'].includes(selection.dispatchStatus)) return null
    return selection
  }

  function searchAvailable() {
    const web = service('web')
    // Actual WebRuntime registry/config fields, not a speculative network probe.
    if (!(web?.searchProviders instanceof Map)) return false
    const configured = web.config?.searchProvider?.get?.() ?? web.searchProviderEnv
    if (configured !== undefined) return web.searchProviders.get(configured)?.available?.() === true
    return [...web.searchProviders.values()].filter((provider) => provider.available?.() === true).length === 1
  }

  /** Non-mutating capability view. It does not resume cold sessions. */
  async function environment() {
    if (closed) return { ownerSession: { available: false, reason: 'host-closed' }, search: { available: false, reason: 'host-closed' } }
    const sessionId = boundSessionId()
    if (!sessionId) return { ownerSession: { available: false, reason: 'no-panel-session' }, search: { available: searchAvailable(), reason: searchAvailable() ? undefined : 'search-capability-unavailable' } }
    const agent = liveAgent(sessionId)
    const ownerSession = !agent
      ? { available: false, sessionId, reason: 'session-not-live' }
      : { available: true, sessionId, busy: agent.status !== 'idle', queueBoundary: 'next-turn' }
    return { ownerSession, search: { available: searchAvailable(), reason: searchAvailable() ? undefined : 'search-capability-unavailable' } }
  }

  /**
   * Deliver the rendered state review to the bound fish conversation.
   * Acceptance is not completion and not delivery to the owner.
   */
  async function surfaceAction({ text: actionText, intent, selectionId, reviewId, messageId = randomUUID(), expectedSessionId, canDeliver }) {
    if (closed) return { accepted: false, status: 'rejected', reason: 'host-closed' }
    if (!text(actionText) || !ACTION_INTENTS.has(intent) || !text(selectionId)) return { accepted: false, definitive: true, status: 'rejected', reason: 'invalid-action' }
    const sessionId = boundSessionId()
    if (!sessionId) return { accepted: false, definitive: true, status: 'rejected', reason: 'no-panel-session' }
    if (expectedSessionId && expectedSessionId !== sessionId) return { accepted: false, definitive: true, status: 'rejected', reason: 'session-binding-changed' }
    const controller = service('sessionController')
    if (!controller || typeof controller.resolveAgent !== 'function') return { accepted: false, definitive: true, status: 'rejected', reason: 'session-controller-unavailable' }
    const sessions = service('sessions')
    if (!sessions || typeof sessions.flush !== 'function') return { accepted: false, definitive: true, status: 'rejected', reason: 'session-support-unavailable' }
    let resolved
    try { resolved = await controller.resolveAgent(sessionId) } catch { return { accepted: false, definitive: true, status: 'rejected', reason: 'resolve-failed' } }
    const agent = resolved?.agent
    if (resolved?.error || !agent?.session || !fish(agent.session) || String(agent.session.id) !== sessionId) return { accepted: false, definitive: true, status: 'rejected', reason: 'session-binding-mismatch' }
    const message = {
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text: actionText }],
      source: { kind: ABS_ACTION_SOURCE, selectionId, intent, reviewId, policyVersion: 'abs-action-v1' },
    }
    if (closed) return { accepted: false, definitive: true, status: 'rejected', reason: 'host-closed' }
    const blocked = canDeliver?.()
    if (blocked) { pendingReviews.delete(messageId); return { accepted: false, definitive: true, status: 'rejected', reason: blocked } }
    if (boundSessionId() !== sessionId) return { accepted: false, definitive: true, status: 'rejected', reason: 'session-binding-changed' }
    const pendingTimer = setTimeout(() => pendingReviews.delete(messageId), 30 * 60 * 1000)
    pendingTimer.unref?.()
    pendingReviews.set(messageId, { sessionId, reviewId, selectionId, intent, timer: pendingTimer })
    try { agent.followup(message) } catch {
      // DSH followup has no completion promise; a throw does not prove that the
      // durable enqueue did not occur. Keep the reservation and provenance.
      return { accepted: false, definitive: false, status: 'unknown', reason: 'followup-outcome-unknown', sessionId, reviewId, selectionId, messageId }
    }
    let persisted = false
    try { persisted = (await sessions.flush(agent.session)) === true } catch { persisted = false }
    return {
      accepted: persisted,
      status: persisted ? 'accepted' : 'unknown',
      sessionId,
      selectionId,
      reviewId,
      messageId,
      ...(!persisted ? { reason: 'persistence-unacknowledged' } : {}),
    }
  }

  function emit(observation) {
    for (const callback of listeners) {
      try { callback(observation) } catch { /* observation consumers own their errors */ }
    }
  }

  function emitActivity(activity) {
    for (const callback of activityListeners) {
      try { callback(activity) } catch { /* activity consumers own their errors */ }
    }
  }

  function emitExploration(observation) {
    emit(observation)
    emitActivity(observation)
  }

  function sessionIdFor(agent) {
    const session = agent?.session
    if (!fish(session) || typeof session.id !== 'string') return null
    return String(session.id)
  }

  function onClaim({ agent, message, turn: turnNumber } = {}) {
    if (closed) return
    const sessionId = sessionIdFor(agent), turn = sessionId && turns.get(sessionId)
    if (!turn || turn.turn !== turnNumber || !message || typeof message.id !== 'string') return
    const pending = pendingReviews.get(message.id), source = message.source ?? {}
    const selection = source.kind === ABS_ACTION_SOURCE
      ? trustedAction(source.selectionId, sessionId, message.id, source.intent) : null
    if (turn.action?.messageId === message.id && turn.actionSelectionId === source.selectionId) return
    turn.claims.push({ id: message.id, reviewId: selection?.reviewId ?? null, sourceKind: source.kind ?? 'unknown' })
    if (source.kind === ABS_ACTION_SOURCE) {
      turn.action = { selection, selectionId: source.selectionId,
        messageId: message.id, intent: selection?.intent ?? source.intent, reviewId: selection?.reviewId ?? null,
        visibleEmitted: false }
      if (selection) {
        turn.reviewId = selection.reviewId
        turn.actionSelectionId = selection.selectionId
      }
      clearTimeout(pending?.timer); pendingReviews.delete(message.id)
      if (turn.claims.some(claim => claim.id !== message.id)) turn.mixed = true
      emitActivity({ kind: 'activity_turn', phase: 'claimed', reviewId: turn.reviewId ?? null, sessionId, turn: turn.turn,
        claimStatus: 'claimed', inputStatus: 'pending', turnStatus: 'pending', attribution: turn.reviewId ? turn.mixed ? 'mixed' : 'self_review' : 'unlinked', at: new Date().toISOString() })
    } else if (turn.reviewId) {
      turn.mixed = true
      emitActivity({ kind: 'activity_turn', phase: 'claim', reviewId: turn.reviewId, sessionId, turn: turn.turn,
        claimStatus: 'claimed', inputStatus: 'mixed', turnStatus: 'pending', attribution: 'mixed', at: new Date().toISOString() })
    }
  }

  function onEvent(session, event) {
    if (closed || !fish(session) || !event || !Number.isSafeInteger(event.seq)) return
    const sessionId = String(session.id)
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      turns.set(sessionId, { turn: data.turn, calls: new Map(), toolCalls: 0, claims: [], step: null, stepSeen: false,
        reviewId: null, actionSelectionId: null, action: null, inputSeen: false, mixed: false })
      return
    }
    if (event.type === 'user/message') {
      const turn = turns.get(sessionId)
      if (turn && (data.turn == null || data.turn === turn.turn) && turn.reviewId) {
        const isActionInput = turn.action && data.id === turn.action.messageId && data.source?.kind === ABS_ACTION_SOURCE
          && data.source?.selectionId === turn.actionSelectionId && data.source?.reviewId === turn.reviewId
        if (isActionInput) {
          turn.inputSeen = true
          emitActivity({ kind: 'activity_turn', phase: 'input', reviewId: turn.reviewId, sessionId, turn: turn.turn,
            claimStatus: 'claimed', inputStatus: turn.mixed ? 'mixed' : 'appended', turnStatus: 'pending', attribution: turn.mixed ? 'mixed' : 'self_review', at: isoTime(event.time) })
        } else if (!SYNTHETIC_CONTEXT_SOURCES.has(data.source?.kind)) {
          turn.mixed = true
          emitActivity({ kind: 'activity_turn', phase: 'input', reviewId: turn.reviewId, sessionId, turn: turn.turn,
            claimStatus: 'claimed', inputStatus: 'mixed', turnStatus: 'pending', attribution: 'mixed', at: isoTime(event.time) })
        }
      }
      // Non-owner injections (schedule, nudge, self-review) are not owner interaction.
      if (isChannelUserMessage(data) || data.source?.kind !== 'user') return
      emit({ kind: 'owner_message', sessionId, seq: event.seq, turn: turn?.turn, at: isoTime(event.time), sourceKind: 'user' })
      return
    }
    const turn = turns.get(sessionId)
    if (!turn || data.turn !== turn.turn) return
    if (event.type === 'assistant/message') {
      if (event.surfaceOp !== 'append') return
      const content = data.message?.content
      const visibleText = typeof content === 'string' ? text(content)
        : Array.isArray(content) && content.some(part => part?.type === 'text' && text(part.text))
      if (turn.action?.selection && turn.inputSeen && turn.stepSeen && !turn.mixed && visibleText && !turn.action.visibleEmitted) {
        turn.action.visibleEmitted = true
        const visible = { kind: 'activity_visible', selectionId: turn.action.selectionId, reviewId: turn.reviewId,
          sessionId, turn: turn.turn, at: isoTime(event.time) }
        const sessions = service('sessions')
        // DSH publishes session/event after appending. Defer flush one
        // microtask so the native persistence listener has queued this exact
        // append before we ask for durable confirmation.
        void Promise.resolve().then(() => sessions?.flush?.(session)).then(persisted => {
          if (persisted === true && !closed) emitActivity(visible)
        }).catch(() => {})
      }
      return
    }
    if (event.type === 'step/start') {
      turn.step = data.step; turn.stepSeen = true
      if (turn.reviewId && turn.inputSeen) emitActivity({ kind: 'activity_turn', phase: 'step', reviewId: turn.reviewId, sessionId, turn: turn.turn,
        claimStatus: 'claimed', inputStatus: turn.mixed ? 'mixed' : 'appended', turnStatus: 'pending', attribution: turn.mixed ? 'mixed' : 'self_review', at: isoTime(event.time) })
      return
    }
    if (event.type === 'step/end') { if (turn.step === data.step) turn.step = null; return }
    if (event.type === 'turn/end') {
      if (turn.reviewId) {
        const completed = data.reason?.kind === 'completed' && turn.inputSeen && turn.stepSeen
        const diagnostic = turnDiagnostic(data.reason, turn)
        const status = completed ? 'completed' : data.reason?.kind === 'error' && turn.inputSeen && turn.stepSeen ? 'failed' : 'unknown'
        emitActivity({ kind: 'activity_turn', phase: 'ended', reviewId: turn.reviewId, sessionId, turn: turn.turn,
          claimStatus: 'claimed', inputStatus: turn.mixed ? 'mixed' : turn.inputSeen ? 'appended' : 'not_appended',
          turnStatus: status, turnDiagnostic: diagnostic, attribution: turn.mixed ? 'mixed' : 'self_review', at: isoTime(event.time) })
      }
      turns.delete(sessionId); return
    }
    if (event.type === 'tool/call' && text(data.name) && text(data.callId)) {
      turn.toolCalls++
      let args = {}
      if (OBSERVED_TOOL_NAMES.has(data.name)) {
        try { args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments ?? {} } catch {}
      }
      turn.calls.set(data.callId, { seq: event.seq, step: data.step, name: data.name, args })
      emitActivity({ kind: 'activity_attempt', sessionId, turn: turn.turn, reviewId: turn.reviewId ?? null,
        attribution: turn.reviewId ? turn.mixed ? 'mixed' : turn.inputSeen ? 'self_review' : 'mixed' : 'unlinked',
        seq: event.seq, callId: data.callId, activity: data.name, at: isoTime(event.time) })
      return
    }
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return
    const message = data.message
    const call = turn.calls.get(message?.source?.callId)
    if (!call || message?.role !== 'tool' || message?.source?.kind !== 'tool' || message.toolCallId !== message.source.callId ||
        data.step !== call.step || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length !== 1 ||
        event.sourceEventSeqs[0] !== call.seq || event.seq <= call.seq || !Number.isFinite(event.time) || !Number.isFinite(new Date(event.time).getTime())) return
    // Recovery and cancellation may append an error without dispatching the
    // body or establishing its outcome. Keep the call pending for phase and
    // outcome classification; these are not failed tool effects.
    const errorCode = toolErrorCode(data.error)
    if (data.error?.name === 'ToolOutcomeUnknownError' || errorCode === 'TOOL_OUTCOME_UNKNOWN' || NO_DISPATCH_TOOL_CODES.has(errorCode)) return
    turn.calls.delete(message.source.callId)
    if (call.name !== 'web_search') {
      const meta = data.meta ?? {}, path = typeof meta.path === 'string' ? resolve(meta.path) : null
      // Never reward reading/writing ABS's own state. Path containment is a platform
      // concern (separators, drive letters, case folding): see app/shared/platform/.
      if (path && platform.isWithin(resolve(dirname(resources.paths.proactive), 'abs'), path)) return
      let evidence = null, activity = call.name
      if (message.isError === false && path) {
        if (call.name === 'read' && Array.isArray(meta.lines) && meta.lines.every((line) => line && typeof line.text === 'string') && meta.lines.some((line) => text(line.text))) {
          evidence = meta.lines.map((line) => line.text).join('\n')
        } else if (call.name === 'read_image') {
          const image = message.content?.find((part) => part.type === 'image' && text(part.attachment?.attachmentId) && part.attachment.bytes > 0)
          evidence = image?.attachment.attachmentId ?? null
        } else if (['write', 'edit'].includes(call.name) && platform.isWithin(resolve(resources.paths.workspace), path)) {
          const changed = Array.isArray(meta.diffs) ? meta.diffs.filter((diff) => diff && typeof diff.oldText === 'string' && typeof diff.newText === 'string' && diff.oldText !== diff.newText) : []
          if (changed?.length) evidence = changed.map((diff) => diff.newText).join('\n')
          else if (call.name === 'write' && meta.operation === 'create' && text(call.args.content)) evidence = call.args.content
        }
      }
      const verified = evidence !== null && evidence.trim().length > 0
      const observation = { kind: 'exploration', result: message.isError === true ? 'failed' : verified ? 'local_content_found' : 'unverified_activity',
        sessionId, seq: event.seq, turn: turn.turn, reviewId: turn.reviewId ?? null,
        attribution: turn.reviewId ? turn.mixed ? 'mixed' : turn.inputSeen ? 'self_review' : 'mixed' : 'unlinked',
        callId: message.source.callId, callSeq: call.seq, resultSeq: event.seq, at: isoTime(event.time), sources: 0, activity,
        ...(verified ? { evidenceKey: createHash('sha256').update(activity + ':' + path + ':' + evidence).digest('hex') } : {}) }
      if (OBSERVED_TOOL_NAMES.has(call.name)) emitExploration(observation)
      else emitActivity(observation)
      return
    }
    if (message.isError === true) {
      const observation = { kind: 'exploration', result: 'failed', sessionId, seq: event.seq, turn: turn.turn, reviewId: turn.reviewId ?? null,
        attribution: turn.reviewId ? turn.mixed ? 'mixed' : turn.inputSeen ? 'self_review' : 'mixed' : 'unlinked', callId: message.source.callId,
        activity: call.name, callSeq: call.seq, resultSeq: event.seq, at: isoTime(event.time), sources: 0 }
      if (OBSERVED_TOOL_NAMES.has(call.name)) emitExploration(observation)
      else emitActivity(observation)
      return
    }
    const meta = data.meta
    if (message.isError !== false || !meta || !Array.isArray(meta.sources) || typeof meta.truncated !== 'boolean' ||
        (meta.answer !== undefined && typeof meta.answer !== 'string') ||
        !meta.sources.every((source) => source && httpUrl(source.url) && ['title', 'snippet', 'publishedAt'].every((key) => source[key] === undefined || typeof source[key] === 'string'))) return
    emitExploration({ kind: 'exploration', result: meta.sources.length > 0 ? 'explore_content_found' : 'explore_no_usable_content', sessionId, seq: event.seq,
      turn: turn.turn, reviewId: turn.reviewId ?? null, attribution: turn.reviewId ? turn.mixed ? 'mixed' : turn.inputSeen ? 'self_review' : 'mixed' : 'unlinked',
      callId: message.source.callId, callSeq: call.seq, resultSeq: event.seq, activity: call.name, at: isoTime(event.time), sources: meta.sources.length })
  }
  const unsubscribe = typeof ctx.on === 'function' ? ctx.on('session/event', onEvent) : null
  const unsubscribeClaims = typeof ctx.on === 'function' ? ctx.on('agent/inbox/claimed', onClaim) : null

  return {
    environment,
    surfaceAction,
    subscribeObservation(callback) { listeners.add(callback); return () => listeners.delete(callback) },
    subscribeActivity(callback) { activityListeners.add(callback); return () => activityListeners.delete(callback) },
    setActionSelectionLookup(lookup) { actionLookup = lookup ?? null },
    boundSessionId,
    close() {
      closed = true
      if (typeof unsubscribe === 'function') unsubscribe()
      if (typeof unsubscribeClaims === 'function') unsubscribeClaims()
      for (const pending of pendingReviews.values()) clearTimeout(pending.timer)
      pendingReviews.clear(); listeners.clear(); activityListeners.clear(); turns.clear()
    },
  }
}
