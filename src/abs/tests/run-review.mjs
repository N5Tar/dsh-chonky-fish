import assert from 'node:assert/strict'

import { renderSelfReview, formatCstTime, driveDemand, REVIEW_HEADING } from '../review.js'
import { createState } from '../core.js'

const at = '2026-11-07T03:00:00.000Z'
const realAt = '2026-11-07T03:00:00.000Z'
const BANNED = ['你应该', '需要你', '请你', '建议', '去联系', '去找', '下一步', '任务', '目标', '决定', '必须', '行动', '帮我', '告诉主人', '主动找']

function custom(social, curiosity) {
  const state = createState(at)
  state.drives.social.satisfaction = social
  state.drives.curiosity.satisfaction = curiosity
  return state
}

let checks = 0
function test(name, run) { run(); checks++; console.log(`ok ${checks} - ${name}`) }

test('heading, provenance and real-time-only facts', () => {
  const text = renderSelfReview({ state: createState(at) })
  assert.ok(text.includes('### ' + REVIEW_HEADING))
  assert.ok(text.includes('非主人发言'))
  assert.ok(!text.includes('内部时间'))
  assert.ok(!text.includes('ABS 时间'))
  assert.equal(formatCstTime('2026-11-07T03:00:00Z'), '2026-11-07 11:00:00')
  assert.equal(formatCstTime('2026-11-07T16:00:00Z'), '2026-11-08 00:00:00')
  assert.equal(formatCstTime(null), '时间未记录')
})

test('no task, action, channel or second-person steering', () => {
  const scenarios = [
    custom(.55, .35),
    custom(.05, .02),
    custom(0, 0),
    custom(1, 1),
  ]
  for (const state of scenarios) {
    state.lastOwnerMessage = { at, realAt }
    state.lastExploration = { resultKind: 'explore_content_found', at, realAt }
    const text = renderSelfReview({ state })
    for (const word of BANNED) assert.ok(!text.includes(word), `banned "${word}" in:\n${text}`)
    assert.ok(!/[{}]/.test(text), 'no structured payload')
  }
})

test('qualitative levels follow the deficit', () => {
  const cases = [
    [.75, '基本处于平常的满足水平'],
    [.60, '比平常的满足水平略低'],
    [.45, '低于平常的满足水平'],
    [.30, '明显低于平常的满足水平'],
    [.10, '远低于平常的满足水平'],
  ]
  for (const [satisfaction, phrase] of cases) {
    const state = custom(satisfaction, .70)
    assert.ok(renderSelfReview({ state }).includes('社交方面：满足程度' + phrase), phrase)
  }
  assert.ok(driveDemand({ satisfaction: 2, setpoint: .7 }) === 0)
  assert.equal(driveDemand({ satisfaction: .7, setpoint: .7 }), 0)
})

test('comparison uses the previous review snapshot', () => {
  const state = custom(.30, .68)
  state.lastReview = { demand: { social: .40, curiosity: .10 } }
  const text = renderSelfReview({ state })
  assert.ok(text.includes('社交方面') && text.includes('比上一次审查时更低了一些'))
  assert.ok(text.includes('探索方面') && text.includes('比上一次审查时有所回升'))
  const steady = custom(.55, .35)
  steady.lastReview = { demand: { social: .2666666666666666, curiosity: .5 } }
  assert.ok(renderSelfReview({ state: steady }).includes('大致相近'))
})

test('observed facts are described without inference', () => {
  const state = custom(.55, .35)
  const text = renderSelfReview({ state })
  assert.ok(text.includes('目前没有记录到与主人的交流'))
  assert.ok(text.includes('目前没有记录到探索结果'))
  state.lastOwnerMessage = { at: '2030-01-01T01:00:00Z', realAt: '2026-11-07T01:00:00Z' }
  state.lastExploration = { resultKind: 'explore_no_usable_content', at: '2026-11-07T02:00:00Z', realAt: '2026-11-07T02:00:00Z' }
  const withFacts = renderSelfReview({ state })
  assert.ok(withFacts.includes('最近一次记录到与主人的交流'))
  assert.ok(withFacts.includes('没有取得可用内容'))
  assert.ok(!withFacts.includes('主人没有理'))
  assert.ok(withFacts.includes('2026-11-07 09:00:00'))
  assert.ok(!withFacts.includes('2030'))
  delete state.lastOwnerMessage.realAt
  const legacy = renderSelfReview({ state })
  assert.ok(legacy.includes('时间未记录'))
  assert.ok(!legacy.includes('2030'))
})

test('missing drives degrade honestly', () => {
  const state = createState(at)
  delete state.drives.social
  const text = renderSelfReview({ state })
  assert.ok(text.includes('社交方面的状态记录目前不可用'))
  assert.ok(!text.includes('社交方面：'))
})

test('rendering is deterministic', () => {
  const state = custom(.55, .35)
  state.lastOwnerMessage = { at, realAt }
  const first = renderSelfReview({ state })
  const second = renderSelfReview({ state })
  assert.equal(first, second)
  assert.ok(!first.includes(REVIEW_HEADING + '。'))
})

console.log(`ABS review: ${checks} groups passed (offline; pure text rendering).`)
