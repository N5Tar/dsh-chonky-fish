import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { platform } from '../platform/index.js';
import { validateClockSnapshot } from './clock.js';

const MAX_RECORDS = 2000;
const MAX_BYTES = 8 * 1024 * 1024;
const clone = (value) => structuredClone(value);
const writers = new Set();
function validate(state) {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('ABS state schema invalid; refusing reset');
  if (Object.hasOwn(state, 'clock')) validateClockSnapshot(state.clock);
  if (Object.hasOwn(state, 'changeLedger')) {
    if (!Array.isArray(state.changeLedger) || state.changeLedger.length > 200 || state.changeLedger.some((row) => !row || !['social', 'curiosity'].includes(row.driveId) || !Number.isFinite(Date.parse(row.realAt)) || typeof row.reason !== 'string' || ![row.before, row.after].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || !Number.isFinite(row.delta) || Math.abs(row.after - row.before - row.delta) > 1e-10)) throw new Error('ABS change ledger invalid');
  }
  for (const id of ['social', 'curiosity']) {
    const d = state.drives?.[id];
    if (!d || !Number.isFinite(d.satisfaction) || d.satisfaction < 0 || d.satisfaction > 1 || !(d.setpoint > 0 && d.setpoint <= 1) || !Number.isFinite(d.decayPerHour) || d.decayPerHour < 0 || !Number.isFinite(Date.parse(d.updatedAt))) throw new Error('ABS drive state invalid');
  }
  for (const key of ['motivations', 'executions', 'history', 'proposalIds', 'feedbackKeys']) if (!Array.isArray(state[key])) throw new Error(`ABS state ${key} invalid`);
  if (state.motivations.length > 1000 || state.executions.length > 10000 || state.history.length > 10000 || state.proposalIds.length > 10000 || state.feedbackKeys.length > 10000) throw new Error('ABS state capacity exceeded; refusing unsafe dedupe eviction');
  if (!state.budget || !Number.isSafeInteger(state.budget.llmCalls) || state.budget.llmCalls < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(state.budget.day) || !Number.isFinite(Date.parse(state.updatedAt))) throw new Error('ABS state metadata invalid');
  for (const key of ['proposalIds', 'feedbackKeys']) {
    if (state[key].some((id) => typeof id !== 'string' || !id) || new Set(state[key]).size !== state[key].length) throw new Error(`ABS invalid dedupe keys: ${key}`);
  }
  const motivationIds = new Set();
  for (const m of state.motivations) {
    if (!m || typeof m.id !== 'string' || !m.id || motivationIds.has(m.id) || !['explore', 'organize', 'social_contact'].includes(m.intent) || m.driveId !== (m.intent === 'social_contact' ? 'social' : 'curiosity') || !Number.isFinite(m.strength) || m.strength < 0 || m.strength > 1 || !['active', 'snoozed', 'completed', 'expired'].includes(m.status) || typeof m.normKey !== 'string' || !Array.isArray(m.aliasNormKeys) || !Array.isArray(m.sourceRefs) || !Number.isFinite(Date.parse(m.updatedAt)) || (m.nextReviewAt && !Number.isFinite(Date.parse(m.nextReviewAt)))) throw new Error('ABS motivation state invalid');
    motivationIds.add(m.id);
  }
  const executionIds = new Set();
  for (const e of state.executions) {
    if (!e || typeof e.executionId !== 'string' || !e.executionId || executionIds.has(e.executionId) || !motivationIds.has(e.motivationId) || typeof e.status !== 'string' || !e.status) throw new Error('ABS execution state invalid');
    executionIds.add(e.executionId);
  }
  for (const h of state.history) if (!h || !Number.isFinite(Date.parse(h.at)) || !['execution', 'defer'].includes(h.kind) || !['active', 'shadow'].includes(h.mode) || !['explore', 'organize', 'social_contact'].includes(h.intent)) throw new Error('ABS history state invalid');
}

/** Single process writer. Snapshot is authoritative; audit failure never rolls it back.
 * commit rejects on audit failure, exposing stateCommitted=true for reconciliation.
 * No automatic external side-effect retry is safe after any commit error.
 */
export async function createAbsStore({ directory }) {
  if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('ABS directory required');
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const snapshotPath = join(root, 'state.json'), auditPath = join(root, 'audit.jsonl');
  if (writers.has(root)) throw new Error('ABS store already has a writer in this process');
  writers.add(root);
  let state = null, audit = [], queue = Promise.resolve(), closed = false;
  // All rename/unlink targets below are explicit children of this verified root.
  async function atomic(path, text) {
    if (![snapshotPath, auditPath].includes(path)) throw new Error('Unexpected ABS write target');
    const temporary = `${path}.tmp`;
    const file = await open(temporary, 'w', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    // Directory flush is a platform capability (src/platform/): POSIX fsyncs the directory,
    // Windows cannot and keeps the synced file + atomic rename instead.
    await platform.syncDirectory(root);
  }
  async function release() { writers.delete(root); }
  try {
    try {
      const raw = await readFile(snapshotPath, 'utf8');
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('ABS snapshot size exceeds limit');
      state = JSON.parse(raw); validate(state);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      const raw = await readFile(auditPath, 'utf8');
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('ABS audit size exceeds limit');
      audit = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).slice(-MAX_RECORDS);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('ABS audit corrupt; reconciliation required', { cause: error }); }
    if (!state && audit.length) throw new Error('ABS snapshot missing with existing audit; refusing reset');
  } catch (error) { await release(); throw error; }
  const enqueue = (fn) => {
    if (closed) return Promise.reject(new Error('ABS store closed'));
    const result = queue.then(fn); queue = result.catch(() => {}); return result;
  };
  return {
    read: () => clone(state),
    commit(nextState, records = []) {
      let next, added;
      try {
        validate(nextState);
        if (!Array.isArray(records)) throw new TypeError('ABS records must be an array');
        next = clone(nextState); added = clone(records);
      } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        if (state && next.revision < state.revision) throw new Error('ABS stale state revision');
        const snapshot = `${JSON.stringify(next)}\n`;
        if (Buffer.byteLength(snapshot) > MAX_BYTES) throw new Error('ABS snapshot size exceeds limit');
        let retained = [...audit, ...added].slice(-MAX_RECORDS);
        const lines = retained.map((record) => JSON.stringify(record));
        let bytes = lines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
        while (bytes > MAX_BYTES && lines.length) bytes -= Buffer.byteLength(lines.shift()) + 1;
        retained = retained.slice(retained.length - lines.length);
        await atomic(snapshotPath, snapshot);
        state = next;
        try { await atomic(auditPath, lines.length ? `${lines.join('\n')}\n` : ''); audit = retained; }
        catch (error) { error.stateCommitted = true; throw error; }
      });
    },
    records({ limit = 200 } = {}) {
      const count = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_RECORDS, Math.floor(limit))) : 200;
      return clone(count ? audit.slice(-count) : []);
    },
    async close() { if (closed) return; closed = true; await queue; await release(); },
  };
}
