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

/**
 * @param {DatabaseSync} db
 * @returns {number} 被放回队列的任务数
 */
export function requeueDeadLetters(db) {
  const result = db.prepare(
    `UPDATE extraction_jobs
     SET status = 'pending', attempts = 0, next_attempt_at = NULL,
         lease_until = NULL, last_error_code = NULL, updated_at = ?
     WHERE status = 'dead_letter'`,
  ).run(new Date().toISOString())
  return Number(result.changes)
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
  const dbPath = args.find((arg) => !arg.startsWith('--')) || defaultDatabasePath()
  const db = new DatabaseSync(dbPath)
  try {
    console.log('事件库:', dbPath)
    console.log('之前状态:', JSON.stringify(jobSummary(db)))
    if (dryRun) {
      console.log('--dry-run：不改动，仅展示。')
    } else {
      const moved = requeueDeadLetters(db)
      console.log('放回队列:', moved, '个死信任务')
      console.log('之后状态:', JSON.stringify(jobSummary(db)))
    }
  } finally {
    db.close()
  }
}
