import { conversation, digest, fail, keys, plain, publicError, readJson, serial, text, writeJson } from './core.js'
import { isConversationalUserMessage } from './policy.js'

const FORMAT = 'channel-reply-v1'
const MAX_ROUTES = 1024, MAX_TURNS = 2048, MAX_EVENTS = 4096, MAX_INPUTS = 128, MAX_OUTPUTS = 256
const STATES = ['waiting', 'pending', 'sending', 'sent', 'failed', 'unknown', 'canceled']
const validTurn = value => Number.isSafeInteger(value) && value >= 0
const routeKey = row => JSON.stringify([row.sessionId, row.inboundMessageId])
const turnKey = (sessionId, turn) => JSON.stringify([sessionId, turn])
const targetKey = row => JSON.stringify([row.connectionId, row.conversation, row.identityRevision, row.sessionKey])
const fingerprint = value => digest(JSON.stringify(value))
const admission = code => ['SOCIAL_NOT_CONNECTED', 'SOCIAL_RATE_LIMITED'].includes(code)
function route(input) {
  if (!plain(input) || !text(input.sessionId) || !text(input.inboundMessageId) || !text(input.connectionId) || !text(input.identityRevision) || !text(input.sessionKey, 2048)) fail('SOCIAL_CHANNEL_REPLY_INVALID')
  return { sessionId: input.sessionId, inboundMessageId: input.inboundMessageId, connectionId: input.connectionId, conversation: conversation(input.conversation), identityRevision: input.identityRevision, sessionKey: input.sessionKey }
}
function operation(row, target) { return digest(JSON.stringify([FORMAT, row.sessionId, row.turn, row.assistantMessageId, targetKey(target)])) }
function validate(state) {
  try {
    keys(state, ['version', 'format', 'routes', 'turns'])
    if (state.version !== 1 || state.format !== FORMAT || !Array.isArray(state.routes) || state.routes.length > MAX_ROUTES || !Array.isArray(state.turns) || state.turns.length > MAX_TURNS) fail('SOCIAL_CHANNEL_REPLY_INVALID')
    const routes = new Map(), turns = new Map()
    for (const value of state.routes) {
      keys(value, ['sessionId', 'inboundMessageId', 'connectionId', 'conversation', 'identityRevision', 'sessionKey', 'turn'])
      const checked = route(value), key = routeKey(checked)
      if (routes.has(key) || (value.turn !== undefined && !validTurn(value.turn))) fail('SOCIAL_CHANNEL_REPLY_INVALID')
      routes.set(key, value)
    }
    for (const row of state.turns) {
      keys(row, ['sessionId', 'turn', 'status', 'ended', 'inputs', 'outputs', 'routeKeys', 'last', 'assistantMessageId', 'output', 'operationId', 'errorCode'])
      if (!text(row.sessionId) || !validTurn(row.turn) || !STATES.includes(row.status) || typeof row.ended !== 'boolean' || !Array.isArray(row.inputs) || row.inputs.length > MAX_INPUTS || !Array.isArray(row.outputs) || row.outputs.length > MAX_OUTPUTS || !Array.isArray(row.routeKeys) || row.routeKeys.length > MAX_INPUTS) fail('SOCIAL_CHANNEL_REPLY_INVALID')
      const key = turnKey(row.sessionId, row.turn)
      if (turns.has(key)) fail('SOCIAL_CHANNEL_REPLY_INVALID')
      turns.set(key, row)
      for (const item of [...row.inputs, ...row.outputs]) { keys(item, ['id', 'hash']); if (!text(item.id) || !text(item.hash, 64)) fail('SOCIAL_CHANNEL_REPLY_INVALID') }
      if (new Set(row.inputs.map(item => item.id)).size !== row.inputs.length || new Set(row.outputs.map(item => item.id)).size !== row.outputs.length || new Set(row.routeKeys).size !== row.routeKeys.length) fail('SOCIAL_CHANNEL_REPLY_INVALID')
      const targets = row.routeKeys.map(id => routes.get(id))
      if (targets.some(target => !target || target.sessionId !== row.sessionId || target.turn !== row.turn)) fail('SOCIAL_CHANNEL_REPLY_INVALID')
      if (row.errorCode !== undefined && !/^SOCIAL_[A-Z_]+$/.test(row.errorCode)) fail('SOCIAL_CHANNEL_REPLY_INVALID')
      if (row.last !== undefined) {
        keys(row.last, ['id', 'valid', 'text'])
        if (!text(row.last.id) || typeof row.last.valid !== 'boolean' || typeof row.last.text !== 'string' || row.last.text.length > 8000) fail('SOCIAL_CHANNEL_REPLY_INVALID')
      }
      if (['pending', 'sending', 'sent', 'unknown', 'failed'].includes(row.status)) {
        if (!row.ended || !targets.length || row.inputs.length !== targets.length || targets.some(target => !row.inputs.some(input => input.id === target.inboundMessageId) || targetKey(target) !== targetKey(targets[0])) || !text(row.assistantMessageId) || !text(row.output, 8000) || row.operationId !== operation(row, targets[0])) fail('SOCIAL_CHANNEL_REPLY_INVALID')
      }
    }
    for (const value of routes.values()) if (value.turn !== undefined && !turns.get(turnKey(value.sessionId, value.turn))?.routeKeys.includes(routeKey(value))) fail('SOCIAL_CHANNEL_REPLY_INVALID')
    return state
  } catch { fail('SOCIAL_CHANNEL_REPLY_INVALID') }
}

/** Host-only per-turn routing. Consumes live committed events, never scans history.
 * Caller MUST await register before submitting its user message to the session. */
export async function createChannelReply({ file, service, syncDirectory = async () => {} }) {
  if (!text(file, 4096)) fail('SOCIAL_CHANNEL_REPLY_INVALID')
  const state = validate(await readJson(file, { version: 1, format: FORMAT, routes: [], turns: [] }))
  const queue = serial(64), events = [], current = new Map()
  let closed = false, poisoned = '', scheduled = false, closePromise
  function check() { if (poisoned) fail(poisoned); if (closed) fail('SOCIAL_BRIDGE_CLOSED') }
  async function persist() {
    if (Buffer.byteLength(JSON.stringify(state)) > 7 * 1024 * 1024) { poisoned = 'SOCIAL_REPLY_CAPACITY'; fail(poisoned) }
    try { await writeJson(file, state, { syncDirectory }) } catch { poisoned = 'SOCIAL_REPLY_STORAGE_UNCERTAIN'; fail(poisoned) }
  }
  function cancel(row, code) { row.status = 'canceled'; row.errorCode = code; delete row.last; delete row.output }
  let recovered = false
  for (const row of state.turns) {
    if (row.status === 'sending') { row.status = 'unknown'; row.errorCode = 'SOCIAL_SEND_UNKNOWN'; recovered = true }
    // Missed live events cannot be reconstructed safely after a restart.
    if (!row.ended) { row.ended = true; cancel(row, 'SOCIAL_REPLY_RESTART_INCOMPLETE'); recovered = true }
  }
  if (recovered) await persist()
  function targetFor(row) { return state.routes.find(target => routeKey(target) === row.routeKeys[0]) }
  async function dispatch(row) {
    if (closed || poisoned || row.status !== 'pending') return
    const target = targetFor(row)
    let scope
    try {
      scope = service.issueScope({ sessionId: row.sessionId, connectionId: target.connectionId, conversation: target.conversation })
      if (scope.identityRevision !== target.identityRevision || scope.sessionKey !== target.sessionKey) fail('SOCIAL_SCOPE_STALE')
      service.scopedIdentity(scope)
    } catch (error) {
      if (scope) service.revokeScope(scope)
      row.errorCode = publicError(error)
      if (!admission(error?.code)) row.status = 'failed'
      await persist()
      return
    }
    try {
      if (closed || poisoned) return
      row.status = 'sending'; delete row.errorCode
      await persist() // Durable final output and operation identity precede the only external write.
      if (closed || poisoned) { row.status = 'pending'; await persist(); return }
      let result
      try { result = await service.send(scope, { operationId: row.operationId, connectionId: target.connectionId, conversation: target.conversation, text: row.output }) }
      catch (error) {
        // Only service pre-admission throws are safe to retry. Driver returned failures are terminal.
        if (admission(error?.code)) { row.status = 'pending'; row.errorCode = error.code; await persist(); return }
        result = { status: 'unknown' }
      }
      row.status = result?.status === 'accepted' ? 'sent' : result?.status === 'failed' ? 'failed' : 'unknown'
      if (row.status !== 'sent') row.errorCode = row.status === 'unknown' ? 'SOCIAL_SEND_UNKNOWN' : publicError({ code: result.errorCode })
      await persist()
    } finally { service.revokeScope(scope) }
  }
  async function consume({ sessionId, event }) {
    const data = event.data
    if (event.type === 'turn/start') {
      if (!validTurn(data?.turn)) { poisoned = 'SOCIAL_REPLY_TURN_INVALID'; return }
      const existing = state.turns.find(row => row.sessionId === sessionId && row.turn === data.turn)
      if (existing) return // Replayed starts never reset a turn or resurrect a completed route.
      // No external admission is pending: this is an ordinary DSH turn, not an
      // outbox record. Local chat must not consume the channel ledger capacity.
      if (!state.routes.some(target => target.sessionId === sessionId && target.turn === undefined)) return
      if (state.turns.length >= MAX_TURNS) { poisoned = 'SOCIAL_REPLY_CAPACITY'; return }
      const previous = current.get(sessionId)
      if (previous && !previous.ended) { previous.ended = true; cancel(previous, 'SOCIAL_REPLY_TURN_INTERRUPTED') }
      const row = { sessionId, turn: data.turn, status: 'waiting', ended: false, inputs: [], outputs: [], routeKeys: [] }
      state.turns.push(row); current.set(sessionId, row); await persist(); return
    }
    const row = current.get(sessionId)
    if (!row || row.ended) return // No active turn means DSH-only, never guess a previous target.
    if (event.type === 'user/message') {
      if (!isConversationalUserMessage(data)) return
      if (!text(data.id)) { cancel(row, 'SOCIAL_REPLY_MIXED_TURN'); await persist(); return }
      const hash = fingerprint(data), prior = row.inputs.find(input => input.id === data.id)
      const old = state.turns.find(item => item !== row && item.sessionId === sessionId && item.inputs.some(input => input.id === data.id && input.hash === hash))
      if (old) return // A replayed committed input must not taint a later live turn.
      if (prior) { if (prior.hash !== hash) { cancel(row, 'SOCIAL_REPLY_MIXED_TURN'); await persist() }; return }
      if (row.inputs.length >= MAX_INPUTS) { cancel(row, 'SOCIAL_REPLY_CAPACITY'); await persist(); return }
      row.inputs.push({ id: data.id, hash })
      delete row.last // Never attribute output that preceded the latest conversational input.
      const target = state.routes.find(item => item.sessionId === sessionId && item.inboundMessageId === data.id)
      if (target && target.turn === undefined) { target.turn = row.turn; row.routeKeys.push(routeKey(target)) }
      else if (target && target.turn !== row.turn) { cancel(row, 'SOCIAL_REPLY_ROUTE_MISMATCH'); await persist(); return }
      const targets = row.routeKeys.map(id => state.routes.find(item => routeKey(item) === id))
      if ((event.surfaceOp !== undefined && event.surfaceOp !== 'append') || (targets.length && (row.inputs.length !== targets.length || targets.some(item => targetKey(item) !== targetKey(targets[0]))))) cancel(row, 'SOCIAL_REPLY_MIXED_TURN')
      await persist(); return
    }
    if (event.type === 'assistant/message') {
      if (data?.turn !== row.turn) return
      const message = data.message
      if (!text(message?.id)) { cancel(row, 'SOCIAL_REPLY_FINAL_MISSING'); await persist(); return }
      const hash = fingerprint(data), prior = row.outputs.find(item => item.id === message.id)
      if (prior) { if (prior.hash !== hash) { cancel(row, 'SOCIAL_REPLY_AMBIGUOUS'); await persist() }; return }
      if (row.outputs.length >= MAX_OUTPUTS) { cancel(row, 'SOCIAL_REPLY_CAPACITY'); await persist(); return }
      row.outputs.push({ id: message.id, hash })
      const blocks = Array.isArray(message.content) ? message.content : []
      const output = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
      const valid = !data.interrupted && message.role === 'assistant' && Array.isArray(message.content) && !blocks.some(block => block?.type === 'tool-call') && (event.surfaceOp === undefined || event.surfaceOp === 'append') && text(output, 8000)
      row.last = { id: message.id, valid: !!valid, text: valid ? output : '' }
      await persist(); return
    }
    if (event.type === 'turn/end') {
      if (data?.turn !== row.turn) return
      row.ended = true; current.delete(sessionId)
      if (row.status === 'canceled') { await persist(); return }
      if (data.reason?.kind !== 'completed') cancel(row, 'SOCIAL_REPLY_TURN_INTERRUPTED')
      else if (!row.routeKeys.length) cancel(row, 'SOCIAL_REPLY_DSH_ONLY')
      else if (!row.last?.valid) cancel(row, 'SOCIAL_REPLY_FINAL_MISSING')
      else {
        row.assistantMessageId = row.last.id; row.output = row.last.text; delete row.last
        row.operationId = operation(row, targetFor(row)); row.status = 'pending'
      }
      await persist()
      await dispatch(row)
    }
  }
  async function drain() {
    while (events.length && !poisoned) await consume(events.shift())
  }
  function schedule() {
    if (scheduled) return
    scheduled = true
    void queue(async () => {
      try { await drain() }
      finally { scheduled = false; if (events.length && !poisoned && !closed) schedule() }
    }).catch(error => { poisoned ||= publicError(error); scheduled = false })
  }
  return {
    async register(input) {
      const checked = route(structuredClone(input))
      return queue(async () => {
        check()
        const existing = state.routes.find(item => routeKey(item) === routeKey(checked))
        if (existing) { if (targetKey(existing) !== targetKey(checked)) fail('SOCIAL_REPLY_ROUTE_MISMATCH'); return }
        if (state.routes.length >= MAX_ROUTES) fail('SOCIAL_REPLY_CAPACITY')
        state.routes.push(checked); await persist()
      })
    },
    onEvent(session, event) {
      if (closed || poisoned || !['turn/start', 'user/message', 'assistant/message', 'turn/end'].includes(event?.type)) return
      try {
        const sessionId = typeof session === 'string' ? session : session?.id
        if (!text(sessionId)) return
        if (events.length >= MAX_EVENTS) { poisoned = 'SOCIAL_REPLY_CAPACITY'; return }
        // Snapshot immediately, before any disk wait. The emitter does not await this listener.
        events.push({ sessionId, event: structuredClone(event) }); schedule()
      } catch { poisoned = 'SOCIAL_REPLY_EVENT_INVALID' }
    },
    process() {
      return queue(async () => {
        if (closed || poisoned) return { pending: false }
        await drain()
        for (const row of state.turns) { if (closed || poisoned) break; await dispatch(row) }
        return { pending: !closed && !poisoned && state.turns.some(row => row.status === 'pending') }
      })
    },
    inspect() {
      const rows = state.routes.map(target => {
        const row = target.turn === undefined ? null : state.turns.find(value => value.sessionId === target.sessionId && value.turn === target.turn)
        return { sessionId: target.sessionId, inboundMessageId: target.inboundMessageId, ...(row ? { turn: row.turn } : {}), ...(row?.assistantMessageId ? { assistantMessageId: row.assistantMessageId } : {}), status: poisoned ? 'failed' : row?.status || 'waiting', ...(poisoned || row?.errorCode ? { errorCode: poisoned || row.errorCode } : {}) }
      })
      if (poisoned && !rows.length) rows.push({ status: 'failed', errorCode: poisoned })
      return rows
    },
    close() {
      if (!closePromise) { closed = true; closePromise = queue(async () => { await drain() }, true) }
      return closePromise
    },
  }
}
