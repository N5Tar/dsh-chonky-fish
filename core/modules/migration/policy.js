import { MAX_TIME_SCALE } from '../abs/clock.js'
import { ABS_DEFAULTS } from '../abs/config.js'
import { validRestTime } from '../abs/rest.js'
import { DEFAULT_CONFIG } from '../../contracts/spec.js'
import { validateSkillArchive } from '../skills/core.js'

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }) }

export const MIGRATION_FORMAT = 'chonkyfish-fishpack'
export const MIGRATION_VERSION = 1
export const MIGRATION_SECTIONS = Object.freeze(['identity', 'wallet', 'profile', 'diaries', 'skills', 'preferences'])

export function projectPreferences(config) {
  const source = object(config)
  if (!source) fail('INVALID_DATA')
  const has = (value, key) => Object.hasOwn(value, key)
  const group = (owner, key, fallback) => {
    if (!has(owner, key)) return fallback
    const value = object(owner[key])
    if (!value) fail('INVALID_DATA')
    return value
  }
  const boolean = (value, key, fallback) => {
    if (!has(value, key)) return fallback
    if (typeof value[key] !== 'boolean') fail('INVALID_DATA')
    return value[key]
  }
  const number = (value, key, fallback, min, max, integer = false) => {
    if (!has(value, key)) return fallback
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (integer && !Number.isSafeInteger(value[key])) || value[key] < min || value[key] > max) fail('INVALID_DATA')
    return value[key]
  }
  const diary = group(source, 'diary', DEFAULT_CONFIG.diary)
  const skills = group(source, 'skills', DEFAULT_CONFIG.skills)
  const eventEngine = group(source, 'eventEngine', DEFAULT_CONFIG.eventEngine)
  const perception = group(source, 'perception', DEFAULT_CONFIG.perception)
  const rawAbs = group(source, 'abs', ABS_DEFAULTS)
  const rest = group(rawAbs, 'restHours', ABS_DEFAULTS.restHours)
  const feedback = group(rawAbs, 'feedback', ABS_DEFAULTS.feedback)
  const rawDrives = group(rawAbs, 'drives', ABS_DEFAULTS.drives)
  const drives = {}
  for (const id of ['social', 'curiosity']) {
    const drive = group(rawDrives, id, ABS_DEFAULTS.drives[id])
    drives[id] = {
      initialSatisfaction: number(drive, 'initialSatisfaction', ABS_DEFAULTS.drives[id].initialSatisfaction, 0, 1),
      setpoint: number(drive, 'setpoint', ABS_DEFAULTS.drives[id].setpoint, 0.01, 1),
      decayPerHour: number(drive, 'decayPerHour', ABS_DEFAULTS.drives[id].decayPerHour, 0, 1),
    }
  }
  const start = has(rest, 'start') ? rest.start : ABS_DEFAULTS.restHours.start
  const end = has(rest, 'end') ? rest.end : ABS_DEFAULTS.restHours.end
  if (!validRestTime(start) || !validRestTime(end) || start === end) fail('INVALID_DATA')
  return {
    diary: {
      enabled: boolean(diary, 'enabled', DEFAULT_CONFIG.diary.enabled),
      maxContentChars: number(diary, 'maxContentChars', DEFAULT_CONFIG.diary.maxContentChars, 1000, 200000, true),
    },
    skills: { enabled: boolean(skills, 'enabled', DEFAULT_CONFIG.skills.enabled) },
    eventEngine: {
      enabled: boolean(eventEngine, 'enabled', DEFAULT_CONFIG.eventEngine.enabled),
      extractTickMs: number(eventEngine, 'extractTickMs', DEFAULT_CONFIG.eventEngine.extractTickMs, 1000, 60000, true),
      extractBatch: number(eventEngine, 'extractBatch', DEFAULT_CONFIG.eventEngine.extractBatch, 1, 10, true),
      maxRecordsPerTurn: number(eventEngine, 'maxRecordsPerTurn', DEFAULT_CONFIG.eventEngine.maxRecordsPerTurn, 50, 5000, true),
    },
    perception: {
      enabled: boolean(perception, 'enabled', DEFAULT_CONFIG.perception.enabled),
      rawTtlMs: number(perception, 'rawTtlMs', DEFAULT_CONFIG.perception.rawTtlMs, 930000, 3600000, true),
      summaryTtlMs: number(perception, 'summaryTtlMs', DEFAULT_CONFIG.perception.summaryTtlMs, 60000, 604800000, true),
    },
    abs: {
      timeScale: number(rawAbs, 'timeScale', ABS_DEFAULTS.timeScale, 0, MAX_TIME_SCALE),
      restHours: {
        enabled: boolean(rest, 'enabled', ABS_DEFAULTS.restHours.enabled), start, end,
      },
      reviewIntervalMinutes: number(rawAbs, 'reviewIntervalMinutes', ABS_DEFAULTS.reviewIntervalMinutes, 10, 120, true),
      reviewMinRealGapMinutes: number(rawAbs, 'reviewMinRealGapMinutes', ABS_DEFAULTS.reviewMinRealGapMinutes, 0, 1440),
      activationCooldownMinutes: number(rawAbs, 'activationCooldownMinutes', ABS_DEFAULTS.activationCooldownMinutes, 0, 1440),
      feedback: {
        ownerMessageGain: number(feedback, 'ownerMessageGain', ABS_DEFAULTS.feedback.ownerMessageGain, 0, 0.3),
        explorationGain: number(feedback, 'explorationGain', ABS_DEFAULTS.feedback.explorationGain, 0, 0.3),
      },
      drives,
    },
  }
}

export function validateIdentity(value) {
  const data = object(value)
  if (!data || Object.keys(data).some(key => !['name', 'prompt'].includes(key))) fail('INVALID_DATA')
  if (typeof data.name !== 'string' || data.name.length > 200 || typeof data.prompt !== 'string' || data.prompt.length > 50000) fail('INVALID_DATA')
  return { name: data.name, prompt: data.prompt }
}

export function validateWallet(value) {
  const data = object(value)
  if (!data || Object.keys(data).some(key => !['balance', 'ledger'].includes(key))) fail('INVALID_DATA')
  if (typeof data.balance !== 'number' || !Number.isFinite(data.balance) || data.balance < 0 || !Array.isArray(data.ledger) || data.ledger.length > 100000) fail('INVALID_DATA')
  const seen = new Set()
  const ledger = data.ledger.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'title', 'amount', 'date'].includes(key))) fail('INVALID_DATA')
    if (!(typeof item.id === 'string' || Number.isSafeInteger(item.id)) || seen.has(String(item.id)) || typeof item.title !== 'string' || item.title.length > 500 || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || typeof item.date !== 'string' || item.date.length > 200) fail('INVALID_DATA')
    seen.add(String(item.id))
    return { id: item.id, title: item.title, amount: item.amount, date: item.date }
  })
  return { balance: data.balance, ledger }
}

export function validatePreferences(value) {
  const exact = (item, keys) => Boolean(item && Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key)))
  const numberIn = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
  const data = object(value)
  if (!exact(data, ['diary', 'skills', 'eventEngine', 'perception', 'abs'])) fail('INVALID_DATA')
  const specs = {
    diary: { keys: ['enabled', 'maxContentChars'], ranges: { maxContentChars: [1000, 200000] } },
    skills: { keys: ['enabled'], ranges: {} },
    eventEngine: { keys: ['enabled', 'extractTickMs', 'extractBatch', 'maxRecordsPerTurn'], ranges: { extractTickMs: [1000, 60000], extractBatch: [1, 10], maxRecordsPerTurn: [50, 5000] } },
    perception: { keys: ['enabled', 'rawTtlMs', 'summaryTtlMs'], ranges: { rawTtlMs: [930000, 3600000], summaryTtlMs: [60000, 604800000] } },
  }
  for (const [group, spec] of Object.entries(specs)) {
    const item = object(data[group])
    if (!exact(item, spec.keys) || typeof item.enabled !== 'boolean') fail('INVALID_DATA')
    for (const [key, [min, max]] of Object.entries(spec.ranges)) if (!Number.isSafeInteger(item[key]) || item[key] < min || item[key] > max) fail('INVALID_DATA')
  }
  const abs = object(data.abs)
  const absKeys = ['timeScale', 'restHours', 'reviewIntervalMinutes', 'reviewMinRealGapMinutes', 'activationCooldownMinutes', 'feedback', 'drives']
  if (!exact(abs, absKeys) || !numberIn(abs.timeScale, 0, MAX_TIME_SCALE) || !Number.isSafeInteger(abs.reviewIntervalMinutes) || abs.reviewIntervalMinutes < 10 || abs.reviewIntervalMinutes > 120 || !numberIn(abs.reviewMinRealGapMinutes, 0, 1440) || !numberIn(abs.activationCooldownMinutes, 0, 1440)) fail('INVALID_DATA')
  const restHours = object(abs.restHours)
  if (!exact(restHours, ['enabled', 'start', 'end']) || typeof restHours.enabled !== 'boolean' || !validRestTime(restHours.start) || !validRestTime(restHours.end) || restHours.start === restHours.end) fail('INVALID_DATA')
  const feedback = object(abs.feedback)
  if (!exact(feedback, ['ownerMessageGain', 'explorationGain']) || !numberIn(feedback.ownerMessageGain, 0, 0.3) || !numberIn(feedback.explorationGain, 0, 0.3)) fail('INVALID_DATA')
  const drives = object(abs.drives)
  if (!exact(drives, ['social', 'curiosity'])) fail('INVALID_DATA')
  for (const id of ['social', 'curiosity']) {
    const drive = object(drives[id])
    if (!exact(drive, ['initialSatisfaction', 'setpoint', 'decayPerHour']) || !numberIn(drive.initialSatisfaction, 0, 1) || !numberIn(drive.setpoint, 0.01, 1) || !numberIn(drive.decayPerHour, 0, 1)) fail('INVALID_DATA')
  }
  return projectPreferences({ ...data, abs })
}

export function mergeMigrationPreferences(current, incoming) {
  const target = object(current) || {}
  const next = { ...target }
  for (const key of ['diary', 'skills', 'eventEngine', 'perception']) next[key] = { ...(object(target[key]) || {}), ...(object(incoming[key]) || {}) }
  next.perception.enabled = false
  const oldAbs = object(target.abs) || {}
  const newAbs = object(incoming.abs) || {}
  next.abs = { ...oldAbs, ...newAbs, mode: 'shadow' }
  next.proactive = { ...(object(target.proactive) || {}), enabled: false }
  return next
}

export function validateDiaryPath(name) {
  if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) fail('UNSAFE_PATH')
  const date = name.slice(0, 10)
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('INVALID_DATA')
  return date
}

export function assertSkillArchive(value) {
  const data = object(value)
  if (!data || !Number.isSafeInteger(data.format) || typeof data.skillId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(data.skillId) || !Array.isArray(data.snapshots) || data.snapshots.length > 64) fail('INVALID_DATA')
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 512 * 1024) fail('LIMIT_EXCEEDED')
  try { return validateSkillArchive(data) } catch { fail('INVALID_DATA') }
}

export { fail as migrationFail }
