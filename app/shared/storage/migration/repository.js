import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { platform } from '../../platform/index.js'
import { mergeMigrationPreferences, migrationFail, validateMemoryRelative } from '../../../../core/modules/migration/policy.js'

const fail = code => migrationFail(code)
const fingerprint = async (targets, preservedRules) => {
  const hash = createHash('sha256')
  async function visit(p) {
    let info
    try { info = await lstat(p) } catch (e) { if (e.code === 'ENOENT') { hash.update('missing'); return } throw e }
    if (info.isSymbolicLink()) fail('UNSAFE_PATH')
    if (info.isFile()) { if (info.nlink !== 1) fail('UNSAFE_PATH'); hash.update(path.basename(p)); hash.update(await readFile(p)); return }
    if (!info.isDirectory()) fail('UNSAFE_PATH')
    const names = (await readdir(p)).sort()
    for (const name of names) {
      const rule = preservedRules.find(item => path.resolve(p) === path.resolve(item.directory) && (item.caseInsensitive ? name.toLowerCase() === item.name : name === item.name))
      if (rule) {
        // 只记下被保留的目录名，不把浏览器缓存或本机会话索引的内容算进迁移指纹。
        hash.update(name); hash.update(rule.marker)
        continue
      }
      hash.update(name)
      await visit(path.join(p, name))
    }
  }
  for (const p of targets) { hash.update(p); await visit(p) }
  return hash.digest('hex')
}

export function createMigrationRepository({ resources, beforeExclusive = async () => {}, beforePublish = async () => {}, onExclusive = () => {}, onCommitted = async () => {}, faultInjector = async () => {} }) {
  let busy = false
  const root = resources.paths.migration
  const targets = [resources.paths.state, resources.paths.config, resources.paths.personalProfile, resources.paths.diary, resources.paths.skills, resources.paths.perceptionPreferences, resources.paths.memory]
  const preservedRules = [
    { directory: resources.paths.personalProfile, name: 'browser-profile', marker: 'preserved-runtime-profile', caseInsensitive: true },
    { directory: resources.paths.memory, name: 'sessions', marker: 'preserved-local-session-index', caseInsensitive: true },
  ]
  async function safeFiles(directory, prefix, maxFiles, filter, skipRootName) {
    const result = new Map()
    async function walk(current, rel) {
      let names
      try { names = await readdir(current) } catch (e) { if (e.code === 'ENOENT') return; throw e }
      for (const name of names) {
        // This is a runtime browser profile, not personal knowledge: it contains
        // login state, caches, databases and open lock files and must never migrate.
        if (prefix === 'profile' && rel === '' && name.toLowerCase() === 'browser-profile') continue
        if (rel === '' && skipRootName && skipRootName(name)) continue
        const full = path.join(current, name), st = await lstat(full)
        if (st.isSymbolicLink() || (st.isFile() && st.nlink !== 1)) fail('UNSAFE_PATH')
        const child = rel ? `${rel}/${name}` : name
        if (st.isDirectory()) await walk(full, child)
        else if (st.isFile() && (!filter || filter.test(name))) {
          if (st.size > 16 * 1024 * 1024 || result.size >= maxFiles) fail('LIMIT_EXCEEDED')
          result.set(`${prefix}/${child}`, await readFile(full))
        } else fail('UNSAFE_PATH')
      }
    }
    await walk(directory, '')
    return result
  }
  async function exists(p) {
    return lstat(p).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))
  }
  async function durableWrite(file, content) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    let handle, renamed = false
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(content)
      await handle.sync()
      await handle.close(); handle = null
      await rename(temporary, file); renamed = true
      await platform.syncDirectory(path.dirname(file))
    } catch (error) {
      await handle?.close().catch(() => {})
      if (!renamed) await unlink(temporary).catch(() => {})
      throw error
    }
  }
  async function writeJournal(directory, value) {
    await durableWrite(path.join(directory, 'transaction.json'), Buffer.from(JSON.stringify(value, null, 2) + '\n'))
  }
  async function syncDirectoryTree(directory) {
    let names
    try { names = await readdir(directory) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const name of names) {
      const child = path.join(directory, name), info = await lstat(child)
      if (info.isDirectory() && !info.isSymbolicLink()) await syncDirectoryTree(child)
    }
    await platform.syncDirectory(directory)
  }
  async function syncRename(from, to) {
    await platform.syncDirectory(path.dirname(from))
    if (path.dirname(to) !== path.dirname(from)) await platform.syncDirectory(path.dirname(to))
  }
  async function preservedProfileNames(directory) {
    try { return (await readdir(directory)).filter(name => name.toLowerCase() === 'browser-profile') }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  function validPreserve(record) {
    const preserve = record.preserve || []
    if (!Array.isArray(preserve)) return false
    if (record.target === resources.paths.personalProfile) return preserve.every(relative => typeof relative === 'string' && relative.toLowerCase() === 'browser-profile')
    if (record.target === resources.paths.memory) return preserve.every(relative => typeof relative === 'string' && relative.toLowerCase() === 'sessions' && !/[/\\\0]/.test(relative))
    return preserve.length === 0
  }
  async function localPreserve(target, targetInfo) {
    if (!targetInfo) return []
    if (target === resources.paths.personalProfile) return preservedProfileNames(target)
    if (target === resources.paths.memory) {
      let names
      try { names = await readdir(target) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
      const preserved = []
      for (const name of names) {
        if (name.toLowerCase() !== 'sessions') continue
        const info = await lstat(path.join(target, name))
        if (info.isSymbolicLink() || !info.isDirectory()) fail('UNSAFE_PATH')
        preserved.push(name)
      }
      return preserved
    }
    return []
  }
  async function restoreRecord(record) {
    const backupExists = await exists(record.backup)
    if (backupExists) {
      for (const relative of record.preserve || []) {
        const backupPath = path.join(record.backup, relative)
        if (await exists(backupPath)) continue
        const candidates = [path.join(record.target, relative), path.join(record.stage, relative)]
        let preservedFrom
        for (const candidate of candidates) { if (await exists(candidate)) { preservedFrom = candidate; break } }
        if (preservedFrom) { await mkdir(path.dirname(backupPath), { recursive: true }); await rename(preservedFrom, backupPath); await syncRename(preservedFrom, backupPath) }
      }
      await rm(record.target, { recursive: true, force: true })
      await rename(record.backup, record.target)
      await syncRename(record.backup, record.target)
    } else if (!record.existed && !(await exists(record.stage))) {
      await rm(record.target, { recursive: true, force: true })
      await platform.syncDirectory(path.dirname(record.target))
    }
  }
  async function writeTree(directory, files) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await platform.syncDirectory(path.dirname(directory))
    for (const [relative, content] of files) {
      if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_PATH')
      const dest = path.join(directory, ...relative.split('/'))
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 })
      await durableWrite(dest, content)
    }
    await syncDirectoryTree(directory)
    await platform.syncDirectory(path.dirname(directory))
  }
  async function readState(pathname, fallback) {
    try { return JSON.parse(await readFile(pathname, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return fallback; fail('INVALID_DATA') }
  }
  return {
    async readDirectory(directory, prefix, maxFiles, filter, skipRootName) { return safeFiles(directory, prefix, maxFiles, filter, skipRootName) },
    async saveExport(id, bytes) { const dir = path.join(root, 'exports'); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, `${id}.fishpack`), bytes, { flag: 'wx', mode: 0o600 }) },
    async saveImport(id, plan) { const dir = path.join(root, 'staging', id); await mkdir(dir, { recursive: true }); await this.writePlan(dir, plan) },
    async writePlan(directory, plan) {
      for (const [target, value] of plan) {
        const index = targets.indexOf(target)
        if (index < 0) fail('UNSAFE_PATH')
        if (value.kind === 'directory') await writeTree(path.join(directory, String(index)), value.files)
        else if (value.kind === 'file' && value.content) await writeFile(path.join(directory, `${index}.bin`), value.content, { flag: 'wx', mode: 0o600 })
      }
    },
    async removeImport(id) { await rm(path.join(root, 'staging', id), { recursive: true, force: true }) },
    async fingerprintTarget() { return fingerprint(targets, preservedRules) },
    async recover() {
      const txRoot = path.join(root, 'transactions')
      await mkdir(txRoot, { recursive: true, mode: 0o700 })
      const txRootInfo = await lstat(txRoot)
      if (!txRootInfo.isDirectory() || txRootInfo.isSymbolicLink()) fail('RECOVERY_REQUIRED')
      for (const id of await readdir(txRoot)) {
        const dir = path.join(txRoot, id), journal = path.join(dir, 'transaction.json')
        const dirInfo = await lstat(dir).catch(() => null)
        if (!dirInfo || !dirInfo.isDirectory() || dirInfo.isSymbolicLink()) fail('RECOVERY_REQUIRED')
        const journalInfo = await lstat(journal).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (!journalInfo) {
          // An empty directory can only be left by a crash before the durable
          // prepared marker. Any artifact without its journal is ambiguous.
          if ((await readdir(dir)).length !== 0) fail('RECOVERY_REQUIRED')
          await rm(dir, { recursive: true, force: true })
          await platform.syncDirectory(txRoot)
          continue
        }
        if (!journalInfo.isFile() || journalInfo.isSymbolicLink() || journalInfo.nlink !== 1) fail('RECOVERY_REQUIRED')
        let tx
        try { tx = JSON.parse(await readFile(journal, 'utf8')) } catch { fail('RECOVERY_REQUIRED') }
        if (tx.phase === 'committed' || tx.phase === 'rolled-back') continue
        if (tx.phase === 'prepared' || tx.phase === 'staged') {
          await rm(dir, { recursive: true, force: true })
          await platform.syncDirectory(txRoot)
          continue
        }
        if (tx.phase !== 'publishing' || !Array.isArray(tx.targets)) fail('RECOVERY_REQUIRED')
        try {
          const seenTargets = new Set()
          for (const record of [...tx.targets].reverse()) {
            const index = targets.indexOf(record.target)
            if (index < 0 || seenTargets.has(record.target) || record.backup !== path.join(dir, 'backup', String(index)) || record.stage !== path.join(dir, 'stage', String(index)) || !validPreserve(record)) fail('RECOVERY_REQUIRED')
            seenTargets.add(record.target)
            await restoreRecord(record)
          }
          await writeJournal(dir, { phase: 'rolled-back', id })
        } catch { fail('RECOVERY_REQUIRED') }
      }
    },
    // Read-only durable evidence for consumers such as first-use onboarding.
    // A pending/ambiguous transaction must be recovered before any completion
    // is inferred, even when an older import committed successfully.
    async readCommittedImport() {
      const txRoot = path.join(root, 'transactions')
      let ids
      try { ids = await readdir(txRoot) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
      let committed = null
      for (const id of ids.sort()) {
        const dir = path.join(txRoot, id), journal = path.join(dir, 'transaction.json')
        const info = await lstat(dir)
        if (!info.isDirectory() || info.isSymbolicLink()) fail('RECOVERY_REQUIRED')
        let tx
        try {
          const info = await lstat(journal)
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('RECOVERY_REQUIRED')
          tx = JSON.parse(await readFile(journal, 'utf8'))
        } catch { fail('RECOVERY_REQUIRED') }
        if (tx.id !== id || !['committed', 'rolled-back'].includes(tx.phase)) fail('RECOVERY_REQUIRED')
        if (tx.phase === 'committed') committed = id
      }
      return committed
    },
    async isBusy() { return busy },
    async withExclusive(fn) { if (busy) fail('MIGRATION_BUSY'); busy = true; onExclusive(true); try { await beforeExclusive(); return await fn() } finally { onExclusive(false); busy = false } },
    async buildPlan(data, snapshot) {
      if (data.includeMemory) for (const name of data.memory.keys()) validateMemoryRelative(name)
      const state = { ...(snapshot.stateWrap || {}), version: 1, generation: (snapshot.stateWrap?.generation || 0) + 1, state: { ...(snapshot.stateWrap?.state || {}), ...data.identity, ...data.wallet, profileDirectory: resources.paths.personalProfile } }
      const config = mergeMigrationPreferences(snapshot.config, data.preferences)
      const collectionPreference = Buffer.from(JSON.stringify({ version: 1, collectionEnabled: false }) + '\n')
      const plan = new Map([
        [resources.paths.state, { kind: 'file', content: Buffer.from(JSON.stringify(state, null, 2) + '\n') }],
        [resources.paths.config, { kind: 'file', content: Buffer.from(JSON.stringify(config, null, 2) + '\n') }],
        [resources.paths.personalProfile, { kind: 'directory', files: data.profile }],
        [resources.paths.diary, { kind: 'directory', files: new Map([...data.diaries].map(([name, content]) => [name.slice(8), content])) }],
        [resources.paths.skills, { kind: 'directory', files: new Map([...data.skills].map(([name, content]) => [name.slice(7), content])) }],
        [resources.paths.perceptionPreferences, { kind: 'file', content: collectionPreference }],
      ])
      if (data.includeMemory) plan.set(resources.paths.memory, { kind: 'directory', files: data.memory })
      return plan
    },
    async commitPlan(id, plan, expectedVersion) {
      const txRoot = path.join(root, 'transactions', id)
      const transactions = path.dirname(txRoot)
      const stageRoot = path.join(txRoot, 'stage'), backupRoot = path.join(txRoot, 'backup')
      const initialVersion = await fingerprint(targets, preservedRules)
      if (expectedVersion && initialVersion !== expectedVersion) fail('STALE_TARGET')
      const records = []
      for (const [target] of plan) {
        const index = targets.indexOf(target)
        if (index < 0) fail('UNSAFE_PATH')
        const stage = path.join(stageRoot, String(index)), backup = path.join(backupRoot, String(index))
        const targetInfo = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
        records.push({ target, stage, backup, existed: !!targetInfo, preserve: await localPreserve(target, targetInfo) })
      }
      const journalTargets = records.map(({ target, stage, backup, existed, preserve }) => ({ target, stage, backup, existed, preserve }))
      const journal = phase => ({ phase, id, targets: journalTargets })
      let publishingStarted = false, publishComplete = false, transactionCreated = false
      try {
        await mkdir(transactions, { recursive: true, mode: 0o700 })
        await platform.syncDirectory(path.dirname(transactions))
        await mkdir(txRoot, { mode: 0o700 })
        transactionCreated = true
        await platform.syncDirectory(transactions)
        await writeJournal(txRoot, journal('prepared'))
        await faultInjector('journal-prepared', { id, txRoot })

        await mkdir(stageRoot, { mode: 0o700 }); await mkdir(backupRoot, { mode: 0o700 })
        await platform.syncDirectory(txRoot)
        for (const [target, value] of plan) {
          const index = targets.indexOf(target), stage = path.join(stageRoot, String(index))
          if (value.kind === 'directory') await writeTree(stage, value.files)
          else if (value.kind === 'file' && value.content) await durableWrite(stage, value.content)
          else fail('INVALID_DATA')
        }
        await syncDirectoryTree(stageRoot)
        await platform.syncDirectory(txRoot)
        await writeJournal(txRoot, journal('staged'))
        await faultInjector('journal-staged', { id, txRoot })
        await beforePublish()
        await writeJournal(txRoot, journal('publishing'))
        await faultInjector('journal-publishing', { id, txRoot })
        publishingStarted = true
        if (await fingerprint(targets, preservedRules) !== (expectedVersion || initialVersion)) fail('STALE_TARGET')

        for (const record of records) {
          await mkdir(path.dirname(record.target), { recursive: true, mode: 0o700 })
          if (record.existed) {
            await rename(record.target, record.backup)
            await syncRename(record.target, record.backup)
            await faultInjector('target-backed-up', { id, target: record.target })
          }
          for (const relative of record.preserve) {
            const from = path.join(record.backup, relative), to = path.join(record.stage, relative)
            if (await exists(from)) {
              if (await exists(to)) fail('UNSAFE_PATH')
              await mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
              await rename(from, to)
              await syncRename(from, to)
              await faultInjector('runtime-preserved', { id, target: record.target, relative })
            }
          }
          await rename(record.stage, record.target)
          await syncRename(record.stage, record.target)
          await faultInjector('target-published', { id, target: record.target })
        }
        publishComplete = true
        await faultInjector('all-targets-published', { id, txRoot })
        await onCommitted()
        await writeJournal(txRoot, journal('committed'))
        await faultInjector('commit-marker', { id, txRoot })
        return { state: 'committed', backupDirectory: backupRoot, restartRequired: true }
      } catch (cause) {
        if (!publishingStarted) {
          if (transactionCreated) {
            try { await rm(txRoot, { recursive: true, force: true }); await platform.syncDirectory(transactions) }
            catch { fail('RECOVERY_REQUIRED') }
          }
          throw Object.assign(cause, { code: cause.code || 'IMPORT_FAILED' })
        }
        // Once every target is published, keep the complete new set. If the
        // commit marker cannot be durably written, startup recovery will choose
        // either the old complete set (publishing) or this new complete set.
        if (publishComplete) fail('RECOVERY_REQUIRED')
        let rollbackError = null
        for (const record of [...records].reverse()) {
          try { await restoreRecord(record) }
          catch (error) { rollbackError = error }
        }
        if (rollbackError) fail('RECOVERY_REQUIRED')
        try { await writeJournal(txRoot, { phase: 'rolled-back', id }) }
        catch { fail('RECOVERY_REQUIRED') }
        throw Object.assign(cause, { code: cause.code || 'IMPORT_FAILED' })
      }
    },
  }
}
