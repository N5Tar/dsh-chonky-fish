import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createResources } from '../../resources/index.js'
import { createConfigStore } from '../config.js'
import { createSocialService } from '../service.js'
import { createFakeDriver } from '../drivers/fake.js'
import { createSocialBridge } from '../session-bridge.js'

const target = { type: 'direct', id: '20002' }
const config = { version: 1, connections: [{ id: 'qq', platform: 'qq', provider: 'napcat', endpoint: 'ws://127.0.0.1:3001/' }] }
async function fixture() {
  const resources = createResources({ homeRoot: await mkdtemp(join(tmpdir(), 'social-bridge-')) })
  await createConfigStore(resources.paths.socialConfig).write(config)
  let driver
  const service = await createSocialService({ paths: resources.paths, limits: resources.spec.SOCIAL.limits, driverFactory: value => (driver = createFakeDriver(value)) })
  const logs = new Map(), agents = new Map()
  const counters = { created: 0, resumed: 0, followup: 0, read: 0, readClosed: 0, flush: 0 }
  const flags = { flush: true, persist: true, permit: true }
  const permissions = { presets: { 'read-only': { sandbox: 'read-only', approval: 'ask' } }, set(session, name) { assert.equal(name, 'read-only'); if (!flags.permit) throw new Error('permission unavailable'); session.permission = name } }
  const presets = { async mount(agentCtx, name) { agentCtx.preset = name }, composedPreset(agentCtx) { return agentCtx.preset } }
  const sessions = { async flush(session) {
    counters.flush++
    if (!flags.flush) return false
    if (flags.persist) logs.set(session.id, { header: structuredClone(session.header), events: structuredClone(session.snapshotEvents()) })
    return true
  } }
  const persistence = { identity: 'test-backend', async open(sessionId, mode) {
    assert.equal(mode, 'read'); counters.read++
    if (!logs.has(sessionId)) throw Object.assign(new Error('missing'), { name: 'SessionPersistenceNotFoundError', sessionId })
    const record = structuredClone(logs.get(sessionId))
    return { header: record.header, async read(offset) { assert.equal(offset, 0); return { events: record.events } }, async close() { counters.readClosed++ } }
  } }
  async function open(options, resume) {
    const sessionId = resume ? options.resumeSessionId : options.sessionId
    const stored = resume ? logs.get(sessionId) : null
    if (resume && !stored) throw Object.assign(new Error('missing'), { name: 'SessionPersistenceNotFoundError', sessionId })
    const header = stored?.header ?? { id: sessionId, ...options.meta }
    const events = structuredClone(stored?.events ?? [])
    const cleanups = [], guards = []
    const agentCtx = { effect(fn) { cleanups.push(fn()) }, tools: {
      presentAs(mode) { assert.equal(mode, 'native') },
      restrict(input) { assert.ok(input.allow.includes('social_send_message')); assert.ok(!input.allow.includes('bash')) },
      guard(fn) { guards.push(fn) },
    } }
    const agent = { ctx: agentCtx, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { id: sessionId, header, snapshotEvents: () => events }, guards,
      followup(message) {
        assert.equal(agent.session.permission, 'read-only', 'restriction must precede delivery')
        assert.equal(guards[0]({ agent, name: 'bash' }), 'Social restricted session denied')
        counters.followup++
        events.push({ type: 'agent/inbox/spliced', data: { inserted: [structuredClone(message)] } })
        events.push({ type: 'user/message', data: structuredClone(message) })
      },
    }
    try { await options.setup(agentCtx, agent) } catch (error) { for (const fn of cleanups) fn?.(); throw error }
    if (resume) counters.resumed++; else counters.created++
    agents.set(sessionId, agent)
    return { agent, async dispose() { for (const fn of cleanups) fn?.(); agents.delete(sessionId) } }
  }
  const ctx = { agents: { list: () => [...agents.values()], create: options => open(options, false), resume: options => open(options, true) }, agentPresets: presets, sessions, permissionPresets: permissions,
    get(name) { if (name === 'sessionPersistence') return persistence; if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test' }) } },
  }
  const bridge = await createSocialBridge({ ctx, service, resources })
  const emit = id => driver.emit({ messageId: id, conversation: target, sender: { id: '20002' }, text: '外部内容' + id, sentAt: Date.now() })
  return { ctx, resources, service, bridge, driver, counters, flags, logs, agents, emit, async close() { await bridge.close(); await service.close() } }
}
let count = 0
async function test(name, fn) { await fn(); count++; console.log(`ok ${count} - ${name}`) }
await test('explicit view only; setup precedes message; silent ACK; trusted object scope', async () => {
  const f = await fixture()
  try {
    await f.emit('1'); await f.emit('2')
    assert.equal(f.counters.created, 0)
    assert.equal(f.counters.followup, 0)
    assert.equal(f.bridge.inspect().available, true)
    const result = await f.bridge.view({ connectionId: 'qq', conversation: target })
    assert.equal(result.status, 'viewed'); assert.equal(result.sentAutomatically, false)
    assert.equal(f.counters.created, 1); assert.equal(f.counters.followup, 1)
    assert.equal(f.driver.sent.length, 0)
    assert.equal((await f.service.listNotices())[0].unreadCount, 0)
    const agent = f.agents.get(result.sessionId)
    assert.ok(f.bridge.scopeForAgent(agent))
    assert.equal(f.bridge.scopeForAgent({ ...agent }), null)
    agent.ctx.preset = 'chonkyfish'
    assert.equal(f.bridge.scopeForAgent(agent), null)
    agent.ctx.preset = 'chonkyfish-social'
    assert.equal((await f.bridge.view({ connectionId: 'qq', conversation: target })).status, 'empty')
    assert.equal(f.counters.followup, 1)
    await f.bridge.close()
    assert.equal(f.bridge.scopeForAgent(agent), null)
  } finally { await f.close() }
})
await test('flush false never ACKs; retry proves exact prior batch without redelivery', async () => {
  const f = await fixture()
  try {
    await f.emit('1'); f.flags.flush = false
    await assert.rejects(f.bridge.view({ connectionId: 'qq', conversation: target }), { code: 'SOCIAL_PERSISTENCE_UNACKNOWLEDGED' })
    assert.equal((await f.service.listNotices())[0].unreadCount, 1)
    f.flags.flush = true
    assert.equal((await f.bridge.view({ connectionId: 'qq', conversation: target })).status, 'viewed')
    assert.equal(f.counters.followup, 1)
  } finally { await f.close() }
})
await test('flush success without actual durable evidence does not ACK', async () => {
  const f = await fixture()
  try {
    await f.emit('1'); f.flags.persist = false
    await assert.rejects(f.bridge.view({ connectionId: 'qq', conversation: target }))
    assert.equal((await f.service.listNotices())[0].unreadCount, 1)
    f.flags.persist = true
    await f.bridge.view({ connectionId: 'qq', conversation: target })
    assert.equal(f.counters.followup, 1)
  } finally { await f.close() }
})
await test('bridge recreation safely resumes a uniquely bound Social session', async () => {
  const f = await fixture()
  let second
  try {
    await f.emit('1'); await f.bridge.view({ connectionId: 'qq', conversation: target })
    await f.bridge.close()
    await f.emit('2')
    second = await createSocialBridge({ ctx: f.ctx, service: f.service, resources: f.resources })
    assert.equal((await second.view({ connectionId: 'qq', conversation: target })).status, 'viewed')
    assert.equal(f.counters.created, 1); assert.equal(f.counters.resumed, 1); assert.equal(f.counters.followup, 2)
  } finally { await second?.close(); await f.close() }
})
await test('missing host and permission fail closed without disrupting inbox', async () => {
  const f = await fixture()
  let unavailable
  try {
    unavailable = await createSocialBridge({ ctx: {}, service: f.service, resources: f.resources })
    assert.equal(unavailable.inspect().available, false)
    await f.emit('1')
    await assert.rejects(unavailable.view({ connectionId: 'qq', conversation: target }), { code: 'SOCIAL_HOST_CAPABILITY_UNAVAILABLE' })
    f.flags.permit = false
    await assert.rejects(f.bridge.view({ connectionId: 'qq', conversation: target }))
    assert.equal(f.counters.followup, 0)
    assert.equal((await f.service.listNotices())[0].unreadCount, 1)
  } finally { await unavailable?.close(); await f.close() }
})
await test('unknown delivery intent never replays; corrupt binding never overwritten', async () => {
  const f = await fixture()
  let recovered
  try {
    await f.emit('1'); f.flags.flush = false
    await assert.rejects(f.bridge.view({ connectionId: 'qq', conversation: target }))
    const agent = [...f.agents.values()][0]
    const state = JSON.parse(await readFile(f.resources.paths.socialBindings, 'utf8'))
    f.logs.set(agent.session.id, { header: structuredClone(agent.session.header), events: [] })
    await f.bridge.close(); f.flags.flush = true
    recovered = await createSocialBridge({ ctx: f.ctx, service: f.service, resources: f.resources })
    await assert.rejects(recovered.view({ connectionId: 'qq', conversation: target }), { code: 'SOCIAL_DELIVERY_UNCERTAIN' })
    assert.equal(f.counters.followup, 1)
    await recovered.close()
    state.bindings[0].cwd = '/outside'
    await writeFile(f.resources.paths.socialBindings, JSON.stringify(state))
    await assert.rejects(createSocialBridge({ ctx: f.ctx, service: f.service, resources: f.resources }), { code: 'SOCIAL_BINDINGS_INVALID' })
    assert.equal(JSON.parse(await readFile(f.resources.paths.socialBindings, 'utf8')).bindings[0].cwd, '/outside')
  } finally { await recovered?.close(); await f.close() }
})
await test('crash after inbox ACK before bridge journal ACK repairs without replay', async () => {
  const f = await fixture()
  let recovered
  try {
    await f.emit('1'); await f.bridge.view({ connectionId: 'qq', conversation: target }); await f.bridge.close()
    const state = JSON.parse(await readFile(f.resources.paths.socialBindings, 'utf8'))
    state.bindings[0].delivery.status = 'attempted'
    await writeFile(f.resources.paths.socialBindings, JSON.stringify(state))
    recovered = await createSocialBridge({ ctx: f.ctx, service: f.service, resources: f.resources })
    assert.equal((await recovered.view({ connectionId: 'qq', conversation: target })).status, 'empty')
    assert.equal(f.counters.followup, 1)
    assert.equal(JSON.parse(await readFile(f.resources.paths.socialBindings, 'utf8')).bindings[0].delivery.status, 'acknowledged')
  } finally { await recovered?.close(); await f.close() }
})
console.log(`social-bridge: ${count}/${count} passed (audited API mocks; no real host/model/platform turns)`)

