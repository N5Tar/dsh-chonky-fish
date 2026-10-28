/**
 * ChonkyFish（大肥鱼）· 资源规格（single source of truth）。
 *
 * 这个文件只放**纯数据**，不 import 任何 node 模块：Host 侧
 * （index.js / src/resources/index.js / 事件引擎 / 主动消息）与 client 构建
 * （build.mjs → client.js）共同读取同一份规格，避免两边各写一套常量。
 *
 * 新增/修改 home 布局、文件名、路由、请求体上限、schema 版本、
 * localStorage key、preset 名或素材目录时，**只改这里**，其它模块不许再硬编码。
 */

/** 插件自己的 home 目录名：$DSH_HOME/chonkyfish/ */
export const HOME_DIR = 'chonkyfish'

/** 鱼鱼工作区目录名：$DSH_HOME/chonkyfish/小鱼塘/ */
export const WORKSPACE_DIR = '小鱼塘'

/** agent preset 名：鱼鱼会话 =（cwd 在工作区内, header.agentPreset === 该值） */
export const PRESET = 'chonkyfish'

/**
 * 插件 home 下的固定文件名。
 * events.db 是 SQLite 库；其它都是 UTF-8 JSON（写入一律 2 空格缩进 + 换行）。
 */
export const FILES = Object.freeze({
  config: 'config.json',
  state: 'state.json',
  proactive: 'proactive.json',
  events: 'events.db',
})

/** Host 暴露给面板的本地 HTTP 路由（都按 activation token 鉴权）。 */
export const ROUTES = Object.freeze({
  state: '/chonkyfish/state',
  events: '/chonkyfish/events',
  session: '/chonkyfish/session',
  proactive: '/chonkyfish/proactive',
  config: '/chonkyfish/config',
})

/** 请求体上限（字节）。state 是整份面板状态，其它是小型控制 JSON。 */
export const LIMITS = Object.freeze({
  stateBodyBytes: 1024 * 1024,
  jsonBodyBytes: 16 * 1024,
})

/** 各类落盘 JSON 的 schema 版本；读到不匹配的版本按「恢复默认」处理。 */
export const VERSIONS = Object.freeze({
  config: 1,
  state: 1,
  proactive: 2,
})

/**
 * 浏览器 localStorage key。
 * Host 文件才是事实源，localStorage 只当浏览器缓存。
 */
export const STORAGE_KEYS = Object.freeze({
  panelState: 'chonkyfish-mini-demo-v1',
  session: 'chonkyfish-session-v2',
  workspace: 'chonkyfish-workspace-v1',
})

/** 面板「补充人格设定」的默认文案：等于它就不算用户自定义，不进 system prompt。 */
export const DEFAULT_PANEL_PROMPT =
  '你是一只喜欢吃白饭的蓝色大肥鱼。你有点傲娇，喜欢摸鱼，偶尔嘴硬，但实际上非常关心和你聊天的人。请用轻松可爱、简短自然的中文交流。'

/**
 * system prompt 变量名：预设里的 persona 模板用 `{{chonkyfish_supplement}}`
 * 引用面板补充人格设定，Host 侧注册同名 provider 动态提供文本。
 */
export const PANEL_SUPPLEMENT_VARIABLE = 'chonkyfish_supplement'

/** 素材目录（相对包根）。poses 是立绘表情名。 */
export const ASSETS = Object.freeze({
  avatar: 'avatar',
  poses: Object.freeze(['idle', 'eat', 'think', 'happy', 'blush', 'sleep']),
})

/**
 * 可编辑的默认配置。
 * config.json 缺失/损坏/字段非法时回退到这里；字段范围由
 * src/resources/index.js 的消毒逻辑负责（本文件不写逻辑）。
 */
export const DEFAULT_CONFIG = Object.freeze({
  version: VERSIONS.config,
  proactive: Object.freeze({ enabled: true }),
  eventEngine: Object.freeze({
    enabled: true,
    extractTickMs: 5000,
    extractBatch: 2,
    maxRecordsPerTurn: 400,
  }),
})
