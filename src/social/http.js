import { publicError, keys, fail } from './core.js'

/** Local authenticated management only. No raw send/ack/agent injection endpoint. */
export function createSocialHttpHandler({ service, bridge, token, maxBodyBytes = 16384 }) {
  return async function handle(request, response) {
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(value))
    }
    if (!token || request.headers['x-chonkyfish-token'] !== token) { reply(401, { ok: false, error: 'SOCIAL_UNAUTHORIZED' }); return }
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        // 配置损坏时仍返回状态：面板要能打开、看到错误，并用一次合法保存覆盖修好。
        let config = null
        try { config = await service.readConfig() } catch {}
        reply(200, { ok: true, ...await service.inspect(), config, identities: await service.listIdentityRecords(), bridge: bridge?.inspect?.() ?? { available: false, reason: 'SOCIAL_BRIDGE_UNAVAILABLE' } })
        return
      }
      if (request.method !== 'POST') { reply(405, { ok: false, error: 'SOCIAL_METHOD_NOT_ALLOWED' }); return }
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > maxBodyBytes) { reply(413, { ok: false, error: 'SOCIAL_BODY_TOO_LARGE' }); return }
        chunks.push(chunk)
      }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('SOCIAL_INVALID_INPUT') }
      let result
      switch (input?.action) {
        case 'configure': keys(input, ['action', 'config']); result = await service.updateConfig(input.config); break
        case 'reload': keys(input, ['action']); result = await service.reload(); break
        case 'confirm_identity':
          keys(input, ['action', 'connectionId', 'expectedProtocolUserId'])
          result = await service.confirmIdentity(input); break
        case 'view':
          keys(input, ['action', 'connectionId', 'conversation'])
          if (!bridge) fail('SOCIAL_BRIDGE_UNAVAILABLE')
          result = await bridge.view({ connectionId: input.connectionId, conversation: input.conversation }); break
        default: fail('SOCIAL_UNKNOWN_ACTION')
      }
      reply(200, { ok: true, result: result ?? null })
    } catch (error) { reply(409, { ok: false, error: publicError(error) }) }
  }
}
