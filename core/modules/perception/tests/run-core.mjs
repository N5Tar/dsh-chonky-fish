import assert from 'node:assert/strict';
import { resolveConfig } from '../config.js';
import { classifyApp, computeWindowStats, buildIntervals, analyzeActivity, computeFreshness, shouldPersistSummary } from '../core.js';

const base = 1800000000000;
const sample = (i, extra = {}) => ({ schemaVersion: 1, runId: 'run-1', seq: i, observedAtMs: base + i * 5000, receivedAtMs: base + i * 5000, monotonicMs: i * 5000, foregroundApp: { platform: 'macos', id: 'com.microsoft.VSCode', name: 'VSCode' }, idleSeconds: 0, sessionState: 'unknown', continuityBreak: false, missing: ['lockState'], ...extra });
let checks = 0;
const test = (name, fn) => { fn(); checks++; console.log(`ok ${checks} - ${name}`); };
test('configuration defaults and retention guard', () => {
  assert.equal(resolveConfig().sampleIntervalMs, 5000);
  assert.equal(resolveConfig().rawTtlMs, 3600000);
  assert.throws(() => resolveConfig({ rawTtlMs: 900000 }));
  assert.throws(() => resolveConfig({ analysisIntervalMs: NaN }));
});
test('classification uses platform and exact identity, never application name', () => {
  assert.equal(classifyApp({ platform: 'macos', id: 'unknown', name: 'code editor' }), 'unclassified');
  assert.equal(classifyApp({ platform: 'windows', id: 'com.microsoft.VSCode' }), 'unclassified');
  assert.equal(classifyApp(null), 'missing');
  assert.equal(classifyApp({ platform: 'macos', id: 'com.openai.codex', name: 'Codex' }), 'development');
  assert.equal(classifyApp({ platform: 'macos', id: 'com.apple.Terminal', name: 'Codex CLI' }), 'terminal');
});
test('cold start retains full denominator and last sample extends only five seconds', () => {
  const stats = computeWindowStats([sample(0)], { nowMs: base + 30000, windowMs: 900000 });
  assert.equal(stats.coveredMs, 5000);
  assert.equal(stats.coverage, 5000 / 900000);
});
test('unknown app remains in category denominator; locked/missing excluded', () => {
  const samples = [sample(0), sample(1, { foregroundApp: { platform: 'macos', id: 'unknown' } }), sample(2, { sessionState: 'locked' }), sample(3, { foregroundApp: null }), sample(4)];
  const stats = computeWindowStats(samples, { nowMs: base + 20000, windowMs: 20000 });
  assert.equal(stats.coveredMs, 10000);
  assert.equal(stats.categoryShare.development, 0.5);
  assert.equal(stats.lockedMs, 5000);
  assert.equal(stats.gapMs, 5000);
});
test('run boundaries, explicit breaks, nonincreasing mono and long gaps are not filled', () => {
  for (const extra of [{ runId: 'run-2' }, { continuityBreak: true }, { monotonicMs: 0 }, { monotonicMs: 15000, observedAtMs: base + 15000 }]) {
    const stats = computeWindowStats([sample(0), sample(1, extra)], { nowMs: sample(1, extra).observedAtMs, windowMs: 900000 });
    assert.equal(stats.coveredMs, 0);
  }
});
test('clock jumps are gaps with evidence and no overlapping intervals', () => {
  const stats = computeWindowStats([sample(0), sample(1, { observedAtMs: base + 20000 })], { nowMs: base + 20000, windowMs: 900000 });
  assert.equal(stats.coveredMs, 0);
  assert.equal(stats.clockDiscontinuity, true);
  const intervals = buildIntervals([sample(0), sample(1)], { nowMs: base + 8000, fromMs: base + 2000, toMs: base + 8000 });
  assert.equal(intervals.reduce((sum, i) => sum + i.toMs - i.fromMs, 0), 6000);
});
const full = Array.from({ length: 181 }, (_, i) => sample(i));
test('DSH and Codex combine into the work category with the compatible development key', () => {
  assert.equal(classifyApp({ platform: 'macos', id: 'com.deepseek.dsh' }), 'development');
  const samples = full.map((s, i) => ({ ...s, foregroundApp: { platform: 'macos', id: i < 101 ? 'com.deepseek.dsh' : i < 162 ? 'com.openai.codex' : 'com.google.Chrome' } }));
  const result = analyzeActivity(samples, { nowMs: base + 900000 });
  assert.equal(result.windowStats.long.categoryShare.development, .9);
  assert.equal(result.candidateActivity, 'development');
});
test('activity needs two distinct rounds and does not confirm repeated source', () => {
  const first = analyzeActivity(full, { nowMs: base + 900000 });
  assert.equal(first.activity, 'unknown');
  assert.equal(analyzeActivity(full, { nowMs: base + 930000, previous: first }), first);
  const second = analyzeActivity([...full, ...Array.from({ length: 6 }, (_, i) => sample(181 + i))], { nowMs: base + 930000, previous: first });
  assert.equal(second.activity, 'development');
  assert.equal(second.confidence, 'high');
  const third = analyzeActivity([...full, sample(240, { idleSeconds: 90 })], { nowMs: base + 1200000, previous: second });
  assert.equal(third.activitySince, second.activitySince);
  assert.equal(third.interaction, 'no_recent_input');
});
test('terminal alone is never development and low coverage is unknown', () => {
  const terminal = full.map(s => ({ ...s, foregroundApp: { platform: 'macos', id: 'com.apple.Terminal' } }));
  assert.equal(analyzeActivity(terminal, { nowMs: base + 900000 }).candidateActivity, 'unknown');
  assert.equal(analyzeActivity([sample(180)], { nowMs: base + 900000 }).candidateActivity, 'unknown');
});
test('freshness revoked by pause, old run, timeout, rollback and TTL', () => {
  const s = sample(180);
  const summary = analyzeActivity(full, { nowMs: base + 900000 });
  const args = { nowMs: base + 900000, status: 'running', runId: 'run-1', sample: s, summary };
  assert.equal(computeFreshness(args).isFresh, true);
  for (const extra of [{ status: 'paused' }, { runId: 'run-2' }, { nowMs: args.nowMs + 21000 }, { nowMs: args.nowMs - 1 }]) assert.equal(computeFreshness({ ...args, ...extra }).isFresh, false);
  assert.ok(computeFreshness({ ...args, nowMs: args.nowMs + 7 * 86400000 }).reasons.includes('summary_expired'));
});
test('history rate cap and minute/state-change persistence', () => {
  const summary = analyzeActivity(full, { nowMs: base + 900000 });
  assert.equal(shouldPersistSummary(summary, null), true);
  assert.equal(shouldPersistSummary({ ...summary, analyzedAt: summary.analyzedAt + 29999, activity: 'browser' }, summary), false);
  assert.equal(shouldPersistSummary({ ...summary, analyzedAt: summary.analyzedAt + 30000, activity: 'browser' }, summary), true);
  assert.equal(shouldPersistSummary({ ...summary, analyzedAt: summary.analyzedAt + 30000 }, summary), false);
  assert.equal(shouldPersistSummary({ ...summary, analyzedAt: summary.analyzedAt + 60000 }, summary), true);
});
test('browser, communication and mixed classifications respect explicit identities', () => {
  for (const [id, expected] of [['com.apple.Safari', 'browser'], ['com.tencent.xinWeChat', 'communication']]) {
    const rows = full.map(s => ({ ...s, foregroundApp: { platform: 'macos', id } }));
    assert.equal(analyzeActivity(rows, { nowMs: base + 900000 }).candidateActivity, expected);
  }
  const mixed = full.map((s, i) => ({ ...s, foregroundApp: { platform: 'macos', id: i % 2 ? 'com.apple.Safari' : 'com.tencent.xinWeChat' } }));
  assert.equal(analyzeActivity(mixed, { nowMs: base + 900000 }).candidateActivity, 'mixed');
});
test('confirmed activity sustains at five minutes and run change resets confirmation', () => {
  let previous = null;
  for (let end = 180; end <= 246; end += 6) {
    previous = analyzeActivity(Array.from({ length: end + 1 }, (_, i) => sample(i)), { nowMs: base + end * 5000, previous });
  }
  assert.equal(previous.activity, 'development');
  assert.equal(previous.continuity, 'sustained');
  const restarted = analyzeActivity([sample(250, { runId: 'new' })], { nowMs: base + 1250000, previous });
  assert.equal(restarted.activity, 'unknown');
  assert.equal(restarted.candidateCount, 1);
  const rollback = computeWindowStats([sample(0), sample(1), sample(2, { observedAtMs: base - 10000 })], { nowMs: base + 10000, windowMs: 900000 });
  assert.equal(rollback.clockDiscontinuity, true);
});
test('insufficient continuity and stale source cannot be refreshed by analyzedAt', () => {
  const summary = analyzeActivity([sample(0)], { nowMs: base });
  assert.equal(summary.continuity, 'insufficient');
  const freshness = computeFreshness({ nowMs: base + 100000, status: 'running', runId: 'run-1', sample: sample(20), summary: { ...summary, analyzedAt: base + 100000 } });
  assert.ok(freshness.reasons.includes('source_stale'));
});
test('bounded app distribution, switches, continuous foreground and known-input fraction', () => {
  const rows = [sample(0), sample(1, { idleSeconds: 90 }), sample(2, { foregroundApp: { platform: 'macos', id: 'com.apple.Safari' }, idleSeconds: null })];
  const stats = computeWindowStats(rows, { nowMs: base + 15000, windowMs: 900000 });
  assert.equal(stats.apps.length, 2);
  assert.equal(stats.apps[0].durationMs, 10000);
  assert.equal(stats.observedSwitches, 1);
  assert.equal(stats.currentAppContinuousMs, 5000);
  assert.equal(stats.recentInputShare, 0.5);
  const many = Array.from({ length: 50 }, (_, i) => sample(i, { foregroundApp: { platform: 'macos', id: `app-${i}`, name: '界'.repeat(1000) } }));
  const bounded = analyzeActivity(many, { nowMs: base + 250000 });
  assert.equal(bounded.windowStats.long.apps.length, 20);
  assert.equal(bounded.windowStats.long.otherAppMs, 150000);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 32768);
});
test('sub-millisecond wall/monotonic rounding cannot create gaps or reset continuity', () => {
  const rows = Array.from({ length: 7 }, (_, i) => sample(i, {
    monotonicMs: 0.43 + i * 5000.17,
    observedAtMs: base + Math.floor(i * 5000.17),
    receivedAtMs: base + Math.floor(i * 5000.17) + 2,
    foregroundApp: { platform: 'macos', id: i < 3 ? 'com.microsoft.VSCode' : 'com.apple.Terminal', name: i < 3 ? 'VSCode' : 'Terminal' },
  }));
  const nowMs = rows.at(-1).observedAtMs;
  const intervals = buildIntervals(rows, { nowMs, fromMs: base, toMs: nowMs });
  assert.equal(intervals.filter(x => x.kind === 'gap').length, 0);
  const stats = computeWindowStats(rows, { nowMs, windowMs: nowMs - base });
  assert.equal(stats.coverage, 1);
  assert.equal(stats.observedSwitches, 1);
  assert.ok(stats.currentAppContinuousMs >= 15000);
});
test('rounding tolerance must never fill a genuine break', () => {
  const rows = [sample(0), sample(1, { continuityBreak: true, monotonicMs: 5000.1 })];
  const items = buildIntervals(rows, { nowMs: base + 5000, fromMs: base, toMs: base + 5000 });
  assert.ok(items.every(x => x.kind === 'gap'));
});
console.log(`Perception core: ${checks} tests passed (synthetic samples only).`);
