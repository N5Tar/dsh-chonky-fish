import assert from 'node:assert/strict'
import { createTaskService } from '../service.js'

function repository() {
  const rows = new Map()
  const operations = new Map()
  const events = []
  const delivered = new Set()
  return {
    rows, operations, events,
    createTask(task, operation) {
      const old = operations.get(operation.id)
      if (old) return { duplicate: true, operation: old, task: rows.get(old.taskId) }
      const busy = [...rows.values()].some(row => row.resources.some(key => task.resources.includes(key)) && !['completed', 'failed', 'cancelled'].includes(row.status))
      if (busy) return { busy: true }
      rows.set(task.id, structuredClone(task)); operations.set(operation.id, structuredClone(operation));
      events.push({ taskId: task.id, version: task.version, type: task.status })
      return { duplicate: false, operation, task }
    },
    getTask(id) { return structuredClone(rows.get(id) ?? null) },
    getOperation(id) { const op = operations.get(id); return op && { ...structuredClone(op), task: structuredClone(rows.get(op.taskId)) } },
    recordCancelIntent({ operation, expectedVersion }) {
      const previous = operations.get(operation.id)
      if (previous) return { duplicate: true, operation: structuredClone(previous), task: structuredClone(rows.get(previous.taskId)) }
      const row = rows.get(operation.taskId)
      if (!row || row.version !== expectedVersion) return { stale: true, task: structuredClone(row ?? null) }
      const next = { ...row, status: 'stopping', cancelOperationId: operation.id, summary: 'stop requested', version: row.version + 1, updatedAt: Date.now() }
      operations.set(operation.id, structuredClone(operation)); rows.set(next.id, next); events.push({ taskId: next.id, version: next.version, type: 'task.stopping' })
      return { duplicate: false, operation: structuredClone(operation), task: structuredClone(next) }
    },
    updateTask(id, version, patch, event) {
      const row = rows.get(id); if (!row || row.version !== version) return null
      const next = { ...row, ...patch, version: row.version + 1, updatedAt: Date.now() }
      rows.set(id, next); events.push({ taskId: id, version: next.version, type: event }); return structuredClone(next)
    },
    listTasks(owner) { return [...rows.values()].filter(row => row.owner.namespaceId === owner.namespaceId && row.owner.conversationId === owner.conversationId).map(row => structuredClone(row)) },
    listAllTasks() { return [...rows.values()].map(row => structuredClone(row)) },
    readEvents(id, afterVersion = 0) { return events.filter(event => event.taskId === id && event.version > afterVersion).map(event => structuredClone(event)) },
    getPendingEvents() { return events.filter(event => !delivered.has(`${event.taskId}:v${event.version}`)).map(event => ({ ...structuredClone(event), eventId: `${event.taskId}:v${event.version}`, owner: structuredClone(rows.get(event.taskId).owner), sourceInputId: rows.get(event.taskId).sourceInputId, summary: rows.get(event.taskId).summary, createdAt: Date.now() })) },
    markEventDelivered(eventId) { delivered.add(eventId); return true },
    close() {},
  }
}

const repo = repository()
let release
const gate = new Promise(resolve => { release = resolve })
const events = []
let settlePendingWatch
let pendingWatchAborted = false
const service = createTaskService({ repository: repo, adapters: { fake: {
  deriveResources: (_name, args) => args.target ? [`file:${args.target}`] : [],
  async execute({ command, signal }) { await gate; if (signal.aborted) throw signal.reason; return { ok: true, value: command.value } },
  cancel: async () => ({ stopped: false }),
}, native: {
  completionScope: 'external-task',
  deriveResources: (_name, args) => args.target ? [`native:${args.target}`] : [],
  async execute() { return { externalHandle: 'native-42' } },
  async watch({ signal }) { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { status: 'unknown' } },
  async cancel() { return { stopped: false } },
}, pending: {
  completionScope: 'external-task',
  deriveResources: () => ['native:pending'],
  async execute() { return { externalHandle: 'native-pending' } },
  async watch({ signal }) { signal.addEventListener('abort', () => { pendingWatchAborted = true }, { once: true }); return new Promise(resolve => { settlePendingWatch = resolve }) },
  async cancel() { return { pending: true } },
} }, onEvent: event => events.push(event) })
const owner = { namespaceId: 'host-stable', conversationId: 'session-1' }
const started = await service.start({ owner, operationId: 'op-1', adapter: 'fake', command: { name: 'write', args: { target: 'x', value: 7 } }, sourceInputId: 'input-1' })
assert.equal(started.status, 'accepted')
assert.ok(repo.getOperation('op-1'), 'operation intent is durable before dispatch')
assert.equal((await service.start({ owner, operationId: 'op-1', adapter: 'fake', command: { name: 'write', args: { target: 'x', value: 7 } }, sourceInputId: 'input-1' })).taskId, started.taskId)
await assert.rejects(service.start({ owner, operationId: 'op-1', adapter: 'fake', command: { name: 'other', args: { target: 'x' } }, sourceInputId: 'input-1' }), { code: 'OPERATION_CONFLICT' })
await assert.rejects(service.start({ owner: { ...owner, conversationId: 'session-2' }, operationId: 'op-2', adapter: 'fake', command: { name: 'write', args: { target: 'x' } }, sourceInputId: 'input-2' }), { code: 'RESOURCE_BUSY' })
const inspected = service.inspect({ owner, taskId: started.taskId })
assert.equal(inspected.status, 'running')
assert.ok(service.observe({ owner, taskId: started.taskId }).length)
const cancel = await service.cancel({ owner, taskId: started.taskId, operationId: 'cancel-1', expectedVersion: inspected.version })
assert.equal(cancel.status, 'stopping', 'cancel returns before the adapter outcome and persists the stop request')
await new Promise(resolve => setImmediate(resolve))
assert.equal(service.inspect({ owner, taskId: started.taskId }).status, 'stopping', 'unconfirmed cancellation keeps observing under the resource lock')
assert.equal((await service.cancel({ owner, taskId: started.taskId, operationId: 'cancel-1', expectedVersion: inspected.version })).status, 'stopping', 'duplicate cancel returns current outcome without dispatching another cancellation')
assert.equal(await service.start({ owner: { ...owner, conversationId: 'session-2' }, operationId: 'op-3', adapter: 'fake', command: { name: 'write', args: { target: 'x' } }, sourceInputId: 'input-3' }).catch(e => e.code), 'RESOURCE_BUSY')
const native = await service.start({ owner, operationId: 'op-native', adapter: 'native', command: { name: 'start-native', args: { target: 'y' } }, sourceInputId: 'input-1' })
await new Promise(resolve => setImmediate(resolve))
const nativeInspect = service.inspect({ owner, taskId: native.taskId })
assert.equal(nativeInspect.externalHandle, 'native-42')
assert.equal(nativeInspect.completionScope, 'external-task')
assert.equal((await service.cancel({ owner, taskId: native.taskId, operationId: 'cancel-native', expectedVersion: nativeInspect.version })).status, 'stopping')
await new Promise(resolve => setImmediate(resolve))
assert.equal(service.inspect({ owner, taskId: native.taskId }).status, 'stopping', 'cancel rejection does not stop the authoritative observer')
const pending = await service.start({ owner, operationId: 'op-pending', adapter: 'pending', command: { name: 'start', args: {} }, sourceInputId: 'input-1' })
await new Promise(resolve => setImmediate(resolve))
const pendingBeforeCancel = service.inspect({ owner, taskId: pending.taskId })
const pendingCancel = await service.cancel({ owner, taskId: pending.taskId, operationId: 'cancel-pending', expectedVersion: pendingBeforeCancel.version })
assert.equal(pendingCancel.status, 'stopping')
assert.equal(pendingWatchAborted, false, 'a queued cancellation continues observing until an authoritative result arrives')
settlePendingWatch({ status: 'cancelled' })
for (let attempt = 0; attempt < 10 && service.inspect({ owner, taskId: pending.taskId }).status !== 'cancelled'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(service.inspect({ owner, taskId: pending.taskId }).status, 'cancelled')

let releaseRecoverWatch, recoveredCancelInput, recoveredWatchCount = 0
const recoveringRepo = repository()
const recoveringService = createTaskService({ repository: recoveringRepo, adapters: { recoverable: {
  completionScope: 'external-task', deriveResources: () => ['native:recoverable'], async execute() { return { externalHandle: 'recoverable-handle' } },
  async watch({ signal }) { recoveredWatchCount++; return new Promise(resolve => { releaseRecoverWatch = resolve; signal.addEventListener('abort', () => resolve({ status: 'outcome-unknown' }), { once: true }) }) },
  async cancel(input) { recoveredCancelInput = input; return { pending: true } },
  async recover({ operationId }) { assert.equal(operationId, 'op-recover-cancel'); return { status: 'running', completionScope: 'external-task', externalHandle: 'recoverable-handle' } },
} } })
const recoveringTask = await recoveringService.start({ owner, operationId: 'op-recover-cancel', adapter: 'recoverable', command: { name: 'start', args: {} }, sourceInputId: 'input-recover-cancel' })
for (let attempt = 0; attempt < 10 && !releaseRecoverWatch; attempt++) await new Promise(resolve => setImmediate(resolve))
const beforeRecoveryCancel = recoveringService.inspect({ owner, taskId: recoveringTask.taskId })
await recoveringService.cancel({ owner, taskId: recoveringTask.taskId, operationId: 'cancel-recover-same-id', expectedVersion: beforeRecoveryCancel.version })
await recoveringService.close()
assert.equal(recoveringRepo.getTask(recoveringTask.taskId).status, 'outcome-unknown', 'close preserves uncertainty rather than claiming an external stop')
let recoveredCancelCalls = 0
const recoveringAfterRestart = createTaskService({ repository: recoveringRepo, adapters: { recoverable: {
  completionScope: 'external-task', deriveResources: () => ['native:recoverable'], async execute() { throw new Error('must not replay start') },
  async watch() { recoveredWatchCount++; return new Promise(resolve => { releaseRecoverWatch = resolve }) },
  async cancel(input) { recoveredCancelCalls++; recoveredCancelInput = input; return { pending: true } },
  async recover({ operationId }) { assert.equal(operationId, 'op-recover-cancel'); return { status: 'running', completionScope: 'external-task', externalHandle: 'recoverable-handle' } },
} } })
await recoveringAfterRestart.recover()
for (let attempt = 0; attempt < 10 && recoveredCancelCalls === 0; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(recoveringAfterRestart.inspect({ owner, taskId: recoveringTask.taskId }).status, 'stopping', 'recovery retains the durable cancellation intent')
assert.equal(recoveredCancelCalls, 1, 'recovery resumes cancellation once the original external handle is confirmed')
assert.equal(recoveredCancelInput.operationId, 'cancel-recover-same-id', 'recovery uses the original idempotency identity')
assert.equal(recoveredCancelInput.externalHandle, 'recoverable-handle')
assert.ok(recoveredWatchCount >= 2, 'recovery creates a fresh observer')
releaseRecoverWatch({ status: 'cancelled' })
for (let attempt = 0; attempt < 10 && recoveringAfterRestart.inspect({ owner, taskId: recoveringTask.taskId }).status !== 'cancelled'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(recoveringAfterRestart.inspect({ owner, taskId: recoveringTask.taskId }).status, 'cancelled')
await recoveringAfterRestart.close()

let firstWatch = true, secondWatchResolve, watchRecoverCalls = 0, watchCancelCalls = 0
const watchFailureRepo = repository()
const watchFailureService = createTaskService({ repository: watchFailureRepo, adapters: { watchFailure: {
  completionScope: 'external-task', deriveResources: () => ['native:watch-failure'], async execute() { return { externalHandle: 'watch-failure-handle' } },
  async watch() { watchRecoverCalls++; if (firstWatch) { firstWatch = false; throw new Error('temporary status RPC failure') } return new Promise(resolve => { secondWatchResolve = resolve }) },
  async recover() { return { status: 'running', completionScope: 'external-task', externalHandle: 'watch-failure-handle' } },
  async cancel() { watchCancelCalls++; return { pending: true } },
} } })
const watchFailureTask = await watchFailureService.start({ owner, operationId: 'op-watch-failure', adapter: 'watchFailure', command: { name: 'start', args: {} }, sourceInputId: 'input-watch-failure' })
for (let attempt = 0; attempt < 10 && watchFailureService.inspect({ owner, taskId: watchFailureTask.taskId }).status !== 'outcome-unknown'; attempt++) await new Promise(resolve => setImmediate(resolve))
const unknownWatchTask = watchFailureService.inspect({ owner, taskId: watchFailureTask.taskId })
await watchFailureService.cancel({ owner, taskId: watchFailureTask.taskId, operationId: 'cancel-after-watch-failure', expectedVersion: unknownWatchTask.version })
for (let attempt = 0; attempt < 10 && watchCancelCalls === 0; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(watchCancelCalls, 1, 'cancel after watch failure performs one cancellation RPC')
assert.equal(watchRecoverCalls, 2, 'cancel after watch failure reattaches the observer from the existing operation')
assert.ok(secondWatchResolve, 'watch is recreated instead of leaving the resource indefinitely stopping')
secondWatchResolve({ status: 'cancelled' })
for (let attempt = 0; attempt < 10 && watchFailureService.inspect({ owner, taskId: watchFailureTask.taskId }).status !== 'cancelled'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(watchFailureService.inspect({ owner, taskId: watchFailureTask.taskId }).status, 'cancelled')
await watchFailureService.close()

let rejectDuringCancelWatch, settleDuringCancelRpc
const cancelConfirmationRepo = repository()
const cancelConfirmationService = createTaskService({ repository: cancelConfirmationRepo, adapters: { cancelConfirmation: {
  completionScope: 'external-task', deriveResources: () => ['native:cancel-confirmation'], async execute() { return { externalHandle: 'cancel-confirmation-handle' } },
  async watch() { return new Promise((_, reject) => { rejectDuringCancelWatch = reject }) },
  async cancel() { return new Promise(resolve => { settleDuringCancelRpc = resolve }) },
} } })
const cancelConfirmationTask = await cancelConfirmationService.start({ owner, operationId: 'op-cancel-confirmation', adapter: 'cancelConfirmation', command: { name: 'start', args: {} }, sourceInputId: 'input-cancel-confirmation' })
for (let attempt = 0; attempt < 10 && !rejectDuringCancelWatch; attempt++) await new Promise(resolve => setImmediate(resolve))
const cancelConfirmationSnapshot = cancelConfirmationService.inspect({ owner, taskId: cancelConfirmationTask.taskId })
await cancelConfirmationService.cancel({ owner, taskId: cancelConfirmationTask.taskId, operationId: 'cancel-confirmation-same-id', expectedVersion: cancelConfirmationSnapshot.version })
for (let attempt = 0; attempt < 10 && !settleDuringCancelRpc; attempt++) await new Promise(resolve => setImmediate(resolve))
rejectDuringCancelWatch(new Error('observer failed during cancellation'))
for (let attempt = 0; attempt < 10 && cancelConfirmationService.inspect({ owner, taskId: cancelConfirmationTask.taskId }).status !== 'outcome-unknown'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(cancelConfirmationService.inspect({ owner, taskId: cancelConfirmationTask.taskId }).status, 'outcome-unknown')
settleDuringCancelRpc({ stopped: true })
for (let attempt = 0; attempt < 10 && cancelConfirmationService.inspect({ owner, taskId: cancelConfirmationTask.taskId }).status !== 'cancelled'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(cancelConfirmationService.inspect({ owner, taskId: cancelConfirmationTask.taskId }).status, 'cancelled', 'authoritative stop confirmation settles outcome-unknown for the same cancellation intent')
await cancelConfirmationService.close()

let releaseStartReceipt, startWatchResolve, deferredCancelInput, deferredCancelCalls = 0
const deferredHandleService = createTaskService({ repository: repository(), adapters: { deferredHandle: {
  completionScope: 'external-task', deriveResources: () => ['native:deferred-handle'],
  async execute() { return new Promise(resolve => { releaseStartReceipt = () => resolve({ externalHandle: 'late-start-handle' }) }) },
  async recover() { return null },
  async watch() { return new Promise(resolve => { startWatchResolve = resolve }) },
  async cancel(input) { deferredCancelCalls++; deferredCancelInput = input; return { pending: true } },
} } })
const deferredHandleTask = await deferredHandleService.start({ owner, operationId: 'op-deferred-handle', adapter: 'deferredHandle', command: { name: 'start', args: {} }, sourceInputId: 'input-deferred-handle' })
await new Promise(resolve => setImmediate(resolve))
const deferredSnapshot = deferredHandleService.inspect({ owner, taskId: deferredHandleTask.taskId })
await deferredHandleService.cancel({ owner, taskId: deferredHandleTask.taskId, operationId: 'cancel-deferred-handle', expectedVersion: deferredSnapshot.version })
await new Promise(resolve => setImmediate(resolve))
assert.equal(deferredCancelCalls, 0, 'cancellation waits while start is still dispatching and has no external handle')
releaseStartReceipt()
for (let attempt = 0; attempt < 10 && !deferredCancelInput; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(deferredCancelInput.externalHandle, 'late-start-handle', 'cancellation uses the handle returned by the original start operation')
assert.equal(deferredCancelCalls, 1, 'cancellation is issued once after the original dispatch returns its handle')
assert.ok(startWatchResolve, 'the late start receipt still attaches its observer while stopping')
startWatchResolve({ status: 'cancelled' })
for (let attempt = 0; attempt < 10 && deferredHandleService.inspect({ owner, taskId: deferredHandleTask.taskId }).status !== 'cancelled'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(deferredHandleService.inspect({ owner, taskId: deferredHandleTask.taskId }).status, 'cancelled')
await deferredHandleService.close()

let lostReceiptCancelInput, lostReceiptWatchResolve
const lostReceiptService = createTaskService({ repository: repository(), adapters: { lostReceipt: {
  completionScope: 'external-task', deriveResources: () => ['native:lost-receipt'], async execute() { throw new Error('start receipt was lost after dispatch') },
  async recover({ operationId }) { assert.equal(operationId, 'op-lost-receipt'); return { status: 'running', completionScope: 'external-task', externalHandle: 'recovered-after-lost-receipt' } },
  async watch() { return new Promise(resolve => { lostReceiptWatchResolve = resolve }) },
  async cancel(input) { lostReceiptCancelInput = input; return { pending: true } },
} } })
const lostReceiptTask = await lostReceiptService.start({ owner, operationId: 'op-lost-receipt', adapter: 'lostReceipt', command: { name: 'start', args: {} }, sourceInputId: 'input-lost-receipt' })
for (let attempt = 0; attempt < 10 && lostReceiptService.inspect({ owner, taskId: lostReceiptTask.taskId }).status !== 'outcome-unknown'; attempt++) await new Promise(resolve => setImmediate(resolve))
const lostReceiptSnapshot = lostReceiptService.inspect({ owner, taskId: lostReceiptTask.taskId })
await lostReceiptService.cancel({ owner, taskId: lostReceiptTask.taskId, operationId: 'cancel-lost-receipt', expectedVersion: lostReceiptSnapshot.version })
for (let attempt = 0; attempt < 10 && !lostReceiptCancelInput; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(lostReceiptCancelInput.externalHandle, 'recovered-after-lost-receipt', 'cancel resolves a lost start receipt by recovering the original operation handle')
assert.ok(lostReceiptWatchResolve, 'lost start receipt recovery reattaches the external observer')
lostReceiptWatchResolve({ status: 'cancelled' })
for (let attempt = 0; attempt < 10 && lostReceiptService.inspect({ owner, taskId: lostReceiptTask.taskId }).status !== 'cancelled'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(lostReceiptService.inspect({ owner, taskId: lostReceiptTask.taskId }).status, 'cancelled')
await lostReceiptService.close()

let finishDuplicateProgressWatch
const duplicateProgressService = createTaskService({ repository: repository(), adapters: { duplicateProgress: {
  completionScope: 'external-task', deriveResources: () => [], async execute() { return { externalHandle: 'progress-handle' } },
  async watch({ onProgress }) { onProgress({ status: 'running', progress: 4 }); const once = duplicateProgressService.inspect({ owner, taskId: progressTask.taskId }).version; onProgress({ status: 'running', progress: 4 }); const twice = duplicateProgressService.inspect({ owner, taskId: progressTask.taskId }).version; finishDuplicateProgressWatch = { once, twice }; return new Promise(resolve => { finishDuplicateProgressWatch.resolve = resolve }) },
} } })
const progressTask = await duplicateProgressService.start({ owner, operationId: 'op-duplicate-progress', adapter: 'duplicateProgress', command: { name: 'start', args: {} }, sourceInputId: 'input-duplicate-progress' })
for (let attempt = 0; attempt < 10 && !finishDuplicateProgressWatch; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(finishDuplicateProgressWatch.twice, finishDuplicateProgressWatch.once, 'repeated identical polling progress does not churn task versions')
assert.ok(finishDuplicateProgressWatch.once > 1, 'a real progress change still advances the task version')
finishDuplicateProgressWatch.resolve({ status: 'completed' })
for (let attempt = 0; attempt < 10 && duplicateProgressService.inspect({ owner, taskId: progressTask.taskId }).status !== 'completed'; attempt++) await new Promise(resolve => setImmediate(resolve))
await duplicateProgressService.close()
release()
for (let attempt = 0; attempt < 10 && service.inspect({ owner, taskId: started.taskId }).status !== 'completed'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(service.inspect({ owner, taskId: started.taskId }).status, 'completed', 'a tool invocation that finishes during stopping wins with its authoritative result')
const abandoned = { id: 'host-restart-task', operationId: 'op-restart', owner, sourceInputId: 'input-1', adapter: 'fake', command: { name: 'write', args: {} }, commandDigest: 'restart-digest', resources: [], status: 'running', version: 1, createdAt: Date.now(), updatedAt: Date.now() }
repo.createTask(abandoned, { id: abandoned.operationId, taskId: abandoned.id, owner, commandDigest: abandoned.commandDigest })
let replayCount = 0
const restarted = createTaskService({ repository: repo, adapters: { fake: { deriveResources: () => [], execute: async () => { replayCount++ } } } })
await restarted.recover()
assert.equal(repo.getTask(abandoned.id).status, 'outcome-unknown')
assert.equal(replayCount, 0, 'restart preserves uncertain state without replaying side effects')
assert.ok(events.every(event => event.owner.namespaceId === owner.namespaceId && event.owner.conversationId === owner.conversationId))
await restarted.close()
await service.close()

const uncertainRepo = repository()
const uncertainService = createTaskService({ repository: uncertainRepo, adapters: {
  uncertain: { deriveResources: () => ['shared:uncertain'], async execute() { throw new Error('dispatch reply was lost') } },
  certainFailure: { deriveResources: () => ['shared:terminal'], async execute() { throw Object.assign(new Error('authoritative tool failure'), { taskOutcome: { status: 'failed', authoritative: true } }) } },
} })
const uncertain = await uncertainService.start({ owner, operationId: 'op-uncertain', adapter: 'uncertain', command: { name: 'external-start', args: {} }, sourceInputId: 'input-uncertain' })
for (let attempt = 0; attempt < 10 && uncertainService.inspect({ owner, taskId: uncertain.taskId }).status === 'running'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(uncertainService.inspect({ owner, taskId: uncertain.taskId }).status, 'outcome-unknown', 'a post-dispatch exception cannot prove that the external effect did not happen')
assert.equal(await uncertainService.start({ owner: { ...owner, conversationId: 'session-other' }, operationId: 'op-uncertain-conflict', adapter: 'uncertain', command: { name: 'external-start', args: {} }, sourceInputId: 'input-other' }).catch(error => error.code), 'RESOURCE_BUSY', 'unknown dispatch keeps the resource locked')
const terminalError = await uncertainService.start({ owner, operationId: 'op-terminal-error', adapter: 'certainFailure', command: { name: 'sync', args: {} }, sourceInputId: 'input-uncertain' })
for (let attempt = 0; attempt < 10 && uncertainService.inspect({ owner, taskId: terminalError.taskId }).status === 'running'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(uncertainService.inspect({ owner, taskId: terminalError.taskId }).status, 'failed', 'an adapter may release resources only with an authoritative terminal outcome')
await uncertainService.close()

let releaseSlowCancel, finishObservedTask, watchedTaskSignal, cancelRpcSignal, slowCancelCalls = 0
const slowCancelRepo = repository()
const slowCancelService = createTaskService({ repository: slowCancelRepo, adapters: { slowCancel: {
  completionScope: 'external-task', deriveResources: () => ['shared:slow-cancel'], async execute() { return { externalHandle: 'slow-cancel-handle' } },
  async watch({ signal }) { watchedTaskSignal = signal; return new Promise(resolve => { finishObservedTask = resolve }) },
  async cancel({ signal }) { cancelRpcSignal = signal; slowCancelCalls++; return new Promise(resolve => { releaseSlowCancel = resolve }) },
} } })
const slowCancelTask = await slowCancelService.start({ owner, operationId: 'op-slow-cancel', adapter: 'slowCancel', command: { name: 'start', args: {} }, sourceInputId: 'input-cancel' })
for (let attempt = 0; attempt < 10 && !finishObservedTask; attempt++) await new Promise(resolve => setImmediate(resolve))
const slowCancelSnapshot = slowCancelService.inspect({ owner, taskId: slowCancelTask.taskId })
const fastReceipt = await Promise.race([
  slowCancelService.cancel({ owner, taskId: slowCancelTask.taskId, operationId: 'cancel-slow', expectedVersion: slowCancelSnapshot.version }),
  new Promise((_, reject) => setTimeout(() => reject(new Error('cancel RPC blocked the foreground receipt')), 30)),
])
assert.equal(fastReceipt.status, 'stopping', 'cancel returns its persisted stopping receipt without waiting for adapter RPC')
const duplicateReceipt = await slowCancelService.cancel({ owner, taskId: slowCancelTask.taskId, operationId: 'cancel-slow', expectedVersion: slowCancelSnapshot.version })
assert.equal(duplicateReceipt.status, 'stopping', 'duplicate cancel with the same operation ID is idempotent')
for (let attempt = 0; attempt < 10 && slowCancelCalls === 0; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(slowCancelCalls, 1, 'a duplicate cancel does not dispatch another adapter request')
assert.ok(watchedTaskSignal instanceof AbortSignal && cancelRpcSignal instanceof AbortSignal && watchedTaskSignal !== cancelRpcSignal, 'cancellation RPC has its own signal and does not abort the authoritative watcher')
finishObservedTask({ status: 'completed', summary: 'operation completed before cancellation acknowledgement' })
for (let attempt = 0; attempt < 10 && slowCancelService.inspect({ owner, taskId: slowCancelTask.taskId }).status !== 'completed'; attempt++) await new Promise(resolve => setImmediate(resolve))
releaseSlowCancel({ stopped: true })
await new Promise(resolve => setImmediate(resolve))
assert.equal(slowCancelService.inspect({ owner, taskId: slowCancelTask.taskId }).status, 'completed', 'late cancellation receipt cannot overwrite an authoritative completion')
await slowCancelService.close()

const retryRepo = repository()
const retryOwner = { namespaceId: 'host-stable', conversationId: 'retry-session' }
const retryAttempts = []
const retryTimers = []
let allowAck = false
const retryService = createTaskService({
  repository: retryRepo,
  adapters: { sync: { deriveResources: () => [], async execute() { return { ok: true } } } },
  onEvent: async event => { retryAttempts.push(event); return { acknowledged: allowAck } },
  setTimeoutFn(callback, delay) { const timer = { callback, delay, unref() {} }; retryTimers.push(timer); return timer },
  clearTimeoutFn(timer) { timer.cancelled = true },
})
await retryService.start({ owner: retryOwner, operationId: 'retry-op', adapter: 'sync', command: { name: 'sync', args: {} }, sourceInputId: 'retry-input' })
await new Promise(resolve => setImmediate(resolve))
assert.equal(retryTimers[0].delay, 1000, 'outbox retry starts with bounded backoff')
allowAck = true
retryTimers[0].callback()
for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve))
assert.ok(retryAttempts.some(event => event.eventId === retryAttempts[0].eventId && retryAttempts.filter(item => item.eventId === event.eventId).length > 1), 'retry preserves the same event id')
assert.equal(retryRepo.getPendingEvents().length, 0, 'acknowledged retry clears the outbox')
await retryService.close()

const pageRepo = repository()
const pageService = createTaskService({ repository: pageRepo, adapters: { page: { deriveResources: () => [], async execute() { return {} } } } })
const pagedTask = await pageService.start({ owner, operationId: 'op-paged-events', adapter: 'page', command: { name: 'sync', args: {} }, sourceInputId: 'input-paged-events' })
for (let attempt = 0; attempt < 10 && pageService.inspect({ owner, taskId: pagedTask.taskId }).status !== 'completed'; attempt++) await new Promise(resolve => setImmediate(resolve))
let pageVersion = pageService.inspect({ owner, taskId: pagedTask.taskId }).version
for (let index = 0; index < 130; index++) pageVersion = pageRepo.updateTask(pagedTask.taskId, pageVersion, { summary: `event ${index}` }, 'task.progress').version
const firstPage = pageService.observe({ owner, taskId: pagedTask.taskId })
assert.equal(firstPage.length, 50, 'task event reads default to a finite 50 event page')
const cappedPage = pageService.observe({ owner, taskId: pagedTask.taskId, limit: 1000 })
assert.equal(cappedPage.length, 100, 'task event reads cap caller supplied page sizes at 100')
const nextPage = pageService.observe({ owner, taskId: pagedTask.taskId, afterVersion: firstPage.at(-1).version })
assert.equal(nextPage[0].version, firstPage.at(-1).version + 1, 'the last returned version is a compatible continuation cursor')
assert.equal(nextPage.length, 50, 'continuation pages remain bounded')
assert.deepEqual(pageService.observe({ owner: { ...owner, conversationId: 'not-owner' }, taskId: pagedTask.taskId }), [], 'event paging preserves owner isolation')
await pageService.close()

const rawJsonProgressRepo = repository()
const jsonProgressRepo = {
  ...rawJsonProgressRepo,
  getTask(id) { const task = rawJsonProgressRepo.getTask(id); return task && JSON.parse(JSON.stringify(task)) },
  updateTask(id, version, patch, type) { return rawJsonProgressRepo.updateTask(id, version, JSON.parse(JSON.stringify(patch)), type) },
}
let jsonProgressVersions
const jsonProgressService = createTaskService({ repository: jsonProgressRepo, adapters: { jsonProgress: {
  completionScope: 'external-task', deriveResources: () => [], async execute() { return { externalHandle: 'json-progress-handle' } },
  async watch({ onProgress }) {
    onProgress({ status: 'running', progress: undefined })
    const once = jsonProgressService.inspect({ owner, taskId: jsonProgressTask.taskId }).version
    onProgress({ status: 'running', progress: undefined })
    const twice = jsonProgressService.inspect({ owner, taskId: jsonProgressTask.taskId }).version
    jsonProgressVersions = { once, twice }
    return { status: 'completed' }
  },
} } })
const jsonProgressTask = await jsonProgressService.start({ owner, operationId: 'op-json-progress', adapter: 'jsonProgress', command: { name: 'start', args: {} }, sourceInputId: 'input-json-progress' })
for (let attempt = 0; attempt < 10 && !jsonProgressVersions; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(jsonProgressVersions.twice, jsonProgressVersions.once, 'progress with undefined fields compares equal after JSON persistence drops those fields')
await jsonProgressService.close()

const nonAtomicRepo = repository()
delete nonAtomicRepo.recordCancelIntent
let releaseNonAtomic
const nonAtomicService = createTaskService({ repository: nonAtomicRepo, adapters: { nonAtomic: {
  deriveResources: () => [], async execute() { return new Promise(resolve => { releaseNonAtomic = resolve }) },
} } })
const nonAtomicTask = await nonAtomicService.start({ owner, operationId: 'op-non-atomic', adapter: 'nonAtomic', command: { name: 'write', args: {} }, sourceInputId: 'input-non-atomic' })
for (let attempt = 0; attempt < 10 && !releaseNonAtomic; attempt++) await new Promise(resolve => setImmediate(resolve))
const nonAtomicSnapshot = nonAtomicService.inspect({ owner, taskId: nonAtomicTask.taskId })
await assert.rejects(nonAtomicService.cancel({ owner, taskId: nonAtomicTask.taskId, operationId: 'cancel-non-atomic', expectedVersion: nonAtomicSnapshot.version }), { code: 'ATOMIC_CANCEL_UNAVAILABLE' })
assert.equal(nonAtomicRepo.getOperation('cancel-non-atomic') ?? null, null, 'a repository without atomic cancel support does not persist a partial cancellation promise')
assert.equal(nonAtomicService.inspect({ owner, taskId: nonAtomicTask.taskId }).status, 'running')
releaseNonAtomic({ ok: true })
await nonAtomicService.close()

let spoofWatchCalled = false
const scopeAuthorityService = createTaskService({ repository: repository(), adapters: { declaredSync: {
  completionScope: 'tool-invocation', deriveResources: () => [], async execute() { return { completionScope: 'external-task', externalHandle: 'untrusted-handle' } },
  async watch() { spoofWatchCalled = true; return new Promise(() => {}) },
} } })
const declaredSyncTask = await scopeAuthorityService.start({ owner, operationId: 'op-declared-sync', adapter: 'declaredSync', command: { name: 'sync', args: {} }, sourceInputId: 'input-declared-sync' })
for (let attempt = 0; attempt < 10 && scopeAuthorityService.inspect({ owner, taskId: declaredSyncTask.taskId }).status !== 'completed'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(scopeAuthorityService.inspect({ owner, taskId: declaredSyncTask.taskId }).status, 'completed')
assert.equal(spoofWatchCalled, false, 'an adapter result cannot override the completion scope declared by Host')
await scopeAuthorityService.close()

let rejectDynamicStart, dynamicWatchResolve, dynamicCancelInput, dynamicStartCalls = 0
const dynamicScopeService = createTaskService({ repository: repository(), adapters: { dynamicExternal: {
  resolveCompletionScope: () => 'external-task', deriveResources: () => ['dynamic:external'],
  async execute() { dynamicStartCalls++; return new Promise((_, reject) => { rejectDynamicStart = reject }) },
  async recover({ operationId }) { assert.equal(operationId, 'op-dynamic-external'); return { status: 'running', externalHandle: 'dynamic-recovered-handle' } },
  async watch() { return new Promise(resolve => { dynamicWatchResolve = resolve }) },
  async cancel(input) { dynamicCancelInput = input; return { pending: true } },
} } })
const dynamicExternalTask = await dynamicScopeService.start({ owner, operationId: 'op-dynamic-external', adapter: 'dynamicExternal', command: { name: 'start', args: {} }, sourceInputId: 'input-dynamic-external' })
for (let attempt = 0; attempt < 10 && !rejectDynamicStart; attempt++) await new Promise(resolve => setImmediate(resolve))
const dynamicBeforeCancel = dynamicScopeService.inspect({ owner, taskId: dynamicExternalTask.taskId })
assert.equal(dynamicBeforeCancel.completionScope, 'external-task', 'dynamic Host scope is persisted before dispatch starts')
await dynamicScopeService.cancel({ owner, taskId: dynamicExternalTask.taskId, operationId: 'cancel-dynamic-external', expectedVersion: dynamicBeforeCancel.version })
rejectDynamicStart(new Error('external start receipt was lost'))
for (let attempt = 0; attempt < 10 && !dynamicCancelInput; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(dynamicCancelInput?.operationId, 'cancel-dynamic-external', 'uncertain dispatch recovery resumes the original cancellation identity')
assert.equal(dynamicCancelInput?.externalHandle, 'dynamic-recovered-handle', 'uncertain dispatch recovery resolves the external handle before cancel')
assert.equal(dynamicStartCalls, 1, 'recovery does not replay the external start operation')
assert.ok(dynamicWatchResolve, 'uncertain dispatch recovery reattaches an observer')
dynamicWatchResolve({ status: 'cancelled' })
for (let attempt = 0; attempt < 10 && dynamicScopeService.inspect({ owner, taskId: dynamicExternalTask.taskId }).status !== 'cancelled'; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(dynamicScopeService.inspect({ owner, taskId: dynamicExternalTask.taskId }).status, 'cancelled')
await dynamicScopeService.close()
console.log('task core ok')
