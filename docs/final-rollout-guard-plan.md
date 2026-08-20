# Final rollout plan-guard implementation

Status: Approved for bounded implementation
Date: 2026-08-20

## Objective

Maintain the fail-closed `final-rollout` mode for the relay-image correction
plus explicit dev-only provisional language-boundary activation after the
telemetry-enrichment fix and completed LiteLLM OOM remediation. It
retains the deployed Azure Realtime relay, OpenRouter LiteLLM sidecar,
expiry-cleanup Job, action group, six scheduled-query alerts, and pinned
transcription model.

The existing `model-spike`, `full-deploy`, and `runtime-rollout` behavior must
remain unchanged. `final-rollout` is a new mode, not an alias and not a relaxed
version of an old mode.

## File ownership

The implementation worker owns only:

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
  LiteLLM remains exactly 0.75 CPU/1.5Gi, relay
  remains exactly 0.25 CPU/0.5Gi, and the aggregate remains exactly 1 CPU/2Gi.
  The Container App before/after recursive differences are exactly
  `body.properties.template.containers[0].env[24]`,
  `body.properties.template.containers[0].image`, and `output`. Prior state has
  no `PALANCAR_LANGUAGE_BOUNDARY_MODE`; planned state appends exactly one plain,
  nonsecret `PALANCAR_LANGUAGE_BOUNDARY_MODE=development-provisional` entry.
  Terminal plans retain that exact entry. Missing, deny-all, duplicated, or
  secret-backed forms are rejected. Configuration body references retain the
  exact Terraform v2 order around the boundary and sidecar expressions. The
  transition has 25 ordered empty relay `after_unknown.env` descriptors and
  exactly one passing module `language_boundary_mode` variable check. The prior relay
  image is the hard-pinned reviewed digest
  `sha256:7c0a4da718d8214edcf4b0c0e8f74b2b92648cce2af1115858ff6c0f29a0dfb1`;
  the planned relay image equals `var.relay_image_digest`, is immutable in the
  same ACR/repository, and is distinct from prior. The reviewed after digest
  remains variable-bound and is not hard-coded in the committed guard or
  sanitized fixture. The provider-computed
  `relay_latest_revision_name` output becomes unknown. The already deployed
  cleanup Job, action group, and six scheduled-query alerts remain no-op.
  The action group is enabled/global/tagged, contains exactly one common-schema
  email receiver per sorted synthetic fixture budget contact under non-PII
  ordinal names, and has no other receiver type. Its deterministic plan-known
  ARM ID is cross-bound to the root output and every alert action list. All four
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
- The current reviewed OpenRouter generation model is exactly
  `openrouter/openai/gpt-5.6-luna`; the Container App sidecar environment and
  root plan variable must match that value exactly.
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
  traffic; relay and LiteLLM containers only; exact CPU/memory, probes,
  immutable same-ACR images in repositories `palancar-relay` and
  `palancar-litellm-proxy`; warm `minReplicas=1`, `maxReplicas=1`; exactly two
  same-vault Key Vault references and no plaintext credentials; exact relay
  environment including Azure Table security, Azure Realtime transcription,
  deployment slot, managed identity, Application Insights connection string,
  disabled statsbeat flags, browser policy, and localhost LiteLLM alias; exact
  OpenRouter LiteLLM environment; and no helper/OTLP/provider topology.
  The reviewed update uses the reference `after_sensitive` envelope. Every
  no-op resource, including the terminal Container App, uses the corresponding
  reference `before_sensitive` envelope as its exact `after_sensitive` value.
- The relay Azure Realtime endpoint is canonical WSS on the exact development
  Foundry host and ends exactly in
  `/openai/v1/realtime?intent=transcription`; deployment is exactly
  `gpt-4o-mini-transcribe`.
- The three immutable image variables are present, canonical, from the exact
  development ACR, and use three distinct exact repositories:
  `palancar-relay`, `palancar-litellm-proxy`, and
  `palancar-expiry-cleanup`. The Container App/Job images must equal those
  variable values exactly.
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

The transition requires exactly 101 passing checks and no unknown checks. Any
failed, unknown, altered, duplicated, omitted, or additional check rejects;
the idempotent form requires the same all-pass check envelope.

## Tests

Derive the positive transition fixture from the sanitized genuine refreshed
Terraform 1.15.8 `show -json` output, preserving the provider/resource envelopes, complete and
applyable flags, configuration and child-module trees, prior/planned values,
nulls, computed values, unknown maps, and sensitivity maps. It must contain no
live contact, secret, credential, instrumentation key, or personal principal
identifier; synthetic placeholders must be cross-bound throughout. The
telemetry-enrichment binary `/tmp/palancar-telemetry-enrichment.tfplan` had
SHA-256
`ad7e5c2090cce0c82d74d40ba242c30f933073c1bdf24a997e06f4d1bbb4dcf7` and is
historical and non-applicable. The former GA item-lifecycle binary is
`/tmp/palancar-ga-item-lifecycle-v3.tfplan`, with reviewed SHA-256
`a4caa91081861c707e07387e4aa2979b3e1cbced0359ee53f19a35d1844b08f8`.
It is also historical and non-applicable because it predates the explicit
language-boundary environment contract; do not guard or apply it. A future
activation needs a newly reviewed protected binary and hash, verified before
guard and immediately before applying that same binary. Verify the binary
hash, not the hash of its JSON view. Keep raw artifacts protected with mode
`0600`, and never commit them. Build the idempotent
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
