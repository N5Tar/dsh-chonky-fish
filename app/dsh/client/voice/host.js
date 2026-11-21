const id = () => globalThis.crypto?.randomUUID?.() || `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`
const sameRef = (a, b) => Boolean(a && b && a.runtimeId === b.runtimeId && a.conversationId === b.conversationId && a.bindingRevision === b.bindingRevision)
function decodeBase64(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('Host audio frame is missing base64 data'), { code: 'VOICE_AUDIO_FRAME' })
  const binary = atob(value), bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
function queryUrl(endpoint, values) {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== null) params.set(key, String(value)) })
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${params.toString()}`
}
async function readSse(endpoint, body, { fetcher, signal, onError } = {}) {
  const response = await fetcher(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) })
  if (!response.ok) {
    let payload = null
    try { payload = await response.json() } catch {}
    const code = payload?.error?.code || `VOICE_HOST_REQUEST_${response.status}`
    throw Object.assign(new Error(code), { code, status: response.status, outcome: payload?.error?.outcome || 'not_applied' })
  }
  if (!response.body?.getReader) throw Object.assign(new Error('Host did not return a readable event stream'), { code: 'VOICE_STREAM_UNAVAILABLE', outcome: 'unknown' })
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', completed = false, cancelled = false
  async function* events() {
    try {
      while (true) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
        let boundary
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index).replace(/\r/g, '')
          buffer = buffer.slice(boundary.index + boundary[0].length)
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (!data) continue
          let item
          try { item = JSON.parse(data) } catch { throw Object.assign(new Error('Host returned an invalid audio event'), { code: 'VOICE_STREAM_EVENT_INVALID', outcome: 'unknown' }) }
          if (item.type === 'error') throw Object.assign(new Error(item.code || 'VOICE_SYNTHESIS_FAILED'), { code: item.code || 'VOICE_SYNTHESIS_FAILED', outcome: 'unknown' })
          if (item.type === 'audio') {
            if (!['pcm_s16le', 'wav'].includes(item.format?.codec) || !Number.isInteger(item.format.sampleRate) || ![1, 2].includes(item.format.channels)) throw Object.assign(new Error('Host returned an unsupported audio format'), { code: 'VOICE_AUDIO_FORMAT', outcome: 'unknown' })
            yield { type: 'audio', data: decodeBase64(item.data), format: item.format }
          } else if (item.type === 'complete') {
            completed = true
            yield { type: 'complete', receipt: item.receipt }
            return
          } else {
            throw Object.assign(new Error('Host returned an unknown audio event'), { code: 'VOICE_STREAM_EVENT_INVALID', outcome: 'unknown' })
          }
        }
        if (done) break
      }
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) cancelled = true
      try { onError?.(error) } catch {}
      throw error
    } finally {
      if (!completed) {
        try { await reader.cancel() } catch {}
      }
      try { reader.releaseLock() } catch {}
    }
    if (!completed && !cancelled) throw Object.assign(new Error('Synthesis stream ended before completion'), { code: 'VOICE_SYNTHESIS_INCOMPLETE', outcome: 'unknown' })
  }
  return events()
}

export function createDshHostVoice({ routes, fetcher = globalThis.fetch?.bind(globalThis) } = {}) {
  if (!routes || typeof fetcher !== 'function') throw new TypeError('routes and fetch are required')
  let hostInfo = null, voiceSettings = null, lease = null, active = null, closed = false
  const ownerId = id()

  async function request(endpoint, method, body, signal) {
    if (closed) throw Object.assign(new Error('Voice Host adapter is closed'), { code: 'VOICE_HOST_UNAVAILABLE' })
    const response = await fetcher(endpoint, { method, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ...(signal ? { signal } : {}) })
    let payload
    try { payload = await response.json() } catch { payload = null }
    if (!response.ok || payload?.ok !== true) throw Object.assign(new Error(payload?.error?.code || `Voice Host request failed (${response.status})`), { code: payload?.error?.code || 'VOICE_HOST_REQUEST_FAILED', status: response.status })
    return payload.data === undefined ? payload : payload.data
  }
  function callData(callRef) {
    if (!lease || lease.callId !== callRef?.callId || !sameRef(lease.conversationRef, callRef?.conversation)) throw Object.assign(new Error('Voice Host lease is stale'), { code: 'STALE_LEASE', outcome: 'not_applied' })
    return { callId: lease.callId, ownerId, conversationRef: lease.conversationRef, serviceGeneration: lease.serviceGeneration, leaseGeneration: lease.leaseGeneration }
  }
  function operationId(operation) { return typeof operation?.operationId === 'string' && operation.operationId ? operation.operationId : id() }

  async function capabilities() {
    hostInfo = await request(routes.voiceCapabilities, 'GET')
    return hostInfo
  }

  async function readVoiceSettings() {
    voiceSettings = await request(routes.voiceSettings, 'GET')
    return voiceSettings
  }
  async function updateVoiceSettings(tts) {
    voiceSettings = await request(routes.voiceSettings, 'PUT', { tts })
    return voiceSettings
  }
  function previewBinding(binding) {
    if (binding === undefined) return undefined
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw Object.assign(new TypeError('Voice preview binding is invalid'), { code: 'VOICE_PREVIEW_BINDING_INVALID', outcome: 'not_applied' })
    const value = {}
    for (const key of ['providerId', 'modelId', 'region', 'workspaceId', 'credentialRef']) {
      if (Object.hasOwn(binding, key) && binding[key] !== undefined) value[key] = binding[key]
    }
    return value
  }
  async function registerVoiceSource({ conversationRef, inputId, submissionId, text, operation } = {}) {
    const current = callData({ callId: lease?.callId, conversation: conversationRef })
    if (typeof inputId !== 'string' || !inputId || typeof submissionId !== 'string' || !submissionId || typeof text !== 'string') throw Object.assign(new TypeError('Voice source registration is invalid'), { code: 'VOICE_SOURCE_INVALID', outcome: 'not_applied' })
    return request(routes.voiceSources, 'POST', { ...current, inputId, submissionId, text }, operation?.signal)
  }
  async function releaseVoiceSource({ conversationRef, submissionId, operation } = {}) {
    if (!lease || !sameRef(lease.conversationRef, conversationRef)) return { released: false }
    const current = callData({ callId: lease.callId, conversation: conversationRef })
    if (typeof submissionId !== 'string' || !submissionId) return { released: false }
    return request(routes.voiceSources, 'POST', { action: 'release', ...current, submissionId }, operation?.signal)
  }
  async function* synthesizeReply({ source, voice = {} } = {}, { operation } = {}) {
    const current = callData({ callId: lease?.callId, conversation: lease?.conversationRef })
    if (typeof source?.sessionId !== 'string' || !source.sessionId || !Number.isSafeInteger(source.seq) || source.seq < 0) throw Object.assign(new TypeError('Voice reply source is invalid'), { code: 'VOICE_SOURCE_INVALID', outcome: 'not_applied' })
    const opId = operationId(operation), signal = operation?.signal
    const run = { operationId: opId, callId: current.callId }
    active = run
    const cancel = () => {
      const { conversationRef: ignored, ...cancelLease } = current
      void request(routes.voiceCancel, 'POST', { ...cancelLease, operationId: opId }).catch(() => {})
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const stream = await readSse(routes.voiceSynthesis, { ...current, operationId: opId, source, voiceId: voice?.voiceId ?? null, rate: voice?.rate ?? 0 }, { fetcher, signal })
      for await (const event of stream) {
        if (active !== run || signal?.aborted) throw Object.assign(new Error('Synthesis was cancelled'), { code: 'TTS_CANCELLED', outcome: 'unknown' })
        yield event
      }
    } finally { signal?.removeEventListener('abort', cancel); if (active === run) active = null }
  }
  async function getVoicePreviewCatalog(binding) {
    const selected = previewBinding(binding)
    return request(routes.voicePreview, 'POST', { action: 'catalog', ...(selected === undefined ? {} : { binding: selected }) })
  }
  async function* synthesizeVoicePreview({ operationId: suppliedOperationId, text, voiceId, rate = 0, emotionTag, binding } = {}, { operation } = {}) {
    const opId = suppliedOperationId || operationId(operation)
    const signal = operation?.signal
    const selected = previewBinding(binding)
    const body = { action: 'synthesize', operationId: opId, text, voiceId, rate, ...(emotionTag ? { emotionTag } : {}), ...(selected === undefined ? {} : { binding: selected }) }
    const stream = await readSse(routes.voicePreview, body, { fetcher, signal })
    yield* stream
  }
  async function listStoredAudio(sessionId, seqs, { signal } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || !Array.isArray(seqs) || seqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) throw Object.assign(new TypeError('Stored audio query is invalid'), { code: 'VOICE_AUDIO_QUERY_INVALID' })
    return request(queryUrl(routes.voiceAudio, { sessionId, seqs: seqs.join(',') }), 'GET', undefined, signal)
  }
  async function getStoredAudio(audioId, sessionId, { signal } = {}) {
    const response = await fetcher(queryUrl(routes.voiceAudio, { audioId, sessionId }), { method: 'GET', credentials: 'same-origin', cache: 'no-store', ...(signal ? { signal } : {}) })
    if (!response.ok) {
      let payload = null
      try { payload = await response.json() } catch {}
      const code = payload?.error?.code || `VOICE_AUDIO_${response.status}`
      throw Object.assign(new Error(code), { code, status: response.status })
    }
    const mimeType = response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() || 'audio/wav'
    if (mimeType !== 'audio/wav') throw Object.assign(new Error('Stored audio format is not supported'), { code: 'VOICE_AUDIO_FORMAT' })
    return { data: new Uint8Array(await response.arrayBuffer()), format: { codec: 'wav', mimeType } }
  }

  const ownership = {
    async acquire({ callRef, conversationRef }) {
      const caps = hostInfo || await capabilities()
      const result = await request(routes.voiceCalls, 'POST', { action: 'acquire', callId: callRef.callId, ownerId, conversationRef })
      lease = { callId: callRef.callId, conversationRef, serviceGeneration: result.serviceGeneration || caps.ownership?.serviceGeneration || hostInfo?.ownership?.serviceGeneration, leaseGeneration: result.leaseGeneration }
      if (!lease.serviceGeneration || !lease.leaseGeneration) { lease = null; throw Object.assign(new Error('Host returned an incomplete voice lease'), { code: 'VOICE_LEASE_INVALID' }) }
      return { valid: true, scopeId: `${lease.serviceGeneration}:${lease.leaseGeneration}`, leaseMs: result.expiresInMs || caps.ownership?.leaseMs || 15000 }
    },
    async renew({ callRef }) {
      const current = callData(callRef)
      try {
        const result = await request(routes.voiceCalls, 'POST', { action: 'renew', ...current })
        return { valid: true, scopeId: `${result.serviceGeneration}:${result.leaseGeneration}`, leaseMs: result.expiresInMs || 15000 }
      } catch (error) {
        if (error.status === 409) { lease = null; return { valid: false, reason: error.code } }
        throw error
      }
    },
    async release({ callRef }) {
      if (!lease) return { released: true }
      const current = callData(callRef)
      try { await request(routes.voiceCalls, 'POST', { action: 'release', ...current }) }
      finally { if (lease?.callId === callRef.callId) lease = null }
      return { released: true }
    },
  }

  const synthesis = {
    async inspect() {
      const settings = voiceSettings || await readVoiceSettings()
      const providerId = settings?.tts?.providerId || 'windows-system-speech'
      const available = providerId === 'aliyun-qwen-tts'
        ? settings?.credentialConfigured === true
        : hostInfo?.synthesis?.supported === true
      return { available, providerId, voices: providerId === 'windows-system-speech' ? hostInfo?.synthesis?.voices || [] : [], capabilities: settings?.capabilities || {} }
    },
    synthesizeReply,
  }

  const foregroundRequest = async (action, conversationRef, fields = {}, { includeLease = true } = {}) => {
      if (!hostInfo) { try { await capabilities() } catch { return { status: 'unavailable', reason: 'host-capabilities-unavailable' } } }
      const leaseFields = includeLease && lease && sameRef(lease.conversationRef, conversationRef)
        ? (({ conversationRef: ignored, ...current }) => current)(callData({ callId: lease.callId, conversation: conversationRef }))
        : { serviceGeneration: hostInfo?.ownership?.serviceGeneration }
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      let timer
      try {
        const run = request(routes.voiceForeground, 'POST', { ...leaseFields, action, conversationRef, ...fields }, controller?.signal)
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(Object.assign(new Error('foreground request timed out'), { code: 'FOREGROUND_TIMEOUT' })) }, 1200) })
        return await Promise.race([run, timeout])
      } catch (error) {
        if (error.status === 400 && error.code === 'INVALID_ARGUMENT') {
          try { await capabilities() } catch {}
        }
        return { status: error.status === 409 ? 'stale' : 'unavailable', reason: error.code || 'host-unavailable' }
      } finally { clearTimeout(timer) }
  }
  async function reconcileForeground(conversationRef, interruptionId) {
    let result = { status: 'outcome-unknown', reason: 'receipt-unresolved' }
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await foregroundRequest('query', conversationRef, { interruptionId }, { includeLease: false })
      if (result?.status === 'applied' || result?.status === 'stale') return result
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
    }
    return { status: 'outcome-unknown', reason: result?.reason || 'receipt-unresolved', interruptionId }
  }
  const foreground = {
    async inspect(conversationRef) {
      const result = await foregroundRequest('inspect', conversationRef)
      return result?.available === true && result?.expected ? result : { available: false, valid: result?.valid !== false, reason: result?.reason || result?.status || 'unavailable' }
    },
    async interrupt({ conversationRef, interruptionId, expected, acceptedInputId, acceptedSubmissionId }) {
      const result = await foregroundRequest('interrupt', conversationRef, { interruptionId, expected, acceptedInputId, acceptedSubmissionId })
      if (result?.status === 'applied' || result?.status === 'stale') return result
      return reconcileForeground(conversationRef, interruptionId)
    },
    query({ conversationRef, interruptionId }) {
      return reconcileForeground(conversationRef, interruptionId)
    },
  }

  return {
    capabilities,
    ownership,
    synthesis,
    foreground,
    readVoiceSettings,
    updateVoiceSettings,
    registerVoiceSource,
    releaseVoiceSource,
    synthesizeReply,
    getVoicePreviewCatalog,
    synthesizeVoicePreview,
    listStoredAudio,
    getStoredAudio,
    close() { if (active && lease) { const { conversationRef: ignored, ...cancelLease } = callData({ callId: lease.callId, conversation: lease.conversationRef }); void request(routes.voiceCancel, 'POST', { ...cancelLease, operationId: active.operationId }).catch(() => {}) } closed = true; lease = null; hostInfo = null; voiceSettings = null },
    get state() { return { hostInfo, lease: lease && { callId: lease.callId, serviceGeneration: lease.serviceGeneration } } },
  }
}
