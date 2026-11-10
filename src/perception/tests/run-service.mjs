import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createPerceptionStore } from '../store.js'
import { createPerceptionService } from '../service.js'

const origin = 2_000_000_000
function fixture({ cleanupFails = false, writeFails = false, supported = true, deferStop = false } = {}) {
  let time = origin, enabled = true, callbacks, run = 0, startCalls = 0, closed = 0, releaseStop
  let collectorState = { state: 'stopped', runId: null }
  const store = createPerceptionStore({ dbPath: ':memory:', DatabaseSync, now: () => time })
  const originalCleanup = store.cleanup.bind(store), originalInsert = store.insertSample.bind(store), originalClose = store.close.bind(store)
  store.cleanup = opts => cleanupFails ? Promise.reject(new Error('disk cleanup failure')) : originalCleanup(opts)
  store.insertSample = sample => { if (writeFails) throw new Error('disk write failure'); return originalInsert(sample) }
  store.close = () => { ++closed; originalClose() }
  const timers = new Set()
  const service = createPerceptionService({ store, capabilities: { supported, reason: 'test unsupported' }, now: () => time, isEnabled: () => enabled,
    setIntervalImpl: fn => { timers.add(fn); return fn }, clearIntervalImpl: fn => timers.delete(fn),
    collectorFactory(options) {
      callbacks = options
      return {
        getStatus: () => collectorState,
        async start() { ++startCalls; collectorState = { state: 'running', runId: 'run-' + ++run }; options.onState(collectorState); return { runId: collectorState.runId } },
        async stop() { if (deferStop) await new Promise(r => { releaseStop = r }); collectorState.state = 'stopped'; options.onState(collectorState) },
        async dispose() { collectorState.state = 'disposed'; options.onState(collectorState) },
      }
    },
  })
  function sample(seq, options = {}) {
    const value = { schemaVersion: 1, runId: collectorState.runId, seq, observedAtMs: time, receivedAtMs: time,
      monotonicMs: seq * 5000, foregroundApp: { platform: 'macos', id: 'com.microsoft.VSCode', name: 'VS Code' },
      idleSeconds: 1, sessionState: 'unknown', missing: ['lockState'], ...options }
    callbacks.onSample(value)
    return value
  }
  return { service, store, sample, timers, advance: ms => { time += ms }, setEnabled: v => { enabled = v }, setCleanupFails: v => { cleanupFails = v },
    releaseStop: () => releaseStop?.(), stats: () => ({ startCalls, closed }), time: () => time }
}
const tests = []
const test = (name, fn) => tests.push([name, fn])
test('initialize never starts collection and shutdown is idempotent', async () => {
  const f = fixture(); await f.service.initialize()
  assert.equal(f.stats().startCalls, 0); assert.equal(f.service.getStatus().state, 'stopped'); assert.equal(f.timers.size, 2)
  assert.equal(f.service.getCurrent().data, null)
  await Promise.all([f.service.close(), f.service.close()]); assert.equal(f.stats().closed, 1); assert.equal(f.timers.size, 0)
})
test('real SQLite synthetic stream analyzes, retains summaries and marks stale', async () => {
  const f = fixture(); await f.service.initialize(); await f.service.start()
  for (let i = 0; i < 190; i++) { f.sample(i); if (i % 6 === 0) f.service.analyze(); f.advance(5000) }
  f.service.analyze()
  assert.equal(f.service.getCurrent().data.activity, 'development')
  assert.equal(f.service.getCurrent().freshness.isFresh, true)
  assert.ok(f.service.getStatus().storage.summaries > 0)
  const timeline = f.service.getTimeline(); assert.ok(timeline.items.some(x => x.kind === 'activity'))
  f.advance(21000); assert.equal(f.service.getStatus().state, 'stale'); assert.equal(f.service.getCurrent().freshness.isFresh, false)
  await f.service.pause(); assert.equal(f.service.getStatus().state, 'paused')
  await f.service.start(); assert.equal(f.service.getCurrent().data, null)
  await f.service.stop(); assert.equal(f.service.getStatus().state, 'stopped'); await f.service.close()
})
test('cleanup runs while stopped and TTL removes raw not recent summaries', async () => {
  const f = fixture(); await f.service.initialize(); await f.service.start(); f.sample(0); f.service.analyze(); await f.service.stop()
  f.advance(3600001); await f.service.clean(); assert.equal(f.service.getStatus().storage.samples, 0)
  assert.equal(f.service.getStatus().storage.summaries, 1)
  f.advance(604800000); await f.service.clean(); assert.equal(f.service.getCurrent().data, null)
  assert.equal(f.service.getStatus().storage.summaries, 0); await f.service.close()
})
test('cleanup failure stops additions, retry does not auto-start', async () => {
  const f = fixture(); await f.service.initialize(); await f.service.start(); f.sample(0)
  f.setCleanupFails(true); await f.service.clean(); assert.equal(f.service.getStatus().state, 'error')
  assert.throws(() => f.sample(1)); await assert.rejects(f.service.start())
  f.setCleanupFails(false); await f.service.clean(); assert.equal(f.stats().startCalls, 1)
  await f.service.start(); assert.equal(f.stats().startCalls, 2); await f.service.close()
})
test('write failure is visible and does not publish unsaved sample', async () => {
  const f = fixture({ writeFails: true }); await f.service.initialize(); await f.service.start()
  assert.throws(() => f.sample(0)); assert.equal(f.service.getStatus().state, 'error'); assert.equal(f.service.getStatus().latestSample, null)
  await f.service.close()
})
test('unsupported and disabled modules do not start', async () => {
  const f = fixture({ supported: false }); await f.service.initialize(); await assert.rejects(f.service.start()); assert.equal(f.stats().startCalls, 0); await f.service.close()
  const d = fixture(); await d.service.initialize(); d.setEnabled(false); await assert.rejects(d.service.start()); await d.service.close()
})
test('close racing initialization leaves no timer or open database', async () => {
  const f = fixture(); const init = f.service.initialize(); await f.service.close(); await init
  assert.equal(f.timers.size, 0); assert.equal(f.stats().closed, 1)
})
test('disable during pending cleanup cannot spawn', async () => {
  const f = fixture(); await f.service.initialize()
  let release; f.store.cleanup = () => new Promise(r => { release = r })
  const starting = f.service.start(); f.setEnabled(false); release({ samples: 0, summaries: 0 })
  await assert.rejects(starting); assert.equal(f.stats().startCalls, 0); await f.service.close()
})
test('status expires memory even before cleanup and old timeline is empty', async () => {
  const f = fixture(); await f.service.initialize(); await f.service.start(); f.sample(0); f.service.analyze()
  f.advance(3600001); f.setCleanupFails(true)
  assert.equal(f.service.getStatus().latestSample, null)
  const old = f.service.getTimeline({ fromMs: f.time() - 7200000, toMs: f.time() - 5400000 })
  assert.deepEqual(old.items, []); assert.equal(old.retentionLimited, true)
  await f.service.close()
})
test('summary storage failure stops collection, cleanup continues', async () => {
  const f = fixture(); await f.service.initialize(); await f.service.start(); f.sample(0)
  f.store.insertSummary = () => { throw new Error('summary disk failure') }
  f.service.analyze(); await Promise.resolve()
  assert.equal(f.service.getStatus().state, 'error'); assert.equal(f.service.getStatus().error.code, 'STORAGE_ERROR')
  assert.equal(f.service.getCurrent().data, null)
  await f.service.clean(); assert.equal(f.service.getStatus().cleanup.error, null); await f.service.close()
})
test('pending stop blocks restart and latest halt wins', async () => {
  const f = fixture({ deferStop: true }); await f.service.initialize(); await f.service.start()
  const pausing = f.service.pause(), stopping = f.service.stop()
  await assert.rejects(f.service.start(), /正在停止/)
  f.releaseStop(); await Promise.all([pausing, stopping]); assert.equal(f.service.getStatus().state, 'stopped')
  await f.service.start(); assert.equal(f.stats().startCalls, 2); await f.service.close()
})
test('initialize twice does not duplicate timers', async () => {
  const f = fixture(); await Promise.all([f.service.initialize(), f.service.initialize()]); assert.equal(f.timers.size, 2); await f.service.close()
})
test('new run never inherits prior-run foreground observations into current analysis', async () => {
  const f = fixture(); await f.service.initialize(); await f.service.start()
  for (let seq = 0; seq < 180; seq++) { f.sample(seq); f.advance(5000) }
  await f.service.stop(); await f.service.start()
  f.sample(0, { foregroundApp: { platform: 'macos', id: 'com.apple.Terminal', name: 'Terminal' } })
  f.advance(5000); f.sample(1, { foregroundApp: { platform: 'macos', id: 'com.apple.Terminal', name: 'Terminal' } })
  f.service.analyze()
  const current = f.service.getCurrent().data
  assert.equal(current.ruleVersion, 'activity-v1.1')
  assert.equal(current.windowStats.long.categoryMs.development, 0)
  assert.equal(current.windowStats.long.apps.length, 1)
  assert.equal(current.windowStats.long.apps[0].id, 'com.apple.Terminal')
  assert.equal(current.continuity, 'insufficient')
  assert.equal(f.service.getStatus().storage.samples, 182) // Old evidence retained, not deleted.
  assert.equal(f.service.getTimeline().containsPriorRuns, true)
  await f.service.close()
})
for (const [name, fn] of tests) { await fn(); console.log('PASS', name) }
console.log(`perception service: ${tests.length} passed`)
