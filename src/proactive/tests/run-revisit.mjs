/**
 * 大肥鱼 · 主动消息：事件回访计划器测试（纯函数）。
 *
 *   node src/proactive/tests/run-revisit.mjs
 *
 * 时间基准一律用本地时间构造（new Date(y, monthIndex, d, h, m)），
 * 这样换时区跑测试结果依然一致。
 */
import assert from 'node:assert/strict'

import {
  REVISIT_EVIDENCE,
  REVISIT_TYPES,
  clampToActiveWindow,
  parseTimeExpression,
  planRevisit,
  planRevisits,
} from '../revisit.js'

/* ------------------------------------------------------------------ */
/* 测试骨架（与模块 0 既有测试风格一致）                              */
/* ------------------------------------------------------------------ */

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

/** 本地时间构造：月份从 1 开始，避免手写 monthIndex 出错。 */
function localTime(year, month, day, hour, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

/** 2026-10-26 是周一（本地时区），作为大部分用例的 observedAt。 */
const MONDAY = localTime(2026, 10, 26, 9, 0)
const MONDAY_LATE = localTime(2026, 10, 26, 11, 0)
const SATURDAY = localTime(2026, 10, 31, 9, 0)
const NOW = localTime(2026, 10, 26, 9, 30)

/* ------------------------------------------------------------------ */
/* parseTimeExpression · 相对日期                                     */
/* ------------------------------------------------------------------ */

test('常量：类型/证据白名单符合契约且被冻结', () => {
  assert.deepEqual([...REVISIT_TYPES], ['goal.intention_expressed', 'goal.plan_expressed'])
  assert.deepEqual([...REVISIT_EVIDENCE], ['intent', 'reported'])
  assert.ok(Object.isFrozen(REVISIT_TYPES))
  assert.ok(Object.isFrozen(REVISIT_EVIDENCE))
})

test('今天 / 今日 → 当天 10:00', () => {
  assert.equal(parseTimeExpression('今天', MONDAY), localTime(2026, 10, 26, 10))
  assert.equal(parseTimeExpression('今日', MONDAY), localTime(2026, 10, 26, 10))
})

test('明天 / 明日 → 次日 10:00', () => {
  assert.equal(parseTimeExpression('明天', MONDAY), localTime(2026, 10, 27, 10))
  assert.equal(parseTimeExpression('明日', MONDAY), localTime(2026, 10, 27, 10))
})

test('后天 → +2 天 10:00，大后天 → +3 天 10:00', () => {
  assert.equal(parseTimeExpression('后天', MONDAY), localTime(2026, 10, 28, 10))
  assert.equal(parseTimeExpression('大后天', MONDAY), localTime(2026, 10, 29, 10))
})

test('下周（单独出现）→ +7 天 10:00', () => {
  assert.equal(parseTimeExpression('下周', MONDAY), localTime(2026, 11, 2, 10))
  assert.equal(parseTimeExpression('下星期', MONDAY), localTime(2026, 11, 2, 10))
  assert.equal(parseTimeExpression('下礼拜', MONDAY), localTime(2026, 11, 2, 10))
})

test('下周三（周一基准）→ 下个 ISO 周的周三，9 天后 10:00', () => {
  // 周一 + 7 天 = 下周一，再 +2 天 = 下周三 = 9 天后。
  assert.equal(parseTimeExpression('下周三', MONDAY), localTime(2026, 11, 4, 10))
  assert.equal(parseTimeExpression('下星期三', MONDAY), localTime(2026, 11, 4, 10))
  assert.equal(parseTimeExpression('下礼拜三', MONDAY), localTime(2026, 11, 4, 10))
})

test('下周一 / 下周日（日、天都算周日）→ 下个 ISO 周内', () => {
  assert.equal(parseTimeExpression('下周一', MONDAY), localTime(2026, 11, 2, 10))
  assert.equal(parseTimeExpression('下周日', MONDAY), localTime(2026, 11, 8, 10))
  assert.equal(parseTimeExpression('下星期天', MONDAY), localTime(2026, 11, 8, 10))
})

test('周X（无上下这）→ 未来最近的那个星期几 10:00', () => {
  assert.equal(parseTimeExpression('周三', MONDAY), localTime(2026, 10, 28, 10))
  assert.equal(parseTimeExpression('星期五', MONDAY), localTime(2026, 10, 30, 10))
  assert.equal(parseTimeExpression('周日', MONDAY), localTime(2026, 11, 1, 10))
  assert.equal(parseTimeExpression('礼拜天', MONDAY), localTime(2026, 11, 1, 10))
})

test('周X：当天就是该星期但默认时刻已过 → 再加 7 天', () => {
  // 周一 11:00 说「周一」，今天 10:00 已过，只能下周。
  assert.equal(parseTimeExpression('周一', MONDAY_LATE), localTime(2026, 11, 2, 10))
  // 「周三」还没到，不影响。
  assert.equal(parseTimeExpression('周三', MONDAY_LATE), localTime(2026, 10, 28, 10))
})

test('周末 / 这周末 / 这个周末 → 未来最近的周六 10:00', () => {
  assert.equal(parseTimeExpression('周末', MONDAY), localTime(2026, 10, 31, 10))
  assert.equal(parseTimeExpression('这周末', MONDAY), localTime(2026, 10, 31, 10))
  assert.equal(parseTimeExpression('这个周末', MONDAY), localTime(2026, 10, 31, 10))
})

test('周末：当天就是周六则取当天（是否太近交给 planRevisit）', () => {
  assert.equal(parseTimeExpression('周末', SATURDAY), localTime(2026, 10, 31, 10))
})

test('N天后 / 隔N天：支持阿拉伯数字与中文数字', () => {
  assert.equal(parseTimeExpression('三天后', MONDAY), localTime(2026, 10, 29, 10))
  assert.equal(parseTimeExpression('两天后', MONDAY), localTime(2026, 10, 28, 10))
  assert.equal(parseTimeExpression('3天后', MONDAY), localTime(2026, 10, 29, 10))
  assert.equal(parseTimeExpression('十天后', MONDAY), localTime(2026, 11, 5, 10))
  assert.equal(parseTimeExpression('隔五天', MONDAY), localTime(2026, 10, 31, 10))
  assert.equal(parseTimeExpression('隔2天', MONDAY), localTime(2026, 10, 28, 10))
})

test('N小时后 / N个小时后 / 过N小时 → 精确 +N 小时', () => {
  assert.equal(parseTimeExpression('三个小时后', MONDAY), localTime(2026, 10, 26, 12))
  assert.equal(parseTimeExpression('两个小时后', MONDAY), localTime(2026, 10, 26, 11))
  assert.equal(parseTimeExpression('3个小时后', MONDAY), localTime(2026, 10, 26, 12))
  assert.equal(parseTimeExpression('2小时后', MONDAY), localTime(2026, 10, 26, 11))
  assert.equal(parseTimeExpression('过2小时', MONDAY), localTime(2026, 10, 26, 11))
})

test('M月D日：今年还没到 → 今年 10:00', () => {
  assert.equal(parseTimeExpression('11月5日', MONDAY), localTime(2026, 11, 5, 10))
  assert.equal(parseTimeExpression('11月5号', MONDAY), localTime(2026, 11, 5, 10))
  // 同一天但默认时刻还没到，取今年。
  assert.equal(parseTimeExpression('10月26日', MONDAY), localTime(2026, 10, 26, 10))
})

test('M月D日：今年已过 → 明年 10:00（跨年）', () => {
  assert.equal(parseTimeExpression('1月3号', MONDAY), localTime(2027, 1, 3, 10))
  assert.equal(parseTimeExpression('10月1日', MONDAY), localTime(2027, 10, 1, 10))
})

test('M月D日：不存在的日期 / 非法月日 → null', () => {
  assert.equal(parseTimeExpression('2月30日', MONDAY), null)
  assert.equal(parseTimeExpression('13月1日', MONDAY), null)
  assert.equal(parseTimeExpression('4月31号', MONDAY), null)
})

/* ------------------------------------------------------------------ */
/* parseTimeExpression · 时段修饰                                     */
/* ------------------------------------------------------------------ */

test('时段修饰：早上/上午/早晨 10:00，中午/午饭 12:00，下午 15:00，傍晚 18:00，晚上 20:00', () => {
  assert.equal(parseTimeExpression('明天早上', MONDAY), localTime(2026, 10, 27, 10))
  assert.equal(parseTimeExpression('明天上午', MONDAY), localTime(2026, 10, 27, 10))
  assert.equal(parseTimeExpression('明天早晨', MONDAY), localTime(2026, 10, 27, 10))
  assert.equal(parseTimeExpression('明天中午', MONDAY), localTime(2026, 10, 27, 12))
  assert.equal(parseTimeExpression('明天午饭', MONDAY), localTime(2026, 10, 27, 12))
  assert.equal(parseTimeExpression('明天下午', MONDAY), localTime(2026, 10, 27, 15))
  assert.equal(parseTimeExpression('明天傍晚', MONDAY), localTime(2026, 10, 27, 18))
  assert.equal(parseTimeExpression('明天晚上', MONDAY), localTime(2026, 10, 27, 20))
  assert.equal(parseTimeExpression('明天夜里', MONDAY), localTime(2026, 10, 27, 20))
  assert.equal(parseTimeExpression('明天夜间', MONDAY), localTime(2026, 10, 27, 20))
})

test('时段修饰叠加日期：后天/今晚/明晚/明早', () => {
  assert.equal(parseTimeExpression('后天下午', MONDAY), localTime(2026, 10, 28, 15))
  assert.equal(parseTimeExpression('今晚', MONDAY), localTime(2026, 10, 26, 20))
  assert.equal(parseTimeExpression('今天晚上', MONDAY), localTime(2026, 10, 26, 20))
  assert.equal(parseTimeExpression('明晚', MONDAY), localTime(2026, 10, 27, 20))
  assert.equal(parseTimeExpression('明天晚上', MONDAY), localTime(2026, 10, 27, 20))
  assert.equal(parseTimeExpression('明早', MONDAY), localTime(2026, 10, 27, 10))
  assert.equal(parseTimeExpression('明天早上', MONDAY), localTime(2026, 10, 27, 10))
})

test('时段修饰叠加周表达 / 周末', () => {
  assert.equal(parseTimeExpression('下周三下午', MONDAY), localTime(2026, 11, 4, 15))
  assert.equal(parseTimeExpression('下周日晚上', MONDAY), localTime(2026, 11, 8, 20))
  assert.equal(parseTimeExpression('周三晚上', MONDAY), localTime(2026, 10, 28, 20))
  assert.equal(parseTimeExpression('周末晚上', MONDAY), localTime(2026, 10, 31, 20))
})

test('空白处理：首尾与中间空白都忽略', () => {
  assert.equal(parseTimeExpression(' 明天 ', MONDAY), localTime(2026, 10, 27, 10))
  assert.equal(parseTimeExpression('明 天', MONDAY), localTime(2026, 10, 27, 10))
  assert.equal(parseTimeExpression('\u3000明天\u3000', MONDAY), localTime(2026, 10, 27, 10))
})

test('observedAt 也接受 ISO 字符串（按本地时区解释相对日期）', () => {
  const iso = new Date(2026, 9, 26, 9, 0).toISOString()
  assert.equal(parseTimeExpression('明天', iso), localTime(2026, 10, 27, 10))
})

/* ------------------------------------------------------------------ */
/* parseTimeExpression · null 边界                                    */
/* ------------------------------------------------------------------ */

test('过去 / 不可用表达 → null', () => {
  const pastExpressions = [
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
  ]
  for (const expression of pastExpressions) {
    assert.equal(parseTimeExpression(expression, MONDAY), null, expression + ' 应返回 null')
  }
})

test('空串 / 纯空白 → null', () => {
  assert.equal(parseTimeExpression('', MONDAY), null)
  assert.equal(parseTimeExpression('   ', MONDAY), null)
  assert.equal(parseTimeExpression('\u3000\t\n', MONDAY), null)
})

test('未知表达 → null（不猜）', () => {
  assert.equal(parseTimeExpression('改天吧', MONDAY), null)
  assert.equal(parseTimeExpression('有空再说', MONDAY), null)
  assert.equal(parseTimeExpression('明天下午三点', MONDAY), null)
  assert.equal(parseTimeExpression('十一后', MONDAY), null)
})

test('裸时段词没有日期 → null', () => {
  assert.equal(parseTimeExpression('晚上', MONDAY), null)
  assert.equal(parseTimeExpression('下午', MONDAY), null)
})

test('非字符串表达 / 非法 observedAt → null', () => {
  assert.equal(parseTimeExpression(42, MONDAY), null)
  assert.equal(parseTimeExpression(null, MONDAY), null)
  assert.equal(parseTimeExpression(undefined, MONDAY), null)
  assert.equal(parseTimeExpression({}, MONDAY), null)
  assert.equal(parseTimeExpression('明天', 'not-a-date'), null)
  assert.equal(parseTimeExpression('明天', Number.NaN), null)
  assert.equal(parseTimeExpression('明天', undefined), null)
})

/* ------------------------------------------------------------------ */
/* clampToActiveWindow                                                */
/* ------------------------------------------------------------------ */

test('免打扰：02:00 → 当天 08:30', () => {
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 2, 0)), localTime(2026, 10, 26, 8, 30))
  // 08:00 仍在 23:30–08:30 的免打扰内，同样推到 08:30。
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 8, 0)), localTime(2026, 10, 26, 8, 30))
})

test('免打扰：23:45 → 次日 08:30', () => {
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 23, 45)), localTime(2026, 10, 27, 8, 30))
})

test('免打扰：恰好在 quietStart 23:30 → 次日 08:30', () => {
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 23, 30)), localTime(2026, 10, 27, 8, 30))
})

test('免打扰：恰好在 quietEnd 08:30 → 原样（结束边界算活跃）', () => {
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 8, 30)), localTime(2026, 10, 26, 8, 30))
})

test('免打扰之外原样返回', () => {
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 12, 0)), localTime(2026, 10, 26, 12, 0))
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 23, 0)), localTime(2026, 10, 26, 23, 0))
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 22, 0)), localTime(2026, 10, 26, 22, 0))
})

test('quietStart === quietEnd → 视为无免打扰', () => {
  assert.equal(
    clampToActiveWindow(localTime(2026, 10, 26, 2, 0), { quietStart: '22:00', quietEnd: '22:00' }),
    localTime(2026, 10, 26, 2, 0),
  )
  assert.equal(
    clampToActiveWindow(localTime(2026, 10, 26, 2, 0), { quietStart: '08:30', quietEnd: '08:30' }),
    localTime(2026, 10, 26, 2, 0),
  )
})

test('非法 quiet 配置 / 非法 dueAt → 原样返回', () => {
  assert.equal(
    clampToActiveWindow(localTime(2026, 10, 26, 2, 0), { quietStart: '25:00', quietEnd: '08:30' }),
    localTime(2026, 10, 26, 2, 0),
  )
  assert.equal(
    clampToActiveWindow(localTime(2026, 10, 26, 2, 0), { quietStart: 'abc', quietEnd: '08:30' }),
    localTime(2026, 10, 26, 2, 0),
  )
  assert.equal(clampToActiveWindow(null), null)
  assert.equal(clampToActiveWindow('not-a-number'), 'not-a-number')
  assert.ok(Number.isNaN(clampToActiveWindow(Number.NaN)))
})

test('非跨午夜免打扰：12:00–14:00 内 13:00 → 当天 14:00，外加原地不动', () => {
  const quiet = { quietStart: '12:00', quietEnd: '14:00' }
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 13, 0), quiet), localTime(2026, 10, 26, 14, 0))
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 12, 0), quiet), localTime(2026, 10, 26, 14, 0))
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 11, 0), quiet), localTime(2026, 10, 26, 11, 0))
  assert.equal(clampToActiveWindow(localTime(2026, 10, 26, 14, 0), quiet), localTime(2026, 10, 26, 14, 0))
})

test('自定义跨午夜免打扰：00:00–06:00 内 01:00 → 当天 06:00', () => {
  assert.equal(
    clampToActiveWindow(localTime(2026, 10, 26, 1, 0), { quietStart: '00:00', quietEnd: '06:00' }),
    localTime(2026, 10, 26, 6, 0),
  )
})

/* ------------------------------------------------------------------ */
/* planRevisit                                                        */
/* ------------------------------------------------------------------ */

let seq = 0
function makeEvent(overrides = {}) {
  seq += 1
  return {
    eventId: 'event-' + seq,
    schemaVersion: '1.0',
    sessionId: 'session-1',
    category: 'goal',
    type: 'goal.plan_expressed',
    actorRef: 'owner',
    action: 'express_plan',
    target: { kind: 'activity', value: '考试' },
    polarity: 'neutral',
    evidenceStatus: 'reported',
    occurredAt: null,
    observedAt: MONDAY,
    sourceRefs: [{ recordId: 'session-1:42', seq: 42, quote: '明天要考试', spanStart: 0, spanEnd: 5 }],
    attributes: { timeExpression: '明天' },
    ...overrides,
  }
}

test('planRevisit：正常计划返回完整字段', () => {
  const event = makeEvent()
  const plan = planRevisit(event, { now: NOW })
  assert.ok(plan)
  assert.equal(plan.eventId, event.eventId)
  assert.equal(plan.sessionId, 'session-1')
  assert.equal(plan.eventSeq, event.eventSeq ?? 0)
  assert.equal(plan.type, 'goal.plan_expressed')
  assert.equal(plan.target, '考试')
  assert.equal(plan.timeExpression, '明天')
  assert.equal(plan.quote, '明天要考试')
  assert.equal(plan.dueAt, localTime(2026, 10, 27, 10))
  assert.deepEqual(Object.keys(plan).sort(), [
    'dueAt',
    'eventId',
    'eventSeq',
    'quote',
    'sessionId',
    'target',
    'timeExpression',
    'type',
  ])
})

test('planRevisit：goal.intention_expressed + intent 也接受', () => {
  const plan = planRevisit(makeEvent({ type: 'goal.intention_expressed', evidenceStatus: 'intent' }), { now: NOW })
  assert.ok(plan)
  assert.equal(plan.type, 'goal.intention_expressed')
})

test('planRevisit：只回访主人自己的话（persona 自我陈述 → null）', () => {
  assert.equal(planRevisit(makeEvent({ actorRef: 'persona:dafeiyu' }), { now: NOW }), null)
  assert.equal(planRevisit(makeEvent({ actorRef: 'someone-else' }), { now: NOW }), null)
  assert.equal(planRevisit(makeEvent({ actorRef: undefined }), { now: NOW }), null)
  assert.ok(planRevisit(makeEvent({ actorRef: 'owner' }), { now: NOW }))
})

test('planRevisit：类型不在白名单 → null', () => {
  for (const type of [
    'preference.like_expressed',
    'activity.activity_reported',
    'interaction.compliment_expressed',
    undefined,
    null,
  ]) {
    assert.equal(planRevisit(makeEvent({ type }), { now: NOW }), null, String(type))
  }
})

test('planRevisit：evidenceStatus 为 hypothetical / uncertain / negated → null', () => {
  for (const evidenceStatus of ['hypothetical', 'uncertain', 'negated']) {
    assert.equal(planRevisit(makeEvent({ evidenceStatus }), { now: NOW }), null, evidenceStatus)
  }
})

test('planRevisit：缺 timeExpression / 空表达 → null', () => {
  assert.equal(planRevisit(makeEvent({ attributes: {} }), { now: NOW }), null)
  assert.equal(planRevisit(makeEvent({ attributes: { timeExpression: '' } }), { now: NOW }), null)
  assert.equal(planRevisit(makeEvent({ attributes: { timeExpression: '   ' } }), { now: NOW }), null)
  assert.equal(planRevisit(makeEvent({ attributes: null }), { now: NOW }), null)
})

test('planRevisit：时间无法解析 → null', () => {
  assert.equal(planRevisit(makeEvent({ attributes: { timeExpression: '改天吧' } }), { now: NOW }), null)
  assert.equal(planRevisit(makeEvent({ observedAt: 'not-a-date' }), { now: NOW }), null)
})

test('planRevisit：太近（now + minLeadMinutes 以内）→ null', () => {
  // 今天 10:00 回访，now = 09:50，默认最小提前 20 分钟 → 拒绝。
  const now = localTime(2026, 10, 26, 9, 50)
  assert.equal(planRevisit(makeEvent({ attributes: { timeExpression: '今天' } }), { now }), null)
  // 显式把 minLeadMinutes 调到 5 → 10 分钟后到点，放行。
  const plan = planRevisit(makeEvent({ attributes: { timeExpression: '今天' } }), { now, minLeadMinutes: 5 })
  assert.ok(plan)
  assert.equal(plan.dueAt, localTime(2026, 10, 26, 10))
})

test('planRevisit：太远（超出 maxHorizonDays）→ null', () => {
  // 「下周」= 11-02 10:00，now = 10-26 09:30，默认 horizon 7 天 → 拒绝。
  assert.equal(planRevisit(makeEvent({ attributes: { timeExpression: '下周' } }), { now: NOW }), null)
  // 放宽到 8 天 → 放行。
  const plan = planRevisit(makeEvent({ attributes: { timeExpression: '下周' } }), { now: NOW, maxHorizonDays: 8 })
  assert.ok(plan)
  assert.equal(plan.dueAt, localTime(2026, 11, 2, 10))
})

test('planRevisit：dueAt 会推过免打扰时段', () => {
  // 明天 10:00 落在 09:30–10:30 免打扰里 → 推到 10:30。
  const plan = planRevisit(makeEvent(), { now: NOW, quietStart: '09:30', quietEnd: '10:30' })
  assert.ok(plan)
  assert.equal(plan.dueAt, localTime(2026, 10, 27, 10, 30))
})

test('planRevisit：target 投影（字符串 / 数字 / 缺失）', () => {
  assert.equal(planRevisit(makeEvent({ target: { kind: 'activity', value: 42 } }), { now: NOW }).target, '42')
  assert.equal(planRevisit(makeEvent({ target: null }), { now: NOW }).target, null)
  assert.equal(planRevisit(makeEvent({ target: { kind: 'activity', value: null } }), { now: NOW }).target, null)
  assert.equal(planRevisit(makeEvent({ target: { kind: 'activity' } }), { now: NOW }).target, null)
})

test('planRevisit：quote 取 sourceRefs[0] 并截断到 80 字符', () => {
  const longQuote = '考'.repeat(120)
  const plan = planRevisit(makeEvent({ sourceRefs: [{ quote: longQuote }] }), { now: NOW })
  assert.equal(plan.quote.length, 80)
  assert.equal(plan.quote, '考'.repeat(80))

  assert.equal(planRevisit(makeEvent({ sourceRefs: [] }), { now: NOW }).quote, '')
  assert.equal(planRevisit(makeEvent({ sourceRefs: null }), { now: NOW }).quote, '')
})

test('planRevisit：非对象输入不抛错，返回 null', () => {
  for (const input of [null, undefined, 'abc', 42, true, []]) {
    assert.equal(planRevisit(input, { now: NOW }), null)
  }
})

test('planRevisit：缺 eventId 无法去重 → null', () => {
  assert.equal(planRevisit(makeEvent({ eventId: undefined }), { now: NOW }), null)
  assert.equal(planRevisit(makeEvent({ eventId: '' }), { now: NOW }), null)
})

/* ------------------------------------------------------------------ */
/* planRevisits                                                       */
/* ------------------------------------------------------------------ */

test('planRevisits：同一 eventId 只留第一条', () => {
  const first = makeEvent({ eventId: 'dup' })
  const second = makeEvent({ eventId: 'dup', attributes: { timeExpression: '后天' } })
  const plans = planRevisits([first, second], { now: NOW })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].eventId, 'dup')
  assert.equal(plans[0].timeExpression, '明天')
  assert.equal(plans[0].dueAt, localTime(2026, 10, 27, 10))
})

test('planRevisits：过滤无效事件、保留顺序', () => {
  const first = makeEvent()
  const second = makeEvent({ attributes: { timeExpression: '后天' } })
  const plans = planRevisits(
    [makeEvent({ type: 'preference.like_expressed' }), null, first, 42, undefined, second],
    { now: NOW },
  )
  assert.equal(plans.length, 2)
  assert.equal(plans[0].eventId, first.eventId)
  assert.equal(plans[1].eventId, second.eventId)
})

test('planRevisits：非数组输入 → 空数组', () => {
  for (const input of [null, undefined, 'x', 42, {}]) {
    assert.deepEqual(planRevisits(input, { now: NOW }), [])
  }
})

/* ------------------------------------------------------------------ */

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log('  ' + (entry.ok ? 'PASS' : 'FAIL') + '  ' + entry.name)
  if (!entry.ok) console.log('        ' + (entry.error && (entry.error.message || entry.error)))
}
console.log('revisit: ' + (results.length - failed.length) + '/' + results.length + ' passed')
process.exitCode = failed.length === 0 ? 0 : 1
