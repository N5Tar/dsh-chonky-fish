import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const source=readFileSync(new URL('../panel.js',import.meta.url),'utf8')
for(const importOnly of [false,true]) {
 let states=[],cursor=0,requests=[],fail=false,committed=0,back=0
 const window=new EventTarget();window.addEventListener('chonkyfish:migration-complete',()=>committed++)
 const context=vm.createContext({zh:{},en:{},MODULE_SURFACE:'',CustomEvent,window,
  RESOURCES:{routes:{migrationImportInspect:'/inspect',migrationImportCommit:'/commit',migrationImportCancel:'/cancel',migrationExport:'/export'}},
  React:{useState(v){const i=cursor++;if(!(i in states))states[i]=v;return[states[i],v=>states[i]=typeof v==='function'?v(states[i]):v]},useRef(v){const i=cursor++;if(!(i in states))states[i]={current:v};return states[i]},useEffect() {},Fragment:'fragment'},
  h(type,props,...children){return{type,props:props||{},children:children.flat(Infinity).filter(v=>v!=null&&v!==false)}},
  fetch:async(url,options)=>{requests.push({url,options});if(fail)throw new Error('INVALID_ARCHIVE');return{ok:true,json:async()=>({ok:true,data:url==='/inspect'?{importId:'import-id',sections:{identity:1,diaries:2},warnings:[]}:url==='/commit'?{restartRequired:true}:{}})}}
 })
 vm.runInContext(source,context)
 const Page=context.createMigrationSettings(k=>context.zh[k],{importOnly})
 const render=()=>{cursor=0;return Page({onBack:()=>back++})}
 const all=t=>t&&typeof t==='object'?[t,...t.children.flatMap(all)]:[]
 const role=(name, tree=render())=>all(tree).filter(node=>node.props.role===name)
 const tabs=()=>role('tab')
 const panels=()=>role('tabpanel')
 const activeContent=()=>panels().find(panel=>!panel.props.hidden)||render()
 const button=name=>all(activeContent()).find(n=>n.type==='button'&&n.children.includes(name))
 const select=()=>all(activeContent()).find(n=>n.type==='input').props.onChange({target:{files:[{name:'backup.fishpack'}],value:'file'}})
 if(importOnly){
  assert.equal(role('tablist').length,0,'onboarding opens the dedicated import flow')
  assert(!all(render()).some(node=>node.type.name==='VoiceSettings'))
 }else{
  assert.equal(role('tablist').length,1)
  assert.deepEqual(tabs().map(tab=>tab.children[0]),['语音设置','鱼鱼的日程','资料导入 / 导出'])
  assert.deepEqual(tabs().map(tab=>tab.props.tabIndex),[0,-1,-1])
  assert.equal(panels().length,3)
  for(const tab of tabs()){
   const panel=panels().find(node=>node.props.id===tab.props['aria-controls'])
   assert.equal(panel?.props['aria-labelledby'],tab.props.id)
  }
  const voiceComponent=panels()[0].children[0].type
  assert.equal(voiceComponent.name,'VoiceSettings')
  assert.equal(panels()[0].children[0].props.active,true)
  assert.deepEqual(panels().map(panel=>panel.props.hidden),[false,true,true])
  assert(!button('导出资料'))
  let focused, prevented=0
  tabs().forEach((tab,index)=>tab.props.ref({focus(){focused=index}}))
  for(const [key, from, to] of [['ArrowRight',0,1],['ArrowLeft',1,0],['End',0,2],['Home',2,0]]){
   tabs()[from].props.onKeyDown({key,preventDefault(){prevented++}})
   assert.equal(focused,to)
   assert.deepEqual(tabs().map(tab=>tab.props['aria-selected']),[to===0,to===1,to===2])
  }
  assert.equal(prevented,4)
  tabs()[1].props.onClick()
  assert.deepEqual(tabs().map(tab=>tab.props.tabIndex),[-1,0,-1])
  assert.deepEqual(panels().map(panel=>panel.props.hidden),[true,false,true])
  assert.equal(panels()[0].children[0].type,voiceComponent,'voice draft component stays mounted')
  assert.equal(panels()[0].children[0].props.active,false)
  tabs()[2].props.onClick()
  assert.deepEqual(panels().map(panel=>panel.props.hidden),[true,true,false])
 }
 assert.equal(!!button('导出资料'),!importOnly)
 fail=true;await select();assert.equal(committed,0);assert(all(render()).some(n=>n.props.role==='alert'));assert(!button('确认替换'))
 fail=false;await select();assert(button('确认替换'));assert.equal(committed,0)
 if(!importOnly){
  const requestCount=requests.length
  tabs()[0].props.onClick();assert(!button('确认替换'))
  tabs()[2].props.onClick();assert(button('确认替换'),'tab switching preserves the pending import')
  assert.equal(requests.length,requestCount,'tab switching sends no migration requests')
 }
 await button('取消').props.onClick();assert(!button('确认替换'));assert.equal(requests.at(-1).url,'/cancel')
 await select();fail=true;await button('确认替换').props.onClick();assert.equal(committed,0);assert(button('确认替换'),'failed commit retains operation for retry')
 fail=false;await button('确认替换').props.onClick();assert.equal(committed,1);assert(!button('确认替换'))
 assert.equal(JSON.parse(requests.at(-1).options.body).id,'import-id')
 if(importOnly){await select();await button('返回首次设置').props.onClick();assert.equal(back,1);assert.equal(requests.at(-1).url,'/cancel')}
}
assert.match(source,/className: 'cf-voice-provider-list'/,'voice services use provider preset cards')
assert.match(source,/h\('dialog',\s*\{/,'voice browser uses a native dialog')
assert.match(source,/voiceOfficialSample/,'official samples remain distinct from generated previews')
assert.match(source,/voicePreviewCost/,'generated audition has an explicit cost notice')
console.log('Settings tabs: default voice panel, keyboard navigation, retained import state, and dedicated onboarding import')
