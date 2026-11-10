import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { digest } from '../core.js'
import { createReplyOutbox, replyEvidence } from '../reply-outbox.js'

const incoming = { id: 'social-' + 'a'.repeat(64), role: 'user', content: [{ type: 'text', text: '喂' }], source: { kind: 'user' } }
const route = { sessionId: 'main-a', inboundMessageId: incoming.id, connectionId: 'ding', conversation: { type: 'direct', id: 'original-chat' }, identityRevision: 'identity-1', sessionKey: 'original-key', eventOffset: 0, contentHash: digest(JSON.stringify(incoming.content)) }
const start = { type: 'turn/start', data: { turn: 7 } }
const user = { type: 'user/message', data: incoming }
const assistant = (content = [{ type: 'text', text: '在呢。' }], extra = {}) => ({ type: 'assistant/message', data: { turn: 7, step: 1, message: { id: 'assistant-final', role: 'assistant', content, source: { kind: 'model' } }, ...extra } })
const end = reason => ({ type: 'turn/end', data: { turn: 7, reason: { kind: reason ?? 'completed' } } })
const complete = () => [start, user, assistant(), end()]
async function fixture(events = complete()) {
  const file = join(await mkdtemp(join(tmpdir(), 'social-reply-')), 'replies.json')
  const sent = [], activeScopes = new Set(), flags = { connected: true, identityRevision: 'identity-1', result: { status: 'accepted' }, events }
  const service = {
    issueScope(input) { if (!flags.connected) throw Object.assign(new Error('offline'), { code: 'SOCIAL_NOT_CONNECTED' }); const scope = { ...input, sessionKey: route.sessionKey, identityRevision: flags.identityRevision }; activeScopes.add(scope); return scope },
    scopedIdentity(scope) { assert.ok(activeScopes.has(scope)); return { protocolUserId: 'robot' } },
    revokeScope(scope) { activeScopes.delete(scope) },
    async send(scope, input) { assert.ok(activeScopes.has(scope)); if (flags.admissionError) throw Object.assign(new Error('admission rejected'), { code: flags.admissionError }); sent.push(structuredClone(input)); return flags.result },
  }
  const options = { file, service, readEvidence: async () => flags.events }
  const box = await createReplyOutbox(options)
  await box.register(route)
  return { file, box, flags, sent, options, activeScopes }
}
let count = 0
async function test(name, fn) { await fn(); count++; console.log(`ok ${count} - ${name}`) }
await test('plain incoming to completed final sends once and summaries contain no text/target', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(await f.box.process(), { pending: false })
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, '在呢。'); assert.deepEqual(f.sent[0].conversation, route.conversation)
    assert.equal(f.box.inspect()[0].status, 'sent')
    assert.deepEqual(Object.keys(f.box.inspect()[0]).sort(), ['assistantMessageId', 'inboundMessageId', 'sessionId', 'status'])
    assert.equal(JSON.stringify(f.box.inspect()).includes('original-chat'), false)
    assert.equal(JSON.stringify(f.box.inspect()).includes('在呢'), false)
    await f.box.process(); assert.equal(f.sent.length, 1)
    assert.equal(f.activeScopes.size, 0)
  } finally { await f.box.close() }
})
await test('framework runtime context injections do not cancel the automatic reply', async () => {
  const context = kind => ({ type: 'user/message', data: { id: 'ctx-' + kind, role: 'user', content: [{ type: 'text', text: kind }], source: { kind } } })
  const f = await fixture([start, user, context('runtime-context'), context('time-context'), assistant(), end()])
  try {
    assert.deepEqual(await f.box.process(), { pending: false })
    assert.equal(f.sent.length, 1, 'runtime context is not a second request')
    assert.equal(f.sent[0].text, '在呢。')
    assert.equal(f.box.inspect()[0].status, 'sent')
  } finally { await f.box.close() }
})
await test('await completed turn, lock turn number, then deliver; scoped session filtering', async () => {
  const f = await fixture([start, user, assistant()])
  try {
    assert.deepEqual(await f.box.process('main-b'), { pending: true }); assert.equal(f.sent.length, 0)
    assert.deepEqual(await f.box.process('main-a'), { pending: true })
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).routes[0].turn, 7)
    f.flags.events = complete(); assert.deepEqual(await f.box.process(), { pending: false }); assert.equal(f.sent.length, 1)
  } finally { await f.box.close() }
})
await test('restart and duplicate completion never repeat an accepted send', async () => {
  const f = await fixture(); let second
  try {
    await f.box.process(); await f.box.close()
    second = await createReplyOutbox(f.options); await second.process()
    assert.equal(f.sent.length, 1); assert.equal(second.inspect()[0].status, 'sent')
  } finally { await second?.close(); await f.box.close() }
})
await test('unknown result and crash pre-send marker never retry', async () => {
  const f = await fixture(); let second
  try {
    f.flags.result = { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' }
    await f.box.process(); await f.box.process(); assert.equal(f.sent.length, 1)
    await f.box.close()
    const state = JSON.parse(await readFile(f.file, 'utf8')); state.routes[0].status = 'sending'
    await writeFile(f.file, JSON.stringify(state))
    second = await createReplyOutbox(f.options); await second.process()
    assert.equal(f.sent.length, 1); assert.equal(second.inspect()[0].status, 'unknown')
  } finally { await second?.close(); await f.box.close() }
})
await test('offline can wait, but identity changes cannot use the previous route', async () => {
  const f = await fixture()
  try {
    f.flags.connected = false; assert.deepEqual(await f.box.process(), { pending: true }); assert.equal(f.sent.length, 0)
    f.flags.connected = true; f.flags.identityRevision = 'other'
    assert.deepEqual(await f.box.process(), { pending: false }); assert.equal(f.sent.length, 0)
    assert.equal(f.box.inspect()[0].status, 'failed'); assert.equal(f.box.inspect()[0].errorCode, 'SOCIAL_SCOPE_STALE')
  } finally { await f.box.close() }
})
for (const [name, events, expected] of [
  ['owner mixed', [start, user, { type: 'user/message', data: { id: 'owner', role: 'user', source: { kind: 'user' } } }, assistant(), end()], 'canceled'],
  ['another source mixed', [start, user, { type: 'user/message', data: { ...incoming, id: 'social-' + 'b'.repeat(64) } }, assistant(), end()], 'canceled'],
  ['interrupted', [start, user, assistant(), end('interrupted')], 'canceled'],
  ['error', [start, user, assistant(), end('error')], 'canceled'],
  ['reasoning-only final never falls back', [start, user, assistant([{ type: 'text', text: 'intermediate' }]), assistant([{ type: 'reasoning', text: 'PRIVATE' }]), end()], 'canceled'],
  ['tool-call final never falls back', [start, user, assistant(), assistant([{ type: 'text', text: 'tool commentary' }, { type: 'tool-call', id: 'call', name: 'x' }]), end()], 'canceled'],
  ['interrupted assistant', [start, user, assistant(undefined, { interrupted: true }), end()], 'canceled'],
  ['duplicate inbound', [start, user, user, assistant(), end()], 'failed'],
  ['changed body', [start, { ...user, data: { ...incoming, content: [{ type: 'text', text: 'different' }] } }, assistant(), end()], 'failed'],
  ['empty final', [start, user, assistant([{ type: 'text', text: ' ' }]), end()], 'canceled'],
  ['compaction final replace', [start, user, { ...assistant(), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 3 } }, end()], 'canceled'],
  ['compaction user replace', [start, { ...user, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 3 } }, assistant(), end()], 'failed'],
]) await test(name + ' does not send', async () => {
  const f = await fixture(events)
  try { await f.box.process(); assert.equal(f.sent.length, 0); assert.equal(f.box.inspect()[0].status, expected) } finally { await f.box.close() }
})
await test('only final text blocks leave process, never reasoning/tool results or earlier text', async () => {
  const f = await fixture([start, user, assistant([{ type: 'text', text: 'intermediate' }, { type: 'tool-call', name: 'x' }]), { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'PRIVATE TOOL' }] } } }, assistant([{ type: 'reasoning', text: 'PRIVATE REASONING' }, { type: 'text', text: '最终' }, { type: 'text', text: '答复' }]), end()])
  try { await f.box.process(); assert.equal(f.sent[0].text, '最终答复') } finally { await f.box.close() }
})
await test('missing evidence and an unregistered ordinary user never authorize output', async () => {
  const f = await fixture([start, { ...user, data: { ...incoming, id: 'owner' } }, assistant(), end()])
  try { assert.deepEqual(await f.box.process(), { pending: true }); assert.equal(f.sent.length, 0) } finally { await f.box.close() }
})
await test('failed transport is explicit and not retried', async () => {
  const f = await fixture()
  try {
    f.flags.result = { status: 'failed', errorCode: 'SOCIAL_WEBHOOK_EXPIRED' }
    await f.box.process(); await f.box.process()
    assert.equal(f.sent.length, 1); assert.equal(f.box.inspect()[0].status, 'failed'); assert.equal(f.box.inspect()[0].errorCode, 'SOCIAL_WEBHOOK_EXPIRED')
  } finally { await f.box.close() }
})
await test('close while evidence is pending prevents any new send', async () => {
  const f = await fixture(); let box, release, entered
  const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve })
  try {
    await f.box.close()
    box = await createReplyOutbox({ ...f.options, readEvidence: async () => { entered(); await gate; return complete() } })
    const processing = box.process(); await ready
    const closing = box.close(); release(); await processing; await closing
    assert.equal(f.sent.length, 0)
  } finally { release(); await box?.close(); await f.box.close() }
})
assert.equal(replyEvidence([start, user, assistant(), end()], { ...route, turn: 99 }).errorCode, 'SOCIAL_REPLY_TURN_MISMATCH')
for (const code of ['SOCIAL_RATE_LIMITED', 'SOCIAL_NOT_CONNECTED']) await test(`service admission ${code} waits and retries the same operation only`, async () => {
  const f = await fixture(); let second
  try {
    const operationId = JSON.parse(await readFile(f.file, 'utf8')).routes[0].operationId
    f.flags.admissionError = code
    assert.deepEqual(await f.box.process(), { pending: true }); assert.equal(f.sent.length, 0)
    assert.equal(f.box.inspect()[0].status, 'waiting'); assert.equal(f.box.inspect()[0].errorCode, code)
    assert.equal(f.activeScopes.size, 0)
    await f.box.close(); second = await createReplyOutbox(f.options)
    delete f.flags.admissionError
    assert.deepEqual(await second.process(), { pending: false }); assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0].operationId, operationId)
    await second.process(); assert.equal(f.sent.length, 1)
  } finally { await second?.close(); await f.box.close() }
})
await test('driver returned failed rate-limit remains terminal, unlike service admission', async () => {
  const f = await fixture()
  try {
    f.flags.result = { status: 'failed', errorCode: 'SOCIAL_RATE_LIMITED' }
    assert.deepEqual(await f.box.process(), { pending: false }); assert.equal(f.box.inspect()[0].status, 'failed')
    await f.box.process(); assert.equal(f.sent.length, 1)
  } finally { await f.box.close() }
})
console.log(`reply-outbox: ${count}/${count} passed (no real platform/model sends)`)
