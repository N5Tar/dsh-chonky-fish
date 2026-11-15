import assert from 'node:assert/strict'
import { createTaskNoticeBridge } from '../task-notices.js'

const workspace = 'F:/fixture/fish'
const events = [], inbox = [], sent = []
let flushes = 0
const agent = { id: 'owner-session', session: { id: 'owner-session', header: { id: 'owner-session', cwd: workspace, agentPreset: 'chonkyfish' }, snapshotEvents: () => events }, inbox: { nextStep: [], nextTurn: inbox }, followup(message) { sent.push(message); inbox.push(message) } }
const ctx = { agents: { get: id => id === agent.id ? agent : undefined }, sessions: { async flush() { flushes++; return true } } }
const notify = createTaskNoticeBridge({ ctx, resources: { paths: { workspace } } })
const source = { kind: 'chonkyfish-task-notice', taskId: 'task-1', version: 2, ownerConversationId: agent.id, eventId: 'task-1:v2', sourceInputId: 'owner-input' }
const event = { source, owner: { namespaceId: 'profile-1', conversationId: agent.id }, status: 'completed', summary: '本机长任务已完成。' }
assert.deepEqual(await notify(event), { acknowledged: true })
assert.equal(sent.length, 1)
assert.equal(sent[0].id, 'chonkyfish-task-notice:task-1:v2')
assert.equal(sent[0].source.kind, 'chonkyfish-task-notice')
assert.equal(flushes, 1)
assert.deepEqual(await notify(event), { acknowledged: true })
assert.equal(sent.length, 1, 'a repeated outbox event already in the inbox is not inserted again')
events.push({ type: 'user/message', data: inbox.pop() })
assert.deepEqual(await notify(event), { acknowledged: true })
assert.equal(sent.length, 1, 'a consumed durable notice is not reinserted')
assert.equal((await notify({ ...event, owner: { ...event.owner, conversationId: 'other-session' } })).acknowledged, false)
assert.equal((await notify({ ...event, source: { ...source, ownerConversationId: 'other-session' } })).acknowledged, false)
assert.equal(sent.length, 1)
assert.deepEqual(await notify({ ...event, status: 'running' }), { acknowledged: true })
assert.equal(sent.length, 1, 'normal progress cannot flood the conversation')
ctx.sessions.flush = async () => false
const second = { ...event, source: { ...source, taskId: 'task-2', eventId: 'task-2:v2' } }
assert.equal((await notify(second)).acknowledged, false, 'uncertain persistence keeps the task outbox pending')
assert.equal(sent.length, 2)
ctx.sessions.flush = async () => true
assert.deepEqual(await notify(second), { acknowledged: true })
assert.equal(sent.length, 2, 'retrying a failed flush only flushes the existing inbox entry')
console.log('task notice bridge: owner isolation, stable message dedup and durable acknowledgement passed')
