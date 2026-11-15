import assert from 'node:assert/strict'
import { createPollingRequestAdapter, discoverPollingRequestProtocols, createPwshJobsAdapter, isKnownPhoneReadTool } from '../protocols.js'

const schema = properties => ({ type: 'object', properties })
const definitions = [
  { name: 'mcp__stardew__stardew_farm_task', parameters: schema({ operation: { type: 'string' }, requestId: { type: 'string' } }) },
  { name: 'mcp__stardew__stardew_task_status', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew__stardew_cancel_task', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew2__stardew_farm_task', parameters: schema({ operation: { type: 'string' }, requestId: { type: 'string' } }) },
  { name: 'mcp__stardew2__stardew_task_status', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew2__stardew_cancel_task', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew__stardew_session_start', parameters: schema({ mode: { type: 'string' }, requestId: { type: 'string' }, address: { type: 'string' } }) },
  { name: 'mcp__stardew__stardew_session_status', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew__stardew_session_cancel', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew__stardew_session_state', parameters: schema({}) },
  { name: 'mcp__stardew2__stardew_session_start', parameters: schema({ mode: { type: 'string' }, requestId: { type: 'string' }, address: { type: 'string' } }) },
  { name: 'mcp__stardew2__stardew_session_status', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew2__stardew_session_cancel', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew2__stardew_session_state', parameters: schema({}) },
  { name: 'mcp__stardew__stardew_tool_task', parameters: schema({ actionType: { type: 'string' }, requestId: { type: 'string' }, worldId: { type: 'string' }, actorId: { type: 'string' }, dateKey: { type: 'string' }, location: { type: 'string' }, tool: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }) },
  { name: 'mcp__stardew__stardew_tool_task_status', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew__stardew_cancel_tool_task', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew2__stardew_tool_task', parameters: schema({ actionType: { type: 'string' }, requestId: { type: 'string' }, worldId: { type: 'string' }, actorId: { type: 'string' }, dateKey: { type: 'string' }, location: { type: 'string' }, tool: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }) },
  { name: 'mcp__stardew2__stardew_tool_task_status', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew2__stardew_cancel_tool_task', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__untrusted__stardew_tool_task', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__untrusted__stardew_tool_task_status', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__untrusted__stardew_cancel_tool_task', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew__stardew_travel_task', parameters: schema({ requestId: { type: 'string' }, worldId: { type: 'string' }, actorId: { type: 'string' }, dateKey: { type: 'string' }, location: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, stopAtTime: { type: 'number' } }) },
  { name: 'mcp__stardew__stardew_travel_status', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew__stardew_travel_cancel', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew2__stardew_travel_task', parameters: schema({ requestId: { type: 'string' }, worldId: { type: 'string' }, actorId: { type: 'string' }, dateKey: { type: 'string' }, location: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, stopAtTime: { type: 'number' } }) },
  { name: 'mcp__stardew2__stardew_travel_status', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__stardew2__stardew_travel_cancel', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__untrusted__stardew_travel_task', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__untrusted__stardew_travel_status', parameters: schema({ requestId: { type: 'string' } }) },
  { name: 'mcp__untrusted__stardew_travel_cancel', parameters: schema({ requestId: { type: 'string' } }) },
]
const protocols = discoverPollingRequestProtocols(definitions)
assert.equal(protocols.length, 8, 'only complete same-namespace start/status/cancel tool sets are admitted')
assert.equal(protocols[0].resourceKey, protocols[1].resourceKey, 'potential aliases share one conservative actor lock')
assert.equal(protocols[2].resourceKey, protocols[3].resourceKey, 'session aliases share one conservative session lock')
assert.equal(protocols[2].resourceKey, 'mcp:stardew-world:session')
assert.equal(protocols[4].resourceKey, 'mcp:stardew-world:task', 'native tools and farm jobs share one actor lock')
assert.equal(protocols[5].resourceKey, 'mcp:stardew-world:task', 'native tools on the second alias share one actor lock')
assert.equal(protocols.some(item => item.serverName === 'untrusted' && item.id === 'stardew-native-tool-v1'), false, 'explicit notApplied receipts are trusted only from Stardew bridge aliases')
assert.deepEqual(protocols.slice(6).map(item => item.id), ['stardew-native-travel-v1', 'stardew-native-travel-v1'])
assert.equal(protocols[6].resourceKey, 'mcp:stardew-world:task', 'native walking shares the conservative local-player task lock')
assert.equal(protocols[7].resourceKey, 'mcp:stardew-world:task', 'native walking on the second alias shares the same task lock')
assert.equal(protocols.some(item => item.serverName === 'untrusted' && item.id === 'stardew-native-travel-v1'), false, 'native travel lifecycle is restricted to the trusted game aliases')
assert.equal(discoverPollingRequestProtocols(definitions.filter(item => !item.name.endsWith('session_cancel'))).some(item => item.id === 'stardew-native-session-v1'), false, 'a partial session tool set does not activate the protocol')
assert.equal(discoverPollingRequestProtocols(definitions.filter(item => !item.name.endsWith('cancel_tool_task'))).some(item => item.id === 'stardew-native-tool-v1'), false, 'a partial native tool lifecycle does not activate the protocol')
assert.equal(discoverPollingRequestProtocols(definitions.filter(item => !item.name.endsWith('travel_cancel'))).some(item => item.id === 'stardew-native-travel-v1'), false, 'a partial travel lifecycle does not activate the protocol')
assert.equal(isKnownPhoneReadTool('mcp__stardew__stardew_get_state'), true)
assert.equal(isKnownPhoneReadTool('mcp__stardew__stardew_session_state'), true)
assert.equal(isKnownPhoneReadTool('mcp__stardew2__stardew_session_status'), true)
assert.equal(isKnownPhoneReadTool('mcp__untrusted__stardew_session_state'), false, 'another MCP server cannot borrow the trusted session read names')
assert.equal(isKnownPhoneReadTool('mcp__stardew2__stardew_get_state'), true, 'the explicitly supported second Stardew alias remains foreground safe')
assert.equal(isKnownPhoneReadTool('mcp__untrusted__stardew_get_state'), false, 'another MCP server cannot borrow a safe raw tool name')
assert.equal(isKnownPhoneReadTool('mcp__stardew__stardew_tool_task_status'), true, 'native task status is an allowlisted read for the trusted game server')
assert.equal(isKnownPhoneReadTool('mcp__stardew2__stardew_tool_task_status'), true, 'native task status is available on the explicitly supported alias')
assert.equal(isKnownPhoneReadTool('mcp__untrusted__stardew_tool_task_status'), false, 'another MCP server cannot borrow native task status trust')
assert.equal(isKnownPhoneReadTool('mcp__stardew__stardew_tool_task'), false, 'native task submission is never a phone read tool')
assert.equal(isKnownPhoneReadTool('mcp__stardew__stardew_travel_status'), true, 'native travel status remains an allowlisted phone read')
assert.equal(isKnownPhoneReadTool('mcp__stardew2__stardew_travel_status'), true, 'native travel status is available on the supported alias')
assert.equal(isKnownPhoneReadTool('mcp__untrusted__stardew_travel_status'), false, 'another MCP server cannot borrow native travel status trust')
assert.equal(isKnownPhoneReadTool('mcp__stardew__stardew_travel_task'), false, 'native travel submission stays managed by the lifecycle adapter')

const signals = new WeakSet()
const seen = []
const states = [{ state: 'stale' }, { state: 'no_state' }, { state: 'unacknowledged' }, { state: 'running', progress: 1 }, { state: 'completed', task: { status: 'completed' } }]
const tools = {
  async resolve({ signal }) { return { dispose() {} } },
  async execute({ calls, signal }) {
    seen.push(calls[0])
    const value = calls[0].name.endsWith('farm_task') ? { content: [{ type: 'text', text: JSON.stringify({ status: 'queued', requestId: JSON.parse(calls[0].arguments).requestId }) }] }
      : calls[0].name.endsWith('task_status') ? { content: [{ type: 'text', text: JSON.stringify(states.shift()) }] }
        : { content: [{ type: 'text', text: JSON.stringify({ status: 'queued' }) }] }
    return { results: [{ callId: calls[0].id, result: { value } }] }
  },
}
const agent = { id: 'session-a', model: { current: () => ({ model: 'fixture' }) } }
const adapter = createPollingRequestAdapter({ tools, definitionsFor: () => definitions, trustedSignals: signals, pollIntervalMs: 1 })
const args = { operation: 'water', x: 1, y: 2, width: 1, height: 1 }
assert.deepEqual(adapter.deriveResources('mcp__stardew__stardew_farm_task', args, { owner: { conversationId: agent.id } }), ['mcp:stardew-world:task'])
const started = await adapter.execute({ taskId: 'task-a', operationId: 'host-operation-id', owner: { conversationId: agent.id }, command: { name: 'mcp__stardew__stardew_farm_task', args }, agent, signal: new AbortController().signal })
assert.equal(started.externalHandle, started.result.requestId)
assert.equal(JSON.parse(seen[0].arguments).requestId, started.externalHandle, 'stable external id is passed before dispatch')
const final = await adapter.watch({ taskId: 'task-a', operationId: 'host-operation-id', owner: { conversationId: agent.id }, command: { name: 'mcp__stardew__stardew_farm_task', args }, externalHandle: started.externalHandle, agent, signal: new AbortController().signal })
assert.equal(final.status, 'completed', 'stale state remains nonterminal until a terminal poll')
assert.equal(seen.length, 6, 'stale, no_state and unacknowledged all remain nonterminal')
states.push({ state: 'unacknowledged' })
const recovered = await adapter.recover({ operationId: 'host-operation-id', task: { command: { name: 'mcp__stardew__stardew_farm_task' } }, owner: { conversationId: agent.id }, agent, signal: new AbortController().signal })
assert.equal(recovered, null, 'a missing acknowledgement is not terminal and does not cause automatic restart')
assert.equal(seen.filter(call => call.name.endsWith('farm_task')).length, 1, 'recovery queries the original id and never replays start')
assert.equal((await adapter.cancel({ operationId: 'cancel-op', owner: { conversationId: agent.id }, command: { name: 'mcp__stardew__stardew_farm_task' }, externalHandle: started.externalHandle, agent, signal: new AbortController().signal })).pending, true)

const sessionStatus = [
  { state: 'current', result: { status: 'ready' } },
  { state: 'current', result: { status: 'queued' } },
  { state: 'current', result: { status: 'queued' } },
  { state: 'current', result: { status: 'running' } },
  { state: 'current', result: { status: 'completed', phase: 'ready' } },
]
const sessionCalls = []
const sessionTools = {
  async resolve() { return { dispose() {} } },
  async execute({ calls }) {
    sessionCalls.push(calls[0])
    const args = JSON.parse(calls[0].arguments)
    const value = calls[0].name.endsWith('session_start') ? { status: 'queued', requestId: args.requestId }
      : calls[0].name.endsWith('session_status') ? sessionStatus.shift()
        : { status: 'queued', requestId: args.requestId }
    return { results: [{ callId: calls[0].id, result: { value } }] }
  },
}
const sessionAdapter = createPollingRequestAdapter({ tools: sessionTools, definitionsFor: () => definitions, pollIntervalMs: 1 })
const sessionCommand = { name: 'mcp__stardew2__stardew_session_start', args: { mode: 'join_lan', address: 'localhost' } }
const sessionStart = await sessionAdapter.execute({ operationId: 'host-session-op', command: sessionCommand, agent, signal: new AbortController().signal })
assert.equal(sessionStart.externalHandle, sessionStart.result.requestId, 'session start confirms the Host-derived request id')
assert.equal(JSON.parse(sessionCalls[0].arguments).mode, 'join_lan', 'session arguments pass through with the Host-derived request id')
const sessionRecovery = await sessionAdapter.recover({ operationId: 'host-session-op', task: { command: sessionCommand }, agent, signal: new AbortController().signal })
assert.equal(sessionRecovery, null, 'an outer current snapshot with result.status ready is not an accepted lifecycle state')
const queuedRecovery = await sessionAdapter.recover({ operationId: 'host-session-op', task: { command: sessionCommand }, agent, signal: new AbortController().signal })
assert.equal(queuedRecovery.status, 'running', 'nested queued session status is recovered as active despite the outer current envelope')
assert.equal(sessionCalls.filter(call => call.name.endsWith('session_start')).length, 1, 'session recovery never replays start')
const sessionFinal = await sessionAdapter.watch({ operationId: 'host-session-op', command: sessionCommand, externalHandle: sessionStart.externalHandle, agent, signal: new AbortController().signal })
assert.equal(sessionFinal.status, 'completed', 'the nested session result status maps to the actual terminal state')
assert.equal(sessionCalls.filter(call => call.name.endsWith('session_status')).length, 5, 'current and ready remain nonterminal while queued and running are polled')

const travelStatuses = ['queued', 'walking_to_exit', 'waiting_for_transition', 'completed'].map(status => ({ state: status, receipt: { status } }))
const travelCalls = []
const travelTools = {
  async resolve() { return { dispose() {} } },
  async execute({ calls }) {
    travelCalls.push(calls[0])
    const args = JSON.parse(calls[0].arguments)
    const value = calls[0].name.endsWith('stardew_travel_task') ? { status: 'queued', requestId: args.requestId }
      : calls[0].name.endsWith('stardew_travel_status') ? travelStatuses.shift()
        : { status: 'queued', requestId: args.requestId }
    return { results: [{ callId: calls[0].id, result: { value } }] }
  },
}
const travelAdapter = createPollingRequestAdapter({ tools: travelTools, definitionsFor: () => definitions, pollIntervalMs: 1 })
const travelCommand = { name: 'mcp__stardew2__stardew_travel_task', args: { worldId: 'world-1', actorId: 'actor-1', dateKey: '1|spring|3', location: 'Farm', x: 4, y: 8, stopAtTime: 2300 } }
assert.deepEqual(travelAdapter.deriveResources(travelCommand.name, travelCommand.args, { owner: { conversationId: agent.id } }), ['mcp:stardew-world:task'])
const travelStart = await travelAdapter.execute({ operationId: 'host-travel-op', command: travelCommand, agent, signal: new AbortController().signal })
assert.equal(travelStart.externalHandle, travelStart.result.requestId, 'native travel start confirms the Host request ID')
assert.equal((await travelAdapter.cancel({ operationId: 'host-travel-cancel', command: travelCommand, externalHandle: travelStart.externalHandle, agent, signal: new AbortController().signal })).pending, true, 'a travel cancel queue receipt remains pending until settled')
const travelFinal = await travelAdapter.watch({ operationId: 'host-travel-op', command: travelCommand, externalHandle: travelStart.externalHandle, agent, signal: new AbortController().signal })
assert.equal(travelFinal.status, 'completed', 'the state/receipt travel envelope completes only at observed arrival')
assert.equal(travelCalls.filter(call => call.name.endsWith('stardew_travel_status')).length, 4, 'queued and transition phases remain nonterminal')
travelStatuses.push({ state: 'settling_movement', receipt: { status: 'settling_movement' } })
const travelRecovery = await travelAdapter.recover({ operationId: 'host-travel-op', task: { command: travelCommand }, agent, signal: new AbortController().signal })
assert.equal(travelRecovery.status, 'running', 'native walking settlement is recovered as an active managed action')
for (const terminalState of ['failed', 'cancelled', 'rejected', 'interrupted']) {
  const terminalTravel = createPollingRequestAdapter({
    tools: { async resolve() { return { dispose() {} } }, async execute({ calls }) { return { results: [{ callId: calls[0].id, result: { value: { state: terminalState, receipt: { status: terminalState } } } }] } } },
    definitionsFor: () => definitions,
  })
  const mapped = ['rejected', 'interrupted'].includes(terminalState) ? 'failed' : terminalState
  assert.equal((await terminalTravel.watch({ operationId: `host-travel-${terminalState}`, command: travelCommand, externalHandle: 'travel-terminal-id', agent, signal: new AbortController().signal })).status, mapped, `native ${terminalState} maps to the expected settled task outcome`)
}

const nativeStatuses = [
  { status: 'queued', receipt: { effectVerified: false } },
  { status: 'running', receipt: { effectVerified: false } },
  { status: 'settling', receipt: { effectVerified: false } },
  { status: 'completed', receipt: { effectVerified: true } },
]
const nativeCalls = []
const nativeTools = {
  async resolve() { return { dispose() {} } },
  async execute({ calls }) {
    nativeCalls.push(calls[0])
    const args = JSON.parse(calls[0].arguments)
    const value = calls[0].name.endsWith('stardew_tool_task') ? { status: 'queued', requestId: args.requestId }
      : calls[0].name.endsWith('stardew_tool_task_status') ? nativeStatuses.shift()
        : { status: 'cancel_queued', requestId: args.requestId }
    return { results: [{ callId: calls[0].id, result: { value } }] }
  },
}
const nativeAdapter = createPollingRequestAdapter({ tools: nativeTools, definitionsFor: () => definitions, pollIntervalMs: 1 })
const nativeCommand = { name: 'mcp__stardew__stardew_tool_task', args: { tool: 'axe', x: 4, y: 8, worldId: 'world-1', actorId: 'actor-1', dateKey: 'year|spring|day', location: 'Farm' } }
assert.deepEqual(nativeAdapter.deriveResources(nativeCommand.name, nativeCommand.args, { owner: { conversationId: agent.id } }), ['mcp:stardew-world:task'])
const nativeStart = await nativeAdapter.execute({ operationId: 'host-native-op', command: nativeCommand, agent, signal: new AbortController().signal })
assert.equal(nativeStart.externalHandle, nativeStart.result.requestId, 'native tool submit confirms its Host-derived request id')
assert.deepEqual(JSON.parse(nativeCalls[0].arguments), { ...nativeCommand.args, requestId: nativeStart.externalHandle }, 'the adapter sends only native tool schema arguments with its Host request ID')
assert.equal((await nativeAdapter.cancel({ operationId: 'host-native-cancel', command: nativeCommand, externalHandle: nativeStart.externalHandle, agent, signal: new AbortController().signal })).pending, true, 'queued cancellation remains pending until a terminal native receipt arrives')
const nativeFinal = await nativeAdapter.watch({ operationId: 'host-native-op', command: nativeCommand, externalHandle: nativeStart.externalHandle, agent, signal: new AbortController().signal })
assert.equal(nativeFinal.status, 'completed', 'effect verified native receipt completes after queued, running, and settling')
assert.equal(nativeCalls.filter(call => call.name.endsWith('stardew_tool_task_status')).length, 4, 'queued, running, and settling remain nonterminal')
nativeStatuses.push({ status: 'settling', receipt: { effectVerified: false } })
const settlingRecovery = await nativeAdapter.recover({ operationId: 'host-native-op', task: { command: nativeCommand }, agent, signal: new AbortController().signal })
assert.equal(settlingRecovery.status, 'running', 'settling is recovered as an active native action')
const rejectedNativeAdapter = createPollingRequestAdapter({
  tools: { ...nativeTools, async execute({ calls }) { return { results: [{ callId: calls[0].id, result: { value: { status: 'rejected', receipt: { effectVerified: false } } } }] } } },
  definitionsFor: () => definitions, pollIntervalMs: 1,
})
assert.equal((await rejectedNativeAdapter.watch({ operationId: 'host-native-rejected', command: nativeCommand, externalHandle: 'native-rejected-id', agent, signal: new AbortController().signal })).status, 'failed', 'native rejected confirms a no-effect failure')

const explicitNativeRejection = createPollingRequestAdapter({
  tools: { async resolve() { return { dispose() {} } }, async execute({ calls }) {
    const requestId = JSON.parse(calls[0].arguments).requestId
    return { results: [{ callId: calls[0].id, result: { value: { status: 'rejected', requestId, notApplied: true, detail: 'stale world scope' } } }] }
  } }, definitionsFor: () => definitions,
})
const nativeNotApplied = await explicitNativeRejection.execute({ operationId: 'host-native-preflight', command: nativeCommand, agent, signal: new AbortController().signal }).catch(error => error)
assert.equal(nativeNotApplied.taskOutcome?.notApplied, true, 'only the explicit request-ID-bound rejected receipt proves the start was not applied')
const explicitSessionRejection = createPollingRequestAdapter({
  tools: { async resolve() { return { dispose() {} } }, async execute({ calls }) {
    const requestId = JSON.parse(calls[0].arguments).requestId
    return { results: [{ callId: calls[0].id, result: { value: { status: 'rejected', requestId, notApplied: true, detail: 'no eligible save' } } }] }
  } }, definitionsFor: () => definitions,
})
const sessionNotApplied = await explicitSessionRejection.execute({ operationId: 'host-session-preflight', command: sessionCommand, agent, signal: new AbortController().signal }).catch(error => error)
assert.equal(sessionNotApplied.taskOutcome?.notApplied, true, 'session preflight receipt also proves the Host operation was not applied')
const sessionRejectedRecovery = await explicitSessionRejection.recover({ operationId: 'host-session-preflight', task: { command: sessionCommand }, agent, signal: new AbortController().signal })
assert.equal(sessionRejectedRecovery.status, 'failed', 'a persisted explicit session rejection recovers as terminal failure')
const ambiguousNative = createPollingRequestAdapter({
  tools: { async resolve() { return { dispose() {} } }, async execute() { throw new Error('transport timeout after possible send') } },
  definitionsFor: () => definitions,
})
const ambiguousNativeFailure = await ambiguousNative.execute({ operationId: 'host-native-timeout', command: nativeCommand, agent, signal: new AbortController().signal }).catch(error => error)
assert.equal(ambiguousNativeFailure.taskOutcome, undefined, 'a post-dispatch transport timeout remains ambiguous')
const genericMcpError = createPollingRequestAdapter({
  tools: { async resolve() { return { dispose() {} } }, async execute({ calls }) { return { results: [{ callId: calls[0].id, result: { isError: true, content: [{ type: 'text', text: 'Error: MCP rejected the request' }] } }] } } },
  definitionsFor: () => definitions,
})
const genericMcpFailure = await genericMcpError.execute({ operationId: 'host-native-mcp-error', command: nativeCommand, agent, signal: new AbortController().signal }).catch(error => error)
assert.equal(genericMcpFailure.taskOutcome, undefined, 'generic MCP isError without the explicit rejection receipt is not proof that dispatch did not occur')

const unknownNativeAdapter = createPollingRequestAdapter({
  tools: { ...nativeTools, async execute({ calls }) {
    nativeCalls.push(calls[0])
    const value = calls[0].name.endsWith('stardew_tool_task_status')
      ? { status: 'unknown', receipt: { effectVerified: false } }
      : { status: 'completed', receipt: { effectVerified: false } }
    return { results: [{ callId: calls[0].id, result: { value } }] }
  } }, definitionsFor: () => definitions, pollIntervalMs: 1,
})
const unknownNative = await unknownNativeAdapter.watch({ operationId: 'host-native-unknown', command: nativeCommand, externalHandle: 'native-unknown-id', agent, signal: new AbortController().signal })
assert.equal(unknownNative.status, 'outcome-unknown', 'native unknown status never becomes success or cancellation')
const unverifiedNative = await unknownNativeAdapter.watch({ operationId: 'host-native-unverified', command: nativeCommand, externalHandle: 'native-unverified-id', agent, signal: new AbortController().signal })
assert.equal(unverifiedNative.status, 'outcome-unknown', 'a completed native status without effect verification is not success')

let jobStatus = 'running'
let jobKilled = false
const jobs = {
  list: () => [{ id: 'job-1', owner: 'session-a', status: jobStatus, toolCall: { callId: 'op-pwsh' } }],
  get: id => ({ id, owner: 'session-a', status: jobStatus }),
  async wait() {},
  kill() { jobKilled = true; return 'requested' },
}
const pwshCalls = []
const pwshTools = {
  async resolve() { return { dispose() {} } },
  async execute({ calls }) { pwshCalls.push(calls[0]); return { results: [{ callId: calls[0].id, result: { value: { kind: 'background', jobId: 'job-1' } } }] } },
}
const pwsh = createPwshJobsAdapter({ tools: pwshTools, jobs, trustedSignals: new WeakSet(), pollIntervalMs: 1 })
const shell = await pwsh.execute({ taskId: 'task-p', operationId: 'op-pwsh', owner: { conversationId: 'session-a' }, command: { name: 'pwsh', args: { command: 'Start-Sleep 2', description: 'wait', run_in_background: false } }, agent, signal: new AbortController().signal })
assert.equal(JSON.parse(pwshCalls[0].arguments).run_in_background, true)
assert.equal(pwshCalls[0].id, 'op-pwsh', 'the persisted host operation id is the DSH job correlation identity')
assert.equal((await pwsh.recover({ task: { operationId: 'op-pwsh', owner: { conversationId: 'session-a' } }, operationId: 'op-pwsh', owner: { conversationId: 'session-a' } })).externalHandle, 'job-1')
assert.equal((await pwsh.cancel({ owner: { conversationId: 'session-a' }, externalHandle: shell.externalHandle })).pending, true)
assert.equal(jobKilled, true)
jobStatus = 'killed'
assert.equal((await pwsh.watch({ owner: { conversationId: 'session-a' }, externalHandle: shell.externalHandle, signal: new AbortController().signal })).status, 'cancelled')
const preflightPwsh = createPwshJobsAdapter({
  tools: { async resolve() { throw new Error('tool resolution failed') }, async execute() { throw new Error('must not execute') } }, jobs, trustedSignals: new WeakSet(),
})
const preflightFailure = await preflightPwsh.execute({ operationId: 'op-preflight', owner: { conversationId: 'session-a' }, command: { name: 'pwsh', args: {} }, agent, signal: new AbortController().signal }).catch(error => error)
assert.equal(preflightFailure.taskOutcome?.notApplied, true, 'protocol adapter proves a resolve failure happened before dispatch')
let protocolDispatches = 0
const protocolPreflight = createPollingRequestAdapter({
  tools: { async resolve() { return { dispose() {} } }, async execute() { protocolDispatches++; throw new Error('must not dispatch') } },
  definitionsFor: () => definitions,
})
const requestIdConflict = await protocolPreflight.execute({ operationId: 'op-conflict', command: { name: 'mcp__stardew__stardew_farm_task', args: { requestId: 'caller-chosen' } }, agent, signal: new AbortController().signal }).catch(error => error)
assert.equal(requestIdConflict.taskOutcome?.notApplied, true, 'request identity conflict is rejected before dispatch')
const cyclicProtocolArgs = {}; cyclicProtocolArgs.self = cyclicProtocolArgs
const protocolSerializationFailure = await protocolPreflight.execute({ operationId: 'op-cyclic', command: { name: 'mcp__stardew__stardew_farm_task', args: cyclicProtocolArgs }, agent, signal: new AbortController().signal }).catch(error => error)
assert.equal(protocolSerializationFailure.taskOutcome?.notApplied, true, 'MCP argument serialization failure is rejected before dispatch')
const protocolLookupFailure = createPollingRequestAdapter({ tools: protocolPreflight.tools, definitionsFor: () => [] })
const lookupFailure = await protocolLookupFailure.execute({ operationId: 'op-no-protocol', command: { name: 'mcp__missing__stardew_farm_task', args: {} }, agent, signal: new AbortController().signal }).catch(error => error)
assert.equal(lookupFailure.taskOutcome?.notApplied, true, 'missing protocol lookup is rejected before dispatch')
assert.equal(protocolDispatches, 0, 'all protocol preflight failures occur before tools.execute starts')
console.log('task protocols ok')
