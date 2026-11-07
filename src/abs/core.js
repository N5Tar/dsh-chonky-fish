import { ABS_DEFAULTS as DEFAULT_CONFIG } from './config.js'
export { DEFAULT_CONFIG }

// All public time arguments accept an ISO timestamp or epoch milliseconds.
// Mutators edit the supplied state; math and scheduling queries are pure.
const HOUR = 3600000
const MINUTE = 60000
const MAX_IDS = 10000
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value))
export const demand = (drive) => clamp((drive.setpoint - drive.satisfaction) / drive.setpoint)

function time(value) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(numeric)) throw new TypeError('ABS requires a valid ISO time or epoch milliseconds')
  return numeric
}
const iso = (numeric) => new Date(numeric).toISOString()

export function createState(now, config = {}) {
  const at = iso(time(now))
  const drives = {}
  for (const id of ['social', 'curiosity']) {
    const source = { ...DEFAULT_CONFIG.drives[id], ...config.drives?.[id] }
    if (!(source.setpoint > 0 && source.setpoint <= 1) || !(source.decayPerHour >= 0) || !Number.isFinite(source.decayPerHour) || !(source.initialSatisfaction >= 0 && source.initialSatisfaction <= 1)) throw new TypeError('Invalid drive configuration')
    drives[id] = { id, satisfaction: source.initialSatisfaction, setpoint: source.setpoint, decayPerHour: source.decayPerHour, updatedAt: at }
    drives[id].demand = demand(drives[id])
  }
  return {
    schemaVersion: 1, revision: 0, mode: config.mode ?? DEFAULT_CONFIG.mode,
    createdAt: at, updatedAt: at, drives,
    motivations: [], executions: [], history: [], proposalIds: [], feedbackKeys: [],
    observations: [], budget: { day: at.slice(0, 10), llmCalls: 0 },
    lastReview: null, lastOwnerMessage: null, lastExploration: null, nextWakeAt: null,
  }
}

export function updateState(state, now, config = {}) {
  const at = Math.max(time(now), time(state.updatedAt))
  for (const drive of Object.values(state.drives)) {
    drive.satisfaction = clamp(drive.satisfaction - drive.decayPerHour * Math.max(0, at - time(drive.updatedAt)) / HOUR)
    drive.updatedAt = iso(at)
    drive.demand = demand(drive)
  }
  state.updatedAt = iso(at)
  state.revision += 1
  return state
}

/** Next review deadline in ABS time. Interval is bounded to 10–120 ABS minutes. */
export function nextReviewAt(state, now, config = {}) {
  const at = time(now)
  const minutes = clamp(Number(config.reviewIntervalMinutes ?? DEFAULT_CONFIG.reviewIntervalMinutes), 10, 120)
  return iso(at + minutes * MINUTE)
}

/**
 * Apply objective feedback once per dedupe key.
 * @returns {{ driveId: string, delta: number, effectKey: string } | null}
 */
export function applyFeedback(state, { driveId, delta, key, at, config = {} }) {
  if (!state?.drives?.[driveId]) return null
  if (typeof key !== 'string' || key === '' || state.feedbackKeys.includes(key)) return null
  if (!Number.isFinite(delta) || delta <= 0) return null
  if (state.feedbackKeys.length >= MAX_IDS) return null
  updateState(state, at, config)
  const drive = state.drives[driveId]
  drive.satisfaction = clamp(drive.satisfaction + Math.min(0.5, delta))
  drive.demand = demand(drive)
  drive.lastFeedbackAt = state.updatedAt
  state.feedbackKeys.push(key)
  return { driveId, delta: Math.min(0.5, delta), effectKey: key }
}

export const CORE_LIMITS = Object.freeze({ maxDedupeIds: MAX_IDS, maxObservations: 200 })
