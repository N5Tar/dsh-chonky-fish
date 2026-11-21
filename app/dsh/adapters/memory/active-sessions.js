/**
 * 把已判定的会话活动串成一条读改写链，原子更新当天索引。
 * 链上不保留失败活动，也不缓存某一天的正文。
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { applySessionActivity, isActivityEvent, isValidSessionId, shanghaiStamp } from '../../../../core/modules/memory/core.js'

const tails = new Map()

function enqueue(memoryRoot, task) {
  const key = resolve(memoryRoot)
  const previous = tails.get(key) || Promise.resolve()
  const run = previous.then(task, task)
  tails.set(key, run.then(() => {}, () => {}))
  return run
}

function tail(memoryRoot) {
  return tails.get(resolve(memoryRoot)) || Promise.resolve()
}

async function atomicWrite(io, file, text) {
  const directory = dirname(file)
  await io.mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    await io.writeFile(temporary, text, 'utf8')
    await io.rename(temporary, file)
  } catch (error) {
    await Promise.resolve(io.unlink(temporary)).catch(() => {})
    throw error
  }
}

export function createActiveSessionWriter({ memoryRoot, isFish, warn = () => {}, io } = {}) {
  if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new Error('memoryRoot required')
  const files = { mkdir, readFile, rename, unlink, writeFile, lstat, ...(io || {}) }
  let closed = false

  function report(error) {
    try { warn(error) } catch { /* 日志失败不影响下一条 */ }
  }

  async function record(activity) {
    const stamp = shanghaiStamp(activity.time)
    if (!stamp || !isValidSessionId(activity.sessionId)) {
      report(new Error('skip invalid activity'))
      return
    }
    const file = join(memoryRoot, 'sessions', `${stamp.date}.md`)
    let existing = null
    let info = null
    try {
      info = await files.lstat(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        report(error)
        return
      }
    }
    if (info) {
      if (info.isSymbolicLink() || !info.isFile()) {
        report(new Error('session index kept: unsafe'))
        return
      }
      try {
        existing = await files.readFile(file, 'utf8')
      } catch (error) {
        report(error)
        return
      }
    }
    const applied = applySessionActivity(existing, stamp.date, activity.sessionId, stamp.clock)
    if (!applied.ok || !applied.changed) {
      if (!applied.ok) report(new Error(`session index kept: ${applied.reason}`))
      return
    }
    await atomicWrite(files, file, applied.text)
  }

  function handle(session, event) {
    if (closed) return
    let fish = false
    try { fish = isFish(session) === true } catch (error) { report(error); return }
    if (!fish || !isActivityEvent(event)) return
    const sessionId = session?.id ?? session?.header?.id
    const activity = { sessionId, time: event.time }
    enqueue(memoryRoot, () => record(activity).catch(report))
  }

  function close() {
    closed = true
    return tail(memoryRoot)
  }

  return { handle, close }
}
