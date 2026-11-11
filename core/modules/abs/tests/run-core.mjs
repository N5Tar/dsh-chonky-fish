import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createState, updateState, nextReviewAt, applyFeedback, demand, DEFAULT_CONFIG } from '../core.js'
import { ABS_DEFAULTS } from '../config.js'
import { createAbsStore } from '../store.js'
import { platform } from '../../../../app/shared/platform/index.js'

const start = Date.parse('2026-11-07T00:00:00Z')
const H = 3600000
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)
let checks = 0
async function test(name, run) { await run(); checks++; console.log(`ok ${checks} - ${name}`) }

await test('default drives and demand', () => {
  assert.equal(DEFAULT_CONFIG, ABS_DEFAULTS)
  const state = createState(start)
  near(state.drives.social.satisfaction, .55)
  near(state.drives.social.demand, .2 / .75)
  near(state.drives.curiosity.demand, .5)
  assert.equal(state.motivations.length, 0)
  assert.equal(state.executions.length, 0)
  assert.equal(state.lastReview, null)
  assert.deepEqual(state.observations, [])
})

await test('decay uses elapsed time and never runs backwards', () => {
  const state = createState(start)
  updateState(state, start + H)
  near(state.drives.social.satisfaction, .542)
  near(state.drives.curiosity.satisfaction, .346)
  updateState(state, start)
  near(state.drives.curiosity.satisfaction, .346)
  updateState(state, start + 1000 * H)
  near(state.drives.curiosity.satisfaction, 0)
  assert.throws(() => createState('bad time'))
})

await test('feedback applies once, clamps and records provenance', () => {
  const state = createState(start)
  const first = applyFeedback(state, { driveId: 'curiosity', delta: .15, key: 'obs:exploration:fish:7', at: start })
  assert.equal(first.driveId, 'curiosity')
  near(state.drives.curiosity.satisfaction, .5)
  assert.equal(state.drives.curiosity.lastFeedbackAt, new Date(start).toISOString())
  assert.equal(applyFeedback(state, { driveId: 'curiosity', delta: .15, key: 'obs:exploration:fish:7', at: start + H }), null)
  near(state.drives.curiosity.satisfaction, .5)
  const huge = applyFeedback(state, { driveId: 'social', delta: 99, key: 'huge', at: start })
  assert.ok(huge)
  near(state.drives.social.satisfaction, 1)
  assert.equal(applyFeedback(state, { driveId: 'invented', delta: .1, key: 'x', at: start }), null)
  assert.equal(applyFeedback(state, { driveId: 'social', delta: 0, key: 'zero', at: start }), null)
})

await test('review deadline is bounded to 10–120 ABS minutes', () => {
  const state = createState(start)
  assert.equal(nextReviewAt(state, start, { reviewIntervalMinutes: 120 }), new Date(start + 120 * 60000).toISOString())
  assert.equal(nextReviewAt(state, start, { reviewIntervalMinutes: 1 }), new Date(start + 10 * 60000).toISOString())
  assert.equal(nextReviewAt(state, start, { reviewIntervalMinutes: 999 }), new Date(start + 120 * 60000).toISOString())
  assert.equal(demand({ satisfaction: 2, setpoint: .7 }), 0)
})

await test('durable snapshot, bounded audit, cloned reads, restart and corruption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chonkyfish-abs-core-'))
  let store = null
  try {
    store = await createAbsStore({ directory, syncDirectory: platform.syncDirectory })
    assert.equal(store.read(), null)
    const state = createState(start)
    applyFeedback(state, { driveId: 'social', delta: .1, key: 'obs:owner:fish:3', at: start })
    state.changeLedger = [{ realAt: new Date(start).toISOString(), driveId: 'social', reason: 'owner_message', before: .55, after: .65, delta: .1 }]
    await assert.rejects(store.commit({ ...state, changeLedger: 'corrupt' }), /ledger invalid/)
    await assert.rejects(store.commit({ ...state, changeLedger: [{ ...state.changeLedger[0], delta: .5 }] }), /ledger invalid/)
    await store.commit(state, [{ type: 'Observation', at: new Date(start).toISOString() }])
    assert.equal(store.read().drives.social.satisfaction, .65)
    assert.equal(store.read().feedbackKeys[0], 'obs:owner:fish:3')
    const saved = await readFile(join(directory, 'state.json'), 'utf8')
    const cloned = store.read()
    cloned.drives.social.satisfaction = 0
    assert.equal(store.read().drives.social.satisfaction, .65)
    await store.close(); store = null
    await writeFile(join(directory, 'state.json'), '{broken')
    await assert.rejects(createAbsStore({ directory, syncDirectory: platform.syncDirectory }))
    await writeFile(join(directory, 'state.json'), saved)
    store = await createAbsStore({ directory, syncDirectory: platform.syncDirectory })
    assert.equal(store.read().drives.social.satisfaction, .65)
    assert.equal(store.records({ limit: 10 }).length, 1)
    assert.deepEqual(store.read().changeLedger, state.changeLedger)
  } finally {
    await store?.close()
    const target = resolve(directory)
    assert.ok(target.startsWith(join(resolve(tmpdir()), 'chonkyfish-abs-core-')))
    await rm(target, { recursive: true, force: true })
  }
})

console.log(`ABS core: ${checks} tests passed (offline; no model/network).`)
