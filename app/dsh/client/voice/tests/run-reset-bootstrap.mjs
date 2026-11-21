import assert from 'node:assert/strict'
import { createDshVoiceController } from '../bootstrap.js'

let resetHandler = null
let unsubscribed = false
let releaseCapabilities
let capabilitiesRequested
const capabilitiesReady = new Promise(resolve => { capabilitiesRequested = resolve })
const capabilitiesResponse = new Promise(resolve => { releaseCapabilities = resolve })
const chat = {
  onVoiceReset(listener) {
    resetHandler = listener
    return () => { unsubscribed = true }
  },
  isVoiceResetting() { return false },
}
const injected = { remote: { speech: { async catalog() { return { ok: true, value: { selection: { providerId: 'p', language: 'en' }, providers: [{ id: 'p', preparation: { phase: 'ready' } }] } } } } } }
const ctx = {
  inject(keys, callback) {
    assert.deepEqual(keys, ['remote.speech'])
    const cleanup = callback(injected)
    const injection = Promise.resolve(injected)
    injection.dispose = () => { cleanup?.() }
    return injection
  },
}
const originalFetch = globalThis.fetch
globalThis.fetch = async endpoint => {
  if (endpoint === 'voice-capabilities') {
    capabilitiesRequested()
    await capabilitiesResponse
    return { ok: true, status: 200, async json() { return { ok: true, data: { host: { local: false } } } } }
  }
  if (endpoint === 'voice-settings') return { ok: true, status: 200, async json() { return { ok: true, data: { tts: {}, credentialConfigured: false, capabilities: {} } } } }
  throw new Error(`Unexpected request ${endpoint}`)
}
try {
  const controller = createDshVoiceController({ ctx, chat, routes: { voiceCapabilities: 'voice-capabilities', voiceSettings: 'voice-settings' } })
  assert.equal(typeof resetHandler, 'function', 'bootstrap subscribes to the chat reset lifecycle')
  const pendingSetup = controller.prepareModel().then(() => null, error => error)
  await capabilitiesReady
  let resetCompleted = false
  const pendingReset = resetHandler().then(() => { resetCompleted = true })
  await Promise.resolve()
  assert.equal(resetCompleted, false, 'reset waits for an in-flight capability/setup operation')
  releaseCapabilities()
  await pendingReset
  assert.equal(resetCompleted, true, 'reset handler completes its asynchronous cleanup before returning')
  const setupError = await pendingSetup
  assert.equal(setupError?.code, 'VOICE_HOST_UNSUPPORTED')
  await controller.dispose()
  assert.equal(unsubscribed, true, 'controller disposal removes its reset listener')
} finally {
  globalThis.fetch = originalFetch
}

console.log('Voice reset bootstrap: subscribes, awaits teardown, and unsubscribes on disposal')
