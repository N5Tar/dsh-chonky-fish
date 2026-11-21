import assert from 'node:assert/strict'
import { createAliyunQwenTts } from '../providers/aliyun-qwen-tts.js'

const chunks = [Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0])]
const frame = value => Buffer.from(`data: ${JSON.stringify(value)}\n\n`)
let request
const provider = createAliyunQwenTts({
  env: { DASHSCOPE_API_KEY: 'secret-test-key' },
  fetcher: async (url, init) => {
    request = { url, init }
    const values = [
      { request_id: 'req-1', output: { finish_reason: 'null', type: 'sentence-synthesis', audio: { data: chunks[0].toString('base64') } } },
      { request_id: 'req-1', output: { finish_reason: 'stop', audio: { data: chunks[1].toString('base64') } } },
    ]
    return { ok: true, body: { async *[Symbol.asyncIterator]() { for (const value of values) yield frame(value) } } }
  },
})
const binding = { providerId: 'aliyun-qwen-tts', region: 'cn-beijing', workspaceId: 'workspace_123', credentialRef: 'DASHSCOPE_API_KEY', modelId: 'qwen-audio-3.1-tts-flash', voiceId: 'longanhuan_v3.1' }
assert.equal(provider.inspect(binding).credentialConfigured, true)
const results = []
for await (const event of provider.synthesize({ binding: { ...binding, rate: 5 }, text: '整条回复。', expressionTag: 'empathetic', operationId: 'op-1' })) results.push(event)
assert.equal(results.length, 3)
assert.deepEqual(Buffer.from(results[0].data), chunks[0])
assert.deepEqual(results.at(-1).type, 'complete')
assert.equal(request.url, 'https://workspace_123.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer')
assert.equal(request.init.headers['X-DashScope-SSE'], 'enable')
assert.equal(request.init.headers.authorization, 'Bearer secret-test-key')
const payload = JSON.parse(request.init.body)
assert.equal(payload.input.text, '[empathetic]整条回复。')
assert.equal(payload.input.format, 'pcm')
assert.equal(payload.input.sample_rate, 24000)
assert.equal(payload.input.rate, 1.5)

const incomplete = createAliyunQwenTts({ env: { DASHSCOPE_API_KEY: 'key' }, fetcher: async () => ({ ok: true, body: { async *[Symbol.asyncIterator]() { yield frame({ output: { finish_reason: 'null', audio: { data: chunks[0].toString('base64') } } }) } } }) })
await assert.rejects(async () => { for await (const _event of incomplete.synthesize({ binding, text: '未完成。' })) {} }, { code: 'TTS_INCOMPLETE' })
await assert.rejects(async () => { for await (const _event of provider.synthesize({ binding: { ...binding, workspaceId: 'https://bad' }, text: 'bad' })) {} }, { code: 'VOICE_PROVIDER_NOT_CONFIGURED' })
console.log('Aliyun Qwen TTS provider: SSE parsing, terminal status and endpoint policy passed')
