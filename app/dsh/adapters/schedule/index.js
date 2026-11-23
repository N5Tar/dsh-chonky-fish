/**
 * installSchedule：工具 + HTTP + 装甲。
 */

import { createScheduleRepository } from '../../../shared/storage/schedule/repository.js'
import { platform } from '../../../shared/platform/index.js'
import {
  createScheduleService,
  createFishScheduleTool,
  bindScheduleToolRunner,
} from '../../../../core/modules/schedule/index.js'
import { createScheduleHost, readActiveSessionId } from './host.js'
import { handleScheduleRequest } from './http.js'

/**
 * @param {any} ctx
 * @param {{
 *   resources: any,
 *   deliverer: { deliver: Function },
 *   ready: Promise<unknown>,
 *   logger?: any,
 * }} options
 */
export function installSchedule(ctx, { resources, deliverer, ready, logger } = {}) {
  const repository = createScheduleRepository({
    path: resources.paths.schedule,
    syncDirectory: platform.syncDirectory,
    withMigrationRead: resources.withMigrationRead,
    withMigrationWrite: resources.withMigrationWrite,
  })
  const log = logger || ctx.logger
  const inner = createScheduleService({
    repository,
    warn: (...args) => {
      try {
        log?.warn?.(...args)
      } catch {
        /* ignore */
      }
    },
  })
  /** @type {ReturnType<typeof createScheduleHost> | null} */
  let host = null
  let closed = false

  const service = {
    list: (...args) => inner.list(...args),
    load: () => inner.load(),
    async create(args) {
      const result = await inner.create(args)
      host?.notifyMutation()
      return result
    },
    async update(args) {
      const result = await inner.update(args)
      host?.notifyMutation()
      return result
    },
    async delete(id) {
      const result = await inner.delete(id)
      host?.notifyMutation()
      return result
    },
    async enable(id, version) {
      const result = await inner.enable(id, version)
      host?.notifyMutation()
      return result
    },
    async disable(id, version) {
      const result = await inner.disable(id, version)
      host?.notifyMutation()
      return result
    },
  }

  const stopTool = ctx.tools.register(createFishScheduleTool(bindScheduleToolRunner(service)))

  function replyJson(response, status, body, head) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(head ? undefined : JSON.stringify(body))
  }

  const stopRoute = ctx.webServer.register({
    kind: 'exact',
    path: resources.routes.schedule,
    handler: (request, response) => {
      void handleScheduleRequest({ service: inner, method: request.method }).then((result) => {
        replyJson(response, result.status, result.body, request.method === 'HEAD')
      })
    },
  })

  host = createScheduleHost({
    service: inner,
    deliver: (sessionId, text, options) => deliverer.deliver(sessionId, text, options),
    getActiveSessionId: () => readActiveSessionId(resources.paths.proactive),
    logger: logger || ctx.logger,
  })

  const boot = Promise.resolve(ready).then(async () => {
    if (closed) return
    await host.start()
  })
  void boot.catch((error) => {
    try {
      ;(logger || ctx.logger)?.warn?.('[chonkyfish/schedule] boot failed', error)
    } catch {
      /* ignore */
    }
  })

  return {
    service,
    host,
    close() {
      closed = true
      host?.close()
      try {
        stopTool()
      } catch {
        /* ignore */
      }
      try {
        stopRoute()
      } catch {
        /* ignore */
      }
    },
  }
}
