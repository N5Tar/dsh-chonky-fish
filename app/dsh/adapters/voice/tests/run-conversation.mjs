import assert from 'node:assert/strict'
import { createDshConversation } from '../conversation.js'
import { createVoiceService } from '../../../../../core/modules/voice/service.js'
import { DEFAULT_VOICE_CONFIG } from '../../../../../core/modules/voice/config.js'
import { createMemoryAudioStore } from '../../../../shared/audio/clips.js'

const ref = { runtimeId: 'dsh:host-1', conversationId: 'session-1', bindingRevision: 'attach-1' }
let source, session, activeRef, submits, submissionModes, emitLocalInput, localListenerSet, submissionCounter, abandoned, nextPromptResult, acceptByRequest, retireByRequest, retainedReleaseCount, retainCalls, sourceRegistrations
function fixture({ foreground, registerVoiceSource, releaseVoiceSource } = {}) {
  const entries = [], callbacks = new Set(), localListeners = new Set()
  localListenerSet = localListeners
  source = {
    getSnapshot: () => ({ entries: [...entries], revision: entries.length }),
    listenerCount: () => callbacks.size,
    subscribe(fn) { callbacks.add(fn); return () => callbacks.delete(fn) },
    append(event) { entries.push({ event }); for (const fn of callbacks) fn() },
  }
  submits = 0
  submissionModes = []
  retainedReleaseCount = 0
  retainCalls = 0
  sourceRegistrations = new Map()
  submissionCounter = 0
  abandoned = []
  nextPromptResult = null
  acceptByRequest = new Map()
  retireByRequest = new Map()
  session = {
    sessionId: ref.conversationId,
    ready: Promise.resolve(),
    getSnapshot: () => ({ running: false, pendingSubmissions: [] }),
    beginSubmission({ mode, onAccept, onRetire }) {
      submissionModes.push(mode)
      const requestId = `request-${++submissionCounter}`
      acceptByRequest.set(requestId, onAccept)
      retireByRequest.set(requestId, onRetire)
      return { requestId, abandon() { abandoned.push(requestId); retireByRequest.get(requestId)?.({ reason: 'failed' }) } }
    },
    async prompt(_content, mode, _signal, requestId) {
      submissionModes.push(mode)
      submits++
      const result = nextPromptResult || { ok: true, value: { accepted: true } }
      if (result.ok === true) acceptByRequest.get(requestId)?.()
      else retireByRequest.get(requestId)?.({ reason: 'failed' })
      return result
    },
  }
  activeRef = ref
  const chat = {
    getVoiceTarget: runtimeId => runtimeId === activeRef?.runtimeId ? activeRef : null,
    getVoiceBinding: target => target && activeRef && target.runtimeId === activeRef.runtimeId && target.conversationId === activeRef.conversationId && target.bindingRevision === activeRef.bindingRevision ? { session, eventSource: source, sessionId: ref.conversationId } : null,
    async retainVoiceBinding(target) {
      retainCalls++
      if (!target || !activeRef || target.runtimeId !== activeRef.runtimeId || target.conversationId !== activeRef.conversationId || target.bindingRevision !== activeRef.bindingRevision) throw Object.assign(new Error('stale'), { code: 'VOICE_TARGET_STALE' })
      return { session, eventSource: source, sessionId: ref.conversationId, release() { retainedReleaseCount++ } }
    },
    onVoiceLocalInput(listener) { localListeners.add(listener); return () => localListeners.delete(listener) },
  }
  emitLocalInput = input => { for (const listener of localListeners) listener(input) }
  return createDshConversation({ chat, foreground,
    async registerVoiceSource(payload) { sourceRegistrations.set(payload.submissionId, payload); return registerVoiceSource ? registerVoiceSource(payload) : { registered: true } },
    async releaseVoiceSource(payload) { sourceRegistrations.delete(payload.submissionId); return releaseVoiceSource ? releaseVoiceSource(payload) : true },
  })
}

const batches = []
const conversation = fixture()
await conversation.retain(ref)
const stop = await conversation.follow(ref, { onBatch: batch => batches.push(batch) })
assert.equal(batches[0].reset, true)
const prepared = await conversation.prepareSubmission({ inputId: 'input-1', conversationRef: ref, text: '你好' })
assert.equal(prepared.submissionId, 'request-1')
assert.equal(sourceRegistrations.get('request-1')?.inputId, 'input-1', 'voice source registration uses the existing beginSubmission request id')
assert.equal(sourceRegistrations.get('request-1')?.text, '你好')
assert.deepEqual(await conversation.submit({ inputId: 'input-1', submissionId: prepared.submissionId, conversationRef: ref, text: '你好' }), { accepted: true, evidence: 'prompt-receipt', foreground: { status: 'unavailable', reason: 'foreground-control-unavailable' } })
assert.deepEqual(submissionModes.slice(0, 2), ['steer', 'steer'], 'prepare and submit use the same interject/steer policy')
source.append({ seq: 0, type: 'turn/start', data: { turn: 4 } })
source.append({ seq: 1, type: 'step/start', data: { turn: 4, step: 1 } })
source.append({ seq: 2, type: 'user/message', surfaceOp: 'append', data: { turn: 4, source: { kind: 'user', rpcId: 'request-1' }, content: [{ type: 'text', text: '你好' }] } })
source.append({ seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: '你好呀。' }] } } })
await new Promise(resolve => setTimeout(resolve, 0))
assert.ok(batches.flatMap(batch => batch.events).some(event => event.type === 'reply.message' && event.surfaceRevision === 3 && event.source.sessionId === ref.conversationId && event.source.seq === 3), 'assistant/message emits one committed source message before step/end and turn/end')
source.append({ seq: 4, type: 'step/end', data: { turn: 4, step: 1 } })
source.append({ seq: 5, type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
source.append({ seq: 6, type: 'assistant/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: '替换后的表面。' }] } } })
await new Promise(resolve => setTimeout(resolve, 0))
const events = batches.flatMap(batch => batch.events)
assert.ok(events.some(event => event.type === 'input.accepted' && event.submissionId === 'request-1'))
assert.ok(events.some(event => event.type === 'input.consumed' && event.submissionId === 'request-1' && event.conversationTurnId.includes(':turn:4')))
assert.ok(events.some(event => event.type === 'reply.message' && event.text === '你好呀。' && event.responseId && event.stepId && event.surfaceRevision === 3 && event.inputIds.includes('input-1') && event.submissionIds.includes('request-1')), 'committed assistant surface text is eligible before turn/end with stable step and consumed input identities')
assert.equal(events.filter(event => event.type === 'reply.message').length, 1, 'the turn does not create a duplicate aggregate reply')
assert.ok(events.some(event => event.type === 'reply.revoked' && event.replyId === `${ref.runtimeId}:${ref.conversationId}:turn:4:message:3` && event.source?.seq === 3), 'surface replacement revokes the exact previously published message')
assert.ok(events.some(event => event.type === 'turn.ended' && event.outcome === 'completed'))
assert.equal(submits, 1)
emitLocalInput({ sessionId: ref.conversationId, bindingRevision: ref.bindingRevision, requestId: 'keyboard-1' })
emitLocalInput({ sessionId: ref.conversationId, bindingRevision: ref.bindingRevision, requestId: 'keyboard-1', state: 'accepted' })
const keyboardReceiptEvents = batches.flatMap(batch => batch.events)
assert.ok(keyboardReceiptEvents.some(event => event.type === 'input.accepted' && event.submissionId === 'keyboard-1' && event.evidence === 'prompt-receipt' && event.origin === 'local'))
assert.ok(!keyboardReceiptEvents.some(event => event.type === 'input.consumed' && event.submissionId === 'keyboard-1'), 'prompt receipt is observed before the delayed Session user event')
source.append({ seq: 7, type: 'turn/start', data: { turn: 5 } })
source.append({ seq: 8, type: 'step/start', data: { turn: 5, step: 1 } })
source.append({ seq: 9, type: 'user/message', data: { turn: 5, source: { kind: 'user', rpcId: 'keyboard-1' } } })
source.append({ seq: 10, type: 'assistant/message', data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: '键盘输入的回答。' }] } } })
source.append({ seq: 11, type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
source.append({ seq: 12, type: 'turn/start', data: { turn: 6 } })
source.append({ seq: 13, type: 'user/message', data: { turn: 6, source: { kind: 'chonkyfish-nudge', form: 'notice' } } })
source.append({ seq: 14, type: 'assistant/message', data: { turn: 6, message: { content: [{ type: 'text', text: '主动提醒。' }] } } })
source.append({ seq: 15, type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
source.append({ seq: 16, type: 'turn/start', data: { turn: 7 } })
source.append({ seq: 17, type: 'user/message', data: { turn: 7, id: 'social-' + 'a'.repeat(64), source: { kind: 'chonkyfish-social' } } })
source.append({ seq: 18, type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '外部消息回答。' }] } } })
source.append({ seq: 19, type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
source.append({ seq: 20, type: 'turn/start', data: { turn: 8 } })
source.append({ seq: 21, type: 'user/message', data: { turn: 8, source: { kind: 'runtime-context' } } })
source.append({ seq: 22, type: 'assistant/message', data: { turn: 8, message: { content: [{ type: 'text', text: '上下文消息后的回答。' }] } } })
source.append({ seq: 23, type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
await new Promise(resolve => setTimeout(resolve, 0))
const laterEvents = batches.flatMap(batch => batch.events)
assert.ok(laterEvents.some(event => event.type === 'reply.message' && event.conversationTurnId.endsWith(':turn:5') && event.origin === 'local'))
assert.ok(!laterEvents.some(event => event.type === 'reply.message' && event.conversationTurnId.endsWith(':turn:6')), 'independent nudge output is not marked as a foreground voice reply')
assert.ok(!laterEvents.some(event => event.type === 'reply.message' && event.conversationTurnId.endsWith(':turn:7')), 'external input is not marked as a foreground voice reply')
assert.ok(!laterEvents.some(event => event.type === 'reply.message' && event.conversationTurnId.endsWith(':turn:8') && event.origin === 'local'))
assert.ok(laterEvents.some(event => event.type === 'input.accepted' && event.submissionId === 'keyboard-1' && event.origin === 'local'))
assert.ok(laterEvents.some(event => event.type === 'input.consumed' && event.submissionId === 'keyboard-1' && event.conversationTurnId.endsWith(':turn:5') && event.origin === 'local'))
const op = new AbortController()
const late = await conversation.prepareSubmission({ inputId: 'input-late', conversationRef: ref, text: '取消后不会发送', operation: { signal: op.signal } })
op.abort()
assert.equal(await conversation.abandonSubmission({ inputId: 'input-late', submissionId: late.submissionId, conversationRef: ref }), true)
assert.ok(abandoned.includes(late.submissionId))
assert.equal(await conversation.inspectAdmission({ inputId: 'input-late', submissionId: late.submissionId, conversationRef: ref }).then(x => x.status), 'unknown')

const unknown = await conversation.prepareSubmission({ inputId: 'input-unknown', conversationRef: ref, text: 'unknown' })
nextPromptResult = { ok: false, error: { code: 'gateway/internal', message: 'unknown outcome' } }
const unknownResult = await conversation.submit({ submissionId: unknown.submissionId, conversationRef: ref, text: 'unknown' })
assert.equal(unknownResult.rejected, false)
assert.equal(unknownResult.outcome, 'unknown')
assert.equal((await conversation.inspectAdmission({ submissionId: unknown.submissionId, conversationRef: ref })).status, 'unknown')

const rejectedSubmission = await conversation.prepareSubmission({ inputId: 'input-rejected', conversationRef: ref, text: 'rejected' })
nextPromptResult = { ok: false, error: { code: 'session/agent-busy', message: 'prompt rejected' } }
const knownRejected = await conversation.submit({ submissionId: rejectedSubmission.submissionId, conversationRef: ref, text: 'rejected' })
assert.equal(knownRejected.rejected, true)
assert.equal(knownRejected.outcome, 'not_applied')
assert.equal((await conversation.inspectAdmission({ submissionId: rejectedSubmission.submissionId, conversationRef: ref })).status, 'rejected')
nextPromptResult = null

const inboxSubmission = await conversation.prepareSubmission({ inputId: 'input-inbox', conversationRef: ref, text: 'queued then removed' })
source.append({ seq: 24, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: 'queued then removed' }], source: { kind: 'user', rpcId: inboxSubmission.submissionId } }] } })
source.append({ seq: 25, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } })
await new Promise(resolve => setTimeout(resolve, 0))
const inboxEvents = batches.flatMap(batch => batch.events)
assert.ok(inboxEvents.some(event => event.type === 'input.accepted' && event.submissionId === inboxSubmission.submissionId && event.evidence === 'inbox-evidence'))
assert.ok(inboxEvents.some(event => event.type === 'input.removed' && event.submissionId === inboxSubmission.submissionId))
assert.equal(sourceRegistrations.has(inboxSubmission.submissionId), false, 'known canceled inbox input releases its unused voice source registration')
const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout
const localTimers = new Set()
globalThis.setTimeout = (fn, delay, ...args) => { const timer = originalSetTimeout(fn, delay, ...args); localTimers.add(timer); return timer }
globalThis.clearTimeout = timer => { localTimers.delete(timer); return originalClearTimeout(timer) }
try {
  let seq = 26
  for (let index = 0; index < 300; index++) {
    const turn = 30 + index, requestId = `keyboard-many-${index}`
    emitLocalInput({ sessionId: ref.conversationId, bindingRevision: ref.bindingRevision, requestId })
    emitLocalInput({ sessionId: ref.conversationId, bindingRevision: ref.bindingRevision, requestId, state: 'accepted' })
    source.append({ seq: seq++, type: 'turn/start', data: { turn } })
    source.append({ seq: seq++, type: 'user/message', data: { turn, source: { kind: 'user', rpcId: requestId } } })
    source.append({ seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'aborted' } } })
    await new Promise(resolve => originalSetTimeout(resolve, 0))
  }
  assert.equal(localTimers.size, 0, 'matched keyboard request IDs release their expiry timers')
  const lateRequestId = 'keyboard-late-after-rejection'
  emitLocalInput({ sessionId: ref.conversationId, bindingRevision: ref.bindingRevision, requestId: lateRequestId, state: 'prepared' })
  emitLocalInput({ sessionId: ref.conversationId, bindingRevision: ref.bindingRevision, requestId: lateRequestId, state: 'rejected' })
  source.append({ seq: seq++, type: 'turn/start', data: { turn: 500 } })
  source.append({ seq: seq++, type: 'user/message', data: { turn: 500, source: { kind: 'user', rpcId: lateRequestId } } })
  source.append({ seq: seq++, type: 'turn/end', data: { turn: 500, reason: { kind: 'aborted' } } })
  await new Promise(resolve => originalSetTimeout(resolve, 0))
  const lateEvents = batches.flatMap(batch => batch.events).filter(event => event.submissionId === lateRequestId)
  assert.ok(lateEvents.some(event => event.type === 'input.accepted' && event.evidence === 'session-message' && event.origin === 'local'), 'late Session evidence overrides a previously reported rejection')
  assert.ok(lateEvents.some(event => event.type === 'input.consumed' && event.conversationTurnId.endsWith(':turn:500')))
} finally {
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
}
assert.equal(batches[0].reset, true, 'follow drains its baseline before returning the stop function')
const originalSetClear = Set.prototype.clear
let clearedSets = 0
Set.prototype.clear = function () { clearedSets++; return originalSetClear.call(this) }
try { stop() } finally { Set.prototype.clear = originalSetClear }
assert.equal(source.listenerCount(), 0, 'stopping follow removes the DSH event subscription')
assert.equal(localListenerSet.size, 0, 'stopping follow removes the local input subscription')
await conversation.release(ref)

let foregroundInterrupt
const foregroundConversation = fixture({ foreground: {
  async inspect() { return { available: true, expected: { conversationTurnId: 'turn-4', responseId: 'response-4', stepId: '4:2' } } },
  async interrupt(request) { foregroundInterrupt = request; return { status: 'applied', interruptionId: request.interruptionId } },
} })
await foregroundConversation.retain(ref)
const foregroundSubmission = await foregroundConversation.prepareSubmission({ inputId: 'input-with-proof', conversationRef: ref, text: '确认后再中断' })
const foregroundResult = await foregroundConversation.submit({ inputId: 'input-with-proof', submissionId: foregroundSubmission.submissionId, conversationRef: ref, text: '确认后再中断' })
assert.equal(foregroundResult.foreground.status, 'applied')
assert.equal(foregroundInterrupt.acceptedSubmissionId, foregroundSubmission.submissionId)
assert.equal(foregroundInterrupt.acceptedInputId, 'input-with-proof')
await foregroundConversation.release(ref)

const stepBatches = []
const stepConversation = fixture()
await stepConversation.retain(ref)
const stopSteps = await stepConversation.follow(ref, { onBatch: batch => stepBatches.push(batch) })
const stepInputA = await stepConversation.prepareSubmission({ inputId: 'step-input-A', conversationRef: ref, text: '先说明一下' })
await stepConversation.submit({ inputId: 'step-input-A', submissionId: stepInputA.submissionId, conversationRef: ref, text: '先说明一下' })
source.append({ seq: 0, type: 'turn/start', data: { turn: 70 } })
source.append({ seq: 1, type: 'step/start', data: { turn: 70, step: 1 } })
source.append({ seq: 2, type: 'user/message', data: { turn: 70, source: { kind: 'user', rpcId: stepInputA.submissionId } } })
source.append({ seq: 3, type: 'assistant/message', data: { turn: 70, step: 1, message: { content: [{ type: 'text', text: '先开始处理。' }] } } })
source.append({ seq: 4, type: 'step/end', data: { turn: 70, step: 1 } })
source.append({ seq: 5, type: 'step/start', data: { turn: 70, step: 2 } })
source.append({ seq: 6, type: 'assistant/message', data: { turn: 70, step: 2, message: { content: [{ type: 'text', text: '工具返回后继续回答。' }] } } })
source.append({ seq: 7, type: 'step/end', data: { turn: 70, step: 2 } })
source.append({ seq: 8, type: 'turn/end', data: { turn: 70, reason: { kind: 'completed' } } })
await new Promise(resolve => setTimeout(resolve, 0))
const stepEvents = stepBatches.flatMap(batch => batch.events)
assert.ok(stepEvents.some(event => event.type === 'reply.message' && event.stepId.endsWith(':step:2') && event.submissionIds.includes(stepInputA.submissionId)), 'a tool-following step inherits the prior consumed-input watermark')
stopSteps()
await stepConversation.release(ref)

const originBatches = []
const originConversation = fixture()
await originConversation.retain(ref)
const stopOrigins = await originConversation.follow(ref, { onBatch: batch => originBatches.push(batch) })
const localOrigin = await originConversation.prepareSubmission({ inputId: 'origin-local', conversationRef: ref, text: '本地输入' })
await originConversation.submit({ inputId: 'origin-local', submissionId: localOrigin.submissionId, conversationRef: ref, text: '本地输入' })
source.append({ seq: 0, type: 'turn/start', data: { turn: 71 } })
source.append({ seq: 1, type: 'step/start', data: { turn: 71, step: 1 } })
source.append({ seq: 2, type: 'user/message', data: { turn: 71, source: { kind: 'user', rpcId: localOrigin.submissionId } } })
source.append({ seq: 3, type: 'user/message', data: { turn: 71, id: 'social-' + 'b'.repeat(64), source: { kind: 'chonkyfish-social' } } })
source.append({ seq: 4, type: 'assistant/message', data: { turn: 71, step: 1, message: { content: [{ type: 'text', text: '混合输入。' }] } } })
source.append({ seq: 5, type: 'step/end', data: { turn: 71, step: 1 } })
const localAfterMixed = await originConversation.prepareSubmission({ inputId: 'origin-local-after', conversationRef: ref, text: '新的本地输入' })
await originConversation.submit({ inputId: 'origin-local-after', submissionId: localAfterMixed.submissionId, conversationRef: ref, text: '新的本地输入' })
source.append({ seq: 6, type: 'step/start', data: { turn: 71, step: 2 } })
source.append({ seq: 7, type: 'user/message', data: { turn: 71, source: { kind: 'user', rpcId: localAfterMixed.submissionId } } })
source.append({ seq: 8, type: 'assistant/message', data: { turn: 71, step: 2, message: { content: [{ type: 'text', text: '新的本地回复。' }] } } })
await new Promise(resolve => setTimeout(resolve, 0))
const originSegments = originBatches.flatMap(batch => batch.events).filter(event => event.type === 'reply.message')
assert.equal(originSegments[0]?.origin, 'mixed', 'same-step social plus local input is ineligible')
assert.equal(originSegments[1]?.origin, 'local', 'a later local step is not contaminated by turn-wide social origin')
assert.ok(originSegments[1]?.inputIds.includes('origin-local-after'))
stopOrigins()
await originConversation.release(ref)

const taskBatches = []
const taskConversation = fixture()
await taskConversation.retain(ref)
const stopTasks = await taskConversation.follow(ref, { onBatch: batch => taskBatches.push(batch) })
const ownedTaskSource = { kind: 'chonkyfish-task-notice', taskId: 'task-1', version: 2, ownerConversationId: ref.conversationId, eventId: 'task-event-1', sourceInputId: 'origin-input-1' }
const ownedTaskId = 'chonkyfish-task-notice:task-event-1'
const localWithTask = await taskConversation.prepareSubmission({ inputId: 'local-with-task', conversationRef: ref, text: '任务情况如何' })
await taskConversation.submit({ inputId: 'local-with-task', submissionId: localWithTask.submissionId, conversationRef: ref, text: '任务情况如何' })
source.append({ seq: 0, type: 'turn/start', data: { turn: 72 } })
source.append({ seq: 1, type: 'step/start', data: { turn: 72, step: 1 } })
source.append({ seq: 2, type: 'user/message', data: { turn: 72, id: ownedTaskId, source: ownedTaskSource } })
source.append({ seq: 3, type: 'assistant/message', data: { turn: 72, step: 1, message: { content: [{ type: 'text', text: '任务仍在运行。' }] } } })
source.append({ seq: 4, type: 'user/message', data: { turn: 72, source: { kind: 'user', rpcId: localWithTask.submissionId } } })
source.append({ seq: 5, type: 'assistant/message', data: { turn: 72, step: 1, message: { content: [{ type: 'text', text: '我继续帮你处理。' }] } } })
source.append({ seq: 6, type: 'step/end', data: { turn: 72, step: 1 } })
source.append({ seq: 7, type: 'step/start', data: { turn: 72, step: 2 } })
source.append({ seq: 8, type: 'user/message', data: { turn: 72, id: 'chonkyfish-task-notice:foreign', source: { ...ownedTaskSource, eventId: 'foreign', ownerConversationId: 'another-session' } } })
source.append({ seq: 9, type: 'assistant/message', data: { turn: 72, step: 2, message: { content: [{ type: 'text', text: '无效归属的任务消息。' }] } } })
await new Promise(resolve => setTimeout(resolve, 0))
const taskEvents = taskBatches.flatMap(batch => batch.events)
assert.ok(taskEvents.some(event => event.type === 'input.consumed' && event.submissionId === ownedTaskId && event.origin === 'owned-task' && event.sourceInputId === ownedTaskSource.sourceInputId), 'a strictly owned task notice has its own consumed identity and origin')
const taskSegments = taskEvents.filter(event => event.type === 'reply.message')
assert.equal(taskSegments[0]?.origin, 'owned-task')
assert.ok(taskSegments[0]?.submissionIds.includes(ownedTaskId))
assert.equal(taskSegments[1]?.origin, 'local', 'local plus an owned task notice remains a valid local reply')
assert.ok(!taskEvents.some(event => event.type === 'input.consumed' && event.submissionId === 'chonkyfish-task-notice:foreign'), 'a task notice for another owner is never admitted')
assert.ok(!taskSegments.some(event => event.text === '无效归属的任务消息。'), 'invalid task metadata cannot become a speech-eligible segment')
stopTasks()
await taskConversation.release(ref)

const baselineConversation = fixture()
source.append({ seq: 1, type: 'turn/start', data: { turn: 20 } })
source.append({ seq: 2, type: 'user/message', data: { turn: 20, source: { kind: 'chonkyfish-nudge', form: 'notice' } } })
source.append({ seq: 3, type: 'assistant/message', data: { turn: 20, message: { content: [{ type: 'text', text: 'follow开始前的部分回答。' }] } } })
await baselineConversation.retain(ref)
const baselineBatches = []
const stopBaseline = await baselineConversation.follow(ref, { onBatch: batch => baselineBatches.push(batch) })
source.append({ seq: 4, type: 'assistant/message', data: { turn: 20, message: { content: [{ type: 'text', text: '补完旧回答。' }] } } })
source.append({ seq: 5, type: 'turn/end', data: { turn: 20, reason: { kind: 'completed' } } })
await new Promise(resolve => setTimeout(resolve, 0))
assert.ok(!baselineBatches.flatMap(batch => batch.events).some(event => event.type === 'reply.message'), 'a turn already running at follow baseline is never spoken')
stopBaseline()
await baselineConversation.dispose()

const failedTurnConversation = fixture()
await failedTurnConversation.retain(ref)
const failedTurnBatches = []
const stopFailedTurn = await failedTurnConversation.follow(ref, { onBatch: batch => failedTurnBatches.push(batch) })
const failedSubmission = await failedTurnConversation.prepareSubmission({ inputId: 'input-credential-error', conversationRef: ref, text: '请回答' })
await failedTurnConversation.submit({ submissionId: failedSubmission.submissionId, conversationRef: ref, text: '请回答' })
source.append({ seq: 1, type: 'turn/start', data: { turn: 90 } })
source.append({ seq: 2, type: 'user/message', data: { turn: 90, source: { kind: 'user', rpcId: failedSubmission.submissionId } } })
source.append({ seq: 3, type: 'turn/end', data: { turn: 90, reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'llm-deepseek: no API key is configured' } } } })
await new Promise(resolve => setTimeout(resolve, 0))
const turnFailure = failedTurnBatches.flatMap(batch => batch.events).find(event => event.type === 'turn.ended')
assert.equal(turnFailure?.outcome, 'failed')
assert.deepEqual(turnFailure?.error, { code: 'MISSING_CREDENTIAL', message: 'llm-deepseek: no API key is configured' })
stopFailedTurn()
await failedTurnConversation.dispose()

const stale = fixture()
await stale.retain(ref)
activeRef = { ...ref, conversationId: 'session-2' }
const rejected = await stale.submit({ submissionId: 'missing', conversationRef: ref, text: '不会发送' })
assert.equal(rejected.accepted, false)
assert.equal(rejected.outcome, 'not_applied')
assert.equal(submits, 0)
await stale.dispose()
await conversation.dispose()
const overlappingRetains = fixture()
const oldCallRef = { ...ref }, newCallRef = { ...ref }
await overlappingRetains.retain(oldCallRef, { scopeId: 'old-call' })
const oldBatches = [], newBatches = []
const stopOldCall = await overlappingRetains.follow(oldCallRef, { scopeId: 'old-call', onBatch: batch => oldBatches.push(batch) })
const oldCallSubmission = await overlappingRetains.prepareSubmission({ inputId: 'old-call-input', conversationRef: { ...oldCallRef }, scopeId: 'old-call', text: '旧通话迟到的消息' })
await overlappingRetains.submit({ submissionId: oldCallSubmission.submissionId, conversationRef: { ...oldCallRef }, scopeId: 'old-call', text: '旧通话迟到的消息' })
await overlappingRetains.retain(newCallRef, { scopeId: 'new-call' })
const stopNewCall = await overlappingRetains.follow(newCallRef, { scopeId: 'new-call', onBatch: batch => newBatches.push(batch) })
await assert.rejects(overlappingRetains.prepareSubmission({ inputId: 'ambiguous', conversationRef: { ...ref }, text: 'scope required' }), error => error.code === 'VOICE_SCOPE_REQUIRED')
await assert.rejects(overlappingRetains.release({ ...ref }), error => error.code === 'VOICE_SCOPE_REQUIRED')
const newCallSubmission = await overlappingRetains.prepareSubmission({ inputId: 'new-call-input', conversationRef: { ...newCallRef }, scopeId: 'new-call', text: '新通话仍可使用此Session' })
await overlappingRetains.submit({ submissionId: newCallSubmission.submissionId, conversationRef: { ...newCallRef }, scopeId: 'new-call', text: '新通话仍可使用此Session' })
assert.equal(retainCalls, 1, 'same-target calls share one independently retained Session reference')
source.append({ seq: 1, type: 'turn/start', data: { turn: 101 } })
source.append({ seq: 2, type: 'step/start', data: { turn: 101, step: 1 } })
source.append({ seq: 3, type: 'user/message', data: { turn: 101, source: { kind: 'user', rpcId: oldCallSubmission.submissionId } } })
source.append({ seq: 4, type: 'assistant/message', data: { turn: 101, step: 1, message: { content: [{ type: 'text', text: '旧通话迟到的回答。' }] } } })
source.append({ seq: 5, type: 'turn/end', data: { turn: 101, reason: { kind: 'completed' } } })
await new Promise(resolve => setTimeout(resolve, 0))
const oldEvents = oldBatches.flatMap(batch => batch.events)
const newEventsBeforeOldRelease = newBatches.flatMap(batch => batch.events)
assert.ok(oldEvents.some(event => event.type === 'input.consumed' && event.submissionId === oldCallSubmission.submissionId), 'the old owner still proves its late voice input')
assert.ok(!newEventsBeforeOldRelease.some(event => event.type === 'input.consumed' && event.submissionId === oldCallSubmission.submissionId), 'a new owner never consumes an old owner input')
assert.ok(!newEventsBeforeOldRelease.some(event => event.type === 'reply.message' && event.conversationTurnId.endsWith(':turn:101') && event.origin === 'local'), 'an old turn cannot become a local eligible reply in the new call')
source.append({ seq: 6, type: 'turn/start', data: { turn: 102 } })
source.append({ seq: 7, type: 'step/start', data: { turn: 102, step: 1 } })
source.append({ seq: 8, type: 'user/message', data: { turn: 102, source: { kind: 'user', rpcId: newCallSubmission.submissionId } } })
source.append({ seq: 9, type: 'assistant/message', data: { turn: 102, step: 1, message: { content: [{ type: 'text', text: '保留后的回答。' }] } } })
source.append({ seq: 10, type: 'turn/end', data: { turn: 102, reason: { kind: 'completed' } } })
await new Promise(resolve => setTimeout(resolve, 0))
const overlappingEvents = newBatches.flatMap(batch => batch.events)
assert.ok(overlappingEvents.some(event => event.type === 'input.consumed' && event.submissionId === newCallSubmission.submissionId), 'scope keeps the new call identity separate from old evidence')
assert.ok(overlappingEvents.some(event => event.type === 'reply.message' && event.conversationTurnId.endsWith(':turn:102') && event.origin === 'local'), 'new call retains its own eligible reply correlation')
stopNewCall()
await overlappingRetains.release({ ...newCallRef }, { scopeId: 'new-call' })
assert.equal(retainedReleaseCount, 0, 'the new call can end before the old drain releases its own owner')
stopOldCall()
await overlappingRetains.release({ ...oldCallRef }, { scopeId: 'old-call' })
assert.equal(retainedReleaseCount, 1, 'the Session reference is released after the final call release')
await overlappingRetains.dispose()

const integratedRef = { runtimeId: 'dsh:host-integration', conversationId: 'session-integration', bindingRevision: 'binding-integration' }
const integratedEntries = [], integratedSubscribers = new Set()
let integratedRetainCount = 0, integratedPrompts = 0, integratedCaptureEvent
const integratedEventSource = {
  getSnapshot() { return { entries: [...integratedEntries], revision: integratedEntries.length } },
  subscribe(listener) { integratedSubscribers.add(listener); return () => integratedSubscribers.delete(listener) },
  append(event) { integratedEntries.push({ event }); for (const listener of integratedSubscribers) listener() },
}
const integratedSession = {
  sessionId: integratedRef.conversationId,
  ready: Promise.resolve(),
  getSnapshot() { return { running: false, pendingSubmissions: [] } },
  beginSubmission({ onAccept, onRetire }) {
    const requestId = `integration-request-${++integratedPrompts}`
    return { requestId, onAccept, onRetire, abandon() {} }
  },
  async prompt(_content, _mode, _signal, requestId) {
    const preparedRequest = `integration-request-${integratedPrompts}`
    assert.equal(requestId, preparedRequest)
    const acceptedSubmission = activeSubmissionCallbacks.get(requestId)
    acceptedSubmission?.onAccept()
    integratedEventSource.append({ seq: 1, type: 'turn/start', data: { turn: 1 } })
    integratedEventSource.append({ seq: 2, type: 'step/start', data: { turn: 1, step: 1 } })
    integratedEventSource.append({ seq: 3, type: 'user/message', data: { turn: 1, source: { kind: 'user', rpcId: requestId } } })
    integratedEventSource.append({ seq: 4, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '跨层集成回复。' }] } } })
    integratedEventSource.append({ seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    return { ok: true, value: { accepted: true } }
  },
}
const activeSubmissionCallbacks = new Map()
const integratedSessionWithCallbacks = {
  ...integratedSession,
  beginSubmission(args) {
    const created = integratedSession.beginSubmission(args)
    activeSubmissionCallbacks.set(created.requestId, created)
    return created
  },
}
const integratedChat = {
  getVoiceTarget(runtimeId) { return runtimeId === integratedRef.runtimeId ? { ...integratedRef } : null },
  getVoiceBinding(candidate) { return candidate && candidate.runtimeId === integratedRef.runtimeId && candidate.conversationId === integratedRef.conversationId && candidate.bindingRevision === integratedRef.bindingRevision ? { session: integratedSessionWithCallbacks, eventSource: integratedEventSource, sessionId: integratedRef.conversationId } : null },
  async retainVoiceBinding(candidate) {
    if (!candidate || candidate.runtimeId !== integratedRef.runtimeId || candidate.conversationId !== integratedRef.conversationId || candidate.bindingRevision !== integratedRef.bindingRevision) throw new Error('stale integration target')
    integratedRetainCount++
    return { session: integratedSessionWithCallbacks, eventSource: integratedEventSource, sessionId: integratedRef.conversationId, release() { integratedRetainCount-- } }
  },
}
const integratedRegistrations = new Map()
const integratedConversation = createDshConversation({ chat: integratedChat,
  async registerVoiceSource(payload) { integratedRegistrations.set(payload.submissionId, payload); return { registered: true } },
  async releaseVoiceSource({ submissionId }) { return integratedRegistrations.delete(submissionId) },
})
const integratedAudio = createMemoryAudioStore()
const integratedCapture = {
  async inspect() { return { available: true } },
  async start({ onEvent }) { integratedCaptureEvent = onEvent },
  cut({ startSample, endSample }) { return integratedAudio.putClip(new Int16Array(endSample - startSample)) },
  async setTurnActive() {}, async gate() {}, async stop() {}, async release() {},
}
let integratedId = 0
const integratedService = createVoiceService({
  capture: integratedCapture,
  recognition: { async inspect() { return { available: true, selection: { providerId: 'fixture-asr', language: 'zh-CN' } } }, async transcribe() { return { text: '跨层语音输入' } } },
  conversation: integratedConversation,
  synthesis: { async inspect() { return { available: true } }, async synthesize() { return { clipRef: integratedAudio.putClip(new Int16Array(1600)) } }, release(refToRelease) { integratedAudio.release(refToRelease) } },
  playback: { async inspect() { return { available: true } }, async unlock() { return { ready: true } }, async play(_clip, options) { options.onStarted?.(); options.onEnded?.(); return { ended: true } }, async stop() {}, async release() {} },
  ownership: { async acquire() { return { valid: true, leaseMs: 15000 } }, async renew() { return { valid: true, leaseMs: 15000 } }, async release() {} },
  audio: integratedAudio,
  clock: { monoNow: () => 0, schedule() { return {} }, cancel() {} },
  ids: { createId(kind) { return `${kind}-${++integratedId}` } },
  config: { ...DEFAULT_VOICE_CONFIG, replyAudioEnabled: false },
})
await integratedService.start({ ...integratedRef }, { unlockResult: { ready: true }, selection: { providerId: 'fixture-asr', language: 'zh-CN' } })
integratedCaptureEvent({ type: 'speech-start', sampleIndex: 1000 })
integratedCaptureEvent({ type: 'speech-end', sampleIndex: 3000 })
integratedCaptureEvent({ type: 'samples', sampleIndex: 22200 })
for (let i = 0; i < 80 && integratedPrompts === 0; i++) await new Promise(resolve => setTimeout(resolve, 0))
for (let i = 0; i < 100 && !integratedService.getSnapshot().replies.some(reply => reply.origin === 'local' && reply.conversationTurnId.endsWith(':turn:1')); i++) await new Promise(resolve => setTimeout(resolve, 0))
const integratedSnapshot = integratedService.getSnapshot()
assert.equal(integratedPrompts, 1, 'the real core can prepare and submit through the real DSH adapter when each API receives cloned ConversationRefs')
assert.equal(integratedSnapshot.inputs[0]?.admission, 'accepted')
assert.ok(integratedSnapshot.replies.some(reply => reply.origin === 'local' && reply.conversationTurnId.endsWith(':turn:1')), 'the core receives owner-scoped consumed/reply events from the Session stream')
await integratedService.hangup({ abandonPending: true })
await integratedService.dispose()
await integratedConversation.dispose()
assert.equal(integratedRetainCount, 0, 'the real scoped owner releases its Session reference after hangup')

const rejectionBoundedConversation = fixture()
await rejectionBoundedConversation.retain(ref)
nextPromptResult = { ok: false, error: { code: 'session/agent-busy', message: 'known pre-admission rejection' } }
for (let index = 0; index < 520; index++) {
  const requestId = `input-rejected-${index}`
  const preparedRejection = await rejectionBoundedConversation.prepareSubmission({ inputId: requestId, conversationRef: ref, text: 'rejected before admission' })
  const rejected = await rejectionBoundedConversation.submit({ inputId: requestId, submissionId: preparedRejection.submissionId, conversationRef: ref, text: 'rejected before admission' })
  assert.equal(rejected.outcome, 'not_applied')
}
nextPromptResult = null
await rejectionBoundedConversation.dispose()
assert.ok(clearedSets > 0, 'stopping follow clears retained callbacks')
const registrationCalls = [], releaseCalls = []
const registrationDenied = fixture({
  async registerVoiceSource(payload) { registrationCalls.push(payload); throw Object.assign(new Error('registration denied'), { code: 'VOICE_SOURCE_REGISTRATION_FAILED', outcome: 'not_applied' }) },
  async releaseVoiceSource(payload) { releaseCalls.push(payload); return true },
})
await registrationDenied.retain(ref)
await assert.rejects(registrationDenied.prepareSubmission({ inputId: 'voice-denied', conversationRef: ref, text: '登记失败' }), error => error.outcome === 'not_applied')
assert.equal(registrationCalls[0].submissionId, 'request-1', 'the source registration uses the existing beginSubmission identity')
assert.equal(submits, 0, 'a denied source registration cannot call session.prompt')
assert.deepEqual(abandoned, ['request-1'], 'the locally prepared DSH submission is abandoned on registration denial')
assert.equal(releaseCalls[0].submissionId, 'request-1', 'a late or uncertain Host registration is cleaned up')
await registrationDenied.dispose()
console.log('voice DSH conversation adapter: 1 passed')
