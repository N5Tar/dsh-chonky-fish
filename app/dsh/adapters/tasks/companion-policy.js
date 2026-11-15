import { discoverPollingRequestProtocols, isKnownPhoneReadTool } from './protocols.js'

// These are capabilities, not substrings searched for in executable text. Unknown
// tools fail closed: an encoded script, script file or new desktop MCP cannot
// regain process/desktop access by changing its spelling or arguments.
const SAFE_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'todo_write', 'job_list',
  'fish_task_list', 'fish_task_inspect', 'fish_task_cancel',
  'fish_skill', 'diary', 'perception_get_owner_state',
])
const NATIVE_ACTIONS = new Set([
  'stardew_session_start', 'stardew_session_cancel',
  'stardew_farm_task', 'stardew_cancel_task',
  'stardew_tool_task', 'stardew_cancel_tool_task',
  'stardew_travel_task', 'stardew_travel_cancel', 'stardew_self_move_to',
  'stardew_self_use_tool', 'stardew_self_interact', 'stardew_menu_action',
  'stardew_fishing_task', 'stardew_fishing_cancel',
  'stardew_social_action', 'stardew_shop_buy', 'stardew_shop_sell', 'stardew_shop_cancel',
  'stardew_sleep',
])
const MANAGED_STARTS = new Set(['stardew_session_start', 'stardew_farm_task', 'stardew_tool_task', 'stardew_travel_task'])
const REQUIRED_PROTOCOLS = ['stardew-native-session-v1', 'stardew-native-tool-v1', 'stardew-native-travel-v1']
const DENIAL = 'Native Stardew companionship is protected: use the stardew2 原生 MCP tools (or fish_task_start with a supported native lifecycle). Arbitrary code, shell, arbitrary file writes, desktop input and other action tools are unavailable in this companion conversation; never activate a game window or synthesize OS input.'
const PROMPT = '\n\n### 原生联机陪玩与主人输入隔离\n\n'
  + '此主人会话配置了 stardew2 原生联机陪玩能力，Host 对本会话及其子代理执行能力隔离。主人持续操作自己的 stardew 主机；AI 只通过 stardew2 的原生 MCP 操作独立客户端，stardew 仅可读取状态。不要激活、恢复或切换窗口，不发送系统键盘、鼠标或手柄输入。失焦不能推进时说明缺口，不抢前台。\n'
  + '此陪玩会话中的 shell、任意代码、终端、任意文件写入、桌面控制和未登记动作工具不可用；即使是不含游戏名的脚本、后台任务或子代理也不能绕过。保留原生游戏工具、受支持的 fish_task 原生任务及只读查询。客户端会话只允许 join_lan 加入主人已打开的联机主机。通用命令工作使用未配置原生陪玩的独立会话。原生工具返回已接收不代表完成，继续依据真实任务回执核对。'

function nativeAction(name) {
  return typeof name === 'string' && name.startsWith('mcp__stardew2__') && NATIVE_ACTIONS.has(name.slice('mcp__stardew2__'.length))
}
function allowedNativeAction(name, args) {
  return nativeAction(name) && (name !== 'mcp__stardew2__stardew_session_start' || args?.mode === 'join_lan')
}
function configured(definitions) {
  const protocols = discoverPollingRequestProtocols(definitions).filter(item => item.serverName === 'stardew2')
  return REQUIRED_PROTOCOLS.every(id => protocols.some(item => item.id === id))
}
function previouslyUsedNativeTools(agent) {
  // Session events are Host-owned. This also closes the restart/reconnect gap
  // before MCP schemas have arrived for a previously used companion session.
  let events
  try { events = agent?.session?.snapshotEvents?.() } catch { return false }
  if (!Array.isArray(events)) return false
  const companionCall = block => {
    if (block?.type !== 'tool-call' && block?.type !== 'tool_call') return false
    if (nativeAction(block.name) || isKnownPhoneReadTool(block.name) && block.name.startsWith('mcp__stardew2__')) return true
    if (block.name !== 'fish_task_start') return false
    try {
      const args = typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments
      return nativeAction(args?.toolName)
    } catch { return false }
  }
  return events.some(event => {
    const data = event?.data ?? event
    if (event?.type !== 'assistant/message' && data?.type !== 'assistant/message') return false
    return [data.message?.content, data.message?.toolCalls, data.content, data.toolCalls].some(blocks => Array.isArray(blocks) && blocks.some(companionCall))
  })
}

/** Independent execution boundary; task adapter trust never exempts this guard. */
export function createNativeCompanionPolicy({ agents, isOwnerAgent, definitionsFor, getSessionHeader, protectNativeCompanion = false }) {
  const protectedAgents = new WeakSet()
  const protectedConversations = new Set()
  const lineage = new WeakMap()
  const storedAgents = new Map()
  const headerReads = new Map()
  const conversationId = agent => agent?.session?.sessionId ?? agent?.session?.id ?? agent?.id
  const parentFor = agent => {
    const id = agent?.session?.header?.parentSession
    return typeof id === 'string' ? agents?.get?.(id) ?? storedAgents.get(id) : null
  }
  function nativeConfigured(agent) {
    // A resumed custom-preset child may have no inherited scoped definitions;
    // the exact companion family can still be registered at the Host root.
    for (const candidate of [agent, undefined]) {
      try { if (configured(definitionsFor(candidate) ?? [])) return true } catch {}
    }
    return false
  }
  function remember(agent) {
    protectedAgents.add(agent)
    const id = conversationId(agent)
    if (typeof id === 'string' && id) protectedConversations.add(id)
  }
  function ownerFor(agent, seen = new Set()) {
    if (!agent || seen.has(agent)) return null
    if (lineage.has(agent)) return lineage.get(agent)
    seen.add(agent)
    let candidates = []
    try { candidates = agents?.list?.() ?? [] } catch {}
    for (const candidate of candidates) {
      let owned = false
      try { owned = agents?.isOwnedBy?.(agent.id, candidate) === true } catch {}
      if (!owned) continue
      const owner = ownerFor(candidate, seen)
      if (owner) { lineage.set(agent, owner); return owner }
    }
    // Resumed subagents can be runtime roots; DSH's durable parentSession is
    // separate from its exact live isOwnedBy relation.
    const owner = ownerFor(parentFor(agent), seen)
    if (owner) { lineage.set(agent, owner); return owner }
    // A child may inherit the owner's preset but have no MCP schemas in its own
    // scope. Resolve actual ancestry before treating that preset as a new root.
    return isOwnerAgent(agent) ? agent : null
  }
  function ancestryUnresolved(agent, seen = new Set()) {
    if (!agent) return false
    if (seen.has(agent)) return true
    seen.add(agent)
    const id = agent.session?.header?.parentSession
    if (typeof id !== 'string') return false
    const parent = parentFor(agent)
    return !parent || ancestryUnresolved(parent, seen)
  }
  async function hydrateAncestry(agent, seen = new Set()) {
    const id = agent?.session?.header?.parentSession
    if (typeof id !== 'string' || seen.has(id)) return
    seen.add(id)
    let parent = parentFor(agent)
    if (!parent && typeof getSessionHeader === 'function') {
      let read = headerReads.get(id)
      if (!read) {
        read = Promise.resolve().then(() => getSessionHeader(id)).then(header => {
          if (header) storedAgents.set(id, { id, session: { id, header } })
        }).catch(() => {}).finally(() => headerReads.delete(id))
        headerReads.set(id, read)
      }
      await read
      parent = parentFor(agent)
    }
    if (parent) await hydrateAncestry(parent, seen)
  }
  function isProtected(agent) {
    if (!agent || typeof agent !== 'object') return false
    if (protectedAgents.has(agent) || protectedConversations.has(conversationId(agent))) return true
    const owner = ownerFor(agent)
    // Do not permanently latch an unrelated child while its cold metadata is
    // loading. Only unsafe capabilities are withheld until lineage is known.
    if (!owner) return ancestryUnresolved(agent) && (protectNativeCompanion || nativeConfigured(agent))
    let active = protectNativeCompanion || protectedAgents.has(owner) || protectedConversations.has(conversationId(owner)) || previouslyUsedNativeTools(owner)
    if (!active) {
      active = nativeConfigured(owner)
    }
    if (!active) return false
    // A transient MCP disconnect or parent teardown must not reopen shell access.
    remember(owner)
    remember(agent)
    return true
  }
  return {
    async observeAgent(agent) { await hydrateAncestry(agent); isProtected(agent) },
    guard(exec) {
      if (!isProtected(exec.agent)) return undefined
      if (SAFE_TOOLS.has(exec.name) || isKnownPhoneReadTool(exec.name) || allowedNativeAction(exec.name, exec.arguments)) return undefined
      if (exec.name === 'job_output' && exec.arguments?.wait === false) return undefined
      if (exec.name === 'fish_task_start') {
        const args = exec.arguments
        const prefix = 'mcp__stardew2__'
        if ((!args?.adapter || args.adapter === 'mcp-polling') && typeof args?.toolName === 'string'
          && args.toolName.startsWith(prefix) && MANAGED_STARTS.has(args.toolName.slice(prefix.length))
          && allowedNativeAction(args.toolName, args.arguments)) return undefined
      }
      return DENIAL
    },
    prompt(context = {}) { return isProtected(context.agent ?? context.scope) ? PROMPT : '' },
  }
}
