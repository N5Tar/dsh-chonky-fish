/**
 * ABS action registry: the single place that defines what an action is.
 *
 * One entry per action type. Everything else derives from this list: the selector
 * evaluates `signal`, the prompt renderer calls `prompt`, storage and the Host accept
 * `ABS_ACTION_INTENTS`, and the UI shows `label` / `basis`. Adding an action means adding
 * one entry here (plus its tests); no other file lists action names.
 *
 * Entry fields
 *   intent    stable name stored in history
 *   label     Chinese name for the UI
 *   priority  tie-break at equal score; higher wins
 *   family    'curiosity' actions share the curiosity drive and alternate at equal score
 *   basis     present only when the lab shows this action's signal; says what `value` is
 *   history   true when `signal` reads `input.lastEnqueuedAt[intent]`
 *   feedback  false when the action's tool results are recorded but never move a drive
 *   signal    ({ input, policy }) -> { ready, score, value, min, blockedReason, extra }
 *   prompt    (context) -> first-person prompt text; throws TypeError on unusable context
 */
import { buildChatHook, comparisonText, formatCstTime } from './review.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const ABS_ACTION_POLICY = Object.freeze({
  workStreakMinimumMs: 60 * 60_000,
  workSampleFreshnessMs: 20_000,
  minimumGap: 0.65,
  restBaseScore: 0.7,
  restRampMs: 30 * 60_000,
  explorationScoreFactor: 0.8,
  reviewMinGap: 0.5,
})
/** Hours since the last enqueued review_pending at which its signal saturates to 1. */
const REVIEW_SATURATION_HOURS = 24

const finiteTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
const clampedGap = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null
const policyNumber = (source, key, min, max) => typeof source[key] === 'number' && Number.isFinite(source[key])
  ? Math.min(max, Math.max(min, source[key])) : ABS_ACTION_POLICY[key]

/** Clamp a (possibly partial or invalid) override against the defaults. Idempotent. */
export function resolveActionPolicy(override) {
  const source = override && typeof override === 'object' && !Array.isArray(override) ? override : {}
  return {
    minimumGap: policyNumber(source, 'minimumGap', 0, 1),
    explorationScoreFactor: policyNumber(source, 'explorationScoreFactor', 0, 2),
    reviewMinGap: policyNumber(source, 'reviewMinGap', 0, 1),
  }
}

// ---- signals -------------------------------------------------------------

function restSignal({ input }) {
  const streak = input.workStreak
  const started = finiteTime(streak?.startedAt)
  const observedThrough = finiteTime(streak?.observedThrough)
  const fresh = observedThrough != null && observedThrough <= input.now
    && input.now - observedThrough <= ABS_ACTION_POLICY.workSampleFreshnessMs
  const streakMinutes = Number.isFinite(streak?.workMinutes) ? streak.workMinutes : 0
  const measuredMs = started != null && observedThrough != null ? observedThrough - started : 0
  const valid = typeof streak?.id === 'string' && streak.id.length > 0 && started != null && observedThrough != null
    && started <= observedThrough && fresh && streakMinutes >= ABS_ACTION_POLICY.workStreakMinimumMs / MINUTE
    && measuredMs >= ABS_ACTION_POLICY.workStreakMinimumMs
  if (!valid) return { ready: false, score: null, blockedReason: 'work_streak_missing_or_unverified' }
  if ((input.remindedWorkStreakIds ?? []).includes(streak.id)) return { ready: false, score: null, blockedReason: 'work_streak_already_reminded' }
  const ramp = Math.min((streakMinutes - 60) / (ABS_ACTION_POLICY.restRampMs / MINUTE), 1)
  return { ready: true, score: ABS_ACTION_POLICY.restBaseScore + (1 - ABS_ACTION_POLICY.restBaseScore) * ramp,
    extra: { workStreakId: streak.id, workMinutes: streakMinutes } }
}

/** A time signal, independent of any drive. Never reviewed saturates; a time before `now` clamps to zero hours. */
function reviewSignal({ input, policy }) {
  const last = finiteTime(input.lastEnqueuedAt?.review_pending)
  const hours = last == null ? Infinity : Math.max(0, (input.now - last) / HOUR)
  const value = Math.min(1, hours / REVIEW_SATURATION_HOURS)
  const ready = value >= policy.reviewMinGap
  return { ready, score: ready ? value : null, value, min: policy.reviewMinGap, blockedReason: 'gap_below_threshold' }
}

/** study and browse share the curiosity drive gap. */
function curiositySignal({ input, policy }) {
  const value = clampedGap(input.curiosityGap)
  const ready = value != null && value >= policy.minimumGap
  return { ready, score: ready ? policy.explorationScoreFactor * value : null, value, min: policy.minimumGap, blockedReason: 'gap_below_threshold' }
}

function chatSignal({ input, policy }) {
  const interaction = input.ownerInteraction
  const interactionAt = finiteTime(interaction?.realAt)
  if (!interaction || interaction.sourceKind !== 'user' || interaction.sessionId !== input.currentSessionId
      || interactionAt == null || interactionAt > input.now) {
    return { ready: false, score: null, blockedReason: 'owner_interaction_unknown' }
  }
  const value = clampedGap(input.socialGap)
  const ready = value != null && value >= policy.minimumGap
  return { ready, score: ready ? value : null, value, min: policy.minimumGap, blockedReason: 'gap_below_threshold' }
}

// ---- prompts ---------------------------------------------------------------

function chatPrompt({ ownerInteraction = null, currentSessionId = null, socialGap = null, previousSocialGap = null, now = null, lastExploration = null }) {
  const ownerTime = Date.parse(ownerInteraction?.realAt)
  if (ownerInteraction?.sourceKind !== 'user' || typeof currentSessionId !== 'string' || !currentSessionId
      || ownerInteraction.sessionId !== currentSessionId || !Number.isFinite(ownerTime)) {
    throw new TypeError('Verified same-session owner timestamp is required for chat')
  }
  const comparison = comparisonText(socialGap, previousSocialGap)
  const hook = buildChatHook({ ownerTime, now, lastExploration })
  return `唔……有点想找主人聊两句。${comparison}我这边记着上次交流是 ${formatCstTime(ownerInteraction.realAt)}。${hook}光在会话里自言自语不算找到他；要是 social_send_owner_message 可用，我就用它给主人捎一句轻松的话。发不出去或渠道不可用时，我再老实记下，不要假装已经找到他。`
}

function restPrompt({ workMinutes = null }) {
  if (!Number.isFinite(workMinutes) || workMinutes < 60) throw new TypeError('Verified work duration is required for a rest prompt')
  return `我留意到主人已经连续工作了大约${Math.floor(workMinutes)}分钟。忙了这么久，我要不要去提醒他歇一会儿？`
}

// ---- registry --------------------------------------------------------------

// Order is the evaluation order: it decides blocked-list order and ties between equal score and priority.
export const ABS_ACTIONS = Object.freeze([
  { intent: 'remind_rest', label: '休息提醒', priority: 3, signal: restSignal, prompt: restPrompt },
  { intent: 'review_pending', label: '代办回看', priority: 2, basis: '距上次回看（时间信号）', history: true, feedback: false,
    signal: reviewSignal, prompt: () => '我想回头看一下自己的代码或日程，看看有没有还没收尾的地方。' },
  { intent: 'study', label: '学习', priority: 2, family: 'curiosity', basis: '好奇缺口',
    signal: curiositySignal, prompt: () => '我想看看前面记下的学习线，接着想想。' },
  { intent: 'browse', label: '逛网站', priority: 2, family: 'curiosity', basis: '好奇缺口',
    signal: curiositySignal, prompt: () => '我想去网上逛逛，看看有没有新鲜的东西。' },
  { intent: 'chat_owner', label: '与主人交流', priority: 1, signal: chatSignal, prompt: chatPrompt },
].map(Object.freeze))

export const ABS_ACTION_BY_INTENT = new Map(ABS_ACTIONS.map(action => [action.intent, action]))
export const ABS_ACTION_INTENTS = Object.freeze(ABS_ACTIONS.map(action => action.intent))
export const ABS_CURIOSITY_INTENTS = Object.freeze(ABS_ACTIONS.filter(action => action.family === 'curiosity').map(action => action.intent))
/** Intents whose evidence is recorded but never moves a drive. */
export const ABS_NO_FEEDBACK_INTENTS = Object.freeze(ABS_ACTIONS.filter(action => action.feedback === false).map(action => action.intent))
/** Intents that need `lastEnqueuedAt` history in the selector input. */
export const ABS_HISTORY_INTENTS = Object.freeze(ABS_ACTIONS.filter(action => action.history).map(action => action.intent))
/** Retired actions: never selected, but old history rows still show a name. */
export const ABS_RETIRED_ACTION_LABELS = Object.freeze({ continue_interest: '旧探索' })

/** What the browser needs: intent -> label, for every active and retired action. */
export const ABS_ACTION_VIEWS = Object.freeze({
  ...Object.fromEntries(Object.entries(ABS_RETIRED_ACTION_LABELS).map(([intent, label]) => [intent, { label, retired: true }])),
  ...Object.fromEntries(ABS_ACTIONS.map(action => [action.intent, { label: action.label }])),
})

/**
 * Signals of the actions the lab shows (those with a `basis`). Read-only: the same
 * functions the selector uses, so the display can never drift from selection.
 *
 * @returns {{intent:string, label:string, basis:string, value:number|null, min:number|null, score:number|null, ready:boolean}[]}
 */
export function actionSignals(input, policyOverride) {
  const policy = resolveActionPolicy(policyOverride)
  return ABS_ACTIONS.filter(action => action.basis).map(action => {
    const signal = action.signal({ input, policy })
    return { intent: action.intent, label: action.label, basis: action.basis, value: signal.value ?? null, min: signal.min ?? null,
      score: signal.score ?? null, ready: signal.ready }
  })
}

/** Render one already-selected, app-authored first-person action prompt. */
export function renderActionPrompt(context = {}) {
  const action = ABS_ACTION_BY_INTENT.get(context.intent)
  if (!action) throw new TypeError('Invalid ABS action prompt intent')
  return action.prompt(context)
}
