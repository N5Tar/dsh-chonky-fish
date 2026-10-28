/**
 * 大肥鱼主动消息 · 核心逻辑测试（不连接 DSH，不花 token）。
 *
 *   node src/proactive/tests/run-proactive.mjs
 *
 * 覆盖：身份判定 / 旁白 / 会话状态落盘 / 投递 / 服务编排
 * （只投面板当前会话、显式会话覆盖、无会话时拒绝、无定时器）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDeliverer, createNudgeMessage } from '../delivery.js'
import { isFishHeader } from '../identity.js'
import { defaultNarration, NUDGE_SOURCE, timeBucket } from '../narration.js'
import { createProactiveService } from '../proactive.js'
import { createProactiveStore, dateKey } from '../store.js'

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

const POND = '/tmp/pond'

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'chonkyfish-proactive-'))
  const home = join(root, 'home')
  mkdirSync(join(home, 'chonkyfish'), { recursive: true })
  mkdirSync(join(home, '小鱼塘'), { recursive: true })
  return {
    home,
    storePath: join(home, 'chonkyfish', 'proactive.json'),
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function fishHeader(overrides = {}) {
  return {
    id: 's1',
    cwd: overrides.cwd ?? POND,
    agentPreset: 'chonkyfish',
    createdAt: 1_700_000_000_000,
    delegationDepth: 0,
    ...overrides,
  }
}

function makeAgent(sessionId, { status = 'idle', header = fishHeader({ id: sessionId }) } = {}) {
  const calls = []
  const session = { id: sessionId, header }
  const agent = {
    session,
    status,
    followup(message) {
      calls.push(message)
    },
  }
  return { agent, calls, session }
}

/** 假 Host ctx：sessionController 按 id 返回对应 agent；sessions.flush 可配置成败。 */
function makeCtx({ agents = {}, resolveError = null, flushResult = true } = {}) {
  const resolved = []
  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) {
      if (name === 'sessionController') {
        return {
          async resolveAgent(sessionId) {
            resolved.push(sessionId)
            if (resolveError) return { error: resolveError }
            const agent = agents[sessionId]
            if (!agent) return { error: { code: 'session-not-found' } }
            return { agent }
          },
        }
      }
      if (name === 'sessions') {
        return { async flush() { return flushResult } }
      }
      return undefined
    },
  }
  return { ctx, resolved }
}

/**
 * 资源管理模块的测试替身：服务只消费 paths.proactive / paths.workspace / spec / getConfig。
 */
function makeResources({ storePath = POND + '/proactive.json', config = { proactive: { enabled: true } }, workspace = POND } = {}) {
  return {
    home: POND,
    paths: { proactive: storePath, workspace },
    spec: { PRESET: 'chonkyfish' },
    getConfig: () => config,
  }
}

/* ------------------------------------------------------------ identity */

await test('identity: 小鱼塘里的 chonkyfish 会话是鱼鱼会话', () => {
  assert.equal(isFishHeader(fishHeader({ cwd: '/tmp/home/小鱼塘' }), { workspaceRoot: '/tmp/home/小鱼塘' }), true)
  assert.equal(
    isFishHeader(fishHeader({ cwd: '/tmp/home/小鱼塘/sub' }), { workspaceRoot: '/tmp/home/小鱼塘' }),
    true,
    '小鱼塘子目录也算',
  )
})

await test('identity: preset 不对 / 是 subagent / 是隔壁目录 都不是鱼鱼会话', () => {
  const options = { workspaceRoot: '/tmp/home/小鱼塘' }
  assert.equal(isFishHeader(fishHeader({ agentPreset: 'default' }), options), false)
  assert.equal(isFishHeader(fishHeader({ origin: 'subagent' }), options), false)
  assert.equal(isFishHeader(fishHeader({ delegationDepth: 1 }), options), false)
  assert.equal(isFishHeader(fishHeader({ cwd: '/tmp/home/小鱼塘2' }), options), false)
  assert.equal(isFishHeader(null, options), false)
})

/* ----------------------------------------------------------- narration */

await test('narration: 默认旁白有「不是主人的话」与不要提系统/时间的约束', () => {
  const now = new Date(2026, 9, 28, 15, 0).getTime()
  assert.equal(timeBucket(now), '下午')
  const text = defaultNarration({ now })
  assert.ok(text.includes('鱼塘旁白'))
  assert.ok(text.includes('不是主人的话'))
  assert.ok(text.includes('不要提时间'))
  assert.ok(text.includes('鱼鱼口吻'))
  assert.ok(text.includes('不要假装主人刚刚说了什么'))
})

await test('narration: 旁白消息是 user 角色但 source 不是 user', () => {
  const message = createNudgeMessage('测试旁白')
  assert.equal(message.role, 'user')
  assert.equal(message.id.length > 20, true)
  assert.deepEqual(message.content, [{ type: 'text', text: '测试旁白' }])
  assert.equal(message.source.kind, NUDGE_SOURCE.kind)
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.summary, '大肥鱼主动来找你了')
})

/* --------------------------------------------------------------- store */

await test('store: 面板会话 id 落盘，重启后还能读到', () => {
  const workspace = makeHome()
  try {
    const store = createProactiveStore({ file: workspace.storePath })
    assert.equal(store.setActiveSession('session-abc'), true)
    assert.equal(store.activeSessionId(), 'session-abc')
    const reopened = createProactiveStore({ file: workspace.storePath })
    assert.equal(reopened.activeSessionId(), 'session-abc')
    const raw = JSON.parse(readFileSync(workspace.storePath, 'utf8'))
    assert.equal(raw.version, 2)
    assert.equal(raw.activeSessionId, 'session-abc')
  } finally {
    workspace.cleanup()
  }
})

await test('store: 非法会话 id 不会覆盖已有值', () => {
  const workspace = makeHome()
  try {
    const store = createProactiveStore({ file: workspace.storePath })
    store.setActiveSession('session-abc')
    assert.equal(store.setActiveSession(''), false)
    assert.equal(store.setActiveSession(null), false)
    assert.equal(store.setActiveSession('   '), false)
    assert.equal(store.activeSessionId(), 'session-abc')
  } finally {
    workspace.cleanup()
  }
})

await test('store: 发送计数/最近记录按本地日期累加', () => {
  const workspace = makeHome()
  try {
    const now = new Date(2026, 9, 28, 15, 0).getTime()
    const store = createProactiveStore({ file: workspace.storePath, now: () => now })
    store.noteSend({ at: now, kind: 'manual', sessionId: 's1', messageId: 'm1' })
    store.noteSend({ at: now + 1000, kind: 'manual', sessionId: 's1', messageId: 'm2' })
    assert.equal(store.countFor(now), 2)
    assert.equal(store.lastSentAt(), now + 1000)
    const snapshot = store.snapshot()
    assert.equal(snapshot.recent.length, 2)
    assert.equal(snapshot.recent[1].kind, 'manual')
    assert.equal(snapshot.counts[dateKey(now)], 2)
  } finally {
    workspace.cleanup()
  }
})

await test('store: 坏文件/旧版本回落到空状态，不抛错', () => {
  const workspace = makeHome()
  try {
    writeFileSync(workspace.storePath, '{"version":1,"lastSessionId":"old"}', 'utf8')
    const store = createProactiveStore({ file: workspace.storePath })
    assert.equal(store.activeSessionId(), null)
    assert.equal(store.lastSentAt(), null)
    assert.equal(store.snapshot().version, 2)
  } finally {
    workspace.cleanup()
  }
})

/* ------------------------------------------------------------ delivery */

await test('delivery: 投递 = followup + flush，消息带来源', async () => {
  const sessionId = 's1'
  const { agent, calls } = makeAgent(sessionId)
  const { ctx, resolved } = makeCtx({ agents: { [sessionId]: agent } })
  const deliverer = createDeliverer({ ctx, workspaceRoot: POND })
  const result = await deliverer.deliver(sessionId, '主动说点什么')
  assert.equal(result.ok, true)
  assert.deepEqual(resolved, [sessionId])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].source.kind, NUDGE_SOURCE.kind)
  assert.equal(result.messageId, calls[0].id)
})

await test('delivery: 会话正在跑 / 身份不符 / 解析失败 / flush 未确认 都不算成功', async () => {
  const sessionId = 's1'
  const busyAgent = makeAgent(sessionId, { status: 'running' })
  const busyCtx = makeCtx({ agents: { [sessionId]: busyAgent.agent } })
  const busyDeliverer = createDeliverer({ ctx: busyCtx.ctx, workspaceRoot: POND })
  assert.equal((await busyDeliverer.deliver(sessionId, 'x')).error, 'agent-busy')
  assert.equal(busyAgent.calls.length, 0)

  const wrongAgent = makeAgent(sessionId, { header: fishHeader({ id: sessionId, agentPreset: 'default' }) })
  const wrongCtx = makeCtx({ agents: { [sessionId]: wrongAgent.agent } })
  const wrongDeliverer = createDeliverer({ ctx: wrongCtx.ctx, workspaceRoot: POND })
  assert.equal((await wrongDeliverer.deliver(sessionId, 'x')).error, 'identity-mismatch')
  assert.equal(wrongAgent.calls.length, 0)

  const errorCtx = makeCtx({ resolveError: { code: 'session-not-found' } })
  const errorDeliverer = createDeliverer({ ctx: errorCtx.ctx, workspaceRoot: POND })
  assert.equal((await errorDeliverer.deliver(sessionId, 'x')).ok, false)

  const flushAgent = makeAgent(sessionId)
  const flushCtx = makeCtx({ agents: { [sessionId]: flushAgent.agent }, flushResult: false })
  const flushDeliverer = createDeliverer({ ctx: flushCtx.ctx, workspaceRoot: POND })
  const flushed = await flushDeliverer.deliver(sessionId, 'x')
  assert.equal(flushed.ok, false)
  assert.equal(flushed.error, 'persistence-unacknowledged')
})

await test('delivery: 空会话 id / 空文本直接拒绝，不碰 DSH API', async () => {
  const { ctx, resolved } = makeCtx({})
  const deliverer = createDeliverer({ ctx, workspaceRoot: POND })
  assert.equal((await deliverer.deliver('', 'x')).error, 'missing-session-id')
  assert.equal((await deliverer.deliver('s1', '   ')).error, 'empty-text')
  assert.deepEqual(resolved, [])
})

/* ------------------------------------------------------------ service */

await test('service: 没有面板会话时拒绝发送，绝不猜一条会话', async () => {
  const workspace = makeHome()
  try {
    const { ctx, resolved } = makeCtx({})
    const service = createProactiveService({ ctx, resources: makeResources({ storePath: workspace.storePath }) })
    const result = await service.send({})
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-panel-session')
    assert.deepEqual(resolved, [])
    assert.equal(service.inspect().automatic, false)
    service.dispose()
  } finally {
    workspace.cleanup()
  }
})

await test('service: 配置里关掉主动消息时拒绝发送', async () => {
  const workspace = makeHome()
  try {
    const panel = makeAgent('session-panel')
    const { ctx, resolved } = makeCtx({ agents: { 'session-panel': panel.agent } })
    const service = createProactiveService({
      ctx,
      resources: makeResources({
        storePath: workspace.storePath,
        config: { proactive: { enabled: false } },
      }),
    })
    service.registerActiveSession('session-panel')
    const result = await service.send({})
    assert.equal(result.ok, false)
    assert.equal(result.error, 'proactive-disabled')
    assert.deepEqual(resolved, [])
    assert.equal(panel.calls.length, 0)
    service.dispose()
  } finally {
    workspace.cleanup()
  }
})

await test('service: 只投面板当前会话，成功后才计数', async () => {
  const workspace = makeHome()
  try {
    const now = new Date(2026, 9, 28, 15, 0).getTime()
    const panelSession = 'session-panel'
    const otherSession = 'session-other'
    const panel = makeAgent(panelSession)
    const other = makeAgent(otherSession)
    const { ctx, resolved } = makeCtx({ agents: { [panelSession]: panel.agent, [otherSession]: other.agent } })
    const service = createProactiveService({ ctx, resources: makeResources({ storePath: workspace.storePath }), now: () => now })
    service.registerActiveSession(panelSession)
    const result = await service.send({})
    assert.equal(result.ok, true)
    assert.deepEqual(resolved, [panelSession], '只投面板会话')
    assert.equal(panel.calls.length, 1)
    assert.equal(other.calls.length, 0)
    assert.ok(panel.calls[0].content[0].text.includes('鱼塘旁白'))
    assert.equal(service.inspect().store.recent.length, 1)
    assert.equal(service.inspect().store.recent[0].kind, 'manual')
    assert.equal(service.inspect().activeSessionId, panelSession)
    service.dispose()
  } finally {
    workspace.cleanup()
  }
})

await test('service: 显式 sessionId 可以覆盖面板会话', async () => {
  const workspace = makeHome()
  try {
    const panel = makeAgent('session-panel')
    const explicit = makeAgent('session-explicit')
    const { ctx, resolved } = makeCtx({ agents: { 'session-panel': panel.agent, 'session-explicit': explicit.agent } })
    const service = createProactiveService({ ctx, resources: makeResources({ storePath: workspace.storePath }) })
    service.registerActiveSession('session-panel')
    const result = await service.send({ sessionId: 'session-explicit', narration: '自定义旁白' })
    assert.equal(result.ok, true)
    assert.deepEqual(resolved, ['session-explicit'])
    assert.equal(explicit.calls.length, 1)
    assert.equal(explicit.calls[0].content[0].text, '自定义旁白')
    assert.equal(panel.calls.length, 0)
    service.dispose()
  } finally {
    workspace.cleanup()
  }
})

await test('service: 面板会话解析不到 / 不是鱼鱼会话 时失败且不计数', async () => {
  const workspace = makeHome()
  try {
    const { ctx } = makeCtx({})
    const service = createProactiveService({ ctx, resources: makeResources({ storePath: workspace.storePath }) })
    service.registerActiveSession('missing-session')
    const result = await service.send({})
    assert.equal(result.ok, false)
    assert.equal(result.error.startsWith('resolve-refused'), true)
    assert.equal(service.inspect().store.recent.length, 0)
    service.dispose()

    const wrong = makeAgent('not-fish', { header: fishHeader({ id: 'not-fish', agentPreset: 'default' }) })
    const { ctx: wrongCtx } = makeCtx({ agents: { 'not-fish': wrong.agent } })
    const wrongService = createProactiveService({ ctx: wrongCtx, resources: makeResources({ storePath: workspace.storePath }) })
    wrongService.registerActiveSession('not-fish')
    assert.equal((await wrongService.send({})).error, 'identity-mismatch')
    assert.equal(wrong.calls.length, 0)
    wrongService.dispose()
  } finally {
    workspace.cleanup()
  }
})

await test('service: 面板会话 id 跨服务实例保留（Host 重启后仍能投）', async () => {
  const workspace = makeHome()
  try {
    const panel = makeAgent('session-panel')
    const { ctx } = makeCtx({ agents: { 'session-panel': panel.agent } })
    const first = createProactiveService({ ctx, resources: makeResources({ storePath: workspace.storePath }) })
    first.registerActiveSession('session-panel')
    first.dispose()

    const second = createProactiveService({ ctx, resources: makeResources({ storePath: workspace.storePath }) })
    assert.equal(second.inspect().activeSessionId, 'session-panel')
    assert.equal((await second.send({ narration: 'hi' })).ok, true)
    assert.equal(panel.calls.length, 1)
    second.dispose()
  } finally {
    workspace.cleanup()
  }
})

await test('service: 只保留能力，不再暴露任何定时器入口', () => {
  const workspace = makeHome()
  try {
    const { ctx } = makeCtx({})
    const service = createProactiveService({ ctx, resources: makeResources({ storePath: workspace.storePath }) })
    assert.equal(typeof service.start, 'undefined')
    assert.equal(typeof service.tick, 'undefined')
    assert.equal(typeof service.forceNudge, 'undefined')
    assert.equal(typeof service.send, 'function')
    assert.equal(typeof service.registerActiveSession, 'function')
    service.dispose()
  } finally {
    workspace.cleanup()
  }
})

/* -------------------------------------------------------------- report */

await new Promise((resolve) => setTimeout(resolve, 10))
const failures = results.filter((item) => !item.ok)
for (const failure of failures) {
  console.error('✗ ' + failure.name)
  if (failure.error) console.error(failure.error)
}
if (failures.length > 0) {
  console.error(`proactive: ${results.length - failures.length}/${results.length} passed`)
  process.exitCode = 1
} else {
  console.log(`proactive: ${results.length}/${results.length} passed`)
}
