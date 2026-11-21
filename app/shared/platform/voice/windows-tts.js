import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./windows-tts.ps1', import.meta.url))
const helperSource = readFileSync(helper, 'utf8')
const MAX_OUTPUT = 20 * 1024 * 1024
const MAX_AUDIO = 12 * 1024 * 1024

function waveInfo(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.length > MAX_AUDIO || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw Object.assign(new Error('Invalid WAV output'), { code: 'TTS_INVALID_WAV' })
  let offset = 12, format = null, dataBytes = 0
  while (offset + 8 <= wav.length) {
    const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), start = offset + 8
    if (start + size > wav.length) throw Object.assign(new Error('Truncated WAV output'), { code: 'TTS_INVALID_WAV' })
    if (name === 'fmt ' && size >= 16) format = { codec: wav.readUInt16LE(start), channels: wav.readUInt16LE(start + 2), sampleRate: wav.readUInt32LE(start + 4), bits: wav.readUInt16LE(start + 14) }
    if (name === 'data') dataBytes = size
    offset = start + size + (size & 1)
  }
  if (!format || format.codec !== 1 || ![1, 2].includes(format.channels) || format.sampleRate < 8000 || format.sampleRate > 48000 || format.bits !== 16 || !dataBytes || dataBytes % (format.channels * 2) !== 0) throw Object.assign(new Error('Unsupported WAV format'), { code: 'TTS_INVALID_WAV' })
  const frames = dataBytes / (format.channels * 2)
  if (frames > format.sampleRate * 300) throw Object.assign(new Error('WAV is too long'), { code: 'TTS_LIMIT_EXCEEDED' })
  return { codec: 'pcm_s16le', channels: format.channels, sampleRate: format.sampleRate, frames, durationMs: Math.ceil(frames * 1000 / format.sampleRate), bytes: wav.length }
}

/** This factory is called only by the platform/index.js Windows x64 branch. */
export function createWindowsTts({ executable, timeoutMs = 15000 }) {
  if (typeof executable !== 'string' || !executable) throw new TypeError('A fixed Windows PowerShell executable is required')
  let child = null, stdout = '', stderr = '', closed = false
  const pending = new Map()

  function failChild(error) {
    const current = child; child = null; stdout = ''; stderr = ''
    if (current && current.exitCode === null) { try { current.kill() } catch {} }
    for (const [id, item] of pending) { clearTimeout(item.timer); clearTimeout(item.killTimer); item.signal?.removeEventListener('abort', item.abort); item.reject(error); pending.delete(id) }
  }
  function ensureChild() {
    if (closed) throw Object.assign(new Error('TTS service is closed'), { code: 'TTS_UNAVAILABLE' })
    if (child) return child
    child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', helperSource], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const instance = child
    instance.stdout.setEncoding('utf8'); instance.stderr.setEncoding('utf8')
    instance.stdout.on('data', part => {
      stdout += part
      if (Buffer.byteLength(stdout) > MAX_OUTPUT) return failChild(Object.assign(new Error('TTS output limit exceeded'), { code: 'TTS_LIMIT_EXCEEDED' }))
      let newline
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim(); stdout = stdout.slice(newline + 1)
        if (!line) continue
        let result
        try { result = JSON.parse(line) } catch { return failChild(Object.assign(new Error('Malformed TTS helper response'), { code: 'TTS_HELPER_FAILED' })) }
        const item = pending.get(result.id)
        if (!item) continue
        clearTimeout(item.timer); clearTimeout(item.killTimer); item.signal?.removeEventListener('abort', item.abort); pending.delete(result.id)
        if (item.signal?.aborted) item.reject(Object.assign(new Error('Synthesis cancelled'), { code: 'TTS_CANCELLED' }))
        else if (result.error) item.reject(Object.assign(new Error(result.error), { code: result.error }))
        else item.resolve(result)
      }
    })
    instance.stderr.on('data', part => { stderr = (stderr + part).slice(-4096) })
    instance.once('error', error => { if (child === instance) failChild(Object.assign(new Error('Windows PowerShell could not start'), { code: 'TTS_HELPER_FAILED', cause: error })) })
    instance.once('close', code => { if (child === instance) failChild(Object.assign(new Error(stderr.trim() || `PowerShell exited ${code}`), { code: 'TTS_HELPER_FAILED' })) })
    return instance
  }
  function invoke(request, { signal, timeout = timeoutMs } = {}) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Synthesis cancelled'), { code: 'TTS_CANCELLED' }))
    return new Promise((resolve, reject) => {
      let worker
      try { worker = ensureChild() } catch (error) { reject(error); return }
      const id = randomUUID()
      const settle = (error, value) => {
        const item = pending.get(id)
        if (!item) return
        clearTimeout(item.timer); signal?.removeEventListener('abort', item.abort); pending.delete(id)
        clearTimeout(item.killTimer)
        if (error) reject(error); else resolve(value)
      }
      const abort = () => {
        try { worker.stdin.write(JSON.stringify({ action: 'cancel', operationId: id }) + '\n') } catch {}
        const item = pending.get(id)
        if (item) item.killTimer = setTimeout(() => { if (pending.has(id)) failChild(Object.assign(new Error('Synthesis cancellation did not settle'), { code: 'TTS_CANCELLED' })) }, 500)
      }
      const timer = setTimeout(() => { try { worker.stdin.write(JSON.stringify({ action: 'cancel', operationId: id }) + '\n') } catch {}; const item = pending.get(id); if (item) item.killTimer = setTimeout(() => { if (pending.has(id)) failChild(Object.assign(new Error('Synthesis timed out'), { code: 'TTS_TIMEOUT' })) }, 500) }, timeout)
      pending.set(id, { resolve, reject, signal, abort, timer, settle, killTimer: null })
      signal?.addEventListener('abort', abort, { once: true })
      try { worker.stdin.write(JSON.stringify({ ...request, id }) + '\n') } catch (error) { settle(Object.assign(error, { code: 'TTS_HELPER_FAILED' })) }
    })
  }

  return {
    inspect: () => ({ supported: true, providerId: 'windows-system-speech', reason: null }),
    async listVoices() { const result = await invoke({ action: 'voices' }, { timeout: 5000 }); return Array.isArray(result.voices) ? result.voices : [] },
    async synthesize({ text, voiceId = null, rate = 0, signal }) {
      if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw Object.assign(new Error('Text must contain 1–12000 characters'), { code: 'TTS_INVALID_TEXT' })
      const result = await invoke({ action: 'synthesize', text, voiceId, rate }, { signal })
      if (typeof result?.wav !== 'string') throw Object.assign(new Error('TTS helper returned no audio'), { code: 'TTS_HELPER_FAILED' })
      const wav = Buffer.from(result.wav, 'base64'); const info = waveInfo(wav)
      return { wav, info }
    },
    close() { closed = true; failChild(Object.assign(new Error('TTS service closed'), { code: 'TTS_UNAVAILABLE' })) },
  }
}

export { waveInfo as inspectWave }
