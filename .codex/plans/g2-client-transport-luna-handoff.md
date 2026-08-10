# G2 client relay transport Luna handoff

## Objective

Add a browser-safe relay transport module for `apps/g2-client` that implements the existing Palancar relay protocol over HTTPS ticket fetch plus WebSocket, with deterministic unit tests. This is an isolated transport/effect-runner foundation; do not change the G2 bridge runtime in this slice.

## Files you may change

- `/home/dev/repos/palancar_ws/palancar/apps/g2-client/src/transport/**`
- `/home/dev/repos/palancar_ws/palancar/apps/g2-client/src/transport/index.ts`
- `/home/dev/repos/palancar_ws/palancar/apps/g2-client/test/transport.test.ts`

## Files you must not change

- G2 bridge/display/state source outside `apps/g2-client/src/transport/**`
- Relay app, Terraform, package manifests, lockfiles, docs, build artifacts, `.ehpk`, or any Azure resource

## Requirements

- Use existing contracts only; do not invent protocol messages.
- Use `fetch` to POST `/v1/session-tickets` on a configured HTTPS relay origin.
- Validate ticket response with `assertSessionTicketResponse`.
- Open `new WebSocket(ticket.wssOrigin + ticket.wssPath, createWebSocketSubprotocols(ticket.ticket))`.
- Send `session.start` immediately after WebSocket `open`.
- Build `session.start` from:
  - `PROTOCOL_VERSION`
  - wearer language `en`
  - supplied selected target language
  - `LANGUAGE_REGISTRY_VERSION`
  - supplied gate policy version defaulting to `1.0.0`
  - supplied client build defaulting to `g2-client-dev`
  - `DEFAULT_NEGOTIATED_LIMITS`
- Validate incoming JSON messages with `assertServerControlMessage`.
- Emit state-machine-relevant server events through a callback:
  - `session.ready`
  - `session.rejected`
  - `transcript.partial`
  - `transcript.final`
  - `language.decision`
  - `translation.ready`
  - `suggestions.ready`
  - `utterance.aborted`
  - map server `error` to a local fatal/error event only if the existing client state type supports it; otherwise surface through an `onTransportError` callback.
- Handle `audio.ack` internally by acknowledging the client queue.
- Provide methods:
  - `startSession(targetLanguage): Promise<void>`
  - `startUtterance(utteranceId): void`
  - `pushPcm(pcm: Uint8Array): void`
  - `commitUtterance(): void`
  - `cancelUtterance(): void`
  - `endSession(reason?: 'user_requested' | 'app_shutdown' | 'transport_error'): void`
  - `close(): void`
- Use `ClientRetainedAudioQueue` from `@palancar/audio` when an utterance starts.
- Use negotiated limits from `session.ready` for the queue if present; before ready, do not accept audio.
- Copy PCM chunks before queueing/sending to avoid typed-array backing-buffer aliasing.
- Never send audio if no active utterance, if socket is not open, or after commit/cancel.
- On queue overflow or invalid ack, stop the utterance locally and report via `onTransportError`; do not silently drop PCM.
- Keep browser compatibility. No Node APIs.
- All public values and returned snapshots should be immutable or defensive copies.

## Tests

Add deterministic Vitest tests with fake `fetch` and fake `WebSocket` constructors. Cover at least:

1. Ticket POST path/body and WebSocket subprotocols are correct; `session.start` is sent on open.
2. Incoming `session.ready` is validated and emitted.
3. `startUtterance` sends `utterance.start`; `pushPcm` sends encoded binary frames with increasing offsets; `audio.ack` releases queue state; `commitUtterance` sends final offset.
4. Malformed ticket response or malformed server control message reports `onTransportError` and closes safely.
5. PCM before ready/no utterance and PCM after commit do not send audio.

## Verification

Run:

```bash
npm run test -w @palancar/g2-client
npm run typecheck -w @palancar/g2-client
npm run build -w @palancar/g2-client
```

## Completion report

Return:

- changed files
- exact verification output
- unresolved issues, if any
- final line `DONE` only if complete
