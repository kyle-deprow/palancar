# Generation foundation — Luna implementation handoff

## Objective

Create a provider-neutral, deterministic `@palancar/generation` package that enforces the accepted-target boundary and exposes translation separately from response suggestions. This task does not implement an Azure/OpenAI network adapter.

## Files you may change

- `packages/generation/**`

## Files you must not change

- all other repository paths, including root/package lock files, contracts, language registry, apps, Terraform, docs, and commits.

Other agents are working in the repository. Preserve their edits.

## Required public contract

Export through `src/index.ts`:

- immutable input/output/error/provider types;
- `createAcceptedTargetTurn(input)` as the only public constructor for a frozen accepted-turn value;
- `GenerationService` with separate `translate(turn)` and `suggest(turn, translation)` methods;
- a deterministic scripted/mock provider for tests;
- a metadata-only evidence collector that never stores source, translation, or suggestion text.

The accepted-turn constructor must require and runtime-validate:

- canonical v4 `sessionId` and `utteranceId`;
- nonempty bounded `segmentId`;
- positive integer accepted final revision;
- selected target from `@palancar/language-registry` (`es` or `tr`, no special branch);
- `decision: "target"`;
- nonempty target transcript up to the contracts transcript bound;
- a bounded, nonempty gate policy version.

It must defensively copy/freeze input so later mutation cannot alter behavior. Invalid input throws a typed error with a stable category and content-free message.

`translate`:

- accepts only a value created by `createAcceptedTargetTurn`; reject forged/plain objects at runtime without invoking the provider;
- invokes exactly one provider translation operation;
- validates a nonempty English translation up to 1,024 characters;
- returns frozen correlation metadata plus the translation;
- never triggers suggestions.

`suggest`:

- accepts only a matching service-produced translation for the same session/utterance/segment/revision/target;
- invokes exactly one provider suggestion operation;
- requires exactly 2 or 3 phrase pairs, each with nonempty English and selected-target text up to 1,024 characters;
- defensively copies and deeply freezes all output;
- rejects stale/mismatched/forged/malformed results without returning partial output.

Provider failures must become typed generation errors with stable categories and content-free public messages; preserve the original error only in a non-enumerable/cause field if practical. Never interpolate conversation text or arbitrary provider messages into the public error message.

The service must prevent duplicate provider work for concurrent/repeated calls on the same accepted turn: memoize the in-flight/completed translation and suggestion promises per service instance and key. A rejected attempt may be retried. Different turns remain independent.

The deterministic mock/provider must support explicit per-operation scripts, call counters, optional delays/failures, both target languages, and defensive copies. Do not synthesize real translations.

Evidence records may include operation, selected target, success/failure category, provider ID/version, correlation IDs/revision, start/end monotonic timestamps, and latency. They must not include raw text, prompts, outputs, or thrown provider messages and must be immutable snapshots.

## Package shape

Follow existing workspace package conventions:

- exact version `0.1.0`, private ESM package;
- dependencies only on local `@palancar/contracts` and `@palancar/language-registry` unless strictly necessary;
- strict TS config extending the repository base config, declaration build, ESLint, Vitest;
- no `any`, network calls, environment access, Azure SDK, OpenAI SDK, timers except injected mock delays, or logging.

## Verification

Tests must cover both `es` and `tr`, accepted-boundary validation, forged values, immutability, separate operations, correlation mismatch, 2/3 suggestions, malformed 0/1/4 suggestions, overlength fields, provider failure redaction, retry after failure, concurrent deduplication, evidence redaction, and no provider call on invalid input.

Run and report:

- `npm run lint --workspace @palancar/generation`
- `npm run typecheck --workspace @palancar/generation`
- `npm run test --workspace @palancar/generation`
- `npm run build --workspace @palancar/generation`
- `git diff --check -- packages/generation`

If workspace scripts cannot run solely because the root lockfile has not yet been updated by the parent, run the equivalent local TypeScript/Vitest/ESLint commands and report that exact limitation. Do not edit the lockfile.

## Completion report

List changed files, actual verification output, and unresolved issues. End with `DONE` only when the implementation is complete.
