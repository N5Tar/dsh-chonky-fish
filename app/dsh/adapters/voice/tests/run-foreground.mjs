import assert from 'node:assert/strict'
import { createDshForeground } from '../foreground.js'

const ref = { runtimeId: 'dsh:host-1', conversationId: 'session-1', bindingRevision: 'binding-1' }
const listeners = new Map()
let cancelCalls = 0, wakeCalls = 0
let settleActivity
const activityDone = new Promise(resolve => { settleActivity = resolve })
const submission = { id: 'message-1', source: { kind: 'user', rpcId: 'request-1' } }
const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args) }
const agent = {
  id: ref.conversationId,
  session: { id: ref.conversationId, sessionId: ref.conversationId, header: { agentPreset: 'chonkyfish' } },
  ctx: {}, status: 'running',
  phase: { kind: 'running', turn: 12, step: 3, abort: { signal: { aborted: false } } },
  activityDone,
  inbox: { nextStep: [submission], nextTurn: [] },
  cancel(_cause, options) { cancelCalls++; assert.deepEqual(options, { keepInbox: true }); this.phase.abort.signal.aborted = true; setTimeout(() => { this.status = 'idle'; this.phase = { kind: 'idle', lastTurn: 12 }; settleActivity() }, 0) },
  wakeDriver() { wakeCalls++; this.inbox.nextStep.shift(); emit('agent/inbox/claimed', { agent: this, message: submission, turn: 13 }); emit('session/event', this.session, { type: 'step/start', data: { turn: 13, step: 1 } }); this.status = 'running' },
}
const ctx = {
  agents: { get: id => id === agent.id ? agent : null },
  agentPresets: { composedPreset: () => 'chonkyfish' },
  on(name, listener, options) { assert.deepEqual(options, { global: true }); const rows = listeners.get(name) || new Set(); rows.add(listener); listeners.set(name, rows); return () => rows.delete(listener) },
}
const foreground = createDshForeground({ ctx })
emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'response-12-3-a', turn: 12, step: 3 } })

const state = await foreground.inspect(ref)
assert.equal(state.available, true)
assert.deepEqual(state.expected, { conversationTurnId: 'dsh:host-1:session-1:turn:12', responseId: 'response-12-3-a', stepId: '12:3' })
const request = { conversationRef: ref, interruptionId: 'interrupt-1', expected: state.expected, acceptedInputId: 'input-1', acceptedSubmissionId: 'request-1' }
assert.deepEqual(await foreground.interrupt(request), { status: 'applied', interruptionId: 'interrupt-1' })
assert.equal(cancelCalls, 1)
assert.equal(wakeCalls, 1, 'a retained steer inbox entry gets an explicit no-body wake after driver cleanup')
assert.equal(agent.inbox.nextStep.length, 0, 'the queued target is claimed by a supervised step after the wake')
assert.deepEqual(await foreground.query({ conversationRef: ref, interruptionId: 'interrupt-1' }), { status: 'applied', interruptionId: 'interrupt-1' })
assert.equal(cancelCalls, 1, 'retrying the same interruption ID is idempotent')
assert.deepEqual(await foreground.interrupt({ ...request, acceptedInputId: 'different-input' }), { status: 'unavailable', reason: 'conflict' }, 'reusing an interruption ID with different conditions is rejected')

emit('agent/inbox/claimed', { agent, message: submission, turn: 13 })
const stale = await foreground.interrupt({ ...request, interruptionId: 'interrupt-claimed' })
assert.equal(stale.status, 'stale', 'an already claimed accepted target is never canceled')
assert.equal(cancelCalls, 1)

await foreground.dispose()
console.log('DSH foreground: observed-generation conditional cancel, retained-input wake and idempotent receipt passed')
