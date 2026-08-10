# Azure foundation evidence — 2026-08-10

Follow-on workload deployment status is recorded in
`docs/evidence/deployment-status-2026-08-10.md`.

## Status

The Azure foundation is deployed and verified, but model deployment remains
blocked with service code `715-123420`. The current diagnosis is consistent
with service-side fraud/risk protection and is pending Azure Support
confirmation. The post-failure Terraform plan is exactly
`2 add, 0 change, 0 destroy`; only the two desired model deployments remain.

This evidence covers reviewed Terraform commits `4bf5e66` (foundation) and
`7ee2cfa` (AzureRM 5 Container Apps log destination apply fix). Verification
used Terraform `1.15.8`, AzureRM `5.0.1`, and AzAPI `2.12.0` in the committed
Visual Studio Enterprise subscription. The tenant and `eastus2` region are
captured in the reviewed Terraform.

## Applied/verified

The bootstrap applied five resources and migrated successfully to the
dedicated `tfstate-bootstrap/bootstrap/terraform.tfstate` key. Live
verification confirmed:

- Shared Key is disabled and default OAuth is enabled.
- TLS 1.2 and HTTPS are enforced.
- Blob versioning and a 14-day change feed are enabled.
- Blob and container deletion retention are both 14 days.
- Point-in-time restore retention is 13 days.
- The bootstrap and development containers are private.
- Remote state is versioned, and the resulting plan had no changes.

The development foundation created and tracks 15 non-model resources:

- The resource group and its $100 monthly resource-group budget.
- Log Analytics and Application Insights.
- An Entra-only workload state account with ARM-managed `SecurityState` and
  `RateState` Tables.
- Azure Container Registry.
- Separate image-pull and runtime identities.
- Three role assignments: AcrPull, Storage Table Data Contributor, and
  Cognitive Services OpenAI User.
- An empty Container Apps environment.
- The Azure OpenAI/Foundry account, with local authentication disabled.

At the time of this foundation check, no Container App workload or cleanup Job
existed yet. The relay workload was deployed later on 2026-08-10; see the
follow-on deployment status evidence linked above.

The first apply exposed the reviewed AzureRM 5 requirement to pair
`logs_destination = "log-analytics"` with the Log Analytics workspace. The
partial state was consistent. After the fix and review, the plan contained five
adds; the retry created the Container Apps environment, Foundry account, and
OpenAI role assignment.

## Model-deployment blocker

Azure rejected both desired deployments with HTTP 400 service code
`715-123420`:

- `gpt-4o-mini-transcribe`, model version `2025-12-15`, GlobalStandard capacity
  1.
- `gpt-5.6-luna`, model version `2026-07-09`, GlobalStandard capacity 1.

The Azure deployment list is empty. The current diagnosis is consistent with a
service-side fraud/risk-protection block, based on this
[Microsoft-hosted support discussion](https://learn.microsoft.com/en-us/questions/5943036/azure-openai-deployment-blocked-by-715-123420-desp),
but it has not been independently proven as the exclusive cause and remains
pending Azure Support confirmation. The observed pattern does not currently
align with a quota, RBAC, region, or template-configuration issue. While
Support investigates, avoid repeated retries, region or quota changes, and
resource recreation because they are unlikely to add diagnostic value.

## Support-case packet

- Service: Azure AI Foundry / Azure OpenAI
- Error: HTTP 400, service code `715-123420`
- Affected account: the development Azure OpenAI/Foundry account tracked by the
  reviewed Terraform
- Affected resource group: the development foundation resource group
- Region: `eastus2`
- Affected deployments: `gpt-4o-mini-transcribe` and `gpt-5.6-luna`
- Observed: `2026-08-10 UTC`
- Request: account/subscription-level deployment-block review by the
  fraud/risk-protection team

Terraform did not return correlation or trace IDs. Those identifiers may be
provided by Azure Support or Activity Log diagnostics and should remain
private; none are invented here.

### Private attachment checklist — Azure Support portal only; never Git

Provide the following only through the private Azure Support portal. Never add
these details to Git:

- The exact subscription ID and account resource ID.
- The exact or narrow UTC failure time from private logs.
- The full error response.
- The deployment, model, SKU, and capacity.
- Any operation, correlation, trace, or request IDs that Azure Support or
  Activity Log diagnostics may provide.

## Privacy/retention

No conversation audio, conversation text, model prompts, credentials, keys,
tokens, sensitive outputs, user email, or personal data are included in this
evidence. No conversation audio or text and no model prompts were sent.

The verified bootstrap controls include versioned remote state, a 14-day
change feed, 14-day blob and container deletion retention, and 13-day
point-in-time restore retention.

## Next gate

Obtain the required private Azure support review of the account/subscription
deployment block. The two model deployments remain the only planned resources.
Until they can be deployed, this evidence proves foundation state only and does
not pass the Phase 3 transcription or generation gates.
