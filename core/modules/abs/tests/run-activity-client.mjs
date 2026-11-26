import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../../../../app/dsh/ui/abs/activity-panel.js', import.meta.url), 'utf8')
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const snapshotAt = new Date().toISOString()
const row = (id, result, extra = {}) => ({ id, wakeAt: snapshotAt, cause: 'timer', mode: 'active', reviewStatus: 'accepted', turnStatus: 'completed', attribution: 'self_review', outcome: result, result, outcomeSummary: '结果摘要 ' + id, evidence: [], annotations: [], ...extra })
const episodes = [row('verified', 'verified'), row('no-action', 'no_action'), row('failed-transport', 'failed', { turnStatus: 'failed', turnDiagnostic: { phase: 'before_tools', code: 'TRANSPORT' }, evidence: [] }), row('failed-legacy', 'failed', { turnStatus: 'failed', turnDiagnostic: null, evidence: [] }), row('unknown', 'unknown'), row('not-started', 'not_started', { reviewStatus: 'not_due', turnStatus: 'unknown', attribution: 'unlinked', turnDiagnostic: { phase: 'not_executed', code: 'NOT_EXECUTED' } }), row('not-started-2', 'not_started', { reviewStatus: 'skipped', turnStatus: 'unknown', attribution: 'unlinked' })]
function harness() {
  const state = [], timers = new Map(), listeners = new Map(), requests = []
  let cursor = 0, deps, effect, cleanup, nextTimer = 0, nowMs = Date.now()
  class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [nowMs])) } static now() { return nowMs } }
  const document = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => listeners.delete(name) }
  const context = vm.createContext({
    URL, Date: TestDate, Intl, Number, Object, Array, JSON, Math, String, Boolean,
    window: { location: { href: 'http://localhost/lab' }, __CHONKYFISH_STATE__: { routes: { absActivities: '/custom/abs/activities' } } },
    RESOURCES: { routes: { absActivities: '/chonkyfish/abs/activities' } }, document,
    setInterval: (fn, ms) => { assert.equal(ms, 15000); timers.set(++nextTimer, fn); return nextTimer }, clearInterval: id => timers.delete(id),
    AbortController,
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options })
      if (options.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: JSON.parse(options.body) && { activityId: JSON.parse(options.body).activityId, label: JSON.parse(options.body).label, active: JSON.parse(options.body).active, at: snapshotAt } }) }
      const parsed = new URL(url), beforeWakeAt = parsed.searchParams.get('beforeWakeAt'), beforeEpisodeId = parsed.searchParams.get('beforeEpisodeId'), outcome = parsed.searchParams.get('outcome')
      const filtered = outcome ? episodes.filter(episode => episode.result === outcome) : episodes
      const cursorIndex = beforeEpisodeId ? filtered.findIndex(episode => episode.id === beforeEpisodeId) + 1 : 0
      const rows = filtered.slice(cursorIndex, cursorIndex + 5)
      const hasMore = cursorIndex + rows.length < filtered.length
      const nextCursor = hasMore && rows.length ? { wakeAt: rows.at(-1).wakeAt, episodeId: rows.at(-1).id } : null
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true,
        window: { from: parsed.searchParams.get('from'), to: parsed.searchParams.get('to'), timeZone: 'Asia/Shanghai', coverageStart: snapshotAt, coverageEnd: snapshotAt, coveredMs: 3600000, complete: false, gaps: [{ from: parsed.searchParams.get('from'), to: snapshotAt }] },
        summary: { episodes: 4, opportunities: 4, totalWakes: 6, notStarted: 2, verified: 1, noAction: 1, failed: 1, unknown: 1 },
        episodes: rows, page: { limit: 5, total: filtered.length, hasMore, snapshotAt, snapshotSeq: 50, outcome, nextCursor } }) }
    },
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null) }),
    React: {
      useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }] },
      useEffect(fn, nextDeps) { if (!deps || nextDeps.some((value, index) => value !== deps[index])) { deps = nextDeps; effect = fn } },
    },
  })
  vm.runInContext(source, context)
  return {
    context, requests, timers, listeners,
    render(props = { view: 'detail' }) { cursor = 0; const tree = context.AbsActivityPanel(props); if (effect) { cleanup?.(); cleanup = effect(); effect = null } return tree },
    tick() { for (const fn of timers.values()) fn() },
    advance(ms) { nowMs += ms },
    visibility(value) { document.hidden = value; listeners.get('visibilitychange')?.() },
    unmount() { cleanup?.() },
  }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const nodes = (tree, type) => tree && typeof tree === 'object' ? [...(tree.type === type ? [tree] : []), ...(tree.children || []).flatMap(child => nodes(child, type))] : []
const text = tree => tree && typeof tree === 'object' ? (tree.children || []).map(text).join(' ') : String(tree)

const app = harness()
assert.match(text(app.render()), /正在读取活动记录/)
await flush()
let tree = app.render()
const firstUrl = new URL(app.requests[0].url)
assert.equal(firstUrl.pathname, '/custom/abs/activities')
assert.equal(firstUrl.searchParams.get('from'), new Date(day + 'T00:00:00+08:00').toISOString())
assert.equal(firstUrl.searchParams.get('to'), new Date(new Date(day + 'T00:00:00+08:00').getTime() + 86400000).toISOString())
assert.equal(firstUrl.searchParams.has('offset'), false)
assert.equal(firstUrl.searchParams.has('beforeWakeAt'), false)
assert.equal(firstUrl.searchParams.has('beforeEpisodeId'), false)
assert.match(text(tree), /结果已验证/)
assert.match(text(tree), /未观察到行动/)
assert.match(text(tree), /执行失败/)
assert.doesNotMatch(text(tree), /明确暂缓|兴趣线索|模型自报/, 'retired deferred / interest / model-reported parts are gone')
assert.match(text(tree), /失败阶段：工具请求前 · 原因：模型连接失败/)
assert.match(text(tree), /本轮在工具请求前失败；没有关联的工具请求或工具回执。/)
assert.match(text(tree), /这条较早记录没有保存失败诊断，失败阶段和原因未记录。/)
assert.doesNotMatch(text(tree), /DSH 标准上下文|DSH context/)
assert.match(text(tree), /结果未知/)
assert.match(text(tree), /存在 1 个观察缺口/)
assert.match(text(tree), /失败 1 · 未知 1/)
assert.equal(nodes(tree, 'article').length, 5)
const badges = nodes(tree, 'span').map(node => text(node))
for (const label of ['已验证', '未观察到行动', '失败', '未知']) assert.ok(badges.includes(label), 'renders result status: ' + label)

const select = nodes(tree, 'select')[0]
nodes(tree, 'button').find(button => button.children.includes('加载更多')).props.onClick()
tree = app.render()
await flush()
tree = app.render()
assert.equal(nodes(tree, 'article').length, 7, 'activity pagination retains the first page and loads older rows')
assert.ok(nodes(tree, 'span').map(node => text(node)).includes('未启动'))
assert.match(text(tree), /失败阶段：本轮未执行 · 原因：没有实际执行本轮模型步骤/)
assert.equal(new URL(app.requests.at(-1).url).searchParams.has('offset'), false)
assert.equal(new URL(app.requests.at(-1).url).searchParams.get('beforeWakeAt'), snapshotAt)
assert.equal(new URL(app.requests.at(-1).url).searchParams.get('beforeEpisodeId'), 'unknown')
assert.equal(new URL(app.requests.at(-1).url).searchParams.get('snapshotAt'), snapshotAt)
assert.equal(new URL(app.requests.at(-1).url).searchParams.get('snapshotSeq'), '50')
assert.equal(nodes(tree, 'button').some(button => button.children.includes('加载更多')), false)
const loadedPages = app.requests.filter(request => request.method !== 'POST').length
app.tick(); await flush()
assert.equal(app.requests.filter(request => request.method !== 'POST').length, loadedPages, 'later pages stay frozen while the user reviews them')
const outcomeSelect = nodes(tree, 'select')[0]
assert.equal(nodes(outcomeSelect, 'option').some(option => option.props.value === 'deferred'), false, 'the retired deferred filter is not offered')
outcomeSelect.props.onChange({ target: { value: 'no_action' } })
tree = app.render()
await flush()
tree = app.render()
assert.equal(new URL(app.requests.at(-1).url).searchParams.get('outcome'), 'no_action', 'outcome filter is applied by the server across the full day')
assert.equal(new URL(app.requests.at(-1).url).searchParams.has('offset'), false, 'outcome filter resets keyset pagination')
assert.equal(new URL(app.requests.at(-1).url).searchParams.has('beforeEpisodeId'), false, 'filtered first page omits stale cursor')
assert.equal(nodes(tree, 'article').length, 1, 'no_action filter uses exclusive canonical result')
assert.match(text(tree), /未观察到行动/)
assert.equal(nodes(tree, 'button').find(button => button.children.includes('有意思')).props.disabled, false)
const interesting = nodes(tree, 'button').find(button => button.children.includes('有意思'))
interesting.props.onClick()
await flush()
tree = app.render()
assert.equal(app.requests.at(-1).method, 'POST')
assert.deepEqual(JSON.parse(app.requests.at(-1).body), { action: 'annotate', activityId: 'no-action', label: 'interesting', active: true })
assert.equal(nodes(tree, 'button').find(button => button.children.includes('有意思')).props['aria-pressed'], true)

const previousFrom = new URL(app.requests.filter(request => request.method !== 'POST').at(-1).url).searchParams.get('from')
const beforeReactivate = app.requests.length
app.visibility(true); app.advance(86400000); app.visibility(false)
assert.equal(app.requests.length, beforeReactivate, 'reactivation synchronizes the day before issuing a request')
tree = app.render()
assert.match(text(tree), /正在读取活动记录/)
await flush(); tree = app.render()
const reactivated = new URL(app.requests.filter(request => request.method !== 'POST').at(-1).url)
assert.notEqual(reactivated.searchParams.get('from'), previousFrom)
assert.equal(reactivated.searchParams.has('offset'), false)
assert.equal(reactivated.searchParams.has('beforeEpisodeId'), false)
assert.equal(reactivated.searchParams.has('snapshotSeq'), false)
assert.equal(reactivated.searchParams.get('outcome'), 'no_action', 'day reactivation preserves the selected outcome filter')

app.unmount(); assert.equal(app.timers.size, 0); assert.equal(app.listeners.size, 0)
console.log('ABS activity client: PASS (UTC+8 window, result states, gaps, annotations, refresh cleanup)')
