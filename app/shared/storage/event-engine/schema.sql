-- 大肥鱼模块 0 · 事件引擎持久化 V1
--
-- 与《模块0 V1 技术详细设计》§8.2 的差异（2026-10-27 拍板）：
--   * 删除 raw_records：原始内容以 DSH 会话日志（$DSH_HOME/sessions/*/session.v4.jsonl.zstd）
--     为唯一权威副本，这里只存 (session_id, seq) 引用 + 进度游标。
--     代价：DSH 会话被删除/归档后溯源链断开，事件自身的 quote 仍可审计。
--   * 删除 event_outbox / event_consumptions：消费者在本进程内，改用
--     semantic_events.event_seq 单调递增 + consumer_cursor 拉取，语义等价（至少一次）。
--     将来出现进程外消费者时再加回 outbox（见 README 的升级条件）。
--   * 删除 sensitivity / payload_hash / source_external_id：不再做外发分级。
--   * 新增 extraction_audit：记录被拒/被跳过的候选，回答「为什么这句没抽出来」。
--
-- 实现：宿主 Node 24.21 自带 node:sqlite（DatabaseSync），零原生依赖。
-- 打开方式：PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. 采集进度：每个会话最多一行，last_seq 之前的事件都已入队。
CREATE TABLE IF NOT EXISTS ingest_cursor (
  session_id TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL CHECK (last_seq >= 0),
  updated_at TEXT NOT NULL
);

-- 2. 提取任务：按 turn 聚合，一个 turn 一个 job（提示词一次处理整个 turn）。
CREATE TABLE IF NOT EXISTS extraction_jobs (
  job_id          TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  turn            INTEGER NOT NULL CHECK (turn >= 0),
  from_seq        INTEGER NOT NULL CHECK (from_seq >= 0),
  to_seq          INTEGER NOT NULL CHECK (to_seq >= from_seq),
  status          TEXT NOT NULL CHECK (status IN
                    ('pending', 'processing', 'succeeded', 'skipped', 'failed_retryable', 'dead_letter')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  lease_until     TEXT,           -- 进程重启后扫描并回收 processing 孤儿任务
  model_id        TEXT,
  prompt_version  TEXT NOT NULL,
  last_error_code TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (session_id, turn, prompt_version)
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON extraction_jobs (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON extraction_jobs (status, lease_until);

-- 3. 语义事件：模块 0 的唯一产出。event_seq 给消费者做游标。
CREATE TABLE IF NOT EXISTS semantic_events (
  event_seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT NOT NULL UNIQUE,
  schema_version   TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  category         TEXT NOT NULL CHECK (category IN
                     ('interaction', 'preference', 'activity', 'environment', 'state', 'goal')),
  event_type       TEXT NOT NULL,
  actor_ref        TEXT NOT NULL,
  action           TEXT NOT NULL,
  target_json      TEXT CHECK (target_json IS NULL OR json_valid(target_json)),
  polarity         TEXT NOT NULL CHECK (polarity IN ('positive', 'negative', 'neutral', 'mixed')),
  evidence_status  TEXT NOT NULL CHECK (evidence_status IN
                     ('reported', 'intent', 'hypothetical', 'negated', 'uncertain')),
  occurred_at      TEXT,
  observed_at      TEXT NOT NULL,
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  attributes_json  TEXT NOT NULL CHECK (json_valid(attributes_json)),
  classifier_json  TEXT CHECK (classifier_json IS NULL OR json_valid(classifier_json)),
  dedupe_key       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (dedupe_key, schema_version)
);
CREATE INDEX IF NOT EXISTS idx_events_session ON semantic_events (session_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON semantic_events (event_type, observed_at);

-- 4. 消费幂等：消费者自己记「读到第几个 event_seq」，等价于 outbox + consumptions。
CREATE TABLE IF NOT EXISTS consumer_cursor (
  consumer_id    TEXT PRIMARY KEY,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);

-- 5. 提取审计：只追加，记录拒绝/跳过原因，用于抽取质量复盘。
CREATE TABLE IF NOT EXISTS extraction_audit (
  audit_id     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  turn         INTEGER NOT NULL,
  job_id       TEXT NOT NULL,
  run_id       TEXT,
  decision     TEXT NOT NULL CHECK (decision IN ('rejected', 'skipped', 'failed', 'repaired', 'observed')),
  reason_code  TEXT NOT NULL,
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_turn ON extraction_audit (session_id, turn);
CREATE INDEX IF NOT EXISTS idx_audit_reason ON extraction_audit (reason_code, created_at);
