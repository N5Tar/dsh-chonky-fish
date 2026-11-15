import assert from 'node:assert/strict';
import { createVoiceService } from '../service.js';
import { createMemoryAudioStore } from '../../../../app/shared/audio/clips.js';

const REF = Object.freeze({ runtimeId: 'fixture-runtime', conversationId: 'fixture-chat', bindingRevision: 'binding-1' });
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await delay(0); } }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function fixture({ captureStart, synthesis, config } = {}) {
  let id = 0, now = 0, sequence = 0, follow, captureEvents, renewals = 0, stoppedCaptures = 0, captureStarts = 0, playbackStops = 0, submitted = [], prepared = 0, played = 0, released = 0, conversationReleases = 0;
  const timers = new Map();
  const audio = createMemoryAudioStore();
  const capture = {
    inspect: async () => ({ available: true }),
    async start(args) { captureStarts++; captureEvents = args.onEvent; return captureStart ? captureStart(args) : undefined; },
    cut({ startSample, endSample }) { return audio.putClip(new Int16Array(endSample - startSample)); },
    async setTurnActive() {}, async gate(value) { capture.gated = Boolean(value); }, async stop() { stoppedCaptures++; }, async release() {},
  };
  const conversation = {
    inspect: async () => ({ available: true, valid: true }), async retain() {}, async release() { conversationReleases++; },
    async prepareSubmission({ inputId }) { return { submissionId: `sub-${++prepared}`, inputId }; },
    async submit(payload) { submitted.push(payload); return { accepted: true, evidence: 'fixture-receipt' }; },
    async inspectAdmission() { return { status: 'unknown' }; },
    async follow(_ref, options) { follow = options.onBatch; options.onBatch({ streamGeneration: 1, cursor: 'base', reset: true, events: [] }); return () => {}; },
  };
  let transcriptions = 0;
  const recognition = { inspect: async () => ({ available: true, selection: { providerId: 'fixture-asr', language: 'zh' } }), async transcribe() { return { text: `口述${++transcriptions}` }; } };
  const speaker = synthesis || { async inspect() { return { available: true }; }, async synthesize() { return audio.putClip(new Int16Array(1600)); }, async release(ref) { released++; audio.release(ref); } };
  const playback = {
    inspect: async () => ({ available: true }), async unlock() { return { ready: true }; },
    async play(_ref, options) { played++; options.onStarted?.(); options.onEnded?.(); return { ended: true }; }, async stop() { playbackStops++; }, async release() {},
  };
  const ownership = { async acquire() { return { valid: true, leaseMs: 15000 }; }, async renew() { renewals++; return { valid: true, leaseMs: 15000 }; }, async release() {} };
  const clock = { monoNow: () => now, schedule(fn, ms) { const handle = { fn, ms, cancelled: false }; timers.set(handle, handle); return handle; }, cancel(handle) { if (handle) handle.cancelled = true; } };
  const service = createVoiceService({ capture, recognition, conversation, synthesis: speaker, playback, ownership, audio, clock, ids: { createId: (kind) => `${kind}-${++id}` }, config });
  const begin = async (ref = REF) => { const unlockResult = await playback.unlock(); return service.start(ref, { unlockResult }); };
  const speak = async () => {
    const start = sequence + 10000, end = start + 1200;
    captureEvents({ type: 'speech-start', sampleIndex: start });
    captureEvents({ type: 'speech-end', sampleIndex: end });
    captureEvents({ type: 'samples', sampleIndex: end + 19200 });
    sequence += 30000;
    await settle();
  };
  const emit = (events) => follow({ streamGeneration: 1, cursor: `c-${Math.random()}`, reset: false, events });
  const advanceTimer = async (ms) => { now += ms; for (const handle of [...timers.keys()]) if (!handle.cancelled && handle.ms <= ms) { timers.delete(handle); await handle.fn(); } await settle(); };
  return { service, audio, capture, playback, conversation, recognition, ownership, begin, speak, emit, submitted, timers, advanceTimer, get renewals() { return renewals; }, get stoppedCaptures() { return stoppedCaptures; }, get captureStarts() { return captureStarts; }, get playbackStops() { return playbackStops; }, get played() { return played; }, get released() { return released; }, get conversationReleases() { return conversationReleases; }, get captureEvents() { return captureEvents; }, get follow() { return follow; }, get prepared() { return prepared; } };
}

let groups = 0;
async function test(name, run) { if (process.env.VOICE_TEST_FILTER && !name.includes(process.env.VOICE_TEST_FILTER)) return; await run(); groups++; console.log(`ok ${groups} - ${name}`); }

await test('startup identifies the unavailable capability before acquiring capture', async () => {
  for (const [port, code, stage] of [
    ['capture', 'VOICE_CAPTURE_UNSUPPORTED', 'capture'],
    ['recognition', 'VOICE_RECOGNITION_UNAVAILABLE', 'recognition'],
    ['playback', 'VOICE_PLAYBACK_UNSUPPORTED', 'playback'],
    ['synthesis', 'VOICE_TTS_UNSUPPORTED', 'synthesis'],
  ]) {
    const f = port === 'synthesis' ? fixture({ synthesis: { inspect: () => ({ available: false }) } }) : fixture();
    if (port !== 'synthesis') f[port].inspect = () => ({ available: false });
    await assert.rejects(f.begin(), error => error.code === code && error.stage === stage);
    assert.equal(f.service.getSnapshot().error.code, code);
    assert.equal(f.captureStarts, 0);
    await f.service.dispose();
  }
});

await test('output-only mode speaks new keyboard replies without ASR or microphone access', async () => {
  const f = fixture(); let captureInspections = 0, recognitionInspections = 0, captureGates = 0;
  f.capture.inspect = () => { captureInspections++; return { available: false }; };
  f.recognition.inspect = () => { recognitionInspections++; return { available: false }; };
  f.capture.gate = () => { captureGates++; };
  await f.service.start(REF, { unlockResult: { ready: true }, inputEnabled: false });
  assert.equal(f.service.getSnapshot().call.inputEnabled, false);
  assert.equal(f.service.getSnapshot().capture.status, 'stopped');
  assert.equal(f.captureStarts, 0);
  assert.equal(captureInspections, 0);
  assert.equal(recognitionInspections, 0);
  f.emit([{ type: 'input.consumed', submissionId: 'typed', conversationTurnId: 'typed-turn', origin: 'local' }, { type: 'reply.final', replyId: 'typed-reply', conversationTurnId: 'typed-turn', text: '打字也会读给你听。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'typed-turn', outcome: 'completed' }]);
  await settle();
  assert.equal(f.played, 1);
  assert.equal(f.released, 1);
  assert.equal(captureGates, 0, 'output-only playback never gates a microphone');
  await f.service.mute(); await f.service.unmute();
  assert.equal(f.captureStarts, 0, 'unmute cannot enable an output-only microphone');
  await f.service.hangup(); await f.service.dispose();
});

await test('mode transitions keep unlocked playback while disposal still releases it', async () => {
  const f = fixture(); let playbackReleases = 0;
  f.playback.release = async () => { playbackReleases++; };
  await f.service.start(REF, { unlockResult: { ready: true }, inputEnabled: false });
  await f.service.hangup({ abandonPending: true, preservePlayback: true });
  assert.equal(playbackReleases, 0, 'switching modes preserves the context unlocked by the Send or microphone click');
  await f.begin();
  assert.equal(f.captureStarts, 1);
  assert.equal(f.service.getSnapshot().call.inputEnabled, true);
  await f.service.dispose();
  assert.ok(playbackReleases > 0, 'real disposal always releases preserved playback resources');
});

await test('fake non-DSH conversation auto-submits twenty ordered rounds with released audio', async () => {
  const f = fixture(); await f.begin();
  for (let i = 0; i < 20; i++) {
    await f.speak();
    assert.equal(f.submitted.length, i + 1);
    const submissionId = f.submitted[i].submissionId;
    f.emit([
      { type: 'input.accepted', submissionId, evidence: 'fixture-event' },
      { type: 'input.consumed', submissionId, messageId: `message-${i}`, conversationTurnId: `turn-${i}`, origin: 'local' },
      { type: 'turn.ended', conversationTurnId: `turn-${i}`, outcome: 'completed' },
    ]);
    await settle();
  }
  assert.equal(f.audio.stats.clips, 0);
  assert.equal(f.audio.stats.rawSamples, 0);
  await f.service.hangup(); await settle();
});

await test('ConversationRef clones share a stable call scope across every conversation port', async () => {
  const f = fixture(), calls = [];
  const record = (name, ref, scopeId) => calls.push({ name, ref, scopeId });
  const inspect = f.conversation.inspect.bind(f.conversation), retain = f.conversation.retain.bind(f.conversation), release = f.conversation.release.bind(f.conversation), follow = f.conversation.follow.bind(f.conversation), prepare = f.conversation.prepareSubmission.bind(f.conversation);
  f.conversation.inspect = async (ref, options) => { record('inspect', ref, options?.scopeId); return inspect(ref, options); };
  f.conversation.retain = async (ref, options) => { record('retain', ref, options?.scopeId); return retain(ref, options); };
  f.conversation.release = async (ref, options) => { record('release', ref, options?.scopeId); return release(ref, options); };
  f.conversation.follow = async (ref, options) => { record('follow', ref, options?.scopeId); return follow(ref, options); };
  f.conversation.prepareSubmission = async (payload) => { record('prepare', payload.conversationRef, payload.scopeId); return prepare(payload); };
  f.conversation.submit = async (payload) => { record('submit', payload.conversationRef, payload.scopeId); throw new Error('exercise admission inspection'); };
  f.conversation.inspectAdmission = async (payload) => { record('inspectAdmission', payload.conversationRef, payload.scopeId); return { status: 'unknown' }; };
  await f.begin(REF); await f.speak(); await f.service.hangup();
  assert.deepEqual(calls.map((call) => call.name), ['inspect', 'retain', 'follow', 'prepare', 'submit', 'inspectAdmission', 'release']);
  assert.ok(calls.every((call) => typeof call.scopeId === 'string' && call.scopeId.startsWith('call-')));
  assert.equal(new Set(calls.map((call) => call.scopeId)).size, 1);
  for (const call of calls) { assert.notEqual(call.ref, REF); assert.deepEqual(call.ref, REF); }
});

await test('accepted input B is delivered while A is still running', async () => {
  const f = fixture(); await f.begin(); await f.speak(); await f.speak();
  assert.equal(f.submitted.length, 2, 'a long-running accepted turn must not block the next utterance');
  const first = f.submitted[0].submissionId;
  f.emit([{ type: 'input.accepted', submissionId: first }, { type: 'input.consumed', submissionId: first, conversationTurnId: 'turn-A', origin: 'local' }]);
  await settle(); assert.equal(f.submitted.length, 2);
  f.emit([{ type: 'turn.ended', conversationTurnId: 'turn-A', outcome: 'completed' }]);
  await settle(); assert.equal(f.submitted.length, 2);
  await f.service.hangup();
});

await test('late permission/start completion cannot resurrect a hung-up call', async () => {
  const gate = deferred(), f = fixture({ captureStart: () => gate.promise });
  const start = f.begin(); await settle();
  assert.equal(f.service.getSnapshot().call.status, 'preparing');
  await f.service.hangup();
  gate.resolve();
  await assert.rejects(start, { code: 'VOICE_CANCELLED' });
  assert.equal(f.service.getSnapshot().call.status, 'ended');
  assert.equal(f.stoppedCaptures, 1);
});

await test('restart waits for old singleton media cleanup before starting a new call', async () => {
  const f = fixture(); await f.begin();
  const stopping = deferred(); f.capture.stop = () => stopping.promise;
  const hangingUp = f.service.hangup();
  const restart = f.begin(); await settle(); assert.equal(f.captureStarts, 1);
  stopping.resolve(); await hangingUp; await restart;
  assert.equal(f.captureStarts, 2);
  assert.equal(f.service.getSnapshot().call.status, 'connected');
  await f.service.hangup();
});

await test('hangup awaits media cleanup while retaining the old in-flight target drain across restart', async () => {
  const f = fixture(), submitGate = deferred(), nextRef = { runtimeId: 'fixture-runtime', conversationId: 'fixture-chat-2', bindingRevision: 'binding-2' };
  const captureStopGate = deferred(), leaseReleaseGate = deferred();
  f.conversation.submit = (payload) => { f.submitted.push(payload); return payload.conversationRef.conversationId === REF.conversationId ? submitGate.promise : Promise.resolve({ accepted: true, evidence: 'new-target-receipt' }); };
  await f.begin(); await f.speak(); await settle();
  assert.equal(f.submitted.length, 1);
  const oldFollow = f.follow;
  f.capture.stop = () => captureStopGate.promise;
  f.ownership.release = () => leaseReleaseGate.promise;
  let hangupSettled = false;
  const hangingUp = f.service.hangup().then((value) => { hangupSettled = true; return value; });
  await settle(); assert.equal(hangupSettled, false, 'hangup waits for capture teardown and ownership release');
  const restarting = f.begin(nextRef); await settle(); assert.equal(f.captureStarts, 1, 'a new target cannot attach to the media port before cleanup');
  captureStopGate.resolve(); await settle(); assert.equal(hangupSettled, false, 'hangup also waits for lease release');
  leaseReleaseGate.resolve(); const endedSnapshot = await hangingUp;
  assert.equal(endedSnapshot.call.status, 'ended');
  assert.equal(f.conversationReleases, 0, 'in-flight prompt keeps the old conversation retained');
  await restarting;
  assert.equal(f.service.getSnapshot().call.conversationRef.conversationId, nextRef.conversationId);
  await f.speak(); await settle();
  assert.equal(f.submitted.length, 2, 'new target delivery can proceed while the old target drains');
  assert.equal(f.submitted[1].conversationRef.conversationId, nextRef.conversationId);
  oldFollow({ streamGeneration: 1, cursor: 'late-old-turn', reset: false, events: [
    { type: 'input.accepted', submissionId: 'sub-1', evidence: 'late-old-target-proof' },
    { type: 'input.consumed', submissionId: 'sub-1', conversationTurnId: 'old-call-turn', origin: 'local' },
    { type: 'reply.final', replyId: 'old-call-reply', conversationTurnId: 'old-call-turn', text: '旧目标的迟到回复。', origin: 'local' },
    { type: 'turn.ended', conversationTurnId: 'old-call-turn', outcome: 'completed' },
  ] });
  await settle();
  assert.equal(f.service.getSnapshot().inputs[0].admission, 'accepted');
  assert.equal(f.played, 0, 'late old-target reply must never play in the new call');
  assert.equal(f.service.getSnapshot().replies.find((reply) => reply.replyId === 'old-call-reply').replayable, false);
  await assert.rejects(f.service.replayReply('old-call-reply'), { code: 'VOICE_REPLY_NOT_REPLAYABLE' });
  assert.equal(f.submitted.filter((input) => input.inputId === f.submitted[0].inputId).length, 1, 'late evidence must not resubmit the old input');
  await f.advanceTimer(30000);
  assert.equal(f.conversationReleases, 1, 'old drain releases its independent target at the 30 second bound');
  submitGate.resolve({ accepted: true, evidence: 'late-receipt' }); await settle();
  assert.equal(f.submitted.length, 2);
  await f.service.hangup();
  assert.equal(f.conversationReleases, 2);
});

await test('mute holds an ASR result that arrives after mute instead of auto-sending on resume', async () => {
  const f = fixture(), asr = deferred(); f.recognition.transcribe = () => asr.promise;
  await f.begin(); await f.speak(); await f.service.mute();
  asr.resolve({ text: '保留这句话' }); await settle();
  assert.equal(f.submitted.length, 0);
  assert.equal(f.service.getSnapshot().inputs[0].status, 'held');
  await f.service.unmute(); await settle(); assert.equal(f.submitted.length, 0);
  await f.service.submitHeld(f.service.getSnapshot().inputs[0].inputId); assert.equal(f.submitted.length, 1);
  await f.service.hangup();
});

await test('plain hangup preserves held rows, while explicit abandon clears the budget and recovers after restart', async () => {
  const f = fixture(), nextRef = { runtimeId: 'fixture-runtime', conversationId: 'after-abandon', bindingRevision: 'binding-after' };
  f.recognition.transcribe = async () => ({ text: '长'.repeat(4001) });
  await f.begin();
  for (let i = 0; i < 8; i++) await f.speak();
  assert.equal(f.service.getSnapshot().queue.unresolved, 8);
  assert.equal(f.service.getSnapshot().inputs.filter((x) => x.status === 'held').length, 8);
  await f.service.hangup();
  assert.equal(f.service.getSnapshot().queue.unresolved, 8, 'default hangup keeps the advanced repair contract');
  assert.ok(f.audio.stats.rawSamples > 0);
  await f.begin(nextRef); await f.speak();
  assert.equal(f.service.getSnapshot().call.status, 'ended', 'budget exhaustion ends the single-button call instead of leaving a hidden capture pause');
  assert.equal(f.submitted.length, 0);
  await f.service.hangup({ abandonPending: true });
  assert.equal(f.service.getSnapshot().queue.unresolved, 0);
  assert.equal(f.audio.stats.clips, 0); assert.equal(f.audio.stats.rawSamples, 0);
  f.recognition.transcribe = async () => ({ text: 'end cleared the stale backlog' });
  await f.begin({ runtimeId: 'fixture-runtime', conversationId: 'after-explicit-end', bindingRevision: 'binding-end' });
  assert.equal(f.service.getSnapshot().capture.status, 'listening');
  await f.speak(); assert.equal(f.submitted.length, 1);
  await f.service.hangup();
});

await test('abandoned unknown keeps proof drain, frees audio, and never resends on a new target', async () => {
  const f = fixture(), nextRef = { runtimeId: 'fixture-runtime', conversationId: 'after-unknown-end', bindingRevision: 'binding-unknown' };
  f.conversation.submit = async (payload) => { f.submitted.push(payload); return { accepted: false, outcome: 'unknown', code: 'TRANSPORT_TIMEOUT' }; };
  await f.begin(); await f.speak();
  const oldInput = f.service.getSnapshot().inputs[0], oldFollow = f.follow;
  assert.equal(oldInput.admission, 'unknown'); assert.ok(f.audio.stats.rawSamples > 0);
  await f.service.hangup({ abandonPending: true });
  const abandoned = f.service.getSnapshot().inputs.find((input) => input.inputId === oldInput.inputId);
  assert.equal(abandoned.localDisposition, 'abandoned'); assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.admission, 'unknown'); assert.equal(f.audio.stats.clips, 0); assert.equal(f.audio.stats.rawSamples, 0);
  assert.equal(f.conversationReleases, 0, 'unknown admission keeps the original target follow alive');
  await f.begin(nextRef); await f.speak();
  assert.equal(f.submitted.length, 2, 'only the new target input is submitted');
  oldFollow({ streamGeneration: 1, cursor: 'late-proof', reset: false, events: [{ type: 'input.accepted', submissionId: 'sub-1', evidence: 'late-admission-proof' }] });
  await settle();
  const proved = f.service.getSnapshot().inputs.find((input) => input.inputId === oldInput.inputId);
  assert.equal(proved.admission, 'accepted'); assert.equal(proved.localDisposition, 'abandoned');
  assert.equal(f.submitted.filter((payload) => payload.inputId === oldInput.inputId).length, 1);
  assert.equal(f.conversationReleases, 1, 'acceptance proof closes the old drain early');
  await f.service.hangup();
});

await test('abandoned unknown evidence check can discard confirmed not-applied work', async () => {
  const f = fixture();
  f.conversation.submit = async (payload) => { f.submitted.push(payload); return { accepted: false, outcome: 'unknown' }; };
  await f.begin(); await f.speak(); const input = f.service.getSnapshot().inputs[0];
  await f.service.hangup({ abandonPending: true });
  f.conversation.inspectAdmission = async () => ({ status: 'rejected', outcome: 'not_applied', code: 'HOST_REJECTED' });
  await f.service.retryUnknown(input.inputId);
  const result = f.service.getSnapshot().inputs.find((row) => row.inputId === input.inputId);
  assert.equal(result.localDisposition, 'discarded'); assert.equal(result.status, 'discarded'); assert.equal(result.admission, 'discarded');
  assert.equal(f.submitted.length, 1);
});

await test('late failed ASR remains abandoned and does not block recognition on the next call', async () => {
  const f = fixture(), asr = deferred(), nextRef = { runtimeId: 'fixture-runtime', conversationId: 'after-asr-abandon', bindingRevision: 'binding-asr' };
  f.recognition.transcribe = () => asr.promise;
  await f.begin(); await f.speak();
  const inputId = f.service.getSnapshot().inputs[0].inputId;
  assert.equal(f.service.getSnapshot().inputs[0].status, 'recognizing');
  await f.service.hangup({ abandonPending: true });
  let input = f.service.getSnapshot().inputs.find((row) => row.inputId === inputId);
  assert.equal(input.localDisposition, 'abandoned'); assert.equal(input.status, 'abandoned');
  assert.equal(f.audio.stats.rawSamples, 0);
  f.recognition.transcribe = async () => ({ text: 'next call is free' });
  await f.begin(nextRef); asr.reject(Object.assign(new Error('late ASR failure'), { code: 'ASR_LATE_FAILURE' })); await settle();
  input = f.service.getSnapshot().inputs.find((row) => row.inputId === inputId);
  assert.equal(input.localDisposition, 'abandoned'); assert.equal(input.status, 'abandoned');
  assert.equal(input.error, null);
  await f.speak(); assert.equal(f.submitted.length, 1, 'new run recognition proceeds despite the old late ASR failure');
  assert.equal(f.submitted[0].conversationRef.conversationId, nextRef.conversationId);
  await f.service.hangup();
});

await test('abandoned unknown metadata is bounded after every thirty-second drain ends', async () => {
  const f = fixture();
  f.conversation.submit = async (payload) => { f.submitted.push(payload); return { accepted: false, outcome: 'unknown' }; };
  for (let i = 0; i < 65; i++) {
    await f.begin({ runtimeId: 'fixture-runtime', conversationId: `unknown-${i}`, bindingRevision: `binding-${i}` });
    await f.speak(); await f.service.hangup({ abandonPending: true });
  }
  assert.equal(f.service.getSnapshot().inputs.length, 65, 'unknown identities stay inspectable until their drain expires');
  await f.advanceTimer(30000);
  assert.ok(f.service.getSnapshot().inputs.length <= 64, 'released abandoned history is trimmed to the bounded metadata window');
});

await test('audio cut failure ends the call and never submits an incomplete turn', async () => {
  const f = fixture(); await f.begin();
  f.capture.cut = async () => { throw Object.assign(new Error('clip budget exhausted'), { code: 'VOICE_AUDIO_BUDGET' }); };
  await f.speak(); await settle();
  assert.equal(f.submitted.length, 0);
  assert.equal(f.service.getSnapshot().inputs[0].status, 'discarded');
  assert.equal(f.service.getSnapshot().inputs[0].admission, 'discarded');
  assert.equal(f.service.getSnapshot().call.status, 'ended');
  assert.equal(f.service.getSnapshot().capture.status, 'stopped');
  await f.service.hangup();
});

await test('late submission preparation is cancelled and abandoned after mute', async () => {
  const f = fixture(), preparedGate = deferred(); let operation, abandoned = null;
  f.conversation.prepareSubmission = async (payload) => { operation = payload.operation; return preparedGate.promise; };
  f.conversation.abandonSubmission = async (payload) => { abandoned = payload; return true; };
  await f.begin(); await f.speak(); await settle();
  assert.ok(operation);
  await f.service.mute();
  assert.equal(operation.signal.aborted, true);
  preparedGate.resolve({ submissionId: 'late-prepared' }); await settle();
  assert.equal(f.submitted.length, 0);
  assert.equal(abandoned?.submissionId, 'late-prepared');
  assert.equal(abandoned?.conversationRef.conversationId, REF.conversationId);
  assert.equal(f.service.getSnapshot().inputs[0].status, 'held');
  await f.service.hangup();
});

await test('duplicate start calls coalesce onto one capture session', async () => {
  const f = fixture();
  const first = f.begin(), second = f.begin();
  await Promise.all([first, second]);
  assert.equal(f.service.getSnapshot().call.status, 'connected');
  assert.equal(f.service.getSnapshot().call.id, (await first).call.id);
  await f.service.hangup();
});

await test('ownership renews at five seconds and revocation stops both local directions', async () => {
  const f = fixture(); await f.begin();
  assert.equal([...f.timers.values()].some((x) => x.ms === 5000), true);
  await f.advanceTimer(5000); assert.equal(f.renewals, 1);
  await f.service.hangup();
});

await test('lease loss during renewal stops the microphone and reply playback', async () => {
  const f = fixture(); await f.begin(); f.ownership.renew = async () => ({ valid: false });
  await f.advanceTimer(5000);
  assert.equal(f.service.getSnapshot().capture.status, 'paused-ownership');
  assert.ok(f.stoppedCaptures > 0); assert.ok(f.playbackStops > 0);
  await f.service.hangup();
});

await test('accepted proof is monotonic when submit reports a later transport failure', async () => {
  const f = fixture();
  f.conversation.submit = async (payload) => { f.submitted.push(payload); f.emit([{ type: 'input.accepted', submissionId: payload.submissionId, evidence: 'event-proof' }]); throw new Error('late transport error'); };
  await f.begin(); await f.speak(); await settle();
  assert.equal(f.submitted.length, 1);
  assert.equal(f.service.getSnapshot().inputs[0].admission, 'accepted');
  await f.service.hangup();
});

await test('accepted input exposes a failed turn error without becoming retryable or resending', async () => {
  const f = fixture(); await f.begin(); await f.speak();
  const submissionId = f.submitted[0].submissionId;
  f.emit([
    { type: 'input.accepted', submissionId, evidence: 'prompt-receipt' },
    { type: 'input.consumed', submissionId, conversationTurnId: 'credential-failure-turn', origin: 'local' },
    { type: 'turn.ended', conversationTurnId: 'credential-failure-turn', outcome: 'failed', error: { code: 'MISSING_CREDENTIAL', message: 'Configure a credential for this provider.' } },
  ]);
  await settle();
  const input = f.service.getSnapshot().inputs[0];
  assert.equal(input.admission, 'accepted');
  assert.equal(input.status, 'failed');
  assert.equal(input.error.code, 'MISSING_CREDENTIAL');
  assert.equal(input.error.stage, 'conversation');
  assert.equal(input.error.outcome, 'applied');
  assert.equal(input.error.retryable, false);
  await assert.rejects(f.service.retryInput(input.inputId));
  assert.equal(f.submitted.length, 1, 'accepted failed work is never resent');
  await f.service.hangup();
});

await test('removed accepted input no longer blocks later ordered delivery', async () => {
  const f = fixture(); await f.begin(); await f.speak(); await f.speak();
  const first = f.submitted[0].submissionId; f.emit([{ type: 'input.accepted', submissionId: first }]); await settle();
  assert.equal(f.submitted.length, 2);
  f.emit([{ type: 'input.removed', submissionId: first, reason: 'host-removed' }]); await settle();
  assert.equal(f.submitted.length, 2);
  await f.service.hangup();
});

await test('unknown admission check never repeats a real submit', async () => {
  const f = fixture();
  f.conversation.submit = async (payload) => { f.submitted.push(payload); return { accepted: false, outcome: 'unknown', code: 'TIMEOUT' }; };
  await f.begin(); await f.speak(); assert.equal(f.submitted.length, 1);
  const input = f.service.getSnapshot().inputs[0];
  await f.service.retryUnknown(input.inputId);
  assert.equal(f.submitted.length, 1);
  await f.service.hangup();
});

await test('explicit unknown resubmission uses a new input and submission identity', async () => {
  const f = fixture(); f.conversation.submit = async (payload) => { f.submitted.push(payload); return f.submitted.length === 1 ? { accepted: false, outcome: 'unknown' } : { accepted: true, evidence: 'receipt' }; };
  await f.begin(); await f.speak(); const original = f.service.getSnapshot().inputs[0];
  const replacementId = await f.service.submitHeld(original.inputId); await settle();
  assert.equal(f.submitted.length, 2);
  assert.notEqual(f.submitted[0].inputId, f.submitted[1].inputId);
  assert.equal(f.service.getSnapshot().inputs.find((x) => x.inputId === replacementId).supersedes.inputId, original.inputId);
  await f.service.hangup();
});

await test('unknown input edits create a superseding identity instead of reusing a submission id', async () => {
  const f = fixture();
  f.conversation.submit = async (payload) => { f.submitted.push(payload); return { accepted: false, outcome: 'unknown' }; };
  await f.begin(); await f.speak();
  const original = f.service.getSnapshot().inputs[0];
  const replacementId = await f.service.editInput(original.inputId, '改写后的口述');
  const replacement = f.service.getSnapshot().inputs.find((x) => x.inputId === replacementId);
  assert.notEqual(replacementId, original.inputId);
  assert.deepEqual(replacement.supersedes, { inputId: original.inputId, submissionId: 'sub-1' });
  assert.equal(original.admission, 'unknown');
  await f.service.hangup();
});

await test('speech during synthesis suppresses stale output and releases its late audio', async () => {
  const gate = deferred(), f = fixture({ synthesis: { async inspect() { return { available: true }; }, async synthesize() { return gate.promise; }, async release(ref) { f.audio.release(ref); } }, config: { version: 1, duplexPreference: 'headphones' } });
  await f.begin(); await f.speak();
  const submissionId = f.submitted[0].submissionId;
  f.emit([
    { type: 'input.consumed', submissionId, conversationTurnId: 'turn-r', origin: 'local' },
    { type: 'reply.final', replyId: 'reply-old', conversationTurnId: 'turn-r', text: '你好。', origin: 'local' },
    { type: 'turn.ended', conversationTurnId: 'turn-r', outcome: 'completed' },
  ]);
  await settle();
  assert.equal(f.service.getSnapshot().playback.status, 'synthesizing');
  f.captureEvents({ type: 'speech-start', sampleIndex: 60000 }); await settle();
  const lateClip = f.audio.putClip(new Int16Array(100)); gate.resolve(lateClip); await settle();
  assert.equal(f.played, 0);
  assert.equal(f.audio.stats.clips, 0);
  await f.service.hangup();
});

await test('late synthesis from a hung-up call cannot play into a restarted target', async () => {
  const synthesisGate = deferred(), nextRef = { runtimeId: 'fixture-runtime', conversationId: 'new-synth-target', bindingRevision: 'binding-new' };
  const f = fixture({ synthesis: { async inspect() { return { available: true }; }, async synthesize() { return synthesisGate.promise; }, async release(ref) { f.audio.release(ref); } }, config: { version: 1, duplexPreference: 'headphones' } });
  await f.begin(); await f.speak(); const submissionId = f.submitted[0].submissionId;
  f.emit([{ type: 'input.consumed', submissionId, conversationTurnId: 'old-synth-turn', origin: 'local' }, { type: 'reply.final', replyId: 'old-synth-reply', conversationTurnId: 'old-synth-turn', text: '旧通话的回复。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'old-synth-turn', outcome: 'completed' }]);
  await settle(); assert.equal(f.service.getSnapshot().playback.status, 'synthesizing');
  await f.service.hangup(); await f.begin(nextRef);
  const lateClip = f.audio.putClip(new Int16Array(160)); synthesisGate.resolve(lateClip); await settle();
  assert.equal(f.played, 0);
  assert.equal(f.audio.stats.clips, 0, 'stale synthesized audio is still released');
  assert.equal(f.service.getSnapshot().call.conversationRef.conversationId, nextRef.conversationId);
  assert.equal(f.service.getSnapshot().playback.status, 'idle');
  await f.service.hangup();
});

await test('old speaker gate tail cannot ungate a new call while it is synthesizing', async () => {
  const newSynthesis = deferred(), nextRef = { runtimeId: 'fixture-runtime', conversationId: 'speaker-new-target', bindingRevision: 'speaker-new' };
  let synthesisCount = 0;
  const f = fixture({ synthesis: { async inspect() { return { available: true }; }, async synthesize() { return ++synthesisCount === 1 ? f.audio.putClip(new Int16Array(160)) : newSynthesis.promise; }, async release(ref) { f.audio.release(ref); } }, config: { version: 1, duplexPreference: 'speaker-turn-taking', replyAudioEnabled: true } });
  await f.begin(); await f.speak(); const submissionId = f.submitted[0].submissionId;
  f.emit([{ type: 'input.consumed', submissionId, conversationTurnId: 'old-speaker-turn', origin: 'local' }, { type: 'reply.final', replyId: 'old-speaker-reply', conversationTurnId: 'old-speaker-turn', text: '旧通话回复。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'old-speaker-turn', outcome: 'completed' }]);
  await settle(); assert.equal(f.capture.gated, true); assert.equal(f.played, 1);
  await f.service.hangup(); await f.begin(nextRef);
  f.emit([{ type: 'input.consumed', submissionId: 'new-keyboard', conversationTurnId: 'new-speaker-turn', origin: 'local' }, { type: 'reply.final', replyId: 'new-speaker-reply', conversationTurnId: 'new-speaker-turn', text: '新通话回复。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'new-speaker-turn', outcome: 'completed' }]);
  await settle(); assert.equal(f.service.getSnapshot().playback.status, 'synthesizing');
  await f.advanceTimer(400); assert.equal(f.capture.gated, true, 'the old tail token cannot ungate the new call');
  const lateClip = f.audio.putClip(new Int16Array(160)); newSynthesis.resolve(lateClip); await settle();
  assert.equal(f.played, 2); assert.equal(f.capture.gated, true);
  await f.advanceTimer(400); assert.equal(f.capture.gated, false, 'the current reply restores its own gate');
  await f.service.hangup();
});

await test('stop settles active playback and its output clip is released', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } }); let playGate;
  f.playback.play = (_ref, options) => { f.playback.playing = true; options.onStarted(); return new Promise((resolve) => { playGate = resolve; }); };
  f.playback.stop = async () => { playGate?.({ stopped: true }); };
  await f.begin(); await f.speak();
  const submissionId = f.submitted[0].submissionId;
  f.emit([{ type: 'input.consumed', submissionId, conversationTurnId: 'turn-play', origin: 'local' }, { type: 'reply.final', replyId: 'reply-play', conversationTurnId: 'turn-play', text: '好。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'turn-play', outcome: 'completed' }]);
  await settle();
  assert.equal(f.service.getSnapshot().playback.status, 'playing');
  await f.service.setOutputEnabled(false); await settle();
  assert.equal(f.audio.stats.clips, 0);
  assert.equal(f.service.getSnapshot().playback.status, 'idle');
  await f.service.hangup();
});

await test('synthesized clip is released when playback rejects', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } });
  f.playback.play = async () => { throw new Error('output device failed'); };
  await f.begin(); await f.speak(); const submissionId = f.submitted[0].submissionId;
  f.emit([{ type: 'input.consumed', submissionId, conversationTurnId: 'reject-turn', origin: 'local' }, { type: 'reply.final', replyId: 'reject-reply', conversationTurnId: 'reject-turn', text: '播放失败。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'reject-turn', outcome: 'completed' }]);
  await settle();
  assert.equal(f.audio.stats.clips, 0);
  assert.equal(f.released, 1);
  assert.equal(f.service.getSnapshot().playback.status, 'failed');
  await f.service.hangup();
});

await test('deferred playback stop publishes idle and queues a new eligible reply until stop settles', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } }), stopGate = deferred(); let firstPlay, stopStarted = false, playCalls = 0;
  const states = []; f.service.subscribe((snapshot) => states.push(snapshot.playback.status));
  f.playback.play = (_ref, options) => {
    playCalls++; options.onStarted?.();
    if (playCalls === 1) return new Promise((resolve) => { firstPlay = resolve; });
    options.onEnded?.(); return Promise.resolve({ ended: true });
  };
  f.playback.stop = () => { stopStarted = true; return stopGate.promise.then(() => { firstPlay?.({ stopped: true }); }); };
  await f.begin(); await f.speak(); const submissionId = f.submitted[0].submissionId;
  f.emit([{ type: 'input.consumed', submissionId, conversationTurnId: 'stop-turn-a', origin: 'local' }, { type: 'reply.final', replyId: 'stop-reply-a', conversationTurnId: 'stop-turn-a', text: '先停止。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'stop-turn-a', outcome: 'completed' }]);
  await settle(); assert.equal(f.service.getSnapshot().playback.status, 'playing');
  const disabling = f.service.setOutputEnabled(false); await settle();
  assert.equal(stopStarted, true); assert.equal(f.service.getSnapshot().playback.status, 'stopping');
  await f.service.setOutputEnabled(true);
  f.emit([{ type: 'input.consumed', submissionId: 'keyboard-during-stop', conversationTurnId: 'stop-turn-b', origin: 'local' }, { type: 'reply.final', replyId: 'stop-reply-b', conversationTurnId: 'stop-turn-b', text: '停止后播放。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'stop-turn-b', outcome: 'completed' }]);
  await settle(); assert.equal(playCalls, 1, 'new reply waits while the earlier asynchronous stop is pending');
  stopGate.resolve(); await disabling; await settle();
  assert.equal(playCalls, 2, 'eligible new reply resumes after stop settles');
  assert.ok(states.includes('idle'), 'stop completion publishes idle without waiting for another capture event');
  await f.service.hangup();
});

await test('speaker output cancellation restores capture after the tail delay', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'speaker-turn-taking', replyAudioEnabled: true } }); let playGate;
  f.playback.play = (_ref, options) => { options.onStarted(); return new Promise((resolve) => { playGate = resolve; }); };
  f.playback.stop = async () => { playGate?.({ stopped: true }); };
  await f.begin(); await f.speak(); const submissionId = f.submitted[0].submissionId;
  f.emit([{ type: 'input.consumed', submissionId, conversationTurnId: 'speaker-turn', origin: 'local' }, { type: 'reply.final', replyId: 'speaker-reply', conversationTurnId: 'speaker-turn', text: '说完恢复聆听。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'speaker-turn', outcome: 'completed' }]);
  await settle(); assert.equal(f.capture.gated, true);
  await f.service.setOutputEnabled(false); await settle(); assert.equal(f.capture.gated, true);
  await f.advanceTimer(400); assert.equal(f.capture.gated, false);
  await f.service.hangup();
});

await test('recent successful local replies expose bounded replay metadata and replay explicitly', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } }); await f.begin(); await f.speak();
  const submissionId = f.submitted[0].submissionId;
  f.emit([{ type: 'input.consumed', submissionId, conversationTurnId: 'replay-turn', origin: 'local' }, { type: 'reply.final', replyId: 'reply-replay', conversationTurnId: 'replay-turn', text: '再说一次。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'replay-turn', outcome: 'completed' }]);
  await settle(); assert.equal(f.played, 1);
  const reply = f.service.getSnapshot().replies.find((x) => x.replyId === 'reply-replay');
  assert.equal(reply.replayable, true);
  await f.service.replayReply('reply-replay'); assert.equal(f.played, 2);
  await f.service.setOutputEnabled(false);
  await assert.rejects(f.service.replayReply('reply-replay'), { code: 'VOICE_OUTPUT_DISABLED' });
  await f.service.hangup();
});

await test('normalized keyboard acceptance advances output epoch and a later reply remains eligible', async () => {
  const synthGate = deferred(); let synthCount = 0;
  const f = fixture({ synthesis: { async inspect() { return { available: true }; }, async synthesize() { return ++synthCount === 1 ? synthGate.promise : f.audio.putClip(new Int16Array(160)); }, async release(ref) { f.audio.release(ref); } }, config: { version: 1, duplexPreference: 'headphones' } });
  await f.begin(); await f.speak(); const first = f.submitted[0].submissionId;
  f.emit([{ type: 'input.consumed', submissionId: first, conversationTurnId: 'spoken-turn', origin: 'local' }, { type: 'reply.final', replyId: 'stale-spoken-reply', conversationTurnId: 'spoken-turn', text: '稍后播放。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'spoken-turn', outcome: 'completed' }]);
  await settle();
  f.emit([{ type: 'input.accepted', submissionId: 'keyboard-request', evidence: 'session-message', origin: 'local' }, { type: 'input.consumed', submissionId: 'keyboard-request', conversationTurnId: 'keyboard-turn', origin: 'local' }]);
  await settle();
  const lateClip = f.audio.putClip(new Int16Array(160)); synthGate.resolve(lateClip); await settle();
  assert.equal(f.played, 0);
  f.emit([{ type: 'turn.ended', conversationTurnId: 'keyboard-turn', outcome: 'completed' }, { type: 'input.consumed', submissionId: 'keyboard-request-2', conversationTurnId: 'later-turn', origin: 'local' }, { type: 'reply.final', replyId: 'later-reply', conversationTurnId: 'later-turn', text: '现在可以播放。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'later-turn', outcome: 'completed' }]);
  await settle();
  assert.equal(f.played, 1);
  await f.service.hangup();
});

await test('autonomous replies without a post-start tracked turn are not eligible', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } }); await f.begin();
  f.emit([{ type: 'reply.final', replyId: 'baseline-autonomous', conversationTurnId: 'old-turn', text: '已经在运行的旧回复。', origin: 'autonomous' }, { type: 'turn.ended', conversationTurnId: 'old-turn', outcome: 'completed' }]);
  await settle();
  assert.equal(f.played, 0);
  assert.equal(f.service.getSnapshot().replies.find((x) => x.replyId === 'baseline-autonomous').replayable, false);
  await assert.rejects(f.service.replayReply('baseline-autonomous'), { code: 'VOICE_REPLY_NOT_REPLAYABLE' });
  await f.service.hangup();
});

await test('committed segments speak before turn end and final aggregation does not repeat them', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } }); await f.begin(); await f.speak();
  const input = f.service.getSnapshot().inputs[0], submissionId = f.submitted[0].submissionId;
  f.emit([
    { type: 'input.consumed', submissionId, conversationTurnId: 'long-task-turn', origin: 'local' },
    { type: 'reply.segment', replyId: 'segment-a', responseId: 'response-a', stepId: 'step-a', surfaceRevision: '1', inputIds: [input.inputId], submissionIds: [submissionId], conversationTurnId: 'long-task-turn', text: '我开始执行了。', origin: 'local' },
  ]);
  await settle(); assert.equal(f.played, 1, 'a committed answer is independent of the running task');
  f.emit([{ type: 'reply.final', replyId: 'aggregate-a', conversationTurnId: 'long-task-turn', text: '我开始执行了。', origin: 'local' }, { type: 'turn.ended', conversationTurnId: 'long-task-turn', outcome: 'completed' }]);
  await settle(); assert.equal(f.played, 1, 'turn aggregation must not repeat an already committed segment');
  await f.service.dispose();
});

await test('an unknown input does not prevent a new independent utterance', async () => {
  const f = fixture(); f.conversation.submit = async payload => { f.submitted.push(payload); return { status: 'unknown' }; };
  await f.begin(); await f.speak(); await f.speak();
  assert.equal(f.submitted.length, 2);
  assert.ok(f.service.getSnapshot().inputs.every(input => input.admission === 'unknown'));
  await f.service.dispose();
});

await test('failed recognition releases its slot so a single-button call survives more than eight failures', async () => {
  const f = fixture(); f.recognition.transcribe = async () => { throw Object.assign(new Error('ASR failed'), { code: 'ASR_FAILED' }); };
  await f.begin();
  for (let n = 0; n < 10; n++) await f.speak();
  assert.equal(f.service.getSnapshot().queue.unresolved, 0);
  assert.equal(f.audio.stats.rawSamples, 0);
  assert.equal(f.service.getSnapshot().capture.status, 'listening');
  f.recognition.transcribe = async () => ({ text: '现在恢复正常。' }); await f.speak();
  assert.equal(f.submitted.length, 1);
  await f.service.dispose();
});

await test('a late segment from an older step in the same turn never uses the newest input epoch', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } }); await f.begin(); await f.speak(); await f.speak();
  const [a, b] = f.service.getSnapshot().inputs, [sa, sb] = f.submitted.map(item => item.submissionId);
  f.emit([{ type: 'input.consumed', submissionId: sa, conversationTurnId: 'shared-turn', origin: 'local' }, { type: 'input.consumed', submissionId: sb, conversationTurnId: 'shared-turn', origin: 'local' },
    { type: 'reply.segment', replyId: 'late-a', responseId: 'response-a', surfaceRevision: '1', conversationTurnId: 'shared-turn', inputIds: [a.inputId], submissionIds: [sa], origin: 'local', text: '旧回答。' },
    { type: 'reply.segment', replyId: 'current-b', responseId: 'response-b', surfaceRevision: '1', conversationTurnId: 'shared-turn', inputIds: [b.inputId], submissionIds: [sb], origin: 'local', text: '当前回答。' }]);
  await settle(); assert.equal(f.played, 1);
  assert.equal(f.service.getSnapshot().replies.find(reply => reply.replyId === 'current-b').status, 'played');
  await f.service.dispose();
});

await test('ASR timeout settles only its attempt and a late result cannot send or unblock a newer utterance', async () => {
  const f = fixture(), first = deferred(), second = deferred(); let calls = 0;
  f.recognition.transcribe = () => ++calls === 1 ? first.promise : second.promise;
  await f.begin(); await f.speak(); await f.advanceTimer(30000);
  assert.equal(f.service.getSnapshot().queue.unresolved, 0);
  await f.speak(); assert.equal(calls, 2, 'a stuck ASR RPC cannot own the run forever');
  first.resolve({ text: '过期文本不能发送。' }); await settle();
  assert.equal(f.submitted.length, 0);
  second.resolve({ text: '新的一句。' }); await settle(); assert.equal(f.submitted.length, 1);
  await f.service.dispose();
});

await test('capture device failure ends the call and stops both directions', async () => {
  const f = fixture(); await f.begin();
  f.captureEvents({ type: 'error', error: Object.assign(new Error('麦克风已断开'), { code: 'VOICE_MIC_DISCONNECTED' }) });
  await settle(); assert.equal(f.service.getSnapshot().call.status, 'ended');
  assert.ok(f.stoppedCaptures > 0); assert.ok(f.playbackStops > 0);
  await f.service.dispose();
});

await test('speaker duplex keeps capture running and a near-end utterance stops an active reply', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'speaker-duplex' } }); let finish;
  f.playback.play = (_ref, options) => { options.onStarted?.(); return new Promise(resolve => { finish = resolve; }); };
  f.playback.stop = async () => { finish?.({ stopped: true }); };
  await f.begin(); await f.speak(); const submissionId = f.submitted[0].submissionId;
  f.emit([{ type: 'input.consumed', submissionId, conversationTurnId: 'duplex-turn', origin: 'local' }, { type: 'reply.segment', replyId: 'duplex-reply', responseId: 'response-duplex', surfaceRevision: '1', conversationTurnId: 'duplex-turn', submissionIds: [submissionId], text: '用户可以随时打断这一句。', origin: 'local' }]);
  await settle(); assert.equal(f.service.getSnapshot().playback.status, 'playing');
  assert.notEqual(f.capture.gated, true, 'full duplex must not drop microphone PCM during TTS');
  f.captureEvents({ type: 'speech-start', sampleIndex: 50000 }); await settle();
  assert.equal(f.service.getSnapshot().playback.status, 'idle');
  assert.equal(f.service.getSnapshot().replies.find(reply => reply.replyId === 'duplex-reply').status, 'stopped');
  await f.service.dispose();
});

await test('pending ASR holds a newly committed reply and a duplicate segment is only played once', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } }), pending = deferred();
  f.recognition.transcribe = () => pending.promise;
  await f.begin(); await f.speak();
  const segment = { type: 'reply.segment', replyId: 'typed-during-asr', responseId: 'typed-response', surfaceRevision: '1', conversationTurnId: 'typed-turn', submissionIds: ['typed'], text: '等你说完再回答。', origin: 'local' };
  f.emit([{ type: 'input.accepted', submissionId: 'typed', origin: 'local' }, { type: 'input.consumed', submissionId: 'typed', conversationTurnId: 'typed-turn', origin: 'local' }, segment, segment]);
  await settle(); assert.equal(f.played, 0);
  pending.resolve({ text: '' }); await settle();
  assert.equal(f.played, 1, 'gate closure should drain the valid new reply exactly once');
  f.emit([segment]); await settle(); assert.equal(f.played, 1);
  await f.service.dispose();
});

await test('a prepared submission does not grant segment playback until matching consumption is proven', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } }); await f.begin(); await f.speak();
  const submissionId = f.submitted[0].submissionId;
  f.emit([{ type: 'reply.segment', replyId: 'proof-wait', responseId: 'proof-response', surfaceRevision: '1', conversationTurnId: 'proof-turn', submissionIds: [submissionId], text: '需要先确认输入消费。', origin: 'local' }]);
  await settle(); assert.equal(f.played, 0, 'prepare/accept alone is not a consumption watermark');
  f.emit([{ type: 'input.consumed', submissionId, conversationTurnId: 'proof-turn', origin: 'local' }]);
  await settle(); assert.equal(f.played, 1, 'a delayed proof activates the waiting committed segment');
  await f.service.dispose();
});

await test('a hung preparation has a deadline, lets the next input through and abandons its late identity', async () => {
  const f = fixture(), pending = deferred(); let preparations = 0, abandoned;
  f.conversation.prepareSubmission = payload => ++preparations === 1 ? pending.promise : Promise.resolve({ submissionId: `next-${payload.inputId}` });
  f.conversation.abandonSubmission = async payload => { abandoned = payload; return true; };
  await f.begin(); await f.speak(); await f.advanceTimer(30000); await f.speak();
  assert.equal(f.submitted.length, 1, 'a preparation stall cannot hold the admission mutex forever');
  pending.resolve({ submissionId: 'late-expired-preparation' }); await settle();
  assert.equal(abandoned.submissionId, 'late-expired-preparation');
  assert.equal(f.submitted.length, 1, 'an expired preparation never resumes automatic sending');
  await f.service.dispose();
});

await test('a hung submit becomes unknown without resending, while its late acceptance updates only the original input', async () => {
  const f = fixture(), pending = deferred();
  f.conversation.submit = payload => { f.submitted.push(payload); return f.submitted.length === 1 ? pending.promise : Promise.resolve({ accepted: true }); };
  await f.begin(); await f.speak(); await f.advanceTimer(30000); await f.speak();
  assert.equal(f.submitted.length, 2);
  assert.equal(f.service.getSnapshot().inputs[0].admission, 'unknown');
  pending.resolve({ accepted: true, evidence: 'late-receipt' }); await settle();
  assert.equal(f.service.getSnapshot().inputs[0].admission, 'accepted');
  assert.equal(f.submitted.length, 2);
  await f.service.dispose();
});

await test('an owned task notice speaks during the call and obeys pending near-end recognition', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } }), asr = deferred();
  f.recognition.transcribe = () => asr.promise;
  await f.begin(); await f.speak();
  const submissionId = 'chonkyfish-task-notice:task-1:v2';
  f.emit([{ type: 'input.consumed', submissionId, conversationTurnId: 'task-notice-turn', taskId: 'task-1', taskVersion: 2, sourceInputId: 'original-task-input', origin: 'owned-task' },
    { type: 'reply.segment', replyId: 'owned-notice', responseId: 'owned-response', surfaceRevision: '1', conversationTurnId: 'task-notice-turn', submissionIds: [submissionId], text: '后台任务已经完成。', origin: 'owned-task' }]);
  await settle(); assert.equal(f.played, 0, 'a task completion cannot speak over an unresolved utterance');
  asr.resolve({ text: '' }); await settle(); assert.equal(f.played, 1);
  await f.service.hangup();
  f.emit([{ type: 'reply.segment', replyId: 'after-end', responseId: 'after-end', surfaceRevision: '1', conversationTurnId: 'task-notice-turn', submissionIds: [submissionId], text: '挂断后不能出声。', origin: 'owned-task' }]);
  await settle(); assert.equal(f.played, 1);
  await f.service.dispose();
});

await test('a task notice consumed during ASR cannot resume ahead of the newly accepted user input', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } }), asr = deferred(); f.recognition.transcribe = () => asr.promise;
  await f.begin(); await f.speak();
  const noticeId = 'chonkyfish-task-notice:task-2:v3';
  f.emit([{ type: 'input.consumed', submissionId: noticeId, conversationTurnId: 'notice-priority', taskId: 'task-2', taskVersion: 3, sourceInputId: 'original-task-input', origin: 'owned-task' }]);
  await settle(); asr.resolve({ text: '现在先回答我的新问题。' }); await settle();
  f.emit([{ type: 'reply.segment', replyId: 'late-notice', responseId: 'late-notice-response', surfaceRevision: '1', conversationTurnId: 'notice-priority', submissionIds: [noticeId], text: '迟到的任务通知。', origin: 'owned-task' }]);
  await settle(); assert.equal(f.played, 0);
  await f.service.dispose();
});

await test('a task notice stays silent after ASR while preparation is still waiting', async () => {
  const f = fixture({ config: { version: 1, duplexPreference: 'headphones' } }), asr = deferred(), preparation = deferred();
  f.recognition.transcribe = () => asr.promise; f.conversation.prepareSubmission = () => preparation.promise;
  await f.begin(); await f.speak();
  const noticeId = 'chonkyfish-task-notice:task-3:v4';
  f.emit([{ type: 'input.consumed', submissionId: noticeId, conversationTurnId: 'notice-before-prepare', taskId: 'task-3', taskVersion: 4, sourceInputId: 'old-input', origin: 'owned-task' },
    { type: 'reply.segment', replyId: 'pending-task-audio', responseId: 'pending-task-response', surfaceRevision: '1', conversationTurnId: 'notice-before-prepare', submissionIds: [noticeId], text: '不能盖过刚说的新问题。', origin: 'owned-task' }]);
  await settle(); asr.resolve({ text: '这是优先处理的新问题。' }); await settle();
  assert.equal(f.played, 0, 'queued/submitting user input must retain priority after ASR');
  preparation.resolve({ submissionId: 'prepared-priority' }); await settle(); assert.equal(f.played, 0);
  await f.service.dispose();
});

await test('permanently pending submits do not grow visible abandoned history after proof drains close', async () => {
  const f = fixture(); f.conversation.submit = payload => { f.submitted.push(payload); return new Promise(() => {}); };
  for (let n = 0; n < 70; n++) {
    await f.begin({ ...REF, bindingRevision: `bounded-${n}` }); await f.speak(); await f.advanceTimer(30000);
    await f.service.hangup({ abandonPending: true }); await f.advanceTimer(30000);
  }
  assert.ok(f.service.getSnapshot().inputs.length <= 64, 'expired proof drains bound metadata even if the network promise never settles');
  assert.equal(f.audio.stats.rawSamples, 0);
  await f.service.dispose();
});

console.log(`voice service: ${groups} groups passed`);
