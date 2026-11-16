import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const source=readFileSync(new URL('../panel.js',import.meta.url),'utf8')
for(const importOnly of [false,true]) {
 let states=[],cursor=0,requests=[],fail=false,committed=0,back=0
 const window=new EventTarget();window.addEventListener('chonkyfish:migration-complete',()=>committed++)
 const context=vm.createContext({zh:{},en:{},MODULE_SURFACE:'',CustomEvent,window,
  RESOURCES:{routes:{migrationImportInspect:'/inspect',migrationImportCommit:'/commit',migrationImportCancel:'/cancel',migrationExport:'/export'}},
  React:{useState(v){const i=cursor++;if(!(i in states))states[i]=v;return[states[i],v=>states[i]=typeof v==='function'?v(states[i]):v]},useRef(v){const i=cursor++;if(!(i in states))states[i]={current:v};return states[i]}},
  h(type,props,...children){return{type,props:props||{},children:children.flat(Infinity).filter(v=>v!=null&&v!==false)}},
  fetch:async(url,options)=>{requests.push({url,options});if(fail)throw new Error('INVALID_ARCHIVE');return{ok:true,json:async()=>({ok:true,data:url==='/inspect'?{importId:'import-id',sections:{identity:1,diaries:2},warnings:[]}:url==='/commit'?{restartRequired:true}:{}})}}
 })
 vm.runInContext(source,context)
 const Page=context.createMigrationSettings(k=>context.zh[k],{importOnly})
 const render=()=>{cursor=0;return Page({onBack:()=>back++})}
 const all=t=>t&&typeof t==='object'?[t,...t.children.flatMap(all)]:[]
 const button=name=>all(render()).find(n=>n.type==='button'&&n.children.includes(name))
 const select=()=>all(render()).find(n=>n.type==='input').props.onChange({target:{files:[{name:'backup.fishpack'}],value:'file'}})
 assert.equal(!!button('导出资料'),!importOnly)
 fail=true;await select();assert.equal(committed,0);assert(all(render()).some(n=>n.props.role==='alert'));assert(!button('确认替换'))
 fail=false;await select();assert(button('确认替换'));assert.equal(committed,0)
 await button('取消').props.onClick();assert(!button('确认替换'));assert.equal(requests.at(-1).url,'/cancel')
 await select();fail=true;await button('确认替换').props.onClick();assert.equal(committed,0);assert(button('确认替换'),'failed commit retains operation for retry')
 fail=false;await button('确认替换').props.onClick();assert.equal(committed,1);assert(!button('确认替换'))
 assert.equal(JSON.parse(requests.at(-1).options.body).id,'import-id')
 if(importOnly){await select();await button('返回首次设置').props.onClick();assert.equal(back,1);assert.equal(requests.at(-1).url,'/cancel')}
}
console.log('Migration UI: settings and onboarding share inspect/cancel/error/retry/commit flow')
