import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createResources } from '../../resources/index.js'
import { createConfigStore } from '../config.js'
import { createSocialService } from '../service.js'
import { createFakeDriver } from '../drivers/fake.js'
import { createSocialBridge, isMainSocialTurn } from '../session-bridge.js'
import { FISH_PRESET } from '../../proactive/identity.js'
import { createPeerBindings } from '../peer-bindings.js'
import { digest } from '../core.js'

const target = { type: 'direct', id: '20002' }, other = { type: 'group', id: '30003' }
// Keep the legacy connection ID while exercising real DingTalk owner pairing and peer routing.
const config = { version: 1, connections: [{ id: 'qq', platform: 'dingtalk', provider: 'dingtalk-stream', clientId: 'mock-app', clientSecret: 'mock-only-secret', robotCode: 'mock-robot' }] }
const input = conversation => ({ connectionId: 'qq', conversation: conversation ?? target })
async function fixture() {
  const resources = createResources({ homeRoot: await mkdtemp(join(tmpdir(), 'social-main-bridge-')) })
  await createConfigStore(resources.paths.socialConfig).write(config)
  let driver, liveBridge
  const peers = await createPeerBindings({ file: resources.paths.socialPeerBindings })
  const service = await createSocialService({ paths: resources.paths, peers, limits: { ...resources.spec.SOCIAL.limits, sendIntervalMs: 0 }, driverFactory: value => (driver = createFakeDriver(value)) })
  const revision = (await service.inspect()).connections[0].identityRevision
  const pairing = await peers.issueCode({ connectionId: 'qq', identityRevision: revision })
  assert.equal((await driver.emit({ messageId: 'pair-control', conversation: target, sender: { id: '20002' }, text: pairing.code, sentAt: Date.now() })).control, true)
  assert.equal((await service.listNotices()).length, 0, 'pairing code is consumed as control, never model input')
  const logs = new Map(), agents = new Map()
  const counters = { followup: 0, resolve: 0, read: 0, readClosed: 0, flush: 0, created: 0 }
  const flags = { flush: true, persist: true, commit: true, active: 'main-a', throwFollowup: false }
  function makeAgent(id, patch = {}) {
    const events = [], header = { id, cwd: resources.paths.workspace, agentPreset: FISH_PRESET, ...patch }
    const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { id, header, snapshotEvents: () => events }, events,
      publish(event) {
        const committed = { seq: events.length, ...structuredClone(event) }
        events.push(committed)
        // Host session/event emits post-commit without awaiting listeners.
        liveBridge?.onEvent(agent.session, committed)
      },
      followup(message) {
        counters.followup++
        if (flags.throwFollowup) throw new Error('unknown followup admission')
        agent.publish({ type: 'agent/inbox/spliced', data: { inserted: [structuredClone(message)] } })
        if (flags.commit) { agent.status = 'running'; agent.publish({ type: 'turn/start', data: { turn: events.length } }); agent.publish({ type: 'user/message', data: structuredClone(message) }) }
        else agent.inbox.nextTurn.push(structuredClone(message))
      },
      finish(reason = 'completed') { const turn = events.filter(event => event.type === 'turn/start').at(-1)?.data.turn; agent.publish({ type: 'turn/end', data: { turn, reason: { kind: reason } } }); agent.status = 'idle'; agent.inbox.nextTurn = []; agent.inbox.nextStep = [] },
      answer(value = '在呢。', content) { const turn = events.filter(event => event.type === 'turn/start').at(-1)?.data.turn; agent.publish({ type: 'assistant/message', data: { turn, step: 1, message: { id: 'answer-' + events.length, role: 'assistant', source: { kind: 'model' }, content: content ?? [{ type: 'text', text: value }] } } }) },
      owner() { agent.publish({ type: 'user/message', data: { id: 'owner-' + events.length, role: 'user', source: { kind: 'user' }, content: [] } }) },
      ownerTurn() { agent.finish(); agent.publish({ type: 'turn/start', data: { turn: events.length } }); agent.owner(); agent.status = 'running' },
    }
    agents.set(id, agent); logs.set(id, { header: structuredClone(header), events: [] }); return agent
  }
  const a = makeAgent('main-a'), b = makeAgent('main-b')
  const sessions = { async flush(session) {
    counters.flush++
    if (!flags.flush) return false
    if (flags.persist) logs.set(session.id, { header: structuredClone(session.header), events: structuredClone(session.snapshotEvents()) })
    return true
  } }
  const persistence = { identity: 'test-backend', async open(id, mode) {
    assert.equal(mode, 'read'); counters.read++
    if (!logs.has(id)) throw Object.assign(new Error('missing'), { name: 'SessionPersistenceNotFoundError', sessionId: id })
    const record = structuredClone(logs.get(id))
    return { header: record.header, async read(offset, length) { assert.ok(Number.isSafeInteger(offset) && offset >= 0); assert.equal(length, 50001); counters.lastReadOffset = offset; return { events: record.events.slice(offset, offset + length) } }, async close() { counters.readClosed++ } }
  } }
  const ctx = { get(name) {
    if (name === 'sessionController') return {
      async resolveAgent(id) { counters.resolve++; return agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } } },
      async create({ sessionId, cwd, agentPreset }) {
        assert.equal(peers.hasPeerSession(sessionId), true, 'ID must be reserved before creation')
        assert.equal(cwd, join(resources.paths.socialWorkspace, digest(sessionId)))
        assert.equal(agentPreset, resources.spec.SOCIAL.preset)
        assert.equal(agents.has(sessionId), false)
        counters.created++; makeAgent(sessionId, { cwd, agentPreset })
        return { sessionId }
      },
    }
    if (name === 'sessions') return sessions
    if (name === 'sessionPersistence') return persistence
    if (['agents', 'agentPresets', 'agentDefaultModel'].includes(name)) assert.fail('must not create agents, mount presets, or select models')
  } }
  const getActiveSessionId = () => flags.active
  const bridge = await createSocialBridge({ ctx, service, resources, peers, getActiveSessionId }); liveBridge = bridge
  const emit = (id, conversation = target, senderId = '20002') => driver.emit({ messageId: id, conversation, sender: { id: senderId }, text: '外部内容' + id, sentAt: Date.now() })
  return { ctx, resources, service, peers, bridge, driver, counters, flags, logs, agents, a, b, makeAgent, emit, getActiveSessionId,
    rebuild: async () => (liveBridge = await createSocialBridge({ ctx, service, resources, peers, getActiveSessionId })), async close() { await liveBridge.close(); await bridge.close(); await service.close(); await peers.close() } }
}
let count = 0
async function test(name, fn) { await fn(); count++; console.log(`ok ${count} - ${name}`) }

await test('caller pumps unread into current existing main; no separate workspace or agent', async () => {
  const f = await fixture()
  try {
    await f.emit('1'); await f.emit('2')
    assert.equal(f.counters.followup, 0, 'bridge has no subscription or timer')
    const notice = (await f.service.listNotices())[0]
    const result = await f.bridge.view(notice) // same call the automatic pump makes
    assert.equal(result.status, 'viewed'); assert.equal(result.sessionId, 'main-a'); assert.equal(result.sentAutomatically, false)
    assert.equal(f.counters.followup, 1); assert.equal(f.agents.size, 2); assert.equal(f.driver.sent.length, 0)
    assert.equal((await f.service.listNotices())[0].unreadCount, 1, 'one platform message per model request')
    assert.equal(f.bridge.inspect().mode, 'main-session-auto'); assert.equal(f.bridge.inspect().bindingCount, 0)
    const delivered = f.a.events.find(event => event.type === 'user/message').data
    assert.deepEqual(delivered.source, { kind: 'user' })
    assert.deepEqual(delivered.content, [{ type: 'text', text: '外部内容1' }])
    assert.deepEqual(Object.keys(delivered).sort(), ['content', 'id', 'role', 'source'])
    assert.ok(f.bridge.scopeForAgent(f.a)); assert.equal(f.bridge.scopeForAgent({ ...f.a }), null)
    assert.equal(f.bridge.isSocialTurn(f.a), true); assert.equal(isMainSocialTurn(f.a), true)
    assert.equal((await f.bridge.view(input())).status, 'busy')
    f.a.finish(); await f.bridge.view(input())
    assert.equal(f.counters.followup, 2)
    assert.equal((await f.service.listNotices())[0].unreadCount, 0)
    await assert.rejects(access(f.resources.paths.socialWorkspace), { code: 'ENOENT' })
    await assert.rejects(access(f.resources.paths.socialBindings), { code: 'ENOENT' })
  } finally { await f.close() }
})
await test('no active main remains pending, busy waits without insertion, target may switch', async () => {
  const f = await fixture()
  try {
    await f.emit('1'); f.flags.active = null
    assert.equal((await f.bridge.view(input())).status, 'pending'); assert.equal(f.counters.resolve, 0)
    f.flags.active = 'main-a'; f.a.status = 'running'
    assert.equal((await f.bridge.view(input())).status, 'busy'); assert.equal(f.counters.followup, 0)
    f.flags.active = 'main-b'; assert.equal((await f.bridge.view(input())).sessionId, 'main-b')
    await f.emit('2'); f.b.finish(); f.flags.active = 'main-a'; f.a.status = 'idle'
    assert.equal((await f.bridge.view(input())).sessionId, 'main-a')
    assert.equal(f.counters.followup, 2)
  } finally { await f.close() }
})
await test('resolved header must be main fish workspace/preset, never subagent', async () => {
  const f = await fixture()
  try {
    await f.emit('1')
    for (const patch of [{ cwd: '/unrelated' }, { agentPreset: 'other' }, { origin: 'subagent' }, { delegationDepth: 1 }]) {
      f.makeAgent('invalid', patch); f.flags.active = 'invalid'
      assert.equal((await f.bridge.view(input())).status, 'pending')
    }
    f.flags.active = 'missing'; assert.equal((await f.bridge.view(input())).status, 'pending')
    assert.equal(f.counters.followup, 0)
  } finally { await f.close() }
})
await test('owner input revokes reply; mixed turn stays restricted, next owner turn restores', async () => {
  const f = await fixture()
  try {
    await f.emit('1'); await f.bridge.view(input()); assert.ok(f.bridge.scopeForAgent(f.a))
    f.a.owner(); assert.equal(f.bridge.scopeForAgent(f.a), null)
    assert.equal(f.bridge.isSocialTurn(f.a), true); assert.equal(isMainSocialTurn(f.a), true)
    f.a.ownerTurn(); assert.equal(f.bridge.isSocialTurn(f.a), false); assert.equal(isMainSocialTurn(f.a), false)
    assert.equal(f.bridge.scopeForAgent(f.a), null)
  } finally { await f.close() }
})
await test('owner group never enters main and cannot share reply capability with owner direct', async () => {
  const f = await fixture()
  try {
    await f.emit('1'); await f.bridge.view(input()); const ownerScope = f.bridge.scopeForAgent(f.a)
    assert.deepEqual(ownerScope.conversation, target)
    await f.emit('2', other); const result = await f.bridge.view(input(other))
    assert.equal(result.status, 'viewed'); assert.notEqual(result.sessionId, 'main-a')
    const peer = f.agents.get(result.sessionId), groupScope = f.bridge.scopeForAgent(peer)
    assert.deepEqual(groupScope.conversation, other)
    assert.equal(peer.session.header.agentPreset, f.resources.spec.SOCIAL.preset)
    assert.equal(peer.session.header.cwd, join(f.resources.paths.socialWorkspace, digest(result.sessionId)))
    assert.equal(f.a.events.filter(event => event.type === 'user/message').length, 1)
    assert.deepEqual(f.service.scopedIdentity(ownerScope).connectionId, 'qq', 'independent main capability is not borrowed by the group')
    const foreign = structuredClone(f.a.events.find(event => event.type === 'user/message').data)
    peer.publish({ type: 'user/message', data: foreign })
    assert.equal(f.bridge.scopeForAgent(peer), null)
    assert.throws(() => f.service.scopedIdentity(groupScope), { code: 'SOCIAL_TARGET_UNBOUND' })
    peer.answer('mixed group private text'); peer.finish(); await f.bridge.processReplies()
    assert.equal(f.driver.sent.length, 0)
  } finally { await f.close() }
})
await test('queued owner revokes; pending external only restricts, never grants send', async () => {
  const f = await fixture()
  try {
    f.flags.commit = false; await f.emit('1'); await f.bridge.view(input())
    assert.equal(f.bridge.isSocialTurn(f.a), true); assert.equal(isMainSocialTurn(f.a), true)
    assert.equal(f.bridge.scopeForAgent(f.a), null)
    const message = f.a.inbox.nextTurn.shift()
    assert.equal(f.bridge.isSocialTurn(f.a), true, 'precommit drained-inbox gap stays restricted')
    f.a.publish({ type: 'turn/start', data: { turn: f.a.events.length } }); f.a.publish({ type: 'user/message', data: message }); f.a.status = 'running'
    assert.ok(f.bridge.scopeForAgent(f.a))
    f.a.inbox.nextStep.push({ id: 'owner', role: 'user', source: { kind: 'user' } })
    assert.equal(f.bridge.scopeForAgent(f.a), null); assert.equal(f.bridge.isSocialTurn(f.a), true)
    f.a.ownerTurn(); assert.equal(f.bridge.isSocialTurn(f.a), false)
  } finally { await f.close() }
})
await test('flush false recovery only original target; restart cannot duplicate in new main', async () => {
  const f = await fixture(); let second
  try {
    await f.emit('1'); f.flags.flush = false
    await assert.rejects(f.bridge.view(input()), { code: 'SOCIAL_PERSISTENCE_UNACKNOWLEDGED' })
    assert.equal((await f.service.listNotices())[0].unreadCount, 1)
    await f.bridge.close(); f.flags.active = 'main-b'; f.flags.flush = true
    second = await f.rebuild(); assert.equal((await second.view(input())).status, 'empty')
    assert.equal(f.counters.followup, 1); assert.equal(f.b.events.length, 0)
    assert.ok(second.scopeForAgent(f.a)); assert.equal(second.scopeForAgent(f.b), null)
    await f.emit('2'); assert.equal((await second.view(input())).sessionId, 'main-b')
  } finally { await second?.close(); await f.close() }
})
await test('unknown followup intent never replays after restart or main switch', async () => {
  const f = await fixture(); let second
  try {
    await f.emit('1'); f.flags.throwFollowup = true
    await assert.rejects(f.bridge.view(input()))
    await f.bridge.close(); f.flags.active = 'main-b'; f.flags.throwFollowup = false
    second = await f.rebuild()
    await assert.rejects(second.view(input()), { code: 'SOCIAL_DELIVERY_UNCERTAIN' })
    assert.equal(f.counters.followup, 1); assert.equal((await f.service.listNotices())[0].unreadCount, 1)
    assert.equal(second.inspect().lastError, 'SOCIAL_DELIVERY_UNCERTAIN')
  } finally { await second?.close(); await f.close() }
})
await test('flush success without evidence does not ACK; later proof repairs without replay', async () => {
  const f = await fixture()
  try {
    await f.emit('1'); f.flags.persist = false
    await assert.rejects(f.bridge.view(input()), { code: 'SOCIAL_DELIVERY_UNCERTAIN' })
    assert.equal((await f.service.listNotices())[0].unreadCount, 1)
    f.flags.persist = true; assert.equal((await f.bridge.view(input())).status, 'empty')
    assert.equal(f.counters.followup, 1); assert.equal(f.counters.read, f.counters.readClosed)
  } finally { await f.close() }
})
await test('crash after inbox ACK repairs journal without replay; old bindings ignored', async () => {
  const f = await fixture(); let second
  try {
    await f.emit('1'); await f.bridge.view(input()); await f.bridge.close()
    const state = JSON.parse(await readFile(f.resources.paths.socialMainDeliveries, 'utf8'))
    state.deliveries[0].delivery.status = 'attempted'
    await writeFile(f.resources.paths.socialMainDeliveries, JSON.stringify(state))
    delete state.deliveries[0].delivery.eventOffset // Pre-offset journal compatibility defaults to zero.
    await writeFile(f.resources.paths.socialMainDeliveries, JSON.stringify(state))
    await writeFile(f.resources.paths.socialBindings, 'old corrupt bindings must never load')
    second = await f.rebuild(); assert.equal((await second.view(input())).status, 'empty')
    assert.equal(f.counters.followup, 1)
    assert.equal(JSON.parse(await readFile(f.resources.paths.socialMainDeliveries, 'utf8')).deliveries[0].delivery.status, 'acknowledged')
  } finally { await second?.close(); await f.close() }
})
await test('missing capabilities and close never dispose main agents or ACK pending input', async () => {
  const f = await fixture(); let missing
  try {
    missing = await createSocialBridge({ ctx: {}, service: f.service, resources: f.resources, peers: f.peers, getActiveSessionId: f.getActiveSessionId })
    assert.equal(missing.inspect().available, false)
    assert.ok(missing.inspect().missingCapabilities.includes('sessionController.resolveAgent'))
    await f.emit('1'); await assert.rejects(missing.view(input()), { code: 'SOCIAL_HOST_CAPABILITY_UNAVAILABLE' })
    await f.bridge.view(input()); await f.bridge.close()
    assert.equal(f.agents.size, 2); assert.equal(f.a.status, 'running')
    assert.equal(f.bridge.scopeForAgent(f.a), null)
    assert.equal(isMainSocialTurn(f.a), true, 'stateless guard survives bridge unload')
    await assert.rejects(f.bridge.view(input()), { code: 'SOCIAL_BRIDGE_CLOSED' })
  } finally { await missing?.close(); await f.close() }
})
await test('active target changing during resolve cannot receive a stale followup', async () => {
  const f = await fixture(); let bridge
  try {
    await f.emit('1')
    const ctx = { get(name) {
      if (name === 'sessionController') return { async resolveAgent() { f.flags.active = 'main-b'; return { agent: f.a } } }
      return f.ctx.get(name)
    } }
    bridge = await createSocialBridge({ ctx, service: f.service, resources: f.resources, peers: f.peers, getActiveSessionId: f.getActiveSessionId })
    const result = await bridge.view(input())
    assert.equal(result.status, 'pending'); assert.equal(result.reason, 'SOCIAL_MAIN_SESSION_CHANGED')
    assert.equal(f.counters.followup, 0)
    await assert.rejects(access(f.resources.paths.socialMainDeliveries), { code: 'ENOENT' })
  } finally { await bridge?.close(); await f.close() }
})
await test('close during async resolve cannot deliver or dispose the borrowed agent', async () => {
  const f = await fixture(); let bridge, release, entered
  const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve })
  try {
    await f.emit('1')
    const ctx = { get(name) {
      if (name === 'sessionController') return { async resolveAgent() { entered(); await gate; return { agent: f.a } } }
      return f.ctx.get(name)
    } }
    bridge = await createSocialBridge({ ctx, service: f.service, resources: f.resources, peers: f.peers, getActiveSessionId: f.getActiveSessionId })
    const viewing = bridge.view(input()); await ready
    const closing = bridge.close(); release()
    await assert.rejects(viewing, { code: 'SOCIAL_BRIDGE_CLOSED' }); await closing
    assert.equal(f.counters.followup, 0); assert.equal(f.agents.get('main-a'), f.a)
  } finally { release(); await bridge?.close(); await f.close() }
})
await test('attempted recovery can ACK cold durable evidence without creating any agent', async () => {
  const f = await fixture(); let second
  try {
    await f.emit('1'); await f.bridge.view(input()); await f.bridge.close()
    const state = JSON.parse(await readFile(f.resources.paths.socialMainDeliveries, 'utf8'))
    state.deliveries[0].delivery.status = 'attempted'
    await writeFile(f.resources.paths.socialMainDeliveries, JSON.stringify(state))
    f.agents.delete('main-a'); f.flags.active = 'main-b'
    second = await f.rebuild(); assert.equal((await second.view(input())).status, 'empty')
    assert.equal(f.counters.followup, 1); assert.equal(f.agents.size, 1)
  } finally { await second?.close(); await f.close() }
})
await test('pure turn guard ignores closed historical external turns and survives absent bridge', async () => {
  const f = await fixture()
  try {
    await f.emit('1'); await f.bridge.view(input()); assert.equal(isMainSocialTurn(f.a), true)
    f.a.finish(); assert.equal(isMainSocialTurn(f.a), false)
    f.a.ownerTurn(); assert.equal(isMainSocialTurn(f.a), false)
    f.a.events.push({ type: 'user/message', data: { role: 'user', source: { kind: 'chonkyfish-social' } } })
    assert.equal(isMainSocialTurn(f.a), true, 'any external input taints the current turn')
    assert.equal(f.bridge.scopeForAgent(f.a), null, 'unrecognized external input grants no route')
  } finally { await f.close() }
})
await test('long completed history does not freeze owner tools; only current turn controls trust', async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 20000; i++) f.a.events.push({ type: 'turn/start', data: {} }, { type: 'user/message', data: { role: 'user', source: { kind: 'chonkyfish-social' } } }, { type: 'turn/end', data: {} })
    assert.ok(f.a.events.length > 50000)
    assert.equal(isMainSocialTurn(f.a), false); assert.equal(f.bridge.isSocialTurn(f.a), false)
    f.a.ownerTurn()
    assert.equal(isMainSocialTurn(f.a), false); assert.equal(f.bridge.isSocialTurn(f.a), false)
    f.a.events.push({ type: 'user/message', data: { role: 'user', source: { kind: 'chonkyfish-social' } } })
    assert.equal(isMainSocialTurn(f.a), true); assert.equal(f.bridge.isSocialTurn(f.a), true)
    f.a.ownerTurn()
    assert.equal(isMainSocialTurn(f.a), false); assert.equal(f.bridge.isSocialTurn(f.a), false)
    // Only a *single* unresolved turn beyond the scan bound stays fail-closed.
    for (let i = 0; i < 50001; i++) f.a.events.push({ type: 'step/end', data: {} })
    assert.equal(isMainSocialTurn(f.a), true)
    f.a.ownerTurn(); assert.equal(isMainSocialTurn(f.a), false)
  } finally { await f.close() }
})
await test('durable evidence starts at persisted delivery offset after long main history', async () => {
  const f = await fixture(); let recovered
  try {
    for (let i = 0; i < 20000; i++) {
      f.a.events.push({ seq: f.a.events.length, type: 'turn/start', data: {} })
      f.a.events.push({ seq: f.a.events.length, type: 'user/message', data: { role: 'user', source: { kind: 'user' } } })
      f.a.events.push({ seq: f.a.events.length, type: 'turn/end', data: {} })
    }
    await f.emit('long-history')
    assert.equal((await f.bridge.view(input())).status, 'viewed')
    assert.equal(f.counters.lastReadOffset, 60000)
    assert.equal((await f.service.listNotices())[0].unreadCount, 0)
    const state = JSON.parse(await readFile(f.resources.paths.socialMainDeliveries, 'utf8'))
    assert.equal(state.deliveries[0].delivery.eventOffset, 60000)
    await f.bridge.close()
    state.deliveries[0].delivery.status = 'attempted'
    await writeFile(f.resources.paths.socialMainDeliveries, JSON.stringify(state))
    recovered = await f.rebuild(); assert.equal((await recovered.view(input())).status, 'empty')
    assert.equal(f.counters.followup, 1); assert.equal(f.counters.lastReadOffset, 60000)
    await recovered.close()
    state.deliveries[0].delivery.eventOffset = 60003 // Skips real evidence: never enough to authorize ACK.
    await writeFile(f.resources.paths.socialMainDeliveries, JSON.stringify(state))
    recovered = await f.rebuild()
    await assert.rejects(recovered.view(input()), { code: 'SOCIAL_DELIVERY_UNCERTAIN' })
    await recovered.close()
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      state.deliveries[0].delivery.eventOffset = invalid
      await writeFile(f.resources.paths.socialMainDeliveries, JSON.stringify(state))
      await assert.rejects(f.rebuild(), { code: 'SOCIAL_DELIVERIES_INVALID' })
    }
  } finally { await recovered?.close(); await f.close() }
})
await test('喂 plain user payload to completed assistant final reaches original transport once', async () => {
  const f = await fixture(); let second
  try {
    await f.driver.emit({ messageId: 'real-inbound', conversation: target, sender: { id: '20002', name: 'sender must stay backend' }, text: '喂', sentAt: Date.now() })
    await f.bridge.view(input())
    const message = f.a.events.find(event => event.type === 'user/message').data
    assert.deepEqual(message, { id: message.id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '喂' }] })
    assert.match(message.id, /^social-[a-f0-9]{64}$/)
    assert.equal(f.bridge.inspect().replies[0].inboundMessageId, message.id)
    assert.deepEqual(await f.bridge.processReplies(), { pending: false }, 'unfinished turns wait for lifecycle events, not a history scan timer')
    assert.equal(f.bridge.inspect().replies[0].status, 'waiting')
    f.a.answer('我在。'); f.a.finish(); f.flags.active = 'main-b'
    assert.deepEqual(await f.bridge.processReplies('main-a'), { pending: false })
    assert.equal(f.driver.sent.length, 1); assert.equal(f.driver.sent[0].text, '我在。'); assert.deepEqual(f.driver.sent[0].conversation, target)
    await f.bridge.processReplies(); assert.equal(f.driver.sent.length, 1)
    await f.bridge.close(); second = await f.rebuild(); await second.processReplies()
    assert.equal(f.driver.sent.length, 1); assert.equal(second.inspect().replies[0].status, 'sent')
    assert.deepEqual(Object.keys(second.inspect().replies[0]).sort(), ['assistantMessageId', 'inboundMessageId', 'sessionId', 'status', 'turn'])
  } finally { await second?.close(); await f.close() }
})
await test('independent outbox keeps both routes when latest conversation journal advances', async () => {
  const f = await fixture()
  try {
    await f.emit('request-a'); await f.bridge.view(input()); f.a.answer('答复A'); f.a.finish()
    await f.emit('request-b', other); const groupResult = await f.bridge.view(input(other)); const group = f.agents.get(groupResult.sessionId); group.answer('答复B'); group.finish()
    await f.emit('request-c'); await f.bridge.view(input()); f.a.answer('答复C'); f.a.finish()
    // The same-conversation journal has advanced, but all three reply routes survive.
    assert.equal(JSON.parse(await readFile(f.resources.paths.socialMainDeliveries, 'utf8')).deliveries.length, 2)
    // Event-driven sends may already have completed; page selection cannot retarget any intent.
    f.flags.active = 'main-b'
    await f.bridge.processReplies()
    assert.deepEqual(f.driver.sent.map(value => [value.conversation, value.text]), [[target, '答复A'], [other, '答复B'], [target, '答复C']])
    assert.equal(f.bridge.inspect().replies.length, 3)
    await f.bridge.processReplies(); assert.equal(f.driver.sent.length, 3)
  } finally { await f.close() }
})
await test('mixed owner turn is canceled while next independently registered turn can reply', async () => {
  const f = await fixture()
  try {
    await f.emit('mixed'); await f.bridge.view(input()); f.a.owner(); f.a.answer('主人隐私不得发送'); f.a.finish()
    await f.emit('safe', other); const result = await f.bridge.view(input(other)); const group = f.agents.get(result.sessionId); group.answer('群聊回复'); group.finish()
    await f.bridge.processReplies()
    assert.equal(f.driver.sent.length, 1); assert.deepEqual(f.driver.sent[0].conversation, other); assert.equal(f.driver.sent[0].text, '群聊回复')
    assert.deepEqual(f.bridge.inspect().replies.map(value => value.status), ['canceled', 'sent'])
  } finally { await f.close() }
})
await test('reply routing consumes post-commit events, never discovers output by scanning snapshots', async () => {
  const f = await fixture()
  try {
    await f.emit('1'); await f.bridge.view(input())
    const turn = f.a.events.findLast(event => event.type === 'turn/start').data.turn
    const reads = f.counters.read, flushes = f.counters.flush
    // Historical/snapshot data without a live event notification is not reply evidence anymore.
    f.a.events.push({ type: 'assistant/message', data: { turn, step: 1, message: { id: 'snapshot-only', role: 'assistant', content: [{ type: 'text', text: '历史文本不可推断发送' }] } } })
    assert.deepEqual(await f.bridge.processReplies(), { pending: false }); assert.equal(f.driver.sent.length, 0)
    f.flags.flush = false; f.flags.persist = false
    f.a.answer('已提交事件回复'); f.a.finish(); await f.bridge.processReplies()
    assert.equal(f.driver.sent.length, 1); assert.equal(f.driver.sent[0].text, '已提交事件回复')
    assert.equal(f.counters.read, reads, 'final reply never opens SessionPersistence')
    assert.equal(f.counters.flush, flushes, 'post-commit Event contract removes extra final-history flush')
  } finally { await f.close() }
})
await test('legacy acknowledged notice is never registered for automatic historical reply', async () => {
  const f = await fixture(); let second
  try {
    await f.emit('legacy'); await f.bridge.view(input()); f.a.answer('历史notice答复不可发送'); f.a.finish(); await f.bridge.close()
    const journal = JSON.parse(await readFile(f.resources.paths.socialMainDeliveries, 'utf8'))
    delete journal.deliveries[0].delivery.format; delete journal.deliveries[0].delivery.contentHash
    await writeFile(f.resources.paths.socialMainDeliveries, JSON.stringify(journal))
    const legacy = JSON.stringify({ version: 1, routes: [] })
    await writeFile(f.resources.paths.socialReplies, legacy)
    // Simulate an acknowledged deployment predating the new live-event journal.
    await writeFile(f.resources.paths.socialChannelReplies, JSON.stringify({ version: 1, format: 'channel-reply-v1', routes: [], turns: [] }))
    second = await f.rebuild(); assert.equal((await second.view(input())).status, 'empty')
    assert.deepEqual(await second.processReplies(), { pending: false }); assert.equal(f.driver.sent.length, 0)
    assert.deepEqual(second.inspect().replies, [])
    assert.equal(await readFile(f.resources.paths.socialReplies, 'utf8'), legacy, 'legacy outbox is untouched')
  } finally { await second?.close(); await f.close() }
})
await test('visitor A/B get distinct reserved sessions; same sender reuses its peer across main switches', async () => {
  const f = await fixture()
  try {
    const chatA = { type: 'direct', id: 'visitor-chat-a' }, chatB = { type: 'direct', id: 'visitor-chat-b' }
    f.flags.active = null // Visitors do not require or borrow the owner's current main session.
    await f.emit('visitor-a-1', chatA, 'visitor-A'); const a = await f.bridge.view(input(chatA))
    await f.emit('visitor-b-1', chatB, 'visitor-B'); const b = await f.bridge.view(input(chatB))
    assert.equal(a.status, 'viewed'); assert.equal(b.status, 'viewed')
    assert.notEqual(a.sessionId, b.sessionId)
    assert.match(a.sessionId, /^social-peer-/); assert.match(b.sessionId, /^social-peer-/)
    assert.equal(f.counters.created, 2)
    for (const id of [a.sessionId, b.sessionId]) {
      const agent = f.agents.get(id)
      assert.equal(agent.session.header.cwd, join(f.resources.paths.socialWorkspace, digest(id)))
      assert.equal(agent.session.header.agentPreset, f.resources.spec.SOCIAL.preset)
      assert.equal(f.peers.hasPeerSession(id), true)
    }
    f.agents.get(a.sessionId).answer('A的答复'); f.agents.get(a.sessionId).finish()
    f.agents.get(b.sessionId).answer('B的答复'); f.agents.get(b.sessionId).finish()
    await f.bridge.processReplies()
    assert.deepEqual(f.driver.sent.map(row => [row.conversation, row.text]), [[chatA, 'A的答复'], [chatB, 'B的答复']])
    f.flags.active = 'main-b'
    await f.emit('visitor-a-2', chatA, 'visitor-A'); const again = await f.bridge.view(input(chatA))
    assert.equal(again.sessionId, a.sessionId); assert.equal(f.counters.created, 2)
    assert.equal(f.a.events.length, 0); assert.equal(f.b.events.length, 0)
    f.agents.get(a.sessionId).answer('A第二轮'); f.agents.get(a.sessionId).finish(); await f.bridge.processReplies()
    await f.emit('owner-main-b'); const owner = await f.bridge.view(input())
    assert.equal(owner.sessionId, 'main-b', 'paired owner direct follows current main, not a peer binding')
    f.b.answer('主人答复'); f.b.finish(); await f.bridge.processReplies()
    assert.equal(f.driver.sent.at(-1).text, '主人答复'); assert.deepEqual(f.driver.sent.at(-1).conversation, target)
  } finally { await f.close() }
})
await test('three complete owner turns each reply; runtime/time injections do not cancel; DSH-only next never sends', async () => {
  const f = await fixture()
  try {
    for (let index = 1; index <= 3; index++) {
      await f.emit('round-' + index); await f.bridge.view(input())
      for (const kind of ['runtime-context', 'time-context']) f.a.publish({ type: 'user/message', data: { id: kind + index, role: 'user', source: { kind }, content: [{ type: 'text', text: 'system context' }] } })
      f.a.answer('第' + index + '轮'); f.a.finish(); await f.bridge.processReplies()
      assert.equal(f.driver.sent.length, index)
    }
    assert.deepEqual(f.driver.sent.map(row => row.text), ['第1轮', '第2轮', '第3轮'])
    f.a.ownerTurn(); f.a.answer('DSH私人答复'); f.a.finish(); await f.bridge.processReplies()
    assert.equal(f.driver.sent.length, 3, 'previous reply target never sticks to DSH-only turn')
    assert.ok(f.bridge.inspect().replies.every(row => row.status === 'sent'))
  } finally { await f.close() }
})
await test('peer header tampering cannot route visitors into main workspace', async () => {
  const f = await fixture()
  try {
    const chat = { type: 'direct', id: 'visitor-tamper' }
    await f.emit('visitor-first', chat, 'visitor-X'); const first = await f.bridge.view(input(chat)); f.agents.get(first.sessionId).finish()
    f.agents.get(first.sessionId).session.header.cwd = f.resources.paths.workspace
    f.agents.get(first.sessionId).session.header.agentPreset = FISH_PRESET
    await f.emit('visitor-second', chat, 'visitor-X')
    await assert.rejects(f.bridge.view(input(chat)), { code: 'SOCIAL_PEER_SESSION_INVALID' })
    assert.equal(f.counters.followup, 1); assert.equal((await f.service.listNotices())[0].unreadCount, 1)
    assert.equal(f.a.events.length, 0)
  } finally { await f.close() }
})
await test('owner active selection cannot target a tracked visitor session even with spoofed main header', async () => {
  const f = await fixture()
  try {
    const chat = { type: 'direct', id: 'visitor-selected' }
    await f.emit('visitor-init', chat, 'visitor-selected'); const selected = await f.bridge.view(input(chat))
    const peer = f.agents.get(selected.sessionId); peer.finish()
    f.flags.active = selected.sessionId
    await f.emit('owner-must-not-leak')
    await assert.rejects(f.bridge.view(input()), { code: 'SOCIAL_MAIN_SESSION_INVALID' })
    peer.session.header.cwd = f.resources.paths.workspace
    peer.session.header.agentPreset = FISH_PRESET
    await assert.rejects(f.bridge.view(input()), { code: 'SOCIAL_MAIN_SESSION_INVALID' })
    assert.equal(f.counters.followup, 1, 'owner body is never enqueued into peer session')
    assert.equal(peer.events.filter(event => event.type === 'user/message').length, 1)
    assert.equal((await f.service.listNotices()).find(row => row.conversation.id === target.id).unreadCount, 1)
  } finally { await f.close() }
})
for (const roundTrip of [false, true]) await test('owner rebind during resolve rejects stale admission' + (roundTrip ? ' even A -> B -> A' : ''), async () => {
  const f = await fixture(); let bridge, release
  try {
    await f.bridge.close(); await f.emit('owner-before-rebind')
    let entered
    const reached = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
    const controller = f.ctx.get('sessionController'), baseGet = f.ctx.get
    const ctx = { ...f.ctx, get(name) { return name === 'sessionController' ? { ...controller, async resolveAgent(id) { entered(); await gate; return controller.resolveAgent(id) } } : baseGet(name) } }
    bridge = await createSocialBridge({ ctx, service: f.service, resources: f.resources, peers: f.peers, getActiveSessionId: f.getActiveSessionId })
    const attempt = bridge.view(input()); await reached
    const revision = (await f.service.inspect()).connections[0].identityRevision
    const original = f.peers.owner('qq', revision)
    for (const sender of roundTrip ? ['different-owner', '20002'] : ['different-owner']) {
      const code = await f.peers.issueCode({ connectionId: 'qq', identityRevision: revision })
      const result = await f.driver.emit({ messageId: 'pair-' + sender, conversation: sender === '20002' ? target : { type: 'direct', id: 'different-owner-chat' }, sender: { id: sender }, text: code.code, sentAt: Date.now() })
      assert.equal(result.control, true)
    }
    assert.notEqual(f.peers.owner('qq', revision).claimId, original.claimId)
    release(); await assert.rejects(attempt, { code: 'SOCIAL_OWNER_CHANGED' })
    assert.equal(f.counters.followup, 0)
    assert.equal((await f.service.listNotices())[0].unreadCount, 1)
  } finally { release?.(); await bridge?.close(); await f.close() }
})
await test('closing during reserved visitor creation prevents followup and later resolve', async () => {
  const f = await fixture(); let bridge, release
  try {
    await f.bridge.close()
    const chat = { type: 'direct', id: 'visitor-close' }
    await f.emit('visitor-close-message', chat, 'visitor-close')
    let entered
    const reached = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
    const controller = f.ctx.get('sessionController'), baseGet = f.ctx.get
    const ctx = { ...f.ctx, get(name) { return name === 'sessionController' ? { ...controller, async create(options) { entered(); await gate; return controller.create(options) } } : baseGet(name) } }
    bridge = await createSocialBridge({ ctx, service: f.service, resources: f.resources, peers: f.peers, getActiveSessionId: f.getActiveSessionId })
    const attempt = bridge.view(input(chat)); await reached
    const resolves = f.counters.resolve, closing = bridge.close()
    // peer-bindings deliberately redacts errors thrown inside the create callback.
    release(); await assert.rejects(attempt, { code: 'SOCIAL_PEER_CREATE_FAILED' }); await closing
    assert.equal(f.counters.followup, 0)
    assert.equal(f.counters.resolve, resolves, 'no post-close resolve after admitted create finishes')
    assert.equal((await f.service.listNotices())[0].unreadCount, 1)
    assert.equal(f.a.events.length, 0); assert.equal(f.b.events.length, 0)
  } finally { release?.(); await bridge?.close(); await f.close() }
})
console.log(`social-main-bridge: ${count}/${count} passed (real peer store; post-commit lifecycle mocks; no real host/model/platform turns)`)
