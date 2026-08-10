# Generation foundation - focused Luna continuation

## Current state

The first fix pass partially updated:

- `packages/generation/src/types.ts`
- `packages/generation/src/accepted.ts`
- `packages/generation/src/evidence.ts`

Current `npm run typecheck -w @palancar/generation` fails because:

- `service.ts` correlation omits `sessionEpoch` and `gatePolicyVersion`;
- `service.ts` suggestion provider input omits required `targetTranscript`;
- tests construct accepted turns without `sessionEpoch`.

## Objective

Finish the generation Sol fixes and make the package pass lint, typecheck, tests, build, and diff check.

## Writable scope

- `packages/generation/**`

Do not edit root manifests, lockfiles, apps, telemetry, relay, Terraform, docs, or commits.

## Required implementation

1. Update `src/service.ts`:
   - `correlationFromTurn` includes `sessionEpoch` and `gatePolicyVersion`.
   - cache keys include `sessionId`, `sessionEpoch`, `utteranceId`, `segmentId`, `acceptedFinalRevision`, `selectedTargetLanguage`, `targetTranscript`, and `gatePolicyVersion`.
   - suggestion provider input includes `targetTranscript`.
   - provider identity (`id`, `version`, `translate`, `suggest`) is inspected via own descriptors, rejects accessors/getters/non-plain values, copied once in constructor, and never reread in `finally` or the `provider` getter.
   - provider translation/suggestion outputs are inspected via descriptors and copied once. Reject accessors, arrays where plain object is required, non-plain objects, proxies that throw, and malformed values with `GenerationError('invalid-provider-result')`; provider thrown errors become `GenerationError('provider-failure')`.
   - evidence sink failures are swallowed/redacted and do not change a successful result or primary failure.
   - pending promise caches delete on rejection, and completed caches are bounded by an explicit small max entry count so generated text is not retained indefinitely.
2. Update `src/mock.ts`:
   - Record frozen copies of translate/suggest inputs.
   - Expose snapshots such as `translateInputs` and `suggestInputs`.
   - Do not discard input with `void input`.
3. Update tests:
   - Add `sessionEpoch` everywhere accepted turns are created.
   - Assert `sessionEpoch` and `gatePolicyVersion` appear in translation/suggestion outputs, provider inputs, and evidence.
   - Prove cache keys distinguish transcript and gate-policy version.
   - Prove hostile provider identity getters and provider result accessors/proxies are redacted typed errors.
   - Prove evidence sink failures do not override successful translation/suggestion.
   - Prove evidence rejects invented failure categories and invalid latency.
   - Prove mock captures provider input correlation/transcript/gate policy.
   - Prove invalid gate-policy versions are rejected using the protocol version pattern.
   - Prove serialized public errors/evidence do not contain representative conversation text or raw provider messages.

## Verification

Run:

- `npm run lint -w @palancar/generation`
- `npm run typecheck -w @palancar/generation`
- `npm run test -w @palancar/generation`
- `npm run build -w @palancar/generation`
- `git diff --check -- packages/generation`

## Completion report

List changed files, actual verification results, unresolved risks, and `DONE` as the final line only if complete.
