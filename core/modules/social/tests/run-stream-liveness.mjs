import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { createDingTalkDriver, DINGTALK_ROBOT_TOPIC } from '../drivers/dingtalk.js'

const config = { id: 'test', platform: 'dingtalk', provider: 'dingtalk-stream', clientId: 'test-app', robotCode: 'test-robot' }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(test) { const deadline = Date.now() + 4000; while (!test()) { if (Date.now() > deadline) assert.fail('liveness condition timed out'); await tick() } }
const gateway = async () => new Response(JSON.stringify({ endpoint: 'wss://wss-open-connection.dingtalk.com/connect', ticket: 'TEST_ONLY' }))
class Socket extends EventEmitter {
  readyState = 0; pings = []; sent = []; terminated = false
  addEventListener(name, callback) { this.on(name, callback) }
  open() { this.readyState = 1; this.emit('open') }
  send(data) { this.sent.push(data) }
  ping(data, mask, callback) { assert.equal(mask, true); this.pings.push(Buffer.from(data)); callback?.() }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close') }
}
function timers() {
  let next = 0
  const callbacks = new Map()
  return {
    callbacks,
    set(fn, delay) { const id = ++next; callbacks.set(id, { fn, delay }); return id },
    clear(id) { callbacks.delete(id) },
    fire(delay) { const item = [...callbacks].find(([, value]) => value.delay === delay); assert.ok(item, `missing timer ${delay}`); callbacks.delete(item[0]); item[1].fn() },
  }
}
async function fixture(extra = {}) {
  const clock = timers(), sockets = [], statuses = []
  const driver = createDingTalkDriver(config, { clientSecret: 'TEST_ONLY', fetchImpl: gateway, reconnectMs: 60000,
    setLivenessTimer: clock.set, clearLivenessTimer: clock.clear,
    socketFactory() { const socket = new Socket(); sockets.push(socket); return socket }, ...extra })
  await driver.start({ onMessage: async () => ({ accepted: true }), onStatus: (...args) => statuses.push(args) })
  await until(() => sockets.length === 1)
  sockets[0].open()
  return { driver, clock, socket: sockets[0], statuses }
}

// Official SDK-style 8-second Ping cadence, but match the outstanding nonce:
// unrelated application traffic and unsolicited Pong cannot hide a dead probe.
{
  const h = await fixture()
  try {
    assert.equal(h.driver.inspect().connection.health, 'unverified')
    assert.equal(h.clock.callbacks.size, 1)
    h.clock.fire(8000)
    assert.equal(h.socket.pings.length, 1)
    assert.equal(h.driver.inspect().connection.health, 'awaiting-pong')
    h.socket.emit('pong', Buffer.from('wrong'))
    assert.equal(h.driver.inspect().connection.pongs, 0)
    h.socket.emit('pong', h.socket.pings[0])
    assert.equal(h.driver.inspect().connection.health, 'healthy')
    assert.equal(h.driver.inspect().connection.pongs, 1)
    assert.equal(h.clock.callbacks.size, 1)
    h.clock.fire(8000)
    h.socket.emit('pong', h.socket.pings[0]) // stale nonce cannot acknowledge this cycle
    assert.equal(h.driver.inspect().connection.pongs, 1)
    h.clock.fire(8000)
    assert.equal(h.socket.terminated, true)
    assert.deepEqual(h.statuses.at(-1), ['disconnected', 'SOCIAL_PONG_TIMEOUT'])
    assert.equal(h.driver.inspect().connection.pongTimeouts, 1)
    assert.equal(h.driver.inspect().connection.health, 'disconnected')
    h.socket.emit('pong', h.socket.pings.at(-1))
    assert.equal(h.clock.callbacks.size, 0)
    assert.equal(h.driver.inspect().connection.pongs, 1)
    const encoded = JSON.stringify(h.driver.inspect())
    assert.equal(encoded.includes(h.socket.pings[0].toString('hex')), false)
    assert.equal(encoded.includes('TEST_ONLY'), false)
  } finally { await h.driver.stop() }
}
console.log('PASS protocol Ping/Pong matching, defaults, timeout, stale callbacks and redaction')

{
  const h = await fixture()
  h.clock.fire(8000)
  const stale = [...h.clock.callbacks.values()][0].fn
  await h.driver.stop()
  assert.equal(h.clock.callbacks.size, 0)
  stale(); h.socket.emit('pong', h.socket.pings[0])
  assert.equal(h.driver.inspect().connection.pongTimeouts, 0)
  assert.equal(h.clock.callbacks.size, 0)
  assert.equal(h.socket.terminated, true)
}
{
  const h = await fixture()
  try {
    h.socket.ping = () => { throw new Error('transport write failed') }
    h.clock.fire(8000)
    assert.deepEqual(h.statuses.at(-1), ['disconnected', 'SOCIAL_PING_FAILED'])
    assert.equal(h.clock.callbacks.size, 0)
  } finally { await h.driver.stop() }
}
console.log('PASS shutdown cancels probes; Ping write failures disconnect safely')

// Use REAL ws framing on loopback (no DingTalk credentials or external network).
// The peer remains TCP-connected but stops answering Ping; recovery must not wait
// for an application message, a close event, or a user-triggered reload.
{
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false })
  await once(server, 'listening')
  const url = `ws://127.0.0.1:${server.address().port}`
  const peers = [], messages = [], statuses = [], tickets = []
  let answer = true
  server.on('connection', socket => {
    peers.push(socket)
    socket.on('ping', payload => { if (answer) socket.pong(payload) })
    socket.on('error', () => {})
  })
  const driver = createDingTalkDriver(config, { clientSecret: 'TEST_ONLY', fetchImpl: async () => {
    tickets.push(tickets.length + 1)
    return new Response(JSON.stringify({ endpoint: 'wss://wss-open-connection.dingtalk.com/connect', ticket: 'TEST_' + tickets.length }))
  }, socketFactory: () => new WebSocket(url, { perMessageDeflate: false }), pingIntervalMs: 20, pongTimeoutMs: 80, reconnectMs: 1 })
  const inbound = id => JSON.stringify({ type: 'CALLBACK', headers: { topic: DINGTALK_ROBOT_TOPIC, messageId: id }, data: JSON.stringify({
    robotCode: config.robotCode, msgtype: 'text', text: { content: id }, conversationType: '1', conversationId: 'test-chat', senderId: 'test-owner', msgId: id,
  }) })
  try {
    await driver.start({ onStatus: (...args) => statuses.push(args), onMessage: async message => { messages.push(message.text); return { accepted: true } } })
    await until(() => driver.inspect().connection.pongs >= 3)
    assert.equal(peers.length, 1)
    assert.equal(driver.inspect().connection.lastFrameAt, null, 'healthy transport without application frames')
    for (const id of ['first', 'second', 'third']) {
      peers[0].send(inbound(id))
      await until(() => messages.includes(id))
    }
    answer = false
    await until(() => driver.inspect().connection.pongTimeouts >= 1)
    answer = true
    await until(() => peers.length >= 2 && driver.inspect().connection.health === 'healthy')
    assert.ok(tickets.length >= 2, 'new gateway ticket for reconnect')
    peers.at(-1).send(inbound('after-recovery'))
    await until(() => messages.includes('after-recovery'))
    assert.deepEqual(messages, ['first', 'second', 'third', 'after-recovery'])
    assert.ok(statuses.some(row => row[1] === 'SOCIAL_PONG_TIMEOUT'))
    assert.equal(driver.inspect().inbound.accepted, 4)
  } finally {
    await driver.stop()
    for (const peer of server.clients) peer.terminate()
    await new Promise(resolve => server.close(resolve))
  }
}
console.log('PASS real loopback WebSocket: idle Pong, consecutive messages, half-open detection, reconnect and resumed reception')
