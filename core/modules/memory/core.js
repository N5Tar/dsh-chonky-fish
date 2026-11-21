/**
 * 活跃会话索引的纯逻辑。
 * 不读 ctx、不写盘：活动判定、Asia/Shanghai 分日、索引解析与合并。
 */

const ACTIVITY_TYPES = new Set(['user/message', 'assistant/message'])

const clockPattern = /^(\d{2}):(\d{2})$/

const shanghaiFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function isValidClock(value) {
  const match = clockPattern.exec(value)
  if (!match) return false
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
}

/** 完整 sessionId。不含换行或分隔符，避免和索引行混在一起。 */
export function isValidSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\r\n|]/.test(value)
}

/**
 * 追加的 user/message 或 assistant/message 才算活动。
 * 不看来源、正文或附件；替换和其它事件类型都不算。
 */
export function isActivityEvent(event) {
  if (!event || typeof event !== 'object') return false
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return false
  return ACTIVITY_TYPES.has(event.type)
}

/** event.time 毫秒时间戳 → Asia/Shanghai 的日期和分钟。非法时间返回 null。 */
export function shanghaiStamp(time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return null
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return null
  const parts = {}
  for (const part of shanghaiFormat.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  const hour = parts.hour === '24' ? '00' : parts.hour
  const clock = `${hour}:${parts.minute}`
  if (!/^\d{4}$/.test(parts.year || '') || !/^\d{2}$/.test(parts.month || '') || !/^\d{2}$/.test(parts.day || '') || !isValidClock(clock)) return null
  return { date: `${parts.year}-${parts.month}-${parts.day}`, clock }
}

function headerLine(date) {
  return `# ${date} 活跃会话（Asia/Shanghai）`
}

function compareEntries(left, right) {
  if (left.first !== right.first) return left.first < right.first ? -1 : 1
  if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1
  return 0
}

export function renderSessionIndex(date, entries) {
  const lines = [headerLine(date)]
  for (const entry of [...entries].sort(compareEntries)) {
    lines.push(`- ${entry.sessionId} | 首次 ${entry.first} | 最近 ${entry.last}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * 只接受本模块写出的索引。缺行、重复、时间倒挂都视为损坏，调用方不得覆盖原文件。
 * @returns {{ ok: true, entries: { sessionId: string, first: string, last: string }[] } | { ok: false, reason: string }}
 */
export function parseSessionIndex(text, date) {
  if (typeof text !== 'string' || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: 'unreadable' }
  const normalized = text.replace(/\r\n/g, '\n')
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  if (body === '') return { ok: false, reason: 'empty' }
  const lines = body.split('\n')
  if (lines[0] !== headerLine(date)) return { ok: false, reason: 'header' }
  const entries = []
  const seen = new Set()
  for (const line of lines.slice(1)) {
    const match = /^- (.*) \| 首次 (\d{2}:\d{2}) \| 最近 (\d{2}:\d{2})$/.exec(line)
    if (!match) return { ok: false, reason: 'line' }
    const sessionId = match[1]
    const first = match[2]
    const last = match[3]
    if (!isValidSessionId(sessionId) || !isValidClock(first) || !isValidClock(last) || first > last || seen.has(sessionId)) {
      return { ok: false, reason: 'line' }
    }
    seen.add(sessionId)
    entries.push({ sessionId, first, last })
  }
  return { ok: true, entries }
}

/**
 * 把一条活动并进已有正文。existing 为 null 表示文件不存在。
 * 损坏时不返回可写正文。
 */
export function applySessionActivity(existing, date, sessionId, clock) {
  if (!isValidSessionId(sessionId) || !isValidClock(clock)) return { ok: false, reason: 'activity' }
  let entries = []
  if (existing !== null && existing !== undefined) {
    const parsed = parseSessionIndex(existing, date)
    if (!parsed.ok) return parsed
    entries = parsed.entries.map(entry => ({ ...entry }))
  }
  const found = entries.find(entry => entry.sessionId === sessionId)
  if (!found) entries.push({ sessionId, first: clock, last: clock })
  else {
    if (clock < found.first) found.first = clock
    if (clock > found.last) found.last = clock
  }
  const text = renderSessionIndex(date, entries)
  const comparable = typeof existing === 'string' ? existing.replace(/\r\n/g, '\n') : existing
  return { ok: true, changed: comparable !== text, text }
}

export function parseSkillDocument(text) {
  if (typeof text !== 'string') return null
  const match = /^---\r?\nname:\s*(.+)\r?\ndescription:\s*(.+)\r?\n---\r?\n/.exec(text)
  if (!match) return null
  const name = match[1].trim()
  const description = match[2].trim()
  if (!name || !description) return null
  return { name, description, content: text }
}
