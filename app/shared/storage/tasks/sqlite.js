import { randomUUID } from 'node:crypto'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const json = value => JSON.stringify(value ?? null)

/** Durable task ledger and namespace scoped resource mutexes. */
export function createTaskRepository({ dbPath, DatabaseSync, now = Date.now }) {
  if (typeof DatabaseSync !== 'function') throw new TypeError('SQLite DatabaseSync adapter required')
  const db = new DatabaseSync(dbPath)
  let closed = false
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version > 1) throw new Error('Unsupported tasks database schema')
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS task_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner_namespace TEXT NOT NULL, owner_conversation TEXT NOT NULL, operation_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_namespace, owner_conversation, created_at DESC);
      CREATE TABLE IF NOT EXISTS task_operations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, owner_namespace TEXT NOT NULL, owner_conversation TEXT NOT NULL, command_digest TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_resources (resource_key TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id));
      CREATE INDEX IF NOT EXISTS task_resources_task ON task_resources(task_id);
      CREATE TABLE IF NOT EXISTS task_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, UNIQUE(task_id, version));
      PRAGMA user_version=1;`)
    if (!db.prepare("SELECT value FROM task_meta WHERE key='namespace_id'").get()) db.prepare("INSERT INTO task_meta(key,value) VALUES('namespace_id',?)").run(randomUUID())
  } catch (error) { db.close(); throw error }
  const assertOpen = () => { if (closed) throw new Error('Task repository is closed') }
  const decode = row => row ? JSON.parse(row.payload_json) : null
  function insertEvent(task, type) {
    db.prepare('INSERT INTO task_events(task_id,version,type,payload_json) VALUES(?,?,?,?)').run(task.id, task.version, type, json({ eventId: `${task.id}:v${task.version}`, taskId: task.id, version: task.version, type, status: task.status, owner: task.owner, sourceInputId: task.sourceInputId, summary: task.summary ?? '', createdAt: now() }))
  }
  function namespaceId() { assertOpen(); return db.prepare("SELECT value FROM task_meta WHERE key='namespace_id'").get().value }
  function getTask(id) { assertOpen(); return decode(db.prepare('SELECT payload_json FROM tasks WHERE id=?').get(id)) }
  return {
    namespaceId,
    createTask(task, operation) {
      assertOpen(); db.exec('BEGIN IMMEDIATE')
      try {
        const previous = db.prepare('SELECT * FROM task_operations WHERE id=?').get(operation.id)
        if (previous) { db.exec('COMMIT'); return { duplicate: true, operation: { ...previous, task: getTask(previous.task_id) }, task: getTask(previous.task_id) } }
        const busy = task.resources.find(key => db.prepare('SELECT 1 AS locked FROM task_resources WHERE resource_key=?').get(key))
        if (busy) { db.exec('ROLLBACK'); return { busy: true, resource: busy } }
        db.prepare('INSERT INTO tasks(id,owner_namespace,owner_conversation,operation_id,status,version,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?)').run(task.id, task.owner.namespaceId, task.owner.conversationId, task.operationId, task.status, task.version, task.createdAt, task.updatedAt, json(task))
        db.prepare('INSERT INTO task_operations(id,task_id,kind,owner_namespace,owner_conversation,command_digest,created_at) VALUES(?,?,?,?,?,?,?)').run(operation.id, task.id, operation.kind ?? 'start', operation.owner.namespaceId, operation.owner.conversationId, operation.commandDigest, operation.createdAt ?? now())
        for (const key of task.resources) db.prepare('INSERT INTO task_resources(resource_key,task_id) VALUES(?,?)').run(key, task.id)
        insertEvent(task, 'task.accepted'); db.exec('COMMIT')
        return { duplicate: false, operation, task }
      } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
    },
    getTask,
    getOperation(id) {
      assertOpen()
      const row = db.prepare('SELECT id,task_id,kind,owner_namespace,owner_conversation,command_digest,created_at FROM task_operations WHERE id=?').get(id)
      return row ? { id: row.id, taskId: row.task_id, kind: row.kind, owner: { namespaceId: row.owner_namespace, conversationId: row.owner_conversation }, commandDigest: row.command_digest, createdAt: row.created_at, task: getTask(row.task_id) } : null
    },
    recordOperation(operation) {
      assertOpen(); db.exec('BEGIN IMMEDIATE')
      try {
        const prior = db.prepare('SELECT id FROM task_operations WHERE id=?').get(operation.id)
        if (prior) { db.exec('ROLLBACK'); return false }
        db.prepare('INSERT INTO task_operations(id,task_id,kind,owner_namespace,owner_conversation,command_digest,created_at) VALUES(?,?,?,?,?,?,?)').run(operation.id, operation.taskId, operation.kind, operation.owner.namespaceId, operation.owner.conversationId, operation.commandDigest, operation.createdAt ?? now())
        db.exec('COMMIT'); return true
      } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
    },
    updateTask(id, version, patch, type) {
      assertOpen(); db.exec('BEGIN IMMEDIATE')
      try {
        const old = getTask(id)
        if (!old || old.version !== version) { db.exec('ROLLBACK'); return null }
        const next = { ...old, ...patch, version: old.version + 1, updatedAt: now() }
        db.prepare('UPDATE tasks SET status=?,version=?,updated_at=?,payload_json=? WHERE id=? AND version=?').run(next.status, next.version, next.updatedAt, json(next), id, version)
        if (TERMINAL.has(next.status)) db.prepare('DELETE FROM task_resources WHERE task_id=?').run(id)
        insertEvent(next, type); db.exec('COMMIT'); return next
      } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
    },
    listTasks(owner) {
      assertOpen()
      return db.prepare('SELECT payload_json FROM tasks WHERE owner_namespace=? AND owner_conversation=? ORDER BY created_at DESC LIMIT 100').all(owner.namespaceId, owner.conversationId).map(decode)
    },
    listAllTasks() { assertOpen(); return db.prepare('SELECT payload_json FROM tasks ORDER BY created_at').all().map(decode) },
    readEvents(taskId, afterVersion = 0) {
      assertOpen()
      return db.prepare('SELECT payload_json FROM task_events WHERE task_id=? AND version>? ORDER BY version').all(taskId, afterVersion).map(row => JSON.parse(row.payload_json))
    },
    getPendingEvents() { assertOpen(); return db.prepare('SELECT payload_json FROM task_events WHERE delivered=0 ORDER BY seq').all().map(row => JSON.parse(row.payload_json)) },
    markEventDelivered(eventId) { assertOpen(); return Number(db.prepare("UPDATE task_events SET delivered=1 WHERE task_id || ':v' || version=? AND delivered=0").run(eventId).changes) > 0 },
    close() { if (closed) return; try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { closed = true; db.close() } },
  }
}
