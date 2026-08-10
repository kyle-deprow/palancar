# Terraform foundation fix handoff (GPT-5.6 Luna xhigh)

## Scope

Fix every Sol finding in `infra/**`. Preserve active npm/protocol work. Edit only `infra/**` and this handoff; do not apply, mutate Azure, commit, or add placeholder workload images.

## Approved current baseline

Update exact pins everywhere and regenerate locks:

- Terraform CLI `= 1.15.8`; add `infra/.terraform-version` containing `1.15.8`.
- AzureRM `= 5.0.1`.
- AzAPI `= 2.12.0` in dev only. Remove AzAPI from bootstrap because bootstrap uses no AzAPI resource.

Review AzureRM 5.0 migration/schema changes and make all modules validate against these exact providers. The parent may supply a Terraform 1.15.8 binary for final verification; do not weaken the exact CLI pin to accommodate 1.15.6.

## Must-Fix

1. **Executable local bootstrap.** Remove the backend block from the initially committed bootstrap configuration. Add committed `backend.tf.example` containing only the later `terraform { backend "azurerm" {} }` declaration; `backend.tf` is ignored. Initial `init/apply` uses local state. After resources exist, copy both `backend.tf.example -> backend.tf` and the HCL config example -> ignored `backend.hcl`, then `init -migrate-state`. Dev keeps its backend declaration and initializes directly against the already-existing remote backend; do not describe migrating nonexistent dev local state.
2. **Valid state recovery.** Enable `change_feed_enabled` and finite change-feed retention covering the restore window alongside versioning/delete retention/PITR, or remove PITR and explicitly rely on versions. Prefer the valid complete 14-day/13-day PITR setup. Verify/document `az storage account blob-service-properties show` and a disposable-key `az storage blob restore` exercise—not `az storage account show` for blob properties.
3. **Entra-only workload Tables.** AzureRM 5 must own the Storage account, but must not own Tables because `azurerm_storage_table` uses Shared Key. AzAPI 2.12 must own each entire `Microsoft.Storage/storageAccounts/tableServices/tables` child through an appropriate current stable ARM API, with no AzureRM overlap. Keep shared keys disabled. Remove apply-principal Table data-plane bootstrap machinery because ARM creation does not require it. Output exact AzAPI Table IDs/names. Explain ownership in README.
4. **Operational budget.** `budget_start_date`, `budget_end_date`, and `budget_contact_emails` have no live defaults and are required. Validate monthly start/end at UTC midnight on day `01`, end after start, practical period, positive amount, and at least one email. Reject reserved example domains (`example.com`, `.invalid`, `.test`, `.example`) in live validation; retain `owner@example.com` only in the example file with an explicit “replace before plan” comment. Use a first-of-month example, e.g. 2026-08-01 to 2027-08-01.
5. **Plan-known RBAC graph.** Foundry is mandatory here, so runtime OpenAI role assignment is unconditional and `cognitive_account_id` is required. Remove `count` based on unknown resource IDs and remove the `terraform_data` Foundry gate. ACR and Table role assignments must not wait for model deployments. Runtime OpenAI role naturally depends only on cognitive account ID. Ensure role definition arguments are valid apply-time values: use verified built-in role names or construct full role-definition resource IDs; never pass a bare GUID to `role_definition_id`.
6. **Ignore coverage.** Ignore `tfplan`, `plan.out`, conventional plan suffixes, generated backend files, state/crash files, and private-key/certificate formats (`*.key`, `*.pem`, `*.pfx`, `*.p12`, etc.) while retaining `.terraform.lock.hcl`, `.terraform-version`, `*.example`, and `backend.tf.example`.
7. **Current provider migration.** Update syntax/deprecations for AzureRM 5.0.1/AzAPI 2.12 and regenerate readonly-verified lockfiles for the current `linux_arm64` platform using Terraform 1.15.8.

## Should-Fix

- Make the full model-deployment map an explicit reviewed variable in dev rather than hard-coded composition. Validate exactly two distinct entries with nonempty deployment/model/version, format `OpenAI`, supported `GlobalStandard`, positive integer capacities, and `NoAutoUpgrade`; put current defaults only in the example file or a clearly reviewed local default if Terraform cannot validate cross-object values cleanly.
- Use separate bootstrap and dev state containers and keys. The local bootstrap operator may temporarily have account-scoped Blob Data Contributor to create/manage both containers; document that future CI identities are container-scoped and remove the previous claim that current permissions are already separate if they are not.
- Constrain this dev environment location to exactly `eastus2` because model/version/quota evidence is region-specific.

## Nits and proactive corrections

- Fix prefix/environment validation to truly accept 2-16 characters, not 1 or 3-16.
- Remove tautological distinct-map-key validation.
- Ensure Storage restore retention relationships satisfy provider constraints.
- Ensure names remain valid after AzureRM 5 migration.
- Ensure role assignments use stable deterministic UUID names and correct principal types without inappropriate service-principal AAD-skip flags for a human apply principal.

## Verification

Using Terraform 1.15.8, run:

1. `terraform fmt -check -recursive infra`
2. Fresh bootstrap `init -backend=false` and `validate` with AzureRM 5.0.1 only.
3. Fresh dev `init -backend=false` and `validate` with AzureRM 5.0.1/AzAPI 2.12.0.
4. A local bootstrap `plan -refresh=false -lock=false` with explicit safe variables must reach a real plan rather than “backend initialization required.” Do not save a plan.
5. Dev plan may remain blocked by intentionally absent live remote backend; state the exact command/input. If feasible, validate module graph with a temporary backend-disabled copy without writing repository files.
6. Prove ignore behavior for named plan/key cases and retention of examples/locks.
7. `git diff --check`.

Report changed paths, migration notes, plan result, provider ownership, checks, and `DONE` only when all findings are closed.
