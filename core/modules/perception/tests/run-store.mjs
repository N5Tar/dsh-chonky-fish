import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPerceptionStore } from '../../../../app/shared/storage/perception/sqlite.js';

const nowMs = 1800000000000;
const config = { summaryTtlMs: 60000 };
const store = createPerceptionStore({ dbPath: ':memory:', DatabaseSync, config, now: () => nowMs });
const sample = (seq, receivedAtMs = nowMs) => ({ runId: 'run-1', seq, observedAtMs: receivedAtMs, receivedAtMs, monotonicMs: seq * 5000, foregroundApp: { platform: 'macos', id: 'test', name: 'Test' }, idleSeconds: null, sessionState: 'unknown', continuityBreak: false, missing: ['lockState'] });
const summary = (analyzedAt = nowMs) => ({ analyzedAt, sourceThrough: analyzedAt, ruleVersion: 'activity-v1', activity: 'unknown' });
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log(`ok ${checks} - ${name}`); }
try {
  await test('sample dedup and receive-order roundtrip', () => {
    assert.equal(store.insertSample(sample(1)), true);
    assert.equal(store.insertSample(sample(1)), false);
    store.insertSample(sample(2, nowMs - 1000));
    assert.deepEqual(store.querySamples().map(s => s.seq), [1, 2]);
    assert.equal(store.querySamples()[0].idleSeconds, null);
    assert.deepEqual(store.querySamples()[0].missing, ['lockState']);
  });
  await test('TTL filtered before physical cleanup and counts expose ranges', () => {
    store.insertSample(sample(3, nowMs - 3600000));
    store.insertSummary(summary(nowMs - 60000));
    store.insertSummary(summary());
    assert.equal(store.querySamples().length, 2);
    assert.equal(store.querySummaries().items.length, 1);
    assert.equal(store.getCounts().samplesFromMs, nowMs - 1000);
    assert.equal(store.getCounts().summaries, 1);
  });
  await test('bounded pagination is descending and cursor has no duplicate boundary', () => {
    for (let i = 0; i < 5; i++) store.insertSummary(summary());
    const page = store.querySummaries({ limit: 2 });
    assert.equal(page.items.length, 2);
    assert.ok(page.items[0].id > page.items[1].id);
    const next = store.querySummaries({ limit: 2, beforeId: page.nextCursor });
    assert.ok(next.items.every(row => row.id < page.nextCursor));
    assert.throws(() => store.querySummaries({ beforeId: 'abc' }));
    assert.throws(() => store.querySamples({ limit: -1 }));
  });
  await test('size bounds and invalid fields fail visibly', () => {
    assert.throws(() => store.insertSummary({ ...summary(), evidence: 'x'.repeat(32768) }));
    assert.throws(() => store.insertSample({ ...sample(7), extra: 'x'.repeat(16384) }));
    assert.throws(() => store.insertSample({ ...sample(7), receivedAtMs: NaN }));
    assert.throws(() => store.insertSummary(summary(NaN)));
  });
  await test('cleanup deletes >500 in batches and yields between batches', async () => {
    for (let i = 10; i < 1110; i++) store.insertSample(sample(i, nowMs - 3600001));
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const result = await store.cleanup();
    assert.equal(result.samples, 1101);
    assert.equal(result.summaries, 1);
    assert.equal(yielded, true);
    assert.deepEqual(await store.cleanup(), { samples: 0, summaries: 0 });
  });
  await test('queries cap their result and TTL independently', () => {
    for (let i = 2000; i < 4100; i++) store.insertSample(sample(i));
    for (let i = 0; i < 510; i++) store.insertSummary(summary());
    assert.equal(store.querySamples({ limit: 10000 }).length, 2000);
    assert.equal(store.querySummaries({ limit: 10000 }).items.length, 500);
    assert.equal(store.querySamples({ nowMs: nowMs + 3600000 }).length, 0);
    assert.equal(store.querySummaries({ nowMs: nowMs + 60000 }).items.length, 0);
  });
} finally { store.close(); }
await test('close is idempotent and subsequent operations fail', () => {
  store.close();
  assert.throws(() => store.insertSample(sample(99)), /closed/);
  assert.throws(() => store.querySamples(), /closed/);
});
await test('schema consists of two tables and user_version; schema failure closes DB', () => {
  let db;
  class InspectDatabase extends DatabaseSync { constructor(path) { super(path); db = this; } }
  const s = createPerceptionStore({ dbPath: ':memory:', DatabaseSync: InspectDatabase });
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name), ['samples', 'summaries']);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  s.close();
  let didClose = false;
  class FutureDatabase { prepare() { return { get: () => ({ user_version: 2 }) }; } close() { didClose = true; } }
  assert.throws(() => createPerceptionStore({ dbPath: ':memory:', DatabaseSync: FutureDatabase }), /Unsupported/);
  assert.equal(didClose, true);
});
console.log(`Perception store: ${checks} tests passed (in-memory SQLite; no real activity collection).`);
