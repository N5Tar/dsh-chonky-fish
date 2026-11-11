import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createSkillService, SKILL_LIMITS } from '../core.js'
import { createSkillFileStorage } from '../../../../app/shared/storage/skills-file.js'
import { LIMITS } from '../../../contracts/spec.js'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { handleSkillsRequest, registerSkillsRoute } from '../../../../app/dsh/adapters/skills/http.js'
const parent = await realpath(tmpdir())
const root = await mkdtemp(join(parent, 'fish-skills-http-'))
const service = createSkillService({ storage: createSkillFileStorage({ directory: root }) })
const token = 'test-owner'
const headers = { 'x-chonkyfish-token': token }
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name) }
const run = (url, extra = {}) => handleSkillsRequest({ service, token, headers, url, ...extra })
try {
  await service.run({ action: 'create', skillId: 'demo-skill', title: '演示技能', description: '演示用测试技能', guide: '# 演示\n这是 HTTP 测试指南。\n' })
  await test('no credentials required and legacy headers are ignored', async () => {
    assert.equal((await handleSkillsRequest({ service, url: '/' })).status, 200)
    assert.equal((await run('/', { headers: {} })).status, 200)
    assert.equal((await run('/', { token: '', headers: { 'x-chonkyfish-token': 'obsolete' } })).status, 200)
  })
  await test('adapter rejects unsupported methods and duplicate/unknown parameters', async () => {
    assert.equal((await run('/', { method: 'PUT' })).status, 405)
    assert.equal((await run('/', { method: 'POST' })).status, 415)
    for (const query of ['action=revise', 'action=list&content=x', 'action=list&action=read', 'limit=1.2', 'offset=-1', 'limit=', 'limit=1000']) assert.equal((await run('/?' + query)).status, 400)
  })
  await test('list and read equal model service results', async () => {
    const list = await run('/?action=list')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.data, await service.run({ action: 'list' }))
    assert.equal(list.body.enabled, true)
    const response = await run('/?action=read&skillId=demo-skill&limit=8000')
    assert.deepEqual(response.body.data, await service.run({ action: 'read', skillId: 'demo-skill', limit: 8000 }))
    assert.equal(response.body.data.content, '# 演示\n这是 HTTP 测试指南。\n')
    assert.equal((await run('/?action=read&skillId=missing')).status, 404)
  })
  await test('disabled tools do not hide read-only library', async () => {
    const response = await run('/', { enabled: false })
    assert.equal(response.status, 200); assert.equal(response.body.enabled, false)
  })
  await test('history and observations reflect tool-side updates', async () => {
    await service.run({ action: 'record', skillId: 'demo-skill', claim: '<script>not executable</script>' })
    const experiences = await run('/?action=read&skillId=demo-skill&section=experiences')
    assert.equal(experiences.body.data.items[0].claim, '<script>not executable</script>')
    const history = await run('/?action=history&skillId=demo-skill')
    assert.equal(history.body.data.total, 2)
    assert.equal((await run('/?action=read&skillId=demo-skill&section=experiences&revision=1')).body.data.total, 0)
  })
  await test('unexpected errors do not reveal filesystem paths', async () => {
    const response = await run('/', { service: { run() { throw new Error('/private/secret') } } })
    assert.equal(response.status, 500); assert.doesNotMatch(JSON.stringify(response), /private/)
  })
  await test('registered route supports HEAD, no-store, disposal and closure', async () => {
    let route, disposed = false, closed = false
    const ctx = { webServer: { register(value) { route = value; return () => { disposed = true } } } }
    const dispose = registerSkillsRoute(ctx, { service, token, ready: Promise.resolve(), isClosed: () => closed, resources: { routes: { skills: '/chonkyfish/skills' }, getConfig: () => ({ skills: { enabled: true } }) } })
    let status, responseHeaders, body
    const res = { writeHead(s, h) { status = s; responseHeaders = h }, end(value) { body = value } }
    await route.handler({ headers, url: route.path, method: 'HEAD' }, res)
    assert.equal(status, 200); assert.equal(body, undefined); assert.equal(responseHeaders['cache-control'], 'no-store')
    await route.handler({ headers, url: route.path, method: 'PUT' }, res)
    assert.equal(status, 405); assert.equal(responseHeaders.allow, 'GET, HEAD, POST')
    closed = true
    await route.handler({ headers, url: route.path, method: 'GET' }, res)
    assert.equal(status, 503)
    dispose(); assert.equal(disposed, true)
  })
  await test('HTTP export/import shares exact archives and refuses duplicate IDs', async () => {
    const exported = await run('/?action=export&skillId=demo-skill')
    assert.deepEqual(exported.body, { ok: true, data: await service.run({ action: 'export', skillId: 'demo-skill' }) })
    const archive = { ...exported.body.data, skillId: 'imported-skill' }
    const payload = { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ action: 'import', archive }) }
    const imported = await run('/', payload)
    assert.equal(imported.status, 200)
    assert.equal(imported.body.data.skillId, 'imported-skill')
    assert.deepEqual((await run('/?action=export&skillId=imported-skill')).body.data, archive)
    assert.equal((await run('/', payload)).status, 409)
    assert.equal((await run('/?action=import', payload)).status, 400)
    for (const body of ['{', 'null', '[]', JSON.stringify({ action: 'create', archive }), JSON.stringify({ action: 'import', archive, overwrite: true }), JSON.stringify({ action: 'import', archive: { ...archive, format: 100 } })]) {
      assert.equal((await run('/', { ...payload, body })).status, 400)
    }
    assert.equal((await run('/', { ...payload, headers: { 'content-type': 'text/plain' } })).status, 415)
    assert.equal((await run('/', { ...payload, body: Buffer.from([0xff]) })).status, 400)
    assert.equal((await run('/', { ...payload, body: ' '.repeat(LIMITS.stateBodyBytes + 1) })).status, 413)
    assert.equal((await run('/', { ...payload, body: JSON.stringify({ action: 'import', archive: { ...archive, guide: 'x'.repeat(SKILL_LIMITS.maxFileBytes) } }) })).status, 413)
  })
  await test('registered HTTP server bounds streamed bodies and keeps host route registration', async () => {
    let route
    registerSkillsRoute({ webServer: { register(value) { route = value; return () => {} } } }, { service, ready: Promise.resolve(), isClosed: () => false, resources: { routes: { skills: '/chonkyfish/skills' }, getConfig: () => ({ skills: { enabled: true } }) } })
    assert.deepEqual(Object.keys(route).sort(), ['handler', 'kind', 'path'])
    const server = createServer(route.handler)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${server.address().port}/chonkyfish/skills`
      const archive = { ...(await service.run({ action: 'export', skillId: 'demo-skill' })), skillId: 'stream-import' }
      let response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import', archive }) })
      assert.equal(response.status, 200)
      assert.equal((await response.json()).data.skillId, 'stream-import')
      response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import', archive }) })
      assert.equal(response.status, 409)
      assert.equal((await response.json()).error.code, 'CONFLICT')
      // Mock a chunked IncomingMessage to exercise streaming overflow without a length header.
      const request = Readable.from([Buffer.alloc(LIMITS.stateBodyBytes), Buffer.from('x')])
      Object.assign(request, { method: 'POST', headers: { 'content-type': 'application/json' }, url: route.path })
      let status, body
      await route.handler(request, { writeHead(value) { status = value }, end(value) { body = value } })
      assert.equal(status, 413)
      assert.equal(JSON.parse(body).error.code, 'LIMIT_EXCEEDED')
      request.destroy()
      assert.equal((await service.run({ action: 'list' })).total, 3)
    } finally { await new Promise(resolve => server.close(resolve)) }
  })
  await test('built panel registers its own sidebar/main key and safe text rendering', async () => {
    const build = await readFile(new URL('../../../../app/dsh/build.mjs', import.meta.url), 'utf8')
    const panel = await readFile(new URL('../../../../app/dsh/ui/skills/panel.js', import.meta.url), 'utf8')
    const client = await readFile(new URL('../../../../client.js', import.meta.url), 'utf8')
    assert.match(build, /id: 'chonkyfish-skills'/)
    assert.match(build, /panel.view === 'skills' \? createSafeSkillsPage\(t\)/)
    assert.match(client, /navSkills: '技能'/)
    assert.match(client, /\/chonkyfish\/skills/)
    assert.doesNotMatch(panel, /innerHTML|dangerouslySetInnerHTML|setInterval/)
    assert.match(panel, /anchor.remove\(\)/)
    assert.match(panel, /URL.revokeObjectURL\(url\)/)
    assert.match(panel, /controller.abort\(\)/)
    assert.match(panel, /revision: view.tab === 'history' \? undefined : detail.revision/)
    assert.match(panel, /@container\(max-width:640px\)/)
    assert.match(panel, /@container\(max-width:850px\)/)
  })
  console.log(`PASS ${passed} skills HTTP/panel checks`)
} finally {
  assert.equal(dirname(root), parent)
  assert.ok(root.startsWith(join(parent, 'fish-skills-http-')))
  await rm(root, { recursive: true, force: true })
}
