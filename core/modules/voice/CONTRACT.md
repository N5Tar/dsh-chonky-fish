# Voice core adapter contract

The public ESM entry is `core/modules/voice/index.js`:

```js
import { createVoiceService, DEFAULT_VOICE_CONFIG, validateVoiceConfig,
  VOICE_LIMITS, parseSpeechReply } from './core/modules/voice/index.js'
const service = createVoiceService({ capture, recognition, conversation,
  synthesis, playback, ownership, audio, clock, ids, config })
```

The caller invokes `playback.unlock()` synchronously from the start button's
user gesture, then passes its result to `service.start(ref, { unlockResult,
selection })`. `start` never delays or fabricates this gesture result.

## Port shapes

- `clock`: `{ monoNow(): number, schedule(fn, delayMs): handle,
  cancel(handle): void }`. `ids.createId(kind): string`.
- `playback`: `inspect()`, `unlock()`, `openStream({format,operation,onStarted})`
  returning `{append(Uint8Array),endInput(),finished}`, `stop()`, `release()`.
  `unlock` is called by the composition root. `openStream` accepts `pcm_s16le`
  chunks and one complete `wav` frame; its `finished` promise settles on
  natural end, active stop, or failure.
- `capture`: `inspect()`, `start({callRef,selection,onEvent,operation})`,
  `cut({startSample,endSample,operation}) -> clipRef` (ownership transfers to
  the core), optional `setTurnActive(boolean)`, `gate(boolean)`,
  `stop()`, `release()`. Events: `{type:'speech-start'|'speech-end'|'samples'
  |'error', sampleIndex, level?, error?}`; `samples` carries the newest absolute
  16 kHz sample index. Speech transitions use the same sample clock. A duplex
  capture returns `{duplex:{nearEndDetection,echoCancellationEnabled,
  implementation,deviceVerified}}` from `start`. Device qualification is
  separate from the requested constraint and from `getSettings()`.
- `recognition`: `inspect()`, `transcribe(clipRef,{selection,operation}) ->
  {text}`. Selection is pinned at call start from capability inspection.
- `audio`: `retain(clipRef)`, `release(clipRef)`, `read(clipRef)`; optional
  `reserve({bytes,kind}) -> {release()}`. Refs are opaque and scoped.
- `conversation`: `inspect(ref,{scopeId})`, `retain(ref,{scopeId})`,
  `release(ref,{scopeId})`, `prepareSubmission({inputId,conversationRef,
  scopeId,text,operation}) -> {submissionId}`, `submit({inputId,submissionId,
  conversationRef,scopeId,text,operation})`,
  `inspectAdmission({inputId,submissionId,conversationRef,scopeId})`, optional
  `abandonSubmission({inputId,submissionId,conversationRef,scopeId,operation}) ->
  boolean`, `follow(ref,{scopeId,cursor,onBatch,signal}) ->
  unsubscribe`. `submit` resolves to `{accepted:true,evidence}` or
  `{accepted:false, outcome:'not_applied'|'unknown', rejected?:true, code?}`.
  `follow` batches use `{streamGeneration,cursor,reset,events}`. Event fields
  follow the normalized DTOs below and `docs/voice-call-technical-v3.md`.
- `synthesis`: `inspect()`,
  `synthesizeReply({source:{sessionId,seq},voice},{operation}) -> AsyncIterable`
  of `{type:'audio',data:Uint8Array,format}` and a final
  `{type:'complete',receipt?}`. One call synthesizes one committed assistant
  message. Audio formats are `pcm_s16le` or `wav`; complete WAV is one audio
  event followed by `complete`.
- `ownership`: `acquire({callRef,conversationRef})`, `renew()`, `release()`;
  acquire/renew return `{valid:boolean, scopeId?, leaseMs?}`. A revocation may
  be delivered to capture as `{type:'error', error:{code:'OWNERSHIP_LOST'}}`.

`createVoiceService` returns `start(ref,{unlockResult,selection,inputEnabled=true})`, `mute()`,
`unmute()`, `setOutputEnabled(enabled)`, `hangup({abandonPending=false,preservePlayback=false})`, `continueCall()`,
`retryInput(inputId)`, `editInput(inputId,text)`, `submitHeld(inputId)`,
`discardInput(inputId)`, `retryUnknown(inputId)` (only performs an evidence
check; it never resubmits),
`playStoredAudio({format,data,operation})` (plays stored reply bytes through the
shared output stream without requesting TTS), `getSnapshot()`,
`subscribe(listener)`, and
`dispose()`. All commands return promises except snapshot/subscription methods.

With `inputEnabled:false`, startup skips capture/recognition capability checks and
never starts or unmutes capture. It still retains/follows the conversation and
uses the normal output ownership, eligibility, cancellation and audio lifecycle.
The snapshot's `call.inputEnabled` distinguishes this connection from an open
microphone; output-only playback does not gate capture.

`preservePlayback:true` is for an immediate internal mode transition: stop and
cancel the old output and release its conversation/lease, but retain the already
unlocked playback context. Normal End/reset close it, and `dispose()` always
releases playback even if a transition preserved it without starting a new run.

`hangup()` waits for capture/playback teardown and ownership release before it
resolves. Its default preserves held and unknown inputs for an advanced UI.
An explicit end/reset may pass `{abandonPending:true}`: known not-submitted or
not-applied inputs are discarded and released; ASR or submissions already in
flight and unknown admissions are marked locally abandoned, retain proof
identity, release raw audio, and can never be resent. Unknown/in-flight prompt
drains retain their per-call follow and ConversationRef for up to 30 seconds
for late acceptance proof. The same service may start a new ConversationRef;
old drain events update only their original input and cannot speak or replay
output into the new call. Abandoned metadata is bounded to 64 rows once its
  drain has ended, even if an external submit never settles. `dispose()` uses the default behavior and is
reserved for plugin unload.

Snapshots are serializable UI data only:

```js
{ call:{status,id,conversationRef}, capture:{status,muted},
  inputs:[{inputId,order,status,transcript,admission,localDisposition,clips:<count>,error}],
  replies:[{replyId,conversationTurnId,status,origin,source}],
  playback:{status,enabled,replyId}, queue:{unresolved,waiting}, error }
```

Audio refs and operation signals do not appear in snapshots. Budgets and held
inputs belong to the injected audio repository, so creating a new service does
not reset the repository's totals. An `unknown` input is never resubmitted by
a retry/check action and does not block later independent utterances. Accepted
inputs do not wait for their agent turn or background task to finish before
the next input is admitted. Preparation/submission are serialized only while
admitting an individual input.

Each service call creates a stable `scopeId` and passes it with cloned
ConversationRefs to every conversation port call. Adapters should key retained
ownership and submissions by `scopeId`, never JavaScript object identity.

Operations include a process-local `AbortSignal` and `cancel(reason)` method.
Adapters may map cancellation to their own explicit cancel API. The core does
not cancel a conversation submission after `submit` has begun; its outcome is
checked by the original stable submission identity. Preparation receives its
own cancellable operation. If it resolves after mute, hangup, or a stale call
fence, the core skips submission and calls `abandonSubmission`; the adapter
returns `true` only when it confirms the prepared request was abandoned.

## Continuous input and output eligibility

Final silence defaults to 1200 ms. Recognition has a 30-second utterance
finish deadline from speech-end, including final silence and queued recognition. Known unsent
recognition failures release the attempt and audio so another utterance can
proceed. Preparation and submission waits are each bounded to 30 seconds;
admission checks to 5 seconds. A submit timeout retains its original identity
as unknown, observes its late result, and never repeats the submit.

Capture faults, lost ownership and exhausted real budgets end the call and
stop both audio directions. Renewal waits are bounded; a late renewal cannot
reopen the call. Hanging up does not cancel durable business tasks.

`speaker-duplex` keeps sampling, AEC and VAD active while TTS plays. Near-end
speech invalidates old reply eligibility and stops the active output. The
Web composition requires an actually enabled echo-cancellation track; it
does not certify acoustic performance. Legacy `speaker-turn-taking` is an
explicit compatibility mode; the DSH composition migrates that stored default
to `speaker-duplex`.

Committed events use the following payloads (in addition to stream identity):

```js
{ type: 'input.accepted', inputId, submissionId, evidence }
{ type: 'input.consumed', inputId, submissionId, messageId,
  conversationTurnId, stepId, origin }
{ type: 'reply.message', replyId, conversationTurnId, responseId, stepId,
  inputIds, submissionIds, origin, text, source:{sessionId,seq}, surfaceRevision }
{ type: 'reply.revoked', replyId, conversationTurnId, responseId, stepId,
  surfaceRevision }
```

Each committed assistant message may play before `turn.ended`, once, only
after its declared inputs have matching `input.consumed` proof in the same call.
Preparation or acceptance alone is insufficient. The normalized message must
identify its exact committed source as `sessionId + seq`; the Host checks that
source against the observed current session event before synthesis. A step
inherits the consumed watermark of its prior step, then incorporates new
consumption. Newest received input and whole-turn origin are not substitutes
for step provenance. Historical, external, mixed, revoked and interrupted
outputs cannot become current local audio. There is no final-turn aggregation,
sentence splitting, or replay-by-resynthesis path.

An `owned-task` consumed event additionally contains `taskId`, `taskVersion`
and `sourceInputId`. Its stable submission identity is
`chonkyfish-task-notice:${eventId}`. It is eligible only for the original task
owner while a call is active. User speech, recognition, preparation and
submission take priority; a newly accepted user input suppresses conflicting
task audio. A call reset never retargets an old task or notice.

## Host scheduling and task boundaries

DSH-specific `steer`, conditional interruption and idle driver wake live in
`app/dsh/adapters/voice/`; the core knows none of the DSH SDK. The Host first
proves that the original accepted input remains unclaimed at the observed
generation. An interruption is issued once; uncertain receipts are queried
using the original interruption ID. A wake contains no message body. Host
recreation may recover only proven local owned pending input; it must not
replay submissions or wake social/unowned messages.

`core/modules/tasks/service.js` is a separate portable lifecycle coordinator.
Its injected repository owns durable namespace/conversation identity,
operation receipts, versions, resource locks and event outbox. External
adapters explicitly define execution scope, status, cancellation and recovery.
Task ownership never depends on the current voice lease, call generation or
page binding. See `docs/voice-call-implementation-guide.md` for adapter usage.
