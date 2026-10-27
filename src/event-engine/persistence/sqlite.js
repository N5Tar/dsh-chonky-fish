/**
 * 大肥鱼模块 0 · SQLite 持久化（node:sqlite，零原生依赖）。
 *
 * 分工：DSH 会话日志是原始内容权威副本；这里只存「DSH 不产生的东西」——
 * 采集游标、提取任务状态、语义事件、消费游标、提取审计。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql')

/** 打开（并迁移到当前 schema 的）事件库。 */
export function openEventDatabase(file) {
  const db = new DatabaseSync(file)
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
  return db
}

export function nowIso() {
  return new Date().toISOString()
}

/* ------------------------------------------------------------------ *
 * 采集游标
 * ------------------------------------------------------------------ */

export function readCursor(db, sessionId) {
  const row = db.prepare('SELECT last_seq FROM ingest_cursor WHERE session_id = ?').get(sessionId)
  return row ? Number(row.last_seq) : -1
}

/** 只前进不后退，防止重放/乱序把游标写回去。 */
export function writeCursor(db, sessionId, seq) {
  db.prepare(
    `INSERT INTO ingest_cursor (session_id, last_seq, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_seq = MAX(ingest_cursor.last_seq, excluded.last_seq),
       updated_at = excluded.updated_at`,
  ).run(sessionId, seq, nowIso())
}

/* ------------------------------------------------------------------ *
 * 提取任务
 * ------------------------------------------------------------------ */

/**
 * @returns {boolean} false 表示这个 turn 已经入过队（幂等）
 */
export function enqueueJob(db, job) {
  const result = db.prepare(
    `INSERT OR IGNORE INTO extraction_jobs
       (job_id, session_id, turn, from_seq, to_seq, status, attempts, next_attempt_at,
        lease_until, model_id, prompt_version, last_error_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.jobId,
    job.sessionId,
    job.turn,
    job.fromSeq,
    job.toSeq,
    job.status ?? 'pending',
    0,
    null,
    null,
    job.modelId ?? null,
    job.promptVersion,
    null,
    job.createdAt,
    job.updatedAt,
  )
  return Number(result.changes) > 0
}

export function getJob(db, jobId) {
  const row = db.prepare('SELECT * FROM extraction_jobs WHERE job_id = ?').get(jobId)
  return row ? mapJobRow(row) : null
}

/**
 * 取一批可执行任务并置为 processing（带租约，崩溃后由 recoverExpiredLeases 回收）。
 * @returns {object[]}
 */
export function claimJobs(db, { limit = 5, leaseMs = 120_000, now = nowIso() } = {}) {
  const rows = db.prepare(
    `SELECT * FROM extraction_jobs
     WHERE status IN ('pending', 'failed_retryable')
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(now, limit)
  const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString()
  const claimed = []
  for (const row of rows) {
    const result = db.prepare(
      `UPDATE extraction_jobs
       SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ?
       WHERE job_id = ? AND status IN ('pending', 'failed_retryable')`,
    ).run(leaseUntil, now, row.job_id)
    if (Number(result.changes) > 0) {
      // 注意：返回的 attempts 必须是本次领取之后的计数（UPDATE 已 +1），
      // 否则重试上限永远达不到。
      claimed.push({ ...mapJobRow(row), status: 'processing', leaseUntil, attempts: Number(row.attempts) + 1 })
    }
  }
  return claimed
}

/** 进程重启后把租约过期还卡在 processing 的孤儿任务放回 pending。 */
export function recoverExpiredLeases(db, now = nowIso()) {
  const result = db.prepare(
    `UPDATE extraction_jobs
     SET status = 'pending', lease_until = NULL, updated_at = ?
     WHERE status = 'processing' AND (lease_until IS NULL OR lease_until <= ?)`,
  ).run(now, now)
  return Number(result.changes)
}

export function finishJob(db, jobId, { status, errorCode = null, nextAttemptAt = null, modelId = null }) {
  db.prepare(
    `UPDATE extraction_jobs
     SET status = ?, lease_until = NULL, last_error_code = ?, next_attempt_at = ?,
         model_id = COALESCE(?, model_id), updated_at = ?
     WHERE job_id = ?`,
  ).run(status, errorCode, nextAttemptAt, modelId, nowIso(), jobId)
}

export function countJobs(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM extraction_jobs GROUP BY status').all()
  /** @type {Record<string, number>} */
  const counts = {}
  for (const row of rows) counts[row.status] = Number(row.n)
  return counts
}

function mapJobRow(row) {
  return {
    jobId: row.job_id,
    sessionId: row.session_id,
    turn: Number(row.turn),
    fromSeq: Number(row.from_seq),
    toSeq: Number(row.to_seq),
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/* ------------------------------------------------------------------ *
 * 语义事件
 * ------------------------------------------------------------------ */

/**
 * 批量写入；靠 UNIQUE(dedupe_key, schema_version) 做跨批/重启幂等。
 * @returns {{ inserted: number, duplicates: number, events: object[] }}
 */
export function insertEvents(db, events) {
  const statement = db.prepare(
    `INSERT OR IGNORE INTO semantic_events
       (event_id, schema_version, session_id, category, event_type, actor_ref, action,
        target_json, polarity, evidence_status, occurred_at, observed_at, source_refs_json,
        attributes_json, classifier_json, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  let inserted = 0
  let duplicates = 0
  const stored = []
  for (const event of events) {
    const result = statement.run(
      event.eventId,
      event.schemaVersion,
      event.sessionId,
      event.category,
      event.type,
      event.actorRef,
      event.action,
      event.target ? JSON.stringify(event.target) : null,
      event.polarity,
      event.evidenceStatus,
      event.occurredAt,
      event.observedAt,
      JSON.stringify(event.sourceRefs),
      JSON.stringify(event.attributes ?? {}),
      event.classifier ? JSON.stringify(event.classifier) : null,
      event.dedupeKey,
      nowIso(),
    )
    if (Number(result.changes) > 0) {
      inserted += 1
      stored.push({ ...event, eventSeq: Number(result.lastInsertRowid) })
    } else {
      duplicates += 1
    }
  }
  return { inserted, duplicates, events: stored }
}

export function countEvents(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM semantic_events').get()
  return Number(row.n)
}

export function listEvents(db, { sessionId = null, limit = 50, sinceSeq = 0 } = {}) {
  const rows = sessionId
    ? db.prepare(
      'SELECT * FROM semantic_events WHERE session_id = ? AND event_seq > ? ORDER BY event_seq ASC LIMIT ?',
    ).all(sessionId, sinceSeq, limit)
    : db.prepare('SELECT * FROM semantic_events WHERE event_seq > ? ORDER BY event_seq ASC LIMIT ?').all(sinceSeq, limit)
  return rows.map(mapEventRow)
}

function mapEventRow(row) {
  return {
    eventSeq: Number(row.event_seq),
    eventId: row.event_id,
    schemaVersion: row.schema_version,
    sessionId: row.session_id,
    category: row.category,
    type: row.event_type,
    actorRef: row.actor_ref,
    action: row.action,
    target: row.target_json ? JSON.parse(row.target_json) : null,
    polarity: row.polarity,
    evidenceStatus: row.evidence_status,
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    sourceRefs: JSON.parse(row.source_refs_json),
    classifier: row.classifier_json ? JSON.parse(row.classifier_json) : null,
    dedupeKey: row.dedupe_key,
    attributes: JSON.parse(row.attributes_json),
    createdAt: row.created_at,
  }
}

/* ------------------------------------------------------------------ *
 * 消费游标
 * ------------------------------------------------------------------ */

export function readConsumerCursor(db, consumerId) {
  const row = db.prepare('SELECT last_event_seq FROM consumer_cursor WHERE consumer_id = ?').get(consumerId)
  return row ? Number(row.last_event_seq) : 0
}

export function writeConsumerCursor(db, consumerId, lastEventSeq) {
  db.prepare(
    `INSERT INTO consumer_cursor (consumer_id, last_event_seq, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(consumer_id) DO UPDATE SET
       last_event_seq = MAX(consumer_cursor.last_event_seq, excluded.last_event_seq),
       updated_at = excluded.updated_at`,
  ).run(consumerId, lastEventSeq, nowIso())
}

/* ------------------------------------------------------------------ *
 * 审计
 * ------------------------------------------------------------------ */

export function insertAudit(db, audit) {
  db.prepare(
    `INSERT INTO extraction_audit
       (audit_id, session_id, turn, job_id, run_id, decision, reason_code, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    audit.auditId,
    audit.sessionId,
    audit.turn ?? 0,
    audit.jobId ?? 'none',
    audit.runId ?? null,
    audit.decision,
    audit.reasonCode,
    audit.details === undefined ? null : JSON.stringify(audit.details),
    nowIso(),
  )
}

export function countAudits(db) {
  const rows = db.prepare('SELECT reason_code, COUNT(*) AS n FROM extraction_audit GROUP BY reason_code').all()
  /** @type {Record<string, number>} */
  const counts = {}
  for (const row of rows) counts[row.reason_code] = Number(row.n)
  return counts
}
