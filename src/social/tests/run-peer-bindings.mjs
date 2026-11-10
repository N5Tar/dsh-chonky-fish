import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPeerBindings } from '../peer-bindings.js'
import { platform } from '../../platform/index.js'

const binding = { connectionId: 'ding', identityRevision: 'revision-1' }
const peer = (patch = {}) => ({ connectionId: 'ding', platform: 'dingtalk', sender: { id: 'sender-a', corpId: 'corp-a', staffId: 'PRIVATE_STAFF', name: 'PRIVATE_NAME' }, conversation: { type: 'direct', id: 'direct-a' }, text: '喂', ...patch })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'social-peer-bindings-')), file = join(root, 'bindings.json'), clock = { value: 1700000000000 }
  const options = { file, now: () => clock.value }, store = await createPeerBindings(options)
  return { root, file, clock, options, store }
}
let count = 0
async function test(name, body) { await body(); count++; console.log(`ok ${count} - ${name}`) }
await test('ordinary first DM never claims owner; code is high entropy, hash-only and private', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(await f.store.consumeCode(peer(), binding.identityRevision), { handled: false, bound: false })
    assert.equal(f.store.isOwner(peer(), binding.identityRevision), false)
    assert.equal(f.store.owner(binding.connectionId, binding.identityRevision), null)
    const issued = await f.store.issueCode(binding)
    assert.match(issued.code, /^FISH-PAIR-[A-Za-z0-9_-]{32}$/)
    assert.equal(issued.expiresAt, f.clock.value + 600000)
    const disk = await readFile(f.file, 'utf8')
    assert.equal(disk.includes(issued.code), false); assert.equal(disk.includes('FISH-PAIR-'), false)
    assert.match(JSON.parse(disk).codes[0].hash, /^[a-f0-9]{64}$/)
    assert.deepEqual(f.store.inspect(), { ownerCount: 0, peerCount: 0, pendingCodeCount: 1 })
    if (process.platform !== 'win32') assert.equal((await stat(f.file)).mode & 0o777, 0o600)
  } finally { await f.store.close() }
})
await test('single-use code binds only direct, retains bounded private sender data, survives restart', async () => {
  const f = await fixture(); let restarted
  try {
    const issued = await f.store.issueCode(binding), message = peer({ text: issued.code })
    assert.deepEqual(await f.store.consumeCode(peer({ text: issued.code, conversation: { type: 'group', id: 'group-a' } }), binding.identityRevision), { handled: true, bound: false })
    assert.deepEqual(await f.store.consumeCode(message, binding.identityRevision), { handled: true, bound: true })
    assert.equal(f.store.isOwner(peer(), binding.identityRevision), true)
    const owner = f.store.owner(binding.connectionId, binding.identityRevision)
    assert.deepEqual(owner.sender, peer().sender); assert.deepEqual(owner.conversation, peer().conversation)
    owner.sender.id = 'mutated'
    assert.equal(f.store.isOwner(peer(), binding.identityRevision), true, 'returned owner cannot mutate private state')
    assert.equal(JSON.stringify(f.store.inspect()).includes('PRIVATE'), false)
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).codes.length, 0)
    await f.store.close(); restarted = await createPeerBindings(f.options)
    assert.equal(restarted.isOwner(peer(), binding.identityRevision), true)
    assert.deepEqual(await restarted.consumeCode(message, binding.identityRevision), { handled: true, bound: false })
    assert.deepEqual(await restarted.consumeCode(peer({ text: issued.code, sender: { id: 'intruder' } }), binding.identityRevision), { handled: true, bound: false })
  } finally { await restarted?.close(); await f.store.close() }
})
await test('concurrent use yields exactly one durable owner binding', async () => {
  const f = await fixture()
  try {
    const { code } = await f.store.issueCode(binding)
    const results = await Promise.all([
      f.store.consumeCode(peer({ text: code }), binding.identityRevision),
      f.store.consumeCode(peer({ text: code, sender: { id: 'sender-b' } }), binding.identityRevision),
    ])
    assert.equal(results.filter(result => result.bound).length, 1)
    assert.equal(f.store.owner(binding.connectionId, binding.identityRevision).sender.id, 'sender-a')
  } finally { await f.store.close() }
})
await test('only issuing a new local code permits owner replacement; old code invalidates immediately', async () => {
  const f = await fixture()
  try {
    const old = await f.store.issueCode(binding), next = await f.store.issueCode(binding)
    assert.notEqual(old.code, next.code)
    assert.equal((await f.store.consumeCode(peer({ text: old.code }), binding.identityRevision)).bound, false)
    assert.equal((await f.store.consumeCode(peer({ text: next.code }), binding.identityRevision)).bound, true)
    const visitor = peer({ sender: { id: 'sender-b' } })
    await f.store.consumeCode(visitor, binding.identityRevision)
    assert.equal(f.store.isOwner(visitor, binding.identityRevision), false)
    const replacement = await f.store.issueCode(binding)
    assert.equal(f.store.isOwner(peer(), binding.identityRevision), true, 'issuing code alone does not transfer ownership')
    assert.equal((await f.store.consumeCode({ ...visitor, text: replacement.code }, binding.identityRevision)).bound, true)
    assert.equal(f.store.isOwner(peer(), binding.identityRevision), false)
    assert.equal(f.store.isOwner(visitor, binding.identityRevision), true)
  } finally { await f.store.close() }
})
await test('expired, wrong binding and malformed codes are consumed, never forwarded', async () => {
  const f = await fixture()
  try {
    const { code, expiresAt } = await f.store.issueCode(binding)
    for (const candidate of ['FISH-PAIR', 'fish-pair-broken', 'FISH-PAIR-?', 'FISH-PAIR-' + 'x'.repeat(10000)]) assert.deepEqual(await f.store.consumeCode(peer({ text: candidate }), binding.identityRevision), { handled: true, bound: false })
    assert.deepEqual(await f.store.consumeCode(peer({ text: 'ordinary text mentioning nothing reserved' }), binding.identityRevision), { handled: false, bound: false })
    assert.equal((await f.store.consumeCode(peer({ text: code, connectionId: 'other' }), binding.identityRevision)).bound, false)
    assert.equal((await f.store.consumeCode(peer({ text: code }), 'different-revision')).bound, false)
    assert.equal((await f.store.consumeCode(peer({ text: code, platform: 'qq' }), binding.identityRevision)).bound, false)
    f.clock.value = expiresAt
    assert.deepEqual(await f.store.consumeCode(peer({ text: code }), binding.identityRevision), { handled: true, bound: false })
    assert.equal(f.store.owner(binding.connectionId, binding.identityRevision), null)
  } finally { await f.store.close() }
})
await test('per-sender guess rate survives restart and resets only after time window', async () => {
  const f = await fixture(); let restarted
  try {
    const { code } = await f.store.issueCode(binding)
    for (let i = 0; i < 5; i++) await f.store.consumeCode(peer({ text: 'FISH-PAIR-wrong' }), binding.identityRevision)
    assert.equal((await f.store.consumeCode(peer({ text: code }), binding.identityRevision)).bound, false)
    await f.store.close(); restarted = await createPeerBindings(f.options)
    assert.equal((await restarted.consumeCode(peer({ text: code }), binding.identityRevision)).bound, false)
    f.clock.value += 60001
    assert.equal((await restarted.consumeCode(peer({ text: code }), binding.identityRevision)).bound, true)
  } finally { await restarted?.close(); await f.store.close() }
})
await test('connection-wide rate budget prevents bypass with many distinct senders', async () => {
  const f = await fixture()
  try {
    const { code } = await f.store.issueCode(binding)
    for (let i = 0; i < 30; i++) await f.store.consumeCode(peer({ text: 'FISH-PAIR-wrong', sender: { id: 'guess-' + i } }), binding.identityRevision)
    assert.equal((await f.store.consumeCode(peer({ text: code }), binding.identityRevision)).bound, false)
    f.clock.value += 60001
    assert.equal((await f.store.consumeCode(peer({ text: code }), binding.identityRevision)).bound, true)
  } finally { await f.store.close() }
})
await test('ownership key includes connection, revision and corp, not names or conversation guessing', async () => {
  const f = await fixture()
  try {
    const { code } = await f.store.issueCode(binding)
    await f.store.consumeCode(peer({ text: code }), binding.identityRevision)
    assert.equal(f.store.isOwner(peer({ connectionId: 'other' }), binding.identityRevision), false)
    assert.equal(f.store.isOwner(peer(), 'other-revision'), false)
    assert.equal(f.store.isOwner(peer({ sender: { id: 'sender-a', corpId: 'other-corp' } }), binding.identityRevision), false)
    assert.equal(f.store.isOwner(peer({ sender: { id: 'other-id', corpId: 'corp-a', name: 'PRIVATE_NAME' } }), binding.identityRevision), false)
    assert.equal(f.store.isOwner(peer({ sender: { id: 'sender-a' }, senderCorpId: 'corp-a' }), binding.identityRevision), true)
    assert.equal(f.store.isOwner(peer({ senderCorpId: 'conflict' }), binding.identityRevision), false)
  } finally { await f.store.close() }
})
await test('visitor session id is persisted before create and ready sessions reuse without create', async () => {
  const f = await fixture(); let calls = 0, reserved
  try {
    const sessionId = await f.store.ensurePeerSession(peer(), binding.identityRevision, async ({ sessionId }) => {
      calls++; reserved = sessionId
      assert.match(sessionId, /^social-peer-/)
      const disk = JSON.parse(await readFile(f.file, 'utf8'))
      assert.equal(disk.peers[0].sessionId, sessionId); assert.equal(disk.peers[0].status, 'reserved')
      assert.equal(f.store.hasPeerSession(sessionId), true)
      return { sessionId }
    })
    assert.equal(sessionId, reserved); assert.equal(f.store.isOwner(peer(), binding.identityRevision), false)
    assert.equal(await f.store.ensurePeerSession(peer({ conversation: { type: 'direct', id: 'changed-dm-id' } }), binding.identityRevision, () => assert.fail('ready session must reuse')), sessionId)
    assert.equal(calls, 1); assert.equal(f.store.hasPeerSession('unregistered'), false)
  } finally { await f.store.close() }
})
await test('crash after Host create retries original durable reservation, never a new id', async () => {
  const f = await fixture(); let original, restarted
  try {
    await assert.rejects(f.store.ensurePeerSession(peer(), binding.identityRevision, async ({ sessionId }) => { original = sessionId; throw new Error('SECRET callback failed after create') }), { code: 'SOCIAL_PEER_CREATE_FAILED' })
    await f.store.close(); restarted = await createPeerBindings(f.options)
    assert.equal(restarted.hasPeerSession(original), true)
    const result = await restarted.ensurePeerSession(peer(), binding.identityRevision, async ({ sessionId }) => { assert.equal(sessionId, original); return { sessionId } })
    assert.equal(result, original)
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).peers.length, 1)
  } finally { await restarted?.close(); await f.store.close() }
})
await test('Host returning a different session id cannot replace the reserved route', async () => {
  const f = await fixture(); let reserved
  try {
    await assert.rejects(f.store.ensurePeerSession(peer(), binding.identityRevision, async ({ sessionId }) => { reserved = sessionId; return { sessionId: 'wrong-main-session' } }), { code: 'SOCIAL_PEER_SESSION_MISMATCH' })
    assert.equal(f.store.hasPeerSession('wrong-main-session'), false)
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).peers[0].status, 'reserved')
    assert.equal(await f.store.ensurePeerSession(peer(), binding.identityRevision, async ({ sessionId }) => { assert.equal(sessionId, reserved) }), reserved)
  } finally { await f.store.close() }
})
await test('same sender DM, groups and channels isolate; owner groups are still visitors', async () => {
  const f = await fixture()
  try {
    const create = async ({ sessionId }) => ({ sessionId })
    const dm = await f.store.ensurePeerSession(peer(), binding.identityRevision, create)
    const groupA = peer({ conversation: { type: 'group', id: 'group-a' } }), groupB = peer({ conversation: { type: 'group', id: 'group-b' } })
    const a = await f.store.ensurePeerSession(groupA, binding.identityRevision, create), b = await f.store.ensurePeerSession(groupB, binding.identityRevision, create)
    const channelA = await f.store.ensurePeerSession(peer({ conversation: { type: 'channel', id: 'same-channel', guildId: 'guild-a' } }), binding.identityRevision, create)
    const channelB = await f.store.ensurePeerSession(peer({ conversation: { type: 'channel', id: 'same-channel', guildId: 'guild-b' } }), binding.identityRevision, create)
    assert.equal(new Set([dm, a, b, channelA, channelB]).size, 5)
    const { code } = await f.store.issueCode(binding); await f.store.consumeCode(peer({ text: code }), binding.identityRevision)
    await assert.rejects(f.store.ensurePeerSession(peer(), binding.identityRevision, create), { code: 'SOCIAL_PEER_IS_OWNER' })
    assert.equal(f.store.isOwner(groupA, binding.identityRevision), true)
    assert.equal(await f.store.ensurePeerSession(groupA, binding.identityRevision, create), a)
    assert.equal(await f.store.ensurePeerSession(groupB, binding.identityRevision, create), b)
    const differentSender = await f.store.ensurePeerSession(peer({ sender: { id: 'other' } }), binding.identityRevision, create)
    const differentRevision = await f.store.ensurePeerSession(peer(), 'revision-2', create)
    const differentCorp = await f.store.ensurePeerSession(peer({ sender: { id: 'sender-a', corpId: 'corp-b' } }), binding.identityRevision, create)
    assert.equal(new Set([dm, differentSender, differentRevision, differentCorp]).size, 4)
  } finally { await f.store.close() }
})
await test('concurrent same-peer ensure calls create only one session', async () => {
  const f = await fixture(); let count = 0
  try {
    const callback = async ({ sessionId }) => { count++; return { sessionId } }
    const ids = await Promise.all(Array.from({ length: 10 }, () => f.store.ensurePeerSession(peer(), binding.identityRevision, callback)))
    assert.equal(new Set(ids).size, 1); assert.equal(count, 1)
  } finally { await f.store.close() }
})
await test('corrupt state fails closed without rewriting or exposing file contents', async () => {
  const f = await fixture()
  await f.store.close()
  const raw = '{PRIVATE_CORRUPT'
  await writeFile(f.file, raw)
  await assert.rejects(createPeerBindings(f.options), error => error.code === 'SOCIAL_PEER_BINDINGS_INVALID' && !error.message.includes('PRIVATE'))
  assert.equal(await readFile(f.file, 'utf8'), raw)
})
await test('failed persistence poisons authorizations and emits only stable error codes', async () => {
  const f = await fixture()
  try {
    await mkdir(f.file)
    await assert.rejects(f.store.issueCode(binding), { code: 'SOCIAL_PEER_STORAGE_UNCERTAIN' })
    assert.equal(f.store.owner(binding.connectionId, binding.identityRevision), null)
    assert.equal(f.store.isOwner(peer(), binding.identityRevision), false)
    assert.equal(f.store.hasPeerSession('anything'), false)
    await assert.rejects(f.store.issueCode(binding), { code: 'SOCIAL_PEER_STORAGE_UNCERTAIN' })
  } finally { await f.store.close() }
})
await test('close during Host create leaves reusable reservation and cannot claim readiness', async () => {
  const f = await fixture(); let release, entered, reserved
  const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve })
  const creating = f.store.ensurePeerSession(peer(), binding.identityRevision, async ({ sessionId }) => { reserved = sessionId; entered(); await gate; return { sessionId } })
  await ready; const closing = f.store.close(); release()
  await assert.rejects(creating, { code: 'SOCIAL_PEER_BINDINGS_CLOSED' }); await closing
  assert.equal(f.store.hasPeerSession(reserved), false)
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).peers[0].status, 'reserved')
})
await test('new owner remains invisible until durability barrier; replacement publishes a new claim id', async () => {
  const f = await fixture(), originalSync = platform.syncDirectory
  let release, write
  try {
    for (const senderId of ['first-owner', 'replacement-owner']) {
      const before = f.store.owner(binding.connectionId, binding.identityRevision)
      const message = peer({ sender: { id: senderId, corpId: 'corp-a' } })
      const { code } = await f.store.issueCode(binding)
      let entered
      const barrier = new Promise(resolve => { release = resolve }), reached = new Promise(resolve => { entered = resolve })
      platform.syncDirectory = async path => { if (path === f.root) { entered(); await barrier }; await originalSync(path) }
      write = f.store.consumeCode({ ...message, text: code }, binding.identityRevision)
      await reached
      assert.deepEqual(f.store.owner(binding.connectionId, binding.identityRevision), before, 'unconfirmed state must not become an authorization source')
      assert.equal(f.store.isOwner(message, binding.identityRevision), false)
      release(); assert.deepEqual(await write, { handled: true, bound: true }); write = null
      platform.syncDirectory = originalSync
      const after = f.store.owner(binding.connectionId, binding.identityRevision)
      assert.equal(after.sender.id, senderId); assert.equal(f.store.isOwner(message, binding.identityRevision), true)
      assert.match(after.claimId, /^[a-f0-9-]{36}$/)
      if (before) assert.notEqual(after.claimId, before.claimId, 'same-millisecond ownership changes have distinct claims')
    }
  } finally { release?.(); if (write) await write.catch(() => {}); platform.syncDirectory = originalSync; await f.store.close() }
})
await test('reserved peer session is not allowlisted before its durability barrier', async () => {
  const f = await fixture(), originalSync = platform.syncDirectory
  let release, entered, creating, created = false
  const barrier = new Promise(resolve => { release = resolve }), reached = new Promise(resolve => { entered = resolve })
  try {
    platform.syncDirectory = async path => { if (path === f.root) { entered(); await barrier }; await originalSync(path) }
    creating = f.store.ensurePeerSession(peer(), binding.identityRevision, async ({ sessionId }) => { created = true; assert.equal(f.store.hasPeerSession(sessionId), true); return { sessionId } })
    await reached
    const reserved = JSON.parse(await readFile(f.file, 'utf8')).peers[0].sessionId
    assert.equal(f.store.hasPeerSession(reserved), false)
    assert.equal(created, false, 'Host create must follow reservation durability, not just rename')
    release(); assert.equal(await creating, reserved); creating = null
    assert.equal(f.store.hasPeerSession(reserved), true)
  } finally { release(); if (creating) await creating.catch(() => {}); platform.syncDirectory = originalSync; await f.store.close() }
})
await test('failed delayed ownership durability never grants the proposed owner', async () => {
  const f = await fixture(), originalSync = platform.syncDirectory
  let release, entered, writing
  const barrier = new Promise(resolve => { release = resolve }), reached = new Promise(resolve => { entered = resolve })
  try {
    const { code } = await f.store.issueCode(binding)
    platform.syncDirectory = async path => { if (path === f.root) { entered(); await barrier; throw new Error('PRIVATE disk failure') }; await originalSync(path) }
    writing = f.store.consumeCode(peer({ text: code }), binding.identityRevision)
    const rejected = assert.rejects(writing, { code: 'SOCIAL_PEER_STORAGE_UNCERTAIN' })
    await reached
    assert.equal(f.store.owner(binding.connectionId, binding.identityRevision), null)
    assert.equal(f.store.isOwner(peer(), binding.identityRevision), false)
    release(); await rejected; writing = null
    assert.equal(f.store.owner(binding.connectionId, binding.identityRevision), null)
    assert.equal(f.store.isOwner(peer(), binding.identityRevision), false)
  } finally { release(); if (writing) await writing.catch(() => {}); platform.syncDirectory = originalSync; await f.store.close() }
})
console.log(`peer-bindings: ${count}/${count} passed (local mocks only; no credentials, network or Host sessions)`)
