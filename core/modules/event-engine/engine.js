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
import { resolve } from 'node:path'
import { PRESET } from '../../contracts/spec.js'
import { PROMPT_VERSION } from './extraction/prompt.js'

const nowIso = () => new Date().toISOString()

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
 *   pathSemantics: { isSamePath: Function, isWithin: Function },
 *   createTurnCollector: Function,
 * }} options
 */
export function createEventEngine({
  file,
  workspaceRoot,
  preset = FISH_PRESET,
  maxRecordsPerTurn = 400,
  logger = null,
  now = nowIso,
  pathSemantics,
  createTurnCollector,
  persistence,
}) {
  // 工作区根是身份配对的一半，必须有；没有它就无法联合判断。
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new Error('createEventEngine: workspaceRoot is required (fish identity = workspace + preset)')
  }
  if (!pathSemantics || typeof pathSemantics.isSamePath !== 'function' || typeof pathSemantics.isWithin !== 'function') {
    throw new TypeError('createEventEngine: pathSemantics is required')
  }
  if (typeof createTurnCollector !== 'function') throw new TypeError('createEventEngine: createTurnCollector is required')
  const requiredPersistence = ['openEventDatabase', 'recoverExpiredLeases', 'insertAudit', 'enqueueJob', 'writeCursor', 'claimJobs', 'finishJob', 'insertEvents', 'countJobs', 'countAudits', 'countEvents', 'readCursor', 'listEvents', 'readConsumerCursor', 'writeConsumerCursor']
  if (!persistence || requiredPersistence.some(method => typeof persistence[method] !== 'function')) throw new TypeError('createEventEngine: complete persistence adapter is required')
  const root = resolve(workspaceRoot)
  const db = persistence.openEventDatabase(file)
  const recoveredLeases = persistence.recoverExpiredLeases(db, now())

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
      persistence.insertAudit(db, {
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
    if (!session || session.social === true) return false
    // Subagent sessions inherit their parent's workspace but are not owner turns.
    if (session.origin === 'subagent' || Number(session.delegationDepth ?? 0) > 0) return false
    if (session.preset !== preset) return false
    const cwd = typeof session.workspacePath === 'string' ? resolve(session.workspacePath) : ''
    if (cwd === '') return false
    return pathSemantics.isSamePath(root, cwd) || pathSemantics.isWithin(root, cwd)
  }

  /* ---------------- turn → job ---------------- */

  const collector = createTurnCollector({
    maxRecordsPerTurn,
    onTurn(turn) {
      const createdAt = now()
      const inserted = persistence.enqueueJob(db, {
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
      audit({ sessionId: skip.sessionId, turn: skip.turn, decision: 'skipped', reasonCode: skip.reason,
        ...(skip.provenance ? { details: { provenance: skip.provenance } } : {}) })
    },
  })

  /* ---------------- 对外 ---------------- */

  /**
   * 接一条已归一化的会话事件。非鱼鱼会话直接忽略（返回 false），不产生任何写入。
   * @param {any} session
   * @param {any} event
   * @returns {boolean}
   */
  function feed(session, event) {
    if (!event || typeof event.type !== 'string') return false
    if (!isFishSession(session)) return false
    const sessionId = String(session.id)
    const seq = Number(event.seq)

    // Model selection is supplied by the Host adapter; absent metadata uses its default.
    if (typeof session.modelId === 'string' && session.modelId) modelBySession.set(sessionId, session.modelId)

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
      if (Number.isInteger(seq)) persistence.writeCursor(db, sessionId, seq)
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
    return persistence.claimJobs(db, { limit, leaseMs, now: now() })
  }

  function settleJob(jobId, outcome) {
    persistence.finishJob(db, jobId, outcome)
  }

  function storeEvents(events) {
    return persistence.insertEvents(db, events)
  }

  function stats() {
    const raw = persistence.countJobs(db)
    const jobs = {
      pending: raw.pending ?? 0,
      processing: raw.processing ?? 0,
      succeeded: raw.succeeded ?? 0,
      skipped: raw.skipped ?? 0,
      failed_retryable: raw.failed_retryable ?? 0,
      dead_letter: raw.dead_letter ?? 0,
    }
    const auditing = persistence.countAudits(db)
    return {
      jobs,
      pending: jobs.pending,
      processing: jobs.processing,
      failed: jobs.failed_retryable + jobs.dead_letter,
      events: persistence.countEvents(db),
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
    getCursor: (sessionId) => persistence.readCursor(db, String(sessionId)),
    listEvents: (query) => persistence.listEvents(db, query),
    getConsumerCursor: (consumerId) => persistence.readConsumerCursor(db, consumerId),
    setConsumerCursor: (consumerId, seq) => persistence.writeConsumerCursor(db, consumerId, seq),
    close() {
      try {
        db.close()
      } catch (ignored) {
        /* already closed */
      }
    },
  }
}
