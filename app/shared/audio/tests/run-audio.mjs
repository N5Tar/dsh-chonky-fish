import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createMemoryAudioStore } from '../clips.js';
import { encodePcm16Wav, decodePcm16Wav } from '../wav.js';
import { createLinearResampler } from '../resample.js';
import { createWebCapture } from '../web/capture.js';

let groups = 0;
function test(name, run) { return Promise.resolve().then(run).then(() => { groups++; console.log(`ok ${groups} - ${name}`); }); }
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

await test('memory clips release refcounted bytes and raw time reservations', () => {
  const store = createMemoryAudioStore();
  const ref = store.putClip(new Int16Array(16000));
  assert.equal(store.stats.rawSamples, 16000);
  store.release(ref);
  assert.deepEqual([store.stats.clips, store.stats.bytes, store.stats.rawSamples], [0, 0, 0]);
  assert.throws(() => createMemoryAudioStore({ maxRawSamples: 100 }).putClip(new Int16Array(101)), { code: 'VOICE_RAW_AUDIO_BUDGET' });
});

await test('WAV round trips exact PCM16 frames and rejects malformed limits', () => {
  const input = Int16Array.from([-32768, -1, 0, 1, 32767]);
  const wav = encodePcm16Wav(input);
  const decoded = decodePcm16Wav(wav);
  assert.equal(decoded.sampleRate, 16000);
  assert.deepEqual([...decoded.samples], [...input]);
  assert.throws(() => decodePcm16Wav(wav, { maxBytes: 20 }), { code: 'VOICE_WAV_SIZE' });
});

await test('stateful resampling emits stable 16 kHz output across input chunk boundaries', () => {
  const resampler = createLinearResampler(48000, 16000);
  const source = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10));
  const one = resampler.process(source);
  const split = createLinearResampler(48000, 16000);
  const chunks = [split.process(source.slice(0, 1001)), split.process(source.slice(1001, 3200)), split.process(source.slice(3200))];
  assert.equal(one.length, chunks.reduce((n, x) => n + x.length, 0));
  assert.ok(one.length >= 1598 && one.length <= 1600);
});

await test('capture keeps a two second idle ring and drops to that ring after an active turn', async () => {
  let worklet;
  class FakeTrack { constructor() { this.stopped = false; } stop() { this.stopped = true; } getSettings() { return {}; } addEventListener() {} }
  const track = new FakeTrack();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class FakeContext {
    sampleRate = 16000; state = 'running'; audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect(node) { worklet = node; }, disconnect() {} }; }
    async close() { this.state = 'closed'; }
  }
  globalThis.AudioWorkletNode = class { constructor() { this.port = { postMessage() {} }; this.disconnect = () => {}; } };
  const store = createMemoryAudioStore();
  const capture = createWebCapture({ audioStore: store, modelUrl: 'm', ortModuleUrl: 'ort', wasmPaths: { mjs: 'mjs', wasm: 'wasm' }, workletUrl: 'worklet', vadWorkerUrl: 'worker', mediaDevices: { getUserMedia: async () => stream }, AudioContextCtor: FakeContext, setIntervalFn: () => 1, clearIntervalFn: () => {}, createVad: ({ onSpeechStart, onSamples }) => ({ start: async () => {}, push: async () => {}, reset() {}, close() {}, speechStart: onSpeechStart, samples: onSamples }) });
  await capture.start({ onEvent() {} });
  const block = () => worklet.port.onmessage({ data: { type: 'pcm', samples: new Float32Array(128).fill(.1) } });
  for (let i = 0; i < 500; i++) block();
  assert.ok(capture.status.bufferedSamples <= 32000);
  capture.setTurnActive(true);
  for (let i = 0; i < 500; i++) block();
  assert.ok(capture.status.bufferedSamples > 32000);
  capture.setTurnActive(false);
  assert.ok(capture.status.bufferedSamples <= 32000);
  await capture.stop();
  assert.equal(track.stopped, true);
  delete globalThis.AudioWorkletNode;
});

await test('speaker gate preserves the sample watchdog while dropping gated PCM and resuming VAD', async () => {
  let worklet, now = 0, watchdog, pushes = 0; const events = [];
  class FakeTrack { stopped = false; stop() { this.stopped = true; } getSettings() { return {}; } addEventListener() {} }
  const track = new FakeTrack(), stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class FakeContext { sampleRate = 16000; state = 'running'; audioWorklet = { addModule: async () => {} }; createMediaStreamSource() { return { connect(node) { worklet = node; }, disconnect() {} }; } async close() { this.state = 'closed'; } }
  globalThis.AudioWorkletNode = class { constructor() { this.port = { postMessage() {} }; this.disconnect = () => {}; } };
  const capture = createWebCapture({ audioStore: createMemoryAudioStore(), modelUrl: 'm', ortModuleUrl: 'ort', wasmPaths: { mjs: 'mjs', wasm: 'wasm' }, workletUrl: 'worklet', vadWorkerUrl: 'worker', mediaDevices: { getUserMedia: async () => stream }, AudioContextCtor: FakeContext, monoNow: () => now, setIntervalFn: (fn) => { watchdog = fn; return 1; }, clearIntervalFn: () => {}, createVad: ({ onError }) => ({ start: async () => {}, push: async () => { pushes++; }, reset() {}, close() {}, onError }) });
  await capture.start({ onEvent: (event) => events.push(event) });
  const block = () => worklet.port.onmessage({ data: { type: 'pcm', samples: new Float32Array(128).fill(.1) } });
  capture.gate(true);
  for (let i = 0; i <= 100; i++) { now = i * 40; block(); watchdog(); }
  assert.equal(capture.status.running, true, 'active samples during a four-second speaker gate keep the watchdog fresh');
  assert.equal(pushes, 0, 'gated microphone PCM never reaches Silero');
  capture.gate(false); now += 10; block();
  assert.equal(pushes, 1, 'VAD resumes as soon as capture ungates');
  now += 2100; watchdog();
  assert.ok(events.some((event) => event.type === 'error' && event.error?.code === 'VOICE_CAPTURE_STALLED'), 'a real post-ungate sampling stall is still detected');
  await capture.stop(); delete globalThis.AudioWorkletNode;
});

await test('VAD Worker serializes recurrent inference and pauses when more than 500 ms queues', async () => {
  const source = readFileSync(new URL('../web/vad.worker.js', import.meta.url), 'utf8');
  let concurrent = 0, maximumConcurrent = 0;
  const messages = [];
  const fakeOrt = {
    env: { wasm: {} }, Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } },
    InferenceSession: { async create() { return { inputNames: ['input', 'state', 'sr'], outputNames: ['output', 'stateN'], async run() { concurrent++; maximumConcurrent = Math.max(maximumConcurrent, concurrent); await delay(2); concurrent--; return { output: { data: new Float32Array([0]) }, stateN: {} }; }, release() {} }; } },
  };
  const self = { postMessage: (message) => messages.push(message), close() {}, importScripts() { self.ort = fakeOrt; } };
  const context = vm.createContext({ self, importScripts: self.importScripts.bind(self), BigInt64Array, Float32Array, Uint8Array, Math, Number, String, Promise, setTimeout, clearTimeout, close() {} });
  vm.runInContext(source, context);
  await self.onmessage({ data: { type: 'init', modelUrl: 'm', ortModuleUrl: 'ort' } });
  await self.onmessage({ data: { type: 'pcm', samples: new Float32Array(2048).buffer } });
  await self.onmessage({ data: { type: 'pcm', samples: new Float32Array(2048).buffer } });
  await delay(40);
  assert.equal(maximumConcurrent, 1);
  await self.onmessage({ data: { type: 'pcm', samples: new Float32Array(6000).buffer } });
  await self.onmessage({ data: { type: 'pcm', samples: new Float32Array(3000).buffer } });
  assert.ok(messages.some((m) => m.type === 'error' && m.code === 'VOICE_VAD_BACKLOG'));
});

await test('classic VAD Worker loads the pinned ORT UMD without a global lexical collision', async () => {
  const workerSource = readFileSync(new URL('../web/vad.worker.js', import.meta.url), 'utf8');
  const ortSource = readFileSync(new URL('../web/assets/onnxruntime-web.min.js', import.meta.url), 'utf8');
  const messages = [];
  const sandbox = { console, setTimeout, clearTimeout, BigInt64Array, Float32Array, Uint8Array, Math, Number, String, Promise, close() {}, postMessage: (message) => messages.push(message) };
  const context = vm.createContext(sandbox); sandbox.self = sandbox;
  sandbox.importScripts = () => {
    vm.runInContext(ortSource, context);
    sandbox.ort.InferenceSession.create = async () => ({ inputNames: ['input', 'state', 'sr'], outputNames: ['output', 'stateN'], async run() { return { output: { data: new Float32Array([0]) }, stateN: sandbox.ort.Tensor ? new sandbox.ort.Tensor('float32', new Float32Array(256), [2, 1, 128]) : null }; }, release() {} });
  };
  vm.runInContext(workerSource, context);
  await sandbox.onmessage({ data: { type: 'init', modelUrl: 'model', ortModuleUrl: 'pinned-ort' } });
  assert.ok(messages.some((message) => message.type === 'ready'));
  assert.ok(!messages.some((message) => message.type === 'error'));
});

await test('speaker duplex requires an actually enabled echo cancellation track and stops rejected tracks', async () => {
  let stopped = 0;
  const track = { stop() { stopped++; }, getSettings() { return { echoCancellation: false }; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class FakeContext { sampleRate = 16000; state = 'running'; audioWorklet = { addModule: async () => {} }; createMediaStreamSource() { return { connect() {}, disconnect() {} }; } async close() { this.state = 'closed'; } }
  globalThis.AudioWorkletNode = class { constructor() { this.port = { postMessage() {} }; } disconnect() {} };
  const capture = createWebCapture({ audioStore: createMemoryAudioStore(), requireEchoCancellation: true, modelUrl: 'm', ortModuleUrl: 'ort', wasmPaths: {}, workletUrl: 'worklet', vadWorkerUrl: 'worker', mediaDevices: { getUserMedia: async () => stream }, AudioContextCtor: FakeContext, setIntervalFn: () => 1, clearIntervalFn() {}, createVad: () => ({ async start() {}, close() {} }) });
  await assert.rejects(capture.start(), { code: 'VOICE_DUPLEX_UNAVAILABLE' });
  assert.equal(stopped, 1, 'a rejected duplex capture must release the microphone');
  delete globalThis.AudioWorkletNode;
});

console.log(`shared audio: ${groups} groups passed`);
