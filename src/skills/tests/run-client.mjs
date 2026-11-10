import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../panel.js', import.meta.url), 'utf8')
const states = [], effects = []
let cursor = 0, tree
const context = vm.createContext({
  MODULE_SURFACE: await readFile(new URL('../../module-surface.css', import.meta.url), 'utf8'), ICON_SKILLS: () => null,
  zh: {}, en: {}, window: {}, RESOURCES: { routes: { skills: '/chonkyfish/skills' } },
  URLSearchParams, AbortController, Blob, URL, setTimeout,
  React: {
    Fragment: 'fragment',
    Component: class { constructor(props) { this.props = props; this.state = {} } },
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i] },
    useEffect(callback, deps) { const i = cursor++; const prev = states[i]; if (!prev || deps.some((d, k) => d !== prev[k])) { effects.push(callback); states[i] = deps } },
  },
  h(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined) } },
  fetch: async url => {
    const action = new URL(url, 'http://localhost').searchParams.get('action')
    const section = new URL(url, 'http://localhost').searchParams.get('section')
    const common = { revision: 1, offset: 0, limit: 10, total: 0, nextOffset: null }
    const data = action === 'list' ? { items: [{ skillId: 'test', title: 'Test', description: 'Demo', revision: 1 }], nextOffset: null } : action === 'history' ? { ...common, items: [] } : section === 'experiences' ? { ...common, section, items: [{ id: 'e1', claim: 'Learned', evidenceRefs: [], createdAt: '2026-01-01' }] } : { ...common, section: 'guide', content: '# Guide' }
    return { ok: true, status: 200, json: async () => ({ ok: true, enabled: true, data }) }
  },
})
vm.runInContext(source, context)
const Page = context.createSkillsPage(key => context.SKILLS_ZH[key] || key)
function render() { cursor = 0; tree = Page(); return tree }
function nodes(node) { return node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [] }
function click(label) { const button = nodes(tree).find(n => n.type === 'button' && n.children.includes(label)); assert.ok(button, label); button.props.onClick(); render() }
async function flush() { for (let i = 0; i < 5; i++) { effects.splice(0).forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); render() } }
render(); await flush()
assert.match(JSON.stringify(tree), /# Guide/)
// React renders new view with old detail BEFORE useEffect clears it. This was the white screen.
click('学习经验'); await flush(); assert.match(JSON.stringify(tree), /Learned/)
click('使用指南'); await flush(); assert.match(JSON.stringify(tree), /# Guide/)
click('版本历史'); await flush(); assert.match(JSON.stringify(tree), /还没有版本记录/)
click('学习经验'); click('使用指南'); click('版本历史'); await flush()
console.log('PASS skills panel tab transitions and rapid switching')
assert.ok(nodes(tree).some(n => n.props.className === 'shell module-shell'))
assert.ok(nodes(tree).some(n => n.props.className === 'module-head'))
assert.ok(nodes(tree).some(n => n.props.className === 'layout module-card'))
assert.ok(nodes(tree).some(n => n.props.className === 'cf-skills cf-module'))
assert.ok(nodes(tree).some(n => n.props.className === 'skill-id' && n.children.includes('test')))
assert.ok(nodes(tree).some(n => n.props.className === 'library-note'))
assert.ok(nodes(tree).some(n => n.props.className === 'footnote'))
function keyboard(key) {
  const tab = nodes(tree).find(n => n.props.role === 'tab' && n.props['aria-selected'])
  let prevented = false
  tab.props.onKeyDown({ key, preventDefault() { prevented = true } }); render()
  assert.equal(prevented, true)
  const active = nodes(tree).find(n => n.props.role === 'tab' && n.props['aria-selected'])
  const panel = nodes(tree).find(n => n.props.role === 'tabpanel')
  assert.equal(active.props.tabIndex, 0)
  assert.equal(active.props['aria-controls'], panel.props.id)
  assert.equal(panel.props['aria-labelledby'], active.props.id)
  return active.children[0]
}
assert.equal(keyboard('ArrowRight'), '使用指南')
assert.equal(keyboard('End'), '版本历史')
assert.equal(keyboard('Home'), '使用指南')
assert.equal(keyboard('ArrowLeft'), '版本历史')
await flush()
console.log('PASS approved layout details, tab semantics and keyboard navigation')
const result = await context.requestSkills({ action: 'list' })
assert.equal(result.ok, true)
console.log('PASS skills panel request adapter')
for (const code of ['CONFLICT', 'INVALID_ARGUMENT', 'LIMIT_EXCEEDED']) {
  context.fetch = async () => ({ ok: false, status: code === 'CONFLICT' ? 409 : 400, json: async () => ({ ok: false, error: { code } }) })
  await assert.rejects(context.requestSkills({}, undefined, { action: 'import', archive: {} }), new RegExp(code === 'CONFLICT' ? 'skillsConflict' : 'skillsInvalidArchive'))
}
let requested
context.fetch = async (url, options) => { requested = { url, options }; return { ok: true, status: 200, json: async () => ({ ok: true, data: { skillId: 'imported' } }) } }
await context.requestSkills({}, undefined, { action: 'import', archive: { skillId: 'imported' } })
assert.equal(requested.url, '/chonkyfish/skills')
assert.equal(requested.options.method, 'POST')
assert.equal(requested.options.headers['content-type'], 'application/json')
assert.equal(requested.options.headers['x-chonkyfish-token'], undefined)
assert.deepEqual(JSON.parse(requested.options.body), { action: 'import', archive: { skillId: 'imported' } })
for (const [data, tab] of [[{ revision: 1, content: 'old' }, 'experiences'], [{ revision: 1, items: [{ claim: 'bad', evidenceRefs: null }] }, 'experiences'], [{ revision: 1, content: null }, 'guide']]) {
  assert.throws(() => context.validateSkillsDetail(data, tab), /skillsInvalidResponse/)
}
const Boundary = context.createSafeSkillsPage(key => context.SKILLS_ZH[key] || key)
const boundary = new Boundary({})
boundary.state = { ...boundary.state, ...Boundary.getDerivedStateFromError(new Error('render failure')) }
assert.match(JSON.stringify(boundary.render()), /重新打开/)
assert.match(JSON.stringify(boundary.render()), /数据未改变/)
console.log('PASS import request contract, clear errors, payload validation and local recovery boundary')
// File preview and cancel do not mutate backend state.
const fileNode = nodes(tree).find(n => n.type === 'input' && n.props.type === 'file')
await fileNode.props.onChange({ target: { files: [{ size: 1048577 }], value: 'large.json' } }); render()
assert.match(JSON.stringify(tree), /文件不能超过/)
await fileNode.props.onChange({ target: { files: [{ size: 10, text: async () => '{bad' }], value: 'bad.json' } }); render()
assert.match(JSON.stringify(tree), /文件不是有效/)
await fileNode.props.onChange({ target: { files: [{ size: 100, name: 'valid.json', text: async () => JSON.stringify({ format: 1, skillId: 'imported', title: 'Imported', snapshots: [{ experiences: [] }] }) }], value: 'valid.json' } }); render()
assert.match(JSON.stringify(tree), /检查导入内容/)
click('取消'); assert.doesNotMatch(JSON.stringify(tree), /valid.json/)
console.log('PASS file size, invalid JSON, preview and cancellation')
const records = Array.from({ length: 64 }, (_, i) => ({ revision: i + 1 }))
context.fetch = async url => {
  const params = new URL(url, 'http://localhost').searchParams, offset = Number(params.get('offset'))
  return { ok: true, status: 200, json: async () => ({ ok: true, data: { revision: 64, total: 64, items: records.slice(offset, offset + 50), nextOffset: offset + 50 < 64 ? offset + 50 : null } }) }
}
const newest = await context.requestSkillsHistory('test', 0)
assert.deepEqual(Array.from(newest.data.items, x => x.revision), [64,63,62,61,60,59,58,57,56,55])
const oldest = await context.requestSkillsHistory('test', 60)
assert.deepEqual(Array.from(oldest.data.items, x => x.revision), [4,3,2,1])
assert.equal(oldest.data.nextOffset, null)
console.log('PASS latest-first history across service page boundaries')
let imports = 0
const offsets = []
context.fetch = async (url, options) => {
  const params = new URL(url, 'http://localhost').searchParams
  let data
  if (options.method === 'POST') { imports++; data = { skillId: 'imported' } }
  else if (params.get('action') === 'list') {
    const offset = Number(params.get('offset')); offsets.push(offset)
    data = { items: [{ skillId: offset ? 'imported' : 'test', title: offset ? 'Imported' : 'Test', description: 'Demo', revision: 1, experienceCount: 0 }], total: 11, nextOffset: offset ? null : 10 }
  } else data = { revision: 1, content: '# Imported', total: 10, offset: 0, limit: 8000, nextOffset: null }
  return { ok: true, status: 200, json: async () => ({ ok: true, enabled: true, data }) }
}
await fileNode.props.onChange({ target: { files: [{ size: 100, name: 'import.json', text: async () => JSON.stringify({ format: 1, skillId: 'imported', title: 'Imported', snapshots: [{ experiences: [] }] }) }], value: '' } }); render()
assert.ok(nodes(tree).some(n => n.type === 'dt' && n.children.includes('当前经验数')))
click('确认导入'); await flush()
assert.equal(imports, 1)
assert.deepEqual(offsets, [0, 10])
assert.ok(nodes(tree).some(n => n.props.className === 'skill-id' && n.children.includes('imported')))
assert.match(JSON.stringify(tree), /# Imported/)
console.log('PASS import preview counts and opening imported skill across directory pages')
