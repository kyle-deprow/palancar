# Continuous conversation mode refactor plan

## Summary

Replace the current gesture-bracketed turn pipeline with one session-scoped,
server-VAD-driven conversation stream. After `session.ready`, the client opens
the G2 microphone automatically and remains in a live conversation state until
the wearer pauses it, the session expires, or the app exits. There is no
push-to-talk mode and no per-utterance press fallback. The system includes
voice verification with voice pre-registration. The goal is for wearer turns
not to remain in accepted transcription or influence generation; a brief
provisional partial or a false negative remains possible, so engineering can
reduce, not eliminate, residual speaker-classification and verification error.

The key decisions are:

- Server VAD is the only speech-boundary authority. The hard duration limit is
  an explicit safety split, not a second user-controlled boundary.
- The audio path is fast path plus retro-correction: `Self` is masked
  immediately; `Other` and `Unknown` are forwarded immediately, while an
  on-device verifier runs in parallel. The two signals have different failure
  modes. If verification concludes that the wearer spoke, the relay invalidates
  that turn within roughly 500-1000 ms.
- Speaker verification uses a locally enrolled voice centroid. It is a
  privacy boundary and generation gate, not an identity proof; the chosen
  thresholds and residual error come from Phase 0 measurements.
- The wire protocol moves from one active utterance to one bounded,
  session-scoped audio stream. The relay assigns turn identities at VAD
  boundaries and emits ordered turn metadata.
- Transcription remains live for the current turn. Generation work is
  latest-context-wins rather than queued per utterance, and never blocks the
  next turn's transcription.
- Conversation context lives in relay memory for the lifetime of the session,
  is bounded by both turn count and text size, and is never persisted or sent
  to telemetry.
- The HUD keeps a same-turn suggestion stable for a short minimum dwell, but a
  newer turn invalidates that card immediately. The newest completed set is
  promoted when it is ready, subject to an explicit latency bound.
- Voice enrollment is a separate phone UX and biometric-data lifecycle. The
  centroid stays in encrypted app-private device storage and never leaves the
  phone.

This plan does not redesign authentication, pairing, or relay security. The
existing enrollment states remain authentication/pairing states; voice
enrollment is a separate biometric-data flow on the phone.

## Current-state analysis

`apps/g2-client/src/state/index.ts` is a pure reducer with a 1,902-line state
model. Its turn states are `Listening`, `Finalizing`, `Translating`, and
`Results`. `pressReduction` starts both the utterance and G2 audio from
`Ready`, then stops audio and commits the utterance on the next press. The
relay and client therefore have exactly one active utterance at a time.

The client runtime reflects that model:

- `apps/g2-client/src/bridge/runtime.ts:#receiveBridgeEvent` forwards every
  accepted Glasses PCM event while audio is open, checks explicit
  `AudioInputSource` values but also accepts a missing source, and ignores
  `speakerRole`. Audio is already available in the WebView as coalesced roughly
  60 ms frames: `packages/audio/src/pcm.ts:DEFAULT_PCM_COALESCING_TARGET_MS`,
  16 kHz mono signed 16-bit PCM (`PCM_SAMPLE_RATE_HZ`).
- `#runEffects` handles `start-utterance`, `start-audio`, `stop-audio`, and
  `commit-utterance`; translation and suggestion effects are only reducer
  bookkeeping because the relay performs the work.
- `#startAudio` and `#stopAudio` correctly serialize bridge microphone calls,
  but are currently tied to one `utteranceId` and one result-pipeline watchdog.
- Control events and display updates are serialized; PCM is copied and pushed
  synchronously in the bridge callback. Preserve that split and do not make the
  relay wait for generation before accepting the next turn.

`apps/g2-client/src/transport/index.ts` owns one `ActiveUtterance`, one
`ClientRetainedAudioQueue`, and one ordered audio identity. The queue and
`packages/audio/src/relay.ts` require contiguous per-utterance offsets and
reject frames from another utterance. This is unsuitable for server-owned
boundaries without either buffering boundary handoffs or changing the stream
identity.

`apps/relay/src/session.ts` likewise has one `#active` transcription record,
one `#finalToken`, one `#finalController`, and one
`#generationOperation`. `apps/relay/src/host.ts` has one `connection.audio`
record for the connection. The relay already validates a `serverVad` capability
and requests `CONFIGURED_SERVER_VAD = "enabled"`, but its protocol still waits
for the client's `utterance.commit`. The Azure adapter observes
`input_audio_buffer.speech_stopped` and queues a VAD commit internally; the
current relay does not use that event as the public turn boundary.

The current `handleTranscriptionEvent` suppresses partial transcript messages
and begins language gating and generation after one final event. Generation is
asynchronous, but cleanup and correlation are still single-turn. The current
`GenerationProviderCompletionInput` contains only `targetTranscript`, and
`packages/generation/src/azure-openai.ts` sends only that transcript to the
model.

`SuggestionsSchema` in `packages/contracts/src/schemas.ts` remains a two- or
three-item array. A single `suggestions.ready` event is stored in `ResultsState`
and selected with `suggestionIndex`; this is the one-shot behavior to remove.

`apps/g2-client/src/display/layouts.ts` defines six absolute text regions on a
576x288 monochrome HUD: `status`, `target`, `source`, `english`, `translated`,
and `hint`. There are six text containers, one event-capture target, and a
fixed brightness hierarchy with `translated` at full brightness. Runtime
updates use serialized `textContainerUpgrade` calls and a 175 ms debounce.

The repository currently pins `@evenrealities/even_hub_sdk` 0.0.14,
`@evenrealities/evenhub-cli` 0.1.14, and `@evenrealities/evenhub-simulator`
0.9.3. The installed SDK declares `AudioSpeakerRole.Self`, `Other`, and
`Unknown`, plus `AudioEvent.speakerRole` and `direction`. The role is explicitly
an app-algorithm result, not a firmware identity assertion.

## Design

### Segmentation and audio stream

Model inference itself is not the latency floor. A verifier can infer in
roughly 5-20 ms, but an embedding needs speech: about 250 ms is poor, 500 ms
moderate, 1 second good, and 2 seconds or more best. Audio arrives in roughly
60 ms coalesced frames
(`packages/audio/src/pcm.ts:DEFAULT_PCM_COALESCING_TARGET_MS`) at 16 kHz mono
S16 (`PCM_SAMPLE_RATE_HZ`), exactly the input format these models consume.

Considered and rejected: buffer-and-release. Holding every frame until the
speaker decision is available would add roughly 300-1000 ms to the `Other`
speaker's path, which is the path that matters for a usable live conversation.
It also makes ordinary turn latency depend on the slowest verification window.

Choose fast path plus retro-correction. On arrival, the SDK's `speakerRole` is
used at zero cost. `Self` is replaced immediately with same-duration silence;
`Other` and `Unknown` are forwarded immediately with no added latency. Missing
or malformed role metadata is normalized to `Unknown` and forwarded; a missing
or non-Glasses source is rejected or replaced with silence. In parallel, the
original PCM is consumed only by the on-device verifier. Silero
VAD gates verification on speech onset, a sliding roughly 1-second window
produces an embedding every roughly 250 ms, and cosine similarity is measured
against the enrolled centroid. Hysteresis and EMA smoothing prevent the
decision from flapping frame to frame. A positive wearer decision emits the
turn invalidation described below within roughly 500-1000 ms.

Common-case added latency is zero. The verifier is intended to prevent a
wearer turn from influencing generation, but a provisional partial can reach
ASR before retro-correction and a false negative can survive. The plan makes no
claim that wearer audio never touches a server: the accepted residual rate is
measured and bounded by the Phase 0 hardware gate and the owner's decision.

Use the existing relay/provider server VAD as the authoritative speech
boundary. The provider is already responsible for speech endpointing, understands the
resampled audio path, and exposes the VAD lifecycle in the existing Azure
adapter. Duplicating endpoint thresholds in the WebView would create two
competing boundaries and would make short pauses, barge-in, and device timing
harder to reason about.

The provider/transcription contract must promote VAD completion to a normalized
final event. Add an explicit VAD boundary reason to the normalized
transcription model rather than treating it as a manual commit or as an
abort. A hard per-segment duration limit remains necessary: the current
`MAX_UTTERANCE_MS`/`MAX_UTTERANCE_SAMPLES` limit becomes a segment limit, and a
long monologue is finalized at that limit and immediately continued as the
next turn. A duration split is a normal continuous-stream boundary, not a
user-visible failure.

The client opens one session-scoped stream after `session.ready`. The relay
accepts a session-scoped ordered audio sequence and feeds a provider
transcription session that can advance from one VAD item to the next without
requiring a client control message between items. At the first provider speech
item (or a final with no partial), the relay allocates the next immutable
`turnIndex`, `utteranceId`, and `segmentId` and emits that identity (a
`turn.started` event may have an empty transcript). It allocates the next
identity only after the prior item reaches a VAD or duration boundary.
`RelayIdGenerator` therefore needs an utterance-ID generator in addition to its
current session and error IDs. A partial or final for a bound identity may only
advance its revision. The relay, not the client, assigns the next index; a
lower/duplicate index is ignored (duplicate finals are immutable), a
higher/gapped index is rejected, and a changed utterance/segment identity is
rejected. The client never creates or rebinds a turn.

The protocol should be versioned rather than overloading the old
`utteranceId` field:

- Bump `PROTOCOL_VERSION` and add a strict `continuous` mode marker to the
  session negotiation. No v1 client is treated as an alternative mode.
- Replace client `utterance.start`, `utterance.commit`, and
  `utterance.cancel` as normal audio controls with a session-scoped audio
  stream. Keep `session.end` for app exit and terminal cleanup.
- Change the binary audio identity and ACKs from utterance-scoped offsets to
  stream-scoped sequence/offset values. The WebSocket session supplies the
  session identity; the relay maps stream ranges to VAD turns.
- Add session-level pause/resume controls for the privacy gesture. They stop
  or resume ambient capture and are never used to bracket an utterance.
- Add a monotonic, relay-owned `turnIndex` to transcript, language, translation,
  and suggestion messages. It is the context high-watermark; do not add a
  second `contextRevision` unless a later design gives it semantics that can
  differ from `turnIndex`.
- Add the client-to-relay `turn.invalidate` message for a positive local
  wearer-verification result. It is part of the atomic v2 contract, not an
  out-of-band control.
- Keep the existing bounded suggestion pair shape, correlated to `turnIndex`
  and the accepted final revision.

The old per-utterance controls and fields should be removed from the v2
client-facing contract, not left as dormant push-to-talk hooks. The atomic v2
wire phase must change every consumer together: `packages/contracts/src/audio.ts`
binary framing, `packages/contracts/src/auth.ts` path/subprotocol/version,
`packages/security-state` stores and tests, `packages/audio`, transcription
types, client transport, relay session, and relay host. Rebuild and redeploy
the relay before any v2 client is distributed.

Barge-in does not wait for translation or suggestions. A new speech start is
accepted while prior generation work is pending. If the provider emits a new
VAD item before prior generation completes, the prior item remains historical,
but its card is immediately stale and cannot be displayed over the newer turn.
Two other-party speakers overlapping in the same Glasses stream are intentionally
treated as one conversation partner; the product does not attempt diarization.
VAD configuration and interleaved/overlapping audio must be measured on
hardware.

### Turn invalidation protocol

The v2 client sends this strict JSON control message when local verification
crosses the calibrated wearer threshold:

```text
turn.invalidate {
  type: "turn.invalidate",
  sessionId: string,
  sessionEpoch: non-negative integer,
  turnIndex: non-negative integer,
  utteranceId: string,
  segmentId: string,
  reason: "speaker_verification_self",
  streamOffset: non-negative integer
}
```

The relay's corresponding event is:

```text
turn.invalidated {
  type: "turn.invalidated",
  sessionId: string,
  sessionEpoch: non-negative integer,
  turnIndex: non-negative integer,
  utteranceId: string,
  segmentId: string,
  status: "invalidated" | "already_invalidated"
}
```

`streamOffset` identifies the end of the locally observed audio range; no
embedding, centroid, similarity score, or raw PCM is sent. The client sends at
most one invalidation for an immutable turn and retries it idempotently until
the relay acknowledges it or the session ends.

The relay accepts the message only for the authenticated session and matching
turn identity. On first receipt it marks the turn invalid, aborts or
suppresses its provider transcription, discards the partial/final transcript
from relay memory, cancels generation when possible, removes the turn from
rolling context, and emits no translation or suggestion from it. The relay
returns a `turn.invalidated` acknowledgement/event so the client can clear
matching source, English, and suggestion state. It does not move the display
high-watermark backwards. Duplicate messages are harmless; an identity
conflict, stale session, or unknown identity is rejected, while a lower
historical turn is acknowledged as already invalidated only if its tombstone
exists.

If the turn already completed, the relay still marks it invalid, removes any
not-yet-published work, and sends `turn.invalidated` as a corrective event. A
previously published transcript or card cannot be unsent from a provider or a
display, but it is cleared client-side when current and is never reused for
generation or context. The relay does not log the transcript or biometric
decision. This bounded retro-correction window is why the latency target is
500-1000 ms and why Phase 0 must measure the residual error honestly.

### State machine

Keep the existing bootstrap and authentication states through `TargetSelection`
and pending `Ready` states. Replace the active turn states with the following
small set:

- `VoiceEnrollmentRequired`: no ambient stream may start without a valid local
  centroid; the phone enrollment flow is the only exit.
- `ConversationStarting`: session identity is established and the runtime is
  opening the continuous audio stream.
- `ConversationLive`: audio is armed. It retains only the current/in-flight
  turns, the visible and deferred suggestion cards, and monotonic high-water
  marks. The relay, not the client, owns conversation history.
- `ConversationPaused`: audio is closed by the wearer. A manual pause retains
  relay context for a bounded five-minute retention window; after that window
  the relay ends the session and a later press starts a new session.
- `Error`: existing terminal and recoverable cleanup behavior, with active
  conversation resources stopped as appropriate.

The client keeps one current turn, at most one in-flight generation turn, the
visible card, one deferred card, and high-water marks for `turnIndex` and
segment revision. A turn identity is immutable once first accepted. A final
may arrive without a partial and opens the turn itself. Lower or duplicate
revisions, stale session identities, identity rebinding, and unexplained index
gaps cannot modify the current display; late historical completions are
discarded.

The main transitions are:

1. A matching `session.ready` in pending `Ready` enters
   `ConversationStarting` and effects `start-audio-stream`. A named
   `audio.stream.started` event enters `ConversationLive`; an
   `audio.stream.start.failed` event enters recoverable `Error`, while a late
   completion is ignored unless its session identity still matches. There is
   no press transition into listening.
2. `turn.started` (which may have an empty transcript), or a first partial or
   final when no start event is available, binds the server turn identity. A
   newer partial updates source text immediately. A final is immutable and
   carries the relay's authoritative `turnIndex`; the relay then starts the
   next VAD item without a client commit effect.
3. A higher turn's `turn.started`, first partial, or final immediately
   invalidates the visible suggestion card and displays `Updating`; it does
   not wait for generation.
   `language.decision` marks the turn accepted or rejected. Rejection clears
   the stale card, updates a short status message, and does not stop capture.
4. `translation.ready` and `suggestions.ready` update only the matching
   immutable turn and accepted final revision. Only the newest eligible
   `turnIndex` can become visible; late lower turns are retained neither as
   cards nor as current English text.
5. A single press requests local mic stop and a relay `conversation.pause`.
   The relay finalizes an open VAD item with boundary reason `pause` before
   acknowledging `conversation.paused`; if the provider misses the pause
   deadline, it explicitly cancels that item and emits `turn.cancelled`. The
   client enters
   `ConversationPaused` only after both `audio.stream.stopped` and
   `conversation.paused`. `audio.stream.start.failed`,
   `audio.stream.stop.failed`, or `conversation.pause.failed` enters `Error`,
   with no automatic forwarding.
6. A press in `ConversationPaused` enters `ConversationStarting` and resumes
   only after a new `audio.stream.started` event. It never auto-opens merely
   because a recovered transport delivered `session.ready`. Swipes cycle only
   the current visible card. A root double press continues to request
   `shutDownPageContainer(1)`; cleanup waits for system or abnormal exit.
7. Transport loss stops the stream and discards unreplayable turn audio. If
   the prior state was live, fresh-session recovery starts a new continuous
   context; if it was paused, recovery preserves paused intent and does not
   open the microphone. Session expiry or the pause-retention deadline clears
   context and returns to pending `Ready`; the next press starts a new session.

Foreground/background recovery is new implementation work; the current G2
client does not already provide the continuous-stream recovery claimed here.

The reducer should be split into a small bootstrap/auth reducer and a
conversation reducer rather than extending the 1,902-line turn switch. Keep
the pure `{state, effects}` interface and deep validation, but remove
`pressReduction`'s `Ready -> Listening`, `Listening -> Finalizing`, and
`Results -> Listening` behavior. Remove the result-pipeline watchdog as a
single-turn concept. The relay owns the session-duration, inactivity, and
paused-retention timers and emits `session.expired`; the client owns mic
start/stop deadlines and the revision-tagged suggestion-dwell timer. Every
timer event carries its session/turn token, and all are cancelled on pause,
session loss, expiry, and cleanup.

On the relay, replace the singular `#active`/`#finalToken` generation model
with a stream record plus a bounded `Map` of in-flight turn work. Transcription event
delivery must stay ordered, while language classification and generation can
run asynchronously. The relay host's per-connection queue and
`drainAsyncEvents` remain the serialized outbound boundary. Each asynchronous
completion is tagged with its immutable turn and snapshot; a late completion is
discarded if its `turnIndex` is below the current high-water mark and is never
allowed to replace a newer visible result.

### Rolling context and generation overlap

Keep conversation context only in `apps/relay/src/session.ts`. Start with the
last 12 finalized eligible turns or 8,000 characters, whichever limit is
reached first, plus the current final turn. A forwarded `Other` or `Unknown`
turn is eligible only until a verification invalidation; an invalidated turn
is removed. Evict oldest entries FIFO at both limits. This is enough short-term
context for follow-up replies without making every prompt grow with a long
conversation. Do not persist it in the client,
relay durable state, browser storage, logs, or telemetry. Clear it on session
end, terminal transport loss, and the paused-session retention deadline.

The context entry should contain the bounded source transcript and its
`turnIndex`; it may contain a translation only when already available, but
generation must not wait for prior translations. Because role and verification
are probabilistic, the relay context is an ordered list of forwarded
transcripts, not a fabricated wearer/other dialogue. The current turn is marked
separately so the model knows what reply it is proposing; invalidation is the
only way to remove a false inclusion.

Extend `GenerationProviderCompletionInput` and the accepted-turn boundary with
an immutable context snapshot and `turnIndex`. Extend the Azure request
construction in `packages/generation/src/azure-openai.ts` so the JSON user
payload includes bounded context plus the current transcript. Preserve the
existing system-prompt rule that all conversation text is untrusted data, and
preserve the existing language and suggestion validation. The generation
provider output remains the existing English translation plus two or three
reply pairs.

Do not start a provider job for every final. Keep one in-flight completion and
one newest pending final; cancel the in-flight job when the pending final is
newer, then start only the newest still-current final. Authorize a job only
after this check. The existing security quota is six generations per minute
(`packages/security-state/src/types.ts:28`) and 60 per session; the scheduler
must never exceed those limits. When the quota is exhausted, keep
transcription live, show `Updating`, and do not queue work for later replay. A
provider that ignores cancellation still cannot publish a result below the
current `turnIndex`. Keep translation and suggestions in one provider request
for this lean refactor; split them only if the latency gate fails.

### Suggestion freshness and display policy

The first `turn.started`, partial, or final for a higher `turnIndex` invalidates
the visible suggestion immediately and changes `translated` to `Updating...`. A same-turn
card may use an initial two-second minimum dwell against harmless partial
updates, but dwell never keeps a stale card visible across turns. If generation
fails, is quota-limited, or misses the release deadline, leave `Updating...`
with no old reply; do not wait indefinitely.

When the newest eligible suggestion set arrives, promote it at the next
serialized display opportunity. Keep at most one deferred set and discard
older sets. A swipe cycles the currently visible set; it does not override the
stale-card rule. The invariant is that the visible card's `turnIndex` is never
lower than the latest accepted turn.

The dwell value is an initial UX constant, not a correctness guarantee. Its
cancellable timer is owned by the client scheduler and emits a
revision-tagged `suggestion.dwell.expired` event. The timer is cancelled on a
higher turn, pause, session loss, or cleanup, so promotion is deterministic
even when no later input arrives.

The initial release latency budget is p95 no more than 500 ms from provider
speech start to the first displayed partial and p95 no more than 2 seconds
from provider `speech_stopped` to the newest eligible suggestion card. A
candidate that misses either bound is not released until the provider path is
changed (for example, split translation and suggestions) or the owner accepts
a different product requirement.

### Speaker verification, role masking, and residual risk

Filter in `apps/g2-client/src/bridge/runtime.ts:#receiveBridgeEvent`, before
calling transport audio methods. Require `AudioInputSource.Glasses` explicitly
for the v2 stream and copy every `Uint8Array`. The fast path is:

- `Self`: forward same-duration silence immediately.
- `Other` or `Unknown`: forward the copied PCM immediately, with no added
  latency.
- Missing or malformed role metadata: normalize to `Unknown` and forward. A
  missing or non-Glasses source is fail closed to same-duration silence.

Do not concatenate only `Other` frames: the ordered audio protocol requires
contiguous offsets, and removing time would make server VAD see artificial
speech with no pauses. Zero-filling preserves the timeline. The relay treats
the stream as role-filtered input, not as an identity proof.

The verifier consumes the original copied PCM locally, before role masking, so
it can catch a wearer frame that the SDK labels `Other`. It retains only the
bounded sliding window needed for VAD and embedding, then clears that buffer;
raw PCM, embeddings, scores, and the centroid never enter relay messages,
logs, telemetry, browser sync, or durable server state. An explicit phone
source is not eligible for the v2 stream and is represented as silence or
rejected before transport.

#### On-device placement and models

Run verification in the phone's Even App WebView. The PCM is already present in
`apps/g2-client/src/bridge/runtime.ts` audio-event handling, so this adds no
network hop or privacy inversion. Use ONNX Runtime Web with WASM SIMD. iOS
WKWebView requires COOP/COEP for `SharedArrayBuffer` and worker threads; do
not assume those headers or capabilities, and budget for single-threaded SIMD.

Silero VAD (about 1 MB, sub-ms inference) gates embeddings on speech onset.
Candidate embedding models are small ECAPA-TDNN, ReDimNet-B0, and TitaNet-S
ONNX exports (roughly 5-25 MB). Resemblyzer is smaller but less accurate. The
model choice is a Phase 0 measurement, not a guess. Use a sliding roughly
1-second window and produce an embedding every roughly 250 ms. Smooth cosine
similarity to the enrolled centroid with EMA and hysteresis; the positive
decision must persist long enough to avoid frame-to-frame flapping.

If the phone cannot carry the selected model, relay-side verification is the
fallback, not the default. It requires sending verifier input to the relay,
adds phone-relay RTT to the correction path, and places raw voice and the
biometric comparison in the server privacy boundary. It must preserve the same
`turn.invalidate` behavior; it must not silently become buffer-and-release.
Before enabling it, resize the relay from its current 0.25 vCPU / 0.5 GiB in
`infra/environments/dev` and repeat the privacy and latency gate. On-device
placement avoids both the capacity change and this privacy cost.

#### Voice enrollment and biometric-data lifecycle

Voice verification requires a completed enrollment before continuous capture
can start. The phone UI provides a dedicated `Voice verification` setup:

1. Explain that a voice biometric is being created, where it will live, that
   it is not sent to Palancar's relay, and how to delete it; obtain explicit
   consent.
2. With the G2 connected, guide the owner through several prompted phrases
   totaling 10-30 seconds. Use the same glasses microphone and audio format as
   conversation; reject clips that fail speech or quality checks.
3. Compute embeddings on-device, average them into one owner centroid, discard
   the enrollment PCM and intermediate embeddings, and show the enrolled
   state. A model/calibration version is stored with the record so upgrades
   require deliberate re-enrollment.

Store the centroid in an encrypted, app-private phone record accessed through
the host storage boundary (`setLocalStorage`/`getLocalStorage`) with an
OS-secure key; never put it in relay storage, telemetry, logs, or an
unprotected sync backup. If the host storage path cannot provide encryption at
rest, use platform secure storage and block release until that requirement is
met. The enrolled record contains only the centroid, model/calibration
version, and lifecycle metadata; no raw enrollment audio is retained.

Thresholds are calibrated against a background cohort, not shipped as a
guessed universal constant. Phase 0 selects the thresholding procedure and
cohort, with AS-Norm score normalization for noisy rooms. The resulting
calibration is versioned with the local record and re-evaluated when the model
or audio path changes.

Re-enrollment records a new sample set and atomically replaces the old
centroid only after the new enrollment succeeds. `Reset voice verification`
deletes the centroid, calibration, and model-bound metadata from device
storage, clears in-memory buffers, and returns the app to `Enrollment required`;
it does not disable itself silently or upload a backup. A failed deletion is
reported as an error and is not presented as complete. The phone UI must
repeat this disclosure and provide the delete action because enrollment is a
new biometric-data privacy obligation, separate from pairing/authentication.

#### Decision required from the owner

The fast role path plus local verifier reduces exposure and prevents an
identified wearer turn from influencing generation, but it cannot prove zero
error. A wearer frame mislabeled `Other`, or a verifier decision that arrives
after publication, can still have reached transcription. A wearer reading a
displayed suggestion aloud is handled by both signals but remains a measured
residual failure mode. The product must describe this honestly.

The owner has chosen to build verification with voice pre-registration. The
remaining decision is the accepted residual error rate: Phase 0 must quantify
SDK `speakerRole` accuracy, candidate-model EER, false-`Other` duration, and
other-speaker recall in real rooms, including read-aloud, and the owner must
explicitly accept the resulting bound before release. No fixed error target is
assumed by this plan.

### Cost, battery, network, and backpressure

The G2 format is 16 kHz, signed 16-bit mono: 32,000 raw bytes per second,
about 1.92 MB/minute. A 30-minute maximum and five-minute inactivity timeout
are currently negotiated limits, not fully enforced end-to-end policies; this
refactor must add explicit relay/session enforcement before relying on them.
The numbers are an upper-bound shape, not a billing estimate. Provider ASR
processing and generation calls also increase with accepted incoming turns.

Controls, in order of safety and simplicity:

- Server VAD gates provider turn finalization and prevents generation during
  silence. The client role mask supplies silence for frames classified `Self`;
  the local Silero VAD only gates embedding work and does not establish a
  server turn boundary.
- The wearer can press once to pause the entire ambient stream. The status
  indicator changes before audio forwarding resumes. After the negotiated
  five-minute period with no eligible VAD speech, the relay ends the session
  and the client returns to `Ready`; a later press starts a new session. This
  is an ambient-session idle policy, not a push-to-talk fallback.
- Keep the existing negotiated session duration and per-segment duration
  limits, but make relay inactivity depend on eligible speech/VAD activity,
  not merely on zero-filled audio packets.
- Make the session-scoped audio queue bounded by the negotiated ACK and replay
  windows. Honor `audio.ack` flow state, stop adding network work when the
  relay asks for pause, and fail to a visible network-slow state rather than
  growing an unbounded PCM queue. Partial transcript events remain
  coalescible; final events and generation results are never silently dropped.
- Do not use client-side VAD as a second server boundary or drop samples. The
  Silero gate is only for local embedding efficiency. Any future bandwidth
  optimization must either send explicit silence-range records or retain
  contiguous timeline semantics; it must not drop samples through the current
  `RelayOrderedFrameAcceptor`.

Battery impact, BLE delivery timing, and actual eligible-Other duty cycle need
hardware measurement. Simulator audio is useful for deterministic plumbing but
does not establish these values.

### Privacy

The `status` region must continuously show a short state such as `MIC LIVE`,
`MIC PAUSED`, or `MIC ERROR`. The phone surface must expose the same state and
explain that live microphone audio classified for forwarding is sent to the
configured relay while the conversation is live. It must also show whether
voice verification is enrolled, link to re-enrollment/reset, and state that
the local centroid never leaves the device. Update the `g2-microphone`
manifest description to describe ambient capture and local verification rather
than capture during a user-started turn.

Press is the explicit pause/resume control. Root double press retains the
system exit confirmation through `shutDownPageContainer(1)`. On pause, audio
capture and forwarding stop; any open VAD item is finalized with boundary reason
`pause` (or explicitly cancelled after a provider deadline) before the pause
acknowledgement. On exit, the session ends and all
in-memory conversation context and turn text are cleared. A paused context has
a five-minute bounded retention window and is cleared when it expires.

The relay must not record raw PCM, role frames, transcript content, prompts, or
generated text in logs or telemetry. Provider retention must remain an
explicitly approved deployment property; use the existing transcription
capability/retention checks and fail closed when it is not known. The
session-scoped rolling context is memory-only and is cleared on every terminal
path, including transport loss and abnormal app exit.

### Display and gestures

Keep six text containers and the current absolute geometry. Do not add a list,
scrolling transcript, or image container for the first continuous design. Use
the regions as follows:

- `status`: `MIC LIVE`, `VERIFYING`, `Voice enrollment required`, `Updating`,
  `Paused`, or a short safe error.
- `target`: selected target language.
- `source`: newest incoming partial/final source text, truncated through the
  existing display-length helper.
- `english`: newest available English translation.
- `translated`: the visible suggested target-language reply, at full
  brightness; use `Updating...` when the current card is being replaced.
- `hint`: `Swipe replies · Press pause`, `Press resume`, or a similarly short
  action hint.

The source and English regions track the newest current turn. A higher turn's
`turn.started`, first partial, or final clears `translated` to `Updating...`; a same-turn partial
cannot churn an otherwise valid card. Preserve one event-capture target,
unique IDs/names, in-bounds rectangles, text limits, and serialized
`textContainerUpgrade` calls. Use rebuild only if the layout type changes;
ordinary conversation updates must remain text upgrades.

Swipes cycle the current visible suggestion set. A single press is no longer a
turn boundary; it pauses or resumes ambient capture. No press can create a
one-shot utterance. Double press remains root exit confirmation.

## Phased sequencing

No phase should expose both continuous and push-to-talk modes. Preparatory
work may be developed behind tests or an unreleased protocol version, but the
first user-facing client for the new contract is continuous-only.

### Phase 0: role and verification pass/fail feasibility gate (unreleased)

Measure both signals on physical G2 hardware in real rooms. Use scripted,
labeled windows for the owner speaking normally and reading a displayed
suggestion aloud, one other speaker, side-by-side seating, noise, overlap, and
a third speaker. Retain only labels, timing, and aggregate metrics; do not
retain conversation content or enrollment PCM.

For the SDK signal, record `speakerRole` confusion counts and duration,
`Unknown` runs, `direction` values, VAD boundaries, and role-mask timing.
Evaluate `direction` as metadata but do not depend on it for the decision. For
the verification signal, evaluate Silero VAD plus every candidate embedding
model at 250 ms, 500 ms, 1 second, and 2 seconds of speech. Measure EER,
false-accept wearer-as-Other duration, other-speaker recall, read-aloud
behavior, correction time, and CPU/memory cost with and without AS-Norm.

The initial feasibility gates are false-`Other` wearer-speech duration <=0.1%
in every labeled scenario and other-speaker recall >=95% in every scenario;
mixed wearer/other frames and overlap are scored separately, never averaged
away. Report verifier wearer misses, false invalidations of other speech,
transient partial exposure, p95 correction time, and CPU/memory cost alongside
the SDK role accuracy and other-speaker recall. Phase 0 outputs the selected
ONNX model, background cohort, AS-Norm and hysteresis procedure, calibrated
threshold, enrollment quality rules, and the measured residual-error curve.
Model selection and threshold calibration are measurement outputs, not guesses
or fixed constants. If either role/recall gate fails, no candidate threshold
meets the owner's bound, or read-aloud behavior is unacceptable, the result is
an explicit **no-go** and requirements must be revisited before any v2 client is
distributed. The deterministic protocol fixtures move to Phase 1 with the
actual contract; release remains blocked until the owner accepts the measured
residual bound.

### Phase 1: atomic v2 wire and all consumers (unreleased)

Land the entire v2 wire change in one phase. Change
`packages/contracts/src/schemas.ts`, `validation.ts`, constants, and
`packages/contracts/src/audio.ts` binary framing for continuous negotiation,
session-scoped offsets, pause/resume, `turn.started`/`turn.cancelled`/turn
metadata, strict high-watermark validation, and the
`turn.invalidate`/`turn.invalidated` schema.
Change
`packages/contracts/src/auth.ts` (`/v1/stream`, `palancar.v1`, and protocol
version), `packages/security-state` stores and tests, `packages/audio`, and
transcription types/session/Azure adapter. The relay must implement
idempotent invalidation for open, in-flight, and already-completed turns.

Change the client transport/runtime protocol boundary and relay `session.ts`,
`types.ts`, and `host.ts` in the same phase. Include deterministic v2
conformance, masking-to-VAD,
partial/final ordering, pause, quota, and replay tests. The relay must be
rebuilt and redeployed to an isolated preproduction path before any v2 client
ships; a contracts-only build is not a deployment and the protocol must reject
v1/v2 pairing.

### Phase 2: continuous client behavior (unreleased)

Refactor `apps/g2-client/src/state/index.ts` to the bootstrap plus
`VoiceEnrollmentRequired`/`ConversationStarting`/`ConversationLive`/
`ConversationPaused` model and remove
the old per-utterance effects. Add the enrollment-required state and the phone
`Voice verification` flow: prompted 10-30 second capture, on-device centroid
creation, encrypted local storage, re-enrollment, reset, deletion confirmation,
and no-network/no-telemetry handling. Update
`apps/g2-client/src/bridge/runtime.ts` for explicit Glasses-source role
masking, the raw-PCM local Silero/embedding pipeline, hysteresis, and
`turn.invalidate` emission when verification crosses its calibrated threshold
(the transport may already have carried provisional frames).
Use ONNX Runtime Web with the Phase 0 model and calibration, and exercise the
single-threaded iOS path.

Update microphone lifecycle events, pause/resume, and foreground recovery;
update `layouts.ts` for live/paused, updating, stale-card, and enrollment
status content. Deliberately retire the language gate for role-filtered source
partial display in this phase: partials are provisional source text only,
cannot start generation, and must be covered by the
`packages/language-registry` policy/test update.

Add the minimal phone live/paused/error indicator and ambient-capture copy in
`apps/g2-client/src/phone-ui.ts`/the application shell, and update
`apps/g2-client/app.json`'s microphone description. This phase uses the
already deployed v2 relay and is still an
unreleased development slice.

### Phase 3: rolling generation and freshness (unreleased)

Extend `packages/generation/src/types.ts`, `service.ts`, and
`azure-openai.ts` with bounded context snapshots keyed by `turnIndex`. Add
relay context eviction and the one-in-flight/one-pending latest-wins scheduler
that stays within the existing six-generations-per-minute and 60-per-session
limits. Update `suggestions.ready` composition only within the v2 fields landed
in Phase 1, and test late, cancelled, out-of-order, quota-exhausted, and failed
results.

Implement immediate stale-card invalidation, the revision-tagged dwell timer,
and the explicit speech-stop-to-card latency budget in the client. Phase 3
requires a relay rebuild/redeploy because relay code changes, but it does not
require another contracts migration unless a new wire field is proposed; any
such field restarts the atomic Phase 1 sequence.

### Phase 4: integrated validation and release gate

Run the fast workspace type checks and deterministic Vitest suites, then the
official simulator for startup, live/paused layouts, swipes, pause/resume,
and root exit. Use the simulator's 576x288 RGBA screenshots and console output
for semantic layout assertions, not for hardware claims.

QR-sideload the exact client build to physical G2 hardware and test audio
permissions, SDK role tagging, VAD boundaries, long monologues, barge-in,
read-aloud suggestions, BLE backpressure, Android background suspension,
recovery, battery, and provider latency. Package a private `.ehpk` only after
the hardware path passes. Record the installed SDK, CLI, simulator, Even App,
firmware, and hardware versions for the release. Release is blocked unless the
Phase 0 role/embedding measurements, the p95 partial/card latency budget, the
enrollment privacy/deletion checks, and the owner's explicit accepted residual
error bound all pass or are explicitly accepted.

All phases before this are unreleased development slices, not independently
shippable product releases. For any later schema or binary-frame change, repeat
the atomic sequence: rebuild `packages/contracts`, all client/relay/security
consumers, run relay tests, redeploy the relay, then ship the matching client.
Display-only, reducer-only, and context-builder-only changes can avoid a relay
redeploy only when they do not alter wire messages.

## Testing strategy

Favor virtual clocks, controlled promises, and explicit event injection. Do
not use sleeps to test VAD or generation ordering.

- In `apps/g2-client/test/state.test.ts`, test every transition above,
  monotonic revisions, unseen and final-only turns, immutable identities,
  stale-session rejection, latest-wins suggestions, stale-card clearing, the
  revision-tagged dwell timer (including an old timer token being ignored),
  pause/resume, transport recovery, retention expiry, and the absence of any
  press-to-talk transition. Inject the scheduler and clock; use generated
  event sequences only where they clarify that a lower `turnIndex` cannot
  replace a newer visible result.
- In bridge/runtime tests, inject `EvenHubEvent` values with each
  `AudioSpeakerRole`. Assert `Other` PCM is copied and forwarded, while
  `Unknown` is copied and forwarded immediately, and `Self` becomes
  equal-duration zero PCM. Missing or malformed roles normalize to `Unknown`
  and are forwarded; explicit phone or missing-source audio remains excluded.
  Feed original patterned PCM, including runs of `Self` and `Unknown`, through
  the deterministic VAD/embedding adapter and
  assert a positive decision emits one idempotent invalidation without waiting
  for transport, not just that buffers are masked.
- In enrollment tests, cover prompted 10-30 second capture, quality rejection,
  centroid averaging, encrypted local persistence, re-enrollment replacement,
  reset/deletion, no-network/no-telemetry behavior, and the refusal to enter
  `ConversationLive` without a valid local enrollment.
- In `packages/audio` and transport tests, cover session offsets, contiguous
  ACK/replay ranges, flow pause, bounded queues, zero-filled frames, binary
  limits, reconnect, and no unbounded growth. Update protocol replay and
  conformance fixtures for v2, the `turn.invalidate` schema and ACK, and
  assert v1 is rejected rather than silently downgraded.
- In `packages/transcription/test`, use a deterministic adapter whose VAD
  script emits speech starts, partial revisions, stops, duration splits, and
  overlapping provider callbacks. Assert normalized finals are ordered and
  carry the correct boundary reason.
- In `apps/relay/test/relay-core.test.ts`, use fake clocks, fake IDs, a
  controllable transcription adapter, and generation promises. Cover two
  turns arriving before the first generation completes, out-of-order
  completions, context snapshots/eviction, one-in-flight/one-pending
  scheduling, quota exhaustion, VAD finalization, long monologues, pause,
  pause-finalization deadlines and `turn.cancelled`, retention expiry,
  inactivity, provider failure, cleanup, and invalidation of
  open, in-flight, and already-completed turns. Assert invalidated turns never
  enter generation or rolling context and that duplicate invalidations are
  harmless.
- In `apps/relay/test/relay-host.test.ts`, exercise the actual WebSocket host
  queue, binary stream, ACK flow, async drain, v2 negotiation, and contract
  fixtures. Assert transcript partials are delivered without waiting
  for generation, invalidation corrections are delivered in order, and late
  generation results do not reorder protocol turn messages.
- In `apps/g2-client/test/display.test.ts`, retain the existing bounds,
  container count, unique-name, one-capture-target, brightness, and text-limit
  assertions. Add live/paused content, immediate stale-card clearing, dwell
  expiry, and semantic update assertions. Extend the existing Azure VAD
  harness for masking-to-endpoint and retro-correction cases; no separate
  evidence framework is needed. Run the workspace typecheck/test/build gates
  before packaging.

## Open gates

- The Phase 0 `speakerRole` accuracy, candidate-model EER, false-`Other`
  duration, recall, and correction-time measurements are release blockers, as
  is the owner's explicit acceptance of the resulting residual error rate.
- Enrollment must remain device-local, encrypted, absent from telemetry and
  relay traffic, and verifiably deletable before release.
- Hardware must confirm VAD endpoint behavior, mixed/overlap handling, read-aloud
  behavior, BLE timing, battery, and the p95 latency budget.
- The scheduler must stay within the existing six-generations-per-minute and
  60-per-session quotas; quota exhaustion must not stop transcription.
- Android foreground recovery, paused intent, and unreplayable-stream cleanup
  require physical-device validation; simulator success is insufficient.
