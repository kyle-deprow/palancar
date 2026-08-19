# Relay auth routes, CORS, and socket invalidation — Luna handoff

## Objective

Integrate the accepted origin policy and retry-safe security-state credential lifecycle into the relay host: complete browser CORS/preflight enforcement, three credential lifecycle routes, WebSocket Origin rejection before ticket consumption, and synchronous known-session invalidation.

## Files you may change

- `apps/relay/src/host.ts`
- `apps/relay/test/relay-host.test.ts`

## Read-only dependencies

- `apps/relay/src/origin-policy.ts`
- `packages/contracts/src/auth.ts`
- `packages/contracts/src/validation.ts`
- `packages/security-state/src/types.ts`
- ADR 0003

## Files you must not change

- Every other file. Do not edit origin-policy, contracts, security-state, package files, Terraform, client, docs, or commit.

## Configuration

- Add `browserOriginPolicy: BrowserOriginPolicy` to `RelayHostConfig`.
- `parseRelayHostConfig` must call `parseBrowserOriginPolicy(env)` and include the frozen result. Any invalid policy remains wrapped by exact generic relay config error.
- Direct `createRelayHost` calls may default to the fail-closed frozen `{allowedOrigins:[],allowNullOrigin:false}` so existing originless test tooling remains functional.

## Paths and methods

Preserve existing paths and add:

- `POST /v1/credential-rotations`: exact JSON `{}`, bearer current credential, call `beginCredentialRotation`, 200 validated `RotationBeginResponse`.
- `POST /v1/credential-rotation-confirmations`: exact JSON `{}`, bearer pending/current-v>1 credential, call `promoteCredential`, 200 validated `RotationConfirmationResponse` where `confirmedAt` and immutable absolute `expiresAt` come directly from store result.
- `DELETE /v1/installations/current`: no body and exact current/former-current retry bearer, call `revokeCurrentInstallation`, then 204 with no content-type/body/content-length.
- Existing pairing/session-ticket behavior stays intact. Recognized paths with wrong methods return 405 and exact `Allow`.
- Rename body limit internally if useful; all JSON auth bodies stay <=4096 bytes, exact application/json content type, generic 400/413 failures, no raw values.
- Map `credential-conflict` to 409. Preserve all existing mappings.

## Origin/CORS ordering and exact behavior

- Evaluate actual-request Origin before content type/body/bearer/state access.
- `originless` requests remain allowed for trusted operations tooling and receive no ACAO.
- Rejected Origin returns generic 403/no-store before any security call.
- Allowed actual browser responses, success and failure, include exact `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`, `Cache-Control: no-store`. Never wildcard, cookie credentials, reflected rejected values, or multiple ACAO.
- `OPTIONS` is supported only on the five auth endpoints and requires an allowed non-originless Origin.
- Exact preflight metadata:
  - pairing redemption: method POST, headers Content-Type;
  - session tickets, rotation begin, rotation confirmation: method POST, headers Authorization and Content-Type;
  - installation delete: method DELETE, header Authorization.
- Parse requested headers as case-insensitive comma tokens, but reject empty/duplicate/unlisted tokens and any other request metadata. Require exact route method. Return 204 with no body and `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods` (only route method), `Access-Control-Allow-Headers` (canonical allowed list), `Cache-Control:no-store`, and `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers`.
- Invalid preflight is generic 400/no-store and must not call security state.
- WebSocket upgrade evaluates Origin before `prepareStreamUpgrade`; rejected returns generic HTTP 403 and does not consume/burn ticket. Originless and exact allowed/null-per-policy proceed.

## Rotation/revocation session invalidation

- Index live connections by installation ID using exact `SessionLease` identity; preserve the existing all-connections set for shutdown if useful.
- Extend pending-upgrade tracking with prepared lease identity/state. Associate immediately after ticket consumption and before `handleUpgrade`; transfer to live index without an authorization gap.
- Maintain process-lifetime in-memory gates:
  - revoked installation IDs;
  - minimum credential version per promoted installation.
- Check gates before upgrade preparation and again after ticket consumption/before 101. A delayed prepared upgrade for a revoked installation or older credential version returns 401 and never upgrades.
- After a newly promoted result: install minimum version; reject matching stale prepared upgrades; synchronously `core.close()` and close only live connections for that installation whose credential version is older. `already-promoted` must not close valid new-version sessions.
- After either newly/already revoked result: install revoked gate; reject every prepared upgrade; synchronously `core.close()` all live connections for installation and close with 4401 reason `authentication_failed`.
- Before sending HTTP success, wait for affected sockets to close for a bounded maximum 1000 ms, then terminate any remaining. Provider/transcription cancellation via `core.close()` must occur before the success response.
- Avoid race gaps: a ticket consumption promise resolving after durable promotion/revocation must hit the in-memory gate.
- Cleanup every index/gate-owned transient and timer on socket close/host stop; process-lifetime durable gates remain until host disposal.

## Response safety

- All auth responses/failures use no-store.
- 204 has no body.
- Never expose credentials/tickets/pairing text in errors, JSON failure, headers other than the intended Authorization request and ticket response, close reason, stack assertions, or test diagnostics.

## Tests

Add focused host tests for:

- config parse defaults/valid/invalid origin policy;
- each route success shape/status/no-store and all bearer/body/method/error mappings;
- lost-response retries for confirmation and deletion;
- CORS actual response and exact preflight matrix, null flag, originless tools, rejected/multiple/malformed origins/headers;
- prove origin rejection/preflight performs zero state calls;
- prove rejected WSS origin does not burn ticket, allowed/originless behavior works;
- old-version socket closes before confirmation response while promoted-version socket remains on retry;
- revocation closes all matching sockets/provider work before response but not other installations;
- prepared-upgrade races cannot produce 101 after promotion/revocation;
- canary secrets absent from responses/errors/close reasons;
- existing readiness, pairing, ticket, protocol, audio, shutdown tests remain green.

## Verification

Run and report:

```bash
npm run test --workspace @palancar/relay -- --run test/origin-policy.test.ts test/relay-host.test.ts
npm run typecheck --workspace @palancar/relay
npm run lint --workspace @palancar/relay
```

## Escalation

If required dependency APIs differ from the accepted contract or another file is needed, stop and report. Do not bypass state operations, weaken origin ordering, or omit race tests.

## Completion report

List files, actual checks, and remaining risks. End with `DONE` only if complete.
