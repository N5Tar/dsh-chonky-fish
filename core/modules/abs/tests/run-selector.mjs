import assert from 'node:assert/strict'
import { selectAbsAction, ABS_ACTION_POLICY } from '../selector.js'
import { sanitizeAbsConfig, mergeAbsConfig } from '../config.js'

const now = Date.parse('2026-11-25T12:00:00.000Z')
const owner = { sessionId: 'fish', realAt: '2026-11-25T10:00:00.000Z', sourceKind: 'user' }
const base = {
  now, mode: 'active', currentSessionId: 'fish', ownerInteraction: owner,
  socialGap: 0.5, curiosityGap: 0.5, workStreak: null, remindedWorkStreakIds: [],
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
assert.equal(explore.intent, 'continue_interest')

const cfg = sanitizeAbsConfig({})
assert.equal(cfg.actionPolicy.minimumGap, ABS_ACTION_POLICY.minimumGap)
assert.equal(cfg.actionPolicy.explorationScoreFactor, ABS_ACTION_POLICY.explorationScoreFactor)
const merged = mergeAbsConfig(cfg, { actionPolicy: { minimumGap: 0.25 }, reviewMinRealGapMinutes: 2 })
assert.equal(merged.actionPolicy.minimumGap, 0.25)
assert.equal(merged.actionPolicy.explorationScoreFactor, ABS_ACTION_POLICY.explorationScoreFactor)
assert.equal(merged.reviewMinRealGapMinutes, 2)
assert.equal(sanitizeAbsConfig({ actionPolicy: { minimumGap: 9 } }).actionPolicy.minimumGap, 1)

console.log('ABS selector/actionPolicy: ok')
