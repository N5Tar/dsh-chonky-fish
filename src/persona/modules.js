/** Module-owned prose, rendered inside the complete persona (not a separate system section). */
import { profilePrompt } from './profile-prompt.js'
import { perceptionPrompt } from '../perception/persona.js'
import { diaryPrompt } from '../diary/persona.js'
import { socialPrompt } from '../social/persona.js'
import { skillsPrompt } from '../skills/persona.js'

export const MODULES_VARIABLE = 'chonkyfish_modules'
// Add new module contributions here. ABS intentionally contributes no persona prose.
export const DEFAULT_PROMPT_MODULES = Object.freeze([
  profilePrompt, perceptionPrompt, diaryPrompt, socialPrompt, skillsPrompt,
])

const INTRO = '## 我自己的本事\n\n我不只是等主人说话、再回答的鱼。我也有自己留意的事情、经历过的日子、想去逛的地方，还有一点点摸索出来的本事。下面这些都是我平时会用到的能力，不用等主人每次提醒，想起来、用得上，就可以自己去看看、做做。'
const OUTRO = '这些本事会随着我的经历慢慢增加。需要查资料、看文件、运行命令时，其他工具也能帮上忙。做什么、用什么，跟着眼前的事情和自己的兴趣来，不必为了显得忙碌而找事做。'

export function createModulePrompt({ readContext, modules = DEFAULT_PROMPT_MODULES }) {
  const ids = new Set()
  const ordered = modules.map(module => {
    if (!module || typeof module.id !== 'string' || !module.id || ids.has(module.id)) throw new Error('Invalid or duplicate persona module id')
    if (typeof module.title !== 'string' || !module.title.trim() || !Number.isFinite(module.order) || typeof module.render !== 'function') throw new Error(`Invalid persona module: ${module.id}`)
    ids.add(module.id)
    return { ...module }
  }).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  function read() {
    const context = readContext()
    const sections = ordered.flatMap(module => {
      const text = module.render(context)
      if (text == null || text === '') return []
      if (typeof text !== 'string') throw new Error(`Invalid persona module text: ${module.id}`)
      return text.trim() ? [`### ${module.title}\n\n${text.trim()}`] : []
    })
    return sections.length ? '\n\n' + [INTRO, ...sections, OUTRO].join('\n\n') : ''
  }
  return { variableName: MODULES_VARIABLE, provider: read, read }
}
