# Luna handoff — Relay LiteLLM host config and readiness

## Objective

Wire the relay executable to select `mock` or `litellm` generation explicitly,
and add dependency-aware `/readyz` for LiteLLM. This slice depends on
`LiteLLMChatGenerationProvider` existing in `@palancar/generation`; if it is not
present, stop and report that blocker.

## Files you may change

- `apps/relay/src/host.ts`
- `apps/relay/test/relay-host.test.ts`
- `apps/relay/package.json` only if a script-only change is required.

## Files you must not change

- Any file outside `apps/relay`.
- `apps/relay/src/session.ts`.
- `packages/**`.
- `infra/**`.
- generated `dist/**`.

## Requirements

- Read `/home/dev/repos/palancar_ws/palancar/.codex/plans/litellm-openrouter-generation-plan.md`
  before editing.
- Executable env parsing must require `PALANCAR_GENERATION_PROVIDER=mock|litellm`.
  Do not default executable startup to mock.
- Preserve `createRelayHost(config)` dependency injection for tests.
- For `mock`, use the existing deterministic mock generation service.
- For `litellm`, require:
  - `PALANCAR_LITELLM_BASE_URL`
  - `PALANCAR_LITELLM_API_KEY`
  - `PALANCAR_LITELLM_MODEL`
  - `PALANCAR_LITELLM_EXPECTED_BACKEND`
  - `PALANCAR_LITELLM_EXPECTED_UPSTREAM_MODEL`
  - `PALANCAR_LITELLM_METADATA_URL`
  - optional `PALANCAR_LITELLM_TIMEOUT_MS`
- Config validation errors must be generic. `main.ts` should continue printing
  only `relay failed to start`.
- `/healthz` remains exactly process-only `{ ok: true }`.
- `/readyz` returns content-free generation status:
  - mock: status ready with provider `mock`, providerId matching the mock
    provider, model `mock`, upstreamReady true.
  - litellm: call authenticated `<baseUrl>/v1/models` and unauthenticated
    `<metadataUrl>/palancar/provider`.
    - timeout 2_000 ms for each readiness fetch.
    - max response bytes 16_384.
    - `/v1/models` response must parse to an object with `.data` array and
      exactly one item whose `.id` equals `PALANCAR_LITELLM_MODEL`.
    - metadata must parse to object with exact `alias`, `backend`, and
      `upstreamModel` matching expected values.
    - non-2xx, timeout, malformed JSON, duplicate/missing alias, backend
      mismatch, alias mismatch, upstream mismatch -> HTTP 503 with
      `{ ready:false, generation:{... upstreamReady:false } }`.
  - Never include API key, provider response body, prompts, transcripts, or
    secrets in response or errors.

## Tests

Update `apps/relay/test/relay-host.test.ts`.

Test at least:

- `parseRelayHostConfig` with `PALANCAR_GENERATION_PROVIDER=mock` works.
- executable parse without provider fails generically.
- litellm config creates provider identity without leaking key.
- missing/malformed LiteLLM vars fail config parsing.
- `/healthz` remains 200 even when LiteLLM readiness fails.
- `/readyz` mock response is 200 and content-free.
- `/readyz` litellm response is 200 when mocked `/v1/models` and metadata are
  valid.
- `/readyz` litellm response is 503 for non-2xx, timeout, malformed JSON,
  duplicate alias, missing alias, backend mismatch, alias mismatch, and
  upstream mismatch.

## Verification

Run and report actual output:

```sh
npm run lint -w @palancar/relay
npm run typecheck -w @palancar/relay
npm run test -w @palancar/relay
```

## Completion report

Report:

- changed files
- verification commands and actual results
- unresolved issues

End with `DONE` only if complete.
