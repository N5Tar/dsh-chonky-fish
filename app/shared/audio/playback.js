export function createWebPlayback({ audioStore, AudioContextCtor = globalThis.AudioContext } = {}) {
  if (!audioStore) throw new TypeError('audioStore is required');
  let context = null, source = null, currentResolve = null, unlocked = false, generation = 0;
  function stop() {
    ++generation;
    try { source?.stop(); } catch {}
    try { source?.disconnect(); } catch {}
    source = null;
    if (currentResolve) { currentResolve(); currentResolve = null; }
  }
  return {
    inspect() { return { available: Boolean(AudioContextCtor), unlocked, sampleRate: context?.sampleRate ?? null }; },
    async unlock() {
      if (!AudioContextCtor) return { ready: false, code: 'VOICE_PLAYBACK_UNSUPPORTED' };
      context ||= new AudioContextCtor({ latencyHint: 'interactive' });
      if (context.state === 'suspended') await context.resume();
      unlocked = context.state === 'running';
      return { ready: unlocked, sampleRate: context.sampleRate };
    },
    play(clipRef, { onStarted = () => {}, onEnded = () => {}, onError = () => {} } = {}) {
      if (!context || !unlocked || context.state !== 'running') { const e = Object.assign(new Error('Playback context is not unlocked'), { code: 'VOICE_PLAYBACK_LOCKED' }); onError(e); return Promise.reject(e); }
      stop(); const mine = generation;
      try {
        const pcm = audioStore.read(clipRef), frames = Float32Array.from(pcm, (x) => x < 0 ? x / 32768 : x / 32767);
        const buffer = context.createBuffer(1, frames.length, 16000); buffer.copyToChannel(frames, 0);
        source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
        return new Promise((resolve, reject) => {
          currentResolve = () => resolve({ stopped: true });
          source.onended = () => { if (mine !== generation) return; source?.disconnect(); source = null; currentResolve = null; onEnded(); resolve({ ended: true }); };
          try { source.start(); onStarted(); } catch (e) { currentResolve = null; onError(e); reject(e); }
        });
      } catch (e) { onError(e); return Promise.reject(e); }
    },
    stop,
    async release() { stop(); if (context && context.state !== 'closed') await context.close(); context = null; unlocked = false; },
  };
}
