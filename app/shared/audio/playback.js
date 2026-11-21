import { decodePcm16Wav } from './wav.js'

const MAX_STREAM_BUFFER_SECONDS = 3
const MAX_STREAM_CHUNK_SECONDS = 0.5

export function createWebPlayback({ audioStore, AudioContextCtor = globalThis.AudioContext,
  maxBufferedSeconds = MAX_STREAM_BUFFER_SECONDS, maxChunkSeconds = MAX_STREAM_CHUNK_SECONDS } = {}) {
  if (!audioStore) throw new TypeError('audioStore is required')
  let context = null, active = null, unlocked = false, generation = 0

  function playbackError(message, code) { return Object.assign(new Error(message), { code }) }
  function runningContext() {
    if (!context || !unlocked || context.state !== 'running') throw playbackError('Playback context is not unlocked', 'VOICE_PLAYBACK_LOCKED')
    return context
  }
  function sourceFromBuffer(buffer, run, duration) {
    const ctx = runningContext()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const startAt = Math.max(ctx.currentTime || 0, run.nextStartAt || 0)
    run.nextStartAt = startAt + duration
    run.sources.add(source)
    run.bufferedSeconds += duration
    source.onended = () => {
      run.sources.delete(source)
      try { source.disconnect() } catch {}
      run.bufferedSeconds = Math.max(0, run.bufferedSeconds - duration)
      for (const resolve of run.spaceWaiters.splice(0)) resolve()
      maybeFinish(run)
    }
    source.start(startAt)
    if (!run.started) {
      run.started = true
      try { run.onStarted?.() } catch {}
    }
    return source
  }
  function finish(run, result) {
    if (run.settled) return
    run.settled = true
    run.cleanupSignal?.()
    if (active === run) active = null
    run.resolveFinished(result)
  }
  function fail(run, error) {
    if (run.settled) return
    run.settled = true
    run.cleanupSignal?.()
    if (active === run) active = null
    for (const source of run.sources) {
      try { source.stop() } catch {}
      try { source.disconnect() } catch {}
    }
    run.sources.clear()
    run.bufferedSeconds = 0
    for (const resolve of run.spaceWaiters.splice(0)) resolve()
    try { run.onError?.(error) } catch {}
    run.rejectFinished(error)
  }
  function maybeFinish(run) {
    if (!run.settled && !run.stopping && run.inputEnded && run.pendingAppends === 0 && run.sources.size === 0) finish(run, { ended: true })
  }
  function stopRun(run, result = { stopped: true }) {
    if (!run || run.settled) return
    run.stopping = true
    for (const source of run.sources) {
      try { source.stop() } catch {}
      try { source.disconnect() } catch {}
    }
    run.sources.clear()
    run.bufferedSeconds = 0
    for (const resolve of run.spaceWaiters.splice(0)) resolve()
    finish(run, result)
  }
  function stop() {
    ++generation
    if (active) stopRun(active, { stopped: true })
  }

  async function waitForSpace(run, duration) {
    while (!run.settled && active === run && run.bufferedSeconds + duration > maxBufferedSeconds) {
      await new Promise(resolve => run.spaceWaiters.push(resolve))
    }
    if (run.settled || active !== run || run.operation?.signal?.aborted) throw playbackError('Playback was stopped', 'VOICE_PLAYBACK_STOPPED')
  }

  function pcmBuffer(run, pcm, sampleRate, channels) {
    const frames = pcm.length / channels
    const buffer = runningContext().createBuffer(channels, frames, sampleRate)
    for (let channel = 0; channel < channels; channel++) {
      const data = new Float32Array(frames)
      for (let frame = 0; frame < frames; frame++) {
        const sample = pcm[frame * channels + channel]
        data[frame] = sample < 0 ? sample / 32768 : sample / 32767
      }
      buffer.copyToChannel(data, channel)
    }
    return { buffer, duration: frames / sampleRate }
  }

  function parsePcmFormat(format) {
    if (format?.codec !== 'pcm_s16le' || !Number.isInteger(format.sampleRate) || format.sampleRate < 8000 || format.sampleRate > 192000 || ![1, 2].includes(format.channels)) {
      throw playbackError('Unsupported PCM stream format', 'VOICE_AUDIO_FORMAT')
    }
    return { sampleRate: format.sampleRate, channels: format.channels }
  }

  function schedulePcm(run, pcm, sampleRate, channels) {
    const maxFrames = Math.max(1, Math.floor(sampleRate * maxChunkSeconds))
    const totalFrames = pcm.length / channels
    for (let startFrame = 0; startFrame < totalFrames; startFrame += maxFrames) {
      const frameCount = Math.min(maxFrames, totalFrames - startFrame)
      const samples = pcm.subarray(startFrame * channels, (startFrame + frameCount) * channels)
      const { buffer, duration } = pcmBuffer(run, samples, sampleRate, channels)
      return waitForSpace(run, duration).then(() => {
        if (run.settled || active !== run) throw playbackError('Playback was stopped', 'VOICE_PLAYBACK_STOPPED')
        sourceFromBuffer(buffer, run, duration)
      }).then(() => schedulePcm(run, pcm.subarray((startFrame + frameCount) * channels), sampleRate, channels))
    }
    return Promise.resolve()
  }

  function pcmToSamples(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null
    if (!data || data.byteLength === 0 || data.byteLength % 2 !== 0) throw playbackError('PCM frame must contain complete 16-bit samples', 'VOICE_AUDIO_FRAME')
    const samples = new Int16Array(data.byteLength / 2)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    for (let offset = 0; offset < data.byteLength; offset += 2) samples[offset / 2] = view.getInt16(offset, true)
    return samples
  }

  function decodedWavBuffer(run, bytes, format) {
    const decoded = decodePcm16Wav(bytes, { maxBytes: 16 * 1024 * 1024, maxSeconds: 300 })
    if ((format.sampleRate && format.sampleRate !== decoded.sampleRate) || (format.channels && format.channels !== decoded.channels)) {
      throw playbackError('WAV header does not match the declared format', 'VOICE_AUDIO_FORMAT_MISMATCH')
    }
    return pcmBuffer(run, decoded.samples, decoded.sampleRate, decoded.channels)
  }

  return {
    inspect() { return { available: Boolean(AudioContextCtor), unlocked, playing: Boolean(active && !active.settled), sampleRate: context?.sampleRate ?? null } },
    async unlock() {
      if (!AudioContextCtor) return { ready: false, code: 'VOICE_PLAYBACK_UNSUPPORTED' }
      context ||= new AudioContextCtor({ latencyHint: 'interactive' })
      if (context.state === 'suspended') await context.resume()
      unlocked = context.state === 'running'
      return { ready: unlocked, sampleRate: context.sampleRate }
    },
    play(clipRef, { onStarted = () => {}, onEnded = () => {}, onError = () => {} } = {}) {
      let ctx
      try { ctx = runningContext() } catch (error) { onError(error); return Promise.reject(error) }
      stop()
      const mine = generation
      let pcm
      try { pcm = audioStore.read(clipRef) } catch (error) { onError(error); return Promise.reject(error) }
      const frames = Float32Array.from(pcm, x => x < 0 ? x / 32768 : x / 32767)
      const buffer = ctx.createBuffer(1, frames.length, 16000)
      buffer.copyToChannel(frames, 0)
      const run = { kind: 'clip', generation: mine, sources: new Set(), bufferedSeconds: 0, spaceWaiters: [], nextStartAt: ctx.currentTime || 0, inputEnded: true, pendingAppends: 0, onStarted, onError, settled: false }
      let resolveFinished, rejectFinished
      const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
      Object.assign(run, { resolveFinished, rejectFinished })
      active = run
      try {
        const source = sourceFromBuffer(buffer, run, frames.length / 16000)
        source.onended = () => {
          run.sources.delete(source)
          try { source.disconnect() } catch {}
          if (active !== run || run.settled || run.stopping) return
          finish(run, { ended: true })
          try { onEnded() } catch {}
        }
      } catch (error) { fail(run, error) }
      return finished
    },
    openStream({ format, operation, onStarted = () => {}, onError = () => {} } = {}) {
      runningContext()
      stop()
      const mine = generation
      const codec = format?.codec
      const pcmFormat = codec === 'pcm_s16le' ? parsePcmFormat(format) : null
      if (codec !== 'pcm_s16le' && codec !== 'wav') throw playbackError('Unsupported audio codec', 'VOICE_AUDIO_FORMAT')
      const run = { kind: 'stream', generation: mine, operation, format, codec, pcmFormat, sources: new Set(), bufferedSeconds: 0, spaceWaiters: [], nextStartAt: context.currentTime || 0, pendingAppends: 0, inputEnded: false, started: false, onStarted, onError, settled: false, wavAdded: false }
      let resolveFinished, rejectFinished
      const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
      Object.assign(run, { resolveFinished, rejectFinished })
      active = run
      const signal = operation?.signal
      if (signal) {
        const cancel = () => stopRun(run, { stopped: true })
        signal.addEventListener('abort', cancel, { once: true })
        run.cleanupSignal = () => signal.removeEventListener('abort', cancel)
        if (signal.aborted) cancel()
      }
      async function append(data) {
        if (run.settled || active !== run || run.inputEnded) throw playbackError('Stream is no longer accepting audio', 'VOICE_PLAYBACK_STOPPED')
        run.pendingAppends++
        try {
          if (codec === 'wav') {
            if (run.wavAdded) throw playbackError('WAV stream accepts exactly one complete frame', 'VOICE_AUDIO_FRAME')
            run.wavAdded = true
            const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null
            if (!bytes) throw playbackError('WAV frame must be a Uint8Array', 'VOICE_AUDIO_FRAME')
            const { buffer, duration } = decodedWavBuffer(run, bytes, format)
            // A complete WAV is already a single size-bounded artifact. Queue
            // it as one buffer so long files can start and drain without a
            // producer waiting for space that no stream chunk can free.
            sourceFromBuffer(buffer, run, duration)
            return
          }
          const samples = pcmToSamples(data)
          if (samples.length % pcmFormat.channels !== 0) throw playbackError('PCM frame ends mid-channel', 'VOICE_AUDIO_FRAME')
          await schedulePcm(run, samples, pcmFormat.sampleRate, pcmFormat.channels)
        } catch (error) {
          if (!run.settled) fail(run, error)
          throw error
        } finally {
          run.pendingAppends = Math.max(0, run.pendingAppends - 1)
          maybeFinish(run)
        }
      }
      function endInput() {
        if (run.settled || run.inputEnded) return
        if (codec === 'wav' && !run.wavAdded) {
          fail(run, playbackError('WAV stream ended without a complete file', 'VOICE_AUDIO_FRAME'))
          return
        }
        run.inputEnded = true
        maybeFinish(run)
      }
      return { append, endInput, finished }
    },
    stop,
    async release() { stop(); if (context && context.state !== 'closed') await context.close(); context = null; unlocked = false },
  }
}
