# G2 authentication controller and HTTP client — Luna handoff

## Objective

Implement the browser authentication controller boundary and bounded relay HTTP client from the approved Sol design. This slice owns credential lifecycle logic but does not integrate reducer/runtime/transport/UI.

## Files you may change

- `apps/g2-client/src/auth/types.ts` (new)
- `apps/g2-client/src/auth/http-client.ts` (new)
- `apps/g2-client/src/auth/controller.ts` (new)
- `apps/g2-client/test/auth-http-client.test.ts` (new)
- `apps/g2-client/test/auth-controller.test.ts` (new)

## Read-only dependencies

- `apps/g2-client/src/auth/credential-store.ts`
- `packages/contracts` auth schemas/validators
- ADR 0003

## Files you must not change

- Every other file, including credential-store, package manifests, state, runtime, transport, main, HTML/CSS, relay, docs, and lockfile.
- Do not commit.

## Exact public types

Implement/export the Sol-approved interfaces:

```ts
export type AuthRequiredReason =
  | "missing" | "absolute-expired" | "credential-rejected"
  | "pairing-failed" | "pairing-uncertain" | "revoked"
  | "revocation-unconfirmed";

export type AuthOutcome =
  | { readonly kind: "ready" }
  | { readonly kind: "required"; readonly reason: AuthRequiredReason }
  | { readonly kind: "unavailable" }
  | { readonly kind: "storage-error" };

export interface SessionCredentialLease {
  readonly credential: string;
  readonly credentialVersion: number;
}

export type CredentialAcquisition =
  | { readonly kind: "ready"; readonly lease: SessionCredentialLease }
  | { readonly kind: "required" }
  | { readonly kind: "storage-error" };

export interface SessionCredentialProvider {
  acquire(): Promise<CredentialAcquisition>;
  recordAuthenticated(version: number): Promise<"recorded" | "stale" | "storage-error">;
  reject(version: number): Promise<"required" | "stale" | "storage-error">;
}

export interface G2AuthController {
  initialize(): Promise<AuthOutcome>;
  enroll(pairingCode: string): Promise<AuthOutcome>;
  retryPersistence(): Promise<AuthOutcome>;
  resetEnrollment(): Promise<AuthOutcome>;
  prepareSessionBoundary(options: { readonly allowRotation: boolean }): Promise<AuthOutcome>;
  revokeCurrent(): Promise<AuthOutcome>;
  readonly credentialProvider: SessionCredentialProvider;
  dispose(): void;
}
```

Also export `AuthHttpClient`, `AuthHttpClientError`, `createAuthHttpClient`, controller options, and `createG2AuthController` with injected store/http/clock suitable for deterministic tests.

## HTTP client contract

- Accept exact HTTPS relay origin only: no auth, path, query, fragment, whitespace, or trailing configured slash. Generic configuration error.
- Methods:
  - `ensureRelayAwake(): Promise<void>` GET `/healthz`, exact `{ok:true}`;
  - `redeemPairing(code)` POST exact request and validate `InstallationCredentialResponse`;
  - `beginRotation(credential)` POST `{}` and validate `RotationBeginResponse`;
  - `confirmRotation(credential)` POST `{}` and validate `RotationConfirmationResponse`;
  - `revokeCurrent(credential)` DELETE no body, returns `confirmed` for 204 and `already-invalid` for 401;
  - `dispose()`.
- Every request uses `credentials:"omit"`, `redirect:"error"`, no referrer policy leakage, and a 30-second total AbortController deadline. Inject timeout scheduling/clock if needed for non-sleeping tests.
- JSON requests use exact `content-type: application/json`; bearer requests add exact `Authorization: Bearer <credential>`. Pairing has no bearer.
- Prevalidate pairing/credential canonical grammar with contracts.
- Bound every response body to 16 KiB including chunked streams/content-length; cancel oversized bodies. 204 reads no body.
- Successful `/healthz` may be cached for at most 30 seconds; failures are never cached. Calls after dispose fail closed.
- Pairing redemption is never automatically retried.
- `AuthHttpClientError` exposes only frozen/non-secret category and optional numeric status chosen from `configuration|rejected|conflict|unavailable|protocol|timeout|disposed`; exact fixed messages, no cause/raw response/body/url/secret.
- Distinguish a pairing request that might have reached server (network/timeout/5xx) from a definite 4xx rejection so controller can report uncertain vs failed. A 409 rotation begin is `conflict`.

## Controller record/lifecycle contract

- Use only the existing `CredentialStore`; never localStorage/bridge storage/log/DOM/URL.
- Serialize all mutating controller operations through one internal promise queue; concurrent lifecycle calls cannot race state or grants.
- Keep at most one in-memory record and one one-use credential grant. Returned objects are frozen. Never expose record/installation/credential in outcomes/errors.
- `initialize`:
  - absent => required/missing;
  - absolute expiry `<= now` => clear then required/absolute-expired;
  - valid non-expired => ready;
  - load/corruption/required-clear failure => storage-error.
  - Do not reject solely because local idle expiry elapsed.
- `enroll`:
  - exact canonical pairing only; ensure relay awake before POST;
  - no automatic retry;
  - definite 4xx => required/pairing-failed; ambiguous network/timeout/5xx => required/pairing-uncertain;
  - successful response becomes store record with current rotation due equal initial idle expiry;
  - save before ready; save failure retains exactly that volatile record only for `retryPersistence` and returns storage-error.
- `retryPersistence` saves the same volatile record without another HTTP call; otherwise re-attempts load/initialize safely.
- `resetEnrollment` clears only active record and all grants/volatile state; clear failure => storage-error.
- `prepareSessionBoundary`:
  - fail closed unless initialized ready record exists;
  - always clear an older unconsumed grant first;
  - if pending exists, idempotently confirm it before granting; confirmation response version must equal pending version and immutable absolute expiry exactly;
  - after confirmation, promote local pending to current, conservative idle expiry `min(now+30d, absolute)`, next rotation due same conservative boundary, remove all pending fields, and save before grant;
  - if rotation is allowed and `now >= currentRotationDueAt`, begin rotation. A 409/lost-begin conflict keeps current credential usable and proceeds to grant; a success must save current+pending before confirmation, then confirm and save promoted before grant;
  - derive pending rotation due as `min(now+30d, absolute)` and ensure it obeys credential-store invariants;
  - ambiguous confirmation retains both credentials, returns unavailable, and issues no grant; next boundary retries confirmation;
  - other unavailable operations issue no grant.
  - on success create one-use in-memory grant and return ready.
- `credentialProvider.acquire` atomically consumes the one-use grant. No grant => required. Storage error state => storage-error.
- `recordAuthenticated(version)` only for matching current/granted version: persist conservative idle expiry `min(now+30d, absolute)` before the caller may construct WebSocket; stale mismatch does nothing. Store failure clears grant/enters storage-error.
- `reject(version)` only clears a matching current version from memory/store and returns required; stale mismatch returns stale; clear failure => storage-error.
- `revokeCurrent`:
  - ensure relay awake first;
  - snapshot current credential only in call scope;
  - clear IndexedDB/local/grant before DELETE; if clear fails do not call DELETE and return storage-error;
  - 204 or 401 => required/revoked;
  - network/timeout/5xx after local clear => required/revocation-unconfirmed;
  - drop snapshot regardless.
- `dispose` immediately aborts HTTP, invalidates queue generation/grants/volatile record, closes store, and makes future operations fail closed without unhandled rejection. It never remotely revokes.

## Tests

Use fakes; no live network or real IndexedDB. Cover every branch above, exact request init/URL/body/headers, 16KiB fixed/chunked boundary, timeout/dispose abort, warm cache, no retry, malformed response, secret-free errors, absolute-vs-idle expiry, volatile save retry, begin conflict, pending cold-start confirmation, version/absolute mismatch, ordering of store/HTTP/grant, one-use acquire, concurrent serialization, stale callbacks, rejection, revocation ordering, dispose, and canary absence from error JSON/stacks/outcomes.

## Verification

Run:

```bash
npm run test --workspace @palancar/g2-client -- --run test/auth-http-client.test.ts test/auth-controller.test.ts test/credential-store.test.ts
npm run typecheck --workspace @palancar/g2-client
npm run lint --workspace @palancar/g2-client
```

## Escalation

If this exact behavior requires an out-of-scope change, stop and report. Do not weaken one-use grants or persistence-before-use ordering.

## Completion report

List files, actual checks, and risks. End `DONE` only when complete.
