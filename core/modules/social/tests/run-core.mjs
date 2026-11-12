import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigStore, validateConfig } from '../config.js'
import { PROVIDERS } from '../providers.js'
import { createIdentityStore } from '../identity-store.js'
import { createScopeAuthority, acceptMessage } from '../policy.js'
import { normalizeEvent, createOneBotDriver } from '../drivers/onebot.js'

const target = { type: 'direct', id: '20002' }
const connection = { id: 'discord-main', platform: 'discord', provider: 'onebots-discord', endpoint: 'ws://127.0.0.1:3001/' }
const config = { version: 1, connections: [connection] }
assert.deepEqual(Object.keys(PROVIDERS).sort(), ['dingtalk-stream', 'onebots-discord'])
assert.deepEqual(validateConfig(config), config)
const dingConnection = { id: 'ding', platform: 'dingtalk', provider: 'dingtalk-stream', clientId: 'ding-app', robotCode: 'ding-robot', clientSecret: 'test-secret-value' }
assert.deepEqual(validateConfig({ version: 1, connections: [connection, dingConnection] }).connections, [connection, dingConnection])
for (const patch of [{ endpoint: 'wss://example.com' }, { tokenEnv: 'TOKEN' }, { clientSecret: '' }, { clientSecret: 123 }, { clientSecret: 'x'.repeat(8193) }, { clientSecretEnv: 'DING_SECRET' }, { clientId: '' }, { clientId: ' app ' }, { robotCode: '' }, { robotCode: undefined }, { clientSecretEnv: '' }, { clientSecretEnv: 'not valid!' }, { platform: 'discord' }, { provider: 'onebots-discord' }]) {
  assert.throws(() => validateConfig({ version: 1, connections: [{ ...dingConnection, ...patch }] }))
}
// 只保留连接本身；旧的开关 / 接收范围 / 允许名单字段一律被拒绝。
for (const patch of [{ protocol: 'onebot-v12' }, { provider: '__proto__' }, { provider: 'dingtalk-stream' }, { endpoint: 'ws://example.com/' }, { endpoint: 'ws://a:secret@localhost/' }, { endpoint: 'ws://localhost/?access_token=secret' }, { enabled: true }, { inbound: {} }, { allowedConversations: [] }]) {
  assert.throws(() => validateConfig({ version: 1, connections: [{ ...connection, ...patch }] }))
}
assert.throws(() => validateConfig({ version: 1, enabled: true, connections: [connection] }))
assert.throws(() => validateConfig({ version: 1, connections: [connection, connection] }))
const root = await mkdtemp(join(tmpdir(), 'social-core-'))
const legacyFile = join(root, 'legacy-config.json')
const retiredConnection = { id: 'retired', platform: 'legacy', provider: 'retired-provider', endpoint: 'ws://127.0.0.1:3002/' }
await writeFile(legacyFile, JSON.stringify({ version: 1, connections: [connection, retiredConnection] }))
const legacyConfigStore = createConfigStore(legacyFile)
assert.deepEqual(await legacyConfigStore.read(), config, 'unavailable providers do not disable supported connections')
assert.throws(() => validateConfig({ version: 1, connections: [retiredConnection] }), { code: 'SOCIAL_UNSUPPORTED_PROVIDER' })
const changedConnection = { ...connection, id: 'discord-updated' }
await legacyConfigStore.write({ version: 1, connections: [changedConnection] })
const preservedLegacyRows = JSON.parse(await readFile(legacyFile, 'utf8')).connections
assert.deepEqual(preservedLegacyRows, [changedConnection, retiredConnection], 'unavailable config rows remain on disk when supported settings change')
assert.deepEqual(await legacyConfigStore.read(), { version: 1, connections: [changedConnection] })
const store = createIdentityStore(join(root, 'identities.json'))
const self = { connectionId: connection.id, platform: 'discord', provider: 'onebots-discord', protocolUserId: 'mapped-self' }
const first = await store.verify(self)
assert.equal(first.status, 'connected')
assert.equal((await store.verify(self)).identityRevision, first.identityRevision)
assert.equal((await store.verify({ ...self, protocolUserId: 'other-self' })).status, 'identity_changed')
await assert.rejects(store.confirm({ connectionId: connection.id, expectedProtocolUserId: 'wrong' }))
const changed = await store.confirm({ connectionId: connection.id, expectedProtocolUserId: 'other-self' })
assert.notEqual(changed.identityRevision, first.identityRevision)
assert.equal((await store.verify({ ...changed.identity, protocolUserId: 'third-self' })).status, 'identity_changed')
await writeFile(join(root, 'broken.json'), 'broken')
await assert.rejects(createIdentityStore(join(root, 'broken.json')).verify(self))
const authority = createScopeAuthority()
assert.throws(() => authority.check({ sessionId: 'a', canSend: true }))
const scope = authority.issue({ sessionId: 'a', platform: 'discord', connectionId: connection.id, conversation: target, identityRevision: first.identityRevision })
assert.equal(authority.check(scope), scope)
authority.revoke(scope)
assert.throws(() => authority.check(scope))
const event = { type: 'message', detail_type: 'private', self: { platform: 'discord', user_id: 'mapped-self' }, user_id: '20002', message_id: 'msg-1', time: 1000, message: [{ type: 'text', data: { text: 'hi' } }] }
const message = normalizeEvent(event, connection, self)
assert.equal(message.text, 'hi')
// 配置了连接就接收：私聊/群/频道不再有额外筛选，只过滤自身回声和机器人。
assert.equal(acceptMessage(connection, self, message), true)
assert.equal(acceptMessage(connection, self, { ...message, conversation: { type: 'group', id: '30003' } }), true)
assert.equal(acceptMessage(connection, self, { ...message, sender: { id: self.protocolUserId } }), false)
assert.equal(acceptMessage(connection, self, { ...message, sender: { id: '30004', isBot: true } }), false)
assert.equal(acceptMessage(connection, self, { ...message, text: 'x'.repeat(32001) }), false)
assert.equal(normalizeEvent({ ...event, message: '<@mapped-self> hi' }, connection, self), null)
assert.throws(() => normalizeEvent({ ...event, self: { platform: 'discord', user_id: 'wrong-self' } }, connection, self))
assert.throws(() => normalizeEvent({ ...event, user_id: Number.MAX_SAFE_INTEGER + 1 }, connection, self))
const channelMessage = normalizeEvent({ ...event, detail_type: 'channel', guild_id: 'guild', channel_id: 'channel', message: [{ type: 'mention', data: { user_id: 'mapped-self' } }, { type: 'text', data: { text: 'hey' } }] }, connection, self)
assert.deepEqual(channelMessage.conversation, { type: 'channel', id: 'channel', guildId: 'guild' })
assert.equal(channelMessage.mentionsSelf, true)

class Socket extends EventTarget {
  readyState = 1
  sent = []
  mode = 'success'
  send(raw) {
    const request = JSON.parse(raw); this.sent.push(request)
    if (this.mode === 'timeout' && request.action === 'send_message') return
    const data = request.action === 'get_self_info' ? { platform: 'discord', user_id: 'mapped-self', user_name: 'fish' } : { message_id: 'long-message-id' }
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data }) })))
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
const socket = new Socket()
const driver = createOneBotDriver(connection, { socketFactory: () => socket, actionTimeoutMs: 15 })
let connected
const ready = new Promise(resolve => { connected = resolve })
await driver.start({ onMessage: async () => {}, onStatus: value => { if (value === 'connected') connected() } })
socket.dispatchEvent(new Event('open'))
await ready
const result = await driver.sendText({ conversation: target, text: '<@mapped-self> hi', replyToMessageId: 'original' })
assert.equal(result.status, 'accepted')
assert.equal(socket.sent.at(-1).action, 'send_message')
assert.deepEqual(socket.sent.at(-1).params, { detail_type: 'private', message: [{ type: 'reply', data: { message_id: 'original' } }, { type: 'text', data: { text: '<@mapped-self> hi' } }], user_id: '20002' })
assert.deepEqual(socket.sent.at(-1).self, { platform: 'discord', user_id: 'mapped-self' })
socket.mode = 'timeout'
assert.equal((await driver.sendText({ conversation: target, text: 'maybe' })).status, 'unknown')
assert.equal(socket.sent.filter(value => value.action === 'send_message').length, 2)
await driver.stop()
assert.equal((await driver.sendText({ conversation: target, text: 'no' })).status, 'failed')
console.log('social-core: PASS (strict config, identities, scopes, Discord v12 normalization/actions, socket unknown/no retry)')

const brokenConfig = join(root, 'broken-config.json')
await writeFile(brokenConfig, '{broken')
await assert.rejects(createConfigStore(brokenConfig).write(config), { code: 'SOCIAL_CONFIG_RECOVERY_REQUIRED' })
assert.equal(await readFile(brokenConfig, 'utf8'), '{broken')
