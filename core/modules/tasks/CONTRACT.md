# Managed task core contract

`createTaskService` is a portable ESM coordinator. It has no DSH, DOM, voice
lease or game dependency. The application composes it once per durable task
repository and injects trusted external adapters.

```js
import { createTaskService } from './service.js'
const tasks = createTaskService({ repository, adapters: { remoteJob }, onEvent })
const receipt = await tasks.start({
  owner: { namespaceId, conversationId }, operationId, sourceInputId,
  adapter: 'remoteJob', command: { name: 'operation', args: {} },
})
// {taskId, version, status:'accepted', duplicate:false}
```

## Public operations

| Operation | Input | Result |
| --- | --- | --- |
| `start` | owner, operationId, sourceInputId, adapter, command | Short durable receipt; work starts independently |
| `inspect` | owner, taskId | Owned task snapshot or null |
| `list` | owner, limit | At most configured maxList (default 100) owned tasks |
| `lookupOperation` | owner, operationId, adapter, command, sourceInputId | Existing receipt after identity/digest checks, never dispatch |
| `observe` | owner, taskId, afterVersion, limit | Event page, default 50, maximum 100; last version is next cursor |
| `cancel` | owner, taskId, operationId, expectedVersion | Short durable stop-intent receipt; no wait for external RPC |
| `recover` | none | Reconcile existing external operations; never repeat start |
| `deliverPending` | none | Deliver durable outbox events with stable identities |
| `registerAdapter` | name, adapter | Disposer; duplicate names rejected |
| `close` | none | Stop local observation; running external work becomes unknown, not falsely stopped |

`namespaceId` belongs to repository identity. `conversationId` and
`sourceInputId` are captured from the actual owner/input, not from a mutable
current page. New calls, resets and binding revisions never replace them.
Only authoritative completed/failed/cancelled states release resource locks;
outcome-unknown retains isolation. Repeating an operation ID with different
owner, source or command is rejected.

## Trusted external adapter

An adapter must implement `deriveResources(name,args,context)` and
`execute(input)`. It declares `completionScope:'tool-invocation'|'external-task'`
or a synchronous `resolveCompletionScope({owner,command,...})`. The resolved
Host scope is persisted before dispatch; a business result cannot override it.

For external tasks, `execute` returns `{externalHandle}` and `watch(input)`
observes the actual terminal result. `watch` may invoke `onProgress(detail)`;
JSON-equivalent progress is deduplicated. A start receipt is not completion.
`cancel(input)` returns `{stopped:true}` only with proof of external stop;
`{pending:true}` does not release the resource. `recover({task,owner,operationId})`
queries the original start identity and returns a known terminal or
`{status:'running',externalHandle}` without replaying side effects.

Execution input includes taskId, operationId, owner, sourceInputId, command,
resources and an independent signal. Observation additionally receives
externalHandle/onProgress. Cancellation receives the stable cancellation
operationId, owner, command, externalHandle and its own signal. An adapter may
throw `cause.taskOutcome={notApplied:true}` only for provable pre-dispatch
failure, or `{authoritative:true,status}` for a known terminal result. Other
dispatch failures remain unknown.

A persisted cancellation survives restart and receipt loss. It may reconcile
the original start to recover a handle, reattach observation and continue the
same cancellation identity. A late stop confirmation may resolve matching
unknown cancellation, but cannot overwrite an already confirmed terminal.

## Repository and delivery

The injected repository implements atomic `createTask(task,operation)`,
versioned `updateTask(id,version,patch,type)`, `getTask`, `getOperation`,
`listTasks`, `listAllTasks`, and bounded `readEvents(taskId,afterVersion,limit)`.
The production SQLite implementation is in
`app/shared/storage/tasks/sqlite.js`.

Cancellation requires
`recordCancelIntent({operation,expectedVersion})`: in **one transaction**, it
checks owner-scoped operation identity/version, writes the cancellation
operation and task stopping/cancelOperationId/version, and appends its event.
It returns `{task}` or a duplicate/stale/terminal result. Failure must roll
back all of those writes. A repository without this capability cannot accept
a cancel (`ATOMIC_CANCEL_UNAVAILABLE`). Separately committing the receipt and
intent is insufficient for crash recovery.

Outbox support uses `getPendingEvents()` and
`markEventDelivered(eventId)`. `onEvent(event)` returns
`{acknowledged:true}` only after durable delivery; otherwise the coordinator
retries with bounded backoff. Nonterminal progress can be acknowledged without
an unsolicited chat message, while the event remains available through
`observe`. Phone output is a consumer of task facts, not their lifecycle owner.
