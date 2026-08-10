# Palancar real-time translation plan

Status: Initial product and architecture planning
Last updated: 2026-08-09

## Product objective

Palancar is an Even Realities G2 application that helps an English-speaking wearer understand and respond during a conversation in another language.

The initial experience is:

1. The wearer launches Palancar and sees that it is ready.
2. A press from the R1 ring or a configured glasses temple starts listening.
3. Palancar streams G2 microphone audio and displays the target-language transcription as it develops.
4. At the end of the utterance, Palancar displays the English translation.
5. Palancar generates two or three likely responses. Each response includes the English meaning and the phrase in the target language.
6. The wearer can review and select or cycle through the suggested responses using G2/R1 input.

Palancar is a visual aid only in the initial version. The G2 has no speaker, so the wearer speaks the selected target-language response themselves.

## Decisions made

- Build the G2 client with TypeScript and Vite.
- Pin `@evenrealities/even_hub_sdk` to `0.0.12` for the initial implementation.
- Pin `@evenrealities/evenhub-cli` to `0.1.13` and use simulator `0.8.0`.
- Capture audio with the G2 microphone through `audioControl(true, AudioInputSource.Glasses)`.
- Use `gpt-4o-mini-transcribe-2025-12-15` as the first transcription model to benchmark.
- Use the planned Azure AI Foundry `gpt-5.6-luna` deployment for English translation and contextual response suggestions.
- Use Terraform for all Azure infrastructure as code.
- Configure each session with an explicit wearer language and one selected target language. The first release supports an English wearer with either Spanish or Turkish selected (`wearerLanguage: en`, `targetLanguage: es | tr`).
- Send only accepted target-language turns into translation and response generation. Mixed-language turns are rejected in the first release until richer evidence is defined.
- Treat a useful target-language partial visible on physical G2 within 1.5 seconds p95 of speech onset as the initial realtime acceptance threshold.
- Keep Azure credentials and model access on the backend. No Azure secrets will be shipped in the G2 bundle.
- Connect the Even App WebView to the backend over HTTPS and a secure WebSocket.
- Keep the WebView-to-backend and backend-to-Foundry WebSockets warm for the listening session rather than reconnecting per utterance.
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
          +--> gpt-5.6-luna
                 - English translation
                 - 2-3 contextual responses
                 - English and target-language text for each response
```

The backend returns partial transcription events immediately. It sends the final transcript to Luna once the utterance is finalized. The English translation should be emitted to the client as soon as it is available, without waiting for all response suggestions. Luna returns validated structured data rather than display-formatted prose.

## Initial interaction states

### Starting

- Initialize the Even bridge.
- Create the startup page.
- Restore saved target language and safe session preferences.
- Connect to the Palancar backend.

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
- Request the English translation and response suggestions from Luna.
- Deliver the English translation before suggestions if the model response can be safely streamed or split without degrading correctness.
- Show a compact progress state without discarding the transcript.

### Results

- Show the English translation first.
- Show two or three response choices.
- Each choice contains concise English text and its target-language equivalent.
- Input behavior for selecting, expanding, cycling, or starting the next listening turn remains to be finalized.

### Recovering or error

- Distinguish microphone permission, G2 connection, backend connection, transcription, and Luna failures.
- Keep error text short and actionable on the glasses.
- Retry only operations that are safe to repeat.
- Restore a usable Ready state whenever possible.

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

- A Foundry/OpenAI resource with `gpt-4o-mini-transcribe-2025-12-15` and `gpt-5.6-luna` deployments.
- A dedicated pre-created user-assigned identity for ACR image pull and a separate runtime identity for Foundry access. Application code is configured to request only the runtime identity.
- Key Vault only for secrets that cannot use identity-based access.
- Application Insights and Log Analytics for latency, error, and cost telemetry.
- A custom HTTPS domain or stable Azure endpoint suitable for the Even network whitelist.

Infrastructure will be represented as Terraform. It will use pinned provider versions, a committed dependency lock file, reusable modules, environment-specific variables, remote state with locking and encryption, and reviewed `terraform plan` output before apply. Service-to-service access should use managed identity and least-privilege RBAC.

The initial infrastructure layout should follow this shape:

```text
infra/
├── modules/
│   ├── foundry/
│   ├── backend/
│   ├── identity/
│   ├── key-vault/
│   └── observability/
└── environments/
    └── dev/
```

Backend and model deployments must not depend on manual portal-only configuration that Terraform can safely represent. Any unavoidable manual subscription or quota prerequisite will be documented separately.

## Conceptual client/backend protocol

The protocol should be versioned and distinguish binary audio from JSON control/results.

Client to backend:

- Start a session with target-language and client metadata.
- Include `wearerLanguage`, `targetLanguage`, and the configured mixed-language policy in session metadata.
- Start an utterance.
- Send ordered binary PCM chunks with an absolute starting sample offset.
- Commit or cancel an utterance.
- End the session.

Backend to client:

- Session ready or rejected.
- Partial target-language transcript.
- Final target-language transcript.
- Language-gate decision with detected language, confidence, and accepted/rejected/mixed status.
- English translation ready.
- Structured response suggestions ready.
- Recoverable or terminal error.
- Flow-control or backpressure instruction if required.
- Highest contiguous audio sample offset accepted by the backend.

Sequence numbers, absolute sample offsets, and utterance IDs will prevent late events from a previous turn from overwriting the current display and make accepted-audio gaps observable. Reconnection does not silently resume an utterance: the backend either confirms a resumable accepted offset or aborts that utterance and requires a visible restart.

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

### Backend normalization and Foundry append events

The candidate Foundry Realtime transcription contract requires PCM16 at 24 kHz, mono, little-endian. For that adapter, G2's 16 kHz audio passes through a stateful streaming resampler; resampling each callback independently would create boundary artifacts. Resampler state continues across all frames in the active utterance. A fallback provider such as Azure Speech can advertise native 16 kHz input and bypass this normalization.

The Foundry Realtime adapter keeps one resampler state per active utterance and flushes/resets it only at a confirmed utterance boundary. At 24 kHz, its initial transport targets contain:

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
| Resample, queue, and Foundry append | 20 ms | 40 ms | backend receive to upstream send |
| Recognition to useful delta | 450 ms | 550 ms | eligible upstream audio to usable delta |
| Backend and client relay | 40 ms | 60 ms | Azure event receive to WebView receipt |
| Coalescing, bridge, and BLE display | 160 ms | 200 ms | WebView receipt to visible physical display |
| **End-to-end** | **1.13 s** | **1.50 s** | fixture/voice onset to physical G2 visibility |

The final target-language transcript must also appear p95 within 1.2 seconds after explicit Stop or detected speech end. Translation and suggestions have separate timers so transcription performance cannot conceal downstream model latency.

## Required realtime deployment spike

Before the full backend is built, create a timestamped harness against the Terraform-provisioned development deployment:

1. Append five seconds of uninterrupted 16 kHz speech without manual commit and record every append, VAD, delta, completed, and error event.
2. Repeat with server VAD as the sole automatic finalizer.
3. Repeat with server VAD disabled and manual commits at 600, 800, 1,000, and 3,000 ms.
4. Use at least 30 trials per candidate cell only as exploration, including word and phrase boundaries that cross commit points.
5. Include physical-G2 microphone recordings for English, Spanish, Turkish, mixed speech, silence, agreed accents, and noise conditions; do not select a provider from clean uploaded fixtures alone.
6. Replay captured revisions through the actual WebView, bridge, and physical G2 display path with synchronized speech-onset, backend-event, WebView-receipt, and visible-display timestamps.
7. Run confirmatory testing of the winning mode with at least 200 end-to-end trials per language/mode for p95 latency and a reported two-sided 95% confidence interval.
8. Size language-gate cells using one-sided 95% exact-binomial lower bounds. For example, at least 150 English turns per selected-target configuration with zero false accepts are required to support a 98% rejection target; observed failures require larger samples and recalculated bounds.

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
- A final segment in the other supported but unselected target language is rejected. Selecting Turkish must not accept Spanish turns, and selecting Spanish must not accept Turkish turns.
- An uncertain segment is held until finalization or additional context; it cannot generate suggested responses.
- A mixed English/target-language segment is rejected from generation in the first release because a single language label cannot prove how much selected-target content it contains. Future acceptance requires calibrated per-language span/probability evidence and symmetric Spanish/Turkish fixtures.
- Provisional probable-target-language text may be displayed for realtime feedback, but only the authoritative final gate decision can invoke Luna.
- Raw audio is streamed to transcription because language cannot be reliably known before recognition. The gate controls downstream text and model calls; it does not pretend to filter the microphone signal itself.

Confidence thresholds are versioned server configuration per target language rather than client constants. An initial `0.80` value is only a benchmark candidate for each language. If the selected transcription API does not return reliable language metadata, the backend will use a small language-identification component on finalized text and measure false-accept and false-reject rates separately for Spanish and Turkish. Model prompting or a configured source-language hint can bias recognition toward the selected language, but it is not treated as an enforcement boundary. The spike compares automatic-language transcription against `es`- and `tr`-hinted sessions because a hard hint could incorrectly transform or accept English speech.

Language-gate acceptance criteria for the English/Spanish and English/Turkish prototype:

- For each target-language configuration, at least 98% of English-only fixture turns are prevented from reaching translation and suggestion generation.
- At least 95% of Spanish fixtures are accepted when Spanish is selected, and at least 95% of Turkish fixtures are accepted when Turkish is selected, across the agreed accents and noise conditions.
- At least 95% of fixtures in the supported but unselected target language are prevented from reaching translation and suggestion generation.
- Mixed-language turns are deterministically rejected from generation in the first release.
- No provisional revision triggers a Luna request.
- Every downstream request records the utterance ID, final transcript revision, detected language, confidence when available, and gate-policy version without logging raw audio.

## Luna result contract

The initial Luna response should contain data equivalent to:

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

For interactive latency, Luna should initially use standard mode with little or no reasoning and a small output budget. We will measure quality before increasing reasoning effort.

## Cost baseline

Current public list-price planning estimates, excluding backend compute and Luna usage:

- `gpt-4o-mini-transcribe`: approximately $0.003 per audio minute or $0.18 per audio hour.
- `gpt-4o-transcribe`: approximately $0.006 per audio minute or $0.36 per audio hour.
- Azure Speech S1 real-time transcription: approximately $1.00 per audio hour in East US.

The mini-transcribe estimate is token-based and must be validated against actual Azure billing. We will record audio duration, billed input tokens, utterance count, and transcription latency during the prototype.

## Security and privacy requirements

- Never put Foundry keys, deployment credentials, or reusable Azure access tokens in the WebView bundle.
- Authenticate the Palancar client to the backend before accepting audio.
- Use TLS for all production HTTP and WebSocket traffic.
- Prefer managed identity between the backend and Azure AI services.
- Do not persist raw audio by default.
- Define explicit retention behavior for transcripts, translations, and telemetry.
- Avoid logging raw audio or complete conversations in normal application logs.
- Add abuse controls, request limits, session-duration limits, and cost budgets.
- Treat spoken content as potentially sensitive user data.

## Validation strategy

### Automated client tests

- State transitions for ready, listening, translating, results, and errors.
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

- Stream recorded 16 kHz PCM fixtures through the real backend.
- Measure first-partial, final-transcript, translation, and total-result latency.
- Verify structured Luna output and malformed-output recovery.
- Verify English-only rejection, selected Spanish/Turkish acceptance, unselected-language rejection, mixed-language policy, and uncertain-language handling before Luna invocation.
- Assert that no provisional transcript revision can trigger translation or suggestions.
- Track token usage and estimated cost per audio hour.

### Physical G2 tests

- Microphone permission and audio quality.
- Ring and left/right temple event behavior.
- Background suspension and foreground recovery.
- BLE timing, display flicker, font fit, and long-text behavior.
- Real conversations across accents, noise levels, and target languages.
- Packaged `.ehpk` behavior in private and beta testing.

Simulator success alone is not release evidence.

## Proposed delivery phases

1. Settle Phase 0 cloud, authentication, retention, start/stop, target-selection, and duration decisions.
2. Build the language registry/gate, then freeze protocol limits, authentication ticket transport, acknowledgements, recovery, and backpressure behavior.
3. In parallel, build the mocked G2 client, relay skeleton, Terraform dev foundation, and transcription/replay evidence tooling against the frozen contracts.
4. Push an immutable relay image and deploy a provisional compute candidate; run the compute-host ADR before promotion. In parallel, run exploratory and statistically sized transcription spikes using physical-G2 audio.
5. Record the selected compute host and transcription provider, or test App Service/Azure Speech fallbacks when a candidate fails.
6. Integrate the selected transcription adapter into the authenticated end-to-end G2/relay slice with partial/final display updates and language gating.
7. Integrate Luna translation and structured response suggestions, delivering translation independently when possible.
8. Validate with physical G2/R1 hardware across English, Spanish, and Turkish and collect latency, accuracy, gate, and cost evidence.
9. Harden already-present authentication, privacy, observability, recovery, packaging, deployment, and operations controls.

## Open product questions

- Is the target language selected before listening, remembered between sessions, or detected automatically?
- Should silence detection finalize automatically, or should a second press always be required?
- Which input starts listening: any single press, ring only, or a configurable source?
- How should the wearer browse and select the suggested responses?
- Should Palancar preserve conversational context across turns, and for how long?
- Is transcript or conversation history stored at all?
- What maximum listening duration and inactivity timeout should apply?
- What p95 latency target should apply to the English translation and response suggestions after final transcription?
- Are the suggested responses optimized for literal accuracy, politeness, brevity, or selectable tones?
- Which Azure region, subscription, resource group, environment names, and budget limits should be used?

## Immediate next decision

Provision the minimal Terraform-managed development deployment and run the required realtime transcription spike. In parallel, choose the first target language and settle the start/stop interaction so the fixture set and G2 state machine can be finalized. Do not build the production transcription relay around mini-transcribe until the spike proves its emission behavior and physical-display latency.
