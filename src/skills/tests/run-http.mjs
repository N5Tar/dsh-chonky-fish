import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createSkillService } from '../core.js'
import { handleSkillsRequest, registerSkillsRoute } from '../http.js'
const parent = await realpath(tmpdir())
const root = await mkdtemp(join(parent, 'fish-skills-http-'))
const service = createSkillService({ directory: root })
const token = 'test-owner'
const headers = { 'x-chonkyfish-token': token }
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name) }
const run = (url, extra = {}) => handleSkillsRequest({ service, token, headers, url, ...extra })
try {
  await test('no credentials required and legacy headers are ignored', async () => {
    assert.equal((await handleSkillsRequest({ service, url: '/' })).status, 200)
    assert.equal((await run('/', { headers: {} })).status, 200)
    assert.equal((await run('/', { token: '', headers: { 'x-chonkyfish-token': 'obsolete' } })).status, 200)
  })
  await test('read-only adapter rejects mutations and duplicate/unknown parameters', async () => {
    assert.equal((await run('/', { method: 'POST' })).status, 405)
    for (const query of ['action=revise', 'action=list&content=x', 'action=list&action=read', 'limit=1.2', 'offset=-1', 'limit=', 'limit=1000']) assert.equal((await run('/?' + query)).status, 400)
  })
  await test('list and read equal model service results', async () => {
    const list = await run('/?action=list')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.data, await service.run({ action: 'list' }))
    assert.equal(list.body.enabled, true)
    const response = await run('/?action=read&skillId=homepage-operations&limit=8000')
    assert.deepEqual(response.body.data, await service.run({ action: 'read', skillId: 'homepage-operations', limit: 8000 }))
    assert.match(response.body.data.content, /mingyue.novak.wang/)
    assert.equal((await run('/?action=read&skillId=missing')).status, 404)
  })
  await test('disabled tools do not hide read-only library', async () => {
    const response = await run('/', { enabled: false })
    assert.equal(response.status, 200); assert.equal(response.body.enabled, false)
  })
  await test('history and observations reflect tool-side updates', async () => {
    await service.run({ action: 'record', skillId: 'homepage-operations', claim: '<script>not executable</script>' })
    const experiences = await run('/?action=read&skillId=homepage-operations&section=experiences')
    assert.equal(experiences.body.data.items[0].claim, '<script>not executable</script>')
    const history = await run('/?action=history&skillId=homepage-operations')
    assert.equal(history.body.data.total, 2)
    assert.equal((await run('/?action=read&skillId=homepage-operations&section=experiences&revision=1')).body.data.total, 0)
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
    await route.handler({ headers, url: route.path, method: 'POST' }, res)
    assert.equal(status, 405); assert.equal(responseHeaders.allow, 'GET, HEAD')
    closed = true
    await route.handler({ headers, url: route.path, method: 'GET' }, res)
    assert.equal(status, 503)
    dispose(); assert.equal(disposed, true)
  })
  await test('built panel registers its own sidebar/main key and safe text rendering', async () => {
    const build = await readFile(new URL('../../../build.mjs', import.meta.url), 'utf8')
    const panel = await readFile(new URL('../panel.js', import.meta.url), 'utf8')
    const client = await readFile(new URL('../../../client.js', import.meta.url), 'utf8')
    assert.match(build, /id: 'chonkyfish-skills'/)
    assert.match(build, /panel.view === 'skills' \? createSkillsPage\(t\)/)
    assert.match(client, /navSkills: '技能'/)
    assert.match(client, /\/chonkyfish\/skills/)
    assert.doesNotMatch(panel, /innerHTML|dangerouslySetInnerHTML|document\.body|setInterval/)
    assert.match(panel, /controller.abort\(\)/)
    assert.match(panel, /revision: view.tab === 'history' \? undefined : detail.revision/)
    assert.match(panel, /prefers|@media/)
  })
  console.log(`PASS ${passed} skills HTTP/panel checks`)
} finally {
  assert.equal(dirname(root), parent)
  assert.ok(root.startsWith(join(parent, 'fish-skills-http-')))
  await rm(root, { recursive: true, force: true })
}
