import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTaskRepository } from '../sqlite.js'

const directory = mkdtempSync(join(tmpdir(), 'chonkyfish-tasks-'))
const path = join(directory, 'tasks.db')
let repo
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
  const pending = repo.getPendingEvents()
  assert.ok(pending.some(event => event.eventId === 'one:v2' && event.sourceInputId === 'in-one'))
  assert.equal(repo.markEventDelivered('one:v2'), true)
  assert.equal(repo.getPendingEvents().some(event => event.eventId === 'one:v2'), false)
  repo.close()
} finally { repo?.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
console.log('task sqlite ok')
