/**
 * 单工具 fish_schedule（多 action）。
 */

import { toPublicError } from './schema.js'

export const FISH_SCHEDULE_TOOL_NAME = 'fish_schedule'

const SUCCESS_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', const: true },
    action: { type: 'string' },
  },
  required: ['ok'],
}

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', const: false },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['code', 'message'],
    },
  },
  required: ['ok', 'error'],
}

export function renderFishScheduleResult(value) {
  if (!value || value.ok !== true) {
    const error = value && value.error ? value.error : { code: 'INTERNAL', message: '日程操作失败' }
    return `日程操作失败 [${error.code}] ${error.message}`
  }
  if (value.action === 'list') {
    const items = Array.isArray(value.items) ? value.items : []
    if (items.length === 0) return '还没有日程。'
    return `共 ${items.length} 条日程：` + items.map((item) => `${item.title}(${item.recurrence}, next=${item.nextFireAt || '—'})`).join('；')
  }
  if (value.action === 'create') return `已创建日程「${value.item?.title || ''}」。`
  if (value.action === 'update') return `已更新日程「${value.item?.title || ''}」。`
  if (value.action === 'delete') return `已删除日程 ${value.id || ''}。`
  if (value.action === 'enable') return `已启用日程「${value.item?.title || ''}」。`
  if (value.action === 'disable') return `已关闭日程「${value.item?.title || ''}」。`
  return '日程操作完成。'
}

/**
 * @param {{ run: (args: unknown) => Promise<Record<string, unknown>> }} service
 */
export function createFishScheduleTool(service) {
  return {
    name: FISH_SCHEDULE_TOOL_NAME,
    description:
      '大肥鱼内部日程（fish_schedule）：创建与维护到点会话提醒。' +
      'action=create/list/update/delete/enable/disable。' +
      '到点只会往面板会话注入旁白（不是主人命令），是否行动由你自己决定；禁止伪造主人口吻。' +
      'once 的 at 可为 YYYY-MM-DDTHH:mm（按 timezone 墙钟）或 ISO；daily/weekly 的 at 为 HH:mm；' +
      'weekly 必填 daysOfWeek（0=周日…6=周六）。不要使用 DSH 的 schedule_* 工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'delete', 'enable', 'disable'],
        },
        title: { type: 'string' },
        prompt: { type: 'string' },
        recurrence: { type: 'string', enum: ['once', 'daily', 'weekly'] },
        at: { type: 'string', description: 'once: 本地 YYYY-MM-DDTHH:mm 或 ISO；daily/weekly: HH:mm' },
        timezone: { type: 'string' },
        daysOfWeek: { type: 'array', items: { type: 'integer' } },
        id: { type: 'string' },
        version: { type: 'integer' },
        enabledOnly: { type: 'boolean' },
      },
      required: ['action'],
    },
    output: {
      schema: { oneOf: [SUCCESS_SCHEMA, ERROR_SCHEMA] },
      render: (_args, value) => [{ type: 'text', text: renderFishScheduleResult(value) }],
    },
    async execute(args) {
      try {
        return await service.run(args)
      } catch (error) {
        return { ok: false, error: toPublicError(error) }
      }
    },
  }
}

/** 把 createScheduleService 包成 tool.run */
export function bindScheduleToolRunner(schedule) {
  return {
    async run(args) {
      const action = args && args.action
      if (action === 'create') return schedule.create(args)
      if (action === 'list') return schedule.list({ enabledOnly: Boolean(args.enabledOnly) })
      if (action === 'update') return schedule.update(args)
      if (action === 'delete') return schedule.delete(args.id)
      if (action === 'enable') return schedule.enable(args.id, args.version)
      if (action === 'disable') return schedule.disable(args.id, args.version)
      const { scheduleError, ERROR_CODES } = await import('./schema.js')
      throw scheduleError(ERROR_CODES.VALIDATION, '未知 action')
    },
  }
}
