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
hosted LiteLLM/generation remains disabled. The exact pinned Azure Realtime
`gpt-4o-mini-transcribe` deployment and relay transcription path are deployed
and enabled. This is not a language or physical-hardware production
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

`terraform show -json` proves only the contents of the saved plan; it cannot
prove the plan command's argv, including whether `-refresh=true` was used.
The later saved-plan lifecycle manifest is authoritative for that provenance
and must enforce the exact plan argv with `-refresh=true` before the JSON guard
or apply step. A passing JSON guard is not a substitute for that manifest.

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

For the deleted `gpt-5.6-luna` deployment, generate a complete normal-refresh
plan without `-target`, `-replace`, `-destroy`, or refresh suppression:

```sh
terraform -chdir=infra/environments/dev plan \
  -refresh=true -input=false -lock=true -lock-timeout=5m \
  -out=/tmp/palancar-luna-model-bootstrap.tfplan
terraform -chdir=infra/environments/dev show -json \
  /tmp/palancar-luna-model-bootstrap.tfplan \
  | node infra/scripts/assert-dev-plan.mjs --mode=luna-model-bootstrap
```

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
Apply only the same protected saved plan after the guard passes.

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
view, and apply that exact same file only when the guard exits successfully.
Keep the binary and JSON view mode `0600`; neither may be committed. The former
GA item-lifecycle procedure below is retained only as a historical hash record;
it predates the explicit language-boundary environment and is non-applicable:

```sh
set -eu
exit 1 # Historical procedure: do not guard or apply this superseded binary.
umask 077
PALANCAR_TERRAFORM=/home/dev/.local/bin/terraform-1.15.8
PALANCAR_PLAN=/tmp/palancar-ga-item-lifecycle-v3.tfplan
PALANCAR_PLAN_JSON=/tmp/palancar-ga-item-lifecycle-v3.tfplan.json
PALANCAR_PLAN_SHA=a4caa91081861c707e07387e4aa2979b3e1cbced0359ee53f19a35d1844b08f8

chmod 600 "$PALANCAR_PLAN"
test "$(sha256sum "$PALANCAR_PLAN" | awk '{print $1}')" = "$PALANCAR_PLAN_SHA"
"$PALANCAR_TERRAFORM" -chdir=infra/environments/dev show -json \
  "$PALANCAR_PLAN" > "$PALANCAR_PLAN_JSON"
chmod 600 "$PALANCAR_PLAN_JSON"
test "$(sha256sum "$PALANCAR_PLAN" | awk '{print $1}')" = "$PALANCAR_PLAN_SHA"
node infra/scripts/assert-dev-plan.mjs --mode=final-rollout \
  < "$PALANCAR_PLAN_JSON"
chmod 600 "$PALANCAR_PLAN" "$PALANCAR_PLAN_JSON"
test "$(sha256sum "$PALANCAR_PLAN" | awk '{print $1}')" = "$PALANCAR_PLAN_SHA"
# Historical apply intentionally removed.
```

The approved SHA is for the saved binary, not its deterministic JSON view;
the two files normally have different hashes. A future activation requires a
newly generated complete non-targeted plan, separately reviewed binary hash,
guard pass, and hash recheck immediately before applying the same binary.

The superseded telemetry-enrichment path
`/tmp/palancar-telemetry-enrichment.tfplan` and binary SHA-256
`ad7e5c2090cce0c82d74d40ba242c30f933073c1bdf24a997e06f4d1bbb4dcf7` are
historical and non-applicable. Do not guard or apply that old plan.

The telemetry-predecessor path `/tmp/palancar-ws-null-callback.tfplan` and
binary SHA-256
`423974333137f7a06d08aa74d30960b35272deae46cae658616d6763770a2986` are
historical and non-applicable. Do not guard or apply that old plan.

The superseded parser-plan path
`/tmp/palancar-realtime-parser-v2.tfplan` and binary SHA-256
`f49c0e0c3f15fccebce1a107ce94f01326fb67f52ec2758756b589187d1be2b4` are
historical and non-applicable. Do not guard or apply that old plan.

Do not run the apply command after a guard rejection, do not substitute a
newly generated plan file between guard and apply, and do not apply a
refresh-only plan.

`final-rollout` is a separate fail-closed mode. Newly generated plans require
the exact plain, nonsecret, unique
`PALANCAR_LANGUAGE_BOUNDARY_MODE=development-provisional` relay environment.
It requires the complete
39-resource transition inventory: 38 no-ops and the reviewed resource-only
Container App update at
`module.container_app_workload[0].azapi_resource.this`. This is the
relay-image correction with the explicit dev language boundary already active:
LiteLLM remains at 0.75
CPU/1.5Gi, relay remains at 0.25 CPU/0.5Gi, and the aggregate remains exactly
1 CPU/2Gi. The only recursive Container App differences are
`containers[0].image` and the provider output. Prior and planned state contain
the same 25-entry relay environment, including exactly one plain, nonsecret
`PALANCAR_LANGUAGE_BOUNDARY_MODE=development-provisional` entry. Missing,
changed, duplicated, secret-backed, or otherwise drifted environments are
rejected. The configuration body references preserve Terraform v2's exact order,
with `var.language_boundary_mode` between the two sidecar-dependent reference
groups. The update's relay `after_unknown.env` has 25 ordered empty descriptors,
one for every planned relay environment entry. The check envelope contains
exactly one passing module `language_boundary_mode` variable check. The prior
relay image is pinned
to the reviewed digest
`sha256:e9b7e2ea937d3a15f3b3a52e50d9736b5c63c69765c3ee571ab0c06f762436bd`.
The historical `sha256:af41c6ad829046e4e92e548afc50a84e8e0da18ad3e3d37be08e2b877c2809df`
predecessor remains a stale negative-test case and is rejected.
The planned image must equal `var.relay_image_digest`, remain immutable in the
same ACR/repository, and be distinct from the prior digest; its reviewed digest
is intentionally not hard-coded in the generic guard or fixture. The
`relay_latest_revision_name` output becomes provider-unknown. There is zero
resource drift. The action group, cleanup Job, alerts, and all other resources
are already deployed and no-op. The action group must use the exact
deterministic development ARM ID and one common-schema, ordinally named email
receiver per sorted budget contact. The same contact set must appear in all
four budget notifications. Every alert is bound to that action group and must
match the committed workspace scope, KQL, threshold, aggregation, severity,
periods, properties, and provider envelope, with no dimensions. The idempotent
form requires all 39 resources and all outputs to be no-op, all 102 checks to
pass, and zero resource drift. The reviewed transition has `applyable=true`.
The terminal no-op plan has `applyable=false`; it is verification evidence only
and must never be applied.

The mode also requires the exact pinned Foundry deployment as a no-op, exact
development ACR digests for the relay, LiteLLM proxy, and expiry-cleanup Job,
and the complete final Container App and scheduled Job payloads. In the initial
transition every resource is no-op except the single Container App update; the
idempotent form requires all 39 resources to be no-op. The transition accepts
only the exact relay-image/output update described above. It rejects all other
drift, deletes, replacements,
imports, deferred or unknown security values, extra topology or receivers,
plaintext credentials, mutable or aliased images, and any second deployment or
workload resource.

The transition requires exactly 102 passing checks and no unknown checks. Any
altered, failed, unknown, or additional check fails closed. The completed OOM
sizing change is background history; it is not an additional current
transition. Any future approved procedure must verify the exact reviewed binary
immediately before guarding and again immediately before applying it.

After apply, generate a fresh complete plan and require 39 no-op resources,
zero resource drift, and all 102 checks passing before treating the rollout as
idempotent. Guard that terminal plan, but never apply it: Terraform reports the
genuine no-op envelope with `applyable=false`.

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
