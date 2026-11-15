export function createLinearResampler(inputRate, outputRate = 16000) {
  if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000 || !Number.isInteger(outputRate) || outputRate < 8000 || outputRate > 48000) throw new RangeError('Sample rates are unsupported');
  const step = inputRate / outputRate;
  let pending = new Float32Array(0), position = 0;
  return {
    process(input) {
      if (!(input instanceof Float32Array)) throw new TypeError('Resampler input must be Float32Array');
      const joined = new Float32Array(pending.length + input.length); joined.set(pending); joined.set(input, pending.length);
      const out = new Float32Array(Math.max(0, Math.floor((joined.length - position - 1) / step)));
      let count = 0;
      while (position + 1 < joined.length && count < out.length) {
        const left = Math.floor(position), fraction = position - left;
        out[count++] = joined[left] * (1 - fraction) + joined[left + 1] * fraction;
        position += step;
      }
      const consumed = Math.floor(position);
      pending = joined.slice(consumed);
      position -= consumed;
      return out.slice(0, count);
    },
    flush() { const out = pending.length ? new Float32Array([pending[Math.min(Math.floor(position), pending.length - 1)]]) : new Float32Array(0); pending = new Float32Array(0); position = 0; return out; },
    reset() { pending = new Float32Array(0); position = 0; },
    get phase() { return position; },
  };
}

export function floatToPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) { const x = Math.max(-1, Math.min(1, samples[i])); out[i] = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767); }
  return out;
}
