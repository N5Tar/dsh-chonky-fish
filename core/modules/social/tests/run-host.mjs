import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../../../app/dsh/host/index.js'
import { createResources } from '../../../../app/shared/resources/index.js'

const home = await mkdtemp(join(tmpdir(), 'social-host-'))
const priorHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const routes = new Map(), listeners = new Map(), guards = [], effects = [], grants = [], contexts = []
const expected = ['/chonkyfish/social', '/chonkyfish/diary', '/chonkyfish/events', '/chonkyfish/proactive']
let readyResolve
const ready = new Promise(resolve => { readyResolve = resolve })
const tools = new Map(), variables = new Map()
const ctx = {
  logger: { warn() {}, info() {} },
  get() { return undefined },
  on(name, handler) { const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); return () => {} },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose },
  agents: { list() { return [] } },
  agentPresets: { composedPreset() { return 'chonkyfish' } },
  permissionPresets: { set(session, preset) { grants.push({ session, preset }) } },
  systemPrompt: { variable(name, provider) { variables.set(name, provider); return () => variables.delete(name) }, context(value) { contexts.push(value); return () => {} } },
  tools: {
    guard(fn) { guards.push(fn); return () => { const i = guards.indexOf(fn); if (i >= 0) guards.splice(i, 1) } },
    register(tool, options = {}) { tools.set(tool.name, { ...tool, options }); return () => tools.delete(tool.name) },
  },
  connection: { requestRejection() { return undefined } },
  webServer: { register(route) {
    routes.set(route.path, route)
    if (expected.every(path => routes.has(path))) readyResolve()
    return () => routes.delete(route.path)
  } },
}
const timeout = setTimeout(() => { readyResolve(); }, 5000)
try {
  apply(ctx)
  await ready
  assert.ok(expected.every(path => routes.has(path)), 'all Host modules initialize even without session/model capabilities')
  assert.deepEqual([...tools.keys()].filter(name => name.startsWith('social_')), ['social_send_owner_message'], 'only proactive owner messaging is exposed')
  const ownerSend = tools.get('social_send_owner_message')
  const mainFish = { session: { id: 'main', header: { agentPreset: 'chonkyfish', cwd: join(home, 'chonkyfish', '小鱼塘') }, snapshotEvents: () => [] } }
  assert.equal(ownerSend.options.when({ agent: mainFish }), true, 'fish main-session turns may message the owner')
  assert.equal(ownerSend.options.when({ agent: { session: { id: 'other', header: { agentPreset: 'other', cwd: '/tmp' } } } }), false)
  assert.equal((await ownerSend.execute({ operationId: 'owner-test', text: '你好' })).error, 'SOCIAL_NO_OWNER_CHAT')
  assert.equal(contexts.some(value => value.name.includes('social')), false, 'no channel/source prompt is injected')
  assert.match(variables.get('chonkyfish_modules')(), /## 能力说明/)
  assert.doesNotMatch(variables.get('chonkyfish_modules')(), /### 钉钉/, 'no connected channel means no advertised DingTalk capability')
  const social = { session: { id: 'unbound', header: { agentPreset: 'chonkyfish-social', cwd: join(home, 'social') } }, ctx: { tools: { restrict() {} } } }
  const owner = { session: { id: 'owner', header: { agentPreset: 'chonkyfish' } }, ctx: { tools: { restrict() {} } } }
  for (const listener of listeners.get('agent/created') ?? []) listener({ agent: social })
  assert.equal(grants.length, 0, 'social preset never inherits automatic full access')
  for (const listener of listeners.get('agent/created') ?? []) listener({ agent: owner })
  assert.equal(grants.length, 1, 'owner behavior remains compatible')
  assert.equal(guards.length, 0, 'social module never installs a channel-based tool guard')
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { id: 'social-' + 'a'.repeat(64), content: [{ type: 'text', text: '喂' }], source: { kind: 'user' } } }]
  const external = { status: 'running', session: { id: 'main', header: { agentPreset: 'chonkyfish', cwd: join(home, 'chonkyfish', '小鱼塘') }, snapshotEvents: () => events } }
  assert.equal(ownerSend.options.when({ agent: external }), true, 'channel-origin main turns retain owner messaging')
  assert.equal(ownerSend.options.when({ agent: social }), false, 'visitor sessions do not inherit the main owner messaging tool')
  events.push({ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } }, { type: 'user/message', data: { source: { kind: 'user' } } })
  assert.equal(ownerSend.options.when({ agent: external }), true, 'ordinary turns keep the same tool availability')
  const patch = await readFile(new URL('../../../../app/dsh/packaging/cordis.patch.yml', import.meta.url), 'utf8')
  const visitorPreset = patch.split('    - id: preset-chonkyfish\n')[0]
  assert.doesNotMatch(visitorPreset, /不调用工具|不包含通用工具|社交受限会话/)
  for (const tool of ['bash', 'pwsh', 'fs', 'fs-search', 'jobs', 'todo', 'schedule', 'web']) assert.ok(visitorPreset.includes("name: '@deepseek-ai/dsh-tool-" + tool + "'"), 'visitor preset includes ' + tool)
  const request = (path, method, body) => new Promise(resolve => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method
    const response = { writeHead(status) { this.status = status }, end(body) { resolve({ status: this.status, body: body ? JSON.parse(body) : null }) } }
    routes.get(path).handler(req, response)
  })
  assert.equal((await request('/chonkyfish/session', 'PUT', { sessionId: 'selected-main' })).status, 204)
  const diaryList = await request('/chonkyfish/diary', 'GET')
  assert.equal(diaryList.status, 200, 'diary read route is registered synchronously and waits for startup readiness')
  assert.deepEqual(diaryList.body.dates, [])
  assert.equal((await request('/chonkyfish/social', 'GET')).body.bridge.targetSessionId, 'selected-main', 'selection changes before debounced disk persistence')
  assert.equal((await request('/chonkyfish/session', 'PUT', { sessionId: 'new-main' })).status, 204)
  assert.equal((await request('/chonkyfish/social', 'GET')).body.bridge.targetSessionId, 'new-main')
  assert.ok((listeners.get('session/event') ?? []).length > 0, 'post-commit session event adapter is installed')
  const committed = [
    { type: 'turn/start', data: { turn: 999 } },
    { type: 'user/message', data: { id: 'owner-local', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'DSH-local-only' }] } },
    { type: 'assistant/message', data: { turn: 999, step: 1, message: { id: 'owner-local-answer', role: 'assistant', content: [{ type: 'text', text: 'PRIVATE LOCAL ANSWER' }] } } },
    { type: 'turn/end', data: { turn: 999, reason: { kind: 'completed' } } },
  ]
  for (const [seq, event] of committed.entries()) for (const handler of listeners.get('session/event') ?? []) handler(mainFish.session, { seq, ...event })
  for (const handler of listeners.get('session/event') ?? []) handler({ id: 'unrelated-session', header: { agentPreset: 'other', cwd: '/tmp' } }, committed[0])
  const eventStatus = (await request('/chonkyfish/social', 'GET')).body.bridge
  assert.equal(eventStatus.replies.some(row => row.errorCode), false, JSON.stringify(eventStatus))
  // Disposal is the deterministic drain barrier; the event emitter itself never awaits writes.
  for (const dispose of effects.splice(0).reverse()) await dispose()
  const resources = createResources({ homeRoot: home })
  await assert.rejects(readFile(resources.paths.socialChannelReplies, 'utf8'), { code: 'ENOENT' }, 'unregistered DSH-only turns never allocate channel reply ledger capacity')
  console.log('social-host: PASS (session/event adapter, peer-backed owner absence, main selection, channel tool access, visitor tool preset, missing-host isolation, no model/source prompt)')
} finally {
  clearTimeout(timeout)
  for (const dispose of effects.reverse()) await dispose()
  if (priorHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = priorHome
}
