/**
 * Host half of the ChonkyFish（大肥鱼）bundle.
 *
 * Jobs:
 * 1. Keep the dedicated 「小鱼塘」 folder under the DSH home.
 * 2. Give every "chonkyfish" preset Session full permission (sandbox
 *    danger-full-access + approval never), through the normal permission
 *    preset write path.
 * 3. Persist the panel's own state (name / extra persona / wallet / ledger /
 *    local demo transcript) in a real JSON file instead of browser
 *    localStorage, served to the panel through an authenticated local route.
 *    The route token is generated per Host activation and injected into the
 *    page; the file is the source of truth, localStorage stays a cache.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FISH_PRESET = 'chonkyfish'
const FULL_ACCESS = 'danger-full-access'
const STATE_ROUTE = '/chonkyfish/state'
const EVENTS_ROUTE = '/chonkyfish/events'
const EXTRACT_TICK_MS = 5000
const EXTRACT_BATCH = 2
const STATE_LIMIT_BYTES = 1024 * 1024

export const inject = ['permissionPresets', 'agents', 'agentPresets', 'webServer']

function isFishAgent(ctx, agent) {
  try {
    const header = agent && agent.session && agent.session.header
    if (header && header.agentPreset === FISH_PRESET) return true
    const composed = ctx.agentPresets.composedPreset(agent.ctx)
    return composed === FISH_PRESET
  } catch (error) {
    return false
  }
}

function giveFullAccess(ctx, agent) {
  if (!agent || !agent.session || !isFishAgent(ctx, agent)) return
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

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = join(home, 'chonkyfish')
  const stateFile = join(stateDir, 'state.json')
  const token = randomUUID()
  let writeChain = Promise.resolve()

  function warn(message, error) {
    try {
      ctx.logger.warn(message, error)
    } catch (ignored) {
      /* logging is best effort */
    }
  }

  function writeState(body) {
    writeChain = writeChain.then(async () => {
      await mkdir(stateDir, { recursive: true })
      const temporary = stateFile + '.' + process.pid + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, body, 'utf8')
      await rename(temporary, stateFile)
    }).catch((error) => {
      warn('[chonkyfish] 状态文件写入失败', error)
    })
    return writeChain
  }

  function authorized(request) {
    return request.headers['x-chonkyfish-token'] === token
  }

  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'script',
      placement: 'body',
      text: 'window.__CHONKYFISH_STATE__ = ' + JSON.stringify({ token, endpoint: STATE_ROUTE, eventsEndpoint: EVENTS_ROUTE }) + ';',
    })
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_ROUTE,
    handler: (request, response) => {
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (!authorized(request)) {
          response.writeHead(401)
          response.end()
          return
        }
        readFile(stateFile, 'utf8').then((text) => {
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
      if (!authorized(request)) {
        response.writeHead(401)
        response.end()
        return
      }
      let size = 0
      let tooLarge = false
      const chunks = []
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > STATE_LIMIT_BYTES) {
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
        const text = Buffer.concat(chunks).toString('utf8')
        let payload
        try {
          payload = JSON.parse(text)
        } catch (error) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('invalid json')
          return
        }
        if (!payload || typeof payload !== 'object' || typeof payload.state !== 'object' || payload.state === null) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('missing state object')
          return
        }
        writeState(JSON.stringify(payload)).then(() => {
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

  ctx.on('agent/created', (payload) => {
    if (payload && payload.agent) giveFullAccess(ctx, payload.agent)
  })
  try {
    for (const agent of ctx.agents.list()) giveFullAccess(ctx, agent)
  } catch (error) {
    /* no live agents is the normal case at boot */
  }

  ctx.effect(() => {
    const path = join(home, '小鱼塘')
    const task = mkdir(path, { recursive: true }).catch((error) => warn('[chonkyfish] 小鱼塘目录创建失败', error))
    return () => {
      void task
    }
  }, 'chonkyfish: pond directory')

  // 事件引擎（模块0）：采集 → 提取 → 查询。任何失败都不许影响面板本身。
  void startEventEngine(ctx, { home, token, warn })
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
 * 启动模块0事件引擎。故意用动态 import + 整段 try/catch：
 * 事件引擎挂了，鱼鱼面板和聊天也必须照常工作。
 */
async function startEventEngine(ctx, { home, token, warn }) {
  try {
    const [{ createEventEngine, FISH_PRESET }, { handleEventsRequest }] = await Promise.all([
      import('./src/event-engine/engine.js'),
      import('./src/event-engine/delivery/query.js'),
    ])

    const stateDir = join(home, 'chonkyfish')
    await mkdir(stateDir, { recursive: true })
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
      file: join(stateDir, 'events.db'),
      pondDir: join(home, '小鱼塘'),
      preset: FISH_PRESET,
      logger: ctx.logger,
    })
    runningEngine = engine
    ctx.effect(() => () => {
      if (runningEngine === engine) runningEngine = null
      engine.close()
    }, 'chonkyfish: event engine')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_ROUTE,
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405)
          response.end()
          return
        }
        const result = handleEventsRequest({ engine, headers: request.headers, url: request.url, token })
        const body = JSON.stringify(result.body)
        response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
        response.end(request.method === 'HEAD' ? undefined : body)
      },
    }), 'chonkyfish: events route')

    // 采集：所有会话事件都经过 feed，由引擎用「(小鱼塘, chonkyfish)」联合判断过滤。
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
        runner.runOnce({ limit: EXTRACT_BATCH })
          .catch((error) => warn('[chonkyfish] 提取轮询失败', error))
          .finally(() => {
            running = false
          })
      }, EXTRACT_TICK_MS)
      ctx.effect(() => () => clearInterval(timer), 'chonkyfish: extraction loop')
    } else {
      warn('[chonkyfish] 缺少 llm/sessionQuery，事件引擎只采集不提取')
    }
  } catch (error) {
    warn('[chonkyfish] 事件引擎启动失败（面板不受影响）', error)
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
