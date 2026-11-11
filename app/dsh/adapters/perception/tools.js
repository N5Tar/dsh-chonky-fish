import { platform } from '../../../shared/platform/index.js'
import { isFishHeader } from '../../../../core/modules/proactive/identity.js'

const labels = { development: '工作', browser: '浏览器活动', communication: '沟通', mixed: '混合活动', unknown: '未知' }
const notes = {
  not_enabled: '主人感知未开启。没有当前主人状态；本工具不会自动开启采集。',
  paused: '主人感知已暂停，没有可用的当前预测。',
  initializing: '感知模块正在初始化，请稍后再查询。',
  starting: '采集正在启动，尚无有效预测。',
  insufficient_data: '观察不足，暂不能判断主人状态。',
  stale: '感知数据已过期，不能用历史预测代表当前状态。',
  unsupported: '当前设备不支持主人感知。',
  unavailable: '感知模块已卸载或不可用。',
  error: '感知模块异常，当前状态不可用。',
  ready: '这是应用活动线索的预测，不等于主人实际任务、忙碌程度或是否允许打扰。无输入不等于离开。',
}

/** Read-only, on-demand snapshot. No start, analysis, HTTP, history, or model call. */
export function createPerceptionTool({ resources, getService, getFailure = () => null, isClosed = () => false }) {
  const isOwnerAgent = agent => isFishHeader(agent?.session?.header, { workspaceRoot: resources.paths.workspace, pathSemantics: platform })
  const result = (status, collectionState = null, extra = {}) => ({
    ok: true, status, collectionState, prediction: null, message: notes[status], ...extra,
  })
  const tool = {
    name: 'perception_get_owner_state',
    description: '只读查询主人当前感知状态（工作、浏览器活动、沟通、混合或未知）。未开启时明确返回未开启；暂停、过期或观察不足时不返回旧预测。不会自动开启采集，不读取屏幕、应用明细或历史，也不代表主人允许被打扰。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!isOwnerAgent(exec?.agent)) return { ok: false, error: { code: 'PERCEPTION_OWNER_SESSION_REQUIRED', message: '仅供大肥鱼的主人会话查询。' } }
      if (args != null && (typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)) return { ok: false, error: { code: 'PERCEPTION_INVALID_ARGUMENTS', message: '此工具不接受参数。' } }
      if (isClosed()) return result('unavailable', 'disposed')
      if (resources.getConfig().perception.enabled === false) return result('not_enabled', 'disabled')
      const service = getService()
      if (!service) return result(getFailure() ? 'error' : 'initializing')
      try {
        const status = service.getStatus(), state = status.state
        if (status.enabled === false) return result('not_enabled', 'disabled')
        if (state === 'stopped') return result('not_enabled', state)
        if (state === 'paused') return result('paused', state)
        if (state === 'disposed') return result('unavailable', state)
        if (state === 'unsupported' || status.capabilities?.supported === false) return result('unsupported', state)
        if (state === 'error' || status.error) return result('error', state)
        if (state === 'starting' || state === 'stopping') return result('starting', state)
        if (state !== 'running') return result('stale', state)
        const current = service.getCurrent(), data = current.data
        if (!current.freshness?.isFresh) return result(data ? 'stale' : 'insufficient_data', state)
        if (!data || data.evidence?.includes('insufficient_coverage')) return result('insufficient_data', state)
        return result('ready', state, {
          prediction: {
            activity: data.activity === 'development' ? 'work' : data.activity,
            label: labels[data.activity] || '未知',
            interaction: data.interaction,
            confidence: data.confidence,
            continuity: data.continuity,
            analyzedAt: data.analyzedAt,
            sourceThrough: data.sourceThrough,
          },
        })
      } catch {
        return result('error')
      }
    },
  }
  // Disabled collection must not hide the tool: callers need the explicit not_enabled result.
  return { tool, when: context => !isClosed() && isOwnerAgent(context?.agent) }
}
