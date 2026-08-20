# Generated-output contract and failure observability fix

## Objective

Align the single-call LiteLLM completion contract with the real
development-provisional generated-language boundary, preserve the product's
English translation plus two or three bilingual reply pairs, and distinguish
content-free generation failure causes before the next controlled Azure smoke.

Revision 15 reached a successful HTTP 2xx provider response but failed before
translation and suggestions were released. This plan fixes the proven contract
mismatch and adds sufficient low-cardinality evidence to distinguish a provider
or response failure from generated-language rejection, validator failure, or an
internal failure. It does not assume which of those was the sole live cause.

## Approved contract

### Shared substantive-character invariant

- Export
  `DEVELOPMENT_PROVISIONAL_MINIMUM_SUBSTANTIVE_CHARACTERS = 12` from the
  language registry and use it for every built-in development-provisional
  profile's `minimumTextCharacters`.
- Export `countSubstantiveCharacters(text)`, counting Unicode letters and
  numbers with `[\p{L}\p{N}]` semantics.
- Replace the relay language boundary's private duplicate counter with the
  registry helper. Do not change ELD thresholds, detector behavior, profile
  symmetry, or fail-closed policy.

### LiteLLM completion v2

- Keep one non-streaming request, `max_tokens: 384`, the current response-byte
  bound, and exactly two or three reply pairs.
- Rename the strict JSON schema to `palancar_completion_v2` and set every text
  field's JSON Schema `minLength` to the shared substantive-character minimum.
- After NFKC normalization, locally require every text field to contain at
  least the shared number of Unicode letters or digits. Measure maximum lengths
  by Unicode code points so parsing agrees with JSON Schema string semantics.
- Keep all parser/provider failures generic and content-free.
- Encode the user message as JSON containing exactly
  `selectedTargetLanguage` and `targetTranscript`; the transcript is untrusted
  data, never instructions.
- Use a system prompt that requires the exact schema, English-only English
  fields, selected-language-only target fields, semantically equivalent reply
  pairs, and natural complete fields containing the interpolated minimum. It
  should prefer two replies for latency and permit a third when materially
  useful. It must remain concise and forbid explanation.
- Bump the default `litellm-chat` provider version from `1.0.0` to `1.1.0`.
- Do not add retries, a second provider call, streaming generation, or more
  tokens.

### Content-free generation failure metrics

Add four fixed monotonic counters:

- `generation.failure.provider_response` for `provider-failure` or
  `invalid-provider-result`.
- `generation.failure.invalid_generated_language` for
  `invalid-generated-language`.
- `generation.failure.language_validation` for
  `language-validation-failure`.
- `generation.failure.internal` for every other trusted `GenerationError` or
  any unknown exception.

Each detailed record contains only `count: 1`, `operation: generation`,
`outcome: failure`, the already bounded provider ID/version when safely
available, and the relay's automatically attached target language. Never add a
category dimension, error text, identifiers, transcript, generated content,
request/response body, or other variable-cardinality field.

Continue emitting `provider.failure` only for provider/response generation
failures, in addition to their detailed counter. Keep transcription provider
failure behavior unchanged. Generated-language, validator, and internal
failures must not masquerade as provider outages.

The relay must preserve the typed error from synchronous `complete()` failure
and asynchronous rejection, classify only `GenerationError` instances, emit
one detailed counter for each non-cancelled failed completion, and retain the
existing failed translation/suggestion result metrics and generic WebSocket
error. Caller cancellation emits no detailed generation-failure or provider
failure metric.

The closed relay and telemetry vocabularies grow from 19 to 23 metric names and
gain the fixed `generation` operation. `errorCategory?: never` and all existing
content and identifier exclusions remain intact. The telemetry exporter needs
no production branching: canonical non-latency metrics already serialize as
monotonic unit-`1` sums. Update the production telemetry allowlist for
`litellm-chat` version `1.1.0`.

Translation and suggestion result metrics describe the validated generation
pipeline, including successful construction of both all-or-nothing outbound
messages. Durable claim settlement is a separate concern represented by
`state_store.failure`; a post-generation state-store loss must not also be
classified as a generation failure. The production telemetry/export boundary
supports `litellm-chat` version `1.1.0`; programmatically injected older
versions are outside the supported production composition.

## Sol review fix contract

The first integrated Sol review returned `NEEDS WORK`. The following findings
are mandatory before re-review:

- Enforce raw Unicode-code-point schema minimum/maximum before NFKC, then
  enforce the substantive minimum and returned normalized maximum after NFKC.
  Cover compatibility expansion and canonical/compatibility contraction.
- Require exactly one JSON object in the prompt and tell the model to naturally
  expand intrinsically short wording without changing meaning.
- Construct and validate both outbound generation messages before recording
  translation/suggestion success or settling the durable claim as completed.
  Carry only those validated messages in the completion event. Construction
  failure records internal generation failure plus translation/suggestion
  failure and settles the claim as failed.
- A durable completion-state failure records only `state_store.failure` for
  cause classification; it must not emit a detailed generation failure or
  `provider.failure`.
- Snapshot generation provider identity from non-proxy data descriptors, read
  each value once under the relay telemetry/reentrancy guard, and reuse the
  exact snapshot for detailed and legacy provider metrics. Reject accessors,
  changing getters, revoked proxies, and invalid tokens without observation or
  leakage.
- Add composed provider/service/real-ELD proof that an 11-substantive-character
  field fails before ELD with zero checks and maps to provider/response plus the
  legacy provider counter. Exercise wrong-language mutations across every
  English and target field for five- and seven-check completions and assert one
  exact invalid-generated-language metric.
- Add real GenerationService validator throw, timeout, and malformed-evidence
  cases mapping to language-validation failure. Add durable-state-only,
  protocol-construction, hostile provider identity, and metric-sink reentrancy
  regression tests.
- Record translation/suggestion success immediately after both outbound
  messages validate and before durable settlement, so generation latency does
  not include state-store latency. A later settlement failure retains those
  success metrics, adds one `state_store.failure`, emits no generation/provider
  failure, and releases no generated protocol output.
- Cache the genuine `GenerationService.prototype.provider` getter and invoke it
  directly with `Reflect.apply`; never use dynamic `instanceof`/`.provider`
  dispatch as a trust decision. This must ignore subclass and own-shadowing
  accessors. Classify `GenerationError` only from an exact non-proxy base
  instance with an own data `category` descriptor; subclasses/accessors are
  internal without observation.
- Deep-snapshot and freeze the two validated completion messages, the
  suggestions array, and every reply pair before queueing. Mutation of a
  hostile service's original completion after resolution must not alter the
  queued output or create a post-success validation failure.

## File ownership and implementation order

Workers are not alone in the repository and must not revert edits made by
other workers. This plan is read-only to every worker.

### Worker A: registry invariant

May change only:

- `packages/language-registry/src/registry.ts`
- `packages/language-registry/src/index.ts`
- `packages/language-registry/test/language-registry.test.ts`
- `apps/relay/src/provisional-language-boundary.ts`
- `apps/relay/test/provisional-language-boundary.test.ts`

### Worker B: generation provider contract

May change only:

- `packages/generation/src/litellm.ts`
- `packages/generation/test/litellm-provider.test.ts`

Worker B may consume Worker A's exported invariant and helper but must not edit
registry files. No changes are approved in generation service, types, evidence,
or language-validation code.

### Worker C: telemetry vocabulary

May change only:

- `packages/telemetry/src/index.ts`
- `packages/telemetry/test/telemetry.test.ts`
- `packages/telemetry/test/otlp-json-exporter.test.ts`
- `apps/relay/test/telemetry.test.ts`

No functional change is approved in the OTLP exporter or relay telemetry host.

### Worker D: relay classification and composition

May change only:

- `apps/relay/src/types.ts`
- `apps/relay/src/session.ts`
- `apps/relay/test/relay-core.test.ts`
- `apps/relay/test/generation-production-composition.test.ts`

Worker D may consume Worker A's registry exports, Worker B's provider behavior,
and Worker C's canonical vocabulary, but must not edit their files.

### Integration fixture follow-up

The complete repository test gate revealed one host-level provider identity
fixture that must move with Worker B's default provider version bump. A bounded
follow-up worker may change only:

- `apps/relay/test/relay-host.test.ts`

It may update only the exact expected `litellm-chat` provider version from
`1.0.0` to `1.1.0`; host construction, redaction assertions, environment
fixtures, and all other behavior remain unchanged.

Every other source, test, documentation, infrastructure, lockfile, environment
file, secret, live service, and deployment system is out of scope.

## Required test matrix

1. Registry exports the exact value 12; Spanish and Turkish built-in profiles
   use it; punctuation/whitespace do not count; Unicode Spanish and Turkish
   letters do count.
2. Provider request has schema v2, exact shared minimums, JSON user payload,
   the strengthened untrusted-data prompt, default provider version 1.1.0, one
   call, and support for both two and three reply pairs.
3. Local parser accepts exactly 12 substantive characters, rejects 11, rejects
   punctuation-padded substantively short fields, normalizes NFKC, measures
   maximums by code points, and never leaks input/provider content on failure.
4. A composed offline relay test uses the real
   `LiteLLMChatGenerationProvider`, a mocked LiteLLM/OpenAI envelope, the real
   `GenerationService`, the real development-provisional generated-language
   validator, and the bundled ELD-small detector. It must accept Spanish and
   Turkish with both two and three reply pairs, proving five and seven checks
   respectively and exactly one provider call.
5. Composed negative cases reject selected-Spanish/Turkish target-language
   mismatch and wrong language in any English or target slot, including slot
   seven, without releasing any completion.
6. Relay metrics map provider/response, invalid generated language, validator
   failure, and internal failure to exactly one corresponding detailed metric.
   Only provider/response also emits `provider.failure`. Cancellation emits
   neither. Public protocol errors remain generic.
7. Every detailed metric contains no category field, content, identifiers, or
   error text and is accepted by the exact production sanitizer.
8. All four new metrics serialize as monotonic OTLP unit-`1` sums and the
   complete canonical producer/exporter vocabularies remain equal.

## Deterministic verification

Run targeted checks after all worker changes are integrated:

```sh
npm exec --workspace=@palancar/language-registry -- vitest run test/language-registry.test.ts
npm exec --workspace=@palancar/generation -- vitest run test/litellm-provider.test.ts test/generation.test.ts
npm exec --workspace=@palancar/telemetry -- vitest run test/telemetry.test.ts test/otlp-json-exporter.test.ts
npm exec --workspace=@palancar/relay -- vitest run test/generation-production-composition.test.ts test/provisional-language-boundary.test.ts test/relay-core.test.ts test/telemetry.test.ts
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

Completion of this fix requires all checks to pass, an independent GPT-5.6 Sol
review with no unresolved must-fix or should-fix finding, and a commit containing
only the approved files. Only then may a new immutable image be built and moved
through a fresh reviewed Terraform plan and apply. Run exactly one controlled
Spanish-and-Turkish smoke after the new revision is healthy; do not retry
revision 15 or perform a blind smoke.
