class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.sequence = 0; this.closed = false; this.port.onmessage = (event) => { if (event.data?.type === 'close') this.closed = true; }; }
  process(inputs) {
    if (this.closed) return false;
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    const length = channels[0].length, mono = new Float32Array(length);
    for (let c = 0; c < channels.length; c++) for (let i = 0; i < length; i++) mono[i] += channels[c][i] / channels.length;
    this.port.postMessage({ type: 'pcm', sequence: this.sequence, samples: mono }, [mono.buffer]);
    this.sequence += length;
    return true;
  }
}
registerProcessor('chonkyfish-voice-capture', VoiceCaptureProcessor);
