/**
 * 大肥鱼 · 日记模块（Host 侧）· 定时提醒状态（diary.json）。
 *
 * 只记「今天有没有提醒过」和最近一次投递结果：
 *   - 同一个鱼鱼会话一天最多被提醒一次，Host 重启也不会重复；
 *   - 日记已经存在时也会打上标记，避免每个 tick 都去查文件；
 *   - 文件缺失/坏 JSON/字段非法一律回退空状态，不能挡住日记功能。
 *
 * 写盘用「临时文件 + rename」，进程被杀不会留下半截 JSON。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 状态文件版本。 */
export const DIARY_STATE_VERSION = 1

function emptyState() {
  return {
    version: DIARY_STATE_VERSION,
    /** 最近一次提醒对应的本地日期（YYYY-MM-DD）。 */
    lastNudgeDate: null,
    /** 最近一次提醒的 epoch 毫秒。 */
    lastNudgeAt: null,
    /** delivered / already-written。 */
    lastNudgeStatus: null,
    /** 被提醒的鱼鱼会话 id（诊断用）。 */
    lastSessionId: null,
  }
}

function sanitize(raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object' || raw.version !== DIARY_STATE_VERSION) return state
  if (typeof raw.lastNudgeDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastNudgeDate)) {
    state.lastNudgeDate = raw.lastNudgeDate
  }
  if (Number.isFinite(Number(raw.lastNudgeAt)) && Number(raw.lastNudgeAt) > 0) {
    state.lastNudgeAt = Number(raw.lastNudgeAt)
  }
  if (raw.lastNudgeStatus === 'delivered' || raw.lastNudgeStatus === 'already-written') {
    state.lastNudgeStatus = raw.lastNudgeStatus
  }
  if (typeof raw.lastSessionId === 'string' && raw.lastSessionId !== '') state.lastSessionId = raw.lastSessionId
  return state
}

/**
 * @param {{ file: string }} options
 */
export function createDiaryState({ file }) {
  async function read() {
    try {
      return sanitize(JSON.parse(await readFile(file, 'utf8')))
    } catch (error) {
      return emptyState()
    }
  }

  async function write(value) {
    const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
      await rename(temporary, file)
    } catch (error) {
      try {
        await unlink(temporary)
      } catch (ignored) {
        /* 临时文件可能都没创建成功 */
      }
      throw error
    }
  }

  /**
   * 合并写入若干字段。
   * @param {{ lastNudgeDate?: string|null, lastNudgeAt?: number|null, lastNudgeStatus?: string|null, lastSessionId?: string|null }} patch
   */
  async function mark(patch) {
    const current = await read()
    await write({ ...current, ...patch })
  }

  return { file, read, mark }
}
