/**
 * 大肥鱼主动消息 · 投递（Host 侧）。
 *
 * 这是整个能力里唯一碰 DSH 会话 API 的地方，做法和 DSH 内置定时提醒
 * （dsh-schedule 的 ScheduleRuntime）完全一致：
 *
 *   1. ctx.sessionController.resolveAgent(sessionId)   ← 冷会话会被恢复
 *   2. agent.status 必须是 idle，避免打断正在进行的 turn
 *   3. agent.followup(createUserMessage(...))          ← 进 inbox 并唤醒一轮
 *   4. ctx.sessions.flush(session)                     ← 等持久化确认
 *
 * 调用方只传「哪条会话、说什么」。会话必须属于鱼鱼身份（工作区根 + chonkyfish），
 * 投到别的会话会被拒绝——主动消息只允许出现在大肥鱼自己的对话里。
 *
 * 消息只用 { id, role, content, source } 四个字段（等价于 dsh-llm 的
 * createUserMessage），不走任何 DSH 内部 import，插件不新增依赖。
 */
import { randomUUID } from 'node:crypto'

import { isFishHeader, FISH_PRESET } from './identity.js'
import { NUDGE_SOURCE } from './narration.js'

/** 构造一条 user 角色的旁白消息（结构等价 createUserMessage，冻结交给会话日志）。 */
export function createNudgeMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { ...NUDGE_SOURCE },
  }
}

/**
 * @param {{
 *   ctx: any,
 *   workspaceRoot: string,
 *   preset?: string,
 *   logger?: { warn?: Function, info?: Function },
 * }} options
 */
export function createDeliverer({ ctx, workspaceRoot, preset = FISH_PRESET, logger }) {
  function service(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch (error) {
      return undefined
    }
  }

  function isFish(header) {
    return isFishHeader(header, { workspaceRoot, preset })
  }

  /**
   * 把一条旁白投进指定鱼鱼会话。
   * @param {string} sessionId
   * @param {string} text
   * @returns {Promise<{ ok: boolean, messageId?: string, sessionId?: string, error?: string }>}
   */
  async function deliver(sessionId, text) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return { ok: false, error: 'missing-session-id' }
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'empty-text' }
    const controller = service('sessionController')
    const sessions = service('sessions')
    if (!controller || typeof controller.resolveAgent !== 'function') {
      return { ok: false, error: 'no-session-controller' }
    }
    if (!sessions || typeof sessions.flush !== 'function') {
      return { ok: false, error: 'no-session-support' }
    }
    let resolved
    try {
      resolved = await controller.resolveAgent(sessionId)
    } catch (error) {
      return { ok: false, error: 'resolve-failed: ' + String((error && error.message) || error) }
    }
    if (!resolved || resolved.error) {
      return {
        ok: false,
        error: 'resolve-refused: ' + String((resolved && resolved.error && resolved.error.code) || 'unknown'),
      }
    }
    const agent = resolved.agent
    if (!agent || !agent.session) return { ok: false, error: 'no-agent' }
    // 主动消息只能落在大肥鱼自己的会话里：别的 agent / 别的项目一律拒绝。
    if (!isFish(agent.session.header)) return { ok: false, error: 'identity-mismatch' }
    // 正在跑 turn 的时候不要插队：让当前这轮先结束，调用方稍后重试。
    if (agent.status !== 'idle') return { ok: false, error: 'agent-busy' }

    const message = createNudgeMessage(text)
    try {
      agent.followup(message)
    } catch (error) {
      return { ok: false, error: 'followup-failed: ' + String((error && error.message) || error) }
    }
    let flushed = true
    try {
      flushed = await sessions.flush(agent.session)
    } catch (error) {
      try {
        if (logger && typeof logger.warn === 'function') logger.warn('[chonkyfish/proactive] flush 异常', error)
      } catch (ignored) {
        /* logging is best effort */
      }
      flushed = false
    }
    if (!flushed) return { ok: false, error: 'persistence-unacknowledged' }
    return { ok: true, messageId: message.id, sessionId: String(agent.session.id ?? sessionId) }
  }

  return { deliver }
}
