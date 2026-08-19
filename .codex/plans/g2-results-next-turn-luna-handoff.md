# G2 Results-to-next-turn state transition — Luna handoff

## Objective

Change the already-established client state machine so one valid press on `Results` immediately begins the next utterance in the same authenticated relay session.

## Files you may change

- `apps/g2-client/src/state/index.ts`
- `apps/g2-client/test/state.test.ts`

## Files you must not change

- Every other file in the repository, including runtime, transport, display, auth, package files, and docs.
- Do not commit.

## Requirements

- Preserve all existing behavior except the `Results` + `press` transition.
- On `Results`, accept the press only when `event.utteranceId` is a canonical UUID v4 under the state machine's existing validator.
- A missing or malformed utterance ID is a no-op with the exact same immutable state and no effects.
- A valid press transitions directly to `Listening` using:
  - the same target language, session ID, and session epoch;
  - the supplied new utterance ID, which must be different from the completed result's utterance ID;
  - `turn = previous turn + 1`, rejecting/no-op if increment would exceed uint32;
  - empty transcript and empty segment/revision/final maps;
  - no retained final transcript, final segment/revision, translation, suggestions, or prior selection index.
- Emit exactly two effects, in existing canonical order and shapes: `start-audio`, then `start-utterance`, both scoped to the existing session and new utterance ID.
- Do not create a `Ready` intermediate state and do not start a new relay session.
- Add focused tests for Spanish and Turkish, valid transition/effects, old result content clearance, absent/malformed/reused UUID no-op, and uint32 turn overflow no-op.
- Preserve reducer input hardening, immutability, all existing tests, and strict TypeScript/lint.

## Verification

Run and report actual output from:

```bash
npm run test --workspace @palancar/g2-client -- --run test/state.test.ts
npm run typecheck --workspace @palancar/g2-client
npm run lint --workspace @palancar/g2-client
```

## Escalation

If the runtime must change to satisfy this state transition, stop and report the exact integration requirement; do not edit runtime.

## Completion report

List changed files, checks, and unresolved risks. End with `DONE` only if complete.
