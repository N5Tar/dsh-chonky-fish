import { readFileSync } from 'node:fs'
import { createSocialService } from './service.js'
import { createPeerBindings } from './peer-bindings.js'
import { createSocialHttpHandler } from './http.js'
import { createSocialBridge, isMainSocialTurn } from './session-bridge.js'
import { createOwnerSendTool } from './tools.js'
import { createMainDeliveryPump } from './main-delivery-pump.js'
import { isFishHeader } from '../proactive/identity.js'
import { publicError } from './core.js'

/** Mark the bridge closed synchronously before waiting for its in-flight pump. */
export async function closeSocialDelivery(bridge, pump) {
  const bridgeClosing = bridge?.close()
  const pumpClosing = pump?.close()
  await Promise.allSettled([bridgeClosing, pumpClosing])
}

/** Paired owner DMs follow the panel; visitors use isolated persistent sessions. */
export function installSocial(ctx, { resources, ready, warn = () => {}, getActiveSessionId } = {}) {
  let service = null, bridge = null, pump = null, peers = null, disposed = false
  const cleanups = []
  const get = name => { try { return ctx[name] ?? ctx.get?.(name) } catch { try { return ctx.get?.(name) } catch { return undefined } } }
  const isFish = agent => isFishHeader(agent?.session?.header, { workspaceRoot: resources.paths.workspace, preset: resources.spec.PRESET })
  const isSocial = agent => agent?.session?.header?.agentPreset === resources.spec.SOCIAL.preset || (isFish(agent) && (bridge?.isSocialTurn(agent) || isMainSocialTurn(agent)))
  const tools = get('tools')
  // Routing and capability checks stay in Host; no source prompt or channel tools
  // are exposed to the model. The user content remains exactly the received text.
  const safe = typeof tools?.guard === 'function' && typeof ctx.on === 'function'
  if (safe) cleanups.push(tools.guard(exec => isSocial(exec.agent)
    ? '本次请求不能调用此工具，请直接回复。' : undefined))
  const selectedSession = () => {
    if (!safe) return null
    if (getActiveSessionId) {
      const selected = getActiveSessionId()
      if (selected !== undefined) return selected
    }
    // The proactive module owns this file; social reads the same panel selection as ABS.
    try {
      const value = JSON.parse(readFileSync(resources.paths.proactive, 'utf8'))
      return typeof value.activeSessionId === 'string' && value.activeSessionId.trim() ? value.activeSessionId.trim() : null
    } catch { return null }
  }
  const initialized = (async () => {
    try {
      await ready
      if (disposed) return
      if (!safe) throw Object.assign(new Error('Required tool guard unavailable'), { code: 'SOCIAL_HOST_CAPABILITY_UNAVAILABLE' })
      peers = await createPeerBindings({ file: resources.paths.socialPeerBindings })
      service = await createSocialService({ paths: resources.paths, limits: resources.spec.SOCIAL.limits, peers })
      if (disposed) { await service.close(); await peers.close(); return }
      // Proactive DingTalk messaging is available only to the fish's own main-session
      // turns, never to external-request turns; the target resolves inside the driver.
      if (typeof tools?.register === 'function') {
        const disposeTool = tools.register(createOwnerSendTool({ service }), {
          when: ({ agent }) => !disposed && isFish(agent) && !(bridge?.isSocialTurn(agent) || isMainSocialTurn(agent)),
        })
        if (typeof disposeTool === 'function') cleanups.push(disposeTool)
      }
      bridge = await createSocialBridge({ ctx, service, resources, peers, getActiveSessionId: selectedSession })
      if (disposed) { await bridge.close(); await service.close(); await peers.close(); return }
      pump = createMainDeliveryPump({ service, bridge })
      const disposeEvents = ctx.on('session/event', (session, event) => {
        if (disposed) return
        const relevant = isFishHeader(session?.header, { workspaceRoot: resources.paths.workspace, preset: resources.spec.PRESET }) || peers?.hasPeerSession(session?.id)
        if (!relevant) return
        bridge?.onEvent(session, event)
        if (event?.type === 'turn/end') pump?.wake()
      })
      if (typeof disposeEvents === 'function') cleanups.push(disposeEvents)
      const disposeRoute = ctx.webServer.register({ kind: 'exact', path: resources.routes.social,
        handler: createSocialHttpHandler({ service, bridge, pump, maxBodyBytes: resources.limits.jsonBodyBytes }) })
      if (typeof disposeRoute === 'function') cleanups.push(disposeRoute)
    } catch (error) {
      warn('[chonkyfish/social] startup failed: ' + publicError(error))
      await closeSocialDelivery(bridge, pump)
      try { await service?.close() } catch {}
      try { await peers?.close() } catch {}
      service = null; bridge = null; pump = null
      // Keep the source guard until plugin disposal, even if storage failed at startup.
    }
  })()
  return {
    initialized,
    capabilityState() { return !disposed && service ? service.capabilityState() : { dingtalk: { connected: false, ownerBound: false } } },
    async close() {
      disposed = true
      await initialized
      try { await closeSocialDelivery(bridge, pump) } finally {
        try { await service?.close(); await peers?.close() } finally {
          for (const dispose of cleanups.reverse()) { try { dispose() } catch {} }
          cleanups.length = 0
        }
      }
    },
  }
}
