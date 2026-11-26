import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatCycleFragment } from '../lib/format-cycle-fragment.mjs'
import { summarizeChatOwner } from '../lib/summarize-chat-owner.mjs'

const dir = dirname(fileURLToPath(import.meta.url))
const page = JSON.parse(readFileSync(join(dir, 'fixtures/activities-page.json'), 'utf8'))
const chatSummary = summarizeChatOwner(page)
const absInspect = {
  state: {
    config: {
      mode: 'active',
      timeScale: 1,
      reviewIntervalMinutes: 120,
      reviewMinRealGapMinutes: 10,
      restHours: { enabled: true, start: '23:00', end: '08:00' },
      drives: { social: { satisfaction: 0.4, setpoint: 0.75, decayPerHour: 0.008 } },
      feedback: { ownerMessageGain: 0.05, explorationGain: 0.15 },
    },
  },
}
const md = formatCycleFragment({
  cycleId: '2026-11-25-R00',
  capturedAt: '2026-11-25T06:00:00.000Z',
  abs: absInspect,
  chatSummary,
})

assert.match(md, /2026-11-25-R00/)
assert.match(md, /timeScale:\s*1/)
assert.match(md, /chat_owner enqueued:\s*2/)
assert.match(md, /ep-chat-1/)
assert.doesNotMatch(md, /password|token/i)
console.log('abs-iteration format: ok')