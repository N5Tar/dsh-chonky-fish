import assert from 'node:assert/strict'
import { computeNextFireAt, parseOnceAt, zonedParts, zonedTimeToUtc } from '../next-fire.js'

const TZ = 'Asia/Shanghai'

function atShanghai(y, m, d, h, min) {
  return zonedTimeToUtc(y, m, d, h, min, TZ)
}

{
  const ms = atShanghai(2026, 11, 23, 15, 30)
  const parts = zonedParts(ms, TZ)
  assert.equal(parts.year, 2026)
  assert.equal(parts.month, 11)
  assert.equal(parts.day, 23)
  assert.equal(parts.hour, 15)
  assert.equal(parts.minute, 30)
}

{
  // daily: before 09:00 → same day
  const from = atShanghai(2026, 11, 23, 8, 0)
  const next = computeNextFireAt({ recurrence: 'daily', at: '09:00', timezone: TZ }, from)
  assert.equal(Date.parse(next), atShanghai(2026, 11, 23, 9, 0))
}

{
  // daily: after 09:00 → next day (cross midnight)
  const from = atShanghai(2026, 11, 23, 10, 0)
  const next = computeNextFireAt({ recurrence: 'daily', at: '09:00', timezone: TZ }, from)
  assert.equal(Date.parse(next), atShanghai(2026, 11, 24, 9, 0))
}

{
  // weekly Sunday=0: from Saturday → next Sunday
  const saturday = atShanghai(2026, 11, 21, 12, 0) // 2026-11-21 is Saturday
  assert.equal(zonedParts(saturday, TZ).weekday, 6)
  const next = computeNextFireAt(
    { recurrence: 'weekly', at: '10:00', timezone: TZ, daysOfWeek: [0] },
    saturday,
  )
  assert.equal(Date.parse(next), atShanghai(2026, 11, 22, 10, 0))
  assert.equal(zonedParts(Date.parse(next), TZ).weekday, 0)
}

{
  const future = parseOnceAt('2099-01-01T12:00', TZ)
  assert.ok(Date.parse(future) > Date.now())
  const past = computeNextFireAt(
    { recurrence: 'once', at: '2020-01-01T00:00:00.000Z', timezone: TZ },
    Date.now(),
  )
  assert.equal(past, null)
}

console.log('schedule next-fire: ok')
