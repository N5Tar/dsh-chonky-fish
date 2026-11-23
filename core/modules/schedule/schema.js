/**
 * 大肥鱼内部日程 · 常量、错误码、文档校验。
 */

export const SCHEDULE_SCHEMA_VERSION = 1
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'
export const DELIVERY_SESSION = 'session'

export const SCHEDULE_LIMITS = Object.freeze({
  maxItems: 50,
  maxTitleChars: 80,
  maxPromptChars: 2000,
  maxScanDeliveries: 5,
  scanContinueMs: 5000,
  maxFireRecords: 200,
  maxBackoffAccumMs: 30 * 60 * 1000,
  backoffStepsMs: Object.freeze([60e3, 120e3, 300e3, 600e3, 900e3]),
  maxTimerMs: 2 ** 31 - 1,
})

export const FIRE_OUTCOMES = Object.freeze([
  'delivered',
  'skipped_busy',
  'skipped_no_session',
  'flush_failed',
  'skipped_missed_on_boot',
  'dropped_crossed_slot',
])

export const ERROR_CODES = Object.freeze({
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  ONCE_IN_PAST: 'ONCE_IN_PAST',
  LIMIT_REACHED: 'LIMIT_REACHED',
  DISABLED: 'DISABLED',
  INTERNAL: 'INTERNAL',
  CORRUPT: 'CORRUPT',
})

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

export function scheduleError(code, message, extra) {
  const error = new Error(message || code)
  error.code = code
  if (extra && typeof extra === 'object') Object.assign(error, extra)
  return error
}

export function emptyScheduleDoc(timezoneDefault = DEFAULT_TIMEZONE) {
  return {
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    timezoneDefault: timezoneDefault || DEFAULT_TIMEZONE,
    items: [],
    fires: [],
  }
}

export function isValidClock(value) {
  return typeof value === 'string' && CLOCK.test(value)
}

export function isValidIsoInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return false
  const ms = Date.parse(value)
  return Number.isFinite(ms)
}

export function isValidTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date())
    return true
  } catch {
    return false
  }
}

export function normalizeDaysOfWeek(value) {
  if (!Array.isArray(value) || value.length === 0) return null
  const set = new Set()
  for (const day of value) {
    if (!Number.isInteger(day) || day < 0 || day > 6) return null
    set.add(day)
  }
  return [...set].sort((a, b) => a - b)
}

export function validateScheduleDoc(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw scheduleError(ERROR_CODES.CORRUPT, 'schedule.json root must be an object')
  }
  if (raw.schemaVersion !== SCHEDULE_SCHEMA_VERSION) {
    throw scheduleError(ERROR_CODES.CORRUPT, 'unsupported schedule schemaVersion')
  }
  if (!isValidTimeZone(raw.timezoneDefault)) {
    throw scheduleError(ERROR_CODES.CORRUPT, 'invalid timezoneDefault')
  }
  if (!Array.isArray(raw.items) || !Array.isArray(raw.fires)) {
    throw scheduleError(ERROR_CODES.CORRUPT, 'items/fires must be arrays')
  }
  if (raw.items.length > SCHEDULE_LIMITS.maxItems) {
    throw scheduleError(ERROR_CODES.CORRUPT, 'too many schedule items')
  }
  const items = raw.items.map((item, index) => validateItem(item, index, raw.timezoneDefault))
  const fires = raw.fires.map((fire, index) => validateFire(fire, index))
  return {
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    timezoneDefault: raw.timezoneDefault,
    items,
    fires,
  }
}

function validateItem(item, index, timezoneDefault) {
  if (!item || typeof item !== 'object') throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] invalid`)
  const id = String(item.id || '')
  if (!id) throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] missing id`)
  if (!Number.isInteger(item.version) || item.version < 1) {
    throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] bad version`)
  }
  if (typeof item.enabled !== 'boolean') throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] enabled`)
  if (typeof item.title !== 'string' || item.title.length === 0 || item.title.length > SCHEDULE_LIMITS.maxTitleChars) {
    throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] title`)
  }
  if (typeof item.prompt !== 'string' || item.prompt.length === 0 || item.prompt.length > SCHEDULE_LIMITS.maxPromptChars) {
    throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] prompt`)
  }
  if (item.delivery !== DELIVERY_SESSION) throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] delivery`)
  const recurrence = item.recurrence
  if (recurrence !== 'once' && recurrence !== 'daily' && recurrence !== 'weekly') {
    throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] recurrence`)
  }
  const timezone = item.timezone || timezoneDefault
  if (!isValidTimeZone(timezone)) throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] timezone`)
  if (recurrence === 'once') {
    if (!isValidIsoInstant(item.at)) throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] once at`)
  } else if (!isValidClock(item.at)) {
    throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] clock at`)
  }
  let daysOfWeek
  if (recurrence === 'weekly') {
    daysOfWeek = normalizeDaysOfWeek(item.daysOfWeek)
    if (!daysOfWeek) throw scheduleError(ERROR_CODES.CORRUPT, `item[${index}] daysOfWeek`)
  }
  return {
    id,
    version: item.version,
    enabled: item.enabled,
    title: item.title,
    prompt: item.prompt,
    delivery: DELIVERY_SESSION,
    recurrence,
    at: item.at,
    timezone,
    ...(daysOfWeek ? { daysOfWeek } : {}),
    nextFireAt: item.nextFireAt == null ? null : String(item.nextFireAt),
    lastFiredAt: item.lastFiredAt == null ? null : String(item.lastFiredAt),
    activeFireId: item.activeFireId == null ? null : String(item.activeFireId),
    backoffUntil: item.backoffUntil == null ? null : String(item.backoffUntil),
    backoffStep: Number.isInteger(item.backoffStep) ? item.backoffStep : 0,
    backoffOriginAt: item.backoffOriginAt == null ? null : String(item.backoffOriginAt),
    createdAt: String(item.createdAt || ''),
    updatedAt: String(item.updatedAt || ''),
  }
}

function validateFire(fire, index) {
  if (!fire || typeof fire !== 'object') throw scheduleError(ERROR_CODES.CORRUPT, `fire[${index}]`)
  if (typeof fire.fireId !== 'string' || typeof fire.scheduleId !== 'string') {
    throw scheduleError(ERROR_CODES.CORRUPT, `fire[${index}] ids`)
  }
  if (!FIRE_OUTCOMES.includes(fire.outcome)) throw scheduleError(ERROR_CODES.CORRUPT, `fire[${index}] outcome`)
  return {
    fireId: fire.fireId,
    scheduleId: fire.scheduleId,
    attemptedAt: String(fire.attemptedAt || ''),
    outcome: fire.outcome,
  }
}

/**
 * @returns {{ fires: object[], overflow: boolean }}
 */
export function appendFireRecord(doc, record) {
  const fires = [...doc.fires, record]
  const protectedKeys = new Set()
  for (const item of doc.items) {
    if (item.activeFireId) protectedKeys.add(`${item.id}\0${item.activeFireId}`)
  }
  let overflow = false
  while (fires.length > SCHEDULE_LIMITS.maxFireRecords) {
    const idx = fires.findIndex((fire) => !protectedKeys.has(`${fire.scheduleId}\0${fire.fireId}`))
    if (idx < 0) {
      overflow = true
      break
    }
    fires.splice(idx, 1)
  }
  return { fires, overflow }
}

export function alreadyDelivered(doc, scheduleId, fireId) {
  return doc.fires.some(
    (fire) => fire.scheduleId === scheduleId && fire.fireId === fireId && fire.outcome === 'delivered',
  )
}

export function clearFireFields(item) {
  return {
    ...item,
    activeFireId: null,
    backoffUntil: null,
    backoffStep: 0,
    backoffOriginAt: null,
  }
}

export function toPublicError(error) {
  const code = error && typeof error.code === 'string' && Object.values(ERROR_CODES).includes(error.code)
    ? error.code
    : ERROR_CODES.INTERNAL
  const message =
    code === ERROR_CODES.INTERNAL
      ? '日程操作失败'
      : String((error && error.message) || code)
  return { code, message }
}

export function scheduleSource(item) {
  return {
    kind: 'chonkyfish-schedule',
    form: 'notice',
    scheduleId: item.id,
    fireId: item.activeFireId,
    title: item.title,
  }
}
