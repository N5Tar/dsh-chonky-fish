/**
 * Windows 平台实现。
 *
 * 目录持久化：显式「不做目录 fsync」。
 * Windows 的 fsync 对应 FlushFileBuffers，只对文件句柄有效；对目录句柄调用会得到
 * EPERM / EISDIR / EINVAL（libuv 层），所以这里不是「尝试后吞掉错误」，而是根本不尝试。
 * 契约差异：
 * - 仍然保证「不读到半个文件」：临时文件先写入并 fsync，再原子 rename。
 * - 不保证「重命名后的目录项已落盘」：NTFS 上文件内容已刷盘，目录项由文件系统自行提交。
 * 需要更强的崩溃一致性时，不能靠目录 fsync，要改成单文件 append-only journal。
 *
 * 路径归属：分隔符 '\\' 与 '/' 都接受，大小写不敏感（NTFS 默认行为），并识别盘符。
 * 只在绝对路径上使用；调用方负责 resolve。
 */
export const name = 'win32'
export const directorySync = false
export const caseInsensitivePaths = true

const fold = (value) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** Windows 路径归属：绝对路径、已 resolve；不同盘符直接判否。 */
export function isWithin(root, target) {
  const base = fold(root)
  const full = fold(target)
  if (!base || !full) return false
  // Prefix must end on a separator boundary so C:\fish does not own C:\fishy.
  return full.length > base.length && full.startsWith(base + '\\')
}

export function createWin32Platform() {
  return {
    name,
    directorySync,
    caseInsensitivePaths,
    isWithin,
    /** Windows cannot flush a directory handle; file data was already synced. */
    async syncDirectory() {
      /* intentionally empty: see the durability note above */
    },
  }
}

export const win32Platform = createWin32Platform()
