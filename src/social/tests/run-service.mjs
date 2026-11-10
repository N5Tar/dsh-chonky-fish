import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createSocialHttpHandler } from '../http.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createResources } from '../../resources/index.js'
import { createConfigStore } from '../config.js'
import { createSocialService } from '../service.js'
import { createFakeDriver } from '../drivers/fake.js'
import { createPeerBindings } from '../peer-bindings.js'
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
const scope = service.issueScope({ sessionId: 'safe-agent', connectionId: 'main', conversation: target })
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
const nextScope = restarted.issueScope({ sessionId: 'safe-agent', connectionId: 'main', conversation: target })
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
assert.throws(() => delayed.issueScope({ sessionId: 'x', connectionId: 'main', conversation: target }))
await delayed.close()
// A real Stream starts asynchronously: retained unread must become discoverable
// on verified connection, without waiting for another platform message.
const lateResources = createResources({ homeRoot: await mkdtemp(join(tmpdir(), 'social-late-connect-')) })
await createConfigStore(lateResources.paths.socialConfig).write(config)
let seedDriver
const seeded = await createSocialService({ paths: lateResources.paths, limits, driverFactory: value => (seedDriver = createFakeDriver(value)) })
await seedDriver.emit(message)
await seeded.close()
let lateCallbacks
const lateService = await createSocialService({ paths: lateResources.paths, limits: { ...limits, notificationMs: 1 }, driverFactory: value => {
  const driver = createFakeDriver(value)
  driver.start = async callbacks => { lateCallbacks = callbacks }
  return driver
} })
assert.deepEqual(await lateService.listNotices(), [])
let unsubscribe
const becameVisible = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('verified reconnect did not notify retained unread')), 1000)
  unsubscribe = lateService.subscribe(rows => { if (rows.some(row => row.unreadCount === 1)) { clearTimeout(timeout); resolve(rows) } })
})
lateCallbacks.onStatus('connected')
assert.equal((await becameVisible)[0].unreadCount, 1)
unsubscribe()
await lateService.close()

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
// DingTalk credentials are resolved only by Host; config/inspect never disclose them.
const dingRoot = await mkdtemp(join(tmpdir(), 'social-dingtalk-service-'))
const dingResources = createResources({ homeRoot: dingRoot })
const dingConfig = { version: 1, connections: [{ id: 'ding', platform: 'dingtalk', provider: 'dingtalk-stream', clientId: 'app', robotCode: 'robot', clientSecretEnv: 'DING_SECRET' }] }
await createConfigStore(dingResources.paths.socialConfig).write(dingConfig)
const missingSecret = await createSocialService({ paths: dingResources.paths, limits, env: { DING_SECRET: 'must-not-read-env' }, driverFactory: () => assert.fail('must not start from legacy env') })
assert.equal((await missingSecret.readConfig()).connections[0].clientSecretSet, false)
assert.equal((await missingSecret.inspect()).connections[0].reason, 'SOCIAL_DINGTALK_SECRET_MISSING')
await missingSecret.close()
let dingDriver, observedSecret
const dingService = await createSocialService({ paths: dingResources.paths, limits, env: {}, driverFactory: (value, options) => {
  if (value.platform !== 'dingtalk') return createFakeDriver(value)
  assert.equal(options.protocol, 'dingtalk-stream'); observedSecret = options.clientSecret
  dingDriver = createFakeDriver(value)
  dingDriver.sendText = async () => ({ status: 'failed', errorCode: 'SOCIAL_WEBHOOK_EXPIRED' })
  return dingDriver
} })
const legacyPublic = await dingService.readConfig()
assert.equal(legacyPublic.connections[0].clientSecretEnv, undefined)
await dingService.updateConfig({ ...legacyPublic, connections: [{ ...legacyPublic.connections[0], clientSecret: 'secret-test-value' }, config.connections[0]] })
assert.equal(observedSecret, 'secret-test-value')
const publicDing = await dingService.readConfig()
assert.equal(JSON.stringify(await dingService.inspect()).includes('secret-test-value'), false)
assert.equal(JSON.stringify(publicDing).includes('secret-test-value'), false)
assert.equal(publicDing.connections[0].clientSecretSet, true)
let stored = JSON.parse(await readFile(dingResources.paths.socialConfig, 'utf8'))
assert.equal(stored.connections[0].clientSecret, 'secret-test-value')
assert.equal(stored.connections[0].clientSecretEnv, undefined)
assert.equal(stored.connections[0].clientSecretSet, undefined)
if (process.platform !== 'win32') assert.equal((await stat(dingResources.paths.socialConfig)).mode & 0o777, 0o600)
// Saving an unrelated connection, blank editing, and deleting unrelated connections retain it.
await dingService.updateConfig(publicDing)
await dingService.updateConfig({ ...publicDing, connections: [{ ...publicDing.connections[0], clientSecret: '' }] })
assert.equal(observedSecret, 'secret-test-value')
for (const patch of [{ id: 'another' }, { clientId: 'other-app' }, { robotCode: 'other-robot' }]) {
  await assert.rejects(dingService.updateConfig({ version: 1, connections: [{ ...publicDing.connections[0], ...patch }] }), { code: 'SOCIAL_DINGTALK_SECRET_MISSING' })
}
await assert.rejects(dingService.updateConfig({ version: 1, connections: [{ ...publicDing.connections[0], clientSecret: ' ' }] }), { code: 'SOCIAL_DINGTALK_SECRET_INVALID' })
// A client-supplied set marker cannot invent a saved credential.
await assert.rejects(dingService.updateConfig({ version: 1, connections: [{ ...publicDing.connections[0], id: 'new', clientSecretSet: true }] }), { code: 'SOCIAL_DINGTALK_SECRET_MISSING' })
await dingService.updateConfig({ version: 1, connections: [{ ...publicDing.connections[0], clientSecret: 'replacement-secret' }] })
assert.equal(observedSecret, 'replacement-secret')
assert.equal(JSON.parse(await readFile(dingResources.paths.socialConfig, 'utf8')).connections[0].clientSecret, 'replacement-secret')
// Exercise the real service + HTTP management response, not a stub projection.
const handler = createSocialHttpHandler({ service: dingService })
for (const method of ['GET', 'HEAD', 'POST']) {
  const body = { action: 'configure', config: await dingService.readConfig() }
  if (method === 'POST') body.config.connections[0].clientSecret = 'replacement-secret'
  const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method
  const response = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await handler(req, response)
  assert.equal(response.status, 200)
  assert.equal(String(response.body).includes('replacement-secret'), false)
  assert.equal(String(response.body).includes('secret-test-value'), false)
}
const badSecretBody = { action: 'configure', config: { version: 1, connections: [{ ...publicDing.connections[0], clientSecret: 'do-not-echo-this-secret', forbidden: true }] } }
const badSecretReq = Readable.from([Buffer.from(JSON.stringify(badSecretBody))]); badSecretReq.method = 'POST'
const badSecretResponse = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
await handler(badSecretReq, badSecretResponse)
assert.equal(badSecretResponse.status, 409)
assert.equal(badSecretResponse.body.includes('do-not-echo-this-secret'), false)
assert.equal(JSON.parse(await readFile(dingResources.paths.socialConfig, 'utf8')).connections[0].clientSecret, 'replacement-secret')
assert.equal((await dingDriver.emit(message)).accepted, true)
assert.equal((await dingDriver.emit(message)).duplicate, true)
const dingScope = dingService.issueScope({ sessionId: 'ding-session', connectionId: 'ding', conversation: target })
assert.equal((await dingService.send(dingScope, { operationId: 'expired', connectionId: 'ding', conversation: target, text: 'hello' })).errorCode, 'SOCIAL_WEBHOOK_EXPIRED')
await dingService.close()
const dingRestart = await createSocialService({ paths: dingResources.paths, limits, env: {}, driverFactory: (value, options) => {
  assert.equal(options.clientSecret, 'replacement-secret')
  return createFakeDriver(value)
} })
assert.equal((await dingRestart.inspect()).connections[0].status, 'connected')
assert.equal(JSON.stringify(await dingRestart.readConfig()).includes('replacement-secret'), false)
await dingRestart.close()
// Proactive owner messaging resolves its target in the Host, not from model input.
const ownerRoot = await mkdtemp(join(tmpdir(), 'social-owner-'))
const ownerResources = createResources({ homeRoot: ownerRoot })
const ownerConfig = { version: 1, connections: [{ id: 'ding', platform: 'dingtalk', provider: 'dingtalk-stream', clientId: 'app', robotCode: 'robot', clientSecret: 'owner-secret' }] }
await createConfigStore(ownerResources.paths.socialConfig).write(ownerConfig)
let ownerCalls = 0, ownerResult = { status: 'accepted' }, ownerDriver
const ownerPeers = await createPeerBindings({ file: ownerResources.paths.socialPeerBindings })
const ownerArgs = []
const ownerService = await createSocialService({ paths: ownerResources.paths, limits, env: {}, peers: ownerPeers, driverFactory: value => {
  ownerDriver = createFakeDriver(value)
  ownerDriver.sendOwner = async args => { ownerCalls++; ownerArgs.push(structuredClone(args)); assert.equal(args.text, '该喝水了'); return { ...ownerResult } }
  return ownerDriver
} })
assert.deepEqual(ownerService.capabilityState(), { dingtalk: { connected: true, ownerBound: false } })
await assert.rejects(ownerService.sendOwner({ operationId: 'unpaired', text: '该喝水了' }), { code: 'SOCIAL_NO_OWNER_CHAT' })
const stranger = { ...message, messageId: 'stranger-1', conversation: { type: 'direct', id: 'stranger-chat' }, sender: { id: 'stranger', staffId: 'STRANGER_STAFF', corpId: 'corp' } }
assert.equal((await ownerDriver.emit(stranger)).accepted, true)
await assert.rejects(ownerService.sendOwner({ operationId: 'first-dm-is-not-owner', text: '该喝水了' }), { code: 'SOCIAL_NO_OWNER_CHAT' })
assert.equal(ownerCalls, 0)
const issued = await ownerService.issuePairingCode({ connectionId: 'ding' })
assert.match(issued.code, /^FISH-PAIR-/)
let pairingView = await ownerService.inspect()
assert.deepEqual(pairingView.bindings, { ownerCount: 0, peerCount: 0, pendingCodeCount: 1 })
assert.deepEqual(pairingView.connections[0].owner, { bound: false, available: false })
assert.equal(JSON.stringify(pairingView).includes(issued.code), false)
const pairMessage = { ...message, messageId: 'pair-control', text: issued.code, sender: { id: 'paired-owner', staffId: 'PRIVATE_PAIRED_STAFF', corpId: 'PRIVATE_CORP' } }
assert.deepEqual(await ownerDriver.emit({ ...pairMessage, messageId: 'pair-in-group', conversation: { type: 'group', id: 'group' } }), { accepted: true, control: true })
assert.deepEqual((await ownerService.inspect()).connections[0].owner, { bound: false, available: false })
assert.deepEqual(await ownerDriver.emit(pairMessage), { accepted: true, control: true })
assert.deepEqual(await ownerDriver.emit({ ...pairMessage, messageId: 'replayed-code' }), { accepted: true, control: true })
assert.deepEqual(await ownerDriver.emit({ ...pairMessage, messageId: 'bad-code', text: 'FISH-PAIR-malformed' }), { accepted: true, control: true })
pairingView = await ownerService.inspect()
assert.deepEqual(pairingView.bindings, { ownerCount: 1, peerCount: 0, pendingCodeCount: 0 })
assert.deepEqual(pairingView.connections[0].owner, { bound: true, available: true })
assert.deepEqual(ownerService.capabilityState(), { dingtalk: { connected: true, ownerBound: true } }, 'capability facts contain only booleans, never owner IDs or credentials')
assert.equal(pairingView.notices.length, 1); assert.equal(pairingView.notices[0].unreadCount, 1, 'all pairing control messages bypass the inbox')
const controlScope = ownerService.issueScope({ sessionId: 'test', connectionId: 'ding', conversation: target })
assert.equal(await ownerService.readBatch(controlScope), null, 'pairing code never enters an owner model batch')
ownerService.revokeScope(controlScope)
assert.equal((await ownerDriver.emit({ ...stranger, messageId: 'stranger-newest' })).accepted, true)
assert.deepEqual(await ownerService.sendOwner({ operationId: 'owner-1', text: '该喝水了', conversation: stranger.conversation, staffId: 'ATTACKER_OVERRIDE' }), { status: 'accepted' })
assert.deepEqual(ownerArgs[0], { text: '该喝水了', conversation: target, staffId: 'PRIVATE_PAIRED_STAFF' })
assert.equal(ownerCalls, 1)
assert.deepEqual(await ownerService.sendOwner({ operationId: 'owner-1', text: '该喝水了' }), { status: 'accepted' })
assert.equal(ownerCalls, 1, 'same operation never sends twice')
await assert.rejects(ownerService.sendOwner({ operationId: 'owner-1', text: '换一句' }), { code: 'SOCIAL_OPERATION_CONFLICT' })
ownerResult = { status: 'failed', errorCode: 'SOCIAL_NO_OWNER_CHAT' }
assert.deepEqual(await ownerService.sendOwner({ operationId: 'owner-2', text: '该喝水了' }), { status: 'failed', errorCode: 'SOCIAL_NO_OWNER_CHAT' })
ownerResult = { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' }
assert.deepEqual(await ownerService.sendOwner({ operationId: 'owner-3', text: '该喝水了' }), { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' })
assert.deepEqual(await ownerService.sendOwner({ operationId: 'owner-3', text: '该喝水了' }), { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' })
assert.equal(ownerCalls, 3, 'unknown operation is not dispatched twice')
const ownerPublic = JSON.stringify(await ownerService.inspect())
for (const secret of ['owner-secret', 'robot', 'PRIVATE_PAIRED_STAFF', 'PRIVATE_CORP', issued.code]) assert.equal(ownerPublic.includes(secret), false)
const replaceCode = await ownerService.issuePairingCode({ connectionId: 'ding' })
assert.deepEqual(await ownerDriver.emit({ ...stranger, messageId: 'explicit-rebind', text: replaceCode.code }), { accepted: true, control: true })
await assert.rejects(ownerService.sendOwner({ operationId: 'owner-1', text: '该喝水了' }), { code: 'SOCIAL_OPERATION_CONFLICT' })
assert.equal(ownerCalls, 3, 're-pairing cannot replay an old operation toward a new owner')
await ownerService.close(); await ownerPeers.close()
assert.deepEqual(ownerService.capabilityState(), { dingtalk: { connected: false, ownerBound: false } })
// Without the injected pairing authority, even a ready driver cannot infer an owner.
const missingPeers = await createSocialService({ paths: ownerResources.paths, limits, driverFactory: value => {
  const driver = createFakeDriver(value); driver.sendOwner = async () => assert.fail('must not dispatch without pairing authority'); return driver
} })
await assert.rejects(missingPeers.sendOwner({ operationId: 'no-peers', text: 'hi' }), { code: 'SOCIAL_NO_OWNER_CHAT' })
assert.throws(() => missingPeers.issuePairingCode({ connectionId: 'ding' }), { code: 'SOCIAL_PAIRING_UNAVAILABLE' })
await missingPeers.close()
const emptyRoot = await mkdtemp(join(tmpdir(), 'social-owner-empty-'))
const noChannel = await createSocialService({ paths: createResources({ homeRoot: emptyRoot }).paths, limits })
await assert.rejects(noChannel.sendOwner({ operationId: 'owner-x', text: 'hi' }), { code: 'SOCIAL_NO_OWNER_CHAT' })
await noChannel.close()
console.log('social-service: PASS (zero inference, scoped read, silent ack, explicit send, restart/dedup, revocation, stale handshake, DingTalk secret isolation, explicit owner pairing/control consumption, proactive target isolation)')
