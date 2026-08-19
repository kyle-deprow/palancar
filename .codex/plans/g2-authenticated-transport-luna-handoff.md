# G2 authenticated ticket transport — Luna handoff

## Objective

Require and consume the controller's one-use credential grant for every relay session ticket, persist authenticated use before WebSocket construction, and surface redacted credential rejection/storage events.

## Files you may change

- `apps/g2-client/src/transport/index.ts`
- `apps/g2-client/test/transport.test.ts`

## Read-only dependencies

- `apps/g2-client/src/auth/types.ts`
- `apps/g2-client/src/state/index.ts`
- `packages/contracts`

## Files you must not change

- Every other file, including auth/controller/store, runtime, state, UI, package files, relay, docs. Do not commit.

## Public/options behavior

- Add required `credentialProvider: SessionCredentialProvider` to `RelayTransportOptions`; constructor rejects a missing/malformed provider generically.
- Extend `RelayTransportCallbackEvent` with the reducer's redacted `credential.rejected` and `credential.storage-error` events. These carry no credential/version/ID/message.
- Never add credentials or credential version to `RelayTransportSnapshot`, errors, URL, body, WebSocket protocols, callback events, logs, or serializable fields.

## Session-ticket ordering

For each `startSession` generation:

1. Validate target/config first.
2. Call `credentialProvider.acquire()` exactly once. It consumes the one-use grant.
3. If required, emit exactly `credential.rejected`, do no fetch/socket, settle safely.
4. If storage-error/throw/malformed acquisition, emit exactly `credential.storage-error`, do no fetch/socket.
5. POST `/v1/session-tickets` with exact JSON request, `credentials:"omit"`, `redirect:"error"`, content type plus exact `Authorization: Bearer <lease credential>`. Credential never enters body/URL.
6. Bound response body to 16 KiB for content-length and chunked body; oversize/malformed is terminal protocol/ticket failure and body is canceled/content-free.
7. After validating successful ticket response, call `credentialProvider.recordAuthenticated(lease.credentialVersion)` and await it before constructing WebSocket.
8. Only `recorded` permits socket construction. `storage-error`/throw emits `credential.storage-error`; `stale` emits `credential.rejected`; discard the unused ticket.
9. Retain only numeric credential version for the live connection, never raw credential.

All stale generation/close races must suppress provider callbacks/events/socket creation exactly as existing source guards suppress transport work.

## Rejection handling

- Ticket HTTP 401: call `provider.reject(version)` exactly once before emitting redacted outcome; `required` -> credential.rejected, `storage-error`/throw -> credential.storage-error, `stale` -> credential.rejected. Do not additionally emit secret-bearing/generic callbacks.
- Ticket 403/409/429/5xx/network/protocol errors do not erase/reject credentials and retain existing recovery classification.
- Post-upgrade close 4401 or server `session.rejected`/error envelope with code `authentication_failed`: detach/clear audio/session first, invoke provider.reject for the live version once per generation, then emit redacted credential event. Avoid duplicate rejection if server message is followed by close.
- 4403/origin rejection, unsupported protocol/target, rate/state/provider errors must not clear the credential.
- Explicit app close/end and transport replacement never call reject and never revoke.
- Clear retained numeric credential version/auth-rejection latch during detach/close.

## Safety/tests

Update all transport constructors/test helpers with deterministic providers. Cover:

- exact acquire/fetch/record/socket ordering;
- one-use acquire and no auth grant paths;
- exact Authorization header plus omit/redirect and absence from URL/body/snapshot/errors/events/JSON/stacks;
- response 16KiB boundaries;
- recordAuthenticated failure/stale/storage and zero socket;
- 401 reject outcomes and no rejection for every other status;
- 4401, auth session rejection/error, duplicate close latch, 4403 non-rejection;
- generation replacement during acquire/fetch/record and no stale callback;
- explicit close/end no rejection;
- provider throw/malformed return normalization and canary secrecy;
- all existing protocol/audio/recovery tests remain green.

## Verification

Run:

```bash
npm run test --workspace @palancar/g2-client -- --run test/transport.test.ts
npm run typecheck --workspace @palancar/g2-client
npm run lint --workspace @palancar/g2-client
```

## Escalation

Stop if another file is required. Do not make credential provider optional or construct sockets before persistence.

## Completion report

List files/checks/risks. End `DONE` only if complete.
