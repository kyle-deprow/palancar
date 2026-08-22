# Generation output rollout guard plan

## Objective

Document the implemented Azure-only generation rollout contract. Terraform
manages the Foundry deployments and the relay calls `gpt-5.6-luna` directly
with the runtime managed identity and Entra auth. The live rollout and final
evidence are not claimed complete here.

## Transition contract

The current cutover guard is `azure-generation-cutover`. It accepts a complete
normal-refresh Terraform plan only when the sole managed-resource action is
the relay Container App update. The transition must produce one relay
container, zero Container Apps secrets, the fixed Azure generation settings,
and no model, RBAC, output, or unrelated resource changes. The terminal guard
`final-rollout-complete` accepts only the complete no-op plan with zero drift
and is verification-only.

The image remains an immutable Terraform variable. Do not put a live registry
host, image digest, endpoint, resource ID, subscription, tenant, or tfvars
value in this document or in committed guard fixtures.

## Related Luna bootstrap boundary

The Luna model refresh is a separate `luna-model-bootstrap` contract. It
permits only creation of the canonical `gpt-5.6-luna` deployment and the
corresponding deployment-name output update; transcription, relay, cleanup
Job, RBAC, and every other resource remain no-op. Exact scope, role, principal,
name, and change/prior/planned checks reject widening or coordinated identity
mutations. Fixtures remain sanitized and must not contain live IDs or image
values.

## Files

- `infra/scripts/assert-dev-plan.mjs`
- `infra/scripts/assert-dev-plan.test.mjs`
- `infra/scripts/fixtures/final-rollout-transition.plan-fixture.json`
- `infra/scripts/dev-plan-lifecycle.mjs`
- `infra/scripts/cleanup-key-vault-credentials.mjs`
- `infra/scripts/set-dev-runtime-secrets-role.mjs`
- `infra/scripts/remove-env-entry.mjs`
- `docs/final-rollout-guard-plan.md`
- `infra/README.md`

## Verification and operator flow

Run the lifecycle phases in order. Runtime cutover uses
`create`, `guard`, `diagnostic`, `preflight`, and `apply`; use
`reconcile runtime-cutover <run-id>` only after an ambiguous apply. Never
replay the old plan.

```sh
node infra/scripts/dev-plan-lifecycle.mjs init
run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create runtime-cutover)"
node infra/scripts/dev-plan-lifecycle.mjs guard runtime-cutover "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs diagnostic runtime-cutover "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs preflight runtime-cutover "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs apply runtime-cutover "$run_id"
```

The lifecycle diagnostic validates and uses the existing Container Apps Job
with the guarded immutable relay image, Entra runtime identity, exact command,
and no secrets. It makes exactly one Job-start POST attempt for the lifecycle
run, writes durable intent/invoking/submission/receipt evidence, and resumes by
reconciling the correlated execution after an ambiguous start. The inner Job
command is `node apps/relay/dist/azure-generation-diagnostic.js`; its successful
receipt is the runtime preflight input.

The diagnostic executable invoked inside the Job is:

```sh
node apps/relay/dist/azure-generation-diagnostic.js
```

It takes no arguments and uses `AZURE_CLIENT_ID` plus the Terraform-supplied
generation settings. It permits at most two sequential model attempts, each
through a fresh `GenerationService`, only when the first complete failure has
exactly one trusted, correlation-matched language-validation evidence record:
`invalid-generated-language`/`rejected` with checks `5` or `7` and a positive
nonmatch count, or `language-validation-failure`/`failed` with checks `5` or
`7` and zero nonmatches. Missing, multiple, malformed, inconsistent, provider,
timeout, cancellation, and unknown evidence is terminal; the second attempt
is final and there is never a third. `GenerationService` and the session have
no retry logic. The executable makes one bounded request per model attempt,
prints one fixed pass/failure line, and exits `0` or `20`. This retry is inside
the diagnostic process only; the lifecycle still makes exactly one ACA Job
start. Direct invocation is not a substitute for the lifecycle diagnostic
operation.

After runtime proof, assert the runtime Key Vault role enabled before the
cutover, then disable and assert-disabled before creating the credential
cleanup run. Credential-cleanup preflight validates that disabled state,
creates the protected descriptor, and starts/resumes the cleanup as needed;
apply resumes it and requires absence evidence. The exact utility commands
are:

```sh
node infra/scripts/cleanup-key-vault-credentials.mjs start <run-id>
node infra/scripts/cleanup-key-vault-credentials.mjs resume <run-id>
node infra/scripts/cleanup-key-vault-credentials.mjs assert-absent <run-id>
node infra/scripts/set-dev-runtime-secrets-role.mjs assert-enabled
node infra/scripts/set-dev-runtime-secrets-role.mjs disable
node infra/scripts/set-dev-runtime-secrets-role.mjs assert-disabled
```

After the retained historical provider-revocation sequence proves HTTP 401,
the fixed local environment cleanup is:

```sh
node infra/scripts/remove-env-entry.mjs remove /home/dev/repos/palancar_ws/.env OPENROUTER_API_KEY
node infra/scripts/remove-env-entry.mjs assert-absent /home/dev/repos/palancar_ws/.env OPENROUTER_API_KEY
```

The revocation utility's exact sequence is:

```sh
node infra/scripts/openrouter-revocation-state.mjs prepare
node infra/scripts/openrouter-revocation-state.mjs resume
node infra/scripts/openrouter-revocation-state.mjs mark-local-removed
node infra/scripts/openrouter-revocation-state.mjs assert-complete
```

These provider/key names and commands are historical cleanup context only.

For terminal verification, create and guard the `terminal` run, then run
`finalize terminal <run-id>` and `close terminal <run-id>`. Terminal has no
`preflight` or `apply`; guard, finalize, and close are verification/evidence
operations and do not apply Terraform. These are required future operations,
not evidence that the live rollout or final evidence is already complete.

```sh
terminal_run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create terminal)"
node infra/scripts/dev-plan-lifecycle.mjs guard terminal "$terminal_run_id"
node infra/scripts/dev-plan-lifecycle.mjs finalize terminal "$terminal_run_id"
node infra/scripts/dev-plan-lifecycle.mjs close terminal "$terminal_run_id"
```
