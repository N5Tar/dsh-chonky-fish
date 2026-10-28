/**
 * 大肥鱼 · 日记模块（Host 侧）· 本地 Markdown Provider。
 *
 * 存储约定（和设计文档一致）：
 *   - 一个日期一个 UTF-8 文件：`<directory>/YYYY-MM-DD.md`；
 *   - 正文原样保存（只统一换行符、保证末尾一个 `\n`），不自动加标题；
 *   - `overwrite=false` 用独占创建，已有文件绝不覆盖；
 *   - `overwrite=true` 先写同目录临时文件、再 rename 原子替换；
 *   - 读取不存在返回 null（由 Core 映射 DIARY_NOT_FOUND）；
 *   - 所有底层异常包装成 DIARY_STORAGE_ERROR，不把绝对路径暴露给模型。
 *
 * 这个文件是 V1 唯一的 Provider。将来接 Notion 时只需要另写一个实现
 * `write / read / list / has` 的同构对象，Tool 与 Core 不变。
 */
import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isValidDateText } from './date.js'
import { DiaryError, alreadyExists, invalidDate, storageError } from './errors.js'

/** 严格 `YYYY-MM-DD.md` 文件名。 */
const DIARY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/

/** 正文规范化：CRLF/CR → LF，末尾只留一个换行。 */
function normalizeContent(content) {
  return String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '') + '\n'
}

/**
 * @param {{ directory: string }} options
 */
export function createLocalDiaryProvider({ directory }) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new TypeError('local diary provider requires a directory')
  }

  let layoutReady = null

  /** 首次使用时建目录；之后复用同一个 Promise。 */
  function ensureLayout() {
    if (layoutReady === null) {
      layoutReady = mkdir(directory, { recursive: true }).catch((error) => {
        layoutReady = null
        throw error
      })
    }
    return layoutReady
  }

  /** 文件名只由校验过的日期拼接；Core 已校验，Provider 再兜一层。 */
  function pathFor(date) {
    if (!isValidDateText(date)) throw invalidDate()
    return join(directory, `${date}.md`)
  }

  async function exists(path) {
    try {
      await access(path)
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * 写入某一天的日记。
   * @param {{ date: string, content: string }} diary
   * @param {boolean} [overwrite]
   * @returns {Promise<'created'|'updated'>}
   */
  async function write(diary, overwrite = false) {
    const date = diary && diary.date
    if (!isValidDateText(date)) throw invalidDate()
    const content = diary && typeof diary.content === 'string' ? diary.content : ''
    const path = pathFor(date)
    const text = normalizeContent(content)

    try {
      await ensureLayout()
    } catch (error) {
      throw storageError('日记目录创建失败')
    }

    if (!overwrite) {
      let handle = null
      let created = false
      try {
        handle = await open(path, 'wx')
        created = true
        await handle.writeFile(text, 'utf8')
        return 'created'
      } catch (error) {
        if (error && error.code === 'EEXIST') throw alreadyExists(date)
        // 刚创建但写入失败：清掉半截文件，别留下空日记。
        if (created) {
          try {
            await unlink(path)
          } catch (ignored) {
            /* best effort */
          }
        }
        throw storageError('日记写入失败')
      } finally {
        if (handle) {
          try {
            await handle.close()
          } catch (ignored) {
            /* best effort */
          }
        }
      }
    }

    let existed = false
    try {
      existed = await exists(path)
      const temporary = join(directory, `.diary-${process.pid}-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, text, 'utf8')
        await rename(temporary, path)
      } catch (error) {
        try {
          await unlink(temporary)
        } catch (ignored) {
          /* best effort */
        }
        throw error
      }
      return existed ? 'updated' : 'created'
    } catch (error) {
      if (error instanceof DiaryError) throw error
      throw storageError('日记写入失败')
    }
  }

  /**
   * 读取某一天：不存在返回 null。
   * @param {string} date
   * @returns {Promise<{ date: string, content: string } | null>}
   */
  async function read(date) {
    const path = pathFor(date)
    try {
      const content = await readFile(path, 'utf8')
      return { date, content }
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw storageError('日记读取失败')
    }
  }

  /**
   * 列出已有日记日期（倒序、只保留合法日期文件名）。
   * @param {number} limit
   * @returns {Promise<string[]>}
   */
  async function list(limit) {
    let names
    try {
      names = await readdir(directory)
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw storageError('日记列表读取失败')
    }
    const dates = []
    for (const name of names) {
      const match = DIARY_FILE_PATTERN.exec(name)
      if (!match) continue
      if (!isValidDateText(match[1])) continue
      dates.push(match[1])
    }
    dates.sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))
    return dates.slice(0, limit)
  }

  /**
   * 某天是否已有日记（给调用方做存在性判断）。
   * @param {string} date
   * @returns {Promise<boolean>}
   */
  async function has(date) {
    return exists(pathFor(date))
  }

  return { directory, write, read, list, has }
}
