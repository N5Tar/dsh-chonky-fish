/**
 * 大肥鱼主动消息 · 会话身份判定（Host 侧）。
 *
 * 与模块 0 事件引擎保持同一条铁律：**联合判断**，鱼鱼会话 =（项目, preset）配对。
 *
 *     cwd 落在鱼鱼工作区之内   且   header.agentPreset === 'chonkyfish'
 *     且不是 subagent 子会话
 *
 * 工作区根只认资源管理模块给出的那一个（`$DSH_HOME/chonkyfish/小鱼塘`），
 * 不做旧目录兼容。
 *
 * 判定规则必须和 src/event-engine/engine.js 里的 isFishSession 保持一致。
 */
import { resolve, sep } from 'node:path'

import { PRESET } from '../resources/spec.js'

/** 鱼鱼会话的 preset 半边，来自资源规格（单一事实源）。 */
export const FISH_PRESET = PRESET

/**
 * 会话 header 是否属于鱼鱼对话。
 * @param {any} header - SessionHeader（cwd / agentPreset / origin / delegationDepth）
 * @param {{ workspaceRoot: string, preset?: string }} options
 * @returns {boolean}
 */
export function isFishHeader(header, { workspaceRoot, preset = FISH_PRESET } = {}) {
  if (!header || typeof header !== 'object') return false
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) return false
  // 鱼鱼派出去干活的孩子不是和主人的对话（它们继承父会话的 cwd）
  if (header.origin === 'subagent') return false
  if (Number(header.delegationDepth ?? 0) > 0) return false
  if (header.agentPreset !== preset) return false
  const cwd = typeof header.cwd === 'string' ? resolve(header.cwd) : ''
  if (cwd === '') return false
  const base = resolve(workspaceRoot)
  return cwd === base || cwd.startsWith(base + sep)
}

/**
 * 会话对象（含 header 属性）是否属于鱼鱼对话。
 * @param {any} session
 * @param {{ workspaceRoot: string, preset?: string }} options
 * @returns {boolean}
 */
export function isFishSession(session, options) {
  return Boolean(session && isFishHeader(session.header, options))
}
