import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const source = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
const build = readFileSync(new URL('../../../build.mjs', import.meta.url), 'utf8')
assert(!build.includes("id: 'chonkyfish-hello'"), 'first-use is not a menu')
assert(build.includes('createHelloGate('), 'all registered panels share the gate')
const panels = [...build.matchAll(/id: '[^']+', view: '([^']+)'/g)].map(m => m[1])
assert.equal(panels.length, 8)
for (const view of panels) {
  let states=[],cursor=0,effects=[],cleanups=[],fail=false,completed=false,existing=false
  const events = new EventTarget()
  const context=vm.createContext({zh:{},en:{},AbortController,RESOURCES:{routes:{hello:'/hello'}},
    window:events, React:{
      useState(v){const i=cursor++;if(!(i in states))states[i]=v;return[states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}]},
      useRef(v){const i=cursor++;if(!(i in states))states[i]={current:v};return states[i]},
      useEffect(fn){const i=cursor++;if(!(i in states)){states[i]=true;effects.push(fn)}}},
    h(type,props,...children){return{type,props:props||{},children:children.flat(Infinity).filter(v=>v!=null&&v!==false)}},
    createPanelPage:()=>()=>null,createMigrationSettings:()=>()=>null,
    fetch:async()=>{if(fail)throw new Error('offline');return{ok:true,json:async()=>({ok:true,data:{state:{entryKind:existing?'existing':'new',status:completed?'completed':'draft'}}})}}
  })
  vm.runInContext(source,context)
  const Page=()=>view,Gate=context.createHelloGate(Page,k=>k)
  const render=()=>{cursor=0;return Gate()}
  const flush=async()=>{for(const fn of effects.splice(0))cleanups.push(fn());await new Promise(r=>setTimeout(r,0))}
  let tree=render();assert.notEqual(tree.type,Page);await flush();tree=render();assert.equal(tree.type.name,'HelloPage',view+' cannot bypass')
  events.dispatchEvent(new Event('focus'));assert.equal(render().type.name,'HelloPage','native file picker focus must not unmount importer')
  fail=true;events.dispatchEvent(new Event('chonkyfish:migration-complete'));await flush();tree=render();assert.notEqual(tree.type,Page)
  const nodes=t=>t&&typeof t==='object'?[t,...t.children.flatMap(nodes)]:[]
  assert(nodes(tree).some(n=>n.props.role==='alert'))
  const retry=nodes(tree).find(n=>n.type==='button');assert(retry)
  fail=false;completed=true;retry.props.onClick();await flush();assert.equal(render().type,Page,view+' opens after completion')
  events.dispatchEvent(new Event('chonkyfish:migration-complete'));assert.equal(render().type,Page,'settings success feedback stays mounted');await flush()
  for(const fn of cleanups.splice(0))fn?.()
  states=[];effects=[];existing=true;completed=false;render();await flush();assert.equal(render().type,Page,'existing installation opens directly')
  for(const fn of cleanups.splice(0))fn?.()
}
console.log('Hello gates: all menus, fail-closed loading/error/retry, completion and existing installs passed')
