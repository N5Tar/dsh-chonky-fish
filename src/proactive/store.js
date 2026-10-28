/**
 * 大肥鱼主动消息 · 状态落盘（Host 侧）。
 *
 * 现在只剩「主动发送」一条能力，所以需要记住的东西也很少：
 *   1. 面板当前绑定的鱼鱼会话 id —— 主动消息必须投到这条会话，才能出现在大肥鱼面板的对话里；
 *   2. 当日发送计数与最近发送记录 —— 只做诊断/观测，不参与自动调度（定时器已经移除）。
 *
 * 落盘用「临时文件 + rename」，避免进程被杀时留下半截 JSON。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const STORE_VERSION = 2
const MAX_RECENT = 20
const MAX_COUNT_DAYS = 14

/** 本地日期键，YYYY-MM-DD。 */
export function dateKey(ms) {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

function emptyData() {
  return {
    version: STORE_VERSION,
    /** 面板当前显示的鱼鱼会话；由 client.js 在绑定会话后 PUT /chonkyfish/session 上报。 */
    activeSessionId: null,
    /** 'YYYY-MM-DD' → 当日手动发送条数（仅观测） */
    counts: {},
    lastSentAt: null,
    lastSentKind: null,
    /** 最近发送记录，方便排查；不参与任何判断 */
    recent: [],
  }
}

function sanitize(raw) {
  const data = emptyData()
  if (!raw || typeof raw !== 'object' || raw.version !== STORE_VERSION) return data
  if (typeof raw.activeSessionId === 'string' && raw.activeSessionId.length > 0) {
    data.activeSessionId = raw.activeSessionId
  }
  if (raw.counts && typeof raw.counts === 'object') {
    for (const [day, value] of Object.entries(raw.counts)) {
      const count = Number(value)
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(count) && count >= 0) data.counts[day] = Math.floor(count)
    }
  }
  if (Number.isFinite(Number(raw.lastSentAt)) && Number(raw.lastSentAt) > 0) data.lastSentAt = Number(raw.lastSentAt)
  if (typeof raw.lastSentKind === 'string') data.lastSentKind = raw.lastSentKind
  for (const item of Array.isArray(raw.recent) ? raw.recent : []) {
    if (!item || typeof item !== 'object') continue
    data.recent.push({
      at: Number(item.at) || 0,
      kind: typeof item.kind === 'string' ? item.kind : '',
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
      messageId: typeof item.messageId === 'string' ? item.messageId : '',
    })
  }
  data.recent = data.recent.slice(-MAX_RECENT)
  return data
}

/**
 * 只读地取「面板当前会话 id」，供其它模块（例如日记定时器）在需要时
 * 重新读盘拿到最新值，不持有 store 实例、也不参与写入。
 * 文件缺失/坏 JSON 一律返回 null。
 * @param {string} file
 * @returns {string|null}
 */
export function readActiveSessionId(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || raw.version !== STORE_VERSION) return null
    return typeof raw.activeSessionId === 'string' && raw.activeSessionId.length > 0 ? raw.activeSessionId : null
  } catch (error) {
    return null
  }
}

/**
 * @param {{ file: string, now?: () => number }} options
 */
export function createProactiveStore({ file, now = Date.now }) {
  const data = read()

  function read() {
    try {
      if (!existsSync(file)) return emptyData()
      return sanitize(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      // 文件坏了不能挡住主动消息能力：从空状态重新开始，下次写入会覆盖。
      return emptyData()
    }
  }

  function prune() {
    const days = Object.keys(data.counts).sort()
    for (const day of days.slice(0, Math.max(0, days.length - MAX_COUNT_DAYS))) delete data.counts[day]
    data.recent = data.recent.slice(-MAX_RECENT)
  }

  function write() {
    prune()
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = file + '.' + process.pid + '.tmp'
      writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8')
      renameSync(temporary, file)
      return true
    } catch (error) {
      // 落盘失败只影响跨重启记忆，当前进程内的判断照常。
      return false
    }
  }

  function activeSessionId() {
    return data.activeSessionId
  }

  function setActiveSession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') return false
    if (data.activeSessionId === id) return true
    data.activeSessionId = id
    // 面板绑定/切换会话是低频事件，直接落盘，Host 重启后也能知道该投哪条会话。
    write()
    return true
  }

  function countFor(at) {
    return data.counts[dateKey(at)] || 0
  }

  function lastSentAt() {
    return data.lastSentAt
  }

  function noteSend({ at, kind, sessionId, messageId }) {
    const stamp = Number(at) || now()
    const day = dateKey(stamp)
    data.counts[day] = (data.counts[day] || 0) + 1
    data.lastSentAt = stamp
    data.lastSentKind = typeof kind === 'string' ? kind : null
    data.recent.push({
      at: stamp,
      kind: typeof kind === 'string' ? kind : '',
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      messageId: typeof messageId === 'string' ? messageId : '',
    })
    data.recent = data.recent.slice(-MAX_RECENT)
    write()
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(data))
  }

  function flush() {
    return write()
  }

  function dispose() {
    // 所有写入都是同步落盘，这里没有待刷新的状态。
  }

  return {
    file,
    activeSessionId,
    setActiveSession,
    countFor,
    lastSentAt,
    noteSend,
    snapshot,
    flush,
    dispose,
  }
}
