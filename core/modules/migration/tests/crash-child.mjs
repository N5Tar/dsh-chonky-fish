import { createResources } from '../../../../app/shared/resources/index.js'
import { createMigrationRepository } from '../../../../app/shared/storage/migration/repository.js'

const [homeRoot, checkpoint, targetKey] = process.argv.slice(2)
const resources = createResources({ homeRoot })
await resources.ensureLayout()
const targetPaths = {
  state: resources.paths.state,
  config: resources.paths.config,
  personalProfile: resources.paths.personalProfile,
}
const repository = createMigrationRepository({
  resources,
  faultInjector(label, context) {
    const key = Object.keys(targetPaths).find(name => targetPaths[name] === context?.target)
    if (label === checkpoint && (!targetKey || targetKey === key)) process.exit(86)
  },
})
const plan = new Map([
  [resources.paths.state, { kind: 'file', content: Buffer.from('{"version":1,"state":{"name":"Imported"}}\n') }],
  [resources.paths.config, { kind: 'file', content: Buffer.from('{"version":1,"marker":"imported"}\n') }],
  [resources.paths.personalProfile, { kind: 'directory', files: new Map([['imported-profile.md', Buffer.from('imported')]]) }],
])
await repository.commitPlan('crash-fixture', plan, await repository.fingerprintTarget())
process.exit(0)
