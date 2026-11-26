import { randomUUID } from 'node:crypto'

import { ABS_ACTION_INTENTS } from '../../../../core/modules/abs/actions.js'

const LABELS = new Set(['interesting', 'repetitive', 'follow_up_worthy'])
const STATUSES = new Set(['pending', 'verified', 'failed', 'unverified'])
const RESULTS = new Set(['verified','failed','no_action','unknown','not_started'])
const TURN_DIAGNOSTIC_PHASES = new Set(['before_tools','during_tools','after_tools','not_executed'])
const TURN_DIAGNOSTIC_CODES = new Set(['TRANSPORT','TIMEOUT','RATE_LIMIT','AUTH','INVALID_REQUEST','QUOTA','MODEL_ERROR','ABORTED','INTERRUPTED','BLOCKED','TURN_ERROR','NOT_EXECUTED'])
// Writes accept only registered actions (core/modules/abs/actions.js). The column has no CHECK, so adding an
// action needs no schema change; retired intents such as continue_interest stay readable as history.
const ACTION_INTENTS = new Set(ABS_ACTION_INTENTS)
const RETIRED_EPISODE_COLUMNS = ['choice_kind', 'choice_summary', 'choice_reason', 'choice_at']
const ACTION_STATUSES = new Set(['preview','reserved','enqueued','unknown','released','suppressed'])
const ACTION_SELECTION_COLUMNS = 'selection_id,episode_id,review_id,session_id,message_id,intent,reason,score,dispatch_status,work_streak_id,selected_at,visible_at,visible_turn,resolved_at,resolution_reason'
const actionSelectionsSql = (table) => `CREATE TABLE IF NOT EXISTS ${table} (
  selection_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL UNIQUE REFERENCES activity_episodes(episode_id) ON DELETE CASCADE,
  review_id TEXT UNIQUE,
  session_id TEXT,
  message_id TEXT UNIQUE,
  intent TEXT,
  reason TEXT NOT NULL,
  score REAL CHECK (score IS NULL OR (score>=0 AND score<=1)),
  dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('preview','reserved','enqueued','unknown','released','suppressed')),
  work_streak_id TEXT,
  selected_at TEXT NOT NULL,
  visible_at TEXT,
  visible_turn INTEGER,
  resolved_at TEXT,
  resolution_reason TEXT
);`
const ACTION_SELECTIONS_SQL = actionSelectionsSql('activity_action_selections')
// Schema v3/v4 carried an intent CHECK. SQLite cannot alter a CHECK, so rebuild the table without it (rows are kept).
const ACTION_SELECTIONS_REBUILD_SQL = `BEGIN IMMEDIATE;
  ${actionSelectionsSql('activity_action_selections_next')}
  INSERT INTO activity_action_selections_next (${ACTION_SELECTION_COLUMNS}) SELECT ${ACTION_SELECTION_COLUMNS} FROM activity_action_selections;
  DROP TABLE activity_action_selections;
  ALTER TABLE activity_action_selections_next RENAME TO activity_action_selections;
  COMMIT;`
const RESULT_SQL = `CASE
  WHEN e.review_status IN ('not_due','skipped','failed') THEN 'not_started'
  WHEN e.attribution='self_review' AND EXISTS (SELECT 1 FROM activity_evidence a WHERE a.episode_id=e.episode_id AND a.attribution='self_review' AND a.result_status='verified') THEN 'verified'
  WHEN e.attribution='self_review' AND EXISTS (SELECT 1 FROM activity_evidence a WHERE a.episode_id=e.episode_id AND a.attribution='self_review' AND a.result_status='failed') THEN 'failed'
  WHEN e.attribution='self_review' AND e.turn_status='failed' AND e.turn_diagnostic_code IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM activity_evidence a WHERE a.episode_id=e.episode_id) THEN 'failed'
  WHEN e.review_status IN ('accepted','reconcile') AND e.review_id IS NOT NULL AND e.session_id IS NOT NULL AND e.turn_number IS NOT NULL
    AND e.claimed_status='claimed' AND e.input_status='appended' AND e.attribution='self_review' AND e.turn_status='completed'
    AND e.turn_diagnostic_code IS NULL
    AND NOT EXISTS (SELECT 1 FROM activity_evidence a WHERE a.episode_id=e.episode_id) THEN 'no_action'
  WHEN e.review_status IN ('pending','accepted','reconcile') THEN 'unknown'
  ELSE 'not_started' END`
const clone = value => structuredClone(value)
const iso = value => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid activity timestamp')
  return date.toISOString()
}
const text = (value, max, label, optional = false) => {
  if (optional && value == null) return null
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new TypeError(`Invalid ${label}`)
  return value.trim()
}

/** Normalized, bounded storage for ABS activity observations and user labels. */
export function createAbsActivityRepository({ dbPath, DatabaseSync }) {
  if (typeof DatabaseSync !== 'function') throw new TypeError('SQLite DatabaseSync adapter required')
  const db = new DatabaseSync(dbPath)
  let closed = false
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version > 5) throw new Error('Unsupported ABS activity database schema')
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS activity_episodes (
        activity_order INTEGER PRIMARY KEY AUTOINCREMENT, episode_id TEXT NOT NULL UNIQUE, wake_at TEXT NOT NULL, cause TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('off','shadow','active')),
        gate_reason TEXT NOT NULL,
        review_id TEXT UNIQUE, review_status TEXT NOT NULL CHECK (review_status IN ('not_due','skipped','pending','accepted','failed','reconcile')),
        session_id TEXT, message_id TEXT, turn_number INTEGER,
        claimed_status TEXT NOT NULL DEFAULT 'not_claimed' CHECK (claimed_status IN ('pending','claimed','not_claimed','unknown')),
        input_status TEXT NOT NULL DEFAULT 'not_appended' CHECK (input_status IN ('pending','appended','mixed','not_appended','unknown')),
        turn_status TEXT NOT NULL DEFAULT 'unknown' CHECK (turn_status IN ('pending','completed','failed','unknown')),
        turn_diagnostic_phase TEXT, turn_diagnostic_code TEXT,
        attribution TEXT NOT NULL DEFAULT 'unlinked' CHECK (attribution IN ('self_review','mixed','unlinked')),
        social_satisfaction REAL CHECK (social_satisfaction IS NULL OR (social_satisfaction>=0 AND social_satisfaction<=1)),
        curiosity_satisfaction REAL CHECK (curiosity_satisfaction IS NULL OR (curiosity_satisfaction>=0 AND curiosity_satisfaction<=1))
      );
      CREATE INDEX IF NOT EXISTS abs_activity_episodes_wake ON activity_episodes(wake_at DESC);
      CREATE TABLE IF NOT EXISTS activity_evidence (
        evidence_id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES activity_episodes(episode_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL, turn_number INTEGER, source_seq INTEGER NOT NULL,
        source_call_id TEXT, activity_kind TEXT NOT NULL,
        result_status TEXT NOT NULL CHECK (result_status IN ('pending','verified','failed','unverified')),
        result_seq INTEGER,
        observed_at TEXT NOT NULL, attribution TEXT NOT NULL CHECK (attribution IN ('self_review','mixed','unlinked')),
        source_count INTEGER NOT NULL DEFAULT 0 CHECK (source_count >= 0),
        UNIQUE(session_id, source_seq)
      );
      CREATE INDEX IF NOT EXISTS abs_activity_evidence_episode ON activity_evidence(episode_id, observed_at);
      CREATE TABLE IF NOT EXISTS activity_annotations (
        episode_id TEXT NOT NULL REFERENCES activity_episodes(episode_id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK (label IN ('interesting','repetitive','follow_up_worthy')),
        created_at TEXT NOT NULL, PRIMARY KEY(episode_id, label)
      );
      CREATE TABLE IF NOT EXISTS activity_runtime_windows (
        runtime_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('shutdown','recovered'))
      );
      CREATE INDEX IF NOT EXISTS abs_runtime_start ON activity_runtime_windows(started_at);`)
    if (version === 1) db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE activity_episodes ADD COLUMN turn_diagnostic_phase TEXT;
      ALTER TABLE activity_episodes ADD COLUMN turn_diagnostic_code TEXT;
      ${ACTION_SELECTIONS_SQL}
      PRAGMA user_version=4;
      COMMIT;`)
    else if (version === 2) db.exec(`BEGIN IMMEDIATE; ${ACTION_SELECTIONS_SQL} PRAGMA user_version=4; COMMIT;`)
    else if (version === 0) db.exec(`BEGIN IMMEDIATE; ${ACTION_SELECTIONS_SQL} PRAGMA user_version=4; COMMIT;`)
    else if (version === 3 || version === 4) db.exec(ACTION_SELECTIONS_REBUILD_SQL)
    // The steps above stop at user_version<=4. v5 also drops what nothing writes any more:
    // model-reported choices and interest lines (both came from the retired abs_report_activity tool).
    if (version < 5) {
      const columns = new Set(db.prepare('PRAGMA table_info(activity_episodes)').all().map(row => row.name))
      db.exec('BEGIN IMMEDIATE; DROP TABLE IF EXISTS interest_updates; DROP TABLE IF EXISTS interest_lines;')
      for (const column of RETIRED_EPISODE_COLUMNS) if (columns.has(column)) db.exec(`ALTER TABLE activity_episodes DROP COLUMN ${column};`)
      db.exec('PRAGMA user_version=5; COMMIT;')
    }
  } catch (error) { db.close(); throw error }
  const assertOpen = () => { if (closed) throw new Error('ABS activity repository is closed') }
  const transaction = fn => {
    assertOpen(); db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result }
    catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
  }
  const decodeActionSelection = row => row ? ({ selectionId: row.selection_id, episodeId: row.episode_id, reviewId: row.review_id,
    sessionId: row.session_id, messageId: row.message_id, intent: row.intent, reason: row.reason, score: row.score,
    dispatchStatus: row.dispatch_status, workStreakId: row.work_streak_id,
    selectedAt: row.selected_at, visibleAt: row.visible_at ?? null, resolvedAt: row.resolved_at, resolutionReason: row.resolution_reason }) : null

  return {
    recordActionSelection(input) {
      assertOpen()
      const at = iso(input.at), intent = input.intent ?? null
      if (intent !== null && !ACTION_INTENTS.has(intent)) throw new TypeError('Invalid ABS action intent')
      const reason = text(input.reason, 64, 'action selection reason')
      if (input.score != null && (!Number.isFinite(input.score) || input.score < 0 || input.score > 1)) throw new TypeError('Invalid ABS action score')
      return transaction(() => {
        const prior = db.prepare('SELECT * FROM activity_action_selections WHERE episode_id=?').get(text(input.episodeId,128,'episode id'))
        if (prior) return { ...decodeActionSelection(prior), created: false }
        let status, finalReason = reason
        if (intent == null) status = 'suppressed'
        else if (input.mode === 'shadow') status = 'preview'
        else if (input.mode !== 'active') { status = 'suppressed'; finalReason = 'mode_off' }
        else status = 'reserved'
        if (!ACTION_STATUSES.has(status)) throw new Error('Invalid ABS action dispatch status')
        const selectionId = text(input.selectionId,128,'action selection id')
        const episodeId = text(input.episodeId,128,'episode id')
        const reviewId = input.reviewId == null ? null : text(input.reviewId,128,'review id')
        const sessionId = input.sessionId == null ? null : text(input.sessionId,256,'session id')
        const messageId = input.messageId == null ? null : text(input.messageId,128,'action message id')
        db.prepare(`INSERT INTO activity_action_selections
          (selection_id,episode_id,review_id,session_id,message_id,intent,reason,score,dispatch_status,work_streak_id,selected_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(selectionId,episodeId,reviewId,sessionId,messageId,intent,finalReason,input.score ?? null,status,
            input.workStreakId ?? null,at)
        return { selectionId,episodeId,reviewId,sessionId,messageId,intent,reason:finalReason,score:input.score ?? null,
          dispatchStatus:status,workStreakId:input.workStreakId ?? null,selectedAt:at,visibleAt:null,created:true }
      })
    },
    resolveActionSelection({ selectionId, dispatchStatus, at, reason = null }) {
      assertOpen()
      if (!['enqueued','unknown','released'].includes(dispatchStatus)) throw new TypeError('Invalid ABS action resolution')
      const when = iso(at), why = reason == null ? null : text(reason,64,'action resolution reason')
      return transaction(() => {
        const row = db.prepare('SELECT * FROM activity_action_selections WHERE selection_id=?').get(text(selectionId,128,'action selection id'))
        if (!row) return null
        if (row.dispatch_status !== 'reserved') return decodeActionSelection(row)
        db.prepare('UPDATE activity_action_selections SET dispatch_status=?,resolved_at=?,resolution_reason=? WHERE selection_id=? AND dispatch_status=\'reserved\'')
          .run(dispatchStatus,when,why,row.selection_id)
        return decodeActionSelection(db.prepare('SELECT * FROM activity_action_selections WHERE selection_id=?').get(row.selection_id))
      })
    },
    findActionSelection({ selectionId, sessionId, messageId }) {
      assertOpen()
      return decodeActionSelection(db.prepare(`SELECT * FROM activity_action_selections WHERE selection_id=? AND session_id=? AND message_id=?`)
        .get(text(selectionId,128,'action selection id'),text(sessionId,256,'session id'),text(messageId,128,'action message id')))
    },
    markActionVisible({ selectionId, reviewId, sessionId, turn, at }) {
      assertOpen()
      if (!Number.isSafeInteger(turn)) return false
      return Number(db.prepare(`UPDATE activity_action_selections SET visible_at=COALESCE(visible_at,?),visible_turn=COALESCE(visible_turn,?)
        WHERE selection_id=? AND review_id=? AND session_id=? AND dispatch_status IN ('reserved','enqueued','unknown')`)
        .run(iso(at),turn,text(selectionId,128,'action selection id'),text(reviewId,128,'review id'),text(sessionId,256,'session id')).changes) > 0
    },
    actionContext() {
      assertOpen()
      return {
        // Perception's run-scoped streak id is globally unique within its
        // producer. A Fish session rebinding must not permit a second reminder
        // for the same observed streak.
        remindedWorkStreakIds: db.prepare(`SELECT DISTINCT work_streak_id FROM activity_action_selections
          WHERE intent='remind_rest' AND work_streak_id IS NOT NULL
            AND dispatch_status IN ('reserved','enqueued','unknown')`).all().map(row => row.work_streak_id),
      }
    },
    /** Real time of the latest selection of `intent` that the host actually enqueued; null when never. */
    lastEnqueuedAt(intent) {
      assertOpen()
      if (!ACTION_INTENTS.has(intent)) throw new TypeError('Invalid ABS action intent')
      const row = db.prepare(`SELECT MAX(COALESCE(resolved_at, selected_at)) AS at FROM activity_action_selections
        WHERE intent=? AND dispatch_status='enqueued'`).get(intent)
      return row?.at ?? null
    },
    /** The latest selected intent (any status) among `intents`; null when none. */
    lastIntentAmong(intents) {
      assertOpen()
      if (!Array.isArray(intents) || !intents.length || !intents.every(intent => ACTION_INTENTS.has(intent))) throw new TypeError('Invalid ABS action intents')
      return db.prepare(`SELECT intent FROM activity_action_selections
        WHERE intent IN (${intents.map(() => '?').join(',')}) ORDER BY selected_at DESC, rowid DESC LIMIT 1`).get(...intents)?.intent ?? null
    },
    recordWake(episode) {
      assertOpen()
      const wakeAt = iso(episode.wakeAt), episodeId = text(episode.episodeId, 128, 'episode id')
      const reviewStatus = episode.reviewStatus
      if (!['not_due','skipped','pending','accepted','failed','reconcile'].includes(reviewStatus)) throw new TypeError('Invalid review status')
      const state = episode.stateAtWake ?? {}
      const run = db.prepare(`INSERT INTO activity_episodes
        (episode_id,wake_at,cause,mode,gate_reason,review_id,review_status,session_id,message_id,turn_status,claimed_status,input_status,attribution,social_satisfaction,curiosity_satisfaction)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(episode_id) DO UPDATE SET
          gate_reason=excluded.gate_reason,review_status=excluded.review_status,session_id=excluded.session_id,message_id=excluded.message_id,
          turn_status=CASE WHEN activity_episodes.turn_status IN ('unknown','pending') THEN excluded.turn_status ELSE activity_episodes.turn_status END,
          claimed_status=CASE WHEN activity_episodes.claimed_status IN ('unknown','pending','not_claimed') THEN excluded.claimed_status ELSE activity_episodes.claimed_status END,
          input_status=CASE WHEN activity_episodes.input_status IN ('unknown','pending','not_appended') THEN excluded.input_status ELSE activity_episodes.input_status END,
          attribution=CASE WHEN activity_episodes.attribution='mixed' OR excluded.attribution='mixed' THEN 'mixed'
            WHEN excluded.attribution='unlinked' THEN activity_episodes.attribution ELSE excluded.attribution END,
          social_satisfaction=excluded.social_satisfaction,curiosity_satisfaction=excluded.curiosity_satisfaction`)
      return Number(run.run(episodeId, wakeAt, text(episode.cause, 64, 'wake cause'), episode.mode,
        text(episode.gateReason, 64, 'gate reason'), episode.reviewId ?? null, reviewStatus,
        episode.sessionId ?? null, episode.messageId ?? null, episode.turnStatus ?? 'unknown', episode.claimedStatus ?? 'not_claimed',
        episode.inputStatus ?? 'not_appended', episode.attribution ?? 'unlinked', state.social ?? null, state.curiosity ?? null).changes) > 0
    },
    recordEvidence(evidence) {
      assertOpen()
      const evidenceId = text(evidence.evidenceId, 256, 'evidence id')
      if (!STATUSES.has(evidence.status) || !['self_review','mixed','unlinked'].includes(evidence.attribution)) throw new TypeError('Invalid activity evidence')
      const sessionId = text(evidence.sessionId, 256, 'session id'), callId = text(evidence.callId, 256, 'tool call id')
      const row = db.prepare(`SELECT a.evidence_id,a.episode_id,p.attribution FROM activity_evidence a JOIN activity_episodes p ON p.episode_id=a.episode_id
        WHERE a.session_id=? AND a.source_seq=? AND a.source_call_id=?`).get(sessionId, evidence.callSeq, callId)
      if (!row) return false
      const attribution = row.attribution === 'mixed' ? 'mixed' : evidence.attribution
      return Number(db.prepare(`UPDATE activity_evidence SET result_status=?,result_seq=?,observed_at=?,attribution=?,source_count=? WHERE evidence_id=? AND result_status='pending'`)
        .run(evidence.status, evidence.resultSeq, iso(evidence.at), attribution, Math.max(0, Number(evidence.sources) || 0), row.evidence_id).changes) > 0
    },
    recordAttempt(attempt) {
      assertOpen()
      if (!['self_review','mixed','unlinked'].includes(attempt.attribution)) throw new TypeError('Invalid activity attribution')
      const sessionId = text(attempt.sessionId, 256, 'session id'), callId = text(attempt.callId, 256, 'tool call id')
      const episode = attempt.reviewId ? db.prepare('SELECT episode_id,attribution FROM activity_episodes WHERE review_id=? AND session_id=?').get(attempt.reviewId,sessionId) : null
      if (!episode) return false
      const attribution = episode.attribution === 'mixed' ? 'mixed' : attempt.attribution
      return Number(db.prepare(`INSERT INTO activity_evidence
        (evidence_id,episode_id,session_id,turn_number,source_seq,source_call_id,activity_kind,result_status,result_seq,observed_at,attribution,source_count)
        VALUES(?,?,?,?,?,?,?,'pending',NULL,?,?,0) ON CONFLICT(session_id,source_seq) DO NOTHING`)
        .run(text(attempt.evidenceId,256,'evidence id'),episode.episode_id,sessionId,attempt.turn,attempt.seq,callId,
          text(attempt.activity,64,'activity kind'),iso(attempt.at),attribution).changes) > 0
    },
    recordTurn({ reviewId, sessionId, turn, status, attribution, claimStatus = 'claimed', inputStatus = 'pending', diagnostic = null }) {
      assertOpen()
      if (!['pending','completed','failed','unknown'].includes(status) || !['self_review','mixed','unlinked'].includes(attribution)) throw new TypeError('Invalid activity turn')
      if (!['pending','claimed','not_claimed','unknown'].includes(claimStatus) || !['pending','appended','mixed','not_appended','unknown'].includes(inputStatus)) throw new TypeError('Invalid activity input state')
      if (diagnostic && (!TURN_DIAGNOSTIC_PHASES.has(diagnostic.phase) || !TURN_DIAGNOSTIC_CODES.has(diagnostic.code))) throw new TypeError('Invalid activity turn diagnostic')
      const changed = Number(db.prepare(`UPDATE activity_episodes SET turn_number=?,turn_status=?,attribution=CASE WHEN attribution='mixed' OR ?='mixed' THEN 'mixed' ELSE ? END,claimed_status=?,input_status=?,
          turn_diagnostic_phase=COALESCE(?,turn_diagnostic_phase),turn_diagnostic_code=COALESCE(?,turn_diagnostic_code)
        WHERE review_id=? AND session_id=? AND (turn_number IS NULL OR turn_number=?)`)
        .run(Number.isSafeInteger(turn) ? turn : null, status, attribution, attribution, claimStatus, inputStatus, diagnostic?.phase ?? null, diagnostic?.code ?? null, reviewId, sessionId, turn).changes) > 0
      if (changed && attribution === 'mixed') {
        const episode = db.prepare('SELECT episode_id FROM activity_episodes WHERE review_id=? AND session_id=?').get(reviewId,sessionId)
        if (episode) db.prepare("UPDATE activity_evidence SET attribution='mixed' WHERE episode_id=? AND turn_number=?").run(episode.episode_id,turn)
      }
      return changed
    },
    setAnnotation({ episodeId, label, active, at }) {
      assertOpen()
      if (!LABELS.has(label) || typeof active !== 'boolean') throw new TypeError('Invalid activity annotation')
      const when = iso(at)
      return transaction(() => {
        if (!db.prepare('SELECT 1 AS found FROM activity_episodes WHERE episode_id=?').get(episodeId)) throw new Error('ABS_ACTIVITY_NOT_FOUND')
        if (active) db.prepare('INSERT INTO activity_annotations(episode_id,label,created_at) VALUES(?,?,?) ON CONFLICT(episode_id,label) DO NOTHING').run(episodeId, label, when)
        else db.prepare('DELETE FROM activity_annotations WHERE episode_id=? AND label=?').run(episodeId, label)
        return { activityId: episodeId, label, active, at: when }
      })
    },
    query({ from, to, limit = 100, now = Date.now(), snapshotAt = now, snapshotSeq, beforeWakeAt, beforeEpisodeId, outcome } = {}) {
      assertOpen()
      const start = iso(from), end = iso(to)
      const snapshot = iso(snapshotAt)
      if (Date.parse(end) <= Date.parse(start)) throw new TypeError('Invalid activity window')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid activity limit')
      if ((beforeWakeAt == null) !== (beforeEpisodeId == null)) throw new TypeError('Invalid activity cursor')
      if (beforeWakeAt != null) {
        iso(beforeWakeAt)
        if (typeof beforeEpisodeId !== 'string' || !beforeEpisodeId || beforeEpisodeId.length > 160) throw new TypeError('Invalid activity cursor')
        if (snapshotSeq == null) throw new TypeError('Activity cursor requires snapshot sequence')
      }
      if (outcome != null && !RESULTS.has(outcome)) throw new TypeError('Invalid activity outcome')
      const highWater = db.prepare('SELECT COALESCE(MAX(activity_order),0) AS value FROM activity_episodes').get().value
      const pageSnapshot = snapshotSeq == null ? highWater : snapshotSeq
      if (!Number.isSafeInteger(pageSnapshot) || pageSnapshot < 0 || pageSnapshot > highWater) throw new TypeError('Invalid activity snapshot sequence')
      const rowsWithLookahead = db.prepare(`SELECT e.*,s.intent AS action_intent,s.reason AS action_reason,s.score AS action_score,
          s.dispatch_status AS action_dispatch_status,s.selected_at AS action_selected_at,s.visible_at AS action_visible_at,
          s.visible_turn AS action_visible_turn,s.resolved_at AS action_resolved_at,s.resolution_reason AS action_resolution_reason,${RESULT_SQL} AS result FROM activity_episodes e
        LEFT JOIN activity_action_selections s ON s.episode_id=e.episode_id
        WHERE e.wake_at>=? AND e.wake_at<? AND e.activity_order<=? AND (? IS NULL OR (${RESULT_SQL})=?)
          AND (? IS NULL OR e.wake_at<? OR (e.wake_at=? AND e.episode_id<?))
        ORDER BY e.wake_at DESC,e.episode_id DESC LIMIT ?`).all(start, end, pageSnapshot, outcome ?? null, outcome ?? null,
        beforeWakeAt ?? null, beforeWakeAt ?? null, beforeWakeAt ?? null, beforeEpisodeId ?? null, limit + 1)
      const hasMore = rowsWithLookahead.length > limit
      const rows = rowsWithLookahead.slice(0, limit)
      const episodes = rows.map(row => {
        const evidenceRows = db.prepare('SELECT * FROM activity_evidence WHERE episode_id=? ORDER BY observed_at,source_seq').all(row.episode_id)
        const evidence = evidenceRows.map(item => ({ id: item.evidence_id, kind: item.activity_kind, status: item.result_status, at: item.observed_at,
          sessionId: item.session_id, turn: item.turn_number, seq: item.source_seq, resultSeq: item.result_seq, callId: item.source_call_id,
          source: 'host_observed', attribution: item.attribution, sources: item.source_count }))
        const annotations = db.prepare('SELECT label,created_at FROM activity_annotations WHERE episode_id=? ORDER BY label').all(row.episode_id)
        return { id: row.episode_id, wakeAt: row.wake_at, cause: row.cause, mode: row.mode, gateReason: row.gate_reason,
          reviewId: row.review_id, messageId: row.message_id, sessionId: row.session_id, turn: row.turn_number,
          reviewStatus: row.review_status, claimedStatus: row.claimed_status, inputStatus: row.input_status, turnStatus: row.turn_status,
          turnDiagnostic: row.turn_diagnostic_code ? { phase: row.turn_diagnostic_phase, code: row.turn_diagnostic_code } : null, attribution: row.attribution,
          stateAtWake: { socialSatisfaction: row.social_satisfaction, curiositySatisfaction: row.curiosity_satisfaction },
          actionSelection: row.action_dispatch_status ? { intent: row.action_intent, reason: row.action_reason, score: row.action_score,
            dispatchStatus: row.action_dispatch_status, selectedAt: row.action_selected_at,
            visibleAt: row.attribution === 'self_review' && row.action_visible_turn === row.turn_number ? row.action_visible_at ?? null : null,
            resolvedAt: row.action_resolved_at ?? null, resolutionReason: row.action_resolution_reason ?? null } : null,
          result: row.result, outcome: row.result, outcomeSummary: null, evidence,
          annotations: annotations.map(item => ({ label: item.label, at: item.created_at })) }
      })
      const dayTotal = db.prepare('SELECT COUNT(*) AS count FROM activity_episodes WHERE wake_at>=? AND wake_at<?').get(start,end).count
      const pageTotal = db.prepare(`SELECT COUNT(*) AS count FROM activity_episodes e WHERE e.wake_at>=? AND e.wake_at<? AND e.activity_order<=? AND (? IS NULL OR (${RESULT_SQL})=?)`)
        .get(start,end,pageSnapshot,outcome ?? null,outcome ?? null).count
      const first = db.prepare('SELECT MIN(wake_at) AS at FROM activity_episodes WHERE wake_at>=? AND wake_at<?').get(start,end).at
      const last = db.prepare('SELECT MAX(wake_at) AS at FROM activity_episodes WHERE wake_at>=? AND wake_at<?').get(start,end).at
      const countRows = db.prepare(`SELECT result,COUNT(*) AS count FROM (SELECT ${RESULT_SQL} AS result FROM activity_episodes e WHERE e.wake_at>=? AND e.wake_at<?) GROUP BY result`).all(start,end)
      const actionRows = db.prepare(`SELECT COALESCE(intent,'none') AS intent,dispatch_status,COUNT(*) AS count FROM activity_action_selections
        WHERE selected_at>=? AND selected_at<? GROUP BY intent,dispatch_status`).all(start,end)
      const actionSelections = { total: actionRows.reduce((sum,row) => sum + row.count,0), byIntent: {}, byStatus: {} }
      for (const row of actionRows) {
        actionSelections.byIntent[row.intent] = (actionSelections.byIntent[row.intent] ?? 0) + row.count
        actionSelections.byStatus[row.dispatch_status] = (actionSelections.byStatus[row.dispatch_status] ?? 0) + row.count
      }
      const countByResult = Object.fromEntries(countRows.map(row => [row.result,row.count]))
      const verifiedCount = countByResult.verified ?? 0
      const failedCount = countByResult.failed ?? 0, noActionCount = countByResult.no_action ?? 0, knownUnknown = countByResult.unknown ?? 0
      const notStarted = countByResult.not_started ?? 0
      const opportunities = verifiedCount + failedCount + noActionCount + knownUnknown
      const windows = db.prepare(`SELECT started_at,last_seen_at,ended_at,end_reason FROM activity_runtime_windows WHERE started_at<? AND (ended_at IS NULL OR ended_at>?) ORDER BY started_at`).all(end,start)
      const nowAt = new Date(now).toISOString(), endBound = Date.parse(end), fromBound = Date.parse(start), coverageBound = Math.max(fromBound, Math.min(endBound, Date.parse(nowAt)))
      const gaps = []
      let cursor = fromBound
      for (const window of windows) {
        const left = Math.max(fromBound, Date.parse(window.started_at)), right = Math.min(coverageBound, window.ended_at ? Date.parse(window.ended_at) : coverageBound)
        if (right <= left) continue
        if (left > cursor) gaps.push({ from: new Date(cursor).toISOString(), to: new Date(left).toISOString() })
        cursor = Math.max(cursor, right)
      }
      if (cursor < coverageBound) gaps.push({ from: new Date(cursor).toISOString(), to: new Date(coverageBound).toISOString() })
      const coveredMs = Math.max(0, coverageBound - fromBound - gaps.filter(g => Date.parse(g.to) <= coverageBound).reduce((sum,g) => sum + Date.parse(g.to) - Date.parse(g.from),0))
      const runtimeWindows = windows.map(row => ({
        from: new Date(Math.max(fromBound, Date.parse(row.started_at))).toISOString(),
        to: new Date(Math.min(coverageBound, row.ended_at ? Date.parse(row.ended_at) : coverageBound)).toISOString(),
        endReason: row.end_reason ?? null,
      })).filter(row => Date.parse(row.to) >= Date.parse(row.from))
      const tail = rows.at(-1)
      return {
        window: { from: start, to: new Date(coverageBound).toISOString(), requestedTo: end, timeZone: 'Asia/Shanghai',
          coverageStart: runtimeWindows[0]?.from ?? null, coverageEnd: runtimeWindows.at(-1)?.to ?? null,
          observedThrough: new Date(coverageBound).toISOString(),
          runtimeWindows, coveredMs, gaps, complete: gaps.length === 0 },
        summary: { episodes: opportunities, opportunities, totalWakes: dayTotal, notStarted, verified: verifiedCount,
          failed: failedCount, noAction: noActionCount, unknown: knownUnknown, actionSelections },
        episodes,
        page: { limit, total: pageTotal, hasMore, snapshotAt: snapshot, snapshotSeq: pageSnapshot,
          outcome: outcome ?? null, nextCursor: hasMore && tail ? { wakeAt: tail.wake_at, episodeId: tail.episode_id } : null },
      }
    },
    startRuntime({ runtimeId = randomUUID(), at }) {
      assertOpen(); const when = iso(at)
      transaction(() => {
        db.prepare(`UPDATE activity_runtime_windows SET ended_at=last_seen_at,end_reason='recovered' WHERE ended_at IS NULL`).run()
        db.prepare('INSERT INTO activity_runtime_windows(runtime_id,started_at,last_seen_at) VALUES(?,?,?)').run(runtimeId, when, when)
      })
      return runtimeId
    },
    touchRuntime({ runtimeId, at }) {
      assertOpen(); return Number(db.prepare(`UPDATE activity_runtime_windows SET last_seen_at=? WHERE runtime_id=? AND ended_at IS NULL`).run(iso(at),runtimeId).changes) > 0
    },
    closeRuntime({ runtimeId, at }) {
      assertOpen(); const when = iso(at); return Number(db.prepare(`UPDATE activity_runtime_windows SET ended_at=?,last_seen_at=?,end_reason='shutdown' WHERE runtime_id=? AND ended_at IS NULL`).run(when,when,runtimeId).changes) > 0
    },
    recoverOpen() {
      assertOpen()
      return Number(db.prepare(`UPDATE activity_episodes SET turn_status='unknown',claimed_status=CASE WHEN claimed_status='pending' THEN 'unknown' ELSE claimed_status END,
        input_status=CASE WHEN input_status='pending' THEN 'unknown' ELSE input_status END
        WHERE review_status IN ('pending','accepted','reconcile') AND turn_status IN ('pending','unknown')`).run().changes)
    },
    prune({ before }) {
      assertOpen(); const cutoff = iso(before)
      return transaction(() => {
        const removed = db.prepare('DELETE FROM activity_episodes WHERE wake_at<?').run(cutoff).changes
        db.prepare('DELETE FROM activity_runtime_windows WHERE COALESCE(ended_at,last_seen_at)<?').run(cutoff)
        return removed
      })
    },
    close() { if (closed) return; try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { closed = true; db.close() } },
  }
}
