import { createSkillService, SKILL_LIMITS } from '../../../../core/modules/skills/core.js'
import { createSkillFileStorage } from '../../../shared/storage/skills-file.js'
import { registerSkillsRoute } from './http.js'
import { createSkillTools } from '../../../../core/modules/skills/tools.js'

/** Knowledge library with lifecycle checks, without caller permission gates. */
export function installSkills(ctx, { resources, ready = Promise.resolve() }) {
  let closed = false
  const service = createSkillService({ storage: createSkillFileStorage({ directory: resources.paths.skills, maxFileBytes: SKILL_LIMITS.maxFileBytes }) })
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
