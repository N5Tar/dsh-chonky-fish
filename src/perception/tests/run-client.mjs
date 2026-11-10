import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const build = await readFile(new URL('../../../build.mjs', import.meta.url), 'utf8')
const states = [], effects = [], cleanups = new Map(), timers = new Map(), listeners = new Set(), requests = []
let cursor = 0, timerId = 0, tree, liveState = 'stopped', hasData = false, fail = false
const now = Date.now()
const stats = { coverage: .9, categoryShare: { development: .8 }, observedSwitches: 3, apps: [{ name:'<script>not markup</script>', durationMs:60000, share:.8 }] }
const summary = { id:9, activity:'development', interaction:'recent_input', continuity:'brief', confidence:'high', analyzedAt:now, sourceThrough:now, activitySince:now-60000, windowStats:{long:stats,short:stats}, evidence:[] }
const context = vm.createContext({
  window: {}, RESOURCES: { routes: { perception:'/chonkyfish/perception' } }, URLSearchParams, AbortController, Date,
  document: { hidden:false, addEventListener: (_,fn) => listeners.add(fn), removeEventListener: (_,fn) => listeners.delete(fn) },
  setInterval(fn, delay) { const id = ++timerId; timers.set(id,{fn,delay}); return id }, clearInterval: id => timers.delete(id),
  React: { Fragment:'fragment',
    useState(initial) { const i=cursor++; if (!(i in states)) states[i]=initial; return [states[i],v => { states[i]=typeof v==='function'?v(states[i]):v }] },
    useRef(initial) { const i=cursor++; if (!(i in states)) states[i]={current:initial}; return states[i] },
    useEffect(fn,deps) { const i=cursor++, prior=states[i]; if (!prior || deps.some((v,k)=>v!==prior[k])) { effects.push(()=>{cleanups.get(i)?.();cleanups.set(i,fn())}); states[i]=deps } },
  },
  h(type,props,...children) { return {type,props:props||{},children:children.flat(Infinity).filter(v=>v!=null&&v!==false)} },
  fetch: async (url,options) => {
    requests.push({url,options})
    if (fail) throw new Error('offline fixture')
    const params = new URL(url,'http://local').searchParams, action=params.get('action')
    let body
    if (options.method==='POST') { const cmd=JSON.parse(options.body).action; liveState=cmd==='start'?'running':cmd==='pause'?'paused':'stopped'; body={state:liveState} }
    else if (action==='status') body={state:liveState,enabled:true,capabilities:{supported:true},latestSample:hasData?{receivedAtMs:now,foregroundApp:{id:'test',name:'Synthetic IDE'},idleSeconds:2,sessionState:'unknown',missing:['lockState']}:null,lastAnalysisAt:hasData?now:null,retention:{rawTtlMs:3600000,summaryTtlMs:604800000},storage:{samples:hasData?180:0,summaries:hasData?1:0},cleanup:{at:now,samples:0,summaries:0,error:null}}
    else if (action==='current') body={data:hasData?summary:null,freshness:{isFresh:liveState==='running',reasons:[]}}
    else if (action==='timeline') body={fromMs:now-60000,toMs:now,items:hasData?[{startMs:now-60000,endMs:now,app:{name:'Synthetic IDE'},kind:'activity',category:'development',interaction:'recent_input'}]:[]}
    else body={items:hasData?[summary]:[],nextCursor:params.get('cursor')?null:8}
    return {ok:true,status:200,json:async()=>({ok:true,...body})}
  },
})
vm.runInContext(source,context)
const Page=context.createPerceptionPage()
function render(){cursor=0;tree=Page()}
function nodes(n){return n&&typeof n==='object'?[n,...n.children.flatMap(nodes)]:[]}
async function flush(){for(let i=0;i<5;i++){effects.splice(0).forEach(fn=>fn());await new Promise(r=>setImmediate(r));render()}}
async function click(label){const b=nodes(tree).find(n=>n.type==='button'&&n.children.includes(label));assert.ok(b,label);assert.equal(Boolean(b.props.disabled),false,label);await b.props.onClick();render();await flush()}
render();await flush()
assert.match(JSON.stringify(tree),/尚未采集/)
assert.equal(requests.filter(r=>r.options.method==='POST').length,0)
assert.equal(timers.size,2)
assert.ok(build.includes("panel.view === 'sense' ? createPerceptionPage()"))
assert.equal((build.match(/id: 'chonkyfish-sense'/g)||[]).length,1)
console.log('PASS perception mounts existing sense page without auto-start')
await click('开始采集');assert.equal(liveState,'running')
const post=requests.find(r=>r.options.method==='POST');assert.equal(post.url,'/chonkyfish/perception');assert.deepEqual(JSON.parse(post.options.body),{action:'start'})
await click('暂停');assert.equal(liveState,'paused');await click('停止');assert.equal(liveState,'stopped')
console.log('PASS explicit JSON start pause stop controls')
hasData=true;await click('刷新')
assert.equal(context.perceptionLabel('development'),'工作');assert.match(JSON.stringify(tree),/工作占比/);assert.doesNotMatch(JSON.stringify(tree),/开发倾向|开发占比/);assert.equal(nodes(tree).filter(n=>n.type==='svg').length,3)
assert.match(JSON.stringify(tree),/非实时结果/)
assert.ok(!nodes(tree).some(n=>'dangerouslySetInnerHTML' in n.props));assert.ok(nodes(tree).some(n=>n.type==='li'&&n.children.some(x=>typeof x==='string'&&x.includes('<script>'))))
await click('查看');assert.ok(nodes(tree).some(n=>n.type==='pre'));await click('收起')
console.log('PASS facts analysis three tracks and escaped summary detail')
await click('更早摘要');assert.ok(requests.some(r=>r.url.includes('cursor=8')))
await click('最新摘要')
console.log('PASS bounded summary pagination and latest reset')
const before=requests.length;context.document.hidden=true;for(const item of timers.values())await item.fn();await flush();assert.equal(requests.length,before)
context.document.hidden=false;for(const fn of [...listeners])fn();await flush();assert.ok(requests.length>before)
console.log('PASS hidden page stops polling and visibility refreshes')
fail=true;await click('刷新');assert.match(JSON.stringify(tree),/offline fixture/);assert.match(JSON.stringify(tree),/非实时结果/)
console.log('PASS offline state preserves data but never claims fresh result')
for(const cleanup of cleanups.values())cleanup?.();assert.equal(timers.size,0);assert.equal(listeners.size,0)
assert.ok(requests.filter(r=>r.options.method==='GET'&&r.options.signal).every(r=>r.options.signal.aborted))
context.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true})})
await assert.rejects(context.requestPerception({action:'status'}),/响应不完整/)
console.log('PASS unmount cleanup aborts requests; malformed response is rejected')
console.log('perception client: 7 groups passed (mock React/HTTP, no live GUI)')
