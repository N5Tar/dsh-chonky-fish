import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createHash } from 'node:crypto'

const root = new URL('../', import.meta.url)
const source = await readFile(new URL('player.js', root), 'utf8')
const asset = JSON.parse(await readFile(new URL('assets/manifest.json', root), 'utf8'))
const context = vm.createContext({ setTimeout, clearTimeout, Math })
vm.runInContext(source, context)
let id = 0, randomCalls = 0, now = 0
const timers = new Map(), shown = []
const random = [0, .5, .999999]
const player = context.createAvatarPlayer({ asset, onFrame: frame => shown.push({ frame, now }), random: () => random[randomCalls++ % random.length], setTimer: (fn, delay) => { timers.set(++id, { fn, delay }); return id }, clearTimer: key => timers.delete(key) })
function step() { assert.equal(timers.size, 1); const [key, value] = [...timers][0]; timers.delete(key); now += value.delay; value.fn(); return value.delay }
player.resume()
assert.equal(shown.at(-1).frame, 7)
assert.equal(randomCalls, 1)
player.resume(); assert.equal(timers.size, 1)
assert.equal(step(), 2000)
for (let frame = 0; frame < 7; frame++) { assert.equal(shown.at(-1).frame, frame); assert.equal(step(), 30) }
assert.equal(shown.at(-1).frame, 7)
assert.equal(now, 2210)
assert.equal(randomCalls, 2)
assert.equal(step(), 3500)
player.pause(); assert.equal(timers.size, 0); assert.equal(shown.at(-1).frame, 7)
player.resume(); assert.equal([...timers.values()][0].delay, 5000)
player.dispose(); assert.equal(timers.size, 0)
player.resume(); assert.equal(timers.size, 0)
assert.equal(createHash('sha256').update(await readFile(new URL('assets/original.gif', root))).digest('hex'), asset.sha256)
assert.equal(asset.frames.length, 8)
for (const frame of asset.frames) {
  const bytes = await readFile(new URL('assets/' + frame.file, root))
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP')
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
console.log('PASS avatar: exact 210ms action, fresh 2–5s idle, no duplicate timers, pause/resume/disposal, original hash, transparent WebP assets and overlay integration')
