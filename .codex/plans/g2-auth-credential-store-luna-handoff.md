# G2 authentication credential store — Luna handoff

## Objective

Implement the browser-only IndexedDB persistence boundary required by ADR 0003 for one active Palancar installation credential record.

## Files you may change

- `apps/g2-client/src/auth/credential-store.ts` (new)
- `apps/g2-client/test/credential-store.test.ts` (new)
- `apps/g2-client/package.json`
- `package-lock.json`

## Files you must not change

- Every other file in the repository.
- Do not edit ADRs, transport, runtime, state, HTML, CSS, relay, Terraform, or environment files.
- Do not commit.

## Required public contract

Export these exact constants:

- `CREDENTIAL_DATABASE_NAME = "palancar-auth"`
- `CREDENTIAL_DATABASE_VERSION = 1`
- `CREDENTIAL_OBJECT_STORE_NAME = "installation"`
- `ACTIVE_INSTALLATION_KEY = "active"`

Export these exact interfaces/types:

```ts
export interface StoredInstallationCredential {
  readonly key: "active";
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly currentCredential: string;
  readonly currentCredentialVersion: number;
  readonly currentRotationDueAt: string;
  readonly pendingCredential?: string;
  readonly pendingCredentialVersion?: number;
  readonly pendingCredentialExpiresAt?: string;
  readonly pendingRotationDueAt?: string;
}

export interface CredentialStore {
  load(): Promise<StoredInstallationCredential | undefined>;
  save(record: StoredInstallationCredential): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

export interface CredentialStoreOptions {
  readonly indexedDB?: IDBFactory;
}

export class CredentialStoreError extends Error {}

export function createCredentialStore(options?: CredentialStoreOptions): CredentialStore;
```

## Requirements

- Use IndexedDB only. Never touch localStorage, Even bridge storage, cookies, URLs, logs, console, or diagnostics.
- Database version 1 creates exactly one object store named `installation` with `keyPath: "key"`.
- `load` reads only key `active`; `save` upserts one record; `clear` deletes only key `active`; `close` is idempotent.
- Lazily open and reuse one database connection. Handle `onblocked`, `onerror`, failed upgrades, and version changes without leaking raw DOMException messages or record data.
- Every public failure must reject with `CredentialStoreError` whose exact message is `Credential storage unavailable`; no `cause` or credential-bearing fields.
- Strictly validate records both before save and after load:
  - exact enumerable own keys only; plain object prototype only;
  - exact key/schema literals;
  - canonical UUID v4 installation ID;
  - current and pending credentials use the canonical 43-character unpadded base64url secret grammar exported by `@palancar/contracts` validation;
  - positive safe-integer versions;
  - UTC timestamps are canonical ISO strings accepted by contract timestamp validation or equivalently `new Date(value).toISOString() === value`;
  - `idleExpiresAt <= absoluteExpiresAt` and `currentRotationDueAt <= absoluteExpiresAt`;
  - pending fields are all-present or all-absent; when present, pending version is exactly current+1, pending expiry is not after absolute expiry, and pending rotation due is not before pending expiry or after absolute expiry.
- Clone and freeze the object returned by `load`; do not return the IndexedDB-owned mutable object.
- `save` must store a clone rather than caller-owned mutable state.
- If IndexedDB is absent, opening fails, a transaction aborts, or loaded data is malformed, fail closed with `CredentialStoreError`.
- Pin `fake-indexeddb` exactly to `6.2.5` as a dev dependency for deterministic Node tests. Update the root lockfile with npm, without changing unrelated dependency versions.
- Tests must cover database/store creation, round trip, cloning/freezing, replacement, clear, close/reopen, malformed save rejection, malformed loaded data rejection, absent IndexedDB, transaction/open failure normalization, all-or-none pending fields, timestamp/version relationships, and prove canary credential text is absent from serialized error objects and stacks.
- Keep the implementation browser-compatible and strict-TypeScript clean.

## Verification

Run and report actual output from:

```bash
npm run test --workspace @palancar/g2-client -- --run test/credential-store.test.ts
npm run typecheck --workspace @palancar/g2-client
npm run lint --workspace @palancar/g2-client
```

## Escalation

If this exact contract cannot be implemented without changing an out-of-scope file, stop and report the blocker. Do not broaden scope or invent a different persistence model.

## Completion report

List changed files, test/typecheck/lint results, and unresolved risks. End with `DONE` only if all requirements and checks pass.
