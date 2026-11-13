import assert from 'node:assert/strict'
import { createHelloService } from '../service.js'
const clone = structuredClone
function fixture(prompt = '') {
 let data = null, p = {generation:0,state:prompt ? {prompt,name:'原有鱼'} : {}}, a = {revision:0,timeScale:1,restHours:{enabled:true,start:'23:00',end:'08:00'},mode:'shadow'}, pc = {supported:true,requested:false,state:'stopped',controlRevision:0}, calls = {panel:0,abs:0,perception:0}, failAbs = false
 const store = {read:async()=>clone(data),write:async(s,r)=>{assert.equal(data?.revision??null,r);data=clone(s)}}
 const panel = {read:async()=>clone(p),patchIdentity:async({expectedGeneration,...patch})=>{assert.equal(expectedGeneration,p.generation);p={generation:p.generation+1,state:{...p.state,...patch}};calls.panel++}}
 const abs = {readSettings:async()=>clone(a),updateSettings:async({expectedRevision,...patch})=>{if(failAbs)throw Object.assign(new Error('known'),{code:'FAIL',outcome:'not_applied'});assert.equal(expectedRevision,a.revision);a={...a,...patch,revision:a.revision+1};calls.abs++}}
 const perception = {inspect:async()=>clone(pc),setRequested:async(v,expected)=>{if(expected && (expected.expectedControlRevision!==pc.controlRevision || expected.expectedRequested!==pc.requested)) throw Object.assign(new Error('STALE_TARGET'),{code:'STALE_TARGET',outcome:'not_applied'});pc={...pc,requested:v,state:v?'running':'stopped',controlRevision:pc.controlRevision+1};calls.perception++}}
 const ports={store,panel,abs,perception}
 return {service:createHelloService(ports),ports,calls,get p(){return p},get a(){return a},set failAbs(v){failAbs=v},mutatePanel(){p.generation++;p.state.name='later'},crash(){data.operations.at(-1).steps.abs.status='applying'},data:()=>data}
}
async function prepared(f) { let b=await f.service.bootstrap(); await f.service.saveDraft({expectedRevision:b.state.revision,patch:{perceptionRequested:false},step:'review'}); return f.service.bootstrap() }
{
 const f=fixture(), b=await f.service.bootstrap();assert.equal(b.state.entryKind,'new');await assert.rejects(f.service.applyBase({operationId:'x',expectedRevision:0,expectedSources:b.expectedSources}),/PERCEPTION_REQUIRED/)
 const ready=await prepared(f), input={operationId:'x',expectedRevision:ready.state.revision,expectedSources:ready.expectedSources};let op=await f.service.applyBase(input);assert.equal(op.status,'completed');assert.equal(f.a.mode,'shadow');assert.equal(f.calls.panel,1);assert.equal((await f.service.applyBase(input)).status,'completed');assert.equal(f.calls.panel,1)
}
{
 const f=fixture('用户复杂人格'),b=await f.service.bootstrap();assert.equal(b.state.entryKind,'existing');await assert.rejects(f.service.saveDraft({expectedRevision:0,patch:{prompt:'替换'}}),/EXISTING_PERSONA_PROTECTED/)
 const r=await prepared(f);await f.service.applyBase({operationId:'keep',expectedRevision:r.state.revision,expectedSources:r.expectedSources});assert.equal(f.p.state.prompt,'用户复杂人格')
}
{
 const f=fixture(),b=await prepared(f);f.failAbs=true;let op=await f.service.applyBase({operationId:'partial',expectedRevision:b.state.revision,expectedSources:b.expectedSources});assert.equal(op.status,'partial');assert.equal(op.steps.panel.status,'applied');f.failAbs=false;op=await f.service.resume({operationId:'partial'});assert.equal(op.status,'completed');assert.equal(f.calls.panel,1)
}
{
 const f=fixture(),b=await prepared(f);f.failAbs=true;await f.service.applyBase({operationId:'race',expectedRevision:b.state.revision,expectedSources:b.expectedSources});f.mutatePanel();f.failAbs=false;const op=await f.service.resume({operationId:'race'});assert.equal(op.status,'partial');assert.equal(op.steps.panel.error,'HELLO_SOURCE_CHANGED');assert.equal(f.calls.abs,0)
 const state=(await f.service.bootstrap()).state;await f.service.abandon({operationId:'race',expectedRevision:state.revision});assert.equal((await f.service.bootstrap()).state.draft.name,'later')
}
{
 const f=fixture(),b=await prepared(f);f.failAbs=true;await f.service.applyBase({operationId:'crash',expectedRevision:b.state.revision,expectedSources:b.expectedSources});f.crash();const service=createHelloService(f.ports);assert.equal((await service.bootstrap()).state.operations[0].steps.abs.status,'unknown');await service.resume({operationId:'crash'});assert.equal(f.calls.abs,0)
}
{
 const f=fixture();const b=await f.service.bootstrap();await assert.rejects(f.service.saveDraft({expectedRevision:0,patch:{mode:'active'}}),/INVALID_DRAFT/);await assert.rejects(f.service.saveDraft({expectedRevision:99,patch:{name:'x'}}),/STALE_REVISION/)
}
{
 const f=fixture(),b=await prepared(f),original=f.ports.abs.updateSettings
 f.ports.abs.updateSettings=async value=>{await original(value);f.mutatePanel()}
 const op=await f.service.applyBase({operationId:'end-race',expectedRevision:b.state.revision,expectedSources:b.expectedSources})
 assert.equal(op.status,'partial');assert.equal(op.steps.panel.error,'HELLO_SOURCE_CHANGED')
}
{
 const f=fixture(),b=await prepared(f)
 await f.ports.perception.setRequested(true)
 await assert.rejects(f.service.applyBase({operationId:'perception-race',expectedRevision:b.state.revision,expectedSources:b.expectedSources}),/SOURCE_CHANGED/)
 assert.equal(f.calls.panel,0)
}
{
 const f=fixture();await f.service.close();await assert.rejects(f.service.bootstrap(),/HELLO_CLOSED/)
}
{
 const f=fixture(),b=await prepared(f)
 let closing
 const original=f.ports.panel.patchIdentity
 f.ports.panel.patchIdentity=async value=>{await original(value);closing=f.service.close()}
 const op=await f.service.applyBase({operationId:'closing',expectedRevision:b.state.revision,expectedSources:b.expectedSources})
 await closing;assert.equal(op.status,'partial');assert.equal(f.calls.abs,0)
}
{
 const f=fixture(),b=await prepared(f),write=f.ports.store.write
 // User opens perception between observation and persisted intent, then closes it:
 // the value is identical, but the revision must still protect their later action.
 f.ports.store.write=async(s,r)=>{await write(s,r);if(s.operations.at(-1)?.steps.perception.status==='applying'){await f.ports.perception.setRequested(true);await f.ports.perception.setRequested(false)}}
 const op=await f.service.applyBase({operationId:'journal-aba',expectedRevision:b.state.revision,expectedSources:b.expectedSources})
 assert.equal(op.status,'partial');assert.equal(op.steps.perception.status,'failed');assert.equal(op.steps.perception.error,'STALE_TARGET');assert.equal(f.calls.perception,2)
}
{
 const f=fixture(),b=await f.service.bootstrap()
 await f.ports.panel.patchIdentity({expectedGeneration:0,prompt:'在原人格页设置的新内容'})
 const saved=await f.service.saveDraft({expectedRevision:b.state.revision,patch:{name:'鱼鱼',perceptionRequested:false},step:'review'})
 assert.equal(saved.draft.prompt,'在原人格页设置的新内容')
 await assert.rejects(f.service.saveDraft({expectedRevision:saved.revision,patch:{prompt:b.state.draft.prompt}}),/EXISTING_PERSONA_PROTECTED/)
 const fresh=await f.service.bootstrap()
 const op=await f.service.applyBase({operationId:'external-persona',expectedRevision:fresh.state.revision,expectedSources:fresh.expectedSources})
 assert.equal(op.status,'completed');assert.equal(f.p.state.prompt,'在原人格页设置的新内容')
}
console.log('hello core tests passed')
