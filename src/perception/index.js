import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createPerceptionStore } from './store.js'
import { createPerceptionService } from './service.js'
import { registerPerceptionRoute } from './http.js'

// In-process hot reload ownership only; no standalone lock manager or service.
const owners = new Map()

/** The plugin owns this instance; native collection is always opt-in. */
export function installPerception(ctx, { resources, ready: layoutReady = Promise.resolve(),
  loadSqlite = () => import('node:sqlite'), serviceFactory = createPerceptionService, storeFactory = createPerceptionStore } = {}) {
  let closed = false, service = null, failure = null, disposeRoute = () => {}, closing = null
  const warn = error => { try { ctx.logger?.warn?.('[chonkyfish] 感知模块不可用', error?.code || error?.message) } catch {} }
  const ownerKey = resources.paths.perceptionDatabase
  const previousClosed = owners.get(ownerKey)?.close()
  const ready = (async () => {
    let store
    try {
      await previousClosed
      await layoutReady
      if (closed) return
      const config = resources.getConfig().perception
      const sqlite = await loadSqlite()
      if (closed) return
      await mkdir(resources.paths.perception, { recursive: true, mode: 0o700 })
      const target = resources.perceptionCollector()
      let capabilities = { supported: target.supported, reason: target.reason }
      if (target.supported) {
        try { await access(target.binaryPath, constants.X_OK) }
        catch { capabilities = { supported: false, reason: '采集器缺失或不可执行，请重新构建/安装支持此架构的插件' } }
      }
      if (closed) return
      store = storeFactory({ dbPath: resources.paths.perceptionDatabase, DatabaseSync: sqlite.DatabaseSync, config })
      service = serviceFactory({ store, binaryPath: target.binaryPath, capabilities, config,
        isEnabled: () => !closed && resources.getConfig().perception.enabled })
      await service.initialize()
      if (closed) await service.close()
    } catch (cause) {
      failure = { code: 'PERCEPTION_UNAVAILABLE', message: cause?.message || '感知模块初始化失败' }
      try { if (service) await service.close(); else store?.close() } catch {}
      service = null; warn(cause)
    }
  })()
  const close = () => {
    if (closing) return closing
    closed = true
    try { disposeRoute() } catch {}
    closing = (async () => { await ready; if (service) await service.close() })().catch(warn).finally(() => {
      if (owners.get(ownerKey)?.close === close) owners.delete(ownerKey)
    })
    return closing
  }
  try {
    if (ctx.webServer) disposeRoute = registerPerceptionRoute(ctx, { resources, ready, getService: () => service,
      isClosed: () => closed, getFailure: () => failure })
  } catch (cause) { void close(); throw cause }
  const handle = { ready, close, getService: () => service, getFailure: () => failure }
  owners.set(ownerKey, handle)
  return handle
}
