# Luna handoff: Azure foundation deployment evidence

Create one metadata-only evidence document at
`docs/evidence/azure-foundation-2026-08-10.md`. Edit no other file. You are not
alone in the repository; preserve all audio and other work. Do not commit,
apply Terraform, call Azure, open support cases, or mutate external state.

Use only the facts below; do not infer success for absent resources:

- Reviewed Terraform commits: `4bf5e66` (foundation) and `7ee2cfa` (AzureRM 5
  Container Apps log destination apply fix).
- Exact tooling: Terraform `1.15.8`, AzureRM `5.0.1`, AzAPI `2.12.0`.
- Subscription is the committed Visual Studio Enterprise subscription; tenant
  and region `eastus2` are already captured in reviewed Terraform. Do not add a
  user email, credentials, keys, tokens, sensitive outputs, or personal data.
- Bootstrap applied five resources and migrated successfully to the dedicated
  `tfstate-bootstrap/bootstrap/terraform.tfstate` key. Live verification:
  Shared Key disabled, default OAuth enabled, TLS 1.2/HTTPS, versioning on,
  14-day change feed, 14-day blob/container deletion retention, 13-day PITR,
  private bootstrap/dev containers, versioned remote state, no-change plan.
- Development foundation created and tracks 15 non-model resources: resource
  group, $100 monthly resource-group budget, Log Analytics, Application
  Insights, Entra-only workload state account, `SecurityState` and `RateState`
  ARM-managed Tables, ACR, separate image-pull/runtime identities, three role
  assignments (AcrPull, Table Data Contributor, OpenAI User), empty Container
  Apps environment, and Azure OpenAI/Foundry account. Local auth is disabled on
  Foundry. No Container App workload or cleanup Job exists yet.
- First apply exposed the reviewed/corrected AzureRM 5 requirement to pair
  `logs_destination = "log-analytics"` with the workspace. The partial state
  was consistent; after fix/review, plan was five adds and the retry created
  the Container Apps environment, Foundry account, and OpenAI role.
- Both desired model deployments (`gpt-4o-mini-transcribe` version
  `2025-12-15`, and `gpt-5.6-luna` version `2026-07-09`, GlobalStandard capacity
  1) were rejected by Azure with HTTP 400 service code `715-123420`: unusual
  activity/fraud-protection restriction. Azure deployment list is empty.
  Post-failure Terraform plan is exactly `2 add, 0 change, 0 destroy`; only
  these two deployments remain.
- Current official Microsoft-hosted support guidance classifies this code as a
  service-side fraud/risk-protection block rather than quota, RBAC, region, or
  template configuration. It requires private Azure support review; repeated
  retries, alternate regions, quota changes, or resource recreation should not
  be used as workarounds.
- No conversation audio/text or model prompts were sent. This evidence proves
  the foundation state only; it does not pass the Phase 3 transcription or
  generation gates.

Structure the document with Status, Applied/verified, Model-deployment blocker,
Support-case packet, Privacy/retention, and Next gate sections. The support
packet should list service `Azure AI Foundry / Azure OpenAI`, error code,
affected account/resource group/region/deployment names, observed date
`2026-08-10 UTC`, and a request for account/subscription-level deployment-block
review by the fraud/risk-protection team. Explicitly say correlation/trace IDs
were not returned by Terraform and must be collected privately from Azure
support/activity diagnostics; do not invent them.

Run `git diff --check -- docs/evidence/azure-foundation-2026-08-10.md`, report
the changed file, and end `DONE`.
