import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export class SocialError extends Error {
  constructor(code) { super(code); this.name = 'SocialError'; this.code = code }
}
export function fail(code) { throw new SocialError(code) }
export function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function text(value, max = 256) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max }
export function keys(value, allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('SOCIAL_INVALID_INPUT')
}
export function conversation(value) {
  if (!plain(value) || !['direct', 'group', 'channel'].includes(value.type) || !text(value.id)) fail('SOCIAL_INVALID_TARGET')
  keys(value, value.type === 'channel' ? ['type', 'id', 'guildId'] : ['type', 'id'])
  if (value.type === 'channel' && !text(value.guildId)) fail('SOCIAL_INVALID_TARGET')
  return value.type === 'channel' ? { type: value.type, id: value.id, guildId: value.guildId } : { type: value.type, id: value.id }
}
export function sessionKey(platform, connectionId, target) {
  const ref = conversation(target)
  return JSON.stringify([platform, connectionId, ref.type, ref.guildId ?? '', ref.id])
}
export function targetEqual(a, b) { return JSON.stringify(conversation(a)) === JSON.stringify(conversation(b)) }
export function digest(value) { return createHash('sha256').update(value).digest('hex') }
export function serial(maxPending = 128) {
  let chain = Promise.resolve(), pending = 0
  return (fn, shutdown = false) => {
    if (!shutdown && pending >= maxPending) return Promise.reject(new SocialError('SOCIAL_QUEUE_FULL'))
    pending++
    const next = chain.then(fn).finally(() => { pending-- })
    chain = next.catch(() => {})
    return next
  }
}
export async function readJson(file, missing, maxBytes = 8 * 1024 * 1024) {
  let handle
  try {
    handle = await open(file, 'r')
    if ((await handle.stat()).size > maxBytes) fail('SOCIAL_STORAGE_TOO_LARGE')
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxBytes) fail('SOCIAL_STORAGE_TOO_LARGE')
    return JSON.parse(buffer.subarray(0, length).toString('utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(missing)
    throw new SocialError('SOCIAL_STORAGE_INVALID')
  } finally { await handle?.close() }
}
export async function writeJson(file, value) {
  const target = resolve(file)
  const directory = dirname(target)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8')
    await handle.sync()
    await handle.close(); handle = null
    await rename(temporary, target)
    const parent = await open(directory, 'r')
    try { await parent.sync() } finally { await parent.close() }
  } finally {
    await handle?.close()
    // Verify the exact absolute temporary path before cleanup; never touch the target.
    if (resolve(temporary) === temporary && dirname(temporary) === directory && temporary.startsWith(target + '.')) {
      try { await unlink(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}
export function publicError(error) { return typeof error?.code === 'string' && /^(SOCIAL|INBOX)_[A-Z_]+$/.test(error.code) ? error.code : 'SOCIAL_OPERATION_FAILED' }
