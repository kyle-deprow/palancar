# Relay workload retry Luna handoff

## Objective

Add the Sol-reviewed, resource-specific AzAPI retry to the relay Container App Terraform resource so Azure transient `IdentityDoesNotExist` errors are retried during create/update.

## Files you may change

- `/home/dev/repos/palancar_ws/palancar/infra/modules/container-app-workload/main.tf`

## Files you must not change

- Any file outside `/home/dev/repos/palancar_ws/palancar/infra/modules/container-app-workload/main.tf`
- Terraform environment wiring, variables, outputs, relay source, docs, generated plan files, state files, or Azure resources

## Required change

Inside `resource "azapi_resource" "this"` in `infra/modules/container-app-workload/main.tf`, add exactly this retry block at resource top level:

```hcl
  retry = {
    error_message_regex  = ["IdentityDoesNotExist"]
    interval_seconds     = 10
    max_interval_seconds = 30
  }
```

Do not alter:

- `Microsoft.App/containerApps@2026-01-01`
- provider-level `identity`
- `properties.configuration.registries`
- `properties.configuration.identitySettings`
- image, env vars, probes, scale, response exports, or lifecycle precondition
- any no-secret behavior

## Verification

Run:

```bash
/tmp/palancar-terraform-1.15.8/terraform fmt -check infra/modules/container-app-workload/main.tf
cd infra/environments/dev && /tmp/palancar-terraform-1.15.8/terraform validate
```

## Completion report

Return:

- changed files
- exact verification output
- unresolved issues, if any
- final line `DONE` only if complete
