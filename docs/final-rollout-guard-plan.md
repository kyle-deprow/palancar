# Final rollout plan-guard implementation

Status: Approved for bounded implementation
Date: 2026-08-19

## Objective

Add a new fail-closed `final-rollout` mode to the native development Terraform
saved-plan guard. The approved current transition is the relay-image-only
parser fix after the completed LiteLLM OOM remediation. It retains the deployed
Azure Realtime relay, OpenRouter LiteLLM sidecar, expiry-cleanup Job, action
group, and six scheduled-query alerts while retaining the already deployed
pinned transcription model.

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
  It is relay-image-only: LiteLLM remains exactly 0.75 CPU/1.5Gi, relay
  remains exactly 0.25 CPU/0.5Gi, and the aggregate remains exactly 1 CPU/2Gi.
  The Container App before/after recursive differences are exactly
  `body.properties.template.containers[0].image` and `output`. The prior relay
  image is the hard-pinned reviewed digest
  `sha256:4f34ec6d08c6fd67f08e829c4665020af28fea307de4a17bbf2150abab049170`;
  the planned relay image equals `var.relay_image_digest`, is immutable in the
  same ACR/repository, and is distinct from prior. The provider-computed
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
  resources and all outputs to be no-op, all 101 checks to pass, and zero drift.
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
identifier; synthetic placeholders must be cross-bound throughout. The saved
binary approved for the guarded transition has SHA-256
`f49c0e0c3f15fccebce1a107ce94f01326fb67f52ec2758756b589187d1be2b4`, which
must be verified immediately before guard and apply. That is the binary hash,
not the hash of its JSON view. Keep both protected with mode `0600`, and never
commit either raw artifact. Build the idempotent
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

After apply, require a fresh complete plan with all 39 resources no-op, all
outputs no-op, zero resource drift, and all 101 checks passing. Report changed
files, actual command results, residual risks, and `DONE` only when all
requirements and tests are complete.
