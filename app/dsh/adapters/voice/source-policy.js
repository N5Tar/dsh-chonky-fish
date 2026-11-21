import { createHash } from 'node:crypto'
import { messageText } from '../../../../core/modules/event-engine/domain/contracts.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const key = (sessionId, submissionId) => `${sessionId}\0${submissionId}`
const promptRules = tags => `本次语音使用的音色支持情绪标记。只在表达确实适合时，可在相应短语前使用这些标记：${tags.map(tag => `[${tag}]`).join('、')}。标记只控制语音表达，不要向用户解释标记，也不要为使用标记而改变内容。`

/** Host-owned source matching and prompt eligibility for the active DSH turn. */
export function createVoiceSourcePolicy({ ctx, repository, getProvider, namespaceId, ownerPath, maxEntries = 512, now = Date.now } = {}) {
  if (typeof repository?.saveLabelRule !== 'function') throw new TypeError('Voice label-rule repository is required')
  if (typeof getProvider !== 'function') throw new TypeError('Voice provider resolver is required')
  const registrations = new Map(), currentEvents = new Map(), sessions = new Map()
  let closed = false
  const trim = map => { while (map.size > maxEntries) map.delete(map.keys().next().value) }
  const liveAgent = sessionId => {
    const agent = ctx?.agents?.get?.(sessionId)
    if (!agent || agent.id !== sessionId || (agent.session?.sessionId ?? agent.session?.id) !== sessionId) return null
    const preset = agent.session?.header?.agentPreset
    const cwd = agent.session?.header?.cwd
    if (preset !== 'chonkyfish' || ownerPath && cwd !== ownerPath) return null
    return agent
  }
  const sourceOfClaim = ({ agent, message, turn } = {}) => {
    if (!agent || typeof agent.id !== 'string' || !message) return
    const sessionId = agent.id
    const state = sessions.get(sessionId) || { sessionId, turn: null, step: null, source: { kind: 'unknown' }, claimed: null }
    const source = message.source || {}
    const requestId = typeof source.rpcId === 'string' ? source.rpcId : null
    const text = messageText(message.content)
    if (source.kind === 'user') {
      const registration = requestId ? registrations.get(key(sessionId, requestId)) : null
      const voice = registration && registration.textDigest === digest(text)
        ? { kind: 'voice', inputId: registration.inputId, submissionId: requestId }
        : requestId ? { kind: 'typed', submissionId: requestId } : { kind: 'unknown' }
      state.source = voice
    } else if (typeof source.kind === 'string' && (source.kind.includes('tool') || source.kind === 'runtime-context' || source.kind === 'time-context')) {
      // Tool work inherits only the source already captured for this turn.
    } else {
      state.source = { kind: 'background' }
    }
    if (Number.isSafeInteger(turn)) {
      if (state.turn !== turn) state.step = 1
      state.turn = turn
      if (agent.phase?.turn === turn && Number.isSafeInteger(agent.phase.step)) state.step = agent.phase.step + 1
    }
    state.claimed = { requestId, textDigest: digest(text), source: state.source, turn: state.turn }
    sessions.set(sessionId, state)
    trim(sessions)
  }
  const offClaim = typeof ctx?.on === 'function' ? ctx.on('agent/inbox/claimed', sourceOfClaim, { global: true }) : null
  const offEvent = typeof ctx?.on === 'function' ? ctx.on('session/event', (session, event) => {
    const sessionId = session?.sessionId ?? session?.id
    if (typeof sessionId !== 'string' || !event || !Number.isSafeInteger(event.seq)) return
    const data = event.data || {}
    const state = sessions.get(sessionId) || { sessionId, turn: null, step: null, source: { kind: 'unknown' }, claimed: null }
    if (event.type === 'assistant/message') {
      if (event.surfaceOp === undefined || event.surfaceOp === 'append') {
        currentEvents.set(`${sessionId}\0${event.seq}`, { sessionId, seq: event.seq, textDigest: digest(messageText(data.message?.content)), current: true })
      } else if (event.surfaceOp?.op === 'replace') {
        for (const [id, row] of currentEvents) if (row.sessionId === sessionId && row.seq >= event.surfaceOp.startSeq && row.seq <= event.surfaceOp.endSeq) currentEvents.delete(id)
      }
    } else if (event.type === 'turn/start' && Number.isSafeInteger(data.turn)) {
      if (state.turn !== data.turn) { state.source = { kind: 'unknown' }; state.step = 1 }
      state.turn = data.turn
    } else if (event.type === 'step/start' && Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)) {
      if (state.turn !== data.turn) { state.turn = data.turn; state.source = { kind: 'unknown' } }
      state.step = data.step + 1
    } else if (event.type === 'turn/end' && Number.isSafeInteger(data.turn) && state.turn === data.turn) {
      state.source = { kind: 'unknown' }
      state.step = null
    } else if (event.type === 'user/message') {
      const rpcId = data.source?.rpcId
      if (typeof rpcId === 'string') registrations.delete(key(sessionId, rpcId))
      if (typeof rpcId === 'string' && state.claimed?.requestId === rpcId) state.claimed.consumed = true
      else if (data.source?.kind === 'user') state.source = typeof rpcId === 'string' ? { kind: 'typed', submissionId: rpcId } : { kind: 'unknown' }
    }
    sessions.set(sessionId, state)
    trim(currentEvents); trim(sessions)
  }, { global: true }) : null

  function register({ conversationRef, inputId, submissionId, text, callRef } = {}) {
    if (closed) throw Object.assign(new Error('Voice source policy is closed'), { code: 'VOICE_SOURCE_CLOSED', outcome: 'not_applied' })
    const sessionId = conversationRef?.conversationId
    if (typeof sessionId !== 'string' || typeof inputId !== 'string' || !inputId || typeof submissionId !== 'string' || !submissionId || typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('Invalid voice source registration'), { code: 'INVALID_ARGUMENT', outcome: 'not_applied' })
    const id = key(sessionId, submissionId), textDigest = digest(text)
    const old = registrations.get(id)
    if (old) {
      if (old.textDigest !== textDigest || old.inputId !== inputId || old.callId !== (callRef?.callId || null)) throw Object.assign(new Error('Voice source registration conflicts'), { code: 'VOICE_SOURCE_CONFLICT', outcome: 'not_applied' })
      return { registered: true, duplicate: true }
    }
    if (registrations.size >= maxEntries) throw Object.assign(new Error('Voice source registration capacity is full'), { code: 'VOICE_SOURCE_CAPACITY', outcome: 'not_applied' })
    registrations.set(id, { sessionId, inputId, submissionId, textDigest, callId: callRef?.callId || null, createdAt: now() })
    return { registered: true }
  }
  function release({ conversationRef, submissionId, callRef } = {}) {
    if (!conversationRef?.conversationId || typeof submissionId !== 'string') return false
    const id = key(conversationRef.conversationId, submissionId), row = registrations.get(id)
    if (!row || row.callId && row.callId !== callRef?.callId) return false
    return registrations.delete(id)
  }
  function assertReply({ conversationRef, source, event } = {}) {
    if (source?.sessionId !== conversationRef?.conversationId || event?.type !== 'assistant/message' || event.seq !== source.seq) return false
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return false
    const observed = currentEvents.get(`${source.sessionId}\0${source.seq}`)
    return Boolean(observed?.current && observed.textDigest === digest(messageText(event.data?.message?.content)))
  }
  function authorizeSession({ sessionId, conversationRef } = {}) {
    if (typeof sessionId !== 'string') return false
    if (sessionId === conversationRef?.conversationId) return true
    return Boolean(liveAgent(sessionId))
  }
  function render(context = {}) {
    if (closed || repository.modelHistoryProjectionVerified !== true) return ''
    try {
      const agent = context.agent
      const sessionId = agent?.session?.sessionId ?? agent?.session?.id ?? agent?.id
      const live = typeof sessionId === 'string' ? liveAgent(sessionId) : null
      if (!live || agent?.id && agent.id !== live.id) return ''
      const state = sessions.get(sessionId)
      if (!state || state.source.kind !== 'voice' || !Number.isSafeInteger(state.turn) || !Number.isSafeInteger(state.step)) return ''
      const provider = getProvider()
      const tags = provider?.capabilities?.emotionTags
      if (!provider?.credentialConfigured || provider.providerId !== 'aliyun-qwen-tts' || !provider.emotion?.supported || !Array.isArray(tags) || !tags.length) return ''
      const rule = { providerId: provider.providerId, modelId: provider.modelId, voiceId: provider.voiceId, tags: [...tags], inputId: state.source.inputId, submissionId: state.source.submissionId, turn: state.turn, step: state.step }
      const requestId = `${sessionId}:${state.turn}:${state.step}`
      const owner = { namespaceId: String(namespaceId || ownerPath || 'chonkyfish'), sessionId }
      const saved = repository.saveLabelRule({ requestId, owner, rule })
      if (saved !== true && saved?.saved !== true) return ''
      return promptRules(tags)
    } catch { return '' }
  }
  function close() {
    if (closed) return
    closed = true
    try { offClaim?.() } catch {}
    try { offEvent?.() } catch {}
    registrations.clear(); currentEvents.clear(); sessions.clear()
  }
  return { register, release, assertReply, authorizeSession, render, close, dispose: close, inspect() { return { registrations: registrations.size, currentSources: currentEvents.size, sessions: sessions.size } } }
}
