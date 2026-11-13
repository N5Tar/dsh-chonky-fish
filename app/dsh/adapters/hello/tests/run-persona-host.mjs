import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PANEL_PROMPT } from '../../../../../core/contracts/spec.js'
import { apply } from '../../../host/index.js'
const home = await mkdtemp(join(tmpdir(), 'hello-persona-host-'))
const priorHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const routes = new Map(), listeners = new Map(), guards = [], effects = [], grants = [], contexts = []
const expected = ['/chonkyfish/social', '/chonkyfish/diary', '/chonkyfish/events', '/chonkyfish/proactive']
let readyResolve
const ready = new Promise(resolve => { readyResolve = resolve })
const tools = new Map(), variables = new Map()
const ctx = {
  logger: { warn() {}, info() {} },
  get() { return undefined },
  on(name, handler) { const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); return () => {} },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose },
  agents: { list() { return [] } },
  agentPresets: { composedPreset() { return 'chonkyfish' } },
  permissionPresets: { set(session, preset) { grants.push({ session, preset }) } },
  systemPrompt: { variable(name, provider) { variables.set(name, provider); return () => variables.delete(name) }, context(value) { contexts.push(value); return () => {} } },
  tools: {
    guard(fn) { guards.push(fn); return () => { const i = guards.indexOf(fn); if (i >= 0) guards.splice(i, 1) } },
    register(tool, options = {}) { tools.set(tool.name, { ...tool, options }); return () => tools.delete(tool.name) },
  },
  connection: { requestRejection() { return undefined } },
  webServer: { register(route) {
    routes.set(route.path, route)
    if (expected.every(path => routes.has(path))) readyResolve()
    return () => routes.delete(route.path)
  } },
}

const request = (path, method, body) => new Promise(resolve => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); Object.assign(req,{method,url:path,headers:{host:'localhost','content-type':'application/json'}})
  routes.get(path).handler(req,{writeHead(status){this.status=status},end(body){resolve({status:this.status,body:body?JSON.parse(body):null})}})
})
try {
 apply(ctx)
 let boot
 for(let i=0;i<100;i++){boot=await request('/chonkyfish/hello','GET');if(boot.status===200)break;await new Promise(r=>setTimeout(r,20))}
 assert.equal(boot.status,200)
 assert.equal(boot.body.data.preset?.body ?? boot.body.data.state.draft.prompt,DEFAULT_PANEL_PROMPT)
 assert.equal(variables.get('chonkyfish_supplement')(),'','new installation uses static main preset')
 assert.equal(variables.has('chonkyfish_persona'),false)
 const patch=await readFile(new URL('../../../packaging/cordis.patch.yml',import.meta.url),'utf8')
 assert.ok(patch.includes('{{chonkyfish_supplement}}'))
 assert.ok(!patch.includes('{{chonkyfish_persona}}'))
 // Saving the default through the existing panel path keeps the static base persona.
 await request('/chonkyfish/state','PUT',{generation:0,state:{prompt:DEFAULT_PANEL_PROMPT}})
 assert.equal(variables.get('chonkyfish_supplement')(),'')
 // Another clean installation exercises a custom first-use supplement via Hello.
 for(const dispose of effects.splice(0).reverse())await dispose()
 process.env.DSH_HOME=await mkdtemp(join(tmpdir(),'hello-custom-persona-'))
 apply(ctx)
 for(let i=0;i<100;i++){boot=await request('/chonkyfish/hello','GET');if(boot.status===200)break;await new Promise(r=>setTimeout(r,20))}
 assert.equal(boot.status,200)
 const custom='请用简洁中文交流，记住我们正在一起学习。'
 let saved=await request('/chonkyfish/hello','POST',{action:'save-draft',expectedRevision:boot.body.data.state.revision,patch:{prompt:custom,perceptionRequested:false}})
 assert.equal(saved.status,200)
 boot=await request('/chonkyfish/hello','GET')
 const result=await request('/chonkyfish/hello','POST',{action:'apply-base',operationId:'persona-new',expectedRevision:boot.body.data.state.revision,expectedSources:boot.body.data.expectedSources})
 assert.equal(result.body.data.status,'completed',JSON.stringify(result))
 assert.ok(variables.get('chonkyfish_supplement')().includes(custom),'existing supplement provider reads saved newcomer prompt')
 boot=await request('/chonkyfish/hello','GET')
 const blocked=await request('/chonkyfish/hello','POST',{action:'save-draft',expectedRevision:boot.body.data.state.revision,patch:{prompt:'REPLACE EXISTING'}})
 assert.equal(blocked.status,409,JSON.stringify(blocked))
 assert.equal((await request('/chonkyfish/state','GET')).body.state.prompt,custom)
 assert.ok(variables.get('chonkyfish_supplement')().includes(custom))
 console.log('hello persona Host: PASS (static default, existing supplement provider, custom newcomer prompt, existing prompt protected)')
} finally {
 for(const dispose of effects.reverse())await dispose()
 if(priorHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=priorHome
}
