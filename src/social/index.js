import { createSocialService } from './service.js'
import { createSocialHttpHandler } from './http.js'
import { createSocialTools } from './tools.js'
import { createSocialBridge } from './session-bridge.js'
import { publicError } from './core.js'

/** Register social tools and management without changing host tool permissions. */
export function installSocial(ctx, { resources, ready, warn = () => {} }) {
  let service = null, bridge = null, disposed = false
  const cleanups = []
  const scopeForAgent = agent => !disposed ? bridge?.scopeForAgent(agent) ?? null : null
  const initialized = (async () => {
    try {
      await ready
      if (disposed) return
      service = await createSocialService({ paths: resources.paths, limits: resources.spec.SOCIAL.limits })
      if (disposed) { await service.close(); return }
      for (const tool of createSocialTools({ service, scopeForAgent })) {
        const dispose = ctx.tools.register(tool)
        if (typeof dispose === 'function') cleanups.push(dispose)
      }
      bridge = await createSocialBridge({ ctx, service, resources })
      if (disposed) { await bridge.close(); await service.close(); return }
      const disposeRoute = ctx.webServer.register({ kind: 'exact', path: resources.routes.social,
        handler: createSocialHttpHandler({ service, bridge, maxBodyBytes: resources.limits.jsonBodyBytes }) })
      if (typeof disposeRoute === 'function') cleanups.push(disposeRoute)
    } catch (error) {
      warn('[chonkyfish/social] startup failed: ' + publicError(error))
      try { await bridge?.close() } catch {}
      try { await service?.close() } catch {}
      service = null; bridge = null
      while (cleanups.length) { try { cleanups.pop()() } catch {} }
    }
  })()
  return {
    initialized,
    async close() {
      disposed = true
      await initialized
      try { await bridge?.close() } finally {
        try { await service?.close() } finally {
          for (const dispose of cleanups.reverse()) { try { dispose() } catch {} }
          cleanups.length = 0
        }
      }
    },
  }
}
