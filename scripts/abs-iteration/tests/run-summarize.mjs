import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { summarizeChatOwner } from '../lib/summarize-chat-owner.mjs'

const dir = dirname(fileURLToPath(import.meta.url))
const page = JSON.parse(readFileSync(join(dir, 'fixtures/activities-page.json'), 'utf8'))
const summary = summarizeChatOwner(page)

assert.equal(summary.chatOwner.enqueued, 2)
assert.equal(summary.chatOwner.withVisibleReply, 1)
assert.equal(summary.chatOwner.withoutVisibleReply, 1)
assert.equal(summary.chatOwner.samples.length, 2)
assert.equal(summary.chatOwner.samples[0].episodeId, 'ep-chat-1')
assert.equal(summary.chatOwner.samples[0].choiceSummary, '想跟主人打个招呼')
assert.equal(summary.otherIntents.continue_interest?.enqueued, 1)
assert.equal(summary.blockedOrSuppressed, 1)
console.log('abs-iteration summarize: ok')