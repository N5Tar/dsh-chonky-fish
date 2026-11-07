import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

import { installAbs } from '../index.js'

const source = await readFile(new URL('../lab.js', import.meta.url), 'utf8')
async function request(response, bootstrap = { routes: {} }, body) {
  let called
  const context = vm.createContext({
    window: { __CHONKYFISH_STATE__: bootstrap },
    RESOURCES: { routes: { abs: '/chonkyfish/abs' } },
    fetch: async (url, options) => { called = { url, options }; return response },
  })
  vm.runInContext(source, context)
  const value = await context.requestAbsLab(body)
  return { value, called }
}
await assert.rejects(request(new Response('', { status: 404 })), /后端接口未注册（HTTP 404）/)
await assert.rejects(request(new Response('', { status: 200 })), /空响应（HTTP 200）/)
for (const status of [401, 403]) {
  await assert.rejects(request(new Response('', { status })), new RegExp(`空响应（HTTP ${status}）`))
  await assert.rejects(request(new Response('{"ok":false}', { status })), new RegExp(`HTTP ${status}`))
}
await assert.rejects(request(new Response('<html>error</html>', { status: 502 })), /非 JSON.*HTTP 502/)
await assert.rejects(request(new Response('null', { status: 200 })), /响应格式无效/)
await assert.rejects(request(new Response(JSON.stringify({ ok: false, error: 'ABS_STARTUP_FAILED', reason: 'store unavailable' }), { status: 503 })), /store unavailable/)
const successful = await request(new Response(JSON.stringify({ ok: true, state: {} })), { routes: { social: '/chonkyfish/social' }, token: 'test' })
assert.equal(successful.called.url, '/chonkyfish/abs', 'old bootstrap routes must fall back per field')
assert.equal(successful.called.options.headers?.['x-chonkyfish-token'], undefined)
const tokenless = await request(new Response('{"ok":true}'))
assert.equal(tokenless.value.ok, true)
assert.equal(tokenless.called.options.headers?.['x-chonkyfish-token'], undefined)
const configured = await request(new Response('{"ok":true}'), { routes: { abs: '/custom/abs' }, token: 'new' }, { action: 'wake' })
assert.equal(configured.called.url, '/custom/abs')
assert.equal(configured.called.options.method, 'POST')
assert.equal(configured.called.options.headers?.['x-chonkyfish-token'], undefined)
assert.equal(configured.called.options.headers['content-type'], 'application/json')

let route, removed = false, release
const ready = new Promise((resolve) => { release = resolve })
const module = installAbs({ webServer: { register(value) { route = value; return () => { removed = true } } } }, {
  resources: { routes: { abs: '/chonkyfish/abs' } }, ready: ready.then(() => null), warn() {},
})
function diagnostic(token, method = 'GET') {
  let status, value
  route.handler({ method, headers: token === undefined ? {} : { 'x-chonkyfish-token': token } }, { writeHead(code) { status = code }, end(raw) { value = raw === undefined ? undefined : JSON.parse(raw) } })
  return { status, value }
}
for (const token of [undefined, 'bad']) {
  assert.equal(diagnostic(token).status, 503)
  assert.equal(diagnostic(token).value.error, 'ABS_INITIALIZING')
}
release()
await module.initialized
for (const token of [undefined, 'bad']) {
  assert.equal(diagnostic(token).status, 503)
  assert.equal(diagnostic(token).value.error, 'ABS_STARTUP_FAILED')
  assert.equal(diagnostic(token).value.reason, 'ABS_LAYOUT_UNAVAILABLE')
  assert.equal(diagnostic(token, 'HEAD').value, undefined)
}
await module.close()
assert.equal(removed, true)

const display = vm.createContext({})
vm.runInContext(source, display)
assert.equal(display.formatAbsTime('2026-11-07T03:34:11.000Z'), '2026-11-07 11:34:11 UTC+8')
assert.equal(display.formatAbsTime('2026-11-07T16:00:00Z'), '2026-11-08 00:00:00 UTC+8')
assert.equal(display.formatAbsTime(null), '—')
assert.equal(display.formatAbsTime('invalid'), 'invalid')
const audit = { at: '2026-11-07T03:34:11.000Z', nested: { nextReviewAt: '2026-11-07T16:00:00Z' }, description: '2026-11-07T03:34:11.000Z' }
const untouched = JSON.stringify(audit)
const presented = JSON.parse(display.stringifyAbsDisplay(audit))
assert.equal(presented.at, '2026-11-07 11:34:11 UTC+8')
assert.equal(presented.nested.nextReviewAt, '2026-11-08 00:00:00 UTC+8')
assert.equal(presented.description, audit.description, 'do not rewrite arbitrary content')
assert.equal(JSON.stringify(audit), untouched)
assert.match(display.ABS_LAB_SURFACE, /backdrop-filter:blur\(24px\)/)
assert.match(display.ABS_LAB_SURFACE, /-webkit-backdrop-filter/)
assert.match(display.ABS_LAB_SURFACE, /prefers-reduced-transparency/)

const wake = display.describeAbsAudit({ type: 'WakeRecord', at: '2026-11-07T03:34:11Z', cause: 'timer', mode: 'shadow', gate: 'SHADOW_PREVIEW_ONLY', nextWakeRealAt: '2026-11-07T05:34:11Z', realAt: '2026-11-07T03:34:11Z' })
assert.equal(wake.title, '开始一次状态审查')
assert.match(wake.summary, /观察模式只预览，不投递/)
assert.match(JSON.stringify(wake.facts), /下次审查/)
const delivered = display.describeAbsAudit({ type: 'ReviewDelivered', at: '2026-11-07T03:34:11Z', reviewId: 'r1', acceptance: {} })
assert.equal(delivered.title, '状态审查已提交给大肥鱼')
assert.match(delivered.summary, /由大肥鱼自己决定/)
assert.match(delivered.summary, /不等于主人已经看到/)
assert.equal(display.describeAbsAudit({ type: 'ReviewFailed', acceptance: { reason: 'agent-busy' } }).summary, '大肥鱼正在处理其他输入')
assert.equal(display.describeAbsAudit({ type: 'ReviewSkipped', reason: 'TIME_PAUSED' }).title, '本次状态审查没有投递')
assert.match(display.describeAbsAudit({ type: 'Observation', observation: { kind: 'owner_message', sessionId: 'fish', seq: 3 } }).summary, /真实发言/)
assert.match(display.describeAbsAudit({ type: 'Observation', observation: { kind: 'exploration', result: 'explore_content_found', sessionId: 'fish', seq: 4 } }).summary, /取得可用资料/)
assert.match(JSON.stringify(display.describeAbsAudit({ type: 'FeedbackApplied', driveId: 'curiosity', delta: .15, source: 'exploration' })), /\+0\.150/)
assert.equal(display.describeAbsAudit({ type: 'ModeChanged', previous: 'shadow', mode: 'active' }).summary, '观察模式 → 投递模式')
assert.match(display.describeAbsAudit({ type: 'StateMigrated', archived: { motivations: 2, executions: 1 } }).summary, /不再参与运行/)
assert.match(display.describeAbsAudit({ type: 'ClockScaleChanged', previous: 1, timeScale: 60, at: '2026-11-07T03:00:00Z', realAt: '2026-11-07T03:00:00Z' }).summary, /不重置已累计的变化/)
assert.equal(display.describeAbsAudit({ type: 'FutureEvent' }).title, '系统记录')
assert.equal(display.absAuditWord('__proto__'), '__proto__')

const needs = display.describeAbsNeeds({ drives: {
  social: { satisfaction: .55, setpoint: .75, decayPerHour: .008, updatedAt: '2026-11-07T03:00:00Z' },
  curiosity: { satisfaction: .35, setpoint: .7, decayPerHour: .004, updatedAt: '2026-11-07T03:00:00Z' },
} })
assert.ok(Math.abs(needs[0].demand - .2666666666666666) < 1e-12)
assert.equal(needs[1].demand, .5)
assert.match(needs[1].level, /缺口/)
assert.equal(display.describeAbsNeeds({})[0].demand, null)
assert.equal(display.describeAbsNeeds({ drives: { social: { satisfaction: .8, setpoint: .75 } } })[0].demand, 0)

display.h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })
const reviewState = {
  mode: 'shadow',
  reviewPreview: { text: '【内部状态记录 · 非主人发言】\n\n### 自身精神状态审查\n\n社交方面：满足程度低于平常的满足水平。' },
  lastReview: { status: 'delivered', at: '2026-11-07T03:00:00Z', reason: null },
  clockView: { timeScale: 1, paused: false },
  drives: { social: { satisfaction: .55, setpoint: .75 }, curiosity: { satisfaction: .35, setpoint: .7 } },
  config: { timeScale: 1 },
  observations: [{ kind: 'owner_message', realAt: '2026-11-07T03:00:00Z', at: '2026-11-07T03:00:00Z' }, { kind: 'exploration', resultKind: 'explore_content_found', realAt: '2026-11-07T02:00:00Z' }],
}
const reviewTree = JSON.stringify(display.AbsReviewPanel({ state: reviewState, busy: false, onAction() {} }))
assert.match(reviewTree, /自身精神状态审查/)
assert.match(reviewTree, /接纳不等于已经行动/)
assert.match(reviewTree, /手动运行一次审查/)
const observationsTree = JSON.stringify(display.AbsObservationsPanel({ state: reviewState }))
assert.match(observationsTree, /主人真实发言/)
assert.match(observationsTree, /搜索工具结果/)
const needsTree = JSON.stringify(display.AbsNeedsPanel({ state: reviewState }))
assert.match(needsTree, /不代表真实情绪/)
assert.match(needsTree, /不构成行动命令/)
assert.ok(!needsTree.includes('动机'))

const rows = [{ type: 'WakeRecord', at: '2026-11-07T03:00:00Z', cause: 'timer', mode: 'shadow', gate: 'SHADOW_PREVIEW_ONLY' }, { type: 'ReviewDelivered', at: '2026-11-07T04:00:00Z', reviewId: 'r1', acceptance: {} }]
const beforeTimeline = JSON.stringify(rows)
const tree = display.AbsAuditTimeline({ records: rows })
assert.equal(tree.type, 'ol')
assert.match(JSON.stringify(tree.children[0]), /状态审查已提交给大肥鱼/)
assert.equal(JSON.stringify(rows), beforeTimeline)
function findDetails(node) { return node && typeof node === 'object' ? [...(node.type === 'details' ? [node] : []), ...(node.children || []).flatMap(findDetails)] : [] }
assert.equal(findDetails(tree).length, 2)
assert.ok(findDetails(tree).every((node) => !node.props.open), 'raw JSON must be collapsed by default')
assert.match(JSON.stringify(display.AbsAuditTimeline({ records: [] })), /还没有审计记录/)
display.React = { useState: (value) => [value, () => {}] }
const clockTree = JSON.stringify(display.AbsClockPanel({ state: { ...reviewState, nextWakeAt: '2030-01-01T00:00:00Z', clockView: { timeScale: 60, realNow: '2026-11-07T03:00:00Z', virtualNow: '2030-01-01T00:00:00Z', nextWakeRealAt: '2026-11-07T03:02:00Z', realWaitMs: 120000 } } }))
assert.match(clockTree, /2026-11-07 11:02:00 UTC\+8/)
assert.doesNotMatch(clockTree, /2030|ABS 时间|下次审查（ABS）/)
assert.equal(display.describeAbsAudit({ type: 'Recovery', at: '2030-01-01T00:00:00Z', realAt: '2026-11-07T03:00:00Z' }).time, '2026-11-07 11:00:00 UTC+8')
assert.equal(display.describeAbsAudit({ type: 'Recovery', at: '2030-01-01T00:00:00Z' }).time, '—')
assert.match(JSON.stringify(display.AbsReviewPanel({ state: { reviewPreview: '单一现实时间审查文本' } })), /单一现实时间审查文本/)
const ledgerTree = JSON.stringify(display.AbsChangeLedger({ state: { changeLedger: [
  { realAt: '2026-11-07T03:00:00Z', driveId: 'curiosity', before: 0, after: .15, delta: .15, reason: 'local_content_found', activity: 'read' },
  { realAt: '2026-11-07T03:10:00Z', driveId: 'curiosity', before: .15, after: .07, delta: -.08, reason: 'natural_decay', timeScale: 120 },
  { realAt: '2026-11-07T03:11:00Z', driveId: 'curiosity', before: .07, after: .07, delta: 0, reason: 'duplicate_evidence' },
] } }))
assert.match(ledgerTree, /\+15\.00 个百分点/)
assert.match(ledgerTree, /-8\.00 个百分点/)
assert.match(ledgerTree, /不重复加分/)
assert.match(ledgerTree, /2026-11-07 11:10:00 UTC\+8/)
assert.match(JSON.stringify(display.AbsChangeLedger({ state: {} })), /暂无变化记录/)
const restingState = { ...reviewState, mode: 'active', clockView: { rest: { enabled: true, start: '23:00', end: '08:00', resting: true, resumeAt: '2026-11-08T00:00:00Z' } } }
const restTree = JSON.stringify(display.AbsRestPanel({ state: restingState }))
assert.match(restTree, /23:00–08:00/)
assert.match(restTree, /正在休息/)
assert.match(restTree, /2026-11-08 08:00:00 UTC\+8/)
assert.match(restTree, /不控制其他定时任务/)
const restingReview = display.AbsReviewPanel({ state: restingState })
function buttons(node) { return node && typeof node === 'object' ? [...(node.type === 'button' ? [node] : []), ...(node.children || []).flatMap(buttons)] : [] }
assert.equal(buttons(restingReview).find((button) => button.children.includes('手动投递审查')).props.disabled, true)
assert.equal(buttons(restingReview).find((button) => button.children.includes('刷新预览')).props.disabled, undefined)
assert.match(display.absAuditWord('REST_HOURS'), /不唤醒/)
console.log('ABS client/startup: PASS (responses, startup, review UI, needs, observations, audit timeline, real-time-only display, change ledger, rest hours)')
