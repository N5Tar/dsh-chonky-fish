import vm from 'node:vm'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Run the real chat projection regression as part of the existing client suite.
await import('./run-chat-surface.mjs')

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const client = await readFile(join(root, 'client.js'), 'utf8')
const spec = await readFile(join(root, 'core/contracts/spec.js'), 'utf8')
const sourceOnly = process.argv.includes('--source-only')
const markup = await readFile(join(root, 'app/dsh/ui/original.html'), 'utf8')
const cardStyles = markup.match(/\.cf-social-card\{([^}]+)\}/)?.[1] || ''
for (const rule of ['min-width:0', 'white-space:normal', 'overflow-wrap:anywhere']) assert.ok(cardStyles.includes(rule), `card must wrap long descriptions: ${rule}`)
// Resolve the competing selectors for a card button; source order alone is insufficient.
// This bounded cascade check models the exact selectors used here, not a browser CSS engine.
const cardWhiteSpace = css => {
  const specificity = { '.cf-social-card': 10, '#social-panel button': 101, '#social-panel .cf-social-card': 110 }
  let winner = { priority: -1, value: '' }
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of match[1].split(',').map(value => value.trim())) {
      if (!(selector in specificity)) continue
      for (const declaration of match[2].matchAll(/(?:^|;)\s*white-space\s*:\s*([^;]+)/g)) {
        const important = declaration[1].includes('!important')
        const priority = specificity[selector] + (important ? 10000 : 0)
        if (priority >= winner.priority) winner = { priority, value: declaration[1].replace(/\s*!important\s*$/, '').trim() }
      }
    }
  }
  return winner.value
}
assert.equal(cardWhiteSpace(markup), 'normal', 'card wrapping must win over #social-panel button nowrap')
const withoutOverride = markup.replace(/#social-panel \.cf-social-card\{[^}]*\}/g, '')
assert.equal(cardWhiteSpace(withoutOverride), 'nowrap', 'regression check detects the original specificity bug, despite base card normal')
// The primary inbox action must beat the higher-specificity generic row button color.
function inboxButtonColor(css, hover = false) {
  const selectors = { '.cf-social-row button': 11, '.cf-social-row button.primary-mini': 21, '#social-panel .cf-social-row button': 111, '#social-panel .primary-mini': 110, '#social-panel .cf-social-row button.primary-mini': 121 }
  if (hover) selectors['#social-panel .cf-social-row button.primary-mini:hover'] = 131
  let priority = -1, result
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of match[1].split(',').map(s => s.trim())) {
      if (!(selector in selectors)) continue
      for (const declaration of match[2].matchAll(/(?:^|;)\s*color\s*:\s*([^;]+)/g)) {
        const rank = selectors[selector] + (declaration[1].includes('!important') ? 10000 : 0)
        if (rank >= priority) { priority = rank; result = declaration[1].replace(/\s*!important\s*$/, '').trim() }
      }
    }
  }
  return result
}
assert.equal(inboxButtonColor(markup), '#fff', 'inbox primary action must have readable white text')
assert.equal(inboxButtonColor(markup, true), '#fff', 'hover preserves white text')
const oldPrimarySelector = markup.replaceAll('#social-panel .cf-social-row button.primary-mini', '#social-panel .primary-mini')
assert.equal(inboxButtonColor(oldPrimarySelector), '#30669c', 'test detects original dark-on-dark specificity regression')
assert.ok(client.includes('#social-panel .cf-social-row button.primary-mini'), 'rebuilt bundle ships specificity fix')
assert.match(markup, /id="social-client-secret" type="password" maxlength="8192"/)
assert.equal(markup.includes('social-client-secret-env'), false)

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
// `inbound` is no longer forbidden: it now names read-only arrival diagnostics.
for (const removed of ['social-module-enabled', 'social-enabled', 'social-direct', 'social-group', 'social-channel', 'social-allowlist', 'allowedConversations', 'inbound:']) {
  assert.equal(client.includes(removed), false, `client.js 不应再有 ${removed}`)
}

// Every static id the page controller looks up must exist in the shipped markup
// (client.js holds the final PAGE_HTML, including the confirm dialog appended by build.mjs).
const runtime = await readFile(join(root, 'app/dsh/ui/runtime.js'), 'utf8')
if (!sourceOnly) {
  for (const marker of ['SOCIAL_NO_MAIN_SESSION', '重试投递', 'function socialStartRefresh', '正常回复由后台自动发送']) assert.ok(client.includes(marker), `client.js 尚未包含自动投递 UI：${marker}（等待 Lead build）`)
}
const lookedUp = new Set([...runtime.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map(match => match[1]))
const missing = [...lookedUp].filter(id => !client.includes(`id=\\"${id}\\"`) && !(sourceOnly && markup.includes(`id="${id}"`)))
assert.deepEqual(missing, [], `runtime.js 引用了 markup 中不存在的 id：${missing.join(', ')}`)
console.log('social-client: PASS (panel entry, panels preserved, no implicit reply/send surface' + (sourceOnly ? '; source markup fallback, bundle freshness NOT verified' : '') + ')')

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
const intervalCallbacks = new Map()
const documentListeners = {}
let nextInterval = 0
const context = vm.createContext({
  setInterval(callback, delay) { assert.equal(delay, 3000); const id = ++nextInterval; intervalCallbacks.set(id, callback); return id },
  clearInterval(id) { intervalCallbacks.delete(id) },
  $: getNode, document: { createElement: () => new Element(), hidden: false, addEventListener: (name, callback) => { documentListeners[name] = callback }, removeEventListener: name => { delete documentListeners[name] } },
  clearNode: node => { node.children = [] }, socialPanel: new Element(),
  toast() {}, stateBridge: null, ROUTE_SPEC: {},
})
vm.runInContext(runtime.slice(runtime.indexOf("  var socialButton ="), runtime.indexOf('  /* --------------------------------------------------------------- stage */')), context)
const text = node => (node.textContent || '') + node.children.map(text).join(' ')
const evaluate = source => vm.runInContext(source, context)
evaluate('var originalLoadSocial = loadSocial')
for (const stale of ['默认手动', '手动点「查看」', '不会自动调用模型', '现在让鱼鱼看这批新消息', '保留平台、账号与会话来源', '标明外部社交来源', '普通final只本地', '只能tool发送']) {
  assert.equal(runtime.includes(stale) || markup.includes(stale), false, `remove stale manual delivery copy: ${stale}`)
}
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
assert.match(text(getNode('social-catalog')), /未配置/)
assert.match(text(getNode('social-catalog')), /绑定码认领主人/, 'card description is retained and wraps through CSS')
assert.ok(getNode('social-catalog').children[1].children.some(node => node.className === 'cf-social-card-description'))
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
assert.match(text(getNode('social-status')), /主人私聊进入当前主会话/)
assert.match(text(getNode('social-status')), /先打开大肥鱼聊天页面/)
assert.match(text(getNode('social-notices')), /重试投递/)
assert.equal(text(getNode('social-notices')).includes('外部社交来源'), false)
assert.match(text(getNode('social-status')), /正常回复由后台自动发送/)
assert.equal(text(getNode('social-status')).includes('消息来源：'), false)
for (const code of ['SOCIAL_NO_MAIN_SESSION', 'SOCIAL_MAIN_SESSION_INVALID', 'SOCIAL_AGENT_BUSY', 'SOCIAL_DELIVERY_UNCERTAIN']) {
  context.reasonCode = code
  evaluate("socialPayload.bridge = { mode: 'main-session-auto', available: false, reason: reasonCode }; renderSocialStatus()")
  assert.equal(text(getNode('social-status')).includes(code), false, 'bridge errors are localized')
}
evaluate("socialPayload.bridge = { mode: 'main-session-auto', targetSessionId: 'main-example', available: true }; renderSocialStatus()")
assert.match(text(getNode('social-status')), /main-example/)
assert.match(text(getNode('social-status')), /自动投递已就绪/)
context.replyFixture = ['waiting', 'pending', 'sending', 'sent', 'failed', 'unknown', 'canceled'].map(status => ({ sessionId: 'main-example', inboundMessageId: 'opaque-inbound', assistantMessageId: 'opaque-assistant', status, errorCode: status === 'failed' ? 'SOCIAL_WEBHOOK_EXPIRED' : undefined }))
evaluate('socialPayload.bridge.replies = replyFixture; renderSocialStatus()')
for (const label of ['等待回复完成', '等待发送', '发送中', '已发送', '发送失败', '发送结果不确定，请勿重复发送', '已取消发送']) assert.ok(text(getNode('social-status')).includes(label), 'reply state is readable: ' + label)
assert.match(text(getNode('social-status')), /回复地址已过期/)
assert.equal(text(getNode('social-status')).includes('opaque-'), false, 'reply status does not expose message ids or routing metadata')
context.replyFixture = Array.from({ length: 15 }, () => ({ status: 'sent' }))
evaluate('socialPayload.bridge.replies = replyFixture; renderSocialStatus()')
assert.equal((text(getNode('social-status')).match(/已发送/g) || []).length, 1, 'successful replies render once, not one row per reply')
assert.match(text(getNode('social-status')), /已发送 10 条/)
assert.match(text(getNode('social-status')), /最近回复（最多 10 条）/)
evaluate('socialPayload.bridge.replies = []; renderSocialStatus()')
assert.doesNotMatch(text(getNode('social-status')), /最近回复/)
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
assert.equal(getNode('social-new').hidden, false, 'DingTalk Stream supports setup')
assert.match(text(getNode('social-list')), /还没有配置 钉钉/)
assert.match(getNode('social-detail-description').textContent, /绑定码认领主人/)

// Exercise real navigation, form validation and save serialization, stubbing only POST.
const submissions = []
context.captureSubmit = body => submissions.push(JSON.parse(JSON.stringify(body)))
evaluate('var originalSubmit = socialSubmit; socialSubmit = captureSubmit')
getNode('social-provider').options = ['napcat', 'snowluma', 'onebots-discord', 'dingtalk-stream'].map(value => ({ value }))
getNode('social-new').listeners.click()
assert.equal(getNode('social-provider').value, 'dingtalk-stream')
assert.equal(getNode('social-platform').value, 'dingtalk')
assert.equal(getNode('social-dingtalk-fields').hidden, false)
for (const field of ['social-endpoint', 'social-token-env']) assert.equal(getNode(field).disabled, true)
for (const field of ['social-onebot-endpoint-field', 'social-onebot-token-field']) assert.equal(getNode(field).hidden, true)
for (const field of ['social-client-id', 'social-client-secret', 'social-robot-code']) assert.equal(getNode(field).disabled, false)
assert.deepEqual(getNode('social-provider').options.filter(option => !option.disabled).map(option => option.value), ['dingtalk-stream'])
getNode('social-id').value = 'ding-main'
getNode('social-client-id').value = ' app-key-example '
getNode('social-robot-code').value = 'robot-initial'
getNode('social-save').listeners.click()
assert.equal(submissions.length, 0, 'new connection requires a direct secret')
assert.match(getNode('social-form-error').textContent, /Client Secret/)
getNode('social-client-secret').value = '   '
getNode('social-save').listeners.click()
assert.equal(submissions.length, 0, 'whitespace-only secret is rejected, not treated as omitted')
getNode('social-client-secret').value = 's'.repeat(8193)
getNode('social-save').listeners.click()
assert.equal(submissions.length, 0, 'secret max8192')
getNode('social-client-secret').value = 'test-only-secret-initial'
getNode('social-robot-code').value = ''
getNode('social-save').listeners.click()
assert.equal(submissions.length, 0, 'Robot Code is required, never defaulted from Client ID')
assert.match(getNode('social-form-error').textContent, /Robot Code/)
getNode('social-robot-code').value = 'r'.repeat(257)
getNode('social-save').listeners.click()
assert.equal(submissions.length, 0, 'Robot Code is limited to 256 characters')
getNode('social-robot-code').value = ' robot-initial '
// Even stale hidden OneBot values cannot leak into the DingTalk payload.
getNode('social-endpoint').value = 'ws://stale.example'
getNode('social-token-env').value = 'STALE_TOKEN'
getNode('social-save').listeners.click()
const added = submissions.at(-1).config
assert.deepEqual(added.connections.slice(0, 3), payload.config.connections, 'adding DingTalk preserves QQ and Discord')
assert.deepEqual(added.connections[3], { id: 'ding-main', platform: 'dingtalk', provider: 'dingtalk-stream', clientId: 'app-key-example', clientSecret: 'test-only-secret-initial', robotCode: 'robot-initial' })
// Model the GET contract: the backend retains secrets, returning only a presence marker.
const redact = config => ({ ...config, connections: config.connections.map(row => {
  if (row.platform !== 'dingtalk') return { ...row }
  const { clientSecret, clientSecretEnv, ...safe } = row
  return { ...safe, clientSecretSet: !!clientSecret || row.clientSecretSet === true }
}) })
const redactedAdded = redact(added)
context.savedConfig = redactedAdded
evaluate('socialPayload.config = savedConfig; socialSelect(3)')
assert.equal(getNode('social-client-id').value, 'app-key-example')
assert.equal(getNode('social-client-secret').value, '', 'secret never refilled')
assert.equal(getNode('social-endpoint').value, '')
getNode('social-save').listeners.click()
assert.deepEqual(submissions.at(-1).config, redactedAdded, 'empty edit preserves secret via marker without plaintext')
for (const [field, value] of [['social-id', 'ding-renamed'], ['social-client-id', 'other-app'], ['social-robot-code', 'other-robot']]) {
  const before = submissions.length
  const old = getNode(field).value
  getNode(field).value = value
  getNode('social-save').listeners.click()
  assert.equal(submissions.length, before, 'identity changes require re-entered secret: ' + field)
  getNode(field).value = old
}
evaluate('socialPayload.config.connections[3].clientSecretSet = false')
const beforeMigration = submissions.length
getNode('social-save').listeners.click()
assert.equal(submissions.length, beforeMigration, 'legacy env configuration needs a new direct secret')
evaluate('socialPayload.config.connections[3].clientSecretSet = true')
getNode('social-robot-code').value = ' robot-example '
getNode('social-client-secret').value = 'test-only-secret-replacement'
getNode('social-save').listeners.click()
const editedPost = submissions.at(-1).config
assert.equal(editedPost.connections.length, 4)
assert.equal(editedPost.connections[3].robotCode, 'robot-example')
assert.equal(editedPost.connections[3].clientSecret, 'test-only-secret-replacement')
assert.deepEqual(editedPost.connections.slice(0, 3), added.connections.slice(0, 3))
const edited = redact(editedPost)
context.savedConfig = edited
evaluate('socialPayload.config = savedConfig')
getNode('social-cancel').listeners.click()
assert.equal(getNode('social-client-secret').value, '', 'leaving form clears secret')
assert.match(text(getNode('social-list')), /已保存（不回显）/)
assert.equal(text(getNode('social-list')).includes('test-only-secret'), false)
assert.match(text(getNode('social-list')), /robot-example/)
evaluate("socialPayload.connections.push({ connectionId: 'ding-main', platform: 'dingtalk', status: 'error', reason: 'SOCIAL_DINGTALK_SECRET_MISSING' }); renderSocialView()")
assert.match(text(getNode('social-list')), /未找到钉钉 Client Secret/)
assert.equal(text(getNode('social-list')).includes('SOCIAL_DINGTALK_SECRET_MISSING'), false)
assert.match(evaluate("socialErrorMessage(new Error('SOCIAL_WEBHOOK_EXPIRED'))"), /新消息/)
assert.match(evaluate("socialErrorMessage(new Error('SOCIAL_SEND_UNKNOWN'))"), /勿重复/)
getNode('social-back').listeners.click()
getNode('social-catalog').children[0].listeners.click()
evaluate('socialSelect(0)')
assert.equal(getNode('social-dingtalk-fields').hidden, true)
assert.equal(getNode('social-client-id').disabled, true)
assert.equal(getNode('social-client-secret').disabled, true)
assert.equal(getNode('social-robot-code').disabled, true)
assert.equal(getNode('social-onebot-endpoint-field').hidden, false)
assert.equal(getNode('social-onebot-token-field').hidden, false)
assert.equal(getNode('social-endpoint').disabled, false)
assert.equal(getNode('social-token-env').disabled, false)
assert.deepEqual(getNode('social-provider').options.filter(option => !option.disabled).map(option => option.value), ['napcat', 'snowluma'])
assert.equal(getNode('social-client-id').value, '')
getNode('social-save').listeners.click()
assert.deepEqual(submissions.at(-1).config, edited, 'editing QQ after DingTalk preserves all config')
evaluate('socialSelect(2)')
assert.equal(getNode('social-provider').value, 'onebots-discord')
assert.deepEqual(getNode('social-provider').options.filter(option => !option.disabled).map(option => option.value), ['onebots-discord'])
getNode('social-save').listeners.click()
assert.deepEqual(submissions.at(-1).config, edited, 'editing Discord after DingTalk preserves all config')
evaluate("socialPlatform = 'dingtalk'; socialResetForm()")
for (const field of ['social-id', 'social-endpoint', 'social-token-env', 'social-client-id', 'social-client-secret', 'social-robot-code']) assert.equal(getNode(field).value, '', 'new form clears stale values: ' + field)
assert.equal(getNode('social-provider').value, 'dingtalk-stream')
// Exercise successful submission and deletion handlers, mocking only transport/confirmation.
const transport = []
const messages = []
context.mockApi = (method, body) => { transport.push(JSON.parse(JSON.stringify(body))); return Promise.resolve({ ok: true }) }
context.ask = () => Promise.resolve(true)
context.toast = message => messages.push(message)
evaluate('socialApi = mockApi; loadSocial = function () {}; socialSelect(3); socialSubmit = originalSubmit')
getNode('social-client-secret').value = ' test-only-secret-success '
getNode('social-save').listeners.click()
await new Promise(resolve => setImmediate(resolve))
assert.equal(getNode('social-client-secret').value, '', 'successful save clears secret input')
assert.equal(evaluate('socialScreen'), 'detail')
assert.equal(transport.at(-1).config.connections[3].clientSecret, ' test-only-secret-success ', 'secret is sent verbatim, not trimmed')
evaluate('socialSelect(0)')
getNode('social-client-secret').value = 'test-only-secret-delete'
evaluate('socialDeleteConnection()')
await new Promise(resolve => setImmediate(resolve))
assert.equal(getNode('social-client-secret').value, '', 'successful deletion clears secret without waiting for refresh')
const deleteConfig = transport.at(-1).config
assert.equal(deleteConfig.connections.some(row => row.id === 'qq-main'), false)
assert.deepEqual(deleteConfig.connections.find(row => row.id === 'ding-main'), edited.connections[3], 'deleting another connection preserves redacted secret marker')
assert.equal(JSON.stringify(deleteConfig).includes('test-only-secret'), false)
assert.equal(messages.some(message => message.includes('test-only-secret')), false)
// Closing the dashboard modal also clears a typed secret.
context.modal = { classList: { contains: () => true, remove() {} } }
context.focusNode = () => {}
context.modalKind = 'social'
context.modalReturnFocus = null
vm.runInContext(runtime.slice(runtime.indexOf('  function closeModal()'), runtime.indexOf('  if (modal) {')), context)
getNode('social-client-secret').value = 'test-only-secret-cancel'
evaluate('closeModal()')
assert.equal(getNode('social-client-secret').value, '')
console.log('social-dingtalk: PASS (direct secret, redacted edits, required migration/identity refresh, save/exit clearing, delete preservation, wrapping)')

// Retry uses the existing view action without asking for another model-consumption confirmation.
context.ask = () => assert.fail('delivery retry must not request confirmation')
for (const [status, label] of [['viewed', /已投递到对应会话/], ['busy', /稍后会自动投递/], ['pending', /请先打开大肥鱼聊天页面/], ['empty', /没有待投递消息/]]) {
  context.mockApi = (method, body) => { assert.equal(method, 'POST'); assert.equal(body.action, 'view'); return Promise.resolve({ result: { status } }) }
  evaluate("socialApi = mockApi; socialView('qq-main', { type: 'direct', id: '123' })")
  await new Promise(resolve => setImmediate(resolve))
  assert.match(messages.at(-1), label)
}

// Execute real modal lifecycle and real loadSocial with deterministic 3-second timers.
const modalClasses = new Set()
context.modal = { classList: { contains: name => modalClasses.has(name), add: name => modalClasses.add(name), remove: name => modalClasses.delete(name) } }
context.modalTitle = null
for (const panel of ['walletPanel', 'settingsPanel', 'sensePanel', 'diaryPanel']) context[panel] = new Element()
for (const render of ['renderPersona', 'renderWallet', 'renderSense', 'renderDiary']) context[render] = () => {}
context.focusedNode = () => null
context.stateBridge = { routes: { social: '/test-social' } }
context.fetch = () => assert.fail('network is mocked at socialApi')
let gets = 0
context.mockApi = method => { assert.equal(method, 'GET'); gets++; return Promise.resolve(payload) }
vm.runInContext(runtime.slice(runtime.indexOf('  function openModal(kind)'), runtime.indexOf('  if (modal) {')), context)
evaluate("socialApi = mockApi; loadSocial = originalLoadSocial; socialScreen = 'catalog'; openModal('social')")
await new Promise(resolve => setImmediate(resolve))
assert.equal(intervalCallbacks.size, 1, 'opening social starts one timer')
assert.equal(gets, 1)
evaluate("socialPlatform = 'dingtalk'; socialResetForm()")
getNode('social-id').value = 'poll-draft'
getNode('social-client-secret').value = 'test-only-poll-draft'
intervalCallbacks.values().next().value()
await new Promise(resolve => setImmediate(resolve))
assert.equal(gets, 2)
assert.equal(evaluate('socialScreen'), 'form')
assert.equal(getNode('social-id').value, 'poll-draft', 'poll preserves unsaved fields')
assert.equal(getNode('social-client-secret').value, 'test-only-poll-draft', 'poll never clears typed secret')
evaluate('socialBusy = true')
intervalCallbacks.values().next().value()
assert.equal(gets, 2, 'poll does not race a save or retry')
evaluate('socialBusy = false')
context.document.hidden = true
documentListeners.visibilitychange()
assert.equal(intervalCallbacks.size, 0, 'hidden browser page stops polling')
context.document.hidden = false
documentListeners.visibilitychange()
assert.equal(intervalCallbacks.size, 1, 'visible social page resumes polling')
evaluate("openModal('settings')")
assert.equal(intervalCallbacks.size, 0, 'switching modal stops polling')
documentListeners.visibilitychange()
assert.equal(intervalCallbacks.size, 0, 'visibility event cannot start polling on another modal')
evaluate("openModal('social')")
await new Promise(resolve => setImmediate(resolve))
assert.equal(intervalCallbacks.size, 1, 'reopening social restarts polling')
evaluate('closeModal()')
assert.equal(intervalCallbacks.size, 0, 'closing social stops polling')
context.pageView = 'social'
context.socialPanel.hidden = false
evaluate('renderSocial()')
await new Promise(resolve => setImmediate(resolve))
assert.equal(intervalCallbacks.size, 1, 'standalone social page polls without an open modal')
context.timers = new Set()
for (const name of ['toastTimer', 'poseTimer', 'fileSaveTimer', 'realUnsubscribe', 'confirmResolve']) context[name] = null
context.onConfirmKeydown = () => {}
context.onModalKeydown = () => {}
vm.runInContext('var disposeTest = ' + runtime.slice(runtime.indexOf('  return function dispose() {') + '  return '.length, runtime.lastIndexOf('\n}')), context)
evaluate('disposeTest()')
assert.equal(intervalCallbacks.size, 0, 'unmounting standalone social page stops polling')
assert.equal(documentListeners.visibilitychange, undefined, 'unmount removes visibility listener')
context.pageView = 'chat'
// Retain the existing sequence guard: an older response must not replace newer status.
const pendingLoads = []
context.mockApi = () => new Promise(resolve => pendingLoads.push(resolve))
evaluate('socialApi = mockApi; loadSocial(); loadSocial()')
pendingLoads[1]({ ...payload, bridge: { targetSessionId: 'new-main', available: true } })
await new Promise(resolve => setImmediate(resolve))
pendingLoads[0]({ ...payload, bridge: { targetSessionId: 'old-main', available: true } })
await new Promise(resolve => setImmediate(resolve))
assert.equal(evaluate('socialPayload.bridge.targetSessionId'), 'new-main')
console.log('social-auto-delivery: PASS (main-session status, retry without confirmation, pending/busy, polling lifecycle, draft retention, response ordering)')
evaluate("socialPayload = null; socialScreen = 'catalog'; renderSocialView()")
assert.equal(getNode('social-catalog').children.length, 2)
assert.match(text(getNode('social-catalog')), /状态不可用/)
evaluate('socialLoading = true; renderSocialView()')
assert.match(text(getNode('social-catalog')), /读取中/)
evaluate("socialLoading = false; socialPayload = { configError: 'SOCIAL_STORAGE_INVALID' }; renderSocialView()")
assert.equal(getNode('social-save').disabled, true)
assert.equal(getNode('social-new').disabled, true)
console.log('social-navigation: PASS (catalog, scoped details, isolated forms, offline config, legacy, unavailable/loading/error states)')

// Pairing is a local user action; the returned secret stays in this panel memory.
context.pairFixture = {
  config: { version: 1, connections: [{ id: 'ding-pair', platform: 'dingtalk', provider: 'dingtalk-stream' }] },
  connections: [{ connectionId: 'ding-pair', platform: 'dingtalk', status: 'connected', owner: { bound: false } }], notices: [],
}
let pairingPosts = 0
context.mockApi = (method, body) => {
  assert.equal(method, 'POST'); assert.equal(body.action, 'pair_owner'); assert.equal(body.connectionId, 'ding-pair')
  pairingPosts++
  return Promise.resolve({ result: { code: 'FISH-PAIR-test-only', expiresAt: Date.now() + 600000 } })
}
evaluate("socialPayload = pairFixture; socialPlatform = 'dingtalk'; socialScreen = 'detail'; socialBusy = false; socialLoading = false; socialApi = mockApi; renderSocialView()")
let pairActions = getNode('social-list').children[0].children[1]
assert.equal(pairActions.children[0].textContent, '生成绑定码')
pairActions.children[0].listeners.click()
await new Promise(resolve => setImmediate(resolve))
assert.equal(pairingPosts, 1)
assert.equal(getNode('social-list').children[0].children[0].children.some(node => node.value === 'FISH-PAIR-test-only'), true)
assert.match(text(getNode('social-list')), /勿发到群里/)
evaluate("socialPayload.connections[0].owner.bound = true; renderSocialView()")
assert.equal(getNode('social-list').children[0].children[1].children[0].textContent, '生成改绑码')
evaluate("socialPairCodes['ding-pair'].expiresAt = 1; renderSocialView()")
assert.equal(getNode('social-list').children[0].children[0].children.some(node => node.value === 'FISH-PAIR-test-only'), false)
console.log('social-pairing: PASS (explicit local action, copyable ephemeral code, expiry, rebind label)')
evaluate("socialPayload.connections[0].connection = { health: 'healthy', connects: 1, pings: 3, pongs: 3, pongTimeouts: 0, lastPongAt: 1700000000000, lastPongRttMs: 12 }; renderSocialView()")
assert.match(text(getNode('social-list')), /Pong已确认/)
assert.match(text(getNode('social-list')), /Ping 3 \/ Pong 3/)
assert.match(text(getNode('social-list')), /不保证平台已推送消息/)
evaluate("socialPayload.connections[0].connection.health = 'disconnected'; socialPayload.connections[0].connection.lastReason = 'SOCIAL_PONG_TIMEOUT'; renderSocialView()")
assert.match(text(getNode('social-list')), /未收到Pong.*自动重连/)
console.log('social-liveness: PASS (measured heartbeats and honest connection-only status)')

// Execute the actual bundled save handler: unreadable config must never POST.
const saveHandler = client.slice(client.indexOf('  function socialSaveConfig()'), client.indexOf('  function socialDeleteConnection()'))
for (const payload of [{ config: null, configError: 'SOCIAL_STORAGE_INVALID' }, { config: null }]) {
  const messages = []
  const context = { socialPayload: payload, toast: message => messages.push(message), socialReadForm: () => assert.fail('must not read a form over unreadable config'), socialSubmit: () => assert.fail('must not overwrite unreadable config') }
  vm.runInNewContext(saveHandler + ';socialSaveConfig()', context)
  assert.equal(messages.length, 1)
  assert.match(messages[0], /阻止覆盖/)
}
