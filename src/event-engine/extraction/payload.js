/**
 * 大肥鱼模块 0 · 取 turn 原文（P2）。
 *
 * 我们不复存原始内容（raw_records 已删），提取时按 job 的 (sessionId, fromSeq..toSeq)
 * 从 DSH 读回原文：`sessionQuery.listEvents` 只取元信息，`readEvent` 取全文。
 * 活着的会话和已持久化的会话都走同一套接口。
 */
import { toIsoTime } from '../adapters/dsh-source.js'
import { makeRecordId, messageText } from '../domain/contracts.js'

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
  for (const record of events ?? []) {
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
