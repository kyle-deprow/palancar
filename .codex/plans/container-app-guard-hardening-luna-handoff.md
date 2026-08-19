# Luna agent handoff: Container App module and rollout-guard hardening

## Assignment

- Profile: `gpt-5.6-luna` at `xhigh` through the implementation-worker role.
- Objective: Close the exact-topology and identity-casing holes found by Sol and synchronize the module's native Terraform test with Azure's stable normalized declaration.
- Done when: module, native Terraform test, guard, and guard fixtures enforce one exact workload topology; all focused tests, formatting, and validation pass.

## Scope

- Inspect/use: `infra/modules/container-app-workload/main.tf`, `infra/modules/container-app-workload/tests/runtime-contract.tftest.hcl`, `infra/scripts/assert-dev-plan.mjs`, `infra/scripts/assert-dev-plan.test.mjs`, and current variable/output files only as read-only context.
- Do not inspect/change: ignored tfvars, Terraform state/backend files, `.env`, saved plans, cloud resources, or any files outside the four listed files. Do not run plan/apply or Azure commands.
- Write permission: exactly the four listed files.

## Method and evidence

- Requirements:
  1. Update `runtime-contract.tftest.hcl` to require the exact current normalized shape: transport `Http`; identitySettings IDs with only `resourceGroups` changed to `resourcegroups`; slash-free workload endpoint; LiteLLM probes in `Liveness`, `Readiness`, `Startup` order with `initialDelaySeconds=10` on Liveness and absent on Startup. Add exact identitySettings and relay endpoint assertions.
  2. In the module precondition, compare `lower(var.image_pull_identity_id) != lower(var.runtime_identity_id)` so casing cannot bypass role separation. Add a native test case that supplies the same identity with casing differences and expects failure.
  3. In `hasExactRuntimeContainerApp`, compare configured identity IDs case-insensitively for separation while retaining exact normalized identitySettings/registry/secret-role mapping.
  4. Require exact keys at every body topology boundary. At minimum body must contain only `properties`; properties only `managedEnvironmentId`, `configuration`, `template`; configuration only `activeRevisionsMode`, `ingress`, `registries`, `identitySettings`, `secrets`; template only `containers`, `scale`. Require `managedEnvironmentId` to be a canonical Container Apps managed-environment ARM ID in the same subscription/resource group boundary expected by the fixture. Reject unknown siblings such as Dapr, init containers, volumes, service bindings, and any extra property.
  5. Keep exact checks for immutable images, identities, secrets, env, probes, ingress, scale, no Foundry deployment, and no unknown/sensitive values. Do not loosen any existing guard.
  6. Extend JS mutation tests for every newly exact boundary and managed-environment ID mismatch, plus a casing-only duplicate identity. Ensure realistic plan fixture includes managedEnvironmentId.
  7. Preserve Azure stable normalization already observed: Terraform literal `replace(id, "resourceGroups", "resourcegroups")`, `Http`, slash-free table endpoint, and the exact stable probe order/fields.
- Required checks from repository root: `node --test infra/scripts/assert-dev-plan.test.mjs`, `/home/dev/.local/bin/terraform-1.15.8 fmt -check -recursive infra`, `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/container-app-workload test`, `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/environments/dev validate`, and `git diff --check`.
- Evidence to return: changed blocks/tests, exact command outcomes, unresolved risk.
- Stop and escalate if: provider schema rejects the exact already-live normalized shape, or changes beyond the four owned files are needed.

## Response format

1. Result
2. Evidence with file/symbol references
3. Checks run and actual outcomes
4. Blockers/uncertainty
5. Final `DONE` only if complete
