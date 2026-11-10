import WebSocket from 'ws'
import { randomBytes } from 'node:crypto'
import { fail, text } from '../core.js'
import { validateDingTalkRoute, validateDingTalkWebhook, mergeDingTalkRoutes, retainDingTalkRoute } from '../dingtalk-routes.js'

// Protocol references (SDKs are references, not dependencies):
// https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/blob/main/src/client.ts
// https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/blob/main/src/constants.ts
// https://open.dingtalk.com/document/robots/receive-message.md
export const DINGTALK_ROBOT_TOPIC = '/v1.0/im/bot/messages/get'
const GATEWAY = 'https://api.dingtalk.com/v1.0/gateway/connections/open'
function id(value) { if (!text(value)) fail('SOCIAL_PROTOCOL_ID_INVALID'); return value }
function key(target) { return JSON.stringify([target.type, target.id]) }
function endpoint(value, ticket) {
  const url = new URL(value)
  if (url.protocol !== 'wss:' || !(url.hostname === 'dingtalk.com' || url.hostname.endsWith('.dingtalk.com')) || url.port || url.username || url.password || url.hash || url.search || !text(ticket, 8192)) fail('SOCIAL_ENDPOINT_INVALID')
  url.searchParams.set('ticket', ticket)
  return url.href
}
export function normalizeDingTalkEvent(event, config, self, now = Date.now(), stats = null) {
  const skip = reason => { if (stats) { stats.ignored = (stats.ignored ?? 0) + 1; stats.reasons = { ...(stats.reasons ?? {}), [reason]: ((stats.reasons ?? {})[reason] ?? 0) + 1 } } return null }
  if (!event || typeof event !== 'object' || event.robotCode !== config.robotCode) { if (stats) stats.reasons = { ...(stats.reasons ?? {}), 'identity-mismatch': ((stats.reasons ?? {})['identity-mismatch'] ?? 0) + 1 }; fail('SOCIAL_EVENT_IDENTITY_MISMATCH') }
  if (event.msgtype !== 'text' || !text(event.text?.content, 32000)) return skip('non-text')
  if (!['1', '2'].includes(event.conversationType)) return skip('unsupported-conversation')
  if (event.conversationType === '2' && event.isInAtList !== true) return skip('group-not-at')
  if (event.senderId === event.chatbotUserId || event.senderId === config.robotCode || event.isBot === true) return skip('self-message')
  const sentAt = Number(event.createAt)
  return {
    connectionId: config.id, platform: config.platform, provider: config.provider, self: structuredClone(self),
    messageId: id(event.msgId), conversation: { type: event.conversationType === '1' ? 'direct' : 'group', id: id(event.conversationId) },
    sender: { id: id(event.senderId), ...(text(event.senderNick) ? { name: event.senderNick } : {}), ...(text(event.senderStaffId) ? { staffId: event.senderStaffId } : {}), ...(text(event.senderCorpId) ? { corpId: event.senderCorpId } : {}) },
    text: event.text.content, sentAt: Number.isFinite(sentAt) && sentAt > 0 ? sentAt : now,
    mentionsSelf: event.isInAtList === true, replyToSelf: false,
  }
}

export function createDingTalkDriver(config, {
  clientSecret, routeStore, fetchImpl = globalThis.fetch,
  socketFactory = url => new WebSocket(url, { maxPayload: maxFrameBytes, perMessageDeflate: false, followRedirects: false, handshakeTimeout: actionTimeoutMs }), now = Date.now,
  actionTimeoutMs = 10000, reconnectMs = 1000, maxReconnectMs = 30000, heartbeatTimeoutMs = 0,
  pingIntervalMs = 8000, pongTimeoutMs = 8000, setLivenessTimer = setTimeout, clearLivenessTimer = clearTimeout,
  maxFrameBytes = 1024 * 1024, maxWebhooks = 256, maxPendingMessages = 128, sendIntervalMs = 1000, ownerSendIntervalMs = 10000,
} = {}) {
  if (!text(config.clientId) || !text(config.robotCode) || !text(clientSecret, 8192)) fail('SOCIAL_CREDENTIAL_MISSING')
  let stopped = true, epoch = 0, socket = null, callbacks = null, identity = null, retry = 0
  let reconnectTimer, handshakeTimer, heartbeatTimer, processing = 0, sending = false, lastSend = -Infinity
  const hooks = new Map(), requests = new Set()
  let pingTimer = null, pongTimer = null, pendingPing = null
  let ownerSending = false, lastOwnerSend = -Infinity, accessToken = null, tokenExpires = 0
  function ownerRoute(conversation, staffId) {
    // Recipient authorization belongs to the pairing service, never latest inbound.
    if (conversation?.type !== 'direct' || !text(conversation.id)) return null
    const saved = hooks.get(key(conversation))
    if (!saved && !text(staffId, 256)) return null
    return { ...(saved ?? { conversation, expires: 0 }), staffId: text(staffId, 256) ? staffId : undefined }
  }
  function apiRejected(response) {
    const data = response.data
    return (response.status >= 400 && response.status < 500) || (data && ['code', 'errcode', 'errorCode'].some(name => data[name] !== undefined && ![0, '0', null, ''].includes(data[name])))
  }
  async function sendWebhook(route, content, generation) {
    try {
      const response = await post(route.url, { msgtype: 'text', text: { content } })
      if (!active(generation)) return { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' }
      if (response.ok && response.data?.errcode === 0) return { status: 'accepted' }
      if (response.status >= 400 && response.status < 500 || response.ok && typeof response.data?.errcode === 'number' && response.data.errcode !== 0) return { status: 'failed', errorCode: 'SOCIAL_SEND_FAILED' }
      return { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' }
    } catch { return { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' } }
  }
  // Bounded diagnostics: distinguish "platform never delivered" from "ignored on arrival".
  const inbound = { callback: 0, accepted: 0, duplicate: 0, rejected: 0, ignored: 0, reasons: {}, lastAt: null }
  const connection = { connects: 0, lastConnectedAt: null, lastDisconnectAt: null, lastReason: null, lastFrameAt: null, systemFrames: 0, acks: 0,
    health: 'disconnected', pingIntervalMs, pongTimeoutMs, pings: 0, pongs: 0, pongTimeouts: 0, lastPingAt: null, lastPongAt: null, lastPongRttMs: null }
  function active(generation) { return !stopped && generation === epoch }
  function status(value, reason) { try { callbacks?.onStatus(value, reason) } catch {} }
  function clearTimers() {
    clearTimeout(handshakeTimer); clearTimeout(heartbeatTimer)
    if (pingTimer !== null) clearLivenessTimer(pingTimer)
    if (pongTimer !== null) clearLivenessTimer(pongTimer)
    pingTimer = null; pongTimer = null; pendingPing = null
  }
  function closeSocket(ws) {
    // A dead peer may never complete the close handshake; stop its transport now.
    try { if (typeof ws?.terminate === 'function') ws.terminate(); else ws?.close() } catch {}
  }
  function schedulePing(ws, generation) {
    if (!(pingIntervalMs > 0) || !active(generation) || socket !== ws) return
    pingTimer = setLivenessTimer(() => {
      pingTimer = null
      if (!active(generation) || socket !== ws) return
      if (ws.readyState !== 1) { disconnect(generation, 'SOCIAL_CONNECTION_LOST'); return }
      pendingPing = randomBytes(12)
      connection.health = 'awaiting-pong'; connection.lastPingAt = now(); connection.pings++
      pongTimer = setLivenessTimer(() => {
        pongTimer = null
        if (!active(generation) || socket !== ws || !pendingPing) return
        connection.pongTimeouts++
        disconnect(generation, 'SOCIAL_PONG_TIMEOUT')
      }, pongTimeoutMs)
      pongTimer?.unref?.()
      try { ws.ping(pendingPing, true, error => { if (error) disconnect(generation, 'SOCIAL_PING_FAILED') }) }
      catch { disconnect(generation, 'SOCIAL_PING_FAILED') }
    }, pingIntervalMs)
    pingTimer?.unref?.()
  }
  function watchLiveness(ws, generation) {
    if (!(pingIntervalMs > 0)) { connection.health = 'unmonitored'; return }
    if (typeof ws.ping !== 'function' || typeof ws.on !== 'function') fail('SOCIAL_HEARTBEAT_UNSUPPORTED')
    connection.health = 'unverified'; connection.lastPingAt = null; connection.lastPongAt = null; connection.lastPongRttMs = null
    ws.on('pong', data => {
      if (!active(generation) || socket !== ws || !pendingPing || !Buffer.isBuffer(data) || !data.equals(pendingPing)) return
      clearLivenessTimer(pongTimer); pongTimer = null; pendingPing = null
      connection.pongs++; connection.lastPongAt = now()
      connection.lastPongRttMs = Math.max(0, connection.lastPongAt - connection.lastPingAt)
      connection.health = 'healthy'
      schedulePing(ws, generation)
    })
    schedulePing(ws, generation)
  }
  function reconnect() {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect() }, Math.min(maxReconnectMs, reconnectMs * 2 ** Math.min(retry++, 10)))
    reconnectTimer.unref?.()
  }
  function disconnect(generation, reason) {
    if (!active(generation)) return
    connection.lastDisconnectAt = now(); connection.lastReason = reason; connection.health = 'disconnected'
    epoch++; identity = null; hooks.clear(); accessToken = null; tokenExpires = 0; clearTimers()
    for (const request of requests) request.abort()
    const ws = socket; socket = null
    closeSocket(ws)
    status('disconnected', reason); reconnect()
  }
  function heartbeat(generation) {
    clearTimeout(heartbeatTimer)
    // The gateway does not promise an application-frame cadence during idle.
    if (!(heartbeatTimeoutMs > 0)) return
    heartbeatTimer = setTimeout(() => disconnect(generation, 'SOCIAL_HEARTBEAT_TIMEOUT'), heartbeatTimeoutMs)
    heartbeatTimer.unref?.()
  }
  async function post(url, body, headers = {}, tolerateInvalidJson = false) {
    const controller = new AbortController(); requests.add(controller)
    // Race as well as abort: injected transports may ignore AbortSignal.
    let timer, abortListener
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(new Error('request cancelled'))
      controller.signal.addEventListener('abort', abortListener, { once: true })
      timer = setTimeout(() => controller.abort(), actionTimeoutMs)
    })
    try {
      return await Promise.race([aborted, (async () => {
        const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) })
        const reader = response.body?.getReader()
        if (!reader) throw new Error('missing response body')
        let size = 0; const chunks = []
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > maxFrameBytes) throw new Error('response too large')
            chunks.push(Buffer.from(value))
          }
        } finally { await reader.cancel().catch(() => {}) }
        let data
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) { if (!tolerateInvalidJson) throw error; data = null }
        return { ok: response.ok, status: response.status, data }
      })()])
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', abortListener); requests.delete(controller)
    }
  }
  function ack(ws, generation, frame, system = false) {
    if (!active(generation) || socket !== ws || ws.readyState !== 1) return
    ws.send(JSON.stringify({ code: 200, headers: system ? frame.headers : { contentType: 'application/json', messageId: frame.headers.messageId }, message: 'OK', data: system ? frame.data : '{}' }))
    connection.acks++
  }
  async function receive(ws, generation, payload) {
    if (!active(generation)) return
    try {
      if (typeof payload.data !== 'string' || Buffer.byteLength(payload.data) > maxFrameBytes) fail('SOCIAL_FRAME_INVALID')
      const frame = JSON.parse(payload.data)
      connection.lastFrameAt = now()
      if (frame.type === 'SYSTEM') {
        connection.systemFrames++
        // Official disconnect frames may omit messageId and require no ACK:
        // https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/
        if (frame.headers?.topic === 'disconnect') { disconnect(generation, 'SOCIAL_CONNECTION_LOST'); return }
        if (frame.headers?.topic === 'ping') {
          id(frame.headers.messageId)
          ack(ws, generation, frame, true)
        }
        heartbeat(generation)
        return
      }
      id(frame.headers?.messageId)
      if (frame.type !== 'CALLBACK' || frame.headers.topic !== DINGTALK_ROBOT_TOPIC) return
      inbound.callback++; inbound.lastAt = now()
      if (!identity || processing >= maxPendingMessages) return // No success ACK on backpressure.
      const event = JSON.parse(frame.data)
      const message = normalizeDingTalkEvent(event, config, identity, now(), inbound)
      if (!message) { ack(ws, generation, frame); return }
      processing++
      let result
      try { result = await callbacks?.onMessage(message) } finally { processing-- }
      if (!active(generation)) return
      if (result?.accepted !== true && result?.duplicate !== true) { inbound.rejected++; return }
      if (result.accepted === true) inbound.accepted++
      else inbound.duplicate++
      // Only accepted/known duplicate inbox records may update private reply routes.
      let route
      try {
        const expires = Number(event.sessionWebhookExpiredTime)
        if (Number.isSafeInteger(expires) && expires > 0) route = validateDingTalkRoute({ conversation: message.conversation, url: validateDingTalkWebhook(event.sessionWebhook), expires,
          ...(message.conversation.type === 'direct' ? { updatedAt: now(), ...(text(event.senderStaffId, 256) ? { staffId: event.senderStaffId } : {}) } : {}) })
      } catch {} // Invalid reply route must not discard a successfully persisted message.
      if (route) {
        // Inbox acceptance already wakes the model. Make the validated route usable
        // immediately; a slow disk must not turn a fast reply into WEBHOOK_EXPIRED.
        const routeKey = key(route.conversation)
        for (const [k, saved] of hooks) if (!retainDingTalkRoute(saved, now())) hooks.delete(k)
        if (retainDingTalkRoute(route, now())) {
          const merged = mergeDingTalkRoutes(hooks.get(routeKey), route)
          hooks.delete(routeKey); hooks.set(routeKey, merged)
        }
        while (hooks.size > maxWebhooks) hooks.delete(hooks.keys().next().value)
        if (routeStore) {
          try { await routeStore.remember(config, route) } catch { fail('SOCIAL_DINGTALK_ROUTES_WRITE_FAILED') }
          if (!active(generation)) return
        }
      }
      ack(ws, generation, frame)
    } catch (error) {
      if (active(generation)) {
        const reason = ['SOCIAL_EVENT_IDENTITY_MISMATCH', 'SOCIAL_DINGTALK_ROUTES_WRITE_FAILED'].includes(error?.code) ? error.code : 'SOCIAL_EVENT_REJECTED'
        status('error', reason); disconnect(generation, reason)
      }
    }
  }
  async function connect() {
    if (stopped) return
    const generation = ++epoch
    status('starting')
    try {
      if (routeStore) {
        let restored
        try {
          const routes = await routeStore.load(config)
          if (!active(generation)) return
          if (!Array.isArray(routes) || routes.length > 256) fail('SOCIAL_DINGTALK_ROUTES_LOAD_FAILED')
          restored = routes.map(validateDingTalkRoute)
        } catch { fail('SOCIAL_DINGTALK_ROUTES_LOAD_FAILED') }
        if (!active(generation)) return
        hooks.clear()
        for (const route of restored) if (retainDingTalkRoute(route, now())) hooks.set(key(route.conversation), route)
        while (hooks.size > maxWebhooks) hooks.delete(hooks.keys().next().value)
      }
      const response = await post(GATEWAY, { clientId: config.clientId, clientSecret, ua: 'chonkyFish/1.0', subscriptions: [{ type: 'CALLBACK', topic: DINGTALK_ROBOT_TOPIC }] })
      if (!active(generation)) return
      if (!response.ok) fail('SOCIAL_CONNECT_FAILED')
      const ws = socketFactory(endpoint(response.data.endpoint, response.data.ticket)); socket = ws
      handshakeTimer = setTimeout(() => disconnect(generation, 'SOCIAL_HANDSHAKE_TIMEOUT'), actionTimeoutMs)
      handshakeTimer.unref?.()
      ws.addEventListener('open', () => {
        if (!active(generation)) return
        clearTimeout(handshakeTimer); retry = 0
        connection.connects++; connection.lastConnectedAt = now()
        // Gateway-authenticated application binding, NOT a queried DingTalk user identity.
        identity = { connectionId: config.id, platform: config.platform, provider: config.provider, protocolUserId: config.robotCode, verifiedAt: new Date(now()).toISOString() }
        try { watchLiveness(ws, generation) }
        catch { disconnect(generation, 'SOCIAL_HEARTBEAT_UNSUPPORTED'); return }
        heartbeat(generation); status('connected')
      })
      ws.addEventListener('message', payload => { void receive(ws, generation, payload) })
      ws.addEventListener('error', () => disconnect(generation, 'SOCIAL_SOCKET_ERROR'))
      ws.addEventListener('close', () => disconnect(generation, 'SOCIAL_CONNECTION_LOST'))
    } catch (error) {
      if (active(generation)) {
        const reason = error?.code === 'SOCIAL_DINGTALK_ROUTES_LOAD_FAILED' ? error.code : 'SOCIAL_CONNECT_FAILED'
        status('error', reason); disconnect(generation, reason)
      }
    }
  }
  return {
    connectionId: config.id,
    async start(value) { if (!stopped) return; callbacks = value; stopped = false; void connect() },
    async stop() {
      stopped = true; epoch++; clearTimeout(reconnectTimer); reconnectTimer = null; clearTimers()
      identity = null; hooks.clear(); accessToken = null; tokenExpires = 0
      for (const request of requests) request.abort()
      connection.health = 'disconnected'
      const ws = socket; socket = null; closeSocket(ws)
    },
    async getSelfIdentity() { if (!identity || stopped) fail('SOCIAL_NOT_CONNECTED'); return structuredClone(identity) },
    inspect() { return { inbound: structuredClone(inbound), connection: structuredClone(connection) } },
    async sendOwner(input = {}) {
      const content = input?.text
      if (!identity || stopped) return { status: 'failed', errorCode: 'SOCIAL_NOT_CONNECTED' }
      if (!text(content, 8000)) return { status: 'failed', errorCode: 'SOCIAL_INVALID_TEXT' }
      const route = ownerRoute(input.conversation, input.staffId)
      if (!route) return { status: 'failed', errorCode: 'SOCIAL_NO_OWNER_CHAT' }
      if (route.expires <= now() && !route.staffId) return { status: 'failed', errorCode: 'SOCIAL_OWNER_WEBHOOK_EXPIRED' }
      if (ownerSending || now() - lastOwnerSend < ownerSendIntervalMs) return { status: 'failed', errorCode: 'SOCIAL_RATE_LIMITED' }
      ownerSending = true; lastOwnerSend = now(); const generation = epoch
      try {
        if (route.expires > now()) return await sendWebhook(route, content, generation)
        // Official org-app token and BatchSendOTO APIs; never retry external writes.
        // https://open.dingtalk.com/document/orgapp/obtain-the-access_token-of-an-internal-app.md
        // https://open.dingtalk.com/document/robots/chatbots-send-one-on-one-chat-messages-in-batches.md
        if (!accessToken || tokenExpires <= now()) {
          const token = await post('https://api.dingtalk.com/v1.0/oauth2/accessToken', { appKey: config.clientId, appSecret: clientSecret }, {}, true)
          if (!active(generation)) return { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' }
          if (apiRejected(token)) return { status: 'failed', errorCode: 'SOCIAL_OWNER_TOKEN_FAILED' }
          const ttl = token.data?.expireIn
          if (!token.ok || !text(token.data?.accessToken, 8192) || !Number.isSafeInteger(ttl) || ttl <= 0 || !Number.isSafeInteger(now() + ttl * 1000)) return { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' }
          accessToken = token.data.accessToken; tokenExpires = now() + Math.max(0, ttl * 1000 - 60000)
        }
        if (!active(generation)) return { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' }
        const response = await post('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
          robotCode: config.robotCode, userIds: [route.staffId], msgKey: 'sampleText', msgParam: JSON.stringify({ content }),
        }, { 'x-acs-dingtalk-access-token': accessToken }, true)
        if (!active(generation)) return { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' }
        if (apiRejected(response) || ['invalidStaffIdList', 'flowControlledStaffIdList'].some(name => Array.isArray(response.data?.[name]) && response.data[name].length > 0)) return { status: 'failed', errorCode: 'SOCIAL_OWNER_SEND_FAILED' }
        if (!response.ok || !response.data || typeof response.data !== 'object' || Array.isArray(response.data) || ['invalidStaffIdList', 'flowControlledStaffIdList'].some(name => response.data[name] !== undefined && !Array.isArray(response.data[name]))) return { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' }
        return { status: 'accepted' }
      } catch { return { status: 'unknown', errorCode: 'SOCIAL_SEND_UNKNOWN' } }
      finally { ownerSending = false }
    },
    async sendText({ conversation, text: content, replyToMessageId }) {
      if (!identity || stopped) return { status: 'failed', errorCode: 'SOCIAL_NOT_CONNECTED' }
      if (!text(content, 8000)) return { status: 'failed', errorCode: 'SOCIAL_INVALID_TEXT' }
      if (!conversation || !['direct', 'group'].includes(conversation.type) || !text(conversation.id) || conversation.guildId !== undefined) return { status: 'failed', errorCode: 'SOCIAL_UNSUPPORTED_TARGET' }
      // Session webhook supports text, not quoting a specific message. Never silently fake a reply.
      if (replyToMessageId !== undefined) return { status: 'failed', errorCode: 'SOCIAL_REPLY_UNSUPPORTED' }
      const route = hooks.get(key(conversation))
      if (!route || route.expires <= now()) { if (route && !retainDingTalkRoute(route, now())) hooks.delete(key(conversation)); return { status: 'failed', errorCode: 'SOCIAL_WEBHOOK_EXPIRED' } }
      if (sending || now() - lastSend < sendIntervalMs) return { status: 'failed', errorCode: 'SOCIAL_RATE_LIMITED' }
      sending = true; lastSend = now(); const generation = epoch
      try { return await sendWebhook(route, content, generation) }
      finally { sending = false }
    },
  }
}
