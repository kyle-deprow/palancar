# Generation output rollout guard plan

## Objective

Safely roll the reviewed generation-output relay image from the currently
healthy Azure Container Apps revision. The committed final-rollout guard must
bind the transition to the exact deployed predecessor while leaving the new
image digest variable-bound.

## Transition contract

- The currently deployed predecessor relay image is
  `sha256:e9b7e2ea937d3a15f3b3a52e50d9736b5c63c69765c3ee571ab0c06f762436bd`.
- The replacement image is supplied only through `var.relay_image_digest`.
  Its reviewed digest must not be hard-coded in the guard, tests, fixture, or
  documentation.
- The sanitized transition fixture uses a synthetic replacement digest and
  the exact deployed predecessor digest.
- The historical predecessor
  `sha256:af41c6ad829046e4e92e548afc50a84e8e0da18ad3e3d37be08e2b877c2809df`
  remains only as a negative-test case, so a stale plan cannot pass the
  final-rollout guard.
- The only permitted managed-resource action is the existing Container App
  relay image update; the established resource, output, check, environment,
  model, and zero-drift invariants remain unchanged.

## Related Luna bootstrap boundary

The Luna model refresh is a separate `luna-model-bootstrap` guard contract;
it is not a relaxed generation-output rollout. Its complete Terraform 1.15.8
fixture has 40 resource changes and all 10 modules, with provider/schema/
identity metadata and sanitized full payloads. Canonical live Azure IDs,
operator principals, and contact values are accepted only when coherently
cross-bound across the plan. The guard permits only the Luna deployment create
and the `foundry_deployment_names` output update; the transcription deployment,
workloads, cleanup Job, all RBAC assignments, and every other resource remain
no-op. Exact RBAC scope, role-definition, principal/type, deterministic-name,
and change/prior/planned checks reject subscription-wide scope widening,
coordinated role/principal/name mutations, and wildcard payloads. The Luna
fixture and tests are outside this generation-output replacement digest
boundary and must remain sanitized. Its `relay_image_digest` variable is the
full immutable
`palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:e9b7e2ea937d3a15f3b3a52e50d9736b5c63c69765c3ee571ab0c06f762436bd`
reference, cross-bound through configuration and every Container App
prior/planned/resource-change image.

## Files

- `infra/scripts/assert-dev-plan.mjs`
- `infra/scripts/assert-dev-plan.test.mjs`
- `infra/scripts/fixtures/final-rollout-transition.plan-fixture.json`
- `docs/final-rollout-guard-plan.md`
- `docs/litellm-oom-remediation-plan.md`
- `infra/README.md`

## Verification and rollout

1. Run the guard unit tests and confirm the replacement digest is absent from
   committed guard artifacts.
2. Obtain an independent Sol review and commit the predecessor repin.
3. Set the ignored development tfvars relay image to the reviewed immutable
   replacement digest.
4. Produce a complete saved plan with Terraform 1.15.8, protect its binary and
   JSON rendering with mode `0600`, verify deterministic rendering and the
   saved-binary SHA-256, and pass the final-rollout guard. The `show -json`
   rendering cannot prove the plan argv or `-refresh=true`; the later
   saved-plan lifecycle manifest must enforce the exact plan argv, including
   `-refresh=true`, before guard and apply.
5. Obtain an independent Sol review of the exact saved plan, reverify its hash,
   and apply that exact binary.
6. Verify the new healthy single-traffic revision, run exactly one controlled
   Spanish/Turkish smoke, inspect bounded telemetry and cleanup evidence, then
   repin the terminal guard and prove a complete no-drift plan.
