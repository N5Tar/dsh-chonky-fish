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
  assert.match(text, /很想和主人说说话/)
  assert.match(text, /2026-11-07 11:00:00/)
  assert.match(text, /这份念头更强了一些/)
  assert.match(text, /要不要找他说说话/)
  for (const word of BANNED) assert.ok(!text.includes(word), word)
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
