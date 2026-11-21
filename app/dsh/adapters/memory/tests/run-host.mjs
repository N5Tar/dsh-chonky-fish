import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { platform } from '../../../../shared/platform/index.js'
import { createResources } from '../../../../shared/resources/index.js'
import { parseSkillDocument } from '../../../../../core/modules/memory/core.js'
import { installSkills } from '../../skills/index.js'
import { installMemory } from '../index.js'

const tests = []
const test = (name, fn) => tests.push([name, fn])
const at = iso => Date.parse(iso)

function context(services = {}) {
  const listeners = []
  const warnings = []
  let tools = 0
  let skill = null
  let skillDisposed = 0
  const ctx = {
    logger: { warn: (...args) => warnings.push(args.map(item => item instanceof Error ? item.message : String(item)).join(' ')) },
    get(name) { return services[name] },
    on(event, fn) {
      assert.equal(event, 'session/event')
      listeners.push(fn)
      return () => {
        const index = listeners.indexOf(fn)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    tools: { register() { tools += 1; return () => {} } },
  }
  return {
    ctx, warnings, listeners, tools: () => tools,
    skill: () => skill, skillDisposed: () => skillDisposed,
    emit: (session, event) => { for (const fn of [...listeners]) fn(session, event) },
    withSkills(register = value => { skill = value; return () => { skillDisposed += 1 } }) {
      services.skills = { register }
      return this
    },
  }
}

function fish(resources, id = 'session-a', cwd = resources.paths.workspace, header = {}) {
  return { id, header: { cwd, agentPreset: 'chonkyfish', ...header } }
}
function activity(type, time, data = undefined) {
  return data === undefined ? { type, time } : { type, time, data }
}

async function home() {
  // realpath: macOS /var and /tmp are symlinks; skills-file refuses symlink ancestors.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'chonkyfish-memory-'))
  const resources = createResources({ homeRoot: root })
  await resources.ensureLayout()
  return { root, resources, async cleanup() { await rm(root, { recursive: true, force: true }) } }
}

test('宿主接线不把 skills 放进 inject，也不改 preset', () => {
  const host = readFileSync(new URL('../../../host/index.js', import.meta.url), 'utf8')
  const inject = host.match(/export const inject = (\[[^\]]*\])/)[1]
  assert.equal(inject.includes("'skills'"), false)
  assert.match(host, /installMemory\(/)
  assert.match(host, /memoryRoot: resolve\(resources\.paths\.memory\)/)
  assert.match(readFileSync(new URL('../index.js', import.meta.url), 'utf8'), /memoryRoot: resolve\(resources\.paths\.memory\)/)
  const preset = readFileSync(new URL('../../../packaging/cordis.patch.yml', import.meta.url), 'utf8')
  assert.equal(preset.includes('session_search'), false)
  assert.equal(preset.includes('dsh-experimental-session-search'), false)
  const adapter = readFileSync(new URL('../index.js', import.meta.url), 'utf8') + readFileSync(new URL('../active-sessions.js', import.meta.url), 'utf8')
  assert.equal(adapter.includes('tools.register'), false)
  assert.equal(adapter.includes('skills.register'), false)
  assert.equal(adapter.includes("service(ctx, 'skills')"), false)
  assert.match(adapter, /createSkillService/)
  assert.equal(adapter.includes('session_search'), false)
})

test('事件引擎和活动感知关闭时仍记录；社交和子会话不记；附件和其他来源也记', async () => {
  const fixture = await home()
  try {
    await fixture.resources.updateConfig({ memory: { enabled: true }, eventEngine: { enabled: false }, perception: { enabled: false } })
    const host = context().withSkills()
    host.services = null
    const memory = installMemory(host.ctx, { resources: fixture.resources, ready: Promise.resolve(), pathSemantics: platform })
    await memory.ready
    const day = '2026-11-20T'
    const samples = [
      [fish(fixture.resources, 'owner'), activity('user/message', at(day + '09:12:00+08:00'), { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] })],
      [fish(fixture.resources, 'schedule'), activity('user/message', at(day + '09:40:00+08:00'), { source: { kind: 'time-context' }, content: [] })],
      [fish(fixture.resources, 'picture'), activity('assistant/message', at(day + '11:00:00+08:00'), { message: { role: 'assistant', content: [{ type: 'text', text: 'secret-reply' }, { type: 'image', url: 'redacted-image' }, { type: 'reasoning', text: 'hidden-thought' }] } })],
      [fish(fixture.resources, 'child', fixture.resources.paths.workspace, { origin: 'subagent' }), activity('user/message', at(day + '12:00:00+08:00'))],
      [fish(fixture.resources, 'delegated', fixture.resources.paths.workspace, { delegationDepth: 1 }), activity('user/message', at(day + '12:05:00+08:00'))],
      [fish(fixture.resources, 'social', fixture.resources.paths.workspace, { agentPreset: 'chonkyfish-social' }), activity('user/message', at(day + '12:10:00+08:00'))],
      [fish(fixture.resources, 'outside', '/tmp/not-the-fish-workspace'), activity('user/message', at(day + '12:20:00+08:00'))],
      [fish(fixture.resources, 'prefix', fixture.resources.paths.workspace + '-extra'), activity('user/message', at(day + '12:25:00+08:00'))],
      [fish(fixture.resources, 'nested', join(fixture.resources.paths.workspace, 'pond')), activity('user/message', at(day + '13:00:00+08:00'))],
      [fish(fixture.resources, 'tool'), { type: 'tool/call', time: at(day + '13:30:00+08:00'), data: { name: 'bash' } }],
      [fish(fixture.resources, 'attempt'), { type: 'assistant/attempt', time: at(day + '13:40:00+08:00') }],
      [fish(fixture.resources, 'replaced'), { type: 'assistant/message', time: at(day + '13:50:00+08:00'), surfaceOp: 'replace' }],
      [fish(fixture.resources, 'object-replace'), { type: 'assistant/message', time: at(day + '13:55:00+08:00'), surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, data: { message: { content: [{ type: 'text', text: 'replaced-body' }] } } }],
    ]
    for (const [session, event] of samples) host.emit(session, event)
    await memory.close()
    const text = await readFile(join(fixture.resources.paths.memory, 'sessions', '2026-11-20.md'), 'utf8')
    assert.match(text, /^- owner \| 首次 09:12 \| 最近 09:12$/m)
    assert.match(text, /^- schedule \| 首次 09:40 \| 最近 09:40$/m)
    assert.match(text, /^- picture \| 首次 11:00 \| 最近 11:00$/m)
    assert.match(text, /^- nested \| 首次 13:00 \| 最近 13:00$/m)
    for (const secret of ['你好', 'secret-reply', 'redacted-image', 'hidden-thought', 'replaced-body', 'time-context', 'bash', 'child', 'delegated', 'social', 'outside', 'prefix', 'tool', 'attempt', 'replaced', 'object-replace']) {
      assert.equal(text.includes(secret), false, secret)
    }
    assert.equal(host.tools(), 0)
    assert.equal(host.skill(), null)
    const library = JSON.parse(await readFile(join(fixture.resources.paths.skills, 'memory.json'), 'utf8'))
    assert.equal(library.skillId, 'memory')
    assert.match(library.snapshots.at(-1).guide, /我的记忆/)
    assert.equal(await readFile(join(fixture.resources.paths.memory, 'SKILL.md'), 'utf8').then(() => true, () => false), false)
    assert.match(host.warnings.join('\n'), /缺少 sessionQuery/)
  } finally { await fixture.cleanup() }
})

test('同日去重、迟到、跨午夜、重启读盘，正文不进索引', async () => {
  const fixture = await home()
  try {
    const host = context({ sessionQuery: {} }).withSkills()
    const memory = installMemory(host.ctx, { resources: fixture.resources, pathSemantics: platform })
    await memory.ready
    const session = fish(fixture.resources, 'session-a')
    host.emit(session, activity('user/message', at('2026-11-20T15:40:00+08:00')))
    host.emit(session, activity('assistant/message', at('2026-11-20T09:12:00+08:00')))
    host.emit(session, activity('user/message', at('2026-11-21T00:00:00+08:00')))
    await memory.close()
    const firstDay = await readFile(join(fixture.resources.paths.memory, 'sessions', '2026-11-20.md'), 'utf8')
    const nextDay = await readFile(join(fixture.resources.paths.memory, 'sessions', '2026-11-21.md'), 'utf8')
    assert.equal(firstDay, '# 2026-11-20 活跃会话（Asia/Shanghai）\n- session-a | 首次 09:12 | 最近 15:40\n')
    assert.equal(nextDay, '# 2026-11-21 活跃会话（Asia/Shanghai）\n- session-a | 首次 00:00 | 最近 00:00\n')
    const again = context({ sessionQuery: {} }).withSkills()
    const restarted = installMemory(again.ctx, { resources: fixture.resources, pathSemantics: platform })
    await restarted.ready
    host.emit = again.emit
    again.emit(session, activity('assistant/message', at('2026-11-20T10:00:00+08:00')))
    await restarted.close()
    const reread = await readFile(join(fixture.resources.paths.memory, 'sessions', '2026-11-20.md'), 'utf8')
    assert.equal(reread, '# 2026-11-20 活跃会话（Asia/Shanghai）\n- session-a | 首次 09:12 | 最近 15:40\n')
  } finally { await fixture.cleanup() }
})

test('外部改过的当天文件会重新读入，不靠内存里的旧行', async () => {
  const fixture = await home()
  try {
    const host = context({ sessionQuery: {}, skills: { register() {} } })
    const memory = installMemory(host.ctx, { resources: fixture.resources, pathSemantics: platform })
    await memory.ready
    host.emit(fish(fixture.resources, 'session-a'), activity('user/message', at('2026-11-20T09:00:00+08:00')))
    await memory.close()
    const file = join(fixture.resources.paths.memory, 'sessions', '2026-11-20.md')
    await writeFile(file, '# 2026-11-20 活跃会话（Asia/Shanghai）\n- session-a | 首次 09:00 | 最近 09:00\n- session-b | 首次 10:00 | 最近 10:00\n')
    const live = context({ sessionQuery: {}, skills: { register() {} } })
    const installed = installMemory(live.ctx, { resources: fixture.resources, pathSemantics: platform })
    await installed.ready
    live.emit(fish(fixture.resources, 'session-a'), activity('user/message', at('2026-11-20T11:00:00+08:00')))
    await installed.close()
    assert.equal(await readFile(file, 'utf8'), '# 2026-11-20 活跃会话（Asia/Shanghai）\n- session-a | 首次 09:00 | 最近 11:00\n- session-b | 首次 10:00 | 最近 10:00\n')
  } finally { await fixture.cleanup() }
})

test('损坏和旧日读失败不覆盖原文件，新日仍可写', async () => {
  const fixture = await home()
  try {
    const sessions = join(fixture.resources.paths.memory, 'sessions')
    await mkdir(sessions, { recursive: true })
    const broken = join(sessions, '2026-11-19.md')
    await writeFile(broken, 'this file is damaged\n')
    const blocked = join(sessions, '2026-11-20.md')
    await writeFile(blocked, 'keep-old-day\n')
    const { readFile: read, writeFile: write, rename, unlink, mkdir: make } = await import('node:fs/promises')
    const io = {
      mkdir: make, rename, unlink, writeFile: write,
      readFile(file, encoding) {
        if (file === blocked) return Promise.reject(Object.assign(new Error('read failed'), { code: 'EIO' }))
        return read(file, encoding)
      },
    }
    const host = context({ sessionQuery: {}, skills: { register() {} } })
    const memory = installMemory(host.ctx, { resources: fixture.resources, pathSemantics: platform, io })
    await memory.ready
    host.emit(fish(fixture.resources, 'session-a'), activity('user/message', at('2026-11-19T08:00:00+08:00')))
    host.emit(fish(fixture.resources, 'session-a'), activity('user/message', at('2026-11-20T08:00:00+08:00')))
    host.emit(fish(fixture.resources, 'session-a'), activity('user/message', at('2026-11-21T08:00:00+08:00')))
    await memory.close()
    assert.equal(await readFile(broken, 'utf8'), 'this file is damaged\n')
    assert.equal(await readFile(blocked, 'utf8'), 'keep-old-day\n')
    assert.match(await readFile(join(sessions, '2026-11-21.md'), 'utf8'), /session-a \| 首次 08:00 \| 最近 08:00/)
    assert.match(host.warnings.join('\n'), /会话索引写入失败/)
  } finally { await fixture.cleanup() }
})

test('索引路径是符号链接或目录时不读取、不替换', async () => {
  const fixture = await home()
  try {
    const sessions = join(fixture.resources.paths.memory, 'sessions')
    await mkdir(sessions, { recursive: true })
    const target = join(sessions, 'secret-target.md')
    await writeFile(target, 'do-not-read-or-replace\n')
    const link = join(sessions, '2026-11-20.md')
    await symlink(target, link)
    const dirIndex = join(sessions, '2026-11-21.md')
    await mkdir(dirIndex)
    await writeFile(join(dirIndex, 'kept.txt'), 'inside\n')
    const host = context({ sessionQuery: {}, skills: { register() {} } })
    const memory = installMemory(host.ctx, { resources: fixture.resources, pathSemantics: platform })
    await memory.ready
    host.emit(fish(fixture.resources, 'session-a'), activity('user/message', at('2026-11-20T09:00:00+08:00')))
    host.emit(fish(fixture.resources, 'session-b'), activity('user/message', at('2026-11-21T09:00:00+08:00')))
    await memory.close()
    assert.equal((await lstat(link)).isSymbolicLink(), true)
    assert.equal(await readFile(target, 'utf8'), 'do-not-read-or-replace\n')
    assert.equal((await lstat(dirIndex)).isDirectory(), true)
    assert.equal(await readFile(join(dirIndex, 'kept.txt'), 'utf8'), 'inside\n')
    assert.match(host.warnings.join('\n'), /unsafe/)
  } finally { await fixture.cleanup() }
})

test('rename 失败保留原文件，随后的活动仍能写', async () => {
  const fixture = await home()
  try {
    const file = join(fixture.resources.paths.memory, 'sessions', '2026-11-20.md')
    const { readFile: read, writeFile: write, rename: renameFile, unlink, mkdir: make } = await import('node:fs/promises')
    let failRename = false
    const io = {
      mkdir: make, unlink, readFile: read, writeFile: write,
      rename(from, to) {
        if (failRename) return Promise.reject(Object.assign(new Error('rename failed'), { code: 'EIO' }))
        return renameFile(from, to)
      },
    }
    const host = context({ sessionQuery: {}, skills: { register() {} } })
    const memory = installMemory(host.ctx, { resources: fixture.resources, pathSemantics: platform, io })
    await memory.ready
    host.emit(fish(fixture.resources, 'session-a'), activity('user/message', at('2026-11-20T09:00:00+08:00')))
    await memory.close()
    const original = await readFile(file, 'utf8')
    failRename = true
    const live = context({ sessionQuery: {}, skills: { register() {} } })
    const installed = installMemory(live.ctx, { resources: fixture.resources, pathSemantics: platform, io })
    await installed.ready
    live.emit(fish(fixture.resources, 'session-b'), activity('user/message', at('2026-11-20T10:00:00+08:00')))
    await installed.close()
    assert.equal(await readFile(file, 'utf8'), original)
    failRename = false
    const after = context({ sessionQuery: {}, skills: { register() {} } })
    const finalInstall = installMemory(after.ctx, { resources: fixture.resources, pathSemantics: platform, io })
    await finalInstall.ready
    after.emit(fish(fixture.resources, 'session-b'), activity('user/message', at('2026-11-20T10:00:00+08:00')))
    await finalInstall.close()
    const text = await readFile(file, 'utf8')
    assert.match(text, /session-a \| 首次 09:00 \| 最近 09:00/)
    assert.match(text, /session-b \| 首次 10:00 \| 最近 10:00/)
  } finally { await fixture.cleanup() }
})

test('并发写不重叠；close 先解除监听再排空，重载只留一份监听', async () => {
  const fixture = await home()
  try {
    const { readFile: read, writeFile: write, rename, unlink, mkdir: make } = await import('node:fs/promises')
    let active = 0
    let max = 0
    let release
    let entered
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { entered = resolve })
    let blocked = false
    const io = {
      mkdir: make, rename, unlink, readFile: read,
      async writeFile(file, data, encoding) {
        if (!blocked && String(file).endsWith('.tmp')) {
          blocked = true
          entered()
          await gate
        }
        active += 1
        max = Math.max(max, active)
        await new Promise(resolve => setTimeout(resolve, 15))
        active -= 1
        return write(file, data, encoding)
      },
    }
    const first = context({ sessionQuery: {}, skills: { register() {} } })
    const memory = installMemory(first.ctx, { resources: fixture.resources, pathSemantics: platform, io })
    await memory.ready
    first.emit(fish(fixture.resources, 'session-a'), activity('user/message', at('2026-11-20T09:00:00+08:00')))
    await started
    const closing = memory.close()
    assert.equal(first.listeners.length, 0)
    first.emit(fish(fixture.resources, 'session-late'), activity('user/message', at('2026-11-20T09:30:00+08:00')))
    const second = context({ sessionQuery: {}, skills: { register() {} } })
    const reloaded = installMemory(second.ctx, { resources: fixture.resources, pathSemantics: platform, io })
    await reloaded.ready
    assert.equal(second.listeners.length, 1)
    second.emit(fish(fixture.resources, 'session-b'), activity('user/message', at('2026-11-20T11:00:00+08:00')))
    release()
    await closing
    await reloaded.close()
    assert.equal(second.listeners.length, 0)
    assert.equal(max, 1)
    const text = await readFile(join(fixture.resources.paths.memory, 'sessions', '2026-11-20.md'), 'utf8')
    assert.match(text, /session-a \| 首次 09:00 \| 最近 09:00/)
    assert.match(text, /session-b \| 首次 11:00 \| 最近 11:00/)
    assert.equal(text.includes('session-late'), false)
    await memory.close()
  } finally { await fixture.cleanup() }
})

test('没有官方 skills 服务时仍写入 fish_skill 文件；关闭记忆开关则不监听也不写入', async () => {
  const fixture = await home()
  try {
    const missing = context()
    const memory = installMemory(missing.ctx, { resources: fixture.resources, pathSemantics: platform })
    await memory.ready
    missing.emit(fish(fixture.resources), activity('user/message', at('2026-11-20T09:12:00+08:00')))
    await memory.close()
    const warnings = missing.warnings.join('\n')
    assert.equal(warnings.includes('缺少 skills 服务'), false)
    assert.match(warnings, /已把记忆技能写入 fish_skill/)
    assert.match(warnings, /查不了旧聊天/)
    assert.match(await readFile(join(fixture.resources.paths.memory, 'sessions', '2026-11-20.md'), 'utf8'), /session-a/)
    assert.match(await readFile(join(fixture.resources.paths.skills, 'memory.json'), 'utf8'), /我的记忆/)
    const throwing = context()
    throwing.ctx.get = () => { throw new Error('service unavailable') }
    const still = installMemory(throwing.ctx, { resources: fixture.resources, pathSemantics: platform })
    await still.ready
    throwing.emit(fish(fixture.resources, 'session-c'), activity('user/message', at('2026-11-17T09:12:00+08:00')))
    await still.close()
    assert.equal(throwing.warnings.join('\n').includes('缺少 skills 服务'), false)
    assert.match(throwing.warnings.join('\n'), /不覆盖/)
    assert.match(throwing.warnings.join('\n'), /查不了旧聊天/)
    assert.match(await readFile(join(fixture.resources.paths.memory, 'sessions', '2026-11-17.md'), 'utf8'), /session-c/)
  } finally { await fixture.cleanup() }
})

test('记忆开关关闭时不监听，也不创建 memory 技能', async () => {
  const fixture = await home()
  try {
    await fixture.resources.updateConfig({ memory: { enabled: false } })
    const disabled = context({ sessionQuery: {} }).withSkills()
    const stopped = installMemory(disabled.ctx, { resources: fixture.resources, pathSemantics: platform })
    await stopped.ready
    disabled.emit(fish(fixture.resources, 'session-b'), activity('user/message', at('2026-11-20T10:00:00+08:00')))
    await stopped.close()
    assert.equal(disabled.listeners.length, 0)
    assert.equal(disabled.skill(), null)
    assert.equal(await readFile(join(fixture.resources.paths.skills, 'memory.json'), 'utf8').then(() => true, () => false), false)
    assert.equal(await readFile(join(fixture.resources.paths.memory, 'sessions', '2026-11-20.md'), 'utf8').then(text => text.includes('session-b'), () => false), false)
  } finally { await fixture.cleanup() }
})

test('技能目录不可写或正文打不开时，监听仍写索引', async () => {
  const fixture = await home()
  try {
    await writeFile(fixture.resources.paths.skills, 'not-a-directory')
    const host = context({ sessionQuery: {} })
    const memory = installMemory(host.ctx, { resources: fixture.resources, pathSemantics: platform })
    await memory.ready
    host.emit(fish(fixture.resources), activity('assistant/message', at('2026-11-18T08:08:00+08:00')))
    await memory.close()
    assert.match(host.warnings.join('\n'), /记忆技能没有写入 fish_skill/)
    assert.match(await readFile(join(fixture.resources.paths.memory, 'sessions', '2026-11-18.md'), 'utf8'), /session-a/)
    assert.equal(await readFile(fixture.resources.paths.skills, 'utf8'), 'not-a-directory')
    const unreadable = await home()
    try {
      const host = context({ sessionQuery: {} })
      const skipped = installMemory(host.ctx, {
        resources: unreadable.resources,
        pathSemantics: platform,
        readSkill: () => { throw new Error('missing skill') },
      })
      await skipped.ready
      await skipped.close()
      assert.match(host.warnings.join('\n'), /记忆技能没有写入 fish_skill/)
      assert.equal(await readFile(join(unreadable.resources.paths.skills, 'memory.json'), 'utf8').then(() => true, () => false), false)
    } finally { await unreadable.cleanup() }
  } finally { await fixture.cleanup() }
})

function skillToolHost() {
  const registered = new Map()
  const warnings = []
  const ctx = {
    logger: { warn: (...args) => warnings.push(args.map(item => item instanceof Error ? item.message : String(item)).join(' ')) },
    get(name) { return name === 'sessionQuery' ? {} : undefined },
    on() { return () => {} },
    tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
    webServer: null,
  }
  return { ctx, registered, warnings }
}

function bundledGuide() {
  const document = parseSkillDocument(readFileSync(new URL('../../../../../core/modules/memory/SKILL.md', import.meta.url), 'utf8'))
  return document.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
}

async function readFullGuide(tool) {
  let offset = 0
  let revision
  let content = ''
  let pages = 0
  do {
    const args = { action: 'read', skillId: 'memory', section: 'guide', offset }
    if (revision !== undefined) args.revision = revision
    const page = await tool.execute(args)
    assert.equal(page.ok, true, JSON.stringify(page))
    content += page.data.content
    revision = page.data.revision
    offset = page.data.nextOffset
    pages += 1
    assert.ok(pages < 8)
  } while (offset !== null)
  return { content, pages, revision }
}

test('首次安装可被 fish_skill 读出全文，再次启动不改文件，并保留用户技能', async () => {
  const fixture = await home()
  try {
    const host = skillToolHost()
    const skills = installSkills(host.ctx, { resources: fixture.resources, ready: Promise.resolve() })
    await skills.service.run({
      action: 'create', skillId: 'cooking', title: '做菜', description: '用户自己的技能', guide: '用户的做菜技能', reason: '用户创建',
    })
    const cookingBefore = await readFile(join(fixture.resources.paths.skills, 'cooking.json'))
    const first = installMemory(host.ctx, { resources: fixture.resources, pathSemantics: platform })
    await first.ready
    await first.close()
    const installed = await readFile(join(fixture.resources.paths.skills, 'memory.json'))
    assert.match(host.warnings.join('\n'), /已把记忆技能写入 fish_skill/)
    const listed = await host.registered.get('fish_skill').execute({ action: 'list' })
    assert.equal(listed.ok, true)
    assert.equal(listed.data.items.filter(item => item.skillId === 'memory').length, 1)
    assert.ok(listed.data.items.some(item => item.skillId === 'cooking'))
    const full = await readFullGuide(host.registered.get('fish_skill'))
    assert.equal(full.content, bundledGuide())
    assert.ok(full.pages >= 2)
    const secondHost = context({ sessionQuery: {} })
    const second = installMemory(secondHost.ctx, { resources: fixture.resources, pathSemantics: platform })
    await second.ready
    await second.close()
    assert.deepEqual(await readFile(join(fixture.resources.paths.skills, 'memory.json')), installed)
    assert.deepEqual(await readFile(join(fixture.resources.paths.skills, 'cooking.json')), cookingBefore)
    assert.match(secondHost.warnings.join('\n'), /不覆盖/)
    assert.equal(full.revision, 1)
    await skills.close()
  } finally { await fixture.cleanup() }
})

test('同名用户技能、损坏文件和符号链接都不覆盖，其他技能保持原样', async () => {
  const fixture = await home()
  try {
    const host = skillToolHost()
    const skills = installSkills(host.ctx, { resources: fixture.resources, ready: Promise.resolve() })
    await skills.service.run({
      action: 'create', skillId: 'memory', title: '用户的记忆', description: '用户自己写的', guide: '用户自定义指南，不要覆盖', reason: '用户创建',
    })
    await skills.service.run({
      action: 'revise', skillId: 'memory', section: 'guide', content: '用户改过的指南', reason: '用户修订', expectedRevision: 1,
    })
    await skills.service.run({
      action: 'create', skillId: 'cooking', title: '做菜', description: '用户自己的技能', guide: '用户的做菜技能', reason: '用户创建',
    })
    const memoryBefore = await readFile(join(fixture.resources.paths.skills, 'memory.json'))
    const cookingBefore = await readFile(join(fixture.resources.paths.skills, 'cooking.json'))
    const kept = installMemory(context({ sessionQuery: {} }).ctx, { resources: fixture.resources, pathSemantics: platform })
    await kept.ready
    await kept.close()
    assert.deepEqual(await readFile(join(fixture.resources.paths.skills, 'memory.json')), memoryBefore)
    assert.deepEqual(await readFile(join(fixture.resources.paths.skills, 'cooking.json')), cookingBefore)
    const read = await host.registered.get('fish_skill').execute({ action: 'read', skillId: 'memory', limit: 8000 })
    assert.equal(read.ok, true)
    assert.equal(read.data.content, '用户改过的指南')
    await skills.close()

    const broken = await home()
    try {
      await mkdir(broken.resources.paths.skills, { recursive: true })
      await writeFile(join(broken.resources.paths.skills, 'memory.json'), '{')
      await writeFile(join(broken.resources.paths.skills, 'cooking.json'), '{"skillId":"cooking","keep":true}')
      const brokenHost = context({ sessionQuery: {} })
      const memory = installMemory(brokenHost.ctx, { resources: broken.resources, pathSemantics: platform })
      await memory.ready
      await memory.close()
      assert.equal(await readFile(join(broken.resources.paths.skills, 'memory.json'), 'utf8'), '{')
      assert.equal(await readFile(join(broken.resources.paths.skills, 'cooking.json'), 'utf8'), '{"skillId":"cooking","keep":true}')
      assert.match(brokenHost.warnings.join('\n'), /不覆盖/)
    } finally { await broken.cleanup() }

    const linked = await home()
    try {
      await mkdir(linked.resources.paths.skills, { recursive: true })
      const target = join(linked.root, 'outside-memory.json')
      await writeFile(target, 'keep-me')
      await symlink(target, join(linked.resources.paths.skills, 'memory.json'))
      const linkHost = context({ sessionQuery: {} })
      const memory = installMemory(linkHost.ctx, { resources: linked.resources, pathSemantics: platform })
      await memory.ready
      await memory.close()
      assert.equal((await lstat(join(linked.resources.paths.skills, 'memory.json'))).isSymbolicLink(), true)
      assert.equal(await readFile(target, 'utf8'), 'keep-me')
      assert.match(linkHost.warnings.join('\n'), /记忆技能没有写入 fish_skill/)
    } finally { await linked.cleanup() }
  } finally { await fixture.cleanup() }
})

test('skills.enabled 关闭时 fish_skill 读不到记忆技能，文件仍按库规则保留且索引照常', async () => {
  const fixture = await home()
  try {
    await fixture.resources.updateConfig({ skills: { enabled: false } })
    const host = skillToolHost()
    const skills = installSkills(host.ctx, { resources: fixture.resources, ready: Promise.resolve() })
    const memoryHost = context({ sessionQuery: {} })
    const memory = installMemory(memoryHost.ctx, { resources: fixture.resources, pathSemantics: platform })
    await memory.ready
    memoryHost.emit(fish(fixture.resources), activity('user/message', at('2026-11-20T09:12:00+08:00')))
    await memory.close()
    assert.match(memoryHost.warnings.join('\n'), /skills\.enabled 为关/)
    assert.match(await readFile(join(fixture.resources.paths.skills, 'memory.json'), 'utf8'), /我的记忆/)
    assert.match(await readFile(join(fixture.resources.paths.memory, 'sessions', '2026-11-20.md'), 'utf8'), /session-a/)
    const denied = await host.registered.get('fish_skill').execute({ action: 'read', skillId: 'memory' })
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'SKILL_UNAVAILABLE')
    const again = await readFile(join(fixture.resources.paths.skills, 'memory.json'))
    const restart = installMemory(context({ sessionQuery: {} }).ctx, { resources: fixture.resources, pathSemantics: platform })
    await restart.ready
    await restart.close()
    assert.deepEqual(await readFile(join(fixture.resources.paths.skills, 'memory.json')), again)
    await skills.close()
  } finally { await fixture.cleanup() }
})

test('ready 失败或 close 早于就绪都不会留下监听', async () => {
  const fixture = await home()
  try {
    const host = context({ sessionQuery: {}, skills: { register() {} } })
    const broken = installMemory(host.ctx, { resources: fixture.resources, pathSemantics: platform, ready: Promise.reject(new Error('layout failed')) })
    await broken.close()
    assert.match(host.warnings.join('\n'), /启动失败/)
    assert.equal(host.listeners.length, 0)
    let release
    const ready = new Promise(resolve => { release = resolve })
    const early = context({ sessionQuery: {}, skills: { register() {} } })
    const memory = installMemory(early.ctx, { resources: fixture.resources, pathSemantics: platform, ready })
    const closing = memory.close()
    release()
    await closing
    early.emit(fish(fixture.resources), activity('user/message', at('2026-11-20T09:12:00+08:00')))
    assert.equal(early.listeners.length, 0)
    await assert.rejects(readFile(join(fixture.resources.paths.memory, 'sessions', '2026-11-20.md'), 'utf8'))
  } finally { await fixture.cleanup() }
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
  console.error(`memory host: ${tests.length - failed}/${tests.length} passed`)
  process.exitCode = 1
} else {
  console.log(`memory host: ${tests.length}/${tests.length} passed`)
}
