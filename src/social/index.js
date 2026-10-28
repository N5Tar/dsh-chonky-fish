import { createSocialService } from './service.js'
import { createSocialHttpHandler } from './http.js'
import { createSocialTools, socialToolGuard } from './tools.js'
import { createSocialBridge } from './session-bridge.js'
import { publicError } from './core.js'

/** Install the deny-first guard synchronously, before any async initialization. */
export function installSocial(ctx, { resources, ready, token, warn = () => {} }) {
  let service = null, bridge = null, disposed = false
  const cleanups = []
  const scopeForAgent = agent => !disposed ? bridge?.scopeForAgent(agent) ?? null : null
  const guardCleanup = ctx.tools.guard(exec => socialToolGuard(exec, scopeForAgent))
  if (typeof guardCleanup === 'function') cleanups.push(guardCleanup)
  const initialized = (async () => {
    try {
      await ready
      if (disposed) return
      service = await createSocialService({ paths: resources.paths, limits: resources.spec.SOCIAL.limits })
      if (disposed) { await service.close(); return }
      // Register first: DSH restrict allow rejects unknown tool names.
      for (const tool of createSocialTools({ service, scopeForAgent })) {
        const dispose = ctx.tools.register(tool)
        if (typeof dispose === 'function') cleanups.push(dispose)
      }
      bridge = await createSocialBridge({ ctx, service, resources })
      if (disposed) { await bridge.close(); await service.close(); return }
      const disposeRoute = ctx.webServer.register({ kind: 'exact', path: resources.routes.social,
        handler: createSocialHttpHandler({ service, bridge, token, maxBodyBytes: resources.limits.jsonBodyBytes }) })
      if (typeof disposeRoute === 'function') cleanups.push(disposeRoute)
    } catch (error) {
      warn('[chonkyfish/social] startup failed: ' + publicError(error))
      try { await bridge?.close() } catch {}
      try { await service?.close() } catch {}
      service = null; bridge = null
      // Keep deny-first guard until plugin disposal, even when startup fails.
      while (cleanups.length > (typeof guardCleanup === 'function' ? 1 : 0)) { try { cleanups.pop()() } catch {} }
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
