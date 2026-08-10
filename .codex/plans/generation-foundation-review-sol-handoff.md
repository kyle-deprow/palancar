# Generation foundation — Sol review handoff

Perform a read-only adversarial code/security/readiness review of:

- `packages/generation/**` excluding generated/ignored `dist` and `node_modules`;
- `.codex/plans/generation-foundation-luna-handoff.md`;
- relevant contracts and language-registry boundaries;
- the generation workspace entry in `package-lock.json`.

Do not edit files. Ignore unrelated concurrent G2 state work.

Review especially:

- whether only an authoritative accepted final `target` turn can cross the service boundary, including resistance to forged/cross-package objects;
- whether translation and suggestions are truly separate calls and suggestions require a matching service-produced translation;
- correlation checking across session/epoch/utterance/segment/revision/target;
- runtime validation and deep defensive copying/freezing of all inputs/outputs;
- exact 2–3 suggestion validation and bounds matching protocol contracts;
- concurrent/repeated request deduplication, rejected-call retry, cache poisoning, races, and memory lifecycle;
- provider error redaction and absence of conversation text/provider messages in public errors or telemetry;
- evidence timing/category accuracy, immutability, and content-free records;
- deterministic mock fidelity and whether tests can pass for incorrect production behavior;
- Spanish/Turkish parity with no language-specific branch;
- package typing, lint, build, and lock coherence.

Run focused checks as useful. Return findings ordered Must-Fix, Should-Fix, Nits with exact references and concrete fixes. End with exactly `READY` or `NEEDS WORK`; READY means no Must-Fix or Should-Fix remains.
