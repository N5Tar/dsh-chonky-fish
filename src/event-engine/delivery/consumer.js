/**
 * 大肥鱼模块 0 · 游标消费者（P3）。
 *
 * 替代 outbox 的最小可靠投递：消费者把「读到第几个 event_seq」写进
 * consumer_cursor，崩溃/重启后从断点继续；同一事件可能被重复投递一次，
 * 但 onEvents 必须按 eventId 幂等（约定见设计文档 §9）。
 *
 * 现在还没有模块①②③④⑤，所以先给一个演示消费者，用来证明
 * 「可订阅 / 可查询 / 可重放」这条验收。
 */

/**
 * @param {{
 *   engine: ReturnType<typeof import('../engine.js').createEventEngine>,
 *   consumerId: string,
 *   onEvents: (events: any[]) => Promise<void> | void,
 *   batchSize?: number,
 * }} options
 */
export function createCursorConsumer({ engine, consumerId, onEvents, batchSize = 20 }) {
  let cursor = engine.getConsumerCursor(consumerId)

  async function poll() {
    const events = engine.listEvents({ sinceSeq: cursor, limit: batchSize })
    if (events.length === 0) return { processed: 0, cursor }
    await onEvents(events)
    cursor = events[events.length - 1].eventSeq
    engine.setConsumerCursor(consumerId, cursor)
    return { processed: events.length, cursor }
  }

  return {
    consumerId,
    poll,
    get cursor() {
      return cursor
    },
  }
}

/**
 * 演示消费者：只做计数和最近几条预览，证明管道通，不参与任何人格/行动决策。
 * @param {ReturnType<typeof import('../engine.js').createEventEngine>} engine
 * @param {{ consumerId?: string }} [options]
 */
export function createDemoConsumer(engine, { consumerId = 'demo:echo' } = {}) {
  const state = { delivered: 0, lastEventAt: null, preview: [] }
  const consumer = createCursorConsumer({
    engine,
    consumerId,
    onEvents(events) {
      state.delivered += events.length
      state.lastEventAt = new Date().toISOString()
      state.preview = events.slice(-5).map((event) => ({
        eventSeq: event.eventSeq,
        type: event.type,
        evidenceStatus: event.evidenceStatus,
        quote: event.sourceRefs && event.sourceRefs[0] ? event.sourceRefs[0].quote : null,
      }))
    },
  })
  return {
    ...consumer,
    get state() {
      return { ...state, cursor: consumer.cursor, consumerId }
    },
  }
}
