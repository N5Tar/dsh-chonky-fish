import { createAliyunQwenTts } from './aliyun-qwen-tts.js'

function createWindowsAdapter(tts) {
  return {
    id: 'windows-system-speech',
    inspect() { return { ...(tts?.inspect?.() || {}), providerId: 'windows-system-speech', audioOutput: 'complete', emotionSupported: false, emotionTags: [] } },
    listVoices() { return tts?.listVoices?.() || Promise.resolve([]) },
    async *synthesize({ binding, text, signal }) {
      const result = await tts.synthesize({ text, voiceId: binding.voiceId || null, rate: binding.rate || 0, signal })
      yield { type: 'audio', data: new Uint8Array(result.wav), format: { codec: 'wav', sampleRate: result.info.sampleRate, channels: result.info.channels } }
      yield { type: 'complete', receipt: { bytes: result.wav.length, durationMs: result.info.durationMs } }
    },
  }
}

/** Single-provider binding resolver. Windows remains the legacy unconfigured default. */
export function createVoiceProviders({ getConfig, windowsTts, env = process.env, fetcher } = {}) {
  if (typeof getConfig !== 'function') throw new TypeError('getConfig is required')
  const aliyun = createAliyunQwenTts({ env, ...(fetcher ? { fetcher } : {}) })
  const windows = createWindowsAdapter(windowsTts)
  function getBinding() {
    const tts = getConfig()?.voice?.tts || {}
    return { providerId: tts.providerId || 'windows-system-speech', ...tts }
  }
  function getProvider() {
    const binding = getBinding()
    const provider = binding.providerId === 'aliyun-qwen-tts' ? aliyun : binding.providerId === 'windows-system-speech' ? windows : null
    if (!provider) return null
    const capabilities = provider.inspect(binding)
    return {
      providerId: provider.id, modelId: binding.modelId || null, voiceId: binding.voiceId || null,
      audioOutput: capabilities.audioOutput || 'complete',
      emotion: { supported: capabilities.emotionSupported === true, tags: capabilities.emotionSupported ? ['sad', 'excited', 'empathetic', 'serious'] : [] },
      capabilities, binding, credentialConfigured: capabilities.credentialConfigured !== false,
    }
  }
  function providerFor(binding = getBinding()) { return binding.providerId === 'aliyun-qwen-tts' ? aliyun : binding.providerId === 'windows-system-speech' ? windows : null }
  function getEmotionPrompt(binding = getBinding()) {
    const capabilities = providerFor(binding)?.inspect(binding)
    if (!capabilities?.emotionSupported) return null
    // Capability discovery is informational. Conversation prompting remains
    // gated until Host event/source projection has been runtime verified.
    return null
  }
  return {
    getProvider, getVoiceProvider: getProvider, getBinding, providerFor, getEmotionPrompt,
    inspect(binding = getBinding()) { return providerFor(binding)?.inspect(binding) || { supported: false, providerId: binding.providerId, audioOutput: 'unknown', emotionSupported: false, reason: 'VOICE_PROVIDER_UNAVAILABLE' } },
    async listVoices(binding = getBinding()) { const provider = providerFor(binding); return provider ? provider.listVoices(binding) : [] },
    close() { windowsTts?.close?.() },
  }
}

export { createAliyunQwenTts }
