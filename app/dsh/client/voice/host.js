import { decodePcm16Wav } from '../../../shared/audio/wav.js'
import { createLinearResampler, floatToPcm16 } from '../../../shared/audio/resample.js'

const id = () => globalThis.crypto?.randomUUID?.() || `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`
const sameRef = (a, b) => Boolean(a && b && a.runtimeId === b.runtimeId && a.conversationId === b.conversationId && a.bindingRevision === b.bindingRevision)

export function createDshHostVoice({ routes, audioStore, fetcher = globalThis.fetch?.bind(globalThis) } = {}) {
  if (!routes || !audioStore || typeof fetcher !== 'function') throw new TypeError('routes, audioStore, and fetch are required')
  let hostInfo = null, lease = null, active = null, closed = false
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
    inspect() { return { available: hostInfo?.synthesis?.supported === true, providerId: 'windows-system-speech', voices: hostInfo?.synthesis?.voices || [] } },
    async synthesize(text, voice = {}, { operation } = {}) {
      const current = callData({ callId: lease?.callId, conversation: lease?.conversationRef })
      const opId = operationId(operation), signal = operation?.signal
      const run = { operationId: opId, callId: current.callId }
      active = run
      const cancel = () => {
        const { conversationRef: ignored, ...cancelLease } = current
        void request(routes.voiceCancel, 'POST', { ...cancelLease, operationId: opId }).catch(() => {})
      }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        const result = await request(routes.voiceSynthesis, 'POST', { ...current, operationId: opId, text, voiceId: voice?.voiceId ?? null, rate: voice?.rate ?? 0 }, signal)
        if (active !== run || signal?.aborted) throw Object.assign(new Error('Synthesis was cancelled'), { code: 'TTS_CANCELLED' })
        if (typeof result?.wav !== 'string') throw Object.assign(new Error('Host returned no WAV'), { code: 'TTS_INVALID_WAV' })
        const binary = atob(result.wav), wav = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) wav[i] = binary.charCodeAt(i)
        const decoded = decodePcm16Wav(wav, { maxBytes: 2 * 1024 * 1024, maxSeconds: 30 })
        const mono = new Float32Array(decoded.sampleCount)
        for (let i = 0; i < decoded.sampleCount; i++) {
          let total = 0
          for (let channel = 0; channel < decoded.channels; channel++) total += decoded.samples[i * decoded.channels + channel] / 32768
          mono[i] = total / decoded.channels
        }
        const resampled = createLinearResampler(decoded.sampleRate, 16000).process(mono)
        const pcm = floatToPcm16(resampled)
        const clipRef = audioStore.putClip(pcm, { sampleRate: 16000, channels: 1, sampleCount: pcm.length })
        return { clipRef }
      } finally { signal?.removeEventListener('abort', cancel); if (active === run) active = null }
    },
    release(clipRef) { return audioStore.release(clipRef) },
  }

  return {
    capabilities,
    ownership,
    synthesis,
    close() { if (active && lease) { const { conversationRef: ignored, ...cancelLease } = callData({ callId: lease.callId, conversation: lease.conversationRef }); void request(routes.voiceCancel, 'POST', { ...cancelLease, operationId: active.operationId }).catch(() => {}) } closed = true; lease = null; hostInfo = null },
    get state() { return { hostInfo, lease: lease && { callId: lease.callId, serviceGeneration: lease.serviceGeneration } } },
  }
}
