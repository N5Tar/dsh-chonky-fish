import assert from 'node:assert/strict'

import { renderActionPrompt, formatCstTime, driveDemand } from '../review.js'

const owner = { sessionId: 'fish', realAt: '2026-11-07T03:00:00.000Z', sourceKind: 'user' }
const BANNED = ['你应该', '需要你', '请你', '建议', '去联系', '下一步', '任务', '目标', '必须', '帮我', '告诉主人']

let checks = 0
function test(name, run) { run(); checks++; console.log(`ok ${checks} - ${name}`) }

test('chat_owner requires a verified same-session owner timestamp', () => {
  assert.throws(() => renderActionPrompt({ intent: 'chat_owner' }), /Verified same-session/)
  assert.throws(() => renderActionPrompt({ intent: 'chat_owner', ownerInteraction: owner, currentSessionId: 'other' }), /Verified same-session/)
  assert.throws(() => renderActionPrompt({
    intent: 'chat_owner', currentSessionId: 'fish',
    ownerInteraction: { ...owner, sourceKind: 'schedule' },
  }), /Verified same-session/)
  const text = renderActionPrompt({
    intent: 'chat_owner', currentSessionId: 'fish', ownerInteraction: owner, socialGap: 0.8, previousSocialGap: 0.5,
  })
  assert.match(text, /有点想找主人聊两句/)
  assert.match(text, /2026-11-07 11:00:00/)
  assert.match(text, /这份念头更强了一些/)
  assert.match(text, /social_send_owner_message/)
  assert.match(text, /自言自语不算找到他/)
  assert.match(text, /发不出去或渠道不可用/)
  for (const word of BANNED) assert.ok(!text.includes(word), word)
})

test('chat_owner hook uses only verifiable facts and is omitted without a clock', () => {
  const base = { intent: 'chat_owner', currentSessionId: 'fish', ownerInteraction: owner }
  assert.ok(!renderActionPrompt(base).includes('眼下是'))
  const fallback = renderActionPrompt({ ...base, now: Date.parse('2026-11-07T08:30:00.000Z') })
  assert.match(fallback, /眼下是下午（16:30），离上次交流已经过去约 5 小时。/)
  const recent = renderActionPrompt({ ...base, now: Date.parse('2026-11-07T03:20:00.000Z') })
  assert.match(recent, /眼下是上午（11:20），离上次交流还不到一小时。/)
  const night = renderActionPrompt({ ...base, now: Date.parse('2026-11-07T16:30:00.000Z') })
  assert.match(night, /眼下是深夜（00:30）/)
  const explored = renderActionPrompt({ ...base, now: Date.parse('2026-11-07T08:30:00.000Z'),
    lastExploration: { resultKind: 'explore_content_found', realAt: '2026-11-07T07:00:00.000Z', sources: 3 } })
  assert.match(explored, /我最近一次出去逛是 2026-11-07 15:00:00，带回了 3 条能用的内容/)
  assert.ok(!explored.includes('眼下是'))
  for (const lastExploration of [
    { resultKind: 'explore_no_usable_content', realAt: '2026-11-07T07:00:00.000Z', sources: 3 },
    { resultKind: 'explore_content_found', realAt: '2026-11-07T07:00:00.000Z', sources: 0 },
    { resultKind: 'explore_content_found', realAt: '2026-11-07T00:00:00.000Z', sources: 3 },
    { resultKind: 'explore_content_found', realAt: '2026-11-07T09:00:00.000Z', sources: 3 },
  ]) {
    const text = renderActionPrompt({ ...base, now: Date.parse('2026-11-07T08:30:00.000Z'), lastExploration })
    assert.match(text, /眼下是下午/)
    assert.ok(!text.includes('出去逛'))
  }
  for (const word of BANNED) assert.ok(!fallback.includes(word) && !explored.includes(word), word)
  assert.match(fallback, /social_send_owner_message/)
  assert.match(fallback, /自言自语不算找到他/)
})

test('remind_rest requires a measured work streak of at least 60 minutes', () => {
  assert.throws(() => renderActionPrompt({ intent: 'remind_rest', workMinutes: 59 }), /Verified work duration/)
  const text = renderActionPrompt({ intent: 'remind_rest', workMinutes: 90 })
  assert.match(text, /连续工作了大约90分钟/)
  assert.match(text, /要不要去提醒他歇一会儿/)
  for (const word of BANNED) assert.ok(!text.includes(word), word)
})

test('continue_interest is a fixed first-person curiosity prompt', () => {
  const text = renderActionPrompt({ intent: 'continue_interest' })
  assert.equal(text, '我现在很想接触些新东西，好奇的念头很强。我最近做了点啥？要不要继续？')
  assert.throws(() => renderActionPrompt({ intent: 'unknown' }), /Invalid ABS action prompt intent/)
})

test('comparison and timestamps stay factual', () => {
  assert.equal(formatCstTime('2026-11-07T03:00:00Z'), '2026-11-07 11:00:00')
  assert.equal(formatCstTime(null), '时间未记录')
  assert.equal(formatCstTime('invalid'), '时间未记录')
  const steady = renderActionPrompt({
    intent: 'chat_owner', currentSessionId: 'fish', ownerInteraction: owner, socialGap: 0.7, previousSocialGap: 0.7,
  })
  assert.match(steady, /这份念头差不多/)
  assert.ok(!steady.includes('更强了一些'))
  assert.throws(() => renderActionPrompt({
    intent: 'chat_owner', currentSessionId: 'fish',
    ownerInteraction: { ...owner, realAt: 'not-a-time' },
  }), /Verified same-session/)
})

test('driveDemand stays clamped and null-safe', () => {
  assert.equal(driveDemand({ satisfaction: 2, setpoint: .7 }), 0)
  assert.equal(driveDemand({ satisfaction: .7, setpoint: .7 }), 0)
  assert.equal(driveDemand({ satisfaction: 0, setpoint: .7 }), 1)
  assert.equal(driveDemand(null), null)
  assert.equal(driveDemand({ satisfaction: .35, setpoint: .7 }), 0.5)
})

console.log(`ABS review: ${checks} groups passed (offline; pure text rendering).`)
