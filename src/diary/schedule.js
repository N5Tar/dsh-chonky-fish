/**
 * 大肥鱼 · 日记模块（Host 侧）· 每日 20:00 提醒定时器。
 *
 * 目标会话：**面板当前那条鱼鱼会话**（`proactive.json.activeSessionId`）。
 * 项目设定是大肥鱼面板始终只有同一个会话对话，所以这里不建新会话、
 * 也不做多会话聚合；没有面板会话就等下个 tick 再试。
 *
 * 触发规则：
 *   - 到点（默认 20:00，时区可配）后投一条隐藏旁白；
 *   - 同一天只提醒一次（diary.json 落盘 + 进程内兜底）；
 *   - 当天日记已经存在 → 直接标记完成，不再提醒；
 *   - catchUp=true 时，20:00 错过（Host 没开着）之后当天补一次；
 *   - 投递失败（agent busy / 会话恢复失败）不标记，下个 tick 重试。
 *
 * 时间判断不自己算时差：用 Intl.DateTimeFormat 按配置时区取年月日时分。
 */
import { readActiveSessionId } from '../proactive/store.js'
import { diaryNarration } from './narration.js'

/** 轮询间隔：30 秒足够覆盖一分钟粒度的触发。 */
export const DIARY_TICK_MS = 30_000

/** 同一条告警的最短间隔，避免每个 tick 刷日志。 */
const WARN_INTERVAL_MS = 10 * 60_000

const formatterCache = new Map()

function formatterFor(timeZone) {
  const key = timeZone || ''
  let formatter = formatterCache.get(key)
  if (formatter !== undefined) return formatter
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }
  if (timeZone) options.timeZone = timeZone
  try {
    formatter = new Intl.DateTimeFormat('en-CA', options)
  } catch (error) {
    // 非法时区理论上已被配置消毒拦掉；兜底回系统时区。
    const fallback = { ...options }
    delete fallback.timeZone
    formatter = new Intl.DateTimeFormat('en-CA', fallback)
  }
  formatterCache.set(key, formatter)
  return formatter
}

/**
 * 按指定时区拆出本地日期与时分。
 * @param {number} ms epoch 毫秒
 * @param {string} [timeZone] IANA 时区；空表示系统时区
 * @returns {{ date: string, hour: number, minute: number }}
 */
export function zonedParts(ms, timeZone) {
  const formatter = formatterFor(timeZone)
  const values = {}
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type && part.type !== 'literal') values[part.type] = part.value
  }
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  }
}

/**
 * 今天是否已经到/过了提醒时刻。
 * @param {{ now: number, hour: number, minute: number, timeZone?: string, catchUp?: boolean }} options
 * @returns {boolean}
 */
export function isDue({ now, hour, minute, timeZone, catchUp = true }) {
  const parts = zonedParts(now, timeZone)
  const current = parts.hour * 60 + parts.minute
  const target = hour * 60 + minute
  return catchUp ? current >= target : current === target
}

/**
 * @param {{
 *   resources: ReturnType<typeof import('../resources/index.js').createResources>,
 *   provider: ReturnType<typeof import('./provider.js').createLocalDiaryProvider>,
 *   state: ReturnType<typeof import('./state.js').createDiaryState>,
 *   deliverer: { deliver: (sessionId: string, text: string) => Promise<{ ok: boolean, sessionId?: string, error?: string }> },
 *   logger?: { warn?: Function, info?: Function },
 *   now?: () => number,
 *   tickMs?: number,
 * }} options
 */
export function createDiaryScheduler({
  resources,
  provider,
  state,
  deliverer,
  logger,
  now = Date.now,
  tickMs = DIARY_TICK_MS,
}) {
  let timer = null
  let busy = false
  let stopped = false
  /** 进程内兜底：即使状态文件写失败，本进程当天也不重复提醒。 */
  let completedDate = null
  let lastWarn = { key: '', at: 0 }

  function warn(message, error) {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(message, error)
    } catch (ignored) {
      /* logging is best effort */
    }
  }

  function warnThrottled(key, message, error) {
    const stamp = now()
    if (lastWarn.key === key && stamp - lastWarn.at < WARN_INTERVAL_MS) return
    lastWarn = { key, at: stamp }
    warn(message, error)
  }

  async function markCompleted(today, status, sessionId) {
    completedDate = today
    try {
      await state.mark({
        lastNudgeDate: today,
        lastNudgeAt: now(),
        lastNudgeStatus: status,
        lastSessionId: sessionId,
      })
    } catch (error) {
      warnThrottled('state-write', '[chonkyfish/diary] diary.json 写入失败（本进程内仍不会重复提醒）', error)
    }
  }

  /**
   * 跑一次触发判断。定时器每个 tick 调它；测试也可以直接调。
   * @returns {Promise<{ status: string, reason?: string, date?: string, sessionId?: string }>}
   */
  async function checkOnce() {
    if (stopped) return { status: 'stopped' }

    const config = resources.getConfig()
    const diary = config.diary
    if (!diary.enabled || !diary.schedule.enabled) return { status: 'skipped', reason: 'disabled' }

    const schedule = diary.schedule
    const timeZone = schedule.timezone || undefined
    const stamp = now()
    const parts = zonedParts(stamp, timeZone)
    if (!isDue({ now: stamp, hour: schedule.hour, minute: schedule.minute, timeZone, catchUp: schedule.catchUp })) {
      return { status: 'skipped', reason: 'not-due' }
    }

    const today = parts.date
    const current = await state.read()
    if (current.lastNudgeDate === today || completedDate === today) {
      return { status: 'skipped', reason: 'already-nudged' }
    }

    let exists = false
    try {
      exists = await provider.has(today)
    } catch (error) {
      warnThrottled('storage', '[chonkyfish/diary] 检查当天日记失败', error)
      return { status: 'skipped', reason: 'storage-error' }
    }
    if (exists) {
      await markCompleted(today, 'already-written', null)
      return { status: 'skipped', reason: 'diary-exists', date: today }
    }

    const sessionId = readActiveSessionId(resources.paths.proactive)
    if (!sessionId) {
      warnThrottled('no-session', '[chonkyfish/diary] 还没有面板会话，今晚的日记提醒先跳过')
      return { status: 'skipped', reason: 'no-panel-session' }
    }

    const result = await deliverer.deliver(sessionId, diaryNarration({ date: today, hour: schedule.hour }))
    if (!result || result.ok !== true) {
      // agent-busy / 会话恢复失败：不标记，下个 tick 重试。
      warnThrottled('deliver:' + (result && result.error), '[chonkyfish/diary] 日记提醒投递失败，稍后重试', null)
      return { status: 'deliver-failed', reason: result && result.error, date: today }
    }

    await markCompleted(today, 'delivered', result.sessionId || sessionId)
    return { status: 'delivered', date: today, sessionId: result.sessionId || sessionId }
  }

  function tick() {
    if (busy || stopped) return
    busy = true
    checkOnce()
      .catch((error) => warn('[chonkyfish/diary] 定时检查异常', error))
      .finally(() => {
        busy = false
      })
  }

  function start() {
    if (timer !== null || stopped) return
    timer = setInterval(tick, tickMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    tick()
  }

  function stop() {
    stopped = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return { start, stop, checkOnce, tickMs }
}
