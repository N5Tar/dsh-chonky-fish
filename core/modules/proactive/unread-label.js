/** 侧栏「大肥鱼」未读文案；与 Client build 内逻辑保持一致。 */
export const UNREAD_DISPLAY_CAP = 99

export function formatProactiveNavLabel(base, count) {
  const root = typeof base === 'string' ? base : ''
  const n = Math.max(0, Math.floor(Number(count) || 0))
  if (n <= 0) return root
  if (n > UNREAD_DISPLAY_CAP) return root + ' ' + UNREAD_DISPLAY_CAP + '+'
  return root + ' ' + n
}
