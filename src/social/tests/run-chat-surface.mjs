import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const builder = await readFile(join(root, 'build.mjs'), 'utf8')
// Extract the actual generated-chat projection without executing the builder or writing client.js.
const start = builder.indexOf('      function textOfBlocks(blocks) {')
const end = builder.indexOf('      function isRunning() {', start)
assert.ok(start >= 0 && end > start, 'chat projection boundaries remain discoverable')
const template = builder.slice(start, end)
assert.equal(template.includes('${'), false, 'projection extraction must not interpolate unrelated builder state')
assert.equal(template.includes('`'), false, 'projection extraction expects the existing plain template fragment')
const projection = vm.runInNewContext('`' + template + '`')
const stamp = 1794297600000
const user = (id, text, source = { kind: 'user' }) => ({ event: { type: 'user/message', time: stamp, data: { id, role: 'user', source, content: [{ type: 'text', text }] } } })
const reply = (text, turn = 1) => ({ event: { type: 'assistant/message', time: stamp + 1000, surfaceOp: 'append', data: { turn, step: 1, message: { id: 'assistant-' + turn, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] } } } })
let snapshot = {
  revision: 1,
  entries: [
    user('owner-previous', '上一句'),
    // Previously ACKed notices remain filtered; do not replay or rewrite history.
    user('legacy-notice', '旧来源标签与通知', { kind: 'chonkyfish-social', platform: 'dingtalk', senderName: '旧发送者' }),
    user('social-' + 'a'.repeat(64), '喂'),
    reply('我在。'),
    { event: { type: 'tool/result', data: { content: '不是聊天正文' } } },
  ],
}
const context = vm.createContext({
  binding: { eventSource: { getSnapshot: () => snapshot } },
  messageCache: { revision: -1, list: [] },
})
vm.runInContext(projection, context)
const getMessages = () => vm.runInContext('getMessages()', context)
const messages = getMessages()
assert.deepEqual(Array.from(messages, row => ({ role: row.role, text: row.text })), [
  { role: 'user', text: '上一句' },
  { role: 'user', text: '喂' },
  { role: 'fish', text: '我在。' },
])
assert.equal(messages[1].text, '喂', 'ordinary social user/message is naturally visible, with no prompt or prefix')
for (const row of messages) assert.deepEqual(Object.keys(row).sort(), ['role', 'text', 'time'])
for (const hidden of ['dingtalk', '钉钉', 'senderName', '旧发送者', 'notice', 'social-', '平台', '渠道']) assert.equal(JSON.stringify(messages).includes(hidden), false, 'projection must not expose channel/source metadata: ' + hidden)
assert.equal(getMessages(), messages, 'existing revision cache remains in use')

snapshot = { revision: 2, entries: [...snapshot.entries, user('social-' + 'b'.repeat(64), '第二条\n只保留原文')] }
assert.equal(getMessages().at(-1).text, '第二条\n只保留原文')
assert.equal(getMessages().filter(row => row.text === '喂').length, 1, 'refresh does not duplicate ordinary social text')
snapshot = { revision: 3, entries: [user('owner-direct', '普通聊天'), reply('正常回复')] }
assert.deepEqual(Array.from(getMessages(), row => row.text), ['普通聊天', '正常回复'], 'normal owner and assistant flow is unchanged')
// Owner and visitor chat surfaces project separate bound sessions without adding routing labels.
const mainEntries = []
for (let turn = 1; turn <= 3; turn++) {
  mainEntries.push(user('social-' + String(turn).repeat(64), '主人第' + turn + '句'), reply('主人第' + turn + '答', turn))
  snapshot = { revision: 3 + turn, entries: [...mainEntries, user('runtime-' + turn, 'hidden runtime', { kind: 'runtime-context' }), user('time-' + turn, 'hidden clock', { kind: 'time-context' })] }
  assert.equal(getMessages().length, turn * 2)
  assert.equal(getMessages().at(-1).text, '主人第' + turn + '答')
}
const peerSnapshot = { revision: snapshot.revision, entries: [user('social-' + 'd'.repeat(64), '访客自己的正文'), reply('访客自己的答复')] }
const peerContext = vm.createContext({ binding: { eventSource: { getSnapshot: () => peerSnapshot } }, messageCache: { revision: -1, list: [] } })
vm.runInContext(projection, peerContext)
const peerMessages = vm.runInContext('getMessages()', peerContext)
assert.deepEqual(Array.from(peerMessages, row => row.text), ['访客自己的正文', '访客自己的答复'])
assert.equal(JSON.stringify(peerMessages).includes('主人'), false)
assert.equal(JSON.stringify(getMessages()).includes('访客'), false)
for (const row of [...getMessages(), ...peerMessages]) assert.deepEqual(Object.keys(row).sort(), ['role', 'text', 'time'])
context.binding = null
assert.equal(getMessages().length, 0)
console.log('social-chat-surface: PASS (actual getMessages projection; ordinary user 喂, final text, no source/notice/channel labels, legacy filtering, cache)')
