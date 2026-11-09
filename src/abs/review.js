// Deterministic first-person self-review in the fish's voice. This is injected
// context, not native model reasoning. Desires follow state; facts need records.
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

// Keep the existing five deficit bands; only their natural-language expression changes.
const LEVELS = [0.05, 0.25, 0.50, 0.75, 1]
const SOCIAL = [
  '唔……我现在不怎么惦记着聊天，自己待着也挺自在。',
  '唔……我有一点想和主人说说话。不过，自己待一会儿也挺好。',
  '唔……我想和主人说说话的念头还挺明显。倒也不急着马上说点什么。',
  '唔……我挺想和主人说说话的，这份念头有些强了。不过，不用急着把它变成一条消息。',
  '唔……我现在很想和主人说说话，这份念头很强。但这只是我的感受，不代表主人此刻有空。',
]
const CURIOSITY = [
  '新鲜东西嘛，我现在倒没有特别想追着弄明白的感觉。',
  '我还有一点想接触些新东西，看看有没有什么让我好奇的。',
  '我有点想接触些新东西了。想碰到一个让我好奇的小问题，慢慢弄明白。',
  '我挺想接触些新东西，好奇的念头有些强了。比起随便翻翻，我更想弄明白一点什么。',
  '我现在很想接触些新东西，好奇的念头很强。不过，想了解些什么，不等于我已经有什么收获。',
]

function levelText(demand, phrases) {
  const index = LEVELS.findIndex(limit => demand <= limit)
  return phrases[index < 0 ? phrases.length - 1 : index]
}

function comparisonText(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return ''
  const delta = current - previous
  if (Math.abs(delta) < 0.02) return '和上次留意自己时相比，这份念头差不多。'
  return delta > 0 ? '比上次留意自己时，这份念头更强了一些。' : '比上次留意自己时，这份念头淡了一些。'
}

function ownerText(state) {
  const last = state?.lastOwnerMessage
  if (!last) return '我这里还没有记下和主人的交流，不能据此猜主人在忙什么。'
  return `我这里最近一次和主人的交流记录是 ${formatCstTime(last.realAt)}，之后还没有新的交流记录。`
}

const EXPLORATION = {
  explore_content_found: '上一次探索，我拿到了可用的资料，至于懂了多少，不能只凭拿到资料就算数',
  local_content_found: '上一次本地活动，我有了可查看的内容或实际的文件变化，但这还不代表质量已经过验证',
  explore_no_usable_content: '上一次探索，我没有拿到可用的内容',
  failed: '上一次探索没有顺利完成',
}

function explorationText(state) {
  const last = state?.lastExploration
  if (!last || !last.resultKind) return '我这里还没有记下最近的探索结果。'
  const label = EXPLORATION[last.resultKind] ?? '我这里有一条探索记录，不过结果还不能确认'
  return `${label}（${formatCstTime(last.realAt)}）。`
}

/**
 * Render a simulated inner monologue. Pure: no clock reads, random or side effects.
 * Times shown are real-world timestamps only; no invented elapsed time or memories.
 * No task/channel/tool is selected, and the message role is left to the Host.
 * @param {{ state: any }} input
 */
export function renderSelfReview({ state }) {
  const drives = state?.drives ?? {}
  const previous = state?.lastReview?.demand ?? {}
  const social = driveDemand(drives.social)
  const curiosity = driveDemand(drives.curiosity)
  const lines = [`【${REVIEW_HEADING} · 非主人发言】`]
  if (social === null) lines.push('唔……我现在的社交状态还不清楚，先不替自己下结论。')
  else lines.push(levelText(social, SOCIAL) + comparisonText(social, previous.social) + ownerText(state))
  if (curiosity === null) lines.push('我现在对新鲜事物有多好奇，也还不清楚，先不猜。')
  else lines.push(levelText(curiosity, CURIOSITY) + comparisonText(curiosity, previous.curiosity) + explorationText(state))
  if (curiosity !== null && curiosity > 0.05) lines.push('最近有没有什么让我在意、却还没看明白的东西呢……')
  lines.push('这些只是我此刻的念头，不急着非做点什么。想不出也没关系，发会儿呆嘛。🍚')
  return lines.join('\n\n')
}

export const REVIEW_HEADING = '大肥鱼的内心独白'
