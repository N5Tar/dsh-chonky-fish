/**
 * 大肥鱼模块 0 · P1 采集测试（不需要 DSH 运行时）。
 *
 *   node src/event-engine/tests/run-pipeline.mjs
 *
 * 覆盖：会话识别（工作区 + preset）、turn 聚合成 job、空 turn、重启不补采、
 * 重放幂等、游标单调、租约回收。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEventEngine, PROMPT_VERSION } from '../engine.js'

const POND = '/tmp/fake-home/小鱼塘'
const OTHER_WORKSPACE = '/tmp/fake-home/workspace/some-project'

function fishSession(id = 'session-fish-1') {
  return { id, header: { id, agentPreset: 'chonkyfish', cwd: POND }, seq: 0 }
}
function otherSession(id = 'session-other-1') {
  return { id, header: { id, agentPreset: 'chonkyfish', cwd: OTHER_WORKSPACE }, seq: 0 }
}
function otherPresetPondSession(id = 'session-standard-1') {
  return { id, header: { id, agentPreset: 'standard', cwd: POND }, seq: 0 }
}
function subagentSession(id = 'session-child-1') {
  return { id, header: { id, agentPreset: 'chonkyfish', cwd: POND, origin: 'subagent', delegationDepth: 1 }, seq: 0 }
}

let clock = Date.parse('2026-10-27T09:00:00.000Z')
const now = () => new Date((clock += 1000)).toISOString()

function event(seq, type, data = {}) {
  return { seq, type, time: Date.parse('2026-10-27T09:20:00.000Z') + seq * 1000, data, surfaceOp: 'append' }
}
const turnStart = (seq, turn) => event(seq, 'turn/start', { turn })
const userMessage = (seq, text) => event(seq, 'user/message', { role: 'user', content: [{ type: 'text', text }] })
const assistantMessage = (seq, text) =>
  event(seq, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] })
const toolCall = (seq) => event(seq, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
const toolResult = (seq) => event(seq, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [] } })
const turnEnd = (seq, turn, reason = { kind: 'completed' }) => event(seq, 'turn/end', { turn, reason })

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'chonkyfish-events-'))
  return { file: join(dir, 'events.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/* ------------------------------------------------------------------ */

test('小鱼塘 + chonkyfish 会话：user+assistant 聚合成一个 pending job', () => {
  const { file, cleanup } = tempDb()
  const engine = createEventEngine({ file, pondDir: POND, now })
  try {
    const session = fishSession()
    engine.feed(session, turnStart(1, 1))
    engine.feed(session, userMessage(2, '我最近很喜欢 Minecraft'))
    engine.feed(session, assistantMessage(3, '哇，主人喜欢 Minecraft 呀'))
    engine.feed(session, turnEnd(4, 1))

    const stats = engine.stats()
    assert.equal(stats.jobs.pending, 1, '应有一个待提取任务')
    assert.equal(stats.events, 0, 'P1 不产生语义事件')
    assert.equal(engine.getCursor(session.id), 4, '游标应推进到 turn/end')

    const job = engine.db.prepare('SELECT * FROM extraction_jobs').get()
    assert.equal(job.session_id, session.id)
    assert.equal(Number(job.turn), 1)
    assert.equal(Number(job.from_seq), 2)
    assert.equal(Number(job.to_seq), 3)
    assert.equal(job.prompt_version, PROMPT_VERSION)
    assert.equal(job.status, 'pending')
  } finally {
    engine.close()
    cleanup()
  }
})

test('非小鱼塘工作区的 chonkyfish 会话必须被忽略', () => {
  const { file, cleanup } = tempDb()
  const engine = createEventEngine({ file, pondDir: POND, now })
  try {
    const session = otherSession()
    const accepted = engine.feed(session, turnStart(1, 1))
    engine.feed(session, userMessage(2, '这是工作会话'))
    engine.feed(session, turnEnd(3, 1))
    assert.equal(accepted, false, 'feed 应返回 false')
    assert.equal(engine.stats().jobs.pending, 0)
    assert.equal(engine.getCursor(session.id), -1, '不应写游标')
  } finally {
    engine.close()
    cleanup()
  }
})

test('项目对、preset 不对 → 忽略（项目 + preset 缺一不可）', () => {
  const { file, cleanup } = tempDb()
  const engine = createEventEngine({ file, pondDir: POND, now })
  try {
    const session = otherPresetPondSession()
    assert.equal(engine.feed(session, turnStart(1, 1)), false)
    engine.feed(session, userMessage(2, '这个项目和鱼鱼无关'))
    engine.feed(session, turnEnd(3, 1))
    assert.equal(engine.stats().jobs.pending, 0)
    assert.equal(engine.getCursor(session.id), -1)
  } finally {
    engine.close()
    cleanup()
  }
})

test('两条件都满足才算：项目对 + preset 对 → 收', () => {
  const { file, cleanup } = tempDb()
  const engine = createEventEngine({ file, pondDir: POND, now })
  try {
    const session = fishSession('session-fish-10')
    assert.equal(engine.feed(session, turnStart(1, 1)), true)
  } finally {
    engine.close()
    cleanup()
  }
})

test('subagent 子会话（鱼鱼派出去的孩子）必须排除', () => {
  const { file, cleanup } = tempDb()
  const engine = createEventEngine({ file, pondDir: POND, now })
  try {
    const session = subagentSession()
    assert.equal(engine.feed(session, turnStart(1, 1)), false)
    engine.feed(session, userMessage(2, '子任务里的话'))
    engine.feed(session, turnEnd(3, 1))
    assert.equal(engine.stats().jobs.pending, 0)
    assert.equal(engine.getCursor(session.id), -1)
  } finally {
    engine.close()
    cleanup()
  }
})

test('联合判断没有单项放行：缺项目或缺 preset 都不行，也不可关闭校验', () => {
  const { file, cleanup } = tempDb()
  const engine = createEventEngine({ file, pondDir: POND, now })
  try {
    // 1) 项目对、preset 错
    assert.equal(engine.feed(otherPresetPondSession('session-standard-2'), turnStart(1, 1)), false)
    // 2) preset 对、项目错
    assert.equal(engine.feed(otherSession('session-other-2'), turnStart(1, 1)), false)
    // 3) 两个都对才算
    assert.equal(engine.feed(fishSession('session-fish-9'), turnStart(1, 1)), true)
    // 4) 没有项目路径就无法联合判断，直接拒绝启动
    assert.throws(() => createEventEngine({ file: file + '.x', now }), /pondDir is required/)
  } finally {
    engine.close()
    cleanup()
  }
})

test('空 turn（只有工具事件）不产生 job，记 empty_turn 审计', () => {
  const { file, cleanup } = tempDb()
  const engine = createEventEngine({ file, pondDir: POND, now })
  try {
    const session = fishSession('session-fish-2')
    engine.feed(session, turnStart(1, 2))
    engine.feed(session, toolCall(2))
    engine.feed(session, toolResult(3))
    engine.feed(session, turnEnd(4, 2))
    assert.equal(engine.stats().jobs.pending, 0)
    const audit = engine.db.prepare("SELECT reason_code FROM extraction_audit WHERE decision = 'skipped'").all()
    assert.deepEqual(audit.map((row) => row.reason_code), ['empty_turn'])
    assert.equal(engine.getCursor(session.id), 4)
  } finally {
    engine.close()
    cleanup()
  }
})

test('缺少 turn/start（模拟重启后中途接入）→ 跳过且不补采', () => {
  const { file, cleanup } = tempDb()
  const engine = createEventEngine({ file, pondDir: POND, now })
  try {
    const session = fishSession('session-fish-3')
    engine.feed(session, userMessage(10, '重启前说过的话'))
    engine.feed(session, turnEnd(11, 4))
    assert.equal(engine.stats().jobs.pending, 0, '不得为无头 turn 造 job')
    const audit = engine.db.prepare('SELECT reason_code FROM extraction_audit').all()
    assert.deepEqual(audit.map((row) => row.reason_code), ['turn_not_buffered'])
    assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM ingest_cursor').get().n, 1, '游标仍要推进')
  } finally {
    engine.close()
    cleanup()
  }
})

test('同一 turn 重放：job 只有一条，记 duplicate_turn 审计', () => {
  const { file, cleanup } = tempDb()
  const engine = createEventEngine({ file, pondDir: POND, now })
  try {
    const session = fishSession('session-fish-4')
    const events = [turnStart(1, 7), userMessage(2, '重复的 turn'), assistantMessage(3, '嗯嗯'), turnEnd(4, 7)]
    for (const entry of events) engine.feed(session, entry)
    for (const entry of events) engine.feed(session, entry)

    assert.equal(engine.stats().jobs.pending, 1)
    const audits = engine.db.prepare("SELECT reason_code FROM extraction_audit WHERE decision = 'skipped'").all()
    assert.deepEqual(audits.map((row) => row.reason_code), ['duplicate_turn'])
  } finally {
    engine.close()
    cleanup()
  }
})

test('跨进程重启：半截 turn 丢失，新引擎从 turn/end 起不会补造事件', () => {
  const { file, cleanup } = tempDb()
  const first = createEventEngine({ file, pondDir: POND, now })
  const session = fishSession('session-fish-5')
  first.feed(session, turnStart(1, 9))
  first.feed(session, userMessage(2, '这句话在重启前'))
  const cursorBefore = first.getCursor(session.id)
  first.close()

  const second = createEventEngine({ file, pondDir: POND, now })
  try {
    second.feed(session, assistantMessage(3, '重启之后才回的'))
    second.feed(session, turnEnd(4, 9))
    assert.equal(second.stats().jobs.pending, 0, '不补采 → 不为半截 turn 造 job')
    const audit = second.db.prepare('SELECT reason_code FROM extraction_audit').all()
    assert.deepEqual(audit.map((row) => row.reason_code), ['turn_not_buffered'])
    assert.equal(second.getCursor(session.id), 4)
    assert.ok(cursorBefore <= 4)
  } finally {
    second.close()
    cleanup()
  }
})

test('进程重启后回收租约过期的 processing 孤儿任务', () => {
  const { file, cleanup } = tempDb()
  const first = createEventEngine({ file, pondDir: POND, now })
  const session = fishSession('session-fish-6')
  first.feed(session, turnStart(1, 1))
  first.feed(session, userMessage(2, '会被处理的任务'))
  first.feed(session, turnEnd(3, 1))
  const jobId = first.db.prepare('SELECT job_id FROM extraction_jobs').get().job_id
  // 模拟：任务被领取后进程崩了，租约已过期
  first.db.prepare(
    "UPDATE extraction_jobs SET status = 'processing', lease_until = '2000-01-01T00:00:00.000Z' WHERE job_id = ?",
  ).run(jobId)
  first.close()

  const second = createEventEngine({ file, pondDir: POND, now })
  try {
    const row = second.db.prepare('SELECT status FROM extraction_jobs WHERE job_id = ?').get(jobId)
    assert.equal(row.status, 'pending', '孤儿任务应被放回 pending')
    assert.equal(second.stats().recoveredLeases, 1)
  } finally {
    second.close()
    cleanup()
  }
})

test('游标单调：回放更小的 seq 不会把游标写回去', () => {
  const { file, cleanup } = tempDb()
  const engine = createEventEngine({ file, pondDir: POND, now })
  try {
    const session = fishSession('session-fish-7')
    engine.feed(session, turnStart(100, 1))
    engine.feed(session, turnEnd(101, 1))
    engine.feed(session, turnStart(5, 0))
    assert.equal(engine.getCursor(session.id), 101)
  } finally {
    engine.close()
    cleanup()
  }
})

test('seq 空洞只记一次审计，不打断采集', () => {
  const { file, cleanup } = tempDb()
  const engine = createEventEngine({ file, pondDir: POND, now })
  try {
    const session = fishSession('session-fish-8')
    engine.feed(session, turnStart(1, 1))
    engine.feed(session, userMessage(2, '正常一条'))
    engine.feed(session, assistantMessage(9, '中间缺了 3..8'))
    engine.feed(session, turnEnd(10, 1))
    const audits = engine.db.prepare("SELECT reason_code FROM extraction_audit WHERE decision = 'observed'").all()
    assert.deepEqual(audits.map((row) => row.reason_code), ['seq_gap'])
    assert.equal(engine.stats().jobs.pending, 1, '有内容时仍要入队')
  } finally {
    engine.close()
    cleanup()
  }
})

/* ------------------------------------------------------------------ */

const failed = results.filter((entry) => !entry.ok)
console.log('模块0 P1 采集测试 · 用例: ' + results.length + ' · 通过: ' + (results.length - failed.length))
for (const entry of results) {
  console.log('  ' + (entry.ok ? 'PASS' : 'FAIL') + '  ' + entry.name)
  if (!entry.ok) console.log('        ' + (entry.error && entry.error.message))
}
console.log(failed.length === 0 ? '结果: PASS' : '结果: FAIL (' + failed.length + ')')
process.exitCode = failed.length === 0 ? 0 : 1
