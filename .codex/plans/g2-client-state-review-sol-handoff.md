# G2 client interaction state — Sol review handoff

Perform a read-only adversarial correctness/readiness review of:

- `apps/g2-client/src/state/index.ts`
- `apps/g2-client/test/state.test.ts`
- the requirements in `.codex/plans/g2-client-state-luna-handoff.md`
- relevant contracts/language-registry types

Do not edit files. Ignore unrelated concurrent work.

Review especially:

- discriminated-state/type correctness and whether any aliases weaken the contract;
- registry-driven parity between Spanish and Turkish;
- explicit target confirmation and absence of session/audio effects before readiness;
- valid transition/effect ordering;
- stale session/utterance/segment/revision suppression;
- authoritative final + target decision as the only translation path;
- no generation on every non-target decision;
- duplicate target/translation/suggestion handling;
- suggestions validation and safe result cycling;
- transport recovery semantics, especially whether resuming `Listening` after audio was stopped is coherent;
- fatal/shutdown exact-once cleanup;
- immutable outputs without mutating/freezing caller-owned input objects;
- display-safe bounded error behavior with no unknown payload leakage;
- tests that can pass for the wrong reason or miss realistic protocol events.

Run focused tests and typecheck as appropriate, but do not alter the workspace. Return findings grouped Must-Fix, Should-Fix, Nits with precise file references and suggested fixes. End with exactly `READY` or `NEEDS WORK`; READY means no Must-Fix or Should-Fix remains.
