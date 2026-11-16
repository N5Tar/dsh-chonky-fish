import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { initialHelloState } from '../../../../core/modules/hello/schema.js'
import { createHelloRepository } from './repository.js'

// Called before ensureLayout or any background module creates default files.
// Persist the new-install draft first, so a restart before opening the UI cannot
// mistake those generated files for evidence of an existing installation.
export async function initializeHelloInstallation({ resources, syncDirectory }) {
  const store = createHelloRepository({ path: resources.paths.hello, syncDirectory })
  const state = await store.read()
  async function hasData(path) {
    let info
    try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    // A link or special entry is pre-existing data; never follow it or classify
    // it as a clean install. Empty directories alone are not evidence.
    if (!info.isDirectory()) return true
    for (const name of await readdir(path)) if (await hasData(join(path, name))) return true
    return false
  }
  if (state) {
    if (state.installationVersion === 1) return state.entryKind === 'existing'
    // Old clients let users bypass onboarding. Do not trap those users on
    // upgrade, but never retire an actual interrupted setup operation.
    if (state.entryKind === 'new' && state.status === 'draft' && !state.operations.some(op => ['applying', 'partial'].includes(op.status))) {
      for (const key of ['state', 'diary', 'skills', 'personalProfile', 'workspace', 'perceptionPreferences', 'socialConfig', 'socialBindings', 'socialPeerBindings']) {
        if (await hasData(resources.paths[key])) { state.entryKind = 'existing'; break }
      }
    }
    const revision = state.revision
    state.installationVersion = 1; state.revision++
    await store.write(state, revision)
    return state.entryKind === 'existing'
  }
  for (const key of ['config', 'state', 'proactive', 'events', 'tasks', 'abs', 'skills', 'diary', 'personalProfile', 'perceptionPreferences', 'social', 'workspace']) {
    if (await hasData(resources.paths[key])) return true
  }
  await store.write(initialHelloState({ abs: resources.spec.DEFAULT_CONFIG.abs }), null)
  return false
}
