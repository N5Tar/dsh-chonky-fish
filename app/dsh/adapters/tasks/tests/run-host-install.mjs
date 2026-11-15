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
    return { results: [{ callId: calls[0].id, result: calls[0].name === 'fixture_error' ? { isError: true, error: { code: 'FIXTURE_FAILED', message: 'fixture failed' }, content: [] } : { content: [{ type: 'text', text: 'done' }] } }] }
  },
}
const ctx = { tools, agents: { get: id => id === agent.id ? agent : null } }
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
    },
  })
  assert.equal(ctx.tools.guardFn({ agent, name: 'mcp__stardew__stardew_get_state', arguments: {}, signal: new AbortController().signal }), undefined, 'Host registers the explicit MCP state read as foreground safe')
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
  await taskHost.close()
  taskHost = null
  assert.equal(registered.size, 0)
} finally { await taskHost?.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
console.log('task host install ok')
