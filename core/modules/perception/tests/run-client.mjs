import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
const source = await readFile(new URL('../../../../app/dsh/ui/perception/client.js', import.meta.url), 'utf8')
const build = await readFile(new URL('../../../../app/dsh/build.mjs', import.meta.url), 'utf8')
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
const Page=context.AbsOwnerStatePanel
function render(){cursor=0;tree=Page()}
function nodes(n){return n&&typeof n==='object'?[n,...n.children.flatMap(nodes)]:[]}
async function flush(){for(let i=0;i<5;i++){effects.splice(0).forEach(fn=>fn());await new Promise(r=>setImmediate(r));render()}}
async function click(label){const b=nodes(tree).find(n=>n.type==='button'&&n.children.includes(label));assert.ok(b,label);assert.equal(Boolean(b.props.disabled),false,label);await b.props.onClick();render();await flush()}
render();await flush()
assert.match(JSON.stringify(tree),/暂无当前预测/)
assert.equal(requests.filter(r=>r.options.method==='POST').length,0)
assert.equal(timers.size,1)
assert.ok(!build.includes("panel.view === 'sense' ? createPerceptionPage()"))
assert.equal((build.match(/id: 'chonkyfish-sense'/g)||[]).length,0)
assert.match(JSON.stringify(tree),/主人状态/)
console.log('PASS simplified page mounts without auto-start')
await click('开始感知');assert.equal(liveState,'running')
const post=requests.find(r=>r.options.method==='POST');assert.equal(post.url,'/chonkyfish/perception');assert.deepEqual(JSON.parse(post.options.body),{action:'start'})
hasData=true;await click('刷新')
assert.ok(nodes(tree).some(n=>n.props.className==='activity'&&n.children.includes('工作')))
assert.doesNotMatch(JSON.stringify(tree),/当前观察|应用分布|历史摘要|近期变化|数据保留|工作占比|置信等级/)
assert.equal(nodes(tree).filter(n=>['svg','table','pre'].includes(n.type)).length,0)
console.log('PASS only current prediction appears, without diagnostic panels')
await click('停止感知');assert.equal(liveState,'stopped')
assert.match(JSON.stringify(tree),/暂无当前预测/)
assert.ok(!nodes(tree).some(n=>n.props.className==='activity'&&n.children.includes('工作')))
console.log('PASS stopped collection never presents historical state as current')
assert.ok(requests.filter(r=>r.options.method==='GET').every(r=>['status','current'].includes(new URL(r.url,'http://local').searchParams.get('action'))))
console.log('PASS no timeline or history requests')
await click('开始感知')
const before=requests.length;context.document.hidden=true;for(const item of timers.values())await item.fn();await flush();assert.equal(requests.length,before)
context.document.hidden=false;for(const fn of [...listeners])fn();await flush();assert.ok(requests.length>before)
console.log('PASS hidden page stops polling and visibility refreshes')
fail=true;await click('刷新');assert.match(JSON.stringify(tree),/offline fixture/);assert.match(JSON.stringify(tree),/暂无当前预测/)
console.log('PASS offline state preserves data but never claims fresh result')
for(const cleanup of cleanups.values())cleanup?.();assert.equal(timers.size,0);assert.equal(listeners.size,0)
assert.ok(requests.filter(r=>r.options.method==='GET'&&r.options.signal).every(r=>r.options.signal.aborted))
context.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true})})
await assert.rejects(context.requestPerception({action:'status'}),/响应不完整/)
console.log('PASS unmount cleanup aborts requests; malformed response is rejected')
console.log('perception client: 7 groups passed (mock React/HTTP, no live GUI)')
