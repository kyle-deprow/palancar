# ADR 0001: Palancar protocol v1

Status: Accepted

Date: 2026-08-09

## Context

The Even App WebView sends variable G2 PCM callbacks to a relay over a browser
WebSocket. The transport must expose missing, duplicated, stale, and replayed
audio without silently presenting an incomplete transcript as authoritative.
The client and relay also need one versioned control contract for session,
transcript, language-gate, translation, suggestion, recovery, and error events.

## Decision

Protocol v1 uses one authenticated `wss` connection with JSON text messages for
control and result events and binary messages for audio. WebSocket compression
is disabled. One session has at most one active utterance. Unknown fields are
rejected on inbound control objects unless a later schema explicitly marks an
extension point.

The first control message is exactly `session.start` for a ticket with new-session
intent or exactly `session.resume` for a ticket bound to exact resume intent.
Both messages declare protocol version `1`, wearer language `en`, one explicitly
confirmed target language from the current registry, registry and
`gatePolicyVersion`, client build, and common limit negotiation. Only
`session.resume` carries session ID, utterance ID, client last-acknowledged
offset, oldest retained offset, and next captured offset. The server rejects an
unsupported version or target before the client opens the microphone.
`session.ready` may lower a negotiable limit but must never advertise a value
above any hard v1 maximum.

Only an accepted `transcript.final` revision may produce `translation.ready` or
`suggestions.ready`. Segment revisions increase monotonically. Session,
utterance, segment, and accepted-final-revision identifiers prevent stale
provider results from updating a later turn.

## Binary audio frame

The header is exactly 30 bytes. Header integers use network byte order; PCM is
16 kHz, mono, signed 16-bit little-endian.

| Offset | Width | Field | Rule |
|---:|---:|---|---|
| 0 | 2 | Magic | Unsigned `0x5041` (`PA`) |
| 2 | 1 | Protocol version | Unsigned `1` |
| 3 | 1 | Flags | Must be `0`; all bits reserved in v1 |
| 4 | 16 | Utterance ID | RFC 4122 UUID bytes |
| 20 | 4 | Sequence | Unsigned 32-bit; starts at zero |
| 24 | 4 | Starting sample offset | Unsigned 32-bit; from utterance start |
| 28 | 2 | PCM payload length | Unsigned 16-bit byte count |

The payload is 2 through 3,200 bytes and always even. Payload length must equal
the bytes following the header. A complete binary message is therefore at most
3,230 bytes. Offset plus payload samples must neither overflow unsigned 32-bit
nor exceed 480,000 samples. Sequence and offset must describe the next
contiguous frame, except that an exact retained duplicate is idempotently
acknowledged. A conflicting duplicate, overlap, or gap is a protocol error.

Sample offsets always count original 16 kHz mono samples, even when a provider
adapter resamples internally. `audio.ack` reports the highest contiguous
exclusive sample offset accepted by the relay.

## Limits and acknowledgement behavior

| Limit | v1 value |
|---|---:|
| JSON control message | 16,384 UTF-8 bytes after fragment reassembly |
| Audio payload | 3,200 bytes |
| Unacknowledged audio | 8,000 samples / 500 milliseconds |
| Client retained replay window | At most 8,000 unacknowledged samples |
| ACK cadence | Within each 100 milliseconds of accepted audio and on every flow-state change |
| Utterance | 480,000 samples / 30 seconds |
| Session | 30 minutes |
| User inactivity | 5 minutes; transport heartbeat does not reset it |
| Heartbeat | Server ping every 20 seconds; terminate after 10 seconds without pong |

These transport limits are separate from the realtime audio-rate limit. For
each installation/session, the relay enforces an original-input-sample token
bucket that refills at 16,000 samples per second and has capacity 8,000 samples.
Only the first acceptance of a sample range is charged; an exact idempotent
duplicate replay is not charged again. Before forwarding newly accepted audio
to a transcription provider, the relay conditionally updates the session bucket
row in `RateState` using its ETag. State outage or exhausted conditional-update
retries fail closed. The first overrun aborts the active turn; repeated or
deliberate overrun closes the connection with `4408`. This rate bucket does not
replace or relax the independent 8,000-sample unacknowledged/replay limit.

The relay advertises `normal`, `pause`, or `abort` flow state. If the client
would exceed the in-flight or local 500-millisecond queue limit, it stops audio
capture, aborts that turn visibly, and does not silently drop samples. A first
flow breach aborts the utterance; repeated or deliberate ingress violations may
close the connection with `4408`.

The server warns before session expiry, permits no new utterance at or after 29
minutes 30 seconds, and terminates the protocol-v1 session at 30 minutes.
Reaching 30 seconds finalizes the valid accepted utterance audio. User actions
reset inactivity; ping/pong and provider traffic do not. A heartbeat-only v1
session therefore terminates for inactivity at five minutes with `4408`.

## Idempotence, reconnection, and replay

`utterance.start`, `utterance.commit`, and `utterance.cancel` are idempotent for
the same session epoch and utterance ID. Conflicting reuse is rejected. Commit
or cancel for an earlier turn cannot affect the active turn.

On socket loss the client immediately stops capture and retains only its bounded
unacknowledged window. It obtains a new single-use ticket with exact resume intent
and reports session ID, utterance ID, client last-acknowledged offset, oldest
retained offset, and next captured offset. Resume succeeds only when the relay
proves the same active session epoch and requests an offset in the inclusive
range `[oldestRetainedOffset, nextCapturedOffset]`. The client then replays
`[requestedOffset, nextCapturedOffset)`, which is validly empty when the
requested offset equals the next captured offset. Otherwise both sides emit an
explicit `utterance.aborted: non_resumable`, clear the turn, and start fresh. Replica or
provider-state loss is non-resumable by design.

## Control families

The TypeBox schemas in `packages/contracts` are the runtime and TypeScript source
of truth for:

- `session.start`, `session.resume`, `session.ready`, `session.rejected`, and
  `session.end`.
- `utterance.start`, `utterance.commit`, `utterance.cancel`, and
  `utterance.aborted`.
- `audio.ack` and negotiated flow control.
- `transcript.partial` and `transcript.final` with segment ID and revision.
- `language.decision` with `target`, `mixed`, `english`,
  `supported_unselected`, `unsupported`, or `uncertain`.
- `translation.ready` and `suggestions.ready` bound to an accepted final
  revision.
- Versioned typed errors with a stable machine code and short, non-sensitive
  display-safe message.

JSON counters and sample offsets are integers in the unsigned 32-bit range.
Timestamps are UTC ISO-8601 strings rather than 64-bit JSON epoch integers.

## Close and error categories

Before HTTP 101, authentication/audience/replay failures, origin rejection,
session conflict, rate limiting, and mandatory state outage return generic HTTP
`401`, `403`, `409`, `429`, or `503` responses as appropriate; no WebSocket close
code exists before upgrade. The custom `44xx` codes below are reserved for
post-upgrade rechecks or for a separately approved first-message authentication
fallback after its socket has upgraded.

| Code | Meaning |
|---:|---|
| 1000 | Normal completion |
| 1002 | Malformed schema/header/order/integer or invalid UTF-8/JSON |
| 1008 | Generic policy violation |
| 1009 | Message too large |
| 1011 | Internal failure |
| 1012 | Deployment drain or restart |
| 1013 | Temporary state/provider unavailability |
| 4401 | Invalid, expired, or replayed authentication |
| 4403 | Revoked credential, origin, or audience rejection |
| 4406 | Unsupported protocol version |
| 4408 | Inactivity, duration, audio-clock, or flow-control limit |
| 4409 | Session or utterance conflict |
| 4429 | Rate limit |

Close reasons are generic and contain no ticket, credential, identifier, or
conversation text. A non-resumable utterance normally remains a typed abort and
does not close an otherwise healthy session.

## Verification

Golden byte fixtures cover both target languages and every field boundary.
Tests cover minimum/maximum and odd payloads, incorrect lengths, integer
wraparound, fragmentation, unknown flags, duplicate/gap/overlap frames, stale
IDs and revisions, flood and queue limits, exact retained replay, and mandatory
abort when requested replay data is unavailable. Fuzzing also covers invalid
UTF-8/JSON, nesting, compression attempts, and message-size checks after
reassembly. Fake-clock tests cover the audio token bucket at exact refill and
capacity boundaries, duplicate replay without double charge, process restart,
concurrent ETag races, state outage, first-overrun turn abort, and repeated
overrun closure.

## Consequences

Protocol v1 favors explicit aborts over pretending recovery succeeded. Active
resampler and provider state stays process-local, so replica loss loses the
current turn but not protocol correctness. Any incompatible field, limit, close
code, or mixed-language authorization change requires a new protocol version or
an explicitly backward-compatible extension.
