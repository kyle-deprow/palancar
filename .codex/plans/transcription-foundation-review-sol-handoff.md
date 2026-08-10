# Sol review handoff: transcription foundation

Read-only adversarial review of uncommitted `packages/transcription/**` against
`.codex/plans/transcription-foundation-luna-handoff.md`, ADR 0004, the Phase 3
plan, and existing contracts/audio/language APIs. Ignore active G2 changes.
Do not edit/install/commit/call Azure.

Check lifecycle/idempotence/no-late-events, exact original offsets and no
mutation on rejection, buffer-subclass copies, resampler reset, limits,
revision/identity stale protection, symmetric Spanish/Turkish and every gate
category, provider capability honesty, deep metadata allow-list/privacy
canaries/cycles/binary/unknown fields, deep immutability, JSONL safety, typing,
and property-model strength. Verify the mock does not imply Azure readiness or
allow generation from partials. Parent package typecheck/31 tests/build passed;
reported fast-check seeds 20260810 and 715123420 at 250 runs.

Return Must-Fix/Should-Fix/Nits with file-line evidence and end READY,
NEEDS WORK, or MAJOR ISSUES.
