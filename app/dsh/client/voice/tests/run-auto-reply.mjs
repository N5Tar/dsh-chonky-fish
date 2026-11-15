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
set('fetch', async (endpoint, options = {}) => {
  const path = new URL(endpoint, 'http://localhost/').pathname
  if (path === '/caps') return response({ ok: true, data: { host: { local: true, os: 'win32', arch: 'x64' }, ownership: { serviceGeneration: 'host-auto-reply' }, synthesis: { supported: true, voices: [] }, assets: { endpoint: '/chonkyfish/voice/assets' } } })
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
    return response({ ok: true, data: { wav: Buffer.from(encodePcm16Wav(new Int16Array(1600))).toString('base64') } })
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
const controller = createDshVoiceController({ ctx, chat, routes: { voiceCapabilities: '/caps', voiceAssets: '/chonkyfish/voice/assets', config: '/config', voiceCalls: '/calls', voiceSynthesis: '/synthesis' } })
async function settle() { for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
function reply(n) {
  for (const listener of localListeners) listener({ sessionId: session.sessionId, bindingRevision: '1', requestId: `typed-${n}`, state: 'prepared' })
  const events = [
    { type: 'turn/start', data: { turn: n } },
    { type: 'user/message', surfaceOp: 'append', data: { turn: n, source: { kind: 'user', rpcId: `typed-${n}` }, content: [{ type: 'text', text: `问题${n}` }] } },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn: n, message: { content: [{ type: 'text', text: `自动播报第${n}条。` }] } } },
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
  const switcher = createDshVoiceController({ ctx: speechCtx, chat, routes: { voiceCapabilities: '/caps', voiceAssets: '/chonkyfish/voice/assets', config: '/config', voiceCalls: '/calls', voiceSynthesis: '/synthesis' } })
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
  const pendingController = createDshVoiceController({ ctx, chat, routes: { voiceCapabilities: '/caps', voiceAssets: '/chonkyfish/voice/assets', config: '/config', voiceCalls: '/calls', voiceSynthesis: '/synthesis' } })
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
} finally {
  await controller.dispose()
  for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
}
assert.equal(releasedLeases, leases)
console.log('Automatic reply audio: no microphone or ASR, new keyboard replies, no history replay, restart and reset passed')
