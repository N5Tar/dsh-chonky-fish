import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_TIME_SCALE, validateTimeScale, validateClockSnapshot, createAbsClock } from '../clock.js';
import { createAbsStore } from '../store.js';
import { platform } from '../../../../app/shared/platform/index.js';
import { createState } from '../core.js';
let checks = 0;
async function test(name, run) { await run(); console.log(`ok ${++checks} - ${name}`); }
await test('strict finite scale range', () => {
  assert.equal(MAX_TIME_SCALE, 120);
  for (const x of [0, 0.5, 1, 10, 120]) assert.equal(validateTimeScale(x), x);
  for (const x of [-1, 121, NaN, Infinity, '1', null, undefined]) assert.throws(() => validateTimeScale(x));
});
await test('continuous scales, pause, historical receipts and legacy offset', () => {
  let wall = 1000;
  const clock = createAbsClock({ realNow: () => wall, initialVirtualMs: 5000 });
  wall = 1100; assert.equal(clock.now(), 5100);
  clock.setScale(0.5); wall = 1300; assert.equal(clock.now(), 5200);
  clock.setScale(10); wall = 1400; assert.equal(clock.now(), 6200);
  clock.setScale(0); wall = 2000; assert.equal(clock.now(), 6200);
  assert.equal(clock.realNow(), 2000); assert.equal(clock.delayUntil(6000), null);
  clock.setScale(2); assert.equal(clock.now(), 6200);
  wall = 2050; assert.equal(clock.now(), 6300);
  assert.equal(clock.delayUntil(6500), 100); assert.equal(clock.delayUntil(6200), 0);
  for (const [real, virtual] of [[900,4900],[1050,5050],[1200,5150],[1350,5700],[1800,6200],[2025,6250]]) assert.equal(clock.toVirtual(real), virtual);
  const receipt = Object.freeze({ completedAt: new Date(1350).toISOString() });
  assert.equal(clock.toVirtual(Date.parse(receipt.completedAt)), 5700);
  assert.equal(receipt.completedAt, new Date(1350).toISOString());
  const count = clock.snapshot().segments.length; clock.setScale(2);
  assert.equal(clock.snapshot().segments.length, count);
});
await test('rollback and restart never double count or reverse time', () => {
  let wall = 1000;
  const clock = createAbsClock({ realNow: () => wall, scale: 2 });
  wall = 1100; assert.equal(clock.now(), 1200);
  wall = 900; assert.equal(clock.now(), 1200); assert.equal(clock.realNow(), 1100);
  clock.setScale(0.5); wall = 1050; assert.equal(clock.now(), 1200);
  wall = 1200;
  const saved = JSON.parse(JSON.stringify(clock.snapshot()));
  assert.equal(saved.lastVirtualAt, 1250);
  wall = 1000;
  const restored = createAbsClock({ realNow: () => wall, snapshot: saved, scale: 120 });
  assert.equal(restored.timeScale, 0.5); assert.equal(restored.now(), 1250);
  wall = 1400; assert.equal(restored.now(), 1350);
  assert.equal(restored.toVirtual(1050), 1100);
  saved.segments[0].scale = 99; assert.equal(restored.toVirtual(1050), 1100);
  const exposed = restored.snapshot(); exposed.segments.length = 0;
  assert.equal(restored.snapshot().segments.length, 2);
});
await test('paused restoration and equal-anchor changes', () => {
  let wall = 1000;
  const clock = createAbsClock({ realNow: () => wall });
  clock.setScale(10); clock.setScale(0);
  const snapshot = clock.snapshot(); validateClockSnapshot(snapshot);
  wall = 9000;
  const restored = createAbsClock({ realNow: () => wall, snapshot });
  assert.equal(restored.now(), 1000); assert.equal(restored.toVirtual(1000), 1000);
  restored.setScale(1); wall++; assert.equal(restored.now(), 1001);
});
await test('malformed snapshots and invalid inputs fail closed', () => {
  const snapshot = createAbsClock({ realNow: () => 1000 }).snapshot();
  for (const bad of [null, {}, {...snapshot, version: 2}, {...snapshot, segments: []}, {...snapshot, lastRealAt: 999}, {...snapshot, lastVirtualAt: 1001}, {...snapshot, segments: [{realAt: 1000, virtualAt: 1000, scale: -1}]}, {...snapshot, segments: [...snapshot.segments, {realAt: 1100, virtualAt: 999, scale: 1}]}]) assert.throws(() => validateClockSnapshot(bad));
  const clock = createAbsClock({realNow: () => 1000});
  assert.throws(() => clock.setScale('2')); assert.throws(() => clock.toVirtual(NaN)); assert.throws(() => clock.delayUntil(Infinity));
  assert.throws(() => createAbsClock({ realNow: () => NaN }));
});
await test('4096 segments retained and overflow rejected without mutation', () => {
  let wall = 0; const clock = createAbsClock({ realNow: () => wall });
  for (let i = 1; i < 4096; i++) { wall++; clock.setScale(i % 2 ? 2 : 1); }
  const before = clock.snapshot(); validateClockSnapshot(before);
  clock.setScale(clock.timeScale); assert.throws(() => clock.setScale(0), /capacity/);
  assert.deepEqual(clock.snapshot(), before); assert.equal(clock.toVirtual(0), 0);
});
await test('fractional epoch snapshots survive JSON persistence', () => {
  let wall = Date.parse('2026-11-07T00:00:00Z');
  const clock = createAbsClock({ realNow: () => wall, scale: 1 / 3 });
  for (let i = 0; i < 100; i++) { wall += 17; clock.now(); }
  clock.setScale(0.1); wall += 123;
  const snapshot = JSON.parse(JSON.stringify(clock.snapshot())); validateClockSnapshot(snapshot);
  assert.equal(createAbsClock({ realNow: () => wall, snapshot }).now(), clock.now());
});
await test('Date boundaries reject overflow without changing clock state', () => {
  const edge = 8.64e15;
  for (const value of [-edge, edge]) {
    const clock = createAbsClock({ realNow: () => value });
    assert.equal(clock.now(), value); assert.doesNotThrow(() => new Date(clock.now()).toISOString());
    validateClockSnapshot(clock.snapshot());
  }
  for (const value of [-edge - 1, edge + 1, 1e20]) {
    assert.throws(() => createAbsClock({ realNow: () => value }), /Date range/);
    assert.throws(() => createAbsClock({ realNow: () => 0, initialVirtualMs: value }), /Date range/);
    const snapshot = {version: 1, segments: [{realAt: 0, virtualAt: value, scale: 0}], lastRealAt: 0, lastVirtualAt: value};
    assert.throws(() => validateClockSnapshot(snapshot), /Date range/);
  }
  let wall = 0;
  const clock = createAbsClock({ realNow: () => wall, initialVirtualMs: edge - 120, scale: 120 });
  wall = 1; assert.equal(clock.now(), edge);
  const before = clock.snapshot(); wall = 2;
  assert.throws(() => clock.now(), /Date range/); assert.throws(() => clock.snapshot(), /Date range/);
  assert.throws(() => clock.setScale(0), /Date range/);
  wall = 1; assert.deepEqual(clock.snapshot(), before);
  assert.throws(() => clock.toVirtual(2), /Date range/);
  assert.throws(() => clock.toVirtual(edge + 1), /Date range/);
  assert.throws(() => clock.delayUntil(edge + 1), /Date range/);
  const legacy = createAbsClock({realNow: () => 0, initialVirtualMs: -edge, scale: 0});
  assert.throws(() => legacy.toVirtual(-1), /Date range/);
  const tiny = createAbsClock({realNow: () => 0, scale: Number.MIN_VALUE});
  assert.equal(tiny.delayUntil(1000), Infinity);
});
await test('repeated fractional segments retain exact JSON snapshot consistency', () => {
  let wall = 1794000000000;
  const clock = createAbsClock({realNow: () => wall});
  for (let i = 0; i < 128; i++) {
    wall += 17.123; clock.setScale(i % 119 + 0.123456789); wall += 31.456;
    const snapshot = JSON.parse(JSON.stringify(clock.snapshot()));
    validateClockSnapshot(snapshot);
    assert.equal(createAbsClock({realNow: () => wall, snapshot}).now(), clock.now());
  }
});
await test('store accepts legacy/valid clock and rejects present corrupt clock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abs-clock-'));
  const root = resolve(directory);
  assert.equal(root.startsWith(join(resolve(tmpdir()), 'abs-clock-')), true);
  let store;
  try {
    const state = createState(Date.parse('2026-11-07T00:00:00Z'));
    store = await createAbsStore({ directory, syncDirectory: platform.syncDirectory }); await store.commit(state);
    state.clock = createAbsClock({ realNow: () => Date.parse(state.updatedAt) }).snapshot();
    await store.commit(state); await store.close(); store = null;
    store = await createAbsStore({ directory, syncDirectory: platform.syncDirectory }); assert.deepEqual(store.read().clock, state.clock);
    await assert.rejects(store.commit({...state, clock: null}));
    await assert.rejects(store.commit({...state, clock: {...state.clock, lastVirtualAt: -1}}));
    await store.close(); store = null;
    await writeFile(join(root, 'state.json'), JSON.stringify({...state, clock: null}));
    await assert.rejects(createAbsStore({ directory, syncDirectory: platform.syncDirectory }));
  } finally { if (store) await store.close(); await rm(root, {recursive: true, force: true}); }
});
console.log(`${checks} clock tests passed (offline)`);
