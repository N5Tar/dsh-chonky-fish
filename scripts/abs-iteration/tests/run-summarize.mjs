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
assert.equal('choiceSummary' in summary.chatOwner.samples[0], false)
assert.equal(summary.otherIntents.study?.enqueued, 1)
assert.equal(summary.blockedOrSuppressed, 1)
console.log('abs-iteration summarize: ok')