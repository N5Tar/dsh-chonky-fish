import { digest, fail, plain, readJson, writeJson, serial, text, conversation, publicError } from './core.js'
import { isConversationalUserMessage } from './policy.js'

const MAX_ROUTES = 1024
const STATES = ['waiting', 'sending', 'sent', 'unknown', 'failed', 'canceled']
const inboundId = value => typeof value === 'string' && /^social-[a-f0-9]{64}$/.test(value)
const validTurn = value => Number.isSafeInteger(value) && value >= 0
const contentHash = message => digest(JSON.stringify(message?.content ?? null))
const conversational = event => event.type === 'user/message' && isConversationalUserMessage(event.data)

/** Interpret actual SessionEvent envelopes, never assistant stream/tool-result text.
 * Success requires one registered user message in one completed, unmixed turn.
 * The LAST assistant message must itself be a final candidate; never fall back to
 * earlier commentary just because the last message has tool calls or no text. */
export function replyEvidence(events, route) {
  if (!Array.isArray(events)) return { status: 'waiting', errorCode: 'SOCIAL_REPLY_EVIDENCE_MISSING' }
  const occurrences = events.filter(event => event.type === 'user/message' && event.data?.id === route.inboundMessageId)
  if (occurrences.length === 0) return { status: 'waiting', errorCode: 'SOCIAL_REPLY_EVIDENCE_MISSING' }
  if (occurrences.length !== 1) return { status: 'failed', errorCode: 'SOCIAL_REPLY_AMBIGUOUS' }
  const incoming = occurrences[0]
  if ((incoming.surfaceOp !== undefined && incoming.surfaceOp !== 'append') || incoming.data?.source?.kind !== 'user' || incoming.data?.role !== 'user' || contentHash(incoming.data) !== route.contentHash) return { status: 'failed', errorCode: 'SOCIAL_REPLY_EVIDENCE_MISMATCH' }
  const index = events.indexOf(incoming)
  let start = -1, end = -1
  for (let i = index - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') break
    if (events[i].type === 'turn/start') { start = i; break }
  }
  if (start < 0 || !validTurn(events[start].data?.turn)) return { status: 'failed', errorCode: 'SOCIAL_REPLY_TURN_INVALID' }
  const turn = events[start].data.turn
  if (route.turn !== undefined && route.turn !== turn) return { status: 'failed', errorCode: 'SOCIAL_REPLY_TURN_MISMATCH' }
  for (let i = index + 1; i < events.length; i++) {
    if (events[i].type === 'turn/start') return { status: 'canceled', turn, errorCode: 'SOCIAL_REPLY_TURN_INTERRUPTED' }
    if (events[i].type === 'turn/end') { end = i; break }
  }
  const body = events.slice(start + 1, end < 0 ? events.length : end)
  if (body.filter(conversational).length !== 1) return { status: 'canceled', turn, errorCode: 'SOCIAL_REPLY_MIXED_TURN' }
  if (end < 0) return { status: 'waiting', turn }
  if (events[end].data?.turn !== turn || events[end].data?.reason?.kind !== 'completed') return { status: 'canceled', turn, errorCode: 'SOCIAL_REPLY_TURN_INTERRUPTED' }
  const last = body.filter(event => event.type === 'assistant/message').at(-1)
  const message = last?.data?.message
  if (!last || (last.surfaceOp !== undefined && last.surfaceOp !== 'append') || last.data?.turn !== turn || last.data?.interrupted || message?.role !== 'assistant' || !text(message.id) || !Array.isArray(message.content)) return { status: 'canceled', turn, errorCode: 'SOCIAL_REPLY_FINAL_MISSING' }
  // Audited runtime AssistantMessage has role/content/source, no phase/channel.
  // Completed-turn position and absence of tool calls are the final-output boundary.
  if (message.content.some(block => block?.type === 'tool-call')) return { status: 'canceled', turn, errorCode: 'SOCIAL_REPLY_FINAL_MISSING' }
  const finalText = message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
  if (!text(finalText, 8000)) return { status: 'canceled', turn, errorCode: finalText.length > 8000 ? 'SOCIAL_REPLY_TOO_LARGE' : 'SOCIAL_REPLY_EMPTY' }
  return { status: 'ready', turn, assistantMessageId: message.id, text: finalText }
}

/** Host-only durable routes. No body/target/credential escapes inspect(). */
export async function createReplyOutbox({ file, service, readEvidence, syncDirectory = async () => {} }) {
  if (!text(file, 4096)) fail('SOCIAL_REPLIES_INVALID')
  const state = await readJson(file, { version: 1, routes: [] })
  if (!plain(state) || state.version !== 1 || !Array.isArray(state.routes) || state.routes.length > MAX_ROUTES) fail('SOCIAL_REPLIES_INVALID')
  const ids = new Set()
  for (const row of state.routes) {
    if (!plain(row) || row.format !== 'plain-user-v1' || !inboundId(row.inboundMessageId) || ids.has(row.inboundMessageId) || !text(row.sessionId) || !text(row.connectionId) || !text(row.identityRevision) || !text(row.sessionKey, 2048) || !text(row.contentHash) || !text(row.operationId, 128) || !Number.isSafeInteger(row.eventOffset) || row.eventOffset < 0 || !STATES.includes(row.status) || (row.turn !== undefined && !validTurn(row.turn))) fail('SOCIAL_REPLIES_INVALID')
    conversation(row.conversation); ids.add(row.inboundMessageId)
    // The durable pre-send marker is ambiguous after a crash, never an invitation to retry.
    if (row.status === 'sending') { row.status = 'unknown'; row.errorCode = 'SOCIAL_SEND_UNKNOWN' }
  }
  const queue = serial(32)
  let closed = false, poisoned = false, closePromise
  function active() { if (closed) fail('SOCIAL_BRIDGE_CLOSED'); if (poisoned) fail('SOCIAL_REPLY_STORAGE_UNCERTAIN') }
  async function persist() { try { await writeJson(file, state, { syncDirectory }) } catch { poisoned = true; fail('SOCIAL_REPLY_STORAGE_UNCERTAIN') } }
  return {
    register(input) {
      input = structuredClone(input)
      return queue(async () => {
        active()
        const existing = state.routes.find(row => row.inboundMessageId === input.inboundMessageId)
        if (existing) {
          for (const field of ['sessionId', 'connectionId', 'identityRevision', 'sessionKey', 'contentHash', 'eventOffset']) if (existing[field] !== input[field]) fail('SOCIAL_REPLY_ROUTE_MISMATCH')
          if (JSON.stringify(existing.conversation) !== JSON.stringify(input.conversation)) fail('SOCIAL_REPLY_ROUTE_MISMATCH')
          return
        }
        if (state.routes.length >= MAX_ROUTES) fail('SOCIAL_REPLY_CAPACITY') // Never evict unresolved or idempotency records.
        if (!inboundId(input.inboundMessageId) || !text(input.sessionId) || !text(input.connectionId) || !text(input.identityRevision) || !text(input.sessionKey, 2048) || !text(input.contentHash) || !Number.isSafeInteger(input.eventOffset) || input.eventOffset < 0) fail('SOCIAL_REPLIES_INVALID')
        const row = { format: 'plain-user-v1', sessionId: input.sessionId, inboundMessageId: input.inboundMessageId, connectionId: input.connectionId, conversation: conversation(input.conversation), identityRevision: input.identityRevision, sessionKey: input.sessionKey, contentHash: input.contentHash, eventOffset: input.eventOffset, operationId: digest(JSON.stringify(['social-auto-reply-v1', input.sessionId, input.inboundMessageId, input.identityRevision])), status: 'waiting' }
        state.routes.push(row)
        await persist()
      })
    },
    inspect() { return state.routes.map(row => ({ sessionId: row.sessionId, inboundMessageId: row.inboundMessageId, ...(row.assistantMessageId ? { assistantMessageId: row.assistantMessageId } : {}), status: row.status, ...(row.errorCode ? { errorCode: row.errorCode } : {}) })) },
    process(sessionId) {
      return queue(async () => {
        active()
        for (const row of state.routes) {
          if (closed) break
          if (row.status !== 'waiting' || (sessionId !== undefined && row.sessionId !== sessionId)) continue
          let proof
          try { proof = replyEvidence(await readEvidence(row), row) }
          catch (error) { row.errorCode = publicError(error); continue }
          if (closed) break
          if (proof.turn !== undefined && row.turn === undefined) { row.turn = proof.turn; await persist() }
          if (proof.status === 'waiting') { if (proof.errorCode) row.errorCode = proof.errorCode; continue }
          if (proof.status !== 'ready') { row.status = proof.status; row.errorCode = proof.errorCode; await persist(); continue }
          let scope
          try {
            scope = service.issueScope({ sessionId: row.sessionId, connectionId: row.connectionId, conversation: row.conversation })
            if (scope.identityRevision !== row.identityRevision || scope.sessionKey !== row.sessionKey) fail('SOCIAL_SCOPE_STALE')
            service.scopedIdentity(scope)
          } catch (error) {
            if (scope) service.revokeScope(scope)
            row.errorCode = publicError(error)
            if (error?.code !== 'SOCIAL_NOT_CONNECTED') { row.status = 'failed'; await persist() }
            continue
          }
          try {
            if (closed) break
            row.assistantMessageId = proof.assistantMessageId
            row.status = 'sending'; delete row.errorCode
            await persist() // Stable operation + pre-send intent before the only external write.
            if (closed) break
            let result
            try { result = await service.send(scope, { operationId: row.operationId, connectionId: row.connectionId, conversation: row.conversation, text: proof.text }) }
            catch (error) {
              // These service-level admission errors precede transport dispatch.
              // Keep the SAME operation id for a later pump; a driver-returned
              // failed result below is terminal and is never retried this way.
              if (['SOCIAL_RATE_LIMITED', 'SOCIAL_NOT_CONNECTED'].includes(error?.code)) {
                row.status = 'waiting'; row.errorCode = error.code
                await persist()
                continue
              }
              result = { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' }
            }
            row.status = result?.status === 'accepted' ? 'sent' : result?.status === 'failed' ? 'failed' : 'unknown'
            if (row.status !== 'sent') row.errorCode = row.status === 'unknown' ? 'SOCIAL_SEND_UNKNOWN' : publicError({ code: result.errorCode })
            await persist()
          } finally { service.revokeScope(scope) }
        }
        return { pending: !closed && state.routes.some(row => row.status === 'waiting') }
      })
    },
    close() { if (!closePromise) { closed = true; closePromise = queue(async () => {}, true) } return closePromise },
  }
}
