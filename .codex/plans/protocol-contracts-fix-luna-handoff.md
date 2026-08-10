# Protocol/auth contracts fix handoff (GPT-5.6 Luna xhigh)

## Scope

Fix every Sol finding in the current protocol/auth slice. Preserve unrelated work; the Terraform lane owns `infra/**`. Do not edit infra/ADRs/apps, mutate Azure, commit, or add unrelated dependencies.

Allowed files are the same as `.codex/plans/protocol-contracts-luna-handoff.md`, plus this handoff and the Sol review handoff wording if needed.

## Must-Fix

1. Add `segmentId` to the shared accepted-final binding for `translation.ready` and `suggestions.ready`. Update Spanish/Turkish fixtures/tests to assert session, epoch, utterance, segment, and accepted-final revision all bind together.
2. Aggregate `is/assertClientControlMessage`, `is/assertServerControlMessage`, and `is/assertControlMessage` must dispatch by discriminator/result to the specific semantic validators. Raw union `Value.Check` is insufficient. Prove contradictory negotiated limits and invalid resume relationships fail every aggregate path.
3. Introduce an original-sample-offset schema capped at 480,000 for resume, commit/cancel, ACK, and replay offsets. Enforce `oldestRetainedOffset <= clientLastAcknowledgedOffset <= nextCapturedOffset`, `nextCapturedOffset - oldestRetainedOffset <= 8,000`, and requested replay offsets within valid bounds. Add exact 0/480,000/8,000 boundaries and 480,001/8,001 rejection.
4. Canonical 256-bit unpadded base64url must use `^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`; add terminal-alias tests proving noncanonical strings that decode to the same bytes are rejected.
5. Keep a bounded TypeBox WSS string schema, but make every session-ticket-response runtime validator call semantic `URL` validation: protocol exactly `wss:`, no credentials/path/query/fragment, valid host/port, and input exactly equals canonical `url.origin`. Add package-local DOM URL typing if needed without changing the root compiler. Reject `.`, `-`, repeated-dot hosts, port 99999, default-port aliases, uppercase/noncanonical host, paths, queries, fragments, and credentials.
6. UUID text must be canonical lowercase RFC variant/version form, not arbitrary hex groups or uppercase aliases. Accept supported standard UUID versions needed by this app (fixtures use v4) and variant `[89ab]`. Encoding rejects noncanonical/version/variant text. Decoding validates header version/variant bytes and throws `AudioFrameError` reason `uuid`; test malformed bits.
7. Add controlled fixtures and table-driven positive/opposite-union coverage for every family: `utterance.cancel`, `session.end`, `session.rejected`, `utterance.aborted`, `audio.ack`, typed error envelope, every abort/rejection/error category, and all six language decisions. Keep Spanish/Turkish accepted-result fixtures symmetric.

## Should-Fix and hardening

- Add semantic UTC timestamp validation that rejects impossible calendar/time values and ensure every specific and aggregate validator with a timestamp uses it. Add leap-day and invalid month/day/hour/minute/second tests.
- Strengthen sensitive-error tests using distinctive PCM, UUID, header, credential, and ticket canaries; no error name/message/reason/contract field may contain them.
- Deep-freeze nested fixture arrays/objects. Binary fixtures must return defensive copies or otherwise make mutation unable to alter the canonical fixture.

## Original handoff omissions to close in this pass

- Installation credential response must expose separate `idleExpiresAt` and immutable `absoluteExpiresAt`, not one ambiguous expiry.
- Session-ticket request must include protocol version alongside discriminated new/resume intent; keep ticket response as origin/path/ticket/expiry and never a URL containing the ticket.
- Negotiated limits/defaults must include explicit retained replay samples (max 8,000) and maximum utterance milliseconds (max 30,000) in addition to existing fields. Semantic validation requires even audio payload maximum, binary maximum at least header plus payload, no-new-turn no later than session duration, and replay no larger than unacknowledged samples.

## Verification

Run artifact-free install, lint, typecheck, all tests, build, both ESM imports, and `git diff --check`. Report exact total tests and property runs/seed. Do not report `DONE` until every finding and omission above has a regression test.

## Final re-review closure

Sol found two remaining Must-Fix defects and one Should-Fix:

1. `session.resume` retained-window validation must compare `nextCapturedOffset - oldestRetainedOffset` against `requestedLimits.maxRetainedReplaySamples`, not only the hard 8,000 maximum. Add lowered negotiated-limit pass/fail boundaries.
2. Restrict canonical UUIDs and binary codec UUID bits to RFC 4122 v4 for this app: text version nibble exactly `4`, variant `[89ab]`; decoder rejects versions 1-3 and 5-8 with reason `uuid`. Update property generators and boundary tests.
3. Installation credential response requires `idleExpiresAt <= absoluteExpiresAt`. Rotation confirmation requires `confirmedAt <= expiresAt`. Add reversed/equal-order tests while preserving semantic timestamp validation.

Run the full verification again. Do not commit.
