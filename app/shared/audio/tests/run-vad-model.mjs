import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodePcm16Wav } from '../wav.js';

const root = new URL('../../../..', import.meta.url);
const model = new Uint8Array(await readFile(new URL('app/shared/audio/web/assets/silero_vad.onnx', root)));
const ort = await import('onnxruntime-web/wasm');
ort.env.wasm.numThreads = 1;
const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
assert.deepEqual(session.inputNames, ['input', 'state', 'sr']);
assert.deepEqual(session.outputNames, ['output', 'stateN']);

let state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
let context = new Float32Array(64);
async function infer(samples) {
  const input = new Float32Array(576); input.set(context); input.set(samples, 64);
  const result = await session.run({
    input: new ort.Tensor('float32', input, [1, 576]),
    state,
    sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []),
  });
  state = result.stateN; context = samples.slice(-64);
  const score = Number(result.output.data[0]);
  assert.ok(Number.isFinite(score) && score >= 0 && score <= 1);
  return score;
}

// Cold/reset inference validates the pinned model's true tensor contract.
for (let i = 0; i < 8; i++) await infer(new Float32Array(512));

// When a local speech WAV is supplied, exercise positive VAD decisions too.
const fixturePath = process.env.VOICE_VAD_FIXTURE;
if (fixturePath) {
  const fixtureBytes = new Uint8Array(await readFile(fixturePath));
  const fixture = decodePcm16Wav(fixtureBytes);
  assert.equal(fixture.sampleRate, 16000);
  assert.equal(fixture.channels, 1);
  state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]); context = new Float32Array(64);
  let positive = 0;
  for (let at = 0; at + 512 <= fixture.samples.length; at += 512) {
    const frame = Float32Array.from(fixture.samples.subarray(at, at + 512), (x) => x / 32768);
    if (await infer(frame) >= 0.5) positive++;
  }
  assert.ok(positive > 0, 'speech WAV should produce a positive Silero probability');
}

await session.release();

console.log(`Silero ONNX: tensor smoke passed${fixturePath ? ' with speech fixture' : ''}`);
