import { publicError } from './core.js'

/** Arrival-driven, bounded draining; a busy/unavailable main session retains the inbox. */
export function createMainDeliveryPump({ service, bridge, retryMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let closed = false, timer = null, running = null, requested = false, lastError = null, lastResult = null, cursor = 0
  function schedule(delay) {
    if (closed || timer !== null) return
    timer = setTimer(() => { timer = null; void run() }, delay)
    timer?.unref?.()
  }
  function wake() {
    if (closed) return
    requested = true
    if (!running) schedule(0)
  }
  function run() {
    if (closed) return Promise.resolve()
    if (running) { requested = true; return running }
    requested = false
    running = (async () => {
      let retry = false
      try {
        const replyState = await bridge.processReplies?.()
        retry = replyState?.pending === true
        const all = (await service.listNotices()).filter(row => row.unreadCount > 0)
        const start = cursor % Math.max(1, all.length)
        const notices = Array.from({ length: Math.min(32, all.length) }, (_, index) => all[(start + index) % all.length])
        cursor = (start + notices.length) % Math.max(1, all.length)
        lastError = null
        for (const notice of notices) {
          if (closed) break
          try {
            const result = await bridge.view({ connectionId: notice.connectionId, conversation: notice.conversation })
            lastResult = result?.status ?? null
            if (result?.status === 'busy' || result?.status === 'pending') { retry = true; continue }
          } catch (error) { lastError = publicError(error); retry = true }
        }
        if (!closed) retry ||= (await service.listNotices()).some(row => row.unreadCount > 0)
      } catch (error) { lastError = publicError(error); retry = true }
      finally {
        running = null
        // Backoff applies even to repeated arrival notifications while the target is busy.
        if (!closed && (retry || requested)) schedule(retry ? retryMs : 0)
      }
    })()
    return running
  }
  const unsubscribe = service.subscribe(wake)
  wake() // Recover any still-unread arrivals on Host restart, never create a target session.
  return {
    wake, run,
    inspect: () => ({ automatic: true, delivering: running !== null, pending: lastResult === 'busy' || lastResult === 'pending', lastResult, lastError }),
    async close() {
      if (closed) { await running; return }
      closed = true
      if (timer !== null) clearTimer(timer)
      timer = null
      unsubscribe?.()
      await running
    },
  }
}
