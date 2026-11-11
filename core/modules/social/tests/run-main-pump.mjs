import assert from 'node:assert/strict'
import { createMainDeliveryPump } from '../main-delivery-pump.js'
import { closeSocialDelivery } from '../../../../app/dsh/adapters/social/index.js'

function fixture(view, processReplies) {
  let listener, id = 0, unsubscribed = false, enteredResolve
  const entered = new Promise(resolve => { enteredResolve = resolve })
  const scheduled = new Map(), delays = []
  const rows = [{ unreadCount: 1, connectionId: 'ding', conversation: { type: 'direct', id: 'one' } }]
  const service = { async listNotices() { return structuredClone(rows) }, subscribe(fn) { listener = fn; return () => { unsubscribed = true } } }
  const bridge = { view: input => { enteredResolve(); return view(input, rows) }, ...(processReplies ? { processReplies } : {}) }
  const pump = createMainDeliveryPump({ service, bridge, retryMs: 2000,
    setTimer(fn, delay) { delays.push(delay); const key = ++id; scheduled.set(key, fn); return key },
    clearTimer(key) { scheduled.delete(key) },
  })
  return { pump, rows, scheduled, delays, entered, notify: () => listener(), unsubscribed: () => unsubscribed }
}
let deliveries = 0
const success = fixture(async (input, rows) => {
  deliveries++; assert.equal(input.connectionId, 'ding'); assert.deepEqual(input.conversation, { type: 'direct', id: 'one' })
  rows[0].unreadCount = 0
  return { status: 'viewed', sessionId: 'current-main' }
})
assert.equal(success.delays[0], 0, 'startup drains pending inbox')
await success.pump.run()
assert.equal(deliveries, 1)
await success.pump.run()
assert.equal(deliveries, 1, 'no repeated delivery after inbox ACK')
assert.equal(success.pump.inspect().automatic, true)
await success.pump.close()
assert.equal(success.unsubscribed(), true)
assert.equal(success.scheduled.size, 0)
success.notify(); assert.equal(success.scheduled.size, 0)

for (const status of ['busy', 'pending']) {
  let count = 0
  const f = fixture(async () => { count++; return { status } })
  // Simulate firing the initial timer, then await the same in-flight run.
  const [key, callback] = [...f.scheduled][0]; f.scheduled.delete(key); callback()
  await f.pump.run()
  assert.equal(count, 1)
  assert.equal(f.rows[0].unreadCount, 1)
  assert.equal(f.delays.at(-1), 2000, 'bounded retry, not a tight loop')
  f.notify(); f.notify(); assert.equal(f.scheduled.size, 1, 'arrivals coalesce while waiting')
  await f.pump.close()
}
const failed = fixture(async () => { throw Object.assign(new Error('private-body-must-not-leak'), { code: 'SOCIAL_DELIVERY_UNCERTAIN' }) })
await failed.pump.run()
assert.equal(failed.pump.inspect().lastError, 'SOCIAL_DELIVERY_UNCERTAIN')
assert.equal(JSON.stringify(failed.pump.inspect()).includes('private-body'), false)
assert.equal(failed.rows[0].unreadCount, 1)
await failed.pump.close()

let release
const draining = fixture(() => new Promise(resolve => { release = resolve }))
const running = draining.pump.run()
await draining.entered
let closed = false
const close = draining.pump.close().then(() => { closed = true })
await Promise.resolve(); assert.equal(closed, false)
release({ status: 'pending' })
await running; await close
assert.equal(draining.scheduled.size, 0)
// Host integration must close the bridge before awaiting an in-flight resolve.
let resolvePending, bridgeClosed = false, followups = 0
const pendingResolve = new Promise(resolve => { resolvePending = resolve })
const shutdown = fixture(async () => { await pendingResolve; if (!bridgeClosed) followups++; return { status: 'pending' } })
const active = shutdown.pump.run()
await shutdown.entered
const stopping = closeSocialDelivery({ close() { bridgeClosed = true; return active } }, shutdown.pump)
assert.equal(bridgeClosed, true, 'bridge is fenced synchronously, before the in-flight pump drains')
resolvePending(); await stopping
assert.equal(followups, 0)
assert.equal(shutdown.scheduled.size, 0)
// One uncertain source must not starve other conversations.
let otherDelivered = false
const isolated = fixture(async (input, rows) => {
  if (input.conversation.id === 'one') throw Object.assign(new Error('unknown'), { code: 'SOCIAL_DELIVERY_UNCERTAIN' })
  rows[1].unreadCount = 0; otherDelivered = true; return { status: 'viewed' }
})
isolated.rows.push({ unreadCount: 1, connectionId: 'ding', conversation: { type: 'direct', id: 'two' } })
await isolated.pump.run()
assert.equal(otherDelivered, true)
assert.equal(isolated.pump.inspect().lastError, 'SOCIAL_DELIVERY_UNCERTAIN')
await isolated.pump.close()
let replyChecks = 0
const replyOnly = fixture(() => assert.fail('no incoming unread'), async () => ({ pending: ++replyChecks === 1 }))
replyOnly.rows[0].unreadCount = 0
const [replyTimer, replyCallback] = [...replyOnly.scheduled][0]
replyOnly.scheduled.delete(replyTimer); replyCallback()
await replyOnly.pump.run()
assert.equal(replyChecks, 1)
assert.equal(replyOnly.delays.at(-1), 2000, 'pending replies recover even without unread arrivals')
await replyOnly.pump.run()
assert.equal(replyChecks, 2)
await replyOnly.pump.close()
console.log('social-main-pump: PASS (arrival drain, reply recovery, bounded retry, coalescing, no replay, source isolation, safe errors, shutdown fencing)')
