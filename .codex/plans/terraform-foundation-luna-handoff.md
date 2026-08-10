# Terraform bootstrap/dev foundation handoff (GPT-5.6 Luna xhigh)

## Scope and role

Implement a reviewable Terraform bootstrap and development-foundation slice on files disjoint from active npm work. You are not alone in the repository; preserve unrelated edits. Do not run `terraform apply`, mutate Azure, commit, edit npm/code/docs outside `infra`, or create a relay workload that requires an image.

Allowed path: `infra/**` only.

## Fixed decisions

- Terraform CLI: `>= 1.15.0, < 1.16.0` (installed 1.15.6).
- Providers pinned exactly: `hashicorp/azurerm` `4.81.0`, `Azure/azapi` `2.11.0`.
- Subscription `a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1`, tenant `c69da7c1-f194-493b-9697-5b4bc8b56f37`, region `eastus2`.
- Environment/prefix: `dev` / `palancar`; use deterministic lower-case Azure-safe names and a stable short suffix derived from subscription/environment where global uniqueness is required.
- Local development authenticates with Azure CLI. Do not store credentials, access keys, SAS, model keys, Terraform plan files, or live state in the repository.
- AzureRM owns every resource it supports. Use AzAPI only for a whole resource that AzureRM 4.81.0 cannot represent; never split property ownership.
- Budget/alerts and workload state precede model/warm-workload spend.
- This slice creates bootstrap and the dev foundation only. Relay Container App and cleanup Job resources depend on an immutable application image and belong to the later workload apply. Provide clean module interfaces/placeholders for them but do not deploy a public placeholder image.

## Required reading

- `docs/phase-0-decisions.md`
- `docs/adr/0003-client-authentication.md`
- `docs/adr/0004-data-retention.md`
- `docs/adr/0005-compute-host.md`
- Terraform sections of `docs/implementation-plan.md`

## Repository structure

Implement at least:

```text
infra/
  README.md
  .gitignore
  bootstrap/
    versions.tf providers.tf variables.tf main.tf outputs.tf
    backend.hcl.example
    terraform.tfvars.example
    .terraform.lock.hcl
  modules/
    budget/
    workload-state/
    container-registry/
    identities-rbac/
    observability/
    container-app-environment/
    foundry/
  environments/dev/
    versions.tf providers.tf variables.tf locals.tf main.tf outputs.tf
    backend.hcl.example
    terraform.tfvars.example
    .terraform.lock.hcl
```

Keep modules small, typed, documented, and output only non-secret integration values.

## Bootstrap stack

Create a dedicated state resource group, StorageV2 account, and private blob container. Requirements:

- Deterministic globally valid account name (3-24 lowercase alphanumeric), minimum TLS 1.2, public blob/container access disabled, HTTPS only, infrastructure encryption where supported, no cross-tenant replication.
- Blob versioning, 14-day blob/container soft deletion, restore-friendly settings.
- Entra-based backend path. Use AzureRM's Azure AD storage authentication setting and create least-privilege Blob Data Contributor assignment for the current apply principal when requested by variable. Shared-key access is disabled in the accepted steady state; if provider bootstrapping forces a staged transition, make it an explicit variable defaulting safely and explain exact two-apply/migration steps without leaking a key.
- `prevent_destroy` on state resource group/account/container where Terraform supports it.
- Non-secret outputs required to fill backend config: resource group, account, container, bootstrap/dev state keys.
- No backend can create itself. README documents local bootstrap apply, Entra role propagation, `terraform init -migrate-state`, `terraform state list`, no-change plan, blob-version check, and restore exercise.
- Committed backend examples contain placeholders only and use Entra/Azure CLI flags, never keys.

## Dev foundation modules

### Budget

- Resource-group-scoped monthly budget with amount/start/end/contact variables and notification thresholds at 50%, 80%, and 100% actual plus a forecast threshold.
- No hard-coded personal email; example uses `owner@example.com`. Validation requires at least one syntactically plausible contact at plan/apply.
- Ensure the dependency graph can make this module precede Foundry model deployments.

### Workload state

- Dedicated StorageV2 account separate from Terraform state, shared-key access disabled, TLS 1.2+, HTTPS only, public blob access disabled, default public network access allowed for the initial Azure-hosted workload/CLI phase unless a variable explicitly changes it.
- Azure Tables named exactly `SecurityState` and `RateState`.
- Use Azure AD data-plane authentication. The Terraform apply principal may receive Storage Table Data Contributor only when an explicit variable enables bootstrap data-plane management; the runtime identity role is owned by identities/RBAC.
- No stored audio/content resources, queues, blobs, or diagnostics containing table entity bodies.
- Output account/table endpoints and IDs only; no keys.

### Identities/RBAC

- Separate user-assigned `image-pull` and `runtime` identities.
- Image-pull gets only `AcrPull` on ACR.
- Runtime gets Storage Table Data Contributor on workload-state account and Cognitive Services OpenAI User (or the current exact least-privilege inference role available to AzureRM) on the Foundry/OpenAI account.
- Expose identity IDs, client IDs, and principal IDs; these are non-secret.
- Role assignments have explicit dependencies and stable names if practical.

### Container Registry

- Basic SKU, admin disabled, public access initially enabled for local image push, anonymous pull disabled, deterministic name.
- Output login server and ID.

### Observability

- Log Analytics workspace with 30-day retention and immediate purge on day 30 using the AzureRM property if available.
- Workspace-based Application Insights.
- No request/response body capture or conversation content settings.
- Outputs needed by Container Apps environment; mark workspace shared key output sensitive if the AzureRM environment resource requires it. Do not expose it as a root output.

### Container Apps environment

- Consumption environment wired to Log Analytics, with no workload yet.
- Output environment ID, name, and default domain if known after apply.

### Foundry/OpenAI

- AzureRM cognitive account kind `OpenAI`, SKU `S0`, custom subdomain, managed identity/local-auth posture suitable for Entra-only inference (`local_auth_enabled = false` if supported), public network initially enabled, exact region and tags.
- Exact, variable-driven deployments defaulting to:
  - deployment `gpt-4o-mini-transcribe`, model `gpt-4o-mini-transcribe`, version `2025-12-15`, format `OpenAI`, SKU `GlobalStandard`, small explicit capacity.
  - deployment `gpt-5-6-luna`, model `gpt-5.6-luna`, version `2026-07-09`, format `OpenAI`, SKU `GlobalStandard`, small explicit capacity.
- Pin model versions and disable automatic upgrades where AzureRM supports it.
- Validate names, positive capacities, and distinct deployments. Output endpoint, account ID, and deployment names only.
- Foundry account/model resources depend on budget readiness from the environment composition.

## Dev composition

- One resource group with required tags: application, environment, managed-by, data-classification.
- Compose modules in an acyclic order: RG -> budget/observability/state/ACR/identities/environment -> Foundry deployments -> RBAC. Where role scope needs the account, split identity creation from role assignment within the module cleanly or use module inputs without cycles.
- The runtime identity Table role must exist before a later workload can become ready. ACR pull role must exist before a later workload references an image.
- No Key Vault unless an unavoidable secret exists (none in this slice).
- No Container App/Job placeholder image, custom domain, private endpoint, CI federation, or DNS resource.
- Root outputs: resource group, region, ACR server, Container Apps environment ID/domain, workload table endpoint/names, Foundry endpoint/deployment names, runtime identity client ID, image-pull identity ID, App Insights connection string marked sensitive if output at all. Never output keys or state-derived secrets.

## Variable examples and validation

- Examples use placeholders for budget email and state suffix but real non-secret subscription/tenant/region/model defaults.
- Add validation for Azure-safe prefix/environment, positive budget/capacity, RFC3339 budget dates accepted by the resource, email list, retention fixed to 30, and supported deployment SKU.
- Keep live `*.tfvars`, backend configs, plans/JSON plans, state, crash logs, and `.terraform/` ignored while explicitly retaining `*.tfvars.example`, `backend.hcl.example`, and `.terraform.lock.hcl`.

## Verification

Run without apply:

1. `terraform fmt -check -recursive infra`
2. `terraform -chdir=infra/bootstrap init -backend=false`
3. `terraform -chdir=infra/bootstrap validate`
4. `terraform -chdir=infra/environments/dev init -backend=false`
5. `terraform -chdir=infra/environments/dev validate`
6. Inspect provider schemas/resources as needed; fix all deprecations/errors in the pinned versions.
7. `git diff --check`

If a no-refresh plan can run safely without writing a plan file or requiring unknown secret values, run it with explicit ephemeral CLI variables; otherwise explain the exact remaining plan-time input. Do not apply. Report every changed path, provider lock versions/platform, validation results, ownership decisions, any provider limitation, and `DONE` only when checks pass.
