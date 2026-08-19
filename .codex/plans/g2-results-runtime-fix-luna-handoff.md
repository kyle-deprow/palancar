# G2 Results next-turn runtime integration fix — Luna handoff

## Objective

Fix the reviewed runtime gap so a real G2 click while the state is `Results` supplies a fresh utterance UUID and executes the reducer's direct next-turn effects.

## Files you may change

- `apps/g2-client/src/bridge/runtime.ts`
- `apps/g2-client/test/bridge.test.ts`

## Files you must not change

- Every other file. Do not alter state reducer, auth, transport, packages, docs, or commit.

## Requirements

- In the existing click/undefined-event normalization boundary, generate an utterance ID when state is either established `Ready` (`sessionReady:true`) or `Results`.
- Use the existing injected `idGenerator` exactly once per accepted click. Keep TargetSelection/List behavior and all other states unchanged.
- Preserve existing secure-random failure behavior: generator failure returns `fatal` and causes no audio/utterance start.
- Do not generate IDs for swipes, double-click, unestablished Ready, Listening stop, Finalizing, Translating, Error, or enrollment states added later.
- Add bridge-level journey test: reach Results from session ready + first utterance + final/gate/translation/suggestions, click from a valid G2 source, then prove state is Listening, bridge audio opened for the next turn, transport got `start-utterance` for a fresh UUID, no new session/transport was created, old results display/content no longer persists, and effect ordering remains audio open before transport utterance start.
- The existing harness currently returns one fixed UUID. Extend only test harness options as needed to provide a deterministic UUID sequence so first and next utterances differ.
- Add generator-failure coverage specifically from Results and prove no next audio/utterance operation.
- Preserve all current bridge lifecycle/recovery/cleanup tests.

## Verification

Run:

```bash
npm run test --workspace @palancar/g2-client -- --run test/bridge.test.ts test/state.test.ts
npm run typecheck --workspace @palancar/g2-client
npm run lint --workspace @palancar/g2-client
```

## Escalation

Stop if another file is required. Do not reintroduce a Ready intermediate state.

## Completion report

List files and actual checks. End `DONE` only if complete.
