# Luna implementation handoff: relay HTTP/WebSocket host

## Objective

Add a bounded local-development HTTP/WebSocket host around the reviewed `RelaySessionCore`. This slice must make `apps/relay` runnable as a process, expose health/readiness, issue single-use development tickets, perform authenticated WebSocket upgrades with the reviewed subprotocol/ticket path, and drive `RelaySessionCore` over text/binary WebSocket messages.

This is still a synthetic/local host. Do not add Azure Table Storage, real credentials, Foundry adapters, Terraform, Docker, Fastify, durable resume, production auth, or deployment code in this slice.

## Files you may change

- `apps/relay/package.json`
- `apps/relay/src/index.ts`
- `apps/relay/src/host.ts`
- `apps/relay/src/dev-auth.ts`
- `apps/relay/src/main.ts`
- `apps/relay/test/relay-host.test.ts`
- `apps/relay/src/types.ts`
- `package-lock.json`

## Files and actions you must not change

- Do not edit `apps/relay/src/session.ts`, `apps/relay/src/protocol.ts`, or `apps/relay/test/relay-core.test.ts`.
- Do not edit root `package.json`, other apps/packages, docs, infra, generated `dist`, or prior plan files.
- Do not commit.
- Do not contact Azure, run Terraform, create containers, or open external network listeners in tests.

## Dependencies

Update `apps/relay/package.json`:

- Add dependency `"ws": "8.21.3"`.
- Add devDependency `"@types/ws": "8.18.1"`.
- Add devDependency `"@types/node": "22.20.1"`.
- Add script `"start": "node dist/main.js"`.
- Keep existing scripts and internal dependency versions.

Run `npm install --ignore-scripts` after manifest update so the new packages are actually available for checks, then keep the resulting lockfile changes.

## Required public API

### `src/dev-auth.ts`

Implement and export:

```ts
export interface DevelopmentTicketStoreOptions {
  readonly clock?: () => number;
  readonly ticketLifetimeMs?: number;
}

export interface IssueDevelopmentTicketInput {
  readonly intent: RelayTicketIntent;
  readonly audience: RelayUpgradeAudience;
  readonly installationId?: string;
  readonly credentialVersion?: number;
}

export class DevelopmentTicketStore implements TicketConsumer {
  constructor(options?: DevelopmentTicketStoreOptions);
  issue(input: IssueDevelopmentTicketInput): { readonly ticket: string; readonly expiresAt: string };
  consume(ticket: string, audience: RelayUpgradeAudience): Promise<TicketConsumeResult>;
  get size(): number;
}
```

Use the existing `TicketConsumer`, `RelayTicketIntent`, and `RelayUpgradeAudience` types. Add and export `TicketConsumeResult` from `src/types.ts` if needed without changing existing behavior:

```ts
export type TicketConsumeResult =
  | { readonly status: 'accepted'; readonly claim: ConsumedRelayTicket }
  | { readonly status: 'rejected'; readonly reason: TicketConsumeFailureReason };
```

Behavior:

- Generate 256-bit base64url tickets using Node `crypto.randomBytes(32).toString('base64url')`. Validate generated tickets with `assertBase64UrlSecret`.
- Store only in memory.
- `issue` defaults `installationId` to a deterministic development UUID and `credentialVersion` to `1`.
- Store the exact audience and intent with an expiry. Default lifetime is `60_000` ms.
- `consume` is atomic single-use:
  - missing/unknown/previously consumed ticket -> `authentication_failed`;
  - expired ticket -> delete and `ticket_expired`;
  - audience mismatch on environment/origin/path/protocol -> delete and `origin_rejected`;
  - accepted -> delete and return `accepted` claim.
- Never expose ticket values in errors.

### `src/host.ts`

Implement and export:

```ts
export interface RelayHostConfig {
  readonly environment: string;
  readonly origin: string;
  readonly port: number;
  readonly gatePolicyVersion: string;
  readonly ticketStore?: DevelopmentTicketStore;
  readonly clock?: RelayClock;
  readonly ids?: RelayIdGenerator;
  readonly transcriptionAdapter?: TranscriptionAdapter;
  readonly generationService?: GenerationService;
}

export interface RelayHost {
  readonly server: import('node:http').Server;
  readonly ticketStore: DevelopmentTicketStore;
  start(): Promise<{ readonly port: number }>;
  stop(): Promise<void>;
}

export function createRelayHost(config: RelayHostConfig): RelayHost;
export function parseRelayHostConfig(env?: NodeJS.ProcessEnv): RelayHostConfig;
```

Host behavior:

- Use Node `http` and `ws` `WebSocketServer` with `{ noServer: true, perMessageDeflate: false }`.
- Set `maxPayload` to `MAX_CONTROL_MESSAGE_BYTES` from `@palancar/contracts` because `ws` applies it to both text and binary messages. Keep binary-message limits enforced by `RelaySessionCore`.
- Configure `WebSocketServer` `handleProtocols` to select and return only `palancar.v1`. Because `prepareStreamUpgrade` already rejected invalid offers before `handleUpgrade`, `handleProtocols` must never return the ticket-bearing protocol.
- Do not use query-string tickets.
- Endpoints:
  - `GET /healthz` -> `200` JSON `{"ok":true}`.
  - `GET /readyz` -> `200` JSON `{"ready":true}`.
  - `POST /v1/session-tickets` -> development ticket endpoint.
  - `GET /v1/stream` -> WebSocket upgrade only.
  - Everything else -> `404` generic JSON.
- `POST /v1/session-tickets`:
  - Only accepts JSON bodies up to 4096 UTF-8 bytes.
  - Request body shape:
    - `{ "protocolVersion": 1, "intent": "new" }`
    - `{ "protocolVersion": 1, "intent": "resume", "sessionId": "<uuid>" }`
  - Validate the parsed body with existing `assertSessionTicketRequest`, then map to `RelayTicketIntent`.
  - Issue a development ticket bound to exact audience `{ environment, origin, path: "/v1/stream", protocol: "palancar.v1" }`.
  - Response `200` JSON:
    ```json
    {
      "ticket": "<ticket>",
      "wssOrigin": "<origin>",
      "wssPath": "/v1/stream",
      "protocolVersion": 1,
      "expiresAt": "<utc>"
    }
    ```
  - Validate response with existing `assertSessionTicketResponse`.
  - Because `assertSessionTicketResponse` requires canonical `wss://`, the configured `origin` remains an external advertised `wssOrigin`; local tests still connect to the plaintext loopback server using its actual `ws://127.0.0.1:<port>` listener and the ticket-bearing protocols from this response.
  - Malformed body -> `400` generic JSON; body too large -> `413`; wrong method -> `405`.
- Upgrade path:
  - Only `GET /v1/stream` may upgrade. Wrong path rejects before upgrade with generic `404`.
  - Parse offered subprotocols from `Sec-WebSocket-Protocol` by comma trimming.
  - Call `prepareStreamUpgrade` with the exact ticket store and audience before `handleUpgrade`.
  - If rejected, write a generic HTTP response with that status and destroy the socket.
  - If accepted, call `handleUpgrade`, then emit connection with selected protocol exactly `palancar.v1`. Never echo the ticket-bearing subprotocol.
- WebSocket connection behavior:
  - Construct one `RelaySessionCore` per accepted socket with the consumed ticket claim.
  - Use injected clock/ids/transcription/generation defaults if not provided:
    - clock from system time;
    - IDs from `crypto.randomUUID()`;
    - transcription adapter `new DeterministicMockTranscriptionAdapter({ evidenceCategory: "selected-target" })`;
    - generation service with deterministic mock provider returning bounded Spanish/Turkish-compatible suggestions.
  - First text message goes to `openWithFirstText`.
  - Later text messages go to `handleText`.
  - Binary messages go to `handleBinary`.
  - Use a serialized per-socket async work queue so message handling and transcription-event drains cannot overlap or reorder output.
  - After every handler result, send each outgoing message as JSON text, then close with result close code/reason if present.
  - After binary/text handling, call `drainTranscriptionEvents()` only when the socket is still open and the previous handler did not request close.
  - Because adapter callbacks can arrive asynchronously without a new inbound WebSocket message, the transcription adapter passed to `RelaySessionCore` must wrap `onEvent` so it schedules the same serialized drain queue as a wake-up. Do this by injecting a small host-local adapter wrapper that delegates to the configured adapter and wraps the `createSession` callback; do not change `RelaySessionCore`.
  - For `ws`, text arrives as `RawData` with `isBinary === false`. Convert `Buffer`/`ArrayBuffer`/views to UTF-8 string with `Buffer.from(data).toString('utf8')`. Invalid UTF-8 is handled by `ws`; do not promise an application-level `1003` for it. If `isBinary` is false and the data shape cannot be converted, close `1003`.
  - On socket close/error, call `core.close()` once.
  - Do not log raw message bodies, tickets, transcripts, translations, suggestions, or provider errors. Error responses and close reasons must be canned and must not include those values. Successful protocol payloads necessarily include transcripts/translations/suggestions and are allowed.
  - `stop()` must close the HTTP server, close every active WebSocket with code `1001` and reason `server_shutdown`, call `core.close()` through the socket close path, and resolve after sockets/server are closed.
- For tests, `createRelayHost({ port: 0, ... }).start()` must return the actual OS-assigned port.

### `src/main.ts`

Implement CLI entrypoint:

- `const host = createRelayHost(parseRelayHostConfig(process.env));`
- Start the host and write one content-free startup line to stdout: `relay listening on <port>`.
- Handle `SIGTERM` and `SIGINT` by stopping the host then exiting.
- On startup failure, write a generic message to stderr and exit `1`.

### `parseRelayHostConfig`

Read:

- `PALANCAR_RELAY_ENVIRONMENT`, default `dev-local`;
- `PALANCAR_RELAY_ORIGIN`, default `wss://127.0.0.1:<port>` when `PORT` is nonzero, otherwise `wss://127.0.0.1`;
- `PORT`, default `8787`;
- `PALANCAR_GATE_POLICY_VERSION`, default `1.0.0`.

`PALANCAR_RELAY_ORIGIN` must be a canonical credential-free `wss://` origin accepted by `assertSessionTicketResponse`; it may not contain path, query, fragment, username, or password. Local tests may connect to the loopback test server with `ws://127.0.0.1:<actualPort>` while the issued ticket remains bound to the configured external `wssOrigin`.

## Required tests

Add focused Vitest tests in `apps/relay/test/relay-host.test.ts`.

Minimum cases:

1. `GET /healthz` and `GET /readyz` return generic JSON success.
2. `POST /v1/session-tickets` issues a valid ticket response for `{ "protocolVersion": 1, "intent": "new" }`.
3. malformed ticket request returns generic `400`; oversized body returns `413`; wrong method returns `405`.
4. Ticket consume is single-use: first matching audience consumes accepted, second consume returns `authentication_failed`.
5. Expired ticket returns `ticket_expired`; audience mismatch returns `origin_rejected` and burns the ticket.
6. Upgrade with missing/malformed/duplicate protocols rejects before WebSocket acceptance and does not consume invalid tickets.
7. Successful WebSocket connection selects only `palancar.v1`, not the ticket protocol, including when the ticket protocol is offered first.
8. WebSocket first `session.start` receives `session.ready`; binary audio during an utterance receives `audio.ack`; enough contiguous audio for the deterministic mock thresholds plus commit/drain eventually yields transcript/language/translation/suggestions. Use encoded protocol frames with contiguous sequence/offset; do not bypass the binary contract.
9. Reusing the same ticket for a second WebSocket fails before upgrade.
10. No error response, log-observable close reason, or provider-failure response includes a canary ticket/body/provider error string. Do not assert that successful transcript/translation/suggestion payloads omit their legitimate content.
11. Asynchronous adapter callback events are sent without requiring another inbound WebSocket message.
12. `stop()` closes active sockets and the HTTP server.

Use local loopback `127.0.0.1` with `port: 0`; do not contact external services.

## Verification

Run and report actual outputs:

- `npm install --ignore-scripts`
- `npm run lint -w @palancar/relay`
- `npm run typecheck -w @palancar/relay`
- `npm run test -w @palancar/relay`
- `npm run build -w @palancar/relay`
- `git diff --check -- apps/relay package-lock.json`

## Completion report

List changed files, verification outputs, unresolved risks. End with `DONE` only if complete.
