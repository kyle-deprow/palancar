# Continuous conversation mode refactor plan

## Summary

Replace the current gesture-bracketed turn pipeline with one session-scoped,
server-VAD-driven conversation stream. After `session.ready`, the client opens
the G2 microphone automatically and remains in a live conversation state until
the wearer pauses it, the session expires, or the app exits. There is no
push-to-talk mode and no per-utterance press fallback. This plan cannot promise
absolute wearer-voice exclusion: the SDK supplies a probabilistic role label,
not an identity proof.

The key decisions are:

- Server VAD is the only speech-boundary authority. The hard duration limit is
  an explicit safety split, not a second user-controlled boundary. Client audio
  processing is limited to speaker-role masking and transport flow control.
- `Self`, `Unknown`, missing, or invalid speaker-role frames are replaced with
  same-duration silence before they leave the client. Only frames labelled
  `Other` are forwarded; this is a measured probabilistic filter, not a
  guarantee that every forwarded frame belongs to someone else.
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

This plan does not redesign authentication, pairing, or relay security. The
existing enrollment states remain authentication/pairing states, not voice
enrollment states.

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
  `speakerRole`.
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
item (or a final with no partial), the relay binds an immutable `turnIndex`,
`utteranceId`, and `segmentId`; it binds the next identity only after the prior
item reaches a VAD or duration boundary. `RelayIdGenerator` therefore needs an
utterance-ID generator in addition to its current session and error IDs. A
partial or final for a bound identity may only advance its revision; a rebind,
duplicate final, lower index, or unexplained index gap is rejected or ignored
according to the protocol high-watermark rule.

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

### State machine

Keep the existing bootstrap and authentication states through `TargetSelection`
and pending `Ready` states. Replace the active turn states with the following
small set:

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
   `audio.stream.started` event enters `ConversationLive`; a failed start
   enters recoverable `Error`, while a late completion is ignored unless its
   session identity still matches. There is no press transition into listening.
2. The first valid partial or final binds the server turn identity. A newer
   partial updates source text immediately. A final is immutable and carries
   the relay's authoritative `turnIndex`; the relay then starts the next VAD
   item without a client commit effect.
3. A higher turn's first partial/final immediately invalidates the visible
   suggestion card and displays `Updating`; it does not wait for generation.
   `language.decision` marks the turn accepted or rejected. Rejection clears
   the stale card, updates a short status message, and does not stop capture.
4. `translation.ready` and `suggestions.ready` update only the matching
   immutable turn and accepted final revision. Only the newest eligible
   `turnIndex` can become visible; late lower turns are retained neither as
   cards nor as current English text.
5. A single press requests local mic stop and a relay `conversation.pause`.
   The relay finalizes or explicitly cancels any open VAD item before
   acknowledging `conversation.paused`; the client enters
   `ConversationPaused` only after the stop/ack result. A start/stop failure
   has a visible error and no automatic forwarding.
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

The reducer should be split into a small bootstrap/auth reducer and a
conversation reducer rather than extending the 1,902-line turn switch. Keep
the pure `{state, effects}` interface and deep validation, but remove
`pressReduction`'s `Ready -> Listening`, `Listening -> Finalizing`, and
`Results -> Listening` behavior. Remove the result-pipeline watchdog as a
single-turn concept. Use one session-health deadline and one revision-tagged
suggestion-dwell deadline; cancel both on pause, session loss, and cleanup.

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
last 12 finalized other-party turns or 8,000 characters, whichever limit is
reached first, plus the current final turn. Evict oldest entries FIFO at both
limits. This is enough short-term context for follow-up replies without making
every prompt grow with a long conversation. Do not persist it in the client,
relay durable state, browser storage, logs, or telemetry. Clear it on session
end, terminal transport loss, and the paused-session retention deadline.

The context entry should contain the bounded source transcript and its
`turnIndex`; it may contain a translation only when already available, but
generation must not wait for prior translations. Because the client applies a
probabilistic role mask, the relay context is an ordered list of transcripts
derived from frames classified as `Other`, not a fabricated wearer/other
dialogue. The current turn is marked separately so the model knows what reply
it is proposing; the residual false-`Other` risk remains.

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

The first partial or final for a higher `turnIndex` invalidates the visible
suggestion immediately and changes `translated` to `Updating...`. A same-turn
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

### Wearer-voice exclusion

Filter in `apps/g2-client/src/bridge/runtime.ts:#receiveBridgeEvent`, before
calling transport audio methods. Require `AudioInputSource.Glasses` explicitly
for the v2 stream and copy every `Uint8Array`. For a frame tagged `Other`,
forward the copied PCM. For `Self`, `Unknown`, missing, or invalid
`speakerRole`, forward a same-length zero-filled PCM buffer. Do not concatenate
only `Other` frames: the ordered audio protocol requires contiguous offsets, and
removing time would make server VAD see artificial speech with no pauses.
Zero-filling preserves the timeline and suppresses frames that are ambiguous
according to the SDK classifier; it does not prove that forwarded audio is not
the wearer's voice.

An explicit phone source or a missing source is not eligible for the v2 stream;
while capture is open, represent it as same-duration silence (or reject the
malformed event before it can reach transport) so the stream cannot silently
switch microphones.

This is a fail-closed policy. It accepts false negatives for the other party
as the cost of not forwarding ambiguous audio. It also means role masking by
itself does not reduce wire bytes; it provides classifier-conditioned
suppression and VAD silence, not bandwidth savings. The relay must treat the v2
stream as role-filtered input and must not claim an independent identity
decision.

No voice-registration/enrollment step is needed for this refactor. The
installed SDK already supplies per-frame role classification, and its public
contract has no voice-template registration API. Existing enrollment is for
pairing/authentication and must not be repurposed. Adding biometric capture,
storage, matching, and lifecycle would be redundant complexity and would add a
new privacy obligation without removing the SDK's algorithmic error. Do not
store a voice template; the independently validated mechanism in the owner
decision is a separate, larger project.

The residual risk is central and must be explicit: `speakerRole` is not an
identity assertion. A wearer frame mislabeled `Other` can still be transcribed.
A wearer reading a displayed suggestion aloud is blocked when tagged `Self` or
`Unknown`, but can still create a self-response loop when misclassified as
`Other`. No client-only policy can distinguish that frame after the
misclassification.

#### Decision required from the owner

The stated requirement that the wearer's voice is never transcribed cannot be
met absolutely with this SDK metadata. The owner must choose one honest option:

1. Accept a measured probabilistic bound: ship only if the Phase 0 gate meets
   the false-`Other` and other-speaker-recall thresholds below, and describe
   the residual read-aloud risk in product copy; or
2. Fund an independently validated speaker-identity/exclusion mechanism. That
   is substantially larger scope, requires new hardware/model validation, and
   creates a new biometric-data privacy obligation.

Until that decision and the measurements exist, this refactor is not a claim
of absolute wearer-voice exclusion.

### Cost, battery, network, and backpressure

The G2 format is 16 kHz, signed 16-bit mono: 32,000 raw bytes per second,
about 1.92 MB/minute. A 30-minute maximum and five-minute inactivity timeout
are currently negotiated limits, not fully enforced end-to-end policies; this
refactor must add explicit relay/session enforcement before relying on them.
The numbers are an upper-bound shape, not a billing estimate. Provider ASR
processing and generation calls also increase with accepted incoming turns.

Controls, in order of safety and simplicity:

- Server VAD gates provider turn finalization and prevents generation during
  silence. The client role mask supplies silence for frames classified as
  wearer or ambiguous; it does not establish speaker identity.
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
- Do not add client-side VAD as a second boundary. A future RMS gate may be
  evaluated only as a measured bandwidth optimization. It must either send
  explicit silence-range records or retain contiguous timeline semantics; it
  must not drop samples through the current `RelayOrderedFrameAcceptor`.

Battery impact, BLE delivery timing, and actual eligible-Other duty cycle need
hardware measurement. Simulator audio is useful for deterministic plumbing but
does not establish these values.

### Privacy

The `status` region must continuously show a short state such as `MIC LIVE`,
`MIC PAUSED`, or `MIC ERROR`. The phone surface must expose the same state and
explain that live microphone audio classified for forwarding is sent to the
configured relay while the conversation is live. Update the `g2-microphone`
manifest description to describe ambient capture rather than capture during a
user-started turn.

Press is the explicit pause/resume control. Root double press retains the
system exit confirmation through `shutDownPageContainer(1)`. On pause, audio
capture and forwarding stop; any open VAD item is finalized or explicitly
cancelled before the pause acknowledgement. On exit, the session ends and all
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

- `status`: `MIC LIVE`, `Updating`, `Paused`, or a short safe error.
- `target`: selected target language.
- `source`: newest incoming partial/final source text, truncated through the
  existing display-length helper.
- `english`: newest available English translation.
- `translated`: the visible suggested target-language reply, at full
  brightness; use `Updating...` when the current card is being replaced.
- `hint`: `Swipe replies · Press pause`, `Press resume`, or a similarly short
  action hint.

The source and English regions track the newest current turn. A higher turn's
first partial/final clears `translated` to `Updating...`; a same-turn partial
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

### Phase 0: role/VAD feasibility gate (unreleased)

Do only a small labeled hardware procedure and pure role-mask fixtures. Use
scripted speaker windows (wearer reading, one other speaker, side-by-side,
noise, overlap, and a third speaker) with no conversation content retained.
Record frame/duration confusion counts, longest `Unknown` runs, `direction`
values, VAD boundaries, and timing. Evaluate `direction` as metadata but do
not depend on it for the decision.

The proposed initial pass criteria are false-`Other` wearer-speech duration at
or below 0.1% in every scenario (including read-aloud) and at least 95% recall
of other-speaker speech in every labeled scenario, including noise,
side-by-side seating, and a third speaker. Mixed wearer/other frames and
overlap are scored separately, not averaged away. Failure is a no-go: stop before
the v2 client is distributed and return to the owner's requirement decision.
The procedure is metadata-only; deterministic protocol fixtures move to Phase
1 with the actual contract.

### Phase 1: atomic v2 wire and all consumers (unreleased)

Land the entire v2 wire change in one phase. Change
`packages/contracts/src/schemas.ts`, `validation.ts`, constants, and
`packages/contracts/src/audio.ts` binary framing for continuous negotiation,
session-scoped offsets, pause/resume, turn metadata, and strict high-watermark
validation. Change `packages/contracts/src/auth.ts` (`/v1/stream`,
`palancar.v1`, and protocol version), `packages/security-state` stores and
tests, `packages/audio`, and transcription types/session/Azure adapter.

Change the client transport/runtime protocol boundary and relay `session.ts`,
`types.ts`, and `host.ts` in the same phase. Include deterministic v2
conformance, masking-to-VAD,
partial/final ordering, pause, quota, and replay tests. The relay must be
rebuilt and redeployed to an isolated preproduction path before any v2 client
ships; a contracts-only build is not a deployment and the protocol must reject
v1/v2 pairing.

### Phase 2: continuous client behavior (unreleased)

Refactor `apps/g2-client/src/state/index.ts` to the bootstrap plus
`ConversationStarting`/`ConversationLive`/`ConversationPaused` model and remove
the old per-utterance effects. Update `apps/g2-client/src/bridge/runtime.ts`
for explicit Glasses-source role masking, microphone lifecycle events,
pause/resume, and foreground recovery. Update `layouts.ts` for live/paused,
updating, and stale-card content. Deliberately retire the language gate for
role-filtered source partial display in this phase: partials are provisional
source text only, cannot start generation, and must be covered by the
`packages/language-registry` policy/test update.

Add the minimal phone live/paused/error indicator and ambient-capture copy in
`phone-ui.ts`/the application shell, and update `app.json`'s microphone
description. This phase uses the already deployed v2 relay and is still an
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
Phase 0 false-`Other`/recall gate, the p95 partial/card latency budget, and the
owner's requirement decision all pass or are explicitly accepted.

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
  revision-tagged dwell timer, pause/resume, transport recovery, retention
  expiry, and the absence of any press-to-talk transition. Use generated event
  sequences only where they clarify that a lower `turnIndex` cannot replace a
  newer visible result.
- In bridge/runtime tests, inject `EvenHubEvent` values with each
  `AudioSpeakerRole`. Assert `Other` PCM is copied and forwarded, while
  `Self`, `Unknown`, missing, and malformed roles produce equal-duration zero
  PCM. Assert explicit phone or missing-source audio remains excluded and
  cleanup closes the mic. Feed patterned role/PCM sequences through the mask
  into the deterministic VAD adapter to test endpoint effects, not just buffers.
- In `packages/audio` and transport tests, cover session offsets, contiguous
  ACK/replay ranges, flow pause, bounded queues, zero-filled frames, binary
  limits, reconnect, and no unbounded growth. Update protocol replay and
  conformance fixtures for v2 and assert v1 is rejected rather than silently
  downgraded.
- In `packages/transcription/test`, use a deterministic adapter whose VAD
  script emits speech starts, partial revisions, stops, duration splits, and
  overlapping provider callbacks. Assert normalized finals are ordered and
  carry the correct boundary reason.
- In `apps/relay/test/relay-core.test.ts`, use fake clocks, fake IDs, a
  controllable transcription adapter, and generation promises. Cover two
  turns arriving before the first generation completes, out-of-order
  completions, context snapshots/eviction, one-in-flight/one-pending
  scheduling, quota exhaustion, VAD finalization, long monologues, pause,
  retention expiry, inactivity, provider failure, and cleanup.
- In `apps/relay/test/relay-host.test.ts`, exercise the actual WebSocket host
  queue, binary stream, ACK flow, async drain, v2 negotiation, and contract
  fixtures. Assert transcript partials are delivered without waiting
  for generation and that late generation results do not reorder protocol
  turn messages.
- In `apps/g2-client/test/display.test.ts`, retain the existing bounds,
  container count, unique-name, one-capture-target, brightness, and text-limit
  assertions. Add live/paused content, immediate stale-card clearing, dwell
  expiry, and semantic update assertions. Extend the existing Azure VAD
  harness for masking-to-endpoint cases; no separate evidence framework is
  needed. Run the workspace typecheck/test/build gates before packaging.

## Open gates

- The Phase 0 false-`Other`/recall gate and the owner's probabilistic-versus-
  identity decision are release blockers.
- Hardware must confirm VAD endpoint behavior, mixed/overlap handling, read-aloud
  behavior, BLE timing, battery, and the p95 latency budget.
- The scheduler must stay within the existing six-generations-per-minute and
  60-per-session quotas; quota exhaustion must not stop transcription.
- Android foreground recovery, paused intent, and unreplayable-stream cleanup
  require physical-device validation; simulator success is insufficient.
