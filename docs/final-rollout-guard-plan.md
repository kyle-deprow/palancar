# Final rollout plan-guard implementation

Status: Guard implementation retained; live rollout and final evidence pending
Date: 2026-08-20

## Objective

Document the fail-closed final guard for the implemented Azure-only relay
target. Terraform manages Azure Foundry, the relay uses direct Azure OpenAI
generation with the runtime managed identity and Entra auth, and the workload
has one relay container with no runtime proxy or API-key path. The dev
language boundary remains explicitly provisional; staging and production must
use `deny-all`.

The current lifecycle maps `model-bootstrap` to `luna-model-bootstrap`,
`runtime-cutover` to `azure-generation-cutover`, `credential-cleanup` to
`azure-credential-cleanup`, and `terminal` to `final-rollout-complete`.
The terminal guard is a complete no-op verification and must never be applied.

The model-bootstrap guard is the separate normal-refresh guard for creating the
Terraform-managed `gpt-5.6-luna` deployment. Its exact transition and
adversarial coverage live in `infra/scripts/assert-dev-plan.test.mjs`. Live
image digests, endpoints, resource IDs, subscription/tenant values, and tfvars
values remain protected rollout inputs and are intentionally absent here.

### Luna bootstrap guard boundary

The separate `luna-model-bootstrap` mode is guarded against the complete
Terraform 1.15.8 plan at
`infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json`. The fixture
contains 40 resource changes and all 10 modules with the provider, schema, and
identity metadata emitted by Terraform; it is sanitized and contains no empty
resource payloads. The guard accepts protected live bindings only when their
references remain coherently cross-bound across changes, prior/planned values,
outputs, configuration, and checks. It preserves exact structural envelopes
and resource inventory, so extra or missing resources, modules, metadata, or
coordinated type/identity changes fail closed.

Its sole transition is creation of
`module.foundry.azurerm_cognitive_deployment.this["gpt-5.6-luna"]` and the
corresponding sorted `foundry_deployment_names` output update. The
transcription deployment, Container App, cleanup Job, all RBAC assignments,
and every other resource must be no-op. Every RBAC payload is checked for its
address, target scope, full role definition ID/GUID, principal and type,
deterministic assignment name/ID, and change/prior/planned coherence. A
subscription-wide `runtime_openai` scope, role/principal/name mutation, image
cross-binding change, non-canonical timestamp, or wildcard empty payload is
rejected. This boundary is covered by the Luna tests and does not alter the
older guard modes or the final-rollout fixture.

## Current operator flow

Run the lifecycle utility from the repository root. Initialize once, then run
the phase-specific sequences below. Model bootstrap has the normal
create/guard/preflight/apply sequence. Runtime cutover adds the lifecycle
diagnostic between guard and preflight:

```sh
node infra/scripts/dev-plan-lifecycle.mjs init
run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create <phase>)"
node infra/scripts/dev-plan-lifecycle.mjs guard <phase> "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs preflight <phase> "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs apply <phase> "$run_id"

runtime_run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create runtime-cutover)"
node infra/scripts/dev-plan-lifecycle.mjs guard runtime-cutover "$runtime_run_id"
node infra/scripts/dev-plan-lifecycle.mjs diagnostic runtime-cutover "$runtime_run_id"
node infra/scripts/dev-plan-lifecycle.mjs preflight runtime-cutover "$runtime_run_id"
node infra/scripts/dev-plan-lifecycle.mjs apply runtime-cutover "$runtime_run_id"
```

The `diagnostic` operation is valid only for `runtime-cutover`. It validates
the existing Container Apps Job, then uses the guarded immutable relay image,
the Entra runtime identity, the exact diagnostic command, and no secrets. It
records durable intent, invoking, submission, execution, and receipt evidence;
there is exactly one Job-start POST attempt per lifecycle run. An ambiguous
start is reconciled from resumable evidence and is never replayed. The Job's
inner command is `node apps/relay/dist/azure-generation-diagnostic.js` and its
successful receipt is required by runtime preflight.

If an apply is ambiguous, use only:

```sh
node infra/scripts/dev-plan-lifecycle.mjs reconcile <phase> <run-id>
```

Never replay the old saved plan. The terminal flow is guard-only until its
receipts are ready and has no `preflight` or `apply`:

```sh
terminal_run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create terminal)"
node infra/scripts/dev-plan-lifecycle.mjs guard terminal "$terminal_run_id"
node infra/scripts/dev-plan-lifecycle.mjs finalize terminal "$terminal_run_id"
node infra/scripts/dev-plan-lifecycle.mjs close terminal "$terminal_run_id"
```

The diagnostic executable is run by the lifecycle-controlled Job from the
reviewed image. Its no-argument inner command is:

```sh
node apps/relay/dist/azure-generation-diagnostic.js
```

The runtime-role utility supports only `assert-enabled`, `disable`, and
`assert-disabled`. Assert the role enabled before runtime cutover; after the
Azure-only runtime is proven, run `disable` and `assert-disabled` before
credential cleanup. Credential-cleanup preflight validates the disabled role,
creates the protected descriptor, and invokes the Key Vault utility's `start`
or `resume` operation as needed. Apply resumes it and requires absence
evidence. Its exact utility commands are:

```sh
node infra/scripts/cleanup-key-vault-credentials.mjs start <run-id>
node infra/scripts/cleanup-key-vault-credentials.mjs resume <run-id>
node infra/scripts/cleanup-key-vault-credentials.mjs assert-absent <run-id>
```

After provider-side revocation is proved by the retained historical
revocation utility, the fixed local cleanup command is:

```sh
node infra/scripts/remove-env-entry.mjs remove /home/dev/repos/palancar_ws/.env OPENROUTER_API_KEY
node infra/scripts/remove-env-entry.mjs assert-absent /home/dev/repos/palancar_ws/.env OPENROUTER_API_KEY
```

The revocation evidence sequence is:

```sh
node infra/scripts/openrouter-revocation-state.mjs prepare
node infra/scripts/openrouter-revocation-state.mjs resume
node infra/scripts/openrouter-revocation-state.mjs mark-local-removed
node infra/scripts/openrouter-revocation-state.mjs assert-complete
```

`resume` requires HTTP 401 proof before `revoked`; `mark-local-removed` and
`assert-complete` require the local absence proof. These provider/key names and
commands are historical cleanup context only.

The names `OPENROUTER_API_KEY`, `openrouter-api-key`, and `litellm-master-key`
appear only in this marked historical cleanup context; they are not runtime
settings.
This plan records the required future flow, not completed live evidence.

## Historical implementation scope

- `infra/scripts/assert-dev-plan.mjs`
- `infra/scripts/assert-dev-plan.test.mjs`
- `infra/scripts/fixtures/final-rollout-transition.plan-fixture.json`
- `infra/README.md`
- `docs/final-rollout-guard-plan.md`
- `docs/litellm-oom-remediation-plan.md`

All other files, live Terraform inputs/state, Azure resources, credentials,
images, and application code are out of scope.

## Exact accepted topology

The mode accepts a complete, non-targeted Terraform 1.15.8 JSON plan only when:

- `format_version` is exactly the already-supported version; all Terraform
  checks pass; there is no deferred change, unknown security-relevant value,
  duplicate resource address, delete, replacement, import, unrelated
  mutation, or resource drift. The genuine plan represents zero drift with
  Terraform's omitted `resource_drift` envelope; any supplied drift is
  rejected.
- Every configured foundation resource is present in `resource_changes` as
  no-op, including the resource group, budget, observability, Tables/storage,
  ACR, Container Apps environment, Foundry account, identities, Key Vault, and
  all existing role assignments.
- The initial transition contains exactly 39 managed resource changes: 38
  no-ops and one update at
  `module.container_app_workload[0].azapi_resource.this`; there are no creates.
  Its `applyable` value is exactly `true`. The mutually exclusive terminal
  idempotent form has 39 no-op actions and `applyable=false`; it is guard-only
  verification evidence and must never be applied.
  The relay remains exactly 0.25 CPU/0.5Gi and the deployed workload contains
  one relay container with no proxy sidecar.
  The Container App before/after recursive differences are exactly
  `body.properties.template.containers[0].image` and `output`. Prior, planned,
  and terminal state each contain the same 25-entry relay environment with
  exactly one plain, nonsecret
  `PALANCAR_LANGUAGE_BOUNDARY_MODE=development-provisional` entry. Missing,
  changed, duplicated, secret-backed, or otherwise drifted environments are
  rejected. Configuration body references retain the exact Terraform v2 order
  around the language boundary. The transition has ordered empty relay
  `after_unknown.env` descriptors and a passing language-boundary check.
  The planned relay image equals `var.relay_image_digest`, is immutable, and
  is distinct from the protected predecessor. The provider-computed
  `relay_latest_revision_name` output becomes unknown. The already deployed
  cleanup Job, action group, and scheduled-query alerts remain no-op.
  budget notification lists, the action-group receivers, and
  `budget_contact_emails` contain the same contact set. Every alert has the
  exact committed KQL, threshold, severity, aggregation, periods, action group,
  static properties, and no dimensions. The idempotent form requires all 39
  resources and all outputs to be no-op, all 102 checks to pass, and zero drift.
- The transition has the exact reviewed 46-entry `relevant_attributes` set.
  The idempotent form has exactly 45 entries, removing only
  `azurerm_resource_group.foundation["id"]` from that set.
- `foundry_deployments` is exactly the one pinned
  `gpt-4o-mini-transcribe` deployment: model/version `2025-12-15`, format
  `OpenAI`, SKU `GlobalStandard`, capacity `1`, and `NoAutoUpgrade`.
- The corresponding indexed Foundry deployment is present exactly once and is
  no-op with the exact pinned after-state. The retired Luna deployment and any
  additional cognitive deployment are rejected everywhere in the plan.
- The generation provider is exactly `azure-openai`, the deployment is exactly
  `gpt-5.6-luna`, and endpoint/client-ID bindings remain protected Terraform
  values. No retired-provider environment or proxy configuration is accepted.
- The Monitoring Metrics Publisher assignment for the runtime identity at the
  exact Application Insights component scope is present exactly once and is
  no-op in this transition. Its deterministic UUIDv5 name, canonical role
  definition ID, principal, principal type, and exact scope must be validated
  without accepting unknown values.
- Both existing table-scoped operator assignments are present exactly once and
  are no-op in this transition; both resolve to the same Table service.
- The Container App resource is present exactly once and is the sole update in
  the transition, then no-op in the idempotent form. Its complete after-state
  exactly matches the committed final module:
  two distinct user-assigned identities with image-pull lifecycle `None` and
  runtime lifecycle `Main`; ACR registry through image-pull identity; external
  secure HTTP ingress to relay port 8787; single revision and 100% latest
  traffic; one relay container with exact CPU/memory and probes; an immutable
  relay image; warm `minReplicas=1`, `maxReplicas=1`; no plaintext credentials;
  and the exact Azure Table, Azure Realtime, managed-identity, telemetry,
  browser-policy, deployment-slot, and language-boundary environment. No
  proxy, fallback, or provider sidecar is accepted.
  The reviewed update uses the reference `after_sensitive` envelope. Every
  no-op resource, including the terminal Container App, uses the corresponding
  reference `before_sensitive` envelope as its exact `after_sensitive` value.
- The relay Azure Realtime endpoint is canonical WSS on the exact development
  Foundry host and ends exactly in
  `/openai/v1/realtime?intent=transcription`; deployment is exactly
  `gpt-4o-mini-transcribe`.
- The immutable relay and expiry-cleanup image variables are present and the
  Container App/Job images must equal their protected variable values exactly.
- The expiry-cleanup Job is present exactly once and is no-op in this
  remediation. Its
  complete after-state exactly matches the committed module: API type and
  canonical name/location/parent/tags; two identities with the same lifecycle
  split; same ACR/image-pull identity; no secrets; schedule `0 3 * * *`, one
  completion, parallelism one, retry zero, replica timeout 300; one cleanup
  container at 0.25 CPU/0.5Gi using the exact cleanup digest; and exactly the
  eight reviewed environment variables with canonical Table endpoint (no
  trailing slash), table names, environment, relay origin, limit 1000, and
  timeout 240000.

Every security- or topology-relevant object uses exact-key validation. Extra
containers, environments, secrets, registries, identities, probes, ports,
resources, role assignments, model deployments, or mutable/foreign images are
rejected. Unknowns fail closed.

The transition requires exactly 102 passing checks and no unknown checks. Any
failed, unknown, altered, duplicated, omitted, or additional check rejects;
the idempotent form requires the same all-pass check envelope.

## Tests

Derive the positive transition fixture from the sanitized genuine refreshed
Terraform 1.15.8 `show -json` output, preserving the provider/resource envelopes, complete and
applyable flags, configuration and child-module trees, prior/planned values,
nulls, computed values, unknown maps, and sensitivity maps. It must contain no
live contact, secret, credential, instrumentation key, or personal principal
identifier; synthetic placeholders must be cross-bound throughout. The
Historical raw plan artifacts and their hashes are intentionally omitted here. Use only a newly created protected lifecycle run, verify the binary rather than its JSON view, keep raw artifacts mode `0600`, and never commit them. Build the idempotent
fixture from the same genuine schema and prove acceptance
for the initial transition and idempotent state. Add adversarial mutations covering every
accepted resource and invariant above, especially omitted inventory entries,
action changes, unknowns, extra keys, plaintext secrets, image substitutions,
repository aliasing, endpoint query/path confusion, wrong model/version,
role-scope widening, identity swaps, probe relaxation, cold scale, cleanup
schedule/concurrency/timeout relaxation, extra Job env, and a second deployment
or workload resource. Include coherent mirrored attacks against the action
group, all six alerts, budget/action contact bindings, output action/prior
coherence, child-module hierarchy, identities, probes, and runtime destination
bindings. Preserve and run all existing tests for all old modes.

## Verification

`terraform show -json` proves only the contents of a saved plan; it cannot
prove the plan command's argv, including whether `-refresh=true` was used.
The later saved-plan lifecycle manifest must enforce the exact plan argv,
including `-refresh=true`, before the guard and apply steps.

From the repository root run:

```sh
node --test infra/scripts/assert-dev-plan.test.mjs
npm run format:check --if-present
npm run lint --if-present
git diff --check
```

After apply, require a fresh complete plan with `applyable=false`, all 39
resources no-op, all outputs no-op, zero resource drift, and all 102 checks
passing. Guard this terminal verification plan and never apply it. Report
changed files, actual command results, residual risks, and `DONE` only when all
requirements and tests are complete.
