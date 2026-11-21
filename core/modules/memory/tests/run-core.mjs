import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createModulePrompt } from '../../persona/modules.js'
import { applySessionActivity, isActivityEvent, isValidSessionId, parseSessionIndex, parseSkillDocument, renderSessionIndex, shanghaiStamp } from '../core.js'
import { SKILL_LIMITS } from '../../../contracts/spec.js'
import { memoryPrompt } from '../persona.js'

const tests = []
const test = (name, fn) => tests.push([name, fn])
const at = iso => Date.parse(iso)

test('两类追加消息算活动，来源和正文不参与判断', () => {
  assert.equal(isActivityEvent({ type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'schedule' }, content: [] } }), true)
  assert.equal(isActivityEvent({ type: 'user/message', data: { content: [{ type: 'image' }] } }), true)
  assert.equal(isActivityEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply' }, { type: 'reasoning', text: 'hidden' }] } } }), true)
  assert.equal(isActivityEvent({ type: 'assistant/message', surfaceOp: 'append' }), true)
  for (const event of [
    { type: 'tool/call' },
    { type: 'tool/result' },
    { type: 'assistant/attempt' },
    { type: 'turn/start' },
    { type: 'step/delta' },
    { type: 'reasoning' },
    { type: 'user/message', surfaceOp: 'replace' },
    { type: 'assistant/message', surfaceOp: { op: 'replace' } },
    null,
    { type: 'user/message', surfaceOp: 'append' },
  ]) {
    if (event && event.type === 'user/message' && event.surfaceOp === 'append') continue
    assert.equal(isActivityEvent(event), false, JSON.stringify(event))
  }
})

test('Asia/Shanghai 跨午夜，非法时间不猜测', () => {
  assert.deepEqual(shanghaiStamp(at('2026-11-21T00:00:00+08:00')), { date: '2026-11-21', clock: '00:00' })
  assert.deepEqual(shanghaiStamp(at('2026-11-21T00:00:00+08:00') - 60 * 1000), { date: '2026-11-20', clock: '23:59' })
  assert.deepEqual(shanghaiStamp(at('2026-11-20T09:12:00+08:00')), { date: '2026-11-20', clock: '09:12' })
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '2026-11-20T09:12:00+08:00', null, undefined, Number.NEGATIVE_INFINITY]) {
    assert.equal(shanghaiStamp(value), null)
  }
})

test('同日合并首末、迟到不倒退、稳定排序，内容不变就不算改动', () => {
  const first = applySessionActivity(null, '2026-11-20', 'session-b', '14:03')
  const second = applySessionActivity(first.text, '2026-11-20', 'session-a', '09:12')
  const late = applySessionActivity(second.text, '2026-11-20', 'session-a', '15:40')
  const backwards = applySessionActivity(late.text, '2026-11-20', 'session-a', '08:01')
  const same = applySessionActivity(backwards.text, '2026-11-20', 'session-a', '10:00')
  assert.equal(same.changed, false)
  assert.equal(same.text, [
    '# 2026-11-20 活跃会话（Asia/Shanghai）',
    '- session-a | 首次 08:01 | 最近 15:40',
    '- session-b | 首次 14:03 | 最近 14:03',
    '',
  ].join('\n'))
  assert.equal(same.text.includes('seq'), false)
  const crlf = same.text.replace(/\n/g, '\r\n')
  const kept = applySessionActivity(crlf, '2026-11-20', 'session-a', '10:00')
  assert.equal(kept.changed, false)
  assert.equal(kept.text, same.text)
})

test('缺失当空；空文件、坏行、重复和日期不符都不给出可覆盖正文', () => {
  assert.equal(applySessionActivity(null, '2026-11-20', 'session-a', '09:12').ok, true)
  for (const broken of [
    '',
    '# 2026-11-21 活跃会话（Asia/Shanghai）\n',
    '# 2026-11-20 活跃会话（Asia/Shanghai）\n- session-a | 首次 15:40 | 最近 09:12\n',
    '# 2026-11-20 活跃会话（Asia/Shanghai）\n- session-a | 首次 09:12 | 最近 09:12\n- session-a | 首次 10:00 | 最近 10:00\n',
    '# 2026-11-20 活跃会话（Asia/Shanghai）\nnot a row\n',
    '# 2026-11-20 活跃会话（Asia/Shanghai）\n-  | 首次 09:12 | 最近 09:12\n',
  ]) {
    const applied = applySessionActivity(broken, '2026-11-20', 'session-b', '10:00')
    assert.equal(applied.ok, false)
    assert.equal(applied.text, undefined)
  }
  const parsed = parseSessionIndex('# 2026-11-20 活跃会话（Asia/Shanghai）\n- session-a | 首次 09:12 | 最近 09:12\n', '2026-11-20')
  assert.equal(parsed.ok, true)
  assert.equal(renderSessionIndex('2026-11-20', parsed.entries).includes('session-a'), true)
})

test('sessionId 不能含分隔符或换行', () => {
  assert.equal(isValidSessionId('session a'), true)
  assert.equal(isValidSessionId(''), false)
  assert.equal(isValidSessionId(' a'), false)
  assert.equal(isValidSessionId('a|b'), false)
  assert.equal(isValidSessionId('a\nb'), false)
})

test('skill 要求成品自包含，并原样说明官方工具', () => {
  const text = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8')
  const skill = parseSkillDocument(text)
  assert.equal(skill.name, 'memory')
  assert.match(skill.description, /记住、回忆、更正、忘记/)
  for (const phrase of [
    '不得留下来源 sessionId',
    '事件 seq',
    '会话链接',
    '机器本地会话路径',
    '见某会话',
    '正常事件日期',
    '随迁移携带的变更说明和回退副本',
    'memory/CHANGELOG.md',
    'memory/archive/',
    '不得为试验、备份或日志保留主人要求删除的内容',
    'session_search',
    'session_event_search',
    'session_event_read',
    'session_trace',
    'session_event_trace',
    'cwd 完全相同',
    '+08:00',
    'Unix 毫秒',
    'current/shadowed',
    '不能仅因后来被压缩替换而排除',
    '查不了旧聊天',
    '只读不改',
    '不随记忆迁移',
  ]) assert.ok(text.includes(phrase), phrase)
  assert.equal(parseSkillDocument('nope'), null)
})

test('常驻说明只给绝对目录和 skill 入口', () => {
  const root = '/tmp/dsh-fixture/chonkyfish/memory'
  assert.equal(memoryPrompt.render({}), '')
  assert.equal(memoryPrompt.render({ memoryEnabled: false, memoryRoot: root }), '')
  const text = memoryPrompt.render({ memoryEnabled: true, memoryRoot: root })
  assert.ok(text.includes(root))
  assert.ok(text.includes(`${root}/sessions/`))
  const relative = memoryPrompt.render({ memoryEnabled: true, memoryRoot: 'relative/memory' })
  const absolute = resolve('relative/memory')
  assert.ok(relative.includes(absolute))
  assert.equal(relative.includes('`relative/memory`'), false)
  for (const phrase of ['fish_skill', 'action 为 "read"', 'skillId 为 "memory"', 'section 为 "guide"', `limit 为 ${SKILL_LIMITS.maxReadGuideChars}`, 'nextOffset', '不是当前命令']) {
    assert.ok(text.includes(phrase), phrase)
  }
  const prompt = createModulePrompt({ readContext: () => ({ memoryRoot: root, memoryEnabled: true, profileDirectory: '/tmp/profile' }) }).read()
  assert.ok(prompt.indexOf('### 日记') < prompt.indexOf('### 记忆'))
  assert.ok(prompt.indexOf('### 记忆') < prompt.indexOf('### 技能'))
  assert.ok(prompt.includes(root))
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`ok ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
if (failed) {
  console.error(`memory core: ${tests.length - failed}/${tests.length} passed`)
  process.exitCode = 1
} else {
  console.log(`memory core: ${tests.length}/${tests.length} passed`)
}
