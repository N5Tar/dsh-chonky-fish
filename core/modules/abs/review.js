const CST_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

export function formatCstTime(value) {
  if (value === null || value === undefined || value === '') return '时间未记录'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未记录'
  const parts = {}
  for (const part of CST_FORMAT.formatToParts(date)) parts[part.type] = part.value
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value))

export function driveDemand(drive) {
  if (!drive || !Number.isFinite(drive.satisfaction) || !Number.isFinite(drive.setpoint) || drive.setpoint <= 0) return null
  return clamp((drive.setpoint - drive.satisfaction) / drive.setpoint)
}

export function comparisonText(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return ''
  const delta = current - previous
  if (Math.abs(delta) < 0.02) return '和上次留意自己时相比，这份念头差不多。'
  return delta > 0 ? '比上次留意自己时，这份念头更强了一些。' : '比上次留意自己时，这份念头淡了一些。'
}

const EXPLORATION_HOOK_MAX_AGE_MS = 6 * 60 * 60 * 1000

function dayPeriod(hour) {
  if (hour < 5) return '深夜'
  if (hour < 9) return '早上'
  if (hour < 12) return '上午'
  if (hour < 14) return '中午'
  if (hour < 18) return '下午'
  if (hour < 23) return '晚上'
  return '深夜'
}

/**
 * Build one concrete, verifiable opening hook for chat_owner. Only app-held
 * facts are used: a recent verified exploration result, otherwise the current
 * CST period plus the gap since the verified owner message. Returns '' when
 * `now` is not supplied so callers without a clock keep the plain prompt.
 */
export function buildChatHook({ ownerTime, now = null, lastExploration = null }) {
  const nowMs = now === null || now === undefined ? NaN : new Date(now).getTime()
  if (!Number.isFinite(nowMs) || !Number.isFinite(ownerTime)) return ''
  const explored = Date.parse(lastExploration?.realAt)
  const recent = Number.isFinite(explored) && nowMs >= explored && nowMs - explored <= EXPLORATION_HOOK_MAX_AGE_MS
  if (recent && lastExploration?.resultKind === 'explore_content_found' && Number.isSafeInteger(lastExploration.sources)
      && lastExploration.sources > 0) {
    return `我最近一次出去逛是 ${formatCstTime(explored)}，带回了 ${lastExploration.sources} 条能用的内容，可以拣一件说给他听。`
  }
  // Browsing counts as verified only when the page content was read (cdp eval with non-empty output).
  if (recent && lastExploration?.resultKind === 'local_content_found' && lastExploration.activity === 'browse') {
    return `我最近一次出去逛是 ${formatCstTime(explored)}，在网页上看到了点东西，可以拣一件说给他听。`
  }
  const hours = Math.floor(Math.max(0, nowMs - ownerTime) / 3600000)
  const parts = {}
  for (const part of CST_FORMAT.formatToParts(new Date(nowMs))) parts[part.type] = part.value
  const clock = `${parts.hour}:${parts.minute}`
  const gap = hours >= 1 ? `离上次交流已经过去约 ${hours} 小时` : '离上次交流还不到一小时'
  return `眼下是${dayPeriod(Number(parts.hour))}（${clock}），${gap}。`
}
