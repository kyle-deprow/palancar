# Palancar real-time translation plan

Status: Initial product and architecture planning
Last updated: 2026-08-09

Accepted ADRs and this active plan are normative. Historical `.codex` handoff
documents are nonnormative working notes and cannot override an ADR or the
active plan.

## Product objective

Palancar is an Even Realities G2 application that helps an English-speaking wearer understand and respond during a conversation in another language.

The initial experience is:

1. The wearer launches Palancar and sees the restored target highlighted.
2. In TargetSelection, the prompt says “press to confirm, swipe to change”; an
   explicit press confirms Spanish or Turkish before session start.
3. Ready appears, and a press from the R1 ring or a configured glasses temple
   starts listening.
4. Palancar streams G2 microphone audio and displays the target-language transcription as it develops.
5. At the end of the utterance, Palancar displays the English translation.
6. Palancar generates two or three likely responses. Each response includes the English meaning and the phrase in the target language.
7. In Results, swipe cycles suggestions and press starts the next listening turn.

Palancar is a visual aid only in the initial version. The G2 has no speaker, so the wearer speaks the selected target-language response themselves.

## Decisions made

- Build the G2 client with TypeScript and Vite.
- Pin `@evenrealities/even_hub_sdk` to `0.0.12` for the initial implementation.
- Pin `@evenrealities/evenhub-cli` to `0.1.13` and use simulator `0.8.0`.
- Capture audio with the G2 microphone through `audioControl(true, AudioInputSource.Glasses)`.
- Use `gpt-4o-mini-transcribe-2025-12-15` as the first transcription model to benchmark.
- Use LiteLLM/OpenRouter for the combined English translation and contextual
  response completion. Azure generation is an optional future managed-identity
  mode, not a current deployment prerequisite.
- Use Terraform for all Azure infrastructure as code.
- Configure each session with an explicit wearer language and one selected target language. The first release supports an English wearer with either Spanish or Turkish selected (`wearerLanguage: en`, `targetLanguage: es | tr`).
- Send only accepted target-language turns into translation and response generation. Mixed-language turns are rejected in the first release until richer evidence is defined.
- Treat a useful target-language partial visible on physical G2 within 1.5 seconds p95 of speech onset as the initial realtime acceptance threshold.
- Keep Azure credentials and model access on the backend. No Azure secrets will be shipped in the G2 bundle.
- Connect the Even App WebView to the backend over HTTPS and a secure WebSocket.
- Keep the WebView-to-backend and selected transcription-provider connection
  warm for the listening session rather than reconnecting per utterance.
- Package the G2 application as an `.ehpk` for Even Hub distribution. Azure deployment is a separate backend deployment concern.

The transcription model choice is provisional. We will test its accuracy, latency, language coverage, and cost with real G2 microphone audio before treating it as a production decision.

## G2 platform contract

The Palancar application runs in the Even Realities App WebView on the phone. The glasses are a Bluetooth-connected display, microphone, and input peripheral; application JavaScript does not run on the glasses.

Relevant constraints:

- G2 microphone audio is 16 kHz, signed 16-bit little-endian PCM, mono.
- Audio arrives as variable-sized `Uint8Array` chunks through `audioEvent.audioPcm`.
- The client must tolerate arbitrary chunk boundaries and apply backpressure to network sends.
- The startup page must be created before opening the glasses microphone.
- `createStartUpPageContainer()` is called exactly once; subsequent changes use text upgrades or page rebuilds.
- The glasses display is 576×288, monochrome green with 16 intensity levels.
- A page supports at most 12 containers, with exactly one event-capturing text or list container.
- Frequent transcript changes should use `textContainerUpgrade()` to minimize flicker.
- Root-page double press invokes `shutDownPageContainer(1)` for system exit confirmation.
- Important state must survive Android WebView suspension and cold-launch recovery.

The application manifest will request only the permissions actually used. The initial expected permissions are `g2-microphone` and `network`, with the Azure backend origin included in the network whitelist.

## Proposed architecture

```text
R1 ring / G2 temple press
          |
          v
Palancar WebView + EvenAppBridge
  - controls G2 microphone
  - buffers PCM safely
  - renders glasses UI
          |
          | PCM16 over authenticated WSS
          v
Azure Palancar backend
  - session and connection control
  - audio backpressure and turn handling
  - persistent connection to the selected transcription provider when that provider supports sessions
  - transcript language gate
  - authentication and authorization
  - structured client protocol
          |
          +--> gpt-4o-mini-transcribe-2025-12-15
          |      - partial target-language transcript
          |      - final target-language utterance
          |
          +--> LiteLLM --> OpenRouter
                 - English translation
                 - 2-3 contextual responses
                 - English and target-language text for each response
```

The backend returns partial transcription events immediately. It sends the
accepted final transcript through LiteLLM/OpenRouter once the utterance is
finalized. The English translation should be emitted to the client as soon as
it is available, without waiting for all response suggestions. The provider
returns validated structured data rather than display-formatted prose.

## Initial interaction states

### Starting

- Initialize the Even bridge.
- Create the startup page.
- Restore the saved target only as the highlighted option, along with safe
  session preferences.
- Do not start a backend session or open the microphone.

### TargetSelection

- Display “press to confirm, swipe to change.” Swipe changes the highlighted
  Spanish/Turkish target; a swipe is not mandatory.
- Press explicitly confirms the highlighted target, then obtains a new-intent
  ticket, sends `session.start`, and enters Ready only after `session.ready`.

### Ready

- Display `Ready` and the selected target language.
- A configured single press starts listening.
- A root double press opens the system exit confirmation.

### Listening

- Open the G2 microphone and stream PCM to the active backend session.
- Display a stable listening indicator and partial target-language transcript.
- Treat the listening window as an expected other-speaker turn, while recognizing that the mono G2 microphone cannot identify speakers by itself.
- Show probable target-language partials, but do not trigger translation or response generation from provisional text.
- A single press can explicitly stop and finalize the utterance idempotently.
- The deployed transcription mode has exactly one automatic segment owner: server VAD or backend-controlled commits, never both concurrently.

### Translating

- Stop or pause microphone capture for the completed turn.
- Preserve and display the final target-language transcript.
- Request the English translation and response suggestions through
  LiteLLM/OpenRouter.
- Deliver the English translation before suggestions if the model response can be safely streamed or split without degrading correctness.
- Show a compact progress state without discarding the transcript.

### Results

- Show the English translation first.
- Show two or three response choices.
- Each choice contains concise English text and its target-language equivalent.
- Swipe cycles the two or three choices; press starts the next listening turn.

### Fresh-session reconnect or error

- Distinguish microphone permission, G2 connection, backend connection,
  transcription, and LiteLLM/OpenRouter failures.
- Keep error text short and actionable on the glasses.
- Retry only operations that are safe to repeat.
- After a disconnect, abort the active turn, clear retained PCM/transcript/results,
  cancel transcription and generation, obtain a new ticket with bounded jitter,
  and restore `Ready` only after a new `session.ready`. Never replay or
  regenerate interrupted work.

## Display strategy

The first UI should favor stable text regions rather than frequent full-page rebuilds:

- Header/status region: target language and state.
- Main region: partial or final target-language transcript.
- Translation region: English translation.
- Response region: the active suggested reply, with navigation indicating additional choices.
- One text container acts as the event-capture target.

Long content must be truncated, paged, or summarized to fit the G2 display. The final container layout and copy will be designed and simulator-tested after the interaction behavior is settled.

## Backend and Azure direction

The backend needs long-lived WebSocket support and low-latency streaming. The exact Azure compute service is not yet selected. Azure Container Apps and Azure App Service are candidates; the choice will be based on WebSocket behavior, scaling, cold-start latency, operations, and expected cost.

Expected Azure resources include:

- The selected Azure realtime transcription resource and deployment for
  `gpt-4o-mini-transcribe-2025-12-15`.
- A dedicated pre-created user-assigned identity for ACR image pull and a
  separate runtime identity for transcription and Table access. The current
  LiteLLM/OpenRouter generation path does not require an Azure generation
  deployment; a future Azure generation mode must use managed identity.
- A dedicated workload-state Storage account/module, separate from Terraform
  state, with shared-key access disabled, `SecurityState` and `RateState` Tables,
  and runtime Storage Table Data Contributor assigned before workload readiness.
- A managed daily expiry-cleanup Container Apps Job for both workload Tables.
- Key Vault only for secrets that cannot use identity-based access.
- Application Insights and Log Analytics for latency, error, and cost telemetry.
- Azure-provided HTTPS ingress suitable for the initial Even network whitelist;
  custom DNS is deferred.
- Resource-group budget and spending/anomaly alerts created before model
  deployments or the warm workload.

`local-mock` is limited to loopback tests with mock transcription/generation and
no paid endpoint. Any deployed or paid mode requires Azure Table-backed
`SecurityState` and `RateState`; Table unavailability fails closed with no
Azurite, in-memory, or other state fallback.

Infrastructure will be represented as Terraform. It will use pinned provider versions, a committed dependency lock file, reusable modules, environment-specific variables, remote state with locking and encryption, and reviewed `terraform plan` output before apply. Service-to-service access should use managed identity and least-privilege RBAC.

The initial infrastructure layout should follow this shape:

```text
infra/
├── modules/
│   ├── foundry/
│   ├── backend/
│   ├── identity/
│   ├── workload-state/
│   ├── expiry-cleanup-job/
│   ├── key-vault/
│   └── observability/
└── environments/
    └── dev/
```

Backend and model deployments must not depend on manual portal-only configuration that Terraform can safely represent. Any unavoidable manual subscription or quota prerequisite will be documented separately.

The foundation sequence is budget/alerts and observability; workload-state
account/Tables; ACR and separate identities; ACR/Table RBAC; Container Apps
environment and cleanup Job; then the selected transcription resources. The
LiteLLM/OpenRouter generation path is configured separately and does not require
an Azure generation deployment. The relay workload is not ready until both
Tables and runtime Table RBAC pass point-read and ETag update checks. Terraform
state storage remains separate.

Container Apps promotion uses two different duration tests. Active protocol-v1
sessions run to expected termination at 30 minutes, with no new turn at or after
29:30 and no unexplained close or audio gap; a heartbeat-only v1 session closes
at five minutes with `4408`. A separate 35-minute synthetic transport probe is
explicitly not a protocol-v1 session and is exempt from product inactivity and
session limits.

## Conceptual client/backend protocol

The protocol should be versioned and distinguish binary audio from JSON control/results.

Client to backend:

- Send exactly `session.start` first for new intent. It carries common
  `wearerLanguage`, explicitly confirmed `targetLanguage`, protocol/registry/
  client negotiation, and `gatePolicyVersion`; it never carries an earlier
  session/utterance identity or retained-audio offsets. The client does not
  choose mixed policy. Server protocol-v1 mixed policy is `reject`.
- Start an utterance.
- Send ordered binary PCM chunks with an absolute starting sample offset.
- Commit or cancel an utterance.
- End the session.

Backend to client:

- `session.ready` or `session.rejected`; ready may lower negotiable limits but
  never advertise above hard v1 maxima.
- Partial target-language transcript.
- Final target-language transcript.
- `language.decision` with detected language, confidence, and exactly `target`,
  `mixed`, `english`, `supported_unselected`, `unsupported`, or `uncertain`.
- English translation ready.
- Structured response suggestions ready.
- Recoverable or terminal error.
- Flow-control or backpressure instruction if required.
- Highest contiguous audio sample offset accepted by the backend.

Sequence numbers, absolute sample offsets, and utterance IDs will prevent late
events from a previous turn from overwriting the current display and make
accepted-audio gaps observable. The retained queue is only for flow control and
exact duplicate safety within one live connection. Reconnection never continues
an interrupted turn: the client aborts it, clears PCM/transcript/results, cancels
transcription and generation, obtains a new one-time ticket, creates a new
session with an advanced epoch, and waits for the new `session.ready` before
returning to `Ready`.

Before HTTP 101, authentication/audience/replay, origin, rate-limit, conflict,
and state-outage failures use generic HTTP `401`, `403`, `409`, `429`, or `503`
responses; custom `44xx` codes are post-upgrade only unless an explicit
first-message fallback is later approved. Source-IP limits use a compute-host
adapter that trusts only tested platform-controlled peer/forwarded address data,
never an arbitrary client `X-Forwarded-For` chain, and is revalidated per host.

## Audio chunking and transcription cadence

There are three distinct boundaries in the audio path. They must not be conflated:

1. A G2 SDK callback chunk is whatever byte range the host delivers in one `audioEvent`.
2. A transport frame is the amount of PCM Palancar chooses to send in one WebSocket message.
3. An utterance segment is a committed unit that the transcription service turns into text.

### G2 callback chunks

The G2 SDK supplies 16 kHz, mono, signed 16-bit little-endian PCM in variable-sized `Uint8Array` chunks. Hardware callback sizes are not a protocol guarantee. The simulator currently emits approximately 100 ms, or 3,200 bytes, per event, but production code must not depend on that size.

The WebView will copy each received slice when necessary, preserve byte order, and append it to a bounded audio queue. Because each sample is two bytes, the queue must preserve an incomplete trailing byte until its pair arrives rather than corrupting sample alignment.

### WebView-to-backend frames

Raw G2 callback chunks may be too small or irregular to send efficiently. The client should forward available audio promptly and must not add a 100 ms batching delay when the host already supplies a usable chunk. The initial target is 40–80 ms per binary WebSocket frame when callback cadence permits, with a 100 ms hard flush ceiling:

- 40 ms at 16 kHz is 640 samples or 1,280 bytes.
- 80 ms at 16 kHz is 1,280 samples or 2,560 bytes.
- 100 ms at 16 kHz is 1,600 samples or 3,200 bytes.

Splitting a callback after it arrives cannot recover time already spent waiting for that callback, so physical G2 measurements—not the simulator's approximate 100 ms cadence—determine the achievable capture floor. Smaller frames increase overhead; larger frames add buffering latency and make voice activity detection less responsive.

The client/backend WebSocket carries PCM as binary rather than base64. Session, utterance, format, and control information is sent in JSON control messages. WebSocket delivery is ordered, while explicit sequence numbers provide diagnostics and stale-turn protection.

The client queue must be bounded by audio duration, initially 500 ms. If that limit is exceeded, Palancar aborts the active utterance and surfaces a recoverable error. It must not silently drop audio or pause capture while presenting the resulting transcript as complete.

Separately, the relay enforces durable `RateState` audio authorization through
reservation grants of up to 8,000 original 16 kHz samples per
installation/session/turn. Grant capacity refills at 16,000 original samples
per second but never exceeds 8,000 reserved samples. The relay consumes the grant locally; exact
duplicates within the live connection do not consume it, and unused grant
capacity is never refunded. Renewal must durably succeed with an ETag before
provider forwarding beyond the current grant. State outage creates or renews
no grant and fails closed. This is not the 8,000-sample unacknowledged limit.

Disconnect cleanup has independent owners. The client stops capture and clears
local PCM, transcript, translation, suggestions, and pending results. Relay
socket close independently aborts transcription and generation providers and
releases unstarted execution claims. Reconnect is fresh-session only and is
limited per installation in a rolling recovery window.

### Backend normalization and Azure Realtime append events

The candidate Azure Realtime transcription contract requires PCM16 at 24 kHz,
mono, little-endian. For that adapter, G2's 16 kHz audio passes through a
stateful streaming resampler; resampling each callback independently would
create boundary artifacts. Resampler state continues across all frames in the
active utterance. A fallback provider such as Azure Speech can advertise native
16 kHz input and bypass this normalization.

The Azure Realtime adapter keeps one resampler state per active utterance and
flushes/resets it only at a confirmed utterance boundary. At 24 kHz, its
initial transport targets contain:

- 40 ms: 960 samples or 1,920 bytes.
- 80 ms: 1,920 samples or 3,840 bytes.
- 100 ms: 2,400 samples or 4,800 bytes.

The backend base64-encodes each normalized frame and sends an Azure realtime `input_audio_buffer.append` event immediately. Base64 expands a 4,800-byte frame to approximately 6,400 characters. Azure accepts much larger append events, but smaller streaming appends improve responsiveness.

Conceptually:

```text
G2 event chunks (variable, 16 kHz)
        |
        v
bounded client accumulator
        |
        | prompt binary frames, normally 40–100 ms
        v
Palancar backend WebSocket
        |
        v
stateful 16 kHz -> 24 kHz resampler
        |
        | stateful 24 kHz PCM frames
        v
base64 input_audio_buffer.append events
        |
        v
transcription delta/completed events
```

### Append versus commit

An `append` adds audio to Azure's temporary input buffer. A `commit` closes buffered audio as a segment. The existence of a transcription `delta` event does not prove that the selected deployment recognizes audio before commit; a delta may only stream text after a committed item begins processing.

The deployment spike therefore chooses exactly one production segmentation mode:

1. Preferred streaming mode: if useful deltas arrive before commit, append continuously, use server VAD as the sole automatic finalizer, and use an explicit Stop as an idempotent finalization command. Do not make periodic commits.
2. Commit-gated fallback experiment: if deltas begin only after commit, disable server VAD and benchmark backend-controlled commits at 600, 800, and 1,000 ms. Stitch completed segments by Azure item/event identity plus normalized prefix/suffix matching. Reject this mode if it misses latency or accuracy gates.
3. Service fallback: if neither mode passes, benchmark Azure Speech continuous recognition rather than hiding a multi-second delay behind smaller transport frames.

A three-second periodic commit is not a realtime strategy and is removed from the proposed production path. Short periodic commits are an experiment only because they can split words, lose linguistic context, duplicate boundaries, and cause visible revision rollback.

The backend consumes `conversation.item.input_audio_transcription.delta` events as provisional revisions and `conversation.item.input_audio_transcription.completed` as authoritative text. It forwards stable segment IDs and monotonically increasing revision numbers. A final event can replace provisional content but an older revision can never overwrite a newer display state.

The G2 client schedules transcript updates at most every 150–200 ms with a single latest-wins pending value. Display operations remain serialized, but obsolete queued revisions are replaced rather than delivered token-by-token over the BLE-bound bridge.

## Adversarial review outcome and latency budget

The Sol adversarial review found that the earlier plan could not credibly meet a near-realtime goal: its three-second commit ceiling alone violated the target, and VAD/manual commit ownership was ambiguous. The corrected architecture treats pre-commit delta behavior as a go/no-go deployment fact rather than inferring it from event names.

Initial p95 budget, measured from speech onset to useful target-language text visible on physical G2:

| Stage | Target | Warning/fail threshold | Measurement |
|---|---:|---:|---|
| Enough acoustic evidence for first lexical output | 350 ms | 450 ms | fixture speech onset to model-eligible audio duration |
| Client accumulation | 60 ms | 100 ms | G2 callback receipt to WebSocket send |
| Client to backend | 50 ms | 100 ms | client send to backend receive |
| Resample, queue, and Azure Realtime append | 20 ms | 40 ms | backend receive to upstream send |
| Recognition to useful delta | 450 ms | 550 ms | eligible upstream audio to usable delta |
| Backend and client relay | 40 ms | 60 ms | Azure event receive to WebView receipt |
| Coalescing, bridge, and BLE display | 160 ms | 200 ms | WebView receipt to visible physical display |
| **End-to-end** | **1.13 s** | **1.50 s** | fixture/voice onset to physical G2 visibility |

The final target-language transcript must also appear p95 within 1.2 seconds after explicit Stop or detected speech end. Translation and suggestions have separate timers so transcription performance cannot conceal downstream model latency.

## Required realtime deployment spike

Before the full backend is built, create a timestamped harness against the Terraform-provisioned development deployment:

1. Append five seconds of uninterrupted 16 kHz speech without manual commit and
   emit a metadata-only JSONL entry for every append, VAD, delta, completed, and
   error event.
2. Repeat with server VAD as the sole automatic finalizer.
3. Repeat with server VAD disabled and manual commits at 600, 800, 1,000, and 3,000 ms.
4. Use at least 30 trials per candidate cell only as exploration, including word and phrase boundaries that cross commit points.
5. Stream physical-G2 speech for English, Spanish, Turkish, mixed speech,
   silence, agreed accents, and noise conditions; do not select a provider from
   clean uploaded fixtures alone.
6. Forward live revisions in memory through the actual WebView, bridge, and
   physical G2 display path with synchronized speech-onset, backend-event,
   WebView-receipt, and visible-display timestamps.
7. Run confirmatory testing of the winning mode with at least 200 end-to-end trials per language/mode for p95 latency and a reported two-sided 95% confidence interval.
8. Size language-gate cells using one-sided 95% exact-binomial lower bounds. For example, at least 150 English turns per selected-target configuration with zero false accepts are required to support a 98% rejection target; observed failures require larger samples and recalculated bounds.

Realtime-spike JSONL and every persisted spike/evidence report are metadata-only.
Allowed fields are event type, timestamp, opaque IDs, byte/sample/token counts,
status, configuration/model versions, latency, and aggregate accuracy/gate
results. PCM, transcript text, translation text, suggestions, prompts/responses,
and provider payload bodies are categorically excluded. Physical-G2 test speech
is streamed and scored in memory, then discarded without creating recordings or
audio evidence artifacts. Persistable audio fixtures must be generated synthetic
non-conversation fixtures, explicitly distinct from physical/user speech.

The mini-transcribe path passes only if either useful pre-commit text or a 600–800 ms commit mode produces text on continuous speech before 1.5 seconds p95, final text arrives within 1.2 seconds p95 of speech end, no words are missing or duplicated, revisions never roll backward, short segmentation causes no more than 10% relative accuracy degradation versus whole-utterance transcription, and the one-sided gate confidence bounds pass independently for Spanish and Turkish configurations. Failure of latency, finalization, accuracy, boundary stability, or gate false-accept criteria triggers the same harness against Azure Speech continuous recognition.

## Target-language gate

The microphone produces one mono conversation stream; G2 does not provide separate wearer and conversation-partner channels. A ring or temple press establishes intent—"listen to the other person now"—but it does not prove speaker identity or language. The backend therefore applies a language gate to finalized transcript segments before translation or response generation.

Each transcription segment carries data equivalent to:

```json
{
  "utteranceId": "...",
  "revision": 4,
  "text": "...",
  "detectedLanguage": "es",
  "languageConfidence": 0.93,
  "languageStatus": "target",
  "isFinal": true
}
```

The gate is driven by a versioned target-language registry rather than Spanish- or Turkish-specific branches in core code. Each registry entry defines its language code, display label, transcription hint candidate, language-identification thresholds, mixed-language policy, and fixture suites. The initial gate policy is:

- A final segment matching the session's selected target language with sufficient confidence is accepted and sent to translation and response generation.
- A final English-only segment is rejected from downstream model processing. The UI returns to `Waiting for Spanish` or `Waiting for Turkish`, based on session configuration.
- A final segment in the other enabled target returns `supported_unselected` and
  is rejected. Selecting Turkish must not accept Spanish turns, and selecting
  Spanish must not accept Turkish turns.
- An uncertain segment is held until finalization or additional context; it cannot generate suggested responses.
- A mixed English/target-language segment is rejected from generation in the first release because a single language label cannot prove how much selected-target content it contains. Future acceptance requires calibrated per-language span/probability evidence and symmetric Spanish/Turkish fixtures.
- Provisional probable-target-language text may be displayed for realtime
  feedback, but only the authoritative final gate decision can invoke
  LiteLLM/OpenRouter.
- Raw audio is streamed to transcription because language cannot be reliably known before recognition. The gate controls downstream text and model calls; it does not pretend to filter the microphone signal itself.

Confidence thresholds are versioned server configuration per target language rather than client constants. An initial `0.80` value is only a benchmark candidate for each language. If the selected transcription API does not return reliable language metadata, the backend will use a small language-identification component on finalized text and measure false-accept and false-reject rates separately for Spanish and Turkish. Model prompting or a configured source-language hint can bias recognition toward the selected language, but it is not treated as an enforcement boundary. The spike compares automatic-language transcription against `es`- and `tr`-hinted sessions because a hard hint could incorrectly transform or accept English speech.

Language-gate acceptance criteria for the English/Spanish and English/Turkish prototype:

- For each target-language configuration, at least 98% of English-only fixture turns are prevented from reaching translation and suggestion generation.
- At least 95% of Spanish fixtures are accepted when Spanish is selected, and at least 95% of Turkish fixtures are accepted when Turkish is selected, across the agreed accents and noise conditions.
- At least 95% of fixtures with `supported_unselected` decisions are prevented
  from reaching translation and suggestion generation.
- Mixed-language turns are deterministically rejected from generation in the first release.
- No provisional revision triggers a LiteLLM/OpenRouter request.
- Every downstream request records the utterance ID, final transcript revision,
  detected language, confidence when available, and gate-policy version without
  logging audio or conversation content in any deployed sink.

## LiteLLM/OpenRouter result contract

The initial LiteLLM/OpenRouter response should contain data equivalent to:

```json
{
  "sourceLanguage": "es",
  "sourceTranscript": "...",
  "englishTranslation": "...",
  "responses": [
    {
      "english": "...",
      "targetLanguage": "..."
    }
  ]
}
```

The backend will validate this structure, limit response count to three, constrain phrase length for the G2 display, and reject malformed model output. The exact schema will be versioned when implementation begins.

For interactive latency, LiteLLM/OpenRouter should initially use a small output
budget and the configured low-latency model. We will measure quality before
changing model or reasoning settings.

## Cost baseline

Current public list-price planning estimates, excluding backend compute and
LiteLLM/OpenRouter usage:

- `gpt-4o-mini-transcribe`: approximately $0.003 per audio minute or $0.18 per audio hour.
- `gpt-4o-transcribe`: approximately $0.006 per audio minute or $0.36 per audio hour.
- Azure Speech S1 real-time transcription: approximately $1.00 per audio hour in East US.

The mini-transcribe estimate is token-based and must be validated against actual Azure billing. We will record audio duration, billed input tokens, utterance count, and transcription latency during the prototype.

## Security and privacy requirements

- Never put provider keys, deployment credentials, or reusable Azure access
  tokens in the WebView bundle.
- Authenticate the Palancar client to the backend before accepting audio.
- Use TLS for all production HTTP and WebSocket traffic.
- Prefer managed identity between the backend and Azure AI services.
- Never persist raw audio, transcripts, translations, suggestions, prompts, or
  model context in any deployed mode.
- Prohibit conversation content in every log level, trace, exception,
  diagnostic/evidence sink, and crash report; deployed debug settings cannot
  enable request/response bodies.
- Keep explicitly labeled synthetic non-conversation fixtures separate from all
  deployed telemetry and evidence paths.
- Add abuse controls, request limits, session-duration limits, and cost budgets.
- Treat spoken content as potentially sensitive user data.

Generation authorization is durable `RateState` state, not an in-process guard.
Only an accepted `target` final can create a row. Immediately before one
LiteLLM/OpenRouter provider call, the relay takes one atomic ETag claim keyed by
session epoch, utterance, accepted revision, target, gate-policy version, and
transcript hash. Duplicate finals reuse the existing consumed claim and make no
second call; non-target finals create no claim. The opening lease is 10 seconds,
provider start consumes it permanently, the active lease is 35 seconds, and a
20-second heartbeat renews it. Lease expiry releases an unstarted or active
execution lease but never refunds or retries a consumed call. The row records
the model-attempt and turn counters.

## Validation strategy

### Automated client tests

- State transitions for Starting, TargetSelection, Ready, Listening,
  Translating, Results, and errors, including explicit confirmation before
  session start or microphone access.
- Event routing for ring and both glasses temples.
- Audio chunk handling, ordering, copying, and backpressure.
- Display container count, bounds, identifiers, text limits, and event capture.
- Stale-result protection using session and utterance IDs.
- Root double-press exit behavior.

### Simulator tests

- Boot readiness marker and initial display.
- Start/stop input flow.
- Partial transcript and result rendering with mocked backend events.
- Screenshot-based layout assertions.
- Console checks for SDK validation failures and uncaught errors.

### Azure integration tests

- Verify active protocol-v1 termination at 30 minutes with no new turn at or
  after 29:30, heartbeat-only v1 `4408` closure at five minutes, and the separate
  exempt 35-minute non-protocol transport probe.
- Stream generated synthetic non-conversation 16 kHz PCM fixtures through the
  real backend.
- Measure first-partial, final-transcript, translation, and total-result latency.
- Verify structured LiteLLM/OpenRouter output and malformed-output recovery.
- Verify exact `english`, `target`, `supported_unselected`, `mixed`,
  `unsupported`, and `uncertain` decisions before LiteLLM/OpenRouter invocation.
- Assert that no provisional transcript revision can trigger translation or suggestions.
- Track token usage and estimated cost per audio hour.

### Physical G2 tests

- Microphone permission and audio quality.
- Ring and left/right temple event behavior.
- Background suspension and foreground recovery.
- BLE timing, display flicker, font fit, and long-text behavior.
- In-memory physical speech trials across accents, noise levels, and target
  languages; discard speech immediately after scoring without recordings or
  audio evidence artifacts.
- Packaged `.ehpk` behavior in private and beta testing.

Simulator success alone is not release evidence.

## Proposed delivery phases

1. Use the completed Phase 0 development decisions for cloud preflight,
   operator pairing, retention, start/stop, TargetSelection, Results, and
   duration limits; production CIAM/CI/DNS/private networking remain deferred.
2. Build the language registry/gate, then freeze protocol limits, authentication ticket transport, acknowledgements, fresh-session reconnect, and backpressure behavior.
3. In parallel, build the loopback-only mocked G2 client and relay, the Terraform dev foundation, and metadata-only transcription evidence tooling against the frozen contracts.
4. Push an immutable relay image and deploy a provisional compute candidate; run the compute-host ADR before promotion. In parallel, run exploratory and statistically sized transcription spikes using in-memory physical-G2 speech that is discarded after scoring.
5. Record the selected compute host and transcription provider, or test App Service/Azure Speech fallbacks when a candidate fails.
6. Integrate the selected transcription adapter into the authenticated end-to-end G2/relay slice with partial/final display updates and language gating.
7. Integrate LiteLLM/OpenRouter translation and structured response suggestions,
   delivering translation independently when possible.
8. Validate with physical G2/R1 hardware across English, Spanish, and Turkish and collect metadata-only latency, accuracy, gate, and cost evidence.
9. Harden already-present authentication, privacy, observability, recovery, packaging, deployment, and operations controls.

## Phase 0 product decisions

- Every app session enters TargetSelection between Starting and Ready, restoring
  the last Spanish/Turkish choice only as highlighted. The wording is “press to
  confirm, swipe to change”; no swipe is mandatory, and press confirmation
  precedes session start and microphone access.
- A Ready-state single press starts listening and a Listening-state single press commits. Server VAD may finalize automatically, but it is the only automatic segment owner when enabled.
- The same normalized ring/temple press behavior drives both languages. Root double press remains reserved for system exit.
- In Results, swipe cycles the two or three suggestions and press begins the next listening turn.
- Conversation context is memory-only within the 30-minute session. Palancar persists no audio, transcripts, translations, suggestions, or cross-session history.
- Utterances are limited to 30 seconds and user inactivity to 5 minutes.
- East US 2 in the Visual Studio Enterprise Subscription is the development region. Terraform plans must set explicit model capacity and budget thresholds.

Operator pairing, local Azure CLI apply identity, Azure-provided ingress,
cloud/model preflight, product limits, and retention are complete for the
development foundation. Production CIAM, CI federation, custom DNS, and private
networking are deferred. Physical origin/subprotocol/IndexedDB evidence is the
Phase 4 pre-real-audio entry gate and does not block Terraform foundation or
authenticated synthetic implementation.

Detailed protocol, authentication, retention, and compute decisions are in ADRs 0001, 0003, 0004, and 0005 and `docs/phase-0-decisions.md`.

## Remaining measured decisions

- ADR 0002 must select mini-transcribe or Azure Speech from physical Spanish and Turkish latency, accuracy, boundary, and gate evidence.
- The English translation and suggestion p95 targets will be frozen after the
  first LiteLLM/OpenRouter integration benchmark rather than guessed before
  measurement.
- Initial responses prioritize concise, polite, contextually likely phrases. Tone presets remain deferred.
- Custom DNS, private networking, and CI federation remain optional until their owning repository/zone and operational need are known.

## Immediate next implementation

Freeze `packages/contracts` from ADR 0001, implement the authenticated synthetic relay/client boundary, and provision the Terraform development foundation. Do not send real conversation audio or treat mini-transcribe as selected until the authentication/privacy/compute gates and ADR 0002 evidence pass.
