/**
 * 记忆模块的 DSH 接线：独立监听 session/event，并把记忆技能写入 fish_skill 库。
 * 不注册官方 skill，不注册工具，也不依赖事件引擎开关。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SKILL_LIMITS } from '../../../../core/contracts/spec.js'
import { isFishSession } from '../../../../core/modules/proactive/identity.js'
import { parseSkillDocument } from '../../../../core/modules/memory/core.js'
import { createSkillService } from '../../../../core/modules/skills/core.js'
import { createSkillFileStorage } from '../../../shared/storage/skills-file.js'
import { createActiveSessionWriter } from './active-sessions.js'

const SKILL_URL = new URL('../../../../core/modules/memory/SKILL.md', import.meta.url)
const MEMORY_SKILL_ID = 'memory'
const INSTALL_REASON = '记忆模块写入首版；已有同名技能不会被覆盖'

function optionalService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function defaultReadSkill() {
  return readFileSync(SKILL_URL, 'utf8')
}

function skillLibrary(resources) {
  return createSkillService({
    storage: createSkillFileStorage({
      directory: resources.paths.skills,
      maxFileBytes: SKILL_LIMITS.maxFileBytes,
      isMigrationBusy: resources.isMigrationBusy || (() => false),
      withMigrationWrite: resources.withMigrationWrite || (operation => operation()),
      withMigrationRead: resources.withMigrationRead || (operation => operation()),
    }),
  })
}

function memoryGuide(document) {
  if (!document || document.name !== MEMORY_SKILL_ID) return null
  const guide = document.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
  const heading = /^#\s+(\S.*)$/m.exec(guide)
  const title = (heading?.[1] || '记忆').trim()
  if (!guide || !title) return null
  return { title, description: document.description, guide }
}

async function publishMemorySkill(resources, guide, report) {
  try {
    await skillLibrary(resources).run({
      action: 'create',
      skillId: MEMORY_SKILL_ID,
      title: guide.title,
      description: guide.description,
      guide: guide.guide,
      reason: INSTALL_REASON,
    })
    report('[chonkyfish/memory] 已把记忆技能写入 fish_skill 库，skillId 是 memory')
    return 'created'
  } catch (error) {
    if (error?.code === 'CONFLICT') {
      report('[chonkyfish/memory] fish_skill 里已有 memory，保留现有内容，不覆盖')
      return 'kept'
    }
    report('[chonkyfish/memory] 记忆技能没有写入 fish_skill；会话索引照常写', error)
    return 'failed'
  }
}

export function installMemory(ctx, { resources, ready = Promise.resolve(), pathSemantics, readSkill = defaultReadSkill, io, warn } = {}) {
  const report = (...args) => {
    const sink = warn || ctx?.logger?.warn
    try { sink?.(...args) } catch { /* ignore */ }
  }
  let closed = false
  let unsubscribe = () => {}
  let writer = null

  const starting = Promise.resolve(ready).then(async () => {
    if (closed) return
    if (resources.getConfig().memory.enabled !== true) return
    writer = createActiveSessionWriter({
      memoryRoot: resolve(resources.paths.memory),
      io,
      warn: error => report('[chonkyfish/memory] 会话索引写入失败', error),
      isFish: session => isFishSession(session, {
        workspaceRoot: resources.paths.workspace,
        preset: resources.spec.PRESET,
        pathSemantics,
      }),
    })
    if (typeof ctx?.on !== 'function') {
      report('[chonkyfish/memory] 宿主没有 session/event，会话索引不会更新')
    } else {
      let disposed = false
      const listener = (session, event) => { if (!disposed) writer.handle(session, event) }
      try {
        const returned = ctx.on('session/event', listener)
        unsubscribe = () => {
          disposed = true
          if (typeof returned === 'function') returned()
          else if (typeof ctx.off === 'function') ctx.off('session/event', listener)
        }
        if (closed) unsubscribe()
      } catch (error) {
        report('[chonkyfish/memory] 订阅 session/event 失败', error)
      }
    }

    let published = 'failed'
    try {
      const guide = memoryGuide(parseSkillDocument(readSkill()))
      if (!guide) report('[chonkyfish/memory] 记忆 skill 正文无法识别，未写入 fish_skill；会话索引照常写')
      else published = await publishMemorySkill(resources, guide, report)
    } catch (error) {
      report('[chonkyfish/memory] 记忆技能没有写入 fish_skill；会话索引照常写', error)
    }
    if (published !== 'failed' && resources.getConfig().skills.enabled === false) {
      report('[chonkyfish/memory] skills.enabled 为关，fish_skill 当前读不到 memory；已有技能文件按库规则保留，会话索引照常写')
    }

    if (!optionalService(ctx, 'sessionQuery')) {
      report('[chonkyfish/memory] 缺少 sessionQuery，查不了旧聊天；会话索引照常写')
    }
  }).catch(error => {
    report('[chonkyfish/memory] 启动失败', error)
  })

  let closing = null
  function close() {
    if (!closing) {
      closing = (async () => {
        closed = true
        try { unsubscribe() } catch { /* already gone */ }
        await starting
        try { unsubscribe() } catch { /* already gone */ }
        if (writer) await writer.close()
      })()
    }
    return closing
  }

  return { close, ready: starting }
}
