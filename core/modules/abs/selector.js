export const ABS_ACTION_POLICY = Object.freeze({
  workStreakMinimumMs: 60 * 60_000,
  workSampleFreshnessMs: 20_000,
  minimumGap: 0.65,
  restBaseScore: 0.7,
  restRampMs: 30 * 60_000,
  explorationScoreFactor: 0.8,
})
const MINUTE = 60_000
const MAX_WORK_SAMPLE_AGE_MS = ABS_ACTION_POLICY.workSampleFreshnessMs

const PRIORITY = Object.freeze({ remind_rest: 3, continue_interest: 2, chat_owner: 1 })
const finiteTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
const result = (intent, score, reason, extra = {}) => ({ intent, score, reason, ...extra })

function resolvePolicy(override) {
  const source = override && typeof override === 'object' && !Array.isArray(override) ? override : {}
  const minimumGap = typeof source.minimumGap === 'number' && Number.isFinite(source.minimumGap)
    ? Math.min(1, Math.max(0, source.minimumGap)) : ABS_ACTION_POLICY.minimumGap
  const explorationScoreFactor = typeof source.explorationScoreFactor === 'number' && Number.isFinite(source.explorationScoreFactor)
    ? Math.min(2, Math.max(0, source.explorationScoreFactor)) : ABS_ACTION_POLICY.explorationScoreFactor
  return { minimumGap, explorationScoreFactor }
}

/**
 * Pure single-intent selector. The activity repository records one stable
 * dispatch lifecycle row per review; it does not apply action quotas or cadence gates.
 *
 * @param {{now:number, mode:string, currentSessionId:string|null,
 *   ownerInteraction:{sessionId:string,realAt:string,sourceKind:'user'}|null, socialGap:number|null,
 *   curiosityGap:number|null,
 *   workStreak:{id:string,startedAt:string,observedThrough:string,workMinutes:number}|null,
 *   remindedWorkStreakIds:string[],
 *   policy?:{minimumGap?:number, explorationScoreFactor?:number}}} input
 */
export function selectAbsAction(input) {
  if (!input || !Number.isFinite(input.now) || !['off','shadow','active'].includes(input.mode)) throw new TypeError('Invalid ABS selector input')
  if (input.mode === 'off') return result(null, null, 'mode_off')
  if (typeof input.currentSessionId !== 'string' || !input.currentSessionId) return result(null, null, 'owner_session_unavailable')
  const policy = resolvePolicy(input.policy)
  const candidates = []
  const blocked = []
  const gap = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null

  const streak = input.workStreak
  const started = finiteTime(streak?.startedAt)
  const observedThrough = finiteTime(streak?.observedThrough)
  const streakFresh = observedThrough != null && observedThrough <= input.now && input.now - observedThrough <= MAX_WORK_SAMPLE_AGE_MS
  const streakMinutes = Number.isFinite(streak?.workMinutes) ? streak.workMinutes : 0
  const measuredMinutes = started != null && observedThrough != null ? (observedThrough - started) / MINUTE : 0
  const workStreakValid = typeof streak?.id === 'string' && streak.id.length > 0 && started != null && observedThrough != null
    && started <= observedThrough && streakFresh && streakMinutes >= ABS_ACTION_POLICY.workStreakMinimumMs / MINUTE
    && measuredMinutes * MINUTE >= ABS_ACTION_POLICY.workStreakMinimumMs
  if (workStreakValid) {
    if ((input.remindedWorkStreakIds ?? []).includes(streak.id)) blocked.push({ intent: 'remind_rest', reason: 'work_streak_already_reminded' })
    else candidates.push({ intent: 'remind_rest', score: ABS_ACTION_POLICY.restBaseScore
      + (1 - ABS_ACTION_POLICY.restBaseScore) * Math.min((streakMinutes - 60) / (ABS_ACTION_POLICY.restRampMs / MINUTE), 1), workStreakId: streak.id, workMinutes: streakMinutes })
  } else blocked.push({ intent: 'remind_rest', reason: 'work_streak_missing_or_unverified' })

  const curiosityGap = gap(input.curiosityGap)
  if (curiosityGap == null || curiosityGap < policy.minimumGap) blocked.push({ intent: 'continue_interest', reason: 'gap_below_threshold' })
  else candidates.push({ intent: 'continue_interest', score: policy.explorationScoreFactor * curiosityGap })

  const socialGap = gap(input.socialGap)
  const interaction = input.ownerInteraction
  const interactionAt = finiteTime(interaction?.realAt)
  if (typeof input.currentSessionId !== 'string' || !input.currentSessionId || !interaction || interaction.sourceKind !== 'user'
      || interaction.sessionId !== input.currentSessionId || interactionAt == null || interactionAt > input.now) {
    blocked.push({ intent: 'chat_owner', reason: 'owner_interaction_unknown' })
  } else {
    if (socialGap == null || socialGap < policy.minimumGap) blocked.push({ intent: 'chat_owner', reason: 'gap_below_threshold' })
    else candidates.push({ intent: 'chat_owner', score: socialGap })
  }

  // Treat only floating-point representation noise as a mathematical score tie.
  candidates.sort((a, b) => {
    const difference = b.score - a.score
    if (Math.abs(difference) > Number.EPSILON * 4) return difference
    return PRIORITY[b.intent] - PRIORITY[a.intent]
  })
  if (!candidates.length) return { ...result(null, null, 'no_candidate'), blocked }
  const winner = candidates[0]
  return { ...result(winner.intent, winner.score, 'selected', {
    ...(winner.workStreakId ? { workStreakId: winner.workStreakId } : {}),
    ...(winner.workMinutes != null ? { workMinutes: winner.workMinutes } : {}),
  }), blocked }
}
