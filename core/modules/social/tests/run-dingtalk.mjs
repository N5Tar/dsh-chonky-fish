import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createDingTalkRouteStore, validateDingTalkRoute } from '../dingtalk-routes.js'
import { writeJson } from '../core.js'
import { createDingTalkDriver, DINGTALK_ROBOT_TOPIC, normalizeDingTalkEvent } from '../drivers/dingtalk.js'

const config = { id: 'ding', platform: 'dingtalk', provider: 'dingtalk-stream', clientId: 'application', robotCode: 'robot' }
const clock = { value: 1700000000000 }
const event = (overrides = {}) => ({ robotCode: 'robot', msgtype: 'text', text: { content: '你好' }, msgId: 'message-1', conversationId: 'conversation', conversationType: '1', senderId: 'sender', chatbotUserId: 'bot-user', createAt: clock.value, sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=SECRET_ROUTE', sessionWebhookExpiredTime: clock.value + 60000, ...overrides })
const frame = (data = event(), overrides = {}) => ({ type: 'CALLBACK', headers: { topic: DINGTALK_ROBOT_TOPIC, messageId: 'transport-id' }, data: JSON.stringify(data), ...overrides })
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) { const deadline = Date.now() + 2000; do { if (predicate()) return; await tick() } while (Date.now() < deadline); assert.fail('condition did not settle') }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status }) }
class Socket {
  readyState = 0; listeners = new Map(); sent = []; closed = false
  addEventListener(name, fn) { this.listeners.set(name, fn) }
  on(name, fn) { this.listeners.set(name, fn) }
  ping(data, mask, callback) { callback?.(); this.emit('pong', Buffer.from(data)) }
  emit(name, data) { return this.listeners.get(name)?.(data) }
  open() { this.readyState = 1; this.emit('open') }
  message(value) { this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }) }
  send(value) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 3; this.closed = true; this.emit('close') }
}
async function setup(options = {}, onMessage = async () => ({ accepted: true }), connection = config) {
  const sockets = [], requests = [], messages = [], statuses = []
  let responder = async () => json({ errcode: 0 })
  const driver = createDingTalkDriver(connection, { clientSecret: 'CLIENT_SECRET', now: () => clock.value, reconnectMs: 60000, sendIntervalMs: 0, pingIntervalMs: 0, // Protocol-only fake; real Ping/Pong is covered by run-stream-liveness.
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      if (url.includes('/connections/open')) return json({ endpoint: 'wss://wss-open-connection.dingtalk.com/connect', ticket: 'TICKET' })
      return responder(url, init)
    }, socketFactory: url => { const ws = new Socket(); ws.url = url; sockets.push(ws); return ws }, ...options })
  await driver.start({ onStatus: (state, reason) => statuses.push([state, reason]), onMessage: async value => { messages.push(value); return onMessage(value) } })
  await until(() => sockets.length > 0)
  const ws = sockets[0]; ws.open()
  return { driver, ws, sockets, requests, messages, statuses, respond(fn) { responder = fn } }
}
const target = { type: 'direct', id: 'conversation' }
const send = driver => driver.sendText({ conversation: target, text: '回复' })

// Official registration and identity are ready synchronously at connected notification.
{
  const h = await setup()
  assert.deepEqual(JSON.parse(h.requests[0].init.body).subscriptions, [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }])
  assert.equal(h.requests[0].init.redirect, 'error')
  assert.equal(new URL(h.ws.url).searchParams.get('ticket'), 'TICKET')
  const self = await h.driver.getSelfIdentity()
  assert.equal(self.protocolUserId, 'robot'); assert.equal(self.platformUserId, undefined)
  assert.equal((await send(h.driver)).errorCode, 'SOCIAL_WEBHOOK_EXPIRED')
  h.ws.message(frame()); await until(() => h.ws.sent.length === 1)
  assert.equal(h.messages[0].conversation.id, 'conversation')
  assert.equal(h.messages[0].sender.id, 'sender')
  assert.equal(JSON.stringify(h.messages).includes('SECRET_ROUTE'), false)
  assert.equal(JSON.stringify(h.statuses).includes('CLIENT_SECRET'), false)
  assert.deepEqual(h.ws.sent[0], { code: 200, headers: { contentType: 'application/json', messageId: 'transport-id' }, message: 'OK', data: '{}' })
  assert.equal((await send(h.driver)).status, 'accepted')
  assert.deepEqual(JSON.parse(h.requests[1].init.body), { msgtype: 'text', text: { content: '回复' } })
  assert.equal(h.requests[1].init.redirect, 'error')
  // Arrival diagnostics separate "never pushed" from "ignored on arrival".
  h.ws.message(frame(event({ conversationType: '2' }))); await tick()
  h.ws.message(frame(event({ msgtype: 'image', text: undefined }))); await tick()
  const stats = h.driver.inspect().inbound
  assert.equal(stats.callback, 3); assert.equal(stats.accepted, 1)
  assert.equal(stats.ignored, 2); assert.equal(stats.reasons['group-not-at'], 1); assert.equal(stats.reasons['non-text'], 1)
  assert.equal(JSON.stringify(stats).includes('SECRET_ROUTE'), false, 'diagnostics never leak the reply route')
  assert.equal((await h.driver.sendText({ conversation: target, text: 'reply', replyToMessageId: 'message-1' })).errorCode, 'SOCIAL_REPLY_UNSUPPORTED')
  const ping = { type: 'SYSTEM', headers: { topic: 'ping', messageId: 'ping-id' }, data: 'opaque' }
  h.ws.message(ping); assert.equal(h.ws.sent.at(-1).data, 'opaque')
  h.ws.message({ ...ping, headers: { ...ping.headers, topic: 'disconnect' } }); assert.equal(h.ws.closed, true)
  await h.driver.stop()
}
// Official SYSTEM disconnect example omits messageId: graceful disconnect, no ACK/error.
{
  const h = await setup()
  h.ws.message({ type: 'SYSTEM', headers: { topic: 'disconnect', contentType: 'application/json' }, data: '{"reason":"connection is expired"}' })
  assert.equal(h.ws.closed, true); assert.equal(h.ws.sent.length, 0)
  assert.deepEqual(h.statuses.at(-1), ['disconnected', 'SOCIAL_CONNECTION_LOST'])
  assert.equal(h.statuses.some(([state]) => state === 'error'), false)
  await h.driver.stop()
}
// Unlike disconnect, ping still needs a valid messageId to echo an ACK.
{
  const h = await setup()
  h.ws.message({ type: 'SYSTEM', headers: { topic: 'ping', contentType: 'application/json' }, data: '{"opaque":"nonce"}' })
  assert.equal(h.ws.closed, true); assert.equal(h.ws.sent.length, 0)
  assert.ok(h.statuses.some(([state, reason]) => state === 'error' && reason === 'SOCIAL_EVENT_REJECTED'))
  await h.driver.stop()
}
// Delivery only ACKs persisted/known duplicate records; neither rejection nor throw counts.
for (const result of [{ accepted: false }, { accepted: false, duplicate: true }, undefined, { accepted: true }]) {
  const gate = deferred(), h = await setup({}, () => gate.promise)
  h.ws.message(frame()); await until(() => h.messages.length === 1)
  assert.equal(h.ws.sent.length, 0); gate.resolve(result); await tick()
  assert.equal(h.ws.sent.length, result?.accepted || result?.duplicate ? 1 : 0)
  await h.driver.stop()
}
{
  const h = await setup({}, async () => { throw new Error('private storage path SECRET') })
  h.ws.message(frame()); await until(() => h.ws.closed)
  assert.equal(h.ws.sent.length, 0); assert.equal(JSON.stringify(h.statuses).includes('SECRET'), false)
  await h.driver.stop()
}
// Filters and identity checks; group @ is explicit, no heuristic nickname or text parsing.
{
  const h = await setup()
  for (const override of [{ msgtype: 'picture' }, { conversationType: '2', isInAtList: false }, { senderId: 'bot-user' }, { text: { content: ' ' } }]) h.ws.message(frame(event(override)))
  assert.equal(h.messages.length, 0); assert.equal(h.ws.sent.length, 4)
  h.ws.message(frame(event({ conversationType: '2', isInAtList: true }))); await until(() => h.messages.length === 1)
  assert.equal(h.messages[0].mentionsSelf, true); assert.equal(h.messages[0].conversation.type, 'group')
  h.ws.message(frame(event({ robotCode: 'other' }))); assert.equal(h.ws.closed, true)
  assert.ok(h.statuses.some(([, reason]) => reason === 'SOCIAL_EVENT_IDENTITY_MISMATCH'))
  await h.driver.stop()
}
// SSRF prevention: valid inbox messages survive unusable routes, but cannot send.
for (const url of ['http://oapi.dingtalk.com/robot/sendBySession?session=x', 'https://evil.test/robot/sendBySession?session=x', 'https://oapi.dingtalk.com.evil.test/robot/sendBySession?session=x', 'https://user@oapi.dingtalk.com/robot/sendBySession?session=x', 'https://oapi.dingtalk.com/robot/send?session=x', 'https://oapi.dingtalk.com/robot/sendBySession?session=x&session=y', 'https://oapi.dingtalk.com/robot/sendBySession?session=x#secret']) {
  const h = await setup(); h.ws.message(frame(event({ sessionWebhook: url }))); await until(() => h.ws.sent.length === 1)
  assert.equal((await send(h.driver)).errorCode, 'SOCIAL_WEBHOOK_EXPIRED'); assert.equal(h.requests.length, 1)
  await h.driver.stop()
}
{
  const h = await setup({ maxWebhooks: 1 }); h.ws.message(frame()); await until(() => h.ws.sent.length === 1)
  h.ws.message(frame(event({ conversationId: 'other' }))); await until(() => h.ws.sent.length === 2)
  assert.equal((await send(h.driver)).errorCode, 'SOCIAL_WEBHOOK_EXPIRED')
  clock.value += 60001
  assert.equal((await h.driver.sendText({ conversation: { ...target, id: 'other' }, text: 'x' })).errorCode, 'SOCIAL_WEBHOOK_EXPIRED')
  await h.driver.stop()
}
// Ambiguous HTTP writes never retry. Provider rejections are failed, not accepted.
for (const [responder, expected] of [
  [async () => { throw new Error('SECRET transport detail') }, 'unknown'],
  [async () => json({ errcode: 123 }), 'failed'],
  [async () => json({}, 500), 'unknown'],
  [async () => json({}, 429), 'failed'],
  [async () => new Response('not-json'), 'unknown'],
  [async () => json({}), 'unknown'],
]) {
  const h = await setup(); h.ws.message(frame()); await until(() => h.ws.sent.length === 1); h.respond(responder)
  const result = await send(h.driver); assert.equal(result.status, expected)
  assert.equal(JSON.stringify(result).includes('SECRET'), false); assert.equal(h.requests.length, 2)
  await h.driver.stop()
}
// Timeout even for a non-cooperative injected fetch; stop aborts in-flight writes.
{
  const h = await setup({ actionTimeoutMs: 15 }); h.ws.message(frame()); await until(() => h.ws.sent.length === 1)
  h.respond(() => new Promise(() => {})); assert.equal((await send(h.driver)).status, 'unknown'); await h.driver.stop()
}
{
  const h = await setup(); h.ws.message(frame()); await until(() => h.ws.sent.length === 1)
  h.respond(() => new Promise(() => {})); const result = send(h.driver)
  await h.driver.stop(); assert.equal((await result).status, 'unknown')
  assert.equal(h.requests[1].init.signal.aborted, true)
}
// Stop fencing prevents late delivery ACKs and old socket events from resurrecting state.
{
  const gate = deferred(), h = await setup({}, () => gate.promise)
  h.ws.message(frame()); await until(() => h.messages.length === 1); await h.driver.stop()
  gate.resolve({ accepted: true }); await tick(); assert.equal(h.ws.sent.length, 0)
  h.ws.open(); await assert.rejects(h.driver.getSelfIdentity(), { code: 'SOCIAL_NOT_CONNECTED' })
}
{
  const gate = deferred(); let constructed = 0
  const driver = createDingTalkDriver(config, { clientSecret: 'secret', fetchImpl: () => gate.promise, socketFactory: () => { constructed++; return new Socket() } })
  await driver.start({ onStatus() {} }); await driver.stop()
  gate.resolve(json({ endpoint: 'wss://wss-open-connection.dingtalk.com/connect', ticket: 'ticket' })); await tick()
  assert.equal(constructed, 0)
}
// Bounded concurrent inbox work and send rate limit.
{
  const gate = deferred(), h = await setup({ maxPendingMessages: 1 }, () => gate.promise)
  h.ws.message(frame()); h.ws.message(frame(event({ msgId: 'second' })))
  assert.equal(h.messages.length, 1); gate.resolve({ accepted: true }); await until(() => h.ws.sent.length === 1)
  await h.driver.stop()
}
{
  const h = await setup({ sendIntervalMs: 1000 }); h.ws.message(frame()); await until(() => h.ws.sent.length === 1)
  assert.equal((await send(h.driver)).status, 'accepted'); assert.equal((await send(h.driver)).errorCode, 'SOCIAL_RATE_LIMITED')
  await h.driver.stop()
}
// Reconnect and watchdog use short real timers; no sleeps or external network.
{
  const h = await setup({ reconnectMs: 1, heartbeatTimeoutMs: 10 })
  await new Promise(resolve => { const timer = setInterval(() => { if (h.sockets.length > 1) { clearInterval(timer); resolve() } }, 1); setTimeout(() => { clearInterval(timer); resolve() }, 100) })
  assert.equal(h.ws.closed, true); assert.equal(h.sockets.length, 2)
  h.sockets[1].open(); assert.equal((await h.driver.getSelfIdentity()).protocolUserId, 'robot'); await h.driver.stop()
}
// Untrusted gateway responses cannot point the credential-bearing ticket at arbitrary hosts.
for (const endpoint of ['ws://wss-open-connection.dingtalk.com/connect', 'wss://evil.test/connect', 'wss://dingtalk.com.evil.test/connect', 'wss://user@wss-open-connection.dingtalk.com/connect']) {
  let constructed = 0; const statuses = []
  const driver = createDingTalkDriver(config, { clientSecret: 'secret', reconnectMs: 60000,
    fetchImpl: async () => json({ endpoint, ticket: 'ticket' }), socketFactory: () => { constructed++; return new Socket() } })
  await driver.start({ onStatus: state => statuses.push(state) }); await until(() => statuses.includes('disconnected'))
  assert.equal(constructed, 0); await driver.stop()
}
for (const payload of ['{broken json', 'x'.repeat(2048)]) {
  const h = await setup({ maxFrameBytes: 1024 }); h.ws.message(payload)
  assert.equal(h.ws.closed, true); assert.equal(h.ws.sent.length, 0); await h.driver.stop()
}
// HTTP body size is bounded and a too-large send response is ambiguous, not retried.
{
  const h = await setup({ maxFrameBytes: 2048 }); h.ws.message(frame()); await until(() => h.ws.sent.length === 1)
  h.respond(async () => json({ errcode: 0, padding: 'x'.repeat(4096) }))
  assert.equal((await send(h.driver)).status, 'unknown'); assert.equal(h.requests.length, 2); await h.driver.stop()
}
// An old request resolving after a stop/start cannot construct an obsolete socket.
{
  const gate = deferred(), sockets = []; let requests = 0
  const driver = createDingTalkDriver(config, { clientSecret: 'secret', fetchImpl: () => ++requests === 1 ? gate.promise : Promise.resolve(json({ endpoint: 'wss://wss-open-connection.dingtalk.com/connect', ticket: 'new' })), socketFactory: url => { const ws = new Socket(); ws.url = url; sockets.push(ws); return ws } })
  await driver.start({ onStatus() {} }); await driver.stop(); await driver.start({ onStatus() {} })
  await until(() => sockets.length === 1); sockets[0].open()
  gate.resolve(json({ endpoint: 'wss://wss-open-connection.dingtalk.com/connect', ticket: 'old' })); await tick()
  assert.equal(sockets.length, 1); assert.equal(new URL(sockets[0].url).searchParams.get('ticket'), 'new'); await driver.stop()
}
// Private route persistence survives restart without receiving another callback.
{
  const directory = await mkdtemp(join(tmpdir(), 'social-dingtalk-routes-'))
  const file = join(directory, 'webhooks.json')
  const store = createDingTalkRouteStore(file, { now: () => clock.value })
  try {
    assert.deepEqual(await store.load(config), [])
    const first = await setup({ routeStore: store })
    first.ws.message(frame()); await until(() => first.ws.sent.length === 1)
    assert.equal(JSON.stringify(first.messages).includes('SECRET_ROUTE'), false)
    assert.equal(JSON.stringify(first.statuses).includes('SECRET_ROUTE'), false)
    await first.driver.stop()
    const persisted = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(persisted.routes.length, 1)
    assert.equal(persisted.routes[0].url, event().sessionWebhook)
    assert.equal(JSON.stringify(persisted).includes('CLIENT_SECRET'), false, 'only the reply route, never app credentials, is persisted')
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
    const restarted = await setup({ routeStore: createDingTalkRouteStore(file, { now: () => clock.value }) })
    assert.equal(restarted.messages.length, 0, 'restart has not received a new message')
    assert.equal((await send(restarted.driver)).status, 'accepted')
    assert.equal(restarted.requests[1].url, event().sessionWebhook)
    assert.equal(restarted.requests[1].init.redirect, 'error')
    await restarted.driver.stop()
    for (const changed of [{ id: 'other' }, { clientId: 'other-app' }, { robotCode: 'other-robot' }]) {
      const isolated = await setup({ routeStore: store }, undefined, { ...config, ...changed })
      assert.equal((await send(isolated.driver)).errorCode, 'SOCIAL_WEBHOOK_EXPIRED')
      assert.equal(isolated.requests.length, 1)
      await isolated.driver.stop()
    }
    const expiring = await setup({ routeStore: store })
    clock.value += 60001
    assert.equal((await send(expiring.driver)).errorCode, 'SOCIAL_WEBHOOK_EXPIRED')
    assert.equal(expiring.requests.length, 1, 'expired hook never causes a send')
    await expiring.driver.stop()
    assert.equal((await store.load(config)).length, 1, 'direct owner metadata survives webhook expiry')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).routes.length, 1)
    const metadata = { conversation: target, url: event().sessionWebhook, expires: clock.value + 60000, staffId: 'PRIVATE_STAFF', updatedAt: clock.value }
    await store.remember(config, metadata)
    await store.remember(config, { ...metadata, expires: metadata.expires + 1, staffId: 'OLDER_STAFF', updatedAt: clock.value - 1 })
    await store.remember(config, { conversation: target, url: metadata.url, expires: metadata.expires + 2, updatedAt: clock.value + 1 })
    const merged = (await store.load(config))[0]
    assert.equal(merged.staffId, 'PRIVATE_STAFF'); assert.equal(merged.updatedAt, clock.value + 1)
    assert.equal(merged.expires, metadata.expires + 2)
    clock.value += 60003
    assert.equal((await store.load(config))[0].staffId, 'PRIVATE_STAFF', 'API recipient survives restart after expiry')
    await assert.rejects(store.remember(config, { ...metadata, conversation: { type: 'group', id: 'group' } }), { code: 'SOCIAL_DINGTALK_ROUTES_INVALID' })

    // Bounds are enforced across all connection/application bindings, not merely one map.
    const rows = []
    for (let owner = 0; owner < 4; owner++) for (let index = 0; index < 256; index++) rows.push({
      binding: { connectionId: owner ? 'ding-' + owner : config.id, clientId: config.clientId, robotCode: config.robotCode },
      conversation: { type: 'direct', id: 'target-' + index }, url: event().sessionWebhook, expires: clock.value + 60000,
    })
    await writeJson(file, { version: 1, routes: rows })
    await store.remember(config, { conversation: { type: 'group', id: 'new-target' }, url: event().sessionWebhook, expires: clock.value + 60000 })
    assert.equal((await store.load(config)).length, 256)
    assert.equal((await store.load(config)).some(row => row.conversation.id === 'target-0'), false)
    await store.remember({ ...config, clientId: 'rotated-app' }, { conversation: target, url: event().sessionWebhook, expires: clock.value + 60000 })
    assert.equal(JSON.parse(await readFile(file, 'utf8')).routes.filter(row => row.binding.connectionId === config.id).length, 256, 'connection limit includes all its old application bindings')
    assert.equal((await store.load({ ...config, clientId: 'rotated-app' })).length, 1)
    assert.equal((await store.load(config)).length, 255)
    await store.remember({ ...config, id: 'fifth' }, { conversation: target, url: event().sessionWebhook, expires: clock.value + 60000 })
    assert.equal(JSON.parse(await readFile(file, 'utf8')).routes.length, 1024)
    assert.equal((await store.load({ ...config, id: 'fifth' })).length, 1)

    // Corruption or an unsafe stored URL fails closed and cannot be overwritten by a new event.
    const badRows = [
      '{broken JSON',
      JSON.stringify({ version: 1, routes: [{ ...rows[0], url: 'https://evil.test/robot/sendBySession?session=PRIVATE' }] }),
      JSON.stringify({ version: 1, routes: [{ ...rows[0], url: event().sessionWebhook + '&session=other' }] }),
      JSON.stringify({ version: 1, routes: [rows[0], rows[0]] }),
      JSON.stringify({ version: 1, routes: [...rows, { ...rows[0], conversation: { type: 'direct', id: 'over-limit' } }] }),
    ]
    for (const broken of badRows) {
      await writeFile(file, broken)
      await assert.rejects(store.load(config), { code: 'SOCIAL_DINGTALK_ROUTES_INVALID' })
      await assert.rejects(store.remember(config, { conversation: target, url: event().sessionWebhook, expires: clock.value + 60000 }), { code: 'SOCIAL_DINGTALK_ROUTES_INVALID' })
      assert.equal(await readFile(file, 'utf8'), broken, 'damaged private file is preserved exactly')
    }
  } finally {
    // Remove only this test-created absolute temp directory, never a computed user path.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('social-dingtalk-routes-'))
    await rm(directory, { recursive: true, force: true })
  }
}
// Rejected inbox messages do not persist reply routes; known duplicates may refresh them.
for (const accepted of [{ accepted: false }, { duplicate: true }, { accepted: true }]) {
  const remembered = []
  const h = await setup({ routeStore: { load: async () => [], remember: async (_, route) => { remembered.push(route) } } }, async () => accepted)
  h.ws.message(frame()); await tick(); await tick()
  assert.equal(remembered.length, accepted.accepted || accepted.duplicate ? 1 : 0)
  await h.driver.stop()
}
// Persistence failures are public safe codes, never raw URLs/paths or a false connected result.
for (const loaded of [async () => { throw new Error('SECRET_ROUTE private file') }, async () => [{ conversation: target, url: 'https://evil.test/?session=SECRET_ROUTE', expires: clock.value + 1000 }]]) {
  const statuses = []; let fetched = 0
  const driver = createDingTalkDriver(config, { clientSecret: 'fake', routeStore: { load: loaded }, reconnectMs: 60000, fetchImpl: async () => { fetched++; throw new Error('must not fetch') } })
  await driver.start({ onStatus: (state, reason) => statuses.push([state, reason]) })
  await until(() => statuses.some(([state]) => state === 'disconnected'))
  assert.equal(fetched, 0)
  assert.ok(statuses.some(([, reason]) => reason === 'SOCIAL_DINGTALK_ROUTES_LOAD_FAILED'))
  assert.equal(JSON.stringify(statuses).includes('SECRET_ROUTE'), false)
  await driver.stop()
}
{
  const h = await setup({ routeStore: { load: async () => [], remember: async () => { throw new Error('SECRET_ROUTE private path') } } })
  h.ws.message(frame()); await until(() => h.ws.closed)
  assert.equal(h.ws.sent.length, 0)
  assert.ok(h.statuses.some(([, reason]) => reason === 'SOCIAL_DINGTALK_ROUTES_WRITE_FAILED'))
  assert.equal(JSON.stringify(h.statuses).includes('SECRET_ROUTE'), false)
  await h.driver.stop()
}
// A fast final reply must work while private route persistence is still in flight.
{
  const gate = deferred(), h = await setup({ routeStore: { load: async () => [], remember: () => gate.promise } })
  h.ws.message(frame()); await until(() => h.messages.length === 1); await tick()
  assert.equal(h.ws.sent.length, 0, 'platform ACK still waits for private persistence')
  assert.equal((await send(h.driver)).status, 'accepted', 'validated in-memory route precedes slow disk persistence')
  gate.resolve(); await until(() => h.ws.sent.length === 1)
  await h.driver.stop()
}
// Load must finish before connecting; stale load/remember completions cannot resurrect state.
{
  const gate = deferred(), sockets = []; let loads = 0, fetched = 0
  const driver = createDingTalkDriver(config, { clientSecret: 'fake', routeStore: { load: () => ++loads === 1 ? gate.promise : Promise.resolve([]) },
    fetchImpl: async () => { fetched++; return json({ endpoint: 'wss://wss-open-connection.dingtalk.com/connect', ticket: 'mock' }) },
    socketFactory: () => { const ws = new Socket(); sockets.push(ws); return ws } })
  await driver.start({ onStatus() {} }); await tick()
  assert.equal(fetched, 0)
  await assert.rejects(driver.getSelfIdentity(), { code: 'SOCIAL_NOT_CONNECTED' })
  await driver.stop(); await driver.start({ onStatus() {} }); await until(() => sockets.length === 1); sockets[0].open()
  gate.resolve([{ conversation: target, url: event().sessionWebhook, expires: clock.value + 60000 }]); await tick()
  assert.equal(fetched, 1)
  assert.equal((await send(driver)).errorCode, 'SOCIAL_WEBHOOK_EXPIRED', 'late old load cannot restore a stale route')
  await driver.stop()
}
{
  const gate = deferred(), h = await setup({ routeStore: { load: async () => [], remember: () => gate.promise } })
  h.ws.message(frame()); await until(() => h.messages.length === 1); await tick()
  assert.equal(h.ws.sent.length, 0, 'ACK waits for route persistence')
  await h.driver.stop(); gate.resolve(); await tick()
  assert.equal(h.ws.sent.length, 0)
  await assert.rejects(h.driver.getSelfIdentity(), { code: 'SOCIAL_NOT_CONNECTED' })
}
// Proactive owner delivery is explicit, direct-only, and independently rate-limited.
{
  const h = await setup()
  assert.deepEqual(Object.keys(h.driver.inspect()).sort(), ['connection', 'inbound'])
  assert.equal((await h.driver.sendOwner({ text: 'hi' })).errorCode, 'SOCIAL_NO_OWNER_CHAT')
  assert.equal((await h.driver.sendOwner({ conversation: { type: 'group', id: 'group' }, staffId: 'PRIVATE_STAFF', text: 'hi' })).errorCode, 'SOCIAL_NO_OWNER_CHAT')
  assert.equal((await h.driver.sendOwner({ conversation: target, text: 'hi' })).errorCode, 'SOCIAL_NO_OWNER_CHAT')
  for (const content of [undefined, null, 123, '', ' ', 'x'.repeat(8001)]) assert.equal((await h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: content })).errorCode, 'SOCIAL_INVALID_TEXT')
  h.ws.message(frame(event({ senderStaffId: 'PRIVATE_STAFF' }))); await until(() => h.ws.sent.length === 1)
  assert.equal(h.driver.inspect().owner, undefined, 'transport must not infer owner from an inbound DM')
  assert.equal((await h.driver.sendOwner({ text: 'not authorized by latest inbound' })).errorCode, 'SOCIAL_NO_OWNER_CHAT')
  assert.equal((await send(h.driver)).status, 'accepted')
  assert.equal((await h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: '主动消息' })).status, 'accepted', 'owner interval is independent of automatic reply interval')
  assert.equal(h.requests.at(-1).url, event().sessionWebhook)
  assert.equal((await h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: 'second' })).errorCode, 'SOCIAL_RATE_LIMITED')
  assert.equal(h.requests.some(row => row.url.includes('accessToken')), false)
  assert.equal(JSON.stringify(h.driver.inspect()).includes('PRIVATE_STAFF'), false)
  await h.driver.stop()
  assert.equal((await h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: 'hi' })).errorCode, 'SOCIAL_NOT_CONNECTED')
}
{
  const remembered = [], h = await setup({ ownerSendIntervalMs: 0, routeStore: { load: async () => [], remember: async (_, value) => remembered.push(value) } })
  h.ws.message(frame(event({ senderStaffId: 'PRIVATE_DIRECT', senderCorpId: 'PRIVATE_CORP' }))); await until(() => h.ws.sent.length === 1)
  assert.equal(h.messages[0].sender.staffId, 'PRIVATE_DIRECT'); assert.equal(h.messages[0].sender.corpId, 'PRIVATE_CORP')
  clock.value++
  h.ws.message(frame(event({ conversationType: '2', conversationId: 'group', isInAtList: true, senderStaffId: 'PRIVATE_GROUP' }))); await until(() => h.ws.sent.length === 2)
  assert.equal(remembered[0].staffId, 'PRIVATE_DIRECT'); assert.equal(remembered[1].staffId, undefined)
  assert.equal((await h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: 'direct only' })).status, 'accepted')
  clock.value++
  const newestUrl = 'https://oapi.dingtalk.com/robot/sendBySession?session=NEWEST_PRIVATE'
  h.ws.message(frame(event({ senderId: 'stranger', senderStaffId: 'STRANGER_STAFF', conversationId: 'second-direct', sessionWebhook: newestUrl }))); await until(() => h.ws.sent.length === 3)
  assert.equal((await h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: 'paired owner only' })).status, 'accepted')
  assert.equal(h.requests.at(-1).url, event().sessionWebhook, 'latest stranger cannot redirect the explicit paired owner')
  assert.notEqual(h.requests.at(-1).url, newestUrl)
  clock.value += 60001
  assert.equal((await h.driver.sendOwner({ conversation: target, text: 'expired' })).errorCode, 'SOCIAL_OWNER_WEBHOOK_EXPIRED', 'stored staffId alone is not owner authorization')
  assert.equal(h.driver.inspect().owner, undefined)
  assert.equal(JSON.stringify([h.driver.inspect(), h.statuses]).includes('PRIVATE_'), false)
  assert.equal(JSON.stringify(h.messages).includes('NEWEST_PRIVATE'), false, 'webhook credential is never normalized into inbox')
  await h.driver.stop()
}
const expiredOwner = () => ({ conversation: target, url: event().sessionWebhook, expires: clock.value - 1, staffId: 'UNTRUSTED_STORED_STAFF', updatedAt: clock.value - 1000 })
const ownerStore = () => ({ load: async () => [expiredOwner()], remember: async () => {} })
{
  const h = await setup({ routeStore: ownerStore(), ownerSendIntervalMs: 0 })
  let tokens = 0, sends = 0
  h.respond(async (url, init) => {
    assert.equal(init.redirect, 'error')
    if (url.endsWith('/oauth2/accessToken')) {
      tokens++; assert.deepEqual(JSON.parse(init.body), { appKey: config.clientId, appSecret: 'CLIENT_SECRET' })
      return json({ accessToken: 'PRIVATE_TOKEN', expireIn: 7200 })
    }
    sends++; assert.equal(url, 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend')
    assert.equal(init.headers['x-acs-dingtalk-access-token'], 'PRIVATE_TOKEN')
    assert.deepEqual(JSON.parse(init.body), { robotCode: config.robotCode, userIds: ['PRIVATE_STAFF'], msgKey: 'sampleText', msgParam: JSON.stringify({ content: '主动API' }) })
    return json({ processQueryKey: 'receipt', invalidStaffIdList: [], flowControlledStaffIdList: [] })
  })
  assert.equal(h.driver.inspect().owner, undefined)
  assert.equal((await h.driver.sendOwner({ conversation: target, text: 'no explicit staff binding' })).errorCode, 'SOCIAL_OWNER_WEBHOOK_EXPIRED')
  assert.equal((await h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: '主动API' })).status, 'accepted')
  assert.equal((await h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: '主动API' })).status, 'accepted')
  assert.equal(tokens, 1); assert.equal(sends, 2)
  clock.value += 7140001
  assert.equal((await h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: '主动API' })).status, 'accepted'); assert.equal(tokens, 2)
  const publicState = JSON.stringify([h.driver.inspect(), h.messages, h.statuses])
  for (const secret of ['PRIVATE_TOKEN', 'PRIVATE_STAFF', 'SECRET_ROUTE', 'CLIENT_SECRET']) assert.equal(publicState.includes(secret), false)
  await h.driver.stop()
}
for (const [phase, reply, expected, code] of [
  ['token', () => json({ code: 'invalidClient', message: 'PRIVATE_STAFF PRIVATE_TOKEN' }, 400), 'failed', 'SOCIAL_OWNER_TOKEN_FAILED'],
  ['token', () => { throw new Error('PRIVATE_TOKEN') }, 'unknown', 'SOCIAL_SEND_UNKNOWN'],
  ['token', () => json({ accessToken: 'PRIVATE_TOKEN' }), 'unknown', 'SOCIAL_SEND_UNKNOWN'],
  ['send', () => new Response('PRIVATE_STAFF denied', { status: 403 }), 'failed', 'SOCIAL_OWNER_SEND_FAILED'],
  ['send', () => json({ code: 'denied' }), 'failed', 'SOCIAL_OWNER_SEND_FAILED'],
  ['send', () => json({ invalidStaffIdList: ['PRIVATE_STAFF'] }), 'failed', 'SOCIAL_OWNER_SEND_FAILED'],
  ['send', () => json({ flowControlledStaffIdList: ['PRIVATE_STAFF'] }), 'failed', 'SOCIAL_OWNER_SEND_FAILED'],
  ['send', () => { throw new Error('PRIVATE_TOKEN SECRET_ROUTE') }, 'unknown', 'SOCIAL_SEND_UNKNOWN'],
  ['send', () => new Response('ambiguous PRIVATE_STAFF'), 'unknown', 'SOCIAL_SEND_UNKNOWN'],
  ['send', () => json({}, 503), 'unknown', 'SOCIAL_SEND_UNKNOWN'],
]) {
  const h = await setup({ routeStore: ownerStore(), ownerSendIntervalMs: 0 })
  h.respond(async url => url.endsWith('/oauth2/accessToken') && phase !== 'token' ? json({ accessToken: 'PRIVATE_TOKEN', expireIn: 7200 }) : reply())
  const result = await h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: 'hi' })
  assert.deepEqual(result, { status: expected, errorCode: code })
  assert.equal(h.requests.length, phase === 'token' ? 2 : 3, 'no automatic retry')
  for (const secret of ['PRIVATE_TOKEN', 'PRIVATE_STAFF', 'SECRET_ROUTE']) assert.equal(JSON.stringify([result, h.driver.inspect(), h.statuses]).includes(secret), false)
  await h.driver.stop()
}
{
  const h = await setup({ routeStore: ownerStore(), actionTimeoutMs: 15 })
  h.respond(() => new Promise(() => {}))
  assert.equal((await h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: 'timeout' })).status, 'unknown'); await h.driver.stop()
}
{
  const gate = deferred(), h = await setup({ routeStore: ownerStore() })
  h.respond(() => gate.promise)
  const result = h.driver.sendOwner({ conversation: target, staffId: 'PRIVATE_STAFF', text: 'stop' }); await h.driver.stop()
  gate.resolve(json({ accessToken: 'PRIVATE_TOKEN', expireIn: 7200 }))
  assert.equal((await result).status, 'unknown'); assert.equal(h.requests.length, 2, 'stop during token fetch prevents batchSend')
}
assert.throws(() => validateDingTalkRoute({ ...expiredOwner(), conversation: { type: 'group', id: 'group' } }), { code: 'SOCIAL_DINGTALK_ROUTES_INVALID' })
for (const invalid of ['', 'x'.repeat(257), 123]) assert.throws(() => validateDingTalkRoute({ ...expiredOwner(), staffId: invalid }), { code: 'SOCIAL_DINGTALK_ROUTES_INVALID' })
// Default idle behavior is not an assumed application heartbeat cadence. Observe
// actual timer scheduling instead of waiting two minutes or claiming a root cause.
{
  const originalTimer = globalThis.setTimeout, scheduled = []
  let h
  globalThis.setTimeout = (callback, delay, ...args) => { scheduled.push(delay); return originalTimer(callback, delay, ...args) }
  try {
    h = await setup()
    assert.deepEqual(scheduled, [10000, 10000], 'only HTTP and handshake deadlines, no default application heartbeat timer')
    const timersAfterOpen = scheduled.length
    clock.value += 180000
    for (let i = 0; i < 3; i++) {
      h.ws.message({ type: 'SYSTEM', headers: { topic: 'ping', messageId: 'ping-' + i }, data: '{}' })
      h.ws.message(frame(event({ msgId: 'sequential-' + i, text: { content: 'message ' + i } }), { headers: { topic: DINGTALK_ROBOT_TOPIC, messageId: 'callback-' + i } }))
      await until(() => h.ws.sent.length === (i + 1) * 2)
    }
    assert.equal(scheduled.length, timersAfterOpen)
    assert.equal(h.ws.closed, false); assert.equal(h.sockets.length, 1)
    assert.deepEqual(h.messages.map(message => message.text), ['message 0', 'message 1', 'message 2'])
    const diagnostics = h.driver.inspect().connection
    assert.equal(diagnostics.connects, 1); assert.equal(diagnostics.systemFrames, 3); assert.equal(diagnostics.acks, 6)
    assert.equal(diagnostics.lastDisconnectAt, null); assert.equal(diagnostics.lastReason, null)
    assert.equal(diagnostics.lastFrameAt, clock.value)
  } finally { globalThis.setTimeout = originalTimer; await h?.driver.stop() }
}
// Invalid optional staff/corp metadata is omitted rather than leaked or trusted.
{
  const normalized = normalizeDingTalkEvent(event({ senderStaffId: 'x'.repeat(257), senderCorpId: 123 }), config, {})
  assert.equal(normalized.sender.staffId, undefined); assert.equal(normalized.sender.corpId, undefined)
}
assert.throws(() => normalizeDingTalkEvent(event({ robotCode: 'wrong' }), config, {}), { code: 'SOCIAL_EVENT_IDENTITY_MISMATCH' })
console.log('dingtalk driver tests passed (explicit paired owner, stranger isolation, normalized identity, idle timer policy, sequential callbacks, private routes/API/token cache/rate-limit/redaction/fencing; mocked fetch/WebSocket)')
