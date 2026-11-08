import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PLATFORM_NAMES,
  createPlatform,
  createPosixPlatform,
  createWin32Platform,
  describePlatform,
  platform,
  platformNameFor,
} from '../index.js'

let passed = 0
async function test(name, fn) { await fn(); passed++; console.log(`ok ${passed} - ${name}`) }
const code = (expected) => (error) => { assert.equal(error.code, expected); return true }

const root = await mkdtemp(join(await realpath(tmpdir()), 'chonkyfish-platform-'))
try {
  await test('platform selection maps every host to exactly one module', async () => {
    assert.deepEqual(PLATFORM_NAMES, ['posix', 'win32'])
    assert.equal(platformNameFor('win32'), 'win32')
    for (const host of ['darwin', 'linux', 'freebsd', 'openbsd', 'sunos', 'aix']) assert.equal(platformNameFor(host), 'posix')
    assert.equal(platformNameFor(), process.platform === 'win32' ? 'win32' : 'posix')
    assert.equal(createPlatform('posix').name, 'posix')
    assert.equal(createPlatform('win32').name, 'win32')
    assert.throws(() => createPlatform('plan9'), TypeError)
    assert.equal(platform.name, platformNameFor())
    assert.deepEqual(describePlatform(), {
      name: platform.name,
      directorySync: platform.directorySync,
      caseInsensitivePaths: platform.caseInsensitivePaths,
    })
    assert.deepEqual(describePlatform(createWin32Platform()), { name: 'win32', directorySync: false, caseInsensitivePaths: true })
    assert.deepEqual(describePlatform(createPosixPlatform()), { name: 'posix', directorySync: true, caseInsensitivePaths: false })
  })

  await test('win32 declares no directory flush and never touches the filesystem', async () => {
    const win32 = createWin32Platform()
    assert.equal(win32.directorySync, false)
    // A path that cannot exist proves the call is a no-op instead of a swallowed error.
    await win32.syncDirectory(join(root, 'definitely', 'missing'))
    await assert.rejects(stat(join(root, 'definitely')), (error) => error.code === 'ENOENT')
  })

  await test('posix flushes the directory handle and always closes it', async () => {
    const events = []
    const handle = { async sync() { events.push('sync') }, async close() { events.push('close') } }
    const posix = createPosixPlatform({ openFile: async (path, flags) => { events.push(`open:${flags}`); assert.equal(path, root); return handle } })
    await posix.syncDirectory(root)
    assert.deepEqual(events, ['open:r', 'sync', 'close'])

    const failing = { async sync() { throw Object.assign(new Error('io'), { code: 'EIO' }) }, async close() { events.push('close:failed') } }
    const strict = createPosixPlatform({ openFile: async () => failing })
    await assert.rejects(strict.syncDirectory(root), code('EIO'))
    assert.deepEqual(events.at(-1), 'close:failed')
  })

  await test('posix only swallows filesystems that cannot express the flush', async () => {
    for (const codeName of ['ENOTSUP', 'ENOSYS']) {
      const posix = createPosixPlatform({ openFile: async () => { throw Object.assign(new Error(codeName), { code: codeName }) } })
      await posix.syncDirectory(root)
    }
    for (const codeName of ['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'EBADF', 'EMFILE']) {
      const posix = createPosixPlatform({ openFile: async () => { throw Object.assign(new Error(codeName), { code: codeName }) } })
      await assert.rejects(posix.syncDirectory(root), code(codeName))
    }
  })

  await test('root containment and path equality share platform semantics', async () => {
    const posix = createPosixPlatform(), win32 = createWin32Platform()
    assert.equal(posix.isWithin('/', '/tmp/a'), true)
    assert.equal(posix.isWithin('/', '/'), false)
    assert.equal(posix.isSamePath('/srv/fish/', '/srv/fish'), true)
    assert.equal(posix.isSamePath('/srv/Fish', '/srv/fish'), false)
    assert.equal(win32.isSamePath('C:/Work/Fish', 'c:/work/fish/'), true)
    const { isFishHeader } = await import('../../proactive/identity.js')
    const base = join(root, 'Fish')
    const cwd = platform.caseInsensitivePaths ? join(root, 'fish', 'sub') : join(base, 'sub')
    assert.equal(isFishHeader({ cwd, agentPreset: 'chonkyfish' }, { workspaceRoot: base }), true)
  })

  await test('path containment follows the platform rules', async () => {
    const posix = createPosixPlatform(), win32 = createWin32Platform()
    assert.equal(posix.isWithin('/srv/fish', '/srv/fish/note.md'), true)
    assert.equal(posix.isWithin('/srv/fish', '/srv/fishy/note.md'), false)
    assert.equal(posix.isWithin('/srv/fish', '/srv/fish/../fish/note.md'), true)
    assert.equal(posix.isWithin('/srv/fish', '/srv'), false)
    assert.equal(posix.isWithin('/srv/fish', '/srv/fish'), false)
    assert.equal(posix.isWithin('/srv/Fish', '/srv/fish/note.md'), false)

    assert.equal(win32.isWithin('C:\\work\\fish', 'C:\\work\\fish\\note.md'), true)
    assert.equal(win32.isWithin('C:\\work\\fish', 'C:/work/fish/note.md'), true)
    assert.equal(win32.isWithin('C:\\work\\fish', 'c:\\WORK\\FISH\\Note.MD'), true)
    assert.equal(win32.isWithin('C:\\work\\fish', 'C:\\work\\fishy\\note.md'), false)
    assert.equal(win32.isWithin('C:\\work\\fish', 'C:\\work'), false)
    assert.equal(win32.isWithin('C:\\work\\fish', 'D:\\work\\fish\\note.md'), false)
    assert.equal(win32.isWithin('C:\\', 'C:\\anywhere.md'), true)
    assert.equal(win32.isWithin('C:\\work\\fish', 'C:\\work\\fish'), false)

    assert.equal(platform.isWithin(root, join(root, 'x.md')), true)
    assert.equal(platform.isWithin(root, join(root, '..')), false)
  })

  await test('the selected module flushes a real directory on this host', async () => {
    const directory = join(root, 'real')
    await mkdir(directory)
    assert.equal(platform.name, process.platform === 'win32' ? 'win32' : 'posix')
    await platform.syncDirectory(directory)
  })

  await test('business modules do not branch on the OS or re-implement platform rules', async () => {
    const sourceRoot = new URL('../../', import.meta.url)
    const files = []
    async function walk(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
        if (entry.isDirectory()) {
          if (entry.name === 'platform' || entry.name === 'tests' || entry.name === 'node_modules') continue
          await walk(child)
        } else if (entry.name.endsWith('.js')) files.push(child)
      }
    }
    await walk(sourceRoot)
    assert.ok(files.length > 20)
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      assert.doesNotMatch(text, /platform\/(?:posix|win32)\.js/, `${file.pathname} must import only the platform entry`)
      assert.doesNotMatch(text, /startsWith\([^)]*\+\s*sep\)/, `${file.pathname} must delegate path containment`)
      assert.doesNotMatch(text, /process\.platform/, `${file.pathname} must use src/platform instead of process.platform`)
      assert.doesNotMatch(text, /\b(dir|folder|directoryHandle)\.sync\(\)/, `${file.pathname} must use platform.syncDirectory`)
      assert.doesNotMatch(text, /relative\(resolve\(/, `${file.pathname} must use platform.isWithin instead of ad-hoc path checks`)
    }
    for (const implementation of ['posix.js', 'win32.js']) {
      const source = await readFile(new URL(`../${implementation}`, import.meta.url), 'utf8')
      const imports = [...source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)]
      for (const match of imports) assert.ok(match[2].startsWith('node:'), `${implementation} must depend only on Node builtins`)
    }
    for (const relative of ['proactive/identity.js', 'event-engine/engine.js', 'abs/store.js' , 'social/core.js', 'social/inbox-store.js', 'abs/host.js']) {
      const text = await readFile(new URL(`../../${relative}`, import.meta.url), 'utf8')
      assert.match(text, /from '\.\.\/platform\/index\.js'/, `${relative} must import the platform module`)
    }
    const host = await readFile(new URL('../../abs/host.js', import.meta.url), 'utf8')
    assert.match(host, /platform\.isWithin\(/)
    assert.match(await readFile(new URL('../../abs/store.js', import.meta.url), 'utf8'), /platform\.syncDirectory\(/)
  })

  console.log(`\n${passed} platform tests passed`)
} finally {
  await rm(root, { recursive: true, force: true })
}
