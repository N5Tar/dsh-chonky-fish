/**
 * ChonkyFish（大肥鱼）· 资源管理模块测试。
 *
 *   node src/resources/tests/run-resources.mjs
 *
 * 覆盖：dshHome 解析优先级 / home 布局（无任何旧目录迁移）/ 默认 config /
 * 配置消毒与 clamp / updateConfig 深合并与原子写 / clientState / spec 冻结。
 *
 * 全部用 mkdtempSync 建临时 DSH home，测完清理，不碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createResources } from '../index.js'
import {
  ASSETS,
  DEFAULT_CONFIG,
  FILES,
  HOME_DIR,
  LIMITS,
  PRESET,
  ROUTES,
  STORAGE_KEYS,
  VERSIONS,
  WORKSPACE_DIR,
} from '../spec.js'

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

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'chonkyfish-resources-'))
  return {
    dshHome: root,
    home: join(root, HOME_DIR),
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/* ------------------------------------------------------------------ */
/* spec                                                               */
/* ------------------------------------------------------------------ */

await test('spec: 资源规格冻结且字段齐全', () => {
  for (const value of [FILES, ROUTES, LIMITS, VERSIONS, STORAGE_KEYS, ASSETS, DEFAULT_CONFIG]) {
    assert.ok(Object.isFrozen(value))
  }
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.proactive))
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.eventEngine))
  assert.ok(Object.isFrozen(ASSETS.poses))
  assert.equal(PRESET, 'chonkyfish')
  assert.equal(HOME_DIR, 'chonkyfish')
  assert.equal(WORKSPACE_DIR, '小鱼塘')
})

await test('spec: localStorage key 只有当前版本（不含 legacy）', () => {
  assert.deepEqual(Object.keys(STORAGE_KEYS).sort(), ['panelState', 'session', 'workspace'])
  assert.equal('legacySession' in STORAGE_KEYS, false)
  assert.equal('legacyPanelStates' in STORAGE_KEYS, false)
})

/* ------------------------------------------------------------------ */
/* dshHome / paths                                                     */
/* ------------------------------------------------------------------ */

await test('dshHome: homeRoot 优先，其次 env.DSH_HOME，最后 ~/.dsh', () => {
  assert.equal(createResources({ homeRoot: '/tmp/a', env: { DSH_HOME: '/tmp/b' } }).dshHome, '/tmp/a')
  assert.equal(createResources({ env: { DSH_HOME: '/tmp/b' } }).dshHome, '/tmp/b')
  assert.equal(createResources({ env: {} }).dshHome, join(homedir(), '.dsh'))
})

await test('paths: 所有文件都在 home 下，工作区在 home/小鱼塘', () => {
  const resources = createResources({ homeRoot: '/tmp/dsh' })
  const home = join('/tmp/dsh', HOME_DIR)
  assert.equal(resources.home, home)
  assert.deepEqual(resources.paths, {
    home,
    config: join(home, FILES.config),
    state: join(home, FILES.state),
    proactive: join(home, FILES.proactive),
    events: join(home, FILES.events),
    diary: join(home, '日记'),
    workspace: join(home, WORKSPACE_DIR),
  })
  // 没有任何 legacy 路径字段
  assert.equal('legacyWorkspace' in resources.paths, false)
})

/* ------------------------------------------------------------------ */
/* layout                                                              */
/* ------------------------------------------------------------------ */

await test('layout: 建 home/工作区目录和默认 config.json，不碰旧路径', async () => {
  const workspace = makeHome()
  try {
    const resources = createResources({ homeRoot: workspace.dshHome })
    const layout = await resources.ensureLayout()
    assert.equal(layout.home, workspace.home)
    assert.equal(layout.workspace, join(workspace.home, WORKSPACE_DIR))
    assert.equal(existsSync(workspace.home), true)
    assert.equal(existsSync(join(workspace.home, WORKSPACE_DIR)), true)
    assert.equal(existsSync(resources.paths.diary), true)
    assert.equal(existsSync(resources.paths.config), true)
    // 规划里不包含旧 $DSH_HOME/小鱼塘：不会被创建/迁移
    assert.equal(existsSync(join(workspace.dshHome, WORKSPACE_DIR)), false)
    const config = JSON.parse(readFileSync(resources.paths.config, 'utf8'))
    assert.equal(config.version, VERSIONS.config)
    assert.equal(config.proactive.enabled, DEFAULT_CONFIG.proactive.enabled)
    assert.equal(config.eventEngine.extractTickMs, DEFAULT_CONFIG.eventEngine.extractTickMs)
  } finally {
    workspace.cleanup()
  }
})

await test('layout: 可重复执行（幂等），且不覆盖已存在的 config.json', async () => {
  const workspace = makeHome()
  try {
    const resources = createResources({ homeRoot: workspace.dshHome })
    await resources.ensureLayout()
    writeFileSync(resources.paths.config, JSON.stringify({ proactive: { enabled: false } }), 'utf8')
    await resources.ensureLayout()
    const config = resources.getConfig()
    assert.equal(config.proactive.enabled, false)
    // home 下只有预期文件，没有旧路径产物
    const names = readdirSync(workspace.home).sort()
    assert.ok(names.includes(FILES.config))
    assert.ok(names.includes(WORKSPACE_DIR))
  } finally {
    workspace.cleanup()
  }
})

await test('layout: 旧 $DSH_HOME/小鱼塘 不会被迁移或删除', async () => {
  const workspace = makeHome()
  try {
    mkdirSync(join(workspace.dshHome, WORKSPACE_DIR), { recursive: true })
    writeFileSync(join(workspace.dshHome, WORKSPACE_DIR, 'old.txt'), 'old', 'utf8')
    const resources = createResources({ homeRoot: workspace.dshHome })
    await resources.ensureLayout()
    // 旧目录原样保留、新工作区是独立空目录，迁移逻辑已移除
    assert.equal(existsSync(join(workspace.dshHome, WORKSPACE_DIR, 'old.txt')), true)
    assert.deepEqual(readdirSync(join(workspace.home, WORKSPACE_DIR)), [])
  } finally {
    workspace.cleanup()
  }
})

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

await test('config: 文件缺失/坏 JSON 时回退默认值', () => {
  const workspace = makeHome()
  try {
    const resources = createResources({ homeRoot: workspace.dshHome })
    assert.deepEqual(resources.getConfig(), JSON.parse(JSON.stringify({
      version: VERSIONS.config,
      proactive: { enabled: true },
      eventEngine: { enabled: true, extractTickMs: 5000, extractBatch: 2, maxRecordsPerTurn: 400 },
      diary: {
        enabled: true,
        enabledPresets: [PRESET],
        maxContentChars: 50000,
      },
    })))
    mkdirSync(workspace.home, { recursive: true })
    writeFileSync(resources.paths.config, '{not-json', 'utf8')
    assert.equal(resources.getConfig().proactive.enabled, true)
  } finally {
    workspace.cleanup()
  }
})

await test('config: 越界/非法字段被 clamp 或回退', () => {
  const workspace = makeHome()
  try {
    mkdirSync(workspace.home, { recursive: true })
    writeFileSync(
      createResources({ homeRoot: workspace.dshHome }).paths.config,
      JSON.stringify({
        proactive: { enabled: 'yes' },
        eventEngine: { enabled: false, extractTickMs: 999999, extractBatch: 0, maxRecordsPerTurn: '300' },
        unknown: true,
      }),
      'utf8',
    )
    const config = createResources({ homeRoot: workspace.dshHome }).getConfig()
    assert.equal(config.proactive.enabled, true)
    assert.equal(config.eventEngine.enabled, false)
    assert.equal(config.eventEngine.extractTickMs, 60000)
    assert.equal(config.eventEngine.extractBatch, 1)
    assert.equal(config.eventEngine.maxRecordsPerTurn, 300)
    assert.equal('unknown' in config, false)
  } finally {
    workspace.cleanup()
  }
})

await test('config: diary 字段消毒 / clamp', () => {
  const workspace = makeHome()
  try {
    mkdirSync(workspace.home, { recursive: true })
    writeFileSync(
      createResources({ homeRoot: workspace.dshHome }).paths.config,
      JSON.stringify({
        diary: {
          enabled: 'yes',
          enabledPresets: ['chonkyfish', '  ', 42, 'chonkyfish', 'other'],
          maxContentChars: 999999,
          schedule: { hour: 20 },
        },
      }),
      'utf8',
    )
    const config = createResources({ homeRoot: workspace.dshHome }).getConfig()
    assert.equal(config.diary.enabled, true)
    assert.deepEqual(config.diary.enabledPresets, ['chonkyfish', 'other'])
    assert.equal(config.diary.maxContentChars, 200000)
    assert.equal('schedule' in config.diary, false)
  } finally {
    workspace.cleanup()
  }
})

await test('config: updateConfig 深合并并原子落盘，重新读取可见', async () => {
  const workspace = makeHome()
  try {
    const resources = createResources({ homeRoot: workspace.dshHome })
    await resources.ensureLayout()
    const next = await resources.updateConfig({ proactive: { enabled: false }, eventEngine: { extractBatch: 3 }, diary: { maxContentChars: 60000 } })
    assert.equal(next.proactive.enabled, false)
    assert.equal(next.eventEngine.extractBatch, 3)
    assert.equal(next.diary.maxContentChars, 60000)
    const reopened = createResources({ homeRoot: workspace.dshHome })
    assert.equal(reopened.getConfig().proactive.enabled, false)
    assert.equal(reopened.getConfig().eventEngine.extractBatch, 3)
    assert.equal(reopened.getConfig().diary.maxContentChars, 60000)
    // 落盘仍是合法 JSON（2 空格缩进 + 换行）
    const raw = readFileSync(resources.paths.config, 'utf8')
    assert.ok(raw.endsWith('\n'))
    assert.doesNotThrow(() => JSON.parse(raw))
  } finally {
    workspace.cleanup()
  }
})

await test('config: 非法 patch 不抛错，按消毒规则回退', async () => {
  const workspace = makeHome()
  try {
    const resources = createResources({ homeRoot: workspace.dshHome })
    const next = await resources.updateConfig({ proactive: { enabled: 'nope' }, eventEngine: { extractTickMs: 'abc' } })
    assert.equal(next.proactive.enabled, true)
    assert.equal(next.eventEngine.extractTickMs, 5000)
  } finally {
    workspace.cleanup()
  }
})

/* ------------------------------------------------------------------ */
/* clientState                                                         */
/* ------------------------------------------------------------------ */

await test('clientState: 路径/路由/预设齐全且不含 token、不含 legacy', () => {
  const resources = createResources({ homeRoot: '/tmp/dsh' })
  const state = resources.clientState()
  assert.equal(state.home, resources.home)
  assert.equal(state.dshHome, '/tmp/dsh')
  assert.equal(state.preset, PRESET)
  assert.deepEqual(state.routes, ROUTES)
  assert.deepEqual(state.paths, {
    workspace: resources.paths.workspace,
    workspaceParent: resources.home,
    workspaceName: WORKSPACE_DIR,
  })
  assert.equal('token' in state, false)
  assert.equal('legacyWorkspace' in state.paths, false)
})

/* -------------------------------------------------------------- report */

await new Promise((resolve) => setTimeout(resolve, 10))
const failures = results.filter((item) => !item.ok)
for (const failure of failures) {
  console.error('✗ ' + failure.name)
  if (failure.error) console.error(failure.error)
}
if (failures.length > 0) {
  console.error(`resources: ${results.length - failures.length}/${results.length} passed`)
  process.exitCode = 1
} else {
  console.log(`resources: ${results.length}/${results.length} passed`)
}
