import { LIMITS } from '../../../../core/contracts/spec.js'

const fail = (status, code) => ({ status, body: { ok: false, error: { code } } })
const errorResult = (error) => {
  const codes = { INVALID_ARGUMENT: 400, NOT_FOUND: 404, CONFLICT: 409, UNAVAILABLE: 503, CORRUPT_STATE: 500, UNSAFE_PATH: 500, LIMIT_EXCEEDED: 413, UNSUPPORTED_MEDIA_TYPE: 415 }
  const code = Object.hasOwn(codes, error?.code || '') ? error.code : 'SKILL_STORAGE_ERROR'
  return fail(codes[code] || 500, code)
}
const invalid = (code) => { throw Object.assign(new Error(code), { code }) }
function checkContentType(headers) {
  if (typeof headers?.['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(headers['content-type'])) invalid('UNSUPPORTED_MEDIA_TYPE')
  if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') invalid('UNSUPPORTED_MEDIA_TYPE')
}
function parseBody(body) {
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) invalid('INVALID_ARGUMENT')
  if (Buffer.byteLength(body) > LIMITS.stateBodyBytes) invalid('LIMIT_EXCEEDED')
  try {
    return JSON.parse(typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch { invalid('INVALID_ARGUMENT') }
}

// Owner UI adapter. Host authentication remains unchanged; no private token.
export async function handleSkillsRequest({ service, url, method = 'GET', headers = {}, body, enabled = true }) {
  if (!['GET', 'HEAD', 'POST'].includes(method)) return fail(405, 'METHOD_NOT_ALLOWED')
  try {
    const params = new URL(url || '/', 'http://chonkyfish.local').searchParams
    if (method === 'POST') {
      checkContentType(headers)
      if ([...params].length) return fail(400, 'INVALID_ARGUMENT')
      const args = parseBody(body)
      if (!args || Array.isArray(args) || args.action !== 'import' || Object.keys(args).some(key => !['action', 'archive'].includes(key))) return fail(400, 'INVALID_ARGUMENT')
      return { status: 200, body: { ok: true, data: await service.run(args) } }
    }
    const args = { action: params.get('action') || 'list' }
    const allowed = { list: ['offset', 'limit'], read: ['skillId', 'section', 'revision', 'offset', 'limit'], history: ['skillId', 'offset', 'limit'], export: ['skillId'] }
    if (!Object.hasOwn(allowed, args.action)) return fail(400, 'INVALID_ARGUMENT')
    for (const [key, value] of params) {
      if (params.getAll(key).length !== 1 || (key !== 'action' && !allowed[args.action].includes(key))) return fail(400, 'INVALID_ARGUMENT')
      if (key === 'action') continue
      if (['revision', 'offset', 'limit'].includes(key)) {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return fail(400, 'INVALID_ARGUMENT')
        args[key] = Number(value)
      } else args[key] = value
    }
    return { status: 200, body: { ok: true, ...(args.action === 'export' ? {} : { enabled }), data: await service.run(args) } }
  } catch (error) { return errorResult(error) }
}

async function readRequestBody(request) {
  checkContentType(request.headers)
  const declared = request.headers?.['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > LIMITS.stateBodyBytes)) invalid('LIMIT_EXCEEDED')
  const chunks = []
  let length = 0
  // Do not destroy the socket on overflow: allow the structured 413 response.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > LIMITS.stateBodyBytes) invalid('LIMIT_EXCEEDED')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, length)
}

export function registerSkillsRoute(ctx, { service, resources, ready, isClosed }) {
  return ctx.webServer.register({
    kind: 'exact', path: resources.routes.skills,
    async handler(request, response) {
      let result
      try {
        try { await ready }
        catch { throw Object.assign(new Error('UNAVAILABLE'), { code: 'UNAVAILABLE' }) }
        if (isClosed()) result = fail(503, 'UNAVAILABLE')
        else {
          let body
          if (request.method === 'POST') body = await readRequestBody(request)
          result = isClosed() ? fail(503, 'UNAVAILABLE') : await handleSkillsRequest({ service, headers: request.headers, body, url: request.url, method: request.method, enabled: resources.getConfig().skills.enabled })
        }
      } catch (error) { result = errorResult(error) }
      response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(result.status === 405 ? { allow: 'GET, HEAD, POST' } : {}) })
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(result.body))
    },
  })
}
