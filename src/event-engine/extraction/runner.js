/**
 * 大肥鱼模块 0 · 提取任务执行器（P2）。
 *
 * 一个 job = 一个 turn。流程：
 *   领取（带租约） → 从 DSH 读回该 turn 原文 → 调模型 → 解析/校验 → 归一化 →
 *   写 events（去重键保证重放幂等）→ 结算 job → 写审计
 *
 * 失败：最多 3 次，指数退避 3s / 15s / 60s；超过就 dead_letter，不制造假事件。
 */
import { normalizeCandidates } from './event-normalizer.js'
import { loadTurnRecords } from './payload.js'
import { validateCandidates } from './validate.js'

export const MAX_ATTEMPTS = 3
export const BACKOFF_MS = Object.freeze([3_000, 15_000, 60_000])

/**
 * @param {{
 *   engine: ReturnType<typeof import('../engine.js').createEventEngine>,
 *   extractor: ReturnType<typeof import('./extractor.js').createExtractor>,
 *   sessionQuery: any,
 *   allowedTypes?: readonly string[] | null,
 *   maxAttempts?: number,
 *   logger?: { warn: (...args: any[]) => void } | null,
 *   now?: () => string,
 * }} options
 */
export function createExtractionRunner({
  engine,
  extractor,
  sessionQuery,
  allowedTypes = null,
  maxAttempts = MAX_ATTEMPTS,
  logger = null,
  now = () => new Date().toISOString(),
}) {
  function warn(message, error) {
    if (!logger) return
    try {
      logger.warn('[chonkyfish/runner] ' + message, error)
    } catch (ignored) {
      /* best effort */
    }
  }

  function audit(job, decision, reasonCode, details) {
    engine.audit({ sessionId: job.sessionId, turn: job.turn, jobId: job.jobId, decision, reasonCode, details })
  }

  function modelLabel(selection) {
    return selection ? selection.provider + '/' + selection.model : undefined
  }

  function retryAt(attempts) {
    const delay = BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_MS.length - 1)]
    return new Date(Date.parse(now()) + delay).toISOString()
  }

  /** 失败结算：能重试就退避，次数用尽就进死信。 */
  function settleFailure(job, code, selection, error) {
    const attempts = Number(job.attempts) || 1
    if (attempts >= maxAttempts) {
      engine.settleJob(job.jobId, { status: 'dead_letter', errorCode: code, modelId: modelLabel(selection) })
      audit(job, 'failed', code, { deadLetter: true, attempts, detail: error ? String(error.message || error) : undefined })
      return 'deadLetter'
    }
    engine.settleJob(job.jobId, {
      status: 'failed_retryable',
      errorCode: code,
      nextAttemptAt: retryAt(attempts),
      modelId: modelLabel(selection),
    })
    audit(job, 'failed', code, { attempts, retryIn: retryAt(attempts), detail: error ? String(error.message || error) : undefined })
    return 'retrying'
  }

  async function processJob(job, signal) {
    let records
    try {
      records = await loadTurnRecords({
        sessionQuery,
        sessionId: job.sessionId,
        fromSeq: job.fromSeq,
        toSeq: job.toSeq,
      })
    } catch (error) {
      return settleFailure(job, 'payload_unavailable', null, error)
    }
    if (records.length === 0) {
      engine.settleJob(job.jobId, { status: 'skipped', errorCode: 'empty_payload' })
      audit(job, 'skipped', 'empty_payload')
      return 'skipped'
    }

    const turn = {
      sessionId: job.sessionId,
      turn: job.turn,
      observedAt: records[records.length - 1].observedAt,
      records,
    }

    let result
    try {
      result = await extractor.extract({ turn, records, allowedTypes, signal, modelId: job.modelId })
    } catch (error) {
      return settleFailure(job, (error && error.code) || 'llm_failed', null, error)
    }
    if (!result.ok) return settleFailure(job, result.code, result.selection, null)

    if (result.repaired) audit(job, 'repaired', 'format_repaired')

    const { candidates, rejections } = validateCandidates(result.output, turn, allowedTypes ? { allowedTypes } : {})
    for (const rejection of rejections) {
      audit(job, 'rejected', rejection.reason, { detail: rejection.detail, raw: rejection.raw })
    }

    const events = normalizeCandidates({
      candidates,
      turn,
      classifier: {
        model: modelLabel(result.selection),
        promptVersion: extractor.promptVersion,
        runId: job.jobId,
      },
    })

    if (events.length === 0) {
      const reason = result.output && result.output.noEventReason ? String(result.output.noEventReason) : 'no_events'
      engine.settleJob(job.jobId, { status: 'skipped', errorCode: reason, modelId: modelLabel(result.selection) })
      audit(job, 'skipped', 'no_events', { reason, candidates: 0 })
      return 'skipped'
    }

    const stored = engine.storeEvents(events)
    if (stored.inserted === 0) audit(job, 'observed', 'duplicate_events', { events: events.length })
    engine.settleJob(job.jobId, { status: 'succeeded', modelId: modelLabel(result.selection) })
    return 'succeeded'
  }

  /**
   * 跑一轮：领取至多 limit 个任务并处理完。
   * @returns {Promise<{ processed: number, succeeded: number, skipped: number, retrying: number, deadLetter: number }>}
   */
  async function runOnce({ limit = 3, signal } = {}) {
    const jobs = engine.takeJobs(limit)
    const summary = { processed: 0, succeeded: 0, skipped: 0, retrying: 0, deadLetter: 0 }
    for (const job of jobs) {
      summary.processed += 1
      try {
        const outcome = await processJob(job, signal)
        summary[outcome] += 1
      } catch (error) {
        warn('任务处理异常（已转为可重试）', error)
        const outcome = settleFailure(job, 'runner_exception', null, error)
        summary[outcome] += 1
      }
    }
    return summary
  }

  return { runOnce }
}
