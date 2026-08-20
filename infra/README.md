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
Key Vault once immutable relay and LiteLLM image digests are supplied. The
runtime workload is relay plus an OpenRouter-only LiteLLM sidecar; Azure
LiteLLM and Azure transcription remain blocked. The cleanup Job, private
endpoint, custom DNS, CI federation, and placeholder images remain outside
this stack.

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
notification address. `foundry_deployments` defaults to `{}` for a runtime-only
rollout and creates no cognitive deployment.
`owner@example.com` is retained only in `terraform.tfvars.example` and is
deliberately rejected by live validation.
Set the required `operator_principal_id` to the reviewed canonical lower-case
Microsoft Entra object ID used for smoke tests. The committed example contains
only a nil placeholder and must never contain the live principal.

## Saved-plan and Foundry plan guard

Always inspect the exact saved plan before applying it. The guard reads only
Terraform's JSON plan from standard input and never prints plan values:

```sh
terraform -chdir=infra/environments/dev plan \
  -out=/tmp/palancar-dev.tfplan
terraform -chdir=infra/environments/dev show -json /tmp/palancar-dev.tfplan \
  | node infra/scripts/assert-dev-plan.mjs --mode=full-deploy
terraform -chdir=infra/environments/dev apply /tmp/palancar-dev.tfplan
```

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
`gpt-4o-mini-transcribe` deployment and no other mutations. `full-deploy`
allows only that deployment create/no-op and the relay Container App
update/no-op; it rejects deletes, replacements, failed checks, resource drift,
the retired `gpt-5-6-luna` deployment, and other mutations. When the saved
plan includes the Container App scale configuration, the guard requires
`minReplicas = 0` and `maxReplicas = 1`. Keep saved plans local and apply the
same file that was inspected.

For a runtime-only rollout, set `foundry_deployments = {}`, use immutable
`@sha256` relay and LiteLLM images from the same development ACR, and provide
the exact versionless
same-vault `openrouter-api-key` and `litellm-master-key` URLs. The sidecar
backend must be `openrouter`; disabled sidecar inputs must all be empty.

The required smoke operator receives two deterministic Storage Table Data
Contributor assignments: one scoped exactly to `SecurityState` and one scoped
exactly to `RateState`. The operator is not granted storage-account scope.
The runtime identity's existing storage-account assignment is unchanged.

Rollout preflight: before creating that plan, update the ignored live
`infra/environments/dev/terraform.tfvars` so it explicitly contains
`foundry_deployments = {}`. Do not start the rollout plan until the final relay
and LiteLLM digests and all other rollout inputs are ready. The committed
example documents the shape; Terraform automation must not rewrite the ignored
live file.

Inspect the saved plan with:

```sh
terraform -chdir=infra/environments/dev show -json /tmp/palancar-dev.tfplan \
  | node infra/scripts/assert-dev-plan.mjs --mode=runtime-rollout
```

`runtime-rollout` requires the complete foundation, identities, RBAC, Tables,
Foundry account, and Key Vault inventory to be no-op. The Foundry module's
single unindexed static `azurerm_cognitive_deployment` declaration is allowed
only with its exact empty `for_each` map and zero actual instances; indexed,
malformed, prior, planned, changed, drifted, deferred, or otherwise referenced
deployments (including no-op) are rejected. The initial reviewed rollout may
create exactly the two table-scoped operator assignments; after either exists
in prior state, its action must be no-op. The guard also
rejects deletes, replacements, failed checks, unknown workload payloads,
mutable images, identity or revision drift, plaintext credentials,
Azure/provider helper topology, and any mutation other than a single Container
App create/update/no-op plus those initial operator grants. The accepted
workload has exact HTTP ingress and
health probes, a single revision, min replicas 0 or 1, max replicas 1,
`PALANCAR_SECURITY_MODE=azure-table`, mock transcription, localhost LiteLLM on
port 4000, and the `palancar-generation` alias.

For the reviewed final rollout, after the pinned transcription deployment is
already present, create a complete saved plan without `-target`, guard its JSON
view, and apply that exact same file only when the guard exits successfully:

```sh
terraform -chdir=infra/environments/dev plan \
  -out=/tmp/palancar-final.tfplan && \
terraform -chdir=infra/environments/dev show -json /tmp/palancar-final.tfplan \
  | node infra/scripts/assert-dev-plan.mjs --mode=final-rollout && \
terraform -chdir=infra/environments/dev apply /tmp/palancar-final.tfplan
```

Do not run the apply command after a guard rejection, do not substitute a
newly generated plan file between guard and apply, and do not apply a
refresh-only plan.

`final-rollout` is a separate fail-closed mode. It requires the complete
39-resource transition inventory: 29 no-ops, the reviewed Container App update,
and nine creates comprising the monitoring assignment, cleanup Job, relay
action group, and six scheduled-query alerts. The action group must use the
exact deterministic development ARM ID and one common-schema, ordinally named
email receiver per sorted budget contact. The same contact set must appear in
all four budget notifications. Every alert is bound to that action group and
must match the committed workspace scope, KQL, threshold, aggregation,
severity, periods, properties, and provider envelope, with no dimensions. The
idempotent form requires the same 39 resources as no-ops and no drift.

The mode also requires the exact pinned Foundry deployment as a no-op, exact
development ACR digests for the relay, LiteLLM proxy, and expiry-cleanup Job,
and the complete final Container App and scheduled Job payloads. It permits
only the reviewed Container App create/update/no-op, Job create/no-op, and
create-if-absent/no-op-if-present monitoring, action-group, alert, and operator
resources. The initial transition accepts only the exact reviewed preexisting
Container App drift represented in the refreshed saved plan and only alongside
the complete final update. It rejects all other drift, deletes, replacements,
imports, deferred or unknown security values, extra topology or receivers,
plaintext credentials, mutable or aliased images, and any second deployment or
workload resource.

The reviewed transition has exactly two allowed unknown checks: the
`module.container_app_workload.azapi_resource.this` check and the
`module.container_app_workload.var.runtime_monitoring_metrics_publisher_role_assignment_id`
check, each with its exact indexed instance address and unknown status, and
only while the monitoring-role action is create. The Container App body and the
monitoring-role create are independently validated against their complete exact
contracts. Every other unknown check, any altered check envelope, and any
additional unknown check fails closed; the idempotent plan must report every
check as passing.

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
