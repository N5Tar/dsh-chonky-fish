import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** A directory is data, not a second prompt. Blank values use the configured default. */
export function normalizeProfileDirectory(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f\u2028\u2029]/.test(value)) {
    throw new Error('个人档案目录必须是单行路径，长度不能超过 4096 字符。')
  }
  const text = value.trim()
  if (!text) return fallback
  const expanded = text === '~' ? homedir() : text.startsWith('~/') || text.startsWith('~\\') ? join(homedir(), text.slice(2)) : text
  if (!isAbsolute(expanded)) throw new Error('个人档案目录请填写绝对路径或以 ~/ 开头的路径。')
  return resolve(expanded)
}
