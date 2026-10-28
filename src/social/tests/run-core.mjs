import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateConfig } from '../config.js'
import { createIdentityStore } from '../identity-store.js'
import { createScopeAuthority, acceptMessage } from '../policy.js'
import { normalizeEvent, createOneBotDriver } from '../drivers/onebot.js'

const target = { type: 'direct', id: '20002' }
const connection = { id: 'qq-main', platform: 'qq', provider: 'napcat', endpoint: 'ws://127.0.0.1:3001/' }
const config = { version: 1, connections: [connection] }
assert.deepEqual(validateConfig(config), config)
// 只保留连接本身；旧的开关 / 接收范围 / 允许名单字段一律被拒绝。
for (const patch of [{ protocol: 'onebot-v11' }, { provider: '__proto__' }, { provider: 'onebots-discord' }, { endpoint: 'ws://example.com/' }, { endpoint: 'ws://a:secret@localhost/' }, { endpoint: 'ws://localhost/?access_token=secret' }, { enabled: true }, { inbound: {} }, { allowedConversations: [] }]) {
  assert.throws(() => validateConfig({ version: 1, connections: [{ ...connection, ...patch }] }))
}
assert.throws(() => validateConfig({ version: 1, enabled: true, connections: [connection] }))
assert.throws(() => validateConfig({ version: 1, connections: [connection, connection] }))
const root = await mkdtemp(join(tmpdir(), 'social-core-'))
const store = createIdentityStore(join(root, 'identities.json'))
const self = { connectionId: connection.id, platform: 'qq', provider: 'napcat', protocolUserId: '10001', platformUserId: '10001' }
const first = await store.verify(self)
assert.equal(first.status, 'connected')
assert.equal((await store.verify(self)).identityRevision, first.identityRevision)
assert.equal((await store.verify({ ...self, provider: 'snowluma' })).identityRevision, first.identityRevision)
assert.equal((await store.verify({ ...self, protocolUserId: '10002', platformUserId: '10002' })).status, 'identity_changed')
await assert.rejects(store.confirm({ connectionId: 'qq-main', expectedProtocolUserId: 'wrong' }))
const changed = await store.confirm({ connectionId: 'qq-main', expectedProtocolUserId: '10002' })
assert.notEqual(changed.identityRevision, first.identityRevision)
assert.equal((await store.verify({ ...changed.identity, platformUserId: 'different-native-account' })).status, 'identity_changed')
await writeFile(join(root, 'broken.json'), 'broken')
await assert.rejects(createIdentityStore(join(root, 'broken.json')).verify(self))
const authority = createScopeAuthority()
assert.throws(() => authority.check({ sessionId: 'a', canSend: true }))
const scope = authority.issue({ sessionId: 'a', platform: 'qq', connectionId: 'qq-main', conversation: target, identityRevision: first.identityRevision })
assert.equal(authority.check(scope), scope)
authority.revoke(scope)
assert.throws(() => authority.check(scope))
const event = { post_type: 'message', self_id: 10001, message_type: 'private', user_id: 20002, message_id: 1, time: 1000, message: [{ type: 'text', data: { text: 'hi' } }] }
const message = normalizeEvent(event, connection, self, 11)
assert.equal(message.text, 'hi')
// 配置了连接就接收：私聊/群/频道不再有额外筛选，只过滤自身回声和机器人。
assert.equal(acceptMessage(connection, self, message), true)
assert.equal(acceptMessage(connection, self, { ...message, conversation: { type: 'group', id: '30003' } }), true)
assert.equal(acceptMessage(connection, self, { ...message, sender: { id: '10001' } }), false)
assert.equal(acceptMessage(connection, self, { ...message, sender: { id: '30004', isBot: true } }), false)
assert.equal(acceptMessage(connection, self, { ...message, text: 'x'.repeat(32001) }), false)
assert.equal(normalizeEvent({ ...event, message: '[CQ:at,qq=10001]hi' }, connection, self, 11), null)
assert.throws(() => normalizeEvent({ ...event, self_id: 10002 }, connection, self, 11))
assert.throws(() => normalizeEvent({ ...event, user_id: Number.MAX_SAFE_INTEGER + 1 }, connection, self, 11))
const discord = { ...connection, platform: 'discord', provider: 'onebots-discord' }
const discordSelf = { ...self, platform: 'discord', provider: 'onebots-discord', protocolUserId: 'mapped-self' }
const discordMessage = normalizeEvent({ type: 'message', detail_type: 'channel', self: { platform: 'discord', user_id: 'mapped-self' }, user_id: 'long-string-user', guild_id: 'guild', channel_id: 'channel', message_id: 'msg', message: [{ type: 'mention', data: { user_id: 'mapped-self' } }, { type: 'text', data: { text: 'hey' } }] }, discord, discordSelf, 12)
assert.deepEqual(discordMessage.conversation, { type: 'channel', id: 'channel', guildId: 'guild' })
assert.equal(discordMessage.mentionsSelf, true)

class Socket extends EventTarget {
  readyState = 1
  sent = []
  mode = 'success'
  send(raw) {
    const request = JSON.parse(raw); this.sent.push(request)
    if (this.mode === 'timeout' && request.action.startsWith('send_')) return
    const data = request.action === 'get_login_info' ? { user_id: 10001, nickname: 'fish' } : { message_id: 99 }
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
const result = await driver.sendText({ conversation: target, text: '[CQ:at,qq=all]' })
assert.equal(result.status, 'accepted')
assert.deepEqual(socket.sent.at(-1).params.message, [{ type: 'text', data: { text: '[CQ:at,qq=all]' } }])
socket.mode = 'timeout'
assert.equal((await driver.sendText({ conversation: target, text: 'maybe' })).status, 'unknown')
assert.equal(socket.sent.filter(value => value.action === 'send_private_msg').length, 2)
await driver.stop()
assert.equal((await driver.sendText({ conversation: target, text: 'no' })).status, 'failed')
class Socket12 extends Socket {
  send(raw) {
    const request = JSON.parse(raw); this.sent.push(request)
    const data = request.action === 'get_self_info' ? { user_id: 'mapped-self', user_name: 'fish' }
      : request.action === 'get_status' ? { bots: [{ self: { platform: 'discord', user_id: 'mapped-self' }, online: true }] }
      : { message_id: 'long-message-id' }
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data }) })))
  }
}
const socket12 = new Socket12()
const driver12 = createOneBotDriver(discord, { version: 12, socketFactory: () => socket12, actionTimeoutMs: 50 })
let ready12Resolve
const ready12 = new Promise(resolve => { ready12Resolve = resolve })
await driver12.start({ onMessage: async () => {}, onStatus: value => { if (value === 'connected') ready12Resolve() } })
socket12.dispatchEvent(new Event('open'))
await ready12
assert.equal((await driver12.sendText({ conversation: { type: 'channel', guildId: 'guild', id: 'channel' }, text: 'hi', replyToMessageId: 'original' })).status, 'accepted')
assert.equal(socket12.sent.at(-1).action, 'send_message')
assert.deepEqual(socket12.sent.at(-1).params, { detail_type: 'channel', message: [{ type: 'reply', data: { message_id: 'original' } }, { type: 'text', data: { text: 'hi' } }], guild_id: 'guild', channel_id: 'channel' })
assert.deepEqual(socket12.sent.at(-1).self, { platform: 'discord', user_id: 'mapped-self' })
await driver12.stop()
console.log('social-core: PASS (strict config, identities, scopes, filters, v11/v12 normalization, socket actions/unknown/no retry)')
