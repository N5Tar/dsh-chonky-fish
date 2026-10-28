import { randomUUID } from 'node:crypto'
import { readJson, writeJson, plain, text, fail, serial } from './core.js'

function validateIdentity(value) {
  if (!plain(value) || !['connectionId', 'platform', 'provider', 'protocolUserId'].every(key => text(value[key]))) fail('SOCIAL_INVALID_IDENTITY')
  if (value.platformUserId !== undefined && !text(value.platformUserId)) fail('SOCIAL_INVALID_IDENTITY')
  return { connectionId: value.connectionId, platform: value.platform, provider: value.provider, protocolUserId: value.protocolUserId,
    ...(value.platformUserId ? { platformUserId: value.platformUserId } : {}),
    ...(text(value.displayName) ? { displayName: value.displayName } : {}), verifiedAt: new Date().toISOString() }
}
export function createIdentityStore(file) {
  const run = serial()
  async function load() {
    const state = await readJson(file, { version: 1, identities: [] })
    if (!plain(state) || state.version !== 1 || !Array.isArray(state.identities) || state.identities.length > 128) fail('SOCIAL_IDENTITY_STORAGE_INVALID')
    const ids = new Set()
    for (const row of state.identities) {
      validateIdentity(row.identity)
      if (!text(row.identityRevision) || ids.has(row.identity.connectionId)) fail('SOCIAL_IDENTITY_STORAGE_INVALID')
      if (row.pending) validateIdentity(row.pending)
      ids.add(row.identity.connectionId)
    }
    return state
  }
  return {
    list: () => run(async () => structuredClone((await load()).identities)),
    verify: identity => run(async () => {
      const next = validateIdentity(identity)
      const state = await load()
      let row = state.identities.find(value => value.identity.connectionId === next.connectionId)
      if (!row) {
        if (state.identities.length >= 128) fail('SOCIAL_IDENTITY_CAPACITY')
        row = { identity: next, identityRevision: randomUUID() }
        state.identities.push(row)
      } else {
        const previous = row.identity
        const sameProvider = previous.provider === next.provider && previous.platform === next.platform && previous.protocolUserId === next.protocolUserId
        const sameNative = previous.platform === next.platform && previous.platformUserId && previous.platformUserId === next.platformUserId
        const nativeChanged = previous.platformUserId && next.platformUserId && previous.platformUserId !== next.platformUserId
        if (nativeChanged || (!sameProvider && !sameNative) || row.pending) {
          row.pending = next
          await writeJson(file, state)
          return { status: 'identity_changed', identityRevision: row.identityRevision }
        }
        row.identity = next
      }
      await writeJson(file, state)
      return { status: 'connected', ...structuredClone(row) }
    }),
    // Host-only operation. Confirming always rotates revision: old data is never inherited implicitly.
    confirm: ({ connectionId, expectedProtocolUserId }) => run(async () => {
      const state = await load()
      const row = state.identities.find(value => value.identity.connectionId === connectionId)
      if (!row?.pending || row.pending.protocolUserId !== expectedProtocolUserId) fail('SOCIAL_CONFIRMATION_STALE')
      row.identity = row.pending
      delete row.pending
      row.identityRevision = randomUUID()
      await writeJson(file, state)
      return structuredClone(row)
    }),
  }
}
