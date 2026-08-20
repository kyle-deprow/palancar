# Audio grant handoff freshness fix

## Objective

Prevent Azure Table reservation latency from consuming a realtime audio
grant before the relay can use it, without increasing the grant lifetime,
double-reserving samples, refunding committed quota, or weakening session,
offset, replay, and cleanup constraints.

## Approved contract

- Keep `AUDIO_GRANT_TTL_MS` at exactly 1,000 ms.
- Add and export `MIN_AUDIO_GRANT_HANDOFF_MS` at exactly 500 ms. A maximum
  8,000-sample grant at the fixed 16 kHz input rate represents 500 ms of
  realtime audio.
- In the Azure store, use an initial time only for preflight reads. After the
  active-session and all rate-table point reads complete, sample `issuedAt`,
  revalidate the fetched session and exact lease at that time, and use that
  time consistently for quota pruning/events, the grant, both active-grant
  expiry fields, and retention.
- After a successful transaction, reread the active session, then sample the
  handoff clock. Return only when the session and lease are still exact and
  `expiresAt - handoffNow >= MIN_AUDIO_GRANT_HANDOFF_MS`.
- A stale final session fails as `stale-lease`; insufficient handoff lifetime
  fails as `state-unavailable`.
- A committed reservation is never retried, deleted, compensated, refunded,
  or rewound after a post-commit failure.
- Direct success and ambiguous-commit reconciliation use the same final
  session/freshness validator. Reconciliation accepts only an exact operation
  match across grant, utterance, installation, session, epoch, lease version,
  timestamps, offsets, and sample count. A present malformed or mismatched row
  fails immediately.
- Known non-commit conflicts and ambiguous outcomes with no grant row may
  retry with the same grant ID and a fresh late issuance time.
- The in-memory store keeps its late issuance anchor and enforces the same
  post-commit freshness invariant while retaining any committed reservation.
- `audio-meter.ts`, persisted schema, relay protocol, telemetry semantics,
  infrastructure, and TTL remain unchanged.

## File ownership

The bounded implementation worker may change only:

- `packages/security-state/src/types.ts`
- `packages/security-state/src/index.ts`
- `packages/security-state/src/store.ts`
- `packages/security-state/src/azure-store.ts`
- `packages/security-state/test/security-state.test.ts`
- `packages/security-state/test/azure-store.test.ts`

This plan is read-only to the worker. Every other file is out of scope.

## Deterministic verification

Tests must cover:

1. Delayed preflight reads followed by exactly 500 ms of post-anchor latency:
   the old anchor would already be stale, while the fixed grant has exactly
   500 ms remaining and is accepted by the meter.
2. Exactly 501 ms of post-anchor latency: fail `state-unavailable` while one
   durable grant, one transaction, one event in each quota window, and the
   advanced cursor remain; no retry or refund.
3. Ambiguous-before-commit retry, fresh ambiguous-after-commit reconciliation,
   stale ambiguous-after-commit failure, and exact-binding mismatch rejection,
   all without duplicate charges.
4. Equivalent in-memory post-commit freshness failure with the committed
   reservation and cursor retained.
5. Existing expiry, offset, quota, reconnect, and cleanup tests remain green.

Run:

```sh
npm run lint -w @palancar/security-state
npm run typecheck -w @palancar/security-state
npm run test:unit -w @palancar/security-state
npm run build -w @palancar/security-state
git diff --check -- packages/security-state
```

Completion requires all checks to pass, no files outside the ownership list
to change, and no Azure mutation or smoke run.
