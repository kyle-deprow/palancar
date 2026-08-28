# Azure Foundry Entra cutover plan

## Current status and target state

The implementation target is direct Azure Foundry inference only. Terraform
manages the Foundry account and exactly the pinned
`gpt-4o-mini-transcribe` and `gpt-5.6-luna` deployments. The relay uses its
user-assigned managed identity and Entra tokens for both transcription and
generation; Foundry local authentication is disabled. The workload has one
relay container, an empty secrets collection, and no proxy, API-key, or
provider-fallback runtime source.

The live rollout and final evidence are not claimed complete. The remainder of
this document preserves the implementation plan and decision history; use the
current lifecycle flow below as the operator source of truth.

## Objective

Replace the retired generation path with direct Azure Foundry chat completion
calls from the relay. Recreate the `gpt-5.6-luna` deployment through
Terraform, authenticate every deployed inference call with Entra, and retain
the Azure Realtime transcription path.

The user previously explicitly selected Terraform for Palancar, this repository
contains 55 Terraform files and zero Bicep files, and “wire it into the biceps”
is therefore interpreted as “wire it into the existing IaC.” This plan does
not introduce a second Bicep state/deployment system.

The existing `gpt-4o-mini-transcribe` deployment and realtime transcription
path remain intact. Live image digests, resource IDs, endpoints, subscription,
tenant, secrets, and tfvars values are protected rollout inputs and are not
recorded here.

## Historical destructive preflight record

Before this plan was written, the exact manual deployment was inventoried as
`gpt-5.6-luna`, model version `2026-07-09`, format `OpenAI`, SKU
`GlobalStandard`, capacity `1013`, and provisioning state `Succeeded`. The live
relay was confirmed to remain on the OpenRouter path and not reference that
deployment. At the user's explicit request, only that deployment was deleted.
A second metadata-only inventory proved Luna absent and
`gpt-4o-mini-transcribe` still present. The model catalog still advertises the
exact Luna version/SKU. Import is intentionally not part of this migration.

Immediately before applying the saved model-bootstrap plan, repeat the
metadata-only absence check and confirm the quota has been released. Never
read model content, keys, or deployment credentials during this check.

## Fixed architecture

- Preserve the `GenerationProvider` interface and mock provider for local
  tests. The only deployed generation provider is `azure-openai`.
- Call the fixed Azure chat-completions route directly from the relay with
  deployment name `gpt-5.6-luna`.
- Pin the Azure OpenAI Entra scope in code to
  `https://cognitiveservices.azure.com/.default`. The scope and API
  path/version are not runtime-configurable.
- Extract the capable managed-identity source already implemented in
  `packages/transcription/src/azure-managed-identity.ts`; do not create a
  second credential/cache implementation. Instantiate the extracted source
  exactly once in relay host composition and inject it into transcription and
  generation.
  Both consumers use the same pinned Azure OpenAI
  `https://cognitiveservices.azure.com/.default` scope; the extracted source
  therefore retains one cache for that fixed route scope rather than accepting
  caller-supplied scopes. It caches until 120 seconds before expiry,
  coalesces refreshes,
  isolates caller cancellation, aborts a refresh when no waiters remain, and
  is closed exactly once during relay shutdown. If either provider fails
  construction, composition closes the source before failing.
- Keep one request per model attempt, with no retry in `GenerationService` or
  the session, a 15-second deadline, strict JSON Schema,
  `reasoning_effort: low`, `max_completion_tokens: 512`, the 8,192-byte response
  bound, substantive-character checks, and strict Spanish/Turkish generated
  language validation.
- The 15-second generation deadline covers token acquisition and HTTP response
  processing and is combined with session cancellation. Readiness may acquire
  a token/configuration check but must never call chat completions or consume
  Luna TPM.
- Emit only a trusted fixed provider failure stage on the detailed
  provider-response metric. Never emit endpoints, status codes, tokens,
  identifiers, prompts, transcripts, response bodies, generated text, token
  counts, exception text, or raw finish reasons.

## Foundry deployment contract

Terraform must require exactly these deployments when the relay is enabled:

| Deployment | Model version | SKU | Capacity | Upgrade |
| --- | --- | --- | ---: | --- |
| `gpt-4o-mini-transcribe` | `2025-12-15` | `GlobalStandard` | 1 | `NoAutoUpgrade` |
| `gpt-5.6-luna` | `2026-07-09` | `GlobalStandard` | 1013 | `NoAutoUpgrade` |

Capacity 1013 reproduces the captured manual deployment and must not be rounded
to 1000. The Foundry account retains `local_auth_enabled = false`; the runtime
identity retains the account-scoped Cognitive Services OpenAI User role needed
for Foundry inference as well as its existing unrelated Storage and monitoring
roles.

## Runtime environment contract

The generation/auth-specific additions and replacements are exactly:

```text
PALANCAR_GENERATION_PROVIDER=azure-openai
PALANCAR_AZURE_GENERATION_ENDPOINT=https://<resource>.openai.azure.com
PALANCAR_AZURE_GENERATION_DEPLOYMENT=gpt-5.6-luna
AZURE_CLIENT_ID=<runtime-user-assigned-managed-identity-client-id>
```

All existing relay host, security-state, telemetry, browser policy, deployment
slot, and Azure transcription variables remain unchanged.

The generation endpoint validator accepts only canonical HTTPS origins with an
exact `.openai.azure.com` DNS suffix and no userinfo, explicit port, path,
query, fragment, whitespace, or trailing slash. Code appends exactly
`/openai/v1/chat/completions`.

Deployed mode rejects all retired provider/proxy variables, API-key settings,
configurable inference scopes, and configurable generation API versions. The
Container App has one relay container at 0.25 CPU/0.5 GiB and an empty secrets
collection.

## Failure contract

Trusted provider failures use only:

```text
identity timeout transport auth rate_limit http response_size
response_envelope finish_length finish_other completion_json
completion_schema unknown
```

Cancellation has no provider failure stage. Unknown or hostile thrown values
map to `unknown`. HTTP 401/403 map to `auth`, 429 maps to `rate_limit`, other
non-success responses map to `http`, and response bodies are always discarded
without logging.

## Interrupted generation diff disposition

These exact seven generation files contain uncommitted work from an interrupted
Luna task:

```text
packages/generation/src/errors.ts
packages/generation/src/evidence.ts
packages/generation/src/litellm.ts
packages/generation/src/service.ts
packages/generation/src/types.ts
packages/generation/test/generation.test.ts
packages/generation/test/litellm-provider.test.ts
```

They must never be reset, overwritten wholesale, or accidentally staged with a
plan/guard commit.

The captured binary worktree diff SHA-256 for these seven paths is
`<protected-hash>`.
Recompute `git diff --binary` over the exact ordered path list before and after
slices 1 and 2 and require that hash unchanged. A mismatch stops the slice;
never restore or rewrite the files to force a match.

- Preserve and adapt the generic trusted-error, evidence, and service-stage
  propagation in `packages/generation/src/errors.ts`,
  `packages/generation/src/evidence.ts`,
  `packages/generation/src/service.ts`,
  `packages/generation/src/types.ts`, and
  `packages/generation/test/generation.test.ts`.
- Expand the ten LiteLLM-oriented stages to the thirteen Azure stages in this
  plan and replace provider-specific public wording with generic Azure-neutral
  content-free wording.
- Delete/replace the modified positive LiteLLM implementation and
  `litellm-provider.test.ts`; do not commit its `max_tokens` request or its
  LiteLLM-specific error behavior.
- Stage every model-plan/guard commit with an explicit path list that excludes
  all seven interrupted files. Before commit, require
  `git diff --cached --name-only` to equal the reviewed allowlist exactly and
  fail if any of the seven paths appears.

## Historical sequential implementation slices and ownership

No two workers may be active on overlapping paths. Where a later slice lists a
path owned by an earlier slice, ownership transfers only after the earlier
slice is independently verified, Sol-reviewed, and committed. Each Luna worker
receives only its listed files and this read-only plan. The orchestrator runs
the exact commands below independently; Sol reviews each slice before commit.
Before every slice set `PALANCAR_SLICE_BASE` to `git rev-parse HEAD`, require it
to be a full commit hash, and include it in the worker report. A later slice may
not start until the preceding overlapping slice's reviewed commit is `HEAD`.
The plan itself is committed alone before any worker starts and remains
read-only to every worker.

1. **Model contract**
   - Files: `infra/modules/foundry/variables.tf`,
     `infra/modules/foundry/tests/deployments.tftest.hcl`,
     `infra/environments/dev/locals.tf`, `infra/environments/dev/main.tf`,
     `infra/environments/dev/variables.tf`,
     `infra/environments/dev/terraform.tfvars.example`, and
     `infra/environments/dev/tests/alerts.tftest.hcl`.
   - Add exactly the Luna deployment, permit its canonical dotted name, and
     preserve the live Container App/OpenRouter inputs for the model-only
     phase.
   - Tests must accept exactly the two pinned deployments and reject missing or
     extra deployments, Luna capacity 1000/1012/1014, wrong version/SKU/upgrade,
     and dotted-name whitespace, doubled-dot, leading-dot, trailing-dot, and
     non-canonical lookalikes.
   - Verify with
     `/home/dev/.local/bin/terraform-1.15.8 fmt -check -recursive infra`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/environments/dev init -backend=false -input=false`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/environments/dev validate`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/foundry init -backend=false -input=false`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/foundry test`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/environments/dev test`,
     and `git diff --check`.

2. **Model-bootstrap guard and live predecessor repin**
   - Files: `infra/scripts/assert-dev-plan.mjs`,
     `infra/scripts/assert-dev-plan.test.mjs`,
     `infra/scripts/dev-plan-lifecycle.mjs` (new),
     `infra/scripts/dev-plan-lifecycle.test.mjs` (new),
     `infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json` (new),
     `infra/scripts/fixtures/final-rollout-transition.plan-fixture.json`,
     `infra/README.md`, `docs/final-rollout-guard-plan.md`, and
     `docs/generation-output-rollout-guard-plan.md`.
   - Repin the live image to
     `<protected-hash>`;
     preserve stale history. Add a new
     mode that permits exactly one Luna create plus the deployment-name output
     update while requiring transcription, Container App, all RBAC, and every
     other resource/output to be no-op with no drift.
   - Add a saved-plan lifecycle utility with exact phases `model-bootstrap`,
     `runtime-cutover`, `credential-cleanup`, and `terminal`; exact operations
     `init`, `create`, `guard`, `diagnostic`, `preflight`, `apply`, `reconcile`,
     `supersede`, `finalize`, and `close`; and guard mappings
     `luna-model-bootstrap`, `azure-generation-cutover`,
     `azure-credential-cleanup`, and `final-rollout-complete`, respectively.
     It owns a mode-0600 durable rollout state whose only legal advancement is
     manual-Luna-absent → model-applied → runtime-applied →
     credentials-and-RBAC-cleaned → terminal-verified. Terminal has no apply.
     `init` is the only operation allowed when state is absent: under the global
     lock it repeats the metadata-only Luna-absent/transcription-present/catalog
     check, then exclusively and atomically creates manual-Luna-absent state.
     Create/guard/preflight/apply reject skipped, repeated, cross-phase, stale,
     or out-of-order operations. Successful mutating apply advances its phase;
     terminal `finalize` (the only legal finalize) requires the guarded no-op
     plan plus all terminal live/credential receipts before atomically advancing
     to terminal-verified. Terminal guard alone never advances state.
   - `create` invokes exact `/home/dev/.local/bin/terraform-1.15.8` in canonical
     `infra/environments/dev` with
     `plan -refresh=true -input=false -lock=true -lock-timeout=5m` and a
     phase-specific output. `guard` revalidates every binding, invokes that
     binary's `show -json` on only the canonical manifest plan, and sends only
     that mode-0600 JSON to the mapped guard. `preflight` creates a plan-bound
     receipt valid for at most two minutes: model requires Luna absent, released
     quota, exact catalog entry, and transcription intact; runtime requires the
     pinned live predecessor plus the passed one-digest diagnostic receipt;
     credential requires the Entra-only live revision, fixed credential-cleanup
     operation receipt, and zero runtime secret references. Apply requires that
     fresh receipt. Plan maximum age at apply is 15 minutes for model/runtime and
     30 minutes for credential; expired plans are invalidated and regenerated.
     If a credential plan expires after irreversible Key Vault cleanup,
     `supersede credential-cleanup <old-run-id>` is the only recovery: it first
     revalidates the old plan-bound cleanup manifest/absence receipt and exact
     context, then creates a new normal-refresh run bound to those receipt hashes.
     The new run receives its own guard, Sol review, and preflight; no mutation is
     repeated.
     Exact apply argv is
     `apply -input=false -lock=true -lock-timeout=5m <canonical-manifest-plan>`;
     no caller path or passthrough argument is accepted.
   - Every create manifest/receipt binds SHA-256 of the plan, exact Terraform
     executable, lifecycle script, guard script, repository commit, canonical
     working directory, phase, fixed argv, canonical backend identity, Terraform
     workspace, state lineage/serial, cloud, subscription, tenant, and caller
     identity. The backend identity is sorted canonical JSON of exactly backend
     type, resource group, storage account, container, state key, subscription,
     tenant, `use_azuread_auth`, and `use_cli`; its required SHA-256 is
     `<protected-hash>`.
     Identifiers/configuration remain only in protected memory/artifacts; normal
     receipts retain hashes. Every operation revalidates all context and state
     serial/lineage before acting.
   - Before child execution, reject every inherited name beginning `TF_`,
     `ARM_`, `MSI_`, or `IDENTITY_`, plus inherited `AZURE_CONFIG_DIR`.
     Construct the child environment from a closed internal
     allowlist only: fixed `PATH=/usr/bin:/bin`, fixed locale,
     `AZURE_CONFIG_DIR=/home/dev/.azure`, `CHECKPOINT_DISABLE=1`, internally set
     `TF_IN_AUTOMATION=1`, and an empty mode-0600 `TF_CLI_CONFIG_FILE` inside the
     run directory. `HOME` is neither overridden nor inherited. No proxy,
     certificate, logging, plugin, variable, workspace, data-dir, or caller
     environment is inherited. Use exact `/usr/bin/az` only for read-only
     account/context and preflight calls; Terraform children always use the
     exact pinned binary. Require current-user-owned regular non-symlink backend
     cache mode at most 0600, backend type/hash above, workspace exactly
     `default`, and active CLI context equal to backend context.
   - Pin the reviewed Terraform executable SHA-256 to
     `<protected-hash>`.
     Guard/lifecycle scripts, fixtures, and every transitive imported guard
     dependency must be byte-identical to their Git blobs at the reviewed `HEAD`;
     record blob IDs and SHA-256 values. Before every lifecycle operation require
     no staged/untracked paths and every non-generation tracked path clean. For
     model-bootstrap only, permit exactly the seven documented generation paths
     with binary diff hash
     `<protected-hash>`;
     later phases require a fully clean
     worktree. This prevents dirty fixtures/imports from entering the guard.
   - Caller identity supports only Azure CLI `user` accounts. Resolve the
     canonical object ID with exact `/usr/bin/az ad signed-in-user show`, require
     it equal the protected Terraform operator identity, and bind SHA-256 of
     `{cloud,subscription,tenant,userType,objectId}`; never retain/display the
     source identifiers in normal receipts.
   - Every lifecycle directory is canonical, current-user-owned, mode 0700, and
     non-symlink. Every plan, manifest, state, lock record, JSON, log, and receipt
     is regular/non-symlink, owner-only mode 0600, exclusively created with
     restrictive mode before content, fsynced, and atomically renamed without
     replacement. A rollout-wide lock outside individual run directories
     serializes every operation across all runs/phases. Apply atomically consumes the
     create-only guard/preflight receipts. Before Terraform it durably records
     exact state `applying`; success writes a create-only receipt and atomically
     advances to `applied`. A crash or ambiguous exit records/retains `unknown`;
     the old plan is never reapplied. `reconcile` performs only read-only live
     and state inspection: exact expected post-state creates the final applied
     receipt; exact unchanged pre-state records invalidated/failed and requires
     a new normal-refresh plan/review; any mixed, partial, or unknown state
     remains unknown and blocks later phases/escalation until a Sol-reviewed
     recovery plan is defined. It never replays the old plan. Receipts are regular non-symlink, owner-only, exclusive atomic
     writes with file/directory fsync and no replacement. Apply receipt JSON is
     at most 1,024 bytes with status exactly `applied`, `unknown`, or `invalidated`.
   - Unit tests cover inherited-environment contamination (including unknown
     `TF_*`), constructed-environment equality, wrong backend/workspace/account/
     caller/state serial/lineage, executable/guard/repo hash substitution,
     stale plans/preflights, phase skips/repeats, concurrent apply, every crash
     boundary, receipt replacement, reconciliation, arbitrary paths, symlinks,
     and terminal apply rejection.
   - Verify with `node --test infra/scripts/assert-dev-plan.test.mjs`,
     `node --test infra/scripts/dev-plan-lifecycle.test.mjs`, and `git diff --check`.

3. **Shared Azure auth**
   - Files: `packages/transcription/src/azure-managed-identity.ts`,
     `packages/transcription/src/index.ts`,
     `packages/transcription/test/azure-managed-identity.test.ts`,
     `packages/transcription/package.json`, `packages/azure-auth/package.json`
     (new), `packages/azure-auth/tsconfig.json` (new),
     `packages/azure-auth/tsconfig.build.json` (new),
     `packages/azure-auth/src/index.ts` (new),
     `packages/azure-auth/src/managed-identity-token-source.ts` (new),
     `packages/azure-auth/test/managed-identity-token-source.test.ts` (new),
     `package.json`, `package-lock.json`, and `tsconfig.base.json`.
   - Move/extract the implementation, retain a compatibility export for the
     route-specific Azure OpenAI scope used by both consumers, and expose only
     that one pinned scope; do not add caller-selectable scopes or change the
     transcription protocol.
   - Verify with `npm run lint`, `npm run typecheck`,
     `npm test --workspace @palancar/azure-auth`,
     `npm test --workspace @palancar/transcription`,
     `npm run build`, and `git diff --check`, including exact concurrency,
     cancellation, expiry, close, and hostile credential cases. Host
     construction rollback is not owned here; it is owned by slice 5.

4. **Generation provider**
   - Files: `packages/generation/package.json`, `package-lock.json`,
     `packages/generation/README.md`, `packages/generation/src/index.ts`,
     `packages/generation/src/errors.ts`, `packages/generation/src/evidence.ts`,
     `packages/generation/src/litellm.ts` (delete),
     `packages/generation/src/azure-openai.ts` (new),
     `packages/generation/src/service.ts`, `packages/generation/src/types.ts`,
     `packages/generation/test/generation.test.ts`,
     `packages/generation/test/litellm-provider.test.ts` (delete), and
     `packages/generation/test/azure-openai-provider.test.ts` (new).
   - Reconcile the interrupted files using the disposition above. Replace the
     positive LiteLLM provider/export/tests with a direct Azure provider.
   - Reconcile the interrupted uncommitted failure-taxonomy work; do not commit
     its LiteLLM-specific request code or `max_tokens` field.
   - Preserve strict output parsing and generated-language validation.

   - Verify with `npm run lint`, `npm run typecheck`,
     `npm test --workspace @palancar/generation`, `npm run build`, and
     `git diff --check`.

5. **Relay composition, diagnostic, and telemetry**
   - Files: `apps/relay/src/host.ts`, `apps/relay/src/session.ts`,
     `apps/relay/src/telemetry.ts`, `apps/relay/src/types.ts`,
     `apps/relay/src/azure-generation-diagnostic.ts` (new),
     `apps/relay/src/index.ts`, `apps/relay/test/relay-host.test.ts`,
     `apps/relay/test/relay-core.test.ts`, `apps/relay/test/telemetry.test.ts`,
     `apps/relay/test/generation-production-composition.test.ts`,
     `apps/relay/test/azure-generation-diagnostic.test.ts` (new),
     `apps/relay/package.json`, `apps/relay/Dockerfile`, `package-lock.json`,
     `packages/telemetry/src/index.ts`, and
     `packages/telemetry/test/telemetry.test.ts`.
   - Parse only the fixed Azure generation environment.
   - Share one token source with transcription/generation and close it during
     host shutdown. `apps/relay/test/relay-host.test.ts` owns construction
     rollback and exact-once close verification.
   - Add the fixed failure-stage attribute only to
     `generation.failure.provider_response`.
   - Add a content-free one-call capability diagnostic entry point to the relay
     image. Install a process-level 90,000 ms watchdog before token acquisition;
     if it fires, write exactly
     `azure-generation-diagnostic: failed stage=timeout` to stdout and terminate
     with exit 20. Every normal pass/failure path clears the watchdog before its
     single bounded output and exit. Host construction proves exactly one token
     source is shared and closed once.
   - Verify with `npm run lint`, `npm run typecheck`,
     `npm test --workspace @palancar/relay`,
     `npm test --workspace @palancar/telemetry`, `npm run build`, and
     `git diff --check`, including one-request diagnostic behavior,
     construction rollback, exact-once token-source close, and zero-content
     output.

6. **Terraform runtime cutover**
   - Files: `infra/modules/container-app-workload/main.tf`,
     `infra/modules/container-app-workload/locals.tf`,
     `infra/modules/container-app-workload/variables.tf`,
     `infra/modules/container-app-workload/outputs.tf`,
     `infra/modules/container-app-workload/README.md`,
     `infra/modules/container-app-workload/tests/runtime-contract.tftest.hcl`,
     `infra/modules/workload-key-vault/main.tf`,
     `infra/modules/workload-key-vault/variables.tf`,
     `infra/modules/workload-key-vault/outputs.tf`,
     `infra/modules/workload-key-vault/moved.tf` (new),
     `infra/modules/workload-key-vault/tests/runtime-role-assignment.tftest.hcl`
     (new),
     `infra/modules/identities-rbac/main.tf`,
     `infra/modules/identities-rbac/variables.tf`,
     `infra/modules/identities-rbac/outputs.tf`,
     `infra/modules/identities-rbac/tests/operator-rbac.tftest.hcl`,
     `infra/environments/dev/main.tf`, `infra/environments/dev/locals.tf`,
     `infra/environments/dev/variables.tf`, `infra/environments/dev/outputs.tf`,
     `infra/environments/dev/terraform.tfvars.example`, and
     `infra/environments/dev/tests/alerts.tftest.hcl`.
   - Retain and require the exact Luna deployment in the required map.
   - Remove LiteLLM/OpenRouter variables, secrets, sidecar, probes, resources,
     Container App Key Vault references/preconditions, and positive runtime
     tests.
   - Set `configuration.maxInactiveRevisions=1`, the platform minimum, so Azure
     prunes all but the immediate inactive predecessor without creating wasteful
     synthetic revisions. Inactive revisions have no provisioning/running state;
     the platform exposes deactivate/list/activate but no delete operation; see
     [Microsoft's revision lifecycle](https://learn.microsoft.com/en-us/azure/container-apps/revisions)
     and [revision REST operations](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps-revisions?view=rest-resource-manager-containerapps-2025-01-01).
   - Add the Azure generation endpoint/deployment contract and retain the
     OpenAI User role dependency.
   - Preserve the existing Secrets User role assignment as a Terraform no-op
     during cutover, but remove it from Container App dependencies. In
     `workload-key-vault`, add an `enable_runtime_secrets_user_assignment`
     boolean defaulting to true, make the assignment conditional with `count`,
     make its output nullable, and add an explicit `moved` block from
     `azurerm_role_assignment.runtime_secrets_user` to
     `azurerm_role_assignment.runtime_secrets_user[0]`. The dev environment
     switch remains true during runtime cutover, so this is an address migration
     with no RBAC action. Express the output as
     `one(azurerm_role_assignment.runtime_secrets_user[*].id)`, which is null
     when disabled. Runtime-cutover guard/fixture requires the exact
     `previous_address` move and no resource action, and its apply must commit
     that move to state. The later cleanup sets it false and the guard permits
     exactly one delete at
     `module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user[0]`
     only when `previous_address` is absent; lifecycle phase state must already
     prove runtime cutover applied.
   - Verify with
     `/home/dev/.local/bin/terraform-1.15.8 fmt -check -recursive infra`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/environments/dev init -backend=false -input=false`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/environments/dev validate`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/container-app-workload init -backend=false -input=false`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/container-app-workload test`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/workload-key-vault init -backend=false -input=false`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/workload-key-vault test`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/identities-rbac init -backend=false -input=false`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/identities-rbac test`,
     `/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/environments/dev test`,
     and `git diff --check`.

7. **OpenRouter source removal**
   - Files to delete: `apps/litellm-proxy/Dockerfile`,
     `apps/litellm-proxy/README.md`, `apps/litellm-proxy/config.azure.yaml`,
     `apps/litellm-proxy/config.openrouter.yaml`,
     `apps/litellm-proxy/entrypoint.sh`, and
     `apps/litellm-proxy/scripts/validate-local.mjs`.
   - Files to update: `docs/implementation-plan.md`,
     `docs/remaining-implementation-plan.md`,
     `docs/litellm-oom-remediation-plan.md`, and `infra/README.md`.
   - Delete the six listed LiteLLM proxy files and remove OpenRouter/LiteLLM
     production instructions only from the four listed update files. Do not edit
     tests or documentation outside this allowlist.
   - Do not modify generic workspace/package scripts; the proxy has no package
     manifest and the root workspace globs need no cleanup.
   - Do not delete live Key Vault secrets until the Entra-only revision is
     verified and no references remain.
   - Before work, set `PALANCAR_SLICE_BASE` to the verified full commit hash.
     Verify with
     `test "$PALANCAR_SLICE_BASE" = "$(git rev-parse HEAD)"`,
     `for p in apps/litellm-proxy/Dockerfile apps/litellm-proxy/README.md apps/litellm-proxy/config.azure.yaml apps/litellm-proxy/config.openrouter.yaml apps/litellm-proxy/entrypoint.sh apps/litellm-proxy/scripts/validate-local.mjs; do test ! -e "$p" && test ! -L "$p"; done`,
     `for p in docs/implementation-plan.md docs/remaining-implementation-plan.md docs/litellm-oom-remediation-plan.md infra/README.md; do test -f "$p" && test ! -L "$p"; done`,
     `zsh -c 'rg -ni "openrouter|litellm" docs/implementation-plan.md docs/remaining-implementation-plan.md docs/litellm-oom-remediation-plan.md infra/README.md >/dev/null; PALANCAR_RG_STATUS=$?; test "$PALANCAR_RG_STATUS" -eq 1'`,
     `test -z "$(git diff --cached --name-only)"`, and
     `test -z "$(git ls-files --others --exclude-standard)"`, and
     `diff -u <({ printf 'D\t%s\n' apps/litellm-proxy/Dockerfile apps/litellm-proxy/README.md apps/litellm-proxy/config.azure.yaml apps/litellm-proxy/config.openrouter.yaml apps/litellm-proxy/entrypoint.sh apps/litellm-proxy/scripts/validate-local.mjs; printf 'M\t%s\n' docs/implementation-plan.md docs/litellm-oom-remediation-plan.md docs/remaining-implementation-plan.md infra/README.md; } | sort) <(git diff --name-status "$PALANCAR_SLICE_BASE" -- | sort)`. Then run `git diff --check`.
     Run under zsh. Missing/unreadable files, dangling symlinks, update-file
     deletion, wrong status, staged/untracked/extra paths, or `rg` status other
     than exactly 1 fail the slice.

8. **Runtime and cleanup exact-plan guards and cleanup utility**
   - Files: `infra/scripts/assert-dev-plan.mjs`,
     `infra/scripts/assert-dev-plan.test.mjs`,
     `infra/scripts/dev-plan-lifecycle.mjs`,
     `infra/scripts/dev-plan-lifecycle.test.mjs`,
     `infra/scripts/fixtures/azure-generation-cutover.plan-fixture.json` (new),
     `infra/scripts/fixtures/azure-credential-cleanup.plan-fixture.json` (new),
     `infra/scripts/fixtures/final-rollout-transition.plan-fixture.json`,
     `infra/scripts/remove-env-entry.mjs` (new),
     `infra/scripts/remove-env-entry.test.mjs` (new),
     `infra/scripts/cleanup-key-vault-credentials.mjs` (new),
     `infra/scripts/cleanup-key-vault-credentials.test.mjs` (new),
     `infra/scripts/set-dev-runtime-secrets-role.mjs` (new),
     `infra/scripts/set-dev-runtime-secrets-role.test.mjs` (new),
     `infra/scripts/openrouter-revocation-state.mjs` (new),
     `infra/scripts/openrouter-revocation-state.test.mjs` (new),
     `infra/README.md`, `docs/final-rollout-guard-plan.md`, and
     `docs/generation-output-rollout-guard-plan.md`.
   - Add a runtime-cutover mode accepting Luna/transcription/RBAC as no-op and
     exactly one
     Container App update to one container, zero secrets, and the fixed Entra
     environment.
   - Add a credential-cleanup mode accepting exactly one deletion at
     `module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user[0]`
     while app, models, and all other RBAC are no-op and `previous_address` is
     absent. Runtime-cutover fixtures require the old-to-index-zero
     `previous_address` and no RBAC action; lifecycle tests require that move's
     successful apply before cleanup can be created.
   - Add terminal no-op handling and adversarial mutations for model drift,
     stale images, extra containers/secrets, API-key fields, mutable images,
     identities, roles, resource sizing, `maxInactiveRevisions` other than 1,
     and unknown values.
   - Slice 7 leaves its four update files with zero retired-provider references.
     Slice 8 may reintroduce only the two exact retired Key Vault secret names
     inside one `Credential cleanup (retired)` section of `infra/README.md`;
     tests reject OpenRouter/LiteLLM names in runtime, deployment, configuration,
     or any other documentation section.

   - Add a content-free cleanup utility that requires an explicit absolute
     file path and key name, refuses symlinks/non-regular files, and has closed
     `remove` and read-only `assert-absent` modes. Remove requires exactly one
     assignment, creates an exclusive sibling temporary file with the original
     restrictive mode before writing any content, fsyncs file and directory,
     atomically renames, and requires zero remaining assignments. Every failure
     before rename closes and unlinks the temporary file. Assert-absent requires
     zero assignments without writing. Neither mode prints contents or values.
   - Add a protected-tfvars utility fixed to
     `infra/environments/dev/terraform.tfvars`. It refuses symlink/non-regular/
     non-current-user-owned files or mode above 0600 and has `assert-enabled`,
     `disable`, and `assert-disabled` modes. Enabled accepts only zero
     assignments (effective module default true) or exactly one literal true;
     disable requires that enabled precondition, preserves every non-target byte
     and assignment, and atomically writes exactly one literal false with mode/
     owner preserved and the same pre-rename cleanup guarantees. Disabled
     requires exactly one false. It never prints tfvars content. Runtime cutover
     requires enabled; credential plan creation requires disabled.
   - Add a protected OpenRouter revocation utility fixed to the workspace
     `.env` path and lifecycle evidence root with exact operations `prepare`,
     `resume`, `mark-local-removed`, and `assert-complete`. Its durable exclusive state machine
     is `preflight-captured` → `awaiting-user` → `revoked` → `local-removed`.
     Prepare stores the mode-0600 raw current-key response and outputs only the
     three permitted masked fields. Resume in awaiting-user rechecks the old key:
     200 remains awaiting-user; 401 atomically writes a content-free revocation
     receipt, advances to revoked, unlinks the raw file, and verifies absence.
     Revoked permits either exact-one removal followed by read-only absence or,
     after a crash post-rename, direct absence assertion before local-removed.
     Every state/receipt write is atomic/fsynced and tests cover every crash.
   - Add a resumable Key Vault cleanup utility with closed `start`, `resume`,
     and read-only `assert-absent` modes and a hard-coded exact target set of
     `openrouter-api-key` and `litellm-master-key`. Start requires each target
     active exactly once and deleted zero times, then writes a mode-0600 operation
     manifest bound to the reviewed credential plan hash, vault resource ID,
     subscription, tenant, Azure cloud, caller identity, canonical lifecycle run
     ID, fixed target names, and start state. Resume/assert-absent accept only the
     run ID; they read the protected descriptor rather than a vault name from
     argv and revalidate every bound context before access.
   - For each target independently, resume accepts only
     `(active=1,deleted=0)`, `(active=0,deleted=1)`, or
     `(active=0,deleted=0)`: delete from the first, purge from the second, and
     finish the third. Any duplicate, both-active-and-deleted, malformed, or
     unavailable inventory fails closed. Use exact `/usr/bin/az` only to acquire
     short-lived Entra tokens into memory; perform ARM identity validation and
     Key Vault data-plane name-only queries/fixed-name mutations directly over
     HTTPS so vault/secret identifiers never enter process arguments. Never read
     secret values. Token subprocesses and HTTP requests have 15-second
     deadlines; each invocation has a 180-second total deadline and fixed
     five-second convergence polls.
   - The protected manifest tracks at most three start/resume mutation attempts
     and 15 minutes cumulative elapsed time with fixed backoff. After that the
     utility permits only read-only assertion/context output and requires a new
     Sol-reviewed recovery decision; it never loops indefinitely. Tests inject
     clock/process/HTTP runners and cover every two-target partial state, every
     mutation crash boundary, child/request hang, context mismatch, plan-hash
     mismatch, attempt/elapsed ceilings, safe restart, and terminal assertion.
   - Verify with `node --test infra/scripts/assert-dev-plan.test.mjs`,
     `node --test infra/scripts/dev-plan-lifecycle.test.mjs`,
     `node --test infra/scripts/remove-env-entry.test.mjs`, and
     `node --test infra/scripts/cleanup-key-vault-credentials.test.mjs`,
     `node --test infra/scripts/set-dev-runtime-secrets-role.test.mjs`,
     `node --test infra/scripts/openrouter-revocation-state.test.mjs`,
     `git diff --check`.

## Saved-plan generation contract

Every model-bootstrap, runtime-cutover, credential-cleanup, and terminal plan
uses the lifecycle utility from the repository root:

```text
node infra/scripts/dev-plan-lifecycle.mjs init
node infra/scripts/dev-plan-lifecycle.mjs create model-bootstrap|runtime-cutover|credential-cleanup|terminal
node infra/scripts/dev-plan-lifecycle.mjs guard model-bootstrap|runtime-cutover|credential-cleanup|terminal <run-id>
node infra/scripts/dev-plan-lifecycle.mjs diagnostic runtime-cutover <run-id>
node infra/scripts/dev-plan-lifecycle.mjs preflight model-bootstrap|runtime-cutover|credential-cleanup <run-id>
node infra/scripts/dev-plan-lifecycle.mjs apply model-bootstrap|runtime-cutover|credential-cleanup <run-id>
node infra/scripts/dev-plan-lifecycle.mjs reconcile model-bootstrap|runtime-cutover|credential-cleanup <run-id>
node infra/scripts/dev-plan-lifecycle.mjs supersede credential-cleanup <expired-run-id>
node infra/scripts/dev-plan-lifecycle.mjs finalize terminal <run-id>
node infra/scripts/dev-plan-lifecycle.mjs close terminal <run-id>
```

Create chooses an opaque run ID and a new canonical directory only beneath
`/home/dev/.local/state/palancar/azure-foundry-entra-cutover`, an absolute fixed
root outside the Git worktree. The root and run directory are mode 0700; plan,
log, show JSON, manifests, guard receipt, and apply receipt are mode 0600. The
caller supplies only a phase and later the strict run ID—never a directory or
plan path. Symlinks, traversal, pre-existing run directories, and wrong owners
or modes fail closed. Every artifact is a current-user-owned regular
non-symlink created exclusively through a mode-correct temporary file before
content, followed by file/directory fsync and atomic rename; no artifact may be
replaced. The global state has an exclusive operation lock and the same rules.

The retained create manifest proves the exact Terraform 1.15.8 binary and argv
included `-refresh=true` and excluded `-refresh=false`, `-target`, `-replace`,
and `-destroy`; it records the process exit, saved-plan SHA-256, executable/code
hashes, complete execution-context hashes, and state lineage/serial. Guard binds
the exact binary's show JSON, mapped guard implementation, and result to those
same fields. The orchestrator verifies modes/receipts before Sol reviews the
exact binary/hash. Preflight revalidates freshness and live predecessor.
Freshness means create-to-apply elapsed time ≤15 minutes for model/runtime and
≤30 minutes for credential, preflight age ≤2 minutes, and exact equality of
repository commit/dependency blobs, working directory, Terraform/guard/lifecycle
hashes, canonical backend hash, workspace, state lineage/serial, cloud,
subscription, tenant, and canonical caller-object hash. Any mismatch expires
the run. Credential supersession carries forward only the prior cleanup
manifest/absence-receipt hashes after revalidating all those fields.
Apply atomically consumes those receipts, is single-use, invokes only the fixed
binary/canonical plan, and reconciles any ambiguous exit without resubmission.
Terminal apply is mechanically rejected. No phase regenerates a plan between
review and apply; an expired/invalidated plan receives a new run and Sol review.

Retain every protected run directory through terminal verification. The global
state enumerates the exact closed run set, including superseded/invalidated
runs; fail on any unregistered entry. Acquire an exclusive closure lock and
create-only tombstone under the sibling fixed path
`/home/dev/.local/state/palancar/azure-foundry-entra-cutover-closure`, outside
the root being deleted; every lifecycle operation rejects while it exists.
Before deletion stage and fsync there a content-free canonical inventory listing
the individual relative receipt labels and SHA-256 values for every manifest,
guard/preflight/apply/reconcile, diagnostic, revocation, and cleanup receipt.
Delete only the exact validated cutover evidence root (never a parent), verify
absence, then atomically/fsync advance the external closure state from
`prepared` to `deleted`. A crash resumes from that external inventory/tombstone
without recreating the root or losing hashes. Then create and commit a
content-free post-deletion attestation at
`docs/azure-foundry-entra-cutover-evidence.md` containing the receipt-inventory
entries (relative content-free labels and individual hashes), aggregate hash,
registered run count, commit/image/plan hashes, bounded outcomes, and
`raw_evidence_deleted=true`. The orchestrator owns this final file; no worker
does. Retain only the content-free external closure inventory/tombstone as the
permanent no-reopen marker. The final Sol audit occurs after that commit and absence check. Raw plans,
show JSON, command output, tokens, and provider responses are never retained in
Git.

## Current operator flow

Use the lifecycle utility from the repository root. Initialize once, then run
the non-terminal phases in order. Model bootstrap uses the normal
create/guard/preflight/apply sequence. Runtime cutover inserts the lifecycle
diagnostic between guard and preflight. Credential cleanup uses the normal
sequence after its role and cleanup prerequisites:

```sh
node infra/scripts/dev-plan-lifecycle.mjs init

model_run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create model-bootstrap)"
node infra/scripts/dev-plan-lifecycle.mjs guard model-bootstrap "$model_run_id"
node infra/scripts/dev-plan-lifecycle.mjs preflight model-bootstrap "$model_run_id"
node infra/scripts/dev-plan-lifecycle.mjs apply model-bootstrap "$model_run_id"

runtime_run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create runtime-cutover)"
node infra/scripts/dev-plan-lifecycle.mjs guard runtime-cutover "$runtime_run_id"
node infra/scripts/dev-plan-lifecycle.mjs diagnostic runtime-cutover "$runtime_run_id"
node infra/scripts/dev-plan-lifecycle.mjs preflight runtime-cutover "$runtime_run_id"
node infra/scripts/dev-plan-lifecycle.mjs apply runtime-cutover "$runtime_run_id"

credential_run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create credential-cleanup)"
node infra/scripts/dev-plan-lifecycle.mjs guard credential-cleanup "$credential_run_id"
node infra/scripts/dev-plan-lifecycle.mjs preflight credential-cleanup "$credential_run_id"
node infra/scripts/dev-plan-lifecycle.mjs apply credential-cleanup "$credential_run_id"
```

Use `<phase>` as `model-bootstrap`, then `runtime-cutover`, then
`credential-cleanup`. The guard mappings are respectively
`luna-model-bootstrap`, `azure-generation-cutover`, and
`azure-credential-cleanup`. If apply is ambiguous, use only
   `reconcile <phase> <run-id>`; never replay the old saved plan. For an
   ambiguous runtime apply, use the exact runtime command with the same run ID:

   ```text
   node infra/scripts/dev-plan-lifecycle.mjs reconcile runtime-cutover "$runtime_run_id"
   ```

   The terminal guard is verification-only:

```sh
terminal_run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create terminal)"
node infra/scripts/dev-plan-lifecycle.mjs guard terminal "$terminal_run_id"
node infra/scripts/dev-plan-lifecycle.mjs finalize terminal "$terminal_run_id"
node infra/scripts/dev-plan-lifecycle.mjs close terminal "$terminal_run_id"
```

For runtime cutover, run the lifecycle diagnostic after guard and before
preflight:

```sh
node infra/scripts/dev-plan-lifecycle.mjs diagnostic runtime-cutover "$runtime_run_id"
```

The lifecycle operation validates the existing Container Apps Job and uses the
guarded immutable relay image, Entra runtime identity, exact no-argument inner
command, and no secrets. It reserves durable intent before the one allowed Job
start POST, records resumable submission/execution/receipt evidence, and never
resubmits after an ambiguous start. The Job's inner command is:

```sh
node apps/relay/dist/azure-generation-diagnostic.js
```

The executable uses Entra and permits at most two sequential model attempts,
each with a fresh `GenerationService` and the shared provider, validator,
turn, token source, watchdog, and cancellation boundary. It retries only the
two exact trusted/correlation-matched complete language-validation evidence
shapes: `invalid-generated-language`/`rejected` with checks `5` or `7` and
nonmatch greater than zero, or `language-validation-failure`/`failed` with
checks `5` or `7` and zero nonmatches. Missing, malformed, multiple,
inconsistent, provider, timeout, cancellation, and unknown evidence is
terminal; attempt two is final and no third attempt exists. The retry lives
only in this diagnostic executable, not in `GenerationService` or the
session. It makes one bounded request per attempt, prints one fixed
pass/failure line, and exits `0` or `20`. The lifecycle still sends exactly one
ACA Job-start request. Runtime-role commands are exactly:

```sh
node infra/scripts/set-dev-runtime-secrets-role.mjs assert-enabled
node infra/scripts/set-dev-runtime-secrets-role.mjs disable
node infra/scripts/set-dev-runtime-secrets-role.mjs assert-disabled
```

Credential preflight creates the protected Key Vault cleanup descriptor and
starts/resumes the operation as needed. The cleanup utility's exact CLI is:

```sh
node infra/scripts/cleanup-key-vault-credentials.mjs start <run-id>
node infra/scripts/cleanup-key-vault-credentials.mjs resume <run-id>
node infra/scripts/cleanup-key-vault-credentials.mjs assert-absent <run-id>
```

The runtime role must be enabled before runtime cutover. After that runtime is
proven, disable the role and assert-disabled before credential-cleanup
creation; its preflight validates the disabled state, and its apply resumes the
cleanup and requires absence evidence.

The fixed retired cleanup targets are `openrouter-api-key` and
`litellm-master-key`; they appear here only as historical cleanup context.
After the Azure-only revision is proven, the fixed local cleanup command is:

```sh
node infra/scripts/remove-env-entry.mjs remove /home/dev/repos/palancar_ws/.env OPENROUTER_API_KEY
node infra/scripts/remove-env-entry.mjs assert-absent /home/dev/repos/palancar_ws/.env OPENROUTER_API_KEY
```

The retained historical provider-revocation utility must be run before that
local removal and before terminal finalization:

```sh
node infra/scripts/openrouter-revocation-state.mjs prepare
node infra/scripts/openrouter-revocation-state.mjs resume
node infra/scripts/openrouter-revocation-state.mjs mark-local-removed
node infra/scripts/openrouter-revocation-state.mjs assert-complete
```

Its durable state captures preflight evidence, waits for user/provider
revocation, requires HTTP 401 proof before `revoked`, and only then accepts
the local removal proof. These provider/key names are historical cleanup
context only.

## Historical implementation and decision record

1. The exact manual Luna deployment deletion is complete. Review and commit
   this plan alone with an explicit path list; do not stage interrupted files.
   Implement/review the model contract and repin the guard to the actual live
   predecessor.
2. Implement the exact Luna Terraform deployment and a model-only plan guard.
   Run Terraform 1.15.8 formatting, validation, tests, guard tests, and full
   repository gates. Review and commit.
3. Use the saved-plan launcher to generate a complete, non-targeted model-only
   plan. Require
   one Luna create, transcription no-op, Container App no-op, no deletes,
   replacements, imports, or drift, with only the expected deployment-name
   output update. Immediately re-confirm Luna is absent and quota is released.
   Re-query the account model catalog and require the exact
   `gpt-5.6-luna`/`2026-07-09`/`OpenAI`/`GlobalStandard` entry immediately
   before apply.
   Sol reviews the exact binary/hash; apply that same binary and verify the
   deployment reaches Succeeded.
4. Implement, review, test, and commit the shared auth, direct provider, relay,
   telemetry, runtime Terraform, OpenRouter removal, diagnostic, and cutover
   guard slices.
5. Build immutable relay and any diagnostic artifact from a clean commit.
6. Run exactly one Entra capability diagnostic per reviewed immutable digest
   with the runtime managed identity. Start the existing cleanup Container Apps
   Job with a one-execution override: candidate relay image; command
   `node apps/relay/dist/azure-generation-diagnostic.js`; exact generation
   endpoint/deployment and existing `AZURE_CLIENT_ID`; no secrets. The
   diagnostic executable installs the reviewed process-level 90,000 ms
   watchdog, because the
   Job's unchanged 300-second replica timeout cannot be overridden by the start
   operation. The diagnostic permits at most two sequential model attempts and
   sends one fixed synthetic request per attempt through the normal parser and
   generated-language validator; its second attempt is final. Stdout is exactly
   `azure-generation-diagnostic: passed` or
   `azure-generation-diagnostic: failed stage=<closed-stage>` where the closed
   set is the provider stages plus `validation_failure`; stderr is fixed and
   content-free. The watchdog outcome is the existing closed provider stage
   `timeout`, with exact stdout
   `azure-generation-diagnostic: failed stage=timeout`. Exit is exactly 0 for
   pass and exactly 20 for every failure. Before
   execution, metadata-verify that the Job has the runtime UAMI attached, that
   this principal retains the account-scoped Cognitive Services OpenAI User
   role, and that retry limit is 0, parallelism is 1, and completion count is 1.
   The candidate execution override must retain that same identity and those
   singleton/no-retry values. Serialize the exact start-operation override as a
   mode-0600 canonical JSON artifact bound to candidate digest, command array,
   0.25 CPU/0.5 GiB resources, fixed environment names/plain values, and an
   empty secret-reference set. Validate its closed schema and SHA-256, submit
   that exact file without reconstructing a request. Before submission, persist
   and fsync a baseline of existing execution names/timestamps plus operation
   state `prepared`, artifact hash, digest, and a generated client request UUID;
   atomically advance to `submitting`, send that UUID in the start request, and
   issue it exactly once. On response timeout/crash, never resubmit. Reconcile
   the baseline, ARM activity record for that request UUID, and executions until
   one exhaustive outcome occurs: (1) succeeded activity plus exactly one
   attributable metadata-equal execution accepts it, regardless of unrelated
   executions; (2) terminal failed/cancelled/rejected activity plus zero
   attributable executions proves rejection and permits a new digest; (3) zero,
   one, or many non-attributable executions are ignored only when activity gives
   outcome 1 or 2; (4) multiple attributable/matching executions, conflicting
   metadata, nonterminal/missing activity, or any other candidate combination is
   `submission_unknown`. After the 120-second active poll, unknown remains a
   durable unresolved gate—no subsequent diagnostic or rollout is allowed—until
   the original activity becomes terminal and reconciliation yields outcome 1
   or 2. Never assume delayed acceptance was rejection. Retain a protected
   create-only submission receipt with only artifact hash/execution name. Inspect the
   resulting execution metadata and require exact image, command, resources,
   environment, and zero secret-reference equality before accepting diagnostic
   output. Store mode-0600 before/after JSON containing the
   complete Job identity and execution template/trigger contract—including all
   environment names, plain values, and secret-reference metadata but never
   secret values—and require identical SHA-256 hashes. Re-verify the attached
   identity and account-scoped OpenAI role after execution. Failure
   returns to implementation; the same digest is never retried and there is no
   fallback.
7. Use the saved-plan launcher to generate a complete, non-targeted
   runtime-cutover plan.
   Require Luna/transcription no-op and exactly one Container App update from
   the pinned predecessor to one relay container, zero secrets, and the fixed
   Azure environment. Sol reviews the exact binary/hash; apply only that file.
8. Verify one healthy active revision, one replica, 100% traffic, and HTTP 200
   health/readiness. Run one controlled bilingual smoke and content-free
   telemetry/cleanup checks.
9. After proving zero active-runtime references, resolve exact credential targets by
   name without reading values. Terraform state inventory has already proved
   that neither Key Vault secret is a Terraform-managed resource; only their
   Container App references and the Secrets User role are managed. Recheck
   that fact before cleanup so deleting the unmanaged secrets cannot create
   Terraform drift.

   The retained provider-revocation utility is part of the current terminal
   evidence contract. Run its exact sequence before local removal:

   ```text
   node infra/scripts/openrouter-revocation-state.mjs prepare
   node infra/scripts/openrouter-revocation-state.mjs resume
   node infra/scripts/openrouter-revocation-state.mjs mark-local-removed
   node infra/scripts/openrouter-revocation-state.mjs assert-complete
   ```

   `resume` requires HTTP 401 proof before `revoked`; local removal is then
   performed and asserted with the fixed `remove-env-entry` commands in the
   operator flow above. These names and commands are historical cleanup
   context only.

   The current fixed local cleanup is interruption-safe; after a successful
   Azure-only cutover, run `remove` and then `assert-absent` with the exact
   path/key pair documented above. No other `.env` path or assignment changes
   are supported.

   Before credential mutation, run
   `node infra/scripts/set-dev-runtime-secrets-role.mjs disable`, create, guard,
   and Sol-review the
   credential-cleanup saved plan, and obtain Sol approval of its exact
   binary/hash; do not apply it yet. Lifecycle creation builds a mode-0600 vault
   descriptor from protected Terraform/Azure context and binds it to that plan.
   Start the fixed-target cleanup with:

   ```text
   node infra/scripts/cleanup-key-vault-credentials.mjs start "$PALANCAR_CREDENTIAL_RUN_ID"
   ```

   The utility resolves the strict run ID only under the fixed lifecycle
   evidence root and writes its operation manifest there. If start is
   interrupted or returns a bounded timeout, invoke only:

   ```text
   node infra/scripts/cleanup-key-vault-credentials.mjs resume "$PALANCAR_CREDENTIAL_RUN_ID"
   ```

   Resume is the sole permitted recovery operation after a bounded failure and
   is limited by the manifest's three-attempt/15-minute ceiling. It either proves
   both fixed targets absent or fails closed on an impossible/ambiguous state.
   Then run `assert-absent` with only the run ID to prove both names
   are absent from active and deleted inventories. Keep the vault and every
   unrelated secret.

   Require the already reviewed credential-cleanup guard to accept exactly one
   deletion at
   `module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user[0]`.
   Apply through the lifecycle utility only after credential absence is proven.
   After apply, require that exact assignment absent and every other role
   unchanged.
10. Repin the terminal predecessor, use the saved-plan launcher to produce a
    normal-refresh no-change plan,
    require all checks passing and zero drift, and never apply that terminal
    plan. Complete the terminal checks below, hash the closed receipt inventory,
    delete and verify the exact evidence root, commit the post-deletion
    attestation, and only then run the final Sol audit.
    Immediately before the terminal audit, run
    `node infra/scripts/remove-env-entry.mjs assert-absent /home/dev/repos/palancar_ws/.env OPENROUTER_API_KEY`
    and the Key Vault cleanup utility's `assert-absent` mode with only the
    retained credential run ID. Inspect every Container App revision and every
    cleanup Job template/execution for retired environment or secret references.
    Every active/current object must have none. Require
    `maxInactiveRevisions=1` and at most the immediate immutable predecessor; if
    that historical snapshot records retired names, classify it as inert
    metadata only after proving inactive status, zero labels/traffic/replicas,
    zero app-level secrets, purged backing secrets, and removed runtime vault
    RBAC. Azure exposes no revision-delete operation, and generating a synthetic
    revision solely to evict inert metadata is explicitly prohibited as wasted
    compute. Any additional inactive revision or any active reference fails.
    Query live RBAC to prove the runtime identity has no Key Vault Secrets User
    assignment at the vault scope, including unmanaged equivalents. Persist the
    bounded terminal receipts, run lifecycle `finalize terminal <run-id>`, and
    require state `terminal-verified` before receipt inventory/deletion.

## Verification gates

- Root `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and
  `git diff --check`.
- Exact Terraform `/home/dev/.local/bin/terraform-1.15.8`: format check,
  validate, module/environment tests, and root lockfile discipline.
- One-fetch/request-body tests, token cache/concurrency/cancellation/close
  tests, all provider failure stages, hostile error tests, and zero-content
  telemetry assertions.
- Spanish/Turkish two- and three-suggestion production composition tests.
- Guard mutation tests and exact saved-plan review before every apply.
- Lifecycle tests for constructed environment, artifact/context hashes,
  state-machine ordering, fresh preflights, plan age, exclusive single-use
  apply, receipt consumption, every crash boundary, and read-only reconciliation.
- Revocation/Key Vault tests for every durable checkpoint, partial two-target
  state, context mismatch, subprocess/HTTP timeout, bounded attempts, atomic
  local rewrites, and resume/assert-absent behavior.
- Four guard contracts: model bootstrap (one Luna create), runtime cutover (one
  Container App update), credential cleanup (one Secrets User role deletion),
  and terminal complete no-op. Every mode requires a normal-refresh complete
  plan, no drift, and no unrelated changes.
- Live Azure inventory proving two pinned deployments, one app container, zero
  app secrets, correct immutable image, healthy single revision, and no drift.
- Terminal inventory of all app revisions, cleanup Job templates/executions,
  and live vault-scope RBAC, including unmanaged assignment detection.
- Post-cleanup utility checks proving the exact local environment entry is
  absent and both unmanaged credential names are absent from active and deleted
  Key Vault inventories; these checks run again after the terminal no-op plan.

## Completion criteria

- Both Foundry deployments are Terraform-managed and Succeeded.
- Every deployed inference request uses the runtime managed identity; local
  auth remains disabled.
- The active live Container App revision has no retired provider container,
  environment, secret, key reference, or fallback.
- Retired provider credentials are removed after cutover.
- The capability diagnostic and bilingual smoke pass once on reviewed
  deployments.
- Content-free telemetry and security-state cleanup pass.
- The final normally refreshed Terraform plan is a guarded no-op with zero
  drift, and the repository is clean with a final Sol READY verdict.
