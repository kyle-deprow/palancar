# LiteLLM OOM remediation

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

## Phase A: workload contract

The bounded worker may edit only:

- `infra/modules/container-app-workload/main.tf`
- `infra/modules/container-app-workload/tests/runtime-contract.tftest.hcl`
- `infra/modules/container-app-workload/README.md`

Requirements:

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

Verification uses `/home/dev/.local/bin/terraform-1.15.8`:

- `terraform fmt -check` for owned Terraform files
- module `terraform init -backend=false -input=false`
- module `terraform validate`
- module `terraform test`
- remove only the generated module-local `.terraform.lock.hcl`
- `git diff --check`

## Phase B: genuine remediation plan and guard repin

After Phase A is reviewed and committed, the parent generates a complete saved
live plan with the unchanged three image digests and deployment inputs. The
expected shape is 39 resources: one Container App update and 38 no-ops, no
drift, delete, replacement, import, or extra resource. Prior LiteLLM resources
must be 0.25 CPU/0.5 GiB and planned resources 0.75 CPU/1.5 GiB.

The parent creates a coherent sanitized copy from that genuine plan. A second
bounded worker may then edit only:

- `infra/scripts/assert-dev-plan.mjs`
- `infra/scripts/assert-dev-plan.test.mjs`
- `infra/scripts/fixtures/final-rollout-transition.plan-fixture.json`
- `infra/README.md`
- `docs/final-rollout-guard-plan.md`

The operational `final-rollout` guard is repinned to this exact one-update
remediation and its subsequent 39-resource all-no-op state. Historical guard
modes remain unchanged. Tests must reject old LiteLLM resources, altered relay
resources, invalid aggregate pairs, prior rollout action vectors, and any
mutation beyond the reviewed resource-only Container App update.

## Completion

Completion requires a Sol review after each phase, all repository and
Terraform gates, a guard-approved exact saved binary, Sol plan approval, exact
binary apply, a ready Azure revision, real deployed OpenRouter inference,
cleanup/telemetry/security smoke, and a guarded all-no-op plan. Native Azure
working-set headroom under the 1.5 GiB bound must be measured after rollout.
