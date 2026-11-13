import { DEFAULT_PANEL_PROMPT } from '../../contracts/spec.js'
import { validateTimeScale } from '../abs/clock.js'
import { validRestTime } from '../abs/rest.js'
export const HELLO_PRESET = Object.freeze({ id: 'existing-default', name: '大肥鱼默认人格', body: DEFAULT_PANEL_PROMPT, description: '沿用现有主预设及面板补充人格机制；不会替换主预设或覆盖已有设置。' })
export const clone = value => structuredClone(value)
export function fail(code, outcome = 'not_applied') { return Object.assign(new Error(code), { code, outcome }) }
export function keys(value, allowed) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw fail('HELLO_INVALID_DRAFT') }
export function validateDraft(draft, complete = false) {
  keys(draft, ['name', 'prompt', 'perceptionRequested', 'abs'])
  if (typeof draft.name !== 'string' || !draft.name.trim() || draft.name.length > 80 || /[\x00-\x1f]/.test(draft.name)) throw fail('HELLO_INVALID_NAME')
  if (typeof draft.prompt !== 'string' || Buffer.byteLength(draft.prompt) > 65536 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(draft.prompt)) throw fail('HELLO_INVALID_PROMPT')
  if (draft.perceptionRequested !== null && typeof draft.perceptionRequested !== 'boolean') throw fail('HELLO_INVALID_PERCEPTION')
  if (complete && draft.perceptionRequested === null) throw fail('HELLO_PERCEPTION_REQUIRED')
  keys(draft.abs, ['timeScale', 'restHours']); try { validateTimeScale(draft.abs.timeScale) } catch { throw fail('HELLO_INVALID_TIME_SCALE') }
  const rest = draft.abs.restHours; keys(rest, ['enabled', 'start', 'end'])
  if (typeof rest.enabled !== 'boolean' || !validRestTime(rest.start) || !validRestTime(rest.end) || rest.start === rest.end) throw fail('HELLO_INVALID_REST_HOURS')
  return draft
}
export function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.operations) || !['draft','applying','partial','completed'].includes(state.status)) throw fail('HELLO_CORRUPT_STATE')
  if (state.flowVersion !== 'hello-v1' || !['welcome','persona','perception','rhythm','review','done'].includes(state.step) || !['new','existing'].includes(state.entryKind) || !['not_started','skipped'].includes(state.dingtalk?.status) || state.operations.length > 128) throw fail('HELLO_CORRUPT_STATE')
  validateDraft(state.draft)
  for (const op of state.operations) {
    if (!op || typeof op.id !== 'string' || !op.input || !op.steps || !['applying','partial','completed','abandoned'].includes(op.status)) throw fail('HELLO_CORRUPT_STATE')
    validateDraft(op.input, true)
    for (const key of ['panel','abs','perception']) if (!['pending','applying','applied','failed','unknown'].includes(op.steps[key]?.status)) throw fail('HELLO_CORRUPT_STATE')
  }
  return state
}
