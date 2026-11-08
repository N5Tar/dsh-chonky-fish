import { randomUUID, createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { readFileSync } from 'node:fs'

import { platform } from '../platform/index.js'
import { isFishHeader } from '../proactive/identity.js'

const text = (value) => typeof value === 'string' && value.trim().length > 0
const httpUrl = (value) => { try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false } }
const isoTime = (value) => Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString() : new Date().toISOString()

/**
 * Host adapter for the self-review model.
 *
 * It does three jobs only: report the bound owner session and search capability,
 * deliver a state-review message into that fish session, and observe objective
 * facts (owner messages, verified web_search results). It never proposes,
 * scores or executes an ABS-chosen action.
 */
export function createAbsHost({ ctx, resources }) {
  const listeners = new Set()
  const turns = new Map()
  let closed = false
  const service = (name) => { try { return ctx.get(name) } catch { return undefined } }
  const fish = (session) => isFishHeader(session?.header, { workspaceRoot: resources.paths.workspace })

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
      : agent.status === 'idle'
        ? { available: true, sessionId }
        : { available: false, sessionId, reason: 'agent-busy' }
    return { ownerSession, search: { available: searchAvailable(), reason: searchAvailable() ? undefined : 'search-capability-unavailable' } }
  }

  /**
   * Deliver the rendered state review to the bound fish conversation.
   * Acceptance is not completion and not delivery to the owner.
   */
  async function surfaceReview({ text: reviewText, reviewId, canDeliver }) {
    if (closed) return { accepted: false, status: 'rejected', reason: 'host-closed' }
    if (!text(reviewText)) return { accepted: false, status: 'rejected', reason: 'empty-review' }
    const sessionId = boundSessionId()
    if (!sessionId) return { accepted: false, status: 'rejected', reason: 'no-panel-session' }
    const controller = service('sessionController')
    if (!controller || typeof controller.resolveAgent !== 'function') return { accepted: false, status: 'rejected', reason: 'session-controller-unavailable' }
    const sessions = service('sessions')
    if (!sessions || typeof sessions.flush !== 'function') return { accepted: false, status: 'rejected', reason: 'session-support-unavailable' }
    let resolved
    try { resolved = await controller.resolveAgent(sessionId) } catch { return { accepted: false, status: 'rejected', reason: 'resolve-failed' } }
    const agent = resolved?.agent
    if (resolved?.error || !agent?.session || !fish(agent.session) || String(agent.session.id) !== sessionId) return { accepted: false, status: 'rejected', reason: 'session-binding-mismatch' }
    if (agent.status !== 'idle') return { accepted: false, status: 'rejected', reason: 'agent-busy' }
    const messageId = randomUUID()
    const message = {
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text: reviewText }],
      source: { kind: 'chonkyfish-self-review', sourceKind: 'self-review', reviewId },
    }
    if (closed) return { accepted: false, status: 'rejected', reason: 'host-closed' }
    const blocked = canDeliver?.()
    if (blocked) return { accepted: false, status: 'rejected', reason: blocked }
    try { agent.followup(message) } catch { return { accepted: false, status: 'rejected', reason: 'followup-failed' } }
    let persisted = true
    try { persisted = await sessions.flush(agent.session) } catch { persisted = false }
    return {
      accepted: true,
      status: persisted ? 'accepted' : 'reconcile',
      sessionId,
      messageId,
      ...(persisted ? {} : { reason: 'persistence-unacknowledged' }),
    }
  }

  function emit(observation) {
    for (const callback of listeners) {
      try { callback(observation) } catch { /* observation consumers own their errors */ }
    }
  }

  function onEvent(session, event) {
    if (closed || !fish(session) || !event || !Number.isSafeInteger(event.seq)) return
    const sessionId = String(session.id)
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      turns.set(sessionId, { turn: data.turn, calls: new Map() })
      return
    }
    if (event.type === 'user/message') {
      // Non-owner injections (schedule, nudge, self-review) are not owner interaction.
      if (data.source && data.source.kind !== 'user') return
      emit({ kind: 'owner_message', sessionId, seq: event.seq, at: isoTime(event.time) })
      return
    }
    const turn = turns.get(sessionId)
    if (!turn || data.turn !== turn.turn) return
    if (event.type === 'turn/end') { turns.delete(sessionId); return }
    if (event.type === 'tool/call' && ['web_search', 'read', 'read_image', 'write', 'edit', 'bash'].includes(data.name) && text(data.callId)) {
      let args = {}
      try { args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments ?? {} } catch {}
      turn.calls.set(data.callId, { seq: event.seq, step: data.step, name: data.name, args })
      return
    }
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return
    const message = data.message
    const call = turn.calls.get(message?.source?.callId)
    if (!call || message?.role !== 'tool' || message?.source?.kind !== 'tool' || message.toolCallId !== message.source.callId ||
        data.step !== call.step || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length !== 1 ||
        event.sourceEventSeqs[0] !== call.seq || event.seq <= call.seq || !Number.isFinite(event.time) || !Number.isFinite(new Date(event.time).getTime())) return
    // Host recovery can synthesize an error result for an interrupted tool; its
    // real outcome is unknown, so it is not a terminal observation.
    if (data.error?.name === 'ToolOutcomeUnknownError') return
    turn.calls.delete(message.source.callId)
    if (call.name !== 'web_search') {
      const meta = data.meta ?? {}, path = typeof meta.path === 'string' ? resolve(meta.path) : null
      // Never reward reading/writing ABS's own state. Path containment is a platform
      // concern (separators, drive letters, case folding): see src/platform/.
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
      emit({ kind: 'exploration', result: message.isError === true ? 'failed' : verified ? 'local_content_found' : 'unverified_activity',
        sessionId, seq: event.seq, turn: turn.turn, at: isoTime(event.time), sources: 0, activity,
        ...(verified ? { evidenceKey: createHash('sha256').update(activity + ':' + path + ':' + evidence).digest('hex') } : {}) })
      return
    }
    if (message.isError === true) {
      emit({ kind: 'exploration', result: 'failed', sessionId, seq: event.seq, at: isoTime(event.time), sources: 0 })
      return
    }
    const meta = data.meta
    if (message.isError !== false || !meta || !Array.isArray(meta.sources) || typeof meta.truncated !== 'boolean' ||
        (meta.answer !== undefined && typeof meta.answer !== 'string') ||
        !meta.sources.every((source) => source && httpUrl(source.url) && ['title', 'snippet', 'publishedAt'].every((key) => source[key] === undefined || typeof source[key] === 'string'))) return
    emit({ kind: 'exploration', result: meta.sources.length > 0 ? 'explore_content_found' : 'explore_no_usable_content', sessionId, seq: event.seq, at: isoTime(event.time), sources: meta.sources.length })
  }
  const unsubscribe = typeof ctx.on === 'function' ? ctx.on('session/event', onEvent) : null

  return {
    environment,
    surfaceReview,
    subscribeObservation(callback) { listeners.add(callback); return () => listeners.delete(callback) },
    close() { closed = true; if (typeof unsubscribe === 'function') unsubscribe(); listeners.clear(); turns.clear() },
  }
}
