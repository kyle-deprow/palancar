# Sol review handoff: audio stream core

Perform an adversarial, read-only code review of the uncommitted
`packages/audio/**` slice and its package-lock change against:

- `.codex/plans/audio-core-luna-handoff.md`
- `docs/adr/0001-protocol-v1.md`
- relevant audio/client/relay requirements in `docs/implementation-plan.md`
- `.agents/skills/g2-events-input/SKILL.md`
- the public codec/limits in `packages/contracts/**`

Do not edit files, install dependencies, commit, or mutate Azure. Ignore the
separate active Azure/Terraform state and review only the audio slice.

Check correctness and failure behavior for arbitrary byte partitions,
zero-offset and non-zero-offset views, trailing-byte carry/flush/reset,
payload/utterance/sequence integer bounds, atomic queue overflow, negotiated
limits, stale/interior/future ACKs, exact replay and inclusive empty replay,
byte-identical retained frames, client reset, exact versus conflicting relay
duplicates, gap/overlap/wrong utterance/stale-window behavior, bounded memory,
forward/charge idempotence, resampler ownership/aliasing, ESM exports, strict
typing, and property-test quality. Challenge the stated interior-ACK choice:
replaying a whole covering wire frame from an interior requested sample must
not violate the server's requested-offset semantics or silently duplicate a
prefix unless the API makes the distinction explicit and safe.

Parent verification passed lint, strict typecheck, 65 tests (17 audio), build,
Node 22 ESM import, and `git diff --check`.

Return findings grouped as Must-Fix, Should-Fix, and Nits with file/line
evidence and concrete remediation. End exactly `READY`, `NEEDS WORK`, or
`MAJOR ISSUES`.
