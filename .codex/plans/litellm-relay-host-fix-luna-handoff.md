# Luna handoff — Relay LiteLLM readiness review fixes

## Objective

Fix Sol review findings for the relay LiteLLM host/readiness slice.

## Files you may change

- `apps/relay/src/host.ts`
- `apps/relay/test/relay-host.test.ts`

## Files you must not change

- Any other file.

## Required fixes

1. In readiness fetches, set `redirect: 'error'` or an equivalent reject
   behavior so redirects never become successful readiness and the bearer key is
   not forwarded. Add tests for redirects on `/v1/models` and metadata.
2. Add readiness tests for:
   - `/v1/models` response body over 16 KiB.
   - metadata response body over 16 KiB.
   - metadata non-2xx.
   - metadata timeout.
   - metadata malformed JSON.
3. Use exact response equality where practical and include canary strings in
   bad provider bodies to prove `/readyz` never leaks body content or the
   LiteLLM API key.
4. Remove unused optional mock readiness `check` if still present.

## Verification

Run and report actual output:

```sh
npm run lint -w @palancar/relay
npm run typecheck -w @palancar/relay
npm run test -w @palancar/relay
```

## Completion report

Report changed files, verification output, unresolved issues. End with `DONE`
only if complete.
