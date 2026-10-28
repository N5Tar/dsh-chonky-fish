/**
 * 大肥鱼 · 日记模块（Host 侧）· 装配入口。
 *
 * 日记模块只提供「写 / 读 / 列」的能力与本地 Markdown；
 * **不内置任何定时器**。什么时候写由大肥鱼自己决定——它可以用 DSH 原生的
 * `schedule_create` 给自己排一个每日提醒，到点回到这条会话里再调用 `diary`。
 *
 *   - createDiaryModule().tool    → 交给 ctx.tools.register()
 *   - createDiaryModule().service → 面板只读路由使用
 *
 * 路径、上限、开关来自资源管理模块，本文件不硬编码。
 */
import { createDiaryService } from './core.js'
import { createLocalDiaryProvider } from './provider.js'
import { createDiaryTool } from './tools.js'

/**
 * @param {{
 *   resources: ReturnType<typeof import('../resources/index.js').createResources>,
 * }} options
 */
export function createDiaryModule({ resources }) {
  const provider = createLocalDiaryProvider({ directory: resources.paths.diary })
  const service = createDiaryService({
    provider,
    // 每次写入时重新读配置，PUT /chonkyfish/config 改上限后立即生效。
    getMaxChars: () => resources.getConfig().diary.maxContentChars,
  })
  const tool = createDiaryTool(service)

  return {
    tool,
    provider,
    service,
  }
}
