# Luna implementation handoff: relay protocol/session core

## Objective

Create the first bounded `@palancar/relay` TypeScript workspace as a pure, dependency-injected protocol/session core. This slice must not create an HTTP server, WebSocket server, Azure client, Terraform, Dockerfile, live Foundry adapter, durable Table Storage implementation, credential verifier, or real ticket issuer/consumer.

The goal is to make the authenticated WebSocket stream semantics mechanically testable before the network/Azure slice:

- pre-upgrade subprotocol parsing and ticket-consumption orchestration;
- first-message `session.start`/`session.resume` intent validation;
- negotiated limits and registry/policy version checks;
- one active session/utterance state machine;
- ordered binary audio acceptance mapped to transcription ingress;
- final transcript language gate mapped to translation/suggestions only for the selected target language.

## Files you may change

- `apps/relay/package.json`
- `apps/relay/tsconfig.json`
- `apps/relay/tsconfig.build.json`
- `apps/relay/src/index.ts`
- `apps/relay/src/protocol.ts`
- `apps/relay/src/session.ts`
- `apps/relay/src/types.ts`
- `apps/relay/src/testing.ts`
- `apps/relay/test/relay-core.test.ts`
- `package-lock.json`

## Files and actions you must not change

- Do not edit `package.json` at the repo root.
- Do not edit any existing `apps/g2-client/**`, `packages/**`, `infra/**`, `docs/**`, or prior `.codex/plans/**` files.
- Do not contact Azure, run Terraform, add Fastify/ws, open sockets, add runtime network dependencies, create containers, or commit.
- Do not persist, log, snapshot, or echo tickets, credentials, raw audio, transcripts, translations, suggestions, or provider errors in error text.

## Existing APIs to use

Use the built package APIs, not private internals:

- `@palancar/contracts`
  - Constants/types: `DEFAULT_NEGOTIATED_LIMITS`, `MAX_CONTROL_MESSAGE_BYTES`, `WEBSOCKET_SUBPROTOCOL`, `WEBSOCKET_TICKET_PREFIX`, `type SessionTicket`, `type SessionStart`, `type SessionResume`, `type ClientControlMessage`, `type ServerControlMessage`, etc.
  - Validation: `assertSessionStart`, `assertSessionResume`, `assertUtteranceStart`, `assertUtteranceCommit`, `assertUtteranceCancel`, `assertSessionEnd`, `assertServerControlMessage`.
  - Audio: `decodeAudioFrame`, `AudioFrameError`.
- `@palancar/audio`
  - `RelayOrderedFrameAcceptor`.
- `@palancar/language-registry`
  - `LANGUAGE_REGISTRY_VERSION`, `evaluateLanguageGate`, `type TargetLanguage`.
- `@palancar/transcription`
  - `type TranscriptionAdapter`, `type TranscriptionSession`, `type NormalizedTranscriptionEvent`.
- `@palancar/generation`
  - `GenerationService`, `createAcceptedTargetTurn`, generation result types.

## Package shape

Create a private ESM workspace package named `@palancar/relay`.

Required scripts:

- `lint`: `eslint .`
- `typecheck`: `tsc -p tsconfig.json`
- `test`: `vitest run`
- `build`: `tsc -p tsconfig.build.json`

Required dependencies:

- `@palancar/audio`: `0.1.0`
- `@palancar/contracts`: `0.1.0`
- `@palancar/generation`: `0.1.0`
- `@palancar/language-registry`: `0.1.0`
- `@palancar/transcription`: `0.1.0`

Do not add third-party runtime dependencies.

Use the same TypeScript build pattern as existing packages: strict root config, declaration build to `dist`, `rootDir: "src"`, package exports from `dist/index.js`.

## Required exported interfaces and functions

Put externally consumed types in `src/types.ts`, pure protocol helpers in `src/protocol.ts`, session orchestration in `src/session.ts`, deterministic test helpers in `src/testing.ts`, and re-export the public surface from `src/index.ts`.

### Protocol helpers

Implement and export:

```ts
export interface RelayUpgradeAudience {
  readonly environment: string;
  readonly origin: string;
  readonly path: '/v1/stream';
  readonly protocol: typeof WEBSOCKET_SUBPROTOCOL;
}

export type RelayTicketIntent =
  | { readonly intent: 'new' }
  | { readonly intent: 'resume'; readonly sessionId: string };

export interface ConsumedRelayTicket {
  readonly installationId: string;
  readonly credentialVersion: number;
  readonly intent: RelayTicketIntent;
  readonly expiresAt: string;
}

export type TicketConsumeFailureReason =
  | 'authentication_failed'
  | 'ticket_expired'
  | 'session_conflict'
  | 'rate_limited'
  | 'origin_rejected'
  | 'state_unavailable';

export interface TicketConsumer {
  consume(ticket: string, audience: RelayUpgradeAudience): Promise<
    | { readonly status: 'accepted'; readonly claim: ConsumedRelayTicket }
    | { readonly status: 'rejected'; readonly reason: TicketConsumeFailureReason }
  >;
}

export type StreamSubprotocolSelection =
  | { readonly status: 'accepted'; readonly ticket: string; readonly selectedProtocol: typeof WEBSOCKET_SUBPROTOCOL }
  | { readonly status: 'rejected'; readonly httpStatus: 400 | 401 };

export function selectStreamSubprotocols(
  offered: readonly string[]
): StreamSubprotocolSelection;

export type PreparedStreamUpgrade =
  | { readonly status: 'accepted'; readonly selectedProtocol: typeof WEBSOCKET_SUBPROTOCOL; readonly ticketClaim: ConsumedRelayTicket }
  | { readonly status: 'rejected'; readonly httpStatus: 400 | 401 | 403 | 409 | 429 | 503 };

export async function prepareStreamUpgrade(input: {
  readonly offeredSubprotocols: readonly string[];
  readonly audience: RelayUpgradeAudience;
  readonly ticketConsumer: TicketConsumer;
}): Promise<PreparedStreamUpgrade>;

export function negotiateLimits(
  requested: NegotiatedLimits,
  maximums?: NegotiatedLimits
): NegotiatedLimits;
```

Behavior:

- `selectStreamSubprotocols` accepts only when `offered` contains exactly one `palancar.v1` and exactly one `palancar.ticket.<ticket>` value.
- `selectStreamSubprotocols` must reject unless `offered.length === 2`. Any third offered protocol, even if unrelated, is a generic reject.
- The ticket value must satisfy existing `@palancar/contracts` ticket validation.
- The returned `selectedProtocol` must always be exactly `palancar.v1`; never return or echo the ticket-bearing subprotocol as selected.
- Reject missing protocol, wrong protocol, malformed ticket, duplicate ticket, duplicate `palancar.v1`, or extra ticket-bearing protocols.
- Reject by returning generic HTTP status only. Use `401` for exactly two offered values where `palancar.v1` is present but the ticket value is missing or malformed. Use `400` for wrong/missing base protocol, duplicate values, extra protocols, or any non-exact-two protocol list. Do not include ticket or protocol values in errors.
- `prepareStreamUpgrade` must call `ticketConsumer.consume(...)` only after subprotocol validation passes, and before returning an accepted upgrade.
- If subprotocol validation fails, `prepareStreamUpgrade` returns the selection failure status without consuming the ticket.
- If `ticketConsumer.consume` returns accepted, return accepted. The ticket is considered burned even if a later network upgrade would fail.
- Map consume failures:
  - `authentication_failed`, `ticket_expired` -> HTTP 401
  - `origin_rejected` -> HTTP 403
  - `session_conflict` -> HTTP 409
  - `rate_limited` -> HTTP 429
  - `state_unavailable` -> HTTP 503
- `negotiateLimits` returns the field-wise minimum of requested and server maximums. Default server maximums are `DEFAULT_NEGOTIATED_LIMITS`.
- Return a fresh frozen limits object and validate it with `assertNegotiatedLimits`.

### Session core

Implement and export:

```ts
export interface RelayClock {
  nowIso(): string;
}

export interface RelayIdGenerator {
  sessionId(): string;
  errorId(): string;
}

export interface RelaySessionCoreOptions {
  readonly ticketClaim: ConsumedRelayTicket;
  readonly clock: RelayClock;
  readonly ids: RelayIdGenerator;
  readonly transcriptionAdapter: TranscriptionAdapter;
  readonly generationService: GenerationService;
  readonly gatePolicyVersion: string;
  readonly serverLimits?: NegotiatedLimits;
}

export type RelayCloseCode = 1000 | 1002 | 1003 | 1008 | 1011 | 4401 | 4403 | 4408 | 4409 | 4410 | 4503;

export interface RelayStepResult {
  readonly outgoing: readonly ServerControlMessage[];
  readonly close?: Readonly<{ readonly code: RelayCloseCode; readonly reason: string }>;
}

export class RelaySessionCore {
  constructor(options: RelaySessionCoreOptions);
  openWithFirstText(text: string): RelayStepResult;
  handleText(text: string): RelayStepResult;
  handleBinary(bytes: Uint8Array): RelayStepResult;
  handleTranscriptionEvent(event: NormalizedTranscriptionEvent): Promise<RelayStepResult>;
  drainTranscriptionEvents(): Promise<RelayStepResult>;
  close(): RelayStepResult;
}
```

State requirements:

- The core starts in a pre-ready state. The only valid first text message is:
  - `session.start` if `ticketClaim.intent.intent === 'new'`;
  - `session.resume` if `ticketClaim.intent.intent === 'resume'`.
- Validate JSON parsing, max text size, and the specific control schema. Max text size is measured as UTF-8 bytes using negotiated `maxControlMessageBytes` after readiness and `MAX_CONTROL_MESSAGE_BYTES` before readiness.
- Pre-ready first-message failures must use this exact table:

| Failure | Outgoing | Close |
| --- | --- | --- |
| UTF-8 byte length exceeds `MAX_CONTROL_MESSAGE_BYTES` | `session.rejected` code `malformed_message` | `1002`, reason `protocol_error` |
| Malformed JSON | `session.rejected` code `malformed_message` | `1002`, reason `protocol_error` |
| JSON parses but schema validation fails | `session.rejected` code `malformed_message` | `1002`, reason `protocol_error` |
| Known control type other than ticket-matching `session.start`/`session.resume` | `session.rejected` code `authentication_failed` | `4401`, reason `authentication_failed` |
| Ticket intent mismatch (`new` ticket with `session.resume`, or `resume` ticket with `session.start`) | `session.rejected` code `authentication_failed` | `4401`, reason `authentication_failed` |
| Unsupported protocol version discovered before schema validation | `session.rejected` code `unsupported_protocol_version` | `1002`, reason `unsupported_protocol` |
| Unsupported target language discovered before schema validation | `session.rejected` code `unsupported_target_language` | `1008`, reason `unsupported_target` |
| `languageRegistryVersion` differs from `LANGUAGE_REGISTRY_VERSION` | `session.rejected` code `state_unavailable` | `4503`, reason `state_unavailable` |
| `gatePolicyVersion` differs from `options.gatePolicyVersion` | `session.rejected` code `state_unavailable` | `4503`, reason `state_unavailable` |
| Valid resume message but session ID differs from the ticket-bound resume session ID | `session.rejected` code `authentication_failed` | `4401`, reason `authentication_failed` |

- After readiness, malformed/unknown/too-large text controls emit `error` code `malformed_message`, scope `message`, recoverable `false`, and close `1002`.
- Calling `openWithFirstText` more than once after a successful open emits `error` code `session_conflict`, scope `session`, recoverable `false`, and close `4409`.
- Calling any handler after terminal close returns `{ outgoing: [], close: { code: 1000, reason: 'closed' } }` without side effects.
- Every result that includes a `close` must transition the core to terminal before returning. If a transcription session is active, cancel it where appropriate, close it, clear active utterance state, and reject/ignore later queued events.
- For `session.start`:
  - protocol version must be v1 via existing schema validation;
  - `wearerLanguage` must be `en` via schema validation;
  - `targetLanguage` can be `es` or `tr`;
  - `languageRegistryVersion` must equal `LANGUAGE_REGISTRY_VERSION`;
  - `gatePolicyVersion` must equal `options.gatePolicyVersion`;
  - effective limits are field-wise minimum of client requested and server max;
  - generate a new session ID with `ids.sessionId()`;
  - session epoch is `1`;
  - emit a validated `session.ready` with result `new`.
- For `session.resume` in this first slice:
  - Require ticket intent `resume` and exact ticket-bound `sessionId`.
  - Validate the same negotiation/version checks.
  - Because this slice has no durable or hydrated in-memory session registry, fail closed for every otherwise-valid resume by emitting `utterance.aborted` with category `non_resumable` when IDs are usable, then `session.rejected` with `invalid_session`, and close with code `4409`.
  - Do not silently create a replacement session on resume.
- After ready, `handleText` must accept only `utterance.start`, `utterance.commit`, `utterance.cancel`, or `session.end`.
- `utterance.start`:
  - Must match current session ID and epoch.
  - If no active utterance exists, create a `RelayOrderedFrameAcceptor` with effective limits and create a transcription session from the injected adapter:
    - `sessionId`, `sessionEpoch`, `configuration: { serverVadMode: 'disabled', languageMode: 'selected-target-hint', manualCommitCadenceMs: 600 }`, `onEvent` set to append the event to an internal FIFO queue, and `maxUtteranceSamples`.
    - Before creating the session, verify the injected adapter capabilities support `disabled` server VAD, `selected-target-hint` language mode, and `600` ms manual commit cadence. If not, emit generic `error` code `provider_unavailable`, scope `server`, recoverable `true`, and close `4503`.
    - Call transcription `start({ utteranceId, selectedTargetLanguage })`.
    - Delivery ownership: adapter callbacks are appended to the internal FIFO queue; `drainTranscriptionEvents()` processes that queue in order by using the same internal path as `handleTranscriptionEvent(event)`. Tests may also call `handleTranscriptionEvent(event)` directly to inject deterministic events. No other path may emit transcript/language/generation output.
  - If the same `utterance.start` is repeated while active, return no outgoing messages and no close.
  - If a different active utterance exists, emit a generic non-recoverable `error` with code `utterance_conflict` and close `4409`.
- Transcription-session lifecycle is one session per utterance in this slice. Every terminal path for an utterance (`final`, `cancel`, `duration/stale abort`, provider failure) must call `transcriptionSession.close()` after finalizing/cancelling as appropriate, then clear the active utterance. Starting a second utterance creates a new transcription session.
- `handleBinary`:
  - Reject before ready or without active utterance with generic protocol error and close `1002`.
  - Decode bytes with `decodeAudioFrame`.
  - Feed decoded frames into `RelayOrderedFrameAcceptor`.
  - `accepted`: call `transcriptionSession.pushAudio({ utteranceId: frame.utteranceId, originalSampleOffset: frame.offset, pcm: accepted.forwardPayload })` exactly once; emit `audio.ack` with `flowState: 'normal'` and `highestContiguousExclusiveOffset`.
  - `duplicate`: do not forward payload; emit `audio.ack` with `flowState: 'normal'`.
  - If `pushAudio` throws or returns a status other than `accepted`, do not emit `audio.ack`; emit `utterance.aborted` category `provider_loss`, emit generic `error` code `provider_unavailable`, scope `server`, recoverable `true`, close/cancel/cleanup the transcription session, and close `4503`.
  - If `pushAudio` returns `acceptedThroughOriginalSampleOffset` that does not equal the acceptor's `highestContiguousExclusiveOffset`, treat it as provider loss using the same no-ACK/abort/error/cleanup/`4503` behavior.
  - `rejected`:
    - `utterance-limit` -> emit `utterance.aborted` category `duration`, cancel transcription, clear active utterance, close `4408`.
    - `payload-limit` or `malformed-frame` -> emit `error` code `flow_control`, cancel/close/cleanup active transcription, close `1002`.
    - `wrong-utterance`, `conflicting-duplicate`, `gap`, `overlap`, `stale-frame` -> emit `utterance.aborted` category `stale_conflict`, cancel transcription, clear active utterance, close `1002`.
  - Audio-frame decode exceptions -> emit generic `error` code `flow_control`, cancel/close/cleanup active transcription, close `1002`.
- `utterance.commit`:
  - Must match current session/epoch/utterance.
  - `finalOriginalSampleOffset` must equal the acceptor high-water offset.
  - Call `transcriptionSession.finalize(utteranceId)` but do not process the returned final result directly. The only ingress for transcript output and generation is `handleTranscriptionEvent`.
  - Repeated same commit after finalize returns no outgoing messages until the final event arrives or the utterance is otherwise cancelled/closed.
  - Mismatch or offset conflict closes `1002` with a generic error.
- `utterance.cancel`:
  - Must match current session/epoch/utterance.
  - Call `transcriptionSession.cancel(utteranceId)`, emit `utterance.aborted` category `cancellation`, close the transcription session, clear active utterance, no close.
  - Repeated same cancel returns no outgoing messages.
- `session.end`:
  - Must match current session/epoch.
  - Cancel and close active transcription session if present and return close `1000`.
- `close()` must be idempotent and close/cancel any active transcription session.

### Transcription event and generation flow

`handleTranscriptionEvent` is the only path that emits transcript/language/translation/suggestions messages.

Requirements:

- Ignore stale events whose session ID, session epoch, or utterance ID do not match the currently accepted active utterance identity.
- Ignore duplicate or out-of-order transcription events for the active utterance. Revisions must strictly increase. The first accepted final is terminal for that utterance; any later event for that utterance, including a greater final revision, is stale and must be ignored.
- For `transcript.partial`, forward a validated `transcript.partial` only. Do not emit `language.decision` for partials because the gate can return `provisional`, which is not a protocol decision.
- For `transcript.final`, emit in this exact order:
  1. `transcript.final`
  2. `language.decision`
  3. if and only if the gate decision is `target`, `translation.ready`
  4. if and only if the gate decision is `target`, `suggestions.ready`
- Build the gate input from final text plus event `languageEvidence`; selected language is the session target; `isFinal: true`.
- Map final gate decisions directly to the protocol values: `target`, `mixed`, `english`, `supported_unselected`, `unsupported`, `uncertain`.
- If gate decision is not `target`, do not call `GenerationService.translate` or `GenerationService.suggest`.
- If gate decision is `target`, create an `AcceptedTargetTurn` using:
  - session/epoch/utterance/segment/revision from the final;
  - selected target language from the session;
  - `decision: 'target'`;
  - `targetTranscript: event.text`;
  - configured `gatePolicyVersion`.
- Call `generationService.translate(turn)`, then emit `translation.ready`; then call `generationService.suggest(turn, translation)`, then emit `suggestions.ready`.
- Guard async completions with an internal final-processing token containing session ID, epoch, utterance ID, segment ID, and final revision. If the session has closed or that token is no longer current before translation resolves, return only the already-produced `transcript.final` and `language.decision` messages and no generated output. This stale suppression must not emit `provider_unavailable`.
- If translation fails, return `transcript.final`, `language.decision`, then a generic `error` code `provider_unavailable`, scope `server`, recoverable `true`; close/clear the active utterance.
- If translation succeeds but suggestions fail, return `transcript.final`, `language.decision`, `translation.ready`, then a generic `error` code `provider_unavailable`, scope `server`, recoverable `true`; close/clear the active utterance.
- Generation or provider failures should emit a generic `error` code `provider_unavailable`, scope `server`, recoverable `true`, and no close.
- After a final event is fully handled, close the transcription session, clear the active utterance, and allow a later `utterance.start` for the next utterance. For target finals, clear only after translation/suggestions finish or after a generation failure is reported. For non-target finals, clear immediately after the `language.decision` result is returned.

### Error and redaction requirements

- Public `displaySafeMessage` and close `reason` strings must be canned and must not include raw inbound text, ticket values, credentials, UUIDs from malformed messages, transcripts, translations, suggestions, provider error messages, or raw error `.message` values.
- Use `ids.errorId()` for `error` envelopes.
- Validate every outgoing control object with `assertServerControlMessage` before returning it.

## Required tests

Add focused Vitest tests in `apps/relay/test/relay-core.test.ts`. Include deterministic mocks in `src/testing.ts` only if useful.

Minimum cases:

1. Subprotocol parsing accepts exactly `palancar.v1` plus one valid `palancar.ticket.<ticket>` and selects only `palancar.v1`.
2. Missing protocol, malformed ticket, duplicate ticket, duplicate protocol, and wrong/extra ticket protocol reject generically.
3. `prepareStreamUpgrade` calls `ticketConsumer.consume` only after valid subprotocols and maps each consume failure to the specified HTTP status.
4. New-intent ticket rejects first `session.resume`; resume-intent ticket rejects first `session.start`.
5. Happy `session.start` for Spanish and Turkish emits valid `session.ready` with field-wise minimum limits and matching registry/policy versions.
6. Registry version mismatch and gate-policy mismatch reject without creating a transcription session.
7. Valid resume ticket plus valid `session.resume` fails closed as non-resumable/invalid-session and never creates a replacement session.
8. `utterance.start` starts one transcription session; repeated same start is idempotent; different active utterance closes with `utterance_conflict`.
9. Binary before ready or before utterance closes with protocol error.
10. Accepted binary audio forwards payload exactly once and emits `audio.ack`; duplicate emits `audio.ack` and does not forward again.
11. Gap, overlap, wrong utterance, conflicting duplicate/stale conflict, malformed frame, payload limit, and utterance limit map to the required abort/error/close behavior.
12. Commit requires exact accepted high-water offset and does not process `finalize()` return.
13. Cancel emits cancellation abort and clears active utterance; session end closes normally.
14. Partial transcription forwards only `transcript.partial`.
15. Final target-language event emits final, language decision, translation, suggestions in order.
16. Final target-language handling clears the active utterance after generation completes and allows the next utterance to start.
17. Final English, supported-unselected target, unsupported, mixed, and uncertain events emit no generation calls and clear the active utterance after the language decision.
18. Stale transcription events are ignored.
19. Duplicate/out-of-order final revisions are ignored; any event after the first accepted final for an utterance is stale.
20. Unsupported transcription capabilities produce a generic provider-unavailable error and do not leak adapter details.
21. `pushAudio` throw/result mismatch produces no ACK, emits provider-loss abort plus provider-unavailable error, cleans up, and closes `4503`.
22. Handler calls after terminal close and repeated `openWithFirstText` have deterministic results.
23. Server-lowered `maxControlMessageBytes` is enforced after readiness.
24. Resume message whose session ID differs from ticket binding rejects authentication.
25. Translation success plus suggestion failure returns translation and a generic provider-unavailable error.
26. Adapter callback events can be drained through `drainTranscriptionEvents()` and produce the same outputs as direct `handleTranscriptionEvent`.
27. Redaction canaries from hostile inbound text and actually thrown transcription/generation provider errors never appear in returned public messages or close reasons.

## Verification

Run these commands and report their actual output:

- `npm install --package-lock-only --ignore-scripts`
- `npm run lint -w @palancar/relay`
- `npm run typecheck -w @palancar/relay`
- `npm run test -w @palancar/relay`
- `npm run build -w @palancar/relay`
- `git diff --check -- apps/relay package-lock.json`

## Completion report

List changed files, commands run with real results, and unresolved risks. End with `DONE` only if the implementation meets this handoff.
