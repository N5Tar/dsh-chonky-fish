import { createConfigStore } from './config.js'
import { createIdentityStore } from './identity-store.js'
import { createInboxStore } from './inbox-store.js'
import { createOneBotDriver } from './drivers/onebot.js'
import { providerFor, PROVIDERS } from './providers.js'
import { acceptMessage, createScopeAuthority } from './policy.js'
import { fail, readJson, writeJson, serial, sessionKey, text, digest, plain, publicError } from './core.js'

/** No method in this module calls an LLM, follows up an agent, or schedules a reply. */
export async function createSocialService({ paths, limits, env = process.env, driverFactory, now = Date.now }) {
  const configStore = createConfigStore(paths.socialConfig)
  const identities = createIdentityStore(paths.socialIdentities)
  const inbox = await createInboxStore({ directory: paths.socialInbox, limits: limits.inbox, now })
  const scopes = createScopeAuthority()
  const connections = new Map(), listeners = new Set()
  const lifecycle = serial()
  let stopped = false, generation = 0, config = null, configError = null, notificationTimer = null, closePromise = null
  let operations
  try { operations = await readJson(paths.socialOperations, { version: 1, operations: [] }) }
  catch (error) { await inbox.close(); throw error }
  if (!plain(operations) || operations.version !== 1 || !Array.isArray(operations.operations) || operations.operations.length > limits.maxOperations || operations.operations.some(row => !plain(row) || !text(row.operationId) || !text(row.fingerprint) || !['accepted', 'failed', 'unknown'].includes(row.result?.status))) {
    await inbox.close(); fail('SOCIAL_OPERATIONS_INVALID')
  }
  // Persisted in-flight sends remain unknown. Never replay network writes at boot.
  function active() { if (stopped) fail('SOCIAL_STOPPED') }
  function entryFor(connectionId) {
    active()
    const entry = connections.get(connectionId)
    if (!entry || entry.status !== 'connected' || !entry.verified) fail('SOCIAL_NOT_CONNECTED')
    return entry
  }
  function validateScope(scope, sending = false) {
    scopes.check(scope)
    const entry = entryFor(scope.connectionId)
    if (scope.identityRevision !== entry.verified.identityRevision || scope.sessionKey !== sessionKey(entry.config.platform, entry.config.id, scope.conversation)) fail('SOCIAL_SCOPE_STALE')
    if (sending && !scope.canSend) fail('SOCIAL_SEND_FORBIDDEN')
    return entry
  }
  function notify() {
    if (notificationTimer || stopped) return
    notificationTimer = setTimeout(async () => {
      notificationTimer = null
      if (stopped) return
      try { const notices = await listNotices(); for (const listener of listeners) { try { listener(structuredClone(notices)) } catch {} } } catch {}
    }, limits.notificationMs)
    notificationTimer.unref?.()
  }
  async function listNotices() {
    active()
    const notices = await inbox.listNotices()
    return notices.filter(notice => {
      const entry = connections.get(notice.connectionId)
      return entry?.status === 'connected' && entry.verified?.identityRevision === notice.identityRevision
    })
  }
  async function shutdownConnections() {
    generation++
    const previous = [...connections.values()]
    connections.clear()
    await Promise.all(previous.map(async entry => { try { await entry.driver?.stop() } catch {} }))
  }
  async function reload() {
    active()
    await shutdownConnections()
    try { config = await configStore.read(); configError = null }
    catch (error) { config = null; configError = publicError(error); return }
    if (config.connections.length === 0) return
    const current = generation
    for (const value of config.connections) {
      const entry = { config: value, status: 'starting', verified: null, driver: null, ready: Promise.resolve(), lastSendAt: null, epoch: 0 }
      connections.set(value.id, entry)
      try {
        const provider = providerFor(value)
        const token = value.tokenEnv ? env[value.tokenEnv] : undefined
        if (value.tokenEnv && !text(token, 8192)) fail('SOCIAL_TOKEN_MISSING')
        entry.driver = driverFactory ? driverFactory(value, { token, protocol: provider.protocol }) : createOneBotDriver(value, { token, version: provider.protocol === 'onebot-v11' ? 11 : 12 })
        await entry.driver.start({
          onStatus(status, reason) {
            if (stopped || current !== generation) return
            const verificationEpoch = ++entry.epoch
            entry.status = status === 'connected' ? 'starting' : status
            entry.reason = reason
            entry.verified = null
            if (status === 'connected') {
              entry.ready = (async () => {
                try {
                  const identity = await entry.driver.getSelfIdentity()
                  if (identity.connectionId !== value.id || identity.platform !== value.platform || identity.provider !== value.provider) fail('SOCIAL_IDENTITY_MISMATCH')
                  if (stopped || current !== generation || verificationEpoch !== entry.epoch) return
                  const verified = await identities.verify(identity)
                  if (stopped || current !== generation || verificationEpoch !== entry.epoch) return
                  entry.status = verified.status
                  entry.verified = verified.status === 'connected' ? verified : null
                } catch (error) { if (current === generation && verificationEpoch === entry.epoch) { entry.status = 'error'; entry.reason = publicError(error) } }
              })()
            }
          },
          async onMessage(message) {
            await entry.ready
            if (stopped || current !== generation || entry.status !== 'connected' || !entry.verified) return { accepted: false }
            if (!acceptMessage(value, entry.verified.identity, message, limits.inbox.maxBatchChars)) return { accepted: false }
            const result = await inbox.append(message, { identityRevision: entry.verified.identityRevision })
            if (result.accepted) notify()
            return result
          },
        })
      } catch (error) {
        entry.epoch++; entry.status = 'error'; entry.verified = null; entry.reason = publicError(error)
        try { await entry.driver?.stop() } catch {}
      }
    }
    await Promise.all([...connections.values()].map(entry => entry.ready))
  }
  const service = {
    async inspect() {
      active()
      return { configError, inferenceOnArrival: false, actionEngineConnected: false,
        providers: Object.values(PROVIDERS),
        connections: [...connections.values()].map(entry => ({ connectionId: entry.config.id, platform: entry.config.platform, provider: entry.config.provider, status: entry.status, reason: entry.reason, identity: entry.verified?.identity, identityRevision: entry.verified?.identityRevision })),
        notices: await listNotices() }
    },
    readConfig: () => configStore.read(),
    updateConfig: value => lifecycle(async () => { active(); await configStore.write(value); await reload(); return service.inspect() }),
    reload: () => lifecycle(reload),
    confirmIdentity: input => lifecycle(async () => { active(); await identities.confirm(input); await reload(); return service.inspect() }),
    listIdentityRecords: () => identities.list(), // Host management only; tools use scopedIdentity.
    subscribe(listener) { active(); if (typeof listener !== 'function') fail('SOCIAL_INVALID_LISTENER'); listeners.add(listener); return () => listeners.delete(listener) },
    listNotices,
    // Host-only issuance, never exposed directly as an HTTP/tool action.
    issueScope({ sessionId, connectionId, conversation, canSend = false }) {
      const entry = entryFor(connectionId)
      return scopes.issue({ sessionId, connectionId, conversation, platform: entry.config.platform, identityRevision: entry.verified.identityRevision, canSend })
    },
    revokeScope: scope => scopes.revoke(scope),
    scopedIdentity(scope) { const entry = validateScope(scope); return structuredClone(entry.verified.identity) },
    async scopedNotices(scope) { validateScope(scope); return (await listNotices()).filter(value => value.sessionKey === scope.sessionKey) },
    readBatch(scope, { maxMessages = 50, maxChars = limits.inbox.maxBatchChars } = {}) { return lifecycle(async () => {
      validateScope(scope)
      const batch = await inbox.readBatch({ sessionKey: scope.sessionKey, identityRevision: scope.identityRevision, maxMessages, maxChars })
      validateScope(scope)
      return batch
    }) },
    acknowledgeBatch(scope, batch) { return lifecycle(async () => {
      validateScope(scope)
      if (batch.sessionKey !== scope.sessionKey || batch.identityRevision !== scope.identityRevision) fail('SOCIAL_BATCH_FORBIDDEN')
      const result = await inbox.acknowledgeBatch(batch, () => validateScope(scope))
      notify()
      return result
    }) },
    send(scope, input) {
      input = structuredClone(input)
      return lifecycle(async () => {
      const entry = validateScope(scope, true)
      const sendingEpoch = entry.epoch
      if (!plain(input) || !text(input.operationId, 128) || !text(input.text, limits.maxSendChars)) fail('SOCIAL_INVALID_SEND')
      if (input.connectionId !== scope.connectionId || sessionKey(entry.config.platform, input.connectionId, input.conversation) !== scope.sessionKey) fail('SOCIAL_TARGET_FORBIDDEN')
      if (input.replyToMessageId !== undefined && !text(input.replyToMessageId)) fail('SOCIAL_INVALID_SEND')
      const fingerprint = digest(JSON.stringify([scope.sessionKey, scope.identityRevision, input.text, input.replyToMessageId ?? '']))
      const previous = operations.operations.find(row => row.operationId === input.operationId)
      if (previous) { if (previous.fingerprint !== fingerprint) fail('SOCIAL_OPERATION_CONFLICT'); return structuredClone(previous.result) }
      if (entry.lastSendAt !== null && now() - entry.lastSendAt < limits.sendIntervalMs) fail('SOCIAL_RATE_LIMITED')
      // At capacity reject rather than evict idempotency records and risk replay.
      if (operations.operations.length >= limits.maxOperations) fail('SOCIAL_OPERATION_CAPACITY')
      const row = { operationId: input.operationId, fingerprint, at: now(), result: { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' } }
      operations.operations.push(row)
      try { await writeJson(paths.socialOperations, operations) }
      catch { operations.operations.pop(); fail('SOCIAL_STORAGE_FAILED') }
      if (validateScope(scope, true) !== entry || sendingEpoch !== entry.epoch) fail('SOCIAL_SCOPE_STALE')
      entry.lastSendAt = now()
      let result
      try { result = await entry.driver.sendText({ conversation: scope.conversation, text: input.text, replyToMessageId: input.replyToMessageId }) }
      catch { result = { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' } }
      if (!['accepted', 'failed', 'unknown'].includes(result?.status)) result = { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' }
      row.result = { status: result.status, ...(text(result.messageId) ? { messageId: result.messageId } : {}), ...(result.status !== 'accepted' ? { errorCode: result.status === 'unknown' ? 'SOCIAL_SEND_UNKNOWN' : 'SOCIAL_SEND_FAILED' } : {}) }
      try { await writeJson(paths.socialOperations, operations) }
      catch { row.result = { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' } }
      return structuredClone(row.result)
    }) },
    close() {
      if (closePromise) return closePromise
      stopped = true; clearTimeout(notificationTimer); listeners.clear()
      closePromise = lifecycle(async () => {
        await shutdownConnections()
        await inbox.close()
      }, true)
      return closePromise
    },
  }
  await service.reload()
  return service
}
