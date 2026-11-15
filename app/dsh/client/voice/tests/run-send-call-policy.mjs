import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../../../build.mjs', import.meta.url), 'utf8')
const start = source.indexOf('async function send(text) {')
const end = source.indexOf('function onVoiceLocalInput(', start)
assert.ok(start >= 0 && end > start)
const sendSource = source.slice(start, end).trim()

let prompts = 0, prepared = 0, accepted = 0, outputStarts = 0, preparedMode
function makeSend(callActive) {
  return vm.runInNewContext(`(${sendSource})`, {
    assert,
    voiceController: { getSnapshot: () => ({ call: { status: callActive ? 'connected' : 'idle' } }), prepareReplyAudio() { outputStarts++; return Promise.resolve(true) } }, bindingSessionId: 'session-1', voiceBindingRevision: 1,
    voiceLocalInputListeners: new Set([event => { if (event.state === 'prepared') prepared++; if (event.state === 'accepted') accepted++ }]),
    async ensure() { return { session: {
      beginSubmission(options) { preparedMode = options.mode; return { requestId: 'keyboard-1' } },
      async prompt(_content, mode, _signal, requestId) { assert.equal(mode, preparedMode); assert.equal(requestId, 'keyboard-1'); prompts++; return { ok: true, value: { accepted: true } } },
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
console.log('Keyboard Send: does not start voice output, keeps stable submission identity and accepted input notifications')
