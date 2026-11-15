import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installManagedTasks } from '../host.js'

const directory = mkdtempSync(join(tmpdir(), 'chonkyfish-task-host-'))
let activeCallId = 'model-call-a'
const agent = {
  id: 'session-a',
  session: { id: 'session-a', snapshotEvents: () => [
    { type: 'user/message', data: { id: 'user-a', source: { kind: 'user', rpcId: 'input-a' } } },
    { type: 'assistant/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'runtime' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: activeCallId }] } } },
  ] },
  model: { current: () => ({ model: 'fixture' }) },
}
const registered = new Map()
const trustedSignalCalls = []
const externalWatchResolvers = []
const externalCancelInputs = []
const tools = {
  guard(fn) { this.guardFn = fn; return () => {} },
  register(definition, options) { registered.set(definition.name, { definition, options }); return () => registered.delete(definition.name) },
  async resolve({ agent: actualAgent, modelSelection, signal }) {
    assert.equal(actualAgent, agent); assert.equal(modelSelection.model, 'fixture'); assert.equal(signal.aborted, false)
    return { dispose() { trustedSignalCalls.push('disposed') } }
  },
  async execute({ calls, agent: actualAgent, signal, toolSet }) {
    assert.equal(actualAgent, agent); assert.equal(typeof calls[0].id, 'string'); assert.equal(signal.aborted, false); assert.ok(toolSet)
    trustedSignalCalls.push(signal)
    const result = calls[0].name === 'fixture_error' ? { isError: true, error: { code: 'FIXTURE_FAILED', message: 'fixture failed' }, content: [] }
      : calls[0].name === 'fixture_external' ? { value: { externalHandle: 'fixture-job-1' } }
        : { content: [{ type: 'text', text: 'done' }] }
    return { results: [{ callId: calls[0].id, result }] }
  },
}
const jobsService = { list: () => [] }
const ctx = {
  tools,
  agents: { get: id => id === agent.id ? agent : null },
  get(name) { return name === 'jobs' ? jobsService : undefined },
  get jobs() { throw new Error('cannot get property "jobs" without inject') },
}
const events = []
let taskHost
try {
  taskHost = await installManagedTasks(ctx, {
    resources: { paths: { tasks: join(directory, 'tasks.db') }, limits: { taskMaxList: 20 } },
    isOwnerAgent: value => value === agent,
    isPhoneActive: () => true,
    onEvent: async event => { events.push(event); return { acknowledged: true } },
    toolCapabilities: {
      fixture: { completionScope: 'tool-invocation', deriveResources: args => [`fixture:${args.target}`] },
      fixture_error: { completionScope: 'tool-invocation', deriveResources: args => [`fixture:${args.target}`] },
      fixture_external: {
        completionScope: 'external-task', deriveResources: args => [`fixture-external:${args.target}`],
        extractExternalHandle: value => value.externalHandle,
        async watch({ signal }) { return new Promise(resolve => { externalWatchResolvers.push(resolve); signal.addEventListener('abort', () => resolve({ status: 'outcome-unknown' }), { once: true }) }) },
        async cancel(input) { externalCancelInputs.push(input); return { pending: true } },
        async recover() { return { status: 'running', completionScope: 'external-task', externalHandle: 'fixture-job-1' } },
      },
    },
  })
  assert.equal(ctx.tools.guardFn({ agent, name: 'mcp__stardew__stardew_get_state', arguments: {}, signal: new AbortController().signal }), undefined, 'Host registers the explicit MCP state read as foreground safe')
  assert.match(ctx.tools.guardFn({ agent, name: 'mcp__untrusted__stardew_get_state', arguments: {}, signal: new AbortController().signal }), /not approved/, 'an untrusted MCP server cannot borrow the known safe tool name')
  assert.equal(ctx.tools.guardFn({ agent, name: 'job_list', arguments: {}, signal: new AbortController().signal }), undefined, 'Host permits bounded job listing')
  assert.equal(ctx.tools.guardFn({ agent, name: 'job_output', arguments: { wait: false }, signal: new AbortController().signal }), undefined, 'Host permits nonblocking output reads')
  assert.match(ctx.tools.guardFn({ agent, name: 'job_output', arguments: { wait: true }, signal: new AbortController().signal }), /fish_task_start/)
  assert.match(ctx.tools.guardFn({ agent, name: 'mcp__stardew__stardew_get_everything', arguments: {}, signal: new AbortController().signal }), /not approved/)
  for (const name of ['fish_task_start', 'fish_task_list', 'fish_task_inspect', 'fish_task_cancel']) assert.ok(registered.has(name), `${name} is callable and registered`)
  assert.equal(registered.get('fish_task_start').options.when({ agent }), true)
  const start = await registered.get('fish_task_start').definition.execute({ toolName: 'fixture', arguments: { target: 'shared' } }, { agent, callId: 'model-call-a' })
  assert.equal(start.ok, true)
  assert.equal(start.task.status, 'accepted')
  for (let attempts = 0; attempts < 20; attempts++) {
    const status = taskHost.service.inspect({ owner: { namespaceId: taskHost.namespaceId, conversationId: agent.id }, taskId: start.task.taskId })?.status
    if (status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const owner = { namespaceId: taskHost.namespaceId, conversationId: agent.id }
  const task = taskHost.service.inspect({ owner, taskId: start.task.taskId })
  assert.equal(task.status, 'completed')
  const inspectTool = registered.get('fish_task_inspect').definition
  const firstEventPage = await inspectTool.execute({ taskId: start.task.taskId, limit: 1 }, { agent, callId: 'inspect-call-a' })
  assert.equal(firstEventPage.events.length, 1, 'fish_task_inspect forwards its bounded event page size')
  const followingEventPage = await inspectTool.execute({ taskId: start.task.taskId, afterVersion: firstEventPage.events[0].version, limit: 1 }, { agent, callId: 'inspect-call-b' })
  assert.ok(followingEventPage.events.every(event => event.version > firstEventPage.events[0].version), 'fish_task_inspect exposes the last event version as the continuation cursor')
  assert.equal(task.sourceInputId, 'input-a')
  assert.equal(events.some(event => event.source?.kind === 'chonkyfish-task-notice' && event.source.sourceInputId === 'input-a'), true)
  assert.ok(trustedSignalCalls.some(value => value instanceof AbortSignal), 'the nested pipeline receives an independent task signal')
  activeCallId = 'model-call-b'
  const failure = await registered.get('fish_task_start').definition.execute({ toolName: 'fixture_error', arguments: { target: 'error' } }, { agent, callId: 'model-call-b' })
  assert.equal(failure.ok, true)
  for (let attempts = 0; attempts < 20; attempts++) {
    const failed = taskHost.service.inspect({ owner, taskId: failure.task.taskId })?.status
    if (failed === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.equal(taskHost.service.inspect({ owner, taskId: failure.task.taskId }).status, 'failed', 'DSH tool error becomes a failed task')

  activeCallId = 'model-call-external'
  const startExternal = await registered.get('fish_task_start').definition.execute({ toolName: 'fixture_external', arguments: { target: 'shared' } }, { agent, callId: activeCallId })
  assert.equal(startExternal.ok, true)
  for (let attempts = 0; attempts < 20 && externalWatchResolvers.length === 0; attempts++) await new Promise(resolve => setTimeout(resolve, 1))
  let externalTask = taskHost.service.inspect({ owner, taskId: startExternal.task.taskId })
  assert.equal(externalTask.status, 'running', 'Host-declared external tasks remain running until their observer reports a terminal result')
  assert.equal(externalTask.completionScope, 'external-task')
  await assert.rejects(taskHost.service.start({ owner: { ...owner, conversationId: 'other-session' }, operationId: 'op-external-busy', adapter: 'dsh-tool', command: { name: 'fixture_external', args: { target: 'shared' } }, sourceInputId: 'input-other' }), { code: 'RESOURCE_BUSY' }, 'an observed external task retains its resource lock')
  const stopReceipt = await registered.get('fish_task_cancel').definition.execute({ taskId: externalTask.id, expectedVersion: externalTask.version }, { agent, callId: 'cancel-external' })
  assert.equal(stopReceipt.task.status, 'stopping')
  for (let attempts = 0; attempts < 20 && externalCancelInputs.length === 0; attempts++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(externalCancelInputs[0]?.externalHandle, 'fixture-job-1', 'Host cancellation receives the confirmed external handle')
  assert.equal(externalCancelInputs[0]?.operationId, `${owner.namespaceId}:${owner.conversationId}:cancel:cancel-external`)
  await taskHost.close()
  taskHost = null
  assert.equal(registered.size, 0)

  taskHost = await installManagedTasks(ctx, {
    resources: { paths: { tasks: join(directory, 'tasks.db') }, limits: { taskMaxList: 20 } },
    isOwnerAgent: value => value === agent,
    isPhoneActive: () => true,
    onEvent: async event => { events.push(event); return { acknowledged: true } },
    toolCapabilities: {
      fixture: { completionScope: 'tool-invocation', deriveResources: args => [`fixture:${args.target}`] },
      fixture_error: { completionScope: 'tool-invocation', deriveResources: args => [`fixture:${args.target}`] },
      fixture_external: {
        completionScope: 'external-task', deriveResources: args => [`fixture-external:${args.target}`],
        extractExternalHandle: value => value.externalHandle,
        async watch({ signal }) { return new Promise(resolve => { externalWatchResolvers.push(resolve); signal.addEventListener('abort', () => resolve({ status: 'outcome-unknown' }), { once: true }) }) },
        async cancel(input) { externalCancelInputs.push(input); return { pending: true } },
        async recover() { return { status: 'running', completionScope: 'external-task', externalHandle: 'fixture-job-1' } },
      },
    },
  })
  for (let attempts = 0; attempts < 20 && externalCancelInputs.length < 2; attempts++) await new Promise(resolve => setTimeout(resolve, 1))
  externalTask = taskHost.service.inspect({ owner, taskId: startExternal.task.taskId })
  assert.equal(externalTask.status, 'stopping', 'restart resumes the persisted stop state instead of replaying start')
  assert.equal(externalCancelInputs.length, 2, 'restart resumes the same idempotent external cancellation request')
  assert.equal(externalCancelInputs[1].operationId, externalCancelInputs[0].operationId)
  assert.equal(externalCancelInputs[1].externalHandle, 'fixture-job-1')
  const recoveredWatcher = externalWatchResolvers.at(-1)
  recoveredWatcher({ status: 'cancelled' })
  for (let attempts = 0; attempts < 20 && taskHost.service.inspect({ owner, taskId: externalTask.id }).status !== 'cancelled'; attempts++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(taskHost.service.inspect({ owner, taskId: externalTask.id }).status, 'cancelled')
  await taskHost.close()
  taskHost = null
  assert.equal(registered.size, 0)
} finally { await taskHost?.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
console.log('task host install ok')
