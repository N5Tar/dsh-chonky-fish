// Deterministic natural-language self-review. It describes internal state and
// observed facts only; it never names a task, channel, contact or next action.
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

const LEVELS = [
  [0.05, '基本处于平常的满足水平'],
  [0.25, '比平常的满足水平略低，有轻微缺口'],
  [0.50, '低于平常的满足水平，有明显缺口'],
  [0.75, '明显低于平常的满足水平，缺口较大'],
  [1.01, '远低于平常的满足水平，缺口很大'],
]

function levelText(demand) {
  for (const [limit, text] of LEVELS) if (demand <= limit) return text
  return LEVELS[LEVELS.length - 1][1]
}

function comparisonText(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return ''
  const delta = current - previous
  if (Math.abs(delta) < 0.02) return '和上一次审查时大致相近'
  return delta > 0 ? '比上一次审查时更低了一些' : '比上一次审查时有所回升'
}

function ownerText(state) {
  const last = state.lastOwnerMessage
  if (!last) return '目前没有记录到与主人的交流。'
  return `最近一次记录到与主人的交流，是在现实时间 ${formatCstTime(last.realAt)}。此后没有新的交流记录。`
}

const EXPLORATION = {
  explore_content_found: '最近一次探索取得了可用资料',
  local_content_found: '最近一次本地活动取得了可查看的内容或实际文件变化',
  explore_no_usable_content: '最近一次探索没有取得可用内容',
  failed: '最近一次探索执行失败',
}

function explorationText(state) {
  const last = state.lastExploration
  if (!last || !last.resultKind) return '目前没有记录到探索结果。'
  const label = EXPLORATION[last.resultKind] ?? '最近一次探索已经结束'
  return `${label}（现实时间 ${formatCstTime(last.realAt)}）。`
}

/**
 * Render the self-review. Pure: no clock reads, no random, no side effects.
 * Times shown are real-world timestamps only; the experiment acceleration
 * factor is never exposed as a second clock here.
 * @param {{ state: any }} input
 */
export function renderSelfReview({ state }) {
  const drives = state?.drives ?? {}
  const previous = state?.lastReview?.demand ?? {}
  const social = driveDemand(drives.social)
  const curiosity = driveDemand(drives.curiosity)
  const lines = [
    '【内部状态记录 · 非主人发言】',
    '### 自身精神状态审查',
  ]
  if (social === null) lines.push('社交方面的状态记录目前不可用。')
  else {
    const change = comparisonText(social, previous.social)
    lines.push(`社交方面：满足程度${levelText(social)}。${change ? '这方面' + change + '。' : ''}${ownerText(state)}`)
  }
  if (curiosity === null) lines.push('探索方面的状态记录目前不可用。')
  else {
    const change = comparisonText(curiosity, previous.curiosity)
    lines.push(`探索方面：满足程度${levelText(curiosity)}。${change ? '这方面' + change + '。' : ''}${explorationText(state)}`)
  }
  lines.push('以上是当前内部状态的记录。')
  return lines.join('\n\n')
}

export const REVIEW_HEADING = '自身精神状态审查'
