import assert from 'node:assert/strict'
import { createDshForeground } from '../foreground.js'

const ref = { runtimeId: 'dsh:host', conversationId: 'session-proof', bindingRevision: 'bind-1' }
async function runCase(mode) {
  const listeners = new Map(), row = { id: 'request-' + mode, source: { kind: 'user', rpcId: 'request-' + mode } }
  let settle
  const activityDone = new Promise(resolve => { settle = resolve })
  let agent
  const emit = (name, ...args) => { for (const listener of listeners.get(name) || []) listener(...args) }
  agent = {
    id: ref.conversationId, session: { id: ref.conversationId, header: { agentPreset: 'chonkyfish' } }, ctx: {}, status: 'running',
    phase: { kind: 'running', turn: 4, step: 2, abort: { signal: { aborted: false } } }, activityDone,
    inbox: { nextStep: [row], nextTurn: [] },
    cancel() {
      this.phase.abort.signal.aborted = true
      if (mode === 'removed') this.inbox.nextStep.splice(0, 1)
      setTimeout(() => { this.status = 'idle'; this.phase = { kind: 'idle', lastTurn: 4 }; settle() }, 0)
    },
    wakeDriver() {
      this.inbox.nextStep.splice(0, 1)
      emit('agent/inbox/claimed', { agent: this, message: row, turn: 5 })
      if (mode === 'step-started') emit('session/event', this.session, { type: 'step/start', data: { turn: 5, step: 1 } })
      else if (mode === 'user-message') emit('session/event', this.session, { type: 'user/message', data: { source: row.source } })
      this.status = 'running'
    },
  }
  const ctx = {
    agents: { get: id => id === agent.id ? agent : null },
    agentPresets: { composedPreset: () => 'chonkyfish' },
    on(name, fn, options) { assert.deepEqual(options, { global: true }); const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn) },
  }
  const foreground = createDshForeground({ ctx, supervisionTimeoutMs: 5 })
  emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'resp-4-2', turn: 4, step: 2 } })
  const inspected = await foreground.inspect(ref)
  const result = await foreground.interrupt({ conversationRef: ref, interruptionId: 'int-' + mode, expected: inspected.expected, acceptedInputId: 'input-' + mode, acceptedSubmissionId: row.source.rpcId })
  foreground.dispose()
  return result
}

assert.equal((await runCase('removed')).status, 'stale', 'an accepted input removed during cancellation is never reported applied')
assert.equal((await runCase('claimed-only')).status, 'outcome-unknown', 'a claimed input without a successful step or user-message proof is unknown')
assert.equal((await runCase('step-started')).status, 'applied', 'step/start after the target claim proves supervised driver takeover')
assert.equal((await runCase('user-message')).status, 'applied', 'a matching committed user/message proves target consumption')

async function runRecoveryCase(source) {
  const listeners = new Map(), row = { id: 'request-recovery', source }
  let wakeCount = 0
  const agent = {
    id: 'session-recovery', session: { id: 'session-recovery', header: { agentPreset: 'chonkyfish', cwd: '/workspace' } }, ctx: {}, status: 'idle', phase: { kind: 'idle' },
    inbox: { nextStep: [row], nextTurn: [] },
    wakeDriver() { wakeCount++; this.status = 'running'; this.phase = { kind: 'running' } },
  }
  const ctx = {
    agents: { get: id => id === agent.id ? agent : null, list: () => [agent], roots: () => [agent] },
    agentPresets: { composedPreset: () => 'chonkyfish' },
    on(name, fn) { const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn) },
  }
  const foreground = createDshForeground({ ctx, ownerPath: '/workspace' })
  foreground.dispose()
  return { wakeCount }
}
assert.equal((await runRecoveryCase({ kind: 'user', rpcId: 'request-recovery' })).wakeCount, 1, 'a recreated foreground service wakes an idle root with a pending accepted local input')
assert.equal((await runRecoveryCase({ kind: 'external', rpcId: 'request-external' })).wakeCount, 0, 'recovery never wakes external or social inbox ownership')

async function runDisposeRecreateCase() {
  const listeners = new Map(), row = { id: 'request-recreate', source: { kind: 'user', rpcId: 'request-recreate' } }
  let settle, foreground1, foreground2, wakeCount = 0
  const activityDone = new Promise(resolve => { settle = resolve })
  const agent = {
    id: 'session-recreate', session: { id: 'session-recreate', header: { agentPreset: 'chonkyfish', cwd: '/workspace' } }, ctx: {}, status: 'running',
    phase: { kind: 'running', turn: 9, step: 2, abort: { signal: { aborted: false } } }, activityDone, inbox: { nextStep: [row], nextTurn: [] },
    cancel() {
      this.phase.abort.signal.aborted = true
      foreground1.dispose()
      foreground2 = createDshForeground({ ctx, ownerPath: '/workspace' })
      setTimeout(() => { this.status = 'idle'; this.phase = { kind: 'idle', lastTurn: 9 }; settle(); emit('agent/status', { agent: this, status: 'idle' }) }, 0)
    },
    wakeDriver() { wakeCount++; this.status = 'running'; this.phase = { kind: 'running' } },
  }
  const emit = (name, ...args) => { for (const listener of listeners.get(name) || []) listener(...args) }
  const ctx = {
    agents: { get: id => id === agent.id ? agent : null, list: () => [agent], roots: () => [agent] },
    agentPresets: { composedPreset: () => 'chonkyfish' },
    on(name, fn) { const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn) },
  }
  foreground1 = createDshForeground({ ctx, ownerPath: '/workspace', supervisionTimeoutMs: 5 })
  emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'response-recreate', turn: 9, step: 2 } })
  const observed = await foreground1.inspect(refFor(agent.id))
  const result = await foreground1.interrupt({ conversationRef: refFor(agent.id), interruptionId: 'int-recreate', expected: observed.expected, acceptedInputId: 'input-recreate', acceptedSubmissionId: row.source.rpcId })
  assert.equal(result.status, 'outcome-unknown', 'the disposed operation does not claim a result after its service closes')
  assert.equal(wakeCount, 1, 'the replacement service wakes the pending accepted input after cancellation settles')
  foreground2.dispose()
}
function refFor(conversationId) { return { runtimeId: 'dsh:host', conversationId, bindingRevision: 'bind-1' } }
await runDisposeRecreateCase()
console.log('DSH foreground: removal, failed pre-step, supervised takeover and consumption outcomes passed')
