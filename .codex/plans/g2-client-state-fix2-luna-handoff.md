# G2 client state reducer - focused Luna fix handoff

## Objective

Fix the reviewed `apps/g2-client` interaction reducer so it enforces exact protocol identity, target-language gating prerequisites, bounded retained state, and coherent recovery behavior. Preserve the existing state-machine shape unless a change is explicitly required below.

## Writable scope

- `apps/g2-client/src/state/index.ts`
- `apps/g2-client/test/state.test.ts`

Do not edit any other file. Do not commit.

## Required fixes

1. Remove accepted protocol aliases:
   - No `epoch`, `target`, `englishText`, `english`, `targetText`, or `target` aliases.
   - `session.ready` requires `targetLanguage` and `sessionEpoch`.
   - `translation.ready` requires `englishTranslation`.
   - suggestions require `englishText` and `selectedTargetText`.
2. Use canonical v4 UUID validation for `sessionId` and `utteranceId`. A `press` from Ready must require a supplied valid utterance ID; missing/invalid ID is ignored and must never synthesize `utterance-*`.
3. Preserve phases:
   - `transcript.partial` after commit must keep `Finalizing`.
   - `transcript.final` in `Listening` is out of order and ignored.
   - only `Finalizing` may accept final transcript events.
4. Suggestions:
   - matching suggestions before a valid matching translation are ignored, not accepted.
   - stale/cross-session/cross-revision suggestions are ignored, not errors.
   - malformed suggestions for the current awaited identity become a terminal safe error and clean up the session.
   - `ResultsState.englishTranslation` is required.
5. Defensive immutability:
   - Never mutate or freeze caller-owned state/event/nested objects.
   - Clone active maps, suggestions, and `Recovering.priorState` before freezing outputs.
   - Make public discriminants enumerable ordinary fields; do not use non-enumerable `type`.
6. Recovery:
   - Idle established Ready `transport.lost` returns pending Ready and emits fresh `start-session`.
   - `Recovering` is only for active utterances.
   - Active `transport.lost` must validate replay offsets carried on the event: `clientLastAcknowledgedOffset`, `oldestRetainedOffset`, `nextCapturedOffset`.
   - `resume-session` effect must include `utteranceId` and those offsets.
   - Invalid replay snapshots visibly abort to established Ready with canned safe message and no resume effect.
   - When recovering from `Listening`, `transport.lost` stops audio, and successful `transport.resumed` restores `Listening` plus emits `start-audio`; other phases resume without audio.
7. Bounds:
   - Retain at most a fixed segment count and aggregate transcript length <= 4096.
   - A matching event that would exceed bounds becomes a terminal safe error with session cleanup.
8. Messages/errors:
   - Do not display arbitrary event strings/unknown objects. Use only canned safe messages for startup/fatal/non-resumable/etc.
   - Repeated terminal error/fatal/shutdown inputs produce no effects.

## Tests

Update tests to use canonical v4 UUIDs only and add regressions for every required fix above. Remove tests that require ignored events to preserve object identity.

## Verification

Run:

- `npm run test -w @palancar/g2-client -- state.test.ts`
- `npm run test -w @palancar/g2-client`
- `npm run lint -w @palancar/g2-client`
- `npm run typecheck -w @palancar/g2-client`
- `npm run build -w @palancar/g2-client`
- `git diff --check -- apps/g2-client/src/state/index.ts apps/g2-client/test/state.test.ts`

Report actual results.

## Completion report

List changed files, checks run with outcomes, remaining risks, and `DONE` as the final line only if all fixes and checks are complete.
