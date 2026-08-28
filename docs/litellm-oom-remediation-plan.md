# Retired generation workload OOM remediation (historical/superseded)

Status: historical and superseded. The retired generation-workload OOM
remediation and telemetry-enrichment material in this document is completed
evidence only; none of it is an active rollout. This document does not
authorize creating, guarding, preflighting, applying, or finalizing any plan.
The cutover referenced here is complete, and its plan is retained as a historical record at `.archive/azure-foundry-entra-cutover-plan.md`.

## Evidence and decision

The exact retired generation image succeeds without a memory limit and exits
with code 137 and `OOMKilled=true` under the deployed 512 MiB limit. The live
Azure sidecar had the same 0.25 CPU/0.5 GiB allocation and was in
`CrashLoopBackOff`; Key Vault synchronization, image pull, environment shape,
and relay startup succeeded.

The reviewed remediation keeps every image, probe, secret reference, model,
and relay setting unchanged. A 1 GiB bounded proof became ready and completed
real inference but peaked at 99.99% under amd64 emulation, which provides no
defensible headroom. The final decision therefore hard-coded the retired
generation container at 0.75 CPU and 1.5 GiB while retaining relay at 0.25 CPU
and 0.5 GiB. The resulting 1 CPU/2 GiB aggregate was the smallest defensible
allowed Azure Container Apps Consumption allocation. Although Azure permits an
intermediate 0.75 CPU/1.5 GiB aggregate, it would leave the retired generation
container at the empirically headroom-free 1 GiB bound.

## Completed Phase A: workload contract

The bounded worker was limited to:

- `infra/modules/container-app-workload/main.tf`
- `infra/modules/container-app-workload/tests/runtime-contract.tftest.hcl`
- `infra/modules/container-app-workload/README.md`

Completed requirements:

1. Change only the enabled generation container resources to `cpu = 0.75` and
   `memory = "1.5Gi"`.
2. Keep relay resources exactly 0.25 CPU/0.5 GiB.
3. Add an exact ordered two-container resource assertion to the existing
   enabled generation-contract test.
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

## Phase B history: telemetry-enrichment rollout (historical/completed)

After Phase A, the first parser-fix relay-image-only transition used the saved
binary SHA-256
`f49c0e0c3f15fccebce1a107ce94f01326fb67f52ec2758756b589187d1be2b4`.
That parser-fix hash remains historical. The immediate telemetry-predecessor
binary `/tmp/palancar-ws-null-callback.tfplan`, with SHA-256
`423974333137f7a06d08aa74d30960b35272deae46cae658616d6763770a2986`, is also
historical and non-applicable. The superseded telemetry-enrichment binary
`/tmp/palancar-telemetry-enrichment.tfplan`, with historical SHA-256
`ad7e5c2090cce0c82d74d40ba242c30f933073c1bdf24a997e06f4d1bbb4dcf7`, is also
historical and non-applicable. Do not guard, apply, or otherwise use that saved
binary or hash for a rollout; do not verify it as an approved saved binary.
The paths and hashes are retained solely as historical evidence. Never commit
the binaries. The historical expected shape was 39 resources: one Container
App update and 38 no-ops, with no delete, replacement, import, or extra
resource. The retired generation container remained exactly 0.75 CPU/1.5 GiB
and relay remained exactly 0.25 CPU/0.5 GiB.

## Superseded rollout material

The former relay-image and telemetry rollout notes are retained only as a
historical record. They are superseded and contain no current guard, preflight,
apply, or finalize procedure. Do not use this document to choose a guard mode or
route a rollout.

The completed record is limited to the OOM sizing decision above, the historical
telemetry-enrichment evidence, and the old saved-plan hashes and paths recorded
there. Those artifacts are non-applicable and must not be verified or applied.

For the current Azure rollout, the authoritative sequence is:

- `model-bootstrap` guarded by `luna-model-bootstrap`;
- `runtime-cutover` guarded by `azure-generation-cutover`;
- `credential-cleanup` guarded by `azure-credential-cleanup`; and
- terminal verification guarded by `final-rollout-complete`, which is never
  applied.

Native Azure working-set headroom under the 1.5 GiB bound remains completed OOM
evidence only.
