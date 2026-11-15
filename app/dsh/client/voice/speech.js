import { encodePcm16Wav } from '../../../shared/audio/wav.js'

function toBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  return btoa(binary)
}

export function createDshSpeech({ remote, getRemote, audioStore } = {}) {
  let currentRemote = remote || null
  const currentContext = () => getRemote ? getRemote() : currentRemote
  const currentSpeech = () => currentContext()?.remote?.speech || null
  let catalog = null

  function unwrap(result, label) {
    if (result?.ok === false) {
      const error = result.error || {}
      throw Object.assign(new Error(error.message || `${label} failed`), { code: error.code || 'DSH_SPEECH_REMOTE_FAILED', outcome: error.outcome || 'unknown' })
    }
    if (result?.ok === true && Object.hasOwn(result, 'value')) return result.value
    return result
  }

  async function refresh() {
    const speech = currentSpeech()
    if (!speech || typeof speech.catalog !== 'function') {
      catalog = null
      return { available: false, reason: 'DSH_SPEECH_REMOTE_UNAVAILABLE' }
    }
    catalog = unwrap(await speech.catalog(), 'Speech catalog')
    const selection = catalog?.selection
    const provider = Array.isArray(catalog?.providers) ? catalog.providers.find(item => item.id === selection?.providerId) : null
    const ready = provider?.preparation?.phase === 'ready'
    return { available: ready, selection: selection || null, catalog, reason: ready ? null : provider ? 'DSH_SPEECH_NOT_READY' : 'DSH_SPEECH_PROVIDER_UNAVAILABLE' }
  }

  const recognition = {
    async inspect() { return refresh() },
    async transcribe(clipRef, { selection, operation } = {}) {
      const speech = currentSpeech()
      if (!speech || typeof speech.transcribe !== 'function') throw Object.assign(new Error('DSH Speech Remote is not mounted'), { code: 'DSH_SPEECH_REMOTE_UNAVAILABLE', outcome: 'not_applied' })
      if (!audioStore || typeof audioStore.read !== 'function') throw new TypeError('audioStore is required')
      const pinned = selection || catalog?.selection
      if (!pinned?.providerId || !pinned?.language) throw Object.assign(new Error('Speech provider selection is missing'), { code: 'DSH_SPEECH_SELECTION_INVALID', outcome: 'not_applied' })
      const wav = encodePcm16Wav(audioStore.read(clipRef), { sampleRate: 16000, channels: 1 })
      if (catalog?.maxAudioBytes && wav.byteLength > catalog.maxAudioBytes) throw Object.assign(new Error('Audio exceeds DSH Speech Remote limit'), { code: 'VOICE_ASR_AUDIO_LIMIT', outcome: 'not_applied' })
      const result = unwrap(await speech.transcribe({ audioBase64: toBase64(wav), providerId: pinned.providerId, language: pinned.language }, operation?.signal), 'Speech transcription')
      if (typeof result?.text !== 'string') throw Object.assign(new Error('DSH Speech Remote returned no final transcript'), { code: 'VOICE_ASR_INVALID', outcome: 'unknown' })
      return { text: result.text }
    },
  }

  return {
    recognition,
    async inspect() { return refresh() },
    async prepare(providerId, options) {
      const speech = currentSpeech()
      if (!speech || typeof speech.prepare !== 'function') throw Object.assign(new Error('DSH Speech Remote is not mounted'), { code: 'DSH_SPEECH_REMOTE_UNAVAILABLE' })
      return unwrap(await speech.prepare(providerId, options), 'Speech preparation')
    },
    async cancelPreparation(providerId) {
      const speech = currentSpeech()
      if (!speech || typeof speech.cancelPreparation !== 'function') throw Object.assign(new Error('DSH Speech preparation cancellation is unavailable'), { code: 'DSH_SPEECH_REMOTE_UNAVAILABLE' })
      return unwrap(await speech.cancelPreparation(providerId), 'Speech preparation cancellation')
    },
    async *follow(signal) {
      const speech = currentSpeech()
      if (!speech || typeof speech.follow !== 'function') throw Object.assign(new Error('DSH Speech readiness Remote is not mounted'), { code: 'DSH_SPEECH_REMOTE_UNAVAILABLE' })
      const context = currentContext()
      if (!context || typeof context.remote?.$stream !== 'function') throw Object.assign(new Error('DSH Speech stream transport is unavailable'), { code: 'DSH_SPEECH_REMOTE_UNAVAILABLE' })
      const stream = context.remote.$stream({
        name: 'Chonky Fish speech readiness',
        open: abortSignal => speech.follow(abortSignal),
        ended: () => Object.assign(new Error('Speech readiness stream ended'), { code: 'DSH_SPEECH_FOLLOW_ENDED' }),
      })
      const abort = () => { void stream.dispose() }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      try {
        for await (const item of stream) {
          const value = unwrap(item?.value, 'Speech readiness')
          catalog = value
          item?.accept?.()
          yield value
        }
      } finally {
        signal?.removeEventListener('abort', abort)
        await stream.dispose()
      }
    },
    get catalog() { return catalog },
    setRemote(value) { currentRemote = value || null; catalog = null },
    get available() { return typeof currentSpeech()?.catalog === 'function' },
  }
}
