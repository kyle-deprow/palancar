# Phase 0 ADR review handoff (GPT-5.6 Sol)

## Role

Perform a read-only adversarial review of the Phase 0 decision capture. Do not edit files, install dependencies, mutate Azure, or commit.

## Read

- `AGENTS.md`
- `.codex/plans/phase0-sol-handoff.md`
- `docs/phase-0-decisions.md`
- `docs/adr/0001-protocol-v1.md`
- `docs/adr/0003-client-authentication.md`
- `docs/adr/0004-data-retention.md`
- `docs/adr/0005-compute-host.md`
- The authentication, protocol, product-decision, Terraform, and phase sections of:
  - `docs/implementation-plan.md`
  - `docs/real-time-translation-plan.md`

This is an architecture/security review, so use GPT-5.6 Sol judgment. The G2-specific behavior should be checked against the precise split skills named by `AGENTS.md` if needed; there is no aggregate `.agents/skills/even-g2/SKILL.md`.

## Acceptance criteria

1. The ADRs faithfully capture the corrected Phase 0 decision set, mark the
   first-pass `READY` as superseded, and remove the previous query-string ticket
   path.
2. Authentication is implementable in a browser WebView and fails closed: pairing entropy, storage, hashing, rotation, revocation, ticket lifetime/audience, subprotocol selection, atomic consumption, null-origin handling, state outages, and redaction are coherent.
3. Table partition/transaction assumptions needed for exactly-once operations are not contradicted by the docs.
4. Protocol header widths total 30 bytes, endian/sample units are unambiguous, limits cannot overflow, replay/ACK/abort semantics are implementable, and close codes do not conflict.
5. Spanish and Turkish receive identical product/protocol treatment; every session explicitly confirms the target.
6. Palancar-controlled zero content retention is distinguished from Azure provider abuse monitoring, with a realistic pre-real-audio gate.
7. Container Apps is clearly provisional and its promotion/fallback matrix is decisive rather than aspirational.
8. Terraform ownership and dependency order remain acyclic; identity separation and immediate 30-day purge are testable.
9. Cross-document statements do not contradict the accepted values (30-second utterance, 30-minute session, 5-minute inactivity, 500-millisecond replay/in-flight window, 60-second ticket).
10. Deferrals (CI, DNS, private networking, production CIAM, provider selection) do not block a safe development apply and are not accidentally described as complete.

## Output

Group findings as Must-Fix, Should-Fix, and Nits. Include path evidence, impact, and exact correction. End with exactly `READY` if no Must-Fix findings remain, otherwise `NEEDS WORK`.
