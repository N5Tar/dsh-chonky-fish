import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createChannelReply } from '../channel-reply.js'
import { digest, writeJson } from '../core.js'

const directory = await mkdtemp(join(tmpdir(), 'channel-reply-test-'))
const instances = new Set()
let sequence = 0
const inbound = name => 'social-' + digest(name)
const target = { type: 'direct', id: 'private-target' }
const key = (connectionId, conversation) => JSON.stringify([connectionId, conversation])
const error = code => Object.assign(new Error('private diagnostic must not escape'), { code })
function makeRoute(name, overrides = {}) {
  const row = { sessionId: 'main', inboundMessageId: inbound(name), connectionId: 'connection', conversation: target, identityRevision: 'rev1', ...overrides }
  return { ...row, sessionKey: key(row.connectionId, row.conversation) }
}
const start = turn => ({ type: 'turn/start', data: { turn } })
const user = (id, source = 'user') => ({ type: 'user/message', data: { id, role: 'user', source: { kind: source }, content: [{ type: 'text', text: '喂' }] } })
const assistant = (turn, id, text, extra = {}) => ({ type: 'assistant/message', data: { turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }] }, ...extra } })
const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
async function setup() {
  const file = join(directory, 'state-' + sequence++ + '.json'), sends = [], revocations = []
  const controls = { connected: true, identityRevision: 'rev1', result: { status: 'accepted' }, sendError: null }
  const service = {
    issueScope({ sessionId, connectionId, conversation }) {
      if (!controls.connected) throw error('SOCIAL_NOT_CONNECTED')
      return { sessionId, connectionId, conversation, identityRevision: controls.identityRevision, sessionKey: key(connectionId, conversation) }
    },
    scopedIdentity() { return {} },
    revokeScope(scope) { revocations.push(scope) },
    async send(scope, input) {
      const durable = JSON.parse(await readFile(file, 'utf8'))
      const intent = durable.turns.find(row => row.operationId === input.operationId)
      assert.ok(intent, 'intent exists before send')
      assert.equal(intent.status, 'sending', 'pre-send marker is durable before transport')
      assert.equal(intent.output, input.text, 'final output is durable before transport')
      sends.push({ scope, ...structuredClone(input) })
      controls.onSend?.()
      if (controls.sendError) throw controls.sendError
      return controls.result
    },
  }
  const dispatcher = await createChannelReply({ file, service }); instances.add(dispatcher)
  return { file, service, dispatcher, sends, controls, revocations }
}
function feed(h, turn, route, answer = '回复', extra = []) {
  const events = [start(turn), user(route.inboundMessageId), ...extra, assistant(turn, 'assistant-' + turn, answer), end(turn)]
  for (const event of events) assert.equal(h.dispatcher.onEvent({ id: route.sessionId, header: {} }, event), undefined, 'event hook is synchronous')
  return events
}
try {
  // Three distinct consecutive turns, each explicitly registered. No sticky route for DSH next turn.
  {
    const h = await setup()
    for (let turn = 1; turn <= 3; turn++) {
      const route = makeRoute('consecutive-' + turn)
      await h.dispatcher.register(route)
      const events = feed(h, turn, route, '正文-' + turn, [user('runtime-' + turn, 'runtime-context'), user('time-' + turn, 'time-context')])
      await h.dispatcher.process()
      assert.equal(h.sends.length, turn)
      assert.equal(h.sends.at(-1).text, '正文-' + turn)
      for (const event of events) h.dispatcher.onEvent(route.sessionId, event)
      await h.dispatcher.process()
      assert.equal(h.sends.length, turn, 'replayed committed events do not resend')
    }
    h.dispatcher.onEvent('main', start(4)); h.dispatcher.onEvent('main', user('dsh-owner')); h.dispatcher.onEvent('main', assistant(4, 'dsh-answer', 'DSH PRIVATE ANSWER')); h.dispatcher.onEvent('main', end(4))
    assert.deepEqual(await h.dispatcher.process(), { pending: false })
    assert.equal(h.sends.length, 3)
    assert.equal(new Set(h.sends.map(send => send.operationId)).size, 3)
    const visible = JSON.stringify(h.dispatcher.inspect())
    for (const secret of ['private-target', '正文-', 'DSH PRIVATE ANSWER', 'sessionKey', 'connectionId']) assert.equal(visible.includes(secret), false)
    if (process.platform !== 'win32') assert.equal((await stat(h.file)).mode & 0o777, 0o600)
  }
  // Event-only dispatch works without a process/history pump.
  {
    const h = await setup(), route = makeRoute('event-only')
    await h.dispatcher.register(route)
    let timeout
    const sent = new Promise((resolve, reject) => { h.controls.onSend = resolve; timeout = setTimeout(() => reject(new Error('event-only dispatch stalled')), 2000) })
    try { feed(h, 1, route); await sent; assert.equal(h.sends.length, 1) } finally { clearTimeout(timeout) }
    await h.dispatcher.process()
  }
  // Earlier assistant text must not be attributed to a later inbound message.
  {
    const h = await setup(), route = makeRoute('late-input')
    await h.dispatcher.register(route)
    for (const event of [start(1), assistant(1, 'prior-output', 'PRIVATE BEFORE INPUT'), user(route.inboundMessageId), end(1)]) h.dispatcher.onEvent('main', event)
    await h.dispatcher.process()
    assert.equal(h.sends.length, 0); assert.equal(h.dispatcher.inspect()[0].errorCode, 'SOCIAL_REPLY_FINAL_MISSING')
  }
  // DSH conversational text mixed before or after channel input is never sent externally.
  for (const before of [true, false]) {
    const h = await setup(), route = makeRoute('mixed-' + before)
    await h.dispatcher.register(route)
    const input = user(route.inboundMessageId), owner = user('owner')
    for (const event of [start(1), ...(before ? [owner, input] : [input, owner]), assistant(1, 'mixed-output', 'PRIVATE MIXED ANSWER'), end(1)]) h.dispatcher.onEvent('main', event)
    assert.deepEqual(await h.dispatcher.process(), { pending: false })
    assert.equal(h.sends.length, 0)
    assert.equal(h.dispatcher.inspect()[0].errorCode, 'SOCIAL_REPLY_MIXED_TURN')
  }
  // Two distinct routes in one turn cannot fan out; identical route bindings send only once.
  for (const same of [true, false]) {
    const h = await setup(), first = makeRoute('first-' + same), second = makeRoute('second-' + same, same ? {} : { conversation: { type: 'direct', id: 'other-private' } })
    await h.dispatcher.register(first); await h.dispatcher.register(second)
    feed(h, 1, first, 'one final', [user(second.inboundMessageId)])
    await h.dispatcher.process()
    assert.equal(h.sends.length, same ? 1 : 0)
    if (!same) assert.ok(h.dispatcher.inspect().every(row => row.errorCode === 'SOCIAL_REPLY_MIXED_TURN'))
  }
  // Simultaneous sessions are independent, and the event is snapshotted synchronously.
  {
    const h = await setup(), first = makeRoute('session-a'), second = makeRoute('session-b', { sessionId: 'other-main' })
    await h.dispatcher.register(first); await h.dispatcher.register(second)
    h.dispatcher.onEvent('main', start(1)); h.dispatcher.onEvent('other-main', start(1))
    h.dispatcher.onEvent('main', user(first.inboundMessageId)); h.dispatcher.onEvent('other-main', user(second.inboundMessageId))
    const output = assistant(1, 'a-final', 'original text')
    h.dispatcher.onEvent('main', output); output.data.message.content[0].text = 'MUTATED PRIVATE TEXT'
    h.dispatcher.onEvent('other-main', assistant(1, 'b-final', 'other answer'))
    h.dispatcher.onEvent('main', end(1)); h.dispatcher.onEvent('other-main', end(1))
    await h.dispatcher.process()
    assert.deepEqual(h.sends.map(row => row.text), ['original text', 'other answer'])
    assert.deepEqual(h.sends.map(row => row.scope.sessionId), ['main', 'other-main'])
  }
  // Only the last completed assistant message qualifies; do not fall back to earlier text.
  for (const mode of ['tool', 'interrupted', 'empty', 'aborted', 'wrong-turn']) {
    const h = await setup(), route = makeRoute('invalid-last-' + mode)
    await h.dispatcher.register(route)
    h.dispatcher.onEvent('main', start(1)); h.dispatcher.onEvent('main', user(route.inboundMessageId))
    if (mode !== 'wrong-turn') h.dispatcher.onEvent('main', assistant(1, 'early', 'early commentary'))
    const last = assistant(mode === 'wrong-turn' ? 9 : 1, 'last', mode === 'empty' ? '' : 'must not send', mode === 'interrupted' ? { interrupted: true } : {})
    if (mode === 'tool') last.data.message.content.push({ type: 'tool-call', id: 'call', name: 'private-tool', input: {} })
    h.dispatcher.onEvent('main', last); h.dispatcher.onEvent('main', end(1, mode === 'aborted' ? 'aborted' : 'completed'))
    await h.dispatcher.process()
    assert.equal(h.sends.length, 0, mode)
    assert.equal(h.dispatcher.inspect()[0].status, 'canceled')
  }
  // Replayed earlier assistant/user events do not replace the latest output or taint next turn.
  {
    const h = await setup(), a = makeRoute('replay-a'), b = makeRoute('replay-b')
    await h.dispatcher.register(a); await h.dispatcher.register(b)
    const first = feed(h, 1, a, 'first')
    await h.dispatcher.process()
    h.dispatcher.onEvent('main', start(2)); h.dispatcher.onEvent('main', user(b.inboundMessageId))
    for (const event of first) h.dispatcher.onEvent('main', event)
    const early = assistant(2, 'early2', 'not final')
    h.dispatcher.onEvent('main', early); h.dispatcher.onEvent('main', assistant(2, 'final2', 'correct final')); h.dispatcher.onEvent('main', early); h.dispatcher.onEvent('main', end(2))
    await h.dispatcher.process()
    assert.deepEqual(h.sends.map(row => row.text), ['first', 'correct final'])
  }
  // Admission failures can retry; returned transport failures and ambiguous results never retry.
  for (const outcome of ['offline', 'rate', 'failed', 'unknown', 'throw']) {
    const h = await setup(), route = makeRoute('outcome-' + outcome)
    await h.dispatcher.register(route)
    if (outcome === 'offline') h.controls.connected = false
    if (outcome === 'rate') h.controls.sendError = error('SOCIAL_RATE_LIMITED')
    if (outcome === 'failed') h.controls.result = { status: 'failed', errorCode: 'SOCIAL_WEBHOOK_EXPIRED' }
    if (outcome === 'unknown') h.controls.result = { status: 'unknown' }
    if (outcome === 'throw') h.controls.sendError = new Error('PRIVATE HTTP DETAIL')
    feed(h, 1, route)
    const pending = await h.dispatcher.process()
    assert.equal(pending.pending, outcome === 'offline' || outcome === 'rate')
    const attempts = h.sends.length
    h.controls.connected = true; h.controls.sendError = null; h.controls.result = { status: 'accepted' }
    await h.dispatcher.process()
    assert.equal(h.sends.length, attempts + (['offline', 'rate'].includes(outcome) ? 1 : 0))
    if (outcome === 'rate') assert.equal(new Set(h.sends.map(row => row.operationId)).size, 1, 'safe retries reuse operation identity')
    assert.equal(JSON.stringify(h.dispatcher.inspect()).includes('PRIVATE HTTP DETAIL'), false)
  }
  // Changed verified identity is a terminal scope failure, not an endless retry.
  {
    const h = await setup(), route = makeRoute('stale')
    await h.dispatcher.register(route); h.controls.identityRevision = 'rev2'
    feed(h, 1, route); assert.deepEqual(await h.dispatcher.process(), { pending: false })
    assert.equal(h.sends.length, 0); assert.equal(h.dispatcher.inspect()[0].errorCode, 'SOCIAL_SCOPE_STALE')
  }
  // Close drains captured events without new sends: a finalized durable pending intent resumes.
  {
    const h = await setup(), route = makeRoute('restart-pending')
    await h.dispatcher.register(route); feed(h, 1, route, 'durable final'); await h.dispatcher.close()
    assert.equal(h.sends.length, 0)
    const reopened = await createChannelReply({ file: h.file, service: h.service }); instances.add(reopened)
    await reopened.process(); assert.equal(h.sends.length, 1); assert.equal(h.sends[0].text, 'durable final')
    await reopened.close()
    const state = JSON.parse(await readFile(h.file, 'utf8')); state.turns[0].status = 'sending'; await writeJson(h.file, state)
    const ambiguous = await createChannelReply({ file: h.file, service: h.service }); instances.add(ambiguous)
    assert.equal(ambiguous.inspect()[0].status, 'unknown')
    assert.deepEqual(await ambiguous.process(), { pending: false }); assert.equal(h.sends.length, 1)
  }
  // Incomplete live evidence is not reconstructed from session history on restart.
  {
    const h = await setup(), route = makeRoute('restart-incomplete')
    await h.dispatcher.register(route)
    h.dispatcher.onEvent('main', start(1)); h.dispatcher.onEvent('main', user(route.inboundMessageId)); await h.dispatcher.close()
    const restarted = await createChannelReply({ file: h.file, service: h.service }); instances.add(restarted)
    restarted.onEvent('main', assistant(1, 'late-final', 'PRIVATE AFTER RESTART')); restarted.onEvent('main', end(1))
    assert.deepEqual(await restarted.process(), { pending: false })
    assert.equal(h.sends.length, 0); assert.equal(restarted.inspect()[0].errorCode, 'SOCIAL_REPLY_RESTART_INCOMPLETE')
  }
  // Registration is idempotent only for an identical target and never evicts dedupe records.
  {
    const h = await setup(), route = makeRoute('duplicate-register')
    await h.dispatcher.register(route); await h.dispatcher.register(route)
    await assert.rejects(h.dispatcher.register({ ...route, identityRevision: 'different' }), { code: 'SOCIAL_REPLY_ROUTE_MISMATCH' })
    assert.equal(h.dispatcher.inspect().length, 1)
    await h.dispatcher.close()
    const raw = JSON.parse(await readFile(h.file, 'utf8'))
    raw.routes = Array.from({ length: 1024 }, (_, i) => makeRoute('cap-' + i))
    await writeJson(h.file, raw)
    const full = await createChannelReply({ file: h.file, service: h.service }); instances.add(full)
    await assert.rejects(full.register(makeRoute('over-cap')), { code: 'SOCIAL_REPLY_CAPACITY' })
    assert.equal(full.inspect().length, 1024)
  }
  // Any persistence failure poisons dispatch before sending and exposes only a safe diagnostic.
  {
    const h = await setup(), route = makeRoute('storage-failure')
    await h.dispatcher.register(route)
    assert.equal(dirname(resolve(h.file)), resolve(directory))
    await rm(h.file); await mkdir(h.file)
    feed(h, 1, route)
    assert.deepEqual(await h.dispatcher.process(), { pending: false })
    assert.equal(h.sends.length, 0)
    assert.equal(h.dispatcher.inspect()[0].errorCode, 'SOCIAL_REPLY_STORAGE_UNCERTAIN')
    assert.equal(JSON.stringify(h.dispatcher.inspect()).includes(directory), false)
  }
  // A legacy outbox or malformed file is not migrated, overwritten, or dispatched.
  {
    const h = await setup(); await h.dispatcher.close()
    for (const raw of ['{broken', JSON.stringify({ version: 1, routes: [] })]) {
      await writeFile(h.file, raw)
      await assert.rejects(createChannelReply({ file: h.file, service: h.service }))
      assert.equal(await readFile(h.file, 'utf8'), raw)
    }
  }
  // Real GUI prompts use user-rpc. They are conversational owner input, not
  // runtime context, regardless of whether they precede or follow the channel input.
  for (const source of ['user-rpc', 'future-owner-input']) for (const ownerFirst of [true, false]) {
    const h = await setup(), route = makeRoute('gui-mixed-' + source + '-' + ownerFirst)
    await h.dispatcher.register(route)
    const owner = user('gui-owner-' + source, source), external = user(route.inboundMessageId)
    for (const event of [start(1), ...(ownerFirst ? [owner, external] : [external, owner]), assistant(1, 'private-gui-answer', 'PRIVATE OWNER CONTEXT MUST NOT LEAVE DSH'), end(1)]) h.dispatcher.onEvent({ id: 'main' }, event)
    assert.deepEqual(await h.dispatcher.process(), { pending: false })
    assert.equal(h.sends.length, 0, 'GUI or unknown user-role input must cancel channel output')
    assert.equal(h.dispatcher.inspect()[0].status, 'canceled')
    assert.equal(h.dispatcher.inspect()[0].errorCode, 'SOCIAL_REPLY_MIXED_TURN')
  }
  // Ordinary DSH activity must not consume the 2048-turn channel ledger. Drain
  // each turn to test ledger capacity, not the intentionally bounded event queue.
  {
    const h = await setup()
    for (let turn = 1; turn <= 2100; turn++) {
      for (const event of [start(turn), user('local-owner-' + turn, 'user-rpc'), assistant(turn, 'local-answer-' + turn, 'local only'), end(turn)]) h.dispatcher.onEvent({ id: 'main' }, event)
      assert.deepEqual(await h.dispatcher.process(), { pending: false })
    }
    assert.equal(h.sends.length, 0); assert.deepEqual(h.dispatcher.inspect(), [])
    const route = makeRoute('after-2100-local-turns')
    await h.dispatcher.register(route)
    assert.deepEqual(JSON.parse(await readFile(h.file, 'utf8')).turns, [], 'no DSH-only turns retained')
    feed(h, 2101, route, '仍然能正常回复外部消息')
    await h.dispatcher.process()
    assert.equal(h.sends.length, 1); assert.equal(h.sends[0].text, '仍然能正常回复外部消息')
    assert.equal(h.dispatcher.inspect()[0].status, 'sent')
    assert.equal(JSON.parse(await readFile(h.file, 'utf8')).turns.length, 1)
  }
  console.log('channel-reply: PASS (live routing, GUI mixed-turn privacy, 2100 DSH-only turns, durable final intents, replay dedupe, safe retry/restart; no network)')
} finally {
  await Promise.all([...instances].map(instance => instance.close().catch(() => {})))
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  assert.ok(basename(directory).startsWith('channel-reply-test-'))
  await rm(directory, { recursive: true, force: true })
}
