# Palancar runtime efficiency implementation plan

## Objective

Remove the avoidable latency, paid inference, network, and idle-compute costs
identified by the 2026-08-13 adversarial review while preserving the reviewed
G2 SDK 0.0.12 lifecycle and protocol safety boundaries.

The implementation is complete only when the real hot path has one paid
generation request per accepted target turn, final transcript/language events
are not held behind generation, stale requests are cancelled, microphone stop
does not delay commit, audio callbacks are coalesced and ACKs are paced, the
runtime can scale to zero when inactive, and every implemented provider mode is
configuration-consistent and tested.

## Guardrails

- Luna implements only the bounded slices below with explicit file ownership.
- Sol reviews every meaningful slice. No slice is committed until Sol reports
  `READY` after any required fix loop.
- The parent agent owns integration tests, Terraform plans/applies, Azure
  mutations, secret handling, and commits.
- Never expose `.env`, provider keys, Key Vault values, tickets, transcript
  content, or raw audio to a subagent or logs.
- Preserve SDK `0.0.12`, one startup-page creation, typed audio events,
  serialized display updates, system-confirmed exit, and cleanup behavior.
- Do not claim physical-G2 latency or release readiness without hardware
  evidence.
- Do not enable a paid endpoint before authenticated ticket issuance and
  persisted rate enforcement are connected or an explicitly isolated smoke
  configuration is used.

## Slice 1: one-call cancellable generation with staged delivery

Owned files:

- `packages/generation/src/types.ts`
- `packages/generation/src/service.ts`
- `packages/generation/src/mock.ts`
- `packages/generation/src/litellm.ts`
- `packages/generation/src/index.ts`
- `packages/generation/test/**`
- `apps/relay/src/session.ts`
- `apps/relay/src/types.ts`
- `apps/relay/src/host.ts`
- `apps/relay/src/testing.ts`
- `apps/relay/test/**`

Requirements:

- Atomically replace `translate()` and `suggest()` with this private-package
  contract; do not retain compatibility wrappers:

  ```ts
  interface GenerationProvider {
    readonly id: string;
    readonly version: string;
    complete(
      input: GenerationProviderCompletionInput,
      context: { readonly signal: AbortSignal }
    ): Promise<GenerationProviderCompletion>;
  }

  interface GenerationProviderCompletion {
    readonly englishTranslation: string;
    readonly suggestions:
      | readonly [SuggestionPhrasePair, SuggestionPhrasePair]
      | readonly [SuggestionPhrasePair, SuggestionPhrasePair, SuggestionPhrasePair];
  }
  ```

- `GenerationService.complete()` returns one validated `GenerationCompletion`
  containing the provider fields plus the accepted-turn correlation metadata.
- The LiteLLM request uses one strict JSON schema, no retry/fallback, a bounded
  output budget of `max_tokens: 384`, concise schema limits (English translation
  at most 256 characters and each bilingual phrase field at most 160
  characters), `maxResponseBytes: 8192`, and an external
  `AbortSignal` combined with the provider timeout. Do not implement generation
  streaming in this slice.
- Each completion key owns one internal `AbortController`. Duplicate callers
  receive the same promise; every supplied signal is attached to the shared
  controller, and aborting any caller aborts the logical turn. A pre-aborted
  signal prevents a provider call. All signal listeners and map entries are
  removed when the promise settles. LiteLLM cancellation aborts `fetch` and
  cancels any response body.
- The completion key contains session ID, epoch, utterance ID, segment ID,
  accepted final revision, selected target language, gate-policy version, and
  target transcript. Signals are tracked by identity so the same signal never
  receives duplicate listeners. Tests prove strict shared-promise identity and
  exactly one provider abort.
- Replace the transcription-only queue/wakeup with one bounded discriminated
  `RelayAsyncEvent` queue owned by `RelaySessionCore`:

  ```ts
  type RelayAsyncEvent =
    | { kind: 'transcription'; event: NormalizedTranscriptionEvent }
    | { kind: 'generation.completed'; token: FinalProcessingToken; result: GenerationCompletion }
    | { kind: 'generation.failed'; token: FinalProcessingToken };
  ```

- The core appends before invoking one `onAsyncEventsAvailable` callback.
  Remove `withWakeup()`. Rename `drainTranscriptionEvents()` to
  `drainAsyncEvents()` and drain with a head index/batch rather than
  `Array.shift()`. Queue capacity is 64. Keep only the newest queued partial for
  the same utterance/segment. Partials may be evicted to admit finals or
  generation results. Finals and generation results are never silently
  dropped. If a non-partial still cannot be admitted, set one terminal-overflow
  flag, abort pending generation, wake the host, and emit one content-free
  `state_unavailable` server error followed by close `1011/server_error` on the
  next drain. Tests cover partial flooding, final admission at capacity, and
  generation completion at capacity.
- Host uses a per-connection `drainScheduled` flag, serializes draining and
  delivery through `connection.queue`, clears the flag after draining, then
  calls `core.hasPendingAsyncEvents()` and reschedules when events arrived
  during the drain. No polling and no lost wakeups. Tests inject one event while
  a drain is scheduled and another during socket delivery.
- On a valid final, close transcription immediately but keep the protocol turn
  active while generation is pending. Store the generation token/controller
  separately. A new utterance remains a conflict until completion/failure.
- `handleTranscriptionEvent(final)` resolves with exactly `transcript.final`
  and `language.decision` while a deferred provider promise is still pending.
  Successful completion later emits `translation.ready` followed by
  `suggestions.ready`. Combined output is all-or-nothing: malformed suggestions
  emit neither generated event.
- Intentional abort emits no `provider_unavailable`. Provider failure emits one
  content-free recoverable error only if the token is still current. Evidence
  records one `complete` operation and distinguishes cancellation from provider
  failure without content.
- Cancellation, connection close, session end, and terminal errors abort the
  controller before queued events are cleared. A late settlement must never
  enqueue or emit output. The serialized protocol does not support replacing
  an active turn; replacement semantics are out of scope.
- Translation and suggestions remain separate protocol events, emitted in that
  order from the single provider result.
- Tests assert one accepted target final equals exactly one provider/upstream
  request; non-target and pre-cancelled turns equal zero. Host tests defer
  completion and prove final/language delivery precedes generated delivery.

Verification:

```text
npm run typecheck -w @palancar/generation
npm test -w @palancar/generation
npm run typecheck -w @palancar/relay
npm test -w @palancar/relay
```

## Slice 2: immediate G2 commit without lifecycle regression

Owned files:

- `apps/g2-client/src/bridge/runtime.ts`
- `apps/g2-client/test/bridge.test.ts`

Requirements:

- For the paired `stop-audio` + `commit-utterance` end-of-turn effects, execute
  exactly: (1) synchronously set `#audioPcmEnabled = false`; (2) call
  `transport.commitUtterance()` so it owns queue flush and commit transmission;
  (3) start `audioControl(false)` asynchronously; (4) attach a tracked
  rejection/timeout handler without delaying the event tail. If commit throws,
  microphone shutdown must still begin in a `finally` path before fatal cleanup.
- Paired-effect detection requires matching `sessionId`, `sessionEpoch`, and
  `utteranceId`; unrelated standalone stop effects keep their awaited behavior.
- Store the detached close monitor and guard it with the close generation. Route
  `false`, rejection, or timeout through `#queueSerializedEvent` so fatal
  handling occurs exactly once. Attach rejection handling immediately; clear
  monitor and timer references on every path. Settlement after cleanup or a
  superseding generation cannot mutate runtime state.
- Preserve existing awaited stop behavior for standalone shutdown, abort, and
  recovery effects.
- Never clear `#pendingAudioClose` merely because of timeout or cleanup
  preemption. Cleanup and later microphone open adopt/wait for the same promise.
  A second SDK close may start only after the first settles `false` or rejects;
  a new open never starts while close is unresolved; a late successful close
  updates state normally.
- Timeout still triggers fatal handling and bounded cleanup failure, but never
  an overlapping `audioControl(false)` call.
- Do not permit post-commit audio, overlapping open/close, leaked promises, or
  premature cleanup before root exit confirmation.
- Tests cover close success, `false`, rejection, and timeout after exactly one
  commit, plus adoption of unresolved close work.

Verification:

```text
npm run typecheck -w @palancar/g2-client
npm test -w @palancar/g2-client
```

## Slice 3: PCM coalescing, paced ACKs, and copy reduction

Owned files:

- `packages/audio/src/pcm.ts`
- `packages/audio/src/client-queue.ts`
- `packages/audio/src/relay.ts`
- `packages/audio/src/resampler.ts`
- `packages/audio/test/audio.test.ts`
- `apps/g2-client/src/transport/index.ts`
- `apps/g2-client/test/transport.test.ts`
- ACK-specific portions of `apps/relay/src/session.ts`
- ACK-specific portions of `apps/relay/test/relay-core.test.ts`

Requirements:

- Coalesce arbitrary SDK callbacks into a configurable target frame duration;
  initial target is 60 ms / 1,920 bytes at 16 kHz S16LE mono and never exceeds
  negotiated maximum payload bytes.
- The effective target is the largest even byte count no greater than 1,920,
  the negotiated payload maximum, or the negotiated replay/backpressure sample
  limits. The framer owns callback bytes immediately and buffers complete
  samples until that target.
- Pending complete samples count against utterance, replay, and unacknowledged
  limits before queue mutation. Failed pushes are atomic, and captured and
  encoded high-water offsets are tracked separately.
- Commit flush emits every remaining complete sample before the commit control
  message. An odd trailing byte sends its even prefix, visibly cancels/aborts,
  and never sends `utterance.commit`; repeated flushes are empty and idempotent.
- Replay materializes an even pending tail once without changing the captured
  high-water and remains byte-for-byte deterministic. ACKs remain valid only at
  encoded frame boundaries.
- Derive the sample-driven ACK threshold as
  `max(1, min(16 * ackIntervalMs, maxRetainedReplaySamples,
  maxUnacknowledgedSamples))`; the default is 100 ms / 1,600 samples. Emit a
  normal ACK only after successful transcription acceptance crosses the
  threshold. Exact duplicates and valid recovery/commit boundaries may force
  an immediate ACK; malformed, conflicting, stale, gap, provider-failed, or
  high-water-mismatch paths never ACK.
- Preserve the 500 ms replay/backpressure bound, exact sample offsets,
  duplicate detection, and deterministic replay.
- Remove the redundant transport input copy and send isolated queue-returned
  frame bytes directly. Retain ownership copies at the SDK callback and replay
  retention boundaries, and do not share relay duplicate fingerprints with
  provider-forward buffers.
- Do not add timer-based ACK/flush wakeups, cross-cutting telemetry plumbing, or
  weaken resampler ownership semantics. Treat 60 ms as a configurable rollout
  default until physical-G2 measurements exist.

Verification:

```text
npm run typecheck -w @palancar/audio
npm test -w @palancar/audio
npm run typecheck -w @palancar/g2-client
npm test -w @palancar/g2-client
npm run typecheck -w @palancar/relay
npm test -w @palancar/relay
```

## Slice 4: real transcription and calibrated language evidence

Owned files are assigned only after a Sol architecture pass against current
official OpenAI/Azure contracts. Expected scope:

- `packages/transcription/**`
- transcription configuration in `apps/relay/**`
- transcription-specific Terraform variables/secrets/RBAC
- metadata-only spike and tests

Requirements:

- Implement a real mini-transcribe adapter through the selected Azure/OpenAI
  contract, with streaming partial/final events and cancellation.
- Do not let a selected-language hint serve as authoritative language evidence.
  Use provider detection or an independently calibrated classifier.
- Only confident target-language partials are displayed; all final non-target
  decisions make zero generation calls.
- Spanish and Turkish remain initial registry entries, not language branches in
  provider orchestration.
- If Azure deployment remains blocked, finish and test the adapter against a
  deterministic protocol double and record the exact external deployment
  blocker; do not fabricate a live success.

## Slice 5: authenticated spend controls and recovery

Expected scope after Sol design review:

- replace unconditional development ticket issuance in deployed paid mode
- connect persistent ticket consumption and sample/token rate state
- implement client/relay resume or explicitly abort retained turns without
  continuing paid work
- add abuse, replay, expiry, cancellation, and state-outage tests

No paid production-mode generation or transcription deployment is accepted
until this slice is ready.

## Slice 6: Terraform efficiency and provider correctness

Owned files:

- `infra/modules/container-app-workload/**`
- `infra/environments/dev/**`
- affected Foundry/identity/Key Vault module files only if required
- `apps/litellm-proxy/**` only if needed for managed-identity authentication

Requirements:

- Parameterize `min_replicas`; default inactive development to zero and retain
  an explicit warm-latency setting of one.
- Keep one active replica maximum until session ownership is externalized.
- OpenRouter generation must not require unrelated Azure generation
  deployments.
- Azure generation mode must match the Foundry local-auth policy, preferring
  managed identity/AAD instead of an API key.
- Remove static helper processes or readiness work only when equivalent
  configuration attestation remains.
- Terraform plans must be saved and JSON-inspected before apply; no unrelated
  resource replacement or model deployment is allowed.

## Integration and completion gates

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- parent-owned client integration test proving back-to-back
  `translation.ready` and `suggestions.ready` move `Translating` to `Results`
- LiteLLM proxy local/static validation
- Terraform formatting and validation
- inspected no-surprise Terraform plan
- deployed `/healthz` and `/readyz`
- one isolated real OpenRouter request proving exactly one upstream generation
  request for one accepted target turn
- restore non-paid/mock or scale-to-zero baseline after smoke unless the user
  explicitly requests a paid always-on deployment
- clean worktree and reviewed commits for every slice

Physical G2 microphone timing, display latency, background recovery, and
release readiness remain explicit hardware gates.
