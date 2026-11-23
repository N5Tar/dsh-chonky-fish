/**
 * schedule.json 原子读写 + 进程内写队列。不做 version 业务判断。
 */

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  emptyScheduleDoc,
  validateScheduleDoc,
  scheduleError,
  ERROR_CODES,
} from '../../../../core/modules/schedule/schema.js'

/**
 * @param {{
 *   path: string,
 *   syncDirectory?: (dir: string) => Promise<void>,
 *   withMigrationRead?: <T>(fn: () => Promise<T>) => Promise<T>,
 *   withMigrationWrite?: <T>(fn: () => Promise<T>) => Promise<T>,
 * }} options
 */
export function createScheduleRepository({
  path,
  syncDirectory,
  withMigrationRead = (fn) => fn(),
  withMigrationWrite = (fn) => fn(),
} = {}) {
  if (!path) throw new Error('schedule path required')
  let chain = Promise.resolve()
  let corrupt = null

  async function readRaw() {
    try {
      const text = await readFile(path, 'utf8')
      if (!text.trim()) return emptyScheduleDoc()
      return validateScheduleDoc(JSON.parse(text))
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyScheduleDoc()
      if (error && error.code === ERROR_CODES.CORRUPT) {
        corrupt = error
        throw error
      }
      if (error instanceof SyntaxError) {
        corrupt = scheduleError(ERROR_CODES.CORRUPT, 'schedule.json is not valid JSON')
        throw corrupt
      }
      throw error
    }
  }

  function enqueue(task) {
    const run = chain.then(task, task)
    chain = run.catch(() => {})
    return run
  }

  return {
    isCorrupt() {
      return Boolean(corrupt)
    },
    load() {
      return withMigrationRead(() =>
        enqueue(async () => {
          if (corrupt) throw corrupt
          return structuredClone(await readRaw())
        }),
      )
    },
    /**
     * @param {(doc: object) => object | Promise<object>} mutator
     */
    update(mutator) {
      return withMigrationWrite(() =>
        enqueue(async () => {
          if (corrupt) throw corrupt
          const current = await readRaw()
          const next = await mutator(structuredClone(current))
          const validated = validateScheduleDoc(next)
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          const temp = path + '.' + randomUUID() + '.tmp'
          let renamed = false
          try {
            const file = await open(temp, 'wx', 0o600)
            try {
              await file.writeFile(JSON.stringify(validated, null, 2) + '\n')
              await file.sync()
            } finally {
              await file.close()
            }
            await rename(temp, path)
            renamed = true
            if (typeof syncDirectory === 'function') await syncDirectory(dirname(path))
          } catch (error) {
            throw scheduleError(ERROR_CODES.INTERNAL, renamed ? 'schedule sync failed' : 'schedule write failed')
          } finally {
            await unlink(temp).catch(() => {})
          }
          return structuredClone(validated)
        }),
      )
    },
  }
}
