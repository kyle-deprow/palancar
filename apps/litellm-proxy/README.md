# Palancar LiteLLM proxy

This image is the LiteLLM sidecar for the Palancar relay. It runs one LiteLLM
process on `0.0.0.0:4000`; the relay reaches it at `127.0.0.1:4000`. There is
no secondary metadata service or secondary exposed port.

The image is pinned to the verified `linux/amd64` manifest for LiteLLM
`v1.94.0`:

```text
ghcr.io/berriai/litellm:v1.94.0@sha256:fa88aab52bfcf894f964b855f31be0ef83cba9f5be5d94bbc46f78fcdeb4d46b
```

## Production configuration

Production accepts only OpenRouter. It requires:

- `PALANCAR_LITELLM_BACKEND=openrouter`.
- `PALANCAR_LITELLM_UPSTREAM_MODEL=openrouter/<model>`.
- `OPENROUTER_API_KEY`.
- `LITELLM_MASTER_KEY`: the key the relay uses to authenticate to LiteLLM.

Production permits only `OPENROUTER_API_KEY` in the `OPENROUTER_*`
namespace and rejects every `AZURE_*` variable. This is a namespace rule, so
new Azure variables are rejected without requiring an entrypoint update.

The entrypoint rejects every backend other than `openrouter` before inspecting
provider credentials. In particular, `PALANCAR_LITELLM_BACKEND=azure` always
returns the same content-free configuration error. There is no bypass flag.
It then replaces itself with one LiteLLM process using the static
`config.openrouter.yaml`; it never renders a config or writes credentials to
disk.

The production configuration exposes exactly one alias,
`palancar-generation`. Model, global, and router retries are zero and fallback
lists are empty.

## Azure qualification status

Azure is **UNQUALIFIED** and is not production-selectable. The Dockerfile does
not copy `config.azure.yaml`, and the entrypoint has no path that can select
it. That file is retained only as a managed-identity qualification fixture.

The fixture requires:

- `PALANCAR_LITELLM_UPSTREAM_MODEL=azure/<deployment>`.
- `AZURE_API_BASE`.
- `AZURE_API_VERSION`.
- `AZURE_CLIENT_ID` for the user-assigned managed identity.
- `AZURE_CREDENTIAL=DefaultAzureCredential`.

The qualification exercises managed-identity bearer authentication, token
caching, and refresh against local fake endpoints. Even when those technical
checks pass, the command ends at an explicit UNQUALIFIED policy gate. Azure
must remain non-production until that gate is deliberately changed as part of
an authorized production qualification.

## Local validation

From the repository root:

```sh
sh -n apps/litellm-proxy/entrypoint.sh
docker build --platform linux/amd64 \
  -f apps/litellm-proxy/Dockerfile \
  -t palancar-litellm-proxy:local .
node apps/litellm-proxy/scripts/validate-local.mjs
```

With no argument—the CI/default gate—the validator runs only full production
OpenRouter validation and must pass. Its temporary config uses the actual
`openrouter/fake-model` provider path with LiteLLM's supported `api_base`
override pointed at a local fake upstream. It checks catalog authentication,
the exact alias, and success/429/500/timeout behavior with exactly one upstream
request and no fallback. It also checks production backend rejection,
credential namespace isolation, and dummy-secret safety.

Run the Azure-only qualification gate explicitly:

```sh
node apps/litellm-proxy/scripts/validate-local.mjs --azure-qualification
```

This command is expected to exit nonzero while Azure remains unqualified. It
runs only the managed-identity qualification against local fake Container Apps
identity and Azure endpoints, then stops at the explicit policy gate.

Run both gates with:

```sh
node apps/litellm-proxy/scripts/validate-local.mjs --all
```

`--all` is also expected to exit nonzero at the Azure qualification gate.
Unknown arguments fail with the validator usage message.

The production image remains pinned to the verified `linux/amd64` child. The
validator uses the native-architecture child of the same official v1.94.0
release index. It deliberately fails when Docker or the exact runtime is
unavailable and never uses real provider or identity credentials.
