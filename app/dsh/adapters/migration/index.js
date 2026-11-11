import { createMigrationService } from '../../../../core/modules/migration/core.js'
import { createMigrationRepository } from '../../../shared/storage/migration/repository.js'
import { registerMigrationRoutes } from './http.js'
import * as archiveCodec from '../../../shared/storage/migration/archive.js'

export function installMigration(ctx, { resources, ready = Promise.resolve(), pluginVersion = '0.0.0', beforeExclusive, beforePublish, onExclusive, onCommitted }) {
  let closed = false
  const repository = createMigrationRepository({ resources, beforeExclusive, beforePublish, onExclusive, onCommitted })
  const service = createMigrationService({ resources, storage: repository, archiveCodec, pluginVersion })
  const dispose = ctx.webServer ? registerMigrationRoutes(ctx, { service, resources, ready, isClosed: () => closed }) : () => {}
  return { service, close() { if (closed) return; closed = true; dispose() } }
}
