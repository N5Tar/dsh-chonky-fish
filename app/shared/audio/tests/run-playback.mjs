import assert from 'node:assert/strict'
import { createWebPlayback } from '../playback.js'
import { encodePcm16Wav } from '../wav.js'

class FakeBuffer {
  constructor(channels, frames, sampleRate) { this.numberOfChannels = channels; this.length = frames; this.sampleRate = sampleRate; this.channels = Array.from({ length: channels }, () => new Float32Array(frames)) }
  copyToChannel(data, channel) { this.channels[channel].set(data) }
}
class FakeSource {
  constructor(context) { this.context = context; this.connected = false; this.stopped = false }
  connect() { this.connected = true }
  disconnect() { this.connected = false }
  start(at) { this.startedAt = at; this.context.sources.push(this) }
  stop() { this.stopped = true; this.onended?.() }
  finish() { this.context.currentTime = Math.max(this.context.currentTime, this.startedAt + this.buffer.length / this.buffer.sampleRate); this.onended?.() }
}
class FakeAudioContext {
  state = 'running'; currentTime = 0; destination = {}; sources = []; buffers = []
  constructor() { FakeAudioContext.latest = this }
  async resume() { this.state = 'running' }
  createBuffer(channels, frames, sampleRate) { const buffer = new FakeBuffer(channels, frames, sampleRate); this.buffers.push(buffer); return buffer }
  createBufferSource() { return new FakeSource(this) }
  async close() { this.state = 'closed' }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function finishAll(context) {
  while (context.sources.some(source => source.connected)) {
    const source = context.sources.find(item => item.connected)
    source.finish()
    await delay(0)
  }
}

await (async () => {
  const playback = createWebPlayback({ audioStore: { read: () => new Int16Array([0, 1]), release() {} }, AudioContextCtor: FakeAudioContext })
  await playback.unlock()
  const stream = playback.openStream({ format: { codec: 'pcm_s16le', sampleRate: 8000, channels: 1 } })
  let appendDone = false
  const append = stream.append(new Int16Array(4 * 8000).fill(1000).buffer).then(() => { appendDone = true })
  await delay(0)
  assert.equal(FakeAudioContext.latest.sources.length, 6, 'three-second output queue is the backpressure limit')
  assert.equal(appendDone, false, 'append waits for output to drain before scheduling beyond the bound')
  const context = FakeAudioContext.latest
  while (!appendDone) {
    const next = context.sources.find(source => source.connected)
    assert.ok(next, 'the active output queue remains playable while append waits')
    next.finish()
    await delay(0)
  }
  await append
  stream.endInput()
  await finishAll(context)
  assert.deepEqual(await stream.finished, { ended: true })
  await playback.release()
})()

await (async () => {
  const playback = createWebPlayback({ audioStore: { read: () => new Int16Array(), release() {} }, AudioContextCtor: FakeAudioContext })
  await playback.unlock()
  const wav = encodePcm16Wav(Int16Array.from([1, -1, 100, -100]), { sampleRate: 24000, channels: 2 })
  const stream = playback.openStream({ format: { codec: 'wav', sampleRate: 24000, channels: 2 } })
  await stream.append(wav)
  stream.endInput()
  assert.equal(FakeAudioContext.latest.buffers.at(-1).numberOfChannels, 2)
  assert.equal(FakeAudioContext.latest.buffers.at(-1).sampleRate, 24000)
  await finishAll(FakeAudioContext.latest)
  assert.deepEqual(await stream.finished, { ended: true })
  await playback.release()
})()

await (async () => {
  const playback = createWebPlayback({ audioStore: { read: () => new Int16Array(), release() {} }, AudioContextCtor: FakeAudioContext })
  await playback.unlock()
  const wav = encodePcm16Wav(new Int16Array(24000 * 5).fill(24), { sampleRate: 24000, channels: 1 })
  const stream = playback.openStream({ format: { codec: 'wav', sampleRate: 24000, channels: 1 } })
  await stream.append(wav)
  stream.endInput()
  const context = FakeAudioContext.latest
  assert.equal(context.sources.length, 1, 'a long complete WAV schedules as one complete file, not a multi-part stream')
  assert.equal(context.sources[0].buffer.length / context.sources[0].buffer.sampleRate, 5)
  context.sources[0].finish()
  assert.deepEqual(await stream.finished, { ended: true }, 'complete WAV longer than the PCM stream queue finishes naturally')

  const stopped = playback.openStream({ format: { codec: 'wav', sampleRate: 24000, channels: 1 } })
  await stopped.append(wav)
  stopped.endInput()
  playback.stop()
  assert.deepEqual(await stopped.finished, { stopped: true }, 'stopping a complete long WAV settles the same playback owner')
  await playback.release()
})()

await (async () => {
  const playback = createWebPlayback({ audioStore: { read: () => new Int16Array(), release() {} }, AudioContextCtor: FakeAudioContext })
  await playback.unlock()
  const controller = new AbortController()
  const stream = playback.openStream({ format: { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 }, operation: { signal: controller.signal } })
  const append = stream.append(new Int16Array(80000).fill(10).buffer)
  await delay(0)
  controller.abort()
  assert.deepEqual(await stream.finished, { stopped: true })
  await assert.rejects(append, { code: 'VOICE_PLAYBACK_STOPPED' })
  await playback.release()
})()

console.log('web playback: bounded PCM stream, complete WAV decode, and abort cleanup passed')
