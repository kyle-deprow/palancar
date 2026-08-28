# Azure Container Apps live-schema compatibility plan

## Objective

Restore the protected runtime-cutover preflight against Azure CLI 2.83 without weakening the reviewed Terraform topology or any identity, secret, image, ingress, revision, receipt, or evidence invariant.

## Ownership and scope

Implementation may change only:

- `infra/scripts/dev-plan-lifecycle.mjs`
- `infra/scripts/dev-plan-lifecycle.test.mjs`

This plan is read-only during implementation. Terraform, reviewed-plan canonicalization, lifecycle ordering, receipts, hashing, Azure commands, and deployment behavior are out of scope.

## Required implementation

1. Add source-specific, fail-closed normalization at the live Azure response boundary. Do not recursively discard nulls, empty values, or unknown keys and do not mutate raw responses.
2. Parse app and revision ARM IDs by exact hierarchy. Permit case variation only for ARM keywords, subscription UUID, provider namespace, and resource-type segments; preserve exact protected resource names.
3. Validate the Azure CLI 2.83 app schema. Every newly accepted field must be absent or equal its observed Azure-owned default before projection:
   - top-level `resourceGroup` must equal the protected resource group;
   - app properties: `delegatedIdentities=[]`, `patchingMode="Automatic"`, reconciled `latestRevisionName`/`latestReadyRevisionName`, and the observed `latestRevisionFqdn` (no unobserved ready-revision FQDN field);
   - configuration: null `dapr`, `runtime`, `service`, `revisionTransitionThreshold`, and empty `targetLabel`;
   - registry credential placeholders must be empty strings;
   - ingress defaults must remain null except `exposedPort=0`; FQDN must equal the reviewed relay-origin hostname;
   - app template defaults are null except `revisionSuffix=""`;
   - app scale defaults are `cooldownPeriod=300`, `pollingInterval=30`, `rules=null`;
   - live app containers allow only `imageType="ContainerImage"` and tuple-bound ephemeral storage beyond the reviewed shape: relay CPU `0.25`/memory `0.5Gi` maps to `1Gi`, while the legacy sidecar CPU `0.75`/memory `1.5Gi` maps to `4Gi`.
4. Validate each Azure CLI 2.83 revision independently:
   - exact resource group and canonical app/revision ID hierarchy;
   - canonical revision type;
   - revision FQDN tied to the exact revision and app environment suffix;
   - active `replicas=1`; inactive reported replicas must be zero; reject simultaneous `replicas` and legacy `replicaCount`;
   - revision template defaults are null, including `revisionSuffix=null`;
   - revision scale defaults are null, not the app response's 300/30 values;
   - revision containers must not contain the app-only `ephemeralStorage` response field.
5. Reconcile traffic only after validating the revision list. Accept exactly one 100% traffic entry using either `latestRevision=true` or a concrete revision name. Resolve it to the sole healthy, provisioned, running active revision; require latest/latest-ready names and FQDNs to agree.
6. Pass the lifecycle phase into revision reconciliation and apply the exact
   phase-specific inactive-revision contract:
   - runtime preflight requires the reviewed `before` configuration to omit
     `maxInactiveRevisions`, the reviewed `after` configuration to contain
     numeric `1`, the live value to be exactly `null`, exactly one active
     revision, and no inactive revision; project live `null` to omission only
     for the reviewed-before topology comparison;
   - runtime post-reconciliation requires the same reviewed omission-to-`1`
     transition and accepts live `null` or `1` only with exactly one
     manifest-bound inactive predecessor whose name, zero traffic/replicas,
     and reviewed template match are proven;
   - credential-cleanup and terminal require reviewed `before` and `after`
     values of `1` and accept live `null` or `1` only with the cryptographically
     bound exact inactive predecessor and its zero-state/template proof.
   Never apply a broad at-most rule, mutate raw or normalized source objects,
   or authorize topology before the phase-specific predecessor and active/
   inactive proofs complete.
7. Compare the resulting strict internal projection to the reviewed Terraform before/after topology. Preserve raw Azure objects for evidence.

## Tests

Extend the live fixtures to include the exact Azure CLI 2.83 app and revision fields. Add table-driven rejection tests for every accepted default's non-default form, unknown siblings, malformed/foreign IDs and FQDNs, latest/concrete traffic conflicts, revision/name/FQDN disagreement, invalid replica counts, app-vs-revision source-default confusion, null inactive-limit precondition failures, and any topology divergence. Preserve backward-compatible concrete revision traffic coverage.

## Verification

- `node --test infra/scripts/dev-plan-lifecycle.test.mjs`
- Run any broader infrastructure script test command identified in the repository.
- `git diff --check`

## Completion criteria

All tests pass; Azure CLI 2.83-shaped positive fixtures preflight; every normalized field remains fail-closed; reviewed Terraform shape stays strict; Sol returns `READY`; a fresh protected live runtime-cutover preflight succeeds.
