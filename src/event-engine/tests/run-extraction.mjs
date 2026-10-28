/**
 * 大肥鱼模块 0 · P2 提取测试（不需要真实模型 / 不需要 DSH 运行时）。
 *
 *   node src/event-engine/tests/run-extraction.mjs
 *
 * 用假的 llm + 假的 sessionQuery 跑完整链路：
 *   turn → job → 读原文 → 模型 → 解析/校验 → 归一化 → 落库 → 结算/审计
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEventEngine } from '../engine.js'
import { createExtractor, resolveModelFromId } from '../extraction/extractor.js'
import { loadTurnRecords } from '../extraction/payload.js'
import { createExtractionRunner } from '../extraction/runner.js'

const POND = '/tmp/fake-home/小鱼塘'
const SID = 'session-fish-extract'
const TIME_BASE = Date.parse('2026-10-27T09:20:00.000Z')

let clock = Date.parse('2026-10-27T10:00:00.000Z')
const now = () => new Date(clock).toISOString()
const advance = (ms) => {
  clock += ms
}

let seqCounter = 0

function userEvent(text, seq = ++seqCounter) {
  return { seq, type: 'user/message', time: TIME_BASE + seq * 1000, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text }] } }
}
function assistantEvent(text, seq = ++seqCounter) {
  return {
    seq,
    type: 'assistant/message',
    time: TIME_BASE + seq * 1000,
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] },
  }
}
function turnStartEvent(seq = ++seqCounter, turn = 1) {
  return { seq, type: 'turn/start', time: TIME_BASE + seq * 1000, data: { turn } }
}
function turnEndEvent(seq = ++seqCounter, turn = 1) {
  return { seq, type: 'turn/end', time: TIME_BASE + seq * 1000, data: { turn, reason: { kind: 'completed' } } }
}
function toolCallEvent(seq = ++seqCounter) {
  return { seq, type: 'tool/call', time: TIME_BASE + seq * 1000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } }
}

function fishSession(id = SID) {
  return {
    id,
    header: { id, agentPreset: 'chonkyfish', cwd: POND },
    requestContext: () => ({ provider: 'test', model: 'stub-1' }),
  }
}

/** 假 sessionQuery：把 feed 进去的消息事件当作可回读的会话日志。 */
function makeSessionQuery(eventsBySession) {
  return {
    async listEvents(sessionId) {
      const map = eventsBySession.get(sessionId) ?? new Map()
      return [...map.entries()].map(([seq, event]) => ({
        sessionId,
        seq,
        type: event.type,
        time: event.time,
        surface: event.surface ?? 'current',
      }))
    },
    async readEvent({ sessionId, seq }) {
      const map = eventsBySession.get(sessionId) ?? new Map()
      return { target: map.get(seq) }
    },
  }
}

function makeLlm(responses) {
  const calls = []
  let index = 0
  return {
    calls,
    stream(options) {
      calls.push(options)
      const text = responses[Math.min(index, responses.length - 1)]
      index += 1
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function validOutput() {
  return JSON.stringify({
    schemaVersion: '1.0',
    events: [
      {
        category: 'preference',
        type: 'like_expressed',
        target: 'Minecraft',
        targetKind: 'object',
        polarity: 'positive',
        modality: 'asserted',
        sourceRecordId: SID + ':2',
        sourceQuote: '我最近很喜欢 Minecraft',
        timeExpression: '最近',
      },
    ],
    noEventReason: null,
  })
}

/** 建一套环境：引擎 + 假会话日志 + 假模型 + runner。 */
function setup({ responses, userText = '我最近很喜欢 Minecraft', extraEvents = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'chonkyfish-extract-'))
  const file = join(dir, 'events.db')
  seqCounter = 0

  const eventsBySession = new Map([[SID, new Map()]])
  const sessionQuery = makeSessionQuery(eventsBySession)
  const llm = makeLlm(responses)
  const engine = createEventEngine({ file, workspaceRoot: POND, now })
  const extractor = createExtractor({
    llm,
    resolveModel: (modelId) => resolveModelFromId(modelId, { provider: 'fallback', model: 'default' }),
  })
  const runner = createExtractionRunner({ engine, extractor, sessionQuery, now })

  const session = fishSession()
  const events = [
    turnStartEvent(),
    userEvent(userText),
    ...extraEvents,
    assistantEvent('哇，主人也喜欢 Minecraft 呀'),
    turnEndEvent(),
  ]
  for (const event of events) {
    engine.feed(session, event)
    eventsBySession.get(SID).set(event.seq, { type: event.type, time: event.time, data: event.data, surface: event.surface })
  }
  return {
    engine,
    runner,
    llm,
    sessionQuery,
    eventsBySession,
    dir,
    file,
    cleanup() {
      engine.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

/* ------------------------------------------------------------------ */

await test('happy path：一个 turn → 一条事件，模型取会话自己的（preset 决定）', async () => {
  const env = setup({ responses: [validOutput()] })
  try {
    const summary = await env.runner.runOnce()
    assert.deepEqual(summary, { processed: 1, succeeded: 1, skipped: 0, retrying: 0, deadLetter: 0 })

    const events = env.engine.listEvents({ sessionId: SID })
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'preference.like_expressed')
    assert.equal(events[0].evidenceStatus, 'reported')
    assert.equal(events[0].actorRef, 'owner')
    assert.equal(events[0].sourceRefs[0].recordId, SID + ':2')
    assert.equal(events[0].sourceRefs[0].spanStart, 0)
    assert.equal(events[0].classifier.model, 'test/stub-1')

    const job = env.engine.db.prepare('SELECT * FROM extraction_jobs').get()
    assert.equal(job.status, 'succeeded')
    assert.equal(job.model_id, 'test/stub-1', 'job 应记录会话模型')
    assert.equal(job.attempts, 1)

    // 只发当前 turn 的原文，不回灌人格上下文
    const sent = JSON.parse(env.llm.calls[0].messages[0].content[0].text.replace('待提取的原始记录：\n', ''))
    assert.equal(sent.rawRecords.length, 2)
    assert.deepEqual(sent.rawRecords.map((record) => record.sourceKind), ['user_message', 'assistant_message'])
  } finally {
    env.cleanup()
  }
})

await test('格式错误：一次修复重试后成功，并记 repaired 审计', async () => {
  const env = setup({ responses: ['这不是 JSON', validOutput()] })
  try {
    const summary = await env.runner.runOnce()
    assert.equal(summary.succeeded, 1)
    assert.equal(env.llm.calls.length, 2, '应恰好重试一次')
    const audits = env.engine.db.prepare("SELECT reason_code FROM extraction_audit WHERE decision = 'repaired'").all()
    assert.deepEqual(audits.map((row) => row.reason_code), ['format_repaired'])
    assert.equal(env.engine.listEvents({}).length, 1)
  } finally {
    env.cleanup()
  }
})

await test('两次都格式错误 → failed_retryable，不制造事件', async () => {
  const env = setup({ responses: ['坏 JSON 1', '坏 JSON 2'] })
  try {
    const summary = await env.runner.runOnce()
    assert.equal(summary.retrying, 1)
    assert.equal(env.engine.listEvents({}).length, 0)
    const job = env.engine.db.prepare('SELECT * FROM extraction_jobs').get()
    assert.equal(job.status, 'failed_retryable')
    assert.equal(job.last_error_code, 'invalid_json_after_repair')
    assert.ok(job.next_attempt_at > now(), '应排下一次退避重试')
  } finally {
    env.cleanup()
  }
})

await test('重试 3 次都失败 → dead_letter（不无限重试）', async () => {
  const env = setup({ responses: ['坏 JSON'] })
  try {
    for (let round = 0; round < 3; round += 1) {
      await env.runner.runOnce()
      advance(61_000)
    }
    const job = env.engine.db.prepare('SELECT * FROM extraction_jobs').get()
    assert.equal(job.status, 'dead_letter')
    assert.equal(job.attempts, 3)
    const audits = env.engine.db.prepare("SELECT details_json FROM extraction_audit WHERE decision = 'failed'").all()
    assert.ok(audits.some((row) => JSON.parse(row.details_json).deadLetter === true))
    assert.equal(env.engine.listEvents({}).length, 0)
  } finally {
    env.cleanup()
  }
})

await test('引文不在原文里 → 拒绝该候选，job 记为 skipped', async () => {
  const output = validOutput().replace('我最近很喜欢 Minecraft', '我最近很喜欢动物')
  const env = setup({ responses: [output] })
  try {
    const summary = await env.runner.runOnce()
    assert.equal(summary.skipped, 1)
    assert.equal(env.engine.listEvents({}).length, 0)
    const audits = env.engine.db.prepare("SELECT reason_code FROM extraction_audit WHERE decision = 'rejected'").all()
    assert.deepEqual(audits.map((row) => row.reason_code), ['quote_not_found'])
  } finally {
    env.cleanup()
  }
})

await test('events=[] 是正常结果：job skipped，原因落库', async () => {
  const output = JSON.stringify({ schemaVersion: '1.0', events: [], noEventReason: 'small_talk' })
  const env = setup({ responses: [output], userText: '哈哈哈' })
  try {
    const summary = await env.runner.runOnce()
    assert.equal(summary.skipped, 1)
    const job = env.engine.db.prepare('SELECT * FROM extraction_jobs').get()
    assert.equal(job.status, 'skipped')
    assert.equal(job.last_error_code, 'small_talk')
    assert.equal(env.engine.listEvents({}).length, 0)
  } finally {
    env.cleanup()
  }
})

await test('重放同一个 turn（重新提取）→ 不产生重复事件', async () => {
  const env = setup({ responses: [validOutput()] })
  try {
    await env.runner.runOnce()
    assert.equal(env.engine.listEvents({}).length, 1)

    env.engine.db.prepare("UPDATE extraction_jobs SET status = 'pending', attempts = 0, next_attempt_at = NULL").run()
    const summary = await env.runner.runOnce()
    assert.equal(summary.succeeded, 1)
    assert.equal(env.engine.listEvents({}).length, 1, '去重键必须挡住重复入库')
    const audits = env.engine.db.prepare("SELECT reason_code FROM extraction_audit WHERE decision = 'observed'").all()
    assert.deepEqual(audits.map((row) => row.reason_code), ['duplicate_events'])
  } finally {
    env.cleanup()
  }
})

await test('读原文：跳过工具事件与被 compaction 换掉的 shadowed 记录', async () => {
  const eventsBySession = new Map([[SID, new Map()]])
  const user = userEvent('我最近很喜欢 Minecraft', 2)
  const tool = toolCallEvent(3)
  const shadowed = { ...assistantEvent('旧的、被替换掉的回复', 4), surface: 'shadowed' }
  const assistant = assistantEvent('新回复', 5)
  for (const event of [user, tool, shadowed, assistant]) {
    eventsBySession.get(SID).set(event.seq, { type: event.type, time: event.time, data: event.data, surface: event.surface ?? 'current' })
  }
  const records = await loadTurnRecords({
    sessionQuery: makeSessionQuery(eventsBySession),
    sessionId: SID,
    fromSeq: 2,
    toSeq: 5,
  })
  assert.deepEqual(records.map((record) => record.seq), [2, 5])
  assert.deepEqual(records.map((record) => record.sourceKind), ['user_message', 'assistant_message'])
  assert.equal(records[0].recordId, SID + ':2')
})

await test('会话日志读不到 → payload_unavailable，可重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chonkyfish-extract-'))
  const engine = createEventEngine({ file: join(dir, 'events.db'), workspaceRoot: POND, now })
  seqCounter = 0
  const session = fishSession()
  for (const event of [turnStartEvent(), userEvent('我最近很喜欢 Minecraft'), turnEndEvent()]) engine.feed(session, event)
  const runner = createExtractionRunner({
    engine,
    extractor: createExtractor({ llm: makeLlm([validOutput()]), resolveModel: () => ({ provider: 'test', model: 'stub-1' }) }),
    sessionQuery: { async listEvents() { throw new Error('session gone') }, async readEvent() { throw new Error('session gone') } },
    now,
  })
  try {
    const summary = await runner.runOnce()
    assert.equal(summary.retrying, 1)
    const job = engine.db.prepare('SELECT * FROM extraction_jobs').get()
    assert.equal(job.status, 'failed_retryable')
    assert.equal(job.last_error_code, 'payload_unavailable')
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('模型在 JSON 前后夹散文 → 仍能抽出来，不需要修复重试', async () => {
  const env = setup({ responses: ['好的，我来抽取：\n' + validOutput() + '\n以上就是结果。'] })
  try {
    const summary = await env.runner.runOnce()
    assert.equal(summary.succeeded, 1)
    assert.equal(env.engine.listEvents({}).length, 1)
    assert.equal(env.llm.calls.length, 1, '切出平衡 JSON 块后一次就够')
  } finally {
    env.cleanup()
  }
})

await test('不再限制 maxTokens（2026-10-27 拍板：宁可多花 token 也不截断 JSON）', async () => {
  const env = setup({ responses: [validOutput()] })
  try {
    await env.runner.runOnce()
    assert.equal(env.llm.calls[0].maxTokens, undefined, '不传 maxTokens')
    assert.equal(env.llm.calls[0].temperature, 0.1)
  } finally {
    env.cleanup()
  }
})

await test('输出被截断（JSON 不闭合）→ 失败，但审计留下可诊断现场', async () => {
  const truncated = validOutput().slice(0, 120)
  const env = setup({ responses: [truncated] })
  try {
    const summary = await env.runner.runOnce()
    assert.equal(summary.retrying, 1)
    const row = env.engine.db
      .prepare("SELECT reason_code, details_json FROM extraction_audit WHERE decision = 'failed'")
      .get()
    assert.equal(row.reason_code, 'invalid_json_after_repair')
    const details = JSON.parse(row.details_json)
    assert.equal(typeof details.rawLength, 'number')
    assert.ok(details.rawLength > 0)
    assert.equal(details.finishKind, 'stop')
    assert.ok(String(details.detail).length > 0, '必须记录解析失败原因')
  } finally {
    env.cleanup()
  }
})

await test('timeExpression 不在原文里 → 丢弃该字段（不拒绝整条事件）', async () => {
  const output = validOutput().replace('"timeExpression":"最近"', '"timeExpression":"下次"')
  const env = setup({ responses: [output] })
  try {
    const summary = await env.runner.runOnce()
    assert.equal(summary.succeeded, 1)
    const event = env.engine.listEvents({})[0]
    assert.equal(event.attributes.timeExpression, null, '编造的时间表达必须被丢弃')
    assert.equal(event.sourceRefs[0].quote, '我最近很喜欢 Minecraft', '事件本身保留')
  } finally {
    env.cleanup()
  }
})

await test('timeExpression 在原文里 → 保留', async () => {
  const env = setup({ responses: [validOutput()] })
  try {
    await env.runner.runOnce()
    assert.equal(env.engine.listEvents({})[0].attributes.timeExpression, '最近')
  } finally {
    env.cleanup()
  }
})

/* ------------------------------------------------------------------ */

const failed = results.filter((entry) => !entry.ok)
console.log('模块0 P2 提取测试 · 用例: ' + results.length + ' · 通过: ' + (results.length - failed.length))
for (const entry of results) {
  console.log('  ' + (entry.ok ? 'PASS' : 'FAIL') + '  ' + entry.name)
  if (!entry.ok) console.log('        ' + (entry.error && (entry.error.message || entry.error)))
}
console.log(failed.length === 0 ? '结果: PASS' : '结果: FAIL (' + failed.length + ')')
process.exitCode = failed.length === 0 ? 0 : 1
