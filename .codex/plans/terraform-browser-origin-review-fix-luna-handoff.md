# Terraform browser origin Sol review fixes — Luna handoff

## Objective

Fix all Must-Fix/Should-Fix findings from the independent Terraform security review.

## Files you may change

- `infra/modules/container-app-workload/variables.tf`
- `infra/modules/container-app-workload/tests/runtime-contract.tftest.hcl`
- `infra/environments/dev/variables.tf`
- `infra/scripts/assert-dev-plan.mjs`
- `infra/scripts/assert-dev-plan.test.mjs`

## Files you must not change

- Every other file; do not apply, edit live tfvars/state/locks, or commit.

## Must-Fix

1. Prevent every Terraform-valid origin from being canonicalized differently by WHATWG URL/relay parsing. At minimum reject IPv4-like/numeric hosts (including `https://127.0.0.01`) in both duplicated variable validators; this product expects lower-case DNS hosts, so rejecting all numeric IPv4 hosts is acceptable and safer than incomplete IP canonicalization. Add regression test. Preserve valid lower-case DNS and non-default ports.
2. Every plan-guard mode that permits a Container App mutation must enforce the exact fail-closed browser policy. In particular `full-deploy` Container App update/no-op handling must inspect the nested relay env and require `hasExactFailClosedBrowserOriginPolicy`; update realistic full-deploy/no-op fixtures to carry canonical environment data and add mutation tests proving missing/changed allowlist or true/null flag is rejected. Do not weaken any existing inventory/model/scale check.

## Should-Fix

- Set `nullable = false` for both browser-origin list and bool variables in both module and dev environment so explicit null cannot serialize to JSON null or break validation. Add native expected-failure tests for explicit null where Terraform supports it.
- Add native positive boundary runs/assertions for empty list, exactly 32 unique canonical DNS origins, canonical non-default port, and `allow_null_browser_origin=true` serializing exactly `true`. These demonstrate the reusable module supports future reviewed values even though current guard promotion stays exact synthetic/false.

## Verification

Run:

```bash
/home/dev/.local/bin/terraform-1.15.8 fmt -check -recursive infra
/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/container-app-workload init -backend=false -input=false -no-color
/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/container-app-workload test -no-color
node --test infra/scripts/assert-dev-plan.test.mjs
```

Remove only a newly generated module `.terraform.lock.hcl` via approved patch editing; no live actions.

## Completion report

List fixes and command results. End `DONE` only if every finding is fixed.
