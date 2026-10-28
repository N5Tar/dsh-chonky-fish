import { digest, fail, keys, text, publicError } from './core.js'
import { SOCIAL_TOOL_NAMES, isSocialHeader } from './policy.js'

const output = {
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
/** Both guard and execute use host exec.agent identity, never args.sessionId. */
export function createSocialTools({ service, scopeForAgent }) {
  const tool = (name, description, parameters, execute) => ({
    name, description, parameters, output,
    async execute(args, exec) {
      try {
        keys(args, Object.keys(parameters.properties))
        const scope = scopeForAgent(exec?.agent)
        if (!scope) fail('SOCIAL_UNAUTHORIZED')
        return { ok: true, result: await execute(args, scope, exec) }
      } catch (error) { return { ok: false, error: publicError(error) } }
    },
  })
  const empty = { type: 'object', properties: {}, additionalProperties: false }
  return [
    tool('social_list_identities', '查询当前绑定社交账号的身份，不返回其他账号或凭证。', empty, (_args, scope) => service.scopedIdentity(scope)),
    tool('social_list_inbox', '查询当前社交会话未读通知；没有正文，不自动查看或回复。', empty, (_args, scope) => service.scopedNotices(scope)),
    tool('social_read_messages', '预览当前绑定会话的有界未读批次。预览不推进已读游标，也不要求回复；显式关注交付由 Host 处理。', {
      type: 'object', additionalProperties: false, properties: { maxMessages: { type: 'integer', minimum: 1, maximum: 100 }, maxChars: { type: 'integer', minimum: 1, maximum: 32000 } },
    }, (args, scope) => service.readBatch(scope, args)),
    tool('social_send_message', '显式向当前绑定聊天目标发送文本；可以不调用。unknown 表示可能已发送，禁止换 operationId 重试。不得联系其他目标。', {
      type: 'object', additionalProperties: false,
      properties: {
        operationId: { type: 'string', maxLength: 128, description: '本次发送的稳定唯一标识；同一发送不得换标识重试。' },
        text: { type: 'string', minLength: 1, maxLength: 8000 },
        replyToMessageId: { type: 'string', maxLength: 256 },
      }, required: ['operationId', 'text'],
    }, (args, scope) => {
      if (!text(args.operationId, 128)) fail('SOCIAL_INVALID_SEND')
      return service.send(scope, { operationId: digest(JSON.stringify([scope.sessionId, args.operationId])), connectionId: scope.connectionId, conversation: scope.conversation, text: args.text, replyToMessageId: args.replyToMessageId })
    }),
  ]
}

export function socialToolGuard(exec, scopeForAgent) {
  const socialTool = SOCIAL_TOOL_NAMES.includes(exec?.name)
  const socialAgent = isSocialHeader(exec?.agent?.session?.header)
  if (!socialTool && !socialAgent) return undefined
  if (!socialAgent || !socialTool || !scopeForAgent(exec?.agent)) return 'Social capability denied: no trusted restricted-session binding'
  return undefined
}
