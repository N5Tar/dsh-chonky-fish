import { createSkillService } from './core.js'
import { registerSkillsRoute } from './http.js'
import { createSkillTools } from './tools.js'

/** Knowledge library with lifecycle checks, without caller permission gates. */
export function installSkills(ctx, { resources, ready = Promise.resolve() }) {
  let closed = false
  const service = createSkillService({ directory: resources.paths.skills })
  const isAvailable = () => !closed && resources.getConfig().skills.enabled
  const tools = createSkillTools(service, { isAvailable, ready })
  const disposers = []
  const close = () => {
    if (closed) return
    closed = true
    for (const dispose of disposers.reverse()) dispose()
  }
  try {
    for (const tool of tools) disposers.push(ctx.tools.register(tool, { when: isAvailable }))
    if (ctx.webServer) disposers.push(registerSkillsRoute(ctx, { service, resources, ready, isClosed: () => closed }))
  } catch (error) {
    close()
    throw error
  }
  return { service, close }
}
