import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createAbsHost } from '../../../../app/dsh/adapters/abs/host.js'
import { createAbsActivityRepository } from '../../../../app/shared/storage/abs/sqlite.js'
import { createAbsService } from '../service.js'
import { sanitizeAbsConfig } from '../config.js'

const root = await mkdtemp(join(realpathSync(tmpdir()), 'chonkyfish-abs-activity-integration-'))
const at = Date.parse('2026-11-18T10:00:00.000Z')
const proactive = join(root, 'proactive.json')
await writeFile(proactive, JSON.stringify({ version: 2, activeSessionId: 'fish' }))
const callbacks = new Map(), audit = [], messages = []
let seq = 0
let turnNumber = 0, nextTurnReason = { kind: 'completed' }
const session = { id: 'fish', header: { cwd: '/fish', agentPreset: 'chonkyfish' } }
let emitEvent
const agent = {
  session, status: 'idle', ctx: { tools: { register() { return () => {} } } },
  followup(message) {
    messages.push(message)
    this.status = 'working'
    const turn = ++turnNumber
    emitEvent('turn/start', { turn })
    callbacks.get('agent/inbox/claimed')?.({ agent: this, message, turn })
    emitEvent('step/start', { turn, step: 1 })
    emitEvent('user/message', { turn, id: message.id, source: message.source })
    emitEvent('user/message', { turn, id: `runtime-${turn}`, source: { kind: 'runtime-context' } })
    emitEvent('user/message', { turn, id: `time-${turn}`, source: { kind: 'time-context' } })
    if (turn === 1) {
      const searchCall = emitEvent('tool/call', { turn, step: 1, callId: 'search-call', name: 'web_search', arguments: '{}' })
      emitEvent('tool/result', { turn, step: 1, message: { role: 'tool', toolCallId: 'search-call', source: { kind: 'tool', callId: 'search-call' }, isError: false }, meta: { sources: [{ url: 'https://example.org', title: 'Example' }], truncated: false } }, { surfaceOp: 'append', sourceEventSeqs: [searchCall.seq] })
    } else if (turn === 3) {
      const call = emitEvent('tool/call', { turn, step: 1, callId: 'aborted-search-call', name: 'web_search', arguments: '{}' })
      emitEvent('tool/result', { turn, step: 1, message: { role: 'tool', toolCallId: 'aborted-search-call', source: { kind: 'tool', callId: 'aborted-search-call' }, isError: true },
        error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    emitEvent('step/end', { turn, step: 1 })
    emitEvent('turn/end', { turn, reason: nextTurnReason })
    nextTurnReason = { kind: 'completed' }
    this.status = 'idle'
  },
}
const services = {
  agents: { list: () => [agent] }, web: { searchProviders: new Map([['test', { available: () => true }]]) },
  sessionController: { resolveAgent: async () => ({ agent }) }, sessions: { flush: async () => true },
}
const host = createAbsHost({
  ctx: { get(name) { return services[name] }, on(name, callback) { callbacks.set(name, callback); return () => callbacks.delete(name) } },
  resources: { paths: { workspace: '/fish', proactive } },
})
emitEvent = (type, data, extra = {}) => {
  const event = { type, data, seq: ++seq, time: at + seq, ...extra }
  callbacks.get('session/event')?.(session, event)
  return event
}
let state = null
const stateStore = {
  read: () => state && structuredClone(state),
  async commit(value, records) { state = structuredClone(value); audit.push(...records) },
  records: ({ limit }) => audit.slice(-limit), async close() {},
}
const activityStore = createAbsActivityRepository({ dbPath: join(root, 'activities.db'), DatabaseSync })
const cfg = sanitizeAbsConfig({
  mode: 'active', activationCooldownMinutes: 0, reviewMinRealGapMinutes: 0,
  restHours: { enabled: false, start: '23:00', end: '08:00' },
  drives: { curiosity: { initialSatisfaction: 0.2 } },
  feedback: { explorationGain: 0, ownerMessageGain: 0 },
})
let clock = at
const service = await createAbsService({ store: stateStore, activityStore, host, getConfig: () => cfg, now: () => clock, logger: { warn() {} } })

try {
  const wake = await service.wake('manual')
  assert.equal(wake.delivered, true)
  assert.equal(messages.length, 1)
  await service.syncClock()
  const result = service.activities({ from: '2026-11-17T16:00:00.000Z', to: '2026-11-18T16:00:00.000Z', limit: 10, offset: 0 })
  assert.equal(result.episodes.length, 1)
  const episode = result.episodes[0]
  assert.equal(episode.reviewStatus, 'accepted')
  assert.equal(episode.claimedStatus, 'claimed')
  assert.equal(episode.inputStatus, 'appended')
  assert.equal(episode.turnStatus, 'completed')
  assert.equal(episode.result, 'verified')
  assert.equal(episode.evidence.length, 1)
  assert.equal(episode.evidence[0].kind, 'web_search')
  assert.equal(episode.evidence[0].status, 'verified')
  assert.equal(episode.evidence[0].resultSeq > episode.evidence[0].seq, true)
  assert.equal(result.summary.verified, 1)
  assert.ok(episode.actionSelection?.intent, 'action selection is recorded on delivery')
  clock += 121 * 60000
  await service.syncClock()
  nextTurnReason = { kind: 'error', error: { code: 'TRANSPORT', message: 'sensitive provider detail' } }
  const failedWake = await service.wake('manual')
  assert.equal(failedWake.delivered, true)
  await service.syncClock()
  const afterFailure = service.activities({ from: '2026-11-17T16:00:00.000Z', to: '2026-11-18T16:00:00.000Z', limit: 10 })
  const failedEpisode = afterFailure.episodes.find(item => item.reviewId === failedWake.reviewId)
  assert.equal(failedEpisode.attribution, 'self_review')
  assert.equal(failedEpisode.turnStatus, 'failed')
  assert.equal(failedEpisode.turnDiagnostic.phase, 'before_tools')
  assert.equal(failedEpisode.turnDiagnostic.code, 'TRANSPORT')
  assert.equal(failedEpisode.result, 'failed')
  assert.equal(afterFailure.summary.failed, 1)
  assert.doesNotMatch(JSON.stringify(afterFailure), /sensitive provider detail/)
  clock += 121 * 60000
  await service.syncClock()
  nextTurnReason = { kind: 'error', error: { code: 'TRANSPORT', message: 'another provider detail' } }
  const abortedWake = await service.wake('manual')
  assert.equal(abortedWake.delivered, true)
  await service.syncClock()
  const afterAbort = service.activities({ from: '2026-11-17T16:00:00.000Z', to: '2026-11-18T16:00:00.000Z', limit: 10 })
  const abortedEpisode = afterAbort.episodes.find(item => item.reviewId === abortedWake.reviewId)
  assert.equal(abortedEpisode.result, 'unknown', 'a correlated pre-dispatch tool result is not a failed effect')
  assert.equal(abortedEpisode.evidence[0].status, 'pending', 'pre-dispatch leaves the linked attempt unresolved')
  assert.deepEqual(abortedEpisode.turnDiagnostic, { phase: 'during_tools', code: 'TRANSPORT' })
  assert.equal(afterAbort.summary.failed, 1)
  assert.equal(afterAbort.summary.unknown, 1)
  assert.doesNotMatch(JSON.stringify(afterAbort), /another provider detail/)
  console.log('ABS host→service→SQLite: correlated attempts and results persist through action delivery')
} finally {
  await service.close()
  await rm(root, { recursive: true, force: true })
}
