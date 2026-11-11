import { randomUUID } from 'node:crypto'
import { fail, text } from '../core.js'

function id(value) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 256) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  fail('SOCIAL_PROTOCOL_ID_INVALID')
}
function targetId(value, version) {
  if (version === 12) return id(value)
  const result = id(value)
  if (!/^[1-9][0-9]*$/.test(result) || !Number.isSafeInteger(Number(result))) fail('SOCIAL_PROTOCOL_ID_INVALID')
  return Number(result)
}
function referenceKey(conversation, messageId) { return JSON.stringify([conversation.type, conversation.guildId ?? '', conversation.id, messageId]) }
function segments(value) {
  // Never interpret raw CQ strings or allow CQ text injection on sending.
  if (!Array.isArray(value)) return []
  return value.filter(item => item && typeof item.type === 'string' && item.data && typeof item.data === 'object')
}
export function normalizeEvent(event, config, self, version, knownSelfMessageIds = new Set()) {
  if (!event || typeof event !== 'object') return null
  if (version === 11 ? event.post_type !== 'message' : event.type !== 'message') return null
  const eventSelf = version === 11 ? id(event.self_id) : id(event.self?.user_id)
  if (eventSelf !== self.protocolUserId || (version === 12 && event.self?.platform !== config.platform)) fail('SOCIAL_EVENT_IDENTITY_MISMATCH')
  const kind = version === 11 ? event.message_type : event.detail_type
  let conversation
  if (kind === 'private') conversation = { type: 'direct', id: id(event.user_id) }
  else if (kind === 'group') conversation = { type: 'group', id: id(event.group_id) }
  else if (kind === 'channel' && version === 12) conversation = { type: 'channel', id: id(event.channel_id), guildId: id(event.guild_id) }
  else return null
  const parts = segments(event.message)
  const content = parts.filter(part => part.type === 'text' && typeof part.data.text === 'string').map(part => part.data.text).join('')
  if (!content.trim()) return null
  const senderId = id(event.user_id ?? event.sender?.user_id)
  const mentionsSelf = parts.some(part => (part.type === 'at' && String(part.data.qq) === self.protocolUserId) || (part.type === 'mention' && String(part.data.user_id) === self.protocolUserId))
  return {
    connectionId: config.id, platform: config.platform, provider: config.provider, self,
    messageId: id(version === 11 ? event.message_id : event.message_id ?? event.id), conversation,
    sender: { id: senderId, ...(text(event.sender?.nickname) ? { name: event.sender.nickname } : {}), ...(typeof event.sender?.is_bot === 'boolean' ? { isBot: event.sender.is_bot } : {}) },
    text: content, sentAt: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time * 1000 : Date.now(), mentionsSelf,
    // Only bounded, observed own sends prove reply authorship; no nickname/ID guessing.
    replyToSelf: parts.some(part => part.type === 'reply' && knownSelfMessageIds.has(referenceKey(conversation, String(version === 11 ? part.data.id : part.data.message_id)))),
  }
}

export function createOneBotDriver(config, { version = 11, token, socketFactory = url => new WebSocket(url), actionTimeoutMs = 10000, reconnectMs = 1000, maxReconnectMs = 30000, maxFrameBytes = 1024 * 1024 } = {}) {
  let socket = null, callbacks = null, identity = null, stopped = true, timer = null, handshakeTimer = null, retry = 0, epoch = 0, processingMessages = 0
  const pending = new Map(), ownMessageIds = new Set()
  function rememberOwn(conversation, messageId) {
    ownMessageIds.add(referenceKey(conversation, messageId))
    while (ownMessageIds.size > 256) ownMessageIds.delete(ownMessageIds.values().next().value)
  }
  function status(value, reason) { try { callbacks?.onStatus(value, reason) } catch {} }
  function clearPending() {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error('SOCIAL_CONNECTION_LOST'), { code: 'SOCIAL_CONNECTION_LOST' })) }
    pending.clear()
  }
  function action(actionName, params = {}) {
    if (!socket || socket.readyState !== 1) return Promise.reject(Object.assign(new Error('SOCIAL_NOT_CONNECTED'), { code: 'SOCIAL_NOT_CONNECTED' }))
    if (pending.size >= 128) return Promise.reject(Object.assign(new Error('SOCIAL_BACKPRESSURE'), { code: 'SOCIAL_BACKPRESSURE' }))
    const echo = randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(echo); reject(Object.assign(new Error('SOCIAL_ACTION_TIMEOUT'), { code: 'SOCIAL_ACTION_TIMEOUT' })) }, actionTimeoutMs)
      pending.set(echo, { resolve, reject, timer: timeout })
      try { socket.send(JSON.stringify({ action: actionName, params, echo, ...(version === 12 && identity ? { self: { platform: config.platform, user_id: identity.protocolUserId } } : {}) })) }
      catch { clearTimeout(timeout); pending.delete(echo); reject(Object.assign(new Error('SOCIAL_WRITE_UNKNOWN'), { code: 'SOCIAL_WRITE_UNKNOWN' })) }
    })
  }
  function scheduleReconnect() {
    if (stopped || timer) return
    const delay = Math.min(maxReconnectMs, reconnectMs * 2 ** Math.min(retry++, 10))
    timer = setTimeout(() => { timer = null; connect() }, delay)
    timer.unref?.()
  }
  async function getSelfIdentity() {
    const requestedEpoch = epoch
    const info = await action(version === 11 ? 'get_login_info' : 'get_self_info')
    const protocolUserId = id(info?.user_id)
    if (version === 11 && (!/^[1-9][0-9]*$/.test(protocolUserId) || !Number.isSafeInteger(Number(protocolUserId)))) fail('SOCIAL_PROTOCOL_ID_INVALID')
    if (version === 12) {
      if (info?.platform !== undefined && info.platform !== config.platform) fail('SOCIAL_EVENT_IDENTITY_MISMATCH')
      if (info?.platform === undefined) {
        const state = await action('get_status')
        if (!Array.isArray(state?.bots) || !state.bots.some(bot => bot?.self?.platform === config.platform && String(bot.self.user_id) === protocolUserId)) fail('SOCIAL_EVENT_IDENTITY_MISMATCH')
      }
    }
    if (stopped || requestedEpoch !== epoch || socket?.readyState !== 1) fail('SOCIAL_CONNECTION_LOST')
    identity = { connectionId: config.id, platform: config.platform, provider: config.provider, protocolUserId,
      ...(version === 11 ? { platformUserId: protocolUserId } : {}),
      ...(text(info?.nickname ?? info?.user_displayname ?? info?.user_name) ? { displayName: info.nickname ?? info.user_displayname ?? info.user_name } : {}), verifiedAt: new Date().toISOString() }
    return structuredClone(identity)
  }
  function connect() {
    if (stopped) return
    const current = ++epoch
    identity = null
    ownMessageIds.clear()
    status('starting')
    try {
      const url = new URL(config.endpoint)
      // OneBot access_token query authentication; never return/log this URL.
      if (token) url.searchParams.set('access_token', token)
      socket = socketFactory(url.toString())
    } catch { status('error', 'SOCIAL_CONNECT_FAILED'); scheduleReconnect(); return }
    const ws = socket
    clearTimeout(handshakeTimer)
    handshakeTimer = setTimeout(() => {
      if (!stopped && current === epoch) { status('error', 'SOCIAL_HANDSHAKE_TIMEOUT'); ws.close() }
    }, actionTimeoutMs * 3)
    handshakeTimer.unref?.()
    ws.addEventListener('open', async () => {
      if (stopped || current !== epoch) return
      try { await getSelfIdentity(); if (current === epoch && !stopped) { clearTimeout(handshakeTimer); handshakeTimer = null; retry = 0; status('connected') } }
      catch { if (current === epoch && !stopped) { status('error', 'SOCIAL_HANDSHAKE_FAILED'); ws.close() } }
    })
    ws.addEventListener('message', async payload => {
      if (stopped || current !== epoch) return
      try {
        if (typeof payload.data !== 'string' || Buffer.byteLength(payload.data) > maxFrameBytes) fail('SOCIAL_FRAME_INVALID')
        const event = JSON.parse(payload.data)
        if (event.echo !== undefined && pending.has(String(event.echo))) {
          const entry = pending.get(String(event.echo)); pending.delete(String(event.echo)); clearTimeout(entry.timer)
          if ((event.status === 'ok' || event.status === 'async') && (event.retcode === 0 || event.retcode === 1)) entry.resolve(event.data)
          else entry.reject(Object.assign(new Error('SOCIAL_ACTION_REJECTED'), { code: 'SOCIAL_ACTION_REJECTED' }))
          return
        }
        if (!identity) return
        const message = normalizeEvent(event, config, identity, version, ownMessageIds)
        if (message?.sender.id === identity.protocolUserId) rememberOwn(message.conversation, message.messageId)
        if (message) {
          if (processingMessages >= 128) fail('SOCIAL_BACKPRESSURE')
          processingMessages++
          try { await callbacks?.onMessage(message) } finally { processingMessages-- }
        }
      } catch (error) {
        if (stopped || current !== epoch) return
        status('error', error?.code === 'SOCIAL_EVENT_IDENTITY_MISMATCH' ? error.code : 'SOCIAL_EVENT_REJECTED')
        // Fail closed, then reconnect with fresh identity; never leave an open but permanently muted socket.
        ws.close()
      }
    })
    ws.addEventListener('error', () => { if (current === epoch && !stopped) status('error', 'SOCIAL_SOCKET_ERROR') })
    ws.addEventListener('close', () => {
      if (current !== epoch) return
      clearTimeout(handshakeTimer); handshakeTimer = null
      identity = null; clearPending()
      if (!stopped) { status('disconnected'); scheduleReconnect() }
    })
  }
  return {
    connectionId: config.id,
    async start(value) { if (!stopped) return; callbacks = value; stopped = false; connect() },
    async stop() { stopped = true; epoch++; clearTimeout(timer); clearTimeout(handshakeTimer); timer = null; handshakeTimer = null; clearPending(); identity = null; const ws = socket; socket = null; try { ws?.close() } catch {} },
    getSelfIdentity,
    async sendText({ conversation, text: content, replyToMessageId }) {
      if (!identity || stopped) return { status: 'failed', errorCode: 'SOCIAL_NOT_CONNECTED' }
      const sendEpoch = epoch
      try {
        if (!text(content, 8000)) fail('SOCIAL_INVALID_TEXT')
        const message = [{ type: 'text', data: { text: content } }]
        if (replyToMessageId) message.unshift({ type: 'reply', data: { [version === 11 ? 'id' : 'message_id']: id(replyToMessageId) } })
        let name, params
        if (version === 11) {
          if (!['direct', 'group'].includes(conversation.type)) fail('SOCIAL_UNSUPPORTED_TARGET')
          name = conversation.type === 'direct' ? 'send_private_msg' : 'send_group_msg'
          params = { [conversation.type === 'direct' ? 'user_id' : 'group_id']: targetId(conversation.id, version), message }
        } else {
          name = 'send_message'
          params = { detail_type: conversation.type === 'direct' ? 'private' : conversation.type, message }
          if (conversation.type === 'channel') { params.guild_id = id(conversation.guildId); params.channel_id = id(conversation.id) }
          else params[conversation.type === 'direct' ? 'user_id' : 'group_id'] = id(conversation.id)
        }
        const result = await action(name, params)
        if (result?.message_id !== undefined && sendEpoch === epoch) rememberOwn(conversation, id(result.message_id))
        return { status: 'accepted', ...(result?.message_id !== undefined ? { messageId: id(result.message_id) } : {}) }
      } catch (error) {
        const unknown = ['SOCIAL_ACTION_TIMEOUT', 'SOCIAL_CONNECTION_LOST', 'SOCIAL_WRITE_UNKNOWN'].includes(error.code)
        return { status: unknown ? 'unknown' : 'failed', errorCode: unknown ? 'SOCIAL_SEND_UNKNOWN' : 'SOCIAL_SEND_FAILED' }
      }
    },
  }
}
