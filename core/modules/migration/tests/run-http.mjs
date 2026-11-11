import assert from 'node:assert/strict'
import { registerMigrationRoutes } from '../../../../app/dsh/adapters/migration/http.js'

const handlers = new Map()
const routes = {
  migrationExport: '/export', migrationImportInspect: '/inspect', migrationImportCommit: '/commit',
  migrationImportCancel: '/cancel', migrationStatus: '/status',
}
const bridgeCookie = 'dsh-auth-loopback=desktop-session'
const connectionRequests = []
const connection = {
  requestRejection(request) {
    connectionRequests.push(request)
    const origin = request.headers?.origin
    if (origin && origin !== 'http://127.0.0.1:61509') return 403
    return request.headers?.cookie === bridgeCookie ? undefined : 401
  },
}
const ctx = {
  connection,
  webServer: { register(route) { handlers.set(route.path, route.handler); return () => handlers.delete(route.path) } },
}
const resources = { routes, limits: { migrationArchiveBytes: 1024 } }
const service = {
  async prepareExport() { return { exportId: 'test-id', bytes: 3 } },
  async download() { return Buffer.from('zip') },
  async inspect() { return { importId: 'test-import' } },
  async commit() { return { state: 'committed' } },
  async cancel() { return { cancelled: true } },
  async status() { return { state: 'ready' } },
}
registerMigrationRoutes(ctx, { service, resources, ready: Promise.resolve(), isClosed: () => false })
function response() {
  const headers = new Map()
  return {
    headers,
    status: 0,
    body: '',
    writeHead(status, values = {}) { this.status = status; for (const [k, v] of Object.entries(values)) headers.set(k.toLowerCase(), v) },
    end(value = '') { this.body = Buffer.isBuffer(value) ? value : String(value) },
  }
}
function request(method, path, headers = {}) {
  return { method, url: path, headers: { host: '127.0.0.1:61509', ...headers }, async *iterator() {} }
}

// DSH Desktop's forwarder removes Origin and Fetch Metadata, then adds its
// authenticated Host cookie. The route must accept that exact trusted shape.
let res = response()
const bridged = request('POST', '/export', { cookie: bridgeCookie })
await handlers.get('/export')(bridged, res)
assert.equal(res.status, 200)
assert.equal(JSON.parse(res.body).data.exportId, 'test-id')
assert.equal(connectionRequests.at(-1), bridged)
assert.equal('origin' in bridged.headers, false)
assert.equal('sec-fetch-site' in bridged.headers, false)

res = response()
await handlers.get('/export')(request('GET', '/export?id=test-id', { cookie: bridgeCookie }), res)
assert.equal(res.status, 200)
assert.equal(res.headers.get('content-type'), 'application/zip')
assert.equal(res.body.toString(), 'zip')

res = response()
await handlers.get('/export')(request('POST', '/export'), res)
assert.equal(res.status, 401)
assert.equal(JSON.parse(res.body).error.code, 'UNAUTHORIZED')

res = response()
await handlers.get('/export')(request('POST', '/export', {
  cookie: bridgeCookie, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site',
}), res)
assert.equal(res.status, 403)
assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN')

console.log('migration HTTP DSH Desktop authenticated-bridge tests passed')
