import { ABS_ACTIONS, ABS_ACTION_BY_INTENT, ABS_CURIOSITY_INTENTS, resolveActionPolicy } from './actions.js'

export { ABS_ACTION_POLICY } from './actions.js'

const CURIOSITY_INTENTS = new Set(ABS_CURIOSITY_INTENTS)
const result = (intent, score, reason, extra = {}) => ({ intent, score, reason, ...extra })

/** Equal-score ties between curiosity-family actions alternate; otherwise the earlier-listed action wins. */
function curiosityTieBreak(a, b, lastCuriosityIntent) {
  if (!CURIOSITY_INTENTS.has(a.intent) || !CURIOSITY_INTENTS.has(b.intent) || a.intent === b.intent) return 0
  if (a.intent === lastCuriosityIntent) return 1
  if (b.intent === lastCuriosityIntent) return -1
  return 0
}

/**
 * Pure single-intent selector. Every action in the registry (actions.js) answers the same
 * question: is its signal ready, and at what score. The selector only ranks the answers; it
 * knows no action by name. The activity repository records one stable dispatch lifecycle row
 * per review; it does not apply action quotas or cadence gates.
 *
 * @param {{now:number, mode:string, currentSessionId:string|null,
 *   ownerInteraction:{sessionId:string,realAt:string,sourceKind:'user'}|null, socialGap:number|null,
 *   curiosityGap:number|null, lastEnqueuedAt?:Record<string,string|null>, lastCuriosityIntent?:string|null,
 *   workStreak:{id:string,startedAt:string,observedThrough:string,workMinutes:number}|null,
 *   remindedWorkStreakIds:string[],
 *   policy?:{minimumGap?:number, explorationScoreFactor?:number, reviewMinGap?:number}}} input
 */
export function selectAbsAction(input) {
  if (!input || !Number.isFinite(input.now) || !['off','shadow','active'].includes(input.mode)) throw new TypeError('Invalid ABS selector input')
  if (input.mode === 'off') return result(null, null, 'mode_off')
  if (typeof input.currentSessionId !== 'string' || !input.currentSessionId) return result(null, null, 'owner_session_unavailable')
  const policy = resolveActionPolicy(input.policy)
  const candidates = []
  const blocked = []
  for (const action of ABS_ACTIONS) {
    const signal = action.signal({ input, policy })
    if (signal.ready) candidates.push({ intent: action.intent, score: signal.score, ...signal.extra })
    else blocked.push({ intent: action.intent, reason: signal.blockedReason })
  }

  // Treat only floating-point representation noise as a mathematical score tie.
  candidates.sort((a, b) => {
    const difference = b.score - a.score
    if (Math.abs(difference) > Number.EPSILON * 4) return difference
    const priority = ABS_ACTION_BY_INTENT.get(b.intent).priority - ABS_ACTION_BY_INTENT.get(a.intent).priority
    if (priority !== 0) return priority
    return curiosityTieBreak(a, b, input.lastCuriosityIntent ?? null)
  })
  if (!candidates.length) return { ...result(null, null, 'no_candidate'), blocked }
  const { intent, score, ...extra } = candidates[0]
  return { ...result(intent, score, 'selected', extra), blocked }
}
