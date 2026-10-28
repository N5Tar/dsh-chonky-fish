/**
 * 大肥鱼 · 日记模块（Host 侧）· 面板只读 HTTP 接口。
 *
 * 面板「日记」弹窗用这一条 token 鉴权的本地路由读日记：
 *
 *   GET /chonkyfish/diary?limit=60          → { ok:true, action:'list', dates:[...] }
 *   GET /chonkyfish/diary?date=2026-10-28   → { ok:true, action:'read', date, content }
 *
 * 只读；写入仍然只能由鱼鱼通过 `diary` 工具完成。错误沿用 Tool 的稳定错误码。
 */
import { DiaryError, toPublicError } from './errors.js'

/** list 的默认条数，与工具一致。 */
export const DIARY_HTTP_DEFAULT_LIMIT = 30
/** 面板一次最多列出的日期数，避免弹窗太大。 */
export const DIARY_HTTP_MAX_LIMIT = 365

function reply(status, body) {
  return { status, body }
}

/**
 * @param {{
 *   service: { run: (args: unknown) => Promise<Record<string, unknown>> },
 *   headers: Record<string, string | string[] | undefined>,
 *   url: string | undefined,
 *   token: string,
 * }} options
 * @returns {Promise<{ status: number, body: unknown }>}
 */
export async function handleDiaryRequest({ service, headers, url, token }) {
  if (!headers || headers['x-chonkyfish-token'] !== token) {
    return reply(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'unauthorized' } })
  }

  let parsed
  try {
    parsed = new URL(url || '/', 'http://chonkyfish.local')
  } catch (error) {
    return reply(400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: '请求地址不合法' } })
  }

  const date = parsed.searchParams.get('date')
  if (date !== null) {
    try {
      return reply(200, await service.run({ action: 'read', date }))
    } catch (error) {
      const publicError = toPublicError(error)
      const status = error instanceof DiaryError
        ? error.code === 'DIARY_NOT_FOUND'
          ? 404
          : error.code === 'DIARY_STORAGE_ERROR'
            ? 500
            : 400
        : 500
      return reply(status, { ok: false, error: publicError })
    }
  }

  const rawLimit = parsed.searchParams.get('limit')
  let limit = DIARY_HTTP_DEFAULT_LIMIT
  if (rawLimit !== null) {
    limit = Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > DIARY_HTTP_MAX_LIMIT) {
      return reply(400, { ok: false, error: { code: 'INVALID_LIMIT', message: 'limit 必须是 1~365 的整数' } })
    }
  }

  try {
    return reply(200, await service.run({ action: 'list', limit }))
  } catch (error) {
    return reply(500, { ok: false, error: toPublicError(error) })
  }
}
