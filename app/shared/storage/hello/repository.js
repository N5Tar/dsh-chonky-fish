import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateState, fail, clone } from '../../../../core/modules/hello/schema.js'
export function createHelloRepository({ path, withMigrationRead = fn => fn(), withMigrationWrite = fn => fn(), syncDirectory } = {}) {
  if (!path) throw new Error('Hello state path required')
  let chain = Promise.resolve()
  async function readRaw() { try { return validateState(JSON.parse(await readFile(path, 'utf8'))) } catch (error) { if (error.code === 'ENOENT') return null; throw fail('HELLO_CORRUPT_STATE', 'unknown') } }
  return {
    read: () => withMigrationRead(async () => { await chain; return clone(await readRaw()) }),
    write(state, expectedRevision) {
      const task = chain.then(() => withMigrationWrite(async () => {
        validateState(state)
        const current = await readRaw()
        if ((current?.revision ?? null) !== expectedRevision) throw fail('HELLO_STALE_REVISION')
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temp = path + '.' + randomUUID() + '.tmp'
        let renamed = false
        try {
          const file = await open(temp, 'wx', 0o600)
          try { await file.writeFile(JSON.stringify(state, null, 2) + '\n'); await file.sync() } finally { await file.close() }
          await rename(temp, path); renamed = true
          if (syncDirectory) await syncDirectory(dirname(path))
          else { const dir = await open(dirname(path), 'r'); try { await dir.sync() } finally { await dir.close() } }
        } catch { throw fail('HELLO_WRITE_FAILED', renamed ? 'unknown' : 'not_applied') }
        finally { await unlink(temp).catch(() => {}) }
        return clone(state)
      }))
      chain = task.catch(() => {}); return task
    },
  }
}
