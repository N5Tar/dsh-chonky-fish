import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createResources } from '../../../../app/shared/resources/index.js'
import { platform } from '../../../../app/shared/platform/index.js'
import { createHelloRepository } from '../../../../app/shared/storage/hello/repository.js'
import { initializeHelloInstallation } from '../../../../app/shared/storage/hello/installation.js'
import { createMigrationRepository } from '../../../../app/shared/storage/migration/repository.js'
import { createMigrationService } from '../../migration/core.js'
import * as archiveCodec from '../../../../app/shared/storage/migration/archive.js'
import { createHelloService } from '../service.js'
import { initialHelloState } from '../schema.js'
const root = await mkdtemp(join(tmpdir(), 'hello-install-'))
const init = resources => initializeHelloInstallation({ resources, syncDirectory: platform.syncDirectory })
try {
  const fresh = createResources({ homeRoot: join(root, 'fresh') })
  await mkdir(join(fresh.paths.diary, 'empty'), { recursive: true })
  assert.equal(await init(fresh), false)
  await fresh.ensureLayout()
  assert.equal(await init(fresh), false, 'restart before UI must remain a new installation')
  const store = createHelloRepository({ path: fresh.paths.hello, syncDirectory: platform.syncDirectory })
  assert.equal((await store.read()).entryKind, 'new')
  for (const key of ['state', 'config', 'perceptionPreferences', 'socialConfig', 'events', 'proactive']) {
    const r = createResources({ homeRoot: join(root, key) })
    await mkdir(join(r.paths[key], '..'), { recursive: true })
    await writeFile(r.paths[key], '{}')
    assert.equal(await init(r), true, key + ' identifies existing installations')
  }
  for (const key of ['diary', 'skills', 'personalProfile', 'workspace']) {
    const r = createResources({ homeRoot: join(root, key) })
    await mkdir(join(r.paths[key], 'nested'), { recursive: true })
    await writeFile(join(r.paths[key], 'nested', 'data'), 'legacy')
    assert.equal(await init(r), true, key + ' alone protects existing installations')
  }
  // Older versions allowed chat while a new/draft Hello record remained.
  for (const key of ['state', 'diary', 'skills', 'personalProfile', 'socialConfig', 'socialBindings', 'socialPeerBindings']) {
    const r = createResources({homeRoot:join(root,'legacy-draft-'+key)})
    const legacy = initialHelloState({abs:r.spec.DEFAULT_CONFIG.abs}); delete legacy.installationVersion
    const legacyStore = createHelloRepository({path:r.paths.hello,syncDirectory:platform.syncDirectory})
    await legacyStore.write(legacy,null); await r.ensureLayout()
    if(key==='state' || key.startsWith('social')) {await mkdir(join(r.paths[key],'..'),{recursive:true});await writeFile(r.paths[key],JSON.stringify({state:{balance:42,messages:[{text:'chat'}]}}))}
    else {await mkdir(r.paths[key],{recursive:true});await writeFile(join(r.paths[key],'saved-data'),'data')}
    assert.equal(await init(r),true,'legacy skipped draft with '+key+' is an existing user')
    assert.equal((await legacyStore.read()).entryKind,'existing')
  }
  const interrupted = createResources({homeRoot:join(root,'legacy-untouched')})
  const untouched = initialHelloState({abs:interrupted.spec.DEFAULT_CONFIG.abs}); delete untouched.installationVersion
  const untouchedStore=createHelloRepository({path:interrupted.paths.hello,syncDirectory:platform.syncDirectory})
  await untouchedStore.write(untouched,null); await interrupted.ensureLayout()
  assert.equal(await init(interrupted),false,'default config alone cannot retire a legacy new-install draft')

  const partial = await untouchedStore.read()
  delete partial.installationVersion; partial.status='partial'; partial.revision++
  partial.operations=[{id:'interrupted',status:'partial',input:{...partial.draft,perceptionRequested:false},steps:{panel:{status:'applied'},abs:{status:'unknown'},perception:{status:'pending'}}}]
  await untouchedStore.write(partial,partial.revision-1)
  await writeFile(interrupted.paths.state,JSON.stringify({state:{name:'partially saved'}}))
  assert.equal(await init(interrupted),false,'legacy partial setup retains recovery even with written panel data')
  assert.equal((await untouchedStore.read()).status,'partial')

  const abandoned = await untouchedStore.read()
  delete abandoned.installationVersion; abandoned.status='draft'; abandoned.operations[0].status='abandoned'; abandoned.revision++
  await untouchedStore.write(abandoned,abandoned.revision-1)
  assert.equal(await init(interrupted),true,'abandoned history is not a pending setup operation')

  const corrupt = createResources({ homeRoot: join(root, 'corrupt') })
  await mkdir(join(corrupt.paths.hello, ".."), { recursive: true }); await writeFile(corrupt.paths.hello, '{bad')
  await assert.rejects(init(corrupt), /HELLO_CORRUPT_STATE/)

  // Use an actual settings export, not a fake UI success signal.
  const source = createResources({ homeRoot: join(root, 'source') })
  await source.ensureLayout()
  await writeFile(source.paths.state, JSON.stringify({version:1,state:{name:'迁移的鱼',prompt:'原有人格',balance:73,ledger:[]}}))
  const sourceMigration = createMigrationService({resources:source,storage:createMigrationRepository({resources:source}),archiveCodec})
  const exported = await sourceMigration.prepareExport(), bytes = await sourceMigration.download(exported.exportId)
  const repo = createMigrationRepository({resources:fresh, onExclusive: v => fresh.setMigrationMaintenance(v), beforeExclusive: () => fresh.waitForMigrationWrites()})
  const migration = createMigrationService({resources:fresh,storage:repo,archiveCodec})
  assert.equal(await repo.readCommittedImport(), null)
  await assert.rejects(migration.inspect(Buffer.from('invalid')))
  assert.equal(await repo.readCommittedImport(), null)
  const preview = await migration.inspect(bytes)
  assert.equal(await repo.readCommittedImport(), null, 'preflight is not a committed import')
  await migration.commit(preview.importId)
  assert.equal(typeof await repo.readCommittedImport(), 'string')
  const restartedRepo = createMigrationRepository({resources:fresh})
  await restartedRepo.recover()
  let failWrite = true, writes = 0
  const service = createHelloService({
    store: {read:store.read, write:async (...args) => { if(failWrite) throw new Error('disk unavailable'); writes++; return store.write(...args) }},
    readCommittedImport: () => restartedRepo.readCommittedImport(),
    panel: {read:async()=>({generation:1,state:{name:'迁移的鱼',prompt:'原有人格'}}),patchIdentity:()=>assert.fail('import must not replay draft')},
    abs: {readSettings:async()=>({revision:0,...fresh.getConfig().abs}),updateSettings:()=>assert.fail('import must not apply setup')},
    perception: {inspect:async()=>({supported:false,requested:false,state:'unsupported'})},
  })
  await assert.rejects(service.bootstrap(), /disk unavailable/)
  failWrite = false
  assert.equal((await service.bootstrap()).state.status, 'completed')
  assert.equal((await service.bootstrap()).state.status, 'completed')
  assert.equal(writes, 1, 'completion recovery is idempotent')
  assert.equal((await store.read()).step, 'done')
  const pending = join(fresh.paths.migration,'transactions','pending')
  await mkdir(pending); await writeFile(join(pending,'transaction.json'),JSON.stringify({phase:'publishing',id:'pending'}))
  await assert.rejects(restartedRepo.readCommittedImport(), /RECOVERY_REQUIRED/, 'incomplete newer transaction cannot be treated as committed')
  console.log('Hello installation: clean/legacy/restart/import/recovery passed')
} finally { await rm(root,{recursive:true,force:true}) }
