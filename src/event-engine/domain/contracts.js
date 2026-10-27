/**
 * 大肥鱼模块 0 · 数据契约与纯函数工具。
 *
 * 与《模块0 V1 技术详细设计》§5 的差异（2026-10-27 拍板）：
 *   - 删掉 RawRecord 表：原始内容以「DSH 会话日志 + (sessionId, seq)」为准，
 *     我们只保存引用。recordId 统一表达为 `<sessionId>:<seq>`。
 *   - 删掉 sensitivity / payloadHash / sourceExternalId：前者不再外发分级，
 *     后者由 `(sessionId, seq)` 天然唯一取代。
 *   - EvidenceStatus 只保留语言事件可产生的那几个值。
 */
import { createHash } from 'node:crypto'

export const SOURCE_KINDS = Object.freeze(['user_message', 'assistant_message'])

/** 主体由来源种类决定，模型无权指定（不变量 I1）。 */
export const ACTOR_BY_SOURCE = Object.freeze({
  user_message: 'owner',
  assistant_message: 'persona:dafeiyu',
})

export const EVIDENCE_BY_MODALITY = Object.freeze({
  asserted: 'reported',
  intended: 'intent',
  hypothetical: 'hypothetical',
  negated: 'negated',
  uncertain: 'uncertain',
})

/**
 * @typedef {'user_message' | 'assistant_message'} SourceKind
 *
 * @typedef {object} TurnRecord
 * @property {string} recordId       `<sessionId>:<seq>`
 * @property {number} seq            DSH 会话日志序号
 * @property {SourceKind} sourceKind
 * @property {string} observedAt     该条事件的 UTC ISO 时间
 * @property {string} text           归一化后的纯文本（内容权威副本在 DSH 日志）
 *
 * @typedef {object} TurnInput
 * @property {string} sessionId
 * @property {number} turn
 * @property {string} observedAt
 * @property {TurnRecord[]} records
 *
 * @typedef {object} SourceRef
 * @property {string} recordId
 * @property {number} seq
 * @property {string} quote
 * @property {number} spanStart
 * @property {number} spanEnd
 * @property {string} [toolExecutionId]
 *
 * @typedef {object} EventTarget
 * @property {string} kind
 * @property {string} value
 * @property {string} [ref]
 *
 * @typedef {object} SemanticEvent
 * @property {string} eventId
 * @property {string} schemaVersion
 * @property {string} sessionId
 * @property {string} category
 * @property {string} type
 * @property {string} actorRef
 * @property {string} action
 * @property {EventTarget} [target]
 * @property {string} polarity
 * @property {string} evidenceStatus
 * @property {string | null} occurredAt
 * @property {string} observedAt
 * @property {SourceRef[]} sourceRefs
 * @property {{ model: string, promptVersion: string, runId: string }} [classifier]
 * @property {string} dedupeKey
 * @property {Record<string, string | number | boolean | null>} attributes
 */

/**
 * @param {string} sessionId
 * @param {number} seq
 * @returns {string}
 */
export function makeRecordId(sessionId, seq) {
  return sessionId + ':' + seq
}

/**
 * @param {string} recordId
 * @returns {{ sessionId: string, seq: number } | null}
 */
export function parseRecordId(recordId) {
  if (typeof recordId !== 'string') return null
  const at = recordId.lastIndexOf(':')
  if (at <= 0) return null
  const seq = Number(recordId.slice(at + 1))
  if (!Number.isInteger(seq) || seq < 0) return null
  return { sessionId: recordId.slice(0, at), seq }
}

/**
 * 从 DSH 消息内容块里取纯文本。内容块的唯一合法解释就在这里，
 * 预过滤、原文锚定、prompt 打包都必须走这个函数，保证 span 一致。
 * @param {unknown} content
 * @returns {string}
 */
export function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * 只在比较用途上归一化（去空白、全角折半角、小写），不改写任何入库原文。
 * @param {string} text
 * @returns {string}
 */
export function normalizeForCompare(text) {
  return String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * @param {SourceKind | string} sourceKind
 * @returns {string}
 */
export function actorRefForSource(sourceKind) {
  return ACTOR_BY_SOURCE[sourceKind] ?? 'unknown'
}

/**
 * 语言形态 → 程序裁定的事实地位。模型永远不决定 evidenceStatus。
 * @param {string} modality
 * @returns {string}
 */
export function evidenceStatusForModality(modality) {
  return EVIDENCE_BY_MODALITY[modality] ?? 'uncertain'
}

/**
 * 稳定去重键：同源 + 同 span + 同 type + 同主体 + 同 target + 同规则版本。
 * @param {{ recordId: string, spanStart: number, spanEnd: number, type: string, actorRef: string, target?: string, ruleVersion: string }} parts
 * @returns {string}
 */
export function canonicalDedupeKey(parts) {
  const payload = JSON.stringify([
    parts.recordId,
    parts.spanStart,
    parts.spanEnd,
    parts.type,
    parts.actorRef,
    normalizeForCompare(parts.target ?? ''),
    parts.ruleVersion,
  ])
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * 在原文中定位引文。要求逐字出现，不做模糊匹配。
 * @param {string} text
 * @param {string} quote
 * @returns {{ spanStart: number, spanEnd: number } | null}
 */
export function locateQuote(text, quote) {
  if (typeof text !== 'string' || typeof quote !== 'string' || quote.length === 0) return null
  const at = text.indexOf(quote)
  if (at < 0) return null
  return { spanStart: at, spanEnd: at + quote.length }
}
