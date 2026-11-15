import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../../host/index.js'

const home = await mkdtemp(join(tmpdir(), 'chonkyfish-companion-host-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const guards = [], effects = [], listeners = new Map(), variables = new Map(), registered = new Map()
const owner = { id: 'owner', session: { id: 'owner', header: { agentPreset: 'chonkyfish' }, snapshotEvents: () => [] } }
const other = { id: 'other', session: { id: 'other', header: { agentPreset: 'other' }, snapshotEvents: () => [] } }
const live = [owner, other]
const definitions = ['stardew_session_start', 'stardew_session_status', 'stardew_session_cancel',
  'stardew_tool_task', 'stardew_tool_task_status', 'stardew_cancel_tool_task',
  'stardew_travel_task', 'stardew_travel_status', 'stardew_travel_cancel',
].map(name => ({ name: `mcp__stardew2__${name}`, parameters: { type: 'object', properties: { requestId: { type: 'string' } } } }))
const ctx = {
  logger: { warn() {}, info() {} },
  get(name) { return name === 'sessionPersistence' ? { stat: async id => ({ header: { id, agentPreset: 'chonkyfish' } }) } : undefined },
  on(name, handler) { const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); return () => list.splice(list.indexOf(handler), 1) },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose },
  agents: { list: () => live, get: id => live.find(agent => agent.id === id), isOwnedBy: () => false },
  agentPresets: { composedPreset: () => undefined },
  permissionPresets: { set() {} },
  systemPrompt: { variable(name, provider) { variables.set(name, provider); return () => variables.delete(name) }, context() { return () => {} } },
  tools: {
    definitions: () => definitions,
    guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1) },
    register(tool, options) { registered.set(tool.name, { tool, options }); return () => registered.delete(tool.name) },
  },
  connection: { requestRejection() {} },
  webServer: { register() { return () => {} } },
}
const execute = (name, agent = owner, args = {}) => {
  for (const guard of guards) {
    const reason = guard({ name, agent, arguments: args, signal: new AbortController().signal })
    if (reason) return reason
  }
  return undefined
}
try {
  apply(ctx)
  assert.equal(guards.length, 1, 'companion guard is installed synchronously before asynchronous task/phone initialization')
  assert.match(execute('pwsh'), /Native Stardew/, 'a real Host registration blocks shell-first game control')
  assert.equal(execute('pwsh', other), undefined, 'unrelated Agent tools stay available')
  assert.equal(execute('mcp__stardew2__stardew_tool_task'), undefined)
  assert.match(execute('mcp__stardew__stardew_tool_task'), /Native Stardew/)
  assert.match(variables.get('chonkyfish_modules')({ agent: owner }), /主人输入隔离/)
  const cold = { id: 'cold', session: { id: 'cold', header: { parentSession: 'offline-owner', origin: 'subagent', agentPreset: 'custom' } } }
  live.push(cold)
  for (const listener of listeners.get('agent/created') ?? []) await listener({ agent: cold })
  assert.match(execute('pwsh', cold), /Native Stardew/, 'actual serial Host creation hydrates cold persisted lineage')
  for (let attempt = 0; attempt < 100 && !registered.has('fish_task_start'); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(registered.has('fish_task_start'), true, 'the durable task service still initializes beside the independent guard')
  assert.match(execute('fish_task_start', owner, { toolName: 'pwsh', arguments: {} }), /Native Stardew/)
  assert.equal(execute('fish_task_start', owner, { toolName: 'mcp__stardew2__stardew_tool_task', arguments: {} }), undefined)
  for (const dispose of effects.splice(0).reverse()) await dispose()
  assert.equal(guards.length, 0)
  definitions.length = 0
  apply(ctx, { protectNativeCompanion: true })
  assert.equal(guards.length, 1)
  assert.match(execute('pwsh'), /Native Stardew/, 'explicit Host config protects cold startup when MCP publishes no tools')
  assert.equal(execute('pwsh', other), undefined)
  assert.match(execute('mcp__stardew2__stardew_run_script'), /Native Stardew/)
  assert.throws(() => apply(ctx, { protectNativeCompanion: 'true' }), /must be a boolean/)
  for (let attempt = 0; attempt < 100 && !registered.has('fish_task_start'); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(registered.has('fish_task_start'), true)
  console.log('native companion Host: synchronous guard, real persona, cold lineage, unrelated agents and managed tasks verified')
} finally {
  for (const dispose of effects.reverse()) await dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
}
assert.equal(guards.length, 0, 'Host disposal removes both policy guards')
