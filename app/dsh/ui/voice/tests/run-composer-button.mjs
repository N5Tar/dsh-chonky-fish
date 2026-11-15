import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createVoiceComposerControl } from '../composer.js'

const template = await readFile(new URL('../../original.html', import.meta.url), 'utf8')
const voiceButtons = [...template.matchAll(/<button\b[^>]*\bid="voice-button"[^>]*>/g)]
assert.equal(voiceButtons.length, 1, 'the chat template contains exactly one voice button')
assert.match(voiceButtons[0][0], /type="button"/, 'voice control cannot submit or clear the keyboard draft')
const composer = template.match(/<form class="compose" id="chat-form">([\s\S]*?)<\/form>/)?.[1] || ''
assert.ok(composer.indexOf('id="voice-button"') > composer.indexOf('id="chat-input"'))
assert.ok(composer.indexOf('id="voice-button"') < composer.indexOf('class="send-button"'), 'voice control sits between draft input and Send')
assert.doesNotMatch(template, /chonkyfish-voice|语音设置|重播/, 'the template has no extra voice panel or action UI')

class Button {
  constructor() { this.attributes = {}; this.listeners = new Map(); this.disabled = false; this.innerHTML = '' }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  addEventListener(name, fn) { const list = this.listeners.get(name) || []; list.push(fn); this.listeners.set(name, list) }
  removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== fn)) }
  click() { for (const fn of this.listeners.get('click') || []) fn({ currentTarget: this }) }
}

let state = { call: { status: 'idle', id: null }, startupPending: false, capture: { status: 'stopped' }, inputs: [] }
const controllerListeners = new Set()
const calls = []
const errors = []
let rejectStart
const controller = {
  getSnapshot() { return state },
  starting() { return state.startupPending },
  subscribe(fn) { controllerListeners.add(fn); fn(state); return () => controllerListeners.delete(fn) },
  start() {
    calls.push('start')
    state = { ...state, call: { ...state.call, status: 'preparing', inputEnabled: true }, startupPending: true }
    controllerListeners.forEach(fn => fn(state))
    return new Promise((resolve, reject) => { rejectStart = reject })
  },
  cancelStart() {
    calls.push('cancel')
    state = { ...state, call: { ...state.call, status: 'ended' }, startupPending: false }
    controllerListeners.forEach(fn => fn(state))
    rejectStart?.(Object.assign(new Error('cancelled'), { code: 'VOICE_START_CANCELLED' }))
    return Promise.resolve()
  },
  hangup() {
    calls.push('hangup')
    state = { ...state, call: { ...state.call, status: 'ended' } }
    controllerListeners.forEach(fn => fn(state))
    return Promise.resolve()
  },
}
const bridgeListeners = new Set()
const chat = {
  onVoiceController(fn) { bridgeListeners.add(fn); fn(controller); return () => bridgeListeners.delete(fn) },
}
let button = new Button()
let control = createVoiceComposerControl({ button, chat, toast: value => errors.push(value) })
assert.equal(button.attributes['aria-pressed'], 'false')
assert.match(button.innerHTML, /<rect.*rx="3"/)
assert.doesNotMatch(button.innerHTML, /<use\b/, 'the DSH shadow root must not depend on a document-level SVG symbol')
state = { ...state, call: { status: 'connected', id: 'output-only', inputEnabled: false } }
controllerListeners.forEach(fn => fn(state))
assert.equal(button.attributes['aria-pressed'], 'false', 'automatic reply audio does not show an open microphone')
assert.equal(button.attributes['aria-label'], '开始语音通话')

button.click()
assert.equal(calls.at(-1), 'start', 'OFF starts a call')
assert.equal(button.attributes['aria-pressed'], 'true', 'button stays ON through controller startup')
assert.equal(button.attributes['aria-label'], '取消语音启动')
assert.match(button.innerHTML, /m16 4 5 5/)
assert.match(button.innerHTML, /viewBox="0 0 24 24"/)
const hangupsBeforeUnmount = calls.filter(call => call === 'hangup').length
control.dispose()
assert.equal(calls.filter(call => call === 'hangup').length, hangupsBeforeUnmount, 'page unmount only unsubscribes during pending startup')
button = new Button()
control = createVoiceComposerControl({ button, chat, toast: value => errors.push(value) })
assert.equal(button.attributes['aria-pressed'], 'true', 'a remounted composer sees the controller-owned pending state')
assert.equal(button.attributes['aria-label'], '取消语音启动')
button.click()
assert.equal(calls.at(-1), 'cancel', 'a second click cancels pending startup')
await new Promise(resolve => setTimeout(resolve, 0))
assert.equal(button.attributes['aria-pressed'], 'false')

state = { ...state, startupPending: false, call: { ...state.call, status: 'connected' }, capture: { status: 'paused-error' } }
controllerListeners.forEach(fn => fn(state))
assert.equal(button.attributes['aria-pressed'], 'true', 'paused capture remains an active call')
assert.equal(button.attributes['aria-label'], '结束语音通话')
button.click()
assert.equal(calls.at(-1), 'hangup', 'clicking ON ends the call')
await new Promise(resolve => setTimeout(resolve, 0))

state = { ...state, inputs: [{ inputId: 'input-x', admission: 'accepted', error: { code: 'MISSING_CREDENTIAL', message: '模型凭据缺失' } }] }
controllerListeners.forEach(fn => fn(state))
controllerListeners.forEach(fn => fn(state))
assert.equal(errors.filter(value => value.includes('DSH 模型缺少凭据')).length, 1, 'per-input failure toasts once across repeated snapshots')
assert.match(button.attributes.title, /配置模型凭据/)
state = { ...state, inputs: [state.inputs[0], { inputId: 'input-y', admission: 'accepted', status: 'completed', transcript: 'new successful input' }] }
controllerListeners.forEach(fn => fn(state))
assert.doesNotMatch(button.attributes.title, /凭据|MISSING_CREDENTIAL/, 'a newer successful input clears historical input errors from the tooltip')
assert.equal(errors.filter(value => value.includes('DSH 模型缺少凭据')).length, 1, 'repeated history snapshots do not repeat old failure toasts')
const failureGuidance = [
  ['VOICE_RECOGNITION_UNAVAILABLE', /重新开启通话以准备模型/],
  ['VOICE_CAPTURE_UNSUPPORTED', /无法使用麦克风采集/],
  ['VOICE_PLAYBACK_UNSUPPORTED', /无法播放语音/],
  ['VOICE_TTS_UNSUPPORTED', /系统语音组件/],
  ['VOICE_INPUT_LIMIT', /结束通话后重新开始/],
  ['VOICE_AUDIO_BUDGET', /结束通话后重新开始/],
  ['VOICE_CAPTURE_STALLED', /结束并重新开始通话/],
  ['VOICE_VAD_BACKLOG', /结束通话后重新开始/],
  ['VOICE_MIC_PERMISSION', /授权后重新开始通话/],
  ['VOICE_MIC_DISCONNECTED', /重新连接设备/],
]
for (const [index, [code, guidance]] of failureGuidance.entries()) {
  state = { ...state, call: { status: 'connected', id: `call-${index}` }, inputs: [], error: { code } }
  controllerListeners.forEach(fn => fn(state))
  assert.ok(errors.some(value => guidance.test(value)), `${code} toast gives concrete recovery guidance`)
  assert.match(button.attributes.title, guidance, `${code} is available in the button tooltip`)
}
const hangupsBeforeDispose = calls.filter(call => call === 'hangup').length
control.dispose()
assert.equal(calls.filter(call => call === 'hangup').length, hangupsBeforeDispose, 'page cleanup only unsubscribes and does not end the app-lifetime call')
assert.equal(bridgeListeners.size, 0)

console.log('Voice composer: one-button start/cancel/end, reconnect state, input draft isolation, and page lifecycle passed')
