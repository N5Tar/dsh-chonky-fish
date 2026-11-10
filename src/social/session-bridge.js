import { digest, fail, plain, readJson, writeJson, serial, text, publicError } from './core.js'
import { isFishHeader } from '../proactive/identity.js'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createChannelReply } from './channel-reply.js'
import { isChannelUserMessage, isConversationalUserMessage } from './policy.js'

const SOURCE = 'chonkyfish-social'
const MAX_DELIVERIES = 256
const MAX_EVENTS = 50000
const PRECOMMIT_MS = 10000
const external = isChannelUserMessage
function pending(agent) { return [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])] }

/** Current open turn only; a mixed owner/external turn stays restricted until turn/end.
 * Pending external input restricts conservatively but never grants a reply capability. */
export function socialTurnState(agent) {
  const events = agent.session?.snapshotEvents?.()
  if (!Array.isArray(events)) fail('SOCIAL_PERSISTENCE_UNVERIFIED')
  // Historical size says nothing about the current turn's trust. Inspect only the
  // bounded tail until its most recent turn boundary, not every historical message.
  let start = -1, boundary = false
  const floor = Math.max(0, events.length - MAX_EVENTS)
  for (let i = events.length - 1; i >= floor; i--) {
    if (events[i].type === 'turn/end') { boundary = true; break }
    if (events[i].type === 'turn/start') { start = i; boundary = true; break }
  }
  // A single open turn exceeding the bound remains unknown, unlike a long history
  // of completed turns. Never silently forget external input in that open turn.
  if (!boundary && floor > 0) fail('SOCIAL_TURN_PROVENANCE_UNCERTAIN')
  const messages = start < 0 ? [] : events.slice(start + 1).filter(event => event.type === 'user/message').map(event => event.data)
  const queued = pending(agent)
  return { events, start, messages, queued, social: messages.some(external) || queued.some(external) }
}

/** Guard fallback independent of journals/grants. Caller checks the fish workspace/header. */
export function isMainSocialTurn(agent) {
  try { return socialTurnState(agent).social } catch { return true }
}

/** Arrival scheduling belongs to the caller. This bridge never creates/mounts/disposes an Agent. */
export async function createSocialBridge({ ctx, service, resources, peers, getActiveSessionId = () => null }) {
  const file = resources.paths.socialMainDeliveries
  if (!text(file, 4096)) fail('SOCIAL_DELIVERIES_INVALID')
  const state = await readJson(file, { version: 1, deliveries: [] })
  if (!plain(state) || state.version !== 1 || !Array.isArray(state.deliveries) || state.deliveries.length > MAX_DELIVERIES) fail('SOCIAL_DELIVERIES_INVALID')
  const keys = new Set()
  for (const row of state.deliveries) {
    const d = row?.delivery
    if (!plain(row) || !text(row.key) || !text(row.sessionKey, 2048) || !text(row.identityRevision) || !text(row.connectionId) || !text(row.platform) || !plain(row.conversation) || !text(row.conversation.id) || !['direct', 'group', 'channel'].includes(row.conversation.type) || !text(row.sessionId) || row.key !== digest(JSON.stringify([row.sessionKey, row.identityRevision])) || keys.has(row.key) || !plain(d) || !text(d.batchId) || !text(d.messageId) || !['attempted', 'acknowledged'].includes(d.status) || !Number.isSafeInteger(d.fromSeq) || d.fromSeq < 1 || !Number.isSafeInteger(d.throughSeq) || d.throughSeq < d.fromSeq) fail('SOCIAL_DELIVERIES_INVALID')
    if (d.eventOffset !== undefined && (!Number.isSafeInteger(d.eventOffset) || d.eventOffset < 0)) fail('SOCIAL_DELIVERIES_INVALID')
    if (d.format !== undefined && (d.format !== 'plain-user-v1' || !text(d.contentHash))) fail('SOCIAL_DELIVERIES_INVALID')
    keys.add(row.key)
  }
  const queue = serial(32), resolved = new Map(), grants = new Map(), precommit = new WeakMap()
  let closed = false, poisoned = false, closePromise, lastError
  function get(name) {
    try { const value = ctx[name]; if (value != null) return value } catch {}
    try { return ctx.get?.(name) } catch { return undefined }
  }
  function target() { try { const value = getActiveSessionId(); return text(value) ? value : null } catch { return null } }
  function capabilities() {
    const controller = get('sessionController'), sessions = get('sessions'), persistence = get('sessionPersistence')
    const required = { 'sessionController.resolveAgent': controller?.resolveAgent, 'sessions.flush': sessions?.flush, 'sessionPersistence.open': persistence?.open }
    const missingCapabilities = Object.keys(required).filter(key => typeof required[key] !== 'function')
    if (persistence?.identity === undefined) missingCapabilities.push('sessionPersistence.identity')
    return { available: !missingCapabilities.length, reason: missingCapabilities.length ? 'SOCIAL_HOST_CAPABILITY_UNAVAILABLE' : undefined, missingCapabilities, controller, sessions, persistence, backendIdentity: persistence?.identity }
  }
  function active() { if (closed) fail('SOCIAL_BRIDGE_CLOSED'); if (poisoned) fail('SOCIAL_BRIDGE_STORAGE_UNCERTAIN') }
  function validHeader(header, id) {
    if (header?.id !== id) return false
    if (isFishHeader(header, { workspaceRoot: resources.paths.workspace })) return true
    return peers?.hasPeerSession(id) === true && header.agentPreset === resources.spec.SOCIAL.preset &&
      typeof header.cwd === 'string' && resolve(header.cwd) === resolve(resources.paths.socialWorkspace, digest(id))
  }
  async function peerTarget(cap, message, revision) {
    if (!peers) fail('SOCIAL_PAIRING_UNAVAILABLE')
    return peers.ensurePeerSession(message, revision, async ({ sessionId }) => {
      const existing = await cap.controller.resolveAgent(sessionId)
      active()
      if (existing?.agent) {
        if (!validHeader(existing.agent.session?.header, sessionId)) fail('SOCIAL_SESSION_BINDING_MISMATCH')
        return { sessionId }
      }
      if (existing?.error?.code !== 'session/not-found') fail('SOCIAL_PEER_SESSION_UNAVAILABLE')
      if (typeof cap.controller.create !== 'function') fail('SOCIAL_HOST_CAPABILITY_UNAVAILABLE')
      const cwd = join(resources.paths.socialWorkspace, digest(sessionId))
      await mkdir(cwd, { recursive: true, mode: 0o700 })
      active()
      const created = await cap.controller.create({ sessionId, cwd, agentPreset: resources.spec.SOCIAL.preset })
      active()
      if (created?.sessionId !== sessionId) fail('SOCIAL_SESSION_BINDING_MISMATCH')
      return created
    })
  }
  function validAgent(agent, id) { return agent?.session?.id === id && validHeader(agent.session.header, id) && typeof agent.followup === 'function' && typeof agent.session.snapshotEvents === 'function' }
  function revoke(agent) {
    const grant = grants.get(agent)
    if (grant) service.revokeScope(grant.scope)
    grants.delete(agent)
  }
  async function persist() { try { await writeJson(file, state) } catch { poisoned = true; fail('SOCIAL_BRIDGE_STORAGE_UNCERTAIN') } }
  async function resolveAgent(cap, id) {
    const result = await cap.controller.resolveAgent(id)
    active()
    const agent = result?.agent
    if (!validAgent(agent, id)) return null
    const previous = resolved.get(id)
    if (previous && previous !== agent) revoke(previous)
    resolved.set(id, agent)
    return agent
  }
  function matches(message, row, delivery) {
    const source = message?.source
    if (delivery.format === 'plain-user-v1') return message?.id === delivery.messageId && message?.role === 'user' && source?.kind === 'user' && digest(JSON.stringify(message.content ?? null)) === delivery.contentHash
    return message?.id === delivery.messageId && source?.kind === SOURCE && source.version === 1 && source.batchId === delivery.batchId && source.sessionKey === row.sessionKey && source.identityRevision === row.identityRevision && source.connectionId === row.connectionId && source.platform === row.platform && JSON.stringify(source.conversation) === JSON.stringify(row.conversation) && source.firstSeq === delivery.fromSeq && source.lastSeq === delivery.throughSeq
  }
  function isSocialTurn(agent) {
    if (!agent || !isFishHeader(agent.session?.header, { workspaceRoot: resources.paths.workspace })) return false
    try {
      const current = socialTurnState(agent)
      if (current.social) return true
      const latch = precommit.get(agent)
      if (!latch || Date.now() > latch.until) return false
      const tail = current.events.slice(latch.offset)
      if (tail.some(event => event.type === 'turn/end')) { precommit.delete(agent); return false }
      // Includes the tiny inbox-drained / user-message-not-yet-committed window.
      return true
    } catch { return true } // Unknown provenance in a fish session fails closed.
  }
  function scopeForAgent(agent) {
    if (closed || poisoned || !agent) return null
    const grant = grants.get(agent)
    if (!grant) return null
    try {
      const { row, delivery, scope } = grant
      if (resolved.get(row.sessionId) !== agent || !validAgent(agent, row.sessionId)) throw new Error('unrecognized agent')
      const current = socialTurnState(agent)
      // Framework context injections are not extra requests; only owner or other
      // channel input revokes the reply scope.
      const relevant = current.messages.filter(message => isConversationalUserMessage(message) || matches(message, row, delivery))
      const queued = current.queued.filter(message => isConversationalUserMessage(message) || matches(message, row, delivery))
      if (relevant.some(message => !matches(message, row, delivery)) || queued.some(message => !matches(message, row, delivery))) throw new Error('mixed source')
      if (!relevant.some(message => matches(message, row, delivery))) return null
      service.scopedIdentity(scope)
      return scope
    } catch { revoke(agent); return null }
  }
  function grant(agent, row, delivery) {
    revoke(agent)
    const scope = service.issueScope({ sessionId: row.sessionId, connectionId: row.connectionId, conversation: row.conversation })
    if (scope.identityRevision !== row.identityRevision || scope.sessionKey !== row.sessionKey) { service.revokeScope(scope); fail('SOCIAL_SCOPE_STALE') }
    grants.set(agent, { row: structuredClone(row), delivery: structuredClone(delivery), scope })
  }
  async function readEvents(cap, row) {
    const handle = await cap.persistence.open(row.sessionId, 'read')
    if (!handle) fail('SOCIAL_PERSISTENCE_UNVERIFIED')
    try {
      if (!validHeader(handle.header, row.sessionId)) fail('SOCIAL_SESSION_BINDING_MISMATCH')
      const result = await handle.read(row.delivery.eventOffset ?? 0, MAX_EVENTS + 1)
      if (!Array.isArray(result?.events) || result.events.length > MAX_EVENTS) fail('SOCIAL_PERSISTENCE_UNVERIFIED')
      return result.events
    } finally { await handle.close() }
  }
  async function confirmDurable(cap, row, probe, agent) {
    if (agent && !await cap.sessions.flush(agent.session)) fail('SOCIAL_PERSISTENCE_UNACKNOWLEDGED')
    active()
    if (get('sessionPersistence')?.identity !== cap.backendIdentity) fail('SOCIAL_PERSISTENCE_CHANGED')
    const events = await readEvents(cap, row), delivery = row.delivery
    if (get('sessionPersistence')?.identity !== cap.backendIdentity) fail('SOCIAL_PERSISTENCE_CHANGED')
    const committed = events.some(event => event.type === 'user/message' && matches(event.data, row, delivery))
    const inserted = events.some(event => event.type === 'agent/inbox/spliced' && event.data?.inserted?.some(message => matches(message, row, delivery)))
    const queued = agent && pending(agent).some(message => matches(message, row, delivery))
    if (!committed && !(inserted && queued)) fail('SOCIAL_DELIVERY_UNCERTAIN')
    active()
    await service.acknowledgeBatch(probe, { batchId: delivery.batchId, sessionKey: row.sessionKey, identityRevision: row.identityRevision, throughSeq: delivery.throughSeq })
    delivery.status = 'acknowledged'
    await persist()
  }
  const replies = await createChannelReply({ file: resources.paths.socialChannelReplies, service })
  const bridge = {
    inspect() {
      const cap = capabilities()
      return { available: !closed && !poisoned && cap.available, reason: closed ? 'SOCIAL_BRIDGE_CLOSED' : poisoned ? 'SOCIAL_BRIDGE_STORAGE_UNCERTAIN' : cap.reason, missingCapabilities: cap.missingCapabilities, mode: 'main-session-auto', deliveryFormat: 'plain-user-v1', replyMode: 'automatic-final', bindingCount: peers?.inspect().peerCount ?? 0, targetSessionId: target(), replies: replies.inspect(), ...(lastError ? { lastError } : {}) }
    },
    scopeForAgent, isSocialTurn,
    onEvent(session, event) { if (!closed) replies.onEvent(session, event) },
    async processReplies(sessionId) { active(); if (sessionId !== undefined && !text(sessionId)) fail('SOCIAL_INVALID_INPUT'); return replies.process(sessionId) },
    view(input) {
      input = structuredClone(input)
      return queue(async () => {
        active()
        const cap = capabilities()
        if (!cap.available) fail(cap.reason)
        const probe = service.issueScope({ sessionId: 'social-main-probe', connectionId: input.connectionId, conversation: input.conversation })
        try {
          const key = digest(JSON.stringify([probe.sessionKey, probe.identityRevision]))
          let row = state.deliveries.find(value => value.key === key)
          if (row?.delivery.status === 'attempted') {
            // Never replay uncertain intent, even if the user switched main sessions.
            const original = await resolveAgent(cap, row.sessionId)
            if (original) grant(original, row, row.delivery)
            await confirmDurable(cap, row, probe, original)
          }
          const batch = await service.readBatch(probe, { maxMessages: 1 })
          active()
          if (!batch) return { status: 'empty' }
          if (batch.messages.length !== 1) fail('SOCIAL_REPLY_BATCH_INVALID')
          const incoming = batch.messages[0]
          const ownerMain = incoming.conversation.type === 'direct' && peers?.isOwner(incoming, probe.identityRevision) === true
          const ownerClaim = JSON.stringify(peers?.owner?.(incoming.connectionId, probe.identityRevision) ?? null)
          function checkRouting() {
            active()
            if (ownerMain !== (incoming.conversation.type === 'direct' && peers?.isOwner(incoming, probe.identityRevision) === true) || ownerClaim !== JSON.stringify(peers?.owner?.(incoming.connectionId, probe.identityRevision) ?? null)) fail('SOCIAL_OWNER_CHANGED')
          }
          const sessionId = ownerMain ? target() : await peerTarget(cap, incoming, probe.identityRevision)
          if (!sessionId) return { status: 'pending', reason: 'SOCIAL_MAIN_SESSION_UNAVAILABLE' }
          const agent = await resolveAgent(cap, sessionId)
          checkRouting()
          if (!agent) return { status: 'pending', reason: 'SOCIAL_MAIN_SESSION_UNAVAILABLE' }
          const header = agent.session?.header
          if (ownerMain) {
            if (peers?.hasPeerSession(sessionId) || !isFishHeader(header, { workspaceRoot: resources.paths.workspace })) fail('SOCIAL_MAIN_SESSION_INVALID')
          } else if (header?.agentPreset !== resources.spec.SOCIAL.preset || !peers?.hasPeerSession(sessionId) || typeof header.cwd !== 'string' || resolve(header.cwd) !== resolve(resources.paths.socialWorkspace, digest(sessionId))) {
            fail('SOCIAL_PEER_SESSION_INVALID')
          }
          if (ownerMain && target() !== sessionId) return { status: 'pending', reason: 'SOCIAL_MAIN_SESSION_CHANGED' }
          if (agent.status !== 'idle' || pending(agent).length) return { status: 'busy', sessionId }
          if (row?.delivery.batchId === batch.batchId) fail('SOCIAL_DELIVERY_UNCERTAIN')
          const identity = service.scopedIdentity(probe)
          const snapshot = socialTurnState(agent).events
          const lastSeq = snapshot.at(-1)?.seq
          const eventOffset = Number.isSafeInteger(lastSeq) && lastSeq >= 0 && lastSeq < Number.MAX_SAFE_INTEGER ? lastSeq + 1 : 0
          if (batch.messages.length !== 1) fail('SOCIAL_REPLY_BATCH_INVALID')
          const content = [{ type: 'text', text: batch.messages[0].text }]
          const contentHash = digest(JSON.stringify(content))
          const next = { key, sessionKey: probe.sessionKey, identityRevision: probe.identityRevision, connectionId: probe.connectionId, platform: identity.platform, conversation: probe.conversation, sessionId,
            delivery: { batchId: batch.batchId, messageId: 'social-' + digest(JSON.stringify([key, batch.batchId])), fromSeq: batch.fromSeq, throughSeq: batch.throughSeq, eventOffset, format: 'plain-user-v1', contentHash, status: 'attempted' } }
          if (!row) {
            if (state.deliveries.length >= MAX_DELIVERIES) {
              const evict = state.deliveries.findIndex(value => value.delivery.status === 'acknowledged')
              if (evict < 0) fail('SOCIAL_DELIVERY_CAPACITY')
              state.deliveries.splice(evict, 1)
            }
            state.deliveries.push(next)
          } else state.deliveries[state.deliveries.indexOf(row)] = next
          row = next
          await persist() // Intent is durable BEFORE followup. Unknown outcomes never replay.
          active()
          await replies.register({ sessionId, inboundMessageId: row.delivery.messageId, connectionId: row.connectionId, conversation: row.conversation, identityRevision: row.identityRevision, sessionKey: row.sessionKey, contentHash, eventOffset })
          checkRouting()
          if ((ownerMain && target() !== sessionId) || agent.status !== 'idle' || pending(agent).length) fail('SOCIAL_DELIVERY_UNCERTAIN')
          grant(agent, row, row.delivery)
          precommit.set(agent, { offset: snapshot.length, until: Date.now() + PRECOMMIT_MS })
          agent.followup({
            id: row.delivery.messageId, role: 'user',
            content, source: { kind: 'user' },
          })
          await confirmDurable(cap, row, probe, agent)
          lastError = null
          return { status: 'viewed', sessionId, batchId: batch.batchId, throughSeq: batch.throughSeq, sentAutomatically: false }
        } catch (error) { lastError = publicError(error); throw error }
        finally { service.revokeScope(probe) }
      })
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      for (const agent of grants.keys()) revoke(agent)
      const repliesClosing = replies.close()
      closePromise = Promise.all([repliesClosing, queue(async () => { resolved.clear() }, true)]).then(() => {})
      return closePromise
    },
  }
  return bridge
}
