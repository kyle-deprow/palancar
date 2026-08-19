# Terraform browser-origin policy wiring — Luna handoff

## Objective

Wire the relay browser origin policy into the Container App as explicit, fail-closed Terraform configuration and extend the exact runtime rollout guard.

## Files you may change

- `infra/modules/container-app-workload/variables.tf`
- `infra/modules/container-app-workload/main.tf`
- `infra/modules/container-app-workload/tests/runtime-contract.tftest.hcl`
- `infra/environments/dev/variables.tf`
- `infra/environments/dev/main.tf`
- `infra/environments/dev/terraform.tfvars.example`
- `infra/scripts/assert-dev-plan.mjs`
- `infra/scripts/assert-dev-plan.test.mjs`

## Files you must not change

- Every other file. Do not edit Terraform state/tfvars/backend files, code, docs, lock files, or commit.

## Required Terraform contract

- Add module variable `browser_allowed_origins` as `list(string)` with default exactly `["https://even-webview.synthetic.invalid"]`.
- Validate 0–32 unique canonical HTTPS origins with lowercase DNS host, no credentials, wildcard, whitespace, path/query/fragment, trailing slash, or explicit default port. Use Terraform expressions compatible with pinned Terraform 1.15.8.
- Add module variable `allow_null_browser_origin` as bool default false.
- Emit relay env values in stable order:
  - `PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON = jsonencode(var.browser_allowed_origins)`
  - `PALANCAR_ALLOW_NULL_BROWSER_ORIGIN = tostring(var.allow_null_browser_origin)`
- Add matching dev-environment variables with the same defaults/validation and pass them to the workload module.
- Add uncommented fail-closed values to `terraform.tfvars.example` and explain the synthetic origin must remain until physical Even WebView evidence supplies a reviewed exact origin.
- No wildcard or null-origin deployment default.

## Guard requirements

- Extend exact relay env name topology and semantic validation to require both variables.
- Require the JSON string to parse as exactly one-element array `["https://even-webview.synthetic.invalid"]` for the current promoted dev rollout and require null flag exactly `false`.
- Reject missing, duplicate, extra, malformed, wildcard, changed synthetic origin, true/null flag, or secretRef forms.
- Update canonical fixture plans and add mutation tests for every rejection class.
- Preserve existing exact topology, immutable-image, identity, sidecar, state, provider, and normalization checks.

## Native module tests

- Assert exact emitted values.
- Add invalid-variable test runs for malformed origins, duplicate origins, too many origins, wildcard, trailing slash, explicit `:443`, uppercase host, and path.
- Assert current defaults remain fail closed.

## Verification

Use exact Terraform binary `/home/dev/.local/bin/terraform-1.15.8` and run:

```bash
/home/dev/.local/bin/terraform-1.15.8 fmt -check -recursive infra
/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/container-app-workload init -backend=false -input=false -no-color
/home/dev/.local/bin/terraform-1.15.8 -chdir=infra/modules/container-app-workload test -no-color
node --test infra/scripts/assert-dev-plan.test.mjs
```

Do not leave a new untracked module `.terraform.lock.hcl`; remove only that generated file with the approved patch mechanism if this task created it. Do not touch `.terraform/` or live state.

## Escalation

Stop if an out-of-scope change or live apply is required. Do not weaken validation or guard topology.

## Completion report

List files and actual command results. End with `DONE` only if complete.
