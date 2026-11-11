import assert from 'node:assert/strict'
import { createPerceptionTool } from '../../../../app/dsh/adapters/perception/tools.js'

const workspace = '/test/pond'
const agent = { session: { header: { cwd: workspace, agentPreset: 'chonkyfish' } } }
let enabled = true, closed = false, failure = null, state = 'stopped', reads = 0
let current = { data: null, freshness: { isFresh: false } }
let service = { getStatus: () => ({ state, enabled, capabilities: { supported: true } }), getCurrent: () => { reads++; return current } }
const resources = { paths: { workspace }, getConfig: () => ({ perception: { enabled } }) }
const { tool, when } = createPerceptionTool({ resources, getService: () => service, getFailure: () => failure, isClosed: () => closed })
const call = () => tool.execute({}, { agent })
assert.equal(tool.name, 'perception_get_owner_state')
assert.equal(when({ agent }), true)
for (const header of [{ cwd:workspace,agentPreset:'chonkyfish-social' },{ cwd:'/elsewhere',agentPreset:'chonkyfish' },{...agent.session.header,origin:'subagent'},{...agent.session.header,delegationDepth:1}]) {
  const other = { session: { header } }
  assert.equal(when({ agent: other }), false)
  assert.equal((await tool.execute({}, { agent: other })).ok, false)
}
assert.equal((await tool.execute({ start: true }, { agent })).ok, false)
assert.equal((await call()).status, 'not_enabled')
assert.equal(reads, 0)
enabled = false; assert.equal(when({ agent }), true); assert.equal((await call()).collectionState, 'disabled'); enabled = true
console.log('PASS registered owner-only tool stays available when collection is off; no autostart')
const prediction = { activity:'development',interaction:'recent_input',confidence:'medium',continuity:'sustained',analyzedAt:100,sourceThrough:99,evidence:[],windowStats:{secret:'not exposed'} }
current = { data:prediction,freshness:{isFresh:true} }
for (const [value, expected] of [['paused','paused'],['error','error'],['unsupported','unsupported'],['starting','starting'],['stale','stale'],['disposed','unavailable']]) {
  state = value; const result = await call(); assert.equal(result.status,expected); assert.equal(result.prediction,null)
}
state='running'
let result=await call();assert.equal(result.status,'ready');assert.equal(result.prediction.activity,'work');assert.equal(result.prediction.label,'工作');assert.ok(!JSON.stringify(result).includes('secret'))
assert.equal(JSON.parse(tool.output.render({},result)[0].text).prediction.activity,'work')
current.freshness.isFresh=false;assert.equal((await call()).status,'stale');assert.equal((await call()).prediction,null)
current={data:null,freshness:{isFresh:false}};assert.equal((await call()).status,'insufficient_data')
current={data:{...prediction,evidence:['insufficient_coverage']},freshness:{isFresh:true}};assert.equal((await call()).prediction,null)
console.log('PASS valid compact predictions, work label, and stale/insufficient-data safeguards')
service=null;assert.equal((await call()).status,'initializing');failure={code:'TEST'};assert.equal((await call()).status,'error')
service={getStatus(){throw new Error('/private/path')}};assert.equal((await call()).status,'error');assert.ok(!JSON.stringify(await call()).includes('/private/path'))
closed=true;assert.equal(when({agent}),false);assert.equal((await call()).status,'unavailable')
console.log('PASS initialization, unsupported, errors and disposal stay explicit and private')
console.log('Perception tools: 3 groups passed')
