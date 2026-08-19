# G2 enrollment/authentication state machine — Luna handoff

## Objective

Insert the redacted enrollment and session-authentication states into the existing immutable G2 reducer, preserving the reviewed Results direct-next-turn behavior and all protocol/session safeguards.

## Files you may change

- `apps/g2-client/src/state/index.ts`
- `apps/g2-client/test/state.test.ts`

## Files you must not change

- Every other file. Do not edit runtime/transport/auth/UI/docs or commit.

## New states

Add to `ClientState`/`StateName`, with `state` and matching `type` literals:

- `EnrollmentChecking`: `highlightedTarget`, `phase:"checking"|"revoking"`.
- `EnrollmentRequired`: `highlightedTarget`, `reason` from the exact redacted reason union below.
- `Enrolling`: `highlightedTarget` only.
- `StorageError`: `highlightedTarget` only.

Reason union: `missing|absolute-expired|credential-rejected|pairing-failed|pairing-uncertain|revoked|revocation-unconfirmed`.

These states must never contain credential, pairing code, installation/session/utterance identity, transcript, translation, suggestion, or arbitrary server text.

## New events/effects

Add strictly validated exact events:

- `enrollment.ready`
- `enrollment.required` with valid reason
- `enrollment.started`
- `enrollment.failed` with valid pairing reason (`pairing-failed|pairing-uncertain`)
- `enrollment.storage-error`
- `enrollment.retry`
- `enrollment.reset`
- `session.authenticated`
- `session.auth-unavailable`
- `credential.rejected`
- `credential.storage-error`
- `revocation.started`
- `revocation.completed` with `reason:"revoked"|"revocation-unconfirmed"`

Add effects:

- `check-enrollment`
- `reset-enrollment`
- `prepare-session-auth` with only target language

Reuse existing `persist-target`, `start-session`, audio/session cleanup effects. No effect/event may carry a credential or pairing code.

## Exact transitions

- `Starting + startup.ready` -> `EnrollmentChecking/checking` + exactly `check-enrollment`.
- `EnrollmentChecking/checking + enrollment.ready` -> `TargetSelection`.
- `EnrollmentChecking/checking + enrollment.required` -> `EnrollmentRequired` preserving highlighted target/reason.
- Enrollment checking/required/enrolling plus storage error -> `StorageError`.
- `EnrollmentRequired + enrollment.started` -> `Enrolling`.
- `Enrolling + enrollment.ready` -> `TargetSelection`.
- `Enrolling + enrollment.failed` -> `EnrollmentRequired` with supplied pairing reason.
- `StorageError + enrollment.retry` -> `EnrollmentChecking/checking` + `check-enrollment`.
- `StorageError + enrollment.reset` -> `EnrollmentChecking/checking` + `reset-enrollment`.
- `TargetSelection + press` -> a new pending Ready variant `pending:"authentication"`, `sessionReady:false`, target, turn 0; effects exactly `persist-target`, then `prepare-session-auth`. No `start-session` yet.
- `Ready/authentication + session.authenticated` -> existing `Ready/pending:"initial"`; effect exactly `start-session`.
- `Ready/authentication + session.auth-unavailable` -> same auth-pending state with fixed redacted retry message and no effects. A later press in that state emits exactly `prepare-session-auth` for retry.
- Existing `session.ready` only applies after pending initial/recovery; it must never bypass auth-pending state.
- `credential.rejected` from any pending/established/active authenticated-session state -> `EnrollmentRequired/credential-rejected`, stopping active audio and ending any known session with existing safe exact effects. From enrollment/pre-auth states it is a no-op.
- `credential.storage-error` from those same authenticated-session states -> `StorageError` with the same cleanup.
- `revocation.started` from an auth-pending/initial/established/active state -> `EnrollmentChecking/revoking`, stop audio if active, end known session, clear all turn/results/session data.
- `EnrollmentChecking/revoking + revocation.completed` -> `EnrollmentRequired` with supplied reason.
- Fatal/shutdown behavior remains terminal Error as currently specified.
- Press/swipe in all four enrollment/storage states is a no-op. Double-click exit is runtime-owned and unaffected.
- Preserve existing Spanish/Turkish registry symmetry, Results behavior, uint32 checks, stale-event rejection, immutable cloning/freezing, and all other transitions.

## Validation/tests

- Update exact known-event validation; reject extra fields, getters, proxies, invalid reasons/types, and secret-bearing unknown objects without throwing/leaking.
- Exhaustively test transition/effect table, no-op gestures, no premature start-session, session.ready auth bypass rejection, retry behavior, cleanup ordering from Ready/Listening/Finalizing/Translating/Results, state content allowlists, malformed events, immutability, Spanish/Turkish symmetry, and existing Results flow.
- Assert canary credentials/pairing codes supplied through malformed unknown inputs never appear in state/effects/error serialization.

## Verification

Run:

```bash
npm run test --workspace @palancar/g2-client -- --run test/state.test.ts
npm run typecheck --workspace @palancar/g2-client
npm run lint --workspace @palancar/g2-client
```

## Escalation

Stop if another file is required. Do not encode secrets or start session before `session.authenticated`.

## Completion report

List files/checks/risks. End `DONE` only if complete.
