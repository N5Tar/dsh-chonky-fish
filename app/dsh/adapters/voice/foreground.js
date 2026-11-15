import { PRESET } from '../../../../core/contracts/spec.js'

const refKey = ref => `${ref?.runtimeId}\u0000${ref?.conversationId}\u0000${ref?.bindingRevision}`
const expectedEquals = (left, right) => left && right && left.conversationTurnId === right.conversationTurnId && left.responseId === right.responseId && left.stepId === right.stepId

/** Host-only DSH foreground generation inspection and guarded interruption. */
export function createDshForeground({ ctx } = {}) {
  if (!ctx?.agents || typeof ctx.on !== 'function') throw new TypeError('Host agent access and event observation are required')
  const activity = new Map(), claimed = new Set(), receipts = new Map()
  let closed = false
  const listen = (type, handler) => ctx.on(type, handler)
  const offClaimed = listen('agent/inbox/claimed', (agent, event) => {
    const rpcId = event?.message?.source?.rpcId
    if (typeof agent?.id === 'string' && typeof rpcId === 'string') {
      claimed.add(`${agent.id}\u0000${rpcId}`)
      if (claimed.size > 2048) claimed.delete(claimed.values().next().value)
    }
  })
  const offStream = listen('agent/assistant-stream', (agent, event) => {
    const frame = event?.frame
    if (typeof agent?.id !== 'string' || !frame || !Number.isSafeInteger(frame.turn) || !Number.isSafeInteger(frame.step)) return
    const key = agent.id
    if (frame.type === 'start' && typeof frame.attemptId === 'string') activity.set(key, { agent, turn: frame.turn, step: frame.step, responseId: frame.attemptId })
    else if (frame.type === 'end' && activity.get(key)?.responseId === frame.attemptId) activity.delete(key)
  })

  function getAgent(ref) {
    if (closed || !ref || typeof ref.runtimeId !== 'string' || typeof ref.bindingRevision !== 'string' || typeof ref.conversationId !== 'string') return null
    const agent = ctx.agents.get(ref.conversationId)
    if (!agent || agent.id !== ref.conversationId || (agent.session?.sessionId ?? agent.session?.id) !== ref.conversationId) return null
    try { if (ctx.agentPresets?.composedPreset(agent.ctx) !== PRESET && agent.session?.header?.agentPreset !== PRESET) return null } catch { return null }
    return agent
  }
  function observed(ref) {
    const agent = getAgent(ref)
    if (!agent) return { available: false, valid: false, reason: 'stale' }
    const phase = agent.phase, run = activity.get(agent.id)
    const ready = phase?.kind === 'running' && phase.abort?.signal && typeof phase.abort.signal.aborted === 'boolean' && Number.isSafeInteger(phase.turn) && Number.isSafeInteger(phase.step) && typeof agent.cancel === 'function' && typeof agent.whenIdle === 'function' && typeof agent.wakeDriver === 'function' && Array.isArray(agent.inbox?.nextStep) && Array.isArray(agent.inbox?.nextTurn) && run?.agent === agent && run.turn === phase.turn && run.step === phase.step
    if (!ready) return { available: false, valid: true, reason: 'unavailable', running: agent.status === 'running' }
    return { available: true, valid: true, running: true, expected: { conversationTurnId: `${ref.runtimeId}:${ref.conversationId}:turn:${run.turn}`, responseId: run.responseId, stepId: `${run.turn}:${run.step}` } }
  }
  function inspect(ref) { return Promise.resolve(observed(ref)) }
  function hasPending(agent, submissionId) {
    return [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => message?.source?.rpcId === submissionId)
  }
  async function applyInterrupt(request) {
    const { conversationRef: ref, interruptionId, expected, acceptedSubmissionId } = request || {}
    if (closed || typeof interruptionId !== 'string' || !interruptionId || typeof request?.acceptedInputId !== 'string' || !request.acceptedInputId || typeof acceptedSubmissionId !== 'string' || !acceptedSubmissionId) return { status: 'unavailable', reason: 'invalid' }
    const agent = getAgent(ref)
    if (!agent) return { status: 'stale' }
    const current = observed(ref), run = activity.get(agent.id)
    if (!current.available) return { status: current.reason === 'unavailable' ? 'unavailable' : 'stale', reason: current.reason }
    if (!expectedEquals(current.expected, expected) || run.agent !== agent || claimed.has(`${agent.id}\u0000${acceptedSubmissionId}`) || !hasPending(agent, acceptedSubmissionId)) return { status: 'stale' }
    if (agent.phase.abort.signal.aborted) return { status: 'stale' }
    // No await occurs between the generation/inbox checks and this abort, so a
    // claim or generation change cannot slip between the condition and cancel.
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    try {
      await agent.whenIdle()
      if (closed || ctx.agents.get(agent.id) !== agent) return { status: 'outcome-unknown', reason: 'agent-replaced' }
      if (hasPending(agent, acceptedSubmissionId)) {
        if (agent.status === 'idle') agent.wakeDriver()
        else if (agent.status !== 'running') return { status: 'outcome-unknown', reason: 'driver-not-wakeable' }
      }
      return { status: 'applied', interruptionId }
    } catch { return { status: 'outcome-unknown', reason: 'driver-settlement-failed' } }
  }
  function interrupt(request) {
    const key = `${refKey(request?.conversationRef)}\u0000${request?.interruptionId}`
    if (receipts.has(key)) return receipts.get(key)
    const promise = applyInterrupt(request)
    receipts.set(key, promise)
    if (receipts.size > 512) receipts.delete(receipts.keys().next().value)
    return promise
  }
  function query({ conversationRef, interruptionId } = {}) {
    const value = receipts.get(`${refKey(conversationRef)}\u0000${interruptionId}`)
    return value ? value : Promise.resolve({ status: 'unavailable', reason: 'not-found' })
  }
  return {
    inspect,
    interrupt,
    query,
    dispose() { closed = true; try { offClaimed?.() } catch {} try { offStream?.() } catch {} activity.clear(); claimed.clear(); receipts.clear() },
  }
}
