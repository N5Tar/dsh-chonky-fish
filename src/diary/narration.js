/**
 * 大肥鱼 · 日记模块（Host 侧）· 每日提醒旁白（纯函数）。
 *
 * 这条旁白会作为 **隐藏的 user 消息** 投进鱼鱼当前会话：
 *   - 面板只渲染 source.kind === 'user' 的消息，所以旁白不可见；
 *   - 标准对话界面渲染成 notice 行，不是伪造用户发言。
 *
 * 文案原则：
 *   - 像鱼塘里的一句提醒，而不是系统播报；
 *   - 明确「先 read、没写过再 write」，避免重复触发时覆盖；
 *   - 允许写短或不写，禁止编造；
 *   - **写完不用汇报**，也不用点破提醒/旁白，免得穿帮。
 */

const CN_HOURS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

/**
 * 把 24 小时制的小时转成「晚上八点」这种口语。
 * @param {number} hour
 */
export function timeLabel(hour) {
  const value = Number.isInteger(hour) ? ((hour % 24) + 24) % 24 : 20
  const prefix = value >= 5 && value < 11
    ? '早上'
    : value >= 11 && value < 13
      ? '中午'
      : value >= 13 && value < 18
        ? '下午'
        : value >= 18
          ? '晚上'
          : '深夜'
  return prefix + CN_HOURS[((value + 11) % 12)] + '点'
}

/**
 * 生成当天日记的提醒旁白。
 * @param {{ date: string, hour?: number }} options
 * @returns {string}
 */
export function diaryNarration({ date, hour = 20 }) {
  return [
    `（鱼塘安静下来了，${timeLabel(hour)}，今天快过完了。`,
    '如果今天有什么想留下的，就写进今天的日记吧。',
    `先 diary(action="read", date="${date}") 看看今天写过没有；`,
    `没写过就用 diary(action="write", date="${date}", content="……") 写下来。`,
    '只写真实发生过的，别编；想不起来就写短一点，或者今天不写也没关系。',
    '写完收好就行，不用跟我汇报，也不用提提醒或旁白。）',
  ].join('')
}
