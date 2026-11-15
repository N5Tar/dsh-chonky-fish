import { createLinearResampler, floatToPcm16 } from '../resample.js';
import { createSileroVad } from './vad.js';
import { VOICE_LIMITS } from '../../../../core/modules/voice/limits.js';

export function createWebCapture({ audioStore, modelUrl, ortBaseUrl, ortModuleUrl, wasmPaths, workletUrl = new URL('./capture.worklet.js', import.meta.url), vadWorkerUrl = new URL('./vad.worker.js', import.meta.url), createVad = createSileroVad, mediaDevices = globalThis.navigator?.mediaDevices, AudioContextCtor = globalThis.AudioContext, monoNow = () => globalThis.performance?.now?.() ?? Date.now(), setIntervalFn = globalThis.setInterval, clearIntervalFn = globalThis.clearInterval, requireEchoCancellation = false, constraints = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false } } = {}) {
  if (!audioStore) throw new TypeError('audioStore is required');
  let stream = null, context = null, source = null, worklet = null, vad = null, resampler = null;
  let chunks = [], nextSample = 0, generation = 0, running = false, gated = false, callback = () => {}, turnActive = false, vadPaused = false, watchdog = null, lastSampleAt = 0, removeDeviceListener = null;
  const activeStatus = () => {
    const microphone = Boolean(mediaDevices?.getUserMedia && AudioContextCtor && typeof globalThis.AudioWorkletNode === 'function');
    const model = Boolean(modelUrl && ortModuleUrl && wasmPaths && workletUrl && vadWorkerUrl && typeof globalThis.Worker === 'function');
    return { available: microphone && model, microphoneAvailable: microphone, modelAvailable: model, sampleRate: 16000, channels: 1, format: 'pcm_s16le', vad: 'silero-onnx' };
  };
  function append(samples) {
    if (!samples.length) return;
    const pcm = floatToPcm16(samples), startSample = nextSample;
    chunks.push({ startSample, endSample: startSample + pcm.length, pcm }); nextSample += pcm.length;
    if (!turnActive) prune(Math.max(0, nextSample - 32000));
  }
  function getRange(startSample, endSample) {
    if (startSample < 0 || endSample <= startSample || endSample > nextSample) throw Object.assign(new Error('Capture sample range is unavailable'), { code: 'VOICE_CAPTURE_RANGE' });
    const result = new Int16Array(endSample - startSample); let written = 0;
    for (const chunk of chunks) {
      const from = Math.max(startSample, chunk.startSample), to = Math.min(endSample, chunk.endSample);
      if (to > from) { result.set(chunk.pcm.subarray(from - chunk.startSample, to - chunk.startSample), from - startSample); written += to - from; }
    }
    if (written !== result.length) throw Object.assign(new Error('Capture buffer has a sample gap'), { code: 'VOICE_CAPTURE_GAP' });
    return result;
  }
  function prune(before) { chunks = chunks.filter((x) => x.endSample > before); }
  async function stop() {
    ++generation; running = false;
    if (watchdog !== null) clearIntervalFn?.(watchdog); watchdog = null;
    removeDeviceListener?.(); removeDeviceListener = null;
    const oldStream = stream, oldContext = context, oldWorklet = worklet, oldSource = source, oldVad = vad;
    stream = context = worklet = source = vad = null; resampler = null; chunks = []; nextSample = 0; turnActive = false; vadPaused = false;
    try { oldWorklet?.port.postMessage({ type: 'close' }); oldWorklet?.disconnect(); } catch {}
    try { oldSource?.disconnect(); } catch {}
    try { oldStream?.getTracks?.().forEach((track) => track.stop()); } catch {}
    try { oldVad?.close(); } catch {}
    try { if (oldContext && oldContext.state !== 'closed') await oldContext.close(); } catch {}
  }
  return {
    inspect: activeStatus,
    async start({ onEvent, operation } = {}) {
      if (!mediaDevices?.getUserMedia || !AudioContextCtor || typeof AudioWorkletNode !== 'function') throw Object.assign(new Error('AudioWorklet microphone capture is unavailable'), { code: 'VOICE_CAPTURE_UNSUPPORTED' });
      if (!modelUrl || !ortModuleUrl || !wasmPaths || !workletUrl || !vadWorkerUrl) throw Object.assign(new Error('Pinned Silero model or ONNX runtime assets are unavailable'), { code: 'VOICE_VAD_ASSETS_UNAVAILABLE' });
      await stop();
      const mine = ++generation; callback = typeof onEvent === 'function' ? onEvent : () => {}; gated = false; turnActive = false; vadPaused = false; lastSampleAt = monoNow();
      let acquired;
      try { acquired = await mediaDevices.getUserMedia(constraints); }
      catch (e) { throw Object.assign(e, { code: e?.name === 'NotAllowedError' ? 'VOICE_MIC_PERMISSION' : 'VOICE_MIC_UNAVAILABLE', stage: 'capture' }); }
      if (mine !== generation || operation?.signal?.aborted) { acquired.getTracks().forEach((track) => track.stop()); return; }
      stream = acquired;
      const track = acquired.getAudioTracks?.()[0];
      const trackEnded = () => fail(new Error('Microphone input track ended'), 'VOICE_MIC_DISCONNECTED', mine);
      track?.addEventListener?.('ended', trackEnded, { once: true });
      if (track && !track.addEventListener) track.onended = trackEnded;
      if (requireEchoCancellation && mediaDevices.addEventListener) {
        const changed = () => fail(new Error('音频设备已变化，请重新开启通话以检查回声消除。'), 'VOICE_DEVICE_CHANGED', mine);
        mediaDevices.addEventListener('devicechange', changed);
        removeDeviceListener = () => mediaDevices.removeEventListener?.('devicechange', changed);
      }
      try {
        const actualSettings = track?.getSettings?.() || {};
        if (requireEchoCancellation && actualSettings.echoCancellation !== true && actualSettings.echoCancellation !== 'all') {
          throw Object.assign(new Error('当前麦克风未启用回声消除，无法开启扬声器插话通话。'), { code: 'VOICE_DUPLEX_UNAVAILABLE' });
        }
        context = new AudioContextCtor({ latencyHint: 'interactive' });
        await context.audioWorklet.addModule(workletUrl);
        if (mine !== generation) { acquired.getTracks().forEach((track) => track.stop()); await context.close(); return; }
        resampler = createLinearResampler(context.sampleRate, 16000);
        const trackSettings = acquired.getAudioTracks?.()[0]?.getSettings?.() || {};
        const captureVad = createVad({ modelUrl, ortBaseUrl, ortModuleUrl, wasmPaths, workerUrl: vadWorkerUrl,
          onSpeechStart: (sampleIndex) => { if (!gated && mine === generation) { turnActive = true; callback({ type: 'speech-start', sampleIndex: Math.max(0, sampleIndex) }); } },
          onSpeechEnd: (sampleIndex) => { if (!gated && mine === generation) callback({ type: 'speech-end', sampleIndex: Math.max(0, sampleIndex) }); },
          onSamples: (sampleIndex, level) => { if (!gated && mine === generation) callback({ type: 'samples', sampleIndex, level }); },
          onError: (error) => { fail(error, error?.code || 'VOICE_VAD_FAILED', mine); },
        });
        vad = captureVad; await captureVad.start();
        source = context.createMediaStreamSource(acquired);
        worklet = new AudioWorkletNode(context, 'chonkyfish-voice-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        worklet.port.onmessage = ({ data }) => {
          if (!running || vadPaused || mine !== generation || data?.type !== 'pcm') return;
          lastSampleAt = monoNow();
          if (gated) return;
          const pcm = resampler.process(new Float32Array(data.samples)); append(pcm);
          void captureVad.push(pcm).catch((error) => callback({ type: 'error', error }));
        };
        source.connect(worklet); running = true;
        watchdog = setIntervalFn?.(() => { if (running && mine === generation && monoNow() - lastSampleAt >= VOICE_LIMITS.samplingStallMs) fail(new Error('No microphone samples arrived for two seconds'), 'VOICE_CAPTURE_STALLED', mine); }, 500) ?? null;
        return { sampleRate: 16000, sourceSampleRate: context.sampleRate, trackSettings, duplex: { nearEndDetection: true, echoCancellationEnabled: trackSettings.echoCancellation === true || trackSettings.echoCancellation === 'all', implementation: 'browser-aec', deviceVerified: false } };
      } catch (e) {
        await stop(); throw Object.assign(e, { code: e?.code || 'VOICE_CAPTURE_START_FAILED', stage: 'capture' });
      }
    },
    fail,
    cut({ startSample, endSample }) {
      if (!running) throw Object.assign(new Error('Capture is stopped'), { code: 'VOICE_CAPTURE_STOPPED' });
      if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample) || endSample <= startSample || endSample - startSample > VOICE_LIMITS.clipSeconds * 16000) throw Object.assign(new Error('Capture clip range exceeds the 15 second limit'), { code: 'VOICE_CAPTURE_RANGE' });
      const pcm = getRange(startSample, endSample);
      const clip = audioStore.putClip(pcm, { sampleRate: 16000, channels: 1, sampleCount: pcm.length });
      prune(endSample - 4800);
      return clip;
    },
    setTurnActive(value) { turnActive = Boolean(value); if (!turnActive) prune(Math.max(0, nextSample - 32000)); },
    gate(value) {
      const next = Boolean(value);
      if (next === gated) return;
      gated = next; lastSampleAt = monoNow(); turnActive = false; chunks = []; nextSample = 0; resampler?.reset(); vad?.reset();
    },
    stop,
    release: stop,
    get status() { return { ...activeStatus(), running, gated, sampleCount: nextSample, bufferedSamples: chunks.reduce((sum, x) => sum + x.pcm.length, 0), turnActive, vadPaused }; },
  };
  function fail(cause, code, mine = generation) {
    if (mine !== generation || vadPaused) return;
    vadPaused = true; running = false;
    const failure = Object.assign(new Error(cause?.message || String(cause)), { code, cause });
    try { callback({ type: 'error', error: failure }); } catch {}
    void stop();
  }
}
