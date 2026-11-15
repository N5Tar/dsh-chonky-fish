export function createSileroVad({ modelUrl, ortBaseUrl, ortModuleUrl = `${ortBaseUrl}/ort.min.js`, wasmPaths, threshold = 0.5, onSpeechStart = () => {}, onSpeechEnd = () => {}, onSamples = () => {}, onError = () => {}, workerUrl = new URL('./vad.worker.js', import.meta.url) } = {}) {
  if (!modelUrl || !ortModuleUrl) throw new TypeError('Silero modelUrl and ORT module URL are required');
  let worker = null, readyResolve, readyReject, closed = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  return {
    start() {
      if (worker) return ready;
      worker = new Worker(workerUrl, { name: 'chonkyfish-silero-vad' });
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') readyResolve(data);
        else if (data.type === 'speech-start') onSpeechStart(data.sampleIndex);
        else if (data.type === 'speech-end') onSpeechEnd(data.sampleIndex);
        else if (data.type === 'samples') onSamples(data.sampleIndex, data.probability);
        else if (data.type === 'error') { const e = Object.assign(new Error(data.message), { code: data.code }); if (readyResolve) readyReject(e); onError(e); }
      };
      worker.onerror = (event) => { const e = Object.assign(new Error(event.message || 'VAD Worker failed'), { code: 'VOICE_VAD_WORKER_FAILED' }); readyReject(e); onError(e); };
      worker.postMessage({ type: 'init', modelUrl, ortBaseUrl, ortModuleUrl, wasmPaths, threshold });
      return ready;
    },
    async push(samples) { if (!(samples instanceof Float32Array)) throw new TypeError('VAD requires Float32Array'); await ready; if (!closed) { const copy = samples.slice(); worker.postMessage({ type: 'pcm', samples: copy.buffer }, [copy.buffer]); } },
    reset() { if (!closed) worker?.postMessage({ type: 'reset' }); },
    close() { if (closed) return; closed = true; worker?.postMessage({ type: 'close' }); worker?.terminate(); worker = null; },
  };
}
