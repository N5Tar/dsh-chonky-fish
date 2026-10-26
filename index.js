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
      text: 'window.__CHONKYFISH_STATE__ = ' + JSON.stringify({ token, endpoint: STATE_ROUTE }) + ';',
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
}
