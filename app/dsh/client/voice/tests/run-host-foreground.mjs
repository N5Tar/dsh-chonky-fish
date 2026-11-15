import assert from 'node:assert/strict'
import { createDshHostVoice } from '../host.js'

const routes = { voiceCapabilities: '/caps', voiceCalls: '/calls', voiceForeground: '/foreground', voiceSynthesis: '/synth', voiceCancel: '/cancel', voiceAssets: '/assets' }
const ref = { runtimeId: 'dsh:host-generation', conversationId: 'session-1', bindingRevision: 'bind-1' }
const calls = []
const fetcher = async (url, options = {}) => {
  calls.push({ url, options })
  let data
  if (url === routes.voiceCapabilities) data = { ownership: { serviceGeneration: 'host-generation', leaseMs: 15000 }, synthesis: { supported: false, voices: [] } }
  else if (url === routes.voiceForeground && JSON.parse(options.body).action === 'inspect') data = { available: true, valid: true, expected: { conversationTurnId: 'turn-2', responseId: 'response-2', stepId: '2:1' } }
  else if (url === routes.voiceForeground) data = { status: 'applied', interruptionId: JSON.parse(options.body).interruptionId }
  else data = {}
  return { ok: true, status: 200, async json() { return { ok: true, data } } }
}
const host = createDshHostVoice({ routes, audioStore: { putClip() {}, release() {} }, fetcher })
const state = await host.foreground.inspect(ref)
assert.equal(state.available, true)
assert.deepEqual(state.expected, { conversationTurnId: 'turn-2', responseId: 'response-2', stepId: '2:1' })
assert.equal(calls[0].url, routes.voiceCapabilities)
assert.equal(calls[1].url, routes.voiceForeground)
assert.equal(calls[1].options.credentials, 'same-origin')
const receipt = await host.foreground.interrupt({ conversationRef: ref, interruptionId: 'int-1', expected: state.expected, acceptedInputId: 'input-1', acceptedSubmissionId: 'request-1' })
assert.deepEqual(receipt, { status: 'applied', interruptionId: 'int-1' })
const body = JSON.parse(calls[2].options.body)
assert.equal(body.serviceGeneration, 'host-generation')
assert.equal(body.acceptedSubmissionId, 'request-1')
assert.equal(body.action, 'interrupt')
host.close()

let interruptCalls = 0, queryCalls = 0
const lostReceiptHost = createDshHostVoice({ routes, audioStore: { putClip() {}, release() {} }, fetcher: async (url, options = {}) => {
  if (url === routes.voiceCapabilities) return { ok: true, status: 200, async json() { return { ok: true, data: { ownership: { serviceGeneration: 'host-generation-2' }, synthesis: { supported: false, voices: [] } } } } }
  const body = JSON.parse(options.body)
  if (body.action === 'interrupt') { interruptCalls++; throw new Error('simulated lost RPC receipt') }
  queryCalls++
  assert.equal(body.action, 'query')
  assert.equal(body.interruptionId, 'lost-int-1', 'reconciliation reuses the original interruption ID')
  return { ok: true, status: 200, async json() { return { ok: true, data: { status: 'applied', interruptionId: body.interruptionId } } } }
} })
const recoveredReceipt = await lostReceiptHost.foreground.interrupt({ conversationRef: ref, interruptionId: 'lost-int-1', expected: state.expected, acceptedInputId: 'input-1', acceptedSubmissionId: 'request-1' })
assert.deepEqual(recoveredReceipt, { status: 'applied', interruptionId: 'lost-int-1' })
assert.equal(interruptCalls, 1, 'lost RPC receipt never causes a second cancellation request')
assert.equal(queryCalls, 1)
lostReceiptHost.close()
console.log('Voice Host foreground proxy: generation fenced inspect and conditional interrupt passed')
