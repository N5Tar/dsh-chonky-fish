import { validateVoiceConfig, DEFAULT_VOICE_CONFIG } from './config.js';
import { VOICE_LIMITS } from './limits.js';
import { speechToText, splitSpeechSentences } from './speech-text.js';
import { createTurnState } from './turns.js';

const noop = () => {};
const clone = (x) => typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x));
const errorView = (error, stage) => ({ code: error?.code || 'VOICE_OPERATION_FAILED', stage, message: String(error?.message || error), retryable: Boolean(error?.retryable), outcome: error?.outcome || 'unknown' });
const validRef = (r) => r && ['runtimeId', 'conversationId', 'bindingRevision'].every((k) => typeof r[k] === 'string' && r[k].length > 0);

export function createVoiceService(deps) {
  const { capture, recognition, conversation, synthesis, playback, ownership, audio, clock, ids, config: rawConfig = DEFAULT_VOICE_CONFIG } = deps || {};
  for (const [name, value] of Object.entries({ capture, recognition, conversation, synthesis, playback, ownership, audio, clock, ids })) if (!value) throw new TypeError(`voice ${name} port is required`);
  const config = validateVoiceConfig(rawConfig);
  let call = { status: 'idle', id: null, conversationRef: null };
  let captureState = { status: 'stopped', muted: false };
  let playbackState = { status: 'idle', enabled: config.replyAudioEnabled, replyId: null };
  let inputs = [];
  let error = null, epoch = 0, order = 0, currentInput = null, turn = createTurnState({ endSilenceMs: config.endSilenceMs });
  let disposed = false, accepting = false;
  let startGeneration = 0, captureGeneration = 0, activeRun = null, cleanupPromise = Promise.resolve(), playbackEpoch = 0, playbackStopGeneration = 0, playbackStopPromise = Promise.resolve(), activeSynthesisOperation = null, activeRecognitionOperation = null, activeSpeakerGate = null;
  let streamCursor, activeTurnIds = new Map(), replies = new Map(), opGeneration = 0, replyRunTasks = new Map(), recognitionBusyRuns = new Set();
  const listeners = new Set();
  let eventQueue = Promise.resolve();
  let recognitionQueue = [];
  let pendingStartPromise = null;
  const drainingRuns = new Set();
  const op = (kind) => { const controller = new AbortController(); return { operationId: ids.createId(kind), generation: ++opGeneration, signal: controller.signal, cancel: (reason) => { if (!controller.signal.aborted) controller.abort(reason); } }; };
  const snapshot = () => clone({
    call, capture: captureState, inputs: inputs.map(({ inputId, order: n, status, transcript, admission, clips, failure, supersedes, duplicateRisk, localDisposition }) => ({ inputId, order: n, status, transcript: transcript ?? null, admission, clips: clips.length, error: failure ?? null, supersedes: supersedes ?? null, duplicateRisk: Boolean(duplicateRisk), localDisposition: localDisposition ?? null })),
    replies: [...replies.values()].slice(-16).map((reply) => ({ replyId: reply.replyId, conversationTurnId: reply.conversationTurnId, status: reply.status || 'available', origin: reply.origin, replayable: reply.run === activeRun && reply.ended && reply.eligibleTurn && ['local', 'autonomous'].includes(reply.origin) })),
    playback: playbackState, queue: { unresolved: inputs.filter((x) => !['accepted', 'discarded'].includes(x.admission) && x.localDisposition !== 'abandoned').length, waiting: inputs.filter((x) => ['queued', 'held', 'unknown', 'rejected'].includes(x.status) && x.localDisposition !== 'abandoned').length }, error,
  });
  const publish = () => { const view = snapshot(); for (const fn of listeners) { try { fn(view); } catch {} } };
  const enqueue = (fn) => { eventQueue = eventQueue.then(() => { if (!disposed) return fn(); }).catch((e) => { error = errorView(e, 'event'); publish(); }); return eventQueue; };
  const inputById = (id) => inputs.find((x) => x.inputId === id);
  const unresolvedCount = () => inputs.filter((x) => !['accepted', 'discarded'].includes(x.admission) && x.localDisposition !== 'abandoned').length;
  const openInput = (sampleIndex) => {
    if (currentInput) return currentInput;
    if (unresolvedCount() >= VOICE_LIMITS.unresolvedInputs) { endForFailure({ code: 'VOICE_INPUT_LIMIT', message: '待核对输入已达到上限，通话已结束。', outcome: 'not_applied' }, 'capture'); return null; }
    const input = { inputId: ids.createId('input'), order: ++order, epoch: ++epoch, conversationRef: clone(call.conversationRef), scopeId: activeRun?.scopeId, callGeneration: startGeneration, run: activeRun, status: 'recording', admission: 'not_attempted', startSample: Math.max(0, sampleIndex - 4800), endSample: sampleIndex, clips: [], transcriptParts: [], transcript: null, failure: null };
    currentInput = input; inputs.push(input); suppressReplies(input.epoch); if (playbackState.status === 'playing' || playbackState.status === 'synthesizing') void stopPlayback('interruption'); publish(); return input;
  };
  function suppressReplies(nextEpoch) { for (const reply of replies.values()) if (reply.epoch < nextEpoch) { reply.suppressed = true; if (!reply.started) reply.status = 'suppressed'; else reply.status = 'interrupted'; } playbackEpoch++; }
  function receiveCapture(event, generation) { void enqueue(() => processCapture(event, generation)); }
  async function processCapture(event, generation) {
    if (generation !== captureGeneration || call.status !== 'connected' || activeRun?.inputEnabled === false || captureState.muted) return;
    if (!event || typeof event !== 'object') return;
    if (event.type === 'error') {
      error = errorView(event.error, 'capture');
      if (event.error?.code === 'OWNERSHIP_LOST') { captureState.status = 'paused-ownership'; accepting = false; void capture.stop(); void stopPlayback('ownership-lost'); }
      else { endForFailure(event.error, 'capture'); } publish(); return;
    }
    if (event.type === 'speech-start') {
      const input = openInput(event.sampleIndex);
      if (input) { void capture.setTurnActive?.(true); turn.start(event.sampleIndex, input.startSample); input.endSample = event.sampleIndex; }
      return;
    }
    if (event.type === 'speech-end') { turn.end(event.sampleIndex); return; }
    if (event.type === 'samples') {
      const actions = turn.advance(event.sampleIndex);
      for (const action of actions) {
        if (action.type === 'cut') await cutInput(action.startSample, action.endSample, false);
        else if (action.type === 'seal') await cutInput(action.startSample, action.endSample, true);
        else if (action.type === 'new-turn') {
          currentInput = null;
          if (call.status === 'connected' && !captureState.muted) { const next = openInput(action.startSample); if (next) { void capture.setTurnActive?.(true); turn.start(action.startSample, action.startSample); } }
        }
      }
    }
  }
  async function cutInput(startSample, endSample, seal) {
    const input = currentInput;
    if (!input || endSample <= startSample) return;
    input.endSample = endSample;
    const operation = op('capture-cut');
    let ref;
    try { ref = await capture.cut({ startSample, endSample, operation }); }
    catch (e) {
      input.audioComplete = false; input.sealed = true; input.status = 'held'; input.holdUntilExplicit = true; input.admission = 'not_attempted';
      input.failedRange = { startSample, endSample }; input.failure = errorView(e, 'capture-cut');
      if (currentInput === input) currentInput = null; turn.reset(); accepting = false; captureState.status = 'paused-error';
      void capture.setTurnActive?.(false); void capture.stop(); publish(); return;
    }
    input.clips.push({ ref, startSample, endSample, transcript: null });
    if (seal) { input.sealed = true; input.status = 'recognizing'; if (currentInput === input) currentInput = null; turn.reset(); void capture.setTurnActive?.(false); input.attemptTimer = clock.schedule(() => { void enqueue(() => failRecognition(input, Object.assign(new Error('本句识别超时，未发送，请重说。'), { code: 'VOICE_ASR_UTTERANCE_TIMEOUT' }))); }, VOICE_LIMITS.maxTranscriptSeconds * 1000); }
    else input.status = 'recognizing';
    recognitionQueue.push({ input, clip: input.clips.at(-1), selection: input.run?.selection ?? call.selection });
    runRecognitionQueue(); publish();
  }
  function runRecognitionQueue() {
    if (disposed || !accepting || call.status !== 'connected') return;
    const nextIndex = recognitionQueue.findIndex((item) => item.input.run === activeRun && !recognitionBusyRuns.has(item.input.run) && !['abandoned', 'discarded'].includes(item.input.localDisposition) && item.input.admission !== 'discarded');
    if (nextIndex < 0) return;
    const [next] = recognitionQueue.splice(nextIndex, 1), recognitionRun = next.input.run;
    recognitionBusyRuns.add(recognitionRun);
    next.input.recognitionInFlight = true;
    const operation = op('transcribe');
    next.input.recognitionOperation = operation; recognitionRun.recognitionOperation = operation;
    activeRecognitionOperation = operation;
    Promise.resolve().then(() => recognition.transcribe(next.clip.ref, { selection: next.selection, operation })).then((result) => enqueue(() => {
      if (!inputs.includes(next.input) || next.input.admission === 'discarded' || next.input.localDisposition === 'abandoned') return;
      const text = typeof result === 'string' ? result : result?.text;
      if (typeof text !== 'string') throw Object.assign(new Error('Recognition did not return final text'), { code: 'VOICE_ASR_INVALID' });
      next.clip.transcript = text;
      if (next.input.clips.every((c) => c.transcript !== null)) {
        next.input.transcript = next.input.clips.map((c) => c.transcript).join(' ').trim();
        if (!next.input.transcript && next.input.sealed) { next.input.status = 'discarded'; next.input.admission = 'discarded'; closeAttempt(next.input); void releaseInputAudio(next.input); }
        else if (next.input.sealed && next.input.audioComplete !== false) { closeAttempt(next.input); next.input.status = next.input.holdUntilExplicit ? 'held' : 'queued'; if (!next.input.holdUntilExplicit) void deliverNext(); }
      }
      publish();
    })).catch((e) => enqueue(() => { if (next.input.localDisposition === 'abandoned' || next.input.admission === 'discarded') return; if (next.input.holdUntilExplicit) { next.input.status = 'held'; next.input.failure = errorView(e, 'recognition'); } else failRecognition(next.input, e); publish(); })).finally(() => { next.input.recognitionInFlight = false; if (activeRecognitionOperation === operation) activeRecognitionOperation = null; if (recognitionRun.recognitionOperation === operation) { recognitionRun.recognitionOperation = null; recognitionBusyRuns.delete(recognitionRun); } trimHistory(); runRecognitionQueue(); drainReplies(); });
  }
  function closeAttempt(input) { input.attemptClosed = true; if (input.attemptTimer) { clock.cancel(input.attemptTimer); input.attemptTimer = null; } }
  function failRecognition(input, cause) {
    if (input.attemptClosed || input.localDisposition === 'abandoned' || ['accepted', 'discarded', 'submitting', 'unknown'].includes(input.admission)) return;
    closeAttempt(input); input.recognitionOperation?.cancel('recognition-failed');
    if (input.run?.recognitionOperation === input.recognitionOperation) { input.run.recognitionOperation = null; recognitionBusyRuns.delete(input.run); }
    recognitionQueue = recognitionQueue.filter(item => item.input !== input);
    input.status = 'discarded'; input.admission = 'discarded'; input.failure = errorView(cause, 'recognition');
    error = { ...input.failure, message: '本句未发送，请重说。' };
    if (currentInput === input) { currentInput = null; turn.reset(); void capture.setTurnActive?.(false); }
    void releaseInputAudio(input); trimHistory(); void deliverNext(); runRecognitionQueue(); drainReplies(); publish();
  }
  function endForFailure(cause, stage) { error = errorView(cause, stage); void hangup({ abandonPending: true }).catch(noop); publish(); }
  async function releaseInputAudio(input) { for (const clip of input.clips) { try { await audio.release(clip.ref); } catch {} } }
  async function deliverNext() {
    const activeSubmissionRun = activeRun;
    if (!activeSubmissionRun || activeSubmissionRun.submissionBusy || !accepting || call.status !== 'connected') return;
    const input = inputs.find((x) => x.run === activeSubmissionRun && x.status === 'queued' && x.transcript);
    if (!input) return;
    if (input.holdUntilExplicit) return;
    const earlierPending = inputs.some((x) => x.run === activeSubmissionRun && x.localDisposition !== 'abandoned' && x.order < input.order && x.inputId !== input.supersedes?.inputId && !x.holdUntilExplicit && ['recording', 'recognizing', 'queued', 'submitting'].includes(x.status));
    if (earlierPending) return;
    const queuedChars = inputs.filter((x) => !['accepted', 'discarded'].includes(x.admission) && x.localDisposition !== 'abandoned').reduce((n, x) => n + (x.transcript?.length || 0), 0);
    if (input.transcript.length > VOICE_LIMITS.inputTextChars || queuedChars > VOICE_LIMITS.queuedTextChars) { input.status = 'held'; input.holdUntilExplicit = true; input.failure = { code: input.transcript.length > VOICE_LIMITS.inputTextChars ? 'VOICE_TEXT_LIMIT' : 'VOICE_TEXT_QUEUE_LIMIT', stage: 'delivery', retryable: true, outcome: 'not_applied' }; publish(); return; }
    activeSubmissionRun.submissionBusy = true; input.status = 'submitting'; input.admission = 'submitting'; publish();
    const prepareOperation = op('prepare-submission');
    const run = input.run;
    try {
      if (run) run.pendingPrepareOperation = prepareOperation;
      const prepared = await conversation.prepareSubmission({ inputId: input.inputId, conversationRef: input.conversationRef, scopeId: input.scopeId, text: input.transcript, operation: prepareOperation });
      input.submissionId = prepared?.submissionId;
      if (typeof input.submissionId !== 'string' || !input.submissionId) throw Object.assign(new Error('Conversation did not provide a stable submission identity'), { code: 'VOICE_SUBMISSION_ID_MISSING', outcome: 'unknown' });
      run?.submissionEpochs.set(input.submissionId, input.epoch);
      if (!accepting || input.holdUntilExplicit || call.status !== 'connected' || input.callGeneration !== startGeneration || !run || clock.monoNow() >= run.leaseDeadline) {
        if (!input.localDisposition) { input.status = 'held'; input.admission = 'not_attempted'; }
        prepareOperation.cancel('submission-preparation-stale');
        try {
          const abandoned = await conversation.abandonSubmission?.({ inputId: input.inputId, submissionId: input.submissionId, conversationRef: input.conversationRef, scopeId: input.scopeId, operation: prepareOperation });
          if (abandoned === true) input.submissionId = null;
        } catch {}
        maybeReleaseDrainingRun(run);
        return;
      }
      if (run.pendingPrepareOperation === prepareOperation) run.pendingPrepareOperation = null;
      const operation = op('submit');
      input.submissionInFlight = true; run.submittedInFlight = true;
      const result = await conversation.submit({ inputId: input.inputId, submissionId: input.submissionId, conversationRef: input.conversationRef, scopeId: input.scopeId, text: input.transcript, operation });
      if (input.admission !== 'accepted') {
        if (result?.accepted === true) acceptInput(input, result.evidence || 'receipt');
        else if (result?.rejected === true || result?.outcome === 'not_applied') {
          if (input.localDisposition === 'abandoned') discardAbandonedInput(input);
          else { input.status = 'rejected'; input.admission = 'rejected'; input.failure = errorView(result, 'delivery'); }
        } else { input.status = input.localDisposition === 'abandoned' ? 'abandoned' : 'unknown'; input.admission = 'unknown'; input.failure = errorView(result, 'delivery'); }
      }
    } catch (e) {
      if (input.localDisposition === 'discarded') return;
      const abandoned = input.localDisposition === 'abandoned';
      const confirmed = await checkAdmission(input).catch(() => null);
      if (input.admission === 'accepted') { /* evidence already won the race */ }
      else if (confirmed?.accepted) acceptInput(input, confirmed.evidence || 'inspection');
      else if (abandoned && input.admission === 'discarded') { /* inspection already finalized not-applied work */ }
      else if (abandoned && (confirmed?.status === 'rejected' && confirmed?.outcome === 'not_applied' || e?.rejected === true || e?.outcome === 'not_applied')) discardAbandonedInput(input);
      else if (abandoned) { input.status = 'abandoned'; input.admission = 'unknown'; input.failure = errorView(e, 'delivery'); }
      else if (e?.rejected === true || e?.outcome === 'not_applied') { input.status = 'rejected'; input.admission = 'rejected'; input.failure = errorView(e, 'delivery'); }
      else { input.status = 'unknown'; input.admission = 'unknown'; input.failure = errorView(e, 'delivery'); }
    } finally {
      if (run?.pendingPrepareOperation === prepareOperation) run.pendingPrepareOperation = null;
      input.submissionInFlight = false;
      if (run) { run.submittedInFlight = inputs.some((x) => x.run === run && x.submissionInFlight); maybeReleaseDrainingRun(run); }
      if (activeSubmissionRun.submissionBusy) activeSubmissionRun.submissionBusy = false;
      publish(); void deliverNext(); drainReplies();
    }
  }
  function acceptInput(input, evidence) {
    input.admission = 'accepted'; input.status = input.localDisposition === 'abandoned' ? 'abandoned' : 'accepted'; input.acceptanceEvidence = evidence;
    for (const replacement of inputs.filter((x) => x.supersedes?.inputId === input.inputId)) {
      replacement.duplicateRisk = true;
      replacement.failure = { code: 'VOICE_POSSIBLE_DUPLICATE', stage: 'admission', retryable: false, outcome: 'applied' };
      if (!replacement.submissionInFlight && replacement.admission !== 'accepted') { replacement.status = 'held'; replacement.holdUntilExplicit = true; }
    }
    void releaseInputAudio(input);
    maybeReleaseDrainingRun(input.run);
  }
  async function checkAdmission(input) {
    if (!input.submissionId) return null;
    const result = await conversation.inspectAdmission({ inputId: input.inputId, submissionId: input.submissionId, conversationRef: input.conversationRef, scopeId: input.scopeId });
    if (result?.accepted === true || result?.status === 'accepted') { acceptInput(input, result.evidence || 'inspection'); return { accepted: true, evidence: result.evidence }; }
    if (result?.status === 'rejected' && result?.outcome === 'not_applied') {
      if (input.localDisposition === 'abandoned') discardAbandonedInput(input);
      else { input.status = 'rejected'; input.admission = 'rejected'; input.failure = errorView(result, 'admission-check'); }
    }
    return result;
  }
  function stopPlayback(reason) {
    playbackEpoch++;
    activeSynthesisOperation?.cancel(reason || 'playback-stopped'); activeSynthesisOperation = null;
    const stopRun = activeRun, stopToken = ++playbackStopGeneration;
    const currentReply = playbackState.replyId && replies.get(playbackState.replyId);
    if (currentReply) { currentReply.suppressed = true; currentReply.status = reason === 'interruption' ? 'interrupted' : 'stopped'; }
    playbackState.status = 'stopping'; publish();
    const stopping = playbackStopPromise.catch(() => {}).then(async () => {
      try { await playback.stop({ reason }); } catch {}
      if (stopToken === playbackStopGeneration && activeRun === stopRun) { playbackState.status = 'idle'; playbackState.replyId = null; publish(); }
    });
    playbackStopPromise = stopping;
    return stopping;
  }
  async function handleBatch(batch, run = activeRun) {
    if (run && activeRun !== run && !run.draining) return;
    if (!batch || !Array.isArray(batch.events)) return;
    if (batch.reset) { streamCursor = batch.cursor; return; }
    streamCursor = batch.cursor;
    const turnKey = (turnId) => `${run?.generation ?? startGeneration}:${String(turnId)}`;
    for (const event of batch.events) {
      if (event.type === 'input.accepted') {
        const input = inputs.find((x) => x.run === run && x.submissionId === event.submissionId);
        if (input && input.admission !== 'accepted') acceptInput(input, event.evidence || 'event');
        else if (!input && event.origin === 'local' && run === activeRun && !run.submissionEpochs.has(event.submissionId)) { run.submissionEpochs.set(event.submissionId, ++epoch); suppressReplies(epoch); if (playbackState.status === 'playing' || playbackState.status === 'synthesizing') void stopPlayback('interruption'); }
      } else if (event.type === 'input.consumed') {
        const input = inputs.find((x) => x.run === run && x.submissionId === event.submissionId);
        if (input) { if (input.admission !== 'accepted') acceptInput(input, 'consumption-event'); input.conversationTurnId = event.conversationTurnId; input.conversationTurnKey = turnKey(event.conversationTurnId); input.turnEnded = false; activeTurnIds.set(input.conversationTurnKey, { epoch: input.epoch, origin: event.origin, inputIds: [input.inputId] }); }
        else if (event.origin === 'local' && run === activeRun) { let inputEpoch = run.submissionEpochs.get(event.submissionId); if (inputEpoch === undefined) { inputEpoch = ++epoch; run.submissionEpochs.set(event.submissionId, inputEpoch); suppressReplies(epoch); } activeTurnIds.set(turnKey(event.conversationTurnId), { epoch: inputEpoch, origin: 'local', inputIds: [], run }); }
      } else if (event.type === 'turn.started') {
        if (event.origin === 'autonomous') activeTurnIds.set(turnKey(event.conversationTurnId), { epoch, origin: 'autonomous', inputIds: [], run });
      } else if (event.type === 'reply.revoked') {
        const reply = replies.get(event.replyId);
        if (reply?.run === run) { reply.suppressed = true; reply.status = 'revoked'; if (playbackState.replyId === reply.replyId) void stopPlayback('surface-revoked'); }
      } else if (event.type === 'reply.segment') {
        if (typeof event.replyId !== 'string' || typeof event.text !== 'string' || !event.responseId || !event.surfaceRevision) continue;
        const previous = replies.get(event.replyId);
        if (previous && (previous.surfaceRevision === event.surfaceRevision || previous.started)) continue;
        const knownEpochs = [...(event.inputIds || []).map(id => inputs.find(input => input.run === run && input.inputId === id)?.epoch), ...(event.submissionIds || []).map(id => run?.submissionEpochs.get(id))].filter(Number.isFinite);
        const segmentEpoch = knownEpochs.length ? Math.max(...knownEpochs) : null;
        const key = turnKey(event.conversationTurnId);
        const eligible = run === activeRun && call.status === 'connected' && segmentEpoch !== null && event.origin === 'local';
        const reply = { ...event, run, conversationRef: run?.ref, conversationTurnKey: key, epoch: segmentEpoch ?? -1, final: true, ended: true, eligibleTurn: eligible, suppressed: !eligible || segmentEpoch < epoch, status: 'available' };
        replies.set(event.replyId, reply); run?.segmentTurns.add(key); void queueReply(reply);
      } else if (event.type === 'reply.final') {
        if (run?.segmentTurns.has(turnKey(event.conversationTurnId))) continue;
        const turnInfo = activeTurnIds.get(turnKey(event.conversationTurnId));
        const origin = event.origin || turnInfo?.origin || 'unknown';
        const activeReplyRun = run === activeRun && call.status === 'connected';
        replies.set(event.replyId, { ...event, run, conversationRef: run?.ref, conversationTurnKey: turnKey(event.conversationTurnId), epoch: turnInfo?.epoch ?? epoch, origin, eligibleTurn: activeReplyRun && Boolean(turnInfo), final: true, ended: false, suppressed: !activeReplyRun || !turnInfo });
      } else if (event.type === 'turn.ended') {
        const key = turnKey(event.conversationTurnId);
        const turnInputs = inputs.filter((x) => x.run === run && x.conversationTurnKey === key);
        for (const input of turnInputs) {
          input.turnEnded = true; input.status = input.localDisposition === 'abandoned' ? 'abandoned' : event.outcome === 'completed' ? 'completed' : 'failed';
          if (event.outcome !== 'completed' && input.admission === 'accepted') {
            const failure = event.error || { code: 'VOICE_TURN_FAILED', message: 'The accepted voice input turn failed.' };
            input.failure = { ...errorView(failure, 'conversation'), outcome: 'applied', retryable: false };
          }
        }
        if (event.outcome !== 'completed') { activeTurnIds.delete(key); void deliverNext(); continue; }
        activeTurnIds.delete(key);
        const reply = [...replies.values()].find((r) => r.conversationTurnKey === key);
        if (reply) { reply.ended = true; void queueReply(reply); }
        trimHistory();
        void deliverNext();
      } else if (event.type === 'input.removed') {
        const input = inputs.find((x) => x.run === run && x.submissionId === event.submissionId);
        if (input && input.admission === 'accepted') { if (input.localDisposition !== 'abandoned') input.status = 'removed'; input.turnEnded = true; input.failure = { code: 'VOICE_INPUT_REMOVED', stage: 'conversation', retryable: false, outcome: 'applied' }; void deliverNext(); }
      }
    }
    if (run?.submissionEpochs) while (run.submissionEpochs.size > 256) run.submissionEpochs.delete(run.submissionEpochs.keys().next().value);
    drainReplies(); publish();
  }
  const outputBlocked = () => inputs.some((x) => x.run === activeRun && x.localDisposition !== 'abandoned' && !x.attemptClosed && !x.holdUntilExplicit && ['recording', 'recognizing'].includes(x.status));
  function drainReplies() { for (const reply of replies.values()) if (reply.run === activeRun && reply.ended && reply.eligibleTurn && !reply.suppressed && reply.epoch >= epoch && !['played', 'interrupted', 'revoked', 'failed', 'stopped'].includes(reply.status)) void queueReply(reply); }
  function queueReply(reply, options = {}) {
    if (reply.queued || !options.manual && ['played', 'revoked'].includes(reply.status)) return Promise.resolve(false);
    reply.queued = true;
    const replyRun = reply?.run;
    const previous = replyRunTasks.get(replyRun) || Promise.resolve();
    const task = Promise.resolve(previous).catch(() => {}).then(async () => {
      while (playbackState.status === 'stopping') {
        const stopping = playbackStopPromise;
        await stopping.catch(() => {});
        if (replyRun !== activeRun) return false;
      }
      return queueReplyNow(reply, options);
    });
    replyRunTasks.set(replyRun, task);
    task.then(() => { reply.queued = false; if (replyRunTasks.get(replyRun) === task) replyRunTasks.delete(replyRun); }, () => { reply.queued = false; if (replyRunTasks.get(replyRun) === task) replyRunTasks.delete(replyRun); });
    return task;
  }
  async function queueReplyNow(reply, { manual = false } = {}) {
    if (!playbackState.enabled || reply.run !== activeRun || (!manual && reply.suppressed) || !reply.eligibleTurn || reply.origin !== 'local' && reply.origin !== 'autonomous' || (!manual && reply.epoch < epoch) || outputBlocked() || call.status !== 'connected' || ['playing', 'synthesizing', 'stopping'].includes(playbackState.status)) return false;
    const text = speechToText(reply.text);
    const sentences = splitSpeechSentences(text);
    if (!sentences.length) return false;
    const replyRun = reply.run;
    const playbackGeneration = playbackEpoch;
    const isCurrentPlayback = () => replyRun === activeRun && playbackGeneration === playbackEpoch && call.status === 'connected';
    const speakerMode = replyRun.inputEnabled !== false && config.duplexPreference === 'speaker-turn-taking';
    let speakerGateToken = null;
    reply.status = 'synthesizing';
    try {
      for (const sentence of sentences) {
        if (!isCurrentPlayback() || !playbackState.enabled || (!manual && reply.suppressed) || (!manual && reply.epoch < epoch) || outputBlocked()) return false;
        if (speakerMode && !speakerGateToken) { speakerGateToken = { run: replyRun, generation: playbackGeneration }; activeSpeakerGate = speakerGateToken; captureState.status = 'gated'; await capture.gate(true); }
        if (!isCurrentPlayback()) return false;
        const operation = op('synthesize'); activeSynthesisOperation = operation;
        try {
          playbackState.status = 'synthesizing'; playbackState.replyId = reply.replyId; publish();
          const synthesized = await synthesis.synthesize(sentence, config.tts, { operation });
          if (activeSynthesisOperation === operation) activeSynthesisOperation = null;
          const clipRef = synthesized?.clipRef || synthesized;
          try {
            if (!isCurrentPlayback() || !playbackState.enabled || (!manual && reply.suppressed) || (!manual && reply.epoch < epoch) || outputBlocked()) return false;
            playbackState.status = 'playing'; playbackState.replyId = reply.replyId; publish();
            const played = await playback.play(clipRef, { operation: op('play'), onStarted: () => { reply.started = true; }, onEnded: noop, onError: noop });
            if (!isCurrentPlayback() || played?.stopped) { reply.status = 'stopped'; return false; }
            playbackState.status = 'idle'; playbackState.replyId = null;
          } finally { await synthesis.release?.(clipRef); }
        } catch (e) { if (activeSynthesisOperation === operation) activeSynthesisOperation = null; if (!isCurrentPlayback() || operation.signal.aborted) return false; playbackState.status = 'failed'; playbackState.replyId = reply.replyId; reply.status = 'failed'; error = errorView(e, 'playback'); publish(); return false; }
      }
      if (!isCurrentPlayback()) return false;
      reply.status = 'played'; publish(); return true;
    } finally {
      if (speakerGateToken) {
        await new Promise((resolve) => clock.schedule(resolve, VOICE_LIMITS.speakerGateTailMs));
        if (activeSpeakerGate === speakerGateToken) {
          activeSpeakerGate = null;
          if (replyRun === activeRun && call.status === 'connected' && !captureState.muted && captureState.status === 'gated' && playbackState.status !== 'playing') {
            await capture.gate(false);
            if (replyRun === activeRun && call.status === 'connected' && !captureState.muted && captureState.status === 'gated') { captureState.status = 'listening'; publish(); }
          }
        }
      }
    }
  }
  async function replayReply(replyId) {
    const reply = replies.get(replyId);
    if (!reply || reply.run !== activeRun || !reply.ended || !reply.eligibleTurn || !['local', 'autonomous'].includes(reply.origin)) throw Object.assign(new Error('Reply is not eligible for replay'), { code: 'VOICE_REPLY_NOT_REPLAYABLE' });
    if (!playbackState.enabled) throw Object.assign(new Error('Reply audio is disabled'), { code: 'VOICE_OUTPUT_DISABLED' });
    if (call.status !== 'connected' || outputBlocked()) throw Object.assign(new Error('Reply replay is blocked by current call activity'), { code: 'VOICE_REPLY_REPLAY_BLOCKED' });
    if (['playing', 'synthesizing'].includes(playbackState.status)) throw Object.assign(new Error('Another reply is already playing'), { code: 'VOICE_PLAYBACK_BUSY' });
    reply.suppressed = false; reply.epoch = epoch; reply.status = 'available';
    const result = await queueReply(reply, { manual: true }); publish(); return result;
  }
  function trimHistory() {
    const terminal = inputs.filter((x) => ['accepted', 'discarded'].includes(x.admission) && (x.turnEnded || x.admission === 'discarded'));
    const settledAbandoned = inputs.filter((x) => x.localDisposition === 'abandoned' && !x.submissionInFlight && !x.recognitionInFlight && (!x.run || x.run.released));
    const candidates = [...new Set([...terminal, ...settledAbandoned])].sort((a, b) => a.order - b.order);
    for (const row of candidates.slice(0, Math.max(0, candidates.length - 64))) inputs.splice(inputs.indexOf(row), 1);
    const endedReplies = [...replies.values()].filter((x) => x.ended);
    for (const row of endedReplies.slice(0, Math.max(0, endedReplies.length - 64))) replies.delete(row.replyId);
  }

  function start(ref, options = {}) {
    if (pendingStartPromise) return pendingStartPromise;
    if (call.status === 'connected') return Promise.resolve(snapshot());
    const pending = startInternal(ref, options);
    pendingStartPromise = pending.finally(() => { if (pendingStartPromise === wrapped) pendingStartPromise = null; });
    const wrapped = pendingStartPromise;
    return wrapped;
  }
  async function startInternal(ref, { unlockResult, selection, inputEnabled = true } = {}) {
    if (disposed) throw new Error('Voice service is disposed');
    if (typeof inputEnabled !== 'boolean') throw new TypeError('inputEnabled must be boolean');
    if (!validRef(ref)) throw Object.assign(new TypeError('A complete ConversationRef is required'), { code: 'VOICE_TARGET_INVALID' });
    if (call.status === 'connected') return snapshot();
    await cleanupPromise;
    playbackState.status = 'idle'; playbackState.replyId = null;
    const generation = ++startGeneration; accepting = false; error = null;
    const callId = ids.createId('call');
    const run = { callId, scopeId: callId, generation, inputEnabled, ref: clone(ref), selection: undefined, captureGeneration: ++captureGeneration, retained: false, leaseHeld: false, stopFollow: noop, leaseTimer: null, leaseDeadline: Infinity, draining: false, submittedInFlight: false, released: false, submissionEpochs: new Map(), segmentTurns: new Set() };
    activeRun = run;
    call = { status: 'preparing', id: run.callId, conversationRef: clone(run.ref), inputEnabled }; publish();
    const current = () => activeRun === run && startGeneration === run.generation && !disposed;
    try {
      if (!unlockResult || unlockResult.ready === false || unlockResult.unlocked === false) throw Object.assign(new Error('Local playback is not unlocked'), { code: 'VOICE_PLAYBACK_LOCKED', stage: 'playback' });
      const [target, captureCaps, asrCaps, playbackCaps, synthesisCaps] = await Promise.all([conversation.inspect(run.ref, { scopeId: run.scopeId }), inputEnabled ? capture.inspect() : {}, inputEnabled ? recognition.inspect() : {}, playback.inspect(), synthesis.inspect?.() ?? { available: true }]);
      if (!current()) throw Object.assign(new Error('Call start was cancelled'), { code: 'VOICE_CANCELLED' });
      if (target?.available !== true || target?.valid === false) throw Object.assign(new Error('Conversation target is unavailable'), { code: 'VOICE_TARGET_UNAVAILABLE' });
      for (const [caps, code, stage, message] of [
        [captureCaps, 'VOICE_CAPTURE_UNSUPPORTED', 'capture', 'Microphone capture is unavailable'],
        [asrCaps, 'VOICE_RECOGNITION_UNAVAILABLE', 'recognition', 'Speech recognition is unavailable'],
        [playbackCaps, 'VOICE_PLAYBACK_UNSUPPORTED', 'playback', 'Audio playback is unavailable'],
        [playbackState.enabled ? synthesisCaps : null, 'VOICE_TTS_UNSUPPORTED', 'synthesis', 'Speech synthesis is unavailable'],
      ]) {
        if (caps?.available === false) throw Object.assign(new Error(message), { code, stage, outcome: 'not_applied' });
      }
      run.selection = selection ?? asrCaps.selection ?? asrCaps.defaultSelection;
      call.selection = run.selection;
      if (typeof conversation.retain === 'function') { await conversation.retain(run.ref, { scopeId: run.scopeId }); run.retained = true; }
      if (!current()) { if (run.retained) { await conversation.release?.(run.ref, { scopeId: run.scopeId }); run.retained = false; } throw Object.assign(new Error('Call start was cancelled'), { code: 'VOICE_CANCELLED' }); }
      const lease = await ownership.acquire({ callRef: { callId: run.callId, conversation: clone(run.ref), generation }, conversationRef: clone(run.ref) });
      if (lease?.valid === false) throw Object.assign(new Error('Voice ownership is unavailable'), { code: 'VOICE_OWNERSHIP_UNAVAILABLE' });
      if (!current()) { await ownership.release({ callRef: { callId: run.callId, conversation: clone(run.ref), generation } }); throw Object.assign(new Error('Call start was cancelled'), { code: 'VOICE_CANCELLED' }); }
      run.leaseHeld = true;
      const now = clock.monoNow(); run.leaseDeadline = now + Math.max(0, (lease?.leaseMs ?? 15000) - 1000);
      scheduleRenew(run);
      if (!current()) throw Object.assign(new Error('Call start was cancelled'), { code: 'VOICE_CANCELLED' });
      run.followOperation = op('conversation-follow');
      const followResult = await conversation.follow(run.ref, { scopeId: run.scopeId, cursor: undefined, signal: run.followOperation.signal, onBatch: (batch) => { void enqueue(() => handleBatch(batch, run)); } });
      run.stopFollow = typeof followResult === 'function' ? followResult : followResult?.unsubscribe || noop;
      if (!current()) { try { run.stopFollow(); } catch {} run.stopFollow = noop; throw Object.assign(new Error('Call start was cancelled'), { code: 'VOICE_CANCELLED' }); }
      const initialCaptureGeneration = run.captureGeneration;
      if (inputEnabled) {
        run.captureStartOperation = op('capture-start');
        await capture.start({ callRef: { callId: run.callId, conversation: clone(run.ref), generation }, selection: run.selection, onEvent: (event) => receiveCapture(event, initialCaptureGeneration), operation: run.captureStartOperation });
        run.captureStartOperation = null;
      }
      if (!current() || captureGeneration !== initialCaptureGeneration || call.status !== 'preparing') throw Object.assign(new Error('Call start was cancelled'), { code: 'VOICE_CANCELLED' });
      if (clock.monoNow() >= run.leaseDeadline) throw Object.assign(new Error('Voice ownership lease expired during startup'), { code: 'VOICE_OWNERSHIP_LOST' });
      accepting = inputEnabled; call.status = 'connected'; captureState = { status: inputEnabled ? 'listening' : 'stopped', muted: false }; scheduleRenew(run); publish(); return snapshot();
    } catch (e) {
      if (activeRun === run && generation === startGeneration && call.status !== 'ended') { error = errorView(e, e?.stage || 'start'); call.status = 'failed'; accepting = false; }
      cleanupPromise = cleanupCall(run); await cleanupPromise; publish(); throw e;
    }
  }
  function scheduleRenew(run) {
    if (!run.leaseHeld || run.draining || disposed) return;
    if (run.leaseTimer) clock.cancel(run.leaseTimer);
    run.leaseTimer = clock.schedule(async () => {
      if (activeRun !== run || !['connected', 'preparing'].includes(call.status) || !run.leaseHeld) return;
      const requestedAt = clock.monoNow();
      try {
        const lease = await ownership.renew({ callRef: { callId: run.callId, conversation: clone(run.ref), generation: run.generation } });
        if (activeRun !== run || !['connected', 'preparing'].includes(call.status)) return;
        if (lease?.valid === false) throw Object.assign(new Error('Voice ownership lease expired'), { code: 'VOICE_OWNERSHIP_LOST' });
        run.leaseDeadline = requestedAt + Math.max(0, (lease?.leaseMs ?? 15000) - 1000);
        scheduleRenew(run);
      } catch (e) {
        if (activeRun === run) { accepting = false; captureState.status = 'paused-ownership'; if (call.status === 'preparing') call.status = 'failed'; error = errorView(e, 'ownership-renew'); ++captureGeneration; void capture.stop(); void stopPlayback('ownership-lost'); publish(); }
      }
    }, 5000);
  }
  function hasAbandonedUnknownAdmission(run) { return inputs.some((input) => input.run === run && input.localDisposition === 'abandoned' && input.admission === 'unknown'); }
  function maybeReleaseDrainingRun(run) {
    if (run?.draining && !run.submittedInFlight && !hasAbandonedUnknownAdmission(run)) void releaseRunConversation(run);
  }
  function discardAbandonedInput(input) {
    input.localDisposition = 'discarded'; input.status = 'discarded'; input.admission = 'discarded'; input.holdUntilExplicit = false;
    void releaseInputAudio(input); maybeReleaseDrainingRun(input.run); trimHistory(); publish();
  }
  function markInputAbandoned(input) {
    input.localDisposition = 'abandoned'; input.status = 'abandoned'; input.holdUntilExplicit = true;
    void releaseInputAudio(input);
  }
  async function releaseRunConversation(run) {
    if (run.released) return; run.released = true;
    drainingRuns.delete(run);
    if (run.drainTimer) clock.cancel(run.drainTimer);
    run.followOperation?.cancel('conversation-follow-released');
    try { run.stopFollow(); } catch {} run.stopFollow = noop;
    if (run.retained) { try { await conversation.release?.(run.ref, { scopeId: run.scopeId }); } catch {} run.retained = false; }
    trimHistory();
  }
  function cleanupCall(run) {
    if (run.cleanupPromise) return run.cleanupPromise;
    run.cleanupPromise = (async () => {
      if (run.leaseTimer) clock.cancel(run.leaseTimer);
      run.captureStartOperation?.cancel('call-ended');
      run.pendingPrepareOperation?.cancel('call-ended');
      if (!run.draining) run.followOperation?.cancel('call-ended');
      if (activeRun === run) ++captureGeneration;
      await Promise.allSettled([capture.stop(), stopPlayback('call-ended')]);
      try { await capture.release?.(); } catch {}
      if (!run.preservePlayback) { try { await playback.release?.(); } catch {} }
      if (run.leaseHeld) { try { await ownership.release({ callRef: { callId: run.callId, conversation: clone(run.ref), generation: run.generation } }); } catch {} run.leaseHeld = false; }
      if (run.draining) {
        drainingRuns.add(run);
        run.drainTimer = clock.schedule(() => { void releaseRunConversation(run); }, 30000);
        if (!run.submittedInFlight && !hasAbandonedUnknownAdmission(run)) await releaseRunConversation(run);
      } else await releaseRunConversation(run);
      if (activeRun === run) activeRun = null;
    })();
    return run.cleanupPromise;
  }
  async function mute() {
    if (activeRun?.inputEnabled === false) return;
    accepting = false; captureState.muted = true; captureState.status = 'muted'; ++captureGeneration; turn.reset();
    activeRecognitionOperation?.cancel('muted');
    if (activeRun) { activeRun.captureGeneration = -1; activeRun.captureStartOperation?.cancel('muted'); activeRun.pendingPrepareOperation?.cancel('muted'); }
    for (const input of inputs) {
      if (!['accepted', 'discarded'].includes(input.admission) && !input.submissionInFlight) {
        input.status = 'held'; input.holdUntilExplicit = true; if (input.admission !== 'unknown') input.admission = 'not_attempted';
      }
    }
    currentInput = null;
    try { await capture.stop(); } catch {} publish();
  }
  async function unmute() {
    if (call.status !== 'connected' || activeRun?.inputEnabled === false) return;
    captureState.muted = false; accepting = true; captureGeneration++; const gen = captureGeneration; const run = activeRun;
    if (!run) { captureState.status = 'paused-error'; return; }
    run.captureGeneration = gen;
    const operation = op('capture-resume');
    try { await capture.start({ callRef: { callId: run.callId, conversation: clone(run.ref), generation: run.generation }, selection: run.selection, onEvent: (e) => receiveCapture(e, gen), operation }); if (activeRun !== run || captureGeneration !== gen || captureState.muted) return; captureState.status = 'listening'; }
    catch (e) { captureState.status = 'paused-error'; error = errorView(e, 'capture-resume'); }
    publish();
  }
  async function setOutputEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    playbackState.enabled = enabled;
    if (!enabled) { ++opGeneration; await stopPlayback('output-disabled'); }
    publish();
  }
  async function hangup({ abandonPending = false, preservePlayback = false } = {}) {
    if (typeof abandonPending !== 'boolean') throw new TypeError('abandonPending must be boolean');
    if (typeof preservePlayback !== 'boolean') throw new TypeError('preservePlayback must be boolean');
    if (call.status === 'idle') return snapshot();
    if (call.status === 'ended') { await cleanupPromise; return snapshot(); }
    accepting = false; call.status = 'ending'; captureState.status = 'stopping'; ++startGeneration;
    ++captureGeneration; turn.reset();
    ++playbackEpoch; activeSynthesisOperation?.cancel('call-ended'); activeSynthesisOperation = null; activeSpeakerGate = null;
    const run = activeRun;
    activeRecognitionOperation?.cancel('call-ended');
    run?.captureStartOperation?.cancel('call-ended'); run?.pendingPrepareOperation?.cancel('call-ended');
    if (abandonPending) {
      for (const input of inputs) {
        const unfinished = input.submissionInFlight || input.recognitionInFlight || input.admission === 'unknown';
        if (unfinished) markInputAbandoned(input);
        else if (!['accepted', 'discarded'].includes(input.admission)) {
          input.localDisposition = 'discarded'; input.status = 'discarded'; input.admission = 'discarded'; input.holdUntilExplicit = false;
          void releaseInputAudio(input);
        }
      }
      recognitionQueue = recognitionQueue.filter((entry) => !['abandoned', 'discarded'].includes(entry.input.localDisposition));
    } else {
      for (const input of inputs) if (!['accepted', 'discarded'].includes(input.admission) && !input.submissionInFlight) { input.status = 'held'; input.holdUntilExplicit = true; if (input.admission !== 'unknown') input.admission = 'not_attempted'; }
    }
    if (run) {
      run.preservePlayback = preservePlayback;
      run.submittedInFlight = inputs.some((x) => x.run === run && x.submissionInFlight);
      run.draining = run.submittedInFlight || abandonPending && hasAbandonedUnknownAdmission(run);
    }
    currentInput = null;
    playbackState.status = 'idle'; playbackState.replyId = null; call.status = 'ended'; captureState.status = 'stopped';
    if (run) cleanupPromise = cleanupCall(run);
    trimHistory(); publish(); await cleanupPromise; return snapshot();
  }
  async function continueCall(options = {}) { if (!['ended', 'failed'].includes(call.status)) return snapshot(); return start(call.conversationRef, options); }
  async function retryInput(id) {
    const input = inputById(id); if (!input) throw new Error('Unknown input');
    if (input.localDisposition === 'abandoned' || input.localDisposition === 'discarded') throw new Error('Locally ended input cannot be retried');
    if (input.admission === 'accepted') throw new Error('Accepted input cannot be retried');
    if (input.admission === 'unknown') throw Object.assign(new Error('Unknown admission requires evidence check or explicit superseding send'), { code: 'VOICE_ADMISSION_UNKNOWN' });
    if (!['held', 'rejected', 'recognizing'].includes(input.status)) throw new Error('Input is not available to retry');
    if (input.clips.some((c) => c.transcript === null)) {
      for (const clip of input.clips.filter((c) => c.transcript === null)) recognitionQueue.push({ input, clip, selection: input.run?.selection ?? call.selection });
      input.status = 'recognizing'; input.holdUntilExplicit = true; input.failure = null; runRecognitionQueue(); publish(); return;
    }
    input.status = 'queued'; input.admission = 'not_attempted'; input.holdUntilExplicit = false; input.failure = null; await deliverNext();
  }
  function createSupersedingInput(input, transcript) {
    if (unresolvedCount() >= VOICE_LIMITS.unresolvedInputs) throw Object.assign(new Error('Voice input limit reached'), { code: 'VOICE_INPUT_LIMIT' });
    const duplicateRisk = input.admission === 'unknown';
    const run = activeRun ?? input.run;
    const replacement = { inputId: ids.createId('input'), order: ++order, epoch: ++epoch, conversationRef: clone(input.conversationRef), scopeId: run?.scopeId ?? input.scopeId, callGeneration: run?.generation ?? input.callGeneration, run, status: 'held', admission: 'not_attempted', startSample: null, endSample: null, clips: [], transcript, sealed: true, failure: duplicateRisk ? { code: 'VOICE_POSSIBLE_DUPLICATE', stage: 'admission', retryable: false, outcome: 'unknown' } : null, duplicateRisk, supersedes: { inputId: input.inputId, submissionId: input.submissionId ?? null } };
    inputs.push(replacement); suppressReplies(replacement.epoch); return replacement;
  }
  async function editInput(id, text) {
    const input = inputById(id); if (!input) throw new Error('Unknown input');
    if (input.localDisposition === 'abandoned' || input.localDisposition === 'discarded' || input.admission === 'discarded') throw new Error('Locally ended input cannot be edited');
    if (typeof text !== 'string' || !text.trim() || text.length > VOICE_LIMITS.inputTextChars) throw new TypeError('Edited voice text is invalid');
    if (input.admission === 'accepted') throw new Error('Accepted input cannot be edited');
    if (input.admission === 'unknown' || input.submissionId) { const replacement = createSupersedingInput(input, text.trim()); publish(); return replacement.inputId; }
    input.transcript = text.trim(); input.status = 'held'; input.admission = 'not_attempted'; input.failure = null; publish(); return input.inputId;
  }
  async function submitHeld(id) {
    const input = inputById(id); if (!input) throw new Error('Unknown input'); if (!input.transcript) throw new Error('Input has no transcript');
    if (input.localDisposition === 'abandoned' || input.localDisposition === 'discarded') throw new Error('Locally ended input cannot be submitted');
    if (input.admission === 'accepted') throw new Error('Accepted input cannot be resubmitted');
    if (!['held', 'rejected', 'unknown'].includes(input.status) && !['rejected', 'unknown'].includes(input.admission)) throw new Error('Input is not held for explicit submission');
    const target = input.admission === 'unknown' || input.submissionId ? createSupersedingInput(input, input.transcript) : input;
    target.status = 'queued'; target.holdUntilExplicit = false; await deliverNext(); return target.inputId;
  }
  async function discardInput(id) { const input = inputById(id); if (!input) return; if (input.localDisposition === 'abandoned') throw new Error('Abandoned input must remain available for late admission evidence'); if (input.admission === 'accepted') throw new Error('Accepted input cannot be discarded'); input.status = 'discarded'; input.admission = 'discarded'; if (currentInput === input) currentInput = null; await releaseInputAudio(input); publish(); }
  async function retryUnknown(id) { const input = inputById(id); if (!input || input.admission !== 'unknown') throw new Error('Input is not unknown'); const result = await checkAdmission(input); if (input.localDisposition === 'discarded') { publish(); return snapshot(); } if (!result || !['accepted', 'rejected'].includes(input.admission)) { input.status = input.localDisposition === 'abandoned' ? 'abandoned' : 'unknown'; input.admission = 'unknown'; } publish(); return snapshot(); }
  async function dispose() {
    if (disposed) return; await hangup(); await cleanupPromise; disposed = true;
    for (const run of [...drainingRuns]) { if (run.drainTimer) clock.cancel(run.drainTimer); await releaseRunConversation(run); }
    listeners.clear(); for (const input of inputs) if (!['accepted', 'discarded'].includes(input.admission)) await releaseInputAudio(input);
    try { await playback.release?.(); } catch {}
  }
  return { start, mute, unmute, setOutputEnabled, hangup, continueCall, retryInput, editInput, submitHeld, discardInput, retryUnknown, replayReply, getSnapshot: snapshot, subscribe(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); }, dispose };
}
