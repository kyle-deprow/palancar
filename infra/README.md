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

The foundation does not create a relay Container App, cleanup Job, Key Vault,
private endpoint, custom DNS, CI federation, or placeholder image. The relay
and cleanup Job require an immutable application image and remain in a later
workload apply.

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

The dev plan requires live first-of-month UTC budget dates, at least one real
notification address, and an explicit reviewed two-entry Foundry deployment
map. `owner@example.com` is retained only in `terraform.tfvars.example` and is
deliberately rejected by live validation.

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
