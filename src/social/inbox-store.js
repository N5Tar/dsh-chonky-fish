import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { DEFAULT_INBOX_LIMITS } from './limits.js';
export { DEFAULT_INBOX_LIMITS } from './limits.js';

const owners = new Set();
const clone = (value) => structuredClone(value);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const digest = (text) => createHash('sha256').update(text).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const natural = (n) => Number.isSafeInteger(n) && n >= 0;
const text = (s) => typeof s === 'string' && s.length > 0 && s.length <= 1024;
const partitionKey = (sessionKey, revision) => JSON.stringify([sessionKey, revision]);

export function createSessionKey(message) {
  const { platform, connectionId, conversation } = message ?? {};
  if (!text(platform) || !text(connectionId) || !conversation ||
      !['direct', 'group', 'channel'].includes(conversation.type) || !text(conversation.id) ||
      (conversation.guildId !== undefined && !text(conversation.guildId)) ||
      (conversation.type === 'channel' && !text(conversation.guildId))) {
    throw fail('INBOX_INVALID_MESSAGE', 'Invalid message target');
  }
  return JSON.stringify([platform, connectionId, conversation.type, conversation.guildId ?? '', conversation.id]);
}

function validateMessage(message) {
  createSessionKey(message);
  if (!text(message.messageId) || typeof message.text !== 'string' ||
      !message.sender || !text(message.sender.id) || !Number.isFinite(message.sentAt)) {
    throw fail('INBOX_INVALID_MESSAGE', 'Invalid message fields');
  }
}

function validateState(state) {
  const check = (condition) => { if (!condition) throw fail('INBOX_CORRUPT', 'Invalid inbox snapshot'); };
  check(state?.version === 1 && Array.isArray(state.sessions) && Array.isArray(state.acknowledged));
  const partitions = new Set();
  const batchIds = new Set();
  for (const s of state.sessions) {
    check(text(s.identityRevision) && typeof s.sessionKey === 'string');
    check(s.sessionKey === createSessionKey(s));
    const key = partitionKey(s.sessionKey, s.identityRevision);
    check(!partitions.has(key)); partitions.add(key);
    check(positive(s.nextSeq) && natural(s.cursor) && s.cursor < s.nextSeq && natural(s.revision));
    check(natural(s.droppedCount) && natural(s.gapThroughSeq) && s.gapThroughSeq < s.nextSeq);
    check(Array.isArray(s.messages) && Array.isArray(s.dedup));
    let previous = s.cursor;
    for (const m of s.messages) {
      validateMessage(m);
      check(createSessionKey(m) === s.sessionKey && positive(m.seq) && m.seq > previous && m.seq < s.nextSeq && Number.isFinite(m.receivedAt));
      previous = m.seq;
    }
    const ids = new Set();
    for (const d of s.dedup) {
      check(text(d.messageId) && positive(d.seq) && d.seq < s.nextSeq && Number.isFinite(d.at) && !ids.has(d.messageId));
      ids.add(d.messageId);
    }
    if (s.batch !== null) {
      const b = s.batch;
      check(text(b?.batchId) && !batchIds.has(b.batchId)); batchIds.add(b.batchId);
      check(b.sessionKey === s.sessionKey && b.identityRevision === s.identityRevision &&
        positive(b.fromSeq) && b.fromSeq > s.cursor && positive(b.throughSeq) && b.throughSeq >= b.fromSeq && b.throughSeq < s.nextSeq &&
        Number.isFinite(b.createdAt) && typeof b.hasMore === 'boolean' && typeof b.hasGap === 'boolean' &&
        Array.isArray(b.messages) && b.messages.length > 0);
      previous = b.fromSeq - 1;
      for (const m of b.messages) {
        validateMessage(m);
        check(createSessionKey(m) === s.sessionKey && positive(m.seq) && m.seq > previous && m.seq <= b.throughSeq && Number.isFinite(m.receivedAt));
        previous = m.seq;
      }
      check(b.messages[0].seq === b.fromSeq && previous === b.throughSeq);
    }
  }
  for (const a of state.acknowledged) {
    check(text(a?.batchId) && typeof a.sessionKey === 'string' && text(a.identityRevision) && positive(a.throughSeq));
    const s = state.sessions.find((s) => s.sessionKey === a.sessionKey && s.identityRevision === a.identityRevision);
    check(s && a.throughSeq <= s.cursor && !batchIds.has(a.batchId)); batchIds.add(a.batchId);
  }
}

/** Internal storage only: authorization/current identity checks belong to the caller.
 * One writer process per directory. Every method returns a Promise; failed writes
 * poison this instance so it cannot report success from an ambiguous disk state.
 */
export async function createInboxStore({ directory, limits = {}, now = Date.now } = {}) {
  if (typeof directory !== 'string' || !directory) throw fail('INBOX_INVALID_DIRECTORY', 'Directory is required');
  const config = { ...DEFAULT_INBOX_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(config, key) || !positive(value)) throw fail('INBOX_INVALID_LIMIT', `Invalid inbox limit: ${key}`);
    config[key] = value;
  }
  if (typeof now !== 'function') throw fail('INBOX_INVALID_CLOCK', 'Clock must be a function');
  const dir = resolve(directory);
  const path = join(dir, 'inbox-state.json');
  const temp = join(dir, '.inbox-state.tmp');
  // Both rename paths are fixed names inside the explicitly resolved inbox directory.
  if (resolve(path) !== path || resolve(temp) !== temp) throw fail('INBOX_INVALID_DIRECTORY', 'Invalid resolved paths');
  if (owners.has(dir)) throw fail('INBOX_ALREADY_OPEN', 'Inbox directory is already open in this process');
  owners.add(dir);
  let state = { version: 1, sessions: [], acknowledged: [] };
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      if ((await stat(path)).size > config.maxStateBytes) throw fail('INBOX_CORRUPT', 'Inbox snapshot exceeds configured size');
      const envelope = JSON.parse(await readFile(path, 'utf8'));
      if (typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.sha256) throw fail('INBOX_CORRUPT', 'Inbox snapshot checksum mismatch');
      state = JSON.parse(envelope.payload);
      validateState(state);
      const batches = state.sessions.flatMap((s) => s.batch ? [s.batch] : []);
      if (state.sessions.length > config.maxSessions || state.acknowledged.length > config.maxAcknowledgedBatches ||
          batches.length > config.maxBatches || batches.reduce((n, b) => n + bytes(b), 0) > config.maxRetainedBatchBytes ||
          state.sessions.some((s) => s.dedup.length > config.maxDedupEntriesPerSession) ||
          batches.some((b) => b.messages.length > config.maxBatchMessages || b.messages.reduce((n, m) => n + m.text.length, 0) > config.maxBatchChars)) {
        throw fail('INBOX_CORRUPT', 'Recovered metadata exceeds configured bounds');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('INBOX_CORRUPT', 'Inbox recovery failed; original snapshot preserved');
    }
  } catch (error) { owners.delete(dir); throw error; }

  let tail = Promise.resolve();
  let pendingOperations = 0;
  let closed = false;
  let closePromise;
  let poisoned = null;
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value)) throw fail('INBOX_INVALID_CLOCK', 'Clock must return finite milliseconds');
    return value;
  };
  const removeMessage = (s, index) => {
    const [m] = s.messages.splice(index, 1);
    s.droppedCount += 1;
    s.gapThroughSeq = Math.max(s.gapThroughSeq, m.seq);
    s.revision += 1;
  };
  function prune(draft, at) {
    for (const s of draft.sessions) {
      for (let i = s.messages.length - 1; i >= 0; i--) {
        if (at - s.messages[i].receivedAt >= config.ttlMs) removeMessage(s, i);
      }
      while (s.messages.length > config.maxMessagesPerSession || bytes(s.messages) > config.maxBytesPerSession) {
        if (!s.messages.length) break;
        removeMessage(s, 0);
      }
      s.dedup = s.dedup.filter((d) => at - d.at < config.ttlMs).slice(-config.maxDedupEntriesPerSession);
      if (s.batch && at - s.batch.createdAt >= config.batchTtlMs) s.batch = null;
    }
    let count = draft.sessions.reduce((n, s) => n + s.messages.length, 0);
    let total = draft.sessions.reduce((n, s) => n + s.messages.reduce((n, m) => n + bytes(m), 0), 0);
    while (count > config.maxMessages || total > config.maxBytes) {
      const oldest = draft.sessions.filter((s) => s.messages.length).sort((a, b) => a.messages[0].receivedAt - b.messages[0].receivedAt)[0];
      if (!oldest) break;
      total -= bytes(oldest.messages[0]); count -= 1;
      removeMessage(oldest, 0);
    }
    draft.acknowledged = draft.acknowledged.slice(-config.maxAcknowledgedBatches);
  }
  async function persist(draft) {
    const payload = JSON.stringify(draft);
    const encoded = JSON.stringify({ sha256: digest(payload), payload });
    if (Buffer.byteLength(encoded) > config.maxStateBytes) throw fail('INBOX_CAPACITY', 'Inbox snapshot capacity reached');
    let handle;
    try {
      handle = await open(temp, 'w', 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temp, path);
      const folder = await open(dir, 'r');
      try { await folder.sync(); } finally { await folder.close(); }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      poisoned = fail('INBOX_WRITE_FAILED', 'Inbox commit failed; close and recover before further use');
      throw poisoned;
    }
  }
  function transaction(fn) {
    if (closed) return Promise.reject(fail('INBOX_CLOSED', 'Inbox is closed'));
    if (pendingOperations >= config.maxPendingOperations) return Promise.reject(fail('INBOX_CAPACITY', 'Inbox operation queue is full'));
    pendingOperations += 1;
    const operation = tail.then(async () => {
      if (poisoned) throw poisoned;
      const draft = clone(state);
      const at = clock();
      prune(draft, at);
      const result = fn(draft, at);
      if (JSON.stringify(draft) !== JSON.stringify(state)) {
        await persist(draft);
        state = draft;
      }
      return clone(result);
    }).finally(() => { pendingOperations -= 1; });
    tail = operation.catch(() => {});
    return operation;
  }
  const find = (draft, key, revision) => draft.sessions.find((s) => s.sessionKey === key && s.identityRevision === revision);
  const checkRef = (input) => {
    if (!input || typeof input.sessionKey !== 'string' || !text(input.identityRevision)) throw fail('INBOX_INVALID_REFERENCE', 'Session key and identity revision are required');
  };
  const sameRef = (a, b) => a.batchId === b.batchId && a.sessionKey === b.sessionKey && a.identityRevision === b.identityRevision && a.throughSeq === b.throughSeq;
  const publicBatch = ({ createdAt, ...batch }) => batch;

  return {
    append(message, { identityRevision } = {}) {
      // Capture input now: callers cannot mutate a queued append after validation.
      let input;
      try {
        input = JSON.parse(JSON.stringify(message));
        validateMessage(input);
        if (!text(identityRevision)) throw fail('INBOX_INVALID_REFERENCE', 'Identity revision is required');
        if (bytes(input) > config.maxMessageBytes || input.text.length > config.maxBatchChars) throw fail('INBOX_MESSAGE_TOO_LARGE', 'Message exceeds inbox or batch limit');
      } catch (error) { return Promise.reject(error); }
      return transaction((draft, at) => {
        const sessionKey = createSessionKey(input);
        let s = find(draft, sessionKey, identityRevision);
        if (!s) {
          if (draft.sessions.length >= config.maxSessions) throw fail('INBOX_CAPACITY', 'Inbox session capacity reached');
          s = { sessionKey, identityRevision, platform: input.platform, connectionId: input.connectionId,
            conversation: input.conversation, nextSeq: 1, cursor: 0, revision: 0, droppedCount: 0,
            gapThroughSeq: 0, messages: [], dedup: [], batch: null };
          draft.sessions.push(s);
        }
        const duplicate = s.dedup.find((d) => d.messageId === input.messageId);
        if (duplicate) return { accepted: false, duplicate: true, sessionKey, seq: duplicate.seq };
        if (!Number.isSafeInteger(s.nextSeq + 1)) throw fail('INBOX_CAPACITY', 'Inbox sequence exhausted');
        const seq = s.nextSeq++;
        s.messages.push({ ...input, seq, receivedAt: at });
        s.dedup.push({ messageId: input.messageId, seq, at });
        s.revision += 1;
        prune(draft, at);
        return { accepted: true, duplicate: false, sessionKey, seq, retained: s.messages.some((m) => m.seq === seq) };
      });
    },
    listNotices() {
      return transaction((draft) => draft.sessions.map((s) => ({
        kind: 'social.inbox_changed', sessionKey: s.sessionKey, platform: s.platform,
        connectionId: s.connectionId, conversation: s.conversation, identityRevision: s.identityRevision,
        revision: s.revision, unreadCount: s.messages.length,
        mentionsSelf: s.messages.some((m) => m.mentionsSelf === true || m.replyToSelf === true),
        ...(s.messages.length ? { firstUnreadAt: s.messages[0].receivedAt, lastMessageAt: s.messages.at(-1).receivedAt } : {}),
        hasGap: s.gapThroughSeq > s.cursor, droppedCount: s.droppedCount,
      })));
    },
    readBatch(input) {
      let ref;
      try { ref = clone(input); checkRef(ref); } catch (error) { return Promise.reject(error); }
      return transaction((draft, at) => {
        const maxMessages = ref.maxMessages ?? config.maxBatchMessages;
        const maxChars = ref.maxChars ?? config.maxBatchChars;
        if (!positive(maxMessages) || !positive(maxChars)) throw fail('INBOX_INVALID_LIMIT', 'Batch limits must be positive integers');
        const s = find(draft, ref.sessionKey, ref.identityRevision);
        if (!s) return null;
        // A retry must respect the same content/limits, not silently get a larger batch.
        if (s.batch) {
          if (s.batch.messages.length > maxMessages || s.batch.messages.reduce((n, m) => n + m.text.length, 0) > maxChars) throw fail('INBOX_BATCH_LIMIT', 'Existing stable batch exceeds requested limits');
          return publicBatch(s.batch);
        }
        if (!s.messages.length) return null;
        const messages = [];
        let chars = 0;
        for (const m of s.messages) {
          if (messages.length >= Math.min(maxMessages, config.maxBatchMessages) || chars + m.text.length > Math.min(maxChars, config.maxBatchChars)) break;
          messages.push(clone(m)); chars += m.text.length;
        }
        if (!messages.length) throw fail('INBOX_MESSAGE_TOO_LARGE', 'First unread message exceeds requested character limit');
        const batch = { batchId: randomUUID(), sessionKey: s.sessionKey, identityRevision: s.identityRevision,
          fromSeq: messages[0].seq, throughSeq: messages.at(-1).seq, messages,
          hasMore: messages.length < s.messages.length, hasGap: s.gapThroughSeq > s.cursor, createdAt: at };
        const batches = draft.sessions.flatMap((s) => s.batch ? [s.batch] : []);
        if (batches.length >= config.maxBatches || batches.reduce((n, b) => n + bytes(b), bytes(batch)) > config.maxRetainedBatchBytes) throw fail('INBOX_CAPACITY', 'Retained batch capacity reached');
        s.batch = batch;
        return publicBatch(batch);
      });
    },
    acknowledgeBatch(input, authorize = () => {}) {
      let ref;
      try {
        ref = clone(input); checkRef(ref);
        if (!text(ref.batchId) || !positive(ref.throughSeq)) throw fail('INBOX_INVALID_REFERENCE', 'Invalid batch reference');
      } catch (error) { return Promise.reject(error); }
      return transaction((draft) => {
        authorize();
        if (draft.acknowledged.some((a) => sameRef(a, ref))) return { acknowledged: true, throughSeq: ref.throughSeq };
        const s = find(draft, ref.sessionKey, ref.identityRevision);
        if (!s?.batch || !sameRef(s.batch, ref)) throw fail('INBOX_BATCH_MISMATCH', 'Unknown, expired, or mismatched batch');
        s.cursor = s.batch.throughSeq;
        s.messages = s.messages.filter((m) => m.seq > s.cursor);
        s.batch = null;
        s.revision += 1;
        draft.acknowledged.push({ batchId: ref.batchId, sessionKey: ref.sessionKey, identityRevision: ref.identityRevision, throughSeq: ref.throughSeq });
        draft.acknowledged = draft.acknowledged.slice(-config.maxAcknowledgedBatches);
        return { acknowledged: true, throughSeq: s.cursor };
      });
    },
    close() {
      if (!closePromise) {
        closed = true;
        closePromise = tail.then(() => {
          owners.delete(dir);
          if (poisoned) throw poisoned;
        });
      }
      return closePromise;
    },
  };
}

export default createInboxStore;
