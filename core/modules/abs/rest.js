// Daily rest follows fixed UTC+8 wall time, never accelerated time.
const MINUTE = 60000, DAY = 86400000, OFFSET = 8 * 3600000
export const REST_DEFAULTS = Object.freeze({ enabled: true, start: '23:00', end: '08:00' })
export const validRestTime = (value) => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
export function sanitizeRestHours(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const start = validRestTime(source.start) ? source.start : REST_DEFAULTS.start
  const end = validRestTime(source.end) ? source.end : REST_DEFAULTS.end
  return { enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
    start: start === end ? REST_DEFAULTS.start : start,
    end: start === end ? REST_DEFAULTS.end : end }
}
export function restWindow(realMs, raw) {
  if (!Number.isFinite(realMs)) throw new TypeError('Invalid real time')
  const cfg = sanitizeRestHours(raw)
  const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  const start = minutes(cfg.start), end = minutes(cfg.end)
  const localDay = Math.floor((realMs + OFFSET) / DAY) * DAY - OFFSET
  const position = (realMs - localDay) / MINUTE
  const resting = cfg.enabled && (start < end ? position >= start && position < end : position >= start || position < end)
  const resumeAt = resting ? localDay + end * MINUTE + (start > end && position >= start ? DAY : 0) : null
  return { ...cfg, timeZone: 'Asia/Shanghai', resting, resumeAt: resumeAt === null ? null : new Date(resumeAt).toISOString() }
}
export function nextAwakeTime(realMs, cfg) {
  const window = restWindow(realMs, cfg)
  return window.resting ? Date.parse(window.resumeAt) : realMs
}
