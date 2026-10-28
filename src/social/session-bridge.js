import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { digest, fail, plain, readJson, writeJson, serial, text } from './core.js'
import { SOCIAL_PRESET, SOCIAL_TOOL_NAMES } from './policy.js'

const SOURCE = 'chonkyfish-social'
const MAX_BINDINGS = 256
const MAX_EVENTS = 50000

/** A bridge never subscribes to arrivals. Only an explicit view() may run an agent. */
export async function createSocialBridge({ ctx, service, resources }) {
  const file = resources.paths.socialBindings
  const root = resolve(resources.paths.socialWorkspace)
  let state = await readJson(file, { version: 1, bindings: [] })
  if (!plain(state) || state.version !== 1 || !Array.isArray(state.bindings) || state.bindings.length > MAX_BINDINGS) fail('SOCIAL_BINDINGS_INVALID')
  const ids = new Set(), keys = new Set()
  for (const row of state.bindings) {
    if (!plain(row) || !text(row.sessionId) || !text(row.identityRevision) || typeof row.sessionKey !== 'string' || !text(row.connectionId) || !text(row.key) || typeof row.created !== 'boolean' || row.key !== digest(JSON.stringify([row.sessionKey, row.identityRevision])) || row.cwd !== join(root, row.key) || ids.has(row.sessionId) || keys.has(row.key)) fail('SOCIAL_BINDINGS_INVALID')
    if (row.delivery !== null && (!plain(row.delivery) || !text(row.delivery.batchId) || !text(row.delivery.messageId) || !['prepared', 'attempted', 'acknowledged'].includes(row.delivery.status) || !Number.isSafeInteger(row.delivery.fromSeq) || !Number.isSafeInteger(row.delivery.throughSeq) || row.delivery.fromSeq < 1 || row.delivery.throughSeq < row.delivery.fromSeq)) fail('SOCIAL_BINDINGS_INVALID')
    ids.add(row.sessionId); keys.add(row.key)
  }
  const queue = serial(32), live = new Map(), grants = new WeakMap()
  let closed = false, poisoned = false, closePromise = null
  function get(name) {
    try { return ctx[name] ?? (typeof ctx.get === 'function' ? ctx.get(name) : undefined) } catch { return undefined }
  }
  function capabilities() {
    const agents = get('agents'), presets = get('agentPresets'), sessions = get('sessions'), persistence = get('sessionPersistence'), permissions = get('permissionPresets')
    if (!agents?.create || !agents?.resume || !presets?.mount || !presets?.composedPreset || !sessions?.flush || !persistence?.open || persistence.identity === undefined || !permissions?.set) return { available: false, reason: 'SOCIAL_HOST_CAPABILITY_UNAVAILABLE' }
    if (permissions.presets?.['read-only']?.sandbox !== 'read-only') return { available: false, reason: 'SOCIAL_READ_ONLY_UNAVAILABLE' }
    let model
    try { model = get('agentDefaultModel')?.currentSelection() } catch {}
    if (!text(model?.provider) || !text(model?.model)) return { available: false, reason: 'SOCIAL_MODEL_UNAVAILABLE' }
    return { available: true, agents, presets, sessions, persistence, backendIdentity: persistence.identity, permissions, model: { provider: model.provider, model: model.model } }
  }
  function active() { if (closed) fail('SOCIAL_BRIDGE_CLOSED'); if (poisoned) fail('SOCIAL_BRIDGE_STORAGE_UNCERTAIN') }
  async function persist() {
    try { await writeJson(file, state) }
    catch { poisoned = true; fail('SOCIAL_BRIDGE_STORAGE_UNCERTAIN') }
  }
  function checkHeader(header, row) {
    if (!header || header.id !== row.sessionId || header.agentPreset !== SOCIAL_PRESET || typeof header.cwd !== 'string' || resolve(header.cwd) !== row.cwd) fail('SOCIAL_SESSION_BINDING_MISMATCH')
  }
  function scopeForAgent(agent) {
    if (closed || poisoned || !agent) return null
    const grant = grants.get(agent)
    if (!grant) return null
    try {
      if (agent.session?.id !== grant.row.sessionId) return null
      checkHeader(agent.session.header, grant.row)
      if (get('agentPresets')?.composedPreset(agent.ctx) !== SOCIAL_PRESET) return null
      service.scopedIdentity(grant.scope)
      return grant.scope
    } catch { return null }
  }
  function revoke(agent) {
    const grant = grants.get(agent)
    if (grant) { service.revokeScope(grant.scope); grants.delete(agent) }
  }
  async function openAgent(row, cap) {
    const current = live.get(row.sessionId)
    if (current) {
      if (!scopeForAgent(current.agent)) fail('SOCIAL_SESSION_BINDING_STALE')
      return current.agent
    }
    // Never attach to an agent created/resumed elsewhere without this setup.
    if (typeof cap.agents.list === 'function' && cap.agents.list().some(agent => agent.session?.id === row.sessionId)) fail('SOCIAL_SESSION_NOT_OWNED')
    let admitted
    const setup = async (agentCtx, agent) => {
      checkHeader(agent.session?.header, row)
      await cap.presets.mount(agentCtx, SOCIAL_PRESET)
      if (cap.presets.composedPreset(agentCtx) !== SOCIAL_PRESET || !agentCtx.tools?.restrict || !agentCtx.tools?.guard || !agentCtx.tools?.presentAs) fail('SOCIAL_RESTRICTION_UNAVAILABLE')
      agentCtx.tools.presentAs('native')
      agentCtx.tools.restrict({ allow: [...SOCIAL_TOOL_NAMES] })
      agentCtx.tools.guard(exec => exec.agent === agent && SOCIAL_TOOL_NAMES.includes(exec.name) && scopeForAgent(agent) ? undefined : 'Social restricted session denied')
      cap.permissions.set(agent.session, 'read-only')
      const scope = service.issueScope({ sessionId: row.sessionId, connectionId: row.connectionId, conversation: row.conversation, canSend: true })
      if (scope.identityRevision !== row.identityRevision || scope.sessionKey !== row.sessionKey) { service.revokeScope(scope); fail('SOCIAL_SCOPE_STALE') }
      grants.set(agent, { row, scope }); admitted = agent
      if (typeof agentCtx.effect !== 'function') { revoke(agent); fail('SOCIAL_LIFECYCLE_UNAVAILABLE') }
      agentCtx.effect(() => () => revoke(agent), 'chonkyfish-social: scope')
    }
    let handle
    try {
      if (!row.created) {
        // A previous prepare may have created a durable session before a crash. Never replace it.
        const persisted = await tryReadExisting(cap.persistence, row)
        if (persisted) row.created = true
      }
      handle = row.created
        ? await cap.agents.resume({ resumeSessionId: row.sessionId, agentOptions: cap.model, setup })
        : await cap.agents.create({ sessionId: row.sessionId, meta: { cwd: row.cwd, agentPreset: SOCIAL_PRESET }, agentOptions: cap.model, setup })
      if (!handle?.agent || typeof handle.dispose !== 'function' || handle.agent !== admitted || !scopeForAgent(handle.agent)) fail('SOCIAL_AGENT_SETUP_FAILED')
      row.created = true
      await persist()
      live.set(row.sessionId, handle)
      return handle.agent
    } catch (error) {
      if (admitted) revoke(admitted)
      try { await handle?.dispose?.() } catch {}
      throw error
    }
  }
  async function readEvents(persistence, row) {
    const handle = await persistence.open(row.sessionId, 'read')
    if (!handle) fail('SOCIAL_PERSISTENCE_UNVERIFIED')
    try {
      checkHeader(handle.header, row)
      const result = await handle.read(0)
      if (!Array.isArray(result?.events) || result.events.length > MAX_EVENTS) fail('SOCIAL_PERSISTENCE_UNVERIFIED')
      return result.events
    } finally { await handle.close() }
  }
  async function tryReadExisting(persistence, row) {
    try { await readEvents(persistence, row); return true }
    catch (error) {
      // Only a definite absence permits first creation; corruption/unknown errors never do.
      if (error?.name === 'SessionPersistenceNotFoundError' && error.sessionId === row.sessionId) return false
      throw error
    }
  }
  function matches(message, row, delivery) {
    const source = message?.source
    return message?.id === delivery.messageId && source?.kind === SOURCE && source.version === 1 && source.batchId === delivery.batchId && source.sessionKey === row.sessionKey && source.identityRevision === row.identityRevision && source.connectionId === row.connectionId && source.firstSeq === delivery.fromSeq && source.lastSeq === delivery.throughSeq
  }
  function evidence(events, agent, row, delivery) {
    const committed = events.some(event => event.type === 'user/message' && matches(event.data, row, delivery))
    const inserted = events.some(event => event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted) && event.data.inserted.some(message => matches(message, row, delivery)))
    const pending = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some(message => matches(message, row, delivery))
    return { committed, inserted, pending }
  }
  async function confirmDurable(cap, agent, row, delivery) {
    if (!await cap.sessions.flush(agent.session)) fail('SOCIAL_PERSISTENCE_UNACKNOWLEDGED')
    if (get('sessionPersistence') !== cap.persistence || get('sessionPersistence')?.identity !== cap.backendIdentity) fail('SOCIAL_PERSISTENCE_CHANGED')
    const durable = evidence(await readEvents(cap.persistence, row), agent, row, delivery)
    if (!durable.committed && !(durable.inserted && durable.pending)) fail('SOCIAL_DELIVERY_UNCERTAIN')
    const scope = scopeForAgent(agent)
    if (!scope) fail('SOCIAL_SCOPE_STALE')
    await service.acknowledgeBatch(scope, { batchId: delivery.batchId, sessionKey: row.sessionKey, identityRevision: row.identityRevision, throughSeq: delivery.throughSeq })
    delivery.status = 'acknowledged'
    await persist()
  }
  const bridge = {
    inspect() {
      const cap = capabilities()
      return { available: !closed && !poisoned && cap.available, reason: closed ? 'SOCIAL_BRIDGE_CLOSED' : poisoned ? 'SOCIAL_BRIDGE_STORAGE_UNCERTAIN' : cap.reason, mode: 'explicit-view-only', bindingCount: state.bindings.length, permissionPreset: 'read-only' }
    },
    scopeForAgent,
    view(input) {
      input = structuredClone(input)
      return queue(async () => {
        active()
        const cap = capabilities()
        if (!cap.available) fail(cap.reason)
        const probe = service.issueScope({ sessionId: 'social-view-probe', connectionId: input.connectionId, conversation: input.conversation })
        try {
          const key = digest(JSON.stringify([probe.sessionKey, probe.identityRevision]))
          let row = state.bindings.find(value => value.key === key)
          const batch = await service.readBatch(probe)
          if (row?.delivery && row.delivery.status !== 'acknowledged' && (!batch || batch.batchId !== row.delivery.batchId)) {
            // A crash after inbox ACK but before journal ACK may be repaired only by exact durable evidence.
            const recovering = await openAgent(row, cap)
            await confirmDurable(cap, recovering, row, row.delivery)
          }
          if (!batch) return { status: 'empty' }
          if (!row) {
            if (state.bindings.length >= MAX_BINDINGS) fail('SOCIAL_BINDING_CAPACITY')
            row = { key, sessionKey: probe.sessionKey, identityRevision: probe.identityRevision, connectionId: probe.connectionId, conversation: probe.conversation, sessionId: randomUUID(), cwd: join(root, key), created: false, delivery: null }
            state.bindings.push(row)
            await mkdir(row.cwd, { recursive: true, mode: 0o700 })
            await persist()
          }
          const agent = await openAgent(row, cap)
          const scope = scopeForAgent(agent)
          if (!scope) fail('SOCIAL_SCOPE_STALE')
          if (!row.delivery || row.delivery.batchId !== batch.batchId) {
            if (agent.status !== 'idle') return { status: 'busy', sessionId: row.sessionId }
            row.delivery = { batchId: batch.batchId, messageId: 'social-' + digest(JSON.stringify([row.key, batch.batchId])), fromSeq: batch.fromSeq, throughSeq: batch.throughSeq, status: 'prepared' }
            await persist()
          }
          const delivery = row.delivery
          if (typeof agent.session.snapshotEvents !== 'function') fail('SOCIAL_PERSISTENCE_UNVERIFIED')
          const snapshot = agent.session.snapshotEvents()
          if (!Array.isArray(snapshot) || snapshot.length > MAX_EVENTS) fail('SOCIAL_PERSISTENCE_UNVERIFIED')
          const seen = evidence(snapshot, agent, row, delivery)
          if (!seen.committed && !seen.pending) {
            if (seen.inserted || delivery.status !== 'prepared') fail('SOCIAL_DELIVERY_UNCERTAIN')
            if (agent.status !== 'idle') return { status: 'busy', sessionId: row.sessionId }
            delivery.status = 'attempted'
            await persist() // durable intent before the side effect
            if (!scopeForAgent(agent)) fail('SOCIAL_SCOPE_STALE')
            agent.followup({
              id: delivery.messageId, role: 'user',
              content: [{ type: 'text', text: JSON.stringify({ notice: '以下是主动选择查看的低信任社交消息批次。可以保持沉默；仅显式发送工具对外发信。', hasGap: batch.hasGap, messages: batch.messages.map(message => ({ messageId: message.messageId, sender: message.sender, text: message.text, sentAt: message.sentAt })) }) }],
              source: { kind: SOURCE, version: 1, batchId: batch.batchId, sessionKey: row.sessionKey, identityRevision: row.identityRevision, connectionId: row.connectionId, firstSeq: batch.fromSeq, lastSeq: batch.throughSeq },
            })
          }
          await confirmDurable(cap, agent, row, delivery)
          return { status: 'viewed', sessionId: row.sessionId, batchId: batch.batchId, throughSeq: batch.throughSeq, sentAutomatically: false }
        } finally { service.revokeScope(probe) }
      })
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      for (const handle of live.values()) revoke(handle.agent)
      closePromise = queue(async () => {
        for (const handle of live.values()) { try { await handle.dispose() } catch {} }
        live.clear()
      }, true)
      return closePromise
    },
  }
  return bridge
}
