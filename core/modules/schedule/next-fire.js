/**
 * 日程下次触发时刻（纯函数）。时区用 Intl.DateTimeFormat，禁止 getTimezoneOffset。
 */

import { isValidClock, isValidIsoInstant, isValidTimeZone } from './schema.js'

const WEEKDAY = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
})

const partCache = new Map()

function formatter(timeZone) {
  let fmt = partCache.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    partCache.set(timeZone, fmt)
  }
  return fmt
}

/** @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number } | null} */
export function zonedParts(ms, timeZone) {
  if (!Number.isFinite(ms) || !isValidTimeZone(timeZone)) return null
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return null
  const parts = {}
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  const hour = parts.hour === '24' ? 0 : Number(parts.hour)
  const weekday = WEEKDAY[parts.weekday]
  if (!Number.isInteger(weekday)) return null
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday,
  }
}

/**
 * 将 timeZone 下的墙钟组件转为 UTC 毫秒。
 * 用「当作 UTC 的数字 − 该瞬间的时区偏移」迭代收敛。
 */
export function zonedTimeToUtc(year, month, day, hour, minute, timeZone, second = 0) {
  if (!isValidTimeZone(timeZone)) return NaN
  let utc = Date.UTC(year, month - 1, day, hour, minute, second)
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(utc, timeZone)
    if (!parts) return NaN
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const want = Date.UTC(year, month - 1, day, hour, minute, second)
    const delta = want - asUtc
    if (delta === 0) return utc
    utc += delta
  }
  const verify = zonedParts(utc, timeZone)
  if (
    !verify ||
    verify.year !== year ||
    verify.month !== month ||
    verify.day !== day ||
    verify.hour !== hour ||
    verify.minute !== minute
  ) {
    return NaN
  }
  return utc
}

function addCalendarDays(year, month, day, delta) {
  const utc = Date.UTC(year, month - 1, day) + delta * 86400000
  return {
    year: new Date(utc).getUTCFullYear(),
    month: new Date(utc).getUTCMonth() + 1,
    day: new Date(utc).getUTCDate(),
  }
}

/**
 * @param {{ recurrence: string, at: string, timezone: string, daysOfWeek?: number[] }} item
 * @param {number|string|Date} fromInstant
 * @returns {string|null} ISO UTC or null
 */
export function computeNextFireAt(item, fromInstant) {
  const fromMs = typeof fromInstant === 'number' ? fromInstant : Date.parse(String(fromInstant))
  if (!Number.isFinite(fromMs)) return null
  const timeZone = item.timezone
  if (!isValidTimeZone(timeZone)) return null

  if (item.recurrence === 'once') {
    if (!isValidIsoInstant(item.at)) return null
    const atMs = Date.parse(item.at)
    return atMs > fromMs ? new Date(atMs).toISOString() : null
  }

  if (!isValidClock(item.at)) return null
  const [hh, mm] = item.at.split(':').map(Number)
  const local = zonedParts(fromMs, timeZone)
  if (!local) return null

  if (item.recurrence === 'daily') {
    let y = local.year
    let m = local.month
    let d = local.day
    let candidate = zonedTimeToUtc(y, m, d, hh, mm, timeZone)
    if (!(candidate > fromMs)) {
      const next = addCalendarDays(y, m, d, 1)
      candidate = zonedTimeToUtc(next.year, next.month, next.day, hh, mm, timeZone)
    }
    return Number.isFinite(candidate) ? new Date(candidate).toISOString() : null
  }

  if (item.recurrence === 'weekly') {
    const days = Array.isArray(item.daysOfWeek) ? [...new Set(item.daysOfWeek)].filter((d) => d >= 0 && d <= 6) : []
    if (days.length === 0) return null
    days.sort((a, b) => a - b)
    for (let offset = 0; offset <= 14; offset++) {
      const cal = addCalendarDays(local.year, local.month, local.day, offset)
      const candidate = zonedTimeToUtc(cal.year, cal.month, cal.day, hh, mm, timeZone)
      if (!Number.isFinite(candidate) || !(candidate > fromMs)) continue
      const parts = zonedParts(candidate, timeZone)
      if (parts && days.includes(parts.weekday)) return new Date(candidate).toISOString()
    }
    return null
  }

  return null
}

/** 解析工具入参 once：本地墙钟 YYYY-MM-DDTHH:mm + timezone → UTC ISO；或已是 ISO。 */
export function parseOnceAt(at, timeZone) {
  if (typeof at !== 'string' || !at.trim()) return null
  const trimmed = at.trim()
  if (isValidIsoInstant(trimmed)) return new Date(Date.parse(trimmed)).toISOString()
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(trimmed)
  if (!local || !isValidTimeZone(timeZone)) return null
  const y = Number(local[1])
  const m = Number(local[2])
  const d = Number(local[3])
  const h = Number(local[4])
  const min = Number(local[5])
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59) return null
  const ms = zonedTimeToUtc(y, m, d, h, min, timeZone)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}
