# Relay Container App workload

This module owns the complete relay Container App through one `azapi_resource`
using `Microsoft.App/containerApps@2026-01-01`. It requires an immutable
`<acr>.azurecr.io/palancar-relay@sha256:<digest>` image and two user-assigned
identities: one for image pulls and one for application runtime access. The
Container App name must contain 2-32 lower-case alphanumeric characters with
single internal hyphens only.

The deployed workload has exactly one relay container with 0.25 CPU and 0.5
GiB, exactly one warm replica, and a hard maximum of one replica. The image is
always digest-pinned. Revision mode is `Single` and
`configuration.maxInactiveRevisions` is exactly `1`. The configuration emits
an empty secrets collection, and every environment entry is a nonsecret value.
No probes or additional containers are configured.

Generation is fixed to the Entra-authenticated Azure OpenAI runtime contract:

```text
PALANCAR_GENERATION_PROVIDER=azure-openai
PALANCAR_AZURE_GENERATION_ENDPOINT=https://<resource>.openai.azure.com
PALANCAR_AZURE_GENERATION_DEPLOYMENT=gpt-5.6-luna
AZURE_CLIENT_ID=<runtime-user-assigned-managed-identity-client-id>
```

The generation origin must be a lower-case canonical HTTPS origin with an
exact `.openai.azure.com` suffix and no userinfo, port, path, query, fragment,
whitespace, or trailing slash. The deployment name is fixed exactly to
`gpt-5.6-luna`.

The module preserves the relay host, security-state, telemetry, browser
policy, deployment-slot, language-boundary, and Azure transcription
environment contracts. The runtime identity is configured with the `Main`
lifecycle; the image-pull identity uses `None`. The caller must provide
nonempty dependency tokens from the Cognitive Services OpenAI User and
Monitoring Metrics Publisher role assignments. These tokens ensure Terraform
ordering and are not sent to Azure.

Ingress is external HTTP on target port 8787, disallows insecure HTTP, and
sends 100 percent of traffic to the latest single revision. The module emits
only the Azure-provided ingress FQDN, latest revision name, and running status
as computed outputs when Azure returns them.

Transcription is either `mock` with no Azure fields or `azure-realtime` with
the canonical realtime endpoint and exact `gpt-4o-mini-transcribe` deployment.
Azure generation and transcription use the managed identity; no credential
values are accepted by this module.
