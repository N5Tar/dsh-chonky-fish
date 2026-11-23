/**
 * 日程装甲：setTimeout → 扫描 → ensure/deliver/mark。
 */

import { readFileSync } from 'node:fs'

import { SCHEDULE_LIMITS } from '../../../../core/modules/schedule/schema.js'

/**
 * @param {{
 *   service: ReturnType<import('../../../../core/modules/schedule/service.js').createScheduleService>,
 *   deliver: (sessionId: string, text: string, options?: { source?: object }) => Promise<{ ok: boolean, error?: string }>,
 *   getActiveSessionId: () => string | null,
 *   logger?: { warn?: Function, info?: Function },
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} options
 */
export function createScheduleHost({
  service,
  deliver,
  getActiveSessionId,
  logger,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let scanGeneration = 0
  let timer = null
  let closed = false
  let arming = false
  let pendingScan = false

  function warn(...args) {
    try {
      logger?.warn?.('[chonkyfish/schedule]', ...args)
    } catch {
      /* ignore */
    }
  }

  function bumpGeneration() {
    scanGeneration += 1
    return scanGeneration
  }

  function clearTimer() {
    if (timer != null) {
      clearTimeoutFn(timer)
      timer = null
    }
  }

  function arm(targetMs) {
    clearTimer()
    if (closed) return
    const now = Date.now()
    let delay = typeof targetMs === 'number' ? targetMs - now : 0
    if (!Number.isFinite(delay)) delay = SCHEDULE_LIMITS.scanContinueMs
    if (delay < 0) delay = 0
    if (delay > SCHEDULE_LIMITS.maxTimerMs) delay = SCHEDULE_LIMITS.maxTimerMs
    timer = setTimeoutFn(() => {
      timer = null
      void scan()
    }, delay)
  }

  async function rearmFromDoc() {
    if (closed) return
    bumpGeneration()
    try {
      const doc = await service.load()
      const wake = service.nextWakeAt(doc, Date.now())
      if (wake == null) {
        clearTimer()
        return
      }
      arm(wake)
    } catch (error) {
      warn('rearm failed', error)
    }
  }

  async function scan() {
    if (closed) return
    if (arming) {
      // 扫描中又被定时器/rearm 叫醒：记一笔，本轮结束后补扫，避免停摆
      pendingScan = true
      return
    }
    arming = true
    pendingScan = false
    const gen = bumpGeneration()
    try {
      await service.missSkipBoot()
      const doc = await service.load()
      const due = service.listDue(doc, Date.now())
      let delivered = 0
      let hitCap = false

      for (const itemRef of due) {
        if (gen !== scanGeneration) break
        if (delivered >= SCHEDULE_LIMITS.maxScanDeliveries) {
          hitCap = true
          break
        }

        const attempt = await runOneAttempt(itemRef.id, gen)
        if (attempt === 'delivered') delivered += 1
        if (attempt === 'aborted') break
      }

      if (closed) return
      if (gen !== scanGeneration) return // CRUD/rearm 已接管装甲（或其 pendingScan 会补扫）
      if (hitCap) arm(Date.now() + SCHEDULE_LIMITS.scanContinueMs)
      else {
        const latest = await service.load()
        const wake = service.nextWakeAt(latest, Date.now())
        if (wake == null) clearTimer()
        else arm(wake)
      }
    } catch (error) {
      warn('scan failed', error)
      if (!closed && gen === scanGeneration) arm(Date.now() + SCHEDULE_LIMITS.scanContinueMs)
    } finally {
      arming = false
      if (pendingScan && !closed) {
        pendingScan = false
        void scan()
      }
    }
  }

  /**
   * @returns {'delivered' | 'skipped' | 'aborted' | 'noop'}
   */
  async function runOneAttempt(scheduleId, gen) {
    let ensured
    try {
      ensured = await service.ensureFireId(scheduleId)
    } catch (error) {
      warn('ensureFireId', error)
      return 'noop'
    }
    if (!ensured || !ensured.enabled || !ensured.activeFireId) return 'noop'
    const fireId = ensured.activeFireId

    if (await service.alreadyDelivered(scheduleId, fireId)) {
      await service.repairAdvanceIfDelivered(scheduleId, fireId)
      return 'noop'
    }

    if (gen !== scanGeneration) return 'aborted'

    const sessionId = getActiveSessionId()
    if (!sessionId) {
      await service.markTransientSkip(scheduleId, fireId, 'skipped_no_session')
      return 'skipped'
    }

    const prompt = ensured.prompt
    const source = service.scheduleSource(ensured)
    let result
    try {
      result = await deliver(sessionId, prompt, { source })
    } catch (error) {
      warn('deliver threw', error)
      result = { ok: false, error: 'flush_failed' }
    }

    // deliver 返回后必须条件 mark，不因 gen 变化跳过
    if (result && result.ok) {
      await service.markDelivered(scheduleId, fireId)
      return 'delivered'
    }

    const error = String((result && result.error) || '')
    let outcome = 'flush_failed'
    if (error === 'agent-busy') outcome = 'skipped_busy'
    else if (
      error === 'missing-session-id' ||
      error === 'identity-mismatch' ||
      error.startsWith('resolve-') ||
      error === 'no-agent'
    ) {
      outcome = 'skipped_no_session'
    }
    await service.markTransientSkip(scheduleId, fireId, outcome)
    return 'skipped'
  }

  async function start() {
    if (closed) return
    await scan()
  }

  function notifyMutation() {
    void rearmFromDoc()
  }

  function close() {
    closed = true
    bumpGeneration()
    clearTimer()
    pendingScan = false
  }

  return {
    start,
    scan,
    rearm: rearmFromDoc,
    notifyMutation,
    close,
    /** @internal tests */
    _generation: () => scanGeneration,
  }
}

export function readActiveSessionId(proactivePath) {
  try {
    const parsed = JSON.parse(readFileSync(proactivePath, 'utf8'))
    return typeof parsed.activeSessionId === 'string' && parsed.activeSessionId.trim()
      ? parsed.activeSessionId.trim()
      : null
  } catch {
    return null
  }
}
