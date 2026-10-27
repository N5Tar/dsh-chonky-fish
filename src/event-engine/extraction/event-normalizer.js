/**
 * 大肥鱼模块 0 · 候选事件 → 正式语义事件。
 *
 * 这里之后的所有字段都是程序赋值，不再采信模型：
 *   eventId / schemaVersion / sessionId / actorRef / action / evidenceStatus /
 *   observedAt / occurredAt / sourceRefs / dedupeKey / classifier / attributes。
 *
 * V1 不解析相对时间（"昨天"："最近"）→ occurredAt 一律 null，
 * 原表达保留在 attributes.timeExpression 里（设计文档 §6.4：只在无歧义时解析）。
 */
import { randomUUID } from 'node:crypto'
import { RULE_VERSION, SCHEMA_VERSION } from '../domain/event-types.js'
import { canonicalDedupeKey, evidenceStatusForModality, makeRecordId } from '../domain/contracts.js'

/**
 * @param {{
 *   candidates: import('./validate.js').Candidate[],
 *   turn: import('../domain/contracts.js').TurnInput,
 *   classifier: { model: string, promptVersion: string, runId: string },
 * }} input
 * @returns {import('../domain/contracts.js').SemanticEvent[]}
 */
export function normalizeCandidates({ candidates, turn, classifier }) {
  /** @type {import('../domain/contracts.js').SemanticEvent[]} */
  const events = []
  const seen = new Set()

  for (const candidate of candidates) {
    const dedupeKey = canonicalDedupeKey({
      recordId: candidate.sourceRef.recordId,
      spanStart: candidate.sourceRef.spanStart,
      spanEnd: candidate.sourceRef.spanEnd,
      type: candidate.type,
      actorRef: candidate.actorRef,
      target: candidate.target ? candidate.target.value : '',
      ruleVersion: RULE_VERSION,
    })
    // 同批内同源同 span 同含义只留一条；跨批/重启的幂等由 events 表唯一键兜底。
    const batchKey = dedupeKey + '|' + SCHEMA_VERSION
    if (seen.has(batchKey)) continue
    seen.add(batchKey)

    events.push({
      eventId: randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      sessionId: turn.sessionId,
      category: candidate.category,
      type: candidate.type,
      actorRef: candidate.actorRef,
      action: candidate.action,
      ...(candidate.target ? { target: { kind: candidate.target.kind, value: candidate.target.value } } : {}),
      polarity: candidate.polarity,
      evidenceStatus: evidenceStatusForModality(candidate.modality),
      occurredAt: null,
      observedAt: turn.observedAt,
      sourceRefs: [
        {
          recordId: makeRecordId(turn.sessionId, candidate.sourceRef.seq),
          seq: candidate.sourceRef.seq,
          quote: candidate.sourceRef.quote,
          spanStart: candidate.sourceRef.spanStart,
          spanEnd: candidate.sourceRef.spanEnd,
        },
      ],
      classifier: {
        model: classifier.model,
        promptVersion: classifier.promptVersion,
        runId: classifier.runId,
      },
      dedupeKey,
      attributes: {
        modality: candidate.modality,
        ruleVersion: RULE_VERSION,
        targetKind: candidate.target ? candidate.target.kind : null,
        timeExpression: candidate.timeExpression || null,
      },
    })
  }
  return events
}
