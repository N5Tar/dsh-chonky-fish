import assert from 'node:assert/strict'
import { createVoiceOperationManager } from '../operations.js'

const provider = {
  id: 'aliyun-qwen-tts',
  async *synthesize() {
    yield { type: 'audio', data: new Uint8Array([1, 0]), format: { codec: 'pcm_s16le', sampleRate: 24000, channels: 1 } }
    yield { type: 'complete', receipt: { requestId: 'r1' } }
  },
}
const operation = createVoiceOperationManager()
const started = operation.run({ operationId: 'op-1', owner: { namespaceId: 'host', sessionId: 's1' }, source: { sessionId: 's1', seq: 1 }, text: 'hello', voiceId: 'v', provider, binding: {}, save: false })
const events = []
for await (const item of started.events) events.push(item)
assert.deepEqual(events.map(item => item.type), ['audio', 'complete'])
await assert.rejects(async () => { for await (const _event of operation.run({ operationId: 'op-1', owner: {}, source: { sessionId: 's1', seq: 1 }, text: 'hello', voiceId: 'v', provider, binding: {}, save: false }).events) {} }, { code: 'VOICE_OPERATION_ALREADY_COMPLETED' })

const blocking = { id: 'aliyun-qwen-tts', synthesize({ signal }) { return (async function* () { await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(), { code: 'TTS_CANCELLED' })), { once: true })); })() } }
const pending = operation.run({ operationId: 'op-2', owner: {}, source: { sessionId: 's1', seq: 2 }, text: 'hello', voiceId: 'v', provider: blocking, binding: {}, save: false })
assert.throws(() => operation.run({ operationId: 'op-2', owner: {}, source: { sessionId: 's1', seq: 2 }, text: 'hello', voiceId: 'v', provider, binding: {}, save: false }), { code: 'VOICE_OPERATION_IN_PROGRESS' })
const running = (async () => { for await (const _event of pending.events) {} })()
pending.cancel('test')
await assert.rejects(running, { code: 'TTS_CANCELLED' })
operation.close()
console.log('Voice operations: ordered events, idempotency fence and cancellation passed')
