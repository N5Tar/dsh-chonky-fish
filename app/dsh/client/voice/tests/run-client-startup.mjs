import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)))
const clientSource = await readFile(resolve(root, 'client.js'), 'utf8')
const assetRoot = resolve(root, 'app/shared/audio/web/assets')
const assetManifest = JSON.parse(await readFile(resolve(assetRoot, 'manifest.json'), 'utf8'))
const { resolveVoiceAssets } = await import('../assets.js')

assert.doesNotMatch(clientSource, /^\s*import\s/m, 'generated Client has no ESM runtime imports')
assert.doesNotMatch(clientSource, /\bimport\s*\(/, 'generated Client has no lazy ESM runtime chunks')
assert.doesNotMatch(clientSource, /from\s+["']node:/, 'generated Client has no Node builtin imports')
assert.match(clientSource, /ctx\.inject\(\[["']remote\.speech["']\]/, 'optional speech is acquired through Cordis guarded injection')
assert.doesNotMatch(clientSource, /ctx\s*\.\s*remote\s*\??\.\s*speech/, 'Client never reads optional ctx.remote.speech directly')
assert.match(clientSource, /createVoiceOverlay/, 'generated Client includes the plugin-level React overlay')
assert.ok(clientSource.includes(String.raw`id=\"voice-button\"`), 'generated chat composer includes the single voice control')
assert.match(clientSource, /onVoiceController/, 'the chat page receives the app-lifetime voice controller through its bridge')
assert.doesNotMatch(clientSource, /voiceController\.prepareReplyAudio\(\)/, 'ordinary chat Send cannot enable speech outside an explicitly started call')
assert.doesNotMatch(clientSource, /createVoiceBar/, 'generated Client has no floating call bar')
assert.match(clientSource, /VOICE_POSSIBLE_DUPLICATE/, 'generated Client carries duplicate risk metadata')
assert.match(clientSource, /result\.value && result\.value\.accepted === true/, 'keyboard acceptance requires an explicit prompt receipt')
assert.match(clientSource, /'session\/model-unavailable': true/, 'keyboard rejection is limited to typed pre-admission outcomes')
assert.match(clientSource, /finishVoiceResetCall\(\{ service: oldService, playback, setupPromise: setupBeforeReset, hangupOptions: \{ abandonPending: true \} \}\)/, 'Session reset explicitly abandons unresolved inputs while retaining the old service drain')
assert.match(clientSource, /canContinueCall\(\)/, 'ended calls continue only when their conversation target is still current')
const resolvedAssets = resolveVoiceAssets('/chonkyfish/voice/assets', assetManifest, 'dsh-app://app/')
for (const entry of Object.values(assetManifest.files)) {
  const sourceDirectory = entry.file === 'vad.worker.js' || entry.file === 'capture.worklet.js' ? resolve(assetRoot, '..') : assetRoot
  const bytes = await readFile(resolve(sourceDirectory, entry.file))
  assert.equal(bytes.length, entry.bytes, `${entry.file} byte count matches the served manifest`)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.file} SHA matches its served key`)
}
for (const assetURL of [resolvedAssets.modelUrl, resolvedAssets.ortModuleUrl, resolvedAssets.wasmPaths.mjs, resolvedAssets.wasmPaths.wasm, resolvedAssets.workerUrl, resolvedAssets.workletUrl]) {
  const url = new URL(assetURL)
  assert.equal(url.protocol, 'dsh-app:')
  assert.equal(url.hostname, 'app')
  assert.ok(Object.values(assetManifest.files).some(entry => entry.key === url.searchParams.get('key')), 'runtime asset URL resolves to a Host-manifest key')
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.events = new Map()
    this.options = []; this.hidden = false; this.value = ''; this.disabled = false; this.parentNode = null; this._text = ''
  }
  append(...items) {
    for (const item of items) {
      if (item == null) continue
      item.parentNode = this; this.children.push(item)
      if (this.tagName === 'SELECT' && item.tagName === 'OPTION') this.options.push(item)
    }
  }
  replaceChildren(...items) { for (const item of this.children) item.parentNode = null; this.children = []; this.append(...items) }
  addEventListener(type, fn) { const list = this.events.get(type) || []; list.push(fn); this.events.set(type, list) }
  dispatch(type, event = {}) { for (const fn of this.events.get(type) || []) fn({ currentTarget: this, target: this, preventDefault() {}, ...event }) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = null }
  focus() {}
  querySelectorAll() { return [] }
  get textContent() { return this._text + this.children.map(item => item.textContent || '').join('') }
  set textContent(value) { this._text = String(value); this.replaceChildren() }
}

function makeEnvironment(injectionMode) {
  const cleanups = [], effects = [], registrations = [], consoleErrors = []
  let injectionDisposals = 0
  const document = { body: new FakeElement('body'), createElement: tag => new FakeElement(tag), createTextNode: text => ({ textContent: String(text), parentNode: null }) }
  const React = {
    Component: class Component { constructor(props) { this.props = props || {}; this.state = {} } setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state, this.props) : next) } } },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useEffect(effect) { const cleanup = effect(); effects.push(cleanup); return undefined },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useRef(initial) { return { current: initial } },
  }
  let loadedModule
  const window = { __ModuleLoader__: { load(module) { loadedModule = module } } }
  const globals = {
    window, document, URL, Promise, AbortController, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, queueMicrotask, console: { ...console, error(...args) { consoleErrors.push(args) } },
    location: { href: 'dsh-app://app/' }, fetch: async () => { throw new Error('unexpected fetch in startup fixture') },
  }
  vm.runInNewContext(clientSource, globals, { filename: 'client.js' })
  assert.ok(loadedModule, 'DSH ModuleLoader receives generated Client module')
  const plugin = loadedModule.factory(name => { assert.equal(name, 'react'); return React })
  const ctx = {
    locale: { bind: () => key => key, register: () => () => {} },
    theme: { overrideTokens: () => () => {} },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) }, retain() { throw new Error('unexpected session retain') } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }) }, create() { throw new Error('unexpected workspace create') } },
    uiWorkspace: { connectWorkspace() { throw new Error('unexpected workspace connection') }, createDirectory() {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    slots: {
      inject(_name, fn) { return fn() },
      register(metadata, component) { const value = { metadata, component }; registrations.push(value); return value },
    },
    inject(keys, callback) {
      assert.deepEqual(Array.from(keys), ['remote.speech'])
      if (injectionMode === 'missing') {
        const missing = Promise.reject(Object.assign(new Error('optional service is not mounted'), { code: 'SERVICE_NOT_FOUND' }))
        missing.dispose = () => { injectionDisposals += 1 }
        return missing
      }
      const injected = { remote: { speech: { async catalog() { return { ok: true, value: { selection: null, providers: [] } } } }, $stream() { throw new Error('stream not requested during mount') } } }
      const onDispose = callback(injected)
      const available = Promise.resolve(injected)
      available.dispose = () => { injectionDisposals += 1; if (typeof onDispose === 'function') onDispose() }
      return available
    },
  }
  Object.defineProperty(ctx, 'remote', { get() { throw new Error('unguarded ctx.remote access') } })
  plugin.apply(ctx)
  return { registrations, effects, cleanups, consoleErrors, document, ctx, get injectionDisposals() { return injectionDisposals } }
}

function voiceOverlay(env) {
  const registration = env.registrations.find(item => item.metadata?.id === 'chonkyfish-voice')
  assert.ok(registration, 'global voice overlay is registered independently of chat panels')
  return registration.component
}
function allNodes(node, output = []) { output.push(node); for (const child of node.children || []) allNodes(child, output); return output }
const pause = () => new Promise(resolve => setTimeout(resolve, 0))

// Missing optional Remote: module apply, core panels, and headless controller owner still succeed.
const missing = makeEnvironment('missing')
assert.ok(missing.registrations.some(item => item.metadata?.id === 'chonkyfish'))
voiceOverlay(missing)()
assert.equal(missing.document.body.children.length, 0, 'controller owner creates no global voice panel')
await pause()
assert.equal(missing.registrations.filter(item => item.metadata?.name === 'main').length > 0, true, 'core plugin panels remain registered')
assert.deepEqual(missing.consoleErrors, [], 'missing optional speech does not crash the plugin or headless controller owner')
missing.effects.at(-1)?.()

// Present optional Remote: Cordis supplies the guarded scope, and disposal runs its cleanup.
const present = makeEnvironment('present')
voiceOverlay(present)()
await pause()
assert.equal(present.document.body.children.length, 0, 'optional Remote mounts without adding a global voice panel')
assert.deepEqual(present.consoleErrors, [])
present.effects.at(-1)?.()
await pause()
assert.equal(present.injectionDisposals, 1, 'disposing the React overlay releases the Cordis optional-service injection')

console.log('DSH generated Client startup: optional Cordis injection, headless controller lifecycle, composer button, and bundle integrity passed')
