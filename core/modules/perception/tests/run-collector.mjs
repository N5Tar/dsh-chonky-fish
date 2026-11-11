import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCollector, validateSample, MAX_SAMPLE_BYTES } from '../../../../app/shared/platform/perception/collector.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wire = (seq = 0) => ({ schemaVersion: 1, seq, observedAtMs: 1000 + seq * 5000,
  monotonicMs: seq * 5000, foregroundApp: { platform: 'macos', id: 'test.synthetic', name: 'Synthetic' },
  idleSeconds: 0, sessionState: 'unknown', continuityBreak: false, missing: ['lockState'] });
function fake({ ignoreTerm = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.signals = []; child.closed = false;
  child.kill = (signal) => {
    child.signals.push(signal);
    if (!(signal === 'SIGTERM' && ignoreTerm)) setImmediate(() => { child.closed = true; child.emit('close', 0, signal); });
    return true;
  };
  child.sample = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
  return child;
}
function fixture(options = {}, fakeOptions = {}) {
  const children = [], samples = [], states = [], errors = [];
  const collector = createCollector({ binaryPath: '/synthetic path/activity-collector',
    firstSampleTimeoutMs: 50, staleTimeoutMs: 40, killTimeoutMs: 15,
    spawnImpl(path, args, opts) { assert.equal(path, '/synthetic path/activity-collector'); assert.deepEqual(args, []); assert.equal(opts.shell, false);
      assert.ok(children.every((child) => child.closed), 'no process overlap'); const child = fake(fakeOptions); children.push(child); return child; },
    onSample: (sample) => samples.push(sample), onState: ({ state }) => states.push(state), onError: (error) => errors.push(error), ...options });
  return { collector, children, samples, states, errors };
}
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log(`ok ${checks} - ${name}`); }
await test('wire validation rejects oversized strings, enums, timing and missing fields', () => {
  for (const mutate of [v => v.foregroundApp.name = 'x'.repeat(257), v => v.foregroundApp.id = 'x'.repeat(513),
    v => v.foregroundApp.platform = 'linux', v => v.sessionState = 'active', v => v.missing = ['secret'],
    v => v.seq = -1, v => v.idleSeconds = Infinity, v => v.schemaVersion = 2, v => v.continuityBreak = 'yes']) {
    const value = wire(); mutate(value); assert.throws(() => validateSample(value));
  }
  const value = wire(); delete value.foregroundApp; delete value.idleSeconds; delete value.sessionState;
  assert.equal(validateSample(value).foregroundApp, null); assert.equal(validateSample(value).idleSeconds, null);
  assert.equal(validateSample(value).sessionState, 'unknown');
});
await test('explicit start, idempotence, stale recovery, fresh runs and disposal', async () => {
  const f = fixture(); assert.equal(f.children.length, 0);
  const started = f.collector.start(); assert.equal(f.collector.start(), started);
  f.children[0].sample(wire()); const firstRun = (await started).runId;
  assert.equal(f.samples[0].runId, firstRun); assert.ok(f.samples[0].receivedAtMs);
  await delay(60); assert.equal(f.collector.getStatus().state, 'stale');
  f.children[0].sample(wire(1)); assert.equal(f.samples[1].continuityBreak, true);
  const stopping = f.collector.stop(); await assert.rejects(f.collector.start(), /stopping/); await stopping;
  const restarted = f.collector.start(); f.children[1].sample(wire()); assert.notEqual((await restarted).runId, firstRun);
  await Promise.all([f.collector.dispose(), f.collector.dispose()]); await assert.rejects(f.collector.start(), /disposed/);
  assert.equal(f.collector.getStatus().state, 'disposed');
});
await test('first sample timeout escalates TERM to KILL and gates restart', async () => {
  const f = fixture({}, { ignoreTerm: true }); await assert.rejects(f.collector.start(), /timed out/);
  await assert.rejects(f.collector.start(), /stopping/); await f.collector.stop();
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']); await f.collector.dispose();
});
await test('malformed, oversized, bad UTF8 and duplicate sequence fail closed', async () => {
  for (const send of [c => c.stdout.write('{oops}\n'), c => c.stdout.write('x'.repeat(MAX_SAMPLE_BYTES + 1)),
    c => c.stdout.write(Buffer.from([0xff, 10])), c => { c.sample(wire()); c.sample(wire()); }]) {
    const f = fixture(); const starting = f.collector.start(); send(f.children[0]);
    await starting.catch(() => {}); assert.equal(f.collector.getStatus().state, 'error'); await f.collector.stop(); await f.collector.dispose();
  }
});
await test('partial lines and bounded multi-line chunks are parsed', async () => {
  const f = fixture(); const started = f.collector.start(); const line = JSON.stringify(wire());
  f.children[0].stdout.write(line.slice(0, 9)); assert.equal(f.samples.length, 0);
  f.children[0].stdout.write(line.slice(9) + '\n' + JSON.stringify(wire(1)) + '\n');
  await started; assert.equal(f.samples.length, 2); await f.collector.dispose();
});
await test('persistence failure, unexpected exit, spawn errors and stop-before-ready', async () => {
  const f = fixture({ onSample() { throw new Error('synthetic disk failure'); } });
  const ready = f.collector.start(); f.children[0].sample(wire()); await assert.rejects(ready); await f.collector.dispose();
  const g = fixture(); const pending = g.collector.start(); g.children[0].closed = true; g.children[0].emit('close', 1);
  await assert.rejects(pending, /unexpectedly/); await g.collector.dispose();
  const h = fixture({ spawnImpl() { throw new Error('synthetic spawn failure'); } }); await assert.rejects(h.collector.start()); await h.collector.dispose();
  const i = fixture(); const early = i.collector.start(); await i.collector.stop(); await assert.rejects(early, /stopped/); await i.collector.dispose();
  const j = fixture(); const spawnError = j.collector.start(); j.children[0].emit('error', new Error('ENOENT')); await assert.rejects(spawnError); await j.collector.dispose();
});
await test('dispose from a starting observer cannot leak a process', async () => {
  let collector, cleanup;
  const f = fixture({ onState({ state }) { if (state === 'starting') cleanup = collector.dispose(); } });
  collector = f.collector;
  await assert.rejects(collector.start(), /stopped/); await cleanup;
  assert.ok(f.children[0].closed); assert.equal(collector.getStatus().state, 'disposed');
});
await test('unsupported never spawns', async () => { const f = fixture({ supported: false }); await assert.rejects(f.collector.start(), /unsupported/); assert.equal(f.children.length, 0); await f.collector.dispose(); });

// Native execution is opt-in and always synthetic. No code path starts real collection.
if (process.argv.includes('--native')) {
  const nativeArch = process.argv.find((arg) => arg.startsWith('--native-arch='))?.split('=')[1] ?? process.arch;
  assert.ok(['arm64', 'x64'].includes(nativeArch), 'supported synthetic native architecture');
  const binary = fileURLToPath(new URL(`../../../../app/shared/platform/perception/native/macos/${nativeArch}/activity-collector`, import.meta.url));
  async function nativeCase(mode) {
    const child = spawn(binary, ['--self-test'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    const lines = []; let buffer = ''; let diagnostics = '';
    child.stdout.on('data', (data) => { buffer += data; let at; while ((at = buffer.indexOf('\n')) !== -1) { lines.push({ at: Date.now(), value: validateSample(JSON.parse(buffer.slice(0, at))) }); buffer = buffer.slice(at + 1); } });
    child.stderr.on('data', (data) => { diagnostics += data.toString().slice(0, 512); });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 9000);
    try {
      const until = Date.now() + 7000;
      while (lines.length < (mode === 'EOF' ? 2 : 1) && Date.now() < until && child.exitCode === null) await delay(25);
      assert.ok(lines.length >= (mode === 'EOF' ? 2 : 1), diagnostics || 'synthetic sample timeout');
      for (const { value } of lines) assert.equal(value.foregroundApp.id, 'test.synthetic.collector');
      if (mode === 'EOF') { const gap = lines[1].at - lines[0].at; assert.ok(gap >= 4800 && gap <= 6500, `5-second interval: ${gap}`); child.stdin.end(); }
      else child.kill('SIGTERM');
      const [code, signal] = await closed; assert.equal(code, 0); assert.equal(signal, null);
    } finally { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }
  }
  await test('native synthetic 5s sampling and stdin EOF exit', () => nativeCase('EOF'));
  await test('native synthetic SIGTERM exit', () => nativeCase('TERM'));
}
console.log(`Collector: ${checks} tests passed (synthetic signals only).`);
