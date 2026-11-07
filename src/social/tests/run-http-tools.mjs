import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createSocialTools } from '../tools.js'
import { createSocialHttpHandler } from '../http.js'

const agent = { session: { id: 'social-session', header: { agentPreset: 'chonkyfish-social' } } }
const scope = { sessionId: 'social-session', connectionId: 'main', conversation: { type: 'direct', id: 'user' } }
let live = true, sends = 0, reads = 0, views = 0
const scopeForAgent = value => live && value === agent ? scope : null
const service = {
  async inspect() { return { inferenceOnArrival: false, notices: [] } },
  async readConfig() { return { version: 1, connections: [] } },
  async listIdentityRecords() { return [] },
  async scopedIdentity() { return { protocolUserId: 'self' } },
  async scopedNotices() { return [] },
  async readBatch(value) { assert.equal(value, scope); reads++; return null },
  async send(value, args) { assert.equal(value, scope); assert.equal(args.connectionId, 'main'); assert.deepEqual(args.conversation, scope.conversation); assert.equal(args.operationId.length, 64); sends++; return { status: 'accepted' } },
}
const tools = createSocialTools({ service, scopeForAgent })
assert.equal(tools.length, 4)
for (const unbound of [undefined, { session: agent.session }, { session: { header: { agentPreset: 'ordinary' } } }]) {
  assert.equal((await tools[3].execute({ operationId: 'unbound', text: 'hi' }, { agent: unbound })).error, 'SOCIAL_TARGET_UNBOUND')
}
assert.equal((await tools[3].execute({ operationId: 'one', text: 'hi', connectionId: 'evil', conversation: { type: 'direct', id: 'evil' } }, { agent })).ok, false)
assert.equal((await tools[3].execute({ text: 'missing operation id' }, { agent })).ok, false)
assert.equal(sends, 0)
assert.equal((await tools[3].execute({ operationId: 'one', text: 'hi' }, { agent })).ok, true)
assert.equal(sends, 1)
live = false
assert.equal((await tools[3].execute({ operationId: 'two', text: 'hi' }, { agent })).ok, false)
assert.equal((await tools[3].execute({ operationId: 'two', text: 'hi' }, { agent })).error, 'SOCIAL_TARGET_UNBOUND')
assert.equal(sends, 1)

const bridge = { inspect: () => ({ available: true }), async view(args) { assert.equal(args.connectionId, 'main'); views++; return { status: 'viewed' } } }
const handler = createSocialHttpHandler({ service, bridge, maxBodyBytes: 300 })
async function request({ method = 'GET', token, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  req.method = method; req.headers = token === undefined ? {} : { 'x-chonkyfish-token': token }
  const response = { status: null, body: null, writeHead(status) { this.status = status }, end(body) { this.body = body === undefined ? undefined : JSON.parse(body) } }
  await handler(req, response)
  return response
}
assert.equal((await request({ token: 'wrong' })).status, 200)
assert.equal((await request()).status, 200)
assert.equal((await request({ method: 'HEAD' })).body, undefined)
assert.equal(views, 0)
assert.equal((await request({ method: 'POST', body: { action: 'send', text: 'no' } })).status, 409)
assert.equal((await request({ method: 'POST', body: { action: 'view', connectionId: 'main', conversation: scope.conversation, sessionId: 'owner' } })).status, 409)
assert.equal((await request({ method: 'POST', body: { action: 'view', connectionId: 'main', conversation: scope.conversation } })).status, 200)
assert.equal(views, 1)
assert.equal((await request({ method: 'POST', body: 'bad json' })).status, 409)
assert.equal((await request({ method: 'POST', body: 'x'.repeat(301) })).status, 413)
assert.equal(reads, 0)
console.log('social-http-tools: PASS (token-free management, no raw send/ack, explicit view, unbound target errors, fixed send target)')
