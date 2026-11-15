import { VOICE_LIMITS } from './limits.js';

export function createTurnState({ sampleRate = 16000, endSilenceMs = 1200, maxClipSeconds = VOICE_LIMITS.clipSeconds, maxTurnSeconds = VOICE_LIMITS.utteranceSeconds } = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('sampleRate must be positive');
  if (![800, 1200, 1800].includes(endSilenceMs)) throw new RangeError('Unsupported end silence threshold');
  if (!Number.isFinite(maxClipSeconds) || maxClipSeconds <= 0 || !Number.isFinite(maxTurnSeconds) || maxTurnSeconds <= 0) throw new RangeError('Turn and clip limits must be positive');
  let speaking = false, startSample = null, utteranceStart = null, lastSpeechSample = null, cutAt = null;
  let lastAdvanceSample = -1;
  const silenceSamples = Math.ceil(sampleRate * endSilenceMs / 1000);
  const clipSamples = Math.ceil(sampleRate * maxClipSeconds);
  const turnSamples = Math.ceil(sampleRate * maxTurnSeconds);
  return {
    start(sampleIndex, segmentStartSample = sampleIndex) {
      if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0) throw new TypeError('sampleIndex must be a non-negative integer');
      if (!speaking) { speaking = true; if (startSample === null) { startSample = segmentStartSample; utteranceStart = sampleIndex; cutAt = segmentStartSample; } }
      lastSpeechSample = sampleIndex;
    },
    end(sampleIndex) {
      if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0) throw new TypeError('sampleIndex must be a non-negative integer');
      if (speaking) { speaking = false; lastSpeechSample = sampleIndex; }
    },
    advance(sampleIndex) {
      if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0) return [];
      if (startSample === null) return [];
      if (sampleIndex < lastAdvanceSample) return [];
      lastAdvanceSample = sampleIndex;
      const actions = [];
      const currentStart = cutAt ?? startSample;
      const elapsed = sampleIndex - utteranceStart;
      const silenceReached = !speaking && lastSpeechSample !== null && sampleIndex - lastSpeechSample >= silenceSamples;
      if (elapsed >= turnSamples) {
        let boundaryStart = currentStart;
        const hardEnd = utteranceStart + turnSamples;
        while (boundaryStart + clipSamples < hardEnd) {
          actions.push({ type: 'cut', startSample: boundaryStart, endSample: boundaryStart + clipSamples, reason: 'max-clip' });
          boundaryStart += clipSamples;
        }
        actions.push({ type: 'seal', startSample: boundaryStart, endSample: hardEnd, reason: 'max-turn' });
        actions.push({ type: 'new-turn', startSample: hardEnd });
        startSample = null; utteranceStart = null; cutAt = null; lastSpeechSample = null; speaking = false;
        return actions;
      }
      if (elapsed >= clipSamples) {
        while (cutAt + clipSamples <= sampleIndex) {
          actions.push({ type: 'cut', startSample: cutAt, endSample: cutAt + clipSamples, reason: 'max-clip' });
          cutAt += clipSamples;
        }
      }
      if (silenceReached) {
        actions.push({ type: 'seal', startSample: currentStart, endSample: Math.max(currentStart, lastSpeechSample), reason: 'silence' });
        startSample = null; utteranceStart = null; lastSpeechSample = null; cutAt = null;
      }
      return actions;
    },
    reset() { speaking = false; startSample = null; utteranceStart = null; lastSpeechSample = null; cutAt = null; lastAdvanceSample = -1; },
    snapshot() { return { speaking, startSample, lastSpeechSample, cutAt }; },
  };
}
