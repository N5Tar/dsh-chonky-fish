/**
 * 大肥鱼主动消息 · 旁白文案（纯函数）。
 *
 * 主动消息的实现方式：往鱼鱼会话里注入一条 **user 角色的旁白**（source.kind 不是
 * 'user'），驱动一个真实 turn；鱼鱼按人格自己生成回复。
 *
 *   - 大肥鱼面板只显示 source.kind === 'user' 的用户消息，所以旁白不会穿帮；
 *   - 标准对话界面会把非 user 来源渲染成 context 行（form: 'notice'），
 *     显示成「大肥鱼主动来找你了」，也不是伪造的用户发言。
 *
 * 旁白里必须写死「不要提时间/系统/提醒」，否则模型很容易回一句
 * 「叮咚，提醒时间到」这种破坏角色的话。
 */

/** 注入旁白的消息来源；面板据此隐藏，标准对话渲染成 notice 行。 */
export const NUDGE_SOURCE = Object.freeze({
  kind: 'chonkyfish-nudge',
  form: 'notice',
  summary: '大肥鱼主动来找你了',
})

/**
 * 一天的时段，给旁白一点时间感（真正的当前时间由 preset 的 time-context 提供）。
 * @param {number} ms
 * @returns {'凌晨'|'早上'|'上午'|'中午'|'下午'|'傍晚'|'晚上'|'深夜'}
 */
export function timeBucket(ms) {
  const hour = new Date(ms).getHours()
  if (hour < 5) return '凌晨'
  if (hour < 8) return '早上'
  if (hour < 11) return '上午'
  if (hour < 13) return '中午'
  if (hour < 17) return '下午'
  if (hour < 19) return '傍晚'
  if (hour < 23) return '晚上'
  return '深夜'
}

/**
 * 默认旁白：调用方没有指定「为什么这时候说话」时使用。
 * 之后接入空闲/回访等触发点时，可以按触发原因传入更具体的旁白。
 * @param {{ now?: number }} [options]
 * @returns {string}
 */
export function defaultNarration({ now = Date.now() } = {}) {
  const bucket = timeBucket(now)
  return [
    '（鱼塘旁白，不是主人的话：现在是' + bucket + '，主人可能正在忙。）',
    '你想主动跟主人说点什么。',
    '直接说你想说的话，一两句就好，用你平时的鱼鱼口吻，可以带表情。',
    '不要解释你为什么忽然说话，不要提时间、倒计时、系统、提醒或旁白；',
    '也不要假装主人刚刚说了什么。除非真的必要，不要调用工具，直接说一句话就好。',
  ].join('')
}
