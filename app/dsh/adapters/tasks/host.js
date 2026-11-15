import { createPollingRequestAdapter, createPwshJobsAdapter, discoverPollingRequestProtocols, isKnownPhoneReadTool, isManagedPwshAvailable } from './protocols.js'

function notApplied(cause) {
  const failure = cause instanceof Error ? cause : new Error(String(cause?.message ?? cause))
  failure.taskOutcome ??= { notApplied: true }
  return failure
}

/** Adapt explicitly admitted DSH tool calls to the generic background-task contract. */
export function createDshToolAdapter({ tools, allowedTools = {}, getCapability, trustedSignals = new WeakSet() }) {
  let callSequence = 0
  const capability = (name, context = {}) => (allowedTools instanceof Map ? allowedTools.get(name) : allowedTools[name]) ?? getCapability?.(name, context)
  return {
    resolveCompletionScope(name, context = {}) {
      const entry = capability(name, context)
      if (!entry) return undefined
      if (!['tool-invocation', 'external-task'].includes(entry.completionScope)) throw notApplied(Object.assign(new Error('Task completion scope must be declared by the Host adapter'), { code: 'TASK_SCOPE_UNDECLARED' }))
      return entry.completionScope
    },
    deriveResources(name, args, context) {
      const entry = capability(name, context)
      if (!entry) throw notApplied(Object.assign(new Error('Tool is not registered for managed execution'), { code: 'TOOL_NOT_ALLOWED' }))
      return entry.deriveResources ? entry.deriveResources(args, context) : []
    },
    async execute({ taskId, operationId, owner, command, agent, signal }) {
      const entry = capability(command?.name, { owner, agent, command })
      if (!entry || command?.name.startsWith('fish_task_')) throw notApplied(Object.assign(new Error('Tool is not registered for managed execution'), { code: 'TOOL_NOT_ALLOWED' }))
      if (!['tool-invocation', 'external-task'].includes(entry.completionScope)) throw notApplied(Object.assign(new Error('Task completion scope must be declared by the Host adapter'), { code: 'TASK_SCOPE_UNDECLARED' }))
      if (!agent || !signal || typeof tools?.resolve !== 'function' || typeof tools?.execute !== 'function') throw notApplied(Object.assign(new Error('DSH tool executor unavailable'), { code: 'TASK_EXECUTOR_UNAVAILABLE' }))
      trustedSignals.add(signal)
      let toolSet
      try { toolSet = await tools.resolve({ agent, modelSelection: agent.model?.current?.(), signal }) }
      catch (cause) { throw notApplied(cause) }
      try {
        try { signal.throwIfAborted?.() } catch (cause) { throw notApplied(cause) }
        const callId = `${taskId}:call:${++callSequence}`
        let encodedArguments
        try {
          const args = entry.prepareArguments ? entry.prepareArguments(command.args ?? {}, { taskId, operationId, owner }) : command.args ?? {}
          encodedArguments = JSON.stringify(args)
        } catch (cause) { throw notApplied(cause) }
        const result = await tools.execute({
          calls: [{ id: callId, name: command.name, arguments: encodedArguments }],
          agent,
          signal,
          toolSet,
        })
        const outcome = result?.results?.find(item => item.callId === callId)?.result
        if (outcome?.isError === true) {
          const failure = Object.assign(new Error(outcome.error?.message ?? 'DSH tool invocation failed'), { code: outcome.error?.code ?? 'TOOL_INVOCATION_FAILED' })
          if (entry.completionScope === 'tool-invocation') failure.taskOutcome = { status: 'failed', authoritative: true }
          throw failure
        }
        if (entry.completionScope === 'external-task') {
          const externalHandle = entry.extractExternalHandle?.(outcome?.value, result)
          if (typeof externalHandle !== 'string' || !externalHandle) throw Object.assign(new Error('The tool did not return an authoritative external task handle'), { code: 'EXTERNAL_HANDLE_MISSING' })
          return { completionScope: 'external-task', externalHandle, result }
        }
        return { completionScope: 'tool-invocation', result }
      } finally { toolSet?.dispose?.() }
    },
    async watch(input) {
      const entry = capability(input.command?.name, input)
      if (typeof entry?.watch !== 'function') return { status: 'unknown', summary: 'registered external tool has no observer' }
      return entry.watch(input)
    },
    async cancel(input) {
      const entry = capability(input.command?.name, input)
      if (typeof entry?.cancel !== 'function') return { stopped: false }
      return entry.cancel(input)
    },
    async recover(input) {
      const entry = capability(input.task?.command?.name, input)
      return typeof entry?.recover === 'function' ? entry.recover(input) : null
    },
  }
}

function hasLongWait(args) {
  if (!args || typeof args !== 'object') return false
  if (args.wait === true || args.waitForCompletion === true || args.blockUntilComplete === true) return true
  for (const [key, value] of Object.entries(args)) {
    const normalized = key.replace(/[_-]/g, '').toLowerCase()
    if (/^(wait|waitfor|blockuntil|timeout|poll)(ms|seconds|timeoutms)?$/.test(normalized) && typeof value === 'number' && value >= 2000) return true
    if (value && typeof value === 'object' && hasLongWait(value)) return true
  }
  return false
}

/** Resolve an owned input by matching the actual DSH tool-call block in the event snapshot. */
export function resolveSourceInputId(agent, exec) {
  const snapshot = agent?.session?.snapshotEvents
  if (typeof snapshot !== 'function' || typeof exec?.callId !== 'string') return null
  let events
  try { events = snapshot.call(agent.session) } catch { return null }
  if (!Array.isArray(events)) return null
  const containsCall = data => [data?.message?.content, data?.message?.toolCalls, data?.content, data?.toolCalls].some(blocks => Array.isArray(blocks) && blocks.some(block =>
    block && (block.type === 'tool-call' || block.type === 'tool_call') && block.id === exec.callId))
  let callIndex = -1
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    const data = event?.data ?? event
    if ((event?.type === 'assistant/message' || data?.type === 'assistant/message') && containsCall(data)) { callIndex = index; break }
  }
  if (callIndex < 0) return null
  for (let index = callIndex - 1; index >= 0; index--) {
    const event = events[index]
    const data = event?.data ?? event
    if (event?.type !== 'user/message' && data?.type !== 'user/message') continue
    const source = data?.source
    if (source?.kind === 'user') return typeof source.rpcId === 'string' && source.rpcId || typeof data.id === 'string' && data.id || null
    if (source?.kind === 'chonkyfish-task-notice' && source.ownerConversationId === agent.id) return typeof source.sourceInputId === 'string' ? source.sourceInputId : null
    if (source?.kind === 'runtime-context' || source?.kind === 'time-context') continue
    // Never cross an intervening social, system, or other unowned message to borrow an old user input.
    return null
  }
  return null
}

/** Prevent foreground phone steps from using common long-wait tool arguments. */
export function createTaskToolGuard({ isPhoneActive = () => false, trustedSignals = new WeakSet(), toolCapabilities = {}, foregroundSafeTool = () => false } = {}) {
  return exec => {
    if (trustedSignals.has(exec.signal)) return undefined
    let active = false
    try { active = isPhoneActive(exec.agent) === true } catch { active = true }
    if (active && exec.name?.startsWith('fish_task_')) return undefined
    const capability = toolCapabilities instanceof Map ? toolCapabilities.get(exec.name) : toolCapabilities[exec.name]
    if (active && hasLongWait(exec.arguments)) return 'Use fish_task_start for long-running work and return to the conversation without waiting.'
    if (active && capability?.foregroundSafe !== true && foregroundSafeTool(exec) !== true) return 'This tool is not approved for foreground phone execution; use a registered fish_task adapter.'
    return undefined
  }
}

const output = {
  schema: {
    type: 'object', additionalProperties: true,
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/** Four managed task tools; task ownership is always taken from the executing Agent. */
export function createTaskTools(service, { getOwner, getSourceInputId, operationIdFor, resolveAdapter = () => 'dsh-tool', isAvailable = () => true }) {
  const execute = fn => async (args, exec) => {
    if (!isAvailable()) return { ok: false, error: { code: 'TASKS_UNAVAILABLE' } }
    try { return { ok: true, ...await fn(args ?? {}, exec) } }
    catch (cause) { return { ok: false, error: { code: cause?.code ?? 'TASK_FAILED', message: String(cause?.message ?? cause).slice(0, 300) } } }
  }
  const ownerFor = exec => {
    const owner = getOwner(exec.agent)
    if (!owner) throw Object.assign(new Error('This conversation cannot manage tasks'), { code: 'TASK_OWNER_UNAVAILABLE' })
    return owner
  }
  return [
    {
      name: 'fish_task_start',
      description: '在后台启动已登记的 DSH 工具任务。立即返回任务句柄，不等待执行完成。任务操作身份由 Host 生成；operationId 仅可用于核对已有任务，不可用来创建新任务。',
      parameters: { type: 'object', additionalProperties: false, properties: { adapter: { type: 'string', description: '可选：使用Host显式登记的外部任务适配器；缺省为 dsh-tool。' }, toolName: { type: 'string', description: 'dsh-tool适配器下的已登记工具名；外部适配器填写其登记命令名。' }, arguments: { type: 'object', additionalProperties: true }, operationId: { type: 'string', description: '可选：查找并核对已有操作，不能创建新操作。' } }, required: ['toolName', 'arguments'] },
      output,
      execute: execute(async (args, exec) => {
        const owner = ownerFor(exec)
        const sourceInputId = getSourceInputId(exec.agent, exec)
        if (typeof sourceInputId !== 'string' || !sourceInputId) throw Object.assign(new Error('The Host cannot identify the source input for this task'), { code: 'TASK_SOURCE_UNAVAILABLE' })
        const command = { name: args.toolName, args: args.arguments }
        const adapter = args.adapter || resolveAdapter(args.toolName, exec.agent) || 'dsh-tool'
        if (args.operationId) {
          const found = service.lookupOperation({ owner, operationId: args.operationId, adapter, command, sourceInputId })
          if (!found) throw Object.assign(new Error('Operation not found for this owner and input'), { code: 'OPERATION_NOT_FOUND' })
          return { task: found }
        }
        const operationId = operationIdFor(owner, exec)
        if (typeof operationId !== 'string' || !operationId) throw Object.assign(new Error('Host operation identity unavailable'), { code: 'OPERATION_ID_UNAVAILABLE' })
        return { task: await service.start({ owner, operationId, adapter, command, sourceInputId }) }
      }),
    },
    {
      name: 'fish_task_list',
      description: '列出当前会话拥有的后台任务。',
      parameters: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' } } }, output,
      execute: execute(async (args, exec) => ({ tasks: service.list({ owner: ownerFor(exec), limit: args.limit }) })),
    },
    {
      name: 'fish_task_inspect',
      description: '检查当前会话拥有的任务状态与版本；事件按版本分页，默认返回50条、最多100条。继续读取时把最后一条事件的version作为afterVersion。',
      parameters: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' }, afterVersion: { type: 'integer' }, limit: { type: 'integer' } }, required: ['taskId'] }, output,
      execute: execute(async (args, exec) => ({ task: service.inspect({ owner: ownerFor(exec), taskId: args.taskId }), events: service.observe({ owner: ownerFor(exec), taskId: args.taskId, afterVersion: args.afterVersion ?? 0, limit: args.limit }) })),
    },
    {
      name: 'fish_task_cancel',
      description: '按当前已检查的版本请求停止具体任务。只有适配器确认外部操作已停，任务才会标为 cancelled；否则保留未知状态及资源隔离。',
      parameters: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' }, expectedVersion: { type: 'integer' } }, required: ['taskId', 'expectedVersion'] }, output,
      execute: execute(async (args, exec) => ({ task: await service.cancel({ owner: ownerFor(exec), taskId: args.taskId, expectedVersion: args.expectedVersion, operationId: operationIdFor(ownerFor(exec), exec, 'cancel') }) })),
    },
  ]
}

/** Install the task ledger and the guarded, owner-scoped model tools in the DSH Host. */
export async function installManagedTasks(ctx, {
  resources,
  ready = Promise.resolve(),
  isOwnerAgent = () => false,
  isPhoneActive = () => false,
  getSourceInputId = resolveSourceInputId,
  onEvent = async () => ({ acknowledged: false }),
  toolCapabilities = {},
  adapters = {},
  pollingDescriptors,
  warn = () => {},
} = {}) {
  await ready
  const [{ DatabaseSync }, { createTaskRepository }, { createTaskService }] = await Promise.all([
    import('node:sqlite'),
    import('../../../shared/storage/tasks/sqlite.js'),
    import('../../../../core/modules/tasks/service.js'),
  ])
  const repository = createTaskRepository({ dbPath: resources.paths.tasks, DatabaseSync })
  const trustedSignals = new WeakSet()
  const service = createTaskService({ repository, onEvent, maxCommandBytes: resources.limits?.taskMaxCommandBytes, maxResources: resources.limits?.taskMaxResources, maxList: resources.limits?.taskMaxList })
  let jobs = null
  try { jobs = ctx.get?.('jobs') ?? null } catch {}
  if (!jobs) try { jobs = ctx.jobs ?? null } catch {}
  const dshAdapter = createDshToolAdapter({ tools: ctx.tools, allowedTools: toolCapabilities, trustedSignals })
  const bindAdapter = adapter => ({
    completionScope: adapter.completionScope,
    resolveCompletionScope: input => adapter.resolveCompletionScope?.({ ...input, agent: ctx.agents.get(input.owner.conversationId) }),
    deriveResources: (name, args, context) => adapter.deriveResources(name, args, { ...context, agent: ctx.agents.get(context.owner.conversationId) }),
    execute: input => adapter.execute({ ...input, agent: ctx.agents.get(input.owner.conversationId) }),
    watch: input => adapter.watch?.({ ...input, agent: ctx.agents.get(input.owner.conversationId) }),
    cancel: input => adapter.cancel?.({ ...input, agent: ctx.agents.get(input.owner.conversationId) }),
    recover: input => adapter.recover?.({ ...input, agent: ctx.agents.get(input.owner.conversationId) }),
  })
  service.registerAdapter('dsh-tool', {
    resolveCompletionScope: ({ owner, command }) => dshAdapter.resolveCompletionScope(command?.name, { owner, command, agent: ctx.agents.get(owner.conversationId) }),
    deriveResources: (name, args, context) => dshAdapter.deriveResources(name, args, { ...context, agent: ctx.agents.get(context.owner.conversationId) }),
    execute: input => dshAdapter.execute({ ...input, agent: ctx.agents.get(input.owner.conversationId) }),
    watch: input => dshAdapter.watch({ ...input, agent: ctx.agents.get(input.owner.conversationId) }),
    cancel: input => dshAdapter.cancel({ ...input, agent: ctx.agents.get(input.owner.conversationId) }),
    recover: input => dshAdapter.recover({ ...input, agent: ctx.agents.get(input.owner.conversationId) }),
  })
  const pollingAdapter = createPollingRequestAdapter({ tools: ctx.tools, descriptors: pollingDescriptors, definitionsFor: agent => {
    try { return ctx.tools.definitions(agent) } catch { return [] }
  }, trustedSignals })
  service.registerAdapter('mcp-polling', bindAdapter(pollingAdapter))
  if (jobs) service.registerAdapter('dsh-pwsh-job', bindAdapter(createPwshJobsAdapter({ tools: ctx.tools, jobs, trustedSignals })))
  for (const [name, adapter] of Object.entries(adapters)) service.registerAdapter(name, adapter)
  await service.recover()
  await service.deliverPending()
  const getOwner = agent => {
    if (!isOwnerAgent(agent)) return null
    const conversationId = agent?.id
    const sessionId = agent?.session?.sessionId ?? agent?.session?.id
    if (typeof conversationId !== 'string' || !conversationId || sessionId !== conversationId) return null
    return { namespaceId: repository.namespaceId(), conversationId }
  }
  const operationIdFor = (owner, exec, kind = 'start') => typeof exec?.callId === 'string' && exec.callId
    ? `${owner.namespaceId}:${owner.conversationId}:${kind}:${exec.callId}`
    : null
  const resolveAdapter = (toolName, agent) => {
    if (toolName === 'pwsh' && jobs && isManagedPwshAvailable(ctx.tools, agent, jobs)) return 'dsh-pwsh-job'
    let definitions = []
    try { definitions = ctx.tools.definitions(agent) } catch {}
    if (discoverPollingRequestProtocols(definitions, { descriptors: pollingDescriptors }).some(protocol => protocol.startName === toolName)) return 'mcp-polling'
    return 'dsh-tool'
  }
  const definitions = createTaskTools(service, {
    getOwner,
    getSourceInputId,
    operationIdFor,
    resolveAdapter,
    isAvailable: () => available,
  })
  let available = true
  const disposers = []
  try {
    if (typeof ctx.tools.guard !== 'function') throw new Error('DSH tools.guard() is required for phone-mode task safety')
    disposers.push(ctx.tools.guard(createTaskToolGuard({
      isPhoneActive,
      trustedSignals,
      toolCapabilities,
      foregroundSafeTool: exec => isKnownPhoneReadTool(exec.name)
        || exec.name === 'job_list'
        || (exec.name === 'job_output' && exec.arguments?.wait === false),
    })))
    for (const definition of definitions) {
      disposers.push(ctx.tools.register(definition, { when: ({ agent }) => isOwnerAgent(agent) }))
    }
  } catch (cause) {
    available = false
    for (const dispose of disposers.reverse()) try { dispose?.() } catch {}
    service.close().finally(() => repository.close())
    throw cause
  }
  return {
    service,
    registerAdapter: (name, adapter) => service.registerAdapter(name, adapter),
    async close() {
      if (!available) return
      available = false
      for (const dispose of disposers.reverse()) try { dispose?.() } catch {}
      await service.close()
      repository.close()
    },
    get namespaceId() { return repository.namespaceId() },
  }
}
