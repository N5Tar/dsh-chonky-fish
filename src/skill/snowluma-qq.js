/**
 * 大肥鱼 · 条件内嵌 snowluma-qq 技能。
 *
 * 只有配置了 SnowLuma QQ 连接、并且这个连接至少成功核验过一次身份时，
 * 技能目录里才会出现 snowluma-qq；没有 LumaQQ 的 profile 看不到它。
 *
 * 用 `ctx.skills.registerProvider()` 动态提供，而不是 `register()`：
 * 监听 social 目录的变化，配置/身份一变就 invalidate 目录缓存。
 * 技能正文随插件分发（`skills/snowluma-qq/SKILL.md`）。
 */
import { watch, mkdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createResources } from '../resources/index.js'

export const name = 'chonkyfish-snowluma-qq-skill'
export const inject = ['skills']

const SKILL_FILE = new URL('../../skills/snowluma-qq/SKILL.md', import.meta.url)
const PROVIDER_NAME = 'chonkyfish-snowluma-qq'

export const SKILL_NAME = 'snowluma-qq'
export const SKILL_DESCRIPTION = '查看/修改当前绑定的 SnowLuma QQ 账号：资料、好友、群、群成员、空间/说说；改昵称/签名/空间资料，发/删/赞/评论说说。用 social_account 工具，写操作先确认。'
export const SKILL_WHEN_TO_USE = '已连接 SnowLuma QQ 时，主人要求查看或修改 QQ 账号资料、好友/群、空间/说说；只回聊天消息用 social_send_message。'
export const SKILL_SOURCE = 'chonkyfish'

/** 读取随插件分发的技能正文；缺失时返回 undefined（调用方跳过注册）。 */
export function readSkillContent() {
  try {
    return readFileSync(SKILL_FILE, 'utf8')
  } catch {
    return undefined
  }
}

/** 配置里有没有 SnowLuma QQ 连接，并且 identities 里已经有它的核验记录。 */
export async function lumaConnectionIds(resources) {
  let config
  try {
    config = JSON.parse(await readFile(resources.paths.socialConfig, 'utf8'))
  } catch {
    return []
  }
  const ids = new Set((Array.isArray(config.connections) ? config.connections : [])
    .filter(row => row && row.platform === 'qq' && row.provider === 'snowluma' && typeof row.id === 'string')
    .map(row => row.id))
  if (ids.size === 0) return []
  let identities = []
  try {
    const value = JSON.parse(await readFile(resources.paths.socialIdentities, 'utf8'))
    identities = Array.isArray(value.identities) ? value.identities : []
  } catch {
    return []
  }
  return [...ids].filter(id => identities.some(row => row?.identity?.connectionId === id && !row.pending))
}

/**
 * @param {any} ctx
 * @param {{ resources?: ReturnType<typeof createResources> }} [options]
 * @returns {(() => void) | undefined}
 */
export function apply(ctx, options = {}) {
  const skills = ctx.skills
  if (!skills || typeof skills.registerProvider !== 'function') {
    ctx.logger?.warn?.('[chonkyfish] skills.registerProvider 不可用，已跳过 snowluma-qq 技能')
    return
  }
  const resources = options.resources || createResources({ env: process.env })
  const content = readSkillContent()
  if (content === undefined) {
    ctx.logger?.warn?.('[chonkyfish] 找不到内嵌的 snowluma-qq 技能文件，已跳过注册（QQ 账号技能不可用）')
    return
  }
  const file = fileURLToPath(SKILL_FILE)
  const disposer = skills.registerProvider(control => {
    let watcher = null
    let timer = null
    const invalidate = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        try { control.invalidate() } catch {}
      }, 120)
      timer.unref?.()
    }
    try {
      mkdirSync(resources.paths.social, { recursive: true, mode: 0o700 })
      watcher = watch(resources.paths.social, { persistent: false }, invalidate)
      watcher.on?.('error', () => {})
    } catch {
      watcher = null
    }
    const close = () => {
      if (timer) clearTimeout(timer)
      timer = null
      try { watcher?.close() } catch {}
      watcher = null
    }
    if (control.signal) {
      if (control.signal.aborted) close()
      else control.signal.addEventListener('abort', close, { once: true })
    }
    return {
      name: PROVIDER_NAME,
      async list() {
        const ids = await lumaConnectionIds(resources)
        if (ids.length === 0) return []
        const candidate = {
          name: SKILL_NAME,
          description: SKILL_DESCRIPTION,
          whenToUse: SKILL_WHEN_TO_USE,
          invocation: { modelInvocable: true, userInvocable: true },
          source: SKILL_SOURCE,
          provider: PROVIDER_NAME,
          path: file,
          rank: 0,
          locator: { connectionIds: ids },
        }
        return [candidate]
      },
      async get(candidate) {
        return {
          name: candidate.name,
          description: candidate.description,
          whenToUse: candidate.whenToUse,
          invocation: candidate.invocation,
          source: candidate.source,
          provider: candidate.provider,
          ...(candidate.path ? { path: candidate.path } : {}),
          content,
        }
      },
    }
  })
  return disposer
}
