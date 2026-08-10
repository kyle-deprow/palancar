# Luna fix handoff: transcription foundation

Fix every Sol finding in `packages/transcription/**` only. Preserve active G2
and all other work; no npm install/package-lock/root edits, commit, provider
calls, or Azure mutation.

1. Make capabilities executable. Add validated per-session configuration for
   advertised server VAD mode, language mode, and manual commit cadence.
   `enabled` VAD may auto-finalize at the deterministic script threshold;
   `disabled` must never auto-finalize and requires explicit finalize. Validate
   cadence membership and language-mode support; make selected modes observable
   in immutable session configuration. Do not claim provider behavior beyond
   what the mock executes.
2. Make resampling adapter-owned. Remove public caller resampler injection from
   `CreateTranscriptionSessionInput`; mock internally constructs the native-rate
   identity resampler consistent with capabilities. Any future adapter owns its
   own factory. With no injectable throwing resampler, document/test identity
   reset at terminal/new turn.
3. Fully validate normalized event extensions at runtime: finite bounded
   confidence, nonempty/bounded detected language and detector version, exact
   allowed evidence source and finalization reason, uint offsets, session/epoch/
   utterance/segment/revision bindings. Require nondecreasing original accepted
   offsets across revisions and never above the session high-water mark. Return
   a defensive recursively frozen copy; caller mutation must not affect it.
4. Catch `onEvent` failures after committed mutation so command results remain
   deterministic and retry-safe. Expose a content-free typed delivery-failure
   count/status or callback; if a failure hook throws, contain it too. Never log
   or persist event text. Add throwing-callback regressions.
5. Upgrade fast-check lifecycle to a reference model asserting result/state/
   offset/terminal invariants after every command. Add cyclic metadata,
   extension invalidity, offset regression, immutable input, mode/cadence
   selection, and reject-without-mutation tests. Run all mock language evidence
   categories through the real language gate symmetrically for es/tr; assert
   only accepted target finals could authorize downstream work and partials
   never do. Use >=200 runs with recorded seeds.

Run package lint/typecheck/tests/build, Node ESM import, diff check, and report
test counts/seeds/files/API changes. End DONE only when all findings close.
