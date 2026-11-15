import assert from 'node:assert/strict'
import { createDshSpeech } from '../speech.js'

let context
const accepted = []
let transcribeRequest
const catalog = {
  selection: { providerId: 'sensevoice', language: 'zh-CN' },
  maxAudioBytes: 1024 * 1024,
  providers: [{ id: 'sensevoice', preparation: { phase: 'ready' } }],
}
const stream = {
  async *[Symbol.asyncIterator]() {
    yield { value: catalog, accept: () => accepted.push(true) }
  },
  async dispose() {},
}
context = {
  remote: {
    speech: {
      async catalog() { return { ok: true, value: catalog } },
      async prepare(id) { assert.equal(id, 'sensevoice'); return { ok: true, value: { accepted: true } } },
      async transcribe(request, signal) {
        assert.equal(signal?.aborted, false)
        transcribeRequest = request
        return { ok: true, value: { text: '识别完成' } }
      },
      follow() { return stream },
    },
    $stream(options) { assert.equal(options.name, 'Chonky Fish speech readiness'); return stream },
  },
}
const samples = new Int16Array(160)
const audioStore = { read: ref => { assert.equal(ref, 'clip-1'); return samples } }
const adapter = createDshSpeech({ getRemote: () => context, audioStore })

assert.equal((await adapter.inspect()).available, true)
assert.deepEqual(await adapter.prepare('sensevoice'), { accepted: true })
const controller = new AbortController()
const seen = []
for await (const item of adapter.follow(controller.signal)) seen.push(item)
assert.deepEqual(seen, [catalog])
assert.deepEqual(accepted, [true])
assert.deepEqual(await adapter.recognition.transcribe('clip-1', { selection: catalog.selection, operation: { signal: controller.signal } }), { text: '识别完成' })
assert.equal(transcribeRequest.providerId, 'sensevoice')
assert.equal(typeof transcribeRequest.audioBase64, 'string')

context = null
adapter.setRemote(null)
assert.equal((await adapter.inspect()).reason, 'DSH_SPEECH_REMOTE_UNAVAILABLE')
await assert.rejects(adapter.prepare('sensevoice'), error => error.code === 'DSH_SPEECH_REMOTE_UNAVAILABLE')
console.log('DSH speech adapter: typed Remote envelopes, stream acceptance, transcription and lifecycle passed')
