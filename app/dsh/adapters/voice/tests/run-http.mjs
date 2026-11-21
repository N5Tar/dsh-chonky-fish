import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { ROUTES, LIMITS } from '../../../../../core/contracts/spec.js'
import { encodePcm16Wav } from '../../../../shared/audio/wav.js'
import { createVoiceRepository } from '../../../../shared/storage/voice/repository.js'
import { createVoiceProviders } from '../../../../shared/voice/providers/index.js'
import { DEFAULT_VOICE_CONFIG, validateVoiceConfig } from '../../../../../core/modules/voice/config.js'
import { registerVoiceRoutes } from '../http.js'

const handlers = new Map()
let replacedSeq10 = false
const sessionQuery = {
  async listEvents(sessionId) { return sessionId === 'session-1' ? [10, 11, 12, 13].filter(seq => !(replacedSeq10 && seq === 10)).map(seq => ({ seq, type: 'assistant/message', surface: 'current' })) : [] },
  async readEvent({ sessionId, seq }) { return sessionId === 'session-1' && [10, 11, 12, 13].includes(seq) ? { target: { seq, type: 'assistant/message', surface: 'current', surfaceOp: 'append', data: { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: seq === 10 ? '[sad] **Bold** `code` [read more](https://example.com)' : seq === 11 ? 'cancel' : seq === 12 ? '好'.repeat(801) : 'system default reply' }] } } } } : { target: null } },
}
const sourcePolicy = {
  register() { return { registered: true } }, release() { return true }, assertReply() { return true },
  close() {},
}
const ctx = {
  connection: { requestRejection: request => request.headers?.authorization === 'voice-test' ? undefined : 401 },
  webServer: { register({ path, handler }) { handlers.set(path, handler); return () => handlers.delete(path) } },
  get(name) { return name === 'sessionPersistence' ? { stat: async id => ({ header: { id, cwd: '/voice-workspace', agentPreset: 'chonkyfish' } }) } : null },
  sessions: { list: { getSnapshot() { return { byId: { 'session-1': { cwd: '/voice-workspace', removed: false } } } } } },
  logger: { warn() {} },
}
let storedVoice = JSON.parse(JSON.stringify(DEFAULT_VOICE_CONFIG))
const resources = {
  routes: ROUTES, limits: LIMITS, home: '/tmp/voice-host-test', paths: { workspace: '/voice-workspace' }, isMigrationBusy: () => false,
  getConfig: () => ({ voice: storedVoice }), async updateConfig(patch) { storedVoice = validateVoiceConfig({ ...storedVoice, ...patch.voice, tts: { ...storedVoice.tts, ...patch.voice.tts } }); return { voice: storedVoice } },
}
const foregroundCalls = []
const foreground = {
  inspect(ref) { foregroundCalls.push(['inspect', ref]); return { available: true, valid: true, expected: { conversationTurnId: 'dsh:host:session-1:turn:3', responseId: 'response-3', stepId: '3:1' } } },
  interrupt(request) { foregroundCalls.push(['interrupt', request]); return { status: 'applied', interruptionId: request.interruptionId } },
  query(request) { foregroundCalls.push(['query', request]); return { status: 'applied', interruptionId: request.interruptionId } },
}
const assetRoot = fileURLToPath(new URL('../../../../shared/audio/web/assets/', import.meta.url))
let synthStarted, resolveSynth, synthSignal
const storageRoot = await mkdtemp(join(tmpdir(), 'chonkyfish-voice-http-store-'))
const archive = createVoiceRepository({ root: join(storageRoot, 'voice'), DatabaseSync })
let ttsCalls = 0
const windowsInputs = []
const aliyunRequests = []
const windowsTts = {
  inspect: () => ({ supported: true, providerId: 'windows-system-speech', reason: null }),
  listVoices: async () => [{ id: 'Microsoft Huihui Desktop', culture: 'zh-CN' }],
  synthesize: async ({ text, signal }) => {
    ttsCalls++
    windowsInputs.push(text)
    if (text === 'cancel') {
      synthStarted?.()
      synthSignal = signal
      return new Promise((resolve, reject) => { resolveSynth = resolve; signal.addEventListener('abort', () => reject(Object.assign(new Error(), { code: 'TTS_CANCELLED' })), { once: true }) })
    }
    const wav = Buffer.from(encodePcm16Wav(new Int16Array(512), { sampleRate: 22050 }))
    return { wav, info: { codec: 'pcm_s16le', channels: 1, sampleRate: 22050, frames: 512, durationMs: 24, bytes: wav.length } }
  },
  close() {},
}
const providers = createVoiceProviders({
  getConfig: () => resources.getConfig(), windowsTts, env: { DASHSCOPE_API_KEY: 'test-key' },
  fetcher: async (_url, options) => {
    aliyunRequests.push(JSON.parse(options.body))
    const data = Buffer.from([1, 0, 2, 0]).toString('base64')
    return new Response(`data: ${JSON.stringify({ request_id: 'mock-request', output: { audio: { data }, finish_reason: 'stop' } })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  },
})
const voice = registerVoiceRoutes(ctx, {
  resources, ready: Promise.resolve(), assetRoot, sourcePolicy, sessionQuery, repository: archive, providers,
  foreground,
})

async function call(path, { method = 'GET', body, authorized = true, disconnectOnClose = false } = {}) {
  let output = Buffer.alloc(0), status = null, headers = null
  const req = {
    method, url: path, headers: { authorization: authorized ? 'voice-test' : 'wrong', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    async *iterator() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }
  const listeners = new Map()
  const res = { destroyed: false, writableEnded: false, writeHead(code, value) { status = code; headers = value }, write(value) { output = Buffer.concat([output, Buffer.from(String(value))]); return true }, end(value) { if (value !== undefined) output = Buffer.concat([output, Buffer.isBuffer(value) ? value : Buffer.from(String(value))]); this.writableEnded = true }, once(event, fn) { listeners.set(event, fn); if (disconnectOnClose && event === 'close') queueMicrotask(fn); return this }, off(event, fn) { if (listeners.get(event) === fn) listeners.delete(event); return this } }
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
const settings = await call(ROUTES.voiceSettings)
assert.equal(settings.json.data.capabilities.emotionSupported, false)
const aliSettings = await call(ROUTES.voiceSettings, { method: 'PUT', body: { tts: { providerId: 'aliyun-qwen-tts', credentialRef: 'DASHSCOPE_API_KEY', workspaceId: 'workspace_123', voiceId: 'longanhuan_v3.1' } } })
assert.equal(aliSettings.json.data.tts.credentialRef, 'DASHSCOPE_API_KEY')
assert.equal('credentialConfigured' in aliSettings.json.data.tts, false)
assert.equal(aliSettings.json.data.credentialConfigured, true)
const aliCaps = await call(ROUTES.voiceCapabilities)
assert.equal(aliCaps.json.synthesis.providerId, 'aliyun-qwen-tts')
assert.equal(aliCaps.json.synthesis.supported, true, 'configured Aliyun provider is reported on every host OS')
assert.equal(aliCaps.json.synthesis.credentialConfigured, true, 'capability reports the injected Host credential state')
const aliCatalog = await call(ROUTES.voicePreview, { method: 'POST', body: { action: 'catalog' } })
assert.equal(aliCatalog.json.data.officialSampleStatus, 'unverified')
assert.equal(aliCatalog.json.data.voices[0].sample, null)
assert.equal(aliCatalog.json.data.voices[0].source, 'https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list')
assert.ok(aliCatalog.json.data.emotionTags.includes('sarcastic'))
const explicitTagPreview = await call(ROUTES.voicePreview, { method: 'POST', body: { action: 'synthesize', operationId: 'preview-tag', text: '试听', voiceId: 'longanhuan_v3.1', rate: 5, emotionTag: 'sarcastic' } })
assert.equal(explicitTagPreview.status, 200)
assert.equal(aliyunRequests.at(-1).input.text, '[sarcastic]试听', 'preview accepts any official provider emotion tag')
assert.equal(aliyunRequests.at(-1).input.rate, 1.5, 'preview speed slider maps to the provider rate')
await call(ROUTES.voiceSettings, { method: 'PUT', body: { tts: { providerId: 'windows-system-speech', credentialRef: null } } })
const draftBinding = { providerId: 'aliyun-qwen-tts', modelId: 'qwen-audio-3.1-tts-flash', region: 'cn-beijing', workspaceId: '', credentialRef: null }
const draftCatalog = await call(ROUTES.voicePreview, { method: 'POST', body: { action: 'catalog', binding: draftBinding } })
assert.equal(draftCatalog.status, 200, 'an unsaved Aliyun draft can browse the static catalog without workspace or credentials')
assert.equal(draftCatalog.json.data.credentialConfigured, false)
assert.equal(draftCatalog.json.data.workspaceConfigured, false)
assert.equal((await call(ROUTES.voicePreview, { method: 'POST', body: { action: 'catalog', binding: { ...draftBinding, endpoint: 'https://example.invalid' } } })).status, 400, 'draft binding cannot supply provider URLs')
const incompleteDraftPreview = await call(ROUTES.voicePreview, { method: 'POST', body: { action: 'synthesize', binding: draftBinding, operationId: 'draft-missing-workspace', text: '草稿试听', voiceId: 'longanhuan_v3.1', rate: 0 } })
assert.equal(incompleteDraftPreview.status, 409)
assert.equal(incompleteDraftPreview.json.error.code, 'VOICE_PROVIDER_NOT_CONFIGURED')
const completeDraftBinding = { ...draftBinding, workspaceId: 'workspace_123', credentialRef: 'DASHSCOPE_API_KEY' }
const draftPreview = await call(ROUTES.voicePreview, { method: 'POST', body: { action: 'synthesize', binding: completeDraftBinding, operationId: 'draft-preview', text: '草稿试听', voiceId: 'longanhuan_v3.1', rate: -10 } })
assert.equal(draftPreview.status, 200, 'a fully configured draft can be auditioned before saving')
assert.equal(aliyunRequests.at(-1).input.rate, 0.5)
assert.equal((await call(ROUTES.voiceSettings)).json.data.tts.providerId, 'windows-system-speech', 'previewing a draft does not save or change the conversation provider')
const ref = { runtimeId: 'dsh:host', conversationId: 'session-1', bindingRevision: 'bind-1' }
const acquired = await call(ROUTES.voiceCalls, { method: 'POST', body: { action: 'acquire', callId: 'call-1', ownerId: 'owner-1', conversationRef: ref } })
assert.equal(acquired.status, 200)
assert.equal(voice.isConversationActive('session-1'), true)
assert.equal(voice.isConversationActive('other-session'), false)
const lease = acquired.json.data
const busy = await call(ROUTES.voiceCalls, { method: 'POST', body: { action: 'acquire', callId: 'call-2', ownerId: 'owner-2', conversationRef: ref } })
assert.equal(busy.status, 409)
const renewBody = { action: 'renew', callId: 'call-1', ownerId: 'owner-1', conversationRef: ref, serviceGeneration: lease.serviceGeneration, leaseGeneration: lease.leaseGeneration }
assert.equal((await call(ROUTES.voiceCalls, { method: 'POST', body: renewBody })).status, 200)
const foregroundLease = { callId: 'call-1', ownerId: 'owner-1', conversationRef: ref, serviceGeneration: lease.serviceGeneration, leaseGeneration: lease.leaseGeneration }
const foregroundState = await call(ROUTES.voiceForeground, { method: 'POST', body: { ...foregroundLease, action: 'inspect' } })
assert.equal(foregroundState.status, 200)
assert.equal(foregroundState.json.data.expected.responseId, 'response-3')
const unleasedForeground = await call(ROUTES.voiceForeground, { method: 'POST', body: { action: 'inspect', conversationRef: ref, serviceGeneration: lease.serviceGeneration } })
assert.equal(unleasedForeground.status, 200, 'authenticated composer text can inspect the current fish session without a voice lease')
assert.equal(unleasedForeground.json.data.available, true)
const interruptionBody = { ...foregroundLease, action: 'interrupt', interruptionId: 'interrupt-1', expected: foregroundState.json.data.expected, acceptedInputId: 'input-1', acceptedSubmissionId: 'request-1' }
assert.equal((await call(ROUTES.voiceForeground, { method: 'POST', body: interruptionBody })).json.data.status, 'applied')
assert.equal((await call(ROUTES.voiceForeground, { method: 'POST', body: { ...foregroundLease, action: 'query', interruptionId: 'interrupt-1' } })).json.data.status, 'applied')
assert.equal((await call(ROUTES.voiceForeground, { method: 'POST', body: interruptionBody, authorized: false })).status, 401)
assert.equal(foregroundCalls.map(row => row[0]).join(','), 'inspect,inspect,interrupt,query', 'unauthenticated foreground requests cannot inspect, cancel or query')

const sourceBody = { callId: 'call-1', ownerId: 'owner-1', conversationRef: ref, serviceGeneration: lease.serviceGeneration, leaseGeneration: lease.leaseGeneration, inputId: 'input-1', submissionId: 'submission-1', text: '主人说的话' }
const registered = await call(ROUTES.voiceSources, { method: 'POST', body: sourceBody })
assert.deepEqual(registered.json.data, { registered: true, duplicate: false })
const synthBody = { callId: 'call-1', ownerId: 'owner-1', conversationRef: ref, serviceGeneration: lease.serviceGeneration, leaseGeneration: lease.leaseGeneration, operationId: 'op-1', source: { sessionId: 'session-1', seq: 10 }, voiceId: 'Microsoft Huihui Desktop', rate: 0 }
const synthesized = await call(ROUTES.voiceSynthesis, { method: 'POST', body: synthBody })
assert.equal(synthesized.status, 200)
assert.match(synthesized.headers['content-type'], /text\/event-stream/)
const frames = synthesized.bytes.toString('utf8').trim().split('\n\n').map(frame => JSON.parse(frame.replace(/^data: /, '')))
assert.deepEqual(frames.map(frame => frame.type), ['audio', 'complete'])
assert.equal(frames[0].format.codec, 'wav')
assert.ok(Buffer.from(frames[0].data, 'base64').length > 44)
assert.equal(windowsInputs[0], '方括号 sad Bold code read more', 'Windows receives markdown-cleaned text and treats an unapproved provider tag literally')
const defaultVoiceReply = await call(ROUTES.voiceSynthesis, { method: 'POST', body: { ...synthBody, operationId: 'op-win-default', source: { sessionId: 'session-1', seq: 13 }, voiceId: null } })
assert.equal(defaultVoiceReply.status, 200, JSON.stringify(defaultVoiceReply.json || defaultVoiceReply.bytes.toString('utf8')))
assert.equal(windowsInputs.at(-1), 'system default reply')
const defaultAudioList = await call(`${ROUTES.voiceAudio}?sessionId=session-1&seqs=13`)
assert.equal(defaultAudioList.json.data.items[0].voiceId, 'system-default')
const disconnectedAudio = await call(`${ROUTES.voiceAudio}?sessionId=session-1&audioId=${defaultAudioList.json.data.items[0].audioId}`, { disconnectOnClose: true })
assert.equal(disconnectedAudio.status, null, 'a disconnected reader is cancelled without trying to write a response')
assert.equal((await call(`${ROUTES.voiceAudio}?sessionId=session-1&audioId=${defaultAudioList.json.data.items[0].audioId}`)).status, 200, 'the file handle is closed after cancellation')
const audioList = await call(`${ROUTES.voiceAudio}?sessionId=session-1&seqs=10`)
assert.equal(audioList.status, 200, 'archived audio remains available without the active call lease')
assert.equal(audioList.json.data.items.length, 1)
const archivedAudio = await call(`${ROUTES.voiceAudio}?sessionId=session-1&audioId=${audioList.json.data.items[0].audioId}`)
assert.equal(archivedAudio.status, 200)
assert.equal(archivedAudio.headers['content-type'], 'audio/wav')
assert.equal(archivedAudio.bytes.toString('ascii', 0, 4), 'RIFF')

const previewBody = { action: 'synthesize', operationId: 'preview-1', text: '试听内容', voiceId: 'Microsoft Huihui Desktop', rate: 0 }
const previewFirst = await call(ROUTES.voicePreview, { method: 'POST', body: previewBody })
assert.equal(previewFirst.status, 200)
const callsAfterPreview = ttsCalls
const previewSecond = await call(ROUTES.voicePreview, { method: 'POST', body: { ...previewBody, operationId: 'preview-2' } })
assert.equal(previewSecond.status, 200)
assert.equal(ttsCalls, callsAfterPreview, 'identical preview uses the bounded host cache instead of a second provider request')
const previewFrames = previewSecond.bytes.toString('utf8').trim().split('\n\n').map(frame => JSON.parse(frame.replace(/^data: /, '')))
assert.deepEqual(previewFrames.map(frame => frame.type), ['audio', 'complete'])
assert.equal(previewFrames[0].format.codec, 'wav')

let startedResolve
synthStarted = () => startedResolve?.()
const started = new Promise(resolve => { startedResolve = resolve })
const pendingSynthesis = call(ROUTES.voiceSynthesis, { method: 'POST', body: { ...synthBody, operationId: 'op-cancel', source: { sessionId: 'session-1', seq: 11 } } })
await started
assert.equal(synthSignal.aborted, false)
const canceled = await call(ROUTES.voiceCancel, { method: 'POST', body: { callId: 'call-1', ownerId: 'owner-1', serviceGeneration: lease.serviceGeneration, leaseGeneration: lease.leaseGeneration, operationId: 'op-cancel' } })
assert.equal(canceled.status, 200)
assert.equal(synthSignal.aborted, true)
const canceledStream = await pendingSynthesis
assert.equal(canceledStream.status, 200)
assert.equal(JSON.parse(canceledStream.bytes.toString('utf8').trim().split('\n\n').at(-1).replace(/^data: /, '')).code, 'TTS_CANCELLED')

await call(ROUTES.voiceSettings, { method: 'PUT', body: { tts: { providerId: 'aliyun-qwen-tts', credentialRef: 'DASHSCOPE_API_KEY', workspaceId: 'workspace_123', modelId: 'qwen-audio-3.1-tts-flash', voiceId: 'longanhuan_v3.1' } } })
const aliSynthesis = { ...synthBody, operationId: 'op-ali-no-rule', voiceId: 'longanhuan_v3.1' }
const aliWithoutRule = await call(ROUTES.voiceSynthesis, { method: 'POST', body: aliSynthesis })
assert.equal(aliWithoutRule.status, 200)
assert.equal(aliyunRequests.at(-1).input.text, '方括号 sad Bold code read more', 'Aliyun also receives clean text and no unapproved native tag')
archive.saveLabelRule({ requestId: 'session-1:3:1', owner: { namespaceId: String(resources.home), sessionId: 'session-1' }, rule: { providerId: 'aliyun-qwen-tts', modelId: 'qwen-audio-3.1-tts-flash', voiceId: 'longanhuan_v3.1', tags: ['sad'] } })
const aliWithRule = await call(ROUTES.voiceSynthesis, { method: 'POST', body: { ...aliSynthesis, operationId: 'op-ali-rule' } })
assert.equal(aliWithRule.status, 200)
assert.equal(aliyunRequests.at(-1).input.text, '[sad] Bold code read more', 'a persisted matching rule permits only its provider-native tag')
const beforeOverLimit = aliyunRequests.length
const tooLongReply = await call(ROUTES.voiceSynthesis, { method: 'POST', body: { ...aliSynthesis, operationId: 'op-ali-long', source: { sessionId: 'session-1', seq: 12 } } })
assert.equal(tooLongReply.status, 413)
assert.equal(tooLongReply.json.error.code, 'TTS_LIMIT_EXCEEDED')
assert.equal(aliyunRequests.length, beforeOverLimit, 'over-budget cleaned replies never reach a provider')
replacedSeq10 = true
const replacedList = await call(`${ROUTES.voiceAudio}?sessionId=session-1&seqs=10`)
assert.deepEqual(replacedList.json.data.items, [], 'audio for a replaced source message is evicted from the current projection')
assert.equal((await call(`${ROUTES.voiceAudio}?sessionId=session-1&audioId=${audioList.json.data.items[0].audioId}`)).status, 404)

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
  resources, ready: Promise.resolve(), assetRoot: tempAssetRoot, sourcePolicy, sessionQuery,
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
assert.equal(voice.isConversationActive('session-1'), false)
const fenced = await call(ROUTES.voiceCalls, { method: 'POST', body: renewBody })
assert.equal(fenced.status, 409)
voice.close()
await rm(storageRoot, { recursive: true, force: true })
console.log('voice Host HTTP adapter: lease, settings, source registration, SSE and asset routes passed')
