import assert from 'node:assert/strict'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createResources } from '../../resources/index.js'
import { installSkills } from '../index.js'
import { createSkillTools } from '../tools.js'

const temporaryRoot = await realpath(tmpdir())
const root = await mkdtemp(join(temporaryRoot, 'chonkyfish-skills-host-'))
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`) }
function mockContext(failSecond = false) {
  const registered = new Map()
  const guards = new Set()
  return {
    registered, guards,
    tools: {
      register(tool, options) {
        if (failSecond && registered.size === 1) throw new Error('registration failed')
        registered.set(tool.name, { tool, options })
        return () => registered.delete(tool.name)
      },
      guard(fn) { guards.add(fn); return () => guards.delete(fn) },
    },
  }
}
try {
  const resources = createResources({ homeRoot: root })
  await resources.ensureLayout()
  const ctx = mockContext()
  const module = installSkills(ctx, { resources })
  const agent = { session: { header: { agentPreset: 'chonkyfish', cwd: resources.paths.workspace } } }
  const read = ctx.registered.get('fish_skill')
  const learn = ctx.registered.get('fish_skill_learn')

  await test('tools discover homepage without new persona or approval state', async () => {
    assert.equal(ctx.registered.size, 2)
    assert.match(read.tool.description, /homepage-operations/)
    assert.equal(read.options.when({ agent }), true)
    const result = await read.tool.execute({ action: 'list' }, { agent })
    assert.equal(result.ok, true)
    assert.equal(result.data.items[0].skillId, 'homepage-operations')
    assert.equal('authorization' in result.data.items[0], false)
    assert.doesNotThrow(() => JSON.parse(read.tool.output.render({}, result)[0].text))
  })
  await test('all presets/workspaces/social/subagents and direct callers can use skills', async () => {
    const bad = [undefined,
      { session: { header: { agentPreset: 'chonkyfish-social', cwd: resources.paths.workspace } } },
      { session: { header: { agentPreset: 'chonkyfish', cwd: root } } },
      { session: { header: { ...agent.session.header, origin: 'subagent' } } },
      { session: { header: { ...agent.session.header, delegationDepth: 1 } } },
    ]
    for (const other of bad) {
      assert.equal(read.options.when({ agent: other }), true)
      assert.equal((await read.tool.execute({ action: 'list' }, { agent: other })).ok, true)
      assert.equal(ctx.guards.size, 0)
    }
  })
  await test('configuration toggles dynamically without introducing authorization config', async () => {
    await resources.updateConfig({ skills: { enabled: false, authorization: 'irrelevant' } })
    assert.deepEqual(resources.getConfig().skills, { enabled: false })
    assert.equal(read.options.when({ agent }), false)
    assert.equal((await read.tool.execute({ action: 'list' }, { agent })).ok, false)
    await resources.updateConfig({ proactive: { enabled: false } })
    assert.equal(resources.getConfig().skills.enabled, false)
    await resources.updateConfig({ skills: { enabled: true } })
    assert.equal(read.options.when({ agent }), true)
    assert.equal(resources.getConfig().proactive.enabled, false)
  })
  await test('read and learning actions stay separated; errors are structured', async () => {
    assert.equal((await read.tool.execute({ action: 'revise' }, { agent })).error.code, 'INVALID_ARGUMENT')
    assert.equal((await learn.tool.execute({ action: 'list' }, { agent })).error.code, 'INVALID_ARGUMENT')
    assert.equal((await read.tool.execute({ action: 'read', skillId: '../../escape' }, { agent })).ok, false)
  })
  await test('learning persists immediately and conflicts do not overwrite', async () => {
    const old = await read.tool.execute({ action: 'read', skillId: 'homepage-operations' }, { agent })
    assert.equal(old.ok, true)
    const changed = await learn.tool.execute({ action: 'revise', skillId: 'homepage-operations', section: 'guide', expectedRevision: old.data.currentRevision, content: '# 官网运营\n先检查主页信息。', reason: 'integration test' }, { agent })
    assert.equal(changed.ok, true)
    const conflict = await learn.tool.execute({ action: 'revise', skillId: 'homepage-operations', section: 'guide', expectedRevision: old.data.currentRevision, content: 'stale', reason: 'stale write' }, { agent })
    assert.equal(conflict.error.code, 'CONFLICT')
    const recorded = await learn.tool.execute({ action: 'record', skillId: 'homepage-operations', claim: '发布后需检查线上正文。', evidenceRefs: [] }, { agent })
    assert.equal(recorded.ok, true)
    assert.equal(recorded.data.experience.status, 'observed')
  })
  await test('disposal hides and denies captured definitions and removes all registrations', async () => {
    module.close()
    module.close()
    assert.equal(ctx.registered.size, 0)
    assert.equal(ctx.guards.size, 0)
    assert.equal(read.options.when({ agent }), false)
    assert.equal((await read.tool.execute({ action: 'list' }, { agent })).ok, false)
  })
  await test('partial installation is rolled back', async () => {
    const broken = mockContext(true)
    assert.throws(() => installSkills(broken, { resources }), /registration failed/)
    assert.equal(broken.registered.size, 0)
    assert.equal(broken.guards.size, 0)
  })
  await test('storage failures hide filesystem details', async () => {
    const tools = createSkillTools({ run: async () => { throw new Error('/private/secret') } }, { isAvailable: () => true })
    const result = await tools[0].execute({ action: 'list' }, {})
    assert.equal(result.error.code, 'SKILL_STORAGE_ERROR')
    assert.doesNotMatch(JSON.stringify(result), /private/)
  })
  await test('ready barrier is awaited before service execution', async () => {
    let release
    let called = false
    const ready = new Promise(resolve => { release = resolve })
    const tools = createSkillTools({ run: async () => { called = true; return {} } }, { isAvailable: () => true, ready })
    const pending = tools[0].execute({ action: 'list' }, {})
    await Promise.resolve()
    assert.equal(called, false)
    release()
    assert.equal((await pending).ok, true)
    assert.equal(called, true)
  })
  await test('disable during readiness wait prevents a stale write', async () => {
    let release
    let enabled = true
    let called = false
    const ready = new Promise(resolve => { release = resolve })
    const tools = createSkillTools({ run: async () => { called = true; return {} } }, { isAvailable: () => enabled, ready })
    const pending = tools[1].execute({ action: 'record', skillId: 'homepage-operations', claim: 'stale' }, {})
    enabled = false
    release()
    assert.equal((await pending).ok, false)
    assert.equal(called, false)
  })
  const schemas = [read.tool, learn.tool].map(({ name, description, parameters }) => ({ name, description, parameters }))
  console.log(`New skill tool schema UTF-8 bytes: ${Buffer.byteLength(JSON.stringify(schemas))}; exact model-token delta not measured in offline tests.`)
  console.log(`PASS ${passed} skills host integration groups`)
} finally {
  // Only this test-created absolute directory may be removed.
  assert.equal(dirname(resolve(root)), temporaryRoot)
  assert.ok(root.includes('chonkyfish-skills-host-'))
  await rm(root, { recursive: true, force: true })
}
