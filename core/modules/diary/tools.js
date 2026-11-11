/**
 * 大肥鱼 · 日记模块（Host 侧）· 单工具 `diary`。
 *
 * 一个工具、三种能力（action）：
 *   - write：写某一天的日记（默认不覆盖）；
 *   - read：读某一天的日记；
 *   - list：列出已有日记日期。
 *
 * 这里刻意**不 import @deepseek-ai/dsh-tools**：第三方插件从工作区解析不到
 * 该包；`ctx.tools.register()` 接受的就是下面这个普通对象（name / description /
 * parameters / output.schema / output.render / execute），和官方 defineTool
 * 编译后的结构一致。
 */
import { toPublicError } from './errors.js'

/** 工具名（全局注册；非启用 preset 会被 restrict 隐藏）。 */
export const DIARY_TOOL_NAME = 'diary'

const SUCCESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', const: true },
    action: { type: 'string', enum: ['write', 'read', 'list'] },
    date: { type: 'string' },
    status: { type: 'string', enum: ['created', 'updated'] },
    content: { type: 'string' },
    dates: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'action'],
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

/** 结果 → 模型可见的文本（read 必须把正文带出去，list 带日期）。 */
export function renderDiaryResult(value) {
  if (!value || value.ok !== true) {
    const error = value && value.error ? value.error : { code: 'DIARY_STORAGE_ERROR', message: '日记操作失败' }
    return `日记操作失败 [${error.code}] ${error.message}`
  }
  if (value.action === 'write') {
    const verb = value.status === 'updated' ? '已更新' : '已写入'
    return `${verb} ${value.date} 的日记。`
  }
  if (value.action === 'read') {
    return `日记 ${value.date}：\n${value.content}`
  }
  if (value.action === 'list') {
    const dates = Array.isArray(value.dates) ? value.dates : []
    if (dates.length === 0) return '还没有写过日记。'
    return `已有日记（最近 ${dates.length} 条）：${dates.join('、')}`
  }
  return '日记操作完成。'
}

/**
 * @param {{ run: (args: unknown) => Promise<Record<string, unknown>> }} service
 */
export function createDiaryTool(service) {
  return {
    name: DIARY_TOOL_NAME,
    description:
      '大肥鱼日记：一个工具三种能力——action="write" 写某一天的日记（正文由你自己写，默认不覆盖已有日记）；' +
      'action="read" 读某一天的日记；action="list" 列出已有日记日期。日期格式 YYYY-MM-DD。' +
      '写日记的时间由你自己安排：想每天写，可以用 schedule_create 给自己排一个每日提醒。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'read', 'list'],
          description: '要做的日记操作：write / read / list',
        },
        date: {
          type: 'string',
          description: 'YYYY-MM-DD；write 和 read 必填。',
        },
        content: {
          type: 'string',
          description: '日记正文，Markdown 原样保存；write 必填。',
        },
        overwrite: {
          type: 'boolean',
          description: 'write 时是否覆盖已有日记；默认 false（仅创建）。',
        },
        limit: {
          type: 'integer',
          description: 'list 返回的最大条数，1–365，默认 30。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { oneOf: [SUCCESS_SCHEMA, ERROR_SCHEMA] },
      render: (_args, value) => [{ type: 'text', text: renderDiaryResult(value) }],
    },
    async execute(args) {
      try {
        return await service.run(args)
      } catch (error) {
        // 结构化失败：Tool 调用本身成功，模型能看到错误码并自行修正。
        return { ok: false, error: toPublicError(error) }
      }
    },
  }
}
