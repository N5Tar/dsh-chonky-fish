import { createHash } from 'node:crypto'

const TERMINAL = new Map([['completed', 'completed'], ['failed', 'failed'], ['cancelled', 'cancelled']])
const PUBLIC_PREFIX = /^mcp__(.+)__([^_].+)$/
const PHONE_READ_MCP_TOOLS = new Set([
  'stardew_get_state', 'stardew_get_surroundings', 'stardew_get_inventory', 'stardew_get_companion_state',
  'stardew_self_state', 'stardew_interaction_status', 'stardew_menu_state', 'stardew_social_state',
  'stardew_fishing_state', 'stardew_shop_state', 'stardew_travel_state', 'stardew_self_surroundings', 'stardew_self_inventory',
  'stardew_task_status', 'stardew_fishing_status', 'stardew_social_status', 'stardew_shop_status', 'stardew_travel_status',
])
function notApplied(cause) {
  const failure = cause instanceof Error ? cause : new Error(String(cause?.message ?? cause))
  failure.taskOutcome ??= { notApplied: true }
  return failure
}
export const DEFAULT_MCP_TASK_PROTOCOLS = Object.freeze([Object.freeze({
  id: 'stardew-request-task-v1', startRawName: 'stardew_farm_task', statusRawName: 'stardew_task_status', cancelRawName: 'stardew_cancel_task', requestIdProperty: 'requestId', resourceKey: 'mcp:stardew-world:task',
})])

function parseToolName(name) {
  const match = PUBLIC_PREFIX.exec(name || '')
  return match ? { serverName: match[1], rawName: match[2] } : null
}
export function isKnownPhoneReadTool(name) {
  const identity = parseToolName(name)
  return Boolean(identity && PHONE_READ_MCP_TOOLS.has(identity.rawName))
}
function hasRequestId(definition) {
  const property = definition?.parameters?.properties?.requestId
  return property?.type === 'string'
}
function decodeValue(value) {
  if (value?.structuredContent && typeof value.structuredContent === 'object') return value.structuredContent
  for (const block of value?.content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    try { return JSON.parse(block.text) } catch {}
  }
  return value
}
function resultValue(batch, callId) {
  const outcome = batch?.results?.find(item => item.callId === callId)?.result
  if (!outcome) throw Object.assign(new Error('DSH pipeline returned no task tool outcome'), { code: 'TASK_TOOL_RESULT_MISSING' })
  if (outcome.isError) throw Object.assign(new Error(outcome.error?.message ?? 'DSH task tool failed'), { code: outcome.error?.code ?? 'TASK_TOOL_FAILED' })
  return outcome.value
}
function abortableDelay(ms, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done() { signal.removeEventListener('abort', abort); resolve() }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('aborted')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
async function invokeTool({ tools, agent, signal, trustedSignals, name, args, callId }) {
  if (!agent || !signal || typeof tools?.resolve !== 'function' || typeof tools?.execute !== 'function') throw notApplied(Object.assign(new Error('DSH pipeline unavailable'), { code: 'TASK_EXECUTOR_UNAVAILABLE' }))
  trustedSignals.add(signal)
  let toolSet
  try { toolSet = await tools.resolve({ agent, modelSelection: agent.model?.current?.(), signal }) }
  catch (cause) { throw notApplied(cause) }
  try {
    try { signal.throwIfAborted?.() } catch (cause) { throw notApplied(cause) }
    const batch = await tools.execute({ calls: [{ id: callId, name, arguments: JSON.stringify(args) }], agent, signal, toolSet })
    return resultValue(batch, callId)
  } finally { toolSet?.dispose?.() }
}

/** Discover one server's task request protocol only when all three registered tools agree. */
export function discoverPollingRequestProtocols(definitions, { resourceKey = 'mcp:request-task:shared', descriptors = DEFAULT_MCP_TASK_PROTOCOLS } = {}) {
  const byName = new Map((definitions ?? []).map(definition => [definition.name, definition]))
  const found = []
  for (const descriptor of descriptors) {
    for (const definition of definitions ?? []) {
      const identity = parseToolName(definition.name)
      if (!identity || identity.rawName !== descriptor.startRawName) continue
      const prefix = `mcp__${identity.serverName}__`
      const startName = `${prefix}${descriptor.startRawName}`
      const statusName = `${prefix}${descriptor.statusRawName}`
      const cancelName = `${prefix}${descriptor.cancelRawName}`
      const start = byName.get(startName), status = byName.get(statusName), cancel = byName.get(cancelName)
      if (!start || !status || !cancel || !hasRequestId(start) || !hasRequestId(status) || !hasRequestId(cancel)) continue
      found.push({ ...descriptor, serverName: identity.serverName, startName, statusName, cancelName, resourceKey: typeof descriptor.resourceKey === 'string' ? descriptor.resourceKey : resourceKey })
    }
  }
  return found
}

const externalRequestId = operationId => createHash('sha256').update(`chonkyfish-managed-task\0${operationId}`).digest('hex')

/** Generic MCP requestId/status/cancel adapter. Nonterminal stale/no_state/unacknowledged states never release its resource. */
export function createPollingRequestAdapter({ tools, definitionsFor, trustedSignals = new WeakSet(), pollIntervalMs = 1000, descriptors = DEFAULT_MCP_TASK_PROTOCOLS } = {}) {
  const descriptorFor = (name, context = {}) => discoverPollingRequestProtocols(definitionsFor?.(context.agent) ?? [], { descriptors }).find(item => item.startName === name)
  const keyFor = (context, name) => descriptorFor(name, context) ?? (() => { throw Object.assign(new Error('No complete MCP task lifecycle tool set is registered for this server'), { code: 'MCP_TASK_PROTOCOL_UNAVAILABLE' }) })()
  const idFor = operationId => externalRequestId(operationId)
  async function status(descriptor, input, requestId, suffix) {
    const value = await invokeTool({ tools, agent: input.agent, signal: input.signal, trustedSignals, name: descriptor.statusName, args: { [descriptor.requestIdProperty]: requestId }, callId: `${requestId}:${suffix}` })
    return decodeValue(value)
  }
  function mapTerminal(data) {
    const state = data?.state ?? data?.status
    return TERMINAL.get(state)
  }
  return {
    completionScope: 'external-task',
    deriveResources(name, args, context) { return [keyFor({ ...context, command: { name, args } }, name).resourceKey] },
    async execute(input) {
      const descriptor = keyFor(input, input.command?.name)
      const requestId = idFor(input.operationId)
      if (input.command.args?.[descriptor.requestIdProperty] && input.command.args[descriptor.requestIdProperty] !== requestId) throw Object.assign(new Error('External request identity is Host managed'), { code: 'REQUEST_ID_CONFLICT' })
      const args = { ...input.command.args, [descriptor.requestIdProperty]: requestId }
      const value = await invokeTool({ tools, agent: input.agent, signal: input.signal, trustedSignals, name: descriptor.startName, args, callId: input.operationId })
      const receipt = decodeValue(value)
      if (receipt?.[descriptor.requestIdProperty] !== requestId) throw Object.assign(new Error('MCP start receipt did not confirm the Host request id'), { code: 'REQUEST_ID_NOT_CONFIRMED' })
      return { completionScope: 'external-task', externalHandle: requestId, result: receipt }
    },
    async watch(input) {
      const descriptor = keyFor(input, input.command?.name)
      let last
      for (;;) {
        input.signal.throwIfAborted?.()
        const data = await status(descriptor, input, input.externalHandle, `status:${Date.now()}`)
        const terminal = mapTerminal(data)
        if (terminal) return { status: terminal, result: data, summary: `external MCP request ${terminal}` }
        const snapshot = data?.task ?? data?.result ?? data
        const encoded = JSON.stringify(snapshot)
        if (encoded !== last) { last = encoded; input.onProgress?.(snapshot) }
        await abortableDelay(pollIntervalMs, input.signal)
      }
    },
    async cancel(input) {
      const descriptor = keyFor(input, input.command?.name)
      const value = await invokeTool({ tools, agent: input.agent, signal: input.signal, trustedSignals, name: descriptor.cancelName, args: { [descriptor.requestIdProperty]: input.externalHandle }, callId: `${input.operationId}:cancel` })
      const receipt = decodeValue(value)
      const terminal = mapTerminal(receipt)
      return terminal === 'cancelled' ? { stopped: true } : { pending: true, receipt }
    },
    async recover(input) {
      const descriptor = keyFor(input, input.task.command?.name)
      const requestId = idFor(input.operationId)
      const data = await status(descriptor, input, requestId, `recover:${Date.now()}`)
      const terminal = mapTerminal(data)
      if (terminal) return { status: terminal, completionScope: 'external-task', externalHandle: requestId, result: data }
      const state = data?.state ?? data?.status
      if (['running', 'queued', 'stopping', 'partial'].includes(state)) return { status: 'running', completionScope: 'external-task', externalHandle: requestId, result: data }
      return null
    },
  }
}

/** DSH pwsh + ctx.jobs adapter. It starts through tools.execute, then observes/cancels the native job registry. */
export function createPwshJobsAdapter({ tools, jobs, trustedSignals = new WeakSet(), pollIntervalMs = 500 } = {}) {
  const jobFor = (id, owner) => jobs?.get?.(id, owner)
  const terminal = status => status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'killed' ? 'cancelled' : null
  return {
    completionScope: 'external-task',
    deriveResources() { return ['dsh:pwsh:shared-processes'] },
    async execute(input) {
      const value = await invokeTool({
        tools, agent: input.agent, signal: input.signal, trustedSignals,
        name: 'pwsh', callId: input.operationId,
        args: { ...input.command.args, run_in_background: true },
      })
      if (!['background', 'promoted'].includes(value?.kind) || typeof value.jobId !== 'string') throw Object.assign(new Error('pwsh did not return a DSH job handle'), { code: 'PWSh_JOB_HANDLE_MISSING' })
      return { completionScope: 'external-task', externalHandle: value.jobId, result: value }
    },
    async watch(input) {
      for (;;) {
        input.signal.throwIfAborted?.()
        const job = jobFor(input.externalHandle, input.owner.conversationId)
        if (!job) return { status: 'outcome-unknown', summary: 'DSH job registry no longer has this job' }
        const status = terminal(job.status)
        if (status) return { status, result: job, summary: `terminal DSH job status: ${job.status}` }
        input.onProgress?.({ status: job.status, progress: job.progress ?? job.detail })
        await jobs.wait(input.externalHandle, pollIntervalMs, input.owner.conversationId, input.signal)
      }
    },
    async cancel(input) {
      const result = jobs.kill(input.externalHandle, input.owner.conversationId, 'managed task cancellation requested')
      const job = jobFor(input.externalHandle, input.owner.conversationId)
      if (job?.status === 'killed') return { stopped: true }
      if (result === 'requested' || job?.status === 'running' || job?.status === 'stopping') return { pending: true }
      return { stopped: false }
    },
    async recover(input) {
      const jobsForOwner = jobs?.list?.(input.owner.conversationId) ?? []
      const job = jobsForOwner.find(item => item.owner === input.owner.conversationId && item.toolCall?.callId === input.operationId)
      if (!job) return null
      const status = terminal(job.status)
      if (status) return { status, completionScope: 'external-task', externalHandle: job.id, result: job, summary: `recovered terminal DSH job status: ${job.status}` }
      if (job.status === 'running' || job.status === 'stopping') return { status: 'running', completionScope: 'external-task', externalHandle: job.id }
      return null
    },
  }
}

export function isManagedPwshAvailable(tools, agent, jobs) {
  const definition = tools?.get?.('pwsh', agent)
  return Boolean(jobs && definition?.parameters?.properties?.run_in_background)
}
