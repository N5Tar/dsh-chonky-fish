import { PRESET } from '../../../../core/contracts/spec.js'

const refKey = ref => `${ref?.runtimeId}\u0000${ref?.conversationId}\u0000${ref?.bindingRevision}`
const expectedEquals = (left, right) => left && right && left.conversationTurnId === right.conversationTurnId && left.responseId === right.responseId && left.stepId === right.stepId

/** Host-only DSH foreground generation inspection and guarded interruption. */
export function createDshForeground({ ctx, supervisionTimeoutMs = 10000, ownerPath } = {}) {
  if (!ctx?.agents || typeof ctx.on !== 'function') throw new TypeError('Host agent access and event observation are required')
  const activity = new Map(), targets = new Map(), receipts = new Map(), recovered = new WeakSet(), watchedSettlements = new WeakSet()
  let closed = false
  const lookupAgent = id => typeof ctx.agents.get === 'function' ? ctx.agents.get(id) : null
  const listen = (type, handler, options) => ctx.on(type, handler, options)
  const offClaimed = listen('agent/inbox/claimed', ({ agent, message, turn } = {}) => {
    const rpcId = message?.source?.rpcId
    if (typeof agent?.id === 'string' && typeof rpcId === 'string') {
      const key = `${agent.id}\u0000${rpcId}`
      const target = targets.get(key) || { agent, claimed: false, supervised: false, consumed: false, waiters: new Set() }
      if (target.agent === agent) { target.claimed = true; target.turn = turn; targets.set(key, target); notifyTarget(target) }
      if (targets.size > 2048) targets.delete(targets.keys().next().value)
    }
  }, { global: true })
  const offStream = listen('agent/assistant-stream', ({ agent, frame } = {}) => {
    if (typeof agent?.id !== 'string' || !frame || !Number.isSafeInteger(frame.turn) || !Number.isSafeInteger(frame.step)) return
    const key = agent.id
    if (frame.type === 'start' && typeof frame.attemptId === 'string') activity.set(key, { agent, turn: frame.turn, step: frame.step, responseId: frame.attemptId })
    else if (frame.type === 'end' && activity.get(key)?.responseId === frame.attemptId) activity.delete(key)
  }, { global: true })
  const offSessionEvent = listen('session/event', (session, event) => {
    const sessionId = session?.sessionId ?? session?.id
    const agent = typeof sessionId === 'string' ? lookupAgent(sessionId) : null
    if (!agent || agent.session !== session || !event) return
    if (event.type === 'step/start' && Number.isSafeInteger(event.data?.turn)) {
      for (const target of targets.values()) if (target.agent === agent && target.claimed && target.turn === event.data.turn) { target.supervised = true; notifyTarget(target) }
    } else if (event.type === 'user/message' && typeof event.data?.source?.rpcId === 'string') {
      const target = targets.get(`${agent.id}\u0000${event.data.source.rpcId}`)
      if (target?.agent === agent) { target.consumed = true; notifyTarget(target) }
    }
  }, { global: true })

  function recoverAgent(agent) {
    if (closed || !ownerPath || !agent || recovered.has(agent) || lookupAgent(agent.id) !== agent) return false
    if (agent.status !== 'idle' || agent.phase?.kind !== 'idle' || !Array.isArray(agent.inbox?.nextStep) || !Array.isArray(agent.inbox?.nextTurn)) return false
    const roots = typeof ctx.agents.roots === 'function' ? ctx.agents.roots() : []
    if (!roots.includes(agent)) return false
    const cwd = agent.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd !== ownerPath) return false
    try { if (ctx.agentPresets?.composedPreset(agent.ctx) !== PRESET && agent.session?.header?.agentPreset !== PRESET) return false } catch { return false }
    const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    if (!pending.length || pending.some(message => message?.source?.kind !== 'user' || typeof message.source.rpcId !== 'string' || !message.source.rpcId)) return false
    if (typeof agent.wakeDriver !== 'function') return false
    recovered.add(agent)
    try { agent.wakeDriver(); return true } catch { recovered.delete(agent); return false }
  }
  function watchRecovery(agent) {
    if (!ownerPath || !agent || watchedSettlements.has(agent)) return
    watchedSettlements.add(agent)
    if (agent.activityDone && typeof agent.activityDone.then === 'function') Promise.resolve(agent.activityDone).then(() => recoverAgent(agent), () => {})
  }
  const recoverIdle = ({ agent, status } = {}) => { watchRecovery(agent); if (!status || status === 'idle' || agent?.status === 'idle') recoverAgent(agent) }
  const offCreated = listen('agent/created', ({ agent } = {}) => { watchRecovery(agent); recoverAgent(agent) }, { global: true })
  const offStatus = listen('agent/status', recoverIdle, { global: true })
  if (typeof ctx.agents.list === 'function') for (const agent of ctx.agents.list()) { watchRecovery(agent); recoverAgent(agent) }

  function notifyTarget(target) { for (const wake of [...target.waiters]) wake() }

  function getAgent(ref) {
    if (closed || !ref || typeof ref.runtimeId !== 'string' || typeof ref.bindingRevision !== 'string' || typeof ref.conversationId !== 'string') return null
    const agent = lookupAgent(ref.conversationId)
    if (!agent || agent.id !== ref.conversationId || (agent.session?.sessionId ?? agent.session?.id) !== ref.conversationId) return null
    try { if (ctx.agentPresets?.composedPreset(agent.ctx) !== PRESET && agent.session?.header?.agentPreset !== PRESET) return null } catch { return null }
    return agent
  }
  function observed(ref) {
    const agent = getAgent(ref)
    if (!agent) return { available: false, valid: false, reason: 'stale' }
    const phase = agent.phase, run = activity.get(agent.id)
    const ready = phase?.kind === 'running' && phase.abort?.signal && typeof phase.abort.signal.aborted === 'boolean' && Number.isSafeInteger(phase.turn) && Number.isSafeInteger(phase.step) && typeof agent.cancel === 'function' && agent.activityDone && typeof agent.activityDone.then === 'function' && typeof agent.wakeDriver === 'function' && Array.isArray(agent.inbox?.nextStep) && Array.isArray(agent.inbox?.nextTurn) && run?.agent === agent && run.turn === phase.turn && run.step === phase.step
    if (!ready) return { available: false, valid: true, reason: 'unavailable', running: agent.status === 'running' }
    return { available: true, valid: true, running: true, expected: { conversationTurnId: `${ref.runtimeId}:${ref.conversationId}:turn:${run.turn}`, responseId: run.responseId, stepId: `${run.turn}:${run.step}` } }
  }
  function inspect(ref) { return Promise.resolve(observed(ref)) }
  function hasPending(agent, submissionId) {
    return [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => message?.source?.rpcId === submissionId)
  }
  function targetKey(agent, submissionId) { return `${agent.id}\u0000${submissionId}` }
  function waitForSupervision(target) {
    if (target.supervised || target.consumed) return Promise.resolve(true)
    return new Promise(resolve => {
      let timer
      const finish = value => { clearTimeout(timer); target.waiters.delete(wake); resolve(value) }
      const wake = () => { if (target.supervised || target.consumed) finish(true) }
      target.waiters.add(wake)
      timer = setTimeout(() => finish(false), Math.max(0, supervisionTimeoutMs))
      wake()
    })
  }
  async function applyInterrupt(request) {
    const { conversationRef: ref, interruptionId, expected, acceptedSubmissionId } = request || {}
    if (closed || typeof interruptionId !== 'string' || !interruptionId || typeof request?.acceptedInputId !== 'string' || !request.acceptedInputId || typeof acceptedSubmissionId !== 'string' || !acceptedSubmissionId) return { status: 'unavailable', reason: 'invalid' }
    const agent = getAgent(ref)
    if (!agent) return { status: 'stale' }
    const key = targetKey(agent, acceptedSubmissionId)
    const target = targets.get(key)
    if (target?.claimed || !hasPending(agent, acceptedSubmissionId)) return { status: 'stale' }
    const current = observed(ref), run = activity.get(agent.id)
    if (!current.available) return { status: current.reason === 'unavailable' ? 'unavailable' : 'stale', reason: current.reason }
    if (!expectedEquals(current.expected, expected) || run.agent !== agent) return { status: 'stale' }
    if (agent.phase.abort.signal.aborted) return { status: 'stale' }
    // No await occurs between the generation/inbox checks and this abort, so a
    // claim or generation change cannot slip between the condition and cancel.
    const oldActivity = agent.activityDone
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    try {
      await oldActivity
      if (closed || lookupAgent(agent.id) !== agent) return { status: 'outcome-unknown', reason: 'agent-replaced' }
      let observedTarget = targets.get(key)
      if (observedTarget?.consumed || observedTarget?.supervised) return { status: 'applied', interruptionId }
      if (hasPending(agent, acceptedSubmissionId)) {
        if (agent.status === 'idle') agent.wakeDriver()
        else if (agent.status !== 'running') return { status: 'outcome-unknown', reason: 'driver-not-wakeable' }
      } else if (!observedTarget?.claimed) return { status: 'stale', reason: 'accepted-input-removed' }
      observedTarget = targets.get(key)
      if (observedTarget?.claimed || hasPending(agent, acceptedSubmissionId)) {
        const supervised = await waitForSupervision(observedTarget || { claimed: false, supervised: false, consumed: false, waiters: new Set() })
        if (supervised) return { status: 'applied', interruptionId }
        const latest = targets.get(key)
        if (latest?.claimed) return { status: 'outcome-unknown', reason: 'claimed-without-step-or-consumption' }
        if (!hasPending(agent, acceptedSubmissionId)) return { status: 'stale', reason: 'accepted-input-removed' }
        return { status: 'outcome-unknown', reason: 'driver-did-not-claim-input' }
      }
      return { status: 'stale', reason: 'accepted-input-not-observed' }
    } catch { return { status: 'outcome-unknown', reason: 'driver-settlement-failed' } }
  }
  function interrupt(request) {
    const key = `${refKey(request?.conversationRef)}\u0000${request?.interruptionId}`
    const fingerprint = JSON.stringify([request?.expected?.conversationTurnId, request?.expected?.responseId, request?.expected?.stepId, request?.acceptedInputId, request?.acceptedSubmissionId])
    const existing = receipts.get(key)
    if (existing) return existing.fingerprint === fingerprint ? existing.promise : Promise.resolve({ status: 'unavailable', reason: 'conflict' })
    const promise = applyInterrupt(request)
    receipts.set(key, { fingerprint, promise })
    if (receipts.size > 512) receipts.delete(receipts.keys().next().value)
    return promise
  }
  function query({ conversationRef, interruptionId } = {}) {
    const value = receipts.get(`${refKey(conversationRef)}\u0000${interruptionId}`)
    return value ? value.promise : Promise.resolve({ status: 'unavailable', reason: 'not-found' })
  }
  return {
    inspect,
    interrupt,
    query,
    dispose() { closed = true; try { offClaimed?.() } catch {} try { offStream?.() } catch {} try { offSessionEvent?.() } catch {} try { offCreated?.() } catch {} try { offStatus?.() } catch {} activity.clear(); targets.clear(); receipts.clear() },
  }
}
