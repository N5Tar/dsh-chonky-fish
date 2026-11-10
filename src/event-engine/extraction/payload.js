/**
 * 大肥鱼模块 0 · 取 turn 原文（P2）。
 *
 * 我们不复存原始内容（raw_records 已删），提取时按 job 的 (sessionId, fromSeq..toSeq)
 * 从 DSH 读回原文：`sessionQuery.listEvents` 只取元信息，`readEvent` 取全文。
 * 活着的会话和已持久化的会话都走同一套接口。
 */
import { toIsoTime } from '../adapters/dsh-source.js'
import { makeRecordId, messageText } from '../domain/contracts.js'
import { isChannelUserMessage } from '../../social/policy.js'

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * @param {{
 *   sessionQuery: any,
 *   sessionId: string,
 *   fromSeq: number,
 *   toSeq: number,
 * }} params
 * @returns {Promise<Array<{ recordId: string, seq: number, sourceKind: string, observedAt: string, text: string }>>}
 */
export async function loadTurnRecords({ sessionQuery, sessionId, fromSeq, toSeq }) {
  if (!sessionQuery || typeof sessionQuery.listEvents !== 'function' || typeof sessionQuery.readEvent !== 'function') {
    throw new Error('sessionQuery is required to read turn content')
  }
  const events = await sessionQuery.listEvents(sessionId)
  const records = []
  // Replayed/pre-existing jobs must not reintroduce autonomous assistant output.
  // Scan source messages from the containing turn start, even when fromSeq points
  // at its assistant output (older collectors omitted the injected user message).
  const ordered = [...(events ?? [])].sort((a, b) => Number(a.seq) - Number(b.seq))
  const start = ordered.filter((event) => event.type === 'turn/start' && Number(event.seq) <= fromSeq).at(-1)
  for (const record of ordered) {
    if (record.type !== 'user/message' || Number(record.seq) < Number(start?.seq ?? 0) || Number(record.seq) > toSeq) continue
    const window = await sessionQuery.readEvent({ sessionId, seq: Number(record.seq), before: 0, after: 0 })
    const source = window?.target?.data?.source
    if (isChannelUserMessage(window?.target?.data) || (source && source.kind !== 'user')) return []
  }
  for (const record of ordered) {
    const seq = Number(record.seq)
    if (!Number.isInteger(seq) || seq < fromSeq || seq > toSeq) continue
    if (!MESSAGE_TYPES.has(record.type)) continue
    // compaction 换掉的旧内容不参与提取
    if (record.surface && record.surface !== 'current') continue

    const window = await sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 })
    const event = window && window.target
    if (!event) continue
    const content = event.type === 'user/message' ? event.data?.content : event.data?.message?.content
    const text = messageText(content)
    if (text.trim() === '') continue

    records.push({
      recordId: makeRecordId(sessionId, seq),
      seq,
      sourceKind: event.type === 'user/message' ? 'user_message' : 'assistant_message',
      observedAt: toIsoTime(event.time),
      text,
    })
  }
  records.sort((a, b) => a.seq - b.seq)
  return records
}
