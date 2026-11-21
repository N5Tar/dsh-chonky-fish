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

function comparisonText(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return ''
  const delta = current - previous
  if (Math.abs(delta) < 0.02) return '和上次留意自己时相比，这份念头差不多。'
  return delta > 0 ? '比上次留意自己时，这份念头更强了一些。' : '比上次留意自己时，这份念头淡了一些。'
}

/** Render one already-selected, app-authored first-person action prompt. */
export function renderActionPrompt({ intent, ownerInteraction = null, currentSessionId = null, socialGap = null,
  previousSocialGap = null, workMinutes = null }) {
  switch (intent) {
    case 'chat_owner': {
      const ownerTime = Date.parse(ownerInteraction?.realAt)
      if (ownerInteraction?.sourceKind !== 'user' || typeof currentSessionId !== 'string' || !currentSessionId
          || ownerInteraction.sessionId !== currentSessionId || !Number.isFinite(ownerTime)) {
        throw new TypeError('Verified same-session owner timestamp is required for chat')
      }
      const comparison = comparisonText(socialGap, previousSocialGap)
      return `唔……我现在很想和主人说说话，这份念头很强。${comparison}我这里最近一次和主人的交流记录是 ${formatCstTime(ownerInteraction.realAt)}，要不要找他说说话呢？`
    }
    case 'remind_rest': {
      if (!Number.isFinite(workMinutes) || workMinutes < 60) throw new TypeError('Verified work duration is required for a rest prompt')
      const minutes = Math.floor(workMinutes)
      return `我留意到主人已经连续工作了大约${minutes}分钟。忙了这么久，我要不要去提醒他歇一会儿？`
    }
    case 'continue_interest':
      return '我现在很想接触些新东西，好奇的念头很强。我最近做了点啥？要不要继续？'
    default: throw new TypeError('Invalid ABS action prompt intent')
  }
}
