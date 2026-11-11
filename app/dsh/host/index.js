/**
 * Host half of the ChonkyFish（大肥鱼）bundle.
 *
 * Jobs:
 * 1. Own the chonkyFish home under the DSH home（`$DSH_HOME/chonkyfish/`）：
 *    all plugin data (state / config / proactive / events.db / 小鱼塘 workspace)
 *    lives there through the resource manager（app/shared/resources/）.
 * 2. Give every "chonkyfish" preset Session full permission (sandbox
 *    danger-full-access + approval never), through the normal permission
 *    preset write path.
 * 3. Persist the panel's own state (name / extra persona / wallet / ledger /
 *    local demo transcript) in a real JSON file instead of browser
 *    localStorage, served to the panel through an authenticated local route.
 * 4. Expose the resource config（config.json）and the active-session /
 *    proactive routes. Every path, route, limit and default comes from the
 *    resource module — this file does not hardcode them.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { createPanelSupplement } from '../../../core/modules/persona/supplement.js'
import { createModulePrompt } from '../../../core/modules/persona/modules.js'
import { normalizeProfileDirectory } from '../../../core/modules/persona/profile-directory.js'
import { createResources } from '../../shared/resources/index.js'
import { installSocial } from '../adapters/social/index.js'
import { installAbs } from '../adapters/abs/index.js'
import { installSkills } from '../adapters/skills/index.js'
import { installPerception } from '../adapters/perception/index.js'
import { installMigration } from '../adapters/migration/index.js'
import { isSocialHeader } from '../../../core/modules/social/policy.js'

const FULL_ACCESS = 'danger-full-access'

export const inject = ['permissionPresets', 'agents', 'agentPresets', 'systemPrompt', 'webServer', 'connection', 'tools']

function isFishAgent(ctx, agent, preset) {
  try {
    const header = agent && agent.session && agent.session.header
    if (header && header.agentPreset === preset) return true
    const composed = ctx.agentPresets.composedPreset(agent.ctx)
    return composed === preset
  } catch (error) {
    return false
  }
}

function giveFullAccess(ctx, agent, preset) {
  if (!agent || !agent.session || isSocialHeader(agent.session.header) || !isFishAgent(ctx, agent, preset)) return
  try {
    ctx.permissionPresets.set(agent.session, FULL_ACCESS)
  } catch (error) {
    try {
      ctx.logger.warn('[chonkyfish] 小鱼塘会话权限切换失败', error)
    } catch (ignored) {
      /* logging is best effort */
    }
  }
}

/**
 * 读取请求体 JSON；超过上限、空 body、非法 JSON 都返回 null。
 * @param {import('node:http').IncomingMessage} request
 * @param {number} limit
 */
function readJsonBody(request, limit) {
  return new Promise((resolve) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge || chunks.length === 0) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        resolve(null)
      }
    })
    request.on('error', () => resolve(null))
  })
}

export function apply(ctx) {
  const resources = createResources({ env: process.env })
  const { routes, limits, spec } = resources
  let writeChain = Promise.resolve()
  let stateGeneration = 0
  let migrationMaintaining = false
  let activePerception = null
  let activePanelSession // Updated synchronously by the existing panel-session route.
  let socialCapabilities = () => ({ dingtalk: { connected: false, ownerBound: false } })

  function warn(message, error) {
    try {
      ctx.logger.warn(message, error)
    } catch (ignored) {
      /* logging is best effort */
    }
  }

  // home 布局（目录 + 默认 config）；所有异步启动器都会 await 它。
  const layoutReady = resources.ensureLayout({ logger: ctx.logger }).then(async (layout) => {
    const { createMigrationRepository } = await import('../../shared/storage/migration/repository.js')
    await createMigrationRepository({ resources }).recover()
    return layout
  }).catch((error) => {
    warn('[chonkyfish] home 布局或迁移恢复初始化失败', error)
    throw error
  })

  // 面板「补充人格设定」→ system prompt 变量：预设里的 persona 模板用
  // {{chonkyfish_supplement}} 引用它，所以人格不再混进用户消息。
  ctx.effect(() => {
    const supplement = createPanelSupplement({ statePath: resources.paths.state, defaultProfileDirectory: resources.paths.personalProfile, logger: ctx.logger, isMigrationBusy: resources.isMigrationBusy })
    const modules = createModulePrompt({ readContext: () => ({ ...supplement.readState(), ...socialCapabilities() }) })
    const disposeSupplement = ctx.systemPrompt.variable(supplement.variableName, supplement.provider)
    let disposeModules
    try {
      disposeModules = ctx.systemPrompt.variable(modules.variableName, modules.provider)
    } catch (error) {
      disposeSupplement()
      throw error
    }
    return () => { disposeModules(); disposeSupplement() }
  }, 'chonkyfish: panel persona supplement')

  function writeState(body, profileDirectory) {
    let pending
    try {
      pending = resources.withMigrationWrite(() => writeChain.then(async () => {
        await layoutReady
        await mkdir(dirname(resources.paths.state), { recursive: true })
        await mkdir(profileDirectory, { recursive: true })
        const temporary = resources.paths.state + '.' + process.pid + '.' + randomUUID() + '.tmp'
        await writeFile(temporary, body, 'utf8')
        await rename(temporary, resources.paths.state)
      }))
    } catch (error) { pending = Promise.reject(error) }
    // Keep the queue usable, but report this operation's failure to its caller.
    writeChain = pending.catch((error) => { warn('[chonkyfish] 状态文件写入失败', error) })
    return pending
  }

  function replyJson(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }

  ctx.on('webserver/index-inject', (table) => {
    const clientResources = resources.clientState()
    table.push({
      kind: 'script',
      placement: 'body',
      text: 'window.__CHONKYFISH_STATE__ = ' + JSON.stringify({
        // 兼容旧字段
        endpoint: routes.state,
        eventsEndpoint: routes.events,
        sessionEndpoint: routes.session,
        proactiveEndpoint: routes.proactive,
        configEndpoint: routes.config,
        // 资源管理模块给出的布局/路由/预设
        routes,
        preset: clientResources.preset,
        paths: clientResources.paths,
        home: clientResources.home,
      }) + ';',
    })
  })

  /* ---------------------------------------------------------- state file */

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: routes.state,
    handler: (request, response) => {
      if (migrationMaintaining) { replyJson(response, 409, { ok: false, error: { code: 'MIGRATION_BUSY' } }); return }
      if (request.method === 'GET' || request.method === 'HEAD') {
        layoutReady.then(() => resources.withMigrationRead(() => readFile(resources.paths.state, 'utf8'))).then((text) => {
          const payload = JSON.parse(text)
          if (Number.isSafeInteger(payload.generation) && payload.generation >= 0) stateGeneration = payload.generation
          else stateGeneration = 0
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ...payload, generation: stateGeneration }))
        }).catch((error) => {
          if (error.code === 'ENOENT') {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            response.end('{}')
          } else if (error?.code === 'MIGRATION_BUSY') {
            replyJson(response, 409, { ok: false, error: { code: 'MIGRATION_BUSY' } })
          } else {
            response.writeHead(500)
            response.end()
          }
        })
        return
      }
      if (request.method !== 'PUT' && request.method !== 'POST') {
        response.writeHead(405)
        response.end()
        return
      }
      const chunks = []
      let size = 0
      let tooLarge = false
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > limits.stateBodyBytes) {
          tooLarge = true
          chunks.length = 0
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        if (tooLarge) {
          response.writeHead(413)
          response.end()
          return
        }
        let payload
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (error) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('invalid json')
          return
        }
        if (!payload || typeof payload !== 'object' || typeof payload.state !== 'object' || payload.state === null || Array.isArray(payload.state)) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('missing state object')
          return
        }
        if ((payload.generation ?? 0) !== stateGeneration) {
          replyJson(response, 409, { ok: false, error: { code: 'STALE_TARGET' } })
          return
        }
        payload.generation = stateGeneration + 1
        try {
          payload.state.profileDirectory = normalizeProfileDirectory(payload.state.profileDirectory, resources.paths.personalProfile)
        } catch (error) {
          replyJson(response, 400, { ok: false, error: error.message })
          return
        }
        writeState(JSON.stringify(payload), payload.state.profileDirectory).then(() => {
          stateGeneration = payload.generation
          response.writeHead(204)
          response.end()
        }).catch((error) => {
          if (error?.code === 'MIGRATION_BUSY') replyJson(response, 409, { ok: false, error: { code: 'MIGRATION_BUSY' } })
          else { response.writeHead(500); response.end() }
        })
      })
      request.on('error', () => {
        if (!response.headersSent) {
          response.writeHead(400)
          response.end()
        }
      })
    },
  }), 'chonkyfish: state file route')

  /* --------------------------------------------------------- config file */

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: routes.config,
    handler: (request, response) => {
      if (migrationMaintaining) { replyJson(response, 409, { ok: false, error: { code: 'MIGRATION_BUSY' } }); return }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const body = JSON.stringify({
          ok: true,
          home: resources.home,
          paths: resources.paths,
          routes,
          config: resources.getConfig(),
        })
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(request.method === 'HEAD' ? undefined : body)
        return
      }
      if (request.method !== 'PUT' && request.method !== 'POST') {
        replyJson(response, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      readJsonBody(request, limits.jsonBodyBytes).then((patch) => {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          replyJson(response, 400, { ok: false, error: 'invalid-config' })
          return null
        }
        return resources.updateConfig(patch).then((config) => {
          replyJson(response, 200, { ok: true, config })
        })
      }).catch((error) => {
        if (error?.code === 'MIGRATION_BUSY') replyJson(response, 409, { ok: false, error: { code: 'MIGRATION_BUSY' } })
        else replyJson(response, 500, { ok: false, error: String((error && error.message) || error) })
      })
    },
  }), 'chonkyfish: config route')

  // Social arrivals go to the panel's current main session, with source-scoped safeguards.
  ctx.effect(() => {
    const social = installSocial(ctx, { resources, ready: layoutReady, warn, getActiveSessionId: () => activePanelSession })
    const describe = () => social.capabilityState()
    socialCapabilities = describe
    return () => {
      if (socialCapabilities === describe) socialCapabilities = () => ({ dingtalk: { connected: false, ownerBound: false } })
      return social.close().catch(() => warn('[chonkyfish/social] shutdown failed'))
    }
  }, 'chonkyfish: social')

  /* ------------------------------------------------------- permissions */

  ctx.on('agent/created', (payload) => {
    if (payload && payload.agent) giveFullAccess(ctx, payload.agent, spec.PRESET)
  })
  try {
    for (const agent of ctx.agents.list()) giveFullAccess(ctx, agent, spec.PRESET)
  } catch (error) {
    /* no live agents is the normal case at boot */
  }

  // Owner-controlled transfer for ChonkyFish data only; never exposed as an Agent tool.
  ctx.effect(() => {
    const migration = installMigration(ctx, { resources, ready: layoutReady, pluginVersion: '0.4.10', beforeExclusive: async () => { await resources.waitForMigrationWrites(); await writeChain }, beforePublish: async () => { const service = activePerception?.getService?.(); if (service) await service.stop() }, onExclusive: value => { migrationMaintaining = value; resources.setMigrationMaintenance?.(value) }, onCommitted: async () => { try { const saved = JSON.parse(await readFile(resources.paths.state, 'utf8')); stateGeneration = saved.generation || stateGeneration + 1 } catch { stateGeneration += 1 } } })
    return () => migration.close()
  }, 'chonkyfish: migration')

  // Skills are a local knowledge library; no timer, approval state or website deployment.
  ctx.effect(() => {
    const skills = installSkills(ctx, { resources, ready: layoutReady })
    return () => skills.close()
  }, 'chonkyfish: skills')

  // Perception shares the host runtime; collection starts only on explicit UI action.
  ctx.effect(() => {
    const perception = installPerception(ctx, { resources, ready: layoutReady })
    activePerception = perception
    return () => { if (activePerception === perception) activePerception = null; return perception.close() }
  }, 'chonkyfish: perception')

  /* ------------------------------------------------------------- diary */

  // 日记模块：单工具 `diary`（write/read/list）+ 本地 Markdown + 面板只读路由。
  // 写日记的时机由大肥鱼自己用 DSH 的 schedule 工具安排，模块本身没有定时器。
  // 全局提供日记工具，不设置 preset 或会话访问门禁；保留模块启停与存储校验。
  const diaryConfig = resources.getConfig().diary
  if (diaryConfig.enabled) {
    ctx.effect(() => startDiary(ctx, { resources, ready: layoutReady, warn }), 'chonkyfish: diary')
  }

  // 事件引擎（模块0）：采集 → 提取 → 查询。任何失败都不许影响面板本身。
  void startEventEngine(ctx, { resources, ready: layoutReady, warn })

  ctx.effect(() => {
    const abs = installAbs(ctx, { resources, ready: layoutReady, warn })
    return () => { void abs.close().catch((error) => warn('[chonkyfish/abs] shutdown failed', error)) }
  }, 'chonkyfish: abs')

  // 主动消息：只保留「往面板当前会话主动发一句」的能力，没有任何定时器/自动触发。
  // 同样整段 try/catch：主动消息挂了，聊天照常。
  ctx.effect(() => {
    let disposed = false
    let stop = () => {}
    startProactive(ctx, { resources, ready: layoutReady, warn, onActiveSession: id => { activePanelSession = id } }).then((dispose) => {
      if (disposed) dispose()
      else stop = dispose
    }).catch((error) => {
      warn('[chonkyfish] 主动消息启动失败（面板不受影响）', error)
    })
    return () => {
      disposed = true
      try {
        stop()
      } catch (ignored) {
        /* already gone */
      }
    }
  }, 'chonkyfish: proactive')
}

let runningEngine = null

function service(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch (error) {
    return undefined
  }
}

/**
 * 先同步登记面板路由，再异步加载 diary service；请求会等待布局恢复完成。
 * 这样 WebServer 路由不会因 layout/import Promise 的时序而漏注册。
 * @returns {() => void}
 */
function startDiary(ctx, { resources, ready, warn }) {
  let disposed = false
  let disposeTool = () => {}
  const diaryReady = Promise.all([
    import('../../../core/modules/diary/index.js'),
    import('../../../core/modules/diary/http.js'),
  ]).then(([{ createDiaryModule }, { handleDiaryRequest }]) => {
    const diary = createDiaryModule({ resources })
    if (!disposed) {
      try { disposeTool = ctx.tools.register(diary.tool) }
      catch (error) { warn('[chonkyfish] 日记工具注册失败', error) }
    }
    return { diary, handleDiaryRequest }
  }).catch((error) => {
    warn('[chonkyfish] 日记模块启动失败（面板不受影响）', error)
    throw error
  })
  const disposeRoute = ctx.webServer.register({
    kind: 'exact',
    path: resources.routes.diary,
    handler: (request, response) => {
      if (resources.isMigrationBusy?.()) { replyJson(response, 409, { ok: false, error: { code: 'MIGRATION_BUSY' } }); return }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        replyJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
        return
      }
      void (async () => {
        try {
          await ready
          const { diary, handleDiaryRequest } = await diaryReady
          const result = await handleDiaryRequest({ service: diary.service, headers: request.headers, url: request.url })
          response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(request.method === 'HEAD' ? undefined : JSON.stringify(result.body))
        } catch (error) {
          warn('[chonkyfish] 日记面板读取失败', error)
          try { replyJson(response, 503, { ok: false, error: { code: 'DIARY_UNAVAILABLE' } }) } catch { /* response already gone */ }
        }
      })()
    },
  })
  // Avoid an unhandled rejection if no panel request arrives after a startup failure.
  void diaryReady.catch(() => {})
  return () => {
    disposed = true
    try { disposeTool() } catch { /* already gone */ }
    try { disposeRoute() } catch { /* already gone */ }
  }
}

/**
 * 启动模块0事件引擎。故意用动态 import + 整段 try/catch：
 * 事件引擎挂了，鱼鱼面板和聊天也必须照常工作。
 */
async function startEventEngine(ctx, { resources, ready, warn }) {
  try {
    await ready
    const engineConfig = resources.getConfig().eventEngine
    if (!engineConfig.enabled) return null

    const [{ createEventEngine }, { handleEventsRequest }, { createTurnCollector, toEventEngineSession, toEventEngineEvent }, { platform }, persistence] = await Promise.all([
      import('../../../core/modules/event-engine/engine.js'),
      import('../../../core/modules/event-engine/delivery/query.js'),
      import('../adapters/event-engine/dsh-source.js'),
      import('../../shared/platform/index.js'),
      import('../../shared/storage/event-engine/sqlite.js'),
    ])

    // 热重载可能重复调用 apply：先关掉上一只引擎，避免两条连接抢同一个库。
    if (runningEngine) {
      try {
        runningEngine.close()
      } catch (ignored) {
        /* already gone */
      }
      runningEngine = null
    }
    const engine = createEventEngine({
      file: resources.paths.events,
      workspaceRoot: resources.paths.workspace,
      preset: resources.spec.PRESET,
      maxRecordsPerTurn: engineConfig.maxRecordsPerTurn,
      logger: ctx.logger,
      pathSemantics: platform,
      createTurnCollector,
      persistence,
    })
    runningEngine = engine
    ctx.effect(() => () => {
      if (runningEngine === engine) runningEngine = null
      engine.close()
    }, 'chonkyfish: event engine')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: resources.routes.events,
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405)
          response.end()
          return
        }
        const result = handleEventsRequest({ engine, headers: request.headers, url: request.url })
        const body = JSON.stringify(result.body)
        response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
        response.end(request.method === 'HEAD' ? undefined : body)
      },
    }), 'chonkyfish: events route')

    // The DSH adapter reduces host objects to the core's explicit session/event contracts.
    ctx.on('session/event', (session, event) => {
      engine.feed(toEventEngineSession(session), toEventEngineEvent(event))
    })

    const llm = service(ctx, 'llm')
    const sessionQuery = service(ctx, 'sessionQuery')
    if (llm && sessionQuery) {
      const [{ createExtractor, resolveModelFromId }, { createExtractionRunner }, { loadTurnRecords }] = await Promise.all([
        import('../../../core/modules/event-engine/extraction/extractor.js'),
        import('../../../core/modules/event-engine/extraction/runner.js'),
        import('../adapters/event-engine/dsh-history.js'),
      ])
      const extractor = createExtractor({
        llm,
        // 模型 = 该鱼鱼会话自己的模型（preset 决定）；会话拿不到才退默认选择。
        resolveModel: (modelId) => resolveModelFromId(modelId, defaultModelSelection(ctx)),
        logger: ctx.logger,
      })
      const runner = createExtractionRunner({ engine, extractor, readTurnRecords: range => loadTurnRecords({ sessionQuery, ...range }), logger: ctx.logger })
      let running = false
      const timer = setInterval(() => {
        if (running) return
        running = true
        runner.runOnce({ limit: engineConfig.extractBatch })
          .catch((error) => warn('[chonkyfish] 提取轮询失败', error))
          .finally(() => {
            running = false
          })
      }, engineConfig.extractTickMs)
      ctx.effect(() => () => clearInterval(timer), 'chonkyfish: extraction loop')
    } else {
      warn('[chonkyfish] 缺少 llm/sessionQuery，事件引擎只采集不提取')
    }
    return engine
  } catch (error) {
    warn('[chonkyfish] 事件引擎启动失败（面板不受影响）', error)
    return null
  }
}

/**
 * 启动主动消息能力（无定时器）：
 *   PUT  /chonkyfish/session      面板上报当前显示的鱼鱼会话
 *   GET  /chonkyfish/proactive    只读诊断（active session / 最近发送 / 配置）
 *   POST /chonkyfish/proactive    让她往面板当前会话主动说一句（可选自定义旁白）
 * 返回一个幂等的 stop 函数。
 */
async function startProactive(ctx, { resources, ready, warn, onActiveSession }) {
  try {
    await ready
    const [{ createProactiveService }, { createDeliverer }] = await Promise.all([
      import('../../../core/modules/proactive/proactive.js'),
      import('../adapters/proactive/delivery.js'),
    ])
    const deliverer = createDeliverer({ ctx, workspaceRoot: resources.paths.workspace, preset: resources.spec.PRESET, logger: ctx.logger })
    const proactive = createProactiveService({ resources, deliverer, logger: ctx.logger })

    function replyJson(response, status, body) {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(body === undefined ? undefined : JSON.stringify(body))
    }

    try {
      // 面板绑定/切换会话时上报。Host 只往这条会话投主动消息。
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: resources.routes.session,
        handler: (request, response) => {
          if (request.method !== 'PUT' && request.method !== 'POST') {
            replyJson(response, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          readJsonBody(request, resources.limits.jsonBodyBytes).then((body) => {
            const result = proactive.registerActiveSession(body && body.sessionId)
            if (!result.ok) {
              replyJson(response, 400, result)
              return
            }
            onActiveSession?.(result.sessionId)
            response.writeHead(204)
            response.end()
          })
        },
      }), 'chonkyfish: active session route')

      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: resources.routes.proactive,
        handler: (request, response) => {
          if (request.method === 'GET' || request.method === 'HEAD') {
            const body = JSON.stringify(proactive.inspect())
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            response.end(request.method === 'HEAD' ? undefined : body)
            return
          }
          if (request.method !== 'POST') {
            replyJson(response, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          readJsonBody(request, resources.limits.jsonBodyBytes).then((body) => proactive.send({
            sessionId: body && typeof body.sessionId === 'string' ? body.sessionId : null,
            narration: body && typeof body.narration === 'string' ? body.narration : null,
            kind: body && typeof body.kind === 'string' ? body.kind : 'manual',
          })).then((result) => {
            replyJson(response, result.ok ? 200 : 409, result)
          }).catch((error) => {
            replyJson(response, 500, { ok: false, error: String((error && error.message) || error) })
          })
        },
      }), 'chonkyfish: proactive route')
    } catch (error) {
      // 插件卸载中注册会被拒：收掉服务，避免留下半套路由。
      warn('[chonkyfish] 主动消息路由注册失败', error)
      proactive.dispose()
      return () => {}
    }

    return () => proactive.dispose()
  } catch (error) {
    warn('[chonkyfish] 主动消息启动失败（面板不受影响）', error)
    return () => {}
  }
}

function defaultModelSelection(ctx) {
  try {
    const serviceRef = service(ctx, 'agentDefaultModel')
    const selection = serviceRef && serviceRef.currentSelection()
    if (selection && selection.provider && selection.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch (error) {
    /* fall through */
  }
  return { provider: '', model: '' }
}
