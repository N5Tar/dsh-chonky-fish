import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ROUTES, LIMITS } from '../../../../../core/contracts/spec.js'
import { encodePcm16Wav } from '../../../../shared/audio/wav.js'
import { registerVoiceRoutes } from '../http.js'

const handlers = new Map()
const ctx = {
  connection: { requestRejection: request => request.headers?.authorization === 'voice-test' ? undefined : 401 },
  webServer: { register({ path, handler }) { handlers.set(path, handler); return () => handlers.delete(path) } },
  logger: { warn() {} },
}
const resources = { routes: ROUTES, limits: LIMITS, isMigrationBusy: () => false }
const assetRoot = fileURLToPath(new URL('../../../../shared/audio/web/assets/', import.meta.url))
let synthStarted, resolveSynth, synthSignal
const voice = registerVoiceRoutes(ctx, {
  resources, ready: Promise.resolve(), assetRoot,
  tts: {
    inspect: () => ({ supported: true, providerId: 'windows-system-speech', reason: null }),
    listVoices: async () => [{ id: 'Microsoft Huihui Desktop', culture: 'zh-CN' }],
    synthesize: async ({ text, signal }) => {
      if (text === 'cancel') {
        synthStarted?.()
        synthSignal = signal
        return new Promise((resolve, reject) => { resolveSynth = resolve; signal.addEventListener('abort', () => reject(Object.assign(new Error(), { code: 'TTS_CANCELLED' })), { once: true }) })
      }
      const wav = Buffer.from(encodePcm16Wav(new Int16Array(512), { sampleRate: 22050 }))
      return { wav, info: { codec: 'pcm_s16le', channels: 1, sampleRate: 22050, frames: 512, durationMs: 24, bytes: wav.length } }
    },
    close() {},
  },
})

async function call(path, { method = 'GET', body, authorized = true } = {}) {
  let output = Buffer.alloc(0), status = null, headers = null
  const req = {
    method, url: path, headers: { authorization: authorized ? 'voice-test' : 'wrong', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    async *iterator() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }
  const res = { writeHead(code, value) { status = code; headers = value }, end(value) { output = value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(String(value)) } }
  await handlers.get(path.split('?')[0])(req, res)
  let parsed = null
  if (output.length) { try { parsed = JSON.parse(output.toString('utf8')) } catch {} }
  return { status, headers, bytes: output, json: parsed }
}

const denied = await call(ROUTES.voiceCapabilities, { authorized: false })
assert.equal(denied.status, 401)
const caps = await call(ROUTES.voiceCapabilities)
assert.equal(caps.status, 200)
assert.equal(caps.json.synthesis.voices[0].id, 'Microsoft Huihui Desktop')
const ref = { runtimeId: 'dsh:host', conversationId: 'session-1', bindingRevision: 'bind-1' }
const acquired = await call(ROUTES.voiceCalls, { method: 'POST', body: { action: 'acquire', callId: 'call-1', ownerId: 'owner-1', conversationRef: ref } })
assert.equal(acquired.status, 200)
const lease = acquired.json.data
const busy = await call(ROUTES.voiceCalls, { method: 'POST', body: { action: 'acquire', callId: 'call-2', ownerId: 'owner-2', conversationRef: ref } })
assert.equal(busy.status, 409)
const renewBody = { action: 'renew', callId: 'call-1', ownerId: 'owner-1', conversationRef: ref, serviceGeneration: lease.serviceGeneration, leaseGeneration: lease.leaseGeneration }
assert.equal((await call(ROUTES.voiceCalls, { method: 'POST', body: renewBody })).status, 200)

const synthBody = { callId: 'call-1', ownerId: 'owner-1', conversationRef: ref, serviceGeneration: lease.serviceGeneration, leaseGeneration: lease.leaseGeneration, operationId: 'op-1', text: '你好。', voiceId: 'Microsoft Huihui Desktop', rate: 0 }
const synthesized = await call(ROUTES.voiceSynthesis, { method: 'POST', body: synthBody })
assert.equal(synthesized.status, 200)
assert.equal(synthesized.json.data.format.sampleRate, 22050)
assert.ok(Buffer.from(synthesized.json.data.wav, 'base64').length > 44)

let startedResolve
synthStarted = () => startedResolve?.()
const started = new Promise(resolve => { startedResolve = resolve })
const pendingSynthesis = call(ROUTES.voiceSynthesis, { method: 'POST', body: { ...synthBody, operationId: 'op-cancel', text: 'cancel' } })
await started
assert.equal(synthSignal.aborted, false)
const canceled = await call(ROUTES.voiceCancel, { method: 'POST', body: { callId: 'call-1', ownerId: 'owner-1', serviceGeneration: lease.serviceGeneration, leaseGeneration: lease.leaseGeneration, operationId: 'op-cancel' } })
assert.equal(canceled.status, 200)
assert.equal(synthSignal.aborted, true)
assert.equal((await pendingSynthesis).status, 409)

const manifest = JSON.parse(await readFile(join(assetRoot, 'manifest.json'), 'utf8'))
const jsAsset = manifest.files.runtime
const asset = await call(`${ROUTES.voiceAssets}?key=${encodeURIComponent(jsAsset.key)}`)
assert.equal(asset.status, 200)
assert.match(asset.headers['content-type'], /javascript/)
assert.match(asset.headers['cache-control'], /immutable/)
for (const logicalName of ['vadWorker', 'captureWorklet']) {
  const entry = manifest.files[logicalName]
  const response = await call(`${ROUTES.voiceAssets}?key=${encodeURIComponent(entry.key)}`)
  assert.equal(response.status, 200, `${logicalName} asset should resolve from its fixed parent web directory`)
  assert.match(response.headers['content-type'], /javascript/)
  assert.equal(response.bytes.length, entry.bytes)
}
const manifestResponse = await call(`${ROUTES.voiceAssets}?key=manifest.json`)
assert.match(manifestResponse.headers['cache-control'], /no-cache/)
const staleAsset = await call(`${ROUTES.voiceAssets}?key=unknown`)
assert.equal(staleAsset.status, 404)

const tempRoot = await mkdtemp(join(tmpdir(), 'chonkyfish-voice-assets-'))
const tempWebRoot = join(tempRoot, 'web')
const tempAssetRoot = join(tempWebRoot, 'assets')
await mkdir(tempWebRoot)
await mkdir(tempAssetRoot)
await copyFile(join(assetRoot, 'manifest.json'), join(tempAssetRoot, 'manifest.json'))
await copyFile(fileURLToPath(new URL('../../../../shared/audio/web/vad.worker.js', import.meta.url)), join(tempWebRoot, 'vad.worker.js'))
const isolatedHandlers = new Map()
const isolatedVoice = registerVoiceRoutes({
  connection: ctx.connection,
  webServer: { register({ path, handler }) { isolatedHandlers.set(path, handler); return () => isolatedHandlers.delete(path) } },
}, {
  resources, ready: Promise.resolve(), assetRoot: tempAssetRoot,
  tts: { inspect: () => ({ supported: false }), async listVoices() { return [] }, async synthesize() { throw new Error('unused') }, close() {} },
})
async function isolatedAsset(key) {
  let status, headers, bytes = Buffer.alloc(0)
  const req = { method: 'GET', url: `${ROUTES.voiceAssets}?key=${encodeURIComponent(key)}`, headers: { authorization: 'voice-test' }, async *iterator() {} }
  const res = { writeHead(code, value) { status = code; headers = value }, end(value) { bytes = value === undefined ? Buffer.alloc(0) : Buffer.from(value) } }
  await isolatedHandlers.get(ROUTES.voiceAssets)(req, res)
  return { status, headers, bytes }
}
try {
  const workerEntry = manifest.files.vadWorker
  const verified = await isolatedAsset(workerEntry.key)
  assert.equal(verified.status, 200)
  await writeFile(join(tempWebRoot, 'vad.worker.js'), 'replacement bytes must not inherit the old content hash')
  const afterReplacement = await isolatedAsset(workerEntry.key)
  assert.equal(afterReplacement.status, 200)
  assert.deepEqual(afterReplacement.bytes, verified.bytes, 'a verified immutable key keeps serving its verified bytes for the Host lifetime')
} finally {
  isolatedVoice.close()
  await rm(tempRoot, { recursive: true, force: true })
}

const released = await call(ROUTES.voiceCalls, { method: 'POST', body: { ...renewBody, action: 'release' } })
assert.equal(released.status, 200)
const fenced = await call(ROUTES.voiceCalls, { method: 'POST', body: renewBody })
assert.equal(fenced.status, 409)
voice.close()
console.log('voice Host HTTP adapter: 1 passed')
