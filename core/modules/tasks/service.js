const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const COMPLETION_SCOPES = new Set(['tool-invocation', 'external-task'])
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value)
const jsonShape = value => { const encoded = JSON.stringify(value); return encoded === undefined ? null : JSON.parse(encoded) }
const equalOwner = (a, b) => a?.namespaceId === b?.namespaceId && a?.conversationId === b?.conversationId
const error = code => Object.assign(new Error(code), { code })

/** Pure task lifecycle coordinator. Persistence and external capabilities are injected. */
export function createTaskService({ repository, adapters = {}, onEvent = () => {}, now = Date.now, uuid = () => globalThis.crypto.randomUUID(), maxCommandBytes = 65536, maxResources = 32, maxList = 100, setTimeoutFn = globalThis.setTimeout, clearTimeoutFn = globalThis.clearTimeout }) {
  if (!repository) throw new TypeError('task repository required')
  let closed = false
  const controllers = new Map()
  const observers = new Set()
  const dispatching = new Set()
  const cancelControllers = new Map()
  const workers = new Set()
  const cancelReceipts = new Map()
  const pendingDeliveries = new Set()
  const inflightEvents = new Set()
  let retryTimer = null
  let retryDelayMs = 1000

  function scheduleRetry() {
    if (closed || retryTimer !== null || typeof repository.getPendingEvents !== 'function') return
    if (repository.getPendingEvents().length === 0) return
    const delay = retryDelayMs
    retryDelayMs = Math.min(60000, retryDelayMs * 2)
    retryTimer = setTimeoutFn(() => {
      retryTimer = null
      void Promise.resolve(api.deliverPending()).catch(() => scheduleRetry())
    }, delay)
    retryTimer?.unref?.()
  }

  async function deliver(event) {
    if (typeof repository.getPendingEvents !== 'function') return
    if (inflightEvents.has(event.eventId)) return
    inflightEvents.add(event.eventId)
    const delivery = Promise.resolve().then(() => onEvent({
      ...event,
      source: { kind: 'chonkyfish-task-notice', taskId: event.taskId, version: event.version, ownerConversationId: event.owner.conversationId, eventId: event.eventId, sourceInputId: event.sourceInputId },
    })).then(ack => {
      if (ack?.acknowledged === true) {
        repository.markEventDelivered?.(event.eventId)
        retryDelayMs = 1000
      } else scheduleRetry()
    }).catch(() => scheduleRetry()).finally(() => inflightEvents.delete(event.eventId))
    pendingDeliveries.add(delivery)
    await delivery
    pendingDeliveries.delete(delivery)
  }

  function owned(owner, taskId) {
    const task = repository.getTask(taskId)
    if (!task || !equalOwner(task.owner, owner)) return null
    return task
  }
  function publish(task, type, detail = {}) {
    const event = { eventId: `${task.id}:v${task.version}`, taskId: task.id, version: task.version, sourceInputId: task.sourceInputId, owner: task.owner, type, status: task.status, summary: detail.summary ?? task.summary ?? '', createdAt: now(), ...detail }
    void deliver(event)
    return event
  }
  function transition(task, status, patch = {}, type = status) {
    const changed = repository.updateTask(task.id, task.version, { ...patch, status }, type)
    if (!changed) return repository.getTask(task.id)
    publish(changed, type, { summary: changed.summary })
    return changed
  }
  async function observeExternal(task, adapter, handle, controller) {
    if (observers.has(task.id)) return
    observers.add(task.id)
    const progress = detail => {
      const latest = repository.getTask(task.id)
      if (!['running', 'stopping'].includes(latest?.status)) return
      let normalized
      try { normalized = jsonShape(detail) } catch { return }
      if (stable(latest.progress) !== stable(normalized)) transition(latest, latest.status, { progress: normalized, summary: typeof normalized === 'string' ? normalized : 'external task progress' }, 'task.progress')
    }
    try {
      if (typeof adapter.watch !== 'function') {
        const latest = repository.getTask(task.id)
        if (['running', 'stopping'].includes(latest?.status)) transition(latest, 'outcome-unknown', { summary: 'adapter has no authoritative completion observer' }, 'task.outcome-unknown')
        return
      }
      const final = await adapter.watch({ taskId: task.id, operationId: task.operationId, owner: task.owner, sourceInputId: task.sourceInputId, command: task.command, externalHandle: handle, signal: controller.signal, onProgress: progress })
      if (closed) return
      const latest = repository.getTask(task.id)
      if (!['running', 'stopping'].includes(latest?.status)) return
      const status = ['completed', 'failed', 'cancelled'].includes(final?.status) ? final.status : 'outcome-unknown'
      transition(latest, status, { result: final ?? null, finishedAt: TERMINAL.has(status) ? now() : null, summary: final?.summary ?? (status === 'outcome-unknown' ? 'external task has no authoritative terminal result' : status) }, `task.${status}`)
    } catch (cause) {
      if (closed) return
      const latest = repository.getTask(task.id)
      if (['running', 'stopping'].includes(latest?.status)) transition(latest, 'outcome-unknown', { error: String(cause?.message ?? cause), summary: 'external task observation failed; resource remains isolated' }, 'task.outcome-unknown')
    } finally {
      observers.delete(task.id)
      if (controllers.get(task.id) === controller) controllers.delete(task.id)
    }
  }
  async function execute(task, adapter) {
    if (closed) return
    const controller = new AbortController()
    controllers.set(task.id, controller)
    let current = repository.getTask(task.id)
    if (!current || current.status !== 'accepted') { controllers.delete(task.id); return }
    current = transition(current, 'running', { startedAt: now() }, 'task.started')
    try {
      let result
      dispatching.add(task.id)
      try { result = await adapter.execute({ taskId: task.id, operationId: task.operationId, owner: task.owner, sourceInputId: task.sourceInputId, command: task.command, resources: task.resources, signal: controller.signal, version: current.version }) }
      finally { dispatching.delete(task.id) }
      if (closed) return
      const latest = repository.getTask(task.id)
      if (!latest || !['running', 'stopping'].includes(latest.status)) return
      const completionScope = latest.completionScope ?? adapter.completionScope ?? 'tool-invocation'
      if (completionScope === 'external-task') {
        current = transition(latest, latest.status, { externalHandle: result?.externalHandle ?? null, completionScope: 'external-task', summary: 'external task accepted; observing its actual status' }, 'task.external-accepted')
        const observer = observeExternal(current, adapter, result?.externalHandle, controller)
        workers.add(observer); void observer.finally(() => workers.delete(observer))
        const afterObserve = repository.getTask(task.id)
        if (afterObserve?.status === 'stopping' && afterObserve.cancelOperationId) void requestStop(afterObserve, adapter, afterObserve.cancelOperationId)
        return
      }
      current = { ...latest, completionScope }
      if (current.completionScope !== latest.completionScope) current = transition(latest, latest.status, { completionScope: current.completionScope }, 'task.scope')
      const forFinish = repository.getTask(task.id)
      if (!forFinish || !['running', 'stopping'].includes(forFinish.status)) return
      const status = controller.signal.aborted ? 'outcome-unknown' : 'completed'
      transition(forFinish, status, { result: result ?? null, finishedAt: TERMINAL.has(status) ? now() : null, summary: status === 'completed' ? 'tool invocation completed' : 'cancellation could not be confirmed' }, status === 'completed' ? 'task.completed' : 'task.outcome-unknown')
    } catch (cause) {
      if (closed) return
      const latest = repository.getTask(task.id)
      if (!latest || !['running', 'stopping'].includes(latest.status)) return
      const declared = cause?.taskOutcome
      const status = controller.signal.aborted ? 'outcome-unknown'
        : declared?.notApplied === true ? 'failed'
          : declared?.authoritative === true && TERMINAL.has(declared.status) ? declared.status
            : 'outcome-unknown'
      const summary = status === 'failed' && declared?.notApplied === true ? 'adapter proved the operation was not applied'
        : status === 'failed' ? 'adapter reported an authoritative terminal failure'
          : status === 'completed' ? 'adapter reported an authoritative terminal completion'
            : status === 'cancelled' ? 'adapter reported an authoritative terminal cancellation'
              : controller.signal.aborted ? 'cancellation outcome unknown' : 'dispatch outcome unknown; resource remains isolated'
      transition(latest, status, { error: String(cause?.message ?? cause), finishedAt: TERMINAL.has(status) ? now() : null, summary }, status === 'outcome-unknown' ? 'task.outcome-unknown' : `task.${status}`)
      if (status === 'outcome-unknown' && latest.cancelOperationId && (latest.completionScope ?? adapter.completionScope) === 'external-task') void requestStop(repository.getTask(task.id), adapter, latest.cancelOperationId)
    } finally { if (!observers.has(task.id)) controllers.delete(task.id) }
  }
  async function requestStop(task, adapter, operationId) {
    if (closed) return
    const controller = new AbortController()
    cancelControllers.set(task.id, controller)
    try {
      if (task.status === 'accepted') {
        const latest = repository.getTask(task.id)
        if (latest?.status === 'stopping') transition(latest, 'cancelled', { finishedAt: now(), summary: 'cancelled before dispatch' }, 'task.cancelled')
        return
      }
      if (task.status === 'outcome-unknown' && task.cancelOperationId === operationId) {
        const latest = repository.getTask(task.id)
        if (latest?.status === 'outcome-unknown') transition(latest, 'stopping', { summary: 'resuming persisted cancellation after uncertain dispatch' }, 'task.cancel-resumed')
      }
      if (typeof adapter.cancel !== 'function') {
        return
      }
      let latest = repository.getTask(task.id)
      if (!latest || latest.status !== 'stopping') return
      const externalTask = latest.completionScope === 'external-task' || adapter.completionScope === 'external-task'
      if (externalTask && !latest.externalHandle) {
        if (dispatching.has(task.id)) return
        let evidence
        try { evidence = await adapter.recover?.({ task: latest, owner: latest.owner, operationId: latest.operationId }) } catch {}
        if (closed) return
        latest = repository.getTask(task.id)
        if (!latest || latest.status !== 'stopping') return
        if (['completed', 'failed', 'cancelled'].includes(evidence?.status)) {
          transition(latest, evidence.status, { externalHandle: evidence.externalHandle ?? null, result: evidence.result ?? null, finishedAt: now(), summary: evidence.summary ?? `external task ${evidence.status} after cancellation recovery` }, 'task.recovered-terminal')
          return
        }
        if (evidence?.status !== 'running' || !evidence.externalHandle) {
          transition(latest, 'outcome-unknown', { summary: 'cancellation could not recover an authoritative external handle' }, 'task.outcome-unknown')
          return
        }
        latest = transition(latest, 'stopping', { externalHandle: evidence.externalHandle, completionScope: 'external-task', summary: 'recovered external handle while cancellation is pending' }, 'task.cancel-recovered')
        if (!controllers.has(task.id)) {
          const observerController = new AbortController()
          controllers.set(task.id, observerController)
          const worker = observeExternal(latest, adapter, evidence.externalHandle, observerController)
          workers.add(worker); void worker.finally(() => workers.delete(worker))
        }
      } else if (externalTask && !observers.has(task.id) && latest.externalHandle) {
        const observerController = new AbortController()
        controllers.set(task.id, observerController)
        const worker = observeExternal(latest, adapter, latest.externalHandle, observerController)
        workers.add(worker); void worker.finally(() => workers.delete(worker))
      }
      const result = await adapter.cancel({ taskId: task.id, operationId, owner: latest.owner, command: latest.command, externalHandle: latest.externalHandle, signal: controller.signal })
      latest = repository.getTask(task.id)
      const sameUnknownIntent = latest?.status === 'outcome-unknown' && latest.cancelOperationId === operationId
      if (!latest || (latest.status !== 'stopping' && !sameUnknownIntent)) return
      if (result?.stopped === true) {
        controllers.get(task.id)?.abort('adapter confirmed external stop')
        transition(latest, 'cancelled', { finishedAt: now(), summary: 'stopped' }, 'task.cancelled')
      }
      // Pending, rejected, or unconfirmed cancellation keeps the task stopping;
      // its execution/observer may still provide an authoritative result.
    } catch (cause) {
      // A cancellation RPC error is not proof that the request was rejected.
      // Keep observing under the existing lock until a task result is known.
    } finally {
      if (cancelControllers.get(task.id) === controller) cancelControllers.delete(task.id)
    }
  }
  const api = {
    async start({ owner, operationId, adapter: adapterName, command, sourceInputId }) {
      if (closed) throw error('TASKS_CLOSED')
      if (!owner?.namespaceId || !owner?.conversationId || !operationId || !adapterName || !command || !sourceInputId) throw error('INVALID_TASK')
      const adapter = adapters[adapterName]
      if (!adapter || typeof adapter.execute !== 'function' || typeof adapter.deriveResources !== 'function') throw error('ADAPTER_UNAVAILABLE')
      if (!command || typeof command.name !== 'string' || !command.name || !command.args || typeof command.args !== 'object' || Array.isArray(command.args)) throw error('INVALID_TASK_COMMAND')
      if (new TextEncoder().encode(JSON.stringify(command)).byteLength > maxCommandBytes) throw error('COMMAND_TOO_LARGE')
      const commandDigest = stable([adapterName, command])
      const existing = repository.getOperation(operationId)
      if (existing) {
        if (!equalOwner(existing.task.owner, owner) || existing.commandDigest !== commandDigest || existing.task.sourceInputId !== sourceInputId) throw error('OPERATION_CONFLICT')
        return { taskId: existing.task.id, version: existing.task.version, status: existing.task.status, duplicate: true }
      }
      const scopeContext = { owner, command, operationId }
      const completionScope = adapter.resolveCompletionScope?.(scopeContext) ?? adapter.completionScope ?? 'tool-invocation'
      if (!COMPLETION_SCOPES.has(completionScope)) throw error('TASK_SCOPE_UNDECLARED')
      const resources = [...new Set(adapter.deriveResources(command.name, command.args ?? {}, scopeContext))].sort()
      if (resources.length > maxResources) throw error('TOO_MANY_RESOURCES')
      if (resources.some(resource => typeof resource !== 'string' || !resource || resource.length > 512)) throw error('INVALID_RESOURCE')
      const task = { id: uuid(), operationId, owner: { namespaceId: owner.namespaceId, conversationId: owner.conversationId }, sourceInputId, adapter: adapterName, command, commandDigest, resources, completionScope, status: 'accepted', version: 1, createdAt: now(), updatedAt: now(), summary: 'accepted' }
      const op = { id: operationId, taskId: task.id, commandDigest, owner: task.owner, createdAt: task.createdAt, kind: 'start' }
      const created = repository.createTask(task, op)
      if (created.busy) throw error('RESOURCE_BUSY')
      if (created.duplicate) {
        if (!equalOwner(created.task.owner, owner) || created.operation.commandDigest !== commandDigest || created.task.sourceInputId !== sourceInputId) throw error('OPERATION_CONFLICT')
        return { taskId: created.task.id, version: created.task.version, status: created.task.status, duplicate: true }
      }
      publish(task, 'task.accepted')
      queueMicrotask(() => {
        const worker = execute(task, adapter)
        workers.add(worker)
        void worker.finally(() => workers.delete(worker))
      })
      return { taskId: task.id, version: task.version, status: task.status, duplicate: false }
    },
    list({ owner, limit = 50 } = {}) {
      if (!owner?.namespaceId || !owner?.conversationId) throw error('INVALID_OWNER')
      return repository.listTasks(owner).slice(0, Math.max(1, Math.min(maxList, limit)))
    },
    inspect({ owner, taskId }) { return owned(owner, taskId) },
    lookupOperation({ owner, operationId, adapter: adapterName, command, sourceInputId }) {
      const existing = repository.getOperation(operationId)
      if (!existing || !equalOwner(existing.task.owner, owner)) return null
      const commandDigest = stable([adapterName, command])
      if (existing.commandDigest !== commandDigest || existing.task.sourceInputId !== sourceInputId) throw error('OPERATION_CONFLICT')
      return { taskId: existing.task.id, version: existing.task.version, status: existing.task.status, duplicate: true }
    },
    observe({ owner, taskId, afterVersion = 0, limit = 50 }) {
      if (!owned(owner, taskId)) return []
      const pageSize = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 50
      return repository.readEvents(taskId, afterVersion, pageSize).slice(0, pageSize)
    },
    async cancel({ owner, taskId, operationId, expectedVersion }) {
      const key = `${owner?.namespaceId}\u0000${owner?.conversationId}\u0000${taskId}\u0000${expectedVersion}\u0000${operationId}`
      if (cancelReceipts.has(key)) return repository.getTask(taskId) ?? cancelReceipts.get(key)
      const task = owned(owner, taskId)
      if (!task) throw error('TASK_NOT_FOUND')
      if (!operationId || !Number.isSafeInteger(expectedVersion)) throw error('INVALID_CANCEL')
      if (TERMINAL.has(task.status)) return task
      const cancelDigest = stable(['cancel', taskId, expectedVersion])
      const existing = repository.getOperation(operationId)
      if (existing) {
        if (existing.kind !== 'cancel' || existing.task.id !== taskId || !equalOwner(existing.task.owner, owner) || existing.commandDigest !== cancelDigest) throw error('OPERATION_CONFLICT')
        cancelReceipts.set(key, existing.task)
        return existing.task
      }
      if (task.version !== expectedVersion) throw error('STALE_VERSION')
      const adapter = adapters[task.adapter]
      if (typeof repository.recordCancelIntent !== 'function') throw error('ATOMIC_CANCEL_UNAVAILABLE')
      const operation = { id: operationId, taskId, kind: 'cancel', owner, commandDigest: cancelDigest, createdAt: now() }
      const committed = repository.recordCancelIntent({ operation, expectedVersion })
      if (committed?.stale) throw error('STALE_VERSION')
      if (committed?.terminal) return committed.task
      if (committed?.duplicate) {
        const prior = committed.operation
        if (prior?.kind !== 'cancel' || prior.taskId !== taskId || !equalOwner(prior.owner, owner) || prior.commandDigest !== cancelDigest) throw error('OPERATION_CONFLICT')
        cancelReceipts.set(key, committed.task)
        return committed.task
      }
      const next = committed?.task
      if (!next || next.status !== 'stopping' || next.cancelOperationId !== operationId) throw error('ATOMIC_CANCEL_FAILED')
      publish(next, 'task.stopping', { summary: next.summary })
      cancelReceipts.set(key, next)
      queueMicrotask(() => { void requestStop(task, adapter, operationId) })
      return next
    },
    async recover() {
      // Never replay non-idempotent work. Reattach only when an adapter finds an existing external operation by its persisted identity.
      for (const task of repository.listAllTasks?.() ?? []) {
        if (TERMINAL.has(task.status)) continue
        const adapter = adapters[task.adapter]
        let evidence
        try { evidence = await adapter?.recover?.({ task, owner: task.owner, operationId: task.operationId }) } catch {}
        const completionScope = task.completionScope ?? adapter?.completionScope ?? 'tool-invocation'
        if (evidence?.status === 'running' && evidence.externalHandle && completionScope === 'external-task') {
          const resumedStatus = task.cancelOperationId ? 'stopping' : 'running'
          const current = transition(task, resumedStatus, { externalHandle: evidence.externalHandle, completionScope: 'external-task', summary: task.cancelOperationId ? 'reconnected to existing external task; resuming persisted cancellation' : 'reconnected to existing external task after host restart' }, 'task.recovered')
          const controller = new AbortController(); controllers.set(task.id, controller)
          const worker = observeExternal(current, adapter, evidence.externalHandle, controller)
          workers.add(worker); void worker.finally(() => workers.delete(worker))
          if (task.cancelOperationId) void requestStop(current, adapter, task.cancelOperationId)
        } else if (['completed', 'failed', 'cancelled'].includes(evidence?.status)) {
          transition(task, evidence.status, { externalHandle: evidence.externalHandle ?? task.externalHandle, result: evidence.result ?? null, finishedAt: now(), summary: evidence.summary ?? `external task ${evidence.status} after restart` }, 'task.recovered-terminal')
        } else if (task.status === 'outcome-unknown' && !task.cancelOperationId) {
          continue
        } else if (task.status === 'accepted') {
          transition(task, 'failed', { summary: 'host restarted before external dispatch; operation was not replayed', finishedAt: now() }, 'task.not-dispatched')
        } else if (task.status !== 'outcome-unknown') transition(task, 'outcome-unknown', { summary: task.cancelOperationId ? 'host restarted; cancellation intent remains but no authoritative external operation was found' : 'host restarted; no authoritative external operation was found' }, 'task.recovery-unknown')
      }
      return repository.listAllTasks?.() ?? []
    },
    async deliverPending() {
      if (retryTimer !== null) { clearTimeoutFn(retryTimer); retryTimer = null }
      for (const event of repository.getPendingEvents?.() ?? []) await deliver(event)
      if (repository.getPendingEvents?.().length) scheduleRetry()
    },
    registerAdapter(name, adapter) {
      if (closed) throw error('TASKS_CLOSED')
      if (!name || !adapter || typeof adapter.execute !== 'function' || typeof adapter.deriveResources !== 'function') throw error('INVALID_ADAPTER')
      if (adapters[name]) throw error('ADAPTER_EXISTS')
      adapters[name] = adapter
      return () => { if (adapters[name] === adapter) delete adapters[name] }
    },
    async close() {
      if (closed) return
      closed = true
      for (const task of repository.listAllTasks?.() ?? []) {
        if (['accepted', 'running', 'stopping'].includes(task.status)) transition(task, 'outcome-unknown', { summary: 'host closed; external execution was not confirmed stopped' }, 'task.shutdown-unknown')
      }
      for (const controller of controllers.values()) controller.abort('host closing')
      for (const controller of cancelControllers.values()) controller.abort('host closing')
      if (retryTimer !== null) { clearTimeoutFn(retryTimer); retryTimer = null }
    },
  }
  return api
}
