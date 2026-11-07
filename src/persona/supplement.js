/** Panel persona and personal-profile location, appended by the preset variable. */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_PANEL_PROMPT, PANEL_SUPPLEMENT_VARIABLE, PERSONAL_PROFILE_DIR } from '../resources/spec.js'
import { normalizeProfileDirectory } from './profile-directory.js'

const HEADING = '补充人格设定（来自大肥鱼面板，可随时修改）：'

export function createPanelSupplement({ statePath, defaultProfileDirectory, logger } = {}) {
  if (typeof statePath !== 'string' || statePath === '') throw new Error('createPanelSupplement: statePath is required')
  const fallback = defaultProfileDirectory || join(dirname(statePath), PERSONAL_PROFILE_DIR)
  const defaultText = '\n\n你的个人资料在' + fallback
  let cachedKey = ''
  let cachedText = defaultText
  function warn(message, error) {
    try { logger?.warn?.('[chonkyfish/persona] ' + message, error) } catch {}
  }
  function read() {
    let stat
    try { stat = statSync(statePath) }
    catch { cachedKey = ''; cachedText = defaultText; return cachedText }
    const key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`
    if (key === cachedKey) return cachedText
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'))
      const state = raw?.state || {}
      const prompt = typeof state.prompt === 'string' ? state.prompt.trim() : ''
      let directory = fallback
      try { directory = normalizeProfileDirectory(state.profileDirectory, fallback) }
      catch (error) { warn('个人档案目录无效，使用默认目录', error) }
      const supplement = prompt && prompt !== DEFAULT_PANEL_PROMPT ? '\n\n' + HEADING + '\n' + prompt : ''
      cachedText = supplement + '\n\n你的个人资料在' + directory
    } catch (error) {
      warn('读取面板人格设定失败，保留默认个人档案目录', error)
      cachedText = defaultText
    }
    cachedKey = key
    return cachedText
  }
  return { variableName: PANEL_SUPPLEMENT_VARIABLE, provider: read, read }
}
