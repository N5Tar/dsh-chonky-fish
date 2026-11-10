import vm from 'node:vm'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const client = await readFile(join(root, 'client.js'), 'utf8')
const spec = await readFile(join(root, 'src/resources/spec.js'), 'utf8')

// The built bundle must actually ship the panel entry, not only the Host route.
for (const marker of ['social-button', 'social-panel', 'function socialApi', 'function socialView', 'function socialSaveConfig', 'SOCIAL_ERROR_LABELS']) {
  assert.ok(client.includes(marker), `client.js 缺少 ${marker}（先运行 node build.mjs）`)
}
// Existing panels must survive the rebuild.
for (const marker of ['diary-panel', 'sense-panel', 'wallet-panel']) {
  assert.ok(client.includes(marker), `client.js 丢失 ${marker}`)
}
// The route comes from the shared resource spec, not a hardcoded string in the page.
assert.ok(spec.includes("social: '/chonkyfish/social'"), '资源规格缺少社交路由')
assert.ok(client.includes('/chonkyfish/social'), 'client.js 未包含社交路由投影')
// The panel must not offer an implicit auto-reply switch or a direct send action.
// The panel keeps only connection essentials: no switches, scope pickers or allowlists.
for (const removed of ['social-module-enabled', 'social-enabled', 'social-direct', 'social-group', 'social-channel', 'social-allowlist', 'allowedConversations', 'inbound']) {
  assert.equal(client.includes(removed), false, `client.js 不应再有 ${removed}`)
}

// Every static id the page controller looks up must exist in the shipped markup
// (client.js holds the final PAGE_HTML, including the confirm dialog appended by build.mjs).
const runtime = await readFile(join(root, 'src/runtime.js'), 'utf8')
const lookedUp = new Set([...runtime.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map(match => match[1]))
const missing = [...lookedUp].filter(id => !client.includes(`id=\\"${id}\\"`))
assert.deepEqual(missing, [], `runtime.js 引用了 markup 中不存在的 id：${missing.join(', ')}`)
console.log('social-client: PASS (panel entry, panels preserved, no implicit reply/send surface)')

// Execute the actual controller with a small DOM, without network or model calls.
class Element {
  constructor() { this.children = []; this.listeners = {}; this.hidden = false; this.value = ''; this.options = [] }
  appendChild(child) { this.children.push(child); return child }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1) }
  get firstChild() { return this.children[0] }
  addEventListener(name, callback) { this.listeners[name] = callback }
  setAttribute() {}
  focus() { this.focused = true }
  querySelector() { return this.children[0] }
}
const nodes = new Map()
const getNode = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id) }
const context = vm.createContext({
  $: getNode, document: { createElement: () => new Element() },
  clearNode: node => { node.children = [] }, socialPanel: new Element(),
  toast() {}, stateBridge: null, ROUTE_SPEC: {},
})
vm.runInContext(runtime.slice(runtime.indexOf("  var socialButton ="), runtime.indexOf('  /* --------------------------------------------------------------- stage */')), context)
const text = node => (node.textContent || '') + node.children.map(text).join(' ')
const evaluate = source => vm.runInContext(source, context)
const payload = {
  config: { version: 1, connections: [
    { id: 'qq-main', platform: 'qq', provider: 'napcat', endpoint: 'ws://localhost:3001', tokenEnv: 'QQ_TOKEN' },
    { id: 'qq-offline', platform: 'qq', provider: 'snowluma', endpoint: 'ws://localhost:3002' },
    { id: 'old-discord', platform: 'discord', provider: 'onebots-discord', endpoint: 'ws://localhost:3003' },
  ] },
  connections: [{ connectionId: 'qq-main', platform: 'qq', provider: 'napcat', status: 'connected' }],
  notices: [
    { connectionId: 'qq-main', conversation: { type: 'direct', id: '123' }, unreadCount: 2 },
    { connectionId: 'old-discord', conversation: { type: 'direct', id: '456' }, unreadCount: 7 },
  ],
}
context.fixture = payload
evaluate('socialPayload = fixture; renderSocialView()')
assert.equal(getNode('social-catalog').children.length, 3, 'legacy Discord remains accessible')
assert.match(text(getNode('social-catalog')), /部分连接/)
assert.match(text(getNode('social-catalog')), /暂未接入/)
assert.equal(getNode('social-detail').hidden, true)
assert.equal(getNode('social-form').hidden, true)
getNode('social-catalog').children[0].listeners.click()
assert.equal(getNode('social-catalog').hidden, true)
assert.equal(getNode('social-detail').hidden, false)
assert.equal(getNode('social-form').hidden, true)
assert.equal(getNode('social-list').children.length, 2, 'saved offline connection is visible')
assert.match(text(getNode('social-list')), /QQ_TOKEN/)
assert.match(text(getNode('social-list')), /localhost:3002/)
assert.equal(getNode('social-unread-count').textContent, '2', 'unreads are scoped to platform')
getNode('social-new').listeners.click()
assert.equal(getNode('social-form').hidden, false)
assert.equal(getNode('social-detail').hidden, true, 'creation never mixes with configured connections')
assert.equal(getNode('social-delete').hidden, true)
getNode('social-id').value = 'draft'
evaluate('renderSocialView()')
assert.equal(getNode('social-id').value, 'draft', 'refresh does not reset an unfinished form')
getNode('social-cancel').listeners.click()
evaluate('socialSelect(0)')
assert.equal(getNode('social-id').value, 'qq-main')
assert.equal(getNode('social-delete').hidden, false)
assert.equal(getNode('social-detail').hidden, true)
getNode('social-cancel').listeners.click()
getNode('social-back').listeners.click()
getNode('social-catalog').children[1].listeners.click()
assert.equal(getNode('social-new').hidden, true, 'unsupported driver must not offer broken setup')
assert.match(text(getNode('social-list')), /尚未接入钉钉驱动/)
evaluate("socialPayload = null; socialScreen = 'catalog'; renderSocialView()")
assert.equal(getNode('social-catalog').children.length, 2)
assert.match(text(getNode('social-catalog')), /状态不可用/)
evaluate('socialLoading = true; renderSocialView()')
assert.match(text(getNode('social-catalog')), /读取中/)
evaluate("socialLoading = false; socialPayload = { configError: 'SOCIAL_STORAGE_INVALID' }; renderSocialView()")
assert.equal(getNode('social-save').disabled, true)
assert.equal(getNode('social-new').disabled, true)
console.log('social-navigation: PASS (catalog, scoped details, isolated forms, offline config, legacy, unavailable/loading/error states)')

// Execute the actual bundled save handler: unreadable config must never POST.
const saveHandler = client.slice(client.indexOf('  function socialSaveConfig()'), client.indexOf('  function socialDeleteConnection()'))
for (const payload of [{ config: null, configError: 'SOCIAL_STORAGE_INVALID' }, { config: null }]) {
  const messages = []
  const context = { socialPayload: payload, toast: message => messages.push(message), socialReadForm: () => assert.fail('must not read a form over unreadable config'), socialSubmit: () => assert.fail('must not overwrite unreadable config') }
  vm.runInNewContext(saveHandler + ';socialSaveConfig()', context)
  assert.equal(messages.length, 1)
  assert.match(messages[0], /阻止覆盖/)
}
