import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createAbsHost } from '../../../../app/dsh/adapters/abs/host.js'
import { renderSelfReview } from '../review.js'
import { createState } from '../core.js'

const now = 1804471200000
const REVIEW = renderSelfReview({ state: createState(now) })

function fixture({ flush = true, idle = true, activeSessionId = 'fish' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'chonkyfish-abs-host-'))
  const proactive = join(directory, 'proactive.json')
  if (activeSessionId !== null) writeFileSync(proactive, JSON.stringify({ version: 2, activeSessionId }))
  const callbacks = new Map(), messages = [], observations = []
  const session = { id: 'fish', header: { cwd: '/fish', agentPreset: 'chonkyfish' } }
  const agent = { session, status: idle ? 'idle' : 'working', followup: (message) => messages.push(message) }
  const services = {
    agents: { list: () => [agent] },
    tools: { get: (name, scope) => name === 'web_search' && scope === agent ? {} : undefined },
    web: { searchProviders: new Map([['test', { available: () => true }]]) },
    sessionController: { resolveAgent: async () => ({ agent }) },
    sessions: { flush: async () => flush },
  }
  const host = createAbsHost({
    ctx: { get: (key) => services[key], on: (name, callback) => { callbacks.set(name, callback); return () => callbacks.delete(name) } },
    resources: { paths: { workspace: '/fish', proactive } },
  })
  host.subscribeObservation((observation) => observations.push(observation))
  let seq = 0
  const emit = (type, data, extra = {}) => {
    const event = { type, data, seq: ++seq, time: now, ...extra }
    callbacks.get('session/event')?.(session, event)
    return event
  }
  return { host, messages, observations, services, emit, directory, cleanup() { host.close(); rmSync(directory, { recursive: true, force: true }) }, writeBinding(id) { writeFileSync(proactive, JSON.stringify({ version: 2, activeSessionId: id })) } }
}

let checks = 0
async function test(name, run) { await run(); checks++; console.log(`ok ${checks} - ${name}`) }

await test('environment reports the bound session and search without resuming it', async () => {
  const f = fixture()
  const environment = await f.host.environment()
  assert.equal(environment.ownerSession.available, true)
  assert.equal(environment.ownerSession.sessionId, 'fish')
  assert.equal(environment.search.available, true)
  f.cleanup()

  const unbound = fixture({ activeSessionId: null })
  assert.equal((await unbound.host.environment()).ownerSession.reason, 'no-panel-session')
  unbound.cleanup()

  const busy = fixture({ idle: false })
  assert.equal((await busy.host.environment()).ownerSession.reason, 'agent-busy')
  busy.cleanup()
})

await test('surfaceReview delivers only the state text with self-review provenance', async () => {
  const f = fixture()
  const acceptance = await f.host.surfaceReview({ text: REVIEW, reviewId: 'review-1' })
  assert.equal(acceptance.accepted, true)
  assert.equal(acceptance.status, 'accepted')
  assert.equal(acceptance.sessionId, 'fish')
  assert.equal(f.messages.length, 1)
  assert.equal(f.messages[0].role, 'user')
  assert.equal(f.messages[0].content[0].text, REVIEW)
  assert.equal(f.messages[0].source.kind, 'chonkyfish-self-review')
  assert.equal(f.messages[0].source.reviewId, 'review-1')
  for (const word of ['web_search', '目标', '请', '任务']) assert.ok(!f.messages[0].content[0].text.includes(word))
  f.cleanup()
})

await test('acceptance is not completion; persistence and identity failures fail closed', async () => {
  const f = fixture()
  f.services.sessions.flush = async () => false
  const reconciled = await f.host.surfaceReview({ text: REVIEW, reviewId: 'r' })
  assert.equal(reconciled.accepted, true)
  assert.equal(reconciled.status, 'reconcile')
  assert.equal(reconciled.reason, 'persistence-unacknowledged')
  f.cleanup()

  const busy = fixture({ idle: false })
  assert.equal((await busy.host.surfaceReview({ text: REVIEW, reviewId: 'r' })).reason, 'agent-busy')
  busy.cleanup()

  const unbound = fixture({ activeSessionId: null })
  assert.equal((await unbound.host.surfaceReview({ text: REVIEW, reviewId: 'r' })).reason, 'no-panel-session')
  unbound.cleanup()

  const empty = fixture()
  assert.equal((await empty.host.surfaceReview({ text: '   ', reviewId: 'r' })).reason, 'empty-review')
  empty.services.sessions.flush = undefined
  assert.equal((await empty.host.surfaceReview({ text: REVIEW, reviewId: 'r' })).reason, 'session-support-unavailable')
  empty.cleanup()
})

await test('owner messages are observed, injections are not', async () => {
  const f = fixture()
  f.emit('user/message', { source: { kind: 'user' }, message: {} })
  assert.equal(f.observations.length, 1)
  assert.equal(f.observations[0].kind, 'owner_message')
  assert.equal(f.observations[0].sessionId, 'fish')
  assert.equal(f.observations[0].at, new Date(now).toISOString())
  f.emit('user/message', { id: 'social-' + 'a'.repeat(64), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '喂' }] })
  assert.equal(f.observations.length, 1, 'plain channel message is not local owner activity')
  for (const kind of ['chonkyfish-self-review', 'chonkyfish-nudge', 'schedule', 'agent-instructions']) {
    f.emit('user/message', { source: { kind }, message: {} })
  }
  assert.equal(f.observations.length, 1)
  f.emit('assistant/message', { message: { content: [{ type: 'text', text: '我说完了' }] } })
  assert.equal(f.observations.length, 1)
  f.cleanup()
})

await test('verified web_search results become exploration observations', async () => {
  const f = fixture()
  f.emit('turn/start', { turn: 7 })
  const call = f.emit('tool/call', { turn: 7, step: 1, callId: 'call-1', name: 'web_search' })
  f.emit('tool/result', {
    turn: 7, step: 1,
    message: { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, isError: false },
    meta: { sources: [{ url: 'https://example.org', title: 'source' }], truncated: false },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  assert.equal(f.observations.length, 1)
  assert.equal(f.observations[0].kind, 'exploration')
  assert.equal(f.observations[0].result, 'explore_content_found')
  assert.equal(f.observations[0].sources, 1)
  f.cleanup()
})

await test('empty, failed and unverifiable results are classified honestly', async () => {
  async function run(result, extra = {}) {
    const f = fixture()
    f.emit('turn/start', { turn: 7 })
    const call = f.emit('tool/call', { turn: 7, step: 1, callId: 'call-1', name: 'web_search' })
    f.emit('tool/result', result(call), { surfaceOp: 'append', sourceEventSeqs: [call.seq], ...extra })
    const observations = f.observations.slice()
    f.cleanup()
    return observations
  }
  const base = (call, message, meta) => ({ turn: 7, step: 1, message, meta })
  const empty = await run((call) => base(call, { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, isError: false }, { sources: [], truncated: false }))
  assert.equal(empty[0].result, 'explore_no_usable_content')
  assert.equal(empty[0].sources, 0)
  const failed = await run((call) => base(call, { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, isError: true }, undefined))
  assert.equal(failed[0].result, 'failed')
  const unknown = await run((call) => ({ ...base(call, { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, isError: false }, { sources: [{ url: 'https://example.org' }], truncated: false }), error: { name: 'ToolOutcomeUnknownError' } }))
  assert.equal(unknown.length, 0)
  const wrongTurn = await run((call) => ({ ...base(call, { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, isError: false }, { sources: [{ url: 'https://example.org' }], truncated: false }), turn: 8 }))
  assert.equal(wrongTurn.length, 0)
  const badMeta = await run((call) => base(call, { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, isError: false }, { sources: [{ url: 'javascript:bad' }], truncated: false }))
  assert.equal(badMeta.length, 0)
  const missingLink = await run((call) => base(call, { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, isError: false }, { sources: [{ url: 'https://example.org' }], truncated: false }), { sourceEventSeqs: [] })
  assert.equal(missingLink.length, 0)
})

await test('close stops delivery and observation', async () => {
  const f = fixture()
  f.host.close()
  assert.equal((await f.host.surfaceReview({ text: REVIEW, reviewId: 'r' })).reason, 'host-closed')
  f.emit('user/message', { source: { kind: 'user' } })
  assert.equal(f.observations.length, 0)
  assert.equal(f.messages.length, 0)
  rmSync(f.directory, { recursive: true, force: true })
})

await test('local evidence requires correlated content, image or changed workspace artifact', async () => {
  const f = fixture()
  f.emit('turn/start', { turn: 9 })
  function result(name, args, meta, content = [], isError = false, extra = {}) {
    const callId = 'local-' + f.observations.length + '-' + name
    const call = f.emit('tool/call', { turn: 9, step: 1, callId, name, arguments: JSON.stringify(args) })
    f.emit('tool/result', { turn: 9, step: 1, meta, message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError, content } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq], ...extra })
  }
  result('read', {}, { path: '/fish/note.md', lines: [{ number: 1, text: 'new information' }] })
  assert.equal(f.observations.at(-1).result, 'local_content_found')
  assert.match(f.observations.at(-1).evidenceKey, /^[a-f0-9]{64}$/)
  result('read_image', {}, { path: '/tmp/image.png' }, [{ type: 'image', attachment: { attachmentId: 'sha256:image', bytes: 20 } }])
  assert.equal(f.observations.at(-1).result, 'local_content_found')
  result('edit', {}, { path: '/fish/a.js', diffs: [{ oldText: 'old', newText: 'new' }] })
  assert.equal(f.observations.at(-1).result, 'local_content_found')
  result('write', { content: 'created artifact' }, { path: '/fish/new.md', operation: 'create' })
  assert.equal(f.observations.at(-1).result, 'local_content_found')
  for (const [name, args, meta] of [
    ['bash', {}, { cwd: '/fish' }], ['read', {}, { path: '/fish/empty', lines: [] }],
    ['edit', {}, { path: '/fish/a', diffs: [{ oldText: 'same', newText: 'same' }] }],
    ['write', { content: 'outside' }, { path: '/outside/a', operation: 'create' }],
  ]) {
    result(name, args, meta)
    assert.equal(f.observations.at(-1).result, 'unverified_activity')
  }
  result('read', {}, { path: '/fish/note', lines: [{ text: 'not a success' }] }, [], true)
  assert.equal(f.observations.at(-1).result, 'failed')
  const count = f.observations.length
  result('read', {}, { path: '/fish/note', lines: [{ text: 'unlinked' }] }, [], false, { sourceEventSeqs: [] })
  assert.equal(f.observations.length, count)
  result('read', {}, { path: join(f.directory, 'abs/state.json'), lines: [{ text: 'own state' }] })
  assert.equal(f.observations.length, count)
  f.cleanup()
})

await test('delivery gate is checked after async resolution before followup', async () => {
  const f = fixture()
  const resolve = f.services.sessionController.resolveAgent
  let resting = false
  f.services.sessionController.resolveAgent = async (...args) => { const result = await resolve(...args); resting = true; return result }
  const result = await f.host.surfaceReview({ text: REVIEW, reviewId: 'boundary', canDeliver: () => resting ? 'REST_HOURS' : null })
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'REST_HOURS')
  assert.equal(f.messages.length, 0)
  f.cleanup()
})
console.log(`ABS host: ${checks} groups passed (offline; no model/network).`)
