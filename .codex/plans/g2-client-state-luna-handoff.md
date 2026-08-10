# G2 client interaction state — Luna implementation handoff

Implement a pure, deterministic interaction state machine for the G2 client.

## Ownership

You own only:

- `apps/g2-client/src/state/**`
- `apps/g2-client/test/state.test.ts`

Do not edit package manifests, lockfiles, display code, bridge code, or other packages. Other agents are working in the repository; preserve their changes.

## Public contract

Export from `src/state/index.ts`:

- a discriminated `ClientState` union for exactly `Starting`, `TargetSelection`, `Ready`, `Listening`, `Finalizing`, `Translating`, `Results`, `Recovering`, and `Error`;
- a discriminated `ClientEvent` union;
- a discriminated `ClientEffect` union;
- `createInitialState(restoredTarget?: unknown): ClientState`;
- `reduceClientState(state, event): { state: ClientState; effects: readonly ClientEffect[] }`.

The reducer must be pure, never mutate state/event inputs, and return frozen state/effects suitable for deterministic tests.

## Language behavior

- Use the registry-driven `TargetLanguage` / `getLanguageDefinition` API from `@palancar/language-registry`.
- Spanish (`es`) and Turkish (`tr`) are equal peers. Do not branch business behavior by language.
- A valid restored target is highlighted in `Starting`/`TargetSelection`, but is not confirmed and must not start a session or microphone.
- Invalid restored values are ignored and default highlighting follows registry order.
- Swipe cycles registry entries with wraparound. Press in `TargetSelection` confirms and persists the target, then requests session start. There is no audio effect before confirmation and `session.ready`.

## Required transitions and effects

Model external work as effects; do not call SDK, storage, networking, timers, or random/UUID functions.

- Initial state: `Starting` with highlighted target.
- `startup.ready` -> `TargetSelection`; `startup.failed` -> terminal `Error` with a display-safe message.
- `swipe.next` / `swipe.previous` cycle only in `TargetSelection`; elsewhere they are ignored except in `Results`, where they cycle the available suggestion index.
- `press` in `TargetSelection` -> `Ready`, emitting `persist-target` then `start-session` in that order.
- `session.ready` is accepted only when its target matches the confirmed target; it marks the state session-ready. Mismatch -> `Error` and `end-session`.
- `press` in session-ready `Ready` -> `Listening`, emitting `start-audio` then `start-utterance` in an explicitly documented order. A press before session readiness is ignored.
- `press` in `Listening` -> `Finalizing`, emitting `stop-audio` then `commit-utterance`.
- `transcript.partial` updates only the current utterance and stays `Listening` or `Finalizing`.
- `transcript.final` updates the current utterance and stays `Finalizing` until a language decision.
- Non-target language decisions (`english`, `mixed`, `supported_unselected`, `unsupported`, `uncertain`) return to session-ready `Ready`, preserve a bounded display-safe explanation, and must never emit translation/generation effects.
- A `target` decision requires a final transcript for the current utterance, moves to `Translating`, and emits one `request-translation` effect. Duplicate target decisions are ignored.
- `translation.ready` updates English text without waiting for suggestions and emits exactly one `request-suggestions` effect; duplicate translation events do not duplicate effects.
- `suggestions.ready` accepts exactly 2–3 English/target phrase pairs, moves to `Results`, and starts at suggestion zero. Reject malformed/empty/stale results into `Error` without exposing arbitrary payload text.
- `press` in `Results` -> session-ready `Ready` for the next turn, clearing utterance/transcript/translation/suggestions.
- `transport.lost` from an active session -> `Recovering` and emits `stop-audio` if listening plus `resume-session`; preserve current safe display data.
- `transport.resumed` restores the prior phase only when resumable; `transport.non-resumable` visibly aborts the turn and returns session-ready `Ready` with a bounded safe message.
- `utterance.aborted` returns session-ready `Ready` with a bounded safe message and clears active turn data.
- `fatal` -> `Error`, stopping audio if needed and ending the session if one exists. Error messages must be capped at 256 characters and not copy unknown objects.
- `shutdown` emits idempotent semantic cleanup effects (`stop-audio` when applicable and `end-session` when applicable) and leaves a terminal `Error`/shutdown state so subsequent shutdown events produce no effects.
- Events invalid for the current state are ignored with referentially safe frozen output.

Every session/utterance-scoped asynchronous event must carry stable IDs. Ignore stale IDs/revisions. Transcript revisions increase monotonically per segment. Keep the design easy for a later coordinator to consume.

## Tests and checks

Tests must cover both registry targets, restored-target non-confirmation, all happy-path states, non-target suppression, stale/duplicate async events, suggestion cycling, recovery/non-resumable behavior, fatal/shutdown cleanup, malformed suggestions, bounded messages, input immutability, and no side effects before target confirmation/session readiness.

Run:

- `npm run test --workspace @palancar/g2-client -- state.test.ts`
- `npm run typecheck --workspace @palancar/g2-client`
- `git diff --check -- apps/g2-client/src/state apps/g2-client/test/state.test.ts`

Report changed files and results. Do not commit.
