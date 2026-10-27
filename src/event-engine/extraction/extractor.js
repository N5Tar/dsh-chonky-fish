/**
 * 大肥鱼模块 0 · 模型调用 + 解析（P2）。
 *
 * 模型 = 这条鱼鱼会话自己的模型（由 preset 决定，和聊天同一个）。
 * 失败处理保守：格式错误只做**一次**受限修复重试，绝不通过猜测补齐原文引用。
 */
import { buildMessages, buildTurnInput, PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.js'
import { parseAndValidateOutput } from './validate.js'

/**
 * 把 job.model_id（"provider/model"）还原成路由；取不到就用兜底选择。
 * model 里可能自带斜杠，所以只按第一个斜杠切。
 */
export function resolveModelFromId(modelId, fallback = { provider: '', model: '' }) {
  if (typeof modelId === 'string') {
    const at = modelId.indexOf('/')
    if (at > 0 && at < modelId.length - 1) {
      return { provider: modelId.slice(0, at), model: modelId.slice(at + 1) }
    }
  }
  return fallback
}

const REPAIR_INSTRUCTION =
  '上一次输出不是合法 JSON 或不符合 Schema。只输出修正后的 JSON，不要解释、不要改事件内容。' +
  '如果无法修正，输出 {"schemaVersion":"1.0","events":[],"noEventReason":"uncertain"}。'

/**
 * @param {{
 *   llm: { stream: (options: any) => AsyncIterable<any> },
 *   resolveModel: (modelId?: string | null) => { provider: string, model: string },
 *   temperature?: number,
 *   maxTokens?: number | null,
 *   logger?: { warn: (...args: any[]) => void } | null,
 * }} options
 *
 * 不传 maxTokens 就不限制输出长度（2026-10-27 拍板）：宁可多花一点 token，
 * 也不要把 JSON 截断成非法输出。
 */
export function createExtractor({ llm, resolveModel, temperature = 0.1, maxTokens = null, logger = null }) {
  function warn(message, error) {
    if (!logger) return
    try {
      logger.warn('[chonkyfish/extractor] ' + message, error)
    } catch (ignored) {
      /* best effort */
    }
  }

  async function callModel({ provider, model, messages, signal }) {
    let text = ''
    let usage = null
    let finish = null
    const request = {
      provider,
      model,
      system: SYSTEM_PROMPT,
      messages,
      temperature,
      signal,
    }
    if (typeof maxTokens === 'number' && maxTokens > 0) request.maxTokens = maxTokens
    const stream = llm.stream(request)
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
      const failure = finish.failure ?? {}
      const error = new Error(failure.message || '模型调用失败')
      error.code = failure.code || finish.kind
      throw error
    }
    return { text, usage, finishKind: finish && finish.kind ? finish.kind : 'unknown' }
  }

  /** 修复重试：把上一次输出塞回同一条 user 消息里，保持单轮对话形状。 */
  function buildRepairMessages(messages, previousText) {
    const base = messages[0]
    const baseText = base.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    return [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: baseText + '\n\n上一次的输出（需要修正格式）：\n' + previousText + '\n\n' + REPAIR_INSTRUCTION,
          },
        ],
      },
    ]
  }

  /**
   * @returns {Promise<
   *   { ok: true, output: any, repaired: boolean, selection: { provider: string, model: string }, usage: any } |
   *   { ok: false, code: string, detail: string, repaired: boolean, selection: { provider: string, model: string }, usage: any }
   * >}
   */
  async function extract({ turn, records, allowedTypes = null, signal, modelId = null }) {
    const selection = resolveModel(modelId)
    const input = buildTurnInput({ turn, records, allowedTypes })
    const messages = buildMessages(input)

    let repaired = false
    let raw = ''
    let usage = null
    let parsed = null
    let finishKind = 'unknown'

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const payload = attempt === 0 ? messages : buildRepairMessages(messages, raw)
      const result = await callModel({ provider: selection.provider, model: selection.model, messages: payload, signal })
      raw = result.text
      usage = result.usage ?? usage
      finishKind = result.finishKind
      parsed = parseAndValidateOutput(raw)
      if (parsed.ok) break
      const repairable = parsed.reason === 'invalid_json' || parsed.reason === 'schema_invalid'
      if (!repairable) break
      repaired = true
      warn('模型输出格式不合法，尝试一次修复重试', parsed.detail)
    }

    if (!parsed || !parsed.ok) {
      return {
        ok: false,
        code: (repaired ? parsed?.reason + '_after_repair' : parsed?.reason) || 'extract_failed',
        detail: parsed?.detail ?? 'unknown',
        repaired,
        selection,
        usage,
        rawLength: raw.length,
        finishKind,
      }
    }
    return { ok: true, output: parsed.output, repaired, selection, usage, rawLength: raw.length, finishKind }
  }

  return { extract, promptVersion: PROMPT_VERSION }
}
