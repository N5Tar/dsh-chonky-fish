import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createResources } from '../../resources/index.js'
import { createConfigStore } from '../config.js'
import { createSocialService } from '../service.js'
import { createFakeDriver } from '../drivers/fake.js'
import { DEFAULT_INBOX_LIMITS } from '../inbox-store.js'

const target = { type: 'direct', id: '20002' }
const qqConfig = { version: 1, connections: [{ id: 'main', platform: 'qq', provider: 'snowluma', endpoint: 'ws://127.0.0.1:3001/', token: 'test-token' }] }
const directory = await mkdtemp(join(tmpdir(), 'social-account-'))
const resources = createResources({ homeRoot: directory })
const limits = { ...resources.spec.SOCIAL.limits, accountWriteIntervalMs: 1, inbox: DEFAULT_INBOX_LIMITS, sendIntervalMs: 1 }
await createConfigStore(resources.paths.socialConfig).write(qqConfig)
const friends = Array.from({ length: 100 }, (_, i) => ({ user_id: 10000 + i, nickname: 'friend-' + i, remark: '' }))
let driver
const service = await createSocialService({
  paths: resources.paths,
  limits,
  driverFactory: value => (driver = createFakeDriver(value, {
    actionResults: {
      get_stranger_info: params => ({ user_id: params.user_id, nickname: 'fish', sex: 'unknown', age: 1, long_nick: 'hi', qq_level: 9, reg_time: 1, is_vip: false, extra: 'drop-me' }),
      get_friend_list: friends,
      set_qq_profile: {},
      send_qzone_msg: { tid: 'tid-1', time: 1700000000 },
    },
  })),
})
const scope = service.issueScope({ sessionId: 'social-session', connectionId: 'main', conversation: target, canSend: true })

const self = await service.account(scope, 'get_self_profile', {})
assert.equal(self.readOnly, true)
assert.equal(self.data.user_id, 10001)
assert.equal(self.data.nickname, 'fish')
assert.equal('extra' in self.data, false)
assert.deepEqual(driver.actions[0], { name: 'get_stranger_info', params: { user_id: 10001 } })

const list = await service.account(scope, 'get_friend_list', { offset: 10, limit: 2 })
assert.equal(list.data.total, 100)
assert.equal(list.data.offset, 10)
assert.equal(list.data.returned, 2)
assert.deepEqual(list.data.items.map(row => row.user_id), [10010, 10011])
assert.equal(list.data.truncated, true)

await assert.rejects(service.account(scope, 'get_friend_list', { nope: 1 }), { code: 'SOCIAL_INVALID_INPUT' })
await assert.rejects(service.account(scope, 'get_qzone_msg_list', { num: 100 }), { code: 'SOCIAL_INVALID_INPUT' })
await assert.rejects(service.account(scope, 'set_qq_profile', {}), { code: 'SOCIAL_INVALID_INPUT' })
await assert.rejects(service.account(scope, 'set_qq_profile', { sex: 9 }), { code: 'SOCIAL_INVALID_INPUT' })
await assert.rejects(service.account(scope, 'not_an_action', {}), { code: 'SOCIAL_UNKNOWN_ACTION' })

const write = await service.account(scope, 'set_qq_profile', { nickname: '新名字' })
assert.equal(write.readOnly, false)
assert.deepEqual(driver.actions.at(-1), { name: 'set_qq_profile', params: { nickname: '新名字' } })
await assert.rejects(service.account(scope, 'set_qq_profile', { nickname: '再改' }), { code: 'SOCIAL_RATE_LIMITED' })
await new Promise(resolve => setTimeout(resolve, 3))
await service.account(scope, 'set_self_longnick', { long_nick: '学习中' })
assert.deepEqual(driver.actions.at(-1), { name: 'set_self_longnick', params: { long_nick: '学习中' } })

const owner = { session: { id: 'owner', header: { agentPreset: 'chonkyfish' } } }
const ownerSelf = await service.accountForOwner(owner, 'get_self_profile', {})
assert.equal(ownerSelf.data.user_id, 10001)
await assert.rejects(service.accountForOwner({ session: { id: 'x', header: { agentPreset: 'chonkyfish-social' } } }, 'get_self_profile', {}), { code: 'SOCIAL_UNAUTHORIZED' })

// 主会话 owner 路径不建 binding：直接读唯一在线 QQ 的收件箱并在当前会话上下文里回复。
await driver.emit({ messageId: 'owner-msg', conversation: target, sender: { id: '20002' }, text: 'owner hello', sentAt: Date.now() })
const ownerInbox = await service.ownerBatches(owner)
assert.equal(ownerInbox.batches.length, 1)
assert.equal(ownerInbox.batches[0].messages[0].text, 'owner hello')
service.ownerContext(owner, { conversation: target })
const ownerSent = await service.ownerSend(owner, { operationId: 'owner-send', text: 'owner reply' })
assert.equal(ownerSent.status, 'accepted')
assert.equal(driver.sent.length, 1)
await service.ownerAck(owner, ownerInbox.batches[0])
assert.ok((await service.ownerNotices(owner)).every(notice => notice.unreadCount === 0))

// 写超时不能被当成“没发生”而重试。
await new Promise(resolve => setTimeout(resolve, 3))
driver.callAction = async () => { throw Object.assign(new Error('timeout'), { code: 'SOCIAL_ACTION_TIMEOUT' }) }
await assert.rejects(service.account(scope, 'send_qzone_msg', { content: 'hi' }), { code: 'SOCIAL_ACCOUNT_WRITE_UNKNOWN' })
await service.close()

const discordRoot = await mkdtemp(join(tmpdir(), 'social-account-discord-'))
const discordResources = createResources({ homeRoot: discordRoot })
await createConfigStore(discordResources.paths.socialConfig).write({
  version: 1,
  connections: [{ id: 'dc', platform: 'discord', provider: 'onebots-discord', endpoint: 'wss://example.com/', token: 'dc-token' }],
})
const discordService = await createSocialService({
  paths: discordResources.paths,
  limits,
  driverFactory: value => createFakeDriver(value, { protocolUserId: 'dc-self' }),
})
const discordScope = discordService.issueScope({ sessionId: 'social-session', connectionId: 'dc', conversation: { type: 'direct', id: 'u1' }, canSend: true })
await assert.rejects(discordService.account(discordScope, 'get_self_profile', {}), { code: 'SOCIAL_UNSUPPORTED_ACTION' })
await discordService.close()
console.log('social-account: PASS (whitelist, parameter validation, read summaries, write rate limit, unknown write, provider gate)')
