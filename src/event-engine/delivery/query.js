/**
 * 大肥鱼模块 0 · 查询契约（P3）。
 *
 * 面板「感知」区和调试 curl 共用同一套读取逻辑；HTTP 外壳在 index.js，
 * 这里只做参数解析、鉴权和「事件 → 传输形状」的投影，方便脱离 DSH 单测。
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
  return { limit, sinceSeq, sessionId: sessionId && sessionId.length > 0 ? sessionId : null }
}

/**
 * @param {Record<string, unknown>} headers node:http 的 headers（小写键）
 * @param {string} token
 */
export function authorizeEventsRequest(headers, token) {
  if (typeof token !== 'string' || token.length === 0) return false
  const provided = headers && (headers['x-chonkyfish-token'] ?? headers['X-Chonkyfish-Token'])
  return typeof provided === 'string' && provided === token
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
  })
  return {
    ok: true,
    events: events.map(toWireEvent),
    count: events.length,
    stats: engine.stats(),
  }
}

/**
 * HTTP 级入口：鉴权 + 读 + 统一错误形状。
 * @returns {{ status: number, body: object }}
 */
export function handleEventsRequest({ engine, headers, url, token }) {
  if (!authorizeEventsRequest(headers, token)) {
    return { status: 401, body: { ok: false, error: 'unauthorized' } }
  }
  try {
    const query = parseEventsQuery(url)
    return { status: 200, body: readEvents(engine, query) }
  } catch (error) {
    return { status: 500, body: { ok: false, error: String((error && error.message) || error) } }
  }
}
