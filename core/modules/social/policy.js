import { conversation, fail, sessionKey, text } from './core.js'

import { SOCIAL } from '../../contracts/spec.js'
export const SOCIAL_PRESET = SOCIAL.preset
export const SOCIAL_TOOL_NAMES = Object.freeze(['social_list_identities', 'social_list_inbox', 'social_read_messages', 'social_send_message'])
export function isSocialHeader(header) { return header?.agentPreset === SOCIAL_PRESET || header?.source?.kind === 'social' }
/** Host-assigned message identity only; never a visible source label or model prompt. */
export function isChannelUserMessage(message) { return /^social-[a-f0-9]{64}$/.test(message?.id ?? '') || message?.source?.kind === 'chonkyfish-social' }
/** Conversational input is the owner typing or one channel delivery. DSH also injects
 * runtime-context/time-context as user-role messages, which are not extra requests. */
export function isConversationalUserMessage(message) {
  // DSH GUI prompts can use user-rpc. Unknown user-role input is not safe to
  // silently mix into an externally routed reply; exempt only known context.
  return message?.role === 'user' && !['runtime-context', 'time-context'].includes(message?.source?.kind)
}

/** 连接配置好就接收它的消息：只做来源校验，过滤自身回声和机器人。 */
export function acceptMessage(config, identity, message, maxChars = 32000) {
  if (message.connectionId !== config.id || message.platform !== config.platform || message.provider !== config.provider) fail('SOCIAL_MESSAGE_SOURCE_MISMATCH')
  if (message.self?.protocolUserId !== identity.protocolUserId) fail('SOCIAL_EVENT_IDENTITY_MISMATCH')
  if (!text(message.messageId) || !text(message.sender?.id) || !text(message.text, maxChars)) return false
  if (message.sender.id === identity.protocolUserId || message.sender.isBot === true) return false
  conversation(message.conversation)
  return true
}

/** Scope objects are host-created capabilities, not caller-supplied JSON. */
export function createScopeAuthority() {
  const scopes = new WeakSet()
  return {
    issue({ sessionId, platform, connectionId, conversation: target, identityRevision }) {
      if (!text(sessionId) || !text(identityRevision)) fail('SOCIAL_SCOPE_INVALID')
      const scope = Object.freeze({ sessionId, connectionId, identityRevision, sessionKey: sessionKey(platform, connectionId, target), conversation: Object.freeze(conversation(target)) })
      scopes.add(scope)
      return scope
    },
    check(scope) { if (!scope || !scopes.has(scope)) fail('SOCIAL_TARGET_UNBOUND'); return scope },
    revoke(scope) { scopes.delete(scope) },
  }
}
