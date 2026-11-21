const ENDPOINTS = Object.freeze({
  'cn-beijing': workspace => `https://${workspace}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`,
  'ap-southeast-1': workspace => `https://${workspace}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`,
})
const MODEL_IDS = new Set(['qwen-audio-3.1-tts-flash', 'qwen-audio-3.1-tts-plus'])
const EMOTION_TAGS = Object.freeze(['sad', 'amazed', 'angry', 'excited', 'sarcastic', 'curious', 'bored', 'tired', 'scornful', 'shouting', 'panicked', 'mischievously', 'empathetic', 'whispers', 'reluctantly', 'crying', 'serious'])
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024

const failure = (code, message = code, extra = {}) => Object.assign(new Error(message), { code, ...extra })

function validateBinding(binding) {
  if (!binding || binding.providerId !== 'aliyun-qwen-tts') throw failure('VOICE_PROVIDER_UNAVAILABLE')
  if (!Object.hasOwn(ENDPOINTS, binding.region) || typeof binding.workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(binding.workspaceId)) throw failure('VOICE_PROVIDER_NOT_CONFIGURED')
  if (!MODEL_IDS.has(binding.modelId)) throw failure('VOICE_MODEL_UNSUPPORTED')
  if (typeof binding.voiceId !== 'string' || !binding.voiceId.trim() || binding.voiceId.length > 200) throw failure('VOICE_NOT_CONFIGURED')
}

async function* parseSse(body, signal) {
  let pending = '', received = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for await (const chunk of body) {
    if (signal?.aborted) throw failure('TTS_CANCELLED')
    received += chunk.byteLength
    if (received > MAX_RESPONSE_BYTES * 2) throw failure('TTS_LIMIT_EXCEEDED')
    try { pending += decoder.decode(chunk, { stream: true }) }
    catch { throw failure('TTS_INVALID_RESPONSE') }
    if (pending.length > 4 * 1024 * 1024) throw failure('TTS_INVALID_RESPONSE')
    let boundary
    while ((boundary = pending.search(/\r?\n\r?\n/)) >= 0) {
      const frame = pending.slice(0, boundary)
      pending = pending.slice(boundary + (pending[boundary] === '\r' ? 4 : 2))
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data || data === '[DONE]') continue
      let value
      try { value = JSON.parse(data) } catch { throw failure('TTS_INVALID_RESPONSE') }
      yield value
    }
  }
  try { pending += decoder.decode() }
  catch { throw failure('TTS_INVALID_RESPONSE') }
  if (pending.trim()) {
    const data = pending.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (data) { try { yield JSON.parse(data) } catch { throw failure('TTS_INVALID_RESPONSE') } }
  }
}

function normalizedFormat(format) {
  if (format === 'pcm') return { codec: 'pcm_s16le', sampleRate: 24000, channels: 1 }
  throw failure('TTS_FORMAT_UNSUPPORTED')
}

function normalizedRate(value = 0) {
  if (!Number.isInteger(value) || value < -10 || value > 10) throw failure('TTS_INVALID_RATE')
  return value < 0 ? 1 + value * 0.05 : 1 + value * 0.1
}

/** One full-text Qwen TTS request. SSE audio frames are transport chunks only. */
export function createAliyunQwenTts({ env = process.env, fetcher = globalThis.fetch, timeoutMs = 60000, maxAudioBytes = MAX_RESPONSE_BYTES } = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('fetch is required')
  function inspect(binding) {
    const configured = binding?.providerId === 'aliyun-qwen-tts'
    const apiKey = binding?.credentialRef === 'DASHSCOPE_API_KEY' ? env.DASHSCOPE_API_KEY : null
    return { supported: true, providerId: 'aliyun-qwen-tts', configured, credentialConfigured: typeof apiKey === 'string' && apiKey.trim().length > 0, audioOutput: 'stream', emotionSupported: MODEL_IDS.has(binding?.modelId), emotionTags: MODEL_IDS.has(binding?.modelId) ? [...EMOTION_TAGS] : [] }
  }
  return {
    id: 'aliyun-qwen-tts',
    inspect,
    async listVoices(binding) {
      if (binding?.providerId !== 'aliyun-qwen-tts' || !MODEL_IDS.has(binding.modelId)) throw failure('VOICE_MODEL_UNSUPPORTED')
      return [{ id: 'longanhuan_v3.1', name: '龙安欢', language: 'zh-CN', description: 'Qwen Audio TTS 系统音色', sample: null, source: 'https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list', verifiedAt: null }]
    },
    synthesize({ binding, text, expressionTag = null, operationId, signal, format = 'pcm' }) {
      validateBinding(binding)
      if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw failure('TTS_INVALID_TEXT')
      if (expressionTag !== null && !EMOTION_TAGS.includes(expressionTag)) throw failure('TTS_INVALID_EXPRESSION')
      const credential = binding.credentialRef === 'DASHSCOPE_API_KEY' ? env.DASHSCOPE_API_KEY : null
      if (typeof credential !== 'string' || !credential.trim()) throw failure('MISSING_CREDENTIAL')
      const audioFormat = normalizedFormat(format)
      const url = ENDPOINTS[binding.region](binding.workspaceId)
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(failure('TTS_TIMEOUT')), timeoutMs)
      const synthesisText = expressionTag ? `[${expressionTag}]${text}` : text
      const request = fetcher(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'X-DashScope-SSE': 'enable' },
        body: JSON.stringify({ model: binding.modelId, input: { text: synthesisText, voice: binding.voiceId, format, sample_rate: 24000, rate: normalizedRate(binding.rate) } }),
        signal: controller.signal,
        redirect: 'error',
      })
      return (async function* () {
        let total = 0, completed = false, firstAudioAt = null, requestId = operationId || null
        try {
          const response = await request
          if (!response.ok) {
            const errorCode = response.status === 401 || response.status === 403 ? 'INVALID_CREDENTIAL' : response.status === 429 ? 'TTS_RATE_LIMITED' : 'TTS_PROVIDER_FAILED'
            throw failure(errorCode, `Aliyun TTS returned ${response.status}`)
          }
          if (!response.body) throw failure('TTS_INVALID_RESPONSE')
          for await (const item of parseSse(response.body, controller.signal)) {
            const output = item?.output
            if (!output || typeof output !== 'object') throw failure('TTS_INVALID_RESPONSE')
            if (typeof item.request_id === 'string') requestId = item.request_id
            if (output.finish_reason && output.finish_reason !== 'null' && output.finish_reason !== 'stop') throw failure('TTS_PROVIDER_FAILED')
            const data = output.audio?.data
            if (data) {
              if (typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw failure('TTS_INVALID_AUDIO')
              const bytes = Buffer.from(data, 'base64')
              if (!bytes.length || bytes.length > maxAudioBytes || total + bytes.length > maxAudioBytes) throw failure('TTS_LIMIT_EXCEEDED')
              total += bytes.length; firstAudioAt ??= Date.now()
              yield { type: 'audio', data: new Uint8Array(bytes), format: audioFormat, firstAudioAt }
            }
            if (output.finish_reason === 'stop') {
              if (!total) throw failure('TTS_EMPTY_AUDIO')
              completed = true
              yield { type: 'complete', receipt: { requestId, bytes: total } }
              return
            }
          }
          if (!completed) throw failure('TTS_INCOMPLETE')
        } catch (error) {
          if (controller.signal.aborted) {
            const reason = controller.signal.reason
            if (reason?.code) throw reason
            throw failure(signal?.aborted ? 'TTS_CANCELLED' : 'TTS_TIMEOUT')
          }
          throw error
        } finally {
          clearTimeout(timer); signal?.removeEventListener('abort', abort)
          if (!completed) controller.abort()
        }
      })()
    },
  }
}

export const ALIYUN_QWEN_EMOTION_TAGS = EMOTION_TAGS
