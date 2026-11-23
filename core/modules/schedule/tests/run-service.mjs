import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createScheduleRepository } from '../../../../app/shared/storage/schedule/repository.js'
import { createScheduleService } from '../service.js'
import { ERROR_CODES } from '../schema.js'

const dir = await mkdtemp(join(tmpdir(), 'fish-schedule-'))
const path = join(dir, 'schedule.json')
let nowMs = Date.parse('2026-11-23T02:00:00.000Z')
let ids = 0

const repository = createScheduleRepository({ path })
const service = createScheduleService({
  repository,
  now: () => nowMs,
  idFactory: () => `id-${++ids}`,
})

function assertLosslessJson(value, label) {
  const json = JSON.stringify(value)
  assert.ok(json != null, `${label}: stringify`)
  assert.deepEqual(value, JSON.parse(json), `${label}: lossless JSON (undefined 会破坏 round-trip)`)
}

{
  const created = await service.create({
    title: '喝水',
    prompt: '提醒自己喝水',
    recurrence: 'daily',
    at: '12:00',
    timezone: 'Asia/Shanghai',
  })
  assert.equal(created.ok, true)
  assert.equal(created.item.delivery, 'session')
  assert.ok(created.item.nextFireAt)
  assertLosslessJson(created, 'create daily')
  assert.equal(created.item.daysOfWeek, null)
}

{
  // once/daily 的 tool 返回不得含 undefined（DSH：value is not lossless JSON）
  const once = await service.create({
    title: '临时',
    prompt: 'once',
    recurrence: 'once',
    at: '2099-01-01T12:00',
    timezone: 'Asia/Shanghai',
  })
  assertLosslessJson(once, 'create once')
  const weekly = await service.create({
    title: '周报',
    prompt: 'weekly',
    recurrence: 'weekly',
    at: '18:00',
    timezone: 'Asia/Shanghai',
    daysOfWeek: [0],
  })
  assertLosslessJson(weekly, 'create weekly')
  assert.deepEqual(weekly.item.daysOfWeek, [0])
  const listed = await service.list()
  assertLosslessJson(listed, 'list mixed')
  const disabled = await service.disable(once.item.id, once.item.version)
  assertLosslessJson(disabled, 'disable once')
  await service.delete(once.item.id)
  await service.delete(weekly.item.id)
}

{
  await assert.rejects(
    () =>
      service.create({
        title: '过去',
        prompt: 'x',
        recurrence: 'once',
        at: '2020-01-01T12:00',
        timezone: 'Asia/Shanghai',
      }),
    (error) => error.code === ERROR_CODES.ONCE_IN_PAST,
  )
}

{
  const listed = await service.list()
  assert.equal(listed.items.length, 1)
  const item = listed.items[0]
  const updated = await service.update({
    id: item.id,
    version: item.version,
    at: '13:00',
  })
  assert.equal(updated.item.at, '13:00')
  assert.equal(updated.item.activeFireId, null)
  assert.equal(updated.item.version, item.version + 1)
}

{
  const item = (await service.list()).items[0]
  // force due in the past for missSkip
  await repository.update((doc) => {
    doc.items[0] = {
      ...doc.items[0],
      nextFireAt: '2026-11-23T01:00:00.000Z',
      activeFireId: 'fire-old',
      backoffUntil: '2026-11-23T01:30:00.000Z',
      backoffStep: 2,
      backoffOriginAt: '2026-11-23T01:00:00.000Z',
    }
    return doc
  })
  nowMs = Date.parse('2026-11-23T03:00:00.000Z')
  const miss = await service.missSkipBoot()
  assert.equal(miss.skipped, 1)
  const after = (await service.list()).items[0]
  assert.equal(after.activeFireId, null)
  assert.equal(after.backoffOriginAt, null)
  assert.ok(Date.parse(after.nextFireAt) > nowMs || after.nextFireAt)
  const again = await service.missSkipBoot()
  assert.equal(again.skipped, 0)
}

{
  const item = (await service.list()).items[0]
  await repository.update((doc) => {
    doc.items[0] = { ...doc.items[0], nextFireAt: new Date(nowMs - 1000).toISOString(), activeFireId: null }
    return doc
  })
  const ensured = await service.ensureFireId(item.id)
  assert.ok(ensured.activeFireId)
  const fireId = ensured.activeFireId
  await service.markDelivered(item.id, fireId)
  const after = (await service.list()).items[0]
  assert.equal(after.activeFireId, null)
  assert.ok(after.lastFiredAt)
  assert.ok(await service.alreadyDelivered(item.id, fireId))
}

{
  const item = (await service.list()).items[0]
  await service.disable(item.id, item.version)
  const after = (await service.list()).items[0]
  assert.equal(after.enabled, false)
  assert.equal(after.nextFireAt, null)
}

{
  // 过期 nextFireAt 仍应立刻唤醒
  await repository.update((doc) => {
    doc.items = [
      {
        id: 'due-past',
        version: 1,
        enabled: true,
        title: 'past',
        prompt: 'p',
        delivery: 'session',
        recurrence: 'daily',
        at: '09:00',
        timezone: 'Asia/Shanghai',
        nextFireAt: new Date(nowMs - 60_000).toISOString(),
        lastFiredAt: null,
        activeFireId: null,
        backoffUntil: null,
        backoffStep: 0,
        backoffOriginAt: null,
        createdAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      },
    ]
    return doc
  })
  const wake = service.nextWakeAt(await service.load(), nowMs)
  assert.equal(wake, nowMs)
}

{
  // missSkip 失败不得打标：模拟 update 抛错后仍可重试
  service.resetBootMissSkipForTests()
  let calls = 0
  const flaky = {
    isCorrupt: () => false,
    load: () => repository.load(),
    update: async (mutator) => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('disk'), { code: 'INTERNAL' })
      return repository.update(mutator)
    },
  }
  const flakyService = createScheduleService({
    repository: flaky,
    now: () => nowMs,
    idFactory: () => 'boot-id',
  })
  await assert.rejects(() => flakyService.missSkipBoot())
  const second = await flakyService.missSkipBoot()
  assert.equal(second.ok, true)
}

await rm(dir, { recursive: true, force: true })
console.log('schedule service: ok')
