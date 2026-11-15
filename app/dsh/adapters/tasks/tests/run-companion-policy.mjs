import assert from 'node:assert/strict'
import { createDshToolAdapter, createTaskToolGuard } from '../host.js'

const implementation = await import('../companion-policy.js').catch(() => null)
assert.equal(typeof implementation?.createNativeCompanionPolicy, 'function', 'Host must provide an executable native-companion capability policy')
const { createNativeCompanionPolicy } = implementation
const lifecycle = (server = 'stardew2') => [
  'stardew_session_start', 'stardew_session_status', 'stardew_session_cancel',
  'stardew_tool_task', 'stardew_tool_task_status', 'stardew_cancel_tool_task',
  'stardew_travel_task', 'stardew_travel_status', 'stardew_travel_cancel',
].map(raw => ({ name: `mcp__${server}__${raw}`, parameters: { type: 'object', properties: { requestId: { type: 'string' } } } }))

const owner = { id: 'owner', session: { header: { agentPreset: 'chonkyfish' } } }
const child = { id: 'child', session: { header: { agentPreset: 'custom' } } }
const grandchild = { id: 'grandchild', session: { header: { agentPreset: 'custom' } } }
const resumed = { id: 'resumed', session: { header: { parentSession: 'owner', origin: 'subagent' } } }
const other = { id: 'other', session: { header: { agentPreset: 'other' } } }
let live = [owner, child, grandchild, resumed, other]
const parent = new Map([[child, owner], [grandchild, child]])
let definitions = lifecycle()
const agents = { get: id => live.find(agent => agent.id === id), list: () => live, isOwnedBy: (id, candidate) => parent.get(agents.get(id)) === candidate }
const create = () => createNativeCompanionPolicy({ agents, isOwnerAgent: agent => agent === owner, definitionsFor: () => definitions })
const policy = create()
const call = (name, args = {}, agent = owner, signal = new AbortController().signal) => ({ agent, name, arguments: args, signal })
const denied = exec => assert.match(policy.guard(exec), /native|原生/, `must block ${exec.name}`)
const allowed = exec => assert.equal(policy.guard(exec), undefined, `must allow ${exec.name}`)

// The observed focus-stealing path and opaque equivalents are denied before execution,
// even when the shell body contains no recognizable Windows API or game name.
for (const [name, args] of [
  ['pwsh', { command: 'SetForegroundWindow; ShowWindow; keybd_event' }],
  ['pwsh', { command: '& C:/temp/helper.ps1' }],
  ['pwsh', { command: 'Get-Date' }],
  ['bash', { command: 'python helper.py' }],
  ['run_code', { code: 'return tools.pwsh({ command: encoded })' }],
  ['terminal_send', { text: 'arbitrary helper' }],
  ['write', { path: 'actions/injected.json', content: '{}' }],
  ['edit', { path: 'bridge-config.json' }],
  ['mcp__desktop__click', { x: 1, y: 1 }],
  ['future_code_executor', {}],
]) denied(call(name, args))

for (const name of ['read', 'read_image', 'glob', 'grep', 'web_search', 'todo_write', 'job_list', 'fish_task_list', 'fish_task_inspect', 'fish_task_cancel', 'fish_skill', 'diary', 'perception_get_owner_state']) allowed(call(name))
allowed(call('job_output', { wait: false }))
denied(call('job_output', { wait: true }))
denied(call('job_output'))
for (const name of ['stardew_get_state', 'stardew_tool_task', 'stardew_travel_task', 'stardew_menu_action', 'stardew_shop_buy']) allowed(call(`mcp__stardew2__${name}`))
allowed(call('mcp__stardew2__stardew_session_start', { mode: 'join_lan', address: 'localhost' }))
denied(call('mcp__stardew2__stardew_session_start', { mode: 'host_existing_save', saveName: 'primary' }))
denied(call('mcp__stardew2__stardew_session_start', {}))
allowed(call('mcp__stardew__stardew_get_state'))
denied(call('mcp__stardew__stardew_tool_task'))
denied(call('mcp__stardew__stardew_session_start'))
denied(call('mcp__untrusted__stardew_get_state'))
denied(call('mcp__stardew2__stardew_run_script'))
denied(call('mcp__stardew2__stardew_self_warp'))

allowed(call('fish_task_start', { toolName: 'mcp__stardew2__stardew_tool_task', arguments: {} }))
allowed(call('fish_task_start', { adapter: 'mcp-polling', toolName: 'mcp__stardew2__stardew_travel_task', arguments: {} }))
allowed(call('fish_task_start', { toolName: 'mcp__stardew2__stardew_session_start', arguments: { mode: 'join_lan', address: 'localhost' } }))
denied(call('fish_task_start', { toolName: 'mcp__stardew2__stardew_session_start', arguments: { mode: 'host_existing_save' } }))
denied(call('fish_task_start', { toolName: 'pwsh', arguments: { command: 'helper' } }))
denied(call('fish_task_start', { adapter: 'untrusted-custom', toolName: 'mcp__stardew2__stardew_tool_task', arguments: {} }))
denied(call('fish_task_start', { toolName: 'fish_task_start', arguments: { toolName: 'pwsh' } }))
// Task adapter trust must never bypass this independent capability boundary.
denied(call('pwsh', { command: 'helper' }, owner, new AbortController().signal))
for (const agent of [child, grandchild, resumed]) denied(call('pwsh', { command: 'helper' }, agent))
allowed(call('pwsh', { command: 'helper' }, other))
assert.match(policy.prompt({ agent: owner }), /stardew2/)
assert.match(policy.prompt({ agent: grandchild }), /原生/)
assert.equal(policy.prompt({ agent: other }), '')

// Protection persists for admitted descendants across parent teardown and transient
// MCP disappearance; a reconnect must not reopen shell execution.
policy.observeAgent(child)
definitions = []
live = [child, other]
denied(call('pwsh', {}, child))
denied(call('pwsh', {}, owner))
const compactedOwner = { id: owner.id, session: { header: { agentPreset: 'chonkyfish' } } }
assert.match(policy.guard(call('pwsh', {}, compactedOwner)), /native|原生/, 'compaction and Agent replacement preserve the same conversation protection')

// An unrelated ChonkyFish conversation without the trusted companion family keeps
// general tools. Similar names, incomplete schemas, and other aliases do not opt in.
live = [owner]
for (const candidate of [[], lifecycle('untrusted'), lifecycle('stardew'), lifecycle().slice(1), lifecycle().map(item => ({ ...item, parameters: {} }))]) {
  definitions = candidate
  const ordinary = create()
  assert.equal(ordinary.guard(call('pwsh', { command: 'Get-Date' })), undefined)
  assert.equal(ordinary.prompt({ agent: owner }), '')
}
definitions = lifecycle()
const fresh = create()
assert.match(fresh.guard(call('pwsh', { command: 'Get-Date' })), /native|原生/, 'shell-first calls cannot bypass configured companionship')

const samePresetChild = { id: 'same-preset-child', session: { header: { agentPreset: 'chonkyfish' } } }
live = [owner, samePresetChild]
parent.set(samePresetChild, owner)
const inherited = createNativeCompanionPolicy({
  agents, isOwnerAgent: agent => agent.session.header.agentPreset === 'chonkyfish',
  definitionsFor: agent => agent === owner ? lifecycle() : [],
})
assert.match(inherited.guard(call('pwsh', {}, samePresetChild)), /native|原生/, 'an inherited owner preset must not hide the protected runtime parent')

const historyOwner = { id: 'history-owner', session: { header: {}, snapshotEvents: () => [{
  type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'mcp__stardew2__stardew_get_state' }] } },
}] } }
const historical = createNativeCompanionPolicy({ agents, isOwnerAgent: agent => agent === historyOwner, definitionsFor: () => { throw new Error('MCP reconnecting') } })
assert.match(historical.guard(call('pwsh', {}, historyOwner)), /native|原生/, 'persisted native calls close the MCP reconnect window')
const managedHistoryOwner = { id: 'managed-history-owner', session: { header: {}, snapshotEvents: () => [{
  type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'fish_task_start', arguments: JSON.stringify({ toolName: 'mcp__stardew2__stardew_tool_task', arguments: {} }) }] } },
}] } }
const managedHistorical = createNativeCompanionPolicy({ agents, isOwnerAgent: agent => agent === managedHistoryOwner, definitionsFor: () => [] })
assert.match(managedHistorical.guard(call('pwsh', {}, managedHistoryOwner)), /native|原生/, 'durable managed native calls also preserve protection while MCP is offline')

// Exercise the existing background adapter with the same trusted signal that
// bypasses phone policy. The independent game guard must still block dispatch.
definitions = lifecycle()
live = [owner]
const adapterPolicy = create()
const trustedSignals = new WeakSet()
const phoneGuard = createTaskToolGuard({ isPhoneActive: () => true, trustedSignals })
const bodies = []
const pipeline = {
  async resolve() { return { dispose() {} } },
  async execute({ calls, agent, signal }) {
    return { results: calls.map(toolCall => {
      const exec = { agent, signal, name: toolCall.name, arguments: JSON.parse(toolCall.arguments) }
      const reason = phoneGuard(exec) ?? adapterPolicy.guard(exec)
      if (reason) return { callId: toolCall.id, result: { isError: true, error: { message: reason } } }
      bodies.push(toolCall.name)
      return { callId: toolCall.id, result: { value: { accepted: true } } }
    }) }
  },
}
const nativeName = 'mcp__stardew2__stardew_tool_task'
const adapter = createDshToolAdapter({ tools: pipeline, trustedSignals, allowedTools: {
  pwsh: { completionScope: 'tool-invocation' },
  [nativeName]: { completionScope: 'tool-invocation' },
} })
const execute = name => adapter.execute({ taskId: name, operationId: name, owner: { conversationId: owner.id }, command: { name, args: {} }, agent: owner, signal: new AbortController().signal })
await assert.rejects(execute('pwsh'), /Native Stardew/)
await execute(nativeName)
assert.deepEqual(bodies, [nativeName], 'only the native game body executes under background-task trust')

// Cold restored subagents need their durable parent even when no parent Agent
// is live. DSH awaits agent/created handlers before publishing a runnable Agent.
const coldChild = { id: 'cold-child', session: { header: { parentSession: 'cold-owner', origin: 'subagent', agentPreset: 'custom' } } }
const coldAgents = { list: () => [coldChild], get: () => undefined, isOwnedBy: () => false }
let releaseHeader
const cold = createNativeCompanionPolicy({
  agents: coldAgents,
  isOwnerAgent: agent => agent.session.header.agentPreset === 'chonkyfish',
  definitionsFor: () => lifecycle(),
  getSessionHeader: () => new Promise(resolve => { releaseHeader = resolve }),
})
const hydration = cold.observeAgent(coldChild)
assert.match(cold.guard(call('pwsh', {}, coldChild)), /native|原生/, 'unsafe work fails closed while cold ancestry is unresolved')
await Promise.resolve()
releaseHeader({ id: 'cold-owner', agentPreset: 'chonkyfish' })
await hydration
assert.match(cold.guard(call('pwsh', {}, coldChild)), /native|原生/, 'cold durable owner lineage stays protected after hydration')

const ordinaryColdChild = { id: 'ordinary-cold-child', session: { header: { parentSession: 'ordinary-parent', origin: 'subagent', agentPreset: 'custom' } } }
const ordinaryCold = createNativeCompanionPolicy({
  agents: { list: () => [ordinaryColdChild], get: () => undefined, isOwnedBy: () => false },
  isOwnerAgent: agent => agent.session.header.agentPreset === 'chonkyfish',
  definitionsFor: () => lifecycle(),
  getSessionHeader: async () => ({ id: 'ordinary-parent', agentPreset: 'other' }),
})
await ordinaryCold.observeAgent(ordinaryColdChild)
assert.equal(ordinaryCold.guard(call('pwsh', {}, ordinaryColdChild)), undefined, 'resolved unrelated cold ancestry retains general tools')
const configuredProtection = createNativeCompanionPolicy({ agents, isOwnerAgent: agent => agent === owner,
  definitionsFor: () => [], protectNativeCompanion: true,
})
assert.match(configuredProtection.guard(call('pwsh', {}, owner)), /native|原生/, 'explicit companion configuration protects a fresh owner even if MCP startup failed')
assert.equal(configuredProtection.guard(call('pwsh', {}, other)), undefined, 'explicit companion configuration still scopes to owner lineage')
assert.match(configuredProtection.guard(call('mcp__stardew2__stardew_run_script', {}, owner)), /native|原生/)
const cyclicChild = { id: 'cyclic', session: { header: { parentSession: 'cyclic', origin: 'subagent' } } }
const cyclicPolicy = createNativeCompanionPolicy({ agents: { get: () => cyclicChild }, isOwnerAgent: () => false,
  definitionsFor: () => [], protectNativeCompanion: true,
})
assert.match(cyclicPolicy.guard(call('pwsh', {}, cyclicChild)), /native|原生/, 'cyclic cold lineage is unresolved and cannot reopen unsafe tools')
console.log('native companion policy: shell-first, opaque execution, tasks, lineage, and native routes verified')
