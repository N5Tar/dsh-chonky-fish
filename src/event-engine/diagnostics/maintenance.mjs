/**
 * 大肥鱼模块 0 · 运维小工具：把死信任务放回队列。
 *
 * 用法（默认库在 $DSH_HOME/chonkyfish/events.db）：
 *   node src/event-engine/diagnostics/maintenance.mjs [dbPath] [--dry-run]
 *
 * 典型场景：改了提示词/解析器之后，想让之前失败的历史 turn 用新版本重跑一次。
 * 只重置任务状态，不动任何已发布事件——重新抽出来的重复事件会被 dedupeKey 挡住。
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { PROMPT_VERSION } from '../extraction/prompt.js'

function nowIso() {
  return new Date().toISOString()
}

/**
 * @param {DatabaseSync} db
 * @param {string} [promptVersion]
 * @returns {number} 被放回队列的任务数
 */
export function requeueDeadLetters(db, promptVersion = PROMPT_VERSION) {
  const result = db.prepare(
    `UPDATE extraction_jobs
     SET status = 'pending', attempts = 0, next_attempt_at = NULL,
         lease_until = NULL, last_error_code = NULL, prompt_version = ?, updated_at = ?
     WHERE status = 'dead_letter'`,
  ).run(promptVersion, nowIso())
  return Number(result.changes)
}

/**
 * 把所有已完成/失败的任务放回队列，用当前提示词版本重跑（改规则后用）。
 * @param {DatabaseSync} db
 * @param {string} [promptVersion]
 * @returns {number}
 */
export function requeueAllJobs(db, promptVersion = PROMPT_VERSION) {
  const result = db.prepare(
    `UPDATE extraction_jobs
     SET status = 'pending', attempts = 0, next_attempt_at = NULL,
         lease_until = NULL, last_error_code = NULL, prompt_version = ?, updated_at = ?
     WHERE status IN ('succeeded', 'skipped', 'failed_retryable', 'dead_letter')`,
  ).run(promptVersion, nowIso())
  return Number(result.changes)
}

/**
 * 清空派生数据（事件、审计、消费游标），任务表保留以便重跑。
 * @param {DatabaseSync} db
 * @returns {{ events: number, audits: number, consumers: number }}
 */
export function purgeDerivedData(db) {
  const events = db.prepare('DELETE FROM semantic_events').run()
  const audits = db.prepare('DELETE FROM extraction_audit').run()
  const consumers = db.prepare('DELETE FROM consumer_cursor').run()
  return {
    events: Number(events.changes),
    audits: Number(audits.changes),
    consumers: Number(consumers.changes),
  }
}

/**
 * @param {DatabaseSync} db
 * @param {{ promptVersion?: string }} [options]
 */
export function countDerived(db, { promptVersion = PROMPT_VERSION } = {}) {
  const events = db.prepare('SELECT COUNT(*) AS n FROM semantic_events').get()
  const audits = db.prepare('SELECT COUNT(*) AS n FROM extraction_audit').get()
  const cursor = db.prepare('SELECT COUNT(*) AS n FROM consumer_cursor').get()
  return {
    promptVersion,
    events: Number(events.n),
    audits: Number(audits.n),
    consumers: Number(cursor.n),
  }
}

/** @param {DatabaseSync} db */
export function jobSummary(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM extraction_jobs GROUP BY status').all()
  /** @type {Record<string, number>} */
  const summary = {}
  for (const row of rows) summary[row.status] = Number(row.n)
  return summary
}

function defaultDatabasePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'chonkyfish', 'events.db')
}

const isMain = process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const purgeEvents = args.includes('--purge-events')
  const requeueAll = args.includes('--requeue-all')
  const dbPath = args.find((arg) => !arg.startsWith('--')) || defaultDatabasePath()
  const db = new DatabaseSync(dbPath)
  try {
    console.log('事件库:', dbPath)
    console.log('提示词版本:', PROMPT_VERSION)
    console.log('之前 jobs:', JSON.stringify(jobSummary(db)))
    console.log('之前数据:', JSON.stringify(countDerived(db)))
    if (dryRun) {
      console.log('--dry-run：不改动，仅展示。')
    } else {
      if (purgeEvents) console.log('清空派生数据:', JSON.stringify(purgeDerivedData(db)))
      if (requeueAll) console.log('放回队列(全部):', requeueAllJobs(db), '个任务')
      else console.log('放回队列(仅死信):', requeueDeadLetters(db), '个任务')
      console.log('之后 jobs:', JSON.stringify(jobSummary(db)))
      console.log('之后数据:', JSON.stringify(countDerived(db)))
    }
  } finally {
    db.close()
  }
}
