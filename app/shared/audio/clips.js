import { VOICE_LIMITS } from '../../../core/modules/voice/limits.js';

export function createMemoryAudioStore({ scopeId = `audio-${Math.random().toString(36).slice(2)}`, maxBytes = VOICE_LIMITS.worksetBytes, maxInputBytes = VOICE_LIMITS.encodedBytes, maxRawSamples = VOICE_LIMITS.rawAudioSeconds * 16000, maxClips = 2048 } = {}) {
  const clips = new Map();
  let bytes = 0, inputBytes = 0, rawSamples = 0, sequence = 0;
  function reserve(size) {
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('Audio reservation size is invalid');
    if (bytes + size > maxBytes) throw Object.assign(new Error('Audio workset budget exceeded'), { code: 'VOICE_AUDIO_BUDGET', retryable: true, outcome: 'not_applied' });
    bytes += size;
    let released = false;
    return { release() { if (released) return; released = true; bytes -= size; } };
  }
  function putClip(pcm16, { sampleRate = 16000, channels = 1, sampleCount = pcm16?.length, format = 'pcm_s16le' } = {}) {
    if (!(pcm16 instanceof Int16Array) || sampleRate !== 16000 || channels !== 1 || sampleCount !== pcm16.length) throw new TypeError('Expected exact 16 kHz mono PCM16 audio');
    if (clips.size >= maxClips) throw Object.assign(new Error('Audio clip count budget exceeded'), { code: 'VOICE_AUDIO_CLIPS_BUDGET' });
    if (inputBytes + pcm16.byteLength > maxInputBytes) throw Object.assign(new Error('Input audio copy budget exceeded'), { code: 'VOICE_INPUT_AUDIO_BUDGET', retryable: true, outcome: 'not_applied' });
    if (rawSamples + sampleCount > maxRawSamples) throw Object.assign(new Error('Raw audio time budget exceeded'), { code: 'VOICE_RAW_AUDIO_BUDGET', retryable: true, outcome: 'not_applied' });
    const reservation = reserve(pcm16.byteLength);
    const clipId = `clip-${++sequence}`;
    const ref = Object.freeze({ scopeId, clipId, format, sampleCount, byteLength: pcm16.byteLength });
    clips.set(clipId, { ref, data: new Int16Array(pcm16), references: 1, reservation, inputBytes: pcm16.byteLength, rawSamples: sampleCount });
    inputBytes += pcm16.byteLength; rawSamples += sampleCount;
    return ref;
  }
  const get = (ref) => {
    if (!ref || ref.scopeId !== scopeId || typeof ref.clipId !== 'string') throw Object.assign(new Error('Audio reference belongs to another scope'), { code: 'VOICE_AUDIO_REF_INVALID' });
    const value = clips.get(ref.clipId);
    if (!value || value.ref.sampleCount !== ref.sampleCount || value.ref.byteLength !== ref.byteLength) throw Object.assign(new Error('Audio reference is unavailable'), { code: 'VOICE_AUDIO_REF_MISSING' });
    return value;
  };
  return {
    scopeId,
    putClip,
    retain(ref) { get(ref).references++; return ref; },
    release(ref) { const value = get(ref); if (--value.references <= 0) { clips.delete(ref.clipId); value.reservation.release(); inputBytes -= value.inputBytes; rawSamples -= value.rawSamples; } },
    read(ref) { return new Int16Array(get(ref).data); },
    reserve,
    get stats() { return { clips: clips.size, bytes, inputBytes, rawSamples, maxBytes, maxInputBytes, maxRawSamples }; },
    clear() { for (const value of clips.values()) value.reservation.release(); clips.clear(); bytes = inputBytes = rawSamples = 0; },
  };
}
