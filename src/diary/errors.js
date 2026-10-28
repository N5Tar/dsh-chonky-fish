/**
 * 大肥鱼 · 日记模块（Host 侧）· 领域错误。
 *
 * 模块内部一律抛 DiaryError（带稳定错误码）；Tool 适配层把它映射成
 * `{ ok:false, error:{ code, message } }`，不向模型泄漏路径、堆栈或底层异常。
 */

/** Tool 对外暴露的稳定错误码。 */
export const DIARY_CODES = Object.freeze({
  invalidDate: 'INVALID_DATE',
  invalidContent: 'INVALID_CONTENT',
  invalidLimit: 'INVALID_LIMIT',
  invalidArgument: 'INVALID_ARGUMENT',
  alreadyExists: 'DIARY_ALREADY_EXISTS',
  notFound: 'DIARY_NOT_FOUND',
  storageError: 'DIARY_STORAGE_ERROR',
})

/** 日记领域错误：`code` 是稳定契约，`message` 是给人/模型看的中文说明。 */
export class DiaryError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'DiaryError'
    this.code = code
  }

  /** Tool 响应里的公开错误对象（不含 cause / 堆栈）。 */
  toPublic() {
    return { code: this.code, message: this.message }
  }
}

/** @param {string} [message] */
export function invalidDate(message = '日期必须为 YYYY-MM-DD，且是真实存在的日历日期') {
  return new DiaryError(DIARY_CODES.invalidDate, message)
}

/** @param {string} [message] */
export function invalidContent(message = '日记内容不能为空') {
  return new DiaryError(DIARY_CODES.invalidContent, message)
}

/** @param {string} [message] */
export function invalidLimit(message = 'limit 必须是 1~365 的整数') {
  return new DiaryError(DIARY_CODES.invalidLimit, message)
}

/** @param {string} [message] */
export function invalidArgument(message = '日记参数不合法') {
  return new DiaryError(DIARY_CODES.invalidArgument, message)
}

/** @param {string} date */
export function alreadyExists(date) {
  return new DiaryError(DIARY_CODES.alreadyExists, `${date} 的日记已存在；要覆盖请显式传 overwrite=true`)
}

/** @param {string} date */
export function notFound(date) {
  return new DiaryError(DIARY_CODES.notFound, `没有找到 ${date} 的日记`)
}

/** @param {string} [message] */
export function storageError(message = '日记读写失败') {
  return new DiaryError(DIARY_CODES.storageError, message)
}

/**
 * 任意异常 → 公开错误对象。
 * 领域错误原样映射；其它异常统一成存储错误（不暴露底层细节）。
 * @param {unknown} error
 * @returns {{ code: string, message: string }}
 */
export function toPublicError(error) {
  if (error instanceof DiaryError) return error.toPublic()
  return storageError().toPublic()
}
