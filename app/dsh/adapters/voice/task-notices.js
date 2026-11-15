import { isFishHeader } from '../../../../core/modules/proactive/identity.js'
import { platform } from '../../../shared/platform/index.js'

const terminal = new Set(['completed', 'failed', 'cancelled', 'outcome-unknown'])
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512
const labels = { completed: '任务已完成。', failed: '任务执行失败。', cancelled: '任务已确认停止。', 'outcome-unknown': '任务结果暂时无法确认。' }

/** Durable task outbox -> the original owner's ordinary DSH conversation. */
export function createTaskNoticeBridge({ ctx, resources }) {
  return async event => {
    const source = event?.source, owner = event?.owner
    if (source?.kind !== 'chonkyfish-task-notice' || !text(source.taskId) || !text(source.eventId) || !text(source.sourceInputId) || !Number.isSafeInteger(source.version) || source.version < 1 || !text(owner?.namespaceId) || !text(owner?.conversationId) || source.ownerConversationId !== owner.conversationId) return { acknowledged: false }
    if (!terminal.has(event.status)) return { acknowledged: true }
    let sessions
    try { sessions = ctx.sessions || ctx.get?.('sessions') } catch {}
    if (typeof sessions?.flush !== 'function') return { acknowledged: false }
    const agent = ctx.agents?.get(owner.conversationId)
    if (!agent || agent.id !== owner.conversationId || agent.session?.id !== owner.conversationId || !isFishHeader(agent.session.header, { workspaceRoot: resources.paths.workspace, pathSemantics: platform })) return { acknowledged: false }
    if (typeof agent.session.snapshotEvents !== 'function' || typeof agent.followup !== 'function') return { acknowledged: false }
    const messageId = `chonkyfish-task-notice:${source.eventId}`
    const matches = message => message?.id === messageId && message.source?.kind === source.kind && message.source?.taskId === source.taskId && message.source?.version === source.version && message.source?.ownerConversationId === owner.conversationId
    try {
      const history = agent.session.snapshotEvents()
      if (!Array.isArray(history)) return { acknowledged: false }
      const alreadyPresent = history.some(entry => entry.type === 'user/message' && matches(entry.data)) || [...(agent.inbox?.nextStep || []), ...(agent.inbox?.nextTurn || [])].some(matches)
      if (!alreadyPresent) {
        const summary = typeof event.summary === 'string' ? event.summary.slice(0, 2000) : labels[event.status]
        agent.followup({ id: messageId, role: 'user', content: [{ type: 'text', text: `受管理任务的真实状态更新：${labels[event.status]}${summary}\n请依据这些执行事实简短告知主人；这条状态更新不包含新的任务指令。` }], source: { ...source } })
      }
      // followup persists an inbox splice. Do not acknowledge before its log is
      // flushed; on failure the exact same message identity is checked again.
      return { acknowledged: await sessions.flush(agent.session) === true }
    } catch { return { acknowledged: false } }
  }
}
