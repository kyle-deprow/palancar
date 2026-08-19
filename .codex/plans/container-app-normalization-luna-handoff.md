# Luna agent handoff: Container Apps refresh normalization

## Assignment

- Profile: `luna_xhigh`
- Objective: Align the AzAPI Container App declaration and runtime-plan guard with Azure's stable read normalization so a fully refreshed plan is a no-op without weakening workload invariants.
- Done when: the declaration matches the observed Azure body for identity-setting resource-ID casing, HTTP transport enum casing, and LiteLLM probe ordering; guard fixtures and assertions match; all exact guard tests and Terraform formatting/validation pass.

## Scope

- Inspect/use: `infra/modules/container-app-workload/main.tf`, `infra/scripts/assert-dev-plan.mjs`, `infra/scripts/assert-dev-plan.test.mjs`, and the supplied observed diff below.
- Do not inspect/change: `.env`, ignored `terraform.tfvars`, Terraform state/backend files, Azure resources, saved plan files, or any source outside the three listed files. Do not run Terraform plan/apply or Azure commands.
- Write permission: exactly the three listed files.

## Method and evidence

- Observed Azure read normalization versus current desired declaration:
  1. `configuration.identitySettings[*].identity` is returned with the literal path segment `resourcegroups` lowercase while AzureRM identity IDs used elsewhere contain `resourceGroups`.
  2. `configuration.ingress.transport` is returned as `Http`, while the declaration currently uses `http`.
  3. LiteLLM probes are returned in order `Liveness`, `Readiness`, `Startup`, while declaration/fixture currently order `Startup`, `Liveness`, `Readiness`.
- Requirements:
  1. In only `identitySettings`, declare `lower(var.image_pull_identity_id)` and `lower(var.runtime_identity_id)`. Do not lowercase registry or Key Vault identity fields.
  2. Declare transport as `Http`.
  3. Reorder LiteLLM probes to `Liveness`, `Readiness`, `Startup` without changing any probe field/value.
  4. Update the guard to require this exact normalized form. The two identity-setting values must equal lowercase versions of the corresponding configured identity IDs; retain exact key/lifecycle checks. Require `Http`, not arbitrary case-insensitive transport.
  5. Update realistic fixture ordering/casing and mutation tests as needed. Do not relax image, secret, env, topology, scale, or identity invariants.
- Required checks: `node --test infra/scripts/assert-dev-plan.test.mjs`, `/home/dev/.local/bin/terraform-1.15.8 fmt -check -recursive infra`, and `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/environments/dev validate` from repository root.
- Evidence to return: exact changed symbols/blocks, real command outcomes, and unresolved risk.
- Stop and escalate if: provider validation rejects the observed enum/casing, changes outside the three files are needed, or an invariant would need weakening.

## Response format

1. Result: status
2. Evidence: concise bullets with file/symbol references
3. Checks run: commands and outcomes
4. Blockers or uncertainty: none or explicit details
5. Final line `DONE` only if all requirements and checks are complete
