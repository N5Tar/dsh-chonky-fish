import assert from 'node:assert/strict'
import { createVoiceResetBarrier, finishVoiceResetCall } from '../reset-lifecycle.js'

const barrier = createVoiceResetBarrier()
const events = []
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const teardown = deferred()
const acceptance = deferred()
const acceptanceReady = deferred()
const captureStopped = deferred()
const oldService = {
  state: 'unknown', disposed: false,
  async hangup(options) {
    assert.deepEqual(options, { abandonPending: true })
    events.push('capture-stopped')
    captureStopped.resolve()
    await teardown.promise
    acceptanceReady.resolve()
    await acceptance.promise
    this.state = 'accepted'
    events.push('lease-released')
  },
  async dispose() { this.disposed = true },
}
barrier.subscribe(async details => {
  assert.equal(details.sessionId, 'old-session')
  assert.equal(barrier.isResetting(), true)
  await finishVoiceResetCall({ service: oldService, setupPromise: Promise.resolve(), hangupOptions: { abandonPending: true } })
})

const rebind = async () => {
  assert.equal(barrier.isResetting(), true)
  events.push('new-session-attached')
  return 'new-session'
}
const first = barrier.run({ sessionId: 'old-session', bindingRevision: 'rev-1' }, rebind)
const second = barrier.run({ sessionId: 'ignored-concurrent-reset' }, () => {
  throw new Error('concurrent reset must join the in-flight reset')
})
assert.equal(first, second)
await captureStopped.promise
assert.deepEqual(events, ['capture-stopped'])
assert.equal(barrier.isResetting(), true)
teardown.resolve()
await acceptanceReady.promise
acceptance.resolve()
assert.equal(await first, 'new-session')
assert.deepEqual(events, ['capture-stopped', 'lease-released', 'new-session-attached'])
assert.equal(barrier.isResetting(), false)
assert.equal(oldService.state, 'accepted', 'late old-target acceptance remains observable through reset drain')
assert.equal(oldService.disposed, false, 'reset preserves the drain service and its history')

console.log('Voice reset lifecycle: capture and lease teardown precede session rebind')
