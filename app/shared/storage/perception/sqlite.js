import { resolveConfig } from '../../../../core/modules/perception/config.js';

export function createPerceptionStore({ dbPath, DatabaseSync, config: overrides, now = Date.now }) {
  const config = resolveConfig(overrides);
  if (typeof DatabaseSync !== 'function') throw new TypeError('SQLite DatabaseSync adapter required');
  const db = new DatabaseSync(dbPath);
  let closed = false;
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('Unsupported perception database schema');
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA wal_autocheckpoint=100;
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
        observed_at_ms INTEGER NOT NULL, received_at_ms INTEGER NOT NULL, monotonic_ms REAL NOT NULL,
        app_platform TEXT, app_id TEXT, app_name TEXT, idle_seconds REAL,
        session_state TEXT NOT NULL, continuity_break INTEGER NOT NULL, quality_json TEXT NOT NULL,
        UNIQUE(run_id,seq));
      CREATE INDEX IF NOT EXISTS samples_received ON samples(received_at_ms);
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY, analyzed_at_ms INTEGER NOT NULL, source_through_ms INTEGER NOT NULL,
        rule_version TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS summaries_analyzed ON summaries(analyzed_at_ms);
      PRAGMA user_version=1;`);
  } catch (error) { db.close(); throw error; }
  const assertOpen = () => { if (closed) throw new Error('Perception store is closed'); };
  const finite = (value, label) => { if (!Number.isFinite(value)) throw new TypeError(`Invalid ${label}`); return value; };
  const boundedLimit = (value, fallback, max) => {
    if (value == null) return fallback;
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid query limit');
    return Math.min(max, value);
  };
  const decodeSample = row => ({
    id: row.id, schemaVersion: 1, runId: row.run_id, seq: row.seq,
    observedAtMs: row.observed_at_ms, receivedAtMs: row.received_at_ms, monotonicMs: row.monotonic_ms,
    foregroundApp: row.app_platform == null && row.app_id == null ? null : { platform: row.app_platform, id: row.app_id, name: row.app_name },
    idleSeconds: row.idle_seconds, sessionState: row.session_state, continuityBreak: Boolean(row.continuity_break), missing: JSON.parse(row.quality_json),
  });
  return {
    insertSample(sample) {
      assertOpen();
      const payload = JSON.stringify(sample);
      if (Buffer.byteLength(payload) > 16384) throw new RangeError('Sample exceeds 16 KiB');
      if (typeof sample.runId !== 'string' || !sample.runId || !Number.isSafeInteger(sample.seq) || sample.seq < 0) throw new TypeError('Invalid sample identity');
      for (const key of ['observedAtMs', 'receivedAtMs', 'monotonicMs']) finite(sample[key], key);
      const app = sample.foregroundApp;
      const result = db.prepare(`INSERT INTO samples (run_id,seq,observed_at_ms,received_at_ms,monotonic_ms,app_platform,app_id,app_name,idle_seconds,session_state,continuity_break,quality_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,seq) DO NOTHING`).run(
        sample.runId, sample.seq, sample.observedAtMs, sample.receivedAtMs, sample.monotonicMs,
        app?.platform ?? null, app?.id ?? null, app?.name ?? null, sample.idleSeconds ?? null,
        sample.sessionState ?? 'unknown', sample.continuityBreak ? 1 : 0, JSON.stringify(sample.missing ?? []));
      return Number(result.changes) > 0;
    },
    insertSummary(summary) {
      assertOpen();
      const payload = JSON.stringify(summary);
      if (Buffer.byteLength(payload) > 32768) throw new RangeError('Summary exceeds 32 KiB');
      finite(summary.analyzedAt, 'analyzedAt'); finite(summary.sourceThrough, 'sourceThrough');
      return Number(db.prepare('INSERT INTO summaries(analyzed_at_ms,source_through_ms,rule_version,payload_json) VALUES(?,?,?,?)')
        .run(summary.analyzedAt, summary.sourceThrough, summary.ruleVersion, payload).lastInsertRowid);
    },
    querySamples({ fromMs = -Number.MAX_SAFE_INTEGER, toMs = now(), limit, nowMs = now() } = {}) {
      assertOpen(); finite(fromMs, 'fromMs'); finite(toMs, 'toMs'); finite(nowMs, 'nowMs');
      return db.prepare(`SELECT * FROM (SELECT * FROM samples WHERE received_at_ms > ? AND received_at_ms >= ? AND received_at_ms <= ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`)
        .all(nowMs - config.rawTtlMs, fromMs, toMs, boundedLimit(limit, 780, 2000)).map(decodeSample);
    },
    querySummaries({ fromMs = -Number.MAX_SAFE_INTEGER, toMs = now(), limit, beforeId = Number.MAX_SAFE_INTEGER, nowMs = now() } = {}) {
      assertOpen(); finite(fromMs, 'fromMs'); finite(toMs, 'toMs'); finite(nowMs, 'nowMs');
      if (!Number.isSafeInteger(beforeId) || beforeId < 1) throw new TypeError('Invalid summary cursor');
      const size = boundedLimit(limit, 120, 500);
      const rows = db.prepare('SELECT * FROM summaries WHERE analyzed_at_ms > ? AND analyzed_at_ms >= ? AND analyzed_at_ms <= ? AND id < ? ORDER BY id DESC LIMIT ?')
        .all(nowMs - config.summaryTtlMs, fromMs, toMs, beforeId, size + 1);
      const items = rows.slice(0, size).map(row => ({ ...JSON.parse(row.payload_json), id: row.id }));
      return { items, nextCursor: rows.length > size ? items.at(-1).id : null };
    },
    getCounts({ nowMs = now() } = {}) {
      assertOpen(); finite(nowMs, 'nowMs');
      const raw = db.prepare('SELECT COUNT(*) AS count, MIN(received_at_ms) AS fromMs, MAX(received_at_ms) AS toMs FROM samples WHERE received_at_ms > ? AND received_at_ms <= ?').get(nowMs - config.rawTtlMs, nowMs);
      const summaries = db.prepare('SELECT COUNT(*) AS count, MIN(analyzed_at_ms) AS fromMs, MAX(analyzed_at_ms) AS toMs FROM summaries WHERE analyzed_at_ms > ? AND analyzed_at_ms <= ?').get(nowMs - config.summaryTtlMs, nowMs);
      return { samples: raw.count, summaries: summaries.count, samplesFromMs: raw.fromMs, samplesToMs: raw.toMs, summariesFromMs: summaries.fromMs, summariesToMs: summaries.toMs };
    },
    async cleanup({ nowMs = now() } = {}) {
      assertOpen(); finite(nowMs, 'nowMs');
      const result = { samples: 0, summaries: 0 };
      for (const [table, column, ttl] of [['samples', 'received_at_ms', config.rawTtlMs], ['summaries', 'analyzed_at_ms', config.summaryTtlMs]]) {
        let changes;
        do {
          assertOpen();
          changes = Number(db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${column} <= ? ORDER BY ${column} LIMIT 500)`).run(nowMs - ttl).changes);
          result[table] += changes;
          if (changes === 500) await new Promise(resolve => setImmediate(resolve));
        } while (changes === 500);
      }
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      return result;
    },
    close() {
      if (closed) return;
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
      finally { closed = true; db.close(); }
    },
  };
}