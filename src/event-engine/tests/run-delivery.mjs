/**
 * 大肥鱼模块 0 · P3 分发测试（查询契约 + 游标消费者）。
 *
 *   node src/event-engine/tests/run-delivery.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { countDerived, purgeDerivedData, requeueAllJobs, requeueDeadLetters } from '../diagnostics/maintenance.mjs'
import { createCursorConsumer, createDemoConsumer } from '../delivery/consumer.js'
import { handleEventsRequest, parseEventsQuery, readEvents } from '../delivery/query.js'
import { createEventEngine } from '../engine.js'

const POND = '/tmp/fake-home/小鱼塘'
const TOKEN = 'test-token'

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'chonkyfish-delivery-'))
  const engine = createEventEngine({ file: join(dir, 'events.db'), pondDir: POND })
  return {
    engine,
    cleanup() {
      engine.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

let seqCounter = 0
function makeEvent({ type = 'preference.like_expressed', quote = '我最近很喜欢 Minecraft', sessionId = 'session-a' } = {}) {
  seqCounter += 1
  const seq = seqCounter
  return {
    eventId: 'event-' + seq,
    schemaVersion: '1.0',
    sessionId,
    category: type.slice(0, type.indexOf('.')),
    type,
    actorRef: 'owner',
    action: 'express_like',
    target: { kind: 'object', value: 'Minecraft' },
    polarity: 'positive',
    evidenceStatus: 'reported',
    occurredAt: null,
    observedAt: '2026-10-27T09:20:00.000Z',
    sourceRefs: [{ recordId: sessionId + ':' + (seq + 10), seq: seq + 10, quote, spanStart: 0, spanEnd: quote.length }],
    classifier: { model: 'test/stub', promptVersion: 'v1', runId: 'run-' + seq },
    dedupeKey: 'dedupe-' + seq,
    attributes: {},
  }
}

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

/* ------------------------------------------------------------------ */

test('鉴权：没有 token / token 不对 → 401', () => {
  const { engine, cleanup } = makeEngine()
  try {
    assert.equal(handleEventsRequest({ engine, headers: {}, url: '/chonkyfish/events', token: TOKEN }).status, 401)
    assert.equal(
      handleEventsRequest({ engine, headers: { 'x-chonkyfish-token': 'wrong' }, url: '/chonkyfish/events', token: TOKEN }).status,
      401,
    )
    const ok = handleEventsRequest({
      engine,
      headers: { 'x-chonkyfish-token': TOKEN },
      url: '/chonkyfish/events',
      token: TOKEN,
    })
    assert.equal(ok.status, 200)
  } finally {
    cleanup()
  }
})

test('查询参数：limit 截断、sinceSeq、sessionId 过滤', () => {
  const { engine, cleanup } = makeEngine()
  try {
    engine.storeEvents([makeEvent(), makeEvent({ sessionId: 'session-b' }), makeEvent()])

    assert.deepEqual(parseEventsQuery('/x'), { limit: 30, sinceSeq: 0, sessionId: null })
    assert.equal(parseEventsQuery('/x?limit=9999').limit, 200, 'limit 必须封顶')
    assert.equal(parseEventsQuery('/x?limit=0').limit, 30)
    assert.equal(parseEventsQuery('/x?sinceSeq=5').sinceSeq, 5)
    assert.equal(parseEventsQuery('/x?sessionId=session-b').sessionId, 'session-b')

    const all = readEvents(engine, { limit: 10, sessionId: null, sinceSeq: 0 })
    assert.equal(all.count, 3)
    assert.equal(all.events[0].quote, '我最近很喜欢 Minecraft')
    assert.equal(all.events[0].target, 'Minecraft')
    assert.ok(all.stats.events >= 3)

    const onlyB = readEvents(engine, { limit: 10, sessionId: 'session-b', sinceSeq: 0 })
    assert.equal(onlyB.count, 1)

    const afterFirst = readEvents(engine, { limit: 10, sessionId: null, sinceSeq: all.events[0].eventSeq })
    assert.equal(afterFirst.count, 2)
  } finally {
    cleanup()
  }
})

test('消费者：一次投递不重复，游标落库', async () => {
  const { engine, cleanup } = makeEngine()
  try {
    const stored = engine.storeEvents([makeEvent(), makeEvent()])
    const seen = []
    const consumer = createCursorConsumer({
      engine,
      consumerId: 'test:consumer',
      onEvents: (events) => seen.push(...events.map((event) => event.eventId)),
    })

    const first = await consumer.poll()
    assert.equal(first.processed, 2)
    assert.deepEqual(seen, stored.events.map((event) => event.eventId))

    const second = await consumer.poll()
    assert.equal(second.processed, 0, '游标之后没有新事件')
    assert.equal(seen.length, 2)
    assert.equal(engine.getConsumerCursor('test:consumer'), stored.events[1].eventSeq)
  } finally {
    cleanup()
  }
})

test('消费者：重启后从落库游标继续，不重放旧事件', async () => {
  const { engine, cleanup } = makeEngine()
  try {
    engine.storeEvents([makeEvent()])
    const firstRun = []
    await createCursorConsumer({ engine, consumerId: 'test:resume', onEvents: (events) => firstRun.push(events.length) }).poll()
    assert.deepEqual(firstRun, [1])

    engine.storeEvents([makeEvent()])
    const secondRun = []
    await createCursorConsumer({ engine, consumerId: 'test:resume', onEvents: (events) => secondRun.push(events.length) }).poll()
    assert.deepEqual(secondRun, [1], '只投递新增的那一条')
  } finally {
    cleanup()
  }
})

test('演示消费者：可订阅 + 可重放（重放同一批不产生重复计数）', async () => {
  const { engine, cleanup } = makeEngine()
  try {
    engine.storeEvents([makeEvent(), makeEvent({ type: 'activity.activity_reported' })])
    const demo = createDemoConsumer(engine)
    const first = await demo.poll()
    assert.equal(first.processed, 2)
    assert.equal(demo.state.delivered, 2)
    assert.equal(demo.state.preview.length, 2)

    const replay = await demo.poll()
    assert.equal(replay.processed, 0)
    assert.equal(demo.state.delivered, 2)
  } finally {
    cleanup()
  }
})

test('运维：死信任务可以放回队列重跑（不清空已发布事件）', () => {
  const { engine, cleanup } = makeEngine()
  try {
    engine.storeEvents([makeEvent()])
    engine.db.prepare(
      `INSERT INTO extraction_jobs
         (job_id, session_id, turn, from_seq, to_seq, status, attempts, prompt_version, created_at, updated_at)
       VALUES ('job-dead', 'session-a', 1, 2, 3, 'dead_letter', 3, 'v1', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z')`,
    ).run()
    const moved = requeueDeadLetters(engine.db)
    assert.equal(moved, 1)
    const job = engine.db.prepare("SELECT status, attempts, last_error_code FROM extraction_jobs WHERE job_id = 'job-dead'").get()
    assert.equal(job.status, 'pending')
    assert.equal(Number(job.attempts), 0)
    assert.equal(job.last_error_code, null)
    assert.ok(engine.listEvents({}).length >= 1, '已发布事件不受影响')
  } finally {
    cleanup()
  }
})

test('运维：purge 派生数据 + requeue-all 用当前提示词版本重跑', async () => {
  const { engine, cleanup } = makeEngine()
  try {
    engine.storeEvents([makeEvent(), makeEvent()])
    engine.setConsumerCursor('demo:echo', 1)
    await createDemoConsumer(engine).poll()
    engine.db.prepare(
      `INSERT INTO extraction_jobs
         (job_id, session_id, turn, from_seq, to_seq, status, attempts, prompt_version, created_at, updated_at)
       VALUES ('job-a', 'session-a', 1, 2, 3, 'succeeded', 1, 'v1', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z')`,
    ).run()
    assert.ok(countDerived(engine.db).events > 0)

    const purged = purgeDerivedData(engine.db)
    assert.ok(purged.events >= 2)
    assert.ok(purged.audits >= 0)
    assert.ok(purged.consumers >= 1)
    assert.equal(countDerived(engine.db).events, 0)

    const moved = requeueAllJobs(engine.db, 'v2')
    assert.equal(moved, 1)
    const job = engine.db.prepare("SELECT status, attempts, prompt_version FROM extraction_jobs WHERE job_id = 'job-a'").get()
    assert.equal(job.status, 'pending')
    assert.equal(Number(job.attempts), 0)
    assert.equal(job.prompt_version, 'v2')
  } finally {
    cleanup()
  }
})

/* ------------------------------------------------------------------ */

const failed = results.filter((entry) => !entry.ok)
console.log('模块0 P3 分发测试 · 用例: ' + results.length + ' · 通过: ' + (results.length - failed.length))
for (const entry of results) {
  console.log('  ' + (entry.ok ? 'PASS' : 'FAIL') + '  ' + entry.name)
  if (!entry.ok) console.log('        ' + (entry.error && (entry.error.message || entry.error)))
}
console.log(failed.length === 0 ? '结果: PASS' : '结果: FAIL (' + failed.length + ')')
process.exitCode = failed.length === 0 ? 0 : 1
