import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createDshVoiceController } from '../bootstrap.js'
import { DEFAULT_VOICE_CONFIG } from '../../../../../core/modules/voice/config.js'

const manifest = JSON.parse(await readFile(new URL('../../../../shared/audio/web/assets/manifest.json', import.meta.url), 'utf8'))
let streamStarted = false, remoteCancelled = 0, prepared = 0, micRequests = 0
let streamOptions = null, streamAbort = null
let providerPhase = 'standby'
const remote = {
  async catalog() {
    return { ok: true, value: { selection: { providerId: 'sensevoice', language: 'zh-CN' }, providers: [{ id: 'sensevoice', preparation: { phase: providerPhase } }] } }
  },
  async prepare(providerId) { assert.equal(providerId, 'sensevoice'); prepared++; return { ok: true, value: { accepted: true } } },
  async cancelPreparation(providerId) { assert.equal(providerId, 'sensevoice'); remoteCancelled++; return { ok: true, value: { cancelled: true } } },
  async *follow(signal) {
    streamStarted = true
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  },
}
const chat = {
  ensure: async () => {},
  getVoiceTarget(runtimeId) { return { runtimeId, conversationId: 'session-1', bindingRevision: 1 } },
  getVoiceBinding() { return null },
  async retainVoiceBinding() { throw new Error('conversation binding should not be retained before model preparation succeeds') },
  onVoiceReset() { return () => {} },
  isVoiceResetting: () => false,
}
const originalFetch = globalThis.fetch
globalThis.fetch = async (endpoint, options = {}) => {
  const url = new URL(endpoint, 'http://localhost/')
  if (url.pathname === '/caps') return { ok: true, status: 200, async json() { return { ok: true, data: { host: { local: true, os: 'win32', arch: 'x64' }, ownership: { serviceGeneration: 'host-boot-1' }, synthesis: { supported: true, voices: [] }, assets: { endpoint: '/chonkyfish/voice/assets' } } } } }
  if (url.pathname === '/voice-settings') return { ok: true, status: 200, async json() { return { ok: true, data: { tts: DEFAULT_VOICE_CONFIG.tts, credentialConfigured: false, capabilities: { emotionSupported: false, emotionTags: [], audioOutput: 'complete', conversationEmotionEnabled: false } } } } }
  if (url.pathname === '/config') return { ok: true, status: 200, async json() { return { ok: true, config: { voice: DEFAULT_VOICE_CONFIG }, configRevision: 'a'.repeat(64) } } }
  if (url.pathname === '/chonkyfish/voice/assets' && url.searchParams.get('key') === 'manifest.json') return { ok: true, status: 200, async json() { return manifest } }
  throw new Error(`Unexpected request ${options.method || 'GET'} ${url.href}`)
}
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async getUserMedia() { micRequests++; throw new Error('microphone must not be requested during canceled model preparation') } } } })
Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://localhost/' } })

const stream = {
  async *[Symbol.asyncIterator]() {
    const source = streamOptions.open(streamAbort.signal)
    for await (const value of source) yield { value, accept() {} }
  },
  async dispose() { streamAbort?.abort() },
}
// The adapter uses DSH's typed stream wrapper; model state remains pending until cancellation.
const streamContext = { remote: { speech: remote, $stream(options) { streamOptions = options; streamAbort = new AbortController(); return stream } } }
const streamCtx = {
  inject(keys, callback) {
    const cleanup = callback(streamContext)
    const injection = Promise.resolve(streamContext)
    injection.dispose = () => cleanup?.()
    return injection
  },
}
const createController = () => createDshVoiceController({ ctx: streamCtx, chat, routes: { voiceCapabilities: '/caps', voiceSettings: '/voice-settings', config: '/config', voiceAssets: '/chonkyfish/voice/assets', voiceCalls: '/calls', voiceSources: '/voice-sources', voiceSynthesis: '/voice-synthesis', voicePreview: '/voice-preview', voiceAudio: '/voice-audio', voiceCancel: '/voice-cancel' } })
const second = createController()
try {
  const pendingStart = second.start()
  for (let i = 0; i < 100 && !streamStarted; i++) await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(streamStarted, true, 'one Start click automatically prepares a cold selected model')
  assert.equal(prepared, 1)
  assert.equal(second.getSnapshot().startupPending, true)
  let remountedSnapshot
  second.subscribe(value => { remountedSnapshot = value })
  assert.equal(remountedSnapshot.startupPending, true, 'startup state survives composer remounts')
  await second.cancelStart()
  await assert.rejects(pendingStart, error => error.code === 'VOICE_START_CANCELLED')
  assert.equal(remoteCancelled, 1, 'Cancel stops the DSH model preparation')
  assert.equal(second.getSnapshot().startupPending, false)
  assert.equal(micRequests, 0, 'a canceled startup never requests microphone access')
  streamStarted = false
  const unmounted = createController()
  const pendingUnmountedStart = unmounted.start()
  for (let i = 0; i < 100 && !streamStarted; i++) await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(streamStarted, true)
  await unmounted.dispose()
  await assert.rejects(pendingUnmountedStart, error => error.code === 'VOICE_START_CANCELLED')
  assert.equal(remoteCancelled, 2, 'disposing the page also cancels remote preparation')
  assert.equal(micRequests, 0, 'late model preparation after page disposal cannot request the microphone')
  const warmed = createController()
  try {
    providerPhase = 'ready'
    await warmed.prepareModel()
    assert.equal(warmed.modelReady(), true)
    providerPhase = 'standby'
    streamStarted = false
    const restarted = warmed.start()
    restarted.catch(() => {})
    for (let i = 0; i < 100 && !streamStarted; i++) await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(prepared, 3, 'a previously ready model reclaimed by the Host must be prepared again on Start')
    assert.equal(streamStarted, true, 'restart follows fresh readiness instead of trusting the cached ready state')
    await warmed.cancelStart()
    await assert.rejects(restarted, error => error.code === 'VOICE_START_CANCELLED')
    assert.equal(micRequests, 0, 'canceling the model wake-up still cannot open the microphone')
  } finally { await warmed.dispose() }
} finally {
  await second.dispose()
  globalThis.fetch = originalFetch
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete globalThis.navigator
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation)
  else delete globalThis.location
}

console.log('Voice cold start: one-click preparation, remount state and cancel-before-microphone passed')
