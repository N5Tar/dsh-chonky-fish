/**
 * 大肥鱼 · 日记模块（Host 侧）· 日期工具（纯函数）。
 *
 * 只接受严格的 `YYYY-MM-DD` 且必须是真实日历日期：
 *   - `2026-02-30`、`2026-13-01`、`../../abc` 一律非法；
 *   - Core 与 Local Provider 都复用同一份判断，避免两处规则漂移。
 */

/** 严格日期文本模式。 */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * 严格合法日期文本 → true。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidDateText(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  // Date.UTC 的月份从 0 开始；用回读结果反证日期存在（会自动进位）。
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}
