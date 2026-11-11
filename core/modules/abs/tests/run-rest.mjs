import assert from 'node:assert/strict'
import { restWindow, nextAwakeTime, sanitizeRestHours } from '../rest.js'
import { sanitizeAbsConfig, mergeAbsConfig } from '../config.js'
const at = (time) => Date.parse(time + '+08:00')
assert.equal(restWindow(at('2026-11-07T22:59:59.999')).resting, false)
assert.equal(restWindow(at('2026-11-07T23:00:00')).resting, true)
assert.equal(restWindow(at('2026-11-08T07:59:59.999')).resting, true)
assert.equal(restWindow(at('2026-11-08T08:00:00')).resting, false)
assert.equal(nextAwakeTime(at('2026-11-07T23:00:00')), at('2026-11-08T08:00:00'))
assert.equal(nextAwakeTime(at('2026-12-31T23:59:59')), at('2027-01-01T08:00:00'))
assert.equal(nextAwakeTime(at('2026-11-08T01:00:00')), at('2026-11-08T08:00:00'))
assert.equal(restWindow(at('2026-11-07T23:00:00'), { enabled: false }).resting, false)
const noon = { start: '12:00', end: '13:00' }
assert.equal(restWindow(at('2026-11-07T12:30:00'), noon).resumeAt, new Date(at('2026-11-07T13:00:00')).toISOString())
assert.equal(restWindow(at('2026-11-07T13:00:00'), noon).resting, false)
assert.deepEqual(sanitizeRestHours({ start: '24:00', end: 'bad' }), { enabled: true, start: '23:00', end: '08:00' })
assert.deepEqual(sanitizeRestHours({ start: '08:00', end: '08:00' }), { enabled: true, start: '23:00', end: '08:00' })
assert.equal(sanitizeAbsConfig({}).restHours.enabled, true)
assert.deepEqual(mergeAbsConfig({ restHours: { start: '22:00', end: '07:00' } }, { restHours: { enabled: false } }).restHours, { enabled: false, start: '22:00', end: '07:00' })
console.log('ABS rest: PASS (UTC+8 boundaries, overnight, year rollover, daytime, disabled, validation, deep merge)')
