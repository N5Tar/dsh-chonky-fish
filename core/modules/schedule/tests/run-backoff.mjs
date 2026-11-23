import assert from 'node:assert/strict'
import { applyTransientSkip } from '../backoff.js'
import { SCHEDULE_LIMITS } from '../schema.js'

const base = {
  id: 's1',
  recurrence: 'daily',
  at: '09:00',
  timezone: 'Asia/Shanghai',
  nextFireAt: '2026-11-23T01:00:00.000Z', // 09:00 Shanghai
  activeFireId: 'f1',
  backoffStep: 0,
  backoffUntil: null,
  backoffOriginAt: null,
  enabled: true,
}

{
  const now = Date.parse('2026-11-23T01:00:00.000Z')
  const first = applyTransientSkip(base, now, 'skipped_busy')
  assert.equal(first.dropped, false)
  assert.ok(first.item.backoffOriginAt)
  assert.equal(first.item.backoffStep, 1)
  assert.equal(Date.parse(first.item.backoffUntil), now + SCHEDULE_LIMITS.backoffStepsMs[0])
}

{
  // accumulate past 30m → drop
  const origin = Date.parse('2026-11-23T01:00:00.000Z')
  const item = {
    ...base,
    backoffOriginAt: new Date(origin).toISOString(),
    backoffStep: 4,
  }
  const late = origin + SCHEDULE_LIMITS.maxBackoffAccumMs + 1000
  const result = applyTransientSkip(item, late, 'skipped_busy')
  assert.equal(result.dropped, true)
  assert.equal(result.item.activeFireId, null)
  assert.ok(result.item.nextFireAt)
  assert.ok(Date.parse(result.item.nextFireAt) > Date.parse(base.nextFireAt))
}

{
  const once = {
    ...base,
    recurrence: 'once',
    at: '2026-11-23T01:00:00.000Z',
    backoffOriginAt: '2026-11-23T01:00:00.000Z',
    backoffStep: 10,
  }
  const late = Date.parse(once.backoffOriginAt) + SCHEDULE_LIMITS.maxBackoffAccumMs + 1
  const result = applyTransientSkip(once, late, 'skipped_no_session')
  assert.equal(result.dropped, true)
  assert.equal(result.item.enabled, false)
  assert.equal(result.item.nextFireAt, null)
}

console.log('schedule backoff: ok')
