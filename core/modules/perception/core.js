import { resolveConfig } from './config.js';

export const RULE_VERSION = 'activity-v1.1';
// observedAt is integer milliseconds while the monotonic clock has fractions.
// Snap only quantization-sized differences; real breaks remain gaps.
const TIMESTAMP_ROUNDING_MS = 2;
const MINUTE = 60000;
const APP_CATEGORIES = new Map([
  // Keep the persisted development key for compatibility; the category is displayed as work.
  ['macos:com.deepseek.dsh', 'development'],
  ['macos:com.microsoft.VSCode', 'development'],
  // Verified from a real foreground API comparison, not inferred from a name.
  ['macos:com.openai.codex', 'development'],
  ['macos:com.apple.dt.Xcode', 'development'],
  ['macos:com.jetbrains.intellij', 'development'],
  ['macos:com.jetbrains.WebStorm', 'development'],
  ['macos:com.google.Chrome', 'browser'],
  ['macos:com.apple.Safari', 'browser'],
  ['macos:org.mozilla.firefox', 'browser'],
  ['macos:com.microsoft.edgemac', 'browser'],
  ['macos:com.tinyspeck.slackmacgap', 'communication'],
  ['macos:com.tencent.xinWeChat', 'communication'],
  ['macos:com.apple.MobileSMS', 'communication'],
  ['macos:com.apple.Terminal', 'terminal'],
  ['macos:com.googlecode.iterm2', 'terminal'],
]);

export function classifyApp(app) {
  return app?.platform && app?.id
    ? APP_CATEGORIES.get(`${app.platform}:${app.id}`) ?? 'unclassified'
    : 'missing';
}

// Input order is receive order, not wall-clock order: sorting by observedAt
// would hide clock rollback and manufacture continuity.
export function computeWindowStats(samples, { nowMs, windowMs, config: overrides } = {}) {
  const config = resolveConfig(overrides);
  if (!Number.isFinite(nowMs) || !(windowMs > 0)) throw new TypeError('Invalid analysis window');
  const start = nowMs - windowMs;
  const durations = { development: 0, browser: 0, communication: 0, terminal: 0, unclassified: 0 };
  let coveredMs = 0;
  let lockedMs = 0;
  let clockDiscontinuity = samples.some((sample, index) => {
    const prior = samples[index - 1];
    return prior && sample.runId === prior.runId && sample.receivedAtMs >= start && sample.receivedAtMs <= nowMs
      && Math.abs((sample.observedAtMs - prior.observedAtMs) - (sample.monotonicMs - prior.monotonicMs)) > config.clockToleranceMs;
  });
  const intervals = buildIntervals(samples, { nowMs, fromMs: start, toMs: nowMs, config });
  const appTotals = new Map();
  let observedSwitches = 0;
  let currentAppContinuousMs = 0;
  let previousInterval = null;
  for (const interval of intervals) {
    const key = interval.kind === 'activity' ? `${interval.foregroundApp.platform}:${interval.foregroundApp.id}` : null;
    const previousKey = previousInterval?.kind === 'activity' ? `${previousInterval.foregroundApp.platform}:${previousInterval.foregroundApp.id}` : null;
    const adjacent = previousInterval?.toMs === interval.fromMs && previousInterval?.runId === interval.runId;
    if (key && previousKey && adjacent && key !== previousKey) observedSwitches++;
    currentAppContinuousMs = key ? (key === previousKey && adjacent ? currentAppContinuousMs : 0) + interval.toMs - interval.fromMs : 0;
    if (key) {
      const entry = appTotals.get(key) ?? { platform: interval.foregroundApp.platform, id: interval.foregroundApp.id, name: interval.foregroundApp.name ?? null, durationMs: 0 };
      entry.durationMs += interval.toMs - interval.fromMs;
      appTotals.set(key, entry);
    }
    previousInterval = interval;
    const span = interval.toMs - interval.fromMs;
    if (interval.kind === 'gap') { clockDiscontinuity ||= interval.reason === 'wall_clock_discontinuity'; continue; }
    if (interval.kind === 'locked') { lockedMs += span; continue; }
    if (interval.category === 'missing') continue;
    durations[interval.category] += span;
    coveredMs += span;
  }
  const categoryShare = Object.fromEntries(Object.entries(durations).map(([key, value]) => [key, coveredMs ? value / coveredMs : 0]));
  const appEntries = [...appTotals.values()].sort((a, b) => b.durationMs - a.durationMs);
  // Bound both the number of identities and label lengths in persisted summaries.
  const apps = appEntries.slice(0, 20).map(app => ({ ...app, id: app.id.slice(0, 64), platform: app.platform.slice(0, 16), name: app.name?.slice(0, 64) ?? null, share: coveredMs ? app.durationMs / coveredMs : 0 }));
  const latest = samples.at(-1);
  if (latest?.sessionState === 'locked' || latest?.continuityBreak || latest?.runId !== previousInterval?.runId || latest?.foregroundApp?.id !== previousInterval?.foregroundApp?.id || latest?.foregroundApp?.platform !== previousInterval?.foregroundApp?.platform) currentAppContinuousMs = 0;
  const knownInput = samples.filter(s => s.observedAtMs >= start && s.observedAtMs <= nowMs && s.sessionState !== 'locked' && s.idleSeconds != null);
  const recentInputShare = knownInput.length ? knownInput.filter(s => s.idleSeconds <= 60).length / knownInput.length : null;
  return { windowMs, coveredMs, coverage: coveredMs / windowMs, gapMs: windowMs - coveredMs - lockedMs, lockedMs, categoryMs: durations, categoryShare, clockDiscontinuity,
    apps, otherAppMs: appEntries.slice(20).reduce((sum, app) => sum + app.durationMs, 0), observedSwitches, currentAppContinuousMs, recentInputShare, currentIdleSeconds: latest?.idleSeconds ?? null };

}

export function buildIntervals(samples, { nowMs, fromMs = nowMs - 3600000, toMs = nowMs, config: overrides } = {}) {
  const config = resolveConfig(overrides);
  if (![nowMs, fromMs, toMs].every(Number.isFinite) || toMs < fromMs) throw new TypeError('Invalid interval bounds');
  const start = fromMs;
  const end = Math.min(nowMs, toMs);
  const intervals = [];
  let cursor = start;
  let gapReason = 'no_samples';
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    let duration;
    if (b) {
      const mono = b.monotonicMs - a.monotonicMs;
      const wall = b.observedAtMs - a.observedAtMs;
      const clockJump = Math.abs(wall - mono) > config.clockToleranceMs;
      if (a.runId !== b.runId || b.continuityBreak || mono <= 0 || mono > config.maxGapMs || clockJump) {
        if (b.receivedAtMs >= start) gapReason = clockJump ? 'wall_clock_discontinuity' : 'continuity_break';
        continue;
      }
      duration = wall > 0 && Math.abs(wall - mono) <= TIMESTAMP_ROUNDING_MS ? wall : mono;
    } else {
      duration = Math.min(config.sampleIntervalMs, Math.max(0, nowMs - a.observedAtMs));
    }
    const left = Math.max(start, a.observedAtMs, cursor);
    const right = Math.min(end, a.observedAtMs + duration);
    if (right <= left) continue;
    if (left > cursor) intervals.push({ fromMs: cursor, toMs: left, kind: 'gap', reason: gapReason });
    const category = classifyApp(a.foregroundApp);
    intervals.push({ fromMs: left, toMs: right, kind: a.sessionState === 'locked' ? 'locked' : category === 'missing' ? 'gap' : 'activity', category, foregroundApp: a.foregroundApp, interaction: a.sessionState === 'locked' ? 'locked' : a.idleSeconds == null ? 'unknown' : a.idleSeconds <= 60 ? 'recent_input' : 'no_recent_input', runId: a.runId });
    cursor = right;
    gapReason = 'no_samples';
  }
  if (cursor < end) intervals.push({ fromMs: cursor, toMs: end, kind: 'gap', reason: gapReason });
  return intervals;
}

function candidateActivity(stats) {
  if (stats.coverage < 0.8) return 'unknown';
  const s = stats.categoryShare;
  if (s.development >= 0.6 && stats.categoryMs.development >= 5 * MINUTE) return 'development';
  if (s.browser >= 0.6) return 'browser';
  if (s.communication >= 0.6) return 'communication';
  if (['development', 'browser', 'communication', 'terminal'].filter(key => s[key] >= 0.2).length >= 2) return 'mixed';
  return 'unknown';
}

export function analyzeActivity(samples, { nowMs, previous = null, config: overrides } = {}) {
  const config = resolveConfig(overrides);
  const source = samples.at(-1);
  if (!source) return null;
  // Repeated scheduler callbacks must not count as another confirmation round.
  if (previous?.sourceRunId === source.runId && previous?.sourceSeq === source.seq) return previous;
  const short = computeWindowStats(samples, { nowMs, windowMs: 5 * MINUTE, config });
  const long = computeWindowStats(samples, { nowMs, windowMs: 15 * MINUTE, config });
  const proposed = candidateActivity(long);
  const sameRun = previous?.sourceRunId === source.runId;
  const prior = sameRun ? previous : null;
  const candidateCount = prior?.candidateActivity === proposed ? prior.candidateCount + 1 : 1;
  const activity = candidateCount >= 2 ? proposed : prior?.activity ?? 'unknown';
  const activitySince = prior?.activity === activity ? prior.activitySince : nowMs;
  const interaction = source.sessionState === 'locked' ? 'locked'
    : source.idleSeconds == null ? 'unknown' : source.idleSeconds <= 60 ? 'recent_input' : 'no_recent_input';
  const dominantShare = Math.max(...Object.values(long.categoryShare));
  const confidence = proposed === 'unknown' || activity !== proposed ? 'low'
    : long.coverage >= 0.9 && dominantShare >= 0.8 && interaction === 'recent_input' ? 'high' : 'medium';
  const evidence = [];
  if (long.coverage < 0.8) evidence.push('insufficient_coverage');
  if (long.clockDiscontinuity) evidence.push('wall_clock_discontinuity');
  if (long.categoryMs.terminal) evidence.push('terminal_is_supporting_evidence_only');
  if (candidateCount < 2 && proposed !== activity) evidence.push('awaiting_second_confirmation');
  if (interaction === 'no_recent_input') evidence.push('no_recent_input_does_not_imply_absence');
  return {
    activity, interaction, continuity: long.coverage < 0.8 ? 'insufficient' : nowMs - activitySince >= 5 * MINUTE ? 'sustained' : 'brief',
    confidence, activitySince, windowStats: { short, long }, evidence,
    analyzedAt: nowMs, sourceThrough: source.observedAtMs, ruleVersion: RULE_VERSION,
    sourceRunId: source.runId, sourceSeq: source.seq,
    candidateActivity: proposed, candidateCount: Math.min(candidateCount, 2),
  };
}

export function computeFreshness({ nowMs, status, runId, sample, summary, config: overrides }) {
  const config = resolveConfig(overrides);
  const reasons = [];
  if (status !== 'running') reasons.push('not_running');
  if (!sample) reasons.push('no_sample');
  else {
    if (nowMs - sample.receivedAtMs > config.sampleStaleMs) reasons.push('sample_stale');
    if (nowMs < sample.receivedAtMs) reasons.push('clock_rollback');
    if (sample.runId !== runId) reasons.push('sample_old_run');
  }
  if (!summary) reasons.push('no_analysis');
  else {
    if (nowMs - summary.analyzedAt > config.analysisStaleMs) reasons.push('analysis_stale');
    if (!Number.isFinite(summary.sourceThrough) || nowMs - summary.sourceThrough > config.analysisStaleMs) reasons.push('source_stale');
    if (nowMs < summary.analyzedAt || nowMs < summary.sourceThrough) reasons.push('clock_rollback');
    if (summary.sourceRunId !== runId) reasons.push('analysis_old_run');
    if (nowMs - summary.analyzedAt >= config.summaryTtlMs) reasons.push('summary_expired');
  }
  return { isFresh: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function shouldPersistSummary(summary, previousSaved) {
  if (!summary) return false;
  if (!previousSaved) return true;
  const elapsed = summary.analyzedAt - previousSaved.analyzedAt;
  if (elapsed < 30000) return false;
  return elapsed >= MINUTE || ['activity', 'interaction', 'continuity', 'confidence'].some(key => summary[key] !== previousSaved[key]);
}
