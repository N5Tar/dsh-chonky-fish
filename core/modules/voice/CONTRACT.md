# Voice core adapter contract

The public ESM entry is `core/modules/voice/index.js`:

```js
import { createVoiceService, DEFAULT_VOICE_CONFIG, validateVoiceConfig,
  VOICE_LIMITS, speechToText, splitSpeechSentences } from './core/modules/voice/index.js'
const service = createVoiceService({ capture, recognition, conversation,
  synthesis, playback, ownership, audio, clock, ids, config })
```

The caller invokes `playback.unlock()` synchronously from the start button's
user gesture, then passes its result to `service.start(ref, { unlockResult,
selection })`. `start` never delays or fabricates this gesture result.

## Port shapes

- `clock`: `{ monoNow(): number, schedule(fn, delayMs): handle,
  cancel(handle): void }`. `ids.createId(kind): string`.
- `playback`: `inspect()`, `unlock()`, `play(clipRef,{operation,onStarted,
  onEnded,onError}) -> Promise<{ended?:boolean,stopped?:boolean}>`, `stop()`,
  `release()`. `unlock` is called by the composition root; the play promise
  must settle on natural end, active stop, or failure.
- `capture`: `inspect()`, `start({callRef,selection,onEvent,operation})`,
  `cut({startSample,endSample,operation}) -> clipRef` (ownership transfers to
  the core), optional `setTurnActive(boolean)`, `gate(boolean)`,
  `stop()`, `release()`. Events: `{type:'speech-start'|'speech-end'|'samples'
  |'error', sampleIndex, level?, error?}`; `samples` carries the newest absolute
  16 kHz sample index. Speech transitions use the same sample clock.
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
  follow the normalized DTOs in `voice-call-technical-v2.md` §5.1.
- `synthesis`: `inspect()`, `synthesize(text,voice,{operation}) -> clipRef`,
  `release(clipRef)`.
- `ownership`: `acquire({callRef,conversationRef})`, `renew()`, `release()`;
  acquire/renew return `{valid:boolean, scopeId?, leaseMs?}`. A revocation may
  be delivered to capture as `{type:'error', error:{code:'OWNERSHIP_LOST'}}`.

`createVoiceService` returns `start(ref,{unlockResult,selection,inputEnabled=true})`, `mute()`,
`unmute()`, `setOutputEnabled(enabled)`, `hangup({abandonPending=false,preservePlayback=false})`, `continueCall()`,
`retryInput(inputId)`, `editInput(inputId,text)`, `submitHeld(inputId)`,
`discardInput(inputId)`, `retryUnknown(inputId)` (only performs an evidence
check; it never resubmits), `replayReply(replyId)` (explicitly replays only a
recent successful local/autonomous reply under current call/output/input
gates), `getSnapshot()`, `subscribe(listener)`, and
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
ASR and drain work has ended. `dispose()` uses the default behavior and is
reserved for plugin unload.

Snapshots are serializable UI data only:

```js
{ call:{status,id,conversationRef}, capture:{status,muted},
  inputs:[{inputId,order,status,transcript,admission,localDisposition,clips:<count>,error}],
  replies:[{replyId,conversationTurnId,status,origin,replayable}],
  playback:{status,enabled,replyId}, queue:{unresolved,waiting}, error }
```

Audio refs and operation signals do not appear in snapshots. Budgets and held
inputs belong to the injected audio repository, so creating a new service does
not reset the repository's totals. `unknown` blocks automatic delivery and is
never resubmitted by a retry/check action.

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
