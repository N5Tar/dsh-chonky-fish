import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createResources } from '../../../../app/shared/resources/index.js'
import { createMigrationService } from '../core.js'
import { createMigrationRepository } from '../../../../app/shared/storage/migration/repository.js'
import * as archiveCodec from '../../../../app/shared/storage/migration/archive.js'

const temporary = await mkdtemp(join(tmpdir(), 'chonkyfish-migration-'))
try {
  const resources = createResources({ homeRoot: temporary })
  await resources.ensureLayout()
  await writeFile(resources.paths.state, JSON.stringify({ version: 1, state: { name: '鲸鱼', prompt: '人格', profileDirectory: '/old/path', balance: 73, ledger: [{ id: 1, title: '投喂', amount: 3, date: '今天' }], messages: [{ role: 'fish', text: '不迁移' }], other: 'preserve' } }))
  await mkdir(resources.paths.diary, { recursive: true })
  await writeFile(join(resources.paths.diary, '2026-11-11.md'), '今天写下了鱼鱼的日记。')
  await mkdir(resources.paths.skills, { recursive: true })
  await writeFile(join(resources.paths.skills, 'demo.json'), JSON.stringify({ format: 1, skillId: 'demo', title: 'Demo', description: 'Demo skill', snapshots: [{ revision: 1, action: 'create', reason: 'Initial', createdAt: '2026-11-11T00:00:00.000Z', guide: 'Guide', experiences: [] }] }))
  await mkdir(resources.paths.personalProfile, { recursive: true })
  await writeFile(join(resources.paths.personalProfile, 'about.md'), '主人资料')
  await mkdir(join(resources.paths.personalProfile, 'browser-profile', 'Default', 'Cache'), { recursive: true })
  await writeFile(join(resources.paths.personalProfile, 'browser-profile', 'Default', 'Cache', 'state.bin'), 'must not migrate')
  const repository = createMigrationRepository({ resources })
  const service = createMigrationService({ resources, storage: repository, archiveCodec, pluginVersion: 'test' })
  const exported = await service.prepareExport()
  const archive = await service.download(exported.exportId)
  const entries = archiveCodec.readZip(archive)
  assert(entries.has('manifest.json'))
  assert.equal(entries.get('profile/about.md').toString(), '主人资料')
  assert.equal(entries.has('profile/browser-profile/Default/Cache/state.bin'), false)
  assert.equal(exported.sections.profile, 1)
  assert.equal(JSON.parse(entries.get('identity.json')).name, '鲸鱼')
  assert.equal(exported.sections.diaries, 1)
  const exportRacePath = join(resources.paths.diary, '2026-11-13.md')
  const originalReadDirectory = repository.readDirectory.bind(repository)
  repository.readDirectory = async (...args) => {
    const result = await originalReadDirectory(...args)
    if (args[1] === 'profile') await writeFile(exportRacePath, 'external edit during export')
    return result
  }
  await assert.rejects(() => service.prepareExport(), error => error.code === 'STALE_TARGET')
  repository.readDirectory = originalReadDirectory
  await rm(exportRacePath, { force: true })

  // Legacy partial preferences are normalized; malformed source wallet data fails closed.
  const schemaHome = join(temporary, 'schema-test')
  const schemaResources = createResources({ homeRoot: schemaHome })
  await schemaResources.ensureLayout()
  await writeFile(schemaResources.paths.config, JSON.stringify({ version: 1, diary: { enabled: true } }))
  await writeFile(schemaResources.paths.state, JSON.stringify({ version: 1, state: { balance: 'not-a-number', ledger: [] } }))
  const schemaRepo = createMigrationRepository({ resources: schemaResources, beforeExclusive: () => schemaResources.waitForMigrationWrites() })
  const schemaService = createMigrationService({ resources: schemaResources, storage: schemaRepo, archiveCodec, pluginVersion: 'test' })
  await assert.rejects(() => schemaService.prepareExport(), error => error.code === 'INVALID_DATA')
  await writeFile(schemaResources.paths.state, JSON.stringify({ version: 1, state: { name: 'Legacy fish' } }))
  for (const invalidConfig of [
    { version: 1, diary: { maxContentChars: -1 } },
    { version: 1, eventEngine: { extractTickMs: 'bad' } },
    { version: 1, abs: { restHours: { start: '99:00' } } },
  ]) {
    await writeFile(schemaResources.paths.config, JSON.stringify(invalidConfig))
    await assert.rejects(() => schemaService.prepareExport(), error => error.code === 'INVALID_DATA')
  }
  await writeFile(schemaResources.paths.config, JSON.stringify({ version: 1, diary: { enabled: true }, eventEngine: { extractBatch: 2 } }))
  let releaseConfigWrite, configWriteStarted
  const configWriteReady = new Promise(resolve => { configWriteStarted = resolve })
  const pendingConfigWrite = schemaResources.withMigrationWrite(async () => {
    configWriteStarted()
    await new Promise(resolve => { releaseConfigWrite = resolve })
    await writeFile(schemaResources.paths.config, JSON.stringify({ version: 1, diary: { enabled: true }, eventEngine: { extractBatch: 7 } }))
  })
  await configWriteReady
  const pendingExport = schemaService.prepareExport()
  await Promise.resolve()
  releaseConfigWrite()
  await pendingConfigWrite
  const schemaExport = await pendingExport
  const schemaArchive = await schemaService.download(schemaExport.exportId)
  const schemaEntries = archiveCodec.readZip(schemaArchive)
  const exportedPreferences = JSON.parse(schemaEntries.get('preferences.json').toString('utf8'))
  assert.equal(exportedPreferences.diary.enabled, true)
  assert.equal(exportedPreferences.eventEngine.extractBatch, 7)
  const badPreferenceEntries = new Map(schemaEntries)
  const badPreferences = JSON.parse(badPreferenceEntries.get('preferences.json').toString('utf8'))
  badPreferences.skills.extractBatch = 3
  const badPreferenceBytes = Buffer.from(JSON.stringify(badPreferences))
  badPreferenceEntries.set('preferences.json', badPreferenceBytes)
  const badPreferenceManifest = JSON.parse(badPreferenceEntries.get('manifest.json').toString('utf8'))
  const preferenceRecord = badPreferenceManifest.files.find(item => item.path === 'preferences.json')
  preferenceRecord.bytes = badPreferenceBytes.length
  preferenceRecord.sha256 = archiveCodec.sha256(badPreferenceBytes)
  badPreferenceEntries.set('manifest.json', Buffer.from(JSON.stringify(badPreferenceManifest)))
  await assert.rejects(() => schemaService.inspect(archiveCodec.createZip([...badPreferenceEntries])), error => error.code === 'INVALID_DATA')

  // The browser runtime is preserved but not traversed or hashed as migration data.
  const runtimeHome = join(temporary, 'runtime-fingerprint-test')
  const runtimeResources = createResources({ homeRoot: runtimeHome })
  await runtimeResources.ensureLayout()
  await mkdir(runtimeResources.paths.personalProfile, { recursive: true })
  const externalRuntime = join(runtimeHome, 'external-browser-runtime')
  await mkdir(externalRuntime, { recursive: true })
  await writeFile(join(externalRuntime, 'cache.db'), 'runtime bytes')
  await symlink(externalRuntime, join(runtimeResources.paths.personalProfile, 'browser-profile'))
  const runtimeRepo = createMigrationRepository({ resources: runtimeResources })
  const runtimeFingerprint = await runtimeRepo.fingerprintTarget()
  await writeFile(join(externalRuntime, 'cache.db'), 'changed active cache')
  assert.equal(await runtimeRepo.fingerprintTarget(), runtimeFingerprint)

  // Import onto a target with conflicting data, then verify whole-set replacement.
  await writeFile(join(resources.paths.diary, '2026-11-10.md'), 'new-machine only')
  const racingDiary = join(resources.paths.diary, '2026-11-12.md')
  const readDirectory = repository.readDirectory.bind(repository)
  let mutateDuringCollect = true
  repository.readDirectory = async (...args) => {
    const result = await readDirectory(...args)
    if (args[1] === 'profile' && mutateDuringCollect) {
      mutateDuringCollect = false
      await writeFile(racingDiary, 'concurrent external write')
    }
    return result
  }
  await assert.rejects(() => service.inspect(archive), error => error.code === 'STALE_TARGET')
  repository.readDirectory = readDirectory
  await rm(racingDiary, { force: true })

  const preview = await service.inspect(archive)
  assert.equal(preview.sections.skills, 1)
  await writeFile(racingDiary, 'changed after preview')
  await assert.rejects(() => service.commit(preview.importId), error => error.code === 'STALE_TARGET')
  await rm(racingDiary, { force: true })
  const confirmedPreview = await service.inspect(archive)
  await service.commit(confirmedPreview.importId)
  await service.commit(confirmedPreview.importId) // duplicate confirmation is idempotent
  const wrapper = JSON.parse(await readFile(resources.paths.state, 'utf8'))
  assert.equal(wrapper.generation, 1)
  const state = JSON.parse(await readFile(resources.paths.state, 'utf8')).state
  assert.equal(state.name, '鲸鱼')
  assert.equal(state.balance, 73)
  assert.equal(state.profileDirectory, resources.paths.personalProfile)
  assert.equal(state.messages[0].text, '不迁移')
  assert.equal(state.other, 'preserve')
  assert.deepEqual((await repository.readDirectory(resources.paths.diary, 'diaries', 10)).size, 1)
  assert.equal(await readFile(join(resources.paths.personalProfile, 'browser-profile', 'Default', 'Cache', 'state.bin'), 'utf8'), 'must not migrate')
  assert.equal(resources.getConfig().abs.mode, 'shadow')
  assert.equal(resources.getConfig().proactive.enabled, false)
  assert.equal(resources.getConfig().perception.enabled, false)

  await assert.rejects(() => service.inspect(Buffer.from('not zip')))
  await assert.rejects(() => service.inspect(archiveCodec.createZip([['../escape.txt', Buffer.from('escape')]])))
  const malicious = archiveCodec.readZip(archive)
  const manifest = JSON.parse(malicious.get('manifest.json').toString('utf8'))
  const browserPayload = Buffer.from('should never be imported')
  manifest.sections.profile += 1
  manifest.files.push({ path: 'profile/browser-profile/leak.bin', bytes: browserPayload.length, sha256: archiveCodec.sha256(browserPayload) })
  malicious.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  malicious.set('profile/browser-profile/leak.bin', browserPayload)
  await assert.rejects(() => service.inspect(archiveCodec.createZip([...malicious])), error => error.code === 'UNSAFE_PATH')

  const recoveryHome = join(temporary, 'recovery-test')
  const recoveryResources = createResources({ homeRoot: recoveryHome })
  await recoveryResources.ensureLayout()
  const recoveryRepository = createMigrationRepository({ resources: recoveryResources })
  const txDir = join(recoveryResources.paths.migration, 'transactions', 'interrupted')
  const stage = join(txDir, 'stage', '2'), backup = join(txDir, 'backup', '2')
  await mkdir(stage, { recursive: true }); await mkdir(backup, { recursive: true })
  await writeFile(join(backup, 'old-profile.md'), 'before import')
  await mkdir(join(recoveryResources.paths.personalProfile, 'browser-profile', 'Default'), { recursive: true })
  await writeFile(join(recoveryResources.paths.personalProfile, 'new-profile.md'), 'staged import')
  await writeFile(join(recoveryResources.paths.personalProfile, 'browser-profile', 'Default', 'Preferences'), 'existing browser profile')
  await writeFile(join(txDir, 'transaction.json'), JSON.stringify({
    phase: 'publishing', id: 'interrupted', targets: [{ target: recoveryResources.paths.personalProfile, stage, backup, existed: true, preserve: ['browser-profile'] }],
  }))
  await recoveryRepository.recover()
  assert.equal(await readFile(join(recoveryResources.paths.personalProfile, 'old-profile.md'), 'utf8'), 'before import')
  assert.equal(await readFile(join(recoveryResources.paths.personalProfile, 'browser-profile', 'Default', 'Preferences'), 'utf8'), 'existing browser profile')
  await assert.rejects(() => readFile(join(recoveryResources.paths.personalProfile, 'new-profile.md'), 'utf8'), error => error.code === 'ENOENT')
  const outsideMarker = join(recoveryHome, 'outside-marker.txt')
  await writeFile(outsideMarker, 'must remain untouched')
  const unsafeTx = join(recoveryResources.paths.migration, 'transactions', 'unsafe-journal')
  const unsafeStage = join(unsafeTx, 'stage', '2', '..', '..', '..', 'outside-marker.txt')
  await mkdir(unsafeTx, { recursive: true })
  await writeFile(join(unsafeTx, 'transaction.json'), JSON.stringify({
    phase: 'publishing', id: 'unsafe-journal', targets: [{ target: recoveryResources.paths.personalProfile, stage: unsafeStage, backup: join(unsafeTx, 'backup', '2'), existed: true, preserve: [] }],
  }))
  await assert.rejects(() => recoveryRepository.recover(), error => error.code === 'RECOVERY_REQUIRED')
  assert.equal(await readFile(outsideMarker, 'utf8'), 'must remain untouched')

  const crashChild = fileURLToPath(new URL('./crash-child.mjs', import.meta.url))
  const crashPoints = [
    ['journal-prepared', null, false], ['journal-staged', null, false], ['journal-publishing', null, false],
    ['target-backed-up', 'state', false], ['runtime-preserved', 'personalProfile', false],
    ['target-published', 'personalProfile', false], ['all-targets-published', null, false],
    ['commit-marker', null, true],
  ]
  for (const [point, targetKey, committed] of crashPoints) {
    const crashHome = join(temporary, `crash-${point}-${targetKey || 'all'}`)
    const crashResources = createResources({ homeRoot: crashHome })
    await crashResources.ensureLayout()
    const oldState = '{"version":1,"state":{"name":"Original"}}\n'
    const oldConfig = await readFile(crashResources.paths.config, 'utf8')
    await writeFile(crashResources.paths.state, oldState)
    await mkdir(join(crashResources.paths.personalProfile, 'browser-profile', 'Default'), { recursive: true })
    await writeFile(join(crashResources.paths.personalProfile, 'about.md'), 'original profile')
    await writeFile(join(crashResources.paths.personalProfile, 'browser-profile', 'Default', 'Preferences'), 'runtime profile')
    const child = spawnSync(process.execPath, [crashChild, crashHome, point, targetKey || ''], { encoding: 'utf8' })
    assert.equal(child.status, 86, `${point} child failed: ${child.stderr || child.stdout}`)
    await createMigrationRepository({ resources: crashResources }).recover()
    if (committed) {
      assert.match(await readFile(crashResources.paths.state, 'utf8'), /Imported/)
      assert.match(await readFile(crashResources.paths.config, 'utf8'), /imported/)
      assert.equal(await readFile(join(crashResources.paths.personalProfile, 'imported-profile.md'), 'utf8'), 'imported')
    } else {
      assert.equal(await readFile(crashResources.paths.state, 'utf8'), oldState)
      assert.equal(await readFile(crashResources.paths.config, 'utf8'), oldConfig)
      assert.equal(await readFile(join(crashResources.paths.personalProfile, 'about.md'), 'utf8'), 'original profile')
      await assert.rejects(() => readFile(join(crashResources.paths.personalProfile, 'imported-profile.md'), 'utf8'), error => error.code === 'ENOENT')
    }
    assert.equal(await readFile(join(crashResources.paths.personalProfile, 'browser-profile', 'Default', 'Preferences'), 'utf8'), 'runtime profile')
  }

  const missingJournalHome = join(temporary, 'crash-missing-journal')
  const missingResources = createResources({ homeRoot: missingJournalHome })
  await missingResources.ensureLayout()
  const missingOldState = '{"version":1,"state":{"name":"MustRecover"}}\n'
  await writeFile(missingResources.paths.state, missingOldState)
  await mkdir(missingResources.paths.personalProfile, { recursive: true })
  const missingChild = spawnSync(process.execPath, [crashChild, missingJournalHome, 'target-backed-up', 'state'], { encoding: 'utf8' })
  assert.equal(missingChild.status, 86, missingChild.stderr || missingChild.stdout)
  const missingTx = join(missingResources.paths.migration, 'transactions', 'crash-fixture')
  await unlink(join(missingTx, 'transaction.json'))
  await assert.rejects(() => createMigrationRepository({ resources: missingResources }).recover(), error => error.code === 'RECOVERY_REQUIRED')
  await assert.rejects(() => readFile(missingResources.paths.state, 'utf8'), error => error.code === 'ENOENT')
  assert.equal(await readFile(join(missingTx, 'backup', '0'), 'utf8'), missingOldState)

  console.log('migration export/inspect/replace, stale-target, profile-preservation and crash-recovery tests passed')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
