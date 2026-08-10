# Luna implementation handoff: audio stream core

## Objective

Implement the provider-neutral, browser-safe `packages/audio` foundation used by
the G2 sender and relay. This is a bounded implementation task. Do not design
the G2 UI, WebSocket lifecycle, provider integration, authentication, or Azure
resources.

You are not alone in the repository. Preserve unrelated work, especially the
active `infra/**` Terraform edits. Do not revert other agents' changes, commit,
or mutate Azure.

## Required evidence

Read before editing:

- `docs/adr/0001-protocol-v1.md`
- relevant audio/client/relay sections of `docs/implementation-plan.md`
- `packages/contracts/src/audio.ts` and `packages/contracts/src/constants.ts`
- `.agents/skills/g2-events-input/SKILL.md` for the G2 PCM callback contract
- `package.json`, `tsconfig.base.json`, and one existing package for conventions

## Exclusive write scope

- `packages/audio/**`
- root `package.json` only if the workspace scripts require a mechanical update
- root `package-lock.json` only through `npm install`

Do not edit contracts, fixtures, apps, tools, docs, infra, or other packages.

## Functional contract

Implement explicit, typed APIs with no Node-only runtime dependencies:

1. **PCM chunk normalizer/framer**
   - Accept arbitrary `Uint8Array` callbacks representing 16 kHz mono signed
     16-bit little-endian PCM.
   - Copy incoming views so non-zero offsets/shared backing buffers are safe.
   - Carry one trailing byte between callbacks; never reorder or lose bytes.
   - Emit contiguous non-empty even payloads no larger than a configurable
     limit capped at protocol `MAX_AUDIO_PAYLOAD_BYTES` (3,200).
   - `flush` must explicitly return/report an incomplete trailing byte rather
     than padding or silently dropping it. Reset must clear all state.

2. **Client retained/in-flight queue**
   - Build protocol frames with sequence numbers starting at zero and absolute
     original-sample offsets starting at zero.
   - Retain only unacknowledged frames/ranges, capped by negotiated
     `maxUnacknowledgedSamples` and `maxRetainedReplaySamples`, each no greater
     than the v1 8,000-sample maximum.
   - A push that would overflow either bound fails atomically with a typed,
     visible overflow outcome; it must not silently drop/partially enqueue.
   - Apply `audio.ack` monotonically: stale ACKs are harmless, ACK beyond the
     captured offset is rejected, ACKs inside a frame retain the unacknowledged
     suffix without changing the original wire identity, and an ACK at a frame
     boundary releases whole frames. If supporting only frame-boundary ACKs,
     reject an interior ACK explicitly and test that rule. Choose and document
     one behavior.
   - Expose oldest retained, highest acknowledged, next captured, in-flight,
     and replay interval. Replay from any requested offset in the inclusive
     `[oldestRetainedOffset, nextCapturedOffset]` range, including an empty replay
     at the end. Reject an older/newer request with a typed non-resumable result.
   - Exact replay returns byte-identical encoded frames in original order and
     never advances capture state.
   - Reset for a new utterance requires a canonical v4 UUID and clears sequence,
     offsets, trailing-byte state, ACK state, and retained data.

3. **Relay ordered frame acceptor**
   - Track one utterance/epoch-independent ordered stream from decoded frames.
   - Accept exactly contiguous new frames and return the highest contiguous
     exclusive sample offset.
   - Treat an exact duplicate (same sequence, offset, and payload bytes) as
     idempotent without charging/forwarding it again.
   - Return explicit typed outcomes for conflicting duplicate, gap, overlap,
     stale/wrong utterance, and utterance-limit violations. Never throw for a
     normal protocol ordering outcome.
   - Retain only enough bounded fingerprint/data state to recognize duplicates
     inside the negotiated replay window; document behavior outside it.

4. **Stateful resampler abstraction**
   - Define a provider-neutral interface/capabilities contract and lifecycle
     (`push`, `flush`, `reset`) without implementing a 16-to-24 kHz algorithm.
   - Provide a native-rate identity implementation that copies input and has
     deterministic reset/flush behavior.

## Tests

Use Vitest and fast-check where useful. Cover at minimum:

- arbitrary chunk partitions (including every one-byte partition) round-trip
  exactly for even input;
- non-zero-offset typed-array views are copied;
- trailing-byte carry, flush error, reset;
- exact payload and 8,000-sample boundaries plus one over each;
- atomic queue overflow with state unchanged;
- monotonic/stale/invalid ACK boundaries;
- inclusive empty replay and out-of-window replay;
- sequence and offset monotonicity across arbitrary chunks;
- exact duplicate versus conflicting duplicate, gap, overlap, stale utterance;
- identity resampler copy/no-alias/reset behavior;
- at least one deterministic fast-check seed recorded in the test.

The package must export through `src/index.ts`, have strict build/test configs,
and work as a Node 22 ESM import after build.

## Verification and completion

Run from the repository root:

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

Also import `packages/audio/dist/index.js` with Node 22. Report exact files
changed, API choices (especially interior ACK behavior), test counts/seed, and
verification results. End with `DONE` or `BLOCKED: <reason>`.
