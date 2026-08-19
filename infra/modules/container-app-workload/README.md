# Relay Container App workload

This module owns the complete relay Container App through one
`azapi_resource` using `Microsoft.App/containerApps@2026-01-01`. It expects an
immutable ACR digest and two user-assigned identities: one for image pulls and
one for application runtime access. The module does not create secrets or
accept registry credentials.

The workload uses a single revision, exactly one warm replica with a hard
maximum of one, an Azure-provided external WebSocket origin, a content-free
TCP liveness probe, and bounded HTTP readiness probes. Both containers use
exactly 0.25 CPU and 0.5 GiB.
Runtime configuration is supplied through environment variables, with the
live four-field Application Insights connection string accepted only as a
sensitive input. The relay receives only its canonical lower-case
`InstrumentationKey` and slash-free approved `IngestionEndpoint`; the
`LiveEndpoint` and `ApplicationId` input fields are validated but omitted. The
managed identities are configured with `None` and `Main` lifecycles for image
pull and application runtime respectively.

Ingress is external HTTP on target port 8787, disallows insecure HTTP, and
sends 100 percent of traffic to the latest single revision. `exposedPort` and
additional port mappings are intentionally absent: the
[2026-01-01 Container Apps schema](https://learn.microsoft.com/azure/templates/microsoft.app/2026-01-01/containerapps)
defines `exposedPort` for TCP ingress. Readiness probes use a 10-second period
and a 7-second timeout to cover the relay's bounded 6-second checks; no probe
uses headers or secret-bearing fields.

The caller must provide nonempty dependency tokens from the workload identity's
Key Vault Secrets User, Cognitive Services OpenAI User, and Monitoring Metrics
Publisher role assignments. They ensure the Container App is created after
RBAC readiness; they are not sent to Azure.

Every deployed relay uses `PALANCAR_SECURITY_MODE=azure-table` with the
workload Table endpoint, `SecurityState` and `RateState` names, and the runtime
user-assigned identity client ID. Production telemetry always emits the
deployment slot, required sensitive Application Insights connection string,
and both Statsbeat disable switches. Transcription is either `mock` with no
Azure fields or `azure-realtime` with the canonical endpoint and the exact
`gpt-4o-mini-transcribe` deployment. Azure transcription and telemetry use the
managed identity; no Azure API keys are accepted.

## Optional OpenRouter LiteLLM sidecar

Set `enable_litellm_sidecar = true` to add a container named `litellm` on the
same replica as the relay. The sidecar uses the immutable
`litellm_image_digest` from the same `acr_login_server` used by the relay,
binds internally on port 4000, and routes the fixed
relay model alias `palancar-generation` to an `openrouter/` provider-prefixed
`litellm_upstream_model`. Azure is not production-qualified and the module
rejects it.

When enabled, provide HTTPS Key Vault secret URLs for
`litellm_master_key_secret_url` and `openrouter_api_key_secret_url`. They must
be the exact versionless `litellm-master-key` and `openrouter-api-key` URLs in
`key_vault_uri`. Container App secret references use the runtime identity ARM
ID, so Terraform never accepts or writes secret values and versionless URLs can
follow Key Vault rotation. Azure provider fields must remain empty.

When disabled (the default), the sidecar and its secrets are omitted, the
relay explicitly uses `PALANCAR_GENERATION_PROVIDER=mock`, and every LiteLLM
and provider input must be empty. This module does not create a Key Vault or
secret versions; those resources and deployment-time secret value writes
remain outside this slice.
