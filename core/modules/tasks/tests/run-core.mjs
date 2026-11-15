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
console.log('task core ok')
