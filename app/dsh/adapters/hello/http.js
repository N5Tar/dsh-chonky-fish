const fields = {
  'save-draft': ['expectedRevision', 'patch', 'step'],
  'apply-base': ['operationId', 'expectedRevision', 'expectedSources'],
  resume: ['operationId'],
  abandon: ['operationId', 'expectedRevision'],
  'skip-dingtalk': ['expectedRevision'],
}
export function createHelloHttpHandler({ getService, getFailure = () => null, maxBodyBytes = 131072 }) {
  return async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    const fail = (status, code) => reply(status, { ok: false, error: { code, message: code, retryable: status === 503 } })
    try {
      const service = getService()
      if (!service) return fail(503, getFailure() || 'HELLO_INITIALIZING')
      if (request.method === 'GET') {
        const url = new URL(request.url || '/', 'http://localhost')
        const action = url.searchParams.get('action')
        if (!action) return reply(200, { ok: true, data: await service.bootstrap() })
        if (action !== 'operation') return fail(400, 'HELLO_UNKNOWN_ACTION')
        return reply(200, { ok: true, data: await service.inspectOperation({ operationId: url.searchParams.get('id') }) })
      }
      if (request.method !== 'POST') return fail(405, 'HELLO_METHOD_NOT_ALLOWED')
      const headers = request.headers || {}
      if (headers['sec-fetch-site'] === 'cross-site') return fail(403, 'HELLO_CROSS_ORIGIN')
      if (headers.origin) {
        let origin
        try { origin = new URL(headers.origin) } catch { return fail(403, 'HELLO_CROSS_ORIGIN') }
        if (origin.host !== headers.host || !['http:', 'https:'].includes(origin.protocol)) return fail(403, 'HELLO_CROSS_ORIGIN')
      }
      if (!/^application\/json(?:;|$)/i.test(headers['content-type'] || '')) return fail(415, 'HELLO_JSON_REQUIRED')
      let size = 0; const chunks = []
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > maxBodyBytes) return fail(413, 'HELLO_BODY_TOO_LARGE')
        chunks.push(Buffer.from(chunk))
      }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return fail(400, 'HELLO_INVALID_JSON') }
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(fields, input.action)) return fail(400, 'HELLO_UNKNOWN_ACTION')
      if (Object.keys(input).some(key => key !== 'action' && !fields[input.action].includes(key))) return fail(400, 'HELLO_UNKNOWN_FIELD')
      const { action, ...args } = input
      const methods = { 'save-draft': 'saveDraft', 'apply-base': 'applyBase', resume: 'resume', abandon: 'abandon', 'skip-dingtalk': 'skipDingtalk' }
      return reply(200, { ok: true, data: await service[methods[action]](args) })
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'HELLO_FAILED'
      return fail(code.includes('NOT_FOUND') ? 404 : 409, code)
    }
  }
}
