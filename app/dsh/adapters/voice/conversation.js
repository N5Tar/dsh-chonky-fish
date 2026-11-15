const refKey = ref => `${ref?.runtimeId}\u0000${ref?.conversationId}\u0000${ref?.bindingRevision}`
const turnIdOf = (runtimeId, sessionId, turn) => `${runtimeId}:${sessionId}:turn:${String(turn)}`
const plainText = content => Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : ''
const createId = () => globalThis.crypto?.randomUUID?.() || `dsh-voice-${Date.now()}-${Math.random().toString(16).slice(2)}`
const isSocialInput = data => /^social-[a-f0-9]{64}$/i.test(data?.id ?? '') || data?.source?.kind === 'chonkyfish-social'
const isRuntimeContext = source => source?.kind === 'runtime-context' || source?.kind === 'time-context'
const PRE_ADMISSION_CODES = new Set([
  'gateway/bad-request', 'session/invalid-time-zone', 'session/attachment-invalid',
  'session/not-found', 'session/agent-busy', 'session/model-unavailable',
  'subagent/attachment-invalid',
])
const preAdmissionFailure = code => PRE_ADMISSION_CODES.has(code)
const MAX_LOCAL_REQUESTS = 256
const MAX_PENDING_EVENTS = 128
const MAX_PREPARED_SUBMISSIONS = 512
const LOCAL_REQUEST_TTL_MS = 60_000
function pushBounded(list, value) {
  if (list.length >= MAX_PENDING_EVENTS) list.splice(0, list.length - MAX_PENDING_EVENTS + 1)
  list.push(value)
}
function clearLocalRequest(record, requestId) {
  const timer = record.localRequests.get(requestId)
  if (timer) clearTimeout(timer)
  record.localRequests.delete(requestId)
}
function removeOwnerSubmissions(prepared, owner) {
  if (!owner) return
  for (const [submissionId, item] of prepared) if (item.owner === owner) prepared.delete(submissionId)
}
function scopeIdFor(ref, supplied, owners, { createLegacy = false } = {}) {
  if (typeof supplied === 'string' && supplied.trim()) return supplied
  if (supplied !== undefined) throw Object.assign(new Error('Voice call scope is invalid'), { code: 'VOICE_SCOPE_INVALID', outcome: 'not_applied' })
  if (createLegacy && owners.size === 0) return `legacy-${createId()}`
  if (owners.size === 1) return owners.keys().next().value
  throw Object.assign(new Error('A unique voice call scope is required for this Session'), { code: 'VOICE_SCOPE_REQUIRED', outcome: 'not_applied' })
}
function normalizeTurnError(reason) {
  const error = reason?.kind === 'error' && reason.error && typeof reason.error === 'object' ? reason.error : null
  if (!error) return undefined
  const result = {}
  if (typeof error.code === 'string' && error.code.trim()) result.code = error.code.trim().slice(0, 128)
  if (typeof error.message === 'string' && error.message.trim()) result.message = error.message.trim().slice(0, 1000)
  return Object.keys(result).length ? result : undefined
}
function rememberBounded(set, value, limit = MAX_LOCAL_REQUESTS) {
  set.add(value)
  while (set.size > limit) set.delete(set.values().next().value)
}

/** Maps this plugin's current DSH Session to the voice core's opaque conversation contract. */
export function createDshConversation({ ctx, chat, foreground } = {}) {
  if (!chat?.getVoiceBinding || !chat?.getVoiceTarget || !chat?.retainVoiceBinding) throw new TypeError('Strict chat voice accessors and independent retain are required')
  const retained = new Map(), prepared = new Map(), listeners = new Set()
  let disposed = false

  function currentBinding(ref) {
    if (disposed || typeof chat.getVoiceTarget !== 'function') return null
    const target = chat.getVoiceTarget(ref?.runtimeId)
    if (!target || refKey(target) !== refKey(ref)) return null
    const binding = chat.getVoiceBinding(ref)
    if (!binding || binding.sessionId !== ref.conversationId || binding.session?.sessionId !== ref.conversationId || !binding.eventSource) return null
    return binding
  }
  function eventKey(event) { return Number.isSafeInteger(event?.seq) && event.seq >= 0 ? event.seq : null }
  function emit(record, events, reset = false) {
    if (record.closed) return
    const batch = { streamGeneration: record.streamGeneration, cursor: String(record.lastSeq), reset, events }
    for (const onBatch of record.callbacks) { try { onBatch(batch) } catch {} }
  }
  function submissionByRequest(record, rpcId) {
    const item = prepared.get(rpcId)
    return item?.owner === record.owner ? item : null
  }
  function applyInboxSplice(record, data, events = []) {
    const target = data?.target
    if (!['next-turn', 'next-step'].includes(target) || !Number.isSafeInteger(data?.start) || data.start < 0 || !Array.isArray(data.inserted)) return events
    const inbox = record.inbox[target] || (record.inbox[target] = [])
    const removedCount = Number.isSafeInteger(data.removedCount) && data.removedCount >= 0 ? data.removedCount : 0
    const removed = inbox.splice(data.start, removedCount, ...data.inserted)
    for (const message of data.inserted) {
      const rpcId = message?.source?.rpcId
      const item = typeof rpcId === 'string' ? submissionByRequest(record, rpcId) : null
      if (item) markAccepted(item, 'inbox-evidence')
    }
    if (data.outcome === 'canceled') for (const message of removed) {
      const rpcId = message?.source?.rpcId
      const item = typeof rpcId === 'string' ? submissionByRequest(record, rpcId) : null
      if (item?.accepted) events.push({ type: 'input.removed', submissionId: item.requestId, reason: 'host-removed' })
    }
    return events
  }
  function markAccepted(item, evidence = 'session-acceptance') {
    if (item.accepted) return
    item.accepted = true
    if (item.owner?.record && !item.owner.record.closed) emit(item.owner.record, [{ type: 'input.accepted', submissionId: item.requestId, evidence }])
  }

  function foldEvent(record, event) {
    const seq = eventKey(event)
    if (seq === null) return []
    const data = event.data || {}
    const type = event.type
    const events = []
    if (type === 'turn/start' && Number.isSafeInteger(data.turn)) {
      const id = turnIdOf(record.ref.runtimeId, record.ref.conversationId, data.turn)
      const turn = { id, number: data.turn, inputIds: [], originKinds: new Set(), startedSeq: seq }
      record.turns.set(String(data.turn), turn)
      record.currentTurn = turn
      for (const item of record.pendingConsumed.splice(0)) bindConsumed(record, turn, item, events)
      for (const origin of record.pendingOrigins.splice(0)) turn.originKinds.add(origin)
      events.push({ type: 'turn.started', conversationTurnId: id })
    } else if (type === 'user/message') {
      const source = data.source
      if (isSocialInput(data)) {
        const turn = Number.isSafeInteger(data.turn) ? record.turns.get(String(data.turn)) : record.currentTurn
        if (turn) turn.originKinds.add('external')
        else pushBounded(record.pendingOrigins, 'external')
      } else if (source?.kind === 'chonkyfish-nudge') {
        const turn = Number.isSafeInteger(data.turn) ? record.turns.get(String(data.turn)) : record.currentTurn
        if (turn) turn.originKinds.add('autonomous')
        else pushBounded(record.pendingOrigins, 'autonomous')
      } else if (source?.kind === 'user' && !isRuntimeContext(source)) {
        const item = submissionByRequest(record, source.rpcId)
        if (item) {
          markAccepted(item, 'session-message')
          let turn = Number.isSafeInteger(data.turn) ? record.turns.get(String(data.turn)) : record.currentTurn
          const consumed = { item, messageId: String(seq) }
          if (!turn) pushBounded(record.pendingConsumed, consumed)
          else bindConsumed(record, turn, consumed, events)
        } else if (prepared.has(source.rpcId)) {
          const turn = Number.isSafeInteger(data.turn) ? record.turns.get(String(data.turn)) : record.currentTurn
          if (turn) turn.originKinds.add('unknown')
          else pushBounded(record.pendingOrigins, 'unknown')
        } else if (record.localRequests.has(source.rpcId) || record.localRejected.has(source.rpcId)) {
          clearLocalRequest(record, source.rpcId)
          record.localRejected.delete(source.rpcId)
          const wasAccepted = record.localAccepted.has(source.rpcId)
          record.localAccepted.delete(source.rpcId)
          rememberBounded(record.localCompleted, source.rpcId)
          const turn = Number.isSafeInteger(data.turn) ? record.turns.get(String(data.turn)) : record.currentTurn
          const localItem = { requestId: source.rpcId, inputId: null, recordKey: record.key, local: true }
          if (!wasAccepted) emit(record, [{ type: 'input.accepted', submissionId: source.rpcId, evidence: 'session-message', origin: 'local' }])
          const consumed = { item: localItem, messageId: String(seq) }
          if (!turn) pushBounded(record.pendingConsumed, consumed)
          else bindConsumed(record, turn, consumed, events)
        }
      }
    } else if (type === 'agent/inbox/spliced') {
      applyInboxSplice(record, data, events)
    } else if (type === 'step/start' && Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)) {
      const turn = record.turns.get(String(data.turn))
      if (turn) { turn.activeStep = data.step; turn.inputsByStep ||= new Map(); turn.inputsByStep.set(data.step, { inputIds: [], submissionIds: [] }) }
    } else if (type === 'step/end' && Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)) {
      const turn = record.turns.get(String(data.turn))
      if (turn?.activeStep === data.step) turn.activeStep = null
    } else if (type === 'assistant/message') {
      const op = event.surfaceOp
      if (op === 'append' || op === undefined) {
        const number = Number.isSafeInteger(data.turn) ? String(data.turn) : record.currentTurn ? String(record.currentTurn.number) : null
        const turn = number === null ? null : record.turns.get(number)
        const text = plainText(data.message?.content)
        const step = Number.isSafeInteger(data.step) ? data.step : turn?.activeStep
        const consumed = Number.isSafeInteger(step) ? turn?.inputsByStep?.get(step) : null
        const segment = turn && !turn.baseline && text && consumed?.submissionIds.length
          ? { type: 'reply.segment', replyId: `${turn.id}:reply:${seq}`, conversationTurnId: turn.id, responseId: `${turn.id}:response:${step}`, stepId: `${turn.id}:step:${step}`, inputIds: [...consumed.inputIds], submissionIds: [...consumed.submissionIds], origin: turn.originKinds.size === 1 && turn.originKinds.has('local') ? 'local' : 'mixed', text, surfaceRevision: seq }
          : null
        record.surface.set(seq, { seq, turn: number, text, ...(segment ? { segment } : {}) })
        if (segment) events.push(segment)
      } else if (op && typeof op === 'object' && op.op === 'replace' && Number.isSafeInteger(op.startSeq) && Number.isSafeInteger(op.endSeq) && op.endSeq >= op.startSeq) {
        for (const [existingSeq, entry] of record.surface) if (existingSeq >= op.startSeq && existingSeq <= op.endSeq) {
          if (entry.segment) events.push({ type: 'reply.revoked', replyId: entry.segment.replyId, conversationTurnId: entry.segment.conversationTurnId, responseId: entry.segment.responseId, stepId: entry.segment.stepId, surfaceRevision: entry.segment.surfaceRevision })
          record.surface.delete(existingSeq)
        }
        record.surface.set(seq, { seq, turn: Number.isSafeInteger(data.turn) ? String(data.turn) : record.currentTurn ? String(record.currentTurn.number) : null, text: plainText(data.message?.content) })
      }
    } else if (type === 'turn/end' && Number.isSafeInteger(data.turn)) {
      const number = String(data.turn), turn = record.turns.get(number)
      if (turn) {
        const reason = data.reason && typeof data.reason === 'object' ? data.reason : null
        const outcome = reason?.kind === 'completed' ? 'completed' : reason?.kind === 'aborted' ? 'cancelled' : 'failed'
        const origin = turn.originKinds.size > 1 ? 'mixed' : turn.originKinds.has('local') ? 'local' : turn.originKinds.has('autonomous') ? 'autonomous' : turn.originKinds.has('external') ? 'external' : 'unknown'
        if (outcome === 'completed' && !turn.baseline) {
          const text = [...record.surface.values()].filter(entry => entry.turn === number && entry.text).sort((a, b) => a.seq - b.seq).map(entry => entry.text).join('\n').trim()
          if (text) events.push({ type: 'reply.final', replyId: `${turn.id}:reply:${seq}`, conversationTurnId: turn.id, text, origin, inputSubmissionIds: [...(turn.submissionIds || [])] })
        }
        const error = normalizeTurnError(reason)
        events.push({ type: 'turn.ended', conversationTurnId: turn.id, outcome, ...(error ? { error } : {}) })
        record.turns.delete(number)
        if (record.currentTurn === turn) record.currentTurn = null
        for (const item of turn.inputItems || []) prepared.delete(item.requestId)
      }
    }
    record.lastSeq = Math.max(record.lastSeq, seq)
    if (record.surface.size > 512) {
      const keep = [...record.surface.keys()].sort((a, b) => b - a).slice(0, 384)
      const set = new Set(keep); for (const existingSeq of record.surface.keys()) if (!set.has(existingSeq)) record.surface.delete(existingSeq)
    }
    return events
  }

  function bindConsumed(record, turn, consumed, events) {
    const item = consumed.item
    turn.inputIds ||= []
    turn.submissionIds ||= []
    if (item.inputId && !turn.inputIds.includes(item.inputId)) turn.inputIds.push(item.inputId)
    if (!turn.submissionIds.includes(item.requestId)) turn.submissionIds.push(item.requestId)
    const step = turn.activeStep
    if (Number.isSafeInteger(step)) {
      turn.inputsByStep ||= new Map()
      const row = turn.inputsByStep.get(step) || { inputIds: [], submissionIds: [] }
      if (item.inputId && !row.inputIds.includes(item.inputId)) row.inputIds.push(item.inputId)
      if (!row.submissionIds.includes(item.requestId)) row.submissionIds.push(item.requestId)
      turn.inputsByStep.set(step, row)
    }
    if (!turn.inputItems) turn.inputItems = []
    if (!turn.inputItems.includes(item)) turn.inputItems.push(item)
    turn.originKinds.add('local')
    item.turnId = turn.id
    events.push({ type: 'input.consumed', inputId: item.inputId ?? null, submissionId: item.requestId, messageId: consumed.messageId, conversationTurnId: turn.id, stepId: Number.isSafeInteger(step) ? `${turn.id}:step:${step}` : null, origin: 'local' })
  }

  async function inspect(ref) {
    const binding = currentBinding(ref)
    if (!binding) return { available: false, valid: false, reason: 'VOICE_TARGET_STALE' }
    try {
      await binding.session.ready
      return { available: true, valid: true, running: binding.session.getSnapshot?.().running === true }
    } catch { return { available: false, valid: false, reason: 'VOICE_TARGET_UNAVAILABLE' } }
  }
  async function retainRef(ref, incrementOwner = false) {
    if (!currentBinding(ref)) throw Object.assign(new Error('Voice target is not the current canonical DSH Session'), { code: 'VOICE_TARGET_STALE', outcome: 'not_applied' })
    const key = refKey(ref)
    let value = retained.get(key)
    if (value) {
      if (incrementOwner) value.retainCount++
      await value.ready
      return value
    }
    value = { reference: null, binding: null, retainCount: incrementOwner ? 1 : 0, owners: new Map(), ready: null }
    retained.set(key, value)
    value.ready = (async () => {
      const reference = await chat.retainVoiceBinding(ref)
      const binding = reference
      if (binding?.session?.sessionId !== ref.conversationId || !binding?.eventSource || !currentBinding(ref) || typeof reference.release !== 'function') {
        try { reference.release?.() } catch {}
        throw Object.assign(new Error('Retained DSH Session no longer matches the voice target'), { code: 'VOICE_TARGET_STALE', outcome: 'not_applied' })
      }
      value.reference = reference
      value.binding = binding
      return value
    })()
    try { await value.ready } catch (error) {
      if (retained.get(key) === value) retained.delete(key)
      throw error
    }
    return value
  }
  function getBinding(ref) { return retained.get(refKey(ref))?.binding || null }
  function admissionEvidence(item) {
    const binding = retained.get(item.recordKey)?.binding
    const sessionSnapshot = binding?.session?.getSnapshot?.()
    if (Array.isArray(sessionSnapshot?.pendingSubmissions) && sessionSnapshot.pendingSubmissions.some(row => row?.requestId === item.requestId)) return 'session-snapshot'
    const entries = binding?.eventSource?.getSnapshot?.().entries || []
    if (entries.some(entry => entry?.event?.type === 'user/message' && entry.event.data?.source?.rpcId === item.requestId)) return 'session-message'
    if (entries.some(entry => entry?.event?.type === 'agent/inbox/spliced' && entry.event.data?.inserted?.some(message => message?.source?.rpcId === item.requestId))) return 'inbox-evidence'
    for (const record of listeners) {
      if (record.key === item.recordKey && ['next-turn', 'next-step'].some(target => record.inbox[target]?.some(message => message?.source?.rpcId === item.requestId))) return 'inbox-evidence'
    }
    return null
  }

  return {
    inspect,
    async retain(ref, { scopeId } = {}) {
      const key = refKey(ref)
      const current = retained.get(key)
      const scope = scopeIdFor(ref, scopeId, current?.owners || new Map(), { createLegacy: true })
      if (current?.owners.has(scope)) throw Object.assign(new Error('Voice call scope is already retained'), { code: 'VOICE_SCOPE_DUPLICATE', outcome: 'not_applied' })
      const value = await retainRef(ref, true)
      value.owners.set(scope, { scopeId: scope, record: null })
    },
    async release(ref, { scopeId } = {}) {
      const key = refKey(ref), value = retained.get(key)
      if (value) {
        const scope = scopeIdFor(ref, scopeId, value.owners)
        const owner = value.owners.get(scope)
        if (!owner) throw Object.assign(new Error('Voice call scope is not retained'), { code: 'VOICE_SCOPE_STALE', outcome: 'not_applied' })
        value.owners.delete(scope)
        removeOwnerSubmissions(prepared, owner)
        if (value.retainCount > 1) value.retainCount--
        else {
          value.retainCount = 0
          if (retained.get(key) === value) retained.delete(key)
          try { await value.ready; value.reference.release() } catch {}
          for (const [submissionId, item] of prepared) if (item.recordKey === key) prepared.delete(submissionId)
        }
      }
    },
    async prepareSubmission({ inputId, conversationRef, text, operation, scopeId }) {
      if (operation?.signal?.aborted) throw Object.assign(new Error('Voice submission preparation was cancelled'), { code: 'VOICE_PREPARE_CANCELLED', outcome: 'not_applied' })
      const binding = getBinding(conversationRef)
      if (!binding || !currentBinding(conversationRef)) throw Object.assign(new Error('Voice target changed before submission'), { code: 'VOICE_TARGET_STALE', outcome: 'not_applied' })
      if (prepared.size >= MAX_PREPARED_SUBMISSIONS) throw Object.assign(new Error('Voice submission evidence is temporarily full; end this call before starting another'), { code: 'VOICE_SUBMISSION_TRACKING_LIMIT', outcome: 'not_applied' })
      const retainedValue = retained.get(refKey(conversationRef))
      const ownerScope = scopeIdFor(conversationRef, scopeId, retainedValue?.owners || new Map())
      const owner = retainedValue?.owners.get(ownerScope)
      if (!owner) throw Object.assign(new Error('Voice Session owner was released before submission'), { code: 'VOICE_TARGET_STALE', outcome: 'not_applied' })
      const item = { inputId, requestId: null, abandon: null, recordKey: refKey(conversationRef), scopeId: ownerScope, owner, accepted: false, retired: false, rejectionCode: null }
      const foregroundState = typeof foreground?.inspect === 'function' ? await foreground.inspect(conversationRef) : null
      const submission = binding.session.beginSubmission({ text, mode: 'steer', onAccept: () => markAccepted(item, 'prompt-receipt'), onRetire: () => { item.retired = true } })
      if (!submission || typeof submission.requestId !== 'string' || !submission.requestId || typeof submission.abandon !== 'function') throw Object.assign(new Error('DSH Session did not provide a stable submission identity'), { code: 'VOICE_SUBMISSION_ID_MISSING', outcome: 'unknown' })
      item.requestId = submission.requestId
      item.foregroundExpected = foregroundState?.available === true ? foregroundState.expected : null
      item.abandon = submission.abandon
      prepared.set(item.requestId, item)
      return { submissionId: item.requestId }
    },
    async abandonSubmission({ submissionId, conversationRef, scopeId }) {
      const item = prepared.get(submissionId)
      const value = retained.get(refKey(conversationRef))
      const scope = scopeIdFor(conversationRef, scopeId, value?.owners || new Map())
      if (!item || item.recordKey !== refKey(conversationRef) || item.scopeId !== scope) return false
      if (item.accepted || admissionEvidence(item)) return false
      try {
        item.abandon()
        item.retired = true
        prepared.delete(item.requestId)
        return true
      } catch { return false }
    },
    async submit({ inputId, submissionId, conversationRef, text, operation, scopeId }) {
      const value = retained.get(refKey(conversationRef))
      const scope = scopeIdFor(conversationRef, scopeId, value?.owners || new Map())
      const item = prepared.get(submissionId), binding = getBinding(conversationRef)
      if (!item || item.recordKey !== refKey(conversationRef) || item.scopeId !== scope || !binding || !currentBinding(conversationRef)) return { accepted: false, rejected: true, outcome: 'not_applied', code: 'VOICE_TARGET_STALE' }
      let result
      try { result = await binding.session.prompt([{ type: 'text', text }], 'steer', operation?.signal, item.requestId) }
      catch (error) {
        if (preAdmissionFailure(error?.code)) {
          const evidence = item.accepted ? 'prompt-accept-callback' : admissionEvidence(item)
          if (evidence) { markAccepted(item, evidence); return { accepted: true, evidence } }
          item.rejectionCode = error.code
          try { item.abandon() } catch {}
          item.retired = true
          return { accepted: false, rejected: true, outcome: 'not_applied', code: error.code }
        }
        throw Object.assign(error, { code: error?.code || 'VOICE_SUBMISSION_UNKNOWN', outcome: 'unknown' })
      }
      if (result?.ok === true && result.value?.accepted === true) {
        markAccepted(item, 'prompt-receipt')
        if (typeof foreground?.interrupt === 'function' && item.foregroundExpected) {
          const interruptionId = `voice-interruption:${item.requestId}`
          try { item.interruption = await foreground.interrupt({ conversationRef, interruptionId, expected: item.foregroundExpected, acceptedInputId: item.inputId, acceptedSubmissionId: item.requestId }) }
            catch { item.interruption = { status: 'unavailable' } }
        }
        return { accepted: true, evidence: 'prompt-receipt', ...(item.interruption ? { foreground: item.interruption } : {}) }
      }
      const evidence = item.accepted ? 'prompt-accept-callback' : admissionEvidence(item)
      if (evidence) { markAccepted(item, evidence); return { accepted: true, evidence } }
      const code = result?.error?.code
      if (preAdmissionFailure(code)) {
        item.rejectionCode = code
        try { item.abandon() } catch {}
        item.retired = true
        return { accepted: false, rejected: true, outcome: 'not_applied', code }
      }
      return { accepted: false, rejected: false, outcome: 'unknown', code: typeof code === 'string' ? code : 'DSH_PROMPT_OUTCOME_UNKNOWN' }
    },
    async inspectAdmission({ submissionId, conversationRef, scopeId }) {
      const item = prepared.get(submissionId)
      const value = retained.get(refKey(conversationRef))
      const scope = scopeIdFor(conversationRef, scopeId, value?.owners || new Map())
      if (!item || item.recordKey !== refKey(conversationRef) || item.scopeId !== scope) return { status: 'unknown', outcome: 'unknown' }
      if (item.accepted) return { status: 'accepted', accepted: true, evidence: 'prompt-accept-callback' }
      const binding = getBinding(conversationRef)
      const entries = binding?.eventSource?.getSnapshot?.().entries || []
      const evidence = admissionEvidence(item)
      if (evidence || entries.some(entry => entry?.event?.type === 'user/message' && entry.event.data?.source?.rpcId === item.requestId)) {
        const acceptedEvidence = evidence || 'session-message'
        markAccepted(item, acceptedEvidence)
        return { status: 'accepted', accepted: true, evidence: acceptedEvidence }
      }
      if (item.rejectionCode && preAdmissionFailure(item.rejectionCode)) return { status: 'rejected', outcome: 'not_applied', code: item.rejectionCode }
      return { status: 'unknown', outcome: 'unknown' }
    },
    async follow(ref, { cursor, onBatch, signal, scopeId } = {}) {
      const value = await retainRef(ref), binding = value.binding, source = binding.eventSource
      const scope = scopeIdFor(ref, scopeId, value.owners)
      const owner = value.owners.get(scope)
      if (!owner) throw Object.assign(new Error('Voice call scope was not retained'), { code: 'VOICE_SCOPE_STALE', outcome: 'not_applied' })
      if (owner.record && !owner.record.closed) throw Object.assign(new Error('Voice call scope already has a follow record'), { code: 'VOICE_SCOPE_DUPLICATE', outcome: 'not_applied' })
      const record = { key: refKey(ref), ref, scopeId: scope, owner, streamGeneration: createId(), lastSeq: -1, callbacks: new Set([onBatch].filter(fn => typeof fn === 'function')), turns: new Map(), surface: new Map(), inbox: { 'next-turn': [], 'next-step': [] }, pendingConsumed: [], pendingOrigins: [], localRequests: new Map(), localAccepted: new Set(), localRejected: new Set(), localCompleted: new Set(), currentTurn: null, closed: false, syncing: true, dirty: false, unsubscribe: null, unsubscribeLocal: null, scheduled: false }
      owner.record = record
      listeners.add(record)
      const queueRead = () => {
        if (record.closed) return
        if (record.syncing) { record.dirty = true; return }
        if (record.scheduled) return
        record.scheduled = true
        queueMicrotask(() => { record.scheduled = false; void readSnapshot(false) })
      }
      async function readSnapshot(baseline) {
        if (record.closed) return
        const snapshot = source.getSnapshot()
        const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
        if (baseline) {
          for (const entry of entries) {
            const event = entry?.event, seq = eventKey(event)
            if (seq === null) continue
            record.lastSeq = Math.max(record.lastSeq, seq)
            const data = event.data || {}
            if (event.type === 'agent/inbox/spliced') {
              applyInboxSplice(record, data)
            } else if (event.type === 'turn/start' && Number.isSafeInteger(data.turn)) {
              const number = String(data.turn), id = turnIdOf(ref.runtimeId, ref.conversationId, data.turn)
              const turn = { id, number: data.turn, inputIds: [], inputItems: [], originKinds: new Set(), startedSeq: seq, baseline: true }
              record.turns.set(number, turn); record.currentTurn = turn
            } else if (event.type === 'user/message') {
              if (isSocialInput(data)) record.currentTurn?.originKinds.add('external')
              else if (data?.source?.kind === 'chonkyfish-nudge') record.currentTurn?.originKinds.add('autonomous')
            } else if (event.type === 'assistant/message') {
              const op = event.surfaceOp
              if (op === 'append' || op === undefined) record.surface.set(seq, { seq, turn: Number.isSafeInteger(data.turn) ? String(data.turn) : record.currentTurn ? String(record.currentTurn.number) : null, text: plainText(data.message?.content) })
              else if (op?.op === 'replace' && Number.isSafeInteger(op.startSeq) && Number.isSafeInteger(op.endSeq)) {
                for (const oldSeq of record.surface.keys()) if (oldSeq >= op.startSeq && oldSeq <= op.endSeq) record.surface.delete(oldSeq)
                record.surface.set(seq, { seq, turn: Number.isSafeInteger(data.turn) ? String(data.turn) : record.currentTurn ? String(record.currentTurn.number) : null, text: plainText(data.message?.content) })
              }
            } else if (event.type === 'turn/end' && Number.isSafeInteger(data.turn)) {
              record.turns.delete(String(data.turn))
              if (record.currentTurn?.number === data.turn) record.currentTurn = null
            }
          }
          emit(record, [], true)
          return
        }
        const unseen = entries.filter(entry => eventKey(entry?.event) !== null && eventKey(entry.event) > record.lastSeq).sort((a, b) => eventKey(a.event) - eventKey(b.event))
        if (!unseen.length) return
        const firstSeq = eventKey(unseen[0].event)
        if (record.lastSeq >= 0 && firstSeq > record.lastSeq + 1) {
          record.turns.clear(); record.pendingConsumed.length = 0; record.currentTurn = null
          for (const entry of unseen) record.lastSeq = Math.max(record.lastSeq, eventKey(entry.event))
          emit(record, [{ type: 'stream.reset', reason: 'session-event-gap', baselineCursor: String(record.lastSeq) }], true)
          return
        }
        const normalized = []
        for (const entry of unseen) normalized.push(...foldEvent(record, entry.event))
        if (normalized.length) emit(record, normalized)
      }
      record.unsubscribe = source.subscribe(queueRead)
      if (typeof chat.onVoiceLocalInput === 'function') {
        record.unsubscribeLocal = chat.onVoiceLocalInput(input => {
          if (record.closed || input?.sessionId !== ref.conversationId || String(input?.bindingRevision) !== ref.bindingRevision || typeof input?.requestId !== 'string') return
          if (input.state === 'rejected') {
            clearLocalRequest(record, input.requestId)
            record.localAccepted.delete(input.requestId)
            rememberBounded(record.localRejected, input.requestId)
            return
          }
          if (record.localCompleted.has(input.requestId)) return
          record.localRejected.delete(input.requestId)
          clearLocalRequest(record, input.requestId)
          const timer = setTimeout(() => {
            if (record.localRequests.get(input.requestId) !== timer) return
            record.localRequests.delete(input.requestId)
            record.localAccepted.delete(input.requestId)
          }, LOCAL_REQUEST_TTL_MS)
          record.localRequests.set(input.requestId, timer)
          while (record.localRequests.size > MAX_LOCAL_REQUESTS) clearLocalRequest(record, record.localRequests.keys().next().value)
          if (input.state === 'accepted' && !record.localAccepted.has(input.requestId)) {
            rememberBounded(record.localAccepted, input.requestId)
            emit(record, [{ type: 'input.accepted', submissionId: input.requestId, evidence: 'prompt-receipt', origin: 'local' }])
          }
        })
      }
      await readSnapshot(true)
      record.syncing = false
      if (record.dirty) { record.dirty = false; queueRead() }
      const stopSignal = () => dispose()
      let aborting = false
      const dispose = () => {
        if (record.closed) return
        record.closed = true; listeners.delete(record)
        for (const requestId of record.localRequests.keys()) clearLocalRequest(record, requestId)
        try { record.unsubscribe?.() } catch {}
        try { record.unsubscribeLocal?.() } catch {}
        signal?.removeEventListener('abort', stopSignal)
      }
      signal?.addEventListener('abort', stopSignal, { once: true })
      if (signal?.aborted) { aborting = true; dispose() }
      return dispose
    },
    async dispose() {
      disposed = true
      for (const listener of listeners) {
        listener.closed = true
        for (const requestId of listener.localRequests.keys()) clearLocalRequest(listener, requestId)
        listener.localAccepted.clear()
        listener.localRejected.clear()
        listener.localCompleted.clear()
        try { listener.unsubscribe?.() } catch {}
        try { listener.unsubscribeLocal?.() } catch {}
      }
      listeners.clear()
      for (const item of prepared.values()) { if (!item.accepted && !admissionEvidence(item)) { try { item.abandon?.() } catch {} } }
      prepared.clear()
      for (const [key, value] of retained) {
        retained.delete(key)
        try { await value.ready; value.reference.release() } catch {}
      }
    },
  }
}
