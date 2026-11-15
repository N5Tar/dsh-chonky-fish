import assert from 'node:assert/strict'
import { createDshToolAdapter, createTaskToolGuard, resolveSourceInputId } from '../host.js'

const trustedSignals = new WeakSet()
let resolved, executed, disposed = 0
const toolSet = { dispose() { disposed++ } }
const ctxTools = {
  async resolve(input) { resolved = input; return toolSet },
  async execute(input) { executed = input; return { results: [{ callId: input.calls[0].id, result: { content: [{ type: 'text', text: 'accepted request-1' }] } }] } },
  guard(value) { this.registeredGuard = value; return () => {} },
}
const capability = { completionScope: 'tool-invocation', deriveResources: args => [`file:${args.path}`] }
const adapter = createDshToolAdapter({ tools: ctxTools, allowedTools: { fixture_write: capability }, trustedSignals })
const agent = { id: 'conversation-a', model: { current: () => ({ provider: 'test', model: 'test' }) } }
const signal = new AbortController().signal
trustedSignals.add(signal)
const result = await adapter.execute({ taskId: 'task-1', command: { name: 'fixture_write', args: { path: 'shared.txt' } }, owner: { namespaceId: 'ns', conversationId: agent.id }, agent, signal })
assert.equal(result.completionScope, 'tool-invocation')
assert.deepEqual(adapter.deriveResources('fixture_write', { path: 'shared.txt' }), ['file:shared.txt'])
assert.equal(resolved.agent, agent)
assert.equal(resolved.modelSelection.provider, 'test')
assert.equal(resolved.signal, signal)
assert.deepEqual(executed.calls, [{ id: 'task-1:call:1', name: 'fixture_write', arguments: JSON.stringify({ path: 'shared.txt' }) }])
assert.equal(executed.signal, signal)
assert.equal(executed.toolSet, toolSet)
assert.equal(disposed, 1)
assert.equal(await adapter.execute({ taskId: 'task-2', command: { name: 'native_async', args: {} }, agent, signal }).catch(error => error.code), 'TOOL_NOT_ALLOWED')
const preflightAdapter = createDshToolAdapter({
  tools: { async resolve() { throw new Error('tool set could not be resolved') }, async execute() { throw new Error('must not dispatch') } },
  allowedTools: { fixture_write: capability },
})
const preflightFailure = await preflightAdapter.execute({ taskId: 'preflight', operationId: 'preflight-op', command: { name: 'fixture_write', args: {} }, agent, signal }).catch(error => error)
assert.equal(preflightFailure.taskOutcome?.notApplied, true, 'failure before pipeline dispatch is classified as definitely not applied')
const dispatchAdapter = createDshToolAdapter({
  tools: { async resolve() { return { dispose() {} } }, async execute() { throw new Error('transport closed after possible dispatch') } },
  allowedTools: { fixture_write: capability },
})
const dispatchFailure = await dispatchAdapter.execute({ taskId: 'dispatch', operationId: 'dispatch-op', command: { name: 'fixture_write', args: {} }, agent, signal }).catch(error => error)
assert.equal(dispatchFailure.taskOutcome, undefined, 'pipeline exceptions after execute begins remain ambiguous')
const returnedFailure = createDshToolAdapter({
  tools: { async resolve() { return { dispose() {} } }, async execute(input) { return { results: [{ callId: input.calls[0].id, result: { isError: true, error: { message: 'finished with error' } } }] } } },
  allowedTools: { fixture_write: capability },
})
const terminalFailure = await returnedFailure.execute({ taskId: 'returned-error', command: { name: 'fixture_write', args: {} }, agent, signal }).catch(error => error)
assert.deepEqual(terminalFailure.taskOutcome, { status: 'failed', authoritative: true }, 'a returned synchronous tool error is an authoritative invocation terminal')

const guard = createTaskToolGuard({ isPhoneActive: () => true, trustedSignals })
assert.match(guard({ agent, signal: new AbortController().signal, name: 'job_output', arguments: { wait: true } }), /fish_task_start/)
assert.equal(guard({ agent, signal, name: 'job_output', arguments: { wait: true } }), undefined, 'only host-owned task signals bypass the foreground long-wait guard')
assert.match(guard({ agent, signal: new AbortController().signal, name: 'unknown_tool', arguments: {} }), /not approved/)
assert.match(guard({ agent, signal: new AbortController().signal, name: 'job_output', arguments: { wait: false } }), /not approved/, 'direct guard defaults to fail closed without Host read capabilities')
const foregroundGuard = createTaskToolGuard({ isPhoneActive: () => true, trustedSignals, foregroundSafeTool: exec => exec.name === 'job_list' || (exec.name === 'job_output' && exec.arguments?.wait === false) || exec.name === 'mcp__stardew__stardew_get_state' })
assert.equal(foregroundGuard({ agent, signal: new AbortController().signal, name: 'job_list', arguments: {} }), undefined)
assert.equal(foregroundGuard({ agent, signal: new AbortController().signal, name: 'job_output', arguments: { wait: false } }), undefined)
assert.match(foregroundGuard({ agent, signal: new AbortController().signal, name: 'job_output', arguments: {} }), /not approved/, 'job_output is safe only when wait:false is explicit')
assert.match(foregroundGuard({ agent, signal: new AbortController().signal, name: 'mcp__stardew__stardew_get_state', arguments: { timeout_ms: 30000 } }), /fish_task_start/, 'snake_case long timeout is blocked even for a read tool')
assert.equal(foregroundGuard({ agent, signal: new AbortController().signal, name: 'mcp__stardew__stardew_get_state', arguments: {} }), undefined)
assert.match(foregroundGuard({ agent, signal: new AbortController().signal, name: 'mcp__stardew__stardew_get_everything', arguments: {} }), /not approved/, 'arbitrary get-like tools are not admitted')
const safeGuard = createTaskToolGuard({ isPhoneActive: () => true, trustedSignals, toolCapabilities: { quick_read: { foregroundSafe: true } } })
assert.equal(safeGuard({ agent, signal: new AbortController().signal, name: 'quick_read', arguments: {} }), undefined)
const sourceAgent = { id: 'conversation-a', phase: { turn: 2, step: 1 }, session: { snapshotEvents: () => [
  { type: 'user/message', data: { id: 'user-9', source: { kind: 'user', rpcId: 'input-9' } } },
  { type: 'assistant/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'runtime' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'call-7' }] } } },
] } }
assert.equal(resolveSourceInputId(sourceAgent, { callId: 'call-7' }), 'input-9')
sourceAgent.session.snapshotEvents = () => [
  { type: 'user/message', data: { id: 'user-old', source: { kind: 'user', rpcId: 'input-old' } } },
  { type: 'user/message', data: { id: 'social-1', source: { kind: 'social' } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'call-7' }] } } },
]
assert.equal(resolveSourceInputId(sourceAgent, { callId: 'call-7' }), null, 'cannot borrow an older owner input across a nearer external message')
console.log('task host adapter ok')
