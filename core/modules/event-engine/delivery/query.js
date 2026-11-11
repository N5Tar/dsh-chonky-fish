/**
 * 大肥鱼模块 0 · 查询契约（P3）。
 *
 * 面板「感知」区和调试 curl 共用同一套读取逻辑；HTTP 外壳在 index.js，
 * 这里只做参数解析和「事件 → 传输形状」的投影，方便脱离 DSH 单测。
 */

export const DEFAULT_LIMIT = 30
export const MAX_LIMIT = 200

/** @param {string} url */
export function parseEventsQuery(url) {
  const parsed = new URL(url, 'http://localhost')
  const rawLimit = Number(parsed.searchParams.get('limit'))
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT
  const rawSince = Number(parsed.searchParams.get('sinceSeq'))
  const sinceSeq = Number.isFinite(rawSince) && rawSince > 0 ? Math.floor(rawSince) : 0
  const sessionId = parsed.searchParams.get('sessionId')
  return { limit, sinceSeq, sessionId: sessionId && sessionId.length > 0 ? sessionId : null,
    ...(parsed.searchParams.get('latest') === 'true' ? { latest: true } : {}),
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
  }
}

/**
 * HTTP 级入口：读 + 统一错误形状。
 * @returns {{ status: number, body: object }}
 */
export function handleEventsRequest({ engine, url }) {
  try {
    const query = parseEventsQuery(url)
    return { status: 200, body: readEvents(engine, query) }
  } catch (error) {
    return { status: 500, body: { ok: false, error: String((error && error.message) || error) } }
  }
}
