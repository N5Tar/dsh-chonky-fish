import { readFileSync } from 'node:fs'
import { platform } from '../../../shared/platform/index.js'
import { createSocialService } from '../../../../core/modules/social/service.js'
import { createPeerBindings } from '../../../../core/modules/social/peer-bindings.js'
import { createSocialHttpHandler } from './http.js'
import { createSocialBridge } from './session-bridge.js'
import { createOwnerSendTool } from './tools.js'
import { createMainDeliveryPump } from '../../../../core/modules/social/main-delivery-pump.js'
import { isFishHeader } from '../../../../core/modules/proactive/identity.js'
import { publicError } from '../../../../core/modules/social/core.js'

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
  const isFish = agent => isFishHeader(agent?.session?.header, { workspaceRoot: resources.paths.workspace, preset: resources.spec.PRESET, pathSemantics: platform })
  const tools = get('tools')
  // Channel provenance controls reply routing, not tool access. Tools follow the
  // session's preset and normal DSH permissions, including channel-origin turns.
  const safe = typeof ctx.on === 'function'
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
      if (!safe) throw Object.assign(new Error('Required session events unavailable'), { code: 'SOCIAL_HOST_CAPABILITY_UNAVAILABLE' })
      peers = await createPeerBindings({ file: resources.paths.socialPeerBindings, syncDirectory: platform.syncDirectory })
      service = await createSocialService({ paths: resources.paths, limits: resources.spec.SOCIAL.limits, peers, syncDirectory: platform.syncDirectory })
      if (disposed) { await service.close(); await peers.close(); return }
      // Owner messaging remains scoped to the fish's main session, regardless of
      // input channel. The paired target still resolves inside the driver.
      if (typeof tools?.register === 'function') {
        const disposeTool = tools.register(createOwnerSendTool({ service }), {
          when: ({ agent }) => !disposed && isFish(agent),
        })
        if (typeof disposeTool === 'function') cleanups.push(disposeTool)
      }
      bridge = await createSocialBridge({ ctx, service, resources, peers, getActiveSessionId: selectedSession })
      if (disposed) { await bridge.close(); await service.close(); await peers.close(); return }
      pump = createMainDeliveryPump({ service, bridge })
      const disposeEvents = ctx.on('session/event', (session, event) => {
        if (disposed) return
        const relevant = isFishHeader(session?.header, { workspaceRoot: resources.paths.workspace, preset: resources.spec.PRESET, pathSemantics: platform }) || peers?.hasPeerSession(session?.id)
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
      // Storage failure disables delivery without changing session tool permissions.
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
