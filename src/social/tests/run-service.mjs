import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createResources } from '../../resources/index.js'
import { createConfigStore } from '../config.js'
import { createSocialService } from '../service.js'
import { createFakeDriver } from '../drivers/fake.js'
import { DEFAULT_INBOX_LIMITS } from '../inbox-store.js'

const directory = await mkdtemp(join(tmpdir(), 'social-service-'))
const resources = createResources({ homeRoot: directory })
const limits = { ...resources.spec.SOCIAL.limits, inbox: DEFAULT_INBOX_LIMITS, sendIntervalMs: 1 }
const target = { type: 'direct', id: '20002' }
const config = { version: 1, connections: [{ id: 'main', platform: 'qq', provider: 'napcat', endpoint: 'ws://127.0.0.1:3001/' }] }
await createConfigStore(resources.paths.socialConfig).write(config)
let driver
const service = await createSocialService({ paths: resources.paths, limits, driverFactory: value => (driver = createFakeDriver(value)) })
const message = { messageId: '1', conversation: target, sender: { id: '20002' }, text: '你好', sentAt: Date.now() }
assert.equal((await driver.emit(message)).accepted, true)
assert.equal(driver.sent.length, 0)
let view = await service.inspect()
assert.equal(view.inferenceOnArrival, false)
assert.equal(view.actionEngineConnected, false)
assert.equal(view.notices[0].unreadCount, 1)
assert.equal(JSON.stringify(view.notices).includes('你好'), false)
assert.equal((await driver.emit(message)).duplicate, true)
assert.equal((await driver.emit({ ...message, messageId: '2', sender: { id: '10001' } })).accepted, false)
await assert.rejects(service.readBatch({ connectionId: 'main', canSend: true }))
const scope = service.issueScope({ sessionId: 'safe-agent', connectionId: 'main', conversation: target, canSend: true })
const batch = await service.readBatch(scope)
await driver.emit({ ...message, messageId: '2', text: '第二条' })
await service.acknowledgeBatch(scope, batch)
view = await service.inspect()
assert.equal(view.notices[0].unreadCount, 1)
assert.equal(driver.sent.length, 0) // reading and acknowledging never sends
await assert.rejects(service.send(scope, { operationId: 'bad', connectionId: 'main', conversation: { type: 'direct', id: 'other' }, text: 'no' }))
const input = { operationId: 'one', connectionId: 'main', conversation: target, text: '明确回复' }
assert.equal((await service.send(scope, input)).status, 'accepted')
assert.equal((await service.send(scope, input)).status, 'accepted')
assert.equal(driver.sent.length, 1)
await assert.rejects(service.send(scope, { ...input, text: 'changed' }))
await service.close()
await assert.rejects(service.readBatch(scope))
const restarted = await createSocialService({ paths: resources.paths, limits, driverFactory: value => (driver = createFakeDriver(value)) })
assert.equal((await restarted.inspect()).notices[0].unreadCount, 1)
const nextScope = restarted.issueScope({ sessionId: 'safe-agent', connectionId: 'main', conversation: target, canSend: true })
assert.equal((await restarted.send(nextScope, input)).status, 'accepted')
assert.equal(driver.sent.length, 0)
// 没有连接就没有可用的社交能力；收件箱通知也随之不再展示。
await restarted.updateConfig({ version: 1, connections: [] })
await assert.rejects(restarted.send(nextScope, { ...input, operationId: 'two' }))
assert.deepEqual((await restarted.inspect()).notices, [])
await restarted.close()
// A disconnected socket must not be re-authorized by a late identity query.
const delayedRoot = await mkdtemp(join(tmpdir(), 'social-delayed-'))
const delayedResources = createResources({ homeRoot: delayedRoot })
await createConfigStore(delayedResources.paths.socialConfig).write(config)
let callbacks, resolveIdentity
const pendingIdentity = new Promise(resolve => { resolveIdentity = resolve })
const delayed = await createSocialService({ paths: delayedResources.paths, limits, driverFactory: () => ({
  async start(value) { callbacks = value }, async stop() {},
  getSelfIdentity: () => pendingIdentity,
  async sendText() { throw new Error('must not send') },
}) })
callbacks.onStatus('connected')
callbacks.onStatus('disconnected')
resolveIdentity({ connectionId: 'main', platform: 'qq', provider: 'napcat', protocolUserId: '10001' })
await callbacks.onMessage(message)
assert.equal((await delayed.inspect()).connections[0].status, 'disconnected')
assert.throws(() => delayed.issueScope({ sessionId: 'x', connectionId: 'main', conversation: target, canSend: true }))
await delayed.close()
// Invalid but syntactically valid journals must release inbox ownership.
const badRoot = await mkdtemp(join(tmpdir(), 'social-bad-journal-'))
const badResources = createResources({ homeRoot: badRoot })
await mkdir(badResources.paths.social, { recursive: true })
await writeFile(badResources.paths.socialOperations, JSON.stringify({ version: 1, operations: [null] }))
await assert.rejects(createSocialService({ paths: badResources.paths, limits }), { code: 'SOCIAL_OPERATIONS_INVALID' })
await writeFile(badResources.paths.socialOperations, JSON.stringify({ version: 1, operations: [] }))
const recovered = await createSocialService({ paths: badResources.paths, limits })
assert.deepEqual((await recovered.inspect()).connections, [])
await recovered.close()
console.log('social-service: PASS (zero inference, scoped read, silent ack, explicit send, restart/dedup, revocation, stale handshake)')
