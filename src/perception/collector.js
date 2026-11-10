import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const MAX_SAMPLE_BYTES = 16 * 1024;
const sessions = new Set(['unknown', 'locked', 'unlocked']);
const missingFields = new Set(['foregroundApp', 'idleSeconds', 'lockState']);
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);

/** Validate and project the wire schema; never retain arbitrary native fields. */
export function validateSample(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sample object');
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.seq) || value.seq < 0 ||
      !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0 || !finite(value.monotonicMs)) {
    throw new Error('Invalid sample version or timing');
  }
  let foregroundApp = null;
  if (value.foregroundApp != null) {
    const app = value.foregroundApp;
    if (!['macos', 'windows'].includes(app.platform) || !text(app.id, 512) || !text(app.name, 256)) throw new Error('Invalid foreground application');
    foregroundApp = { platform: app.platform, id: app.id, name: app.name };
  }
  const idleSeconds = value.idleSeconds ?? null;
  if (idleSeconds !== null && !finite(idleSeconds)) throw new Error('Invalid idle time');
  const sessionState = value.sessionState ?? 'unknown';
  if (!sessions.has(sessionState)) throw new Error('Invalid session state');
  if (value.continuityBreak != null && typeof value.continuityBreak !== 'boolean') throw new Error('Invalid continuity flag');
  if (value.missing != null && (!Array.isArray(value.missing) || value.missing.length > 3 || value.missing.some((v) => !missingFields.has(v)))) throw new Error('Invalid missing fields');
  const missing = new Set(value.missing ?? []);
  if (!foregroundApp) missing.add('foregroundApp');
  if (idleSeconds === null) missing.add('idleSeconds');
  if (sessionState === 'unknown') missing.add('lockState');
  return { schemaVersion: 1, seq: value.seq, observedAtMs: value.observedAtMs, monotonicMs: value.monotonicMs,
    foregroundApp, idleSeconds, sessionState, continuityBreak: value.continuityBreak ?? false, missing: [...missing] };
}

/** No process exists until start(); stop waits for close before allowing a new run. */
export function createCollector({ binaryPath, supported = true, onSample = () => {}, onState = () => {},
  onError = () => {}, spawnImpl = spawn, now = Date.now, firstSampleTimeoutMs = 20_000,
  staleTimeoutMs = 20_000, killTimeoutMs = 3_000 } = {}) {
  for (const timeout of [firstSampleTimeoutMs, staleTimeoutMs, killTimeoutMs]) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Collector timeouts must be positive');
  }
  let state = supported ? 'stopped' : 'unsupported';
  let child = null, runId = null, lastSampleAt = null, error = null, disposed = false;
  let firstTimer, staleTimer, killTimer, startPromise, resolveStart, rejectStart, closePromise, resolveClose;
  let buffer = Buffer.alloc(0), ending = false, previousSeq = -1, wasStale = false;
  const getStatus = () => ({ state, runId, lastSampleAt, error });
  const publish = (next) => { state = next; try { onState(getStatus()); } catch { /* Observers cannot break cleanup. */ } };
  const clearTimers = () => { clearTimeout(firstTimer); clearTimeout(staleTimer); clearTimeout(killTimer); };
  const terminate = () => {
    if (!child || ending) return;
    ending = true;
    clearTimeout(firstTimer); clearTimeout(staleTimer);
    const target = child;
    try { target.kill('SIGTERM'); } catch { /* Escalate below. */ }
    if (child !== target) return;
    killTimer = setTimeout(() => { if (child === target) { try { target.kill('SIGKILL'); } catch {} } }, killTimeoutMs);
  };
  const fail = (cause) => {
    if (ending || disposed) return;
    error = cause instanceof Error ? cause.message : 'Collector failure';
    publish('error');
    rejectStart?.(new Error(error)); resolveStart = rejectStart = null;
    try { onError(new Error(error)); } catch {}
    terminate();
  };
  const receive = (chunk) => {
    if (ending || disposed) return;
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      if (newline > MAX_SAMPLE_BYTES) return fail(new Error('Collector sample exceeds 16 KiB'));
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      try {
        const sample = validateSample(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
        if (sample.seq <= previousSeq) throw new Error('Collector sequence did not increase');
        sample.runId = runId; sample.receivedAtMs = now();
        sample.continuityBreak ||= wasStale;
        const result = onSample(sample);
        if (result?.then) { result.catch(() => {}); throw new Error('onSample must persist synchronously'); }
        if (ending || disposed) return;
        previousSeq = sample.seq; wasStale = false; lastSampleAt = sample.receivedAtMs;
        clearTimeout(firstTimer); clearTimeout(staleTimer);
        staleTimer = setTimeout(() => { if (!ending && child) { wasStale = true; publish('stale'); } }, staleTimeoutMs);
        publish('running'); resolveStart?.({ runId }); resolveStart = rejectStart = null;
      } catch { return fail(new Error('Collector emitted invalid sample or sample persistence failed')); }
    }
    if (buffer.length > MAX_SAMPLE_BYTES) fail(new Error('Collector sample exceeds 16 KiB'));
  };
  const start = () => {
    if (disposed) return Promise.reject(new Error('Collector disposed'));
    if (!supported) return Promise.reject(new Error('Collector platform unsupported'));
    if (child) {
      if (ending) return Promise.reject(new Error('Collector is still stopping'));
      return startPromise;
    }
    if (!isAbsolute(binaryPath ?? '')) return Promise.reject(new Error('Collector binaryPath must be absolute'));
    runId = randomUUID(); lastSampleAt = null; error = null; ending = false; previousSeq = -1; wasStale = false; buffer = Buffer.alloc(0);
    startPromise = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    // An independently triggered stop must not create an unhandled rejection.
    startPromise.catch(() => {});
    closePromise = new Promise((resolve) => { resolveClose = resolve; });
    state = 'starting';
    try {
      child = spawnImpl(binaryPath, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.on('data', receive);
      child.stdout.on('error', () => fail(new Error('Collector stdout failed')));
      child.stderr.on('data', () => {}); // Drain diagnostics without retaining activity or unbounded output.
      child.stderr.on('error', () => {});
      child.stdin.on('error', () => {});
      child.on('error', () => fail(new Error('Collector process failed to start')));
      child.once('close', () => {
        if (!ending && !disposed) fail(new Error('Collector exited unexpectedly'));
        clearTimers(); child = null; buffer = Buffer.alloc(0);
        if (disposed) publish('disposed'); else if (state !== 'error') publish('stopped');
        resolveClose?.(); resolveClose = null;
      });
      firstTimer = setTimeout(() => fail(new Error('Collector first sample timed out')), firstSampleTimeoutMs);
      publish('starting');
    } catch {
      fail(new Error('Collector process failed to start')); child = null; clearTimers(); resolveClose?.(); resolveClose = null;
    }
    return startPromise;
  };
  const stop = () => {
    if (!child) { if (!disposed && supported) publish('stopped'); return Promise.resolve(); }
    rejectStart?.(new Error('Collector stopped before first sample')); resolveStart = rejectStart = null;
    if (state !== 'error' && !disposed) publish('stopping');
    terminate();
    return closePromise;
  };
  const dispose = async () => { disposed = true; await stop(); clearTimers(); publish('disposed'); };
  return { start, stop, dispose, getStatus };
}

export default createCollector;
