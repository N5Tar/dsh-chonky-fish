/** Read panel persona and profile location once; render them through separate prompt variables. */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_PANEL_PROMPT, PANEL_SUPPLEMENT_VARIABLE, PERSONAL_PROFILE_DIR } from '../../contracts/spec.js'
import { normalizeProfileDirectory } from './profile-directory.js'

const HEADING = '补充人格设定（来自大肥鱼面板，可随时修改）：'

export function createPanelSupplement({ statePath, defaultProfileDirectory, logger, isMigrationBusy = () => false } = {}) {
  if (typeof statePath !== 'string' || statePath === '') throw new Error('createPanelSupplement: statePath is required')
  const fallback = defaultProfileDirectory || join(dirname(statePath), PERSONAL_PROFILE_DIR)
  const defaults = Object.freeze({ prompt: '', profileDirectory: fallback })
  let cachedKey = ''
  let cachedState = defaults
  let wasMigrationBusy = false
  function warn(message, error) {
    try { logger?.warn?.('[chonkyfish/persona] ' + message, error) } catch {}
  }
  function readState() {
    if (isMigrationBusy()) { wasMigrationBusy = true; return cachedState }
    if (wasMigrationBusy) { cachedKey = ''; wasMigrationBusy = false }
    let stat
    try { stat = statSync(statePath) }
    catch { cachedKey = ''; cachedState = defaults; return cachedState }
    const key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`
    if (key === cachedKey) return cachedState
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'))
      const state = raw?.state || {}
      const prompt = typeof state.prompt === 'string' ? state.prompt.trim() : ''
      let profileDirectory = fallback
      try { profileDirectory = normalizeProfileDirectory(state.profileDirectory, fallback) }
      catch (error) { warn('个人档案目录无效，使用默认目录', error) }
      cachedState = Object.freeze({ prompt: prompt !== DEFAULT_PANEL_PROMPT ? prompt : '', profileDirectory })
    } catch (error) {
      warn('读取面板人格设定失败，保留默认个人档案目录', error)
      cachedState = defaults
    }
    cachedKey = key
    return cachedState
  }
  function read() {
    const { prompt } = readState()
    return prompt ? '\n\n' + HEADING + '\n' + prompt : ''
  }
  return { variableName: PANEL_SUPPLEMENT_VARIABLE, provider: read, read, readState }
}
