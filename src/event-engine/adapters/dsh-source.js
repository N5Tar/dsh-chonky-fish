/**
 * 大肥鱼模块 0 · DSH 事件源适配器（turn 收集器）。
 *
 * 只消费 DSH 的 `session/event`（post-commit、fire-and-forget），不轮询、不抓 DOM、
 * 不复制原始内容——内容权威副本留在 DSH 会话日志里，我们只产出 (sessionId, seq) 引用。
 *
 * 明确排除：
 *   - `assistant/attempt`：重试过程中的中间流，不是最终回复
 *   - `system/message` / `developer/message` / `request/*` / `step/*` / `turn/start`
 *   - 非 append 的 surface 事件（compaction/replace 换掉的旧内容），避免同一内容抽两遍
 *
 * 采集边界（2026-10-27 拍板）：不回补历史。进程重启时没收到 `turn/start` 的 turn
 * 直接跳过并记审计，不去翻日志。
 */
import { makeRecordId, messageText } from '../domain/contracts.js'

/** DSH 的时间戳是毫秒 epoch；防御性地兼容秒级。 */
export function toIsoTime(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return new Date().toISOString()
  const ms = numeric < 1e12 ? numeric * 1000 : numeric
  return new Date(ms).toISOString()
}

/** surfaceOp 缺省视为 append；只有对象形式（replace）才拒收。 */
function isAppendSurface(event) {
  return event.surfaceOp === undefined || event.surfaceOp === 'append'
}

/**
 * @param {{
 *   maxRecordsPerTurn?: number,
 *   onTurn: (turn: import('../domain/contracts.js').TurnInput & { truncated: boolean }) => void,
 *   onSkip: (skip: { sessionId: string, turn: number, reason: string }) => void,
 * }} options
 */
export function createTurnCollector({ maxRecordsPerTurn = 400, onTurn, onSkip }) {
  /** @type {Map<string, { sessionId: string, turn: number, observedAt: string, records: any[], truncated: boolean }>} */
  const buffers = new Map()

  function collect(sessionId, event, sourceKind) {
    const buffer = buffers.get(sessionId)
    if (!buffer) return // 没收到 turn/start（重启后中途接入）：忽略，交给 turn/end 记审计
    if (!isAppendSurface(event)) return
    if (buffer.records.length >= maxRecordsPerTurn) {
      buffer.truncated = true
      return
    }
    const data = event.data ?? {}
    const content = data.content !== undefined ? data.content : data.message && data.message.content
    const text = messageText(content)
    if (text.trim() === '') return
    buffer.records.push({
      recordId: makeRecordId(sessionId, event.seq),
      seq: Number(event.seq),
      sourceKind,
      observedAt: toIsoTime(event.time),
      text,
    })
  }

  return {
    /** @param {string} sessionId @param {any} event */
    feed(sessionId, event) {
      const data = event.data ?? {}
      switch (event.type) {
        case 'turn/start':
          buffers.set(sessionId, {
            sessionId,
            turn: Number(data.turn ?? 0),
            observedAt: toIsoTime(event.time),
            records: [],
            truncated: false,
          })
          return
        case 'user/message':
          collect(sessionId, event, 'user_message')
          return
        case 'assistant/message':
          collect(sessionId, event, 'assistant_message')
          return
        case 'turn/end': {
          const buffer = buffers.get(sessionId)
          buffers.delete(sessionId)
          if (!buffer) {
            onSkip({ sessionId, turn: Number(data.turn ?? 0), reason: 'turn_not_buffered' })
            return
          }
          if (buffer.records.length === 0) {
            onSkip({ sessionId, turn: buffer.turn, reason: 'empty_turn' })
            return
          }
          onTurn({ ...buffer, observedAt: toIsoTime(event.time) })
          return
        }
        default:
          return
      }
    },
    /** 会话被销毁/切走时丢弃半截 buffer（不补采）。 */
    reset(sessionId) {
      buffers.delete(sessionId)
    },
    size() {
      return buffers.size
    },
  }
}
