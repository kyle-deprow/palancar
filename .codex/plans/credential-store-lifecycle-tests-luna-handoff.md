# Credential-store lifecycle review fixes — Luna handoff

## Objective

Close the Sol review coverage gaps for IndexedDB lifecycle/error handlers without changing production behavior unless a new test proves a real defect.

## Files you may change

- `apps/g2-client/test/credential-store.test.ts`
- `apps/g2-client/src/auth/credential-store.ts` only if a newly added deterministic test exposes a production defect

## Files you must not change

- Every other file. Do not commit.

## Requirements

Add deterministic isolated tests for:

- `IDBOpenDBRequest.onblocked` firing before success: the pending operation rejects with exact `CredentialStoreError`, late success closes the database, no canary leaks, and a later operation may cleanly reopen.
- asynchronous `IDBOpenDBRequest.onerror` before success with the same normalization/late-event/reopen guarantees.
- an exception/failure during `onupgradeneeded` causing transaction abort/open failure, generic error, late resource cleanup, and retryability.
- database `onversionchange`: cached database closes, is discarded, and the next operation opens a new connection without using the stale one.

Use deterministic fake request/database objects where `fake-indexeddb` cannot force the event. Assert no credential/platform canary appears in error JSON, stack, or enumerable keys. Preserve all existing 22 tests.

If a test reveals a bug, minimally fix the production file while retaining its public contract and secret-free errors. Do not make speculative refactors.

## Verification

Run:

```bash
npm run test --workspace @palancar/g2-client -- --run test/credential-store.test.ts
npm run typecheck --workspace @palancar/g2-client
npm run lint --workspace @palancar/g2-client
```

## Completion report

List files, test results, and any production fix. End `DONE` only if complete.
