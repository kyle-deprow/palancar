# G2 client interaction state — Luna fix handoff

Fix only:

- `apps/g2-client/src/state/index.ts`
- `apps/g2-client/test/state.test.ts`

Do not edit anything else or commit. Preserve concurrent work.

Apply every Sol review correction below:

1. Preserve `Finalizing` when a partial arrives after commit; never regress to `Listening` or duplicate stop/commit effects.
2. Treat a final transcript received during `Listening` as out of order and ignore it. Only `Finalizing` accepts finals.
3. Recovery from `Listening` stops audio on loss and emits `start-audio` only after `transport.resumed` restores `Listening`; coordinator ordering is replay/resume first, then capture restart. Other active-turn phases resume without audio.
4. Suggestions are accepted only when a matching `translation.ready` has already set a valid English translation and triggered suggestions. Make `ResultsState.englishTranslation` required. Valid early suggestions are ignored.
5. Ignore every identity/revision mismatch, including stale suggestions. Only a malformed suggestions payload matching the currently awaited identity may enter a terminal safe `Error`, stopping audio if applicable and ending the session.
6. Never freeze or mutate caller-owned state/event/nested objects. Normalize every reducer input through a defensive deep clone and deep-freeze of the clone; do not rely on a shallow `Object.isFrozen`. It is acceptable for ignored-event output not to preserve reference identity. Ensure nested maps, suggestions, and `Recovering.priorState` are cloned/frozen.
7. Remove protocol aliases and optional canonical fields: no `epoch`, `target`, `englishText`, optional epoch, optional target language, or suggestion field aliases. Use exact canonical event fields (`sessionEpoch`, `targetLanguage` for local `session.ready`, `selectedTargetLanguage`, `englishTranslation`, `selectedTargetText`). Keep local gesture/transport events distinct from server messages. Avoid accepting unknown payload shapes through convenience aliases.
8. `press` may enter Listening only with a coordinator-supplied canonical v4 UUID utterance ID. Missing/invalid ID is ignored; never synthesize an ID.
9. Split Ready into impossible-state-safe variants: pending session has `sessionReady:false` and no session identity; established session has `sessionReady:true` and required session ID/epoch. Keep the public `ReadyState` union.
10. An idle established Ready transport loss cannot use protocol `session.resume`; return to pending Ready and emit a fresh `start-session` for the confirmed target. `Recovering` is only for states with an active utterance and its resume effect must carry the complete immutable replay snapshot needed by `session.resume`: utterance ID plus last acknowledged, oldest retained, and next captured offsets. Extend `transport.lost` to carry/validate those offsets for active turns. Invalid replay snapshots visibly abort to established Ready with a canned safe message and no resume effect.
11. Bound retained transcript state and aggregate display transcript to 4,096 characters and a fixed segment-count maximum. A matching event that would violate bounds must terminally fail with canned content-free cleanup rather than retain unbounded data.
12. Never display arbitrary string/unknown input. Remove arbitrary message fields or ignore them and use only canned messages. A separately validated display-safe event may be added only if its type proves it came from the contracts validator; otherwise do not add one.
13. Errors have coherent behavior: malformed current results/retained transcript overflow become terminal and emit session cleanup; stale events are ignored. Startup errors have no session cleanup. Repeated fatal/shutdown/error inputs produce no effects.
14. Make both public state discriminants ordinary enumerable fields, or retain only one. Do not declare a required field that disappears during spread/serialization.

Tests must use canonical v4 UUIDs and add regressions for all fourteen points, including partial-after-commit, final-before-commit, audio restart after recovery, early/stale suggestions, caller nested immutability, invalid utterance IDs, Ready impossible states at compile/runtime as practical, active replay offsets, idle fresh-session recovery, aggregate/segment bounds, canned message redaction, and nested deep freezing. Remove assertions that expect ignored events to preserve object identity.

Run package state tests, full G2 tests, package lint, package typecheck, package build, and a no-index/scoped whitespace check that actually inspects these untracked files. Report actual results and `DONE` only if all pass.
