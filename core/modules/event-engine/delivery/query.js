/**
 * 大肥鱼模块 0 · 查询契约（P3）。
 *
 * 面板「感知」区和调试 curl 共用同一套读取逻辑；HTTP 外壳在 index.js，
 * 这里只做参数解析和「事件 → 传输形状」的投影，方便脱离 DSH 单测。
 */

export const DEFAULT_LIMIT = 30
export const MAX_LIMIT = 200
const EVENT_CATEGORIES = new Set(['interaction', 'preference', 'activity', 'environment', 'state', 'goal'])
const EVENT_EVIDENCE = new Set(['reported', 'intent', 'hypothetical', 'negated', 'uncertain'])

/** @param {string} url */
export function parseEventsQuery(url) {
  const parsed = new URL(url, 'http://localhost')
  const rawLimit = Number(parsed.searchParams.get('limit'))
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT
  const rawSince = Number(parsed.searchParams.get('sinceSeq'))
  const sinceSeq = Number.isFinite(rawSince) && rawSince > 0 ? Math.floor(rawSince) : 0
  const sessionId = parsed.searchParams.get('sessionId')
  const rawDay = parsed.searchParams.get('day')
  const rawOffset = Number(parsed.searchParams.get('offset'))
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 1_000_000) : 0
  const rawSnapshot = parsed.searchParams.get('snapshotSeq')
  const snapshotSeq = rawSnapshot === null ? null : Number(rawSnapshot)
  if (rawSnapshot !== null && (!Number.isSafeInteger(snapshotSeq) || snapshotSeq < 0)) throw new TypeError('snapshotSeq is invalid')
  const rawCategory = parsed.searchParams.get('category')
  const rawEvidence = parsed.searchParams.get('evidenceStatus')
  if (rawCategory && !EVENT_CATEGORIES.has(rawCategory)) throw new TypeError('category is invalid')
  if (rawEvidence && !EVENT_EVIDENCE.has(rawEvidence)) throw new TypeError('evidenceStatus is invalid')
  let summaryWindow
  if (rawDay !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDay)) throw new TypeError('day must be an ISO calendar date')
    const start = new Date(rawDay + 'T00:00:00+08:00')
    if (!Number.isFinite(start.getTime())) throw new TypeError('day must be a valid UTC+8 calendar date')
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(start)
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]))
    if (`${fields.year}-${fields.month}-${fields.day}` !== rawDay) throw new TypeError('day must be a valid UTC+8 calendar date')
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
    summaryWindow = { observedSince: start.toISOString(), observedBefore: end.toISOString() }
  }
  return { limit, sinceSeq, sessionId: sessionId && sessionId.length > 0 ? sessionId : null,
    ...(parsed.searchParams.get('latest') === 'true' ? { latest: true } : {}),
    ...(summaryWindow ? { summaryWindow } : {}),
    ...(summaryWindow ? { offset, category: rawCategory || null, evidenceStatus: rawEvidence || null, snapshotSeq } : {}),
  }
}

function toWireEvent(event) {
  const ref = Array.isArray(event.sourceRefs) ? event.sourceRefs[0] : null
  return {
    eventSeq: event.eventSeq,
    eventId: event.eventId,
    sessionId: event.sessionId,
    category: event.category,
    type: event.type,
    actorRef: event.actorRef,
    polarity: event.polarity,
    evidenceStatus: event.evidenceStatus,
    observedAt: event.observedAt,
    occurredAt: event.occurredAt,
    target: event.target ? event.target.value : null,
    quote: ref ? ref.quote : null,
    recordId: ref ? ref.recordId : null,
  }
}

/**
 * @param {ReturnType<typeof import('../engine.js').createEventEngine>} engine
 * @param {{ limit: number, sessionId: string | null, sinceSeq: number }} query
 */
export function readEvents(engine, query) {
  if (query.summaryWindow) {
    const windowQuery = { ...query.summaryWindow, category: query.category, evidenceStatus: query.evidenceStatus,
      snapshotSeq: query.snapshotSeq === null ? engine.maxEventSeqInWindow(query.summaryWindow) : query.snapshotSeq }
    const page = { limit: query.limit, offset: query.offset }
    const total = engine.countEventsInWindow(windowQuery)
    const events = engine.listEventsInWindow({ ...windowQuery, ...page })
    return {
      ok: true,
      events: events.map(toWireEvent),
      count: events.length,
      summary: engine.summarizeEvents(query.summaryWindow),
      page: { ...page, total, hasMore: query.offset + events.length < total, snapshotSeq: windowQuery.snapshotSeq },
      stats: engine.stats(),
    }
  }
  const events = engine.listEvents({
    sessionId: query.sessionId,
    limit: query.limit,
    sinceSeq: query.sinceSeq,
    latest: query.latest === true,
  })
  return {
    ok: true,
    events: events.map(toWireEvent),
    count: events.length,
    stats: engine.stats(),
    ...(query.summaryWindow ? { summary: engine.summarizeEvents(query.summaryWindow) } : {}),
  }
}

/**
 * HTTP 级入口：读 + 统一错误形状。
 * @returns {{ status: number, body: object }}
 */
export function handleEventsRequest({ engine, url }) {
  let query
  try {
    query = parseEventsQuery(url)
  } catch (error) {
    return { status: 400, body: { ok: false, error: String((error && error.message) || error) } }
  }
  try {
    return { status: 200, body: readEvents(engine, query) }
  } catch (error) {
    return { status: 500, body: { ok: false, error: String((error && error.message) || error) } }
  }
}
