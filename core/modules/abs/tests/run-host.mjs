import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createAbsHost } from '../../../../app/dsh/adapters/abs/host.js'

const now = 1804471200000
const REVIEW = '唔……我现在很想和主人说说话，这份念头很强。要不要找他说说话呢？'
const ACTION = {
  text: REVIEW,
  intent: 'chat_owner',
  selectionId: 'selection-1',
  reviewId: 'review-1',
  messageId: 'message-1',
  expectedSessionId: 'fish',
}
function surface(host, patch = {}) {
  return host.surfaceAction({ ...ACTION, ...patch })
}

function fixture({ flush = true, idle = true, activeSessionId = 'fish' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'chonkyfish-abs-host-'))
  const proactive = join(directory, 'proactive.json')
  if (activeSessionId !== null) writeFileSync(proactive, JSON.stringify({ version: 2, activeSessionId }))
  const callbacks = new Map(), messages = [], observations = [], activities = [], toolBindings = []
  const session = { id: 'fish', header: { cwd: '/fish', agentPreset: 'chonkyfish' } }
  const agent = { session, status: idle ? 'idle' : 'working', ctx: { tools: { register(tool) { toolBindings.push(tool); return () => toolBindings.splice(toolBindings.indexOf(tool), 1) } } }, followup: (message) => messages.push(message) }
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
  host.subscribeActivity((activity) => activities.push(activity))
  let seq = 0
  const emit = (type, data, extra = {}) => {
    const event = { type, data, seq: ++seq, time: now, ...extra }
    callbacks.get('session/event')?.(session, event)
    return event
  }
  host.setActionSelectionLookup({
    find({ selectionId, sessionId, messageId }) {
      const message = messages.find(item => item.id === messageId)
      if (!message || sessionId !== 'fish' || message.source?.selectionId !== selectionId) return null
      return {
        selectionId, sessionId, messageId,
        reviewId: message.source.reviewId, intent: message.source.intent, dispatchStatus: 'enqueued',
      }
    },
  })
  return { host, messages, observations, activities, services, agent, callbacks, toolBindings, emit, directory, cleanup() { host.close(); rmSync(directory, { recursive: true, force: true }) }, writeBinding(id) { writeFileSync(proactive, JSON.stringify({ version: 2, activeSessionId: id })) } }
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
  const busyEnv = await busy.host.environment()
  assert.equal(busyEnv.ownerSession.available, true)
  assert.equal(busyEnv.ownerSession.busy, true)
  busy.cleanup()
})

await test('surfaceAction delivers only the action text with abs-action provenance', async () => {
  const f = fixture()
  const acceptance = await surface(f.host)
  assert.equal(acceptance.accepted, true)
  assert.equal(acceptance.status, 'accepted')
  assert.equal(acceptance.sessionId, 'fish')
  assert.equal(f.messages.length, 1)
  assert.equal(f.messages[0].role, 'user')
  assert.equal(f.messages[0].content[0].text, REVIEW)
  assert.equal(f.messages[0].source.kind, 'chonkyfish-abs-action')
  assert.equal(f.messages[0].source.reviewId, 'review-1')
  assert.equal(f.messages[0].source.intent, 'chat_owner')
  for (const word of ['web_search', '目标', '请', '任务']) assert.ok(!f.messages[0].content[0].text.includes(word))
  f.cleanup()
})

await test('acceptance is not completion; persistence and identity failures fail closed', async () => {
  const f = fixture()
  f.services.sessions.flush = async () => false
  const reconciled = await surface(f.host, { reviewId: 'r', messageId: 'msg-r' })
  assert.equal(reconciled.accepted, false)
  assert.equal(reconciled.status, 'unknown')
  assert.equal(reconciled.reason, 'persistence-unacknowledged')
  f.cleanup()

  const busy = fixture({ idle: false })
  const busyResult = await surface(busy.host, { reviewId: 'r', messageId: 'msg-busy' })
  assert.equal(busyResult.accepted, true, 'action enqueue is not gated on agent idle')
  busy.cleanup()

  const unbound = fixture({ activeSessionId: null })
  assert.equal((await surface(unbound.host, { reviewId: 'r', messageId: 'msg-unbound' })).reason, 'no-panel-session')
  unbound.cleanup()

  const empty = fixture()
  assert.equal((await surface(empty.host, { text: '   ', reviewId: 'r', messageId: 'msg-empty' })).reason, 'invalid-action')
  empty.services.sessions.flush = undefined
  assert.equal((await surface(empty.host, { reviewId: 'r', messageId: 'msg-support' })).reason, 'session-support-unavailable')
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
  assert.equal(f.observations.length, 2, 'owner direct message delivered from a channel (e.g. DingTalk) counts as owner interaction')
  assert.equal(f.observations[1].kind, 'owner_message')
  assert.equal(f.observations[1].sessionId, 'fish')
  f.emit('user/message', { id: 'delivery-1', role: 'user', source: { kind: 'chonkyfish-social', version: 1 }, content: [{ type: 'text', text: '喂' }] })
  assert.equal(f.observations.length, 3, 'legacy channel-sourced delivery also counts')
  for (const kind of ['chonkyfish-abs-action', 'chonkyfish-nudge', 'schedule', 'agent-instructions']) {
    f.emit('user/message', { source: { kind }, message: {} })
  }
  assert.equal(f.observations.length, 3)
  f.emit('assistant/message', { message: { content: [{ type: 'text', text: '我说完了' }] } })
  assert.equal(f.observations.length, 3)
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
  const unknown = await run((call) => ({ ...base(call, { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, isError: true }, undefined), error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } }))
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
  assert.equal((await surface(f.host, { reviewId: 'r', messageId: 'msg-closed' })).reason, 'host-closed')
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
  const result = await surface(f.host, { reviewId: 'boundary', messageId: 'msg-boundary', canDeliver: () => resting ? 'REST_HOURS' : null })
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'REST_HOURS')
  assert.equal(f.messages.length, 0)
  f.cleanup()
})

await test('claimed action turns mark self_review attribution through completion', async () => {
  const f = fixture()
  await surface(f.host, { reviewId: 'scoped-review', messageId: 'msg-scoped-review' })
  f.emit('turn/start', { turn: 13 })
  f.callbacks.get('agent/inbox/claimed')?.({ agent: f.agent, message: f.messages[0], turn: 13 })
  f.callbacks.get('agent/inbox/claimed')?.({ agent: f.agent, message: f.messages[0], turn: 13 })
  f.emit('step/start', { turn: 13, step: 1 })
  f.emit('user/message', { turn: 13, id: f.messages[0].id, source: f.messages[0].source })
  assert.equal(f.activities.at(-1).attribution, 'self_review')
  assert.equal(f.activities.at(-1).reviewId, 'scoped-review')
  f.emit('turn/end', { turn: 13, reason: { kind: 'completed' } })
  assert.equal(f.activities.at(-1).turnStatus, 'completed')
  assert.equal(f.activities.at(-1).inputStatus, 'appended')
  assert.equal(f.activities.at(-1).attribution, 'self_review')
  f.cleanup()
})

await test('mixed inbox claims, missing user append, and aborted turns stay non-completed', async () => {
  const mixed = fixture()
  await surface(mixed.host, { reviewId: 'mixed-review', messageId: 'msg-mixed-review' })
  mixed.emit('turn/start', { turn: 21 })
  mixed.callbacks.get('agent/inbox/claimed')?.({ agent: mixed.agent, message: { id: 'injected', source: { kind: 'schedule' } }, turn: 21 })
  mixed.callbacks.get('agent/inbox/claimed')?.({ agent: mixed.agent, message: mixed.messages[0], turn: 21 })
  mixed.emit('step/start', { turn: 21, step: 1 })
  mixed.emit('user/message', { turn: 21, id: mixed.messages[0].id, source: mixed.messages[0].source })
  assert.equal(mixed.activities.at(-1).attribution, 'mixed')
  mixed.cleanup()

  const noAppend = fixture()
  await surface(noAppend.host, { reviewId: 'unappended-review', messageId: 'msg-unappended-review' })
  noAppend.emit('turn/start', { turn: 22 })
  noAppend.callbacks.get('agent/inbox/claimed')?.({ agent: noAppend.agent, message: noAppend.messages[0], turn: 22 })
  noAppend.emit('step/start', { turn: 22, step: 1 })
  noAppend.emit('turn/end', { turn: 22, reason: { kind: 'completed' } })
  assert.equal(noAppend.activities.at(-1).inputStatus, 'not_appended')
  assert.equal(noAppend.activities.at(-1).turnStatus, 'unknown')
  assert.deepEqual(noAppend.activities.at(-1).turnDiagnostic, { phase: 'not_executed', code: 'NOT_EXECUTED' })
  noAppend.cleanup()

  const aborted = fixture()
  await surface(aborted.host, { reviewId: 'aborted-review', messageId: 'msg-aborted-review' })
  aborted.emit('turn/start', { turn: 25 })
  aborted.callbacks.get('agent/inbox/claimed')?.({ agent: aborted.agent, message: aborted.messages[0], turn: 25 })
  aborted.emit('turn/end', { turn: 25, reason: { kind: 'aborted' } })
  assert.equal(aborted.activities.at(-1).turnStatus, 'unknown')
  assert.deepEqual(aborted.activities.at(-1).turnDiagnostic, { phase: 'not_executed', code: 'ABORTED' })
  aborted.cleanup()
})

await test('synthetic context is ignored and model failures expose sanitized stage diagnostics', async () => {
  const f = fixture()
  await surface(f.host, { reviewId: 'transport-review', messageId: 'msg-transport-review' })
  f.emit('turn/start', { turn: 23 })
  f.callbacks.get('agent/inbox/claimed')?.({ agent: f.agent, message: f.messages[0], turn: 23 })
  f.emit('step/start', { turn: 23, step: 1 })
  f.emit('user/message', { turn: 23, id: f.messages[0].id, source: f.messages[0].source })
  f.emit('user/message', { turn: 23, id: 'runtime-context-23', source: { kind: 'runtime-context' } })
  f.emit('user/message', { turn: 23, id: 'time-context-23', source: { kind: 'time-context' } })
  assert.equal(f.activities.at(-1).attribution, 'self_review')
  f.emit('turn/end', { turn: 23, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'provider secret must not be retained' } } })
  assert.equal(f.activities.at(-1).turnStatus, 'failed')
  assert.deepEqual(f.activities.at(-1).turnDiagnostic, { phase: 'before_tools', code: 'TRANSPORT' })
  assert.doesNotMatch(JSON.stringify(f.activities), /provider secret/)
  f.cleanup()

  const withTool = fixture()
  await surface(withTool.host, { reviewId: 'after-tool-review', messageId: 'msg-after-tool-review' })
  withTool.emit('turn/start', { turn: 24 })
  withTool.callbacks.get('agent/inbox/claimed')?.({ agent: withTool.agent, message: withTool.messages[0], turn: 24 })
  withTool.emit('step/start', { turn: 24, step: 1 })
  withTool.emit('user/message', { turn: 24, id: withTool.messages[0].id, source: withTool.messages[0].source })
  const call = withTool.emit('tool/call', { turn: 24, step: 1, callId: 'call-24', name: 'unavailable_tool', arguments: '{}' })
  withTool.emit('tool/result', { turn: 24, step: 1, message: { role: 'tool', toolCallId: 'call-24', source: { kind: 'tool', callId: 'call-24' }, isError: true } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  withTool.emit('turn/end', { turn: 24, reason: { kind: 'error', error: { code: 'QUOTA', message: 'provider details' } } })
  assert.deepEqual(withTool.activities.at(-1).turnDiagnostic, { phase: 'after_tools', code: 'QUOTA' })
  withTool.cleanup()

  const preDispatch = fixture()
  await surface(preDispatch.host, { reviewId: 'pre-dispatch-review', messageId: 'msg-pre-dispatch-review' })
  preDispatch.emit('turn/start', { turn: 26 })
  preDispatch.callbacks.get('agent/inbox/claimed')?.({ agent: preDispatch.agent, message: preDispatch.messages[0], turn: 26 })
  preDispatch.emit('step/start', { turn: 26, step: 1 })
  preDispatch.emit('user/message', { turn: 26, id: preDispatch.messages[0].id, source: preDispatch.messages[0].source })
  const notDispatchedCall = preDispatch.emit('tool/call', { turn: 26, step: 1, callId: 'not-dispatched', name: 'web_search', arguments: '{}' })
  for (const error of [
    { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
    { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
    { name: 'ToolNotStartedError', code: 'TOOL_ABORTED_BEFORE_DISPATCH' },
  ]) {
    preDispatch.emit('tool/result', { turn: 26, step: 1, error,
      message: { role: 'tool', toolCallId: 'not-dispatched', source: { kind: 'tool', callId: 'not-dispatched' }, isError: true } },
    { surfaceOp: 'append', sourceEventSeqs: [notDispatchedCall.seq] })
    assert.equal(preDispatch.observations.length, 0, `${error.code} is not a failed activity result`)
  }
  preDispatch.emit('turn/end', { turn: 26, reason: { kind: 'error', error: { code: 'TRANSPORT' } } })
  assert.deepEqual(preDispatch.activities.at(-1).turnDiagnostic, { phase: 'during_tools', code: 'TRANSPORT' }, 'pre-dispatch results do not consume outstanding call state')
  preDispatch.cleanup()
})
console.log(`ABS host: ${checks} groups passed (offline; no model/network).`)
