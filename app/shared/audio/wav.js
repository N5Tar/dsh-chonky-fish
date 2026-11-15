const align = (n) => (n + 1) & ~1;
export function encodePcm16Wav(samples, { sampleRate = 16000, channels = 1 } = {}) {
  if (!(samples instanceof Int16Array) || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !Number.isInteger(channels) || channels < 1 || channels > 2 || samples.length % channels) throw new TypeError('Invalid PCM16 WAV input');
  const dataBytes = samples.byteLength, buffer = new ArrayBuffer(44 + align(dataBytes)), view = new DataView(buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + align(dataBytes), true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, dataBytes, true);
  new Int16Array(buffer, 44, samples.length).set(samples);
  return new Uint8Array(buffer);
}

export function inspectPcm16Wav(input, { maxBytes = 2 * 1024 * 1024, maxSeconds = 30 } = {}) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes || bytes.byteLength < 44 || bytes.byteLength > maxBytes) throw Object.assign(new Error('WAV size is invalid'), { code: 'VOICE_WAV_SIZE' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (p) => String.fromCharCode(...bytes.subarray(p, p + 4));
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE' || view.getUint32(4, true) !== bytes.byteLength - 8) throw Object.assign(new Error('Invalid RIFF/WAVE header'), { code: 'VOICE_WAV_HEADER' });
  let format = null, channels = null, sampleRate = null, bits = null, blockAlign = null, byteRate = null, dataOffset = -1, dataLength = -1;
  for (let p = 12; p + 8 <= bytes.length;) {
    const id = text(p), length = view.getUint32(p + 4, true), start = p + 8;
    if (start + length > bytes.length) throw Object.assign(new Error('Truncated WAV chunk'), { code: 'VOICE_WAV_TRUNCATED' });
    if (id === 'fmt ') { if (length < 16 || format !== null) throw Object.assign(new Error('WAV fmt chunk is truncated or duplicated'), { code: 'VOICE_WAV_FORMAT' }); format = view.getUint16(start, true); channels = view.getUint16(start + 2, true); sampleRate = view.getUint32(start + 4, true); byteRate = view.getUint32(start + 8, true); blockAlign = view.getUint16(start + 12, true); bits = view.getUint16(start + 14, true); }
    if (id === 'data') { if (dataOffset >= 0) throw Object.assign(new Error('WAV contains multiple data chunks'), { code: 'VOICE_WAV_FORMAT' }); dataOffset = start; dataLength = length; }
    p = start + length + (length & 1);
  }
  if (format !== 1 || bits !== 16 || ![1, 2].includes(channels) || !sampleRate || blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign || dataOffset < 0 || dataLength % (channels * 2) || dataLength / (channels * 2) / sampleRate > maxSeconds) throw Object.assign(new Error('Unsupported or invalid PCM WAV'), { code: 'VOICE_WAV_FORMAT' });
  return { sampleRate, channels, bitsPerSample: bits, sampleCount: dataLength / (channels * 2), dataOffset, dataLength };
}

export function decodePcm16Wav(input, options) {
  const wav = input instanceof Uint8Array ? input : new Uint8Array(input);
  const info = inspectPcm16Wav(wav, options);
  const samples = new Int16Array(info.sampleCount * info.channels);
  const view = new DataView(wav.buffer, wav.byteOffset + info.dataOffset, info.dataLength);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return { ...info, samples };
}
