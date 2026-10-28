/**
 * 大肥鱼模块 0 · 事件引擎（Host 侧半层，P1 采集）。
 *
 * 识别规则（2026-10-27 最终）：**联合判断**。
 *
 * 鱼鱼会话的身份是一个「(项目, preset) 配对」：
 *     ( 鱼鱼工作区 , 'chonkyfish' )
 * 会话必须同时落在这个配对里才算鱼鱼对话——不拆成两条互不相干的过滤条件，
 * 也不允许只满足其中一项就放行：
 *
 *   项目对 + preset 错  → 不是鱼鱼（同项目里跑的是别的 agent）
 *   项目错 + preset 对  → 不是鱼鱼（别的项目里恰好选了鱼鱼 preset）
 *   两个都错            → 不是鱼鱼
 *
 * 另外 subagent 子会话（`origin === 'subagent'` 或 `delegationDepth > 0`）一律不是：
 * 孩子会话继承父会话的 cwd，但它们不是和主人的对话。
 *
 * 采集边界：只跟活着的会话（`session/event`），不回补历史；重启时缺 `turn/start`
 * 的 turn 直接跳过并记审计（`turn_not_buffered`）。
 */
import { randomUUID } from 'node:crypto'
import { resolve, sep } from 'node:path'

import { PRESET } from '../resources/spec.js'
import { isSocialHeader } from '../social/policy.js'
import { createTurnCollector } from './adapters/dsh-source.js'
import { PROMPT_VERSION } from './extraction/prompt.js'
import {
  claimJobs,
  countAudits,
  countEvents,
  countJobs,
  enqueueJob,
  finishJob,
  insertAudit,
  insertEvents,
  listEvents,
  nowIso,
  openEventDatabase,
  readConsumerCursor,
  readCursor,
  recoverExpiredLeases,
  writeConsumerCursor,
  writeCursor,
} from './persistence/sqlite.js'

/**
 * 鱼鱼会话身份配对里的 preset 半边，来自资源规格（单一事实源）。
 * 另半边（工作区根）由资源管理模块给出的 `workspaceRoot` 传入：
 * 二者合起来才是身份，缺一项就不是鱼鱼会话。
 */
export const FISH_PRESET = PRESET
export { PROMPT_VERSION }

/**
 * @param {{
 *   file: string,
 *   workspaceRoot: string,
 *   preset?: string,
 *   maxRecordsPerTurn?: number,
 *   logger?: { warn: (...args: any[]) => void },
 *   now?: () => string,
 * }} options
 */
export function createEventEngine({
  file,
  workspaceRoot,
  preset = FISH_PRESET,
  maxRecordsPerTurn = 400,
  logger = null,
  now = nowIso,
}) {
  const db = openEventDatabase(file)
  const recoveredLeases = recoverExpiredLeases(db, now())
  // 工作区根是身份配对的一半，必须有；没有它就无法联合判断。
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new Error('createEventEngine: workspaceRoot is required (fish identity = workspace + preset)')
  }
  const root = resolve(workspaceRoot)

  /** @type {Map<string, number>} 进程内 seq 连续性观测（用于发现丢事件） */
  const lastSeq = new Map()
  /** @type {Map<string, string>} 会话当前模型（来自其 requestContext，preset 决定），入队时落 job.model_id */
  const modelBySession = new Map()
  const gapReported = new Set()

  function warn(message, error) {
    if (!logger) return
    try {
      logger.warn('[chonkyfish/event-engine] ' + message, error)
    } catch (ignored) {
      /* logging is best effort */
    }
  }

  function audit(entry) {
    try {
      insertAudit(db, {
        auditId: randomUUID(),
        sessionId: entry.sessionId,
        turn: entry.turn ?? 0,
        jobId: entry.jobId ?? 'none',
        decision: entry.decision,
        reasonCode: entry.reasonCode,
        details: entry.details,
      })
    } catch (error) {
      warn('审计写入失败', error)
    }
  }

  /* ---------------- 会话识别 ---------------- */

  /**
   * 联合判断：身份 = (项目, preset) 配对，一项不满足就不是鱼鱼会话。
   * 这里刻意写成单个谓词，避免以后有人把两半改成「任一满足即可」。
   */
  function isFishSession(session) {
    const header = session && session.header
    if (!header || isSocialHeader(header)) return false
    // 鱼鱼派出去干活的孩子不是和主人的对话（它们继承父会话的 cwd）
    if (header.origin === 'subagent') return false
    if (Number(header.delegationDepth ?? 0) > 0) return false
    // 配对的两半必须同时成立
    if (header.agentPreset !== preset) return false
    const cwd = typeof header.cwd === 'string' ? resolve(header.cwd) : ''
    if (cwd === '') return false
    return cwd === root || cwd.startsWith(root + sep)
  }

  /* ---------------- turn → job ---------------- */

  const collector = createTurnCollector({
    maxRecordsPerTurn,
    onTurn(turn) {
      const createdAt = now()
      const inserted = enqueueJob(db, {
        jobId: randomUUID(),
        sessionId: turn.sessionId,
        turn: turn.turn,
        fromSeq: turn.records[0].seq,
        toSeq: turn.records[turn.records.length - 1].seq,
        promptVersion: PROMPT_VERSION,
        modelId: modelBySession.get(turn.sessionId) ?? null,
        createdAt,
        updatedAt: createdAt,
      })
      if (!inserted) {
        audit({ sessionId: turn.sessionId, turn: turn.turn, decision: 'skipped', reasonCode: 'duplicate_turn' })
      }
      if (turn.truncated) {
        audit({
          sessionId: turn.sessionId,
          turn: turn.turn,
          decision: 'observed',
          reasonCode: 'turn_truncated',
          details: { keptRecords: turn.records.length, limit: maxRecordsPerTurn },
        })
      }
    },
    onSkip(skip) {
      audit({ sessionId: skip.sessionId, turn: skip.turn, decision: 'skipped', reasonCode: skip.reason })
    },
  })

  /* ---------------- 对外 ---------------- */

  /**
   * 接一条 DSH 会话事件。非鱼鱼会话直接忽略（返回 false），不产生任何写入。
   * @param {any} session
   * @param {any} event
   * @returns {boolean}
   */
  function feed(session, event) {
    if (!event || typeof event.type !== 'string') return false
    if (!isFishSession(session)) return false
    const sessionId = String(session.id ?? session.header.id)
    const seq = Number(event.seq)

    // 会话模型由 preset 决定；记下来给提取任务用（与聊天同一个模型）
    try {
      const requestContext = typeof session.requestContext === 'function' ? session.requestContext() : null
      if (requestContext && requestContext.provider && requestContext.model) {
        modelBySession.set(sessionId, requestContext.provider + '/' + requestContext.model)
      }
    } catch (ignored) {
      /* 取不到就用兜底模型 */
    }

    if (Number.isInteger(seq)) {
      const previous = lastSeq.get(sessionId)
      if (previous !== undefined && seq > previous + 1 && !gapReported.has(sessionId)) {
        gapReported.add(sessionId)
        audit({
          sessionId,
          turn: 0,
          decision: 'observed',
          reasonCode: 'seq_gap',
          details: { fromSeq: previous, toSeq: seq },
        })
      }
      lastSeq.set(sessionId, seq)
    }

    try {
      collector.feed(sessionId, event)
      if (Number.isInteger(seq)) writeCursor(db, sessionId, seq)
    } catch (error) {
      // 采集不允许把聊天拖挂：任何异常都只记录，不向上抛。
      warn('会话事件处理失败', error)
    }
    return true
  }

  /** 会话销毁/切走：丢弃半截 buffer（不补采）。 */
  function forgetSession(sessionId) {
    collector.reset(String(sessionId))
    lastSeq.delete(String(sessionId))
    gapReported.delete(String(sessionId))
    modelBySession.delete(String(sessionId))
  }

  /** P2 用：取一批待提取任务（带租约）。 */
  function takeJobs(limit = 3, leaseMs = 120_000) {
    return claimJobs(db, { limit, leaseMs, now: now() })
  }

  function settleJob(jobId, outcome) {
    finishJob(db, jobId, outcome)
  }

  function storeEvents(events) {
    return insertEvents(db, events)
  }

  function stats() {
    const raw = countJobs(db)
    const jobs = {
      pending: raw.pending ?? 0,
      processing: raw.processing ?? 0,
      succeeded: raw.succeeded ?? 0,
      skipped: raw.skipped ?? 0,
      failed_retryable: raw.failed_retryable ?? 0,
      dead_letter: raw.dead_letter ?? 0,
    }
    const auditing = countAudits(db)
    return {
      jobs,
      pending: jobs.pending,
      processing: jobs.processing,
      failed: jobs.failed_retryable + jobs.dead_letter,
      events: countEvents(db),
      audits: auditing,
      bufferedSessions: collector.size(),
      recoveredLeases,
    }
  }

  return {
    db,
    feed,
    forgetSession,
    /** 写一条审计（拒绝/跳过/观测）。 */
    audit,
    takeJobs,
    settleJob,
    storeEvents,
    stats,
    getCursor: (sessionId) => readCursor(db, String(sessionId)),
    listEvents: (query) => listEvents(db, query),
    getConsumerCursor: (consumerId) => readConsumerCursor(db, consumerId),
    setConsumerCursor: (consumerId, seq) => writeConsumerCursor(db, consumerId, seq),
    close() {
      try {
        db.close()
      } catch (ignored) {
        /* already closed */
      }
    },
  }
}
