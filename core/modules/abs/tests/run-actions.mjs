import assert from 'node:assert/strict'

import { ABS_ACTIONS, ABS_ACTION_INTENTS, ABS_ACTION_VIEWS, ABS_CURIOSITY_INTENTS, ABS_HISTORY_INTENTS, ABS_NO_FEEDBACK_INTENTS, actionSignals, renderActionPrompt } from '../actions.js'
import { ABS_ACTION_VIEWS as SPEC_VIEWS } from '../../../contracts/spec.js'
import { selectAbsAction } from '../selector.js'

const promptContext = { now: '2026-11-25T12:00:00.000Z', workMinutes: 75, currentSessionId: 's1', socialGap: 0.5,
  ownerInteraction: { sourceKind: 'user', sessionId: 's1', realAt: '2026-11-25T10:00:00.000Z' } }
// Registry integrity: one entry per action carries everything the rest of ABS needs.
assert.equal(new Set(ABS_ACTION_INTENTS).size, ABS_ACTIONS.length, 'intents are unique')
for (const action of ABS_ACTIONS) {
  assert.ok(typeof action.label === 'string' && action.label, action.intent + ' label')
  assert.ok(Number.isInteger(action.priority), action.intent + ' priority')
  assert.equal(typeof action.signal, 'function', action.intent + ' signal')
  assert.ok(renderActionPrompt({ intent: action.intent, ...promptContext }).length > 0, action.intent + ' prompt')
  assert.equal(ABS_ACTION_VIEWS[action.intent].label, action.label)
  assert.throws(() => { action.label = 'x' }, TypeError, 'entries are frozen')
}
assert.throws(() => renderActionPrompt({ intent: 'nope' }), TypeError)
assert.deepEqual(ABS_CURIOSITY_INTENTS, ['study', 'browse'])
assert.deepEqual(ABS_NO_FEEDBACK_INTENTS, ['review_pending'])
assert.deepEqual(ABS_HISTORY_INTENTS, ['review_pending'])
assert.equal(ABS_ACTION_VIEWS.continue_interest.retired, true, 'retired history keeps a name')
assert.ok(!ABS_ACTION_INTENTS.includes('continue_interest'), 'retired actions are never selectable')
assert.equal(SPEC_VIEWS, ABS_ACTION_VIEWS, 'the client projection comes from the registry')

// Every registered action is a selector candidate: a ready signal with a top score is chosen.
const now = Date.parse('2026-11-25T12:00:00.000Z')
const base = { mode: 'active', now, currentSessionId: 's1', ownerInteraction: promptContext.ownerInteraction, socialGap: null, curiosityGap: null, workStreak: null, remindedWorkStreakIds: [] }
assert.equal(selectAbsAction({ ...base, lastEnqueuedAt: { review_pending: null } }).intent, 'review_pending')
for (const row of actionSignals({ now, curiosityGap: 0.9, lastEnqueuedAt: {} })) {
  assert.equal(ABS_ACTION_VIEWS[row.intent].label, row.label)
  assert.ok(row.basis, row.intent + ' shown with a basis')
}

console.log('ABS action registry: ok')
