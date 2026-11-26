import assert from 'node:assert/strict'
import { selectAbsAction, ABS_ACTION_POLICY } from '../selector.js'
import { actionSignals } from '../actions.js'
import { sanitizeAbsConfig, mergeAbsConfig } from '../config.js'

const now = Date.parse('2026-11-25T12:00:00.000Z')
const owner = { sessionId: 'fish', realAt: '2026-11-25T10:00:00.000Z', sourceKind: 'user' }
// Reviewed one hour ago: far below the 12-hour review gate, so review_pending stays out of the way by default.
const recentReview = '2026-11-25T11:00:00.000Z'
const base = {
  now, mode: 'active', currentSessionId: 'fish', ownerInteraction: owner,
  socialGap: 0.5, curiosityGap: 0.5, workStreak: null, remindedWorkStreakIds: [],
  lastEnqueuedAt: { review_pending: recentReview },
}

assert.equal(selectAbsAction(base).intent, null)
assert.equal(selectAbsAction(base).reason, 'no_candidate')
assert.ok(selectAbsAction(base).blocked.some((row) => row.intent === 'chat_owner' && row.reason === 'gap_below_threshold'))

const lowered = selectAbsAction({ ...base, policy: { minimumGap: 0.3 } })
assert.equal(lowered.intent, 'chat_owner')
assert.equal(lowered.reason, 'selected')

const explore = selectAbsAction({
  ...base, socialGap: 0.2, curiosityGap: 0.55, policy: { minimumGap: 0.3, explorationScoreFactor: 1 },
})
assert.equal(explore.intent, 'study', 'equal curiosity scores with no history start from study')
assert.equal(explore.score, 0.55)

// study and browse share the curiosity gap and factor; ties alternate instead of always picking one.
const afterStudy = selectAbsAction({ ...base, socialGap: 0.2, curiosityGap: 0.9, lastCuriosityIntent: 'study' })
assert.equal(afterStudy.intent, 'browse')
assert.ok(Math.abs(afterStudy.score - 0.8 * 0.9) < 1e-12, 'curiosity score is explorationScoreFactor × curiosityGap')
const afterBrowse = selectAbsAction({ ...base, socialGap: 0.2, curiosityGap: 0.9, lastCuriosityIntent: 'browse' })
assert.equal(afterBrowse.intent, 'study')
assert.ok(selectAbsAction({ ...base, socialGap: 0.2, curiosityGap: 0.3 }).blocked.some((row) => row.intent === 'study' && row.reason === 'gap_below_threshold'))
assert.ok(selectAbsAction({ ...base, socialGap: 0.2, curiosityGap: 0.3 }).blocked.some((row) => row.intent === 'browse' && row.reason === 'gap_below_threshold'))

// review_pending: time signal min(1, h/24), gated by reviewMinGap (default 0.5 = 12 hours).
const neverReviewed = selectAbsAction({ ...base, lastEnqueuedAt: { review_pending: null }, socialGap: 0.2, curiosityGap: 0.2 })
assert.equal(neverReviewed.intent, 'review_pending', 'never reviewed saturates and wins immediately')
assert.equal(neverReviewed.score, 1)

const sixHours = selectAbsAction({ ...base, lastEnqueuedAt: { review_pending: '2026-11-25T06:00:00.000Z' }, socialGap: 0.2, curiosityGap: 0.2 })
assert.equal(sixHours.reason, 'no_candidate', 'six hours is below the 12-hour gate')
assert.ok(sixHours.blocked.some((row) => row.intent === 'review_pending' && row.reason === 'gap_below_threshold'))

const twelveHours = selectAbsAction({ ...base, lastEnqueuedAt: { review_pending: '2026-11-25T00:00:00.000Z' }, socialGap: 0.2, curiosityGap: 0.2 })
assert.equal(twelveHours.intent, 'review_pending')
assert.equal(twelveHours.score, 0.5)

// Review signal is not curiosity: a review that is due never reads curiosityGap.
const reviewBeatsStudy = selectAbsAction({ ...base, lastEnqueuedAt: { review_pending: null }, socialGap: null, curiosityGap: 0.9, policy: { explorationScoreFactor: 1 } })
assert.equal(reviewBeatsStudy.intent, 'review_pending')

// Future review timestamps clamp to zero hours rather than producing a negative signal.
const future = selectAbsAction({ ...base, lastEnqueuedAt: { review_pending: '2026-11-25T13:00:00.000Z' }, socialGap: 0.2, curiosityGap: 0.2 })
assert.equal(future.reason, 'no_candidate')

// Legacy continue_interest is no longer selectable and is absent from candidates.
for (const row of [neverReviewed, explore, afterStudy, twelveHours]) assert.notEqual(row.intent, 'continue_interest')

const cfg = sanitizeAbsConfig({})
assert.equal(cfg.actionPolicy.minimumGap, ABS_ACTION_POLICY.minimumGap)
assert.equal(cfg.actionPolicy.explorationScoreFactor, ABS_ACTION_POLICY.explorationScoreFactor)
assert.equal(cfg.actionPolicy.reviewMinGap, 0.5)
const merged = mergeAbsConfig(cfg, { actionPolicy: { minimumGap: 0.25 }, reviewMinRealGapMinutes: 2 })
assert.equal(merged.actionPolicy.minimumGap, 0.25)
assert.equal(merged.actionPolicy.explorationScoreFactor, ABS_ACTION_POLICY.explorationScoreFactor)
assert.equal(merged.actionPolicy.reviewMinGap, 0.5)
assert.equal(merged.reviewMinRealGapMinutes, 2)
assert.equal(sanitizeAbsConfig({ actionPolicy: { minimumGap: 9 } }).actionPolicy.minimumGap, 1)
assert.equal(sanitizeAbsConfig({ actionPolicy: { reviewMinGap: 'soon' } }).actionPolicy.reviewMinGap, 0.5, 'invalid reviewMinGap falls back to the default')
assert.equal(sanitizeAbsConfig({ actionPolicy: { reviewMinGap: 3 } }).actionPolicy.reviewMinGap, 1)
assert.equal(selectAbsAction({ ...base, lastEnqueuedAt: { review_pending: '2026-11-25T00:00:00.000Z' }, socialGap: 0.2, curiosityGap: 0.2, policy: { reviewMinGap: 'soon' } }).intent, 'review_pending', 'invalid selector reviewMinGap falls back to 0.5')

// Display signals share the selector's computation.
const signals = actionSignals({ now, curiosityGap: 0.8, lastEnqueuedAt: { review_pending: '2026-11-25T00:00:00.000Z' } })
assert.deepEqual(signals.map(row => row.intent), ['review_pending', 'study', 'browse'])
assert.deepEqual(signals.map(row => row.ready), [true, true, true])
assert.equal(signals[0].score, 0.5)
assert.ok(Math.abs(signals[1].score - 0.64) < 1e-12 && signals[1].score === signals[2].score)
const quiet = actionSignals({ now, curiosityGap: 0.3, lastEnqueuedAt: { review_pending: recentReview } })
assert.deepEqual(quiet.map(row => [row.ready, row.score]), [[false, null], [false, null], [false, null]])
assert.equal(actionSignals({ now, curiosityGap: null, lastEnqueuedAt: { review_pending: null } })[0].value, 1, 'never reviewed saturates')
assert.equal(actionSignals({ now, curiosityGap: null, lastEnqueuedAt: { review_pending: null } })[1].value, null)

console.log('ABS selector/actionPolicy: ok')
