import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createHash } from 'node:crypto'

const root = new URL('../', import.meta.url)
const assets = new URL('../../../../assets/avatar/random/', root)
const source = await readFile(new URL('player.js', root), 'utf8')
const asset = JSON.parse(await readFile(new URL('manifest.json', assets), 'utf8'))
const context = vm.createContext({ setTimeout, clearTimeout, Math })
vm.runInContext(source, context)
function fixture(values) {
  let id = 0, call = 0
  const timers = new Map(), shown = []
  const player = context.createAvatarPlayer({ asset, onFrame: frame => shown.push(frame), random: () => values[call++ % values.length],
    setTimer: (fn, delay) => { timers.set(++id, { fn, delay }); return id }, clearTimer: key => timers.delete(key) })
  function step() { assert.equal(timers.size, 1); const [key, value] = [...timers][0]; timers.delete(key); value.fn(); return value.delay }
  return {player, timers, shown, step}
}
// Force each action and both loop bounds; assert every frame and its actual duration.
for (const action of asset.actions) for (const maximum of [false, true]) {
  const total = asset.actions.reduce((sum, a) => sum + a.weight, 0)
  const before = asset.actions.slice(0, asset.actions.indexOf(action)).reduce((sum, a) => sum + a.weight, 0)
  const f = fixture([maximum ? .999999 : 0, (before + action.weight / 2) / total, maximum ? .999999 : 0])
  f.player.resume(); f.player.resume(); assert.equal(f.timers.size, 1)
  assert.equal(f.shown.at(-1), asset.idleFrame)
  assert.equal(f.step(), maximum ? 5000 : 2000)
  const loops = maximum ? action.maxLoops : action.minLoops
  for (let loop = 0; loop < loops; loop++) for (const frame of action.frames) {
    assert.equal(f.shown.at(-1), frame)
    assert.equal(f.step(), asset.frames[frame].durationMs * 2)
  }
  assert.equal(f.shown.at(-1), asset.idleFrame)
  f.step(); assert(!action.frames.includes(f.shown.at(-1)), 'next action must differ')
  f.player.pause(); assert.equal(f.timers.size, 0); assert.equal(f.shown.at(-1), asset.idleFrame)
  f.player.resume(); assert.equal(f.timers.size, 1)
  f.player.dispose(); assert.equal(f.timers.size, 0)
  f.player.resume(); assert.equal(f.timers.size, 0)
}
assert.deepEqual(asset.actions.map(a => a.name), ['idle', 'running', 'waiting', 'review', 'waving', 'jumping', 'failed'])
assert(asset.actions.find(a => a.name === 'failed').weight < Math.min(...asset.actions.filter(a => a.name !== 'failed').map(a => a.weight)))
assert.equal(asset.playbackRate, 0.5)
assert.equal(asset.frames.length, 41)
for (const frame of asset.frames) {
  const bytes = await readFile(new URL(frame.file, assets))
  assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a')
  assert.equal(bytes.readUInt32BE(16), asset.width); assert.equal(bytes.readUInt32BE(20), asset.height)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), frame.sha256)
}
const widget = await readFile(new URL('widget.js', root), 'utf8')
const build = await readFile(new URL('../../build.mjs', root), 'utf8')
assert.match(widget, /prefers-reduced-motion: reduce/)
assert.match(widget, /visibilitychange/)
assert.match(widget, /removeEventListener/)
assert.match(widget, /player.dispose\(\)/)
assert.match(widget, /image.decode\(\)/)
assert.match(widget, /pointer-events:none/)
assert.match(widget, /pointer-events:auto/)
assert.match(build, /name: 'shell.overlay', id: 'chonkyfish-avatar'/)
assert.doesNotMatch(widget, /innerHTML|setInterval/)
console.log('PASS avatar: seven random actions, exact frame timing and loop bounds, no immediate repeats, pause/resume/disposal, asset hashes and overlay integration')
