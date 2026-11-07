// ABS self-review defaults. Numerical policy changes must receive a new policy version.
import { MAX_TIME_SCALE } from './clock.js'
import { REST_DEFAULTS, sanitizeRestHours } from './rest.js'
export const ABS_DEFAULTS = Object.freeze({
  mode: 'shadow', timeScale: 1,
  restHours: REST_DEFAULTS,
  reviewIntervalMinutes: 120,
  reviewMinRealGapMinutes: 10,
  activationCooldownMinutes: 60,
  policyVersion: 'abs-self-review-v1',
  feedback: Object.freeze({ ownerMessageGain: 0.05, explorationGain: 0.15 }),
  drives: {
    social: { initialSatisfaction: 0.55, setpoint: 0.75, decayPerHour: 0.008 },
    curiosity: { initialSatisfaction: 0.35, setpoint: 0.70, decayPerHour: 0.004 },
  },
})
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const number = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

export function sanitizeAbsConfig(raw) {
  const source = object(raw), defaults = ABS_DEFAULTS
  const result = {
    ...defaults,
    mode: ['off', 'shadow', 'active'].includes(source.mode) ? source.mode : defaults.mode,
    policyVersion: defaults.policyVersion,
    restHours: sanitizeRestHours(source.restHours),
  }
  for (const [key, min, max] of [
    ['timeScale', 0, MAX_TIME_SCALE],
    ['reviewIntervalMinutes', 10, 120],
    ['reviewMinRealGapMinutes', 0, 1440],
    ['activationCooldownMinutes', 0, 1440],
  ]) result[key] = number(source[key], defaults[key], min, max)
  result.reviewIntervalMinutes = Math.round(result.reviewIntervalMinutes)
  const feedback = object(source.feedback)
  result.feedback = {
    ownerMessageGain: number(feedback.ownerMessageGain, defaults.feedback.ownerMessageGain, 0, 0.3),
    explorationGain: number(feedback.explorationGain, defaults.feedback.explorationGain, 0, 0.3),
  }
  result.drives = {}
  for (const id of ['social', 'curiosity']) {
    const drive = object(object(source.drives)[id]), base = defaults.drives[id]
    result.drives[id] = {
      initialSatisfaction: number(drive.initialSatisfaction, base.initialSatisfaction, 0, 1),
      setpoint: number(drive.setpoint, base.setpoint, 0.01, 1),
      decayPerHour: number(drive.decayPerHour, base.decayPerHour, 0, 1),
    }
  }
  return result
}

export function mergeAbsConfig(current, patch) {
  const source = object(patch), before = sanitizeAbsConfig(current), drives = object(source.drives), feedback = object(source.feedback)
  return sanitizeAbsConfig({
    ...before,
    ...source,
    drives: {
      social: { ...before.drives.social, ...object(drives.social) },
      curiosity: { ...before.drives.curiosity, ...object(drives.curiosity) },
    },
    feedback: { ...before.feedback, ...feedback },
    restHours: { ...before.restHours, ...object(source.restHours) },
  })
}
