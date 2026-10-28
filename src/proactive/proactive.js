/**
 * 大肥鱼主动消息 · 服务编排（Host 侧）。
 *
 * 这里只保留「主动发送」这一条能力，**没有任何定时器/自动触发**：
 *
 *   - 大肥鱼面板（client.js）绑上鱼鱼会话后，会 PUT /chonkyfish/session 把
 *     sessionId 报给 Host，Host 记进 proactive.json 的 activeSessionId；
 *   - 任何地方想让她先开口（以后接空闲/回访/外部事件，或手动调试），调用
 *     POST /chonkyfish/proactive（或本模块的 send()）即可；
 *   - Host 只往「面板当前会话」里注入旁白，所以消息会出现在大肥鱼面板的
 *     对话里，而不是新建或另找一个会话。
 *
 * 路径、preset、工作区根、开关全部来自资源管理模块（src/resources/），
 * 本文件不再自己拼 home / 文件名 / preset 名等硬编码。
 *
 * 投递路径仍是 delivery.js 的 followup + flush（和 DSH 内置定时提醒同一套）。
 * 自动调度（空闲问候、事件回访）暂时移除；回访计划器 revisit.js 先保留但不接线。
 */
import { createDeliverer } from './delivery.js'
import { defaultNarration } from './narration.js'
import { createProactiveStore } from './store.js'

/**
 * @param {{
 *   ctx: any,
 *   resources: ReturnType<typeof import('../resources/index.js').createResources>,
 *   logger?: { warn?: Function, info?: Function },
 *   now?: () => number,
 * }} options
 */
export function createProactiveService({ ctx, resources, logger, now = Date.now }) {
  const store = createProactiveStore({ file: resources.paths.proactive, now })
  const deliverer = createDeliverer({
    ctx,
    workspaceRoot: resources.paths.workspace,
    preset: resources.spec.PRESET,
    logger,
  })

  function note(message) {
    try {
      if (logger && typeof logger.info === 'function') logger.info('[chonkyfish/proactive] ' + message)
    } catch (ignored) {
      /* logging is best effort */
    }
  }

  /**
   * 面板上报「我现在显示的是这条鱼鱼会话」。Host 只认一条 active session，
   * 主动消息永远投这里——这是「不生成新会话、只出现在面板对话里」的关键。
   * @param {string} sessionId
   * @returns {{ ok: boolean, sessionId?: string, error?: string }}
   */
  function registerActiveSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, error: 'invalid-session-id' }
    }
    const id = sessionId.trim()
    store.setActiveSession(id)
    note('面板当前会话：' + id)
    return { ok: true, sessionId: id }
  }

  /**
   * 让鱼鱼主动说一句话。
   *
   * 目标会话优先级：显式 sessionId > 面板上报的 activeSessionId。
   * 没有面板会话就直接拒绝，绝不猜一条别的会话投过去。
   * 开关来自资源管理模块的 config.proactive.enabled。
   *
   * @param {{
   *   sessionId?: string|null,
   *   narration?: string|null,
   *   kind?: string,
   * }} [options]
   * @returns {Promise<{ ok: boolean, messageId?: string, sessionId?: string, error?: string }>}
   */
  async function send({ sessionId = null, narration = null, kind = 'manual' } = {}) {
    if (!resources.getConfig().proactive.enabled) {
      return { ok: false, error: 'proactive-disabled' }
    }
    const explicit = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : null
    const target = explicit || store.activeSessionId()
    if (!target) return { ok: false, error: 'no-panel-session' }

    const text = typeof narration === 'string' && narration.trim() !== ''
      ? narration.trim()
      : defaultNarration({ now: now() })

    const result = await deliverer.deliver(target, text)
    if (!result.ok) {
      note('主动消息未投递（' + result.error + '）：' + target)
      return result
    }
    store.noteSend({
      at: now(),
      kind: typeof kind === 'string' && kind.trim() !== '' ? kind.trim() : 'manual',
      sessionId: result.sessionId,
      messageId: result.messageId,
    })
    note('主动消息已投递：' + result.sessionId)
    return result
  }

  function inspect() {
    return {
      home: resources.home,
      paths: resources.paths,
      config: resources.getConfig(),
      activeSessionId: store.activeSessionId(),
      lastSentAt: store.lastSentAt(),
      store: store.snapshot(),
      automatic: false,
    }
  }

  function dispose() {
    store.dispose()
  }

  return { registerActiveSession, send, inspect, dispose }
}
