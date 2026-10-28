/**
 * 大肥鱼 · system prompt 补充人格变量测试。
 *
 *   node src/persona/tests/run-supplement.mjs
 *
 * 覆盖：文件缺失 / 坏 JSON / 默认文案 / 自定义文案 / 按 mtime 缓存与更新。
 * 全部使用 mkdtempSync 临时目录，不碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PANEL_PROMPT, PANEL_SUPPLEMENT_VARIABLE } from '../../resources/spec.js'
import { createPanelSupplement } from '../supplement.js'

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

function makeStateDir() {
  const root = mkdtempSync(join(tmpdir(), 'chonkyfish-persona-'))
  const home = join(root, 'chonkyfish')
  mkdirSync(home, { recursive: true })
  return {
    root,
    statePath: join(home, 'state.json'),
    write(payload) {
      writeFileSync(this.statePath, JSON.stringify(payload), 'utf8')
    },
    writeRaw(text) {
      writeFileSync(this.statePath, text, 'utf8')
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('常量：变量名与预设模板一致', () => {
  assert.equal(PANEL_SUPPLEMENT_VARIABLE, 'chonkyfish_supplement')
})

test('文件缺失 → 空字符串', () => {
  const workspace = makeStateDir()
  try {
    const supplement = createPanelSupplement({ statePath: workspace.statePath })
    assert.equal(supplement.provider(), '')
    assert.equal(supplement.variableName, PANEL_SUPPLEMENT_VARIABLE)
  } finally {
    workspace.cleanup()
  }
})

test('默认文案 / 空文案 → 空字符串', () => {
  const workspace = makeStateDir()
  try {
    const supplement = createPanelSupplement({ statePath: workspace.statePath })
    workspace.write({ state: { prompt: DEFAULT_PANEL_PROMPT } })
    assert.equal(supplement.provider(), '')
    workspace.write({ state: { prompt: '   ' } })
    assert.equal(supplement.provider(), '')
    workspace.write({ state: {} })
    assert.equal(supplement.provider(), '')
  } finally {
    workspace.cleanup()
  }
})

test('自定义文案 → 带标题的 system prompt 片段', () => {
  const workspace = makeStateDir()
  try {
    const supplement = createPanelSupplement({ statePath: workspace.statePath })
    workspace.write({ state: { prompt: ' 你是溟月，要叫主人。 ' } })
    const text = supplement.provider()
    assert.ok(text.startsWith('\n\n补充人格设定'))
    assert.ok(text.includes('你是溟月，要叫主人。'))
    assert.equal(text.includes(' 你是溟月'), false, '值应 trim')
  } finally {
    workspace.cleanup()
  }
})

test('坏 JSON → 空字符串且不抛错', () => {
  const workspace = makeStateDir()
  try {
    const supplement = createPanelSupplement({ statePath: workspace.statePath })
    workspace.writeRaw('{not json')
    assert.equal(supplement.provider(), '')
  } finally {
    workspace.cleanup()
  }
})

test('mtime 缓存：内容不变不重复解析，变更后能读出新值', () => {
  const workspace = makeStateDir()
  try {
    const supplement = createPanelSupplement({ statePath: workspace.statePath })
    workspace.write({ state: { prompt: '旧设定' } })
    assert.ok(supplement.provider().includes('旧设定'))

    // 同一 mtime：仍用缓存
    const before = supplement.provider()
    workspace.writeRaw(JSON.stringify({ state: { prompt: '新设定' } }))
    utimesSync(workspace.statePath, new Date(), new Date(Date.now() + 2000))
    assert.equal(before.includes('旧设定'), true)
    assert.ok(supplement.provider().includes('新设定'))
  } finally {
    workspace.cleanup()
  }
})

await new Promise((resolve) => setTimeout(resolve, 10))
const failures = results.filter((item) => !item.ok)
for (const failure of failures) {
  console.error('✗ ' + failure.name)
  if (failure.error) console.error(failure.error)
}
if (failures.length > 0) {
  console.error(`persona-supplement: ${results.length - failures.length}/${results.length} passed`)
  process.exitCode = 1
} else {
  console.log(`persona-supplement: ${results.length}/${results.length} passed`)
}
