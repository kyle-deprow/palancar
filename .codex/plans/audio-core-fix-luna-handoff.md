# Luna fix handoff: audio stream core

Fix every finding in the Sol audio review. Work directly in
`/home/dev/repos/palancar_ws/palancar`. You are not alone; preserve unrelated
Azure/Terraform state and files. Do not commit or mutate Azure.

## Write scope

- `packages/audio/**`
- root `package-lock.json` only if `npm install` mechanically changes it
- this handoff is read-only

Do not edit contracts, docs, apps, tools, infra, or other packages.

## Required corrections

1. **Frame-boundary ACK/replay**
   - Remove support for logical interior ACKs and remove `wireStartOffset`.
   - ACK offsets must be non-negative integers and either the current acknowledged
     offset or an exact retained frame end boundary up to `nextCapturedOffset`.
     Return a typed `interior-frame` invalid result without mutation otherwise.
   - A negative integer is `negative`, not `non-integer`.
   - Replay offsets must be an exact retained frame start boundary or
     `nextCapturedOffset`; return typed `interior-frame` non-resumable without
     mutation otherwise. Replay is exactly `[requestedOffset,nextCapturedOffset)`
     and every returned frame begins at or after the request. Empty replay at
     the end remains valid.

2. **All effective negotiated limits**
   - Add `maxUtteranceSamples` to client limits. It must be a positive integer no
     greater than protocol `MAX_UTTERANCE_SAMPLES`; enforce it atomically on push.
   - Replace the relay constructor's positional replay-window argument with a
     frozen explicit options object containing `maxAudioPayloadBytes`,
     `maxRetainedReplaySamples`, and `maxUtteranceSamples`, each validated against
     protocol hard maxima. This is a new package with no compatibility burden.
   - Enforce lowered payload/utterance bounds before state mutation.

3. **Runtime structural rejection in relay**
   - Although callers normally decode with the contract codec, treat the public
     `AudioFrame` parameter as untrusted at runtime. Before ordering logic,
     validate protocol version/flags, canonical UUID identity, uint32 integer
     sequence and offset, `Uint8Array` payload, exact integer `payloadLength`,
     non-empty/even payload, payload length equality, effective payload cap, and
     effective utterance cap.
   - Return explicit typed rejected outcomes (`malformed-frame`,
     `payload-limit`, or `utterance-limit` as appropriate) and never mutate for
     malformed input. Do not throw for a normal untrusted-frame rejection.

4. **Bounded linear-time data structures**
   - Eliminate repeated `Array.shift()` and linear duplicate lookup.
   - Client may use an array plus head index with occasional amortized compaction.
   - Relay must use O(1)-average sequence lookup (for example `Map`) plus an
     ordered queue/head index for sample-bounded eviction. State counts must
     report only live entries. Keep all memory bounded by negotiated replay
     samples plus at most one maximum frame.

5. **Tests**
   - Replace interior-success tests with explicit interior ACK/replay rejection
     and no-mutation assertions.
   - Cover exact and one-over lowered payload/utterance limits on both client and
     relay.
   - Table-test `NaN`, infinities, fractions, negatives, uint32 overflow, bad
     flags/version, payload type/declared-length/empty/odd/oversize, wrong UUID,
     and verify rejection leaves state unchanged.
   - Add deterministic fast-check model/state-machine properties for sequences
     of push, boundary/stale/interior/future ACK, valid/invalid replay, reset,
     duplicate, gap/overlap, and fingerprint eviction. At minimum assert state
     invariants and reject-without-mutation. Record seeds and use at least 200
     runs for each property.
   - Add a high-frame-count regression that would expose quadratic `shift` or
     duplicate scans; assert behavior/state rather than a flaky wall-clock limit.

## Verification

Run root lint, strict typecheck, all tests, build, Node 22 ESM import, and
`git diff --check`. Report changed files, exact tests/counts/seeds, API changes,
and actual verification results. End `DONE` only when complete; otherwise
`BLOCKED: <reason>`.
