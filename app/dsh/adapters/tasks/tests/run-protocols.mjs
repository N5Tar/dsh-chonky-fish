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
]
const protocols = discoverPollingRequestProtocols(definitions)
assert.equal(protocols.length, 2, 'only complete same-namespace start/status/cancel tool sets are admitted')
assert.equal(protocols[0].resourceKey, protocols[1].resourceKey, 'potential aliases share one conservative actor lock')
assert.equal(isKnownPhoneReadTool('mcp__stardew__stardew_get_state'), true)
assert.equal(isKnownPhoneReadTool('mcp__stardew2__stardew_get_state'), true, 'the explicitly supported second Stardew alias remains foreground safe')
assert.equal(isKnownPhoneReadTool('mcp__untrusted__stardew_get_state'), false, 'another MCP server cannot borrow a safe raw tool name')

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
