/**
 * 大肥鱼 · 日记模块测试（不连接 DSH，不花 token）。
 *
 *   node src/diary/tests/run-diary.mjs
 *
 * 覆盖：日期/正文/limit/action 校验、Local Provider 行为、单工具契约、
 * 每日 20:00 判断（时区/catchUp/去重/已写/无会话/agent busy）、旁白文案。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDiaryService } from '../core.js'
import { isValidDateText } from '../date.js'
import { DIARY_CODES, DiaryError } from '../errors.js'
import { handleDiaryRequest } from '../http.js'
import { createDiaryModule } from '../index.js'
import { diaryNarration, timeLabel } from '../narration.js'
import { createLocalDiaryProvider } from '../provider.js'
import { createDiaryScheduler, isDue, zonedParts } from '../schedule.js'
import { createDiaryState } from '../state.js'
import { createDiaryTool, DIARY_TOOL_NAME, renderDiaryResult } from '../tools.js'

const results = []
function test(name, fn) {
  try {
    const value = fn()
    if (value && typeof value.then === 'function') {
      return value.then(
        () => results.push({ name, ok: true }),
        (error) => results.push({ name, ok: false, error }),
      )
    }
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
  return Promise.resolve()
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'chonkyfish-diary-'))
  return {
    root,
    diary: join(root, '日记'),
    state: join(root, 'diary.json'),
    proactive: join(root, 'proactive.json'),
    config: join(root, 'config.json'),
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function makeService(root, maxChars = 50000) {
  const provider = createLocalDiaryProvider({ directory: join(root, '日记') })
  return {
    provider,
    service: createDiaryService({ provider, getMaxChars: () => maxChars }),
  }
}

async function expectCode(promise, code) {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof DiaryError, '应抛 DiaryError')
    assert.equal(error.code, code)
    return
  }
  assert.fail('应当抛错 ' + code)
}

/* --------------------------------------------------------------- 日期 */

await test('date: 严格 YYYY-MM-DD + 真实日历日期', () => {
  assert.equal(isValidDateText('2026-10-28'), true)
  assert.equal(isValidDateText('2026-02-29'), false) // 2026 不是闰年
  assert.equal(isValidDateText('2024-02-29'), true)
  assert.equal(isValidDateText('2026-02-30'), false)
  assert.equal(isValidDateText('2026-13-01'), false)
  assert.equal(isValidDateText('2026-00-10'), false)
  assert.equal(isValidDateText('2026-1-1'), false)
  assert.equal(isValidDateText('../../abc'), false)
  assert.equal(isValidDateText(''), false)
})

/* -------------------------------------------------------------- core */

await test('core: 非法日期 / 空正文 / 超长 / 非法 limit / 非法 action', async () => {
  const workspace = makeRoot()
  try {
    const { service } = makeService(workspace.root, 10)
    await expectCode(service.run({ action: 'write', date: '2026-02-30', content: 'x' }), DIARY_CODES.invalidDate)
    await expectCode(service.run({ action: 'write', date: '../../abc', content: 'x' }), DIARY_CODES.invalidDate)
    await expectCode(service.run({ action: 'write', date: '2026-10-28' }), DIARY_CODES.invalidContent)
    await expectCode(service.run({ action: 'write', date: '2026-10-28', content: '   ' }), DIARY_CODES.invalidContent)
    await expectCode(service.run({ action: 'write', date: '2026-10-28', content: '一二三四五六七八九十十一' }), DIARY_CODES.invalidContent)
    await expectCode(service.run({ action: 'write', date: '2026-10-28', content: 'x', overwrite: 'false' }), DIARY_CODES.invalidArgument)
    await expectCode(service.run({ action: 'list', limit: 0 }), DIARY_CODES.invalidLimit)
    await expectCode(service.run({ action: 'list', limit: 366 }), DIARY_CODES.invalidLimit)
    await expectCode(service.run({ action: 'list', limit: true }), DIARY_CODES.invalidLimit)
    await expectCode(service.run({ action: 'nope' }), DIARY_CODES.invalidArgument)
    await expectCode(service.run(null), DIARY_CODES.invalidArgument)
  } finally {
    workspace.cleanup()
  }
})

await test('core: read 不存在 → DIARY_NOT_FOUND；write/read/list 正常', async () => {
  const workspace = makeRoot()
  try {
    const { service } = makeService(workspace.root)
    await expectCode(service.run({ action: 'read', date: '2026-10-28' }), DIARY_CODES.notFound)

    const written = await service.run({ action: 'write', date: '2026-10-28', content: '今天摸鱼了' })
    assert.deepEqual(written, { ok: true, action: 'write', date: '2026-10-28', status: 'created' })

    const read = await service.run({ action: 'read', date: '2026-10-28' })
    assert.equal(read.ok, true)
    assert.equal(read.action, 'read')
    assert.ok(read.content.includes('今天摸鱼了'))

    const list = await service.run({ action: 'list' })
    assert.deepEqual(list, { ok: true, action: 'list', dates: ['2026-10-28'] })
  } finally {
    workspace.cleanup()
  }
})

/* ---------------------------------------------------------- provider */

await test('provider: 创建 / 重复拒绝 / 覆盖 / 读取不存在 / 列表过滤 / has', async () => {
  const workspace = makeRoot()
  try {
    const { provider } = makeService(workspace.root)

    assert.equal(await provider.has('2026-10-28'), false)
    assert.equal(await provider.write({ date: '2026-10-28', content: '第一版' }), 'created')
    assert.equal(await provider.has('2026-10-28'), true)

    const file = join(workspace.root, '日记', '2026-10-28.md')
    assert.ok(readFileSync(file, 'utf8').endsWith('\n'))
    assert.ok(readFileSync(file, 'utf8').includes('第一版'))

    await expectCode(provider.write({ date: '2026-10-28', content: '第二版' }), DIARY_CODES.alreadyExists)
    assert.ok(readFileSync(file, 'utf8').includes('第一版'))

    assert.equal(await provider.write({ date: '2026-10-28', content: '第二版' }, true), 'updated')
    assert.ok(readFileSync(file, 'utf8').includes('第二版'))
    assert.equal(await provider.write({ date: '2026-10-29', content: '新的' }, true), 'created')

    assert.equal(await provider.read('2026-10-30'), null)
    const read = await provider.read('2026-10-29')
    assert.equal(read.date, '2026-10-29')
    assert.ok(read.content.includes('新的'))

    // 统一换行 + 末尾一个换行
    await provider.write({ date: '2026-11-01', content: 'a\r\nb\r\n' })
    const normalized = readFileSync(join(workspace.root, '日记', '2026-11-01.md'), 'utf8')
    assert.equal(normalized, 'a\nb\n')

    // 列表：只收合法日期文件名、倒序、截断
    writeFileSync(join(workspace.root, '日记', 'not-a-date.md'), 'x', 'utf8')
    writeFileSync(join(workspace.root, '日记', '2026-13-01.md'), 'x', 'utf8')
    writeFileSync(join(workspace.root, '日记', '.diary-temp.tmp'), 'x', 'utf8')
    assert.deepEqual(await provider.list(30), ['2026-11-01', '2026-10-29', '2026-10-28'])
    assert.deepEqual(await provider.list(2), ['2026-11-01', '2026-10-29'])
  } finally {
    workspace.cleanup()
  }
})

await test('provider: 目录不可用 → DIARY_STORAGE_ERROR（不泄漏路径）', async () => {
  const workspace = makeRoot()
  try {
    const blocked = join(workspace.root, 'blocked')
    writeFileSync(blocked, 'not a directory', 'utf8')
    const provider = createLocalDiaryProvider({ directory: blocked })
    try {
      await provider.write({ date: '2026-10-28', content: 'x' })
      assert.fail('应当失败')
    } catch (error) {
      assert.ok(error instanceof DiaryError)
      assert.equal(error.code, DIARY_CODES.storageError)
      assert.equal(error.message.includes(workspace.root), false)
    }
  } finally {
    workspace.cleanup()
  }
})

/* ------------------------------------------------------------- tools */

await test('tool: 单工具 diary，action 枚举，成功/失败都可渲染', async () => {
  const workspace = makeRoot()
  try {
    const { service } = makeService(workspace.root)
    const tool = createDiaryTool(service)
    assert.equal(tool.name, DIARY_TOOL_NAME)
    assert.deepEqual(tool.parameters.properties.action.enum, ['write', 'read', 'list'])
    assert.equal(typeof tool.output.render, 'function')
    assert.ok(Array.isArray(tool.output.schema.oneOf))

    const write = await tool.execute({ action: 'write', date: '2026-10-28', content: '鱼鱼日记' })
    assert.equal(write.ok, true)
    assert.ok(renderDiaryResult(write).includes('2026-10-28'))

    const read = await tool.execute({ action: 'read', date: '2026-10-28' })
    assert.ok(renderDiaryResult(read).includes('鱼鱼日记'))

    const list = await tool.execute({ action: 'list' })
    assert.ok(renderDiaryResult(list).includes('2026-10-28'))

    const missing = await tool.execute({ action: 'read', date: '2026-10-30' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, DIARY_CODES.notFound)
    assert.ok(renderDiaryResult(missing).includes(DIARY_CODES.notFound))
  } finally {
    workspace.cleanup()
  }
})

/* ------------------------------------------------------------ 旁白 */

await test('narration: 口语时间 / 日期 / 写完不用汇报', () => {
  assert.equal(timeLabel(20), '晚上八点')
  assert.equal(timeLabel(8), '早上八点')
  assert.equal(timeLabel(23), '晚上十一点')
  assert.equal(timeLabel(0), '深夜十二点')
  const text = diaryNarration({ date: '2026-10-28', hour: 20 })
  assert.ok(text.includes('2026-10-28'))
  assert.ok(text.includes('不用跟我汇报'))
  assert.ok(text.includes('diary(action="read"'))
})

/* ----------------------------------------------------------- 定时器 */

await test('schedule: 时区拆分与到点判断（20:00 / catchUp）', () => {
  const at2000 = Date.UTC(2026, 9, 28, 12, 0, 0) // Asia/Shanghai 20:00
  assert.deepEqual(zonedParts(at2000, 'Asia/Shanghai'), { date: '2026-10-28', hour: 20, minute: 0 })
  assert.equal(isDue({ now: at2000, hour: 20, minute: 0, timeZone: 'Asia/Shanghai' }), true)
  assert.equal(isDue({ now: at2000 - 60_000, hour: 20, minute: 0, timeZone: 'Asia/Shanghai' }), false)
  assert.equal(isDue({ now: at2000 + 60_000, hour: 20, minute: 0, timeZone: 'Asia/Shanghai' }), true)
  assert.equal(
    isDue({ now: at2000 + 60_000, hour: 20, minute: 0, timeZone: 'Asia/Shanghai', catchUp: false }),
    false,
  )
  const nextDay = Date.UTC(2026, 9, 28, 16, 1, 0) // Asia/Shanghai 次日 00:01
  assert.equal(isDue({ now: nextDay, hour: 20, minute: 0, timeZone: 'Asia/Shanghai' }), false)
})

function makeSchedulerFixture({
  workspace,
  now,
  config,
  deliver = async () => ({ ok: true, sessionId: 's1' }),
  files = {},
}) {
  mkdirSync(workspace.root, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(workspace.root, name), content, 'utf8')
  }
  const provider = createLocalDiaryProvider({ directory: workspace.diary })
  const state = createDiaryState({ file: workspace.state })
  const resources = {
    getConfig: () => config,
    paths: { proactive: workspace.proactive, diary: workspace.diary },
  }
  const calls = []
  const deliverer = {
    async deliver(sessionId, text) {
      calls.push({ sessionId, text })
      return deliver(sessionId, text)
    },
  }
  const scheduler = createDiaryScheduler({ resources, provider, state, deliverer, now: () => now })
  return { scheduler, provider, state, calls, resources }
}

const BASE_CONFIG = (overrides = {}) => ({
  diary: {
    enabled: true,
    maxContentChars: 50000,
    schedule: { enabled: true, hour: 20, minute: 0, timezone: 'Asia/Shanghai', catchUp: true, ...overrides },
  },
})

const AT_2000 = Date.UTC(2026, 9, 28, 12, 0, 0)

await test('schedule: 到点投递 → 标记 → 同一天不重复', async () => {
  const workspace = makeRoot()
  try {
    const { scheduler, state, calls } = makeSchedulerFixture({
      workspace,
      now: AT_2000,
      config: BASE_CONFIG(),
      files: { 'proactive.json': JSON.stringify({ version: 2, activeSessionId: 'fish-session' }) },
    })
    const first = await scheduler.checkOnce()
    assert.equal(first.status, 'delivered')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].sessionId, 'fish-session')
    assert.ok(calls[0].text.includes('2026-10-28'))
    const saved = await state.read()
    assert.equal(saved.lastNudgeDate, '2026-10-28')
    assert.equal(saved.lastNudgeStatus, 'delivered')

    const second = await scheduler.checkOnce()
    assert.equal(second.reason, 'already-nudged')
    assert.equal(calls.length, 1)
  } finally {
    workspace.cleanup()
  }
})

await test('schedule: 未到点 / 当天已有日记 / 无面板会话 / 投递失败重试', async () => {
  const workspace = makeRoot()
  try {
    // 未到点
    {
      const ws = makeRoot()
      const fixture = makeSchedulerFixture({
        workspace: ws,
        now: AT_2000 - 60_000,
        config: BASE_CONFIG(),
        files: { 'proactive.json': JSON.stringify({ version: 2, activeSessionId: 'fish-session' }) },
      })
      const result = await fixture.scheduler.checkOnce()
      assert.equal(result.reason, 'not-due')
      ws.cleanup()
    }

    // 当天已有日记 → 标记 already-written，不投递
    {
      const ws = makeRoot()
      const fixture = makeSchedulerFixture({
        workspace: ws,
        now: AT_2000,
        config: BASE_CONFIG(),
        files: { 'proactive.json': JSON.stringify({ version: 2, activeSessionId: 'fish-session' }) },
      })
      mkdirSync(ws.diary, { recursive: true })
      writeFileSync(join(ws.diary, '2026-10-28.md'), 'already\n', 'utf8')
      const result = await fixture.scheduler.checkOnce()
      assert.equal(result.reason, 'diary-exists')
      assert.equal(fixture.calls.length, 0)
      assert.equal((await fixture.state.read()).lastNudgeStatus, 'already-written')
      ws.cleanup()
    }

    // 没有面板会话 → 跳过，不投递
    {
      const ws = makeRoot()
      const fixture = makeSchedulerFixture({ workspace: ws, now: AT_2000, config: BASE_CONFIG() })
      const result = await fixture.scheduler.checkOnce()
      assert.equal(result.reason, 'no-panel-session')
      assert.equal(fixture.calls.length, 0)
      ws.cleanup()
    }

    // agent busy → 不标记，下次成功
    {
      const ws = makeRoot()
      let deliver = async () => ({ ok: false, error: 'agent-busy' })
      const fixture = makeSchedulerFixture({
        workspace: ws,
        now: AT_2000,
        config: BASE_CONFIG(),
        files: { 'proactive.json': JSON.stringify({ version: 2, activeSessionId: 'fish-session' }) },
        deliver: (...args) => deliver(...args),
      })
      const failed = await fixture.scheduler.checkOnce()
      assert.equal(failed.status, 'deliver-failed')
      assert.equal((await fixture.state.read()).lastNudgeDate, null)
      deliver = async () => ({ ok: true, sessionId: 'fish-session' })
      const retried = await fixture.scheduler.checkOnce()
      assert.equal(retried.status, 'delivered')
      assert.equal(fixture.calls.length, 2)
      ws.cleanup()
    }
  } finally {
    workspace.cleanup()
  }
})

await test('schedule: enabled/disabled 与 catchUp=false', async () => {
  const workspace = makeRoot()
  try {
    const disabled = makeSchedulerFixture({
      workspace,
      now: AT_2000,
      config: { diary: { enabled: false, schedule: { enabled: true, hour: 20, minute: 0, timezone: 'Asia/Shanghai' } } },
      files: { 'proactive.json': JSON.stringify({ version: 2, activeSessionId: 's' }) },
    })
    assert.equal((await disabled.scheduler.checkOnce()).reason, 'disabled')

    const lateWs = makeRoot()
    const late = makeSchedulerFixture({
      workspace: lateWs,
      now: AT_2000 + 5 * 60_000,
      config: BASE_CONFIG({ catchUp: false }),
      files: { 'proactive.json': JSON.stringify({ version: 2, activeSessionId: 's' }) },
    })
    assert.equal((await late.scheduler.checkOnce()).reason, 'not-due')
    lateWs.cleanup()
  } finally {
    workspace.cleanup()
  }
})

/* --------------------------------------------------------- 面板路由 */

await test('http: 鉴权 / 列表 / 读取 / 404 / 参数校验', async () => {
  const workspace = makeRoot()
  try {
    const { service } = makeService(workspace.root)
    await service.run({ action: 'write', date: '2026-10-28', content: '面板里能读到' })
    const token = 'secret-token'

    const unauthorized = await handleDiaryRequest({
      service,
      headers: {},
      url: '/chonkyfish/diary',
      token,
    })
    assert.equal(unauthorized.status, 401)

    const listed = await handleDiaryRequest({
      service,
      headers: { 'x-chonkyfish-token': token },
      url: '/chonkyfish/diary?limit=60',
      token,
    })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body, { ok: true, action: 'list', dates: ['2026-10-28'] })

    const read = await handleDiaryRequest({
      service,
      headers: { 'x-chonkyfish-token': token },
      url: '/chonkyfish/diary?date=2026-10-28',
      token,
    })
    assert.equal(read.status, 200)
    assert.equal(read.body.ok, true)
    assert.ok(read.body.content.includes('面板里能读到'))

    const missing = await handleDiaryRequest({
      service,
      headers: { 'x-chonkyfish-token': token },
      url: '/chonkyfish/diary?date=2026-10-29',
      token,
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, DIARY_CODES.notFound)

    const badDate = await handleDiaryRequest({
      service,
      headers: { 'x-chonkyfish-token': token },
      url: '/chonkyfish/diary?date=2026-02-30',
      token,
    })
    assert.equal(badDate.status, 400)
    assert.equal(badDate.body.error.code, DIARY_CODES.invalidDate)

    const badLimit = await handleDiaryRequest({
      service,
      headers: { 'x-chonkyfish-token': token },
      url: '/chonkyfish/diary?limit=0',
      token,
    })
    assert.equal(badLimit.status, 400)
    assert.equal(badLimit.body.error.code, DIARY_CODES.invalidLimit)
  } finally {
    workspace.cleanup()
  }
})

/* ------------------------------------------------------------ 装配 */

await test('module: 装配出单工具与 start/stop，不依赖 DSH', () => {
  const workspace = makeRoot()
  try {
    const resources = {
      paths: {
        diary: workspace.diary,
        diaryState: workspace.state,
        proactive: workspace.proactive,
        workspace: join(workspace.root, '小鱼塘'),
      },
      getConfig: () => BASE_CONFIG(),
    }
    const diary = createDiaryModule({ ctx: {}, resources, logger: null, now: () => AT_2000 })
    assert.equal(diary.tool.name, DIARY_TOOL_NAME)
    diary.start()
    diary.stop()
  } finally {
    workspace.cleanup()
  }
})

/* ------------------------------------------------------------- report */

await new Promise((resolve) => setTimeout(resolve, 10))
const failures = results.filter((item) => !item.ok)
for (const failure of failures) {
  console.error('✗ ' + failure.name)
  if (failure.error) console.error(failure.error)
}
if (failures.length > 0) {
  console.error(`diary: ${results.length - failures.length}/${results.length} passed`)
  process.exitCode = 1
} else {
  console.log(`diary: ${results.length}/${results.length} passed`)
}
