/**
 * 大肥鱼模块 0 · 事件类型词表 V1（版本化注册表，单一事实源）。
 *
 * V1 收窄后的范围（相对《模块0 V1 技术详细设计》§4）：
 *   - 只收「语言事件」：来源只有 user_message / assistant_message。
 *   - 不产出确定性工具事件（决策：不做 page_opened / tool_action_verified）。
 *     因此 evidenceStatus 里没有 attempted / tool_verified / system_observed，
 *     也没有 external_notice / system_observation 两种来源。
 *   - 模型只能从下面的登记表里挑 type；未登记一律拒绝（见 validate.js）。
 *
 * 语义一律取极窄含义：只表达「说了 / 打算 / 假设 / 否认」，不提升为客观事实。
 */

export const SCHEMA_VERSION = '1.0'
export const EVENT_REGISTRY_VERSION = '1.0'
/** 提示词/规则版本，进 dedupeKey，换版本即视为可重新提取。 */
export const RULE_VERSION = 'v1'

export const CATEGORIES = Object.freeze([
  'interaction',
  'preference',
  'activity',
  'environment',
  'state',
  'goal',
])

export const POLARITIES = Object.freeze(['positive', 'negative', 'neutral', 'mixed'])

/** 语言形态（模型给），不是事实可信度。 */
export const MODALITIES = Object.freeze([
  'asserted',
  'intended',
  'hypothetical',
  'negated',
  'uncertain',
])

/** 程序最终裁定的事实地位。V1 只由 modality + 来源种类推导。 */
export const EVIDENCE_STATUSES = Object.freeze([
  'reported',
  'intent',
  'hypothetical',
  'negated',
  'uncertain',
])

export const TARGET_KINDS = Object.freeze([
  'object',
  'content',
  'person',
  'activity',
  'state',
  'other',
])

export const ALL_MODALITIES = MODALITIES
export const ALL_POLARITIES = POLARITIES

/**
 * type → 契约。
 *   action            canonical verb，程序写死，模型给的话必须一致
 *   description       给提示词用的语义边界说明
 *   polarities        该类型允许的 polarity 集合
 *   modalities        该类型允许的语言形态集合（默认全部）
 *   targetRequired    是否必须带 target
 */
export const EVENT_TYPES = Object.freeze({
  'interaction.compliment_expressed': {
    action: 'express_compliment',
    description: '对某对象/行为表达称赞或欣赏（只是表达，不推断关系提升）。',
    polarities: ['positive', 'mixed'],
    targetRequired: true,
  },
  'interaction.invitation_expressed': {
    action: 'express_invitation',
    description: '发出邀请、约时间或提出一起做某事（必须带对象：做什么/去哪/一起做什么）。',
    polarities: ['positive', 'neutral', 'mixed'],
    targetRequired: true,
  },
  'interaction.thanks_expressed': {
    action: 'express_thanks',
    description: '表达感谢（必须带对象：谢什么/谢谁）。',
    polarities: ['positive'],
    targetRequired: true,
  },
  'preference.like_expressed': {
    action: 'express_like',
    description: '表达喜欢/偏好某对象。只记录表达，不改兴趣权重。',
    polarities: ['positive', 'mixed'],
    targetRequired: true,
  },
  'preference.dislike_expressed': {
    action: 'express_dislike',
    description: '表达不喜欢/反感某对象。只记录表达，不改兴趣权重。',
    polarities: ['negative', 'mixed'],
    targetRequired: true,
  },
  'preference.content_feedback_expressed': {
    action: 'evaluate_content',
    description: '对某个内容（视频/文章/作品等）给出评价。',
    polarities: ['positive', 'negative', 'neutral', 'mixed'],
    targetRequired: true,
  },
  'activity.activity_reported': {
    action: 'report_activity',
    description: '陈述自己做过/正在做某活动，例如「我昨天看了视频」。仅为自述，不是工具验证事实。',
    polarities: ['positive', 'negative', 'neutral', 'mixed'],
    targetRequired: false,
  },
  'environment.content_update_reported': {
    action: 'report_content_update',
    description: '报告外部内容有更新，例如「B 站那个 UP 主更新了」。来源是转述，不是宿主观测。',
    polarities: ['neutral', 'positive', 'mixed'],
    targetRequired: true,
  },
  'state.self_state_expressed': {
    action: 'express_self_state',
    description:
      '表达自身状态（疲惫/情绪/是否方便等主观陈述）。target 填那个状态本身，例如「累」「开心」「没空」；不是系统观测。',
    polarities: ['positive', 'negative', 'neutral', 'mixed'],
    targetRequired: false,
  },
  'goal.intention_expressed': {
    action: 'express_intention',
    description: '表达想要做某事的意图，例如「明天想看 B 站」。意图不代表已执行。',
    polarities: ['positive', 'neutral', 'mixed'],
    targetRequired: true,
    modalities: ['asserted', 'intended', 'hypothetical', 'uncertain'],
  },
  'goal.plan_expressed': {
    action: 'express_plan',
    description: '描述一个具体计划或安排。计划不代表已执行。',
    polarities: ['positive', 'neutral', 'mixed'],
    targetRequired: true,
  },
  'goal.goal_cancelled': {
    action: 'cancel_goal',
    description: '明确取消/放弃之前说过的目标。',
    polarities: ['negative', 'neutral'],
    targetRequired: true,
    modalities: ['asserted'],
  },
})

/** 按 category 分组的 type 列表，便于提示词只喂相关子集。 */
export const TYPES_BY_CATEGORY = Object.freeze(
  CATEGORIES.reduce((acc, category) => {
    acc[category] = Object.keys(EVENT_TYPES).filter((type) => type.startsWith(category + '.'))
    return acc
  }, /** @type {Record<string, string[]>} */ ({})),
)

export const ALL_TYPES = Object.freeze(Object.keys(EVENT_TYPES))

/**
 * @param {string} type
 * @returns {boolean}
 */
export function isRegisteredType(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(EVENT_TYPES, type)
}

/**
 * 模型按设计文档 §5.3/§7.3 只给短 type（`like_expressed`）并把 category 分开写，
 * 注册表用全限定名。这里做唯一一次补全，避免两处各自猜。
 * 已经带点号的输入原样返回，交给后面的 category 交叉校验处理。
 * @param {string} category
 * @param {string} type
 * @returns {string | null}
 */
export function qualifyType(category, type) {
  if (typeof type !== 'string' || type.length === 0) return null
  if (type.includes('.')) return type
  if (typeof category !== 'string' || category.length === 0) return null
  return category + '.' + type
}

/**
 * @param {string} type
 * @returns {{ category: string, type: string, action: string, description: string, polarities: readonly string[], modalities: readonly string[], targetRequired: boolean } | null}
 */
export function describeType(type) {
  if (!isRegisteredType(type)) return null
  const contract = EVENT_TYPES[type]
  return {
    category: type.slice(0, type.indexOf('.')),
    type,
    action: contract.action,
    description: contract.description,
    polarities: contract.polarities,
    modalities: contract.modalities ?? ALL_MODALITIES,
    targetRequired: contract.targetRequired,
  }
}
