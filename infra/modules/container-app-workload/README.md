# Relay Container App workload

This module owns the complete relay Container App through one
`azapi_resource` using `Microsoft.App/containerApps@2026-01-01`. It expects an
immutable ACR digest and two user-assigned identities: one for image pulls and
one for application runtime access. The module does not create secrets or
accept registry credentials.

The workload uses a single revision, one warm replica, an Azure-provided
external WebSocket origin, and HTTP liveness/readiness probes. Runtime
configuration is supplied through non-secret environment variables and the
managed identities are configured with `None` and `Main` lifecycles for image
pull and application runtime respectively.

## Optional LiteLLM sidecar

Set `enable_litellm_sidecar = true` to add a container named `litellm` on the
same replica as the relay. The sidecar uses the immutable
`litellm_image_digest`, binds internally on port 4000, and routes the fixed
relay model alias `palancar-generation` to either an `openrouter/` or `azure/`
provider-prefixed `litellm_upstream_model`. `litellm_cpu` and
`litellm_memory` control its resource allocation.

When enabled, provide HTTPS Key Vault secret URLs for
`litellm_master_key_secret_url` and the selected provider key URL. Container
App secret references use the runtime identity ARM ID, so Terraform never
accepts or writes secret values. OpenRouter mode requires
`openrouter_api_key_secret_url`; Azure mode requires `azure_api_base`,
`azure_api_version`, and `azure_api_key_secret_url`. Unused provider fields and
all generation secret URLs must be empty as appropriate for the selected mode.

When disabled (the default), the sidecar and its secrets are omitted, the
relay explicitly uses `PALANCAR_GENERATION_PROVIDER=mock`, and no
`PALANCAR_LITELLM_*` variables are emitted. This module does not create a Key
Vault or secret versions; those resources and deployment-time secret value
writes remain outside this slice.
