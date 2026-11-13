import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createHelloHttpHandler } from '../http.js'
let calls = 0
const service = { bootstrap: () => ({ ready: true }), saveDraft: input => { calls++; return input }, inspectOperation: ({ operationId }) => ({ id: operationId }), abandon: input => input }
const handler = createHelloHttpHandler({ getService: () => service, maxBodyBytes: 200 })
const request = (method, body, headers = {}, url = '/') => new Promise(resolve => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]); Object.assign(req, { method, headers: { host: 'localhost:1234', 'content-type': 'application/json', ...headers }, url })
  handler(req, { writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { resolve({ status: this.status, headers: this.headers, body: JSON.parse(body) }) } })
})
assert.equal((await request('GET')).body.data.ready, true)
assert.equal((await request('GET', undefined, {}, '/?action=operation&id=abc')).body.data.id, 'abc')
assert.equal((await request('POST', { action: 'save-draft', expectedRevision: 0, patch: {} }, { origin: 'http://localhost:1234' })).status, 200)
assert.equal((await request('POST', { action: 'save-draft', patch: {} }, { origin: 'https://evil.example' })).status, 403)
assert.equal((await request('POST', { action: 'save-draft', patch: {} }, { 'sec-fetch-site': 'cross-site' })).status, 403)
assert.equal((await request('POST', { action: 'save-draft', mode: 'active' })).status, 400)
assert.equal((await request('POST', '{}', { 'content-type': 'text/plain' })).status, 415)
assert.equal((await request('POST', 'x'.repeat(201))).status, 413)
assert.equal((await request('POST', { action: 'abandon', expectedRevision: 1, operationId: 'abc' })).status, 200)
assert.equal(calls, 1)
console.log('hello HTTP: PASS (origin, MIME, size, whitelist, operation, abandon)')
