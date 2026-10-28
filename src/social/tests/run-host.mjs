import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../../index.js'

const home = await mkdtemp(join(tmpdir(), 'social-host-'))
const priorHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const routes = new Map(), listeners = new Map(), guards = [], effects = [], grants = []
const expected = ['/chonkyfish/social', '/chonkyfish/diary', '/chonkyfish/events', '/chonkyfish/proactive']
let readyResolve
const ready = new Promise(resolve => { readyResolve = resolve })
const tools = new Map()
const ctx = {
  logger: { warn() {}, info() {} },
  get() { return undefined },
  on(name, handler) { const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); return () => {} },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose },
  agents: { list() { return [] } },
  agentPresets: { composedPreset() { return 'chonkyfish' } },
  permissionPresets: { set(session, preset) { grants.push({ session, preset }) } },
  systemPrompt: { variable() { return () => {} } },
  tools: {
    guard(fn) { guards.push(fn); return () => { const i = guards.indexOf(fn); if (i >= 0) guards.splice(i, 1) } },
    register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
  },
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
  assert.ok(tools.has('social_send_message'))
  const social = { session: { id: 'unbound', header: { agentPreset: 'chonkyfish-social', cwd: join(home, 'social') } }, ctx: { tools: { restrict() {} } } }
  const owner = { session: { id: 'owner', header: { agentPreset: 'chonkyfish' } }, ctx: { tools: { restrict() {} } } }
  for (const listener of listeners.get('agent/created') ?? []) listener({ agent: social })
  assert.equal(grants.length, 0, 'social preset never inherits automatic full access')
  for (const listener of listeners.get('agent/created') ?? []) listener({ agent: owner })
  assert.equal(grants.length, 1, 'owner behavior remains compatible')
  assert.ok(guards.some(guard => typeof guard({ agent: social, name: 'bash' }) === 'string'))
  assert.ok(guards.some(guard => typeof guard({ agent: social, name: 'diary' }) === 'string'))
  assert.ok(guards.some(guard => typeof guard({ agent: social, name: 'social_send_message' }) === 'string'))
  assert.ok(guards.some(guard => typeof guard({ agent: owner, name: 'social_send_message' }) === 'string'))
  console.log('social-host: PASS (default-off startup, missing-host bridge isolation, global guards, owner compatibility)')
} finally {
  clearTimeout(timeout)
  for (const dispose of effects.reverse()) await dispose()
  if (priorHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = priorHome
}
