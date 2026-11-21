import { createAbsStore } from '../../../../core/modules/abs/store.js'
import { createAbsHost } from './host.js'
import { createAbsService } from '../../../../core/modules/abs/service.js'
import { createAbsHttpHandler } from './http.js'
import { createAbsActivitiesHttpHandler } from './http.js'
import { createAbsActivityRepository } from '../../../shared/storage/abs/sqlite.js'
import { platform } from '../../../shared/platform/index.js'

/** Lifecycle wrapper; one ABS instance per mounted plugin. Never touches the Social bridge. */
export function installAbs(ctx, { resources, ready, warn = () => {}, loadSqlite = () => import('node:sqlite'), readWorkStreak = () => null }) {
  let disposed = false, service = null, host = null, store = null, activityStore = null, disposeRoute = null, disposeActivitiesRoute = null
  let handler = null, activitiesHandler = null, startupError = null
  // Register before async startup so a failed store/host produces a diagnostic,
  // not an indistinguishable empty 404.
  disposeRoute = ctx.webServer.register({ kind: 'exact', path: resources.routes.abs, handler: (request, response) => {
    if (handler) return handler(request, response)
    response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ok: false,
      error: startupError ? 'ABS_STARTUP_FAILED' : 'ABS_INITIALIZING',
      ...(startupError ? { reason: startupError } : {}),
    }))
  } })
  disposeActivitiesRoute = ctx.webServer.register({ kind: 'exact', path: resources.routes.absActivities, handler: (request, response) => {
    if (activitiesHandler) return activitiesHandler(request, response)
    response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ok: false,
      error: startupError ? 'ABS_STARTUP_FAILED' : 'ABS_INITIALIZING',
      ...(startupError ? { reason: startupError } : {}),
    }))
  } })
  const initialized = (async () => {
    try {
      const layout = await ready
      if (disposed) return
      if (!layout) throw new Error('ABS_LAYOUT_UNAVAILABLE')
      const sqlite = await loadSqlite()
      if (disposed) return
      store = await createAbsStore({ directory: resources.paths.abs, syncDirectory: platform.syncDirectory })
      if (disposed) { await store.close(); store = null; return }
      activityStore = createAbsActivityRepository({ dbPath: resources.paths.absActivityDatabase, DatabaseSync: sqlite.DatabaseSync })
      host = createAbsHost({ ctx, resources })
      service = await createAbsService({ store, activityStore, host, getConfig: () => resources.getConfig().abs, readWorkStreak, logger: ctx.logger })
      if (disposed) { await service.close(); return }
      handler = createAbsHttpHandler({ service, resources, maxBodyBytes: resources.limits.jsonBodyBytes })
      activitiesHandler = createAbsActivitiesHttpHandler({ service, maxBodyBytes: resources.limits.jsonBodyBytes })
      service.start()
    } catch (error) {
      handler = null
      startupError = String(error.message ?? error)
      warn('[chonkyfish/abs] startup failed', error)
      if (service) await service.close().catch(() => {})
      else { await host?.close?.(); await activityStore?.close?.(); await store?.close?.() }
      service = null
    }
  })()
  return {
    initialized,
    getService: () => service,
    async close() {
      disposed = true
      await initialized
      if (typeof disposeRoute === 'function') disposeRoute()
      if (typeof disposeActivitiesRoute === 'function') disposeActivitiesRoute()
      await service?.close()
    },
  }
}
