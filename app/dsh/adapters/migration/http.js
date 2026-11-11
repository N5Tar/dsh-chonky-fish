import { LIMITS } from '../../../../core/contracts/spec.js'

const codes = { INVALID_ARCHIVE: 400, UNSUPPORTED_VERSION: 409, LIMIT_EXCEEDED: 413, UNSAFE_PATH: 400, INVALID_DATA: 400, MIGRATION_BUSY: 409, STALE_TARGET: 409, BACKUP_FAILED: 500, IMPORT_FAILED: 500, RECOVERY_REQUIRED: 503, NOT_FOUND: 404 }
const resultError = error => ({ status: codes[error?.code] || 500, body: { ok: false, error: { code: codes[error?.code] ? error.code : 'MIGRATION_FAILED' } } })
function authorize(request, response, connection) {
  const rejection = connection.requestRejection(request)
  if (rejection === undefined) return true
  send(response, rejection, { ok: false, error: { code: rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' } })
  return false
}
async function body(request, max) {
  const declared = request.headers?.['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > max)) throw Object.assign(new Error(), { code: 'LIMIT_EXCEEDED' })
  const chunks = []; let length = 0
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    length += chunk.length
    if (length > max) throw Object.assign(new Error(), { code: 'LIMIT_EXCEEDED' })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}
function send(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(data))
}
async function jsonBody(req, max = 4096) {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error(), { code: 'UNSUPPORTED_MEDIA_TYPE' })
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await body(req, max))) } catch (error) { if (error.code) throw error; throw Object.assign(new Error(), { code: 'INVALID_DATA' }) }
}

export function registerMigrationRoutes(ctx, { service, resources, ready, isClosed }) {
  const routes = resources.routes
  const connection = ctx.connection
  if (!connection || typeof connection.requestRejection !== 'function') throw new Error('DSH Connection request authentication is required for migration routes')
  const regs = []
  regs.push(ctx.webServer.register({ kind: 'exact', path: routes.migrationExport, handler: async (req, res) => {
    if (!authorize(req, res, connection)) return
    try {
      await ready
      if (isClosed()) return send(res, 503, { ok: false, error: { code: 'UNAVAILABLE' } })
      if (req.method === 'POST') {
        const out = await service.prepareExport(); return send(res, 200, { ok: true, data: out })
      }
      if (req.method === 'GET') {
        const id = new URL(req.url, 'http://local').searchParams.get('id')
        const archive = await service.download(id)
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="chonkyfish.fishpack"', 'content-length': archive.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        return res.end(archive)
      }
      return send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    } catch (e) { const out = resultError(e); send(res, out.status, out.body) }
  } }))
  regs.push(ctx.webServer.register({ kind: 'exact', path: routes.migrationImportInspect, handler: async (req, res) => {
    if (!authorize(req, res, connection)) return
    try {
      await ready
      if (isClosed()) return send(res, 503, { ok: false, error: { code: 'UNAVAILABLE' } })
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
      if (req.headers['content-type'] !== 'application/zip' && req.headers['content-type'] !== 'application/octet-stream') return send(res, 415, { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE' } })
      const data = await body(req, LIMITS.migrationArchiveBytes)
      return send(res, 200, { ok: true, data: await service.inspect(data) })
    } catch (e) { const out = resultError(e); send(res, out.status, out.body) }
  } }))
  regs.push(ctx.webServer.register({ kind: 'exact', path: routes.migrationImportCommit, handler: async (req, res) => {
    if (!authorize(req, res, connection)) return
    try {
      await ready
      if (isClosed()) return send(res, 503, { ok: false, error: { code: 'UNAVAILABLE' } })
      if (req.method === 'GET') {
        return send(res, 200, { ok: true, data: await service.status(new URL(req.url, 'http://local').searchParams.get('id')) })
      }
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
      const payload = await jsonBody(req)
      if (!payload || typeof payload.id !== 'string' || Object.keys(payload).some(key => key !== 'id')) return send(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT' } })
      return send(res, 200, { ok: true, data: await service.commit(payload.id) })
    } catch (e) { const out = resultError(e); send(res, out.status, out.body) }
  } }))
  regs.push(ctx.webServer.register({ kind: 'exact', path: routes.migrationImportCancel, handler: async (req, res) => {
    if (!authorize(req, res, connection)) return
    try {
      await ready
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
      const payload = await jsonBody(req)
      if (!payload || typeof payload.id !== 'string' || Object.keys(payload).some(key => key !== 'id')) return send(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT' } })
      return send(res, 200, { ok: true, data: await service.cancel(payload.id) })
    } catch (e) { const out = resultError(e); send(res, out.status, out.body) }
  } }))
  regs.push(ctx.webServer.register({ kind: 'exact', path: routes.migrationStatus, handler: async (req, res) => {
    if (!authorize(req, res, connection)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    try { await ready; const id = new URL(req.url, 'http://local').searchParams.get('id'); const out = await service.status(id); return send(res, 200, { ok: true, data: out }) }
    catch (e) { const out = resultError(e); send(res, out.status, out.body) }
  } }))
  return () => regs.reverse().forEach(dispose => { try { dispose() } catch {} })
}
