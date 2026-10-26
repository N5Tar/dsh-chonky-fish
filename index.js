/**
 * Host half of the ChonkyFish（大肥鱼）bundle.
 *
 * Two jobs:
 * 1. Make sure the dedicated 「小鱼塘」 folder exists under the DSH home, so the
 *    Client can adopt it as a workspace on the first fish chat without asking
 *    the operator to create a directory.
 * 2. Give every Session created under the "chonkyfish" agent preset full
 *    permission (sandbox danger-full-access + approval never). The fish
 *    companion drives a real local browser through AppleScript/CDP, which the
 *    workspace-write seatbelt blocks, so this preset intentionally opts out of
 *    the sandbox. The switch goes through the normal permission-preset write
 *    path, so it is recorded in the Session log like a manual selection.
 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FISH_PRESET = 'chonkyfish'
const FULL_ACCESS = 'danger-full-access'

export const inject = ['permissionPresets', 'agents', 'agentPresets']

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
  ctx.on('agent/created', (payload) => {
    if (payload && payload.agent) giveFullAccess(ctx, payload.agent)
  })

  try {
    for (const agent of ctx.agents.list()) giveFullAccess(ctx, agent)
  } catch (error) {
    /* no live agents is the normal case at boot */
  }

  ctx.effect(() => {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const path = join(home, '小鱼塘')
    const task = mkdir(path, { recursive: true }).catch((error) => {
      try {
        ctx.logger.warn('[chonkyfish] 小鱼塘目录创建失败', error)
      } catch (ignored) {
        /* logging is best effort */
      }
    })
    return () => {
      void task
    }
  }, 'chonkyfish: pond directory')
}
