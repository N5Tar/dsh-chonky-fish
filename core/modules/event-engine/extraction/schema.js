/**
 * 大肥鱼模块 0 · 模型输出契约（JSON Schema 子集，程序侧唯一校验依据）。
 *
 * 模型只返回候选事件，不得决定：eventId、actorRef、evidenceStatus、observedAt、
 * occurredAt、sourceRefs 的 span、dedupeKey、classifier —— 这些全部由程序赋值。
 *
 * 写法遵循设计文档 §5.3/§7.3：`category` 与短 `type`（如 `like_expressed`）分开给，
 * 全限定名（`preference.like_expressed`）由 domain/event-types.js#qualifyType 补全。
 * 因此 schema 里 type 只约束成字符串，词表校验在 validate.js 的语义层做。
 *
 * schema 里的关键字只用到本仓库自带迷你校验器（validate.js）支持的子集：
 * type / const / enum / required / additionalProperties / properties /
 * items / maxItems / minItems / minLength / maxLength / pattern / $ref。
 */
import { ALL_POLARITIES, CATEGORIES, MODALITIES, SCHEMA_VERSION, TARGET_KINDS } from '../domain/event-types.js'

/**
 * 单条候选事件。
 * additionalProperties: false —— 模型想夹带 toolVerified / eventId 之类会被拒。
 */
export const EVENT_CANDIDATE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['category', 'type', 'polarity', 'modality', 'sourceRecordId', 'sourceQuote'],
  additionalProperties: false,
  properties: {
    category: { enum: CATEGORIES },
    type: { type: 'string', minLength: 3, maxLength: 80 },
    actor: { type: 'string', maxLength: 64 },
    action: { type: 'string', maxLength: 64 },
    target: { type: 'string', minLength: 1, maxLength: 120 },
    targetKind: { enum: TARGET_KINDS },
    polarity: { enum: ALL_POLARITIES },
    modality: { enum: MODALITIES },
    sourceRecordId: { type: 'string', minLength: 1, maxLength: 200 },
    sourceQuote: { type: 'string', minLength: 1, maxLength: 500 },
    timeExpression: { type: 'string', minLength: 1, maxLength: 40 },
  },
})

export const MODEL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['schemaVersion', 'events'],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    events: {
      type: 'array',
      maxItems: 8,
      items: { $ref: '#/$defs/event' },
    },
    noEventReason: {
      enum: ['small_talk', 'no_semantic_content', 'uncertain', null],
    },
  },
  $defs: { event: EVENT_CANDIDATE_SCHEMA },
})
