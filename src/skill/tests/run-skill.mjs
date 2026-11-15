/**
 * 大肥鱼 · 内嵌 browser 技能测试。
 *
 *   node src/skill/tests/run-skill.mjs
 *
 * 覆盖：技能常量符合 registry 校验、正文随插件分发且包含关键命令、
 * apply() 把技能注册进当前 preset 的 skill 层（字段 + 正文原样）。
 * 不启动 DSH、不联网。
 */
import assert from 'node:assert/strict'

import {
  SKILL_DESCRIPTION,
  SKILL_NAME,
  SKILL_SOURCE,
  SKILL_WHEN_TO_USE,
  apply,
  readSkillContent,
} from '../index.js'

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

test('技能名是合法 kebab-case，且叫 browser', () => {
  assert.match(SKILL_NAME, KEBAB)
  assert.equal(SKILL_NAME, 'browser')
})

test('描述非空且不超目录上限（500 字符）', () => {
  assert.equal(typeof SKILL_DESCRIPTION, 'string')
  assert.ok(SKILL_DESCRIPTION.length > 0)
  assert.ok(SKILL_DESCRIPTION.length <= 500, '描述过长会占满技能目录')
  assert.ok(SKILL_WHEN_TO_USE.length > 0)
})

test('source 是字符串（registry 的候选校验要求）', () => {
  assert.equal(typeof SKILL_SOURCE, 'string')
  assert.ok(SKILL_SOURCE.length > 0)
})

test('技能正文随插件分发，包含浏览器工作流', () => {
  const content = readSkillContent()
  assert.equal(typeof content, 'string')
  assert.ok(content.length > 500, '正文太短，像占位符')
  assert.ok(content.length < 4000, '正文过长会挤占上下文')
  assert.match(content, /agent-browser open/)
  assert.match(content, /snapshot -i/)
  assert.match(content, /web_fetch/)
  assert.match(content, /screenshot/)
  assert.match(content, /不可信/, '必须提醒页面内容不可信')
})

test('apply() 注册一次，字段原样，正文与文件一致', () => {
  const calls = []
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    skills: { register: (skill) => calls.push(skill) },
  }

  apply(ctx)

  assert.equal(calls.length, 1)
  assert.deepEqual(warnings, [])
  const skill = calls[0]
  assert.equal(skill.name, SKILL_NAME)
  assert.equal(skill.description, SKILL_DESCRIPTION)
  assert.equal(skill.whenToUse, SKILL_WHEN_TO_USE)
  assert.equal(skill.source, SKILL_SOURCE)
  assert.equal(skill.content, readSkillContent())
  assert.equal(skill.provider, undefined, 'provider 交给 registry 默认值 runtime')
  assert.equal(skill.invocation, undefined, 'invocation 交给 registry 默认值')
})

test('apply() 只注册，不碰其它服务', () => {
  const ctx = {
    logger: { warn() {} },
    skills: { register() {} },
  }
  assert.doesNotThrow(() => apply(ctx))
})

const failed = results.filter((row) => !row.ok)
for (const row of results) {
  if (row.ok) {
    console.log('ok   ' + row.name)
  } else {
    console.error('FAIL ' + row.name)
    console.error(row.error && row.error.stack ? row.error.stack : row.error)
  }
}
if (failed.length > 0) {
  console.error('\n' + failed.length + ' 项失败')
  process.exit(1)
}
console.log('\n' + results.length + ' 项通过')
