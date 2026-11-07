// Read-only owner UI adapter. Uses exactly the same service as the model tools.
export async function handleSkillsRequest({ service, url, method = 'GET', enabled = true }) {
  const fail = (status, code) => ({ status, body: { ok: false, error: { code } } })
  if (!['GET', 'HEAD'].includes(method)) return fail(405, 'METHOD_NOT_ALLOWED')
  try {
    const params = new URL(url || '/', 'http://chonkyfish.local').searchParams
    const args = { action: params.get('action') || 'list' }
    const allowed = { list: ['offset', 'limit'], read: ['skillId', 'section', 'revision', 'offset', 'limit'], history: ['skillId', 'offset', 'limit'] }
    if (!Object.hasOwn(allowed, args.action)) return fail(400, 'INVALID_ARGUMENT')
    for (const [key, value] of params) {
      if (params.getAll(key).length !== 1 || (key !== 'action' && !allowed[args.action].includes(key))) return fail(400, 'INVALID_ARGUMENT')
      if (key === 'action') continue
      if (['revision', 'offset', 'limit'].includes(key)) {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return fail(400, 'INVALID_ARGUMENT')
        args[key] = Number(value)
      } else args[key] = value
    }
    return { status: 200, body: { ok: true, enabled, data: await service.run(args) } }
  } catch (error) {
    const codes = { INVALID_ARGUMENT: 400, NOT_FOUND: 404, CORRUPT_STATE: 500, UNSAFE_PATH: 500, LIMIT_EXCEEDED: 400 }
    const code = Object.hasOwn(codes, error?.code || '') ? error.code : 'SKILL_STORAGE_ERROR'
    return fail(codes[code] || 500, code)
  }
}

export function registerSkillsRoute(ctx, { service, resources, ready, isClosed }) {
  return ctx.webServer.register({
    kind: 'exact', path: resources.routes.skills,
    async handler(request, response) {
      let result
      try {
        await ready
        result = isClosed() ? { status: 503, body: { ok: false, error: { code: 'UNAVAILABLE' } } }
          : await handleSkillsRequest({ service, headers: request.headers, url: request.url, method: request.method, enabled: resources.getConfig().skills.enabled })
      } catch { result = { status: 503, body: { ok: false, error: { code: 'UNAVAILABLE' } } } }
      response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(result.status === 405 ? { allow: 'GET, HEAD' } : {}) })
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(result.body))
    },
  })
}
