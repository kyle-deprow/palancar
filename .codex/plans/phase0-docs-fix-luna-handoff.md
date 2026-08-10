# Phase 0 ADR fix handoff (GPT-5.6 Luna xhigh)

## Scope

Implement the exact corrections from the first Sol Phase 0 ADR review. You are not alone in the repository; preserve all unrelated work. Do not edit code/package files, mutate Azure, or commit.

Allowed files only:

- `docs/phase-0-decisions.md`
- `docs/adr/0001-protocol-v1.md`
- `docs/adr/0003-client-authentication.md`
- `docs/adr/0004-data-retention.md`
- `docs/adr/0005-compute-host.md`
- `docs/implementation-plan.md`
- `docs/real-time-translation-plan.md`
- `.codex/plans/phase0-docs-review-sol-handoff.md` only if review instructions need factual correction
- `.codex/plans/phase0-sol-handoff.md` only for the stale G2 skill paths

Read `.codex/plans/phase0-docs-review-sol-handoff.md` and all allowed docs completely before editing.

## Required corrections

1. **Compute test/protocol duration split.** A protocol-v1 active test runs to its expected 30-minute termination, permits no new turn at/after 29:30, and has no unexplained closure/audio gap. A heartbeat-only v1 session must close at five minutes with `4408`. Test 35-minute platform socket longevity only with a separate synthetic transport probe that is explicitly not a protocol-v1 session and is exempt from product inactivity/session enforcement. Correct ADR 0005 and every implementation/product-plan matrix statement.
2. **Terraform workload state.** Add a dedicated workload Storage account/module, `SecurityState` and `RateState` Tables, shared-key disablement, runtime `Storage Table Data Contributor`, and a managed daily expiry-cleanup Container Apps Job to all Azure resource lists, diagrams, foundation applies, sequencing, identity readiness, and ownership tables. Table RBAC must precede workload readiness. Budget/alerts must exist before model deployments and the warm workload. Terraform state storage remains separate.
3. **Freeze Table data model and transactions in ADR 0003.** For development, `SecurityState` uses one environment partition such as `dev-v1` with row keys `pair:<sha256>`, `credential:<sha256>`, `installation:<id>`, `ticket:<sha256>`, and `session:<installationId>`. Define important status/version/audience/expiry fields and point lookups. Pair redemption transaction consumes pair + creates installation + current credential mapping. Ticket consume transaction consumes ticket + claims/advances installation session epoch and session row. All transaction members share the same table/partition and use ETags. `RateState` partitions by hashed installation/operator/source scope and uses fixed-window/token-bucket rows with conditional updates. Reads enforce expiry before cleanup. Note this single security partition is a low-volume development design and production partitioning requires a reviewed migration.
4. **Freeze credential rotation.** At a session boundary, atomically create pending `v+1` while `v` remains current. Client retains both. First authenticated HTTPS request with `v+1` atomically promotes it; confirmation tells client to delete `v`. An unconfirmed pending credential expires after five minutes while `v` remains valid. Rotation never resets installation 90-day absolute expiry. Revocation invalidates current/pending credentials, all outstanding tickets, and known sockets together. Active sessions are not rotated mid-turn; explicit revocation terminates them.
5. **New versus resume contract and pre-upgrade failures.** The first control message is exactly `session.start` for a new-intent ticket or `session.resume` for an exact resume-intent ticket. Both carry common protocol/registry/client negotiation; only resume carries session/utterance/last-acknowledged/oldest-retained/next-captured offsets. Add `session.resume` to every contract enumeration. Before HTTP 101, auth/audience/replay, origin, rate limit, conflict, and state outage use generic HTTP 401/403/409/429/503 results with no WebSocket close code. Reserve custom 44xx codes for post-upgrade rechecks or an explicitly approved first-message fallback.
6. **Audio realtime rate enforcement.** Add a per-installation/session original-sample token bucket in ADR 0001 and the relevant abuse tables: refill 16,000 samples/second, capacity 8,000, charge only first acceptance (not exact duplicate replay). Persist bucket state in a `RateState` session row using ETag conditional updates before provider forwarding; state outage fails closed. First overrun aborts the turn, repeated/deliberate overrun closes `4408`. Require boundary, duplicate, restart, race, and fake-clock tests. Do not confuse this with the 8,000-sample unacknowledged limit.
7. **Target confirmation state.** Add `TargetSelection` between Starting and Ready in every journey/state-machine description. Restore the last target only as highlighted; swipe changes it and press explicitly confirms before session start or microphone access. Wording is “press to confirm, swipe to change,” not a mandatory swipe. Freeze Results as swipe-to-cycle and press-to-start-next-turn. The client sends `gatePolicyVersion`, not a client-chosen mixed policy; server v1 policy is reject. Use ADR 0001's exact language decisions everywhere.
8. **Unconditional zero application content retention.** Remove every qualifier such as “by default” or “normal application logs” that could permit conversation/audio logging in a deployed mode. Prohibit content in every deployed mode, log level, trace, exception, diagnostic/evidence sink, and crash report. Synthetic non-conversation fixtures remain explicitly separate. Keep the Azure provider abuse-monitoring boundary.
9. **Correct Phase 0 completion.** Mark operator pairing, local Azure CLI apply identity, Azure-provided ingress, cloud/model preflight, product limits, and retention as complete. Explicitly defer production CIAM, CI federation, custom DNS, and private networking. Move physical origin/subprotocol/IndexedDB evidence to the pre-real-audio Phase 4 entry gate; it does not block Terraform foundation or authenticated synthetic implementation. Remove contradictory Phase 0 exit requirements.
10. **Replay interval.** Permit a requested resume offset in the inclusive range `[oldestRetainedOffset, nextCapturedOffset]`; replay `[requestedOffset, nextCapturedOffset)`, which can be empty.
11. **Trusted source IP.** Define a host adapter that accepts only platform-controlled peer/forwarded address data according to the tested host topology and never trusts an arbitrary client-supplied `X-Forwarded-For` chain. Revalidate it on each compute host.
12. **Editorial correctness.** `session.ready` may lower negotiable limits but must never advertise above hard v1 maxima. Pairing input accepts only one canonical 26-character Crockford Base32 representation and rejects aliases/noncanonical forms before hashing. Mark existing Phase 0 `READY` labels as first-pass superseded/`NEEDS WORK` until a new Sol re-review returns ready.

## Verification

- Search all changed docs for contradictory 35-minute v1, heartbeat survival, query ticket, client-supplied mixed policy, undecided Results controls, content logging qualifiers, and stale Phase 0 blockers.
- Recalculate the binary header total and preserve 30 bytes.
- Ensure exact values remain consistent: 3,200-byte audio payload, 16,384-byte control, 8,000-sample in-flight/replay, 480,000-sample utterance, 30 seconds, 30 minutes, 5 minutes, and 60-second tickets.
- Run `git diff --check` and report changed paths plus any residual ambiguity. Do not report `DONE` unless all twelve corrections are covered.

## Final re-review closure

The second Sol pass found one remaining Must-Fix and one Nit. Close both:

1. Make every realtime-spike JSONL/evidence statement metadata-only. Allowed fields are event type, timestamp, opaque IDs, byte/sample/token counts, status, configuration/model versions, latency, and aggregate accuracy/gate results. Categorically exclude PCM, transcript text, translation text, suggestions, prompts/responses, and provider payload bodies.
2. Physical-G2 test speech must be streamed and scored in memory, then discarded without creating recordings or audio evidence artifacts. Persistable audio fixtures must be generated synthetic non-conversation fixtures, explicitly distinct from physical/user speech. Replace “spike-local audio evidence” with “metadata-only spike evidence.” Correct both plans and any ownership/table wording.
3. In `.codex/plans/phase0-sol-handoff.md`, replace the nonexistent aggregate skill path with the five split G2 skill paths listed in `AGENTS.md`.

Run targeted searches and `git diff --check` again. Do not commit.
