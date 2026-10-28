/**
 * 大肥鱼 · 日记模块（Host 侧）· 装配入口。
 *
 * 一个工具 + 一个本地 Markdown Provider + 一个每日定时器：
 *   - createDiaryModule().tool      → 交给 ctx.tools.register()
 *   - createDiaryModule().start()   → 启动 20:00 定时检查
 *   - createDiaryModule().stop()    → 插件卸载/热重载时停表
 *
 * 路径、上限、时区、开关全部来自资源管理模块，本文件不硬编码。
 */
import { createDeliverer } from '../proactive/delivery.js'
import { PRESET } from '../resources/spec.js'
import { createDiaryService } from './core.js'
import { createLocalDiaryProvider } from './provider.js'
import { createDiaryScheduler } from './schedule.js'
import { createDiaryState } from './state.js'
import { createDiaryTool } from './tools.js'

/**
 * @param {{
 *   ctx: any,
 *   resources: ReturnType<typeof import('../resources/index.js').createResources>,
 *   logger?: { warn?: Function, info?: Function },
 *   now?: () => number,
 *   tickMs?: number,
 * }} options
 */
export function createDiaryModule({ ctx, resources, logger, now = Date.now, tickMs }) {
  const provider = createLocalDiaryProvider({ directory: resources.paths.diary })
  const service = createDiaryService({
    provider,
    // 每次写入时重新读配置，PUT /chonkyfish/config 改上限后立即生效。
    getMaxChars: () => resources.getConfig().diary.maxContentChars,
  })
  const tool = createDiaryTool(service)
  const state = createDiaryState({ file: resources.paths.diaryState })
  const deliverer = createDeliverer({
    ctx,
    workspaceRoot: resources.paths.workspace,
    preset: PRESET,
    logger,
  })
  const scheduler = createDiaryScheduler({
    resources,
    provider,
    state,
    deliverer,
    logger,
    now,
    ...(tickMs === undefined ? {} : { tickMs }),
  })

  return {
    tool,
    provider,
    service,
    start: () => scheduler.start(),
    stop: () => scheduler.stop(),
    checkOnce: () => scheduler.checkOnce(),
  }
}
