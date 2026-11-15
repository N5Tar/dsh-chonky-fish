let session, ortRuntime, state, pending = new Float32Array(0), samplesSeen = 0;
let active = false, activeFrames = 0, silentFrames = 0, threshold = 0.5;
let inferenceQueue = Promise.resolve(), queuedSamples = 0, paused = false, generation = 0;
let context = new Float32Array(64);
const WINDOW = 512, CONTEXT = 64, SAMPLE_RATE = 16000, MAX_BACKLOG_SAMPLES = SAMPLE_RATE / 2;
function send(type, extra = {}) { self.postMessage({ type, ...extra }); }
function tensor(data, dims) { return new ortRuntime.Tensor('float32', data, dims); }
async function infer(frame, expectedGeneration) {
  const inputName = session.inputNames.find((x) => /input/i.test(x)) || session.inputNames[0];
  const stateName = session.inputNames.find((x) => /state/i.test(x));
  const srName = session.inputNames.find((x) => /^sr$/i.test(x) || /sample.?rate/i.test(x));
  const feeds = { [inputName]: tensor(frame, [1, CONTEXT + WINDOW]) };
  const previousState = state;
  if (stateName && previousState) feeds[stateName] = previousState;
  if (srName) feeds[srName] = new ortRuntime.Tensor('int64', BigInt64Array.from([16000n]), []);
  const result = await session.run(feeds);
  if (expectedGeneration !== generation) return null;
  const probabilityName = session.outputNames.find((x) => /output|prob/i.test(x)) || session.outputNames[0];
  const probability = Number(result[probabilityName]?.data?.[0] ?? 0);
  const nextStateName = session.outputNames.find((x) => /state/i.test(x));
  if (nextStateName) state = result[nextStateName];
  context = new Float32Array(feeds[inputName].data.subarray(WINDOW));
  return Number.isFinite(probability) ? probability : 0;
}
async function consume(data, expectedGeneration) {
  const joined = new Float32Array(pending.length + data.length); joined.set(pending); joined.set(data, pending.length);
  let offset = 0;
  while (offset + WINDOW <= joined.length && session) {
    const frame = joined.slice(offset, offset + WINDOW);
    const input = new Float32Array(CONTEXT + WINDOW); input.set(context); input.set(frame, CONTEXT);
    const probability = await infer(input, expectedGeneration);
    if (expectedGeneration !== generation || probability === null) return;
    const frameStart = samplesSeen; samplesSeen += WINDOW; offset += WINDOW;
    if (probability >= threshold) { activeFrames++; silentFrames = 0; if (!active && activeFrames >= 2) { active = true; send('speech-start', { sampleIndex: frameStart - WINDOW }); } }
    else { activeFrames = 0; silentFrames++; if (active && silentFrames >= 12) { active = false; send('speech-end', { sampleIndex: frameStart - (silentFrames - 1) * WINDOW }); } }
    send('samples', { sampleIndex: samplesSeen, probability });
  }
  pending = joined.slice(offset);
}
self.onmessage = async ({ data }) => {
  try {
    if (data?.type === 'init') {
      threshold = Number.isFinite(data.threshold) ? data.threshold : 0.5;
      importScripts(data.ortModuleUrl);
      ortRuntime = self.ort;
      ortRuntime.env.wasm.numThreads = 1;
      ortRuntime.env.wasm.proxy = false;
      if (data.wasmPaths) ortRuntime.env.wasm.wasmPaths = data.wasmPaths;
      session = await ortRuntime.InferenceSession.create(data.modelUrl, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      const stateInput = session.inputNames.find((x) => /state/i.test(x));
      if (stateInput) state = tensor(new Float32Array(2 * 1 * 128), [2, 1, 128]);
      send('ready', { inputs: session.inputNames, outputs: session.outputNames });
    } else if (data?.type === 'pcm' && session && !paused) {
      const copy = new Float32Array(data.samples), expectedGeneration = generation; queuedSamples += copy.length;
      if (queuedSamples > MAX_BACKLOG_SAMPLES) { queuedSamples -= copy.length; paused = true; send('error', { message: 'VAD inference is more than 500 ms behind capture', code: 'VOICE_VAD_BACKLOG' }); return; }
      inferenceQueue = inferenceQueue.then(() => { if (expectedGeneration === generation && !paused) return consume(copy, expectedGeneration); }).catch((e) => { paused = true; send('error', { message: String(e?.message || e), code: 'VOICE_VAD_FAILED' }); }).finally(() => { queuedSamples -= copy.length; });
    }
    else if (data?.type === 'reset') { generation++; state = tensor(new Float32Array(2 * 1 * 128), [2, 1, 128]); context = new Float32Array(CONTEXT); pending = new Float32Array(0); samplesSeen = 0; active = false; activeFrames = 0; silentFrames = 0; paused = false; send('reset'); }
    else if (data?.type === 'close') { session?.release(); session = null; close(); }
  } catch (e) { send('error', { message: String(e?.message || e), code: 'VOICE_VAD_FAILED' }); }
};
