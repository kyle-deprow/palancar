# Generation foundation - Luna fix handoff

## Objective

Fix all Sol `NEEDS WORK` findings for `@palancar/generation` without changing package boundaries or architecture. The service must only operate on fully correlated accepted target turns, must not leak provider/user content through errors/evidence, and must be resistant to accessor/proxy/hostile provider objects.

## Writable scope

- `packages/generation/**`

Do not edit root manifests, lockfiles, G2 client, telemetry, relay, Terraform, docs, or commits. Other agents are active; preserve their edits.

## Must fix

1. Add `sessionEpoch` everywhere an accepted turn/correlation/result/evidence/cache key needs protocol identity:
   - accepted-turn input/output types;
   - runtime validation;
   - service correlation checks;
   - translation/suggestion provider inputs and outputs as needed;
   - evidence records;
   - tests and mocks.
2. Prevent self-authorizing/cache-alias behavior:
   - Keep accepted turns branded defensively, but ensure all cache/dedupe keys include `sessionId`, `sessionEpoch`, `utteranceId`, `segmentId`, `acceptedFinalRevision`, `selectedTargetLanguage`, `targetTranscript`, and `gatePolicyVersion`.
   - Tests must prove two turns differing only in transcript or gate policy do not alias.
3. Eliminate validate-then-read-again hazards:
   - Snapshot plain provider result/evidence objects into local primitives exactly once after validation.
   - Reject accessors, getters, proxies that throw, arrays, non-plain objects, cycles, and excessive nesting with `GenerationError` categories only.
   - Do not invoke getters when checking object shape.
4. Snapshot provider identity before use:
   - Validate/copy provider ID and version once during construction or first call.
   - Never reread provider identity in `finally`.
   - Hostile provider getters must produce a typed redacted `GenerationError`, never a raw thrown message.

## Should fix

1. Evidence validation must accept only explicit operation/status/failure categories and must compute latency from validated start/end values. It must reject invented categories.
2. Evidence sink failures must not override the primary operation result/failure and must not expose raw sink/provider errors.
3. Completed promise caches must be bounded and must not retain generated text indefinitely. Use an explicit small max-entry bound and evict deterministically.
4. The deterministic mock must record/validate provider inputs enough that tests fail if production sends the wrong correlation, transcript, target language, or gate policy.
5. Package checks/build scripts must work from a clean checkout by building needed workspace prerequisites or documenting/running them in tests.
6. Gate-policy version validation must match the protocol `VersionSchema` pattern and length from `@palancar/contracts`, not a weaker custom pattern.

## Tests

Add or update Vitest tests for every finding:

- `sessionEpoch` in accepted turns, results, evidence, and provider calls.
- cache keys distinguish transcript and gate policy.
- hostile accessor/getter/proxy provider results and provider identity are rejected/redacted.
- evidence rejects invented categories and invalid latency.
- evidence sink failures are swallowed/redacted without changing the operation result.
- completed cache is bounded.
- mock input capture catches wrong correlation/transcript/gate policy.
- gate-policy version rejects invalid protocol versions.
- serialized public errors/evidence do not contain representative Spanish/Turkish/English conversation strings or raw provider messages.

## Verification

Run:

- `npm run lint -w @palancar/generation`
- `npm run typecheck -w @palancar/generation`
- `npm run test -w @palancar/generation`
- `npm run build -w @palancar/generation`
- `git diff --check -- packages/generation`

Report actual results.

## Completion report

List changed files, checks run with outcomes, remaining risks, and `DONE` as the final line only if all findings are fixed and verification passes.
