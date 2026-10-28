/**
 * ChonkyFish（大肥鱼）· Host 侧资源管理器。
 *
 * 职责（其它 Host 模块只从这里取路径/路由/限制/配置，不许再硬编码）：
 *   1. 解析 $DSH_HOME，算出插件自己的 home：$DSH_HOME/chonkyfish/；
 *   2. 建 home / 工作区目录、按默认值写 config.json（已存在不动）；
 *   3. 读取/更新可编辑的 config.json（消毒 + 临时文件 + rename 原子写）；
 *   4. 给页面注入 clientState（路径/路由/预设名，**不含 token**）。
 *
 * 设计约束：
 *   - 路径、文件名、路由、上限、版本、存储 key、默认配置全部来自 ./spec.js；
 *   - 不做任何旧目录迁移：插件只认 home 内的固定布局；
 *   - ensureLayout 里任何异常都只 warn，不让 Host 崩；
 *   - 所有写盘都是「临时文件 + rename」，进程被杀不会留下半截 JSON。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  ASSETS,
  DEFAULT_CONFIG,
  DIARY_DIR,
  FILES,
  HOME_DIR,
  LIMITS,
  PRESET,
  ROUTES,
  STORAGE_KEYS,
  VERSIONS,
  WORKSPACE_DIR,
} from './spec.js'

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** logger 是可选的 best-effort：日志自己炸了不管。 */
function warn(logger, message, error) {
  if (!logger || typeof logger.warn !== 'function') return
  try {
    logger.warn(message, error)
  } catch (ignored) {
    /* logging is best effort */
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把任意输入收敛成 [min, max] 内的整数；非法输入回退默认值。
 * 允许数字字符串（手写配置文件常见），其余一律当非法。
 */
function clampInt(value, { min, max, fallback }) {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * 原子写 JSON：同目录临时文件 + rename。
 * 失败时清掉临时文件；错误抛给调用方决定怎么处理。
 */
async function writeJsonAtomic(file, value) {
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
    await rename(temporary, file)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (ignored) {
      /* 临时文件可能都没创建成功 */
    }
    throw error
  }
}

/**
 * IANA 时区是否合法；空字符串表示跟随系统，也允许。
 * Intl 遇到未知时区会抛 RangeError，这里只用来做配置消毒。
 */
function isValidTimeZone(value) {
  if (typeof value !== 'string') return false
  if (value === '') return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch (error) {
    return false
  }
}

/** agent preset 白名单：去重、去空白、只接受非空字符串。 */
function sanitizePresetList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const seen = new Set()
  const presets = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const preset = item.trim()
    if (preset === '' || seen.has(preset)) continue
    seen.add(preset)
    presets.push(preset)
  }
  return presets.length > 0 ? presets : [...fallback]
}

/**
 * 配置消毒：未知字段一律丢弃，非法字段回退默认值。
 * @param {unknown} raw
 * @returns {{ version: number, proactive: { enabled: boolean }, eventEngine: { enabled: boolean, extractTickMs: number, extractBatch: number, maxRecordsPerTurn: number }, diary: { enabled: boolean, enabledPresets: string[], maxContentChars: number, schedule: { enabled: boolean, hour: number, minute: number, timezone: string, catchUp: boolean } } }}
 */
function sanitizeConfig(raw) {
  const source = isPlainObject(raw) ? raw : {}
  const proactive = isPlainObject(source.proactive) ? source.proactive : {}
  const eventEngine = isPlainObject(source.eventEngine) ? source.eventEngine : {}
  const diary = isPlainObject(source.diary) ? source.diary : {}
  const schedule = isPlainObject(diary.schedule) ? diary.schedule : {}
  const defaults = DEFAULT_CONFIG
  return {
    version: VERSIONS.config,
    proactive: {
      enabled: typeof proactive.enabled === 'boolean' ? proactive.enabled : defaults.proactive.enabled,
    },
    eventEngine: {
      enabled: typeof eventEngine.enabled === 'boolean' ? eventEngine.enabled : defaults.eventEngine.enabled,
      extractTickMs: clampInt(eventEngine.extractTickMs, {
        min: 1000,
        max: 60000,
        fallback: defaults.eventEngine.extractTickMs,
      }),
      extractBatch: clampInt(eventEngine.extractBatch, { min: 1, max: 10, fallback: defaults.eventEngine.extractBatch }),
      maxRecordsPerTurn: clampInt(eventEngine.maxRecordsPerTurn, {
        min: 50,
        max: 5000,
        fallback: defaults.eventEngine.maxRecordsPerTurn,
      }),
    },
    diary: {
      enabled: typeof diary.enabled === 'boolean' ? diary.enabled : defaults.diary.enabled,
      enabledPresets: sanitizePresetList(diary.enabledPresets, defaults.diary.enabledPresets),
      maxContentChars: clampInt(diary.maxContentChars, {
        min: 1000,
        max: 200000,
        fallback: defaults.diary.maxContentChars,
      }),
      schedule: {
        enabled: typeof schedule.enabled === 'boolean' ? schedule.enabled : defaults.diary.schedule.enabled,
        hour: clampInt(schedule.hour, { min: 0, max: 23, fallback: defaults.diary.schedule.hour }),
        minute: clampInt(schedule.minute, { min: 0, max: 59, fallback: defaults.diary.schedule.minute }),
        timezone: isValidTimeZone(schedule.timezone) ? schedule.timezone : defaults.diary.schedule.timezone,
        catchUp: typeof schedule.catchUp === 'boolean' ? schedule.catchUp : defaults.diary.schedule.catchUp,
      },
    },
  }
}

/** 顶层浅合并 + proactive/eventEngine/diary 深合并，然后整体消毒。非法 patch 按 {} 处理。 */
function mergeConfig(current, patch) {
  const source = isPlainObject(patch) ? patch : {}
  const proactive = isPlainObject(source.proactive) ? source.proactive : {}
  const eventEngine = isPlainObject(source.eventEngine) ? source.eventEngine : {}
  const diary = isPlainObject(source.diary) ? source.diary : {}
  const schedule = isPlainObject(diary.schedule) ? diary.schedule : {}
  return sanitizeConfig({
    version: VERSIONS.config,
    proactive: { ...current.proactive, ...proactive },
    eventEngine: { ...current.eventEngine, ...eventEngine },
    diary: {
      ...current.diary,
      ...diary,
      schedule: { ...current.diary.schedule, ...schedule },
    },
  })
}

/**
 * dshHome 优先级：显式 homeRoot（测试/嵌入用）> env.DSH_HOME（非空）> ~/.dsh。
 * 保持传入值原样，不强行 resolve（相对路径由 path.join 语义处理）。
 */
function resolveDshHome(env, homeRoot) {
  if (typeof homeRoot === 'string' && homeRoot.trim() !== '') return homeRoot
  const fromEnv = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME : ''
  if (fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/* ------------------------------------------------------------------ */
/* 资源管理器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 创建 Host 侧资源管理器。纯路径计算，不碰磁盘（ensureLayout 才建）。
 *
 * @param {{ env?: NodeJS.ProcessEnv | Record<string, string | undefined>, homeRoot?: string }} [options]
 * @returns {{
 *   dshHome: string,
 *   home: string,
 *   paths: { home: string, config: string, state: string, proactive: string, events: string, diaryState: string, diary: string, workspace: string },
 *   routes: typeof ROUTES,
 *   limits: typeof LIMITS,
 *   versions: typeof VERSIONS,
 *   spec: { HOME_DIR: string, WORKSPACE_DIR: string, PRESET: string, FILES: typeof FILES, ROUTES: typeof ROUTES, LIMITS: typeof LIMITS, VERSIONS: typeof VERSIONS, STORAGE_KEYS: typeof STORAGE_KEYS, ASSETS: typeof ASSETS, DEFAULT_CONFIG: typeof DEFAULT_CONFIG },
 *   ensureLayout: (options?: { logger?: { warn?: (...args: any[]) => void } }) => Promise<{ home: string, workspace: string }>,
 *   getConfig: () => ReturnType<typeof sanitizeConfig>,
 *   updateConfig: (patch: unknown) => Promise<ReturnType<typeof sanitizeConfig>>,
 *   clientState: () => { home: string, dshHome: string, preset: string, routes: typeof ROUTES, paths: { workspace: string, workspaceParent: string, workspaceName: string } },
 * }}
 */
export function createResources({ env = process.env, homeRoot } = {}) {
  const dshHome = resolveDshHome(env, homeRoot)
  const home = join(dshHome, HOME_DIR)
  const paths = {
    home,
    config: join(home, FILES.config),
    state: join(home, FILES.state),
    proactive: join(home, FILES.proactive),
    events: join(home, FILES.events),
    diaryState: join(home, FILES.diaryState),
    diary: join(home, DIARY_DIR),
    workspace: join(home, WORKSPACE_DIR),
  }

  /** ensureLayout 传进来的 logger 会留给 updateConfig 的写盘失败告警用。 */
  let activeLogger = null

  /** 静态资源规格快照：给 index.js / build 输出统一入口。 */
  const spec = Object.freeze({
    HOME_DIR,
    WORKSPACE_DIR,
    DIARY_DIR,
    PRESET,
    FILES,
    ROUTES,
    LIMITS,
    VERSIONS,
    STORAGE_KEYS,
    ASSETS,
    DEFAULT_CONFIG,
  })

  /** 每次读完都消毒；文件缺失/JSON 坏/字段非法都回退默认，不抛错。 */
  function getConfig() {
    let raw = null
    try {
      raw = JSON.parse(readFileSync(paths.config, 'utf8'))
    } catch (error) {
      raw = null
    }
    return sanitizeConfig(raw)
  }

  /**
   * 合并 patch 后原子落盘，返回合并结果。
   * 非法 patch 不抛错；写盘失败会 warn 后抛出（由调用方转成失败响应）。
   * @param {unknown} patch
   */
  async function updateConfig(patch) {
    const next = mergeConfig(getConfig(), patch)
    try {
      await writeJsonAtomic(paths.config, next)
    } catch (error) {
      warn(activeLogger, '[chonkyfish] config.json 写入失败', error)
      throw error
    }
    return next
  }

  /** config.json 不存在才写默认值；已存在（哪怕是用户手改成半坏）都不动。 */
  async function ensureConfigFile() {
    try {
      readFileSync(paths.config, 'utf8')
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await writeJsonAtomic(paths.config, sanitizeConfig(null))
  }

  /**
   * 启动时准备 home 布局：home 目录、默认 config.json、鱼鱼工作区目录（幂等）。
   * 每一步独立 catch：任何一步失败都只 warn，返回尽力而为的结构。
   *
   * @param {{ logger?: { warn?: (...args: any[]) => void } }} [options]
   * @returns {Promise<{ home: string, workspace: string }>}
   */
  async function ensureLayout({ logger } = {}) {
    if (logger) activeLogger = logger
    try {
      await mkdir(paths.home, { recursive: true })
    } catch (error) {
      warn(logger, '[chonkyfish] 资源 home 目录创建失败', error)
    }
    try {
      await ensureConfigFile()
    } catch (error) {
      warn(logger, '[chonkyfish] 默认 config.json 写入失败', error)
    }
    try {
      await mkdir(paths.workspace, { recursive: true })
    } catch (error) {
      warn(logger, '[chonkyfish] 鱼鱼工作区目录创建失败', error)
    }
    try {
      await mkdir(paths.diary, { recursive: true })
    } catch (error) {
      warn(logger, '[chonkyfish] 日记目录创建失败', error)
    }
    return { home: paths.home, workspace: paths.workspace }
  }

  /**
   * 注入页面的资源信息。**故意不包含 token**：token 由 index.js 拼到注入脚本里。
   */
  function clientState() {
    return {
      home: paths.home,
      dshHome,
      preset: PRESET,
      routes: ROUTES,
      paths: {
        workspace: paths.workspace,
        workspaceParent: dirname(paths.workspace),
        workspaceName: WORKSPACE_DIR,
      },
    }
  }

  return {
    dshHome,
    home,
    paths,
    routes: ROUTES,
    limits: LIMITS,
    versions: VERSIONS,
    spec,
    ensureLayout,
    getConfig,
    updateConfig,
    clientState,
  }
}
