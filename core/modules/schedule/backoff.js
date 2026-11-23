/**
 * 短退避与跨槽丢弃（纯函数）。
 */

import { SCHEDULE_LIMITS, clearFireFields } from './schema.js'
import { computeNextFireAt } from './next-fire.js'

/**
 * @param {object} item
 * @param {number} nowMs
 * @param {string} outcome
 * @returns {{ item: object, dropped: boolean, fireExtra?: { outcome: string } }}
 */
export function applyTransientSkip(item, nowMs, outcome) {
  const steps = SCHEDULE_LIMITS.backoffStepsMs
  const nowIso = new Date(nowMs).toISOString()
  let next = {
    ...item,
    backoffOriginAt: item.backoffOriginAt || nowIso,
  }
  const originMs = Date.parse(next.backoffOriginAt)
  const accum = nowMs - originMs
  const stepIndex = Math.min(Math.max(0, next.backoffStep | 0), steps.length - 1)
  const nextBackoffMs = nowMs + steps[stepIndex]
  const slotEndMs = logicalSlotEndMs(next, nowMs)

  const overAccum = accum >= SCHEDULE_LIMITS.maxBackoffAccumMs
  const crossSlot = Number.isFinite(slotEndMs) && nextBackoffMs >= slotEndMs

  if (overAccum || crossSlot) {
    return {
      item: dropCurrentSlot(next, nowMs),
      dropped: true,
      fireExtra: { outcome: 'dropped_crossed_slot' },
      skipOutcome: outcome,
    }
  }

  next = {
    ...next,
    backoffUntil: new Date(nextBackoffMs).toISOString(),
    backoffStep: (next.backoffStep | 0) + 1,
  }
  return { item: next, dropped: false, skipOutcome: outcome }
}

/** 当前槽应到点 T 的下一逻辑槽终点（毫秒）；once 为 origin+30m。 */
export function logicalSlotEndMs(item, nowMs) {
  if (item.recurrence === 'once') {
    const origin = item.backoffOriginAt ? Date.parse(item.backoffOriginAt) : nowMs
    return origin + SCHEDULE_LIMITS.maxBackoffAccumMs
  }
  const t = item.nextFireAt ? Date.parse(item.nextFireAt) : nowMs
  if (!Number.isFinite(t)) return NaN
  const next = computeNextFireAt(item, t)
  return next ? Date.parse(next) : NaN
}

export function dropCurrentSlot(item, nowMs) {
  let next = clearFireFields(item)
  if (item.recurrence === 'once') {
    return { ...next, enabled: false, nextFireAt: null }
  }
  const anchor = item.nextFireAt ? Date.parse(item.nextFireAt) : nowMs
  const nextFire = computeNextFireAt(item, Number.isFinite(anchor) ? anchor : nowMs)
  return { ...next, nextFireAt: nextFire }
}
