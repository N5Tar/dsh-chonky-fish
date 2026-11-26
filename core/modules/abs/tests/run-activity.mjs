import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createAbsActivityRepository } from '../../../../app/shared/storage/abs/sqlite.js'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'chonkyfish-abs-activity-'))
const path = join(root, 'activities.db')
const at = '2026-11-18T10:00:00.000Z'
const iso = minutes => new Date(Date.parse(at) + minutes * 60000).toISOString()
const day = { from: '2026-11-18T00:00:00.000Z', to: '2026-11-19T00:00:00.000Z' }

function episode(id, time, reviewId = 'review-' + id) {
  return { episodeId: id, wakeAt: time, cause: 'timer', mode: 'active', gateReason: 'DUE', reviewId,
    reviewStatus: 'pending', sessionId: 'fish', messageId: 'message-' + id, turnStatus: 'pending', claimedStatus: 'pending',
    inputStatus: 'pending', attribution: 'unlinked', stateAtWake: { social: .45, curiosity: .32 } }
}

let checks = 0
function test(name, run) { run(); checks++; console.log(`ok ${checks} - ${name}`) }

try {
  let repo = createAbsActivityRepository({ dbPath: path, DatabaseSync })
  repo.recoverOpen()
  const runtimeA = repo.startRuntime({ at })
  let coverage = repo.query({ from: at, to: iso(60), now: Date.parse(at) + 30 * 60000 })
  assert.equal(coverage.window.complete, true, 'future time in the requested window is not reported as an observation gap')
  assert.equal(coverage.window.to, iso(30))
  assert.equal(coverage.window.requestedTo, iso(60))
  assert.equal(coverage.window.gaps.length, 0)

  test('verified when self-review evidence is verified', () => {
    repo.recordWake(episode('verified', iso(2), 'review-verified'))
    repo.recordTurn({ reviewId: 'review-verified', sessionId: 'fish', turn: 2, status: 'pending', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
    repo.recordAttempt({ evidenceId: 'fish:22', reviewId: 'review-verified', sessionId: 'fish', turn: 2, seq: 22,
      callId: 'call-22', activity: 'web_search', at: iso(2.5), attribution: 'self_review' })
    repo.recordEvidence({ evidenceId: 'fish:22', sessionId: 'fish', callSeq: 22, resultSeq: 23,
      callId: 'call-22', status: 'verified', at: iso(3), attribution: 'self_review', sources: 1 })
    repo.recordTurn({ reviewId: 'review-verified', sessionId: 'fish', turn: 2, status: 'completed', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
    let page = repo.query({ ...day, now: Date.parse(at) + 4 * 60000 })
    assert.equal(page.episodes.find(item => item.id === 'verified').result, 'verified')
    assert.equal(page.summary.verified, 1)
    repo.recordTurn({ reviewId: 'review-verified', sessionId: 'fish', turn: 2, status: 'completed', attribution: 'mixed', claimStatus: 'claimed', inputStatus: 'mixed' })
    page = repo.query({ ...day, now: Date.parse(at) + 4 * 60000 })
    const mixed = page.episodes.find(item => item.id === 'verified')
    assert.equal(mixed.result, 'unknown', 'late mixed attribution invalidates the earlier self-review result')
    assert.equal(mixed.evidence[0].attribution, 'mixed')
    assert.equal(page.summary.verified, 0)
    assert.equal(page.summary.unknown, 1)
  })

  test('an unverified tool attempt keeps the result unknown', () => {
    repo.recordWake(episode('defer-with-attempt', iso(4), 'review-defer-attempt'))
    repo.recordTurn({ reviewId: 'review-defer-attempt', sessionId: 'fish', turn: 4, status: 'pending', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
    repo.recordAttempt({ evidenceId: 'fish:44', reviewId: 'review-defer-attempt', sessionId: 'fish', turn: 4, seq: 44, callId: 'call-44', activity: 'unsupported_tool', at: iso(4), attribution: 'self_review' })
    repo.recordEvidence({ evidenceId: 'fish:44', sessionId: 'fish', callSeq: 44, resultSeq: 45,
      callId: 'call-44', status: 'unverified', at: iso(5), attribution: 'self_review' })
    repo.recordTurn({ reviewId: 'review-defer-attempt', sessionId: 'fish', turn: 4, status: 'completed', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
    const page = repo.query({ ...day, now: Date.parse(at) + 6 * 60000 })
    assert.equal(page.episodes.find(item => item.id === 'defer-with-attempt').result, 'unknown')
    assert.equal('deferred' in page.summary, false, 'the retired deferred count is not reported')
    assert.ok(page.summary.unknown >= 2)
  })

  test('no_action when review completes without evidence', () => {
    repo.recordWake(episode('no-action', iso(3.5), 'review-no-action'))
    repo.recordTurn({ reviewId: 'review-no-action', sessionId: 'fish', turn: 3, status: 'completed', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
    repo.recordWake({ ...episode('no-action', iso(3.5), 'review-no-action'), reviewStatus: 'accepted', attribution: 'self_review' })
    const page = repo.query({ ...day, now: Date.parse(at) + 4 * 60000 })
    const row = page.episodes.find(item => item.id === 'no-action')
    assert.equal(row.result, 'no_action')
    assert.equal('choice' in row || 'interests' in row, false, 'model-reported choices and interests are no longer exposed')
    assert.equal(page.summary.noAction >= 1, true)
  })

  test('action selection persistence and query summary', () => {
    repo.recordWake(episode('action-episode', iso(6), 'review-action'))
    const created = repo.recordActionSelection({ selectionId: 'sel-1', episodeId: 'action-episode', reviewId: 'review-action', sessionId: 'fish',
      messageId: 'message-action-episode', intent: 'study', reason: 'selected', score: 0.6, mode: 'active', at: iso(6) })
    assert.equal(created.created, true)
    assert.equal(created.dispatchStatus, 'reserved')
    repo.resolveActionSelection({ selectionId: 'sel-1', dispatchStatus: 'enqueued', at: iso(6.1) })
    repo.markActionVisible({ selectionId: 'sel-1', reviewId: 'review-action', sessionId: 'fish', turn: 5, at: iso(6.2) })
    repo.recordTurn({ reviewId: 'review-action', sessionId: 'fish', turn: 5, status: 'completed', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
    const page = repo.query({ ...day, now: Date.parse(at) + 7 * 60000 })
    const row = page.episodes.find(item => item.id === 'action-episode')
    assert.equal(row.actionSelection?.intent, 'study')
    assert.equal(row.actionSelection?.dispatchStatus, 'enqueued')
    assert.ok(page.summary.actionSelections.total >= 1)
    repo.recordWake(episode('rest-episode', iso(6.8), 'review-rest'))
    const restSel = repo.recordActionSelection({ selectionId: 'sel-rest', episodeId: 'rest-episode', reviewId: 'review-rest', sessionId: 'fish',
      messageId: 'message-rest-episode', intent: 'remind_rest', reason: 'selected', workStreakId: 'streak-1', mode: 'active', at: iso(6.8) })
    assert.equal(restSel.dispatchStatus, 'reserved')
    assert.equal(repo.actionContext().remindedWorkStreakIds.includes('streak-1'), true, 'reserved rest reminders are still active streak guards')
    repo.resolveActionSelection({ selectionId: 'sel-rest', dispatchStatus: 'released', at: iso(6.9), reason: 'test' })
    assert.equal(repo.actionContext().remindedWorkStreakIds.includes('streak-1'), false, 'released selections stop guarding the streak')
  })

  const annotated = repo.setAnnotation({ episodeId: 'verified', label: 'interesting', active: true, at: iso(5) })
  assert.equal(annotated.active, true)
  repo.setAnnotation({ episodeId: 'verified', label: 'interesting', active: false, at: iso(6) })
  let page = repo.query({ ...day, limit: 1, now: Date.parse(at) + 6 * 60000 })
  assert.ok(page.page.total >= 3)
  assert.equal(page.page.hasMore, true)
  assert.equal(page.episodes[0].stateAtWake.curiositySatisfaction, .32)
  const snapshotSeq = page.page.snapshotSeq
  const snapshotAt = page.page.snapshotAt
  assert.ok(Number.isSafeInteger(snapshotSeq))
  assert.ok(page.page.nextCursor)
  const secondBeforeInsert = repo.query({ ...day, limit: 1,
    beforeWakeAt: page.page.nextCursor.wakeAt, beforeEpisodeId: page.page.nextCursor.episodeId,
    snapshotSeq, snapshotAt, now: Date.parse(at) + 6 * 60000 })
  const expectedSecondId = secondBeforeInsert.episodes[0].id
  const expectedSecondCursor = structuredClone(secondBeforeInsert.page.nextCursor)
  repo.recordWake({ episodeId: 'late-insert', wakeAt: iso(1), cause: 'timer', mode: 'shadow', gateReason: 'SHADOW_PREVIEW_ONLY', reviewStatus: 'not_due' })
  const frozen = repo.query({ ...day, limit: 1,
    beforeWakeAt: page.page.nextCursor.wakeAt, beforeEpisodeId: page.page.nextCursor.episodeId,
    snapshotSeq, snapshotAt, now: Date.parse(at) + 6 * 60000 })
  assert.equal(frozen.episodes[0].id, expectedSecondId, 'late inserts cannot shift the snapshot page')
  assert.deepEqual(frozen.page.nextCursor, expectedSecondCursor)
  repo.recordWake({ episodeId: 'not-due', wakeAt: iso(7), cause: 'timer', mode: 'shadow', gateReason: 'SHADOW_PREVIEW_ONLY', reviewStatus: 'not_due' })
  page = repo.query({ ...day, now: Date.parse(at) + 8 * 60000 })
  assert.ok(page.summary.totalWakes >= 5)
  assert.ok(page.summary.notStarted >= 2)
  const notStartedFirst = repo.query({ ...day, outcome: 'not_started', limit: 1, now: Date.parse(at) + 8 * 60000 })
  assert.equal(notStartedFirst.episodes[0].id, 'not-due')
  repo.recordWake({ episodeId: 'not-due', wakeAt: iso(7), cause: 'timer', mode: 'shadow', gateReason: 'SHADOW_PREVIEW_ONLY', reviewStatus: 'accepted', sessionId: 'fish', reviewId: 'review-not-due', messageId: 'message-not-due' })
  repo.recordTurn({ reviewId: 'review-not-due', sessionId: 'fish', turn: 11, status: 'pending', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
  const afterFilterTransition = repo.query({ ...day, outcome: 'not_started', limit: 1,
    beforeWakeAt: notStartedFirst.page.nextCursor.wakeAt, beforeEpisodeId: notStartedFirst.page.nextCursor.episodeId,
    snapshotSeq: notStartedFirst.page.snapshotSeq, snapshotAt: notStartedFirst.page.snapshotAt, now: Date.parse(at) + 8 * 60000 })
  assert.equal(afterFilterTransition.episodes[0].id, 'late-insert', 'a result changing between filtered pages does not shift the immutable keyset boundary')
  assert.throws(() => repo.query({ ...day, outcome: 'deferred', now: Date.parse(at) + 8 * 60000 }), /Invalid activity outcome/)
  const unknownPage = repo.query({ ...day, outcome: 'unknown', now: Date.parse(at) + 8 * 60000 })
  assert.equal(unknownPage.episodes[0].result, 'unknown')
  assert.ok(unknownPage.summary.unknown >= 1, 'full-day summary stays unfiltered')

  const db = new DatabaseSync(path)
  const columns = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .flatMap(table => db.prepare(`PRAGMA table_info(${table.name})`).all().map(column => column.name))
  assert.ok(!columns.some(name => /json|payload|body|raw_text/i.test(name)), 'database schema contains no JSON/raw payload columns')
  db.close()

  repo.recordWake(episode('crash', iso(9), 'review-crash'))
  repo.recordTurn({ reviewId: 'review-crash', sessionId: 'fish', turn: 9, status: 'pending', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
  repo.close()
  repo = createAbsActivityRepository({ dbPath: path, DatabaseSync })
  repo.recoverOpen()
  const runtimeB = repo.startRuntime({ at: iso(30) })
  page = repo.query({ ...day, now: Date.parse(at) + 31 * 60000 })
  const recovered = page.episodes.find(item => item.id === 'crash')
  assert.equal(recovered.turnStatus, 'unknown')
  assert.equal(recovered.inputStatus, 'appended', 'the committed user/message input remains recorded even when later turn status is unknown')
  assert.equal(recovered.result, 'unknown')
  assert.ok(page.window.gaps.length >= 1, 'restart gap is exposed rather than filled')
  assert.equal(page.window.runtimeWindows[0].endReason, 'recovered')
  assert.equal(repo.recordAttempt({ evidenceId: 'unlinked:1', reviewId: 'missing', sessionId: 'fish', turn: 9, seq: 1, callId: 'unlinked-call', activity: 'read', at: iso(32), attribution: 'unlinked' }), false)
  test('review and curiosity history count only what the host actually dispatched', () => {
    assert.equal(repo.lastEnqueuedAt('review_pending'), null)
    repo.recordWake(episode('review-a', iso(12), 'review-a'))
    repo.recordActionSelection({ selectionId: 'sel-review-a', episodeId: 'review-a', reviewId: 'review-a', sessionId: 'fish',
      messageId: 'message-review-a', intent: 'review_pending', reason: 'selected', score: 1, mode: 'active', at: iso(12) })
    assert.equal(repo.lastEnqueuedAt('review_pending'), null, 'a reserved selection is not yet an enqueued review')
    repo.resolveActionSelection({ selectionId: 'sel-review-a', dispatchStatus: 'enqueued', at: iso(12.1) })
    assert.equal(repo.lastEnqueuedAt('review_pending'), iso(12.1))
    repo.recordWake(episode('review-b', iso(13), 'review-b'))
    repo.recordActionSelection({ selectionId: 'sel-review-b', episodeId: 'review-b', reviewId: 'review-b', sessionId: 'fish',
      messageId: 'message-review-b', intent: 'review_pending', reason: 'selected', score: 1, mode: 'active', at: iso(13) })
    repo.resolveActionSelection({ selectionId: 'sel-review-b', dispatchStatus: 'released', at: iso(13.1), reason: 'test' })
    assert.equal(repo.lastEnqueuedAt('review_pending'), iso(12.1), 'a released review does not reset the signal')
    repo.recordWake(episode('browse-a', iso(14), 'review-browse-a'))
    repo.recordActionSelection({ selectionId: 'sel-browse-a', episodeId: 'browse-a', reviewId: 'review-browse-a', sessionId: 'fish',
      messageId: 'message-browse-a', intent: 'browse', reason: 'selected', score: 0.5, mode: 'active', at: iso(14) })
    assert.equal(repo.lastIntentAmong(['study', 'browse']), 'browse')
  })

  repo.recordWake(episode('expired', '2026-05-01T10:00:00.000Z', 'review-expired'))
  repo.recordTurn({ reviewId: 'review-expired', sessionId: 'fish', turn: 10, status: 'completed', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
  repo.recordAttempt({ evidenceId: 'fish:100', reviewId: 'review-expired', sessionId: 'fish', turn: 10, seq: 100, callId: 'call-expired', activity: 'read', at: '2026-05-01T10:02:00.000Z', attribution: 'self_review' })
  repo.setAnnotation({ episodeId: 'expired', label: 'interesting', active: true, at: '2026-05-01T10:03:00.000Z' })
  assert.equal(repo.prune({ before: '2026-05-22T00:00:00.000Z' }), 1)
  page = repo.query({ from: '2026-05-01T00:00:00.000Z', to: '2026-05-02T00:00:00.000Z', now: Date.parse(at) + 31 * 60000 })
  assert.equal(page.page.total, 0)
  repo.closeRuntime({ runtimeId: runtimeB, at: iso(31) })

  const failureAt = '2026-12-01T10:00:00.000Z'
  const failureEpisode = (id, reviewId) => ({ ...episode(id, failureAt, reviewId), reviewStatus: 'accepted' })
  repo.recordWake(failureEpisode('model-failed', 'review-model-failed'))
  repo.recordTurn({ reviewId: 'review-model-failed', sessionId: 'fish', turn: 70, status: 'failed', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended', diagnostic: { phase: 'before_tools', code: 'TRANSPORT' } })
  repo.recordWake(failureEpisode('legacy-failed-without-diagnostic', 'review-legacy-failed-without-diagnostic'))
  repo.recordTurn({ reviewId: 'review-legacy-failed-without-diagnostic', sessionId: 'fish', turn: 74, status: 'failed', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
  repo.recordWake(failureEpisode('verified-before-failure', 'review-verified-before-failure'))
  repo.recordTurn({ reviewId: 'review-verified-before-failure', sessionId: 'fish', turn: 71, status: 'pending', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
  repo.recordAttempt({ evidenceId: 'fish:710', reviewId: 'review-verified-before-failure', sessionId: 'fish', turn: 71, seq: 710, callId: 'call-710', activity: 'web_search', at: failureAt, attribution: 'self_review' })
  repo.recordEvidence({ evidenceId: 'fish:710', sessionId: 'fish', callSeq: 710, resultSeq: 711, callId: 'call-710', status: 'verified', at: failureAt, attribution: 'self_review', sources: 1 })
  repo.recordTurn({ reviewId: 'review-verified-before-failure', sessionId: 'fish', turn: 71, status: 'failed', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended', diagnostic: { phase: 'after_tools', code: 'QUOTA' } })
  repo.recordWake(failureEpisode('mixed-model-failed', 'review-mixed-model-failed'))
  repo.recordTurn({ reviewId: 'review-mixed-model-failed', sessionId: 'fish', turn: 72, status: 'failed', attribution: 'mixed', claimStatus: 'claimed', inputStatus: 'mixed', diagnostic: { phase: 'before_tools', code: 'TRANSPORT' } })
  repo.recordWake(failureEpisode('unverified-model-failed', 'review-unverified-model-failed'))
  repo.recordTurn({ reviewId: 'review-unverified-model-failed', sessionId: 'fish', turn: 73, status: 'pending', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended' })
  repo.recordAttempt({ evidenceId: 'fish:730', reviewId: 'review-unverified-model-failed', sessionId: 'fish', turn: 73, seq: 730, callId: 'call-730', activity: 'unknown_tool', at: failureAt, attribution: 'self_review' })
  repo.recordEvidence({ evidenceId: 'fish:730', sessionId: 'fish', callSeq: 730, resultSeq: 731, callId: 'call-730', status: 'unverified', at: failureAt, attribution: 'self_review' })
  repo.recordTurn({ reviewId: 'review-unverified-model-failed', sessionId: 'fish', turn: 73, status: 'failed', attribution: 'self_review', claimStatus: 'claimed', inputStatus: 'appended', diagnostic: { phase: 'during_tools', code: 'MODEL_ERROR' } })
  const failurePage = repo.query({ from: '2026-12-01T00:00:00.000Z', to: '2026-12-02T00:00:00.000Z', now: Date.parse(failureAt) + 60000 })
  const failureById = Object.fromEntries(failurePage.episodes.map(item => [item.id, item]))
  assert.equal(failureById['model-failed'].result, 'failed', 'a confirmed self-review model failure is a failed episode without being a tool failure')
  assert.deepEqual(failureById['model-failed'].turnDiagnostic, { phase: 'before_tools', code: 'TRANSPORT' })
  assert.equal(failureById['verified-before-failure'].result, 'verified', 'verified objective evidence survives a later model error')
  assert.equal(failureById['mixed-model-failed'].result, 'unknown', 'mixed attribution remains unknown despite a model error')
  assert.equal(failureById['unverified-model-failed'].result, 'unknown', 'unverified tool evidence remains unknown despite a model error')
  assert.equal(failurePage.summary.failed, 1)
  assert.equal(failurePage.summary.verified, 1)
  assert.equal(failureById['legacy-failed-without-diagnostic'].result, 'unknown', 'legacy failed status without a trusted diagnostic stays unknown')
  assert.equal(failurePage.summary.unknown, 3)
  repo.close()

  const migrationPath = join(root, 'legacy-activities.db')
  copyFileSync(path, migrationPath)
  const legacy = new DatabaseSync(migrationPath)
  legacy.exec('ALTER TABLE activity_episodes DROP COLUMN turn_diagnostic_phase; ALTER TABLE activity_episodes DROP COLUMN turn_diagnostic_code; PRAGMA user_version=1;')
  legacy.close()
  repo = createAbsActivityRepository({ dbPath: migrationPath, DatabaseSync })
  const migrated = repo.query({ from: '2026-12-01T00:00:00.000Z', to: '2026-12-02T00:00:00.000Z', now: Date.parse(failureAt) + 60000 })
  assert.equal(migrated.episodes.find(item => item.id === 'model-failed').turnDiagnostic, null, 'v1 rows migrate with a nullable diagnostic')
  assert.equal(migrated.episodes.find(item => item.id === 'model-failed').result, 'unknown', 'v1 turn failures are not inferred as confirmed model failures')
  assert.equal(migrated.episodes.find(item => item.id === 'verified-before-failure').result, 'verified')
  const migratedDb = new DatabaseSync(migrationPath)
  assert.equal(migratedDb.prepare('PRAGMA user_version').get().user_version, 5)
  assert.ok(migratedDb.prepare('PRAGMA table_info(activity_episodes)').all().some(column => column.name === 'turn_diagnostic_code'))
  assert.ok(migratedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activity_action_selections'").get())
  migratedDb.close()
  repo.close()

  // Schema v3 CHECK allowed only the three original intents. Rebuild keeps history and accepts the new intents.
  const v3Path = join(root, 'v3-activities.db')
  copyFileSync(path, v3Path)
  const v3 = new DatabaseSync(v3Path)
  v3.exec(`DROP TABLE activity_action_selections;
    CREATE TABLE activity_action_selections (
      selection_id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL UNIQUE REFERENCES activity_episodes(episode_id) ON DELETE CASCADE,
      review_id TEXT UNIQUE, session_id TEXT, message_id TEXT UNIQUE,
      intent TEXT CHECK (intent IS NULL OR intent IN ('chat_owner','remind_rest','continue_interest')),
      reason TEXT NOT NULL,
      score REAL CHECK (score IS NULL OR (score>=0 AND score<=1)),
      dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('preview','reserved','enqueued','unknown','released','suppressed')),
      work_streak_id TEXT, selected_at TEXT NOT NULL, visible_at TEXT, visible_turn INTEGER, resolved_at TEXT, resolution_reason TEXT
    );
    INSERT INTO activity_action_selections (selection_id,episode_id,review_id,session_id,message_id,intent,reason,score,dispatch_status,selected_at,resolved_at)
      VALUES ('sel-legacy','action-episode','review-action','fish','message-action-episode','continue_interest','selected',0.6,'enqueued','2026-11-18T10:06:00.000Z','2026-11-18T10:06:10.000Z');
    PRAGMA user_version=3;`)
  v3.close()
  repo = createAbsActivityRepository({ dbPath: v3Path, DatabaseSync })
  const legacySelection = repo.findActionSelection({ selectionId: 'sel-legacy', sessionId: 'fish', messageId: 'message-action-episode' })
  assert.equal(legacySelection?.intent, 'continue_interest', 'legacy rows survive the rebuild')
  assert.equal(legacySelection?.dispatchStatus, 'enqueued')
  repo.recordWake(episode('post-migration', iso(20), 'review-post-migration'))
  const created = repo.recordActionSelection({ selectionId: 'sel-post', episodeId: 'post-migration', reviewId: 'review-post-migration', sessionId: 'fish',
    messageId: 'message-post-migration', intent: 'review_pending', reason: 'selected', score: 1, mode: 'active', at: iso(20) })
  assert.equal(created.intent, 'review_pending')
  repo.recordWake(episode('post-study', iso(21), 'review-post-study'))
  assert.equal(repo.recordActionSelection({ selectionId: 'sel-study', episodeId: 'post-study', reviewId: 'review-post-study', sessionId: 'fish',
    messageId: 'message-post-study', intent: 'study', reason: 'selected', score: 0.5, mode: 'shadow', at: iso(21) }).intent, 'study', 'new study intent is accepted by the schema')
  assert.throws(() => repo.recordActionSelection({ selectionId: 'sel-bad', episodeId: 'post-migration', intent: 'organize', reason: 'selected', mode: 'active', at: iso(20) }), /Invalid ABS action intent/)
  assert.equal(repo.lastEnqueuedAt('review_pending'), null)
  repo.close()
  const v3Check = new DatabaseSync(v3Path)
  assert.equal(v3Check.prepare('PRAGMA user_version').get().user_version, 5)
  v3Check.close()

  // v4 databases still carry the retired model-report tables and columns; v5 drops them and keeps the episodes.
  const v4Path = join(root, 'v4-activities.db')
  copyFileSync(path, v4Path)
  const v4 = new DatabaseSync(v4Path)
  v4.exec(`CREATE TABLE interest_lines (interest_id TEXT PRIMARY KEY, scope_session_id TEXT NOT NULL, normalized_title TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','completed','abandoned')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE interest_updates (update_id TEXT PRIMARY KEY, interest_id TEXT NOT NULL REFERENCES interest_lines(interest_id),
      episode_id TEXT NOT NULL REFERENCES activity_episodes(episode_id) ON DELETE CASCADE, source_evidence_id TEXT, continuation TEXT NOT NULL, updated_at TEXT NOT NULL);
    ALTER TABLE activity_episodes ADD COLUMN choice_kind TEXT CHECK (choice_kind IS NULL OR choice_kind IN ('continue','defer'));
    ALTER TABLE activity_episodes ADD COLUMN choice_summary TEXT;
    ALTER TABLE activity_episodes ADD COLUMN choice_reason TEXT;
    ALTER TABLE activity_episodes ADD COLUMN choice_at TEXT;
    INSERT INTO interest_lines VALUES ('i1','fish','x','x','active','2026-11-18T10:00:00.000Z','2026-11-18T10:00:00.000Z');
    INSERT INTO interest_updates VALUES ('u1','i1','verified',NULL,'later','2026-11-18T10:00:00.000Z');
    UPDATE activity_episodes SET choice_kind='defer', choice_summary='old' WHERE episode_id='no-action';
    PRAGMA user_version=4;`)
  v4.close()
  repo = createAbsActivityRepository({ dbPath: v4Path, DatabaseSync })
  const v4Page = repo.query({ ...day, now: Date.parse(at) + 40 * 60000 })
  assert.equal(v4Page.episodes.find(item => item.id === 'no-action')?.result, 'no_action', 'a stale defer choice no longer changes the result')
  assert.equal(v4Page.episodes.some(item => 'choice' in item || 'interests' in item), false)
  repo.close()
  const v4Check = new DatabaseSync(v4Path)
  assert.equal(v4Check.prepare('PRAGMA user_version').get().user_version, 5)
  assert.equal(v4Check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('interest_lines','interest_updates')").get().n, 0)
  assert.equal(v4Check.prepare('PRAGMA table_info(activity_episodes)').all().some(column => column.name.startsWith('choice_')), false)
  assert.ok(v4Check.prepare("SELECT COUNT(*) AS n FROM activity_episodes").get().n > 0)
  assert.doesNotMatch(v4Check.prepare("SELECT sql FROM sqlite_master WHERE name='activity_action_selections'").get().sql, /CHECK \(intent/, 'the intent CHECK is gone, so a new action needs no schema change')
  v4Check.close()
  void runtimeA
  console.log('ABS activity SQLite: normalized schema and lifecycle invariants passed')
} finally { rmSync(root, { recursive: true, force: true }) }