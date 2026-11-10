import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../events-panel.js', import.meta.url), 'utf8')
function harness({ hidden = false, route, fetcher } = {}) {
  const states = [], effects = [], timers = new Map(), listeners = new Map(), requests = []
  let cursor = 0, nextTimer = 0, cleanup, deps, effect
  const document = { hidden, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) } }
  const context = vm.createContext({
    URL, AbortController, Date, Number, Object, Array,
    window: { location: { href: 'http://localhost/lab' }, __CHONKYFISH_STATE__: route ? { routes: { events: route } } : {} },
    document, RESOURCES: { routes: { events: '/chonkyfish/events' } },
    fetch: async (url, options) => { requests.push({ url, ...options }); return fetcher ? fetcher(url, options) : { ok: true, json: async () => ({ ok: true, events: [] }) } },
    setInterval: (fn, ms) => { assert.equal(ms, 15000); timers.set(++nextTimer, fn); return nextTimer }, clearInterval: id => timers.delete(id),
    h: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    React: {
      useState: initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] },
      useEffect: (fn, nextDeps) => { if (!deps || nextDeps.some((value, i) => value !== deps[i])) { deps = nextDeps; effect = fn } },
    },
  })
  vm.runInContext(source, context)
  return {
    context, document, requests, timers, listeners,
    render() { cursor = 0; const tree = context.AbsEventsPanel(); if (effect) { cleanup?.(); cleanup = effect(); effects.push(effect); effect = null } return tree },
    tick() { for (const fn of timers.values()) fn() },
    visibility(value) { document.hidden = value; listeners.get('visibilitychange')?.() },
    unmount() { cleanup?.() },
  }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const text = tree => typeof tree === 'object' ? tree.children.map(text).join(' ') : String(tree)
const nodes = (tree, tag) => typeof tree !== 'object' ? [] : [...(tree.tag === tag ? [tree] : []), ...tree.children.flatMap(child => nodes(child, tag))]
const event = (seq, extra = {}) => ({ eventSeq: seq, eventId: 'event-' + seq, category: 'goal', type: 'goal.plan_expressed', actorRef: 'owner', evidenceStatus: 'intent', observedAt: '2026-11-10T04:00:00Z', occurredAt: null, target: '测试计划', quote: '<script>not HTML</script>', sessionId: 'session-real', recordId: 'session-real:7', ...extra })
let tests = 0
async function test(name, fn) { await fn(); tests++; console.log('PASS', name) }
await test('loads real route fallback, bounded newest snapshot, escaped quote and provenance', async () => {
  const app = harness({ fetcher: async () => ({ ok: true, json: async () => ({ ok: true, events: Array.from({ length: 35 }, (_, i) => event(i)) }) }) })
  assert.match(text(app.render()), /正在读取/)
  await flush()
  const tree = app.render()
  assert.equal(new URL(app.requests[0].url).pathname, '/chonkyfish/events')
  assert.equal(new URL(app.requests[0].url).searchParams.get('limit'), '30')
  assert.equal(new URL(app.requests[0].url).searchParams.get('latest'), 'true')
  assert.equal(nodes(tree, 'article').length, 30)
  assert.equal(nodes(tree, 'article')[0].props.key, 'event-34')
  assert.equal(nodes(tree, 'article').at(-1).props.key, 'event-5')
  assert.match(text(tree), /记录时间.*UTC\+8/)
  assert.match(text(tree), /事件发生时间：未明确/)
  assert.match(text(tree), /意图 · 不代表已执行/)
  assert.match(text(tree), /session-real:7/)
  assert.equal(nodes(tree, 'blockquote')[0].children[0], '<script>not HTML</script>')
  assert.equal(nodes(tree, 'script').length, 0)
  assert.equal(nodes(tree, 'details').length, 30)
  const select = nodes(tree, 'select')[0]
  assert.equal(nodes(select, 'option').length, 7)
  select.props.onChange({ target: { value: 'preference' } })
  assert.match(text(app.render()), /最新 30 条中暂无此类别事件/)
  app.unmount()
})
await test('bootstrap route wins, visibility pauses and resumes, cleanup releases resources', async () => {
  const app = harness({ hidden: true, route: '/custom/events?limit=200&sinceSeq=20' })
  app.render(); await flush(); assert.equal(app.requests.length, 0)
  app.tick(); await flush(); assert.equal(app.requests.length, 0)
  app.visibility(false); await flush(); assert.equal(app.requests.length, 1)
  assert.equal(new URL(app.requests[0].url).pathname, '/custom/events')
  assert.equal(new URL(app.requests[0].url).searchParams.has('sinceSeq'), false)
  assert.match(text(app.render()), /暂无抽取事件/)
  app.tick(); await flush(); assert.equal(app.requests.length, 2)
  app.visibility(true); app.tick(); await flush(); assert.equal(app.requests.length, 2)
  app.unmount(); assert.equal(app.timers.size, 0); assert.equal(app.listeners.size, 0)
})
await test('abort pending request on hide/unmount and ignore stale response', async () => {
  const pending = []
  const app = harness({ fetcher: () => new Promise(resolve => pending.push(resolve)) })
  app.render(); app.tick(); assert.equal(app.requests.length, 1)
  app.visibility(true); assert.equal(app.requests[0].signal.aborted, true)
  app.visibility(false); assert.equal(app.requests.length, 2)
  pending[1]({ ok: true, json: async () => ({ ok: true, events: [event(2)] }) }); await flush()
  pending[0]({ ok: true, json: async () => ({ ok: true, events: [event(1)] }) }); await flush()
  assert.equal(nodes(app.render(), 'article')[0].props.key, 'event-2')
  app.tick(); app.unmount(); assert.equal(app.requests[2].signal.aborted, true)
  pending[2]({ ok: true, json: async () => ({ ok: true, events: [] }) }); await flush()
  assert.equal(nodes(app.render(), 'article')[0].props.key, 'event-2')
})
await test('errors stay honest, retain prior records as stale, retry recovers', async () => {
  let count = 0
  const app = harness({ fetcher: async () => ++count === 2 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ ok: true, events: [event(count)] }) } })
  app.render(); await flush(); app.tick(); await flush()
  let tree = app.render()
  assert.match(text(tree), /HTTP 503/); assert.match(text(tree), /上次读取的记录/)
  assert.equal(nodes(tree, 'article').length, 1)
  nodes(tree, 'button')[0].props.onClick(); app.render(); await flush(); tree = app.render()
  assert.doesNotMatch(text(tree), /HTTP 503/); assert.equal(nodes(tree, 'article')[0].props.key, 'event-3')
  assert.equal(app.timers.size, 1); app.unmount()
})
await test('malformed payload and non-JSON surface errors rather than empty state', async () => {
  for (const json of [async () => ({ ok: false, events: [] }), async () => ({ ok: true, events: [null] }), async () => { throw new Error('bad json') }]) {
    const app = harness({ fetcher: async () => ({ ok: true, json }) })
    app.render(); await flush(); const tree = app.render()
    assert.ok(text(tree).includes('响应')); assert.doesNotMatch(text(tree), /暂无抽取事件/); app.unmount()
  }
})
console.log(`\n${tests} events client tests passed`)
