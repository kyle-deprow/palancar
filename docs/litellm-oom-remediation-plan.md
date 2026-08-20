# LiteLLM OOM remediation

Status: completed. The Phase A sizing change and its original guarded rollout
are retained below as historical implementation evidence. The active rollout
is the Phase B parser-fix relay-image transition.

## Evidence and decision

The exact deployed LiteLLM image succeeds without a memory limit and exits
with code 137 and `OOMKilled=true` under the deployed 512 MiB limit. The live
Azure sidecar has the same 0.25 CPU/0.5 GiB allocation and is in
`CrashLoopBackOff`; Key Vault synchronization, image pull, environment shape,
and relay startup succeeded.

The reviewed remediation keeps every image, probe, secret reference, model,
and relay setting unchanged. A 1 GiB bounded proof became ready and completed
real inference but peaked at 99.99% under amd64 emulation, which provides no
defensible headroom. The final decision therefore hard-codes LiteLLM at 0.75
CPU and 1.5 GiB while retaining relay at 0.25 CPU and 0.5 GiB. The resulting
1 CPU/2 GiB aggregate is the smallest defensible allowed Azure Container Apps
Consumption allocation. Although Azure permits an intermediate 0.75 CPU/1.5
GiB aggregate, it would leave LiteLLM at the empirically headroom-free 1 GiB
bound.

## Completed Phase A: workload contract

The bounded worker was limited to:

- `infra/modules/container-app-workload/main.tf`
- `infra/modules/container-app-workload/tests/runtime-contract.tftest.hcl`
- `infra/modules/container-app-workload/README.md`

Completed requirements:

1. Change only the enabled LiteLLM container resources to `cpu = 0.75` and
   `memory = "1.5Gi"`.
2. Keep relay resources exactly 0.25 CPU/0.5 GiB.
3. Add an exact ordered two-container resource assertion to the existing
   `enabled_openrouter_contract` test.
4. Document the distinct allocations, the 1 CPU/2 GiB aggregate Consumption
   pair, and the measured reason for not using the smaller pair.
5. Do not add variables, change probes/images/environment/secrets/scale, edit
   root wiring or guard files, access Azure, build images, read `.env`, or
   commit.

Verification used `/home/dev/.local/bin/terraform-1.15.8`:

- `terraform fmt -check` for owned Terraform files
- module `terraform init -backend=false -input=false`
- module `terraform validate`
- module `terraform test`
- remove only the generated module-local `.terraform.lock.hcl`
- `git diff --check`

## Phase B: genuine remediation plan and guard repin

After Phase A was reviewed and committed, the parent generated a complete saved
live plan for the parser-fix relay-image-only transition with the deployment
inputs unchanged. The approved saved binary hash is
`f49c0e0c3f15fccebce1a107ce94f01326fb67f52ec2758756b589187d1be2b4`; verify
it immediately before guarding and applying that exact file. This is the
saved-binary hash, not the JSON-view hash. Keep both raw files mode `0600` and
never commit them. The expected
shape is 39 resources: one Container App update and 38 no-ops, with no delete,
replacement, import, or extra resource. LiteLLM remains exactly 0.75 CPU/1.5
GiB and relay remains exactly 0.25 CPU/0.5 GiB. The Container App transition
differs recursively only at relay `containers[0].image` and the computed
provider output: the prior relay digest is the reviewed hard-pinned digest,
while the planned image equals the immutable same-ACR `var.relay_image_digest`
and is distinct from prior. The `relay_latest_revision_name` output becomes
unknown. The genuine transition has zero resource drift, represented by the
omitted `resource_drift` envelope. The subsequent idempotent form requires all
39 resources and all outputs to be no-op, all 101 checks to pass with no unknown
checks, and zero resource drift.

The parent creates a coherent sanitized copy from that genuine plan. A second
bounded worker may then edit only:

- `infra/scripts/assert-dev-plan.mjs`
- `infra/scripts/assert-dev-plan.test.mjs`
- `infra/scripts/fixtures/final-rollout-transition.plan-fixture.json`
- `infra/README.md`
- `docs/final-rollout-guard-plan.md`
- `docs/litellm-oom-remediation-plan.md`

The operational `final-rollout` guard is repinned to this exact one-update
relay-image transition and its subsequent 39-resource all-no-op state.
Historical guard modes remain unchanged. The completed OOM sizing remains
background evidence, not a current resource transition. Tests must reject old
LiteLLM resources, altered relay resources, invalid aggregate pairs, prior
rollout action vectors, alternate prior digests, image-variable mismatches,
provider-output/revision drift, and any mutation beyond the reviewed
resource-only Container App update.

## Completion

Completion requires a Sol review after each phase, all repository and
Terraform gates, immediate verification of the approved saved-binary hash, a
guard-approved exact saved binary, exact binary apply, a ready Azure revision,
real deployed OpenRouter inference, cleanup/telemetry/security smoke, and a
fresh guarded all-no-op plan with 39 no-op resources, zero drift, and 101
passing checks. Native Azure working-set headroom under the 1.5 GiB bound must
be measured after rollout.
