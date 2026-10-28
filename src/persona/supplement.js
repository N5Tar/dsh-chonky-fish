/**
 * 大肥鱼 · 面板「补充人格设定」→ system prompt 变量（Host 侧）。
 *
 * 面板把补充人格设定保存在 home 下的 state.json；这个模块把它作为
 * **system prompt 变量** 提供给预设里的 persona 模板
 * （`{{chonkyfish_supplement}}`），而不是把它塞进用户消息。
 *
 *   - 变量 provider 在每次 prompt assembly 时调用，读 state.json（按 mtime 缓存）；
 *   - 值为空、等于默认文案或文件暂时不可读时返回 ''，模板渲染时该行自然消失；
 *   - 不抛错：系统提示词组装失败会拖垮整个会话，读文件失败只当没有补充。
 */
import { readFileSync, statSync } from 'node:fs'

import { DEFAULT_PANEL_PROMPT, PANEL_SUPPLEMENT_VARIABLE } from '../resources/spec.js'

const HEADING = '补充人格设定（来自大肥鱼面板，可随时修改）：'

/**
 * @param {{ statePath: string, logger?: { warn?: (...args: any[]) => void } }} options
 */
export function createPanelSupplement({ statePath, logger } = {}) {
  if (typeof statePath !== 'string' || statePath === '') {
    throw new Error('createPanelSupplement: statePath is required')
  }

  let cachedMtimeMs = -1
  let cachedText = ''

  function warn(message, error) {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn('[chonkyfish/persona] ' + message, error)
    } catch (ignored) {
      /* logging is best effort */
    }
  }

  /** 读 state.json 里的 state.prompt；默认/空值视为「没有补充」。 */
  function read() {
    let stat
    try {
      stat = statSync(statePath)
    } catch (error) {
      cachedMtimeMs = -1
      cachedText = ''
      return ''
    }
    if (stat.mtimeMs === cachedMtimeMs) return cachedText

    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'))
      const prompt = raw && raw.state && typeof raw.state.prompt === 'string' ? raw.state.prompt.trim() : ''
      cachedText = prompt !== '' && prompt !== DEFAULT_PANEL_PROMPT ? '\n\n' + HEADING + '\n' + prompt : ''
    } catch (error) {
      warn('读取面板补充人格设定失败（本轮跳过）', error)
      cachedText = ''
    }
    cachedMtimeMs = stat.mtimeMs
    return cachedText
  }

  return {
    variableName: PANEL_SUPPLEMENT_VARIABLE,
    /** system prompt 变量 provider；必须同步返回字符串。 */
    provider: read,
    read,
  }
}
