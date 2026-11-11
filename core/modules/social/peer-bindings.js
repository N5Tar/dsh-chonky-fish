import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { digest, fail, plain, text, keys, conversation, readJson, writeJson, serial } from './core.js'

const PREFIX = 'FISH-PAIR-'
const TTL = 10 * 60 * 1000
const WINDOW = 60 * 1000
const MAX_BINDINGS = 64, MAX_PEERS = 1024, MAX_GUESSES = 2048
const HASH = /^[a-f0-9]{64}$/
const SESSION = /^social-peer-[a-f0-9-]{36}$/
const INVALID = 'SOCIAL_PEER_BINDINGS_INVALID'
function binding(value) {
  if (!text(value?.connectionId, 80) || !text(value?.identityRevision)) fail(INVALID)
  return { connectionId: value.connectionId, identityRevision: value.identityRevision }
}
function bindingKey(value) { return digest(JSON.stringify([value.connectionId, value.identityRevision])) }
function identityKey(value, sender) { return digest(JSON.stringify([value.connectionId, value.identityRevision, sender.id, sender.corpId ?? ''])) }
function peerKey(value) { return digest(JSON.stringify([value.identityKey, value.scope])) }
function timestamp(value) { return Number.isSafeInteger(value) && value >= 0 }
function messageIdentity(message, identityRevision) {
  const owner = binding({ connectionId: message?.connectionId, identityRevision })
  if (!plain(message?.sender) || !text(message.sender.id)) fail(INVALID)
  const corp = message.sender.corpId ?? message.senderCorpId
  if (corp !== undefined && !text(corp)) fail(INVALID)
  if (message.sender.corpId !== undefined && message.senderCorpId !== undefined && message.sender.corpId !== message.senderCorpId) fail(INVALID)
  const sender = { id: message.sender.id, ...(corp !== undefined ? { corpId: corp } : {}) }
  const staffId = message.sender.staffId ?? message.senderStaffId
  if (text(staffId)) sender.staffId = staffId
  if (text(message.sender.name)) sender.name = message.sender.name
  return { ...owner, sender, conversation: conversation(message.conversation), identityKey: identityKey(owner, sender) }
}
function validate(raw) {
  try {
    keys(raw, ['version', 'owners', 'codes', 'peers', 'guesses'])
    if (raw.version !== 1 || !Array.isArray(raw.owners) || raw.owners.length > MAX_BINDINGS || !Array.isArray(raw.codes) || raw.codes.length > MAX_BINDINGS || !Array.isArray(raw.peers) || raw.peers.length > MAX_PEERS || !Array.isArray(raw.guesses) || raw.guesses.length > MAX_GUESSES) fail(INVALID)
    const ownerIds = new Set(), codeIds = new Set(), peerIds = new Set(), sessions = new Set(), guessIds = new Set()
    for (const row of raw.owners) {
      keys(row, ['connectionId', 'identityRevision', 'sender', 'conversation', 'boundAt', 'claimId'])
      binding(row); keys(row.sender, ['id', 'corpId', 'staffId', 'name'])
      if (row.claimId !== undefined && !text(row.claimId)) fail(INVALID)
      if (!text(row.sender.id) || ['corpId', 'staffId', 'name'].some(name => row.sender[name] !== undefined && !text(row.sender[name])) || conversation(row.conversation).type !== 'direct' || !timestamp(row.boundAt)) fail(INVALID)
      const key = bindingKey(row)
      if (ownerIds.has(key)) fail(INVALID)
      ownerIds.add(key)
    }
    for (const row of raw.codes) {
      keys(row, ['connectionId', 'identityRevision', 'hash', 'issuedAt', 'expiresAt'])
      binding(row)
      if (!HASH.test(row.hash) || !timestamp(row.issuedAt) || !timestamp(row.expiresAt) || row.expiresAt - row.issuedAt !== TTL || codeIds.has(bindingKey(row))) fail(INVALID)
      codeIds.add(bindingKey(row))
    }
    for (const row of raw.peers) {
      keys(row, ['key', 'identityKey', 'connectionId', 'identityRevision', 'scope', 'sessionId', 'status'])
      binding(row)
      if (!HASH.test(row.key) || !HASH.test(row.identityKey) || row.key !== peerKey(row) || !SESSION.test(row.sessionId) || !['reserved', 'ready'].includes(row.status) || peerIds.has(row.key) || sessions.has(row.sessionId)) fail(INVALID)
      if (row.scope?.type === 'direct') keys(row.scope, ['type'])
      else if (!['group', 'channel'].includes(conversation(row.scope).type)) fail(INVALID)
      peerIds.add(row.key); sessions.add(row.sessionId)
    }
    for (const row of raw.guesses) {
      keys(row, ['key', 'windowStart', 'count'])
      if (!HASH.test(row.key) || !timestamp(row.windowStart) || !Number.isSafeInteger(row.count) || row.count < 1 || row.count > 30 || guessIds.has(row.key)) fail(INVALID)
      guessIds.add(row.key)
    }
    return raw
  } catch { fail(INVALID) }
}

/** Local Host store only. Never send inspect(), ownership data or codes to a model.
 * create({sessionId}) must resume that reserved ID before trying to create it.
 * A failed callback keeps the reservation: crash recovery retries the SAME ID.
 * All callers for one file must share this instance (single Host ownership). */
export async function createPeerBindings({ file, now = Date.now, syncDirectory = async () => {} }) {
  if (!text(file, 4096)) fail(INVALID)
  let state
  try { state = validate(await readJson(file, { version: 1, owners: [], codes: [], peers: [], guesses: [] })) } catch { fail(INVALID) }
  const run = serial(128)
  let committedOwners = structuredClone(state.owners), committedPeers = structuredClone(state.peers)
  let closed = false, poisoned = false, closePromise
  function active() { if (closed) fail('SOCIAL_PEER_BINDINGS_CLOSED'); if (poisoned) fail('SOCIAL_PEER_STORAGE_UNCERTAIN') }
  function at() { const value = now(); if (!timestamp(value) || !timestamp(value + TTL)) fail(INVALID); return value }
  async function persist() {
    try {
      await writeJson(file, state, { syncDirectory })
      committedOwners = structuredClone(state.owners)
      committedPeers = structuredClone(state.peers)
    } catch { poisoned = true; fail('SOCIAL_PEER_STORAGE_UNCERTAIN') }
  }
  function owner(connectionId, identityRevision) {
    if (closed || poisoned) return null
    try { const key = bindingKey(binding({ connectionId, identityRevision })); return structuredClone(committedOwners.find(row => bindingKey(row) === key) ?? null) } catch { return null }
  }
  function isOwner(message, identityRevision) {
    if (closed || poisoned || message?.platform !== 'dingtalk') return false
    try {
      const peer = messageIdentity(message, identityRevision), found = owner(peer.connectionId, identityRevision)
      return !!found && identityKey(found, found.sender) === peer.identityKey
    } catch { return false }
  }
  function expire(time) {
    state.codes = state.codes.filter(row => row.expiresAt > time)
    state.guesses = state.guesses.filter(row => time - row.windowStart < WINDOW)
  }
  return {
    issueCode(input) {
      input = structuredClone(input)
      return run(async () => {
        active(); keys(input, ['connectionId', 'identityRevision'])
        const selected = binding(input), key = bindingKey(selected), time = at()
        expire(time)
        if (state.codes.length >= MAX_BINDINGS && !state.codes.some(row => bindingKey(row) === key)) fail('SOCIAL_PEER_CAPACITY')
        const code = PREFIX + randomBytes(24).toString('base64url'), expiresAt = time + TTL
        state.codes = state.codes.filter(row => bindingKey(row) !== key)
        state.codes.push({ ...selected, hash: digest(code), issuedAt: time, expiresAt })
        await persist() // No plaintext code is ever stored.
        return { code, expiresAt }
      })
    },
    consumeCode(message, identityRevision) {
      message = structuredClone(message)
      return run(async () => {
        active()
        const candidate = typeof message?.text === 'string' ? message.text.trim() : ''
        if (!/^FISH-PAIR/i.test(candidate)) return { handled: false, bound: false }
        // Reserved-prefix input is consumed even malformed, expired or in a group.
        if (message?.platform !== 'dingtalk' || message?.conversation?.type !== 'direct') return { handled: true, bound: false }
        let peer
        try { peer = messageIdentity(message, identityRevision) } catch { return { handled: true, bound: false } }
        const time = at(); expire(time)
        const rateKeys = [digest(JSON.stringify(['sender', peer.identityKey])), digest(JSON.stringify(['binding', bindingKey(peer)]))]
        const limits = [5, 30]
        const rows = rateKeys.map(key => state.guesses.find(row => row.key === key))
        if (rows.some((row, i) => row && row.count >= limits[i]) || state.guesses.length + rows.filter(row => !row).length > MAX_GUESSES) return { handled: true, bound: false }
        rows.forEach((row, i) => { if (row) row.count++; else state.guesses.push({ key: rateKeys[i], windowStart: time, count: 1 }) })
        const code = state.codes.find(row => bindingKey(row) === bindingKey(peer))
        const valid = /^FISH-PAIR-[A-Za-z0-9_-]{32}$/.test(candidate) && code && time >= code.issuedAt && time < code.expiresAt && timingSafeEqual(Buffer.from(code.hash, 'hex'), Buffer.from(digest(candidate), 'hex'))
        if (!valid) { await persist(); return { handled: true, bound: false } }
        const ownerKey = bindingKey(peer)
        if (state.owners.length >= MAX_BINDINGS && !state.owners.some(row => bindingKey(row) === ownerKey)) { await persist(); return { handled: true, bound: false } }
        const { identityKey: _, ...record } = peer
        state.owners = state.owners.filter(row => bindingKey(row) !== ownerKey)
        state.owners.push({ ...record, boundAt: time, claimId: randomUUID() })
        state.codes = state.codes.filter(row => bindingKey(row) !== ownerKey)
        await persist() // Atomic owner replacement AND single-use code consumption.
        return { handled: true, bound: true }
      })
    },
    owner, isOwner,
    inspect() { return { ownerCount: closed || poisoned ? 0 : state.owners.length, peerCount: closed || poisoned ? 0 : state.peers.length, pendingCodeCount: closed || poisoned ? 0 : state.codes.filter(row => row.expiresAt > now()).length } },
    hasPeerSession(sessionId) { return !closed && !poisoned && typeof sessionId === 'string' && committedPeers.some(row => row.sessionId === sessionId) },
    ensurePeerSession(message, identityRevision, create) {
      message = structuredClone(message)
      return run(async () => {
        active()
        const peer = messageIdentity(message, identityRevision)
        if (peer.conversation.type === 'direct' && isOwner(message, identityRevision)) fail('SOCIAL_PEER_IS_OWNER')
        const scope = peer.conversation.type === 'direct' ? { type: 'direct' } : peer.conversation
        const key = peerKey({ identityKey: peer.identityKey, scope })
        let row = state.peers.find(value => value.key === key)
        if (row?.status === 'ready') return row.sessionId
        if (typeof create !== 'function') fail('SOCIAL_PEER_CREATE_REQUIRED')
        if (!row) {
          if (state.peers.length >= MAX_PEERS) fail('SOCIAL_PEER_CAPACITY')
          row = { key, identityKey: peer.identityKey, connectionId: peer.connectionId, identityRevision, scope, sessionId: 'social-peer-' + randomUUID(), status: 'reserved' }
          state.peers.push(row)
          await persist()
        }
        active()
        let result
        try { result = await create({ sessionId: row.sessionId }) } catch { fail('SOCIAL_PEER_CREATE_FAILED') }
        active()
        if (result !== undefined && (!plain(result) || result.sessionId !== row.sessionId)) fail('SOCIAL_PEER_SESSION_MISMATCH')
        row.status = 'ready'
        await persist()
        return row.sessionId
      })
    },
    close() { if (!closePromise) { closed = true; closePromise = run(async () => {}, true) } return closePromise },
  }
}
