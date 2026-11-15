/** 自动把新消息批次交给大肥鱼查看。
 *
 * 不收信时推理；只有 Host 收件箱确认接纳后，才 debounce 后调用 view()。
 * 主会话路径直接进主 Agent，不建 session binding；没有主会话时退回受限会话。
 */
export function createAutoViewer({ service, bridge, view, limits = {}, warn = () => {} }) {
  const delay = Number.isSafeInteger(limits.autoViewDelayMs) ? limits.autoViewDelayMs : 1200
  const retry = Number.isSafeInteger(limits.autoViewRetryMs) ? limits.autoViewRetryMs : 5000
  const timers = new Map()
  const running = new Set()
  const again = new Set()
  let closed = false, unsubscribe = null

  function keyOf(notice) {
    if (notice?.sessionKey) return notice.sessionKey
    try { return JSON.stringify([notice?.connectionId, notice?.conversation]) } catch { return 'unknown' }
  }
  function schedule(notice, wait = delay) {
    if (closed || (!view && !bridge) || !notice || !(Number(notice.unreadCount) > 0)) return
    if (!view) {
      try {
        if (typeof bridge.inspect === 'function' && !bridge.inspect().available) return
      } catch {}
    }
    const key = keyOf(notice)
    if (timers.has(key)) return
    const timer = setTimeout(() => {
      timers.delete(key)
      void run(notice)
    }, Math.max(0, wait))
    timer.unref?.()
    timers.set(key, timer)
  }
  async function run(notice) {
    if (closed || (!view && !bridge) || !notice || !(Number(notice.unreadCount) > 0)) return
    const key = keyOf(notice)
    if (running.has(key)) { again.add(key); return }
    running.add(key)
    try {
      const result = view
        ? await view(notice)
        : await bridge.view({ connectionId: notice.connectionId, conversation: notice.conversation })
      if (!closed && result?.status === 'busy') schedule(notice, retry)
    } catch (error) {
      if (!closed) warn('[chonkyfish/social] auto-view failed: ' + (error?.code || error?.message || 'unknown'))
    } finally {
      running.delete(key)
      if (again.delete(key) && !closed) schedule(notice)
    }
  }
  function start() {
    if (closed || unsubscribe) return
    try {
      unsubscribe = service.subscribe(notices => {
        for (const notice of Array.isArray(notices) ? notices : []) schedule(notice)
      })
    } catch {
      unsubscribe = null
    }
    Promise.resolve(service.listNotices()).then(notices => {
      for (const notice of Array.isArray(notices) ? notices : []) schedule(notice)
    }).catch(() => {})
  }
  function close() {
    closed = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    running.clear()
    again.clear()
    try { unsubscribe?.() } catch {}
    unsubscribe = null
  }
  return { start, close, schedule }
}
