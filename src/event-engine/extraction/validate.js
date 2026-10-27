/**
 * 大肥鱼模块 0 · 校验层。
 *
 * 两层校验，缺一不可：
 *   P3-a 结构校验：模型原始输出 vs JSON Schema（严格、拒绝多余键）。
 *   P3-b 语义校验：登记表交叉校验 + 原文锚定 + 来源/主体一致性（不变量 I1/I2）。
 *
 * 拒绝一律带 reason code，写入 extraction_audit，不静默丢弃。
 */
import { describeType, isRegisteredType, qualifyType, SCHEMA_VERSION } from '../domain/event-types.js'
import { actorRefForSource, locateQuote } from '../domain/contracts.js'
import { MODEL_OUTPUT_SCHEMA } from './schema.js'

/* ------------------------------------------------------------------ *
 * 迷你 JSON Schema 校验器（只覆盖 schema.js 用到的子集）
 * ------------------------------------------------------------------ */

const TYPE_CHECKS = {
  object: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
}

function matchesType(value, type) {
  const check = TYPE_CHECKS[type]
  return check ? check(value) : true
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => (node == null ? undefined : node[key]), root)
}

function checkNode(value, schema, root, path, errors) {
  if (!schema || typeof schema !== 'object') return
  if (schema.$ref) {
    const target = resolveRef(root, schema.$ref)
    if (target) checkNode(value, target, root, path, errors)
    return
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, code: 'const', detail: 'expected ' + JSON.stringify(schema.const) })
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) {
    errors.push({ path, code: 'enum', detail: 'got ' + JSON.stringify(value) })
    return
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) {
      errors.push({ path, code: 'type', detail: 'expected ' + types.join('|') })
      return
    }
  }
  if (matchesType(value, 'string')) {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path, code: 'minLength', detail: String(schema.minLength) })
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path, code: 'maxLength', detail: String(schema.maxLength) })
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, code: 'pattern', detail: String(schema.pattern) })
    }
    return
  }
  if (matchesType(value, 'array')) {
    if (schema.items) {
      value.forEach((entry, index) => checkNode(entry, schema.items, root, path + '[' + index + ']', errors))
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push({ path, code: 'maxItems', detail: String(schema.maxItems) })
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({ path, code: 'minItems', detail: String(schema.minItems) })
    }
    return
  }
  if (matchesType(value, 'object')) {
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
        errors.push({ path: path + '.' + key, code: 'required', detail: 'missing' })
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      const childPath = path + '.' + key
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        checkNode(entry, properties[key], root, childPath, errors)
      } else if (schema.additionalProperties === false) {
        errors.push({ path: childPath, code: 'extra_property', detail: 'not in schema' })
      }
    }
  }
}

/**
 * @param {unknown} value
 * @param {object} schema
 * @returns {{ ok: boolean, errors: Array<{ path: string, code: string, detail: string }> }}
 */
export function validateAgainstSchema(value, schema) {
  const errors = []
  checkNode(value, schema, schema, '$', errors)
  return { ok: errors.length === 0, errors }
}

/* ------------------------------------------------------------------ *
 * 模型输出 → 候选事件
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Candidate
 * @property {string} category
 * @property {string} type
 * @property {string} actorRef
 * @property {string} action
 * @property {{ kind: string, value: string } | null} target
 * @property {string} polarity
 * @property {string} modality
 * @property {string} timeExpression
 * @property {{ recordId: string, seq: number, quote: string, spanStart: number, spanEnd: number }} sourceRef
 */

/**
 * 模型经常在 JSON 前后夹散文/思考过程/``` 围栏。这里按括号配对切出第一个
 * 完整的对象块（正确处理字符串内的引号与转义），切不出来就原样返回让 parse 失败。
 * @param {unknown} text
 * @returns {string}
 */
export function extractJsonCandidate(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  if (start < 0) return trimmed
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < trimmed.length; index += 1) {
    const ch = trimmed[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return trimmed.slice(start, index + 1)
    }
  }
  return trimmed
}

/**
 * 第一层：把模型原始文本变成合法 JSON 并过 Schema。
 * @param {unknown} raw 模型返回的字符串或已解析对象
 * @returns {{ ok: true, output: any } | { ok: false, reason: string, detail: string, rejects: Array<object> }}
 */
export function parseAndValidateOutput(raw) {
  let output = raw
  if (typeof raw === 'string') {
    const text = extractJsonCandidate(raw)
    try {
      output = JSON.parse(text)
    } catch (error) {
      return {
        ok: false,
        reason: 'invalid_json',
        detail: String(error && error.message ? error.message : error),
        rejects: [{ path: '$', code: 'invalid_json', detail: 'unparsable model output' }],
      }
    }
  }
  const result = validateAgainstSchema(output, MODEL_OUTPUT_SCHEMA)
  if (!result.ok) {
    return { ok: false, reason: 'schema_invalid', detail: result.errors[0]?.code ?? 'schema', rejects: result.errors }
  }
  if (output.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'schema_version_mismatch',
      detail: String(output.schemaVersion),
      rejects: [{ path: '$.schemaVersion', code: 'schema_version_mismatch', detail: String(output.schemaVersion) }],
    }
  }
  return { ok: true, output }
}

/**
 * 第二层：逐条候选做登记表 / 原文锚定 / 来源一致性校验。
 * 单条被拒不影响同批其它候选（同源多条不同含义事件允许并存）。
 *
 * @param {any} output 已通过 Schema 的输出
 * @param {import('../domain/contracts.js').TurnInput} turn
 * @param {{ allowedTypes?: readonly string[] }} [options]
 * @returns {{ candidates: Candidate[], rejections: Array<{ reason: string, detail: string, raw: unknown }> }}
 */
export function validateCandidates(output, turn, options = {}) {
  /** @type {Candidate[]} */
  const candidates = []
  const rejections = []
  const records = new Map(turn.records.map((record) => [record.recordId, record]))
  const allowed = options.allowedTypes && options.allowedTypes.length > 0 ? new Set(options.allowedTypes) : undefined

  for (const raw of output.events) {
    const reject = (reason, detail) => rejections.push({ reason, detail, raw })

    const qualified = qualifyType(raw.category, raw.type)
    if (!qualified || !isRegisteredType(qualified)) {
      reject('unknown_type', String(raw.category) + '/' + String(raw.type))
      continue
    }
    const contract = describeType(qualified)
    if (contract.category !== raw.category) {
      reject('type_category_mismatch', raw.category + ' vs ' + qualified)
      continue
    }
    if (allowed && !allowed.has(qualified)) {
      reject('type_not_allowed', qualified)
      continue
    }
    if (raw.action !== undefined && raw.action !== contract.action) {
      reject('action_mismatch', raw.action + ' vs ' + contract.action)
      continue
    }
    if (!contract.polarities.includes(raw.polarity)) {
      reject('polarity_not_allowed', qualified + ' / ' + raw.polarity)
      continue
    }
    if (!contract.modalities.includes(raw.modality)) {
      reject('modality_not_allowed', qualified + ' / ' + raw.modality)
      continue
    }
    if (contract.targetRequired && (raw.target === undefined || raw.target.trim() === '')) {
      reject('target_required', qualified)
      continue
    }

    const record = records.get(raw.sourceRecordId)
    if (!record) {
      reject('unknown_record', String(raw.sourceRecordId))
      continue
    }
    const expectedActor = actorRefForSource(record.sourceKind)
    if (raw.actor !== undefined && raw.actor !== expectedActor) {
      reject('actor_mismatch', raw.actor + ' vs ' + expectedActor)
      continue
    }
    const span = locateQuote(record.text, raw.sourceQuote)
    if (!span) {
      reject('quote_not_found', raw.sourceQuote)
      continue
    }
    // 时间表达也必须逐字出现在原文里，否则一律丢弃（模型会编「下次」这类词）。
    const timeExpression =
      typeof raw.timeExpression === 'string' && raw.timeExpression.length > 0 && record.text.includes(raw.timeExpression)
        ? raw.timeExpression
        : ''

    candidates.push({
      category: raw.category,
      type: qualified,
      actorRef: expectedActor,
      action: contract.action,
      target: raw.target === undefined || raw.target.trim() === ''
        ? null
        : { kind: raw.targetKind ?? 'other', value: raw.target.trim() },
      polarity: raw.polarity,
      modality: raw.modality,
      timeExpression,
      sourceRef: {
        recordId: record.recordId,
        seq: record.seq,
        quote: raw.sourceQuote,
        spanStart: span.spanStart,
        spanEnd: span.spanEnd,
      },
    })
  }
  return { candidates, rejections }
}
