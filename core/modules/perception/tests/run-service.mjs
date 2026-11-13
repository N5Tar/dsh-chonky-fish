import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createPerceptionStore } from '../../../../app/shared/storage/perception/sqlite.js'
import { createPerceptionService } from '../service.js'
import { createCollectionPreferences } from '../../../../app/shared/storage/perception/preferences.js'
import { platform } from '../../../../app/shared/platform/index.js'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

async function until(predicate) { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) assert.fail('condition did not settle'); await new Promise(resolve => setImmediate(resolve)) } }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

const origin = 2_000_000_000
function fixture({ cleanupFails = false, writeFails = false, supported = true, deferStop = false, preferences, initialEnabled = true, startFails = false } = {}) {
  let time = origin, enabled = initialEnabled, callbacks, run = 0, startCalls = 0, closed = 0, releaseStop
  let collectorState = { state: 'stopped', runId: null }
  const store = createPerceptionStore({ dbPath: ':memory:', DatabaseSync, now: () => time })
  const originalCleanup = store.cleanup.bind(store), originalInsert = store.insertSample.bind(store), originalClose = store.close.bind(store)
  store.cleanup = opts => cleanupFails ? Promise.reject(new Error('disk cleanup failure')) : originalCleanup(opts)
  store.insertSample = sample => { if (writeFails) throw new Error('disk write failure'); return originalInsert(sample) }
  store.close = () => { ++closed; originalClose() }
  const timers = new Set()
  const service = createPerceptionService({ store, preferences, capabilities: { supported, reason: 'test unsupported' }, now: () => time, isEnabled: () => enabled,
    setIntervalImpl: fn => { timers.add(fn); return fn }, clearIntervalImpl: fn => timers.delete(fn),
    collectorFactory(options) {
      callbacks = options
      return {
        getStatus: () => collectorState,
        async start() { ++startCalls; if (startFails) throw new Error('mock collector failure'); collectorState = { state: 'running', runId: 'run-' + ++run }; options.onState(collectorState); return { runId: collectorState.runId } },
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
  const starting = f.service.start(); await until(() => release); f.setEnabled(false); release({ samples: 0, summaries: 0 })
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
test('local private preference restores true across restart, while pause and stop persist false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perception-preference-')), file = join(root, 'collection-preference.json')
  const opened = []
  try {
    const first = fixture({ preferences: createCollectionPreferences(file, { syncDirectory: platform.syncDirectory }) }); opened.push(first)
    await first.service.initialize(); assert.equal(first.stats().startCalls, 0)
    assert.deepEqual(first.service.getStatus().collectionPreference, { requested: false, loaded: true, error: null })
    await first.service.start()
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, collectionEnabled: true })
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
    await first.service.close()
    assert.equal(JSON.parse(await readFile(file, 'utf8')).collectionEnabled, true, 'plugin shutdown must not rewrite user intent')
    const restarted = fixture({ preferences: createCollectionPreferences(file, { syncDirectory: platform.syncDirectory }) }); opened.push(restarted)
    await restarted.service.initialize(); await until(() => restarted.stats().startCalls === 1)
    await restarted.service.pause(); assert.equal(JSON.parse(await readFile(file, 'utf8')).collectionEnabled, false)
    await restarted.service.close()
    const paused = fixture({ preferences: createCollectionPreferences(file, { syncDirectory: platform.syncDirectory }) }); opened.push(paused)
    await paused.service.initialize(); assert.equal(paused.stats().startCalls, 0)
    await paused.service.start(); await paused.service.stop(); await paused.service.close()
    const stopped = fixture({ preferences: createCollectionPreferences(file, { syncDirectory: platform.syncDirectory }) }); opened.push(stopped)
    await stopped.service.initialize(); assert.equal(stopped.stats().startCalls, 0)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).collectionEnabled, false)
  } finally {
    await Promise.all(opened.map(f => f.service.close()))
    assert.equal(resolve(root), root); assert.ok(root.startsWith(join(tmpdir(), 'perception-preference-')))
    await rm(root, { recursive: true, force: true })
  }
})
test('restore respects unsupported and disabled modules without erasing saved intent', async () => {
  for (const options of [{ supported: false }, { initialEnabled: false }]) {
    const writes = [], f = fixture({ ...options, preferences: { read: async () => true, write: async value => writes.push(value) } })
    await f.service.initialize()
    assert.equal(f.stats().startCalls, 0); assert.equal(f.service.getStatus().collectionPreference.requested, true)
    await f.service.close(); assert.deepEqual(writes, [])
  }
})
test('user stop while startup preference read is pending wins over restore', async () => {
  const gate = deferred(), writes = []
  let reading = false
  const f = fixture({ preferences: { read: async () => { reading = true; return gate.promise }, write: async value => writes.push(value) } })
  const initializing = f.service.initialize(); await until(() => reading)
  const stopping = f.service.stop(); gate.resolve(true)
  await Promise.all([initializing, stopping])
  assert.equal(f.stats().startCalls, 0); assert.equal(f.service.getStatus().state, 'stopped')
  assert.deepEqual(writes, [false]); assert.equal(f.service.getStatus().collectionPreference.requested, false)
  await f.service.close()
})
test('pause during saved-start write cancels spawn and serializes final false intent', async () => {
  const gate = deferred(), writes = []; let writing = false
  const f = fixture({ preferences: { read: async () => false, write: async value => { writes.push(value); if (value) { writing = true; await gate.promise } } } })
  await f.service.initialize()
  const starting = f.service.start(); const rejected = assert.rejects(starting, { code: 'CANCELLED' })
  await until(() => writing)
  const pausing = f.service.pause(); gate.resolve()
  await Promise.all([rejected, pausing])
  assert.deepEqual(writes, [true, false]); assert.equal(f.stats().startCalls, 0)
  assert.equal(f.service.getStatus().collectionPreference.requested, false)
  assert.equal(f.service.getStatus().state, 'paused'); await f.service.close()
})
test('internal disable and collector/storage errors preserve the explicit on preference', async () => {
  const writes = [], f = fixture({ preferences: { read: async () => false, write: async value => writes.push(value) } })
  await f.service.initialize(); await f.service.start(); f.sample(0)
  f.setEnabled(false); f.service.analyze(); await until(() => f.service.getStatus().state === 'paused')
  assert.deepEqual(writes, [true]); assert.equal(f.service.getStatus().collectionPreference.requested, true)
  await f.service.close(); assert.deepEqual(writes, [true])
  const errorWrites = [], broken = fixture({ startFails: true, preferences: { read: async () => false, write: async value => errorWrites.push(value) } })
  await broken.service.initialize(); await assert.rejects(broken.service.start(), /mock collector failure/)
  assert.deepEqual(errorWrites, [true]); assert.equal(broken.service.getStatus().collectionPreference.requested, true)
  assert.equal(broken.service.getStatus().state, 'error'); await broken.service.close()
})
test('corrupt preference fails closed visibly; explicit stop can repair local intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perception-preference-')), file = join(root, 'collection-preference.json')
  let f
  try {
    await writeFile(file, '{PRIVATE_CORRUPT')
    f = fixture({ preferences: createCollectionPreferences(file, { syncDirectory: platform.syncDirectory }) }); await f.service.initialize()
    assert.equal(f.stats().startCalls, 0); assert.equal(f.service.getStatus().state, 'error')
    assert.equal(f.service.getStatus().collectionPreference.error.code, 'PREFERENCE_INVALID')
    assert.equal(JSON.stringify(f.service.getStatus()).includes('PRIVATE_CORRUPT'), false)
    assert.equal(await readFile(file, 'utf8'), '{PRIVATE_CORRUPT', 'startup does not silently repair corruption')
    await f.service.stop()
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, collectionEnabled: false })
    assert.equal(f.service.getStatus().collectionPreference.error, null)
  } finally {
    await f?.service.close(); assert.equal(resolve(root), root); assert.ok(root.startsWith(join(tmpdir(), 'perception-preference-')))
    await rm(root, { recursive: true, force: true })
  }
})
test('preference write failure never reports success and stops collection even on pause', async () => {
  const fault = () => Object.assign(new Error('偏好保存失败'), { code: 'PREFERENCE_WRITE_FAILED' })
  const start = fixture({ preferences: { read: async () => false, write: async () => { throw fault() } } })
  await start.service.initialize(); await assert.rejects(start.service.start(), { code: 'PREFERENCE_WRITE_FAILED' })
  assert.equal(start.stats().startCalls, 0); assert.equal(start.service.getStatus().state, 'error'); await start.service.close()
  let failWrite = false
  const pause = fixture({ preferences: { read: async () => false, write: async () => { if (failWrite) throw fault() } } })
  await pause.service.initialize(); await pause.service.start(); failWrite = true
  await assert.rejects(pause.service.pause(), { code: 'PREFERENCE_WRITE_FAILED' })
  assert.equal(pause.service.getStatus().state, 'error')
  assert.equal(pause.service.getStatus().collectionPreference.requested, true, 'old durable intent must not be falsely reported as disabled')
  assert.equal(pause.service.getStatus().collectionPreference.error.code, 'PREFERENCE_WRITE_FAILED')
  assert.throws(() => pause.sample(0), { code: 'UNAVAILABLE' }); await pause.service.close()
})
test('close during startup preference load cannot restore a collector or overwrite intent', async () => {
  const gate = deferred(), writes = []; let reading = false
  const f = fixture({ preferences: { read: async () => { reading = true; return gate.promise }, write: async value => writes.push(value) } })
  const init = f.service.initialize(); await until(() => reading)
  const closing = f.service.close(); gate.resolve(true)
  await Promise.all([init, closing])
  assert.equal(f.stats().startCalls, 0); assert.equal(f.stats().closed, 1); assert.equal(f.timers.size, 0); assert.deepEqual(writes, [])
})
test('explicit migration creates once and never overwrites existing false or corrupt preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perception-preference-')), file = join(root, 'collection-preference.json')
  try {
    const store = createCollectionPreferences(file, { syncDirectory: platform.syncDirectory })
    assert.equal(await store.read(), false)
    assert.equal(await store.createIfAbsent(true), true); assert.equal(await store.read(), true)
    await store.write(false)
    assert.equal(await store.createIfAbsent(true), false); assert.equal(await store.read(), false)
    await writeFile(file, '{corrupt')
    assert.equal(await store.createIfAbsent(true), false); assert.equal(await readFile(file, 'utf8'), '{corrupt')
    await assert.rejects(store.read(), { code: 'PREFERENCE_INVALID' })
    for (const raw of [JSON.stringify({ version: 1, collectionEnabled: 'true' }), JSON.stringify({ version: 2, collectionEnabled: true }), JSON.stringify({ version: 1, collectionEnabled: true, extra: 'forbidden' }), 'x'.repeat(4097)]) {
      await writeFile(file, raw); await assert.rejects(store.read(), { code: 'PREFERENCE_INVALID' })
    }
  } finally {
    assert.equal(resolve(root), root); assert.ok(root.startsWith(join(tmpdir(), 'perception-preference-')))
    await rm(root, { recursive: true, force: true })
  }
})
test('failed pending start write cannot cancel or falsely acknowledge a later explicit stop', async () => {
  for (const failOff of [false, true]) {
    const gate = deferred(), writes = []; let writing = false, persisted = true
    const failure = () => Object.assign(new Error('save failed'), { code: 'PREFERENCE_WRITE_FAILED' })
    const f = fixture({ preferences: { read: async () => persisted, write: async value => {
      writes.push(value)
      if (value) { writing = true; await gate.promise; throw failure() }
      if (failOff) throw failure()
      persisted = value
    } } })
    try {
      await f.service.initialize(); await until(() => f.stats().startCalls === 1)
      const starting = f.service.start(), startRejected = assert.rejects(starting, { code: 'PREFERENCE_WRITE_FAILED' })
      await until(() => writing)
      const stopping = f.service.stop()
      const checkedStop = failOff ? assert.rejects(stopping, { code: 'PREFERENCE_WRITE_FAILED' }) : stopping
      gate.resolve(); await Promise.all([startRejected, checkedStop])
      assert.deepEqual(writes, [true, false], 'internal error halt cannot supersede the queued off write')
      assert.equal(persisted, failOff)
      assert.equal(f.stats().startCalls, 1, 'failed restart intent does not spawn again')
      assert.equal(f.service.getStatus().collectionPreference.requested, failOff)
      assert.equal(f.service.getStatus().state, failOff ? 'error' : 'stopped')
      assert.equal(f.service.getStatus().collectionPreference.error?.code ?? null, failOff ? 'PREFERENCE_WRITE_FAILED' : null)
    } finally { gate.resolve(); await f.service.close() }
  }
})
test('explicit stop admitted immediately before close still persists false; new controls reject', async () => {
  let persisted = true
  const writes = [], f = fixture({ preferences: { read: async () => persisted, write: async value => { writes.push(value); persisted = value } } })
  await f.service.initialize(); await until(() => f.stats().startCalls === 1)
  const stopping = f.service.stop(), closing = f.service.close()
  await Promise.all([stopping, closing])
  assert.equal(persisted, false); assert.deepEqual(writes, [false]); assert.equal(f.stats().closed, 1)
  await assert.rejects(f.service.start(), { code: 'UNAVAILABLE' })
  await assert.rejects(f.service.pause(), { code: 'UNAVAILABLE' })
  await assert.rejects(f.service.stop(), { code: 'UNAVAILABLE' })
  assert.deepEqual(writes, [false], 'post-close requests never change the last admitted intent')
  const restarted = fixture({ preferences: { read: async () => persisted, write: async value => { persisted = value } } })
  await restarted.service.initialize(); assert.equal(restarted.stats().startCalls, 0); await restarted.service.close()
})
for (const [name, fn] of tests) { await fn(); console.log('PASS', name) }
console.log(`perception service: ${tests.length} passed`)

// Conditional Hello controls cannot overwrite a newer native settings action.
{
  const f = fixture()
  await f.service.initialize()
  const original = f.service.getControlState()
  const pending = f.service.start()
  assert.equal(f.service.getControlState().revision, original.revision + 1, 'start reserves revision synchronously')
  assert.throws(() => f.service.setRequested(false, { expectedRevision: original.revision, expectedRequested: original.requested }), { code: 'STALE_TARGET', outcome: 'not_applied' })
  await pending
  const current = f.service.getControlState()
  await f.service.setRequested(false, { expectedRevision: current.revision, expectedRequested: current.requested })
  assert.equal(f.service.getControlState().requested, false)
  assert.throws(() => f.service.setRequested(true, { expectedRevision: current.revision, expectedRequested: current.requested }), { code: 'STALE_TARGET' })
  await f.service.close()
}
console.log('perception conditional control: PASS')
