/**
 * 大肥鱼 · 日记模块（Host 侧）· 业务 Core。
 *
 * 职责边界（和设计文档一致）：
 *   - 校验日期 / 正文 / limit / action 参数；
 *   - 定义覆盖语义（overwrite=false 仅创建，true 创建或替换）；
 *   - 把 Provider 的 null 映射成 DIARY_NOT_FOUND；
 *   - 不知道文件路径、不知道 Tool 框架、不调用 LLM。
 */
import { isValidDateText } from './date.js'
import { invalidArgument, invalidContent, invalidDate, invalidLimit, notFound } from './errors.js'

/** 默认正文上限；实际值来自 config.diary.maxContentChars。 */
export const DEFAULT_MAX_CONTENT_CHARS = 50000

/** 默认 list 条数。 */
export const DEFAULT_LIST_LIMIT = 30

/**
 * @param {{
 *   provider: ReturnType<typeof import('./provider.js').createLocalDiaryProvider>,
 *   getMaxChars?: () => number,
 * }} options
 */
export function createDiaryService({ provider, getMaxChars = () => DEFAULT_MAX_CONTENT_CHARS }) {
  function maxChars() {
    const value = Number(getMaxChars())
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_MAX_CONTENT_CHARS
  }

  function checkDate(value) {
    if (!isValidDateText(value)) throw invalidDate()
    return value
  }

  function checkContent(value) {
    if (typeof value !== 'string' || value.trim() === '') throw invalidContent()
    if (value.length > maxChars()) throw invalidContent(`日记内容超过 ${maxChars()} 字符上限`)
    return value
  }

  function checkLimit(value) {
    if (value === undefined) return DEFAULT_LIST_LIMIT
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 365) throw invalidLimit()
    return value
  }

  /**
   * 单工具入口：根据 action 分发到 write / read / list。
   * @param {unknown} args
   * @returns {Promise<Record<string, unknown>>}
   */
  async function run(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalidArgument('参数必须是一个对象')

    const action = args.action
    if (action === 'write') {
      const date = checkDate(args.date)
      const content = checkContent(args.content)
      if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
        throw invalidArgument('overwrite 必须是布尔值')
      }
      const status = await provider.write({ date, content }, args.overwrite === true)
      return { ok: true, action: 'write', date, status }
    }

    if (action === 'read') {
      const date = checkDate(args.date)
      const diary = await provider.read(date)
      if (diary === null) throw notFound(date)
      return { ok: true, action: 'read', date, content: diary.content }
    }

    if (action === 'list') {
      const limit = checkLimit(args.limit)
      const dates = await provider.list(limit)
      return { ok: true, action: 'list', dates }
    }

    throw invalidArgument('action 只能是 "write" / "read" / "list"')
  }

  return { run, checkDate, checkContent, checkLimit }
}
