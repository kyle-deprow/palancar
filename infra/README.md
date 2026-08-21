# Palancar infrastructure

This directory contains the non-secret Terraform bootstrap and development
foundation. Terraform is pinned exactly to `1.15.8` by `.terraform-version`;
provider locks pin AzureRM `5.0.1` and, in dev only, AzAPI `2.12.0`.

The fixed development subscription is
`a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1`, tenant is
`c69da7c1-f194-493b-9697-5b4bc8b56f37`, and region is `eastus2`. Local
development authenticates with Azure CLI/Entra. Never commit credentials,
keys, certificates, backend files, live variables, state, or Terraform plans.

## Ownership and workload boundary

AzureRM owns every foundation resource it can represent. In the workload-state
module AzureRM owns the StorageV2 account, while AzAPI owns each entire
`Microsoft.Storage/storageAccounts/tableServices/tables` child. AzureRM does
not own those Tables because its Table resource uses Shared Key, which is
disabled on this account. The exact AzAPI Table IDs and names are non-secret
outputs.

The foundation can optionally create the relay Container App and its workload
Key Vault once the immutable relay image digest is supplied. The runtime
workload is a single relay container; generation uses direct Azure OpenAI
through the relay runtime's Entra-managed identity. The exact pinned Azure
Realtime `gpt-4o-mini-transcribe` deployment and relay transcription path are
deployed and enabled. This is not a language or physical-hardware production
promotion. The deployed workload stack also owns the expiry-cleanup Job, the
relay action group, and its six scheduled-query alerts. Private endpoint,
custom DNS, CI federation, and placeholder images remain outside this stack.
The relay language boundary is an explicit required module input: dev sets
`development-provisional`, while staging and production must set `deny-all`.
Terraform emits it once as the nonsecret
`PALANCAR_LANGUAGE_BOUNDARY_MODE` relay environment variable.

## Bootstrap with local state, then migrate

The committed bootstrap stack intentionally has no backend declaration, so its
first initialization and apply use local state:

```sh
az login --tenant c69da7c1-f194-493b-9697-5b4bc8b56f37
az account set --subscription a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1

terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap plan -refresh=false -lock=false
terraform -chdir=infra/bootstrap apply
```

The bootstrap creates one protected state account and two protected private
containers: one for `bootstrap/terraform.tfstate` and one for
`dev/terraform.tfstate`. The initial operator can temporarily receive
account-scoped `Storage Blob Data Contributor` so AzureRM can create and manage
both containers through Entra auth while Shared Key remains disabled. Allow
for role propagation and rerun the same apply if container creation races it.
Future CI identities should be container-scoped; do not treat the operator's
temporary account scope as already-separated state permissions.

After the account and both containers exist:

1. Copy `infra/bootstrap/backend.tf.example` to ignored
   `infra/bootstrap/backend.tf`.
2. Copy `infra/bootstrap/backend.hcl.example` to ignored
   `infra/bootstrap/backend.hcl` and replace its output placeholders.
3. Migrate the existing local bootstrap state:

```sh
terraform -chdir=infra/bootstrap init \
  -backend-config=backend.hcl \
  -migrate-state
terraform -chdir=infra/bootstrap state list
terraform -chdir=infra/bootstrap plan
```

Keep the original local state protected until `state list`, a no-change plan,
blob-version verification, and the restore exercise all pass.

## Initialize dev directly against remote state

Dev retains its backend declaration. It has no local state to migrate. Copy
`infra/environments/dev/backend.hcl.example` to the ignored
`infra/environments/dev/backend.hcl`, fill it from bootstrap outputs, and
initialize directly:

```sh
terraform -chdir=infra/environments/dev init -backend-config=backend.hcl
terraform -chdir=infra/environments/dev validate
terraform -chdir=infra/environments/dev plan
```

The dev plan requires live first-of-month UTC budget dates and at least one real
notification address. When the relay is enabled, `foundry_deployments` must be
exactly this two-deployment map:

| Deployment | Model version | Format | SKU | Capacity | Upgrade |
| --- | --- | --- | --- | ---: | --- |
| `gpt-4o-mini-transcribe` | `2025-12-15` | `OpenAI` | `GlobalStandard` | 1 | `NoAutoUpgrade` |
| `gpt-5.6-luna` | `2026-07-09` | `OpenAI` | `GlobalStandard` | 1013 | `NoAutoUpgrade` |

Each deployment's `model_name` equals its deployment name, and the map has no
additional entries.
Generation uses the canonical `gpt-5.6-luna` deployment through the relay
runtime's Entra-managed identity. No other deployment set is valid for an
enabled relay.
`owner@example.com` is retained only in `terraform.tfvars.example` and is
deliberately rejected by live validation.
Set the required `operator_principal_id` to the reviewed canonical lower-case
Microsoft Entra object ID used for smoke tests. The committed example contains
only a nil placeholder and must never contain the live principal.

## Saved-plan and Foundry plan guard

Current enabled-relay rollouts are lifecycle-only. Run each phase through the
lifecycle utility's operations described below; do not invoke a standalone
Terraform plan, JSON guard, or apply command for the rollout:

```sh
node infra/scripts/dev-plan-lifecycle.mjs init
run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create model-bootstrap)"
node infra/scripts/dev-plan-lifecycle.mjs guard model-bootstrap "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs preflight model-bootstrap "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs apply model-bootstrap "$run_id"
```

Repeat those phase operations for `runtime-cutover` and
`credential-cleanup` in the order shown below. If an apply outcome is
ambiguous, use the lifecycle utility's `reconcile` operation for that same
phase and run ID before advancing. The terminal phase uses `create`, `guard`,
and `finalize`; it is verification only and must never be applied.

For the isolated Foundry model spike, save a targeted plan and require the
single pinned transcription deployment create:

```sh
terraform -chdir=infra/environments/dev plan \
  -target='module.foundry.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"]' \
  -out=/tmp/palancar-foundry.tfplan
terraform -chdir=infra/environments/dev show -json /tmp/palancar-foundry.tfplan \
  | node infra/scripts/assert-dev-plan.mjs --mode=model-spike
terraform -chdir=infra/environments/dev apply /tmp/palancar-foundry.tfplan
```

`model-spike` allows exactly one create action at the pinned
`gpt-4o-mini-transcribe` deployment and no other mutations. This isolated
spike is not a current enabled-relay rollout; use the lifecycle utility for
that rollout. When the saved plan includes the Container App scale
configuration, the guard requires `minReplicas = 0` and `maxReplicas = 1`.
Keep the spike's saved plan local and apply the same file that was inspected.

For the canonical `gpt-5.6-luna` generation deployment, use the lifecycle
utility's `model-bootstrap` phase operations above. It creates the complete
normal-refresh plan and applies only the same protected saved plan after its
guard and preflight pass; do not substitute direct Terraform commands.

`luna-model-bootstrap` is fail-closed and accepts only the complete Terraform
1.15.8 plan with exactly one create at
`module.foundry.azurerm_cognitive_deployment.this["gpt-5.6-luna"]`:
model/version `gpt-5.6-luna`/`2026-07-09`, format `OpenAI`, SKU
`GlobalStandard`, capacity `1013`, and `NoAutoUpgrade`. The pinned
`gpt-4o-mini-transcribe` deployment, Foundry account, Container App, cleanup
Job, all RBAC, and every other managed resource must be exact no-op. The only
output action is the known, non-sensitive sorted
`foundry_deployment_names` update from the transcription name to both names.
The plan must have no drift, imports, generated configuration, deposed state,
replacement, delete, unknown security-relevant data, or sensitive leakage.
The lifecycle utility applies only the same protected saved plan after the
guard and preflight pass.

The Luna bootstrap guard is intentionally a full-plan guard, not a leaf-value
fixture matcher. Its positive fixture is
`infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json`: a complete
Terraform 1.15.8 plan with 40 resource changes, all 10 module calls, provider,
schema, and identity metadata, and no empty resource payloads. Resource IDs,
operator principal, and contact values may be live-shaped when they are
canonical and coherently cross-bound through resource changes, prior/planned
state, outputs, configuration, and checks. Structural envelopes, inventory,
provider/schema metadata, identities, and all additions/removals remain exact.
The `relay_image_digest` variable is the full immutable predecessor reference
`palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:e9b7e2ea937d3a15f3b3a52e50d9736b5c63c69765c3ee571ab0c06f762436bd`; the same
reference must appear in configuration bindings and the Container App's
prior, planned, and resource-change payloads.

The only accepted transition is the Luna deployment create plus the sorted
`foundry_deployment_names` output update. The transcription deployment, app,
cleanup Job, every RBAC assignment, and all other resources remain no-op. Each
RBAC assignment is checked for its exact address, scope relation, full role
definition ID/GUID, principal binding and type, deterministic UUIDv5 name/ID,
and coherent change/prior/planned payloads. In particular, a subscription-wide
scope widening or coordinated role, principal, or name mutation is rejected;
there is no wildcard empty-object acceptance. Keep the fixture sanitized and
run `node --test infra/scripts/assert-dev-plan.test.mjs` after guard changes.

The required smoke operator receives two deterministic Storage Table Data
Contributor assignments: one scoped exactly to `SecurityState` and one scoped
exactly to `RateState`. The operator is not granted storage-account scope.
The runtime identity's existing storage-account assignment is unchanged.

The current enabled-relay rollout uses these lifecycle phases and guard modes:

| Phase | Guard mode | Accepted transition |
| --- | --- | --- |
| `model-bootstrap` | `luna-model-bootstrap` | Exactly one canonical `gpt-5.6-luna` deployment create; transcription, Container App, RBAC, and all other resources are no-op. |
| `runtime-cutover` | `azure-generation-cutover` | Exactly one Container App update to the single relay container, zero secrets, and the fixed Azure generation environment; both Foundry deployments and all other resources are no-op. |
| `credential-cleanup` | `azure-credential-cleanup` | Exactly one delete at `module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user[0]`; the app, models, and all other RBAC are no-op, with `previous_address` absent. |
| `terminal` | `final-rollout-complete` | A complete no-op plan with all checks passing and zero drift; verification only, never apply. |

Execute every current rollout phase through
`node infra/scripts/dev-plan-lifecycle.mjs`, which enforces this order: model
bootstrap, runtime cutover, credential cleanup, then terminal verification.
For each non-terminal phase, run `create`, `guard`, `preflight`, and `apply`
with its returned run ID; use `reconcile` only for an ambiguous apply. For the
terminal phase, run `create`, `guard`, and `finalize`; never run `apply`.

## State recovery verification

The state account enables blob versioning, change feed with finite 14-day
retention, 14-day blob/container soft deletion, and 13-day point-in-time
restore. Verify the actual blob service properties after apply:

```sh
az storage account blob-service-properties show \
  --account-name '<bootstrap-account>' \
  --resource-group '<bootstrap-resource-group>' \
  --query '{versioning:isVersioningEnabled,changeFeed:changeFeed,deleteRetention:deleteRetentionPolicy,containerDeleteRetention:containerDeleteRetentionPolicy,restore:restorePolicy}'
```

For a recovery exercise, write only to a disposable state key, record a UTC
time before overwriting it, then restore only that disposable range:

```sh
az storage blob restore \
  --account-name '<bootstrap-account>' \
  --resource-group '<bootstrap-resource-group>' \
  --time-to-restore '<UTC-RFC3339-BEFORE-OVERWRITE>' \
  --blob-range 'tfstate-bootstrap/disposable-restore-test.tfstate' \
               'tfstate-bootstrap/disposable-restore-test.tfstate0'
```

The second value is an exclusive endpoint, so the `0` suffix includes exactly the disposable key.

Confirm the restored disposable key with Entra-authenticated blob reads, then
run `terraform state list` and a no-change plan against the real state. Never
test recovery by deleting the protected resource group, account, containers,
or live state blobs.

## Non-mutating verification

Use the pinned Terraform binary and do not save a plan:

```sh
terraform fmt -check -recursive infra
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap plan -refresh=false -lock=false
terraform -chdir=infra/environments/dev init -backend=false
terraform -chdir=infra/environments/dev validate
git diff --check
```

These checks do not apply infrastructure or mutate Azure.
