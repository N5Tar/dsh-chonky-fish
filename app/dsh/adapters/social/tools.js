import { digest, fail, keys, text, publicError } from '../../../../core/modules/social/core.js'

const output = {
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
/** One model-facing capability: the fish may initiate a message to the owner's own
 * DingTalk direct chat. Targets and transports stay private inside the Host. */
export function createOwnerSendTool({ service }) {
  return {
    name: 'social_send_owner_message',
    description: '通过钉钉单聊主动给主人发一条文本消息。只在确实需要主动提醒或告知主人时使用；不要用它代替对当前对话的正常回复。发送结果 unknown 表示可能已送达，禁止换 operationId 重试。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        operationId: { type: 'string', minLength: 1, maxLength: 128, description: '本次主动发送的稳定唯一标识；同一发送不得换标识重试。' },
        text: { type: 'string', minLength: 1, maxLength: 8000 },
      },
      required: ['operationId', 'text'],
    },
    output,
    async execute(args) {
      try {
        keys(args, ['operationId', 'text'])
        if (!text(args.operationId, 128) || !text(args.text, 8000)) fail('SOCIAL_INVALID_SEND')
        const result = await service.sendOwner({ operationId: args.operationId, text: args.text })
        return { ok: result.status === 'accepted', status: result.status, ...(result.errorCode ? { error: result.errorCode } : {}) }
      } catch (error) { return { ok: false, error: publicError(error) } }
    },
  }
}

/** Resolve the current target from host exec.agent identity, never args.sessionId. */
export function createSocialTools({ service, scopeForAgent }) {
  const tool = (name, description, parameters, execute) => ({
    name, description, parameters, output,
    async execute(args, exec) {
      try {
        keys(args, Object.keys(parameters.properties))
        const scope = scopeForAgent(exec?.agent)
        if (!scope) fail('SOCIAL_TARGET_UNBOUND')
        return { ok: true, result: await execute(args, scope, exec) }
      } catch (error) { return { ok: false, error: publicError(error) } }
    },
  })
  const empty = { type: 'object', properties: {}, additionalProperties: false }
  return [
    tool('social_list_identities', '查询当前外部消息批次所用社交账号的身份，不返回凭证。', empty, (_args, scope) => service.scopedIdentity(scope)),
    tool('social_list_inbox', '查询当前外部消息来源的未投递通知，不返回正文。', empty, (_args, scope) => service.scopedNotices(scope)),
    tool('social_read_messages', '预览当前来源尚未投递的消息；不推进游标。已投递内容见主会话中的外部消息批次。', {
      type: 'object', additionalProperties: false, properties: { maxMessages: { type: 'integer', minimum: 1, maximum: 100 }, maxChars: { type: 'integer', minimum: 1, maximum: 32000 } },
    }, (args, scope) => service.readBatch(scope, args)),
    tool('social_send_message', '向当前外部批次的原会话发送文本；可不回复。unknown 表示可能已发送，禁止换 operationId 重试。不能换目标或发送主会话隐私。', {
      type: 'object', additionalProperties: false,
      properties: {
        operationId: { type: 'string', maxLength: 128, description: '本次发送的稳定唯一标识；同一发送不得换标识重试。' },
        text: { type: 'string', minLength: 1, maxLength: 8000 },
        replyToMessageId: { type: 'string', maxLength: 256 },
      }, required: ['operationId', 'text'],
    }, (args, scope) => {
      if (!text(args.operationId, 128)) fail('SOCIAL_INVALID_SEND')
      return service.send(scope, { operationId: digest(JSON.stringify([scope.sessionId, scope.sessionKey, scope.identityRevision, args.operationId])), connectionId: scope.connectionId, conversation: scope.conversation, text: args.text, replyToMessageId: args.replyToMessageId })
    }),
  ]
}
