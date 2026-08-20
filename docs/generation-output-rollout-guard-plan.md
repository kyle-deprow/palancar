# Generation output rollout guard plan

## Objective

Safely roll the reviewed generation-output relay image from the currently
healthy Azure Container Apps revision. The committed final-rollout guard must
bind the transition to the exact deployed predecessor while leaving the new
image digest variable-bound.

## Transition contract

- The currently deployed predecessor relay image is
  `sha256:af41c6ad829046e4e92e548afc50a84e8e0da18ad3e3d37be08e2b877c2809df`.
- The replacement image is supplied only through `var.relay_image_digest`.
  Its reviewed digest must not be hard-coded in the guard, tests, fixture, or
  documentation.
- The sanitized transition fixture uses a synthetic replacement digest and
  the exact deployed predecessor digest.
- Historical predecessor digests remain negative-test cases so a stale plan
  cannot pass the final-rollout guard.
- The only permitted managed-resource action is the existing Container App
  relay image update; the established resource, output, check, environment,
  model, and zero-drift invariants remain unchanged.

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
   saved-binary SHA-256, and pass the final-rollout guard.
5. Obtain an independent Sol review of the exact saved plan, reverify its hash,
   and apply that exact binary.
6. Verify the new healthy single-traffic revision, run exactly one controlled
   Spanish/Turkish smoke, inspect bounded telemetry and cleanup evidence, then
   repin the terminal guard and prove a complete no-drift plan.
