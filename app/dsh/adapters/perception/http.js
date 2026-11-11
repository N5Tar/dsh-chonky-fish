import { LIMITS } from '../../../../core/contracts/spec.js'

const fail = (status, code, message = code) => ({ status, body: { ok: false, error: { code, message } } })
const invalid = () => Object.assign(new Error('请求参数无效'), { code: 'INVALID_ARGUMENT' })
const number = value => {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw invalid()
  return Number(value)
}
function checkWrite(headers) {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(headers['content-type'] || '') ||
      (headers['content-encoding'] && headers['content-encoding'] !== 'identity')) {
    throw Object.assign(new Error('需要 application/json'), { code: 'UNSUPPORTED_MEDIA_TYPE' })
  }
  if (headers['sec-fetch-site'] === 'cross-site') throw Object.assign(new Error('拒绝跨站控制请求'), { code: 'FORBIDDEN' })
  if (headers.origin) {
    let origin
    try { origin = new URL(headers.origin) } catch { throw Object.assign(new Error('来源无效'), { code: 'FORBIDDEN' }) }
    if (!headers.host || origin.host !== headers.host || !['http:', 'https:'].includes(origin.protocol)) {
      throw Object.assign(new Error('来源与宿主不匹配'), { code: 'FORBIDDEN' })
    }
  }
}
export async function handlePerceptionRequest({ service, url = '/', method = 'GET', headers = {}, body, nowMs = Date.now() }) {
  if (!['GET', 'HEAD', 'POST'].includes(method)) return fail(405, 'METHOD_NOT_ALLOWED')
  try {
    const params = new URL(url, 'http://chonkyfish.local').searchParams
    if (method === 'POST') {
      checkWrite(headers)
      if (params.size || (typeof body !== 'string' && !Buffer.isBuffer(body))) throw invalid()
      if (Buffer.byteLength(body) > LIMITS.jsonBodyBytes) return fail(413, 'LIMIT_EXCEEDED')
      let args
      try { args = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(body))) } catch { throw invalid() }
      if (!args || Array.isArray(args) || Object.keys(args).length !== 1 || !['start', 'pause', 'stop'].includes(args.action)) throw invalid()
      await service[args.action]()
      return { status: 200, body: { ok: true, state: service.getStatus().state } }
    }
    const action = params.get('action') || 'status'
    const allowed = { status: [], current: [], timeline: ['fromMs', 'toMs'], summaries: ['fromMs', 'toMs', 'cursor', 'limit'] }
    if (!Object.hasOwn(allowed, action)) throw invalid()
    const args = {}
    for (const [key, value] of params) {
      if (params.getAll(key).length !== 1 || (key !== 'action' && !allowed[action].includes(key))) throw invalid()
      if (key !== 'action') args[key === 'cursor' ? 'beforeId' : key] = number(value)
    }
    if (args.limit !== undefined && (args.limit < 1 || args.limit > 500)) throw invalid()
    if (args.beforeId !== undefined && args.beforeId < 1) throw invalid()
    if (action === 'timeline' || action === 'summaries') {
      args.toMs ??= nowMs
      args.fromMs ??= args.toMs - (action === 'timeline' ? 3600000 : 604800000)
      const maximum = action === 'timeline' ? 3600000 : 604800000
      if (args.fromMs < 0 || args.toMs > nowMs + 5000 || args.toMs <= args.fromMs || args.toMs - args.fromMs > maximum) throw invalid()
    }
    const data = action === 'status' ? service.getStatus() : action === 'current' ? service.getCurrent() :
      action === 'timeline' ? service.getTimeline(args) : service.getSummaries(args)
    return { status: 200, body: { ok: true, ...data } }
  } catch (error) {
    const statuses = { INVALID_ARGUMENT: 400, UNSUPPORTED_MEDIA_TYPE: 415, FORBIDDEN: 403, UNAVAILABLE: 503, UNSUPPORTED: 503, STORAGE_ERROR: 503, PREFERENCE_INVALID: 503, PREFERENCE_READ_FAILED: 503, PREFERENCE_WRITE_FAILED: 503, CANCELLED: 409 }
    return fail(statuses[error?.code] || 500, error?.code || 'PERCEPTION_ERROR', error?.message || '感知请求失败')
  }
}

async function readBody(request) {
  checkWrite(request.headers || {})
  const chunks = []; let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += data.length
    if (size > LIMITS.jsonBodyBytes) throw Object.assign(new Error('请求体过大'), { code: 'LIMIT_EXCEEDED' })
    chunks.push(data)
  }
  return Buffer.concat(chunks, size)
}
export function registerPerceptionRoute(ctx, { resources, getService, ready, isClosed, getFailure }) {
  return ctx.webServer.register({ kind: 'exact', path: resources.routes.perception,
    async handler(request, response) {
      let result
      try {
        await ready
        const service = getService()
        if (isClosed()) result = fail(503, 'UNAVAILABLE', '感知模块已关闭')
        else if (!service) {
          const cause = getFailure()
          result = fail(503, cause?.code || 'UNAVAILABLE', cause?.message || '感知模块初始化失败')
        } else {
          const body = request.method === 'POST' ? await readBody(request) : undefined
          result = await handlePerceptionRequest({ service, url: request.url, method: request.method, headers: request.headers, body })
        }
      } catch (error) {
        const status = { LIMIT_EXCEEDED: 413, FORBIDDEN: 403, UNSUPPORTED_MEDIA_TYPE: 415 }[error?.code] || 500
        result = fail(status, error?.code || 'PERCEPTION_ERROR', error?.message)
      }
      response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        ...(result.status === 405 ? { allow: 'GET, HEAD, POST' } : {}) })
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(result.body))
    },
  })
}
