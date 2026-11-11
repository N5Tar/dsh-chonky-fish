import { open, mkdir, rename, unlink, link } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
const fault = (code, message) => Object.assign(new Error(message), { code })
/** Only explicit local collection intent; never samples, activity or OS permissions. */
export function createCollectionPreferences(file, { syncDirectory, withMigrationWrite = operation => operation(), withMigrationRead = operation => operation() } = {}) {
  if (typeof syncDirectory !== 'function') throw new TypeError('createCollectionPreferences requires syncDirectory')
  const target = resolve(file)
  let tail = Promise.resolve()
  const serial = fn => { const next = tail.then(fn); tail = next.catch(() => {}); return next }
  return {
    read: () => withMigrationRead(() => serial(async () => {
      let handle
      try {
        handle = await open(target, 'r')
        if ((await handle.stat()).size > 4096) throw fault('PREFERENCE_INVALID', '采集偏好文件损坏，未自动开始采集')
        const data = Buffer.alloc(4097)
        let bytesRead = 0
        while (bytesRead < data.length) {
          const result = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead)
          if (!result.bytesRead) break
          bytesRead += result.bytesRead
        }
        if (bytesRead > 4096) throw fault('PREFERENCE_INVALID', '采集偏好文件损坏，未自动开始采集')
        let value
        try { value = JSON.parse(data.subarray(0, bytesRead).toString('utf8')) } catch { throw fault('PREFERENCE_INVALID', '采集偏好文件损坏，未自动开始采集') }
        if (!value || Array.isArray(value) || Object.keys(value).length !== 2 || value.version !== 1 || typeof value.collectionEnabled !== 'boolean') throw fault('PREFERENCE_INVALID', '采集偏好文件损坏，未自动开始采集')
        return value.collectionEnabled
      } catch (error) {
        if (error.code === 'ENOENT') return false
        if (error.code === 'PREFERENCE_INVALID') throw error
        throw fault('PREFERENCE_READ_FAILED', '无法读取采集偏好，未自动开始采集')
      } finally { await handle?.close() }
    })),
    write: value => withMigrationWrite(() => save(value, false)),
    // Explicit migration only: atomically create if absent, never replace a user choice.
    createIfAbsent: value => withMigrationWrite(() => save(value, true)),
  }
  function save(value, exclusive) {
    return serial(async () => {
      if (typeof value !== 'boolean') throw fault('PREFERENCE_INVALID', '采集偏好必须是布尔值')
      const directory = dirname(target), temporary = `${target}.${randomUUID()}.tmp`
      let handle
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        handle = await open(temporary, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ version: 1, collectionEnabled: value }) + '\n', 'utf8')
        await handle.sync(); await handle.close(); handle = null
        if (exclusive) {
          try { await link(temporary, target) } catch (error) { if (error.code === 'EEXIST') return false; throw error }
        } else await rename(temporary, target)
        await syncDirectory(directory)
        return exclusive ? true : value
      } catch { throw fault('PREFERENCE_WRITE_FAILED', '未能保存采集偏好；请修复存储后重试') }
      finally {
        await handle?.close()
        // Delete only this exact absolute, same-directory temporary path.
        if (resolve(temporary) === temporary && dirname(temporary) === directory && temporary.startsWith(target + '.')) {
          try { await unlink(temporary) } catch (error) { if (error.code !== 'ENOENT') throw fault('PREFERENCE_WRITE_FAILED', '采集偏好临时文件清理失败') }
        }
      }
    })
  }
}
