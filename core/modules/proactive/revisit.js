/**
 * 大肥鱼 · 主动消息：事件回访计划器（纯函数）。
 *
 * 状态：已实现并有测试，但主动消息目前只保留「手动发送」能力，本模块**未接线**；
 * 等空闲/事件等触发点确定后再从 proactive.js 接入（接入后仍然只投面板当前会话）。
 *
 * 输入是模块 0 抽出的语义事件（goal.intention_expressed / goal.plan_expressed），
 * 本模块把事件里的「原文时间表达 + observedAt」换算成一个具体到点的回访时间。
 * 全部是纯函数、无第三方依赖、不碰存储和网络，由主动消息服务调用，也方便脱离
 * DSH 单测。
 *
 * 时间语义约定：
 *   - occurredAt 一律为 null，真实发生时间只能由 attributes.timeExpression 推出来。
 *   - 相对时间一律相对 observedAt（用户说这句话的时刻）解释。
 *   - 只用本地时间 API（getFullYear / setHours / setDate …），换时区结果自洽。
 *   - 表达形式不在白名单内、或无法唯一确定时一律返回 null，绝不猜：
 *     宁可漏一次回访，也不要在错误的时间打扰用户。
 */

/** 值得回访的语义事件类型。 */
export const REVISIT_TYPES = Object.freeze(['goal.intention_expressed', 'goal.plan_expressed'])

/**
 * 值得回访的事实地位。
 * hypothetical / uncertain / negated 都是「没真的打算做」，一律跳过。
 */
export const REVISIT_EVIDENCE = Object.freeze(['intent', 'reported'])

/** 明确表示「过去 / 不可用」的表达：直接返回 null。 */
const PAST_EXPRESSIONS = new Set([
  '昨天',
  '昨日',
  '昨晚',
  '昨天晚上',
  '前天',
  '最近',
  '上次',
  '刚才',
  '之前',
  '以前',
  '这阵子',
  '最近这几天',
])

/** 中文数字 1–10（规格只要求一位数；「两」按口语惯例当 2）。 */
const CHINESE_NUMBERS = Object.freeze({
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
})

/** 星期字 → ISO 星期几（周一起 1，周日 = 7）。 */
const WEEKDAY_ISO = Object.freeze({
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
})

/**
 * 时段修饰词 → 小时（24 小时制，本地时间）。
 * 顺序即匹配优先级：两字词在前，「晚」这种单字殿后，避免把「晚上」截成「晚」。
 */
const PERIOD_RULES = Object.freeze([
  ['晚上', 20],
  ['夜里', 20],
  ['夜间', 20],
  ['傍晚', 18],
  ['下午', 15],
  ['中午', 12],
  ['午饭', 12],
  ['上午', 10],
  ['早上', 10],
  ['早晨', 10],
  ['晚', 20],
])

const HOUR_MS = 3600000
const DAY_MS = 86400000
const MAX_QUOTE_LENGTH = 80
const HHMM_PATTERN = /^(\d{1,2}):(\d{2})$/

/* ------------------------------------------------------------------ */
/* 时间基础工具                                                       */
/* ------------------------------------------------------------------ */

/**
 * ISO 字符串 / epoch ms / Date → epoch ms；无效输入返回 null。
 * @param {string | number | Date | null | undefined} value
 * @returns {number | null}
 */
function toEpoch(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : null
  }
  return null
}

/**
 * 取 observedAt 所在「本地日期」的 00:00。
 * @param {number} epochMs
 * @returns {Date}
 */
function startOfLocalDay(epochMs) {
  const date = new Date(epochMs)
  date.setHours(0, 0, 0, 0)
  return date
}

/**
 * 按本地日历加天（用 setDate 走日历运算，不假设一天固定 24h）。
 * @param {Date} date
 * @param {number} days
 * @returns {Date}
 */
function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

/**
 * 某个本地日期的指定整点。
 * @param {Date} date 本地 00:00
 * @param {number} hour 0–23
 * @returns {number} epoch ms
 */
function atHour(date, hour) {
  const target = new Date(date)
  target.setHours(hour, 0, 0, 0)
  return target.getTime()
}

/**
 * 「N」→ 数字；支持阿拉伯数字和中文一–十。
 * @param {string} raw
 * @returns {number | null}
 */
function parseCount(raw) {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    return Number.isSafeInteger(value) ? value : null
  }
  return Object.prototype.hasOwnProperty.call(CHINESE_NUMBERS, raw) ? CHINESE_NUMBERS[raw] : null
}

/**
 * 下一个 ISO 周（周一开始）里指定星期的 hour 点。
 * 例：observedAt 是周一，「下周三」= 下周一 + 2 天 = 9 天后。
 * @param {Date} base 本地 00:00
 * @param {number} isoWeekday 1–7（7 = 周日）
 * @param {number} hour
 * @returns {number}
 */
function nextIsoWeekday(base, isoWeekday, hour) {
  const daysSinceMonday = (base.getDay() + 6) % 7
  const nextMonday = addDays(base, 7 - daysSinceMonday)
  return atHour(addDays(nextMonday, isoWeekday - 1), hour)
}

/**
 * 未来最近的那个星期 X；算出来不晚于 observedAt 就再加 7 天。
 * @param {Date} base 本地 00:00
 * @param {number} observed epoch ms
 * @param {number} isoWeekday 1–7（7 = 周日）
 * @param {number} hour
 * @returns {number}
 */
function nearestWeekday(base, observed, isoWeekday, hour) {
  const jsWeekday = isoWeekday % 7 // 周日 7 → 0
  const offset = (jsWeekday - base.getDay() + 7) % 7
  let candidate = atHour(addDays(base, offset), hour)
  if (candidate <= observed) candidate = atHour(addDays(base, offset + 7), hour)
  return candidate
}

/**
 * 未来最近的周六 hour 点；当天就是周六则取当天（是否太近交给 planRevisit 判）。
 * @param {Date} base 本地 00:00
 * @param {number} hour
 * @returns {number}
 */
function nextSaturday(base, hour) {
  const offset = (6 - base.getDay() + 7) % 7
  return atHour(addDays(base, offset), hour)
}

/**
 * 下一个「M 月 D 日」hour 点；今年已过则明年，该日期不存在则 null。
 * @param {Date} base 本地 00:00
 * @param {number} observed epoch ms
 * @param {number} month 1–12
 * @param {number} day 1–31
 * @param {number} hour
 * @returns {number | null}
 */
function nextMonthDay(base, observed, month, day, hour) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  if (!Number.isInteger(day) || day < 1 || day > 31) return null
  const year = base.getFullYear()
  // 依次试今年、明年：今年已过或今年没有这一天（如闰日）时看明年。
  for (let yearOffset = 0; yearOffset <= 1; yearOffset += 1) {
    const candidate = new Date(year + yearOffset, month - 1, day, hour, 0, 0, 0)
    const valid = candidate.getMonth() === month - 1 && candidate.getDate() === day
    if (!valid) continue
    if (candidate.getTime() > observed) return candidate.getTime()
  }
  return null
}

/**
 * 从表达里剥出时段修饰词。
 * @param {string} text 已去掉空白字符的表达
 * @returns {{ hour: number, rest: string } | null}
 */
function extractPeriod(text) {
  for (const [word, hour] of PERIOD_RULES) {
    if (text.includes(word)) return { hour, rest: text.split(word).join('') }
  }
  return null
}

/**
 * 解析纯日期部分（时段修饰已被剥掉）。
 * @param {string} dateText
 * @param {Date} base 本地 00:00
 * @param {number} observed epoch ms
 * @param {number} hour 时段修饰给的小时；默认 10
 * @returns {number | null}
 */
function resolveDateText(dateText, base, observed, hour) {
  // 相对「天」
  if (dateText === '今天' || dateText === '今日') return atHour(base, hour)
  if (dateText === '明天' || dateText === '明日') return atHour(addDays(base, 1), hour)
  if (dateText === '大后天') return atHour(addDays(base, 3), hour)
  if (dateText === '后天') return atHour(addDays(base, 2), hour)

  // 下周 / 下星期 / 下礼拜（单独出现）→ 本地日期 +7 天
  if (dateText === '下周' || dateText === '下星期' || dateText === '下礼拜') {
    return atHour(addDays(base, 7), hour)
  }

  // 周末 / 这周末 / 这个周末 → 未来最近的周六
  if (dateText === '周末' || dateText === '这周末' || dateText === '这个周末') {
    return nextSaturday(base, hour)
  }

  // 下周X / 下星期X / 下礼拜X → 下一个 ISO 周里的该星期
  let match = /^下(?:周|星期|礼拜)([一二三四五六日天])$/.exec(dateText)
  if (match) {
    const isoWeekday = WEEKDAY_ISO[match[1]]
    return isoWeekday ? nextIsoWeekday(base, isoWeekday, hour) : null
  }

  // 周X / 星期X / 礼拜X（无上/下/这）→ 未来最近的该星期
  match = /^(?:周|星期|礼拜)([一二三四五六日天])$/.exec(dateText)
  if (match) {
    const isoWeekday = WEEKDAY_ISO[match[1]]
    return isoWeekday ? nearestWeekday(base, observed, isoWeekday, hour) : null
  }

  // N天后 / 隔N天 → +N 天
  match = /^(\d+|[一二两三四五六七八九十])天后$/.exec(dateText)
  if (match) {
    const days = parseCount(match[1])
    if (days === null || days < 1) return null
    return atHour(addDays(base, days), hour)
  }
  match = /^隔(\d+|[一二两三四五六七八九十])天$/.exec(dateText)
  if (match) {
    const days = parseCount(match[1])
    if (days === null || days < 1) return null
    return atHour(addDays(base, days), hour)
  }

  // N小时后 / N个小时后 / 过N小时（也接受「过N小时后」）→ 精确 +N 小时
  match = /^过(\d+|[一二两三四五六七八九十])个?小时(?:后)?$/.exec(dateText)
  if (match) {
    const hours = parseCount(match[1])
    if (hours === null || hours < 1) return null
    return observed + hours * HOUR_MS
  }
  match = /^(\d+|[一二两三四五六七八九十])个?小时后$/.exec(dateText)
  if (match) {
    const hours = parseCount(match[1])
    if (hours === null || hours < 1) return null
    return observed + hours * HOUR_MS
  }

  // M月D日 / M月D号 → 下一个该日期
  match = /^(\d{1,2})月(\d{1,2})[日号]$/.exec(dateText)
  if (match) {
    return nextMonthDay(base, observed, Number(match[1]), Number(match[2]), hour)
  }

  return null
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                           */
/* ------------------------------------------------------------------ */

/**
 * 把原文时间表达换算成具体时刻（epoch ms）。
 *
 * 支持的表达见模块头注释与规格：今天/明天/后天/大后天、下周/下周X、周X、
 * 周末、N天后/隔N天、N小时后/过N小时、M月D日，可叠加早上/中午/下午/傍晚/
 * 晚上等时段修饰；今晚/明晚/明早单独处理。
 *
 * @param {string} expression 原文时间表达（如「明天」「下周三下午」）
 * @param {string | number | Date} observedAt 话语被观察到的时刻（ISO 或 epoch ms）
 * @param {Record<string, unknown>} [options] 预留位，当前不影响语义
 * @returns {number | null} epoch ms；无法确定返回 null
 */
export function parseTimeExpression(expression, observedAt, options = {}) {
  void options // 预留：未来可能扩展默认时段/时区覆盖，当前实现不依赖。
  if (typeof expression !== 'string') return null

  // 先 trim 再删掉所有空白，见规格；中文表达里夹空格也能识别。
  const text = expression.replace(/\s+/g, '')
  if (text.length === 0) return null
  if (PAST_EXPRESSIONS.has(text)) return null

  const observed = toEpoch(observedAt)
  if (observed === null) return null
  const base = startOfLocalDay(observed)

  // 融合词：「今晚」不是「今天」+「晚上」的字面拼接，先单独处理。
  if (text === '今晚' || text === '今天晚上') return atHour(base, 20)
  if (text === '明晚' || text === '明天晚上') return atHour(addDays(base, 1), 20)
  if (text === '明早' || text === '明天早上') return atHour(addDays(base, 1), 10)

  const period = extractPeriod(text)
  const dateText = period ? period.rest : text
  if (dateText.length === 0) return null

  const hour = period ? period.hour : 10
  const result = resolveDateText(dateText, base, observed, hour)
  return Number.isFinite(result) ? result : null
}

/**
 * 解析本地 HH:MM。
 * @param {unknown} value
 * @returns {{ hour: number, minute: number, minutes: number } | null}
 */
function parseClock(value) {
  if (typeof value !== 'string') return null
  const match = HHMM_PATTERN.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute, minutes: hour * 60 + minute }
}

/**
 * 把落在免打扰时段的时刻推到该免打扰时段结束（保持「到点」语义，不丢回访）。
 *
 * quietStart/quietEnd 是本地 HH:MM，允许跨午夜（如 23:30–08:30）：
 *   02:00 → 当天 08:30；23:45 → 次日 08:30。
 * 不在免打扰内原样返回；quietStart === quietEnd 视为无免打扰；
 * 非法输入（非法时刻 / 非法配置）原样返回。
 *
 * @param {number} dueAt epoch ms
 * @param {{ quietStart?: string, quietEnd?: string }} [options]
 * @returns {number}
 */
export function clampToActiveWindow(dueAt, { quietStart = '23:30', quietEnd = '08:30' } = {}) {
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) return dueAt

  const start = parseClock(quietStart)
  const end = parseClock(quietEnd)
  if (!start || !end || start.minutes === end.minutes) return dueAt

  const date = new Date(dueAt)
  const localMinutes = date.getHours() * 60 + date.getMinutes()
  const crossesMidnight = start.minutes > end.minutes

  const inQuiet = crossesMidnight
    ? localMinutes >= start.minutes || localMinutes < end.minutes
    : localMinutes >= start.minutes && localMinutes < end.minutes
  if (!inQuiet) return dueAt

  // 跨午夜且已过 quietStart：结束时刻落在次日；否则落在当天。
  const shifted = new Date(dueAt)
  if (crossesMidnight && localMinutes >= start.minutes) shifted.setDate(shifted.getDate() + 1)
  shifted.setHours(end.hour, end.minute, 0, 0)
  return shifted.getTime()
}

/**
 * event.target.value → 字符串或 null（非字符串用 String 转换）。
 * @param {unknown} target
 * @returns {string | null}
 */
function projectTarget(target) {
  if (!target || typeof target !== 'object') return null
  const value = target.value
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return null
  return String(value)
}

/**
 * sourceRefs[0].quote → 字符串，超过 80 字符截断。
 * @param {unknown} sourceRefs
 * @returns {string}
 */
function projectQuote(sourceRefs) {
  const first = Array.isArray(sourceRefs) ? sourceRefs[0] : null
  const quote = first && typeof first.quote === 'string' ? first.quote : ''
  return quote.length > MAX_QUOTE_LENGTH ? quote.slice(0, MAX_QUOTE_LENGTH) : quote
}

/**
 * 单个事件 → 回访计划。
 *
 * 依次校验：类型白名单、事实地位白名单、有原文时间表达、时间可解析、
 * 推过免打扰时段、不早于 now + minLeadMinutes、不晚于 now + maxHorizonDays。
 * 任一不满足返回 null；异常输入（null / 非对象）也不抛错，返回 null。
 *
 * @param {Record<string, any>} event 模块 0 的语义事件
 * @param {{
 *   now?: number,
 *   quietStart?: string,
 *   quietEnd?: string,
 *   minLeadMinutes?: number,
 *   maxHorizonDays?: number,
 * }} [options]
 * @returns {null | {
 *   eventId: string,
 *   sessionId: string,
 *   eventSeq: number,
 *   type: string,
 *   target: string | null,
 *   timeExpression: string,
 *   quote: string,
 *   dueAt: number,
 * }}
 */
export function planRevisit(event, options = {}) {
  try {
    if (!event || typeof event !== 'object') return null
    const opts = options && typeof options === 'object' ? options : {}

    // 1. 类型白名单
    if (!REVISIT_TYPES.includes(event.type)) return null
    // 只回访「主人自己说过」的打算/计划：鱼鱼自我陈述（persona:dafeiyu）不能当成主人说的。
    if (event.actorRef !== 'owner') return null
    // 2. 事实地位白名单（hypothetical / uncertain / negated 跳过）
    if (!REVISIT_EVIDENCE.includes(event.evidenceStatus)) return null

    // eventId 是去重键，必须是非空字符串，否则无法生成可用计划。
    if (typeof event.eventId !== 'string' || event.eventId.length === 0) return null

    // 3. 必须有原文时间表达
    const attributes = event.attributes && typeof event.attributes === 'object' ? event.attributes : {}
    const rawExpression = attributes.timeExpression
    if (typeof rawExpression !== 'string' || rawExpression.trim().length === 0) return null
    const timeExpression = rawExpression.trim()

    // 4. 解析时间（相对 observedAt）
    const parsed = parseTimeExpression(timeExpression, event.observedAt)
    if (parsed === null) return null

    // 5. 推过免打扰时段
    const quietStart = typeof opts.quietStart === 'string' ? opts.quietStart : '23:30'
    const quietEnd = typeof opts.quietEnd === 'string' ? opts.quietEnd : '08:30'
    const dueAt = clampToActiveWindow(parsed, { quietStart, quietEnd })

    // 6/7. 太近或太远的都排掉
    const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()
    const minLeadMinutes = Number.isFinite(opts.minLeadMinutes) ? opts.minLeadMinutes : 20
    const maxHorizonDays = Number.isFinite(opts.maxHorizonDays) ? opts.maxHorizonDays : 7
    if (dueAt <= now + minLeadMinutes * 60000) return null
    if (dueAt > now + maxHorizonDays * DAY_MS) return null

    // 8. 产出计划
    return {
      eventId: event.eventId,
      sessionId: typeof event.sessionId === 'string' ? event.sessionId : '',
      eventSeq: Number.isFinite(event.eventSeq) ? event.eventSeq : 0,
      type: event.type,
      target: projectTarget(event.target),
      timeExpression,
      quote: projectQuote(event.sourceRefs),
      dueAt,
    }
  } catch {
    // 计划器是旁路能力，任何脏输入都不应把主动消息主流程带崩。
    return null
  }
}

/**
 * 一批事件 → 回访计划数组，按 eventId 去重（同一 eventId 只留第一条）。
 * @param {Record<string, any>[]} events
 * @param {Parameters<typeof planRevisit>[1]} [options]
 * @returns {NonNullable<ReturnType<typeof planRevisit>>[]}
 */
export function planRevisits(events, options = {}) {
  if (!Array.isArray(events)) return []
  const plans = []
  const seenEventIds = new Set()
  for (const event of events) {
    const plan = planRevisit(event, options)
    if (!plan) continue
    if (seenEventIds.has(plan.eventId)) continue
    seenEventIds.add(plan.eventId)
    plans.push(plan)
  }
  return plans
}
