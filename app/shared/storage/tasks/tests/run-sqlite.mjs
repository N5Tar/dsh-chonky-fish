import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTaskRepository } from '../sqlite.js'

const directory = mkdtempSync(join(tmpdir(), 'chonkyfish-tasks-'))
const path = join(directory, 'tasks.db')
let repo, triggerDb
const owner = { namespaceId: 'host-uuid', conversationId: 'conversation-a' }
const makeTask = (id, conversationId = owner.conversationId) => ({ id, operationId: `op-${id}`, owner: { namespaceId: owner.namespaceId, conversationId }, sourceInputId: `in-${id}`, adapter: 'fixture', command: { name: 'write', args: {} }, commandDigest: `digest-${id}`, resources: ['file:shared'], status: 'accepted', version: 1, createdAt: 1, updatedAt: 1 })
try {
  repo = createTaskRepository({ dbPath: path, DatabaseSync })
  const namespaceId = repo.namespaceId()
  assert.match(namespaceId, /^[0-9a-f-]{36}$/i, 'stable host namespace is a UUID')
  const first = makeTask('one')
  assert.equal(repo.createTask(first, { id: first.operationId, taskId: first.id, commandDigest: first.commandDigest, owner: first.owner }).duplicate, false)
  assert.equal(repo.recordOperation({ id: 'cancel-one', taskId: first.id, kind: 'cancel', owner: first.owner, commandDigest: 'cancel-digest', createdAt: 2 }), true)
  assert.equal(repo.getOperation('cancel-one').task.id, first.id, 'cancel idempotency receipt persists independently from the process')
  const conflict = makeTask('two', 'conversation-b')
  assert.equal(repo.createTask(conflict, { id: conflict.operationId, taskId: conflict.id, commandDigest: conflict.commandDigest, owner: conflict.owner }).busy, true, 'resource ownership is global across conversations')
  assert.equal(repo.getTask('one').id, 'one')
  assert.equal(repo.updateTask('one', 1, { status: 'outcome-unknown' }, 'unknown').version, 2)
  repo.close()
  repo = createTaskRepository({ dbPath: path, DatabaseSync })
  assert.equal(repo.namespaceId(), namespaceId)
  assert.equal(repo.createTask(conflict, { id: conflict.operationId, taskId: conflict.id, commandDigest: conflict.commandDigest, owner: conflict.owner }).busy, true, 'unknown lock survives restart')
  assert.equal(repo.getOperation('op-one').task.status, 'outcome-unknown')
  assert.equal(repo.getOperation('cancel-one').commandDigest, 'cancel-digest')
  let eventVersion = repo.getTask('one').version
  for (let index = 0; index < 130; index++) eventVersion = repo.updateTask('one', eventVersion, { summary: `page event ${index}` }, 'progress').version
  assert.equal(repo.readEvents('one', 0, 50).length, 50, 'SQLite event queries enforce the requested page limit')
  assert.equal(repo.readEvents('one', 50, 200).length, 82, 'SQLite pages preserve the complete tail after the requested version')
  const cancelTask = { ...makeTask('atomic-cancel'), resources: [], status: 'running', version: 1 }
  repo.createTask(cancelTask, { id: cancelTask.operationId, taskId: cancelTask.id, commandDigest: cancelTask.commandDigest, owner: cancelTask.owner })
  const cancelIntent = { id: 'cancel-atomic', taskId: cancelTask.id, kind: 'cancel', owner: cancelTask.owner, commandDigest: 'atomic-cancel-digest', createdAt: 3 }
  triggerDb = new DatabaseSync(path)
  triggerDb.exec("CREATE TRIGGER reject_cancel_event BEFORE INSERT ON task_events WHEN NEW.task_id='atomic-cancel' AND NEW.type='task.stopping' BEGIN SELECT RAISE(ABORT, 'injected cancel commit failure'); END")
  assert.throws(() => repo.recordCancelIntent({ operation: cancelIntent, expectedVersion: cancelTask.version }), /injected cancel commit failure/)
  assert.equal(repo.getOperation(cancelIntent.id), null, 'a failed atomic cancellation writes no durable operation receipt')
  assert.equal(repo.getTask(cancelTask.id).status, 'running', 'a failed atomic cancellation leaves the task state untouched')
  triggerDb.exec('DROP TRIGGER reject_cancel_event')
  triggerDb.close(); triggerDb = null
  const committedCancel = repo.recordCancelIntent({ operation: cancelIntent, expectedVersion: cancelTask.version })
  assert.equal(committedCancel.task.status, 'stopping')
  assert.equal(committedCancel.task.cancelOperationId, cancelIntent.id)
  assert.equal(repo.getOperation(cancelIntent.id).task.cancelOperationId, cancelIntent.id, 'the operation receipt and stop intent commit together')
  const duplicateCancel = repo.recordCancelIntent({ operation: cancelIntent, expectedVersion: cancelTask.version })
  assert.equal(duplicateCancel.duplicate, true, 'a duplicate atomic cancel intent returns the original operation and current task')
  assert.equal(duplicateCancel.operation.id, cancelIntent.id)
  assert.equal(duplicateCancel.task.cancelOperationId, cancelIntent.id)
  const pending = repo.getPendingEvents()
  assert.ok(pending.some(event => event.eventId === 'one:v2' && event.sourceInputId === 'in-one'))
  assert.equal(repo.markEventDelivered('one:v2'), true)
  assert.equal(repo.getPendingEvents().some(event => event.eventId === 'one:v2'), false)
  repo.close()
} finally { triggerDb?.close(); repo?.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
console.log('task sqlite ok')
