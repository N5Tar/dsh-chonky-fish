import { randomUUID } from 'node:crypto'
import { assertSkillArchive, MIGRATION_FORMAT, MIGRATION_SECTIONS, MIGRATION_VERSION, mergeMigrationPreferences, projectPreferences, validateDiaryPath, validateIdentity, validatePreferences, validateWallet, migrationFail } from './policy.js'

const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const isObject = value => value && typeof value === 'object' && !Array.isArray(value)
const error = (code, message = code) => migrationFail(code, message)

function validateArchive(entries, pluginVersion, archiveCodec) {
  const manifestBytes = entries.get('manifest.json')
  if (!manifestBytes) error('INVALID_ARCHIVE')
  if (manifestBytes.length > 4 * 1024 * 1024) error('LIMIT_EXCEEDED')
  const manifest = archiveCodec.parseJson(manifestBytes)
  if (!isObject(manifest) || manifest.format !== MIGRATION_FORMAT || manifest.version !== MIGRATION_VERSION) error(manifest?.format === MIGRATION_FORMAT ? 'UNSUPPORTED_VERSION' : 'INVALID_ARCHIVE')
  if (!isObject(manifest.sections) || MIGRATION_SECTIONS.some(key => !Number.isSafeInteger(manifest.sections[key]) || manifest.sections[key] < 0)) error('INVALID_ARCHIVE')
  if (!Array.isArray(manifest.files)) error('INVALID_ARCHIVE')
  const listed = new Map()
  for (const item of manifest.files) {
    if (!isObject(item) || typeof item.path !== 'string' || !Number.isSafeInteger(item.bytes) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || listed.has(item.path)) error('INVALID_ARCHIVE')
    listed.set(item.path, item)
  }
  if (listed.size !== entries.size - 1) error('INVALID_ARCHIVE')
  for (const [path, buffer] of entries) {
    if (path === 'manifest.json') continue
    const item = listed.get(path)
    if (!item || item.bytes !== buffer.length || item.sha256 !== archiveCodec.sha256(buffer)) error('INVALID_ARCHIVE')
  }
  const required = ['identity.json', 'wallet.json', 'preferences.json']
  if (required.some(path => !entries.has(path))) error('INVALID_ARCHIVE')
  const identity = validateIdentity(archiveCodec.parseJson(entries.get('identity.json')))
  const wallet = validateWallet(archiveCodec.parseJson(entries.get('wallet.json')))
  const preferences = validatePreferences(archiveCodec.parseJson(entries.get('preferences.json')))
  const profile = new Map(), diaries = new Map(), skills = new Map()
  for (const [path, buffer] of entries) {
    if (path === 'manifest.json') continue
    if (buffer.length > 16 * 1024 * 1024) error('LIMIT_EXCEEDED')
    if (path.startsWith('profile/')) {
      const name = path.slice(8)
      if (!name || name.split('/').some(part => !part || part.startsWith('.') || part === '..') || name.split('/')[0].toLowerCase() === 'browser-profile') error('UNSAFE_PATH')
      profile.set(name, buffer)
    } else if (path.startsWith('diaries/')) {
      const name = path.slice(8); validateDiaryPath(name); diaries.set(name, buffer)
      if (buffer.length > 16 * 1024 * 1024) error('LIMIT_EXCEEDED')
    } else if (path.startsWith('skills/')) {
      const name = path.slice(7)
      if (!/^[a-z][a-z0-9-]{0,63}\.json$/.test(name)) error('UNSAFE_PATH')
      const skill = assertSkillArchive(archiveCodec.parseJson(buffer))
      if (skill.skillId + '.json' !== name) error('INVALID_DATA')
      skills.set(name, buffer)
    } else if (!required.includes(path)) error('INVALID_ARCHIVE')
  }
  if (skills.size > 128) error('LIMIT_EXCEEDED')
  for (const key of MIGRATION_SECTIONS) {
    const actual = key === 'identity' || key === 'wallet' || key === 'preferences' ? 1 : key === 'profile' ? profile.size : key === 'diaries' ? diaries.size : skills.size
    if (manifest.sections[key] !== actual) error('INVALID_ARCHIVE')
  }
  return { manifest, identity, wallet, preferences, profile, diaries, skills, pluginVersion }
}

async function readRegular(file, maxBytes) {
  const { lstat, readFile } = await import('node:fs/promises')
  try {
    const st = await lstat(file)
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > maxBytes) error('UNSAFE_PATH')
    return await readFile(file)
  } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}

export function createMigrationService({ resources, storage, archiveCodec, pluginVersion = '0.0.0', now = () => new Date() }) {
  const operations = new Map()
  function pruneExpired() { for (const [id, operation] of operations) if (operation.expiresAt < Date.now() && !operation.done) operations.delete(id) }
  async function collect() {
    const stateRaw = await readRegular(resources.paths.state, 8 * 1024 * 1024)
    let stateWrap = { version: 1, state: {} }
    if (stateRaw) {
      try { stateWrap = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stateRaw)) } catch { error('INVALID_DATA') }
      if (!isObject(stateWrap) || !isObject(stateWrap.state)) error('INVALID_DATA')
    }
    const state = stateWrap.state
    const configRaw = await readRegular(resources.paths.config, 4 * 1024 * 1024)
    let config
    try { config = configRaw ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configRaw)) : resources.getConfig() } catch { error('INVALID_DATA') }
    if (!isObject(config)) error('INVALID_DATA')
    const identity = validateIdentity({
      name: Object.hasOwn(state, 'name') ? state.name : '大肥鱼',
      prompt: Object.hasOwn(state, 'prompt') ? state.prompt : '',
    })
    const wallet = validateWallet({
      balance: Object.hasOwn(state, 'balance') ? state.balance : 0,
      ledger: Object.hasOwn(state, 'ledger') ? state.ledger : [],
    })
    const payload = new Map([
      ['identity.json', json(identity)],
      ['wallet.json', json(wallet)],
      ['preferences.json', json(validatePreferences(projectPreferences(config)))],
    ])
    const files = await storage.readDirectory(resources.paths.personalProfile, 'profile', 10000)
    for (const [name, bytes] of files) payload.set(name, bytes)
    const diaryFiles = await storage.readDirectory(resources.paths.diary, 'diaries', 10000, /^\d{4}-\d{2}-\d{2}\.md$/)
    for (const [name, bytes] of diaryFiles) { validateDiaryPath(name.slice(8)); payload.set(name, bytes) }
    const skillFiles = await storage.readDirectory(resources.paths.skills, 'skills', 128, /^[a-z][a-z0-9-]{0,63}\.json$/)
    for (const [name, bytes] of skillFiles) { assertSkillArchive(archiveCodec.parseJson(bytes)); payload.set(name, bytes) }
    return { payload, stateWrap, config, counts: { identity: 1, wallet: 1, profile: files.size, diaries: diaryFiles.size, skills: skillFiles.size, preferences: 1 } }
  }
  async function prepareExport() {
    pruneExpired()
    const snapshot = await storage.withExclusive(async () => {
      const before = await storage.fingerprintTarget()
      const collected = await collect()
      if (before !== await storage.fingerprintTarget()) error('STALE_TARGET')
      return collected
    })
    const files = [...snapshot.payload].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: archiveCodec.sha256(bytes) }))
    const sections = snapshot.counts
    const manifest = { format: MIGRATION_FORMAT, version: MIGRATION_VERSION, createdAt: now().toISOString(), pluginVersion, sections, files, warnings: ['custom-profile-path-not-included', 'browser-profile-excluded', 'autonomous-actions-disabled-on-import'] }
    const entries = [['manifest.json', json(manifest)], ...snapshot.payload]
    const archive = archiveCodec.createZip(entries)
    if (archive.length > resources.limits.migrationArchiveBytes) error('LIMIT_EXCEEDED')
    const id = randomUUID()
    operations.set(id, { type: 'export', expiresAt: Date.now() + 10 * 60 * 1000, archive, counts: sections })
    return { exportId: id, bytes: archive.length, sections, expiresInMs: 600000, warnings: manifest.warnings }
  }

  async function inspect(buffer) {
    pruneExpired()
    const entries = archiveCodec.readZip(buffer)
    const data = validateArchive(entries, pluginVersion, archiveCodec)
    const prepared = await storage.withExclusive(async () => {
      const before = await storage.fingerprintTarget()
      const snapshot = await collect()
      const targetVersion = await storage.fingerprintTarget()
      if (before !== targetVersion) error('STALE_TARGET')
      const plan = await storage.buildPlan(data, snapshot)
      return { plan, targetVersion }
    })
    const id = randomUUID(), expiresAt = Date.now() + 10 * 60 * 1000
    const { plan, targetVersion } = prepared
    operations.set(id, { type: 'import', expiresAt, data, plan, targetVersion })
    return { importId: id, sections: data.manifest.sections, bytes: buffer.length, expiresInMs: 600000, targetVersion, warnings: data.manifest.warnings }
  }

  async function commit(id) {
    const op = operations.get(id)
    if (!op || op.type !== 'import' || op.expiresAt < Date.now()) error('NOT_FOUND')
    if (op.done) return { operationId: id, ...op.result }
    return storage.withExclusive(async () => {
      if (await storage.fingerprintTarget() !== op.targetVersion) error('STALE_TARGET')
      const result = await storage.commitPlan(id, op.plan, op.targetVersion)
      operations.set(id, { ...op, result, done: true })
      return { operationId: id, ...result }
    })
  }
  async function status(id) {
    if (!id) return { busy: await storage.isBusy() }
    const op = operations.get(id)
    if (!op) return null
    return op.done ? { operationId: id, state: 'committed', ...op.result } : { operationId: id, state: 'ready', expiresAt: op.expiresAt }
  }
  async function download(id) {
    const op = operations.get(id)
    if (!op || op.type !== 'export' || op.expiresAt < Date.now()) error('NOT_FOUND')
    return op.archive
  }
  async function cancel(id) {
    const op = operations.get(id)
    if (!op || op.type !== 'import' || op.done) error('NOT_FOUND')
    operations.delete(id); await storage.removeImport(id); return { cancelled: true }
  }
  return { prepareExport, inspect, commit, status, download, cancel }
}
