# ADR 0003: Client enrollment and WebSocket authentication

Status: Accepted for development; physical WebView evidence required before real audio

Date: 2026-08-09

## Context

The Even App runs in a browser WebView. Browser WebSockets cannot attach an
arbitrary `Authorization` header, and reusable credentials must not appear in
the client source, bundle, manifest, URL, browser history, or telemetry.
Authentication must survive relay restarts and reject ticket replay atomically.

## Decision

Development uses operator-authorized, one-time installation enrollment followed
by short-lived, audience-bound WebSocket tickets. Query-string tickets are
prohibited in protocol v1.

Pairing-code issuance is an explicit operator action, never a relay endpoint.
An Entra-authenticated operator uses the approved Azure CLI/Entra CLI runbook to
generate a 128-bit CSPRNG code in exactly one canonical 26-character Crockford
Base32 representation, compute its SHA-256 hash, and insert only that hash into
the `SecurityState` Table. The CLI prints or returns the plaintext exactly once
with no-store handling; the relay never issues, logs, or returns pairing
plaintext. Pairing input accepts only the canonical representation and rejects
aliases, case variants, separators, ambiguous-character substitutions, and every
other noncanonical form before hashing. The code expires after 10 minutes.
Unknown, expired, consumed, and revoked codes have the same public failure. The
relay only redeems the submitted plaintext by hashing it and atomically consuming
the matching Table row.

Successful atomic redemption consumes the code and creates an installation with
a 256-bit random credential. Only the SHA-256 credential hash is stored by the
service. The client stores the credential in IndexedDB—not localStorage, bridge
storage, a URL, or diagnostics. It idles out after 30 days, rotates after 30
days, and expires absolutely after 90 days.

Credential rotation occurs only at a session boundary. One atomic transaction
creates pending credential `v+1` while credential `v` remains current, and the
client retains both. The first authenticated HTTPS request using `v+1`
atomically promotes it; the successful response confirms promotion and tells
the client to delete `v`. If promotion is never confirmed, pending `v+1`
expires after five minutes and `v` remains valid. Rotation never changes or
extends the installation's 90-day absolute expiry. Active sessions are not
rotated mid-turn. Explicit revocation atomically invalidates current and pending
credentials, every outstanding ticket, and the active session record, and it
terminates all known sockets and provider work for that installation.

The credential is sent as a bearer token only to HTTPS
`POST /v1/session-tickets`. Exact-origin CORS is enforced when the physical host
provides a stable origin, but bearer authentication is the security boundary.
A `null` origin may be accepted only for this bearer-authenticated development
flow after physical-host evidence; cookie fallback is prohibited for a null
origin.

## Ticket contract

A ticket is 256 random bits. The relay stores only its hash and binds it to the
canonical environment, `wss` origin, `/v1/stream`, protocol version,
installation ID, credential version, and new-session intent. It expires in
exactly 60 seconds with no clock-skew grace and is single-use.

After upgrade, the first control message must be `session.start` and match the
new-session ticket intent exactly. It carries protocol, wearer/target, registry,
gate-policy, client, and limit negotiation; it never carries an earlier
session/utterance identity or retained-audio offsets. A disconnect therefore
requires a new ticket and a new session rather than continuation of interrupted
work.

The browser offers two WebSocket subprotocol values:

```text
palancar.v1
palancar.ticket.<base64url-ticket>
```

Azure ingress must forward both byte-for-byte. The relay validates and
atomically consumes the ticket before upgrade, but selects and returns only
`palancar.v1`; it never echoes the ticket-bearing value. A ticket burned before
a failed upgrade remains burned. Before HTTP 101, invalid authentication,
audience or replay, origin rejection, rate limiting, session conflict, and
mandatory state outage return only generic HTTP `401`, `403`, `409`, `429`, or
`503` responses as appropriate. They cannot use WebSocket close codes before an
upgrade. Custom `44xx` close codes are reserved for post-upgrade rechecks or an
explicitly approved first-message fallback.

A same-origin `__Host-` Secure, HttpOnly, SameSite=Strict cookie is an allowed
fallback only if a physical WebView test proves a genuinely same-origin flow.
If subprotocol forwarding and cookies both fail, a first-message ticket may be
evaluated with a three-second authentication deadline and strict unauthenticated
connection limits. It requires an ADR update and evidence before use. A query
parameter is not a fallback.

## Durable state model and transactions

A dedicated workload Azure Storage account—not the Terraform state account—is
the development state store. Shared-key access is disabled. Its `SecurityState`
and `RateState` Tables are owned by a dedicated Terraform workload-state module,
and the runtime managed identity receives only Storage Table Data Contributor on
that account before workload readiness. Azurite plus a fake clock is permitted
only for loopback `local-mock` tests with mock providers and no paid endpoint;
paid or deployed modes require Azure Table and have no state-store fallback.

For low-volume development, every `SecurityState` entity uses the single
environment partition key `dev-v1`. Row keys and required fields are:

| Row key | Required fields and point-lookup purpose |
|---|---|
| `pair:<sha256>` | `status` (`issued`, `consumed`, or `revoked`), schema version, operator scope hash, environment/audience, `issuedAt`, `expiresAt`, `consumedAt`; lookup by canonical pairing-code hash |
| `credential:<sha256>` | installation ID, credential version, `status` (`current`, `pending`, `retired`, or `revoked`), environment/audience, `issuedAt`, `lastUsedAt`, idle expiry, absolute installation expiry, pending expiry; lookup by presented credential hash |
| `installation:<id>` | `status`, schema version, current and optional pending credential versions/hashes, pending expiry, session epoch, one-active-session lock (`activeSessionId`, `activeSessionEpoch`, `sessionLockExpiresAt`), idle expiry, immutable 90-day absolute expiry, revocation time; lookup by installation ID |
| `ticket:<sha256>` | `status` (`issued`, `consumed`, or `revoked`), installation ID, credential version, new-session intent, exact environment/origin/path/protocol audience, issued/expiry/consumed times; lookup by ticket hash |
| `session:<installationId>` | installation ID, claimed session ID, session epoch, `status` (`opening`, `active`, `expired`, or `revoked`), ticket hash, issue/claim times, opening and active lease expiry, and last authenticated activity; lookup by installation ID |

All security point reads supply both `PartitionKey=dev-v1` and the exact row key
and reject logical expiry before relying on physical cleanup. Pair redemption is
one `SecurityState` partition transaction that conditionally changes the pair
row from issued to consumed and creates both the installation row and current
credential-hash mapping. Ticket consumption is one partition transaction that
conditionally consumes the ticket, advances the installation session epoch,
claims the installation's one-active-session lock, and creates
`session:<installationId>` in `opening` with an opening lease of exactly 10
seconds. It may replace an already logically expired session only while
atomically releasing its expired installation lock. Every existing member uses
its exact current ETag in an `If-Match` condition; wildcard ETags are
prohibited, and transaction failure returns no partial success. A valid
`session.start` is then an atomic exact-ETag transition of that same session
from `opening` to `active`, and sets both the session and installation lock to
an active lease of exactly 35 seconds. An invalid, late, or ETag-stale
`session.start` does not activate the session. Every 20-second heartbeat
renews the active session and its installation lock to 35 seconds from the
heartbeat, again with the exact current ETags and the returned replacement
ETags used for the next operation. A disconnected session is never claimed
again; its active turn is aborted in memory and the next ticket creates a
fresh session epoch.

When an opening or active lease expires, the relay logically expires the
session and atomically clears the installation lock only if its session ID and
epoch still match. The daily cleanup job performs that same exact-ETag,
same-partition release transaction before deleting an expired session; expiry
and cleanup can never leave an installation locked. If a required state read,
claim, or heartbeat update is unavailable, no lease is renewed, no newly
authorized work is forwarded, and the affected socket closes; there is no
outage grace period.

`RateState` is a separate Table. It partitions entities by hashed
installation, operator, or trusted-source scope and stores rolling limits and
durable audio-reservation grants. An audio authorization is a durable
reservation grant for at most 8,000 original 16 kHz samples. The relay
consumes a granted amount locally as newly accepted sample ranges arrive; exact
duplicates within the same live connection do not consume it. Unused granted
capacity is never refunded, including when a turn or socket ends. When local
consumption would exceed the current grant, a renewal must durably succeed
with an exact ETag condition before any sample beyond that grant is forwarded
to a provider. A Table outage grants or renews nothing and therefore forwards
no newly authorized audio. Reads enforce expiry before the daily cleanup job
removes stale rows. A state outage fails closed. The single `SecurityState`
partition is deliberately a low-volume development design; production
partitioning requires a reviewed data migration that preserves exactly-once
redemption, ticket consumption, credential rotation, revocation, session-epoch
claims, and audio grant reservations.

The `RateState` generation-authorization row is keyed by session epoch,
utterance, accepted final revision, target language, gate-policy version, and
transcript hash. It stores the durable `turn` and `modelAttempt` counters,
`status`, ETag, opening/active lease expiry, provider-start time, and completion
metadata. A non-`target` language decision creates no row and makes no provider
call. For an accepted target final, the relay performs one atomic ETag claim
immediately before the one provider call. A duplicate final finds the existing
row and reuses its outcome; it never creates a second claim or provider call.
The opening claim has a 10-second lease. At provider start, the claim becomes
consumed, `modelAttempt` is incremented for that `turn`, and it is never
refunded. The active provider lease is 35 seconds and is renewed by the
20-second heartbeat using its ETag. Lease expiry releases the unstarted or
active execution claim; an already consumed claim remains consumed and cannot
be retried or refunded. Provider completion is recorded only if the row and
session epoch still match.

Credential pending creation, promotion, expiry, and revocation update the
installation and affected credential mappings in same-partition transactions.
The revocation transaction marks the installation, current/pending credentials,
and session revoked. Ticket consumption always includes the installation row,
so that committed status invalidates every outstanding ticket immediately even
before ticket rows are later marked or cleaned. The revocation operation then
synchronously terminates every known socket/provider task before returning;
ticket issue and socket rechecks fail closed while it is in progress.

Active sockets, provider connections, resampler state, and the bounded
live-connection duplicate queue remain in process memory. The client and relay
have independent disconnect responsibilities: the client stops capture and
clears its local PCM, transcript, translation, suggestion, and pending-result
state; a relay socket-close handler independently aborts every provider task and
releases only unstarted execution claims. Neither side waits for the other.
Every utterance start and 20-second heartbeat rechecks the persisted credential
version and renews active session and generation leases with exact ETags.
Revocation closes a known socket immediately and is otherwise effective within
20 seconds. State-store failure fails enrollment, ticket issue/consume,
revocation checks, session heartbeats, audio grants, and generation
authorization closed.

Expired rows are rejected logically even before cleanup. A daily managed cleanup
Container Apps Job removes expired pairing codes, pending/retired credentials,
tickets, sessions, and rate windows within 24 hours and retains
revoked-installation tombstones for 30 days.

## Abuse limits

| Operation | Limit |
|---|---:|
| Operator pairing-code insertion | 20 per operator per day through the approved CLI runbook |
| Pairing redemption | 5 per 15 minutes and 20 per day per source IP |
| Ticket issue | 6 per minute and 30 per hour per installation |
| Unauthenticated upgrades | 10 per minute per source IP; 2 concurrent |
| Active sessions | 1 per installation |
| Reconnects | 5 per installation per rolling 60-second recovery window; 12 per installation per rolling 10-minute recovery window, with jittered backoff |
| Original audio samples | Durable reservation grants per installation/session/turn: up to 8,000 original samples; local consumption; unused capacity is never refunded |

Additional protocol and generation limits are frozen in ADR 0001. Reconnect
limits are keyed by installation in a rolling recovery window; opening a new
session or epoch does not reset them. Rate-limit and grant state is durable in
`RateState` and fails closed when unavailable. A first audio-grant overrun
aborts the turn and repeated or deliberate overrun closes `4408`. The grant is
separate from the 8,000-sample unacknowledged limit.

Source-IP limits consume only a trusted-source value from a host adapter. The
adapter accepts the platform-controlled peer address or platform-added forwarded
address fields according to the tested topology for that compute host. It never
trusts an arbitrary client-supplied `X-Forwarded-For` chain. The mapping and
header-removal boundary must be revalidated whenever Palancar evaluates or moves
to another compute host.

## Browser and packaging controls

The WebView uses a strict CSP without inline script, `eval`, or third-party
script. Dependencies are exactly pinned. Persistent state contains only
installation authentication metadata and the last target choice. Losing
IndexedDB requires re-pairing. Source, production bundle, `.ehpk`, image,
Terraform outputs, browser history, ingress logs, application logs, Application
Insights, Log Analytics, traces, exceptions, diagnostics/evidence sinks, and
crash reports are scanned with canary values across every deployed mode and log
level. Zero credential, ticket, pairing code, raw audio, or conversation-content
matches are required before real audio. Synthetic non-conversation fixtures are
kept separate from all deployed sinks.

Production replaces operator pairing with an approved customer identity flow,
expected to be Entra External ID authorization code with PKCE through a
system-browser/native flow proven on the Even host. It preserves revocable
installation registration and the single-use session-ticket boundary.

## Required evidence

- Actual Even WebView origin, IndexedDB persistence, CORS/preflight, background,
  foreground, and cold-start behavior.
- Exactly one success from 100 concurrent redemptions and from 100 concurrent
  upgrades using one ticket.
- Wrong audience/path/environment/protocol and expired/revoked/rotated cases.
- Relay failure between ticket consumption and upgrade does not permit reuse.
- Process restart and Table outage fail safely.
- Pairing redemption, ticket, credential rotation/revocation, session epoch,
  audio-grant, reconnect-window, and generation-authorization tests exercise
  ETag races, transaction rollback, duplicate-final reuse, lease expiry,
  expiry-before-cleanup, and fake-clock boundaries. Non-target decisions prove
  that no generation row or provider call is created.
- Trusted-source tests prove client-supplied forwarding headers cannot choose a
  rate-limit identity on each candidate compute host.
- Canary scans prove subprotocol values and credentials are absent from every
  persistent logging layer.

Until these checks pass on the deployed candidate and physical host, the relay
may accept only synthetic test audio. They are Phase 4 pre-real-audio entry
evidence and do not block Terraform foundation or authenticated synthetic
implementation.
