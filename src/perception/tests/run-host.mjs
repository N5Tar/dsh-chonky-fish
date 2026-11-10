import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { installPerception } from '../index.js'
import { handlePerceptionRequest } from '../http.js'
import { createResources } from '../../resources/index.js'
import { perceptionTarget } from '../../platform/index.js'

const tests = [], test = (name, fn) => tests.push([name, fn])
function context() {
  let route, tool, condition, removed = 0, toolsRemoved = 0
  return { ctx: { logger: { warn() {} }, tools: { register(value, options) { tool = value; condition = options.when; return () => { ++toolsRemoved } } }, webServer: { register(value) { route = value; return () => { ++removed } } } },
    route: () => route, removed: () => removed, tool: () => tool, when: context => condition(context), toolsRemoved: () => toolsRemoved }
}
async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'fish-perception-test-'))
  try { await fn(directory) }
  finally {
    // Only delete the exact mkdtemp test directory, never a supplied/user path.
    assert.equal(resolve(directory), directory); assert.ok(directory.startsWith(join(tmpdir(), 'fish-perception-test-')))
    await rm(directory, { recursive: true, force: true })
  }
}
test('resources own route, paths, config and binary mapping', async () => {
  await temporary(async root => {
    const resources = createResources({ homeRoot: root }); await resources.ensureLayout()
    assert.equal(resources.routes.perception, '/chonkyfish/perception')
    assert.equal(resources.paths.perceptionDatabase, join(root, 'chonkyfish', 'perception', 'activity.db'))
    assert.equal(resources.getConfig().perception.enabled, true)
    await resources.updateConfig({ perception: { enabled: false, rawTtlMs: 1, summaryTtlMs: 1 } })
    assert.deepEqual(resources.getConfig().perception, { enabled: false, rawTtlMs: 930000, summaryTtlMs: 60000 })
    assert.equal(perceptionTarget('win32', 'x64').supported, false)
    assert.equal(perceptionTarget('darwin', 'arm64').supported, true)
  })
})
test('host initializes without collecting and disposes route/database', async () => {
  await temporary(async root => {
    const resources = createResources({ homeRoot: root }); const ctx = context()
    const module = installPerception(ctx.ctx, { resources, ready: resources.ensureLayout() })
    assert.equal(ctx.tool().name, 'perception_get_owner_state', 'registered during plugin initialization')
    const agent = { session: { header: { cwd: resources.paths.workspace, agentPreset: 'chonkyfish' } } }
    assert.equal(ctx.when({ agent }), true)
    await module.ready
    assert.equal((await ctx.tool().execute({}, { agent })).prediction, null)
    assert.equal(module.getFailure(), null)
    assert.ok(['stopped', 'unsupported'].includes(module.getService().getStatus().state))
    assert.equal(module.getService().getCurrent().data, null)
    assert.equal(ctx.route().path, resources.routes.perception)
    await module.close(); await module.close(); assert.equal(ctx.removed(), 1)
    assert.equal(ctx.toolsRemoved(), 1); assert.equal(ctx.when({ agent }), false)
  })
})
test('replacement install disposes previous same-directory instance first', async () => {
  await temporary(async root => {
    const resources = createResources({ homeRoot: root }), a = context(), b = context()
    const first = installPerception(a.ctx, { resources }); await first.ready
    const second = installPerception(b.ctx, { resources }); await second.ready
    assert.equal(a.removed(), 1); assert.equal(second.getFailure(), null)
    assert.equal(second.getService().getCurrent().data, null)
    await first.close(); await second.close(); assert.equal(b.removed(), 1)
  })
})
test('SQLite absence degrades module without breaking host', async () => {
  await temporary(async root => {
    const ctx = context(), resources = createResources({ homeRoot: root })
    const module = installPerception(ctx.ctx, { resources, loadSqlite: async () => { throw new Error('SQLite unavailable') } })
    await module.ready; assert.equal(module.getService(), null); assert.equal(module.getFailure().code, 'PERCEPTION_UNAVAILABLE')
    await module.close(); assert.equal(ctx.removed(), 1)
  })
})
test('dispose during initialization prevents late service creation', async () => {
  await temporary(async root => {
    let release, called = 0
    const ready = new Promise(r => { release = r }), ctx = context()
    const module = installPerception(ctx.ctx, { resources: createResources({ homeRoot: root }), ready,
      loadSqlite: async () => { ++called; throw new Error('must not load') } })
    const closing = module.close(); release(); await closing
    assert.equal(called, 0); assert.equal(module.getService(), null)
  })
})
const fakeService = () => {
  let state = 'stopped'
  return { getStatus: () => ({ state }), getCurrent: () => ({ data: null, freshness: { isFresh: false, reasons: ['no_analysis'] } }),
    getTimeline: args => ({ items: [], ...args }), getSummaries: args => ({ items: [], nextCursor: null, ...args }),
    async start() { state = 'running' }, async pause() { state = 'paused' }, async stop() { state = 'stopped' } }
}
test('HTTP current, ranges and numeric cursor are bounded', async () => {
  const service = fakeService(), query = url => handlePerceptionRequest({ service, url })
  assert.equal((await query('/?action=current')).body.data, null)
  assert.equal((await query('/?action=timeline')).status, 200)
  assert.equal((await query('/?action=summaries&cursor=1&limit=500')).body.beforeId, 1)
  for (const url of ['/?action=timeline&fromMs=0', '/?action=summaries&limit=501', '/?action=summaries&cursor=0', '/?action=status&action=current', '/?action=edit']) {
    assert.equal((await query(url)).status, 400, url)
  }
})
test('HTTP controls require JSON and reject cross-site requests', async () => {
  const service = fakeService()
  const call = options => handlePerceptionRequest({ service, method: 'POST', body: '{"action":"start"}', ...options })
  assert.equal((await call({})).status, 415)
  const headers = { 'content-type': 'application/json', host: '127.0.0.1:49444', origin: 'http://127.0.0.1:49444' }
  assert.equal((await call({ headers })).body.state, 'running')
  assert.equal((await call({ headers, body: '{"action":"pause"}' })).body.state, 'paused')
  assert.equal((await call({ headers: { ...headers, origin: 'https://evil.example' } })).status, 403)
  assert.equal((await call({ headers, body: '{"action":"delete"}' })).status, 400)
  assert.equal((await call({ headers, body: 'x'.repeat(17000) })).status, 413)
})
test('registered route supports HEAD and bounds streamed request bodies', async () => {
  await temporary(async root => {
    const c = context(), resources = createResources({ homeRoot: root })
    const module = installPerception(c.ctx, { resources }); await module.ready
    const request = async (method, body = '', headers = {}) => {
      const input = Readable.from(body ? [Buffer.from(body)] : [])
      Object.assign(input, { method, url: '/?action=status', headers })
      let result = {}
      await c.route().handler(input, { writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders }, end(data) { result.data = data } })
      return result
    }
    const head = await request('HEAD'); assert.equal(head.status, 200); assert.equal(head.data, undefined); assert.equal(head.headers['cache-control'], 'no-store')
    const oversized = await request('POST', 'x'.repeat(17000), { 'content-type': 'application/json' }); assert.equal(oversized.status, 413)
    const wrong = await request('POST', '{}', { 'content-type': 'text/plain' }); assert.equal(wrong.status, 415)
    await module.close(); assert.equal((await request('GET')).status, 503)
  })
})
for (const [name, fn] of tests) { await fn(); console.log('PASS', name) }
console.log(`perception host/http: ${tests.length} passed`)
