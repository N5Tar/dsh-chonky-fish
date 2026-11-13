import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
const source = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
let states = [], cursor = 0, effects = [], pending = [], requests = []
const initial = { state: { revision: 0, status: 'draft', step: 'welcome', entryKind: 'new', draft: { name: '大肥鱼', prompt: '新手补充', perceptionRequested: null, abs: { timeScale: 1, restHours: { enabled: true, start: '23:00', end: '08:00' } } } }, current: { panel: { state: {} }, perception: { supported: false, state: 'unsupported' } }, expectedSources: { panelGeneration: 0, absRevision: 'a' } }
const context = vm.createContext({ zh: {}, en: {}, RESOURCES: { routes: { hello: '/hello' }, assets: { avatar: 'avatar' } }, window: { crypto: { randomUUID: () => 'op-test' } }, AbortController, URLSearchParams, console, fetch: async(url, opts) => { requests.push(opts); return { ok: true, json: async() => ({ ok: true, data: opts.body ? { ...initial.state, revision: 1 } : structuredClone(initial) }) } }, React: { useState(value) { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], value => { states[i] = value }] }, useRef(value) { const i = cursor++; if (!(i in states)) states[i] = { current: value }; return states[i] }, useEffect(fn) { const i = cursor++; if (!(i in states)) { states[i] = true; effects.push(fn) } } }, h(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(x=>x != null && x !== false) } }, createPanelPage: view => function MockPage() { return view } })
vm.runInContext(source, context)
assert.equal(context.helloValidTime('25:00'), false)
assert.equal(context.helloValidTime('23:59'), true)
assert.equal(context.helloCanContinue('perception', initial.state.draft), false)
assert.equal(context.helloCanContinue('rhythm', initial.state.draft), true)
assert.equal(context.helloCanContinue('rhythm', { abs: { timeScale: -1 } }), false)
assert(!source.includes('localStorage'))
const Page = context.createHelloPage()
function render() { cursor = 0; return Page() }
function all(tree) { return tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(all)] : [] }
function button(tree, name) { return all(tree).find(x=>x.type === 'button' && x.children.includes(name)) }
render(); for (const effect of effects.splice(0)) effect(); await new Promise(resolve=>setTimeout(resolve,0))
let tree = render()
assert(button(tree, '开始认识彼此'))
button(tree, '开始认识彼此').props.onClick(); await new Promise(resolve=>setTimeout(resolve,0))
tree = render(); assert(all(tree).some(x=>x.type === 'textarea'))
assert.equal(JSON.parse(requests.at(-1).body).action, 'save-draft')
// Existing prompt must never be writable or sent by Hello.
initial.current.panel.state.prompt = '用户自己的设定'; states = []; effects = []; render(); effects.splice(0).forEach(fn=>fn()); await new Promise(resolve=>setTimeout(resolve,0)); tree = render(); button(tree, '开始认识彼此').props.onClick(); await new Promise(resolve=>setTimeout(resolve,0)); tree = render()
assert.equal(all(tree).find(x=>x.type==='textarea').props.readOnly,true)
assert(!Object.hasOwn(JSON.parse(requests.at(-1).body).patch,'prompt'))
button(tree,'先去聊天').props.onClick(); tree=render(); assert.equal(tree.type(),'chat')
console.log('Hello client: validation, persisted draft, existing persona preservation, exit passed')
