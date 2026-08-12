# Palancar LiteLLM proxy

This image is the `litellm` sidecar for the Palancar relay. The relay talks to
LiteLLM at `127.0.0.1:4000`; the sidecar metadata endpoint listens on
`0.0.0.0:4001`. The image exposes both ports, although the Container App
ingress remains on the relay. The sidecar container name is `litellm`.

The image is pinned to:

```text
ghcr.io/berriai/litellm:v1.75.5-stable@sha256:751ba882360f8d62c63ceb0a5b628f897cee0e0b93b3596c81ff1228e6b77ce3
```

Required environment:

- `PALANCAR_LITELLM_BACKEND`: exactly `openrouter` or `azure`.
- `PALANCAR_LITELLM_UPSTREAM_MODEL`: `openrouter/...` for OpenRouter or
  `azure/...` for Azure.
- `LITELLM_MASTER_KEY`: key required by the relay for LiteLLM requests.

OpenRouter additionally requires `OPENROUTER_API_KEY` and rejects Azure
credential fields, including `AZURE_OPENAI_API_KEY`, `AZURE_USERNAME`, and
`AZURE_PASSWORD`. Azure additionally requires `AZURE_API_BASE`,
`AZURE_API_VERSION`, and `AZURE_API_KEY`, and rejects `OPENROUTER_API_KEY`.
The rendered configuration is written with mode `0600` to
`/tmp/palancar-litellm.yaml`.

The pinned upstream image currently resolves to `linux/amd64`; local arm64
hosts can build the derived image because the Dockerfile does not execute build
steps, but runtime validation requires an amd64-capable Docker runtime.

The only configured model alias is `palancar-generation`. Retries and
fallbacks are disabled, callbacks are empty, and request/response bodies are
not configured for logging. No database is configured.

`GET /palancar/provider` on port 4001 returns only the alias, selected backend,
and upstream model; it never returns credentials.

Build and validate locally:

```sh
docker build -f apps/litellm-proxy/Dockerfile -t palancar-litellm-proxy:local .
node apps/litellm-proxy/scripts/validate-local.mjs
```

Validation uses dummy credentials and never makes an upstream inference call.
