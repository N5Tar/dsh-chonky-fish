import assert from 'node:assert/strict'

import { renderSelfReview, formatCstTime, driveDemand, REVIEW_HEADING } from '../review.js'
import { createState } from '../core.js'

const at = '2026-11-07T03:00:00.000Z'
const realAt = '2026-11-07T03:00:00.000Z'
const BANNED = ['你应该', '需要你', '请你', '建议', '去联系', '去找', '下一步', '任务', '目标', '决定', '必须', '行动', '帮我', '告诉主人', '主动找', '满足程度', '缺口', '<think>', 'reasoning']

function custom(social, curiosity) {
  const state = createState(at)
  state.drives.social.satisfaction = social
  state.drives.curiosity.satisfaction = curiosity
  return state
}

let checks = 0
function test(name, run) { run(); checks++; console.log(`ok ${checks} - ${name}`) }

test('first-person monologue preserves provenance and real-time-only facts', () => {
  const text = renderSelfReview({ state: createState(at) })
  assert.ok(text.startsWith(`【${REVIEW_HEADING} · 非主人发言】`))
  assert.ok(text.includes('唔……我'))
  assert.ok(text.includes('这些只是我此刻的念头'))
  assert.ok(text.includes('想不出也没关系'))
  assert.ok(!text.includes('###'))
  assert.ok(!text.includes('内部时间'))
  assert.ok(!text.includes('ABS 时间'))
  assert.equal(formatCstTime('2026-11-07T03:00:00Z'), '2026-11-07 11:00:00')
  assert.equal(formatCstTime('2026-11-07T16:00:00Z'), '2026-11-08 00:00:00')
  assert.equal(formatCstTime(null), '时间未记录')
  assert.equal(formatCstTime('invalid'), '时间未记录')
})

test('no prescribed task, channel, second-person steering or fake reasoning tags', () => {
  for (const social of [0, .10, .30, .45, .60, .75, 1]) {
    for (const curiosity of [0, .07, .28, .42, .56, .70, 1]) {
      const state = custom(social, curiosity)
      state.lastOwnerMessage = { at, realAt }
      state.lastExploration = { resultKind: 'explore_content_found', at, realAt }
      const text = renderSelfReview({ state })
      for (const word of BANNED) assert.ok(!text.includes(word), `banned "${word}" in:\n${text}`)
      assert.ok(!/[{}]/.test(text), 'no structured payload')
    }
  }
})

test('five social and curiosity levels still follow their respective deficits', () => {
  const socialCases = [
    [.75, '不怎么惦记着聊天'], [.60, '有一点想和主人'],
    [.45, '想和主人说说话的念头还挺明显'], [.30, '挺想和主人'], [.10, '很想和主人'],
  ]
  const curiosityCases = [
    [.70, '没有特别想追着弄明白'], [.56, '还有一点想接触'],
    [.42, '有点想接触'], [.28, '挺想接触'], [.07, '很想接触'],
  ]
  for (const [satisfaction, phrase] of socialCases) {
    assert.ok(renderSelfReview({ state: custom(satisfaction, .70) }).includes(phrase), phrase)
  }
  for (const [satisfaction, phrase] of curiosityCases) {
    assert.ok(renderSelfReview({ state: custom(.75, satisfaction) }).includes(phrase), phrase)
  }
  assert.equal(driveDemand({ satisfaction: 2, setpoint: .7 }), 0)
  assert.equal(driveDemand({ satisfaction: .7, setpoint: .7 }), 0)
})

test('satisfied drives do not manufacture curiosity or urgency', () => {
  const text = renderSelfReview({ state: custom(1, 1) })
  assert.ok(text.includes('自己待着也挺自在'))
  assert.ok(text.includes('没有特别想追着弄明白'))
  assert.ok(!text.includes('最近有没有什么让我在意'))
  assert.ok(!text.includes('很想'))
})

test('comparison follows the previous deficit, not a fabricated memory', () => {
  const state = custom(.30, .68)
  state.lastReview = { demand: { social: .40, curiosity: .10 } }
  const paragraphs = renderSelfReview({ state }).split('\n\n')
  assert.ok(paragraphs[1].includes('这份念头更强了一些'))
  assert.ok(paragraphs[2].includes('这份念头淡了一些'))
  const steady = custom(.55, .35)
  steady.lastReview = { demand: { social: .2666666666666666, curiosity: .5 } }
  assert.ok(renderSelfReview({ state: steady }).includes('这份念头差不多'))
  assert.ok(!renderSelfReview({ state: custom(.55, .35) }).includes('上次留意自己'))
})

test('observed facts retain real timestamps without inventing absence or history', () => {
  const state = custom(.55, .35)
  const text = renderSelfReview({ state })
  assert.ok(text.includes('还没有记下和主人的交流'))
  assert.ok(text.includes('还没有记下最近的探索结果'))
  assert.ok(!text.includes('很久'))
  state.lastOwnerMessage = { at: '2030-01-01T01:00:00Z', realAt: '2026-11-07T01:00:00Z' }
  state.lastExploration = { resultKind: 'explore_no_usable_content', at, realAt: '2026-11-07T02:00:00Z' }
  const withFacts = renderSelfReview({ state })
  assert.ok(withFacts.includes('最近一次和主人的交流记录'))
  assert.ok(withFacts.includes('没有拿到可用的内容'))
  assert.ok(!withFacts.includes('主人没有理'))
  assert.ok(withFacts.includes('2026-11-07 09:00:00'))
  assert.ok(withFacts.includes('2026-11-07 10:00:00'))
  assert.ok(!withFacts.includes('2030'))
  delete state.lastOwnerMessage.realAt
  const legacy = renderSelfReview({ state })
  assert.ok(legacy.includes('时间未记录'))
  assert.ok(!legacy.includes('2030'))
})

test('exploration outcomes do not claim mastery, quality or unverified completion', () => {
  for (const [resultKind, phrase] of [
    ['explore_content_found', '不能只凭拿到资料就算数'],
    ['local_content_found', '不代表质量已经过验证'],
    ['explore_no_usable_content', '没有拿到可用的内容'],
    ['failed', '没有顺利完成'],
    ['unverified_activity', '结果还不能确认'],
    ['unknown-result', '结果还不能确认'],
  ]) {
    const state = custom(.55, .35)
    state.lastExploration = { resultKind, realAt }
    const text = renderSelfReview({ state })
    assert.ok(text.includes(phrase), resultKind)
    assert.ok(!text.includes('我学会了'))
  }
})

test('missing or invalid drives degrade honestly without fabricated desires', () => {
  const state = createState(at)
  delete state.drives.social
  state.drives.curiosity.satisfaction = NaN
  const text = renderSelfReview({ state })
  assert.ok(text.includes('社交状态还不清楚'))
  assert.ok(text.includes('有多好奇，也还不清楚'))
  assert.ok(!text.includes('想和主人'))
  assert.ok(!text.includes('最近有没有什么让我在意'))
  assert.equal(text, renderSelfReview({ state: null }))
})

test('rendering is deterministic and leaves state untouched', () => {
  const state = custom(.55, .35)
  state.lastOwnerMessage = { at, realAt }
  const before = structuredClone(state)
  const first = renderSelfReview({ state })
  assert.equal(first, renderSelfReview({ state }))
  assert.deepEqual(state, before)
})

console.log(`ABS review: ${checks} groups passed (offline; pure text rendering).`)
