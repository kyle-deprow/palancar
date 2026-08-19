# Security credential lifecycle Sol review fixes — Luna handoff

## Objective

Fix every Must-Fix/Should-Fix from the independent Sol review of the retry-safe credential lifecycle and add the missing mirrored acceptance evidence.

## Files you may change

- `packages/security-state/src/store.ts`
- `packages/security-state/src/azure-store.ts`
- `packages/security-state/test/security-state.test.ts`
- `packages/security-state/test/azure-store.test.ts`
- `packages/security-state/test/azure-store.azurite.test.ts` only if needed for a regression test

## Files you must not change

- All other files, including types/errors/index/schema/contracts/relay/client/package/docs. Do not commit.

## Must-Fix 1: Azure ambiguous identity

- Generate one unique operation identity before the retry loop for each Azure `promoteCredential` and `revokeCurrentInstallation` invocation, using the existing approved ID factory/canonical hashing convention.
- In the first promotion/revocation transaction, write that exact identity to the already-existing optional session-row `lastOperationId` field. This is not a schema migration.
- Ambiguous reconciliation must point-read the session row and return first-operation status (`promoted`/`revoked`) only when `lastOperationId` exactly matches this invocation, in addition to all state/version/time/hash checks.
- If durable resulting state exists but operation ID differs, retry through the normal loop and return `already-promoted`/`already-revoked`; never claim another operation's commit.
- Preserve the same operation ID across CAS retries for one invocation.
- Add fake-Azure ambiguity-before-commit contention tests where another operation commits at the same fake clock timestamp and the tested operation receives ambiguous before its own write. Prove exactly one first status and the other replay status. Preserve committed-ambiguity tests.
- Assert transaction composition includes exact session ETag/replacement and operation ID for both operations.

## Must-Fix 2: missing mirrored matrix

Add local and fake-Azure tests (shared helpers/tables allowed) covering both lifecycle operations as applicable:

- pending replacement exactly at expiry and old pending row retired/expired without a second unexpired secret;
- reject v1 current confirmation, pending/current misuse, retired, expired, revoked, malformed, unrelated, and wrong-audience credentials;
- exact idle and absolute expiry boundaries, and new idle expiry capped at absolute expiry;
- promotion racing `revokeCurrentInstallation` (not ID-based revocation) leaves no active old credential/session and yields only valid terminal outcomes;
- ambiguous replay and ambiguity-before-commit contention;
- exact operation-specific rows/ETags;
- credential canaries absent from serialized errors, stacks, snapshots/results, and boundary diagnostics.

Use existing test-only snapshots/fixtures without adding production inspection APIs. Keep tests deterministic and avoid sleeps.

## Should-Fix

- In local `beginCredentialRotation`, detect an unexpired pending credential during preflight before generating/hashing a candidate token; retain the transactional conflict recheck.
- Add a token-factory call-count test proving existing pending conflict consumes no randomness and returns `credential-conflict` even if the next token source would fail.
- Replace the local all-session scan on already-revoked retry with a bounded lookup if existing installation/session bookkeeping permits it without schema/API changes. If the installation intentionally clears its active session ID, a small private map keyed by installation may be added only if maintained atomically; otherwise document in report why a safe bounded change was not possible and leave as nit.

## Safety

- No new persisted field; `lastOperationId` already exists.
- No Table/list scans or wildcard ETags.
- Preserve exact input validation/frozen results/error categories and all existing behavior.
- Ensure operation IDs and credentials never appear in public errors.

## Verification

Run:

```bash
npm run test:unit --workspace @palancar/security-state
npm run test:azurite --workspace @palancar/security-state
npm run typecheck --workspace @palancar/security-state
npm run lint --workspace @palancar/security-state
```

## Completion report

List exact fixes/tests/check output and any remaining nit. End `DONE` only if every Must/Should item is complete.
