import assert from 'node:assert/strict'
import { createAutoViewer } from '../auto-view.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const notices = []
let listener = null
const service = {
  subscribe(fn) { listener = fn; return () => { listener = null } },
  async listNotices() { return notices.slice() },
}
let mode = 'viewed'
const views = []
const view = async notice => { views.push({ connectionId: notice.connectionId, conversation: structuredClone(notice.conversation) }); return { status: mode } }
const warnings = []
const viewer = createAutoViewer({ service, view, limits: { autoViewDelayMs: 1, autoViewRetryMs: 2 }, warn: message => warnings.push(message) })

notices.push({ connectionId: 'main', sessionKey: 'k1', conversation: { type: 'direct', id: 'u1' }, unreadCount: 1 })
viewer.start()
await wait(20)
assert.equal(views.length, 1)
assert.deepEqual(views[0], { connectionId: 'main', conversation: { type: 'direct', id: 'u1' } })

const emit = notice => { if (listener) listener([notice]) }
emit({ connectionId: 'main', sessionKey: 'k2', conversation: { type: 'direct', id: 'u2' }, unreadCount: 2 })
await wait(20)
assert.equal(views.length, 2)

// 同一个会话的重复通知只排一次。
emit({ connectionId: 'main', sessionKey: 'k3', conversation: { type: 'direct', id: 'u3' }, unreadCount: 1 })
emit({ connectionId: 'main', sessionKey: 'k3', conversation: { type: 'direct', id: 'u3' }, unreadCount: 1 })
await wait(20)
assert.equal(views.length, 3)

// busy 时自动短暂重试。
mode = 'busy'
emit({ connectionId: 'main', sessionKey: 'k4', conversation: { type: 'direct', id: 'u4' }, unreadCount: 1 })
await wait(30)
assert.ok(views.filter(view => view.conversation.id === 'u4').length >= 2)
mode = 'viewed'
await wait(10)

// 没有未读时不应该触发。
const before = views.length
emit({ connectionId: 'main', sessionKey: 'k5', conversation: { type: 'direct', id: 'u5' }, unreadCount: 0 })
await wait(20)
assert.equal(views.length, before)

viewer.close()
emit({ connectionId: 'main', sessionKey: 'k6', conversation: { type: 'direct', id: 'u6' }, unreadCount: 1 })
await wait(20)
assert.equal(views.length, before)
assert.deepEqual(warnings, [])
console.log('social-auto-view: PASS (initial unread, debounce/dedupe, busy retry, close)')
