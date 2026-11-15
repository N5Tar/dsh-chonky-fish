import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../../../build.mjs', import.meta.url), 'utf8')
const start = source.indexOf('async function send(text) {')
const end = source.indexOf('function onVoiceLocalInput(', start)
assert.ok(start >= 0 && end > start)
const sendSource = source.slice(start, end).trim()

let prompts = 0, prepared = 0, accepted = 0, outputStarts = 0, preparedMode, interruptions = [], queries = []
function makeSend(callActive, observedForeground = false, uncertainInterrupt = false) {
  return vm.runInNewContext(`(${sendSource})`, {
    assert,
    voiceController: { getSnapshot: () => ({ call: { status: callActive ? 'connected' : 'idle' } }), prepareReplyAudio() { outputStarts++; return Promise.resolve(true) }, ...(observedForeground ? { async foregroundTarget() { return { runtimeId: 'dsh:host', conversationId: 'session-1', bindingRevision: 'bind-1' } }, foreground: { async inspect() { return { available: true, expected: { conversationTurnId: 'turn-1', responseId: 'response-1', stepId: '1:1' } } }, async interrupt(request) { interruptions.push(request); return { status: uncertainInterrupt ? 'outcome-unknown' : 'applied' } }, async query(request) { queries.push(request); return { status: 'applied', interruptionId: request.interruptionId } } } } : {}) }, bindingSessionId: 'session-1', voiceBindingRevision: 1,
    voiceLocalInputListeners: new Set([event => { if (event.state === 'prepared') prepared++; if (event.state === 'accepted') accepted++ }]),
    async ensure() { return { session: {
      beginSubmission(options) { preparedMode = options.mode; return { requestId: 'keyboard-1' } },
      async prompt(_content, mode, _signal, requestId) { assert.equal(mode, preparedMode); assert.equal(mode, 'steer'); assert.equal(requestId, 'keyboard-1'); prompts++; return { ok: true, value: { accepted: true } } },
    } } },
    console: { warn() {}, error() {} },
  })
}
await makeSend(false)('typing outside a call')
assert.equal(outputStarts, 0, 'ordinary keyboard Send never arms speech outside a phone call')
assert.equal(prompts, 1)
assert.equal(prepared, 1)
assert.equal(accepted, 1)
await makeSend(true)('typing during a call')
assert.equal(outputStarts, 0, 'an active call uses its existing output subscription')
assert.equal(prompts, 2)
assert.equal(accepted, 2)
await makeSend(true, true)('typing with an observed foreground generation')
assert.equal(interruptions.length, 1)
assert.equal(interruptions[0].acceptedSubmissionId, 'keyboard-1')
assert.equal(interruptions[0].acceptedInputId, 'keyboard-1')
await makeSend(true, true, true)('typing reconciles an uncertain interrupt')
assert.equal(interruptions.length, 2, 'each typed request sends exactly one conditional interrupt')
assert.equal(queries.length, 1, 'uncertain typed cancellation is reconciled by query')
assert.equal(queries[0].interruptionId, interruptions[1].interruptionId, 'query uses the original interruption ID')
console.log('Keyboard Send: does not start voice output, keeps stable submission identity and accepted input notifications')
