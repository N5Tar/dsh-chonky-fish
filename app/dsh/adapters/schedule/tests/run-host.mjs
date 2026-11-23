import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createScheduleRepository } from '../../../../shared/storage/schedule/repository.js'
import { createScheduleService } from '../../../../../core/modules/schedule/service.js'
import { createScheduleHost } from '../host.js'
import { handleScheduleRequest } from '../http.js'
import { NUDGE_SOURCE } from '../../../../../core/modules/proactive/narration.js'
import { createNudgeMessage } from '../../proactive/delivery.js'

{
  const message = createNudgeMessage('hello', {
    kind: 'chonkyfish-schedule',
    form: 'notice',
    scheduleId: 's1',
    fireId: 'f1',
    title: 't',
  })
  assert.equal(message.source.kind, 'chonkyfish-schedule')
  assert.equal(createNudgeMessage('x').source.kind, NUDGE_SOURCE.kind)
}

const dir = await mkdtemp(join(tmpdir(), 'fish-schedule-host-'))
const path = join(dir, 'schedule.json')
const proactive = join(dir, 'proactive.json')
await writeFile(proactive, JSON.stringify({ version: 2, activeSessionId: 'fish-session' }), 'utf8')

let nowMs = Date.parse('2026-11-23T04:00:00.000Z')
const repository = createScheduleRepository({ path })
const service = createScheduleService({
  repository,
  now: () => nowMs,
  idFactory: () => 'fixed-id',
})

await service.create({
  title: '提醒',
  prompt: '该喝水了',
  recurrence: 'once',
  at: '2099-01-01T12:00',
  timezone: 'Asia/Shanghai',
})

const http = await handleScheduleRequest({ service, method: 'GET' })
assert.equal(http.status, 200)
assert.equal(http.body.items.length, 1)
assert.equal(http.body.items[0].title, '提醒')

const forbidden = await handleScheduleRequest({ service, method: 'POST' })
assert.equal(forbidden.status, 405)

const deliveries = []
let timers = []
const host = createScheduleHost({
  service,
  getActiveSessionId: () => 'fish-session',
  deliver: async (sessionId, text, options) => {
    deliveries.push({ sessionId, text, source: options?.source })
    return { ok: true, messageId: 'm1' }
  },
  setTimeoutFn: (fn, ms) => {
    const handle = { ms, fn }
    timers.push(handle)
    return handle
  },
  clearTimeoutFn: (handle) => {
    timers = timers.filter((row) => row !== handle)
  },
})

// Boot 首轮 missSkip（无过点）
await host.scan()
assert.equal(deliveries.length, 0)

// 之后再变 due，常规扫描应投递（不再 missSkip）
await repository.update((doc) => {
  doc.items[0] = {
    ...doc.items[0],
    at: new Date(nowMs - 1000).toISOString(),
    nextFireAt: new Date(nowMs - 1000).toISOString(),
    enabled: true,
  }
  return doc
})

await host.scan()
assert.equal(deliveries.length, 1)
assert.equal(deliveries[0].text, '该喝水了')
assert.equal(deliveries[0].source.kind, 'chonkyfish-schedule')
assert.equal(deliveries[0].source.form, 'notice')

const after = (await service.list()).items[0]
assert.equal(after.enabled, false)
assert.equal(after.nextFireAt, null)

host.close()
await rm(dir, { recursive: true, force: true })
console.log('schedule host: ok')
