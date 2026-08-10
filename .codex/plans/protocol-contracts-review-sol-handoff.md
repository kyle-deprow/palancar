# Protocol/auth contracts review handoff (GPT-5.6 Sol)

## Role

Perform a read-only adversarial review of the protocol/auth contracts implementation against accepted ADRs 0001 and 0003. Do not edit, install, commit, or mutate Azure.

## Read

- `AGENTS.md`
- `.codex/plans/protocol-contracts-luna-handoff.md`
- `docs/adr/0001-protocol-v1.md`
- `docs/adr/0003-client-authentication.md`
- All root dependency/script changes in the candidate diff
- Every file under `packages/contracts/**`
- Protocol-related changes under `packages/test-fixtures/**`

## Acceptance focus

1. TypeBox schemas are strict at runtime, bounded, discriminated, and match all ADR message families without accepting unknown properties or unsupported versions/languages.
2. `session.start` versus `session.resume` intent, common negotiation, resume offsets, HTTP auth schemas, accepted-final revision binding, and exact language decisions are coherent.
3. Canonical pairing code truly represents 128 bits in one 26-character Crockford form; 256-bit credentials/tickets and subprotocol construction are exact and never form a URL/query ticket.
4. The binary codec is browser-compatible and correct for 30-byte big-endian header plus untouched little-endian PCM, UUID conversion, copying, size/evenness, uint32, and 480,000-sample bounds.
5. Stable errors contain no PCM or sensitive content and ordering/duplicate state is not accidentally claimed by the single-frame codec.
6. Constants are a single immutable source and all units/hard maxima match ADR 0001.
7. Fixtures/tests cover new/resume, Spanish/Turkish symmetry, auth boundaries, strict schema rejection, golden/min/max binary, all error categories, copied buffers, and deterministic property tests that can catch codec faults.
8. Public runtime exports work from a clean clone; dependency lifecycle does not rely on ignored artifacts or create recursion.
9. Existing language fixtures/tests remain intact and no secret, real credential, generated output, unsafe range, or unrelated architecture was introduced.

Independently run safe checks/probes as useful. Group findings as Must-Fix, Should-Fix, and Nits with path evidence, impact, and exact correction. End exactly `READY` when no Must-Fix remains, otherwise `NEEDS WORK`.
