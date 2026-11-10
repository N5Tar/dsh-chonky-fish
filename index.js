/**
 * Host half of the ChonkyFish（大肥鱼）bundle.
 *
 * Jobs:
 * 1. Own the chonkyFish home under the DSH home（`$DSH_HOME/chonkyfish/`）：
 *    all plugin data (state / config / proactive / events.db / 小鱼塘 workspace)
 *    lives there through the resource manager（src/resources/）.
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

import { createPanelSupplement } from './src/persona/supplement.js'
import { createModulePrompt } from './src/persona/modules.js'
import { normalizeProfileDirectory } from './src/persona/profile-directory.js'
import { createResources } from './src/resources/index.js'
import { installSocial } from './src/social/index.js'
import { installAbs } from './src/abs/index.js'
import { installSkills } from './src/skills/index.js'
import { installPerception } from './src/perception/index.js'
import { isSocialHeader } from './src/social/policy.js'

const FULL_ACCESS = 'danger-full-access'

export const inject = ['permissionPresets', 'agents', 'agentPresets', 'systemPrompt', 'webServer', 'tools']

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
  const layoutReady = resources.ensureLayout({ logger: ctx.logger }).catch((error) => {
    warn('[chonkyfish] home 布局初始化失败（面板仍可继续使用）', error)
    return null
  })

  // 面板「补充人格设定」→ system prompt 变量：预设里的 persona 模板用
  // {{chonkyfish_supplement}} 引用它，所以人格不再混进用户消息。
  ctx.effect(() => {
    const supplement = createPanelSupplement({ statePath: resources.paths.state, defaultProfileDirectory: resources.paths.personalProfile, logger: ctx.logger })
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
    const pending = writeChain.then(async () => {
      await layoutReady
      await mkdir(dirname(resources.paths.state), { recursive: true })
      await mkdir(profileDirectory, { recursive: true })
      const temporary = resources.paths.state + '.' + process.pid + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, body, 'utf8')
      await rename(temporary, resources.paths.state)
    })
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
      if (request.method === 'GET' || request.method === 'HEAD') {
        readFile(resources.paths.state, 'utf8').then((text) => {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          response.end(request.method === 'HEAD' ? undefined : text)
        }).catch((error) => {
          if (error.code === 'ENOENT') {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            response.end('{}')
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
        try {
          payload.state.profileDirectory = normalizeProfileDirectory(payload.state.profileDirectory, resources.paths.personalProfile)
        } catch (error) {
          replyJson(response, 400, { ok: false, error: error.message })
          return
        }
        writeState(JSON.stringify(payload), payload.state.profileDirectory).then(() => {
          response.writeHead(204)
          response.end()
        }).catch(() => {
          response.writeHead(500)
          response.end()
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
        replyJson(response, 500, { ok: false, error: String((error && error.message) || error) })
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

  ctx.effect(() => {
    void layoutReady
    return () => {}
  }, 'chonkyfish: home layout')

  // Skills are a local knowledge library; no timer, approval state or website deployment.
  ctx.effect(() => {
    const skills = installSkills(ctx, { resources, ready: layoutReady })
    return () => skills.close()
  }, 'chonkyfish: skills')

  // Perception shares the host runtime; collection starts only on explicit UI action.
  ctx.effect(() => {
    const perception = installPerception(ctx, { resources, ready: layoutReady })
    return () => perception.close()
  }, 'chonkyfish: perception')

  /* ------------------------------------------------------------- diary */

  // 日记模块：单工具 `diary`（write/read/list）+ 本地 Markdown + 面板只读路由。
  // 写日记的时机由大肥鱼自己用 DSH 的 schedule 工具安排，模块本身没有定时器。
  // 全局提供日记工具，不设置 preset 或会话访问门禁；保留模块启停与存储校验。
  const diaryConfig = resources.getConfig().diary
  if (diaryConfig.enabled) {
    let diaryHandle = null
    let diaryDisposed = false

    ctx.effect(() => {
      diaryDisposed = false
      startDiary(ctx, { resources, ready: layoutReady, warn }).then((handle) => {
        if (diaryDisposed) {
          if (handle) {
            try {
              handle.stop()
            } catch (ignored) {
              /* already gone */
            }
          }
          return
        }
        diaryHandle = handle
      }).catch((error) => {
        warn('[chonkyfish] 日记模块启动失败（面板不受影响）', error)
      })
      return () => {
        diaryDisposed = true
        if (diaryHandle) {
          try {
            diaryHandle.stop()
          } catch (ignored) {
            /* already gone */
          }
          diaryHandle = null
        }
      }
    }, 'chonkyfish: diary')
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
 * 启动日记模块：注册 diary 工具 + 面板只读路由（没有定时器）。
 * 和事件引擎一样用动态 import + 整段 try/catch：日记挂了，面板和聊天照常。
 * @returns {Promise<{ stop: () => void } | null>}
 */
async function startDiary(ctx, { resources, ready, warn }) {
  try {
    await ready
    const [{ createDiaryModule }] = await Promise.all([import('./src/diary/index.js')])
    const diary = createDiaryModule({ resources })
    let disposeTool = () => {}
    try {
      disposeTool = ctx.tools.register(diary.tool)
    } catch (error) {
      warn('[chonkyfish] diary 工具注册失败', error)
      return null
    }
    // 面板「日记」弹窗的只读路由（list / read）。注册失败不影响工具本身。
    try {
      const { handleDiaryRequest } = await import('./src/diary/http.js')
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: resources.routes.diary,
        handler: (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405)
            response.end()
            return
          }
          handleDiaryRequest({
            service: diary.service,
            headers: request.headers,
            url: request.url,
              }).then((result) => {
            const body = JSON.stringify(result.body)
            response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
            response.end(request.method === 'HEAD' ? undefined : body)
          }).catch(() => {
            try {
              response.writeHead(500)
              response.end()
            } catch (ignored) {
              /* response already gone */
            }
          })
        },
      }), 'chonkyfish: diary route')
    } catch (error) {
      warn('[chonkyfish] 日记面板路由注册失败（日记工具仍可用）', error)
    }
    return {
      stop() {
        try {
          disposeTool()
        } catch (ignored) {
          /* already gone */
        }
      },
    }
  } catch (error) {
    warn('[chonkyfish] 日记模块启动失败（面板不受影响）', error)
    return null
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

    const [{ createEventEngine }, { handleEventsRequest }] = await Promise.all([
      import('./src/event-engine/engine.js'),
      import('./src/event-engine/delivery/query.js'),
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

    // 采集：所有会话事件都经过 feed，由引擎用「(工作区根, chonkyfish)」联合判断过滤。
    ctx.on('session/event', (session, event) => {
      engine.feed(session, event)
    })

    const llm = service(ctx, 'llm')
    const sessionQuery = service(ctx, 'sessionQuery')
    if (llm && sessionQuery) {
      const [{ createExtractor, resolveModelFromId }, { createExtractionRunner }] = await Promise.all([
        import('./src/event-engine/extraction/extractor.js'),
        import('./src/event-engine/extraction/runner.js'),
      ])
      const extractor = createExtractor({
        llm,
        // 模型 = 该鱼鱼会话自己的模型（preset 决定）；会话拿不到才退默认选择。
        resolveModel: (modelId) => resolveModelFromId(modelId, defaultModelSelection(ctx)),
        logger: ctx.logger,
      })
      const runner = createExtractionRunner({ engine, extractor, sessionQuery, logger: ctx.logger })
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
    const [{ createProactiveService }] = await Promise.all([import('./src/proactive/proactive.js')])
    const proactive = createProactiveService({ ctx, resources, logger: ctx.logger })

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
