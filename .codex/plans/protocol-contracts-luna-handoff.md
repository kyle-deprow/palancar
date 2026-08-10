# Protocol/auth contracts implementation handoff (GPT-5.6 Luna xhigh)

## Scope and role

Implement the first code slice unlocked by the accepted Phase 0 ADRs. You are not alone in the repository; preserve unrelated work and do not revert other edits. Do not commit or mutate Azure.

Allowed edits only:

- `package.json` and `package-lock.json` for the exact dependencies below
- `packages/contracts/**`
- `packages/test-fixtures/package.json`
- `packages/test-fixtures/src/index.ts`
- `packages/test-fixtures/src/protocol.ts` (or an equivalently named single protocol fixture module)
- `packages/test-fixtures/test/protocol-conformance.test.ts`
- `docs/adr/0001-protocol-v1.md` only to correct a provable implementation ambiguity; report any such edit explicitly

Do not edit the language registry behavior, existing language fixtures/tests, apps, infra, or other docs.

## Required reading

- `AGENTS.md`
- `docs/adr/0001-protocol-v1.md`
- `docs/adr/0003-client-authentication.md`
- `docs/phase-0-decisions.md`
- Protocol/auth sections of `docs/implementation-plan.md`
- Current package/build conventions in `packages/language-registry` and `packages/test-fixtures`

## Dependencies

Use exact versions:

- Runtime dependency of `@palancar/contracts`: `@sinclair/typebox` `0.34.52`
- Root dev dependency: `fast-check` `4.9.0`

Do not add Ajv yet; the relay will own Ajv compilation. Use TypeBox `Value.Check` in package-level validation tests/helpers.

## Package and exports

Create private ESM package `@palancar/contracts` version `0.1.0`, exporting compiled `dist/index.js` and `dist/index.d.ts`. Follow strict root TypeScript and lifecycle conventions. A clean install followed independently by root lint, typecheck, test, or build must work without pre-existing ignored `dist` output. Update test-fixtures dependency/lifecycle only as required to consume the built contracts package.

## Protocol constants

Export one immutable source of truth for:

- protocol version `1`
- binary magic `0x5041`
- header bytes `30`
- maximum audio payload `3_200` bytes
- maximum complete binary message `3_230` bytes
- maximum control message `16_384` UTF-8 bytes
- maximum unacknowledged/replay samples `8_000`
- ACK interval `100` ms
- maximum utterance `480_000` original 16 kHz samples / `30_000` ms
- no-new-turn after `1_770_000` ms
- session duration `1_800_000` ms
- inactivity `300_000` ms
- heartbeat interval/grace `20_000`/`10_000` ms
- original-sample token bucket refill/capacity `16_000`/`8_000`
- ticket lifetime `60_000` ms
- pairing lifetime `600_000` ms

Prevent accidental mutation.

## TypeBox schemas and types

Every object schema must use `additionalProperties: false`, bounded strings/arrays, and integer ranges. Export each schema and inferred `Static` type. Do not use an unregistered JSON Schema format; use explicit patterns for UUID, UTC timestamp, version/build strings, language codes, canonical pairing code, and base64url secrets.

Implement at minimum:

### Common

- UUID, UTC timestamp, unsigned-32, positive revision/epoch, wearer language literal `en`, target language union `es | tr`, detected language code, confidence `[0,1]`.
- Negotiated protocol limits. Client-requested/server-effective values may be lower where sensible but never above ADR hard maxima. Keep units in property names.
- Common session negotiation fields: protocol version, wearer language, selected target language, language-registry version, `gatePolicyVersion`, client build, and requested limits.

### Client control messages

- `session.start`: new-session first message with common negotiation only.
- `session.resume`: resume first message with common negotiation plus session ID, session epoch, utterance ID, client last-acknowledged offset, oldest retained offset, and next captured offset.
- `utterance.start`, `utterance.commit`, and `utterance.cancel`; commit/cancel carry the final original-sample offset.
- `session.end` with a bounded reason enum.

### Server control messages

- `session.ready`: assigned session ID/epoch, confirmed target, registry/gate versions, effective limits, server time, and explicit `new` versus `resumed` result. A resumed result includes requested replay offset.
- `session.rejected` with bounded protocol/session rejection codes and display-safe message.
- `utterance.aborted` with explicit non-resumable, flow, duration, rate, cancellation, stale/conflict, provider-loss categories.
- `audio.ack`: session/epoch/utterance, highest contiguous exclusive accepted offset, flow state (`normal | pause | abort`), optional requested replay offset.
- `transcript.partial` and `transcript.final`: stable segment ID, monotonic revision, bounded transcript text, provider event time; final is authoritative but not automatically gate-accepted.
- `language.decision` using exactly `target | mixed | english | supported_unselected | unsupported | uncertain`, selected target, optional detected code/confidence, segment/revision, and gate policy version.
- `translation.ready`: accepted final revision and bounded English translation.
- `suggestions.ready`: accepted final revision and exactly 2 or 3 objects containing bounded English plus selected-target text.
- A typed error envelope with stable bounded code enum, scope, recoverable flag, display-safe message, error ID, and time; no arbitrary details/payload/header fields.

Export discriminated unions for client, server, and all control messages plus reusable `is*/assert*` validation helpers backed by TypeBox Value. Helpers must reject unknown properties.

## HTTPS auth schemas and helpers

Implement TypeBox schemas/types for:

- Pairing redemption request and installation-credential response.
- Session-ticket request with discriminated `new` or exact `resume` intent; resume binds the session ID. Session-ticket response contains the opaque 256-bit ticket, canonical `wss` origin/path, protocol and exact expiry—not a ticket URL.
- Rotation begin response carrying pending credential/version/expiry and rotation confirmation response.
- Generic bounded HTTP error response.

Canonical pairing code pattern: exactly 26 uppercase Crockford Base32 characters, alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, with first character `0` through `7` so exactly 128 bits have one representation. Reject lowercase, separators, aliases, and ambiguous characters.

Installation credential and ticket are 256-bit base64url without padding: exactly 43 characters from `[A-Za-z0-9_-]`. Provide a helper that constructs and validates exactly these two offered WebSocket subprotocol values:

- `palancar.v1`
- `palancar.ticket.<ticket>`

Never construct a URL containing a ticket.

## Binary audio codec

Implement browser-compatible encode/decode helpers using `Uint8Array`/`DataView`, not Node Buffer:

- Header layout exactly `2+1+1+16+4+4+2 = 30` bytes.
- Header numeric fields use big-endian/network byte order; PCM payload bytes are copied unchanged and documented as little-endian S16LE.
- Magic/version/flags (`0` only), canonical UUID bytes, uint32 sequence/offset, exact payload length.
- Payload must be even and 2..3,200 bytes. Complete frame must be at most 3,230 bytes.
- `offset + payloadSamples` must neither exceed uint32 nor 480,000 samples.
- Copy inputs/outputs so caller mutation cannot alter an already encoded/decoded frame.
- Throw/export a typed `AudioFrameError` with stable machine reason for magic, version, flags, UUID, integer, length, odd payload, oversize, and utterance-range failures. It must not include payload content.

Ordering/gap/duplicate state belongs to the later audio/session package; this codec validates one frame only.

## Controlled fixtures and tests

Add typed protocol fixtures under `@palancar/test-fixtures` without altering existing language fixtures:

- At least one valid new-session journey and one valid resumed-session journey.
- A golden minimum binary frame whose exact bytes/hex are asserted.
- A maximum-size valid frame.
- Representative valid final/gate/translation/suggestions events for both Spanish-selected and Turkish-selected sessions.
- No fixture may contain a credential/ticket that resembles a real reusable secret; use clearly synthetic deterministic values and label them controlled.

Tests must prove:

1. Every exported valid control/auth fixture passes the intended schema and rejects the wrong union.
2. Unknown properties, unsupported targets/versions, invalid confidence, invalid revisions/offsets, more/less than 2-3 suggestions, and oversized strings fail.
3. Canonical pairing and base64url rules, including first-character and lowercase/alias/separator rejection.
4. Ticket subprotocol helper returns only the two values and never a query/URL.
5. Golden binary bytes, min/max round trip, copied buffers, every error category, integer boundaries, offset+sample overflow, and malformed declared lengths.
6. Property-based round trips with `fast-check` for valid UUIDs, uint32 sequences, valid offsets/payload sizes that fit the utterance, and arbitrary PCM bytes. Include deterministic seed/reporting and enough runs to exercise boundaries without making tests slow.
7. Header constants recalculate to 30 and maximum frame to 3,230.
8. Spanish/Turkish fixtures are structurally symmetric and use exact decision enum values.

## Verification

Run and report:

- `npm install`
- artifact-free `npm run lint`
- artifact-free `npm run typecheck`
- artifact-free `npm test`
- artifact-free `npm run build`
- Node 22 ESM runtime imports for `@palancar/contracts` and `@palancar/test-fixtures`
- `git diff --check`

Do not report `DONE` with failing checks or unresolved ambiguity. List every changed path, test count, property-test run count/seed behavior, and any residual risk.
