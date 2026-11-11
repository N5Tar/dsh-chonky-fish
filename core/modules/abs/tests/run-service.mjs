import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { createAbsService } from '../service.js'
import { createAbsHttpHandler } from '../../../../app/dsh/adapters/abs/http.js'
import { createState } from '../core.js'
import { sanitizeAbsConfig, mergeAbsConfig } from '../config.js'

const start = Date.parse('2026-11-07T00:00:00Z')
const noDecay = { drives: { social: { decayPerHour: 0 }, curiosity: { decayPerHour: 0 } } }

async function setup(overrides = {}, seed, options = {}) {
  let clock = options.realStart ?? start, cfg = sanitizeAbsConfig(overrides), saved = seed ? structuredClone(seed) : null, callback
  const records = [], deliveries = []
  let acceptance = () => ({ accepted: true, status: 'accepted', sessionId: 'fish', messageId: 'msg-' + deliveries.length })
  const store = {
    read: () => structuredClone(saved),
    async commit(value, rows) { if (saved) assert.ok(value.revision >= saved.revision); saved = structuredClone(value); records.push(...structuredClone(rows)); await options.onCommit?.(value, rows) },
    records: ({ limit }) => records.slice(-limit),
    async close() {},
  }
  const host = {
    async environment() { return { ownerSession: { available: true, sessionId: 'fish' }, search: { available: true } } },
    async surfaceReview({ canDeliver, ...payload }) { const reason = canDeliver?.(); if (reason) return { accepted: false, reason }; deliveries.push(structuredClone(payload)); return acceptance() },
    subscribeObservation(fn) { callback = fn; return () => { callback = null } },
    close() {},
  }
  const service = await createAbsService({ store, host, getConfig: () => cfg, now: () => clock, logger: { warn() {} }, ...(options.timers ? { timers: options.timers } : {}) })
  return {
    service, records, deliveries,
    get state() { return saved },
    now: () => clock,
    advanceMinutes: (minutes) => { clock += minutes * 60000 },
    advanceMs: (ms) => { clock += ms },
    configure: (patch) => { cfg = mergeAbsConfig(cfg, patch) },
    cfg: () => cfg,
    observe: (observation) => callback?.(observation),
    setAcceptance: (fn) => { acceptance = fn },
    close: () => service.close(),
  }
}
let passed = 0
async function test(name, fn) { await fn(); console.log('PASS', name); passed++ }

await test('rest blocks timer/manual/activation at 120x and resumes once at 08:00', async () => {
  const realStart = Date.parse('2026-11-07T23:00:00+08:00')
  const f = await setup({ mode: 'active', timeScale: 120, activationCooldownMinutes: 0 }, null, { realStart })
  for (const cause of ['timer', 'manual', 'transition']) assert.equal((await f.service.wake(cause)).reason, 'REST_HOURS')
  assert.equal(f.deliveries.length, 0)
  const view = f.service.inspect().clockView
  assert.equal(view.rest.resting, true)
  assert.equal(view.nextWakeRealAt, '2026-11-08T00:00:00.000Z')
  f.observe({ kind: 'owner_message', sessionId: 'fish', seq: 1, at: new Date(f.now()).toISOString() })
  await f.service.syncClock()
  assert.ok(f.state.lastOwnerMessage)
  const seed = f.state; await f.close()
  const g = await setup({ mode: 'active', timeScale: 120, activationCooldownMinutes: 0 }, seed, { realStart: realStart + 8 * 3600000 })
  assert.equal((await g.service.wake('manual')).reason, 'REST_HOURS')
  g.advanceMinutes(60)
  assert.equal((await g.service.wake('timer')).delivered, true)
  assert.equal((await g.service.wake('timer')).reason, 'NOT_DUE')
  assert.equal(g.deliveries.length, 1)
  await g.close()
})

await test('future deadlines inside rest are shown at morning and disabling rest takes effect', async () => {
  const f = await setup({ mode: 'active', activationCooldownMinutes: 0 }, null, { realStart: Date.parse('2026-11-07T22:00:00+08:00') })
  assert.equal((await f.service.wake('timer')).delivered, true)
  assert.equal(f.service.inspect().clockView.nextWakeRealAt, '2026-11-08T00:00:00.000Z')
  f.advanceMinutes(120)
  assert.equal((await f.service.wake('manual')).reason, 'REST_HOURS')
  f.configure({ restHours: { enabled: false } })
  assert.equal((await f.service.wake('timer')).delivered, true)
  await f.close()
})

await test('rest timer polls configuration without repeated wakes or audit writes', async () => {
  let callback, delay
  const timers = { setTimeout(fn, ms) { callback = fn; delay = ms; return { unref() {} } }, clearTimeout() {} }
  const f = await setup({ mode: 'active', activationCooldownMinutes: 0 }, null, { realStart: Date.parse('2026-11-07T23:30:00+08:00'), timers })
  await f.service.wake('manual'); f.service.start()
  const count = f.records.length
  assert.equal(delay, 30000)
  for (let i = 0; i < 3; i++) { f.advanceMinutes(.5); callback(); await f.service.syncClock() }
  assert.equal(f.records.length, count)
  assert.equal(f.deliveries.length, 0)
  f.configure({ timeScale: 0 }); await f.service.syncClock()
  assert.equal(f.service.inspect().clockView.nextWakeRealAt, null)
  await f.close()
})

await test('shadow computes and previews without delivering anything', async () => {
  const f = await setup()
  const result = await f.service.wake('timer')
  assert.equal(result.delivered, false)
  assert.equal(result.reason, 'SHADOW_PREVIEW_ONLY')
  assert.equal(f.deliveries.length, 0)
  assert.equal(f.state.lastReview, null)
  assert.ok(f.state.nextWakeAt)
  assert.ok(f.service.inspect().reviewPreview.includes('大肥鱼的内心独白'))
  assert.equal(f.records.find((row) => row.type === 'WakeRecord').gate, 'SHADOW_PREVIEW_ONLY')
  const before = JSON.stringify(f.state)
  const preview = f.service.preview()
  assert.ok(preview.text.includes('大肥鱼的内心独白'))
  assert.equal(JSON.stringify(f.state), before)
  await f.close()
})

await test('active delivers one review only after activation cooldown', async () => {
  const f = await setup({ mode: 'active' })
  const first = await f.service.wake('timer')
  assert.equal(first.delivered, false)
  assert.equal(first.reason, 'ACTIVATION_COOLDOWN')
  assert.equal(f.deliveries.length, 0)
  f.advanceMinutes(121)
  const second = await f.service.wake('timer')
  assert.equal(second.delivered, true)
  assert.equal(f.deliveries.length, 1)
  const review = f.deliveries[0]
  assert.ok(review.text.includes('大肥鱼的内心独白'))
  for (const word of ['web_search', '目标', '任务', '请']) assert.ok(!review.text.includes(word))
  assert.equal(f.state.lastReview.status, 'delivered')
  assert.equal(f.state.lastReview.messageId, 'msg-1')
  assert.ok(f.records.some((row) => row.type === 'ReviewDelivered'))
  assert.equal(f.state.nextWakeAt, new Date(Date.parse(f.state.lastReview.at) + 120 * 60000).toISOString())
  await f.close()
})

await test('scheduled reviews respect the interval; manual review bypasses the schedule', async () => {
  const f = await setup({ mode: 'active' })
  await f.service.wake('timer'); f.advanceMinutes(121); await f.service.wake('timer')
  assert.equal(f.deliveries.length, 1)
  f.advanceMinutes(5)
  assert.equal((await f.service.wake('timer')).reason, 'NOT_DUE')
  assert.equal(f.deliveries.length, 1)
  assert.equal((await f.service.wake('manual')).delivered, true)
  assert.equal(f.deliveries.length, 2)
  await f.close()
})

await test('real-time minimum gap prevents flooding under acceleration', async () => {
  const f = await setup({ mode: 'active', timeScale: 60, reviewIntervalMinutes: 10 })
  await f.service.wake('timer')
  f.advanceMinutes(1) // 60 ABS minutes, past activation
  assert.equal((await f.service.wake('timer')).delivered, true)
  assert.equal(f.deliveries.length, 1)
  const next = Date.parse(f.state.nextWakeAt)
  f.advanceMs(10000) // 10 real seconds = 10 ABS minutes, but the real gap is 10 real minutes
  assert.ok(next > f.now())
  assert.equal((await f.service.wake('timer')).reason, 'NOT_DUE')
  assert.equal(f.deliveries.length, 1)
  f.advanceMinutes(10)
  assert.equal((await f.service.wake('timer')).delivered, true)
  await f.close()
})

await test('pause blocks delivery and keeps state frozen', async () => {
  const f = await setup({ mode: 'active' })
  await f.service.wake('timer'); f.advanceMinutes(121)
  f.configure({ timeScale: 0 }); await f.service.syncClock()
  const frozen = f.service.inspect().clockView.virtualNow
  f.advanceMinutes(30)
  assert.equal((await f.service.wake('timer')).reason, 'TIME_PAUSED')
  assert.equal(f.deliveries.length, 0)
  assert.equal(f.service.inspect().clockView.virtualNow, frozen)
  await f.close()
})

await test('delivery failure is recorded without inventing success', async () => {
  const f = await setup({ mode: 'active' })
  f.setAcceptance(() => ({ accepted: false, status: 'rejected', reason: 'agent-busy' }))
  await f.service.wake('timer'); f.advanceMinutes(121)
  const result = await f.service.wake('timer')
  assert.equal(result.delivered, false)
  assert.equal(result.reason, 'agent-busy')
  assert.equal(f.state.lastReview.status, 'failed')
  assert.ok(f.records.some((row) => row.type === 'ReviewFailed'))
  await f.close()
})

await test('owner messages raise social satisfaction once per record', async () => {
  const f = await setup(noDecay)
  const before = f.state.drives.social.satisfaction
  f.observe({ kind: 'owner_message', sessionId: 'fish', seq: 11, at: new Date(f.now()).toISOString() })
  await f.service.syncClock()
  assert.ok(Math.abs(f.state.drives.social.satisfaction - before - .05) < 1e-12)
  assert.ok(f.state.lastOwnerMessage)
  f.observe({ kind: 'owner_message', sessionId: 'fish', seq: 11, at: new Date(f.now()).toISOString() })
  await f.service.syncClock()
  assert.ok(Math.abs(f.state.drives.social.satisfaction - before - .05) < 1e-12)
  assert.equal(f.state.observations.filter((row) => row.kind === 'owner_message').length, 1)
  await f.close()
})

await test('verified exploration raises curiosity; empty results do not', async () => {
  const f = await setup(noDecay)
  const before = f.state.drives.curiosity.satisfaction
  f.observe({ kind: 'exploration', result: 'explore_no_usable_content', sessionId: 'fish', seq: 20, at: new Date(f.now()).toISOString(), sources: 0 })
  await f.service.syncClock()
  assert.equal(f.state.drives.curiosity.satisfaction, before)
  assert.equal(f.state.lastExploration.resultKind, 'explore_no_usable_content')
  f.observe({ kind: 'exploration', result: 'explore_content_found', sessionId: 'fish', seq: 21, at: new Date(f.now()).toISOString(), sources: 3 })
  await f.service.syncClock()
  assert.ok(Math.abs(f.state.drives.curiosity.satisfaction - before - .15) < 1e-12)
  assert.equal(f.state.lastExploration.sources, 3)
  assert.ok(f.records.some((row) => row.type === 'FeedbackApplied' && row.driveId === 'curiosity'))
  await f.close()
})

await test('local feedback is capped per turn, content deduped across restart, and ledger explains zero gain', async () => {
  const f = await setup(noDecay)
  const observation = (seq, turn, evidenceKey) => ({ kind: 'exploration', result: 'local_content_found', activity: 'read', sessionId: 'fish', seq, turn, evidenceKey, at: new Date(f.now()).toISOString() })
  f.observe(observation(1, 1, 'a'.repeat(64))); await f.service.syncClock()
  assert.ok(Math.abs(f.state.drives.curiosity.satisfaction - .5) < 1e-12)
  f.observe(observation(2, 1, 'b'.repeat(64))); await f.service.syncClock()
  assert.equal(f.state.changeLedger.at(-1).reason, 'local_turn_limit')
  assert.equal(f.state.changeLedger.at(-1).delta, 0)
  const seed = f.state; await f.close()
  const g = await setup(noDecay, seed)
  g.observe(observation(3, 2, 'a'.repeat(64))); await g.service.syncClock()
  assert.equal(g.state.changeLedger.at(-1).reason, 'duplicate_evidence')
  g.observe(observation(4, 2, 'c'.repeat(64))); await g.service.syncClock()
  assert.ok(Math.abs(g.state.drives.curiosity.satisfaction - .65) < 1e-12)
  assert.ok(Math.abs(g.state.changeLedger.at(-1).delta - .15) < 1e-12)
  const length = g.state.changeLedger.length
  g.observe(observation(4, 2, 'c'.repeat(64))); await g.service.syncClock()
  assert.equal(g.state.changeLedger.length, length)
  for (let seq = 10; seq < 215; seq++) g.observe({ ...observation(seq, 3, ''), result: 'unverified_activity' })
  await g.service.syncClock()
  assert.equal(g.state.changeLedger.length, 200)
  assert.equal(g.state.changeLedger.at(-1).delta, 0)
  await g.close()
})

await test('ledger records actual clamped gain and accelerated decay with real timestamps', async () => {
  const f = await setup({ timeScale: 120, drives: { curiosity: { initialSatisfaction: .98 } } })
  f.observe({ kind: 'exploration', result: 'explore_content_found', sessionId: 'fish', seq: 1, at: new Date(f.now()).toISOString(), sources: 1 })
  await f.service.syncClock()
  assert.ok(Math.abs(f.state.changeLedger.at(-1).delta - .02) < 1e-12)
  f.advanceMinutes(10); await f.service.wake('timer')
  const row = f.state.changeLedger.filter((row) => row.reason === 'natural_decay' && row.driveId === 'curiosity').at(-1)
  assert.ok(Math.abs(row.delta + .08) < 1e-12)
  assert.equal(row.realAt, new Date(f.now()).toISOString())
  await f.close()
})

await test('a review turn that yields a search result feeds back through observation', async () => {
  const f = await setup({ mode: 'active' })
  await f.service.wake('timer'); f.advanceMinutes(121); await f.service.wake('timer')
  const before = f.state.drives.curiosity.satisfaction
  f.observe({ kind: 'exploration', result: 'explore_content_found', sessionId: 'fish', seq: 30, at: new Date(f.now()).toISOString(), sources: 2 })
  await f.service.syncClock()
  assert.ok(f.state.drives.curiosity.satisfaction > before)
  assert.equal(f.deliveries.length, 1)
  await f.close()
})

await test('restart keeps state and does not replay missed reviews', async () => {
  const f = await setup({ mode: 'active' })
  await f.service.wake('timer'); f.advanceMinutes(121); await f.service.wake('timer')
  const snapshot = structuredClone(f.state)
  await f.close()
  const g = await setup({ mode: 'active' }, snapshot, { realStart: start + 600000 })
  assert.equal(g.service.inspect().lastReview.status, 'delivered')
  assert.equal(g.deliveries.length, 0)
  assert.ok(g.service.inspect().nextWakeAt)
  const result = await g.service.wake('timer')
  assert.equal(result.delivered, false)
  assert.ok(['NOT_DUE', 'ACTIVATION_COOLDOWN'].includes(result.reason))
  await g.close()
})

await test('legacy motivations and executions are archived, drives and clock survive', async () => {
  const legacy = createState(start)
  legacy.motivations = [{ id: 'old-motivation' }]
  legacy.executions = [{ executionId: 'old-execution' }]
  legacy.proposalIds = ['old-proposal']
  legacy.history = [{ kind: 'execution', intent: 'explore', at: new Date(start).toISOString(), mode: 'active' }]
  const f = await setup({}, legacy)
  assert.equal(f.state.motivations.length, 0)
  assert.equal(f.state.executions.length, 0)
  assert.equal(f.state.proposalIds.length, 0)
  assert.ok(f.records.some((row) => row.type === 'StateMigrated'))
  assert.ok(f.state.drives.social.satisfaction > 0)
  await f.close()
})

await test('60x and 1x produce identical internal state for the same ABS elapsed time', async () => {
  const normal = await setup(noDecay)
  const fast = await setup({ ...noDecay, timeScale: 60 })
  await normal.service.wake('timer')
  await fast.service.wake('timer')
  normal.advanceMinutes(120)
  fast.advanceMinutes(2)
  await normal.service.wake('timer')
  await fast.service.wake('timer')
  assert.deepEqual(normal.state.drives, fast.state.drives)
  assert.equal(normal.state.nextWakeAt, fast.state.nextWakeAt)
  assert.equal(normal.service.inspect().reviewPreview, fast.service.inspect().reviewPreview)
  assert.equal(fast.service.inspect().clockView.nextWakeRealAt, new Date(start + 4 * 60000).toISOString())
  await normal.close(); await fast.close()
})

await test('clock scale changes are persisted without delivering', async () => {
  const f = await setup({ mode: 'active' })
  await f.service.wake('timer'); f.advanceMinutes(121); await f.service.wake('timer')
  const deliveries = f.deliveries.length
  f.configure({ timeScale: 60 })
  await f.service.syncClock()
  assert.equal(f.deliveries.length, deliveries)
  assert.ok(f.records.some((row) => row.type === 'ClockScaleChanged'))
  assert.equal(f.service.inspect().clockView.timeScale, 60)
  await f.close()
})

async function request(handler, method, body, token) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = token === undefined ? {} : { 'x-chonkyfish-token': token }
  const result = {}
  await handler(req, { writeHead(status) { result.status = status }, end(text) { result.body = text ? JSON.parse(text) : null } })
  return result
}

await test('HTTP exposes state/environment and preview without side effects', async () => {
  const f = await setup()
  const handler = createAbsHttpHandler({ service: f.service, resources: { async updateConfig() {} }, token: 'token' })
  assert.equal((await request(handler, 'GET', undefined, 'bad')).status, 200)
  const current = await request(handler, 'GET')
  assert.equal(current.status, 200)
  assert.ok(current.body.state.reviewPreview.includes('大肥鱼的内心独白'))
  assert.equal(current.body.environment.ownerSession.available, true)
  const before = JSON.stringify(f.state), deliveries = f.deliveries.length
  const preview = await request(handler, 'POST', { action: 'preview' })
  assert.equal(preview.status, 200)
  assert.ok(preview.body.result.text.includes('大肥鱼的内心独白'))
  assert.equal(JSON.stringify(f.state), before)
  assert.equal(f.deliveries.length, deliveries)
  assert.equal((await request(handler, 'POST', { action: 'report', satisfactionDelta: 1 })).status, 400)
  await f.close()
})

await test('HTTP without tokens preserves method, payload and input validation', async () => {
  const f = await setup()
  const handler = createAbsHttpHandler({ service: f.service, resources: {}, maxBodyBytes: 32 })
  assert.equal((await request(handler, 'GET')).status, 200)
  assert.deepEqual(await request(handler, 'HEAD'), { status: 200, body: null })
  assert.equal((await request(handler, 'DELETE')).status, 405)
  assert.equal((await request(handler, 'POST')).status, 400)
  assert.equal((await request(handler, 'POST', [])).status, 400)
  assert.equal((await request(handler, 'POST', { action: 'preview', x: 1 })).status, 409)
  assert.equal((await request(handler, 'POST', { action: 'preview', padding: 'x'.repeat(33) })).status, 413)
  await f.close()
})

await test('HTTP mode activation requires confirmation and isolated replay stays isolated', async () => {
  const f = await setup()
  const handler = createAbsHttpHandler({ service: f.service, resources: { async updateConfig(patch) { f.configure(patch.abs) } }, token: 'token' })
  assert.equal((await request(handler, 'POST', { action: 'mode', mode: 'active' })).status, 409)
  f.advanceMinutes(30)
  const virtualNow = f.service.inspect().clockView.virtualNow
  const replay = await request(handler, 'POST', { action: 'replay', hours: 72 })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.result.isolated, true)
  assert.equal(Date.parse(replay.body.result.at), Date.parse(virtualNow) + 72 * 3600000)
  assert.ok(replay.body.result.review.includes('大肥鱼的内心独白'))
  assert.equal(f.deliveries.length, 0)
  const activated = await request(handler, 'POST', { action: 'mode', mode: 'active', confirmActive: true })
  assert.equal(activated.status, 200)
  assert.equal(f.cfg().mode, 'active')
  await f.close()
})

await test('HTTP rest settings validate, persist and never wake on save', async () => {
  const f = await setup()
  const handler = createAbsHttpHandler({ service: f.service, resources: { async updateConfig(patch) { f.configure(patch.abs) } }, token: 'token' })
  const input = { action: 'rest-hours', enabled: true, start: '22:30', end: '07:30' }
  assert.equal((await request(handler, 'POST', input, 'bad')).status, 200)
  for (const patch of [{ enabled: 'true' }, { start: '24:00' }, { end: '22:30' }, { start: null }, { timeZone: 'UTC' }]) assert.equal((await request(handler, 'POST', { ...input, ...patch })).status, 409)
  const result = await request(handler, 'POST', input)
  assert.equal(result.status, 200)
  assert.deepEqual(f.cfg().restHours, { enabled: true, start: '22:30', end: '07:30' })
  assert.equal(f.deliveries.length, 0)
  assert.equal(result.body.result.rest.start, '22:30')
  await f.close()
})

await test('HTTP scale validation and export', async () => {
  const f = await setup()
  const handler = createAbsHttpHandler({ service: f.service, resources: { async updateConfig(patch) { f.configure(patch.abs) } }, token: 'token' })
  for (const timeScale of [-1, 121, null, '60', true]) assert.equal((await request(handler, 'POST', { action: 'time-scale', timeScale })).status, 409)
  assert.equal((await request(handler, 'POST', { action: 'time-scale', timeScale: 60 })).status, 200)
  assert.equal(f.cfg().timeScale, 60)
  const exported = await request(handler, 'POST', { action: 'export' })
  assert.equal(exported.status, 200)
  assert.ok(exported.body.result.content.length > 0)
  await f.close()
})

await test('storage failure blocks further work', async () => {
  const f = await setup({}, undefined, { onCommit: async (_state, rows) => { if (rows.some((row) => row.type === 'ClockScaleChanged')) throw new Error('simulated storage failure') } })
  f.configure({ timeScale: 60 })
  await assert.rejects(f.service.syncClock(), /simulated storage failure/)
  assert.equal(f.service.inspect().storageUncertain, true)
  await assert.rejects(f.service.wake('timer'), /ABS_STORAGE_UNCERTAIN/)
  assert.equal(f.deliveries.length, 0)
  await f.close()
})

await test('service start schedules the ABS deadline in real time', async () => {
  const scheduled = []
  const timers = { setTimeout(callback, delay) { const handle = { callback, delay, unref() {} }; scheduled.push(handle); return handle }, clearTimeout(handle) { if (handle) handle.cleared = true } }
  const f = await setup({ timeScale: 60 }, undefined, { timers })
  await f.service.wake('timer')
  f.service.start()
  assert.ok(scheduled.length > 0)
  assert.ok(scheduled.at(-1).delay >= 250 && scheduled.at(-1).delay <= 30000)
  await f.close()
  assert.equal(scheduled.at(-1).cleared, true)
})

console.log(`ABS service/HTTP: ${passed} groups passed`)
