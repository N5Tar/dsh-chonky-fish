import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../../host/index.js'
const home = await mkdtemp(join(tmpdir(), 'hello-host-'))
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
 assert.equal(boot.status,200,JSON.stringify(boot))
 assert.equal(boot.body.data.state.entryKind,'new')
 assert.equal(variables.has('chonkyfish_persona'),false,'no new persona provider')
 const writes=await Promise.all([request('/chonkyfish/state','PUT',{generation:0,state:{name:'first',prompt:'keep existing',wallet:99}}),request('/chonkyfish/state','PUT',{generation:0,state:{name:'second'}})])
 assert.deepEqual(writes.map(r=>r.status).sort(),[204,409])
 const panel=(await request('/chonkyfish/state','GET')).body
 assert.equal(panel.generation,1);assert.equal(panel.state.wallet,99)
 boot=await request('/chonkyfish/hello','GET')
 const saved=await request('/chonkyfish/hello','POST',{action:'save-draft',expectedRevision:boot.body.data.state.revision,patch:{name:'hello',prompt:'keep existing',perceptionRequested:false}})
 assert.equal(saved.status,200,JSON.stringify(saved))
 boot=await request('/chonkyfish/hello','GET')
 const applied=await request('/chonkyfish/hello','POST',{action:'apply-base',operationId:'host-test',expectedRevision:boot.body.data.state.revision,expectedSources:boot.body.data.expectedSources})
 assert.equal(applied.status,200,JSON.stringify(applied))
 assert.equal(applied.body.data.status,'completed',JSON.stringify(applied))
 const final=(await request('/chonkyfish/state','GET')).body
 assert.equal(final.state.prompt,'keep existing'); assert.equal(final.state.wallet,99);assert.equal(final.state.name,'hello')
 assert.equal((await request('/chonkyfish/hello','GET')).body.data.current.abs.mode,'shadow')
 console.log('hello Host: PASS (bootstrap, old-state concurrent CAS, existing persona/wallet preservation, base apply, unchanged ABS mode)')
} finally {
 for(const dispose of effects.reverse())await dispose()
 if(priorHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=priorHome
}
