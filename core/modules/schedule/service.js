/**
 * 日程服务：CRUD、missSkip、mark*、fires 幂等。
 */

import { randomUUID } from 'node:crypto'

import {
  DELIVERY_SESSION,
  DEFAULT_TIMEZONE,
  ERROR_CODES,
  SCHEDULE_LIMITS,
  alreadyDelivered,
  appendFireRecord,
  clearFireFields,
  emptyScheduleDoc,
  isValidClock,
  isValidTimeZone,
  normalizeDaysOfWeek,
  scheduleError,
  scheduleSource,
} from './schema.js'
import { computeNextFireAt, parseOnceAt } from './next-fire.js'
import { applyTransientSkip, dropCurrentSlot } from './backoff.js'

/**
 * @param {{
 *   repository: { load: Function, update: Function, isCorrupt?: Function },
 *   now?: () => number,
 *   idFactory?: () => string,
 * }} options
 */
export function createScheduleService({
  repository,
  now = () => Date.now(),
  idFactory = () => randomUUID(),
  warn = () => {},
} = {}) {
  if (!repository) throw new Error('schedule repository required')
  let bootMissSkipDone = false

  function noteFireOverflow(overflow) {
    if (overflow) {
      try {
        warn('[chonkyfish/schedule] fires log exceeded maxFireRecords; protected active fireIds retained')
      } catch {
        /* ignore */
      }
    }
  }

  function stamp() {
    return new Date(now()).toISOString()
  }

  async function loadDoc() {
    if (repository.isCorrupt?.()) {
      throw scheduleError(ERROR_CODES.INTERNAL, 'schedule store corrupt')
    }
    try {
      return await repository.load()
    } catch (error) {
      if (error && error.code === ERROR_CODES.CORRUPT) {
        throw scheduleError(ERROR_CODES.INTERNAL, 'schedule store corrupt')
      }
      throw error
    }
  }

  function projectItem(item) {
    // daysOfWeek 仅 weekly 有值；once/daily 必须是 null，不能是 undefined
    // （DSH tool 输出要求 lossless JSON，undefined 会触发 invalid output）
    return {
      id: item.id,
      version: item.version,
      enabled: item.enabled,
      title: item.title,
      prompt: item.prompt,
      delivery: item.delivery,
      recurrence: item.recurrence,
      at: item.at,
      timezone: item.timezone,
      daysOfWeek: Array.isArray(item.daysOfWeek) ? item.daysOfWeek : null,
      nextFireAt: item.nextFireAt ?? null,
      lastFiredAt: item.lastFiredAt ?? null,
      activeFireId: item.activeFireId ?? null,
      backoffUntil: item.backoffUntil ?? null,
      backoffStep: item.backoffStep ?? 0,
      backoffOriginAt: item.backoffOriginAt ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }
  }

  async function list({ enabledOnly = false } = {}) {
    const doc = await loadDoc()
    const items = enabledOnly ? doc.items.filter((item) => item.enabled) : doc.items
    return { ok: true, action: 'list', timezoneDefault: doc.timezoneDefault, items: items.map(projectItem) }
  }

  async function create(input) {
    const docPreview = await loadDoc()
    if (docPreview.items.length >= SCHEDULE_LIMITS.maxItems) {
      throw scheduleError(ERROR_CODES.LIMIT_REACHED, '日程数量已达上限')
    }
    const built = buildNewItem(input, docPreview.timezoneDefault, now())
    const saved = await repository.update((doc) => {
      if (doc.items.length >= SCHEDULE_LIMITS.maxItems) {
        throw scheduleError(ERROR_CODES.LIMIT_REACHED, '日程数量已达上限')
      }
      doc.items.push(built)
      return doc
    })
    const item = saved.items.find((row) => row.id === built.id)
    return { ok: true, action: 'create', item: projectItem(item) }
  }

  function buildNewItem(input, timezoneDefault, nowMs) {
    if (!input || typeof input !== 'object') throw scheduleError(ERROR_CODES.VALIDATION, '无效参数')
    const title = String(input.title || '').trim()
    const prompt = String(input.prompt || '').trim()
    if (!title || title.length > SCHEDULE_LIMITS.maxTitleChars) {
      throw scheduleError(ERROR_CODES.VALIDATION, 'title 无效')
    }
    if (!prompt || prompt.length > SCHEDULE_LIMITS.maxPromptChars) {
      throw scheduleError(ERROR_CODES.VALIDATION, 'prompt 无效')
    }
    const recurrence = input.recurrence
    if (recurrence !== 'once' && recurrence !== 'daily' && recurrence !== 'weekly') {
      throw scheduleError(ERROR_CODES.VALIDATION, 'recurrence 无效')
    }
    const timezone = input.timezone ? String(input.timezone) : timezoneDefault || DEFAULT_TIMEZONE
    if (!isValidTimeZone(timezone)) throw scheduleError(ERROR_CODES.VALIDATION, 'timezone 无效')

    let at
    let daysOfWeek
    if (recurrence === 'once') {
      at = parseOnceAt(input.at, timezone)
      if (!at) throw scheduleError(ERROR_CODES.VALIDATION, 'once.at 无效')
      if (!(Date.parse(at) > nowMs)) throw scheduleError(ERROR_CODES.ONCE_IN_PAST, 'once 时刻必须晚于现在')
    } else {
      at = String(input.at || '').trim()
      if (!isValidClock(at)) throw scheduleError(ERROR_CODES.VALIDATION, 'at 须为 HH:mm')
      if (recurrence === 'weekly') {
        daysOfWeek = normalizeDaysOfWeek(input.daysOfWeek)
        if (!daysOfWeek) throw scheduleError(ERROR_CODES.VALIDATION, 'weekly 需要有效 daysOfWeek')
      }
    }

    const base = {
      id: idFactory(),
      version: 1,
      enabled: true,
      title,
      prompt,
      delivery: DELIVERY_SESSION,
      recurrence,
      at,
      timezone,
      ...(daysOfWeek ? { daysOfWeek } : {}),
      nextFireAt: null,
      lastFiredAt: null,
      activeFireId: null,
      backoffUntil: null,
      backoffStep: 0,
      backoffOriginAt: null,
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    }
    base.nextFireAt = computeNextFireAt(base, nowMs)
    if (!base.nextFireAt && recurrence === 'once') {
      throw scheduleError(ERROR_CODES.ONCE_IN_PAST, 'once 时刻必须晚于现在')
    }
    return base
  }

  async function update(input) {
    const id = String(input?.id || '')
    const expected = input?.version
    if (!id || !Number.isInteger(expected)) throw scheduleError(ERROR_CODES.VALIDATION, '需要 id 与 version')
    const saved = await repository.update((doc) => {
      const index = doc.items.findIndex((item) => item.id === id)
      if (index < 0) throw scheduleError(ERROR_CODES.NOT_FOUND, '日程不存在')
      const current = doc.items[index]
      if (current.version !== expected) throw scheduleError(ERROR_CODES.VERSION_CONFLICT, 'version 冲突')
      let next = { ...current }
      const patch = input || {}
      let scheduleChanged = false
      if (patch.title !== undefined) {
        const title = String(patch.title).trim()
        if (!title || title.length > SCHEDULE_LIMITS.maxTitleChars) throw scheduleError(ERROR_CODES.VALIDATION, 'title 无效')
        next.title = title
      }
      if (patch.prompt !== undefined) {
        const prompt = String(patch.prompt).trim()
        if (!prompt || prompt.length > SCHEDULE_LIMITS.maxPromptChars) throw scheduleError(ERROR_CODES.VALIDATION, 'prompt 无效')
        next.prompt = prompt
      }
      if (patch.timezone !== undefined) {
        if (!isValidTimeZone(patch.timezone)) throw scheduleError(ERROR_CODES.VALIDATION, 'timezone 无效')
        next.timezone = patch.timezone
        scheduleChanged = true
      }
      if (patch.recurrence !== undefined) {
        if (patch.recurrence !== 'once' && patch.recurrence !== 'daily' && patch.recurrence !== 'weekly') {
          throw scheduleError(ERROR_CODES.VALIDATION, 'recurrence 无效')
        }
        next.recurrence = patch.recurrence
        scheduleChanged = true
      }
      if (patch.at !== undefined || scheduleChanged) {
        if (next.recurrence === 'once') {
          const at = parseOnceAt(patch.at !== undefined ? patch.at : next.at, next.timezone)
          if (!at) throw scheduleError(ERROR_CODES.VALIDATION, 'once.at 无效')
          next.at = at
        } else if (patch.at !== undefined) {
          const at = String(patch.at).trim()
          if (!isValidClock(at)) throw scheduleError(ERROR_CODES.VALIDATION, 'at 须为 HH:mm')
          next.at = at
        }
        scheduleChanged = true
      }
      if (next.recurrence === 'weekly') {
        const days = patch.daysOfWeek !== undefined ? normalizeDaysOfWeek(patch.daysOfWeek) : next.daysOfWeek
        const normalized = normalizeDaysOfWeek(days)
        if (!normalized) throw scheduleError(ERROR_CODES.VALIDATION, 'weekly 需要有效 daysOfWeek')
        next.daysOfWeek = normalized
        if (patch.daysOfWeek !== undefined) scheduleChanged = true
      } else {
        delete next.daysOfWeek
      }
      if (scheduleChanged) {
        next = clearFireFields(next)
        next.nextFireAt = computeNextFireAt(next, now())
      }
      next.version = current.version + 1
      next.updatedAt = stamp()
      doc.items[index] = next
      return doc
    })
    return { ok: true, action: 'update', item: projectItem(saved.items.find((item) => item.id === id)) }
  }

  async function remove(id) {
    const target = String(id || '')
    if (!target) throw scheduleError(ERROR_CODES.VALIDATION, '需要 id')
    await repository.update((doc) => {
      const next = doc.items.filter((item) => item.id !== target)
      if (next.length === doc.items.length) throw scheduleError(ERROR_CODES.NOT_FOUND, '日程不存在')
      doc.items = next
      return doc
    })
    return { ok: true, action: 'delete', id: target }
  }

  async function setEnabled(id, version, enabled) {
    const target = String(id || '')
    if (!target || !Number.isInteger(version)) throw scheduleError(ERROR_CODES.VALIDATION, '需要 id 与 version')
    const saved = await repository.update((doc) => {
      const index = doc.items.findIndex((item) => item.id === target)
      if (index < 0) throw scheduleError(ERROR_CODES.NOT_FOUND, '日程不存在')
      const current = doc.items[index]
      if (current.version !== version) throw scheduleError(ERROR_CODES.VERSION_CONFLICT, 'version 冲突')
      let next = { ...current, version: current.version + 1, updatedAt: stamp() }
      if (!enabled) {
        next = { ...clearFireFields(next), enabled: false, nextFireAt: null }
      } else {
        if (current.recurrence === 'once') {
          const atMs = Date.parse(current.at)
          if (!(atMs > now())) throw scheduleError(ERROR_CODES.ONCE_IN_PAST, 'once 已过期，无法启用')
        }
        next.enabled = true
        next = clearFireFields(next)
        next.nextFireAt = computeNextFireAt(next, now())
      }
      doc.items[index] = next
      return doc
    })
    return {
      ok: true,
      action: enabled ? 'enable' : 'disable',
      item: projectItem(saved.items.find((item) => item.id === target)),
    }
  }

  /** Boot 漏点；仅应调用一次（成功落盘后才打标，失败可重试）。 */
  async function missSkipBoot() {
    if (bootMissSkipDone) return { ok: true, skipped: 0 }
    const nowMs = now()
    const nowIso = new Date(nowMs).toISOString()
    let skipped = 0
    await repository.update((doc) => {
      const nextItems = []
      let fires = doc.fires
      for (const item of doc.items) {
        if (!item.enabled || !item.nextFireAt || !(Date.parse(item.nextFireAt) < nowMs)) {
          nextItems.push(item)
          continue
        }
        skipped += 1
        const fireId = item.activeFireId || idFactory()
        const appended = appendFireRecord(
          { ...doc, items: nextItems.concat(item), fires },
          { fireId, scheduleId: item.id, attemptedAt: nowIso, outcome: 'skipped_missed_on_boot' },
        )
        noteFireOverflow(appended.overflow)
        fires = appended.fires
        let next = clearFireFields(item)
        if (item.recurrence === 'once') {
          next = { ...next, enabled: false, nextFireAt: null, version: item.version + 1, updatedAt: nowIso }
        } else {
          next = {
            ...next,
            nextFireAt: computeNextFireAt(item, nowMs),
            version: item.version + 1,
            updatedAt: nowIso,
          }
        }
        nextItems.push(next)
      }
      doc.items = nextItems
      doc.fires = fires
      return doc
    })
    bootMissSkipDone = true
    return { ok: true, skipped }
  }

  function resetBootMissSkipForTests() {
    bootMissSkipDone = false
  }

  async function ensureFireId(scheduleId) {
    const nowMs = now()
    const saved = await repository.update((doc) => {
      const index = doc.items.findIndex((item) => item.id === scheduleId)
      if (index < 0) return doc
      const item = doc.items[index]
      if (!item.enabled || !item.nextFireAt) return doc
      if (!(Date.parse(item.nextFireAt) <= nowMs)) return doc
      if (item.backoffUntil && Date.parse(item.backoffUntil) > nowMs) return doc
      if (item.activeFireId) return doc
      doc.items[index] = {
        ...item,
        activeFireId: idFactory(),
        version: item.version + 1,
        updatedAt: stamp(),
      }
      return doc
    })
    return saved.items.find((item) => item.id === scheduleId) || null
  }

  async function markDelivered(scheduleId, fireId) {
    const nowMs = now()
    const nowIso = new Date(nowMs).toISOString()
    const saved = await repository.update((doc) => {
      const index = doc.items.findIndex((item) => item.id === scheduleId)
      if (index < 0) return doc
      const item = doc.items[index]
      if (item.activeFireId !== fireId) return doc
      if (alreadyDelivered(doc, scheduleId, fireId)) {
        doc.items[index] = advanceAfterDelivery(item, nowMs, nowIso)
        return doc
      }
      const deliveredFire = appendFireRecord(doc, {
        fireId,
        scheduleId,
        attemptedAt: nowIso,
        outcome: 'delivered',
      })
      noteFireOverflow(deliveredFire.overflow)
      doc.fires = deliveredFire.fires
      doc.items[index] = advanceAfterDelivery(item, nowMs, nowIso)
      return doc
    })
    return saved.items.find((item) => item.id === scheduleId) || null
  }

  function advanceAfterDelivery(item, nowMs, nowIso) {
    let next = clearFireFields(item)
    next.lastFiredAt = nowIso
    next.version = item.version + 1
    next.updatedAt = nowIso
    if (item.recurrence === 'once') {
      next.enabled = false
      next.nextFireAt = null
    } else {
      next.nextFireAt = computeNextFireAt(item, nowMs)
    }
    return next
  }

  async function repairAdvanceIfDelivered(scheduleId, fireId) {
    const doc = await loadDoc()
    if (!alreadyDelivered(doc, scheduleId, fireId)) return null
    return markDelivered(scheduleId, fireId)
  }

  async function markTransientSkip(scheduleId, fireId, outcome) {
    const nowMs = now()
    const nowIso = new Date(nowMs).toISOString()
    const saved = await repository.update((doc) => {
      const index = doc.items.findIndex((item) => item.id === scheduleId)
      if (index < 0) return doc
      const item = doc.items[index]
      if (item.activeFireId !== fireId) return doc
      const result = applyTransientSkip(item, nowMs, outcome)
      const skipFire = appendFireRecord(doc, {
        fireId,
        scheduleId,
        attemptedAt: nowIso,
        outcome,
      })
      noteFireOverflow(skipFire.overflow)
      doc.fires = skipFire.fires
      if (result.dropped) {
        const dropFire = appendFireRecord(
          { ...doc, items: doc.items.map((row, i) => (i === index ? result.item : row)) },
          { fireId, scheduleId, attemptedAt: nowIso, outcome: 'dropped_crossed_slot' },
        )
        noteFireOverflow(dropFire.overflow)
        doc.fires = dropFire.fires
      }
      doc.items[index] = {
        ...result.item,
        version: item.version + 1,
        updatedAt: nowIso,
      }
      return doc
    })
    return saved.items.find((item) => item.id === scheduleId) || null
  }

  function nextWakeAt(doc, nowMs = now()) {
    let best = null
    for (const item of doc.items) {
      if (!item.enabled) continue
      const backoffMs = item.backoffUntil ? Date.parse(item.backoffUntil) : NaN
      let wake = null
      if (Number.isFinite(backoffMs) && backoffMs > nowMs) {
        // 退避中：只睡到 backoffUntil，避免把过期 nextFireAt 当成立刻重扫死循环
        wake = backoffMs
      } else if (item.nextFireAt) {
        const nextMs = Date.parse(item.nextFireAt)
        if (Number.isFinite(nextMs)) wake = nextMs < nowMs ? nowMs : nextMs
      }
      if (wake == null) continue
      if (best == null || wake < best) best = wake
    }
    return best
  }

  function listDue(doc, nowMs = now()) {
    return doc.items
      .filter((item) => {
        if (!item.enabled || !item.nextFireAt) return false
        if (!(Date.parse(item.nextFireAt) <= nowMs)) return false
        if (item.backoffUntil && Date.parse(item.backoffUntil) > nowMs) return false
        return true
      })
      .sort((a, b) => Date.parse(a.nextFireAt) - Date.parse(b.nextFireAt))
  }

  return {
    list,
    create,
    update,
    delete: remove,
    enable: (id, version) => setEnabled(id, version, true),
    disable: (id, version) => setEnabled(id, version, false),
    missSkipBoot,
    resetBootMissSkipForTests,
    ensureFireId,
    markDelivered,
    repairAdvanceIfDelivered,
    markTransientSkip,
    alreadyDelivered: async (scheduleId, fireId) => alreadyDelivered(await loadDoc(), scheduleId, fireId),
    load: loadDoc,
    listDue,
    nextWakeAt,
    scheduleSource,
    emptyScheduleDoc,
    dropCurrentSlot,
  }
}
