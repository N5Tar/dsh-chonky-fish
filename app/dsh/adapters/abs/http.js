import { updateState } from '../../../../core/modules/abs/core.js'
import { sanitizeAbsConfig } from '../../../../core/modules/abs/config.js'
import { validateTimeScale } from '../../../../core/modules/abs/clock.js'
import { validRestTime } from '../../../../core/modules/abs/rest.js'

export function createAbsHttpHandler({ service, resources, maxBodyBytes = 16384 }) {
  return async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body))
    }
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
        case 'time-scale':
          if (Object.keys(input).some((key) => !['action', 'timeScale'].includes(key))) throw new Error('ABS_UNKNOWN_FIELD')
          validateTimeScale(input.timeScale)
          await resources.updateConfig({ abs: { timeScale: input.timeScale } })
          result = await service.syncClock()
          break
        case 'rest-hours':
          if (Object.keys(input).some((key) => !['action', 'enabled', 'start', 'end'].includes(key))) throw new Error('ABS_UNKNOWN_FIELD')
          if (typeof input.enabled !== 'boolean' || !validRestTime(input.start) || !validRestTime(input.end) || input.start === input.end) throw new Error('ABS_INVALID_REST_HOURS')
          await resources.updateConfig({ abs: { restHours: { enabled: input.enabled, start: input.start, end: input.end } } })
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
        case 'pacing': {
          const allowed = ['action', 'reviewIntervalMinutes', 'reviewMinRealGapMinutes', 'actionPolicy']
          if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('ABS_UNKNOWN_FIELD')
          const patch = {}
          if ('reviewIntervalMinutes' in input) patch.reviewIntervalMinutes = input.reviewIntervalMinutes
          if ('reviewMinRealGapMinutes' in input) patch.reviewMinRealGapMinutes = input.reviewMinRealGapMinutes
          if ('actionPolicy' in input) {
            if (!input.actionPolicy || typeof input.actionPolicy !== 'object' || Array.isArray(input.actionPolicy)) throw new Error('ABS_INVALID_ACTION_POLICY')
            patch.actionPolicy = input.actionPolicy
          }
          if (!Object.keys(patch).length) throw new Error('ABS_PACING_EMPTY')
          const updated = await resources.updateConfig({ abs: patch })
          const absCfg = updated?.abs ?? sanitizeAbsConfig({ ...(service.inspect().config ?? {}), ...patch })
          result = {
            reviewIntervalMinutes: absCfg.reviewIntervalMinutes,
            reviewMinRealGapMinutes: absCfg.reviewMinRealGapMinutes,
            actionPolicy: absCfg.actionPolicy,
          }
          break
        }
        default:
          return reply(400, { ok: false, error: 'ABS_UNKNOWN_ACTION' })
      }
      reply(200, { ok: true, result })
    } catch (error) { reply(409, { ok: false, error: String(error.message ?? error) }) }
  }
}

function dayWindow(dateText, now = Date.now()) {
  const value = dateText ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('ABS_INVALID_ACTIVITY_DATE')
  const fromMs = Date.parse(value + 'T00:00:00+08:00')
  const date = new Date(fromMs)
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
  if (!Number.isFinite(fromMs) || local !== value) throw new TypeError('ABS_INVALID_ACTIVITY_DATE')
  return { from: new Date(fromMs).toISOString(), to: new Date(fromMs + 86400000).toISOString() }
}

function activityRange(url, now = Date.now()) {
  const names = new Set([...url.searchParams.keys()])
  for (const name of names) if (!['date','from','to','limit','snapshotAt','snapshotSeq','beforeWakeAt','beforeEpisodeId','outcome'].includes(name)) throw new TypeError('ABS_UNKNOWN_QUERY')
  for (const name of names) if (url.searchParams.getAll(name).length !== 1) throw new TypeError('ABS_DUPLICATE_QUERY')
  if (url.searchParams.has('date') && (url.searchParams.has('from') || url.searchParams.has('to'))) throw new TypeError('ABS_INVALID_ACTIVITY_WINDOW')
  let window
  if (url.searchParams.has('date') || (!url.searchParams.has('from') && !url.searchParams.has('to'))) window = dayWindow(url.searchParams.get('date') ?? undefined, now)
  else {
    if (!url.searchParams.has('from') || !url.searchParams.has('to')) throw new TypeError('ABS_INVALID_ACTIVITY_WINDOW')
    window = { from: new Date(url.searchParams.get('from')).toISOString(), to: new Date(url.searchParams.get('to')).toISOString() }
    if (Date.parse(window.to) <= Date.parse(window.from) || Date.parse(window.to) - Date.parse(window.from) > 31 * 86400000) throw new TypeError('ABS_INVALID_ACTIVITY_WINDOW')
  }
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw == null ? 100 : Number(limitRaw)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('ABS_INVALID_ACTIVITY_PAGE')
  const beforeWakeAt = url.searchParams.get('beforeWakeAt') ?? undefined
  const beforeEpisodeId = url.searchParams.get('beforeEpisodeId') ?? undefined
  if ((beforeWakeAt == null) !== (beforeEpisodeId == null)) throw new TypeError('ABS_INVALID_ACTIVITY_CURSOR')
  if (beforeWakeAt != null && (!Number.isFinite(Date.parse(beforeWakeAt)) || new Date(beforeWakeAt).toISOString() !== beforeWakeAt || !beforeEpisodeId || beforeEpisodeId.length > 160)) throw new TypeError('ABS_INVALID_ACTIVITY_CURSOR')
  const snapshotAt = url.searchParams.get('snapshotAt') ?? new Date(now).toISOString()
  if (!Number.isFinite(Date.parse(snapshotAt)) || new Date(snapshotAt).toISOString() !== snapshotAt || Date.parse(snapshotAt) > now) throw new TypeError('ABS_INVALID_ACTIVITY_SNAPSHOT')
  const snapshotSeqRaw = url.searchParams.get('snapshotSeq')
  const snapshotSeq = snapshotSeqRaw == null ? undefined : Number(snapshotSeqRaw)
  if (snapshotSeqRaw != null && (!Number.isSafeInteger(snapshotSeq) || snapshotSeq < 0)) throw new TypeError('ABS_INVALID_ACTIVITY_SNAPSHOT')
  if (beforeWakeAt != null && snapshotSeq == null) throw new TypeError('ABS_INVALID_ACTIVITY_SNAPSHOT')
  const outcome = url.searchParams.get('outcome') ?? undefined
  if (outcome && !['verified','failed','no_action','unknown','not_started'].includes(outcome)) throw new TypeError('ABS_INVALID_ACTIVITY_OUTCOME')
  return { ...window, limit, snapshotAt, ...(snapshotSeq == null ? {} : { snapshotSeq }),
    ...(beforeWakeAt == null ? {} : { beforeWakeAt, beforeEpisodeId }), ...(outcome ? { outcome } : {}) }
}

/** Read-only activity feed plus persisted, owner-authored observation annotations. */
export function createAbsActivitiesHttpHandler({ service, maxBodyBytes = 16384, now = Date.now }) {
  const labels = new Set(['interesting','repetitive','follow_up_worthy'])
  return async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body))
    }
    try {
      if (['GET','HEAD'].includes(request.method)) {
        const serverNow = now()
        const query = activityRange(new URL(request.url, 'http://localhost'), serverNow)
        return reply(200, { ok: true, ...service.activities({ ...query, now: serverNow }) })
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
      if (input.action !== 'annotate' || Object.keys(input).some(key => !['action','activityId','label','active'].includes(key)) ||
          typeof input.activityId !== 'string' || !input.activityId || !labels.has(input.label) || typeof input.active !== 'boolean') return reply(400, { ok: false, error: 'ABS_INVALID_ANNOTATION' })
      const result = await service.annotateActivity({ episodeId: input.activityId, label: input.label, active: input.active })
      return reply(200, { ok: true, result })
    } catch (error) {
      const code = String(error?.message ?? error)
      const status = code === 'ABS_ACTIVITY_NOT_FOUND' ? 404 : code.startsWith('ABS_') ? 400 : 409
      reply(status, { ok: false, error: code })
    }
  }
}
