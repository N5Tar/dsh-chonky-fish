import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInboxStore, createSessionKey } from '../inbox-store.js';

// Fixtures remain in this clearly identified temporary root for failure diagnosis.
const root = await mkdtemp(join(tmpdir(), 'social-inbox-test-'));
let tests = 0;
const revision = 'identity-1';
const message = (id, overrides = {}) => ({
  platform: 'qq', connectionId: 'qq-main', provider: 'napcat',
  messageId: String(id), conversation: { type: 'direct', id: 'peer' },
  sender: { id: 'peer', name: 'External text' }, text: `message-${id}`,
  sentAt: 1000 - Number(id), ...overrides,
});
const key = createSessionKey(message(1));
const ref = (overrides = {}) => ({ sessionKey: key, identityRevision: revision, ...overrides });
const append = (store, id, overrides) => store.append(message(id, overrides), { identityRevision: revision });
const rejects = (fn, code) => assert.rejects(fn, { code });
async function test(name, fn) {
  const directory = join(root, String(++tests));
  await fn(directory);
  console.log(`ok ${tests} - ${name}`);
}

await test('stable 1–6 batch, arrival 7, exact acknowledgement and restart', async (directory) => {
  let store = await createInboxStore({ directory });
  for (let i = 1; i <= 6; i++) await append(store, i, { mentionsSelf: i === 2 });
  const batch = await store.readBatch(ref());
  assert.deepEqual(batch.messages.map((m) => m.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(batch.hasMore, false);
  await append(store, 7);
  assert.deepEqual(await store.readBatch(ref()), batch);
  await rejects(() => store.acknowledgeBatch({ ...batch, throughSeq: 7 }), 'INBOX_BATCH_MISMATCH');
  await rejects(() => store.acknowledgeBatch({ ...batch, identityRevision: 'other' }), 'INBOX_BATCH_MISMATCH');
  await rejects(() => store.acknowledgeBatch({ ...batch, sessionKey: 'wrong' }), 'INBOX_BATCH_MISMATCH');
  await store.close();
  store = await createInboxStore({ directory });
  assert.deepEqual(await store.readBatch(ref()), batch);
  await store.acknowledgeBatch(batch);
  await store.acknowledgeBatch(batch);
  const notices = await store.listNotices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].unreadCount, 1);
  assert.equal(notices[0].mentionsSelf, false);
  assert.equal(JSON.stringify(notices).includes('message-'), false);
  assert.equal((await store.readBatch(ref())).fromSeq, 7);
  await store.close();
  store = await createInboxStore({ directory });
  await store.acknowledgeBatch(batch);
  assert.equal((await store.listNotices())[0].unreadCount, 1);
  await store.close();
});

await test('concurrent serialization, dedup and detached values', async (directory) => {
  const store = await createInboxStore({ directory });
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => append(store, i)));
  assert.deepEqual(results.map((r) => r.seq), Array.from({ length: 30 }, (_, i) => i + 1));
  const duplicates = await Promise.all(Array.from({ length: 20 }, () => append(store, 1)));
  assert.equal(duplicates.every((r) => r.duplicate), true);
  const pending = message(100);
  const operation = store.append(pending, { identityRevision: revision });
  pending.text = 'mutated';
  await operation;
  const batches = await Promise.all(Array.from({ length: 10 }, () => store.readBatch(ref())));
  assert.equal(new Set(batches.map((b) => b.batchId)).size, 1);
  assert.equal(batches[0].messages.at(-1).text, 'message-100');
  batches[0].messages[0].text = 'mutated';
  assert.equal((await store.readBatch(ref())).messages[0].text, 'message-0');
  await store.close();
});

await test('identity, guild, platform and connection isolation', async (directory) => {
  const store = await createInboxStore({ directory });
  await append(store, 1);
  await store.append(message(1), { identityRevision: 'identity-2' });
  await append(store, 1, { connectionId: 'other' });
  await append(store, 1, { platform: 'discord', conversation: { type: 'channel', guildId: 'g1', id: 'same' } });
  await append(store, 1, { platform: 'discord', conversation: { type: 'channel', guildId: 'g2', id: 'same' } });
  assert.equal((await store.listNotices()).length, 5);
  assert.equal(await store.readBatch(ref({ identityRevision: 'unknown' })), null);
  assert.equal(createSessionKey(message(1)), JSON.stringify(['qq', 'qq-main', 'direct', '', 'peer']));
  assert.notEqual(createSessionKey(message(1, { connectionId: 'a,b', conversation: { type: 'direct', id: 'c' } })), createSessionKey(message(1, { connectionId: 'a', conversation: { type: 'direct', id: 'b,c' } })));
  await store.close();
});

await test('per-session/global capacity, session cap and visible gaps', async (directory) => {
  const store = await createInboxStore({ directory, limits: { maxMessagesPerSession: 2, maxMessages: 3, maxSessions: 2 } });
  for (let i = 1; i <= 3; i++) await append(store, i);
  let notice = (await store.listNotices())[0];
  assert.equal(notice.unreadCount, 2); assert.equal(notice.hasGap, true); assert.equal(notice.droppedCount, 1);
  await append(store, 4, { conversation: { type: 'direct', id: 'second' } });
  await append(store, 5, { conversation: { type: 'direct', id: 'second' } });
  const notices = await store.listNotices();
  assert.equal(notices.reduce((n, s) => n + s.unreadCount, 0), 3);
  assert.equal(notices[0].droppedCount, 2);
  await rejects(() => append(store, 6, { conversation: { type: 'direct', id: 'third' } }), 'INBOX_CAPACITY');
  const batch = await store.readBatch(ref());
  assert.equal(batch.fromSeq, 3); assert.equal(batch.hasGap, true);
  await store.acknowledgeBatch(batch);
  notice = (await store.listNotices())[0];
  assert.equal(notice.hasGap, false);
  await store.close();
});

await test('TTL gaps and bounded stable batch lifetime', async (directory) => {
  let time = 100;
  const store = await createInboxStore({ directory, now: () => time, limits: { ttlMs: 10, batchTtlMs: 20 } });
  await append(store, 1);
  const batch = await store.readBatch(ref());
  time = 110;
  const notice = (await store.listNotices())[0];
  assert.equal(notice.unreadCount, 0); assert.equal(notice.droppedCount, 1); assert.equal(notice.hasGap, true);
  assert.deepEqual(await store.readBatch(ref()), batch);
  time = 120;
  await rejects(() => store.acknowledgeBatch(batch), 'INBOX_BATCH_MISMATCH');
  assert.equal(await store.readBatch(ref()), null);
  await append(store, 2);
  const next = await store.readBatch(ref());
  assert.equal(next.hasGap, true); assert.equal(next.fromSeq, 2);
  await store.acknowledgeBatch(next);
  assert.equal((await store.listNotices())[0].hasGap, false);
  await store.close();
});

await test('batch count/bytes caps and expiry release retained capacity', async (directory) => {
  let time = 0;
  const store = await createInboxStore({ directory, now: () => time, limits: { maxBatches: 1, batchTtlMs: 5 } });
  await append(store, 1);
  const second = message(2, { conversation: { type: 'direct', id: 'second' } });
  await store.append(second, { identityRevision: revision });
  await store.readBatch(ref());
  const secondRef = ref({ sessionKey: createSessionKey(second) });
  await rejects(() => store.readBatch(secondRef), 'INBOX_CAPACITY');
  time = 5;
  assert.ok(await store.readBatch(secondRef));
  await store.close();
  const other = await createInboxStore({ directory: join(directory, 'bytes'), limits: { maxRetainedBatchBytes: 1 } });
  await append(other, 1);
  await rejects(() => other.readBatch(ref()), 'INBOX_CAPACITY');
  assert.equal((await other.listNotices())[0].unreadCount, 1);
  await other.close();
});

await test('message/batch limits never truncate, skip, or overrun requested limits', async (directory) => {
  const store = await createInboxStore({ directory, limits: { maxBatchChars: 10, maxBatchMessages: 2, maxMessageBytes: 1024 } });
  await rejects(() => append(store, 0, { text: 'a'.repeat(11) }), 'INBOX_MESSAGE_TOO_LARGE');
  await rejects(() => append(store, 0, { text: 'ok', extra: 'x'.repeat(1024) }), 'INBOX_MESSAGE_TOO_LARGE');
  await append(store, 1, { text: 'abcde' });
  await append(store, 2, { text: 'fghij' });
  await append(store, 3, { text: 'x' });
  await rejects(() => store.readBatch(ref({ maxChars: 4 })), 'INBOX_MESSAGE_TOO_LARGE');
  const batch = await store.readBatch(ref({ maxChars: 5 }));
  assert.equal(batch.messages.length, 1); assert.equal(batch.messages[0].text, 'abcde');
  assert.equal(batch.hasMore, true);
  await rejects(() => store.readBatch(ref({ maxChars: 4 })), 'INBOX_BATCH_LIMIT');
  await store.acknowledgeBatch(batch);
  const next = await store.readBatch(ref({ maxMessages: 1000, maxChars: 1000 }));
  assert.equal(next.messages.length, 2);
  assert.equal(next.messages.reduce((n, m) => n + m.text.length, 0), 6);
  await store.close();
});

await test('finite dedup and ack windows survive restart', async (directory) => {
  let store = await createInboxStore({ directory, limits: { maxDedupEntriesPerSession: 2, maxAcknowledgedBatches: 1 } });
  await append(store, 1);
  const first = await store.readBatch(ref()); await store.acknowledgeBatch(first);
  await append(store, 2);
  const second = await store.readBatch(ref()); await store.acknowledgeBatch(second);
  await append(store, 3);
  await rejects(() => store.acknowledgeBatch(first), 'INBOX_BATCH_MISMATCH');
  assert.equal((await append(store, 2)).duplicate, true);
  assert.equal((await append(store, 1)).accepted, true);
  await store.close();
  store = await createInboxStore({ directory, limits: { maxDedupEntriesPerSession: 2, maxAcknowledgedBatches: 1 } });
  assert.equal((await append(store, 1)).duplicate, true);
  await store.acknowledgeBatch(second);
  await store.close();
});

await test('corrupt JSON/checksum/schema fail closed without overwriting', async (directory) => {
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'inbox-state.json');
  for (const invalid of ['{', JSON.stringify({ payload: '{}', sha256: 'wrong' }), (() => {
    const payload = JSON.stringify({ version: 1, sessions: [{ identityRevision: 'x', sessionKey: 'bad' }], acknowledged: [] });
    return JSON.stringify({ payload, sha256: createHash('sha256').update(payload).digest('hex') });
  })()]) {
    await writeFile(file, invalid);
    await rejects(() => createInboxStore({ directory }), 'INBOX_CORRUPT');
    assert.equal(await readFile(file, 'utf8'), invalid);
  }
});

await test('private snapshot, bounded disk size, failed capacity leaves state unchanged', async (directory) => {
  const store = await createInboxStore({ directory, limits: { maxStateBytes: 1500 } });
  await append(store, 1);
  const file = join(directory, 'inbox-state.json');
  const before = await readFile(file, 'utf8');
  await rejects(() => append(store, 2, { text: 'x'.repeat(1400) }), 'INBOX_CAPACITY');
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await store.listNotices())[0].unreadCount, 1);
  await store.close();
});

await test('byte capacities evict unread with explicit gap even for single too-large entry', async (directory) => {
  const store = await createInboxStore({ directory, limits: { maxBytes: 1, maxBytesPerSession: 1 } });
  const result = await append(store, 1);
  assert.equal(result.retained, false);
  const notice = (await store.listNotices())[0];
  assert.equal(notice.unreadCount, 0); assert.equal(notice.hasGap, true); assert.equal(notice.droppedCount, 1);
  await store.close();
});

await test('close drains writes, rejects later operations, rejects duplicate owners', async (directory) => {
  const store = await createInboxStore({ directory });
  await rejects(() => createInboxStore({ directory }), 'INBOX_ALREADY_OPEN');
  const pending = append(store, 1);
  const closing = store.close();
  await rejects(() => append(store, 2), 'INBOX_CLOSED');
  await rejects(() => store.listNotices(), 'INBOX_CLOSED');
  await pending; await closing;
  const reopened = await createInboxStore({ directory });
  await store.close(); // A repeated old close must not release the new owner's guard.
  await rejects(() => createInboxStore({ directory }), 'INBOX_ALREADY_OPEN');
  assert.equal((await reopened.listNotices())[0].unreadCount, 1);
  await reopened.close();
});

await test('strict invalid input and configured bounds', async (directory) => {
  for (const limits of [{ maxMessages: Infinity }, { maxMessages: 0 }, { maxMessages: -1 }, { nope: 5 }, { toString: 5 }]) {
    await rejects(() => createInboxStore({ directory, limits }), 'INBOX_INVALID_LIMIT');
  }
  const store = await createInboxStore({ directory });
  await rejects(() => store.append(message(1)), 'INBOX_INVALID_REFERENCE');
  await rejects(() => append(store, 1, { conversation: { type: 'channel', id: 'missing-guild' } }), 'INBOX_INVALID_MESSAGE');
  await rejects(() => store.readBatch(ref({ maxMessages: 0 })), 'INBOX_INVALID_LIMIT');
  await rejects(() => store.acknowledgeBatch(ref({ batchId: 'x', throughSeq: 0 })), 'INBOX_INVALID_REFERENCE');
  await store.close();
});

await test('write failure is fail-closed and never publishes uncommitted notices', async (directory) => {
  const store = await createInboxStore({ directory });
  await append(store, 1);
  const snapshot = await readFile(join(directory, 'inbox-state.json'), 'utf8');
  await mkdir(join(directory, '.inbox-state.tmp'));
  await rejects(() => append(store, 2), 'INBOX_WRITE_FAILED');
  await rejects(() => store.listNotices(), 'INBOX_WRITE_FAILED');
  assert.equal(await readFile(join(directory, 'inbox-state.json'), 'utf8'), snapshot);
  await rejects(() => store.close(), 'INBOX_WRITE_FAILED');
  const recovered = await createInboxStore({ directory });
  assert.equal((await recovered.listNotices())[0].unreadCount, 1);
  await recovered.close();
});

await test('retained snapshot stays stable across global eviction and exact acknowledgement', async (directory) => {
  const store = await createInboxStore({ directory, limits: { maxMessages: 1 } });
  await append(store, 1);
  const first = await store.readBatch(ref());
  await append(store, 2);
  assert.deepEqual(await store.readBatch(ref()), first);
  await store.acknowledgeBatch(first);
  assert.equal((await store.readBatch(ref())).fromSeq, 2);
  await store.close();
});

await test('recovery rejects tighter retained metadata bounds without overwriting', async (directory) => {
  const store = await createInboxStore({ directory });
  await append(store, 1);
  await append(store, 2, { conversation: { type: 'direct', id: 'other' } });
  await store.close();
  const snapshot = await readFile(join(directory, 'inbox-state.json'), 'utf8');
  await rejects(() => createInboxStore({ directory, limits: { maxSessions: 1 } }), 'INBOX_CORRUPT');
  assert.equal(await readFile(join(directory, 'inbox-state.json'), 'utf8'), snapshot);
});

await test('bounded pending operation queue applies backpressure and recovers capacity', async (directory) => {
  const store = await createInboxStore({ directory, limits: { maxPendingOperations: 1 } });
  const pending = append(store, 1);
  await rejects(() => append(store, 2), 'INBOX_CAPACITY');
  await pending;
  assert.equal((await append(store, 3)).seq, 2);
  assert.equal((await store.listNotices())[0].unreadCount, 2);
  await store.close();
});

console.log(`\n${tests} inbox tests passed. Temporary fixtures: ${root}`);
