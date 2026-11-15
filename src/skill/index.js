/**
 * 大肥鱼 · 内嵌 browser 技能。
 *
 * 挂在 `preset-chonkyfish.plugins` 里，所以 `ctx.skills.register()` 落在**这个
 * preset 的 skill 层**，只对鱼鱼可见，不会污染标准 preset。
 *
 * 技能正文随插件分发（`skills/browser/SKILL.md`），不依赖用户 home 下的
 * `~/.agents/skills`：新装 DSH / 新 profile 装完插件就有，不用另装技能文件。
 * 真正驱动浏览器的 `agent-browser` CLI 不在插件里，技能会先检查、缺失时用
 * npm 装（或 `npx` 临时跑），所以第一次用可能需要联网。
 */
import { readFileSync } from 'node:fs'

export const name = 'chonkyfish-browser-skill'
export const inject = ['skills']

const SKILL_FILE = new URL('../../skills/browser/SKILL.md', import.meta.url)

export const SKILL_NAME = 'browser'
export const SKILL_DESCRIPTION = '用本机 Chrome 真正打开、点击、登录、填表、截图网页（agent-browser CLI）。需要真实浏览器操作时使用；只读网页优先 web_fetch。'
export const SKILL_WHEN_TO_USE = '需要点击、登录、填表、翻页、看 JS 渲染结果或截图时；普通读网页用 web_fetch。'
export const SKILL_SOURCE = 'chonkyfish'

/** 读取随插件分发的技能正文；缺失时返回 undefined（调用方跳过注册）。 */
export function readSkillContent() {
  try {
    return readFileSync(SKILL_FILE, 'utf8')
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const content = readSkillContent()
  if (content === undefined) {
    ctx.logger?.warn?.('[chonkyfish] 找不到内嵌的 browser 技能文件，已跳过注册（浏览器技能不可用）')
    return
  }
  ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    source: SKILL_SOURCE,
    content,
  })
}
