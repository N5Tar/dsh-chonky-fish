import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SKILL_LIMITS } from '../../../core/contracts/spec.js'

const SKILL_FILE = /^([a-z][a-z0-9-]{0,63})\.json$/
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

// Check every ancestor, including existing parents. Never traverse a symlink.
async function ensureDirectory(directory) {
  const parsed = path.parse(directory)
  let current = parsed.root
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let info
    try { info = await lstat(current) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      try { await mkdir(current, { mode: 0o700 }) }
      catch (creationError) { if (creationError.code !== 'EEXIST') throw creationError }
      info = await lstat(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) fail('UNSAFE_PATH', 'Storage ancestors must be real directories')
  }
}

async function checkFile(filename, maxFileBytes) {
  try {
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('UNSAFE_PATH', 'State must be a regular, unlinked file')
    if (info.size > maxFileBytes) fail('CORRUPT_STATE', 'Stored state exceeds the byte limit')
    return true
  } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

/** Filesystem adapter for the local skill repository; business validation stays in core. */
export function createSkillFileStorage({ directory, maxFileBytes = SKILL_LIMITS.maxFileBytes, isMigrationBusy = () => false, withMigrationWrite = operation => operation(), withMigrationRead = operation => operation() } = {}) {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) fail('INVALID_ARGUMENT', 'directory is required')
  if (directory.split(/[\\/]/).includes('..')) fail('UNSAFE_PATH', 'Parent traversal is not allowed')
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new TypeError('maxFileBytes must be a positive integer')
  const root = path.resolve(directory)
  const filename = id => {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail('INVALID_ARGUMENT', 'Invalid skillId')
    return path.join(root, `${id}.json`)
  }
  const storage = {
    lockKey: root,
    async ensureReady() { await ensureDirectory(root) },
    async listIds() {
      let names
      try { names = await readdir(root) }
      catch (error) { if (error.code === 'ENOENT') return []; throw error }
      return names.map(name => SKILL_FILE.exec(name)?.[1]).filter(Boolean).sort()
    },
    async exists(id) { await ensureDirectory(root); return checkFile(filename(id), maxFileBytes) },
    async read(id) {
      const file = filename(id)
      if (!await checkFile(file, maxFileBytes)) return undefined
      let handle
      try {
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
        const info = await handle.stat()
        if (!info.isFile() || info.nlink !== 1) fail('UNSAFE_PATH', 'Unsafe state file')
        if (info.size > maxFileBytes) fail('CORRUPT_STATE', 'Stored state exceeds the byte limit')
        const buffer = Buffer.alloc(maxFileBytes + 1)
        let length = 0
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length > maxFileBytes) fail('CORRUPT_STATE', 'Stored state exceeds the byte limit')
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))) }
        catch { fail('CORRUPT_STATE', 'Skill state is not valid JSON') }
      } catch (error) {
        if (error.code === 'ELOOP') fail('UNSAFE_PATH', 'Symlink state file refused')
        throw error
      } finally { await handle?.close() }
    },
    async write(id, state, { exclusive = false } = {}) {
      if (isMigrationBusy()) fail('UNAVAILABLE', 'Migration is replacing data')
      const file = filename(id)
      const data = JSON.stringify(state)
      if (Buffer.byteLength(data) > maxFileBytes) fail('LIMIT_EXCEEDED', 'State byte limit reached; no changes saved')
      await ensureDirectory(root)
      await checkFile(file, maxFileBytes)
      const temporary = path.join(root, `.skill-${randomUUID()}.tmp`)
      let handle
      let created = false
      try {
        handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        created = true
        await handle.writeFile(data, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await ensureDirectory(root)
        await checkFile(file, maxFileBytes)
        if (isMigrationBusy()) fail('UNAVAILABLE', 'Migration is replacing data')
        if (exclusive) {
          try { await link(temporary, file) }
          catch (error) { if (error.code === 'EEXIST') fail('CONFLICT', 'Skill already exists; import never overwrites'); throw error }
          await unlink(temporary)
        } else await rename(temporary, file)
        created = false
      } finally {
        await handle?.close()
        if (created) await unlink(temporary)
      }
    },
  }
  const unguardedWrite = storage.write.bind(storage)
  const unguardedEnsureReady = storage.ensureReady.bind(storage)
  const unguardedListIds = storage.listIds.bind(storage)
  const unguardedExists = storage.exists.bind(storage)
  const unguardedRead = storage.read.bind(storage)
  storage.write = (id, state, options) => withMigrationWrite(() => unguardedWrite(id, state, options))
  storage.ensureReady = (...args) => withMigrationRead(() => unguardedEnsureReady(...args))
  storage.listIds = (...args) => withMigrationRead(() => unguardedListIds(...args))
  storage.exists = (...args) => withMigrationRead(() => unguardedExists(...args))
  storage.read = (...args) => withMigrationRead(() => unguardedRead(...args))
  return storage
}

export default createSkillFileStorage
