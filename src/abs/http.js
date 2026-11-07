import { updateState } from './core.js'
import { sanitizeAbsConfig } from './config.js'
import { validateTimeScale } from './clock.js'
import { renderSelfReview } from './review.js'

export function createAbsHttpHandler({ service, resources, token, maxBodyBytes = 16384 }) {
  return async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body))
    }
    if (!token || request.headers['x-chonkyfish-token'] !== token) return reply(401, { ok: false, error: 'ABS_UNAUTHORIZED' })
    try {
      if (['GET', 'HEAD'].includes(request.method)) {
        return reply(200, { ok: true, state: service.inspect(), environment: await service.environment(), records: await service.records(100) })
      }
      if (request.method !== 'POST') return reply(405, { ok: false, error: 'ABS_METHOD_NOT_ALLOWED' })
      let bytes = 0
      const chunks = []
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > maxBodyBytes) return reply(413, { ok: false, error: 'ABS_BODY_TOO_LARGE' })
        chunks.push(Buffer.from(chunk))
      }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(400, { ok: false, error: 'ABS_INVALID_JSON' }) }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return reply(400, { ok: false, error: 'ABS_INVALID_INPUT' })
      let result
      switch (input.action) {
        case 'wake':
          if (Object.keys(input).some((key) => key !== 'action')) throw new Error('ABS_UNKNOWN_FIELD')
          result = await service.wake('manual')
          break
        case 'preview':
          if (Object.keys(input).some((key) => key !== 'action')) throw new Error('ABS_UNKNOWN_FIELD')
          result = service.preview()
          break
        case 'time-scale':
          if (Object.keys(input).some((key) => !['action', 'timeScale'].includes(key))) throw new Error('ABS_UNKNOWN_FIELD')
          validateTimeScale(input.timeScale)
          await resources.updateConfig({ abs: { timeScale: input.timeScale } })
          result = await service.syncClock()
          break
        case 'mode':
          if (Object.keys(input).some((key) => !['action', 'mode', 'confirmActive'].includes(key))) throw new Error('ABS_UNKNOWN_FIELD')
          if (!['off', 'shadow', 'active'].includes(input.mode)) throw new Error('ABS_INVALID_MODE')
          if (input.mode === 'active' && input.confirmActive !== true) throw new Error('ABS_ACTIVE_CONFIRMATION_REQUIRED')
          await resources.updateConfig({ abs: { mode: input.mode } })
          result = await service.wake('transition')
          break
        case 'replay': {
          if (Object.keys(input).some((key) => !['action', 'hours'].includes(key))) throw new Error('ABS_UNKNOWN_FIELD')
          if (typeof input.hours !== 'number' || !Number.isFinite(input.hours) || input.hours < 0 || input.hours > 720) throw new Error('ABS_INVALID_REPLAY_HOURS')
          const snapshot = service.inspect(), config = sanitizeAbsConfig(snapshot.config)
          const at = new Date(Date.parse(snapshot.clockView?.virtualNow ?? snapshot.updatedAt) + input.hours * 3600000).toISOString()
          // Isolated deterministic projection: no delivery, no model, no tool call.
          updateState(snapshot, at, config)
          result = {
            isolated: true,
            at,
            drives: snapshot.drives,
            review: renderSelfReview({ state: snapshot }),
          }
          break
        }
        case 'export':
          if (Object.keys(input).some((key) => key !== 'action')) throw new Error('ABS_UNKNOWN_FIELD')
          result = {
            format: 'jsonl',
            scope: 'recent-bounded-audit',
            content: (await service.records(1000)).map((row) => JSON.stringify(row)).join('\n') + '\n',
          }
          break
        default:
          return reply(400, { ok: false, error: 'ABS_UNKNOWN_ACTION' })
      }
      reply(200, { ok: true, result })
    } catch (error) { reply(409, { ok: false, error: String(error.message ?? error) }) }
  }
}
