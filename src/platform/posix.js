import { open } from 'node:fs/promises'

/**
 * POSIX（Linux / macOS / *BSD）平台实现。
 *
 * 目录持久化：rename 之后对目录句柄 fsync 是让这次重命名在掉电/崩溃后仍然可见的标准做法。
 * 只有「文件系统根本表达不了这个操作」的错误（ENOTSUP / ENOSYS）可以吞掉；
 * 其余错误照样抛出，避免把真正的 IO 故障当成正常情况。
 *
 * 路径归属：用 '/' 做前缀边界判断，大小写敏感。
 */
const UNSUPPORTED = new Set(['ENOTSUP', 'ENOSYS'])

export const name = 'posix'
export const directorySync = true
export const caseInsensitivePaths = false

const stripTrailingSeparators = (value) => value.replace(/\/+$/, '')

/** 只在绝对、已 resolve 的路径上使用；调用方负责 resolve。 */
export function isWithin(root, target) {
  const base = stripTrailingSeparators(root)
  const full = stripTrailingSeparators(target)
  if (!base || !full) return false
  return full.length > base.length && full.startsWith(base + '/')
}

export function createPosixPlatform({ openFile = open } = {}) {
  return {
    name,
    directorySync,
    caseInsensitivePaths,
    isWithin,
    /** Flush the directory entry so a just-completed rename survives a crash. */
    async syncDirectory(directory) {
      let handle
      try {
        handle = await openFile(directory, 'r')
        await handle.sync()
      } catch (error) {
        if (!UNSUPPORTED.has(error?.code)) throw error
      } finally {
        await handle?.close()
      }
    },
  }
}

export const posixPlatform = createPosixPlatform()
