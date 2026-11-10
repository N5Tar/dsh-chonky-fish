import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPerceptionStore } from '../store.js'
import { createPerceptionService } from '../service.js'

// Advance a synthetic clock over 90 minutes; no desktop signals or user database.
const directory = await mkdtemp(join(tmpdir(), 'fish-perception-soak-'))
const dbPath = join(directory, 'activity.db')
let service
try {
  let time = 2_000_000_000, observer, state = 'stopped'
  const store = createPerceptionStore({ dbPath, DatabaseSync, now: () => time })
  service = createPerceptionService({ store, now: () => time,
    setIntervalImpl: () => 0, clearIntervalImpl() {},
    collectorFactory(options) {
      observer = options
      return { getStatus: () => ({ state, runId: 'soak' }),
        async start() { state = 'running'; options.onState({ state, runId: 'soak' }) },
        async stop() { state = 'stopped'; options.onState({ state, runId: 'soak' }) }, async dispose() { state = 'disposed' } }
    },
  })
  await service.initialize(); await service.start()
  const begin = performance.now()
  let maxSamples = 0, deleted = 0
  for (let seq = 0; seq < 1080; seq++) {
    observer.onSample({ schemaVersion: 1, runId: 'soak', seq, observedAtMs: time, receivedAtMs: time,
      monotonicMs: seq * 5000, foregroundApp: { platform: 'macos', id: 'com.microsoft.VSCode', name: 'Synthetic IDE' },
      idleSeconds: seq % 7, sessionState: 'unknown', continuityBreak: false, missing: ['lockState'] })
    if (seq % 6 === 0) service.analyze()
    if (seq % 60 === 0) deleted += (await service.clean()).samples
    maxSamples = Math.max(maxSamples, service.getStatus().storage.samples)
    time += 5000
  }
  await service.clean()
  const counts = service.getStatus().storage
  assert.ok(maxSamples <= 720); assert.ok(counts.samples <= 720); assert.ok(deleted > 0)
  assert.ok(counts.summaries >= 80 && counts.summaries <= 180)
  assert.equal(service.getCurrent().data.activity, 'development')
  await service.close(); service = null
  const bytes = (await stat(dbPath)).size
  assert.ok(bytes < 8 * 1024 * 1024, `unexpected size ${bytes}`)
  const reopened = createPerceptionStore({ dbPath, DatabaseSync, now: () => time })
  assert.deepEqual(reopened.getCounts(), counts)
  time += 8 * 86400000
  await reopened.cleanup()
  assert.equal(reopened.getCounts().samples, 0); assert.equal(reopened.getCounts().summaries, 0)
  reopened.close()
  console.log(JSON.stringify({ result: 'PASS', simulatedMinutes: 90, counts, maxSamples, bytesAfterCheckpoint: bytes, elapsedMs: Math.round(performance.now() - begin), realCollection: false }))
} finally {
  await service?.close()
  assert.equal(resolve(directory), directory); assert.ok(directory.startsWith(join(tmpdir(), 'fish-perception-soak-')))
  await rm(directory, { recursive: true, force: true })
}
