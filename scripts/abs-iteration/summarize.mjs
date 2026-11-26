#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { summarizeChatOwner } from './lib/summarize-chat-owner.mjs'
import { formatCycleFragment } from './lib/format-cycle-fragment.mjs'

const path = process.argv[2]
if (!path) {
  console.error('Usage: node scripts/abs-iteration/summarize.mjs <snapshot.json>')
  process.exit(2)
}

const snap = JSON.parse(readFileSync(path, 'utf8'))
const chatSummary = summarizeChatOwner(snap.activities)
const md = formatCycleFragment({
  cycleId: snap.cycleId ?? 'unknown',
  capturedAt: snap.capturedAt ?? '',
  abs: snap.abs,
  chatSummary,
})
process.stdout.write(md + '\n')
