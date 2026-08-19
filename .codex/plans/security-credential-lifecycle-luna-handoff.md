# Security-state credential lifecycle — Luna handoff

## Objective

Implement the accepted retry-safe credential promotion and credential-authenticated installation revocation semantics identically in the in-memory and Azure Table stores, without changing persisted schema.

## Files you may change

- `packages/security-state/src/types.ts`
- `packages/security-state/src/errors.ts`
- `packages/security-state/src/index.ts`
- `packages/security-state/src/store.ts`
- `packages/security-state/src/azure-store.ts`
- `packages/security-state/test/security-state.test.ts`
- `packages/security-state/test/azure-store.test.ts`
- `packages/security-state/test/azure-store.azurite.test.ts`

## Files you must not change

- Every other file, including Azure schema, contracts, relay, client, package manifests, docs, and environment files.
- Do not commit.

## Required type/API changes

Add `credential-conflict` to `SecurityErrorCategory` with public message `Credential operation conflicted.`

Export these types through `src/index.ts`:

```ts
export interface CredentialPromotionResult extends InstallationMutationResult {
  readonly status: "promoted" | "already-promoted";
  readonly confirmedAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface RevokeCurrentInstallationInput {
  readonly credential: string;
}

export interface InstallationRevocationResult extends InstallationMutationResult {
  readonly status: "revoked" | "already-revoked";
  readonly revokedAt: number;
}
```

Change `SecurityRuntimeStore.promoteCredential` to return `CredentialPromotionResult` and add:

```ts
readonly revokeCurrentInstallation: (
  input: RevokeCurrentInstallationInput,
) => Promise<InstallationRevocationResult>;
```

Preserve existing ID-based `revokeInstallation` behavior/API for operator/internal callers.

## Rotation begin requirements

- Only exact current active credential may begin rotation.
- When an unexpired pending credential already exists, fail with `credential-conflict`, never produce a second pending credential, and never expose/recover pending plaintext.
- Exactly at pending expiry, a replacement may be created and old pending becomes expired.
- Under 100 concurrent calls, exactly one succeeds and all other committed contenders fail `credential-conflict`; outage/transaction boundary errors remain their correct categories.
- Do not change absolute expiry.

## Promotion requirements

- Pending credential atomically promotes to current, retires old current, clears pending fields, touches rolling idle expiry, preserves absolute expiry, and returns `status:"promoted"` plus exact store clock `confirmedAt`, resulting idle expiry, absolute expiry, and any invalidated old-version session.
- A retry using that same now-current credential succeeds with `status:"already-promoted"`, touches idle expiry, and returns the same semantic fields with the current request's store clock.
- Replay success is allowed only when current credential version > 1. Original v1 current credential, retired, pending from another installation/audience, expired, revoked, malformed, and unrelated credentials fail `invalid-credential`.
- Replay must never increment version/tombstone/session epoch or invalidate a session already using the promoted version.
- 100 concurrent confirmations produce one `promoted` and 99 `already-promoted` results (subject only to bounded store contention retries), with one version transition.
- Azure ambiguous-commit reconciliation must return the correct promoted/already status and timestamps without performing a second promotion.

## Credential-authenticated revocation requirements

- `revokeCurrentInstallation({credential})` is one state-store operation, not public authenticate-then-ID-revoke composition.
- First call requires the exact current credential of an active installation; atomically revokes installation/current/pending credentials and opening/active session; increments tombstone once; returns `status:"revoked"`, exact store-clock `revokedAt`, and invalidated session when present.
- A retry using the exact former-current now-revoked credential succeeds as `status:"already-revoked"`, with the persisted revocation timestamp and no mutation/tombstone increment, only while that credential row remains and still matches the installation current hash/version.
- Pending, retired, unrelated revoked, arbitrary, malformed, expired, and wrong-audience credentials fail `invalid-credential`.
- Under 100 concurrent calls, exactly one result is `revoked`, all remaining valid retries are `already-revoked`, tombstone increments exactly once.
- Promotion/revocation races must leave no active old credential or live old-version session.
- Azure ambiguous-commit reconciliation must distinguish committed revocation from an unrelated/rejected state.

## Shared safety requirements

- Preserve strict exact-input-object validation and add tests rejecting extra fields for the new operation.
- Freeze all returned objects including nested invalidated session identity.
- Never retain raw secrets in errors, causes, logs, or enumerable error fields.
- Do not add persisted fields or Table scans. All Azure reads remain exact point reads and writes same-partition exact-ETag transactions.
- Ensure `AzureRuntimeStore` delegates the new method and implements the changed return type.
- Preserve all existing auth/session/rate/generation behavior.

## Tests

Add mirrored local/fake-Azure tests for all requirements, including fake-clock boundaries, 100-way begin/promotion/revocation concurrency, result fields, expiry invariants, wrong audience/state, retry idempotency, revocation with active session, and canary secrecy. Extend Azurite tests with at least first+replay promotion, first+replay revocation, conflict while pending, and active-session invalidation.

## Verification

Run and report actual output:

```bash
npm run test:unit --workspace @palancar/security-state
npm run test:azurite --workspace @palancar/security-state
npm run typecheck --workspace @palancar/security-state
npm run lint --workspace @palancar/security-state
```

## Escalation

If persisted schema or an out-of-scope file appears necessary, stop and report why. Do not weaken retry or concurrency semantics.

## Completion report

List changed files, checks, any remaining risk. End with `DONE` only if complete.
