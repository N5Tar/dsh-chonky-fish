import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createDshVoiceController } from '../bootstrap.js'
import { encodePcm16Wav } from '../../../../shared/audio/wav.js'

const manifest = JSON.parse(await readFile(new URL('../../../../shared/audio/web/assets/manifest.json', import.meta.url), 'utf8'))
const originals = new Map(['fetch', 'location', 'navigator', 'AudioContext', 'AudioWorkletNode', 'Worker'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const set = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
let micRequests = 0, synthesisRequests = 0, plays = 0, leases = 0, releasedLeases = 0, resetHandler
class AudioContext {
  state = 'running'; sampleRate = 48000
  audioWorklet = { async addModule() {} }
  async resume() { this.state = 'running' }
  async close() { this.state = 'closed' }
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createBuffer() { assert.equal(this.state, 'running', 'mode switches must preserve the unlocked playback context'); return { copyToChannel() {} } }
  createBufferSource() { return { connect() {}, disconnect() {}, stop() {}, start() { plays++; queueMicrotask(() => this.onended?.()) } } }
}
set('AudioContext', AudioContext)
set('navigator', { mediaDevices: { async getUserMedia() { micRequests++; throw new Error('automatic reply playback must never access the microphone') } } })
set('location', { href: 'http://localhost/' })
const response = data => ({ ok: true, status: 200, async json() { return data } })
let settingsState = { tts: { providerId: 'windows-system-speech', voiceId: null, rate: 0, credentialRef: null, region: 'cn-beijing', workspaceId: '', modelId: 'qwen-audio-3.1-tts-flash' }, credentialConfigured: false, capabilities: { emotionSupported: false, emotionTags: [], audioOutput: 'complete', conversationEmotionEnabled: false } }
let catalogLoads = 0
const catalogRequests = []
const previewRequests = []
const settingsWrites = []
const eventStream = events => {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  let sent = false
  return { ok: true, status: 200, body: { getReader() { return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes } }, async cancel() {}, releaseLock() {} } } } }
}
set('fetch', async (endpoint, options = {}) => {
  const path = new URL(endpoint, 'http://localhost/').pathname
  if (path === '/caps') return response({ ok: true, data: { host: { local: true, os: 'win32', arch: 'x64' }, ownership: { serviceGeneration: 'host-auto-reply' }, synthesis: { supported: true, voices: [] }, assets: { endpoint: '/chonkyfish/voice/assets' } } })
  if (path === '/voice-settings') {
    if (options.method === 'PUT') { const body = JSON.parse(options.body); settingsWrites.push(body.tts); settingsState = { ...settingsState, tts: body.tts, credentialConfigured: true }; return response({ ok: true, data: settingsState }) }
    return response({ ok: true, data: settingsState })
  }
  if (path === '/config') return response({ ok: true, config: { voice: { version: 1 } } })
  if (path === '/chonkyfish/voice/assets') return response(manifest)
  const body = JSON.parse(options.body || '{}')
  if (path === '/calls') {
    if (body.action === 'acquire') { leases++; return response({ ok: true, data: { leaseGeneration: `lease-${leases}`, serviceGeneration: 'host-auto-reply', expiresInMs: 15000 } }) }
    if (body.action === 'release') releasedLeases++
    return response({ ok: true, data: { ...body, expiresInMs: 15000 } })
  }
  if (path === '/synthesis') {
    synthesisRequests++
    const wav = Buffer.from(encodePcm16Wav(new Int16Array(1600))).toString('base64')
    return eventStream([{ type: 'audio', data: wav, format: { codec: 'wav', sampleRate: 16000, channels: 1 } }, { type: 'complete' }])
  }
  if (path === '/voice-preview') {
    if (body.action === 'catalog') { catalogLoads++; catalogRequests.push(body); if (!body.binding) assert.match(settingsState.tts.workspaceId, /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/); return response({ ok: true, data: { voices: [{ id: 'aliyun-voice-1', name: 'Voice One', sample: null, source: 'https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list' }] } }) }
    previewRequests.push(body)
    const wav = Buffer.from(encodePcm16Wav(new Int16Array(1600))).toString('base64')
    return eventStream([{ type: 'audio', data: wav, format: { codec: 'wav', sampleRate: 16000, channels: 1 } }, { type: 'complete' }])
  }
  throw new Error(`Unexpected request ${path}`)
})
const entries = [], sourceListeners = new Set(), localListeners = new Set()
const source = { getSnapshot: () => ({ entries: [...entries], revision: entries.length }), subscribe(fn) { sourceListeners.add(fn); return () => sourceListeners.delete(fn) } }
const session = { sessionId: 'session-auto', getSnapshot: () => ({ running: false, pendingSubmissions: [] }) }
const binding = { sessionId: session.sessionId, session, eventSource: source }
const chat = {
  async ensure() {},
  getVoiceTarget(runtimeId) { return { runtimeId, conversationId: session.sessionId, bindingRevision: '1' } },
  getVoiceBinding() { return binding },
  async retainVoiceBinding() { return { ...binding, release() {} } },
  onVoiceLocalInput(fn) { localListeners.add(fn); return () => localListeners.delete(fn) },
  onVoiceReset(fn) { resetHandler = fn; return () => { resetHandler = null } },
  isVoiceResetting: () => false,
}
let attachOptionalSpeech
const ctx = { inject(_keys, callback) { attachOptionalSpeech = callback; const missing = Promise.reject(new Error('no optional ASR service')); missing.dispose = () => {}; return missing } }
const testRoutes = { voiceCapabilities: '/caps', voiceSettings: '/voice-settings', voiceAssets: '/chonkyfish/voice/assets', config: '/config', voiceCalls: '/calls', voiceSources: '/voice-sources', voiceSynthesis: '/synthesis', voicePreview: '/voice-preview', voiceAudio: '/voice-audio', voiceCancel: '/voice-cancel' }
const controller = createDshVoiceController({ ctx, chat, routes: testRoutes })
async function settle() { for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
function reply(n) {
  for (const listener of localListeners) listener({ sessionId: session.sessionId, bindingRevision: '1', requestId: `typed-${n}`, state: 'prepared' })
  const events = [
    { type: 'turn/start', data: { turn: n } },
    { type: 'step/start', data: { turn: n, step: 1 } },
    { type: 'user/message', data: { turn: n, source: { kind: 'user', rpcId: `typed-${n}` }, content: [{ type: 'text', text: `问题${n}` }] } },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn: n, step: 1, message: { content: [{ type: 'text', text: `自动播报第${n}条。` }] } } },
    { type: 'step/end', data: { turn: n, step: 1 } },
    { type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } },
  ]
  for (const event of events) { entries.push({ event: { ...event, seq: entries.length + 1 } }); for (const listener of sourceListeners) listener() }
}
try {
  assert.equal(typeof controller.prepareReplyAudio, 'function')
  assert.equal(await controller.prepareReplyAudio(), true, 'automatic output works without the optional Speech Remote')
  assert.equal(controller.getSnapshot().call.inputEnabled, false)
  assert.equal(controller.getSnapshot().startupPending, false, 'automatic output does not turn the microphone button on')
  reply(1); await settle()
  assert.equal(synthesisRequests, 1)
  assert.equal(plays, 1)
  assert.equal(micRequests, 0)
  const outputCallId = controller.getSnapshot().call.id
  const detachSpeech = attachOptionalSpeech({ remote: { speech: { async catalog() { return { ok: true, value: { selection: { providerId: 'local', language: 'zh' }, providers: [{ id: 'local', preparation: { phase: 'ready' } }] } } } } } })
  await controller.prepareModel()
  assert.equal(controller.getSnapshot().call.id, outputCallId, 'mounting optional ASR must not replace an active output-only service')
  detachSpeech()
  assert.equal(controller.getSnapshot().call.status, 'connected', 'removing optional ASR leaves output-only playback available')
  await controller.hangup()
  assert.equal(await controller.prepareReplyAudio(), true)
  await settle()
  assert.equal(plays, 1, 'starting output again never replays the baseline reply')
  reply(2); await settle()
  assert.equal(plays, 2)
  await resetHandler()
  assert.equal(controller.getSnapshot().call.status, 'ended')
  assert.equal(micRequests, 0)
  await controller.dispose()
  let stoppedTracks = 0
  set('AudioWorkletNode', class { port = { postMessage() {} }; disconnect() {} })
  set('Worker', class { postMessage(data) { if (data.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } })) } terminate() {} })
  set('navigator', { mediaDevices: { async getUserMedia() { micRequests++; const track = { stop() { stoppedTracks++ }, addEventListener() {}, getSettings: () => ({ sampleRate: 48000, echoCancellation: true }) }; return { getTracks: () => [track], getAudioTracks: () => [track] } } } })
  const speechCtx = { inject(_keys, callback) {
    const cleanup = callback({ remote: { speech: { async catalog() { return { ok: true, value: { selection: { providerId: 'local', language: 'zh' }, providers: [{ id: 'local', preparation: { phase: 'ready' } }] } } } } } })
    const ready = Promise.resolve(); ready.dispose = () => cleanup?.(); return ready
  } }
  const switcher = createDshVoiceController({ ctx: speechCtx, chat, routes: testRoutes })
  try {
    assert.equal(await switcher.prepareReplyAudio(), true)
    await switcher.start()
    assert.equal(switcher.getSnapshot().call.inputEnabled, true)
    assert.equal(switcher.getSnapshot().capture.status, 'listening')
    assert.equal(micRequests, 1)
    reply(3); await settle()
    assert.equal(plays, 3, 'output-only to microphone mode retains working playback')
    await switcher.hangup()
    assert.equal(stoppedTracks, 1)
    assert.equal(await switcher.prepareReplyAudio(), true)
    reply(4); await settle()
    assert.equal(plays, 4, 'a later keyboard message re-arms output after explicit voice End')
    assert.equal(micRequests, 1, 're-arming automatic output does not re-open the microphone')
  } finally { await switcher.dispose() }
  const previousFetch = globalThis.fetch
  let finishCaps, capsRequested = false
  const capsGate = new Promise(resolve => { finishCaps = resolve })
  set('fetch', async (endpoint, options) => {
    if (new URL(endpoint, 'http://localhost/').pathname === '/caps') { capsRequested = true; await capsGate }
    return previousFetch(endpoint, options)
  })
  const pendingController = createDshVoiceController({ ctx, chat, routes: testRoutes })
  try {
    const leasesBefore = leases
    const pending = pendingController.prepareReplyAudio()
    for (let i = 0; i < 50 && !capsRequested; i++) await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(capsRequested, true)
    const resetting = resetHandler()
    finishCaps(); await resetting
    assert.equal(await pending, false, 'reset invalidates an automatic output setup in progress')
    assert.equal(leases, leasesBefore, 'late setup cannot reattach or acquire a call after reset')
    assert.equal(micRequests, 1)
  } finally { await pendingController.dispose(); set('fetch', previousFetch) }

  const settingsController = createDshVoiceController({ ctx, chat, routes: testRoutes })
  try {
    assert.equal((await settingsController.readVoiceSettings()).tts.providerId, 'windows-system-speech', 'settings begin with the Windows default')
    const aliyun = { providerId: 'aliyun-qwen-tts', voiceId: null, rate: 2, credentialRef: 'DASHSCOPE_API_KEY', region: 'cn-beijing', workspaceId: 'workspace_123', modelId: 'qwen-audio-3.1-tts-flash' }
    const writesBeforeDraft = settingsWrites.length
    const draftCatalog = await settingsController.getVoicePreviewCatalog(aliyun)
    assert.equal(draftCatalog.voices[0].id, 'aliyun-voice-1', 'an unsaved vendor draft can load its voice catalog')
    assert.deepEqual(catalogRequests[0].binding, { providerId: aliyun.providerId, modelId: aliyun.modelId, region: aliyun.region, workspaceId: aliyun.workspaceId, credentialRef: aliyun.credentialRef })
    await settingsController.playVoicePreview({ binding: aliyun, voiceId: 'aliyun-voice-1', text: '未保存设置试听', rate: 1 })
    assert.equal(previewRequests[0].voiceId, 'aliyun-voice-1', 'draft preview uses the explicit selected voice')
    assert.equal(previewRequests[0].rate, 1)
    assert.deepEqual(previewRequests[0].binding, { providerId: aliyun.providerId, modelId: aliyun.modelId, region: aliyun.region, workspaceId: aliyun.workspaceId, credentialRef: aliyun.credentialRef })
    assert.equal(settingsWrites.length, writesBeforeDraft, 'draft catalog and preview do not save or rewrite conversation settings')
    assert.equal(settingsState.tts.providerId, 'windows-system-speech', 'draft preview does not replace the saved Windows binding')
    await settingsController.updateVoiceSettings(aliyun)
    assert.equal(settingsWrites[0].credentialRef, 'DASHSCOPE_API_KEY', 'Aliyun uses the fixed Host credential alias')
    assert.equal(settingsWrites[0].workspaceId, 'workspace_123', 'Aliyun saves the validated workspace ID')
    assert.equal((await settingsController.getVoicePreviewCatalog()).voices[0].id, 'aliyun-voice-1', 'a saved workspace can load its catalog')
    await settingsController.updateVoiceSettings({ ...aliyun, voiceId: 'aliyun-voice-1' })
    await settingsController.getVoicePreviewCatalog()
    await assert.rejects(settingsController.playVoicePreview({ text: '试听这段语音', rate: 11 }), { code: 'VOICE_PREVIEW_RATE_INVALID' })
    await settingsController.playVoicePreview({ text: '试听这段语音', rate: -3 })
    assert.equal(catalogLoads, 3, 'draft and saved provider selections load their own catalogs')
    assert.equal(previewRequests[1].voiceId, 'aliyun-voice-1', 'preview uses the saved voice binding')
    assert.equal(previewRequests[1].rate, -3, 'explicit preview rate is sent after range validation')
    assert.equal(previewRequests[1].text, '试听这段语音')
    assert.equal('binding' in previewRequests[1], false, 'saved preview omits draft binding and follows the saved Host configuration')
  } finally { await settingsController.dispose() }
} finally {
  await controller.dispose()
  for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
}
assert.equal(releasedLeases, leases)
console.log('Automatic reply audio: no microphone or ASR, new keyboard replies, no history replay, restart and reset passed')
