# Luna handoff — LiteLLM proxy image

## Objective

Add the LiteLLM proxy sidecar image source under `apps/litellm-proxy` with a
fixed proxy image pin, backend-specific config rendering, content-free metadata
endpoint, and local validation script. This slice must not touch relay,
generation, or Terraform files.

## Files you may change

- `apps/litellm-proxy/Dockerfile`
- `apps/litellm-proxy/entrypoint.sh`
- `apps/litellm-proxy/metadata-server.mjs`
- `apps/litellm-proxy/config.template.yaml`
- `apps/litellm-proxy/README.md`
- `apps/litellm-proxy/scripts/validate-local.mjs`
- root `package.json` only if needed to add a workspace script; prefer not.

## Files you must not change

- `packages/**`
- `apps/relay/**`
- `infra/**`
- generated `dist/**`
- `package-lock.json` unless root package metadata must change.

## Requirements

- Read `/home/dev/repos/palancar_ws/palancar/.codex/plans/litellm-openrouter-generation-plan.md`
  before editing.
- Base image must be exactly:
  `ghcr.io/berriai/litellm:v1.75.5-stable@sha256:751ba882360f8d62c63ceb0a5b628f897cee0e0b93b3596c81ff1228e6b77ce3`
- Container listens:
  - LiteLLM on `0.0.0.0:4000`
  - metadata server on `0.0.0.0:4001`
- Sidecar container name in infra will be `litellm`; document this.
- `entrypoint.sh`:
  - `set -eu`
  - validates `PALANCAR_LITELLM_BACKEND=openrouter|azure`.
  - OpenRouter requires:
    - `PALANCAR_LITELLM_UPSTREAM_MODEL` starting `openrouter/`
    - `OPENROUTER_API_KEY`
    - rejects Azure credential/env fields.
  - Azure requires:
    - `PALANCAR_LITELLM_UPSTREAM_MODEL` starting `azure/`
    - `AZURE_API_BASE`
    - `AZURE_API_VERSION`
    - `AZURE_API_KEY`
    - rejects `OPENROUTER_API_KEY`.
  - Writes rendered config to `/tmp/palancar-litellm.yaml`.
  - Starts metadata server and LiteLLM; if either exits, the container exits.
- Metadata endpoint:
  - `GET /palancar/provider`
  - returns only:
    - `alias: "palancar-generation"`
    - `backend`
    - `upstreamModel`
  - no secrets.
- Config:
  - fixed model alias `palancar-generation`
  - provider route from `PALANCAR_LITELLM_UPSTREAM_MODEL`
  - OpenRouter key from `OPENROUTER_API_KEY`
  - Azure key/base/version from env
  - master key from `LITELLM_MASTER_KEY`
  - no DB
  - no raw request/response callbacks/logging
  - retries/fallbacks disabled or bounded to one attempt
- Local validation script:
  - can be `apps/litellm-proxy/scripts/validate-local.mjs`
  - builds/runs detached image if practical, or validates entrypoint/config
    rendering without a real OpenRouter call.
  - must assert unauthenticated `/v1/models` returns 401, authenticated response
    has `.data` array and exactly one `.data[].id == "palancar-generation"`,
    and `/health/readiness` succeeds.

## Verification

Run and report actual output:

```sh
docker build -f apps/litellm-proxy/Dockerfile -t palancar-litellm-proxy:local .
```

If Docker runtime works locally, also run:

```sh
node apps/litellm-proxy/scripts/validate-local.mjs
```

## Completion report

Report:

- changed files
- verification commands and actual results
- unresolved issues

End with `DONE` only if complete.
