# Luna implementation handoff: relay Container App Terraform workload

## Objective

Add the Terraform workload slice that deploys the already-pushed immutable relay image to Azure Container Apps using whole-resource AzAPI ownership for `Microsoft.App/containerApps@2026-01-01`.

This slice must not change the foundation resources, model deployments, bootstrap, relay application code, Docker packaging, or docs. Do not run `terraform apply`; the parent will apply after Sol review.

The pushed image digest to use in parent apply is:

```text
palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:f4bd511c17b1e5cdbe0e37a82b33d1f69040654352dfb9a8f544193276c14cd9
```

## Files you may change

- `infra/modules/container-app-workload/README.md`
- `infra/modules/container-app-workload/versions.tf`
- `infra/modules/container-app-workload/variables.tf`
- `infra/modules/container-app-workload/main.tf`
- `infra/modules/container-app-workload/outputs.tf`
- `infra/environments/dev/locals.tf`
- `infra/environments/dev/main.tf`
- `infra/environments/dev/variables.tf`
- `infra/environments/dev/outputs.tf`

## Files and actions you must not change

- Do not edit `terraform.tfvars`, backend files, bootstrap, other modules, app/package code, Docker files, docs, root manifests, or lockfiles.
- Do not run `terraform apply`, `az` mutating commands, Docker, or ACR commands.
- Do not commit.

## Design requirements

### Module resource ownership

Implement `infra/modules/container-app-workload` as a real module replacing the placeholder README.

- Use AzAPI only for the Container App resource.
- Pin resource type exactly: `Microsoft.App/containerApps@2026-01-01`.
- Do not create secrets.
- Do not use AzureRM for any part of the Container App.
- Providers never overlap ownership.

### Container App shape

Inputs must include:

- `name`
- `resource_group_id`
- `resource_group_name`
- `location`
- `tags`
- `container_app_environment_id`
- `image_digest`
- `acr_login_server`
- `image_pull_identity_id`
- `runtime_identity_id`
- `runtime_identity_client_id`
- `workload_table_endpoint`
- `security_state_table_name`
- `rate_state_table_name`
- `foundry_endpoint`
- `foundry_deployment_names`
- `environment`
- `relay_origin`
- `gate_policy_version`, default `1.0.0`
- `target_port`, default `8787`
- `min_replicas`, default `1`
- `max_replicas`, default `1`
- `cpu`, default `0.25`
- `memory`, default `0.5Gi`

Validate:

- `image_digest` is an immutable ACR digest: `^[a-z0-9.-]+\\.azurecr\\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$`.
- `relay_origin` is a canonical Azure-provided `wss://` origin with no path/query/fragment.
- `min_replicas == 1` and `max_replicas == 1` for this development slice.
- `target_port == 8787`.
- `gate_policy_version` is a semver-ish version accepted by current app contract.
- identity IDs and environment IDs are nonempty ARM IDs.
- `resource_group_id` is a nonempty ARM ID for a resource group.
- no variable accepts credentials or registry passwords.

### AzAPI body

The Container App must configure:

- Use the `azapi_resource` provider-level identity block, not an `identity` object inside `body`:
  - `identity { type = "UserAssigned"; identity_ids = [var.image_pull_identity_id, var.runtime_identity_id] }`
- `properties.managedEnvironmentId = var.container_app_environment_id`.
- `properties.configuration.activeRevisionsMode = "Single"`.
- `properties.configuration.ingress`:
  - `external = true`
  - `targetPort = var.target_port`
  - `transport = "http"`
  - `allowInsecure = false`
  - all traffic to latest revision.
- `properties.configuration.registries` with ACR server and image-pull managed identity; no username/password.
- `properties.configuration.identitySettings`:
  - image-pull identity lifecycle `"None"`;
  - runtime identity lifecycle `"Main"`.
- `properties.template.containers[0]`:
  - `name = "relay"`;
  - `image = var.image_digest`;
  - `resources.cpu = var.cpu`;
  - `resources.memory = var.memory`;
  - env vars:
    - `NODE_ENV=production`
    - `PORT=<target_port>`
    - `PALANCAR_RELAY_BIND_HOST=0.0.0.0`
    - `PALANCAR_RELAY_ENVIRONMENT=<environment>`
    - `PALANCAR_RELAY_ORIGIN=<relay_origin>`, where `relay_origin` is a required module input and must be a canonical `wss://` origin.
    - `PALANCAR_GATE_POLICY_VERSION=<gate_policy_version>`
    - `AZURE_CLIENT_ID=<runtime_identity_client_id>`
    - `PALANCAR_WORKLOAD_TABLE_ENDPOINT=<workload_table_endpoint>`
    - `PALANCAR_SECURITY_STATE_TABLE=<security_state_table_name>`
    - `PALANCAR_RATE_STATE_TABLE=<rate_state_table_name>`
    - `PALANCAR_FOUNDRY_ENDPOINT=<foundry_endpoint>`
    - `PALANCAR_FOUNDRY_DEPLOYMENTS=<comma-joined foundry_deployment_names>`
- Do not set `APPLICATIONINSIGHTS_CONNECTION_STRING` in this slice. The app does not consume it yet, and the existing output is sensitive application configuration. A later telemetry integration must use a reviewed secret or managed configuration path.
- Add HTTP probes in `properties.template.containers[0].probes`; validation failure is blocking:
  - liveness probe:
    - `type = "Liveness"`
    - `httpGet.path = "/healthz"`
    - `httpGet.port = 8787`
    - `initialDelaySeconds = 10`
    - `periodSeconds = 10`
    - `timeoutSeconds = 3`
    - `failureThreshold = 3`
  - readiness probe:
    - `type = "Readiness"`
    - `httpGet.path = "/readyz"`
    - `httpGet.port = 8787`
    - `initialDelaySeconds = 5`
    - `periodSeconds = 5`
    - `timeoutSeconds = 3`
    - `failureThreshold = 3`
- `properties.template.scale.minReplicas = var.min_replicas`.
- `properties.template.scale.maxReplicas = var.max_replicas`.

Set `response_export_values` so outputs can expose:

- `properties.configuration.ingress.fqdn`
- `properties.latestRevisionName`
- `properties.runningStatus` if available

### Dev environment wiring

In `infra/environments/dev`:

- Add `local.names.relay_container_app = "ca-${var.prefix}-${var.environment}-relay-${local.suffix}"`.
- Add `local.relay_origin = "wss://${local.names.relay_container_app}.${module.container_app_environment.default_domain}"`.
- Add variable `relay_image_digest` with default `""`; validate empty or immutable ACR digest.
- Add variable `deploy_relay_workload` default `false`.
- Create module `container_app_workload` with `count = var.deploy_relay_workload ? 1 : 0`.
- Validate that when `deploy_relay_workload` is true, `relay_image_digest` is not empty with a blocking `lifecycle.precondition` on the AzAPI Container App resource; do not use a `check` block because failed checks are warnings, and do not refer to unsupported module preconditions.
- Pass all required outputs from existing modules.
- Add `depends_on = [module.identities_rbac]`.
- Do not force Foundry model deployments to be created or recreated. Pass `sort(keys(var.foundry_deployments))` as `foundry_deployment_names`; do not reference `module.foundry.deployment_names` from the workload module call. The targeted plan must contain no `azurerm_cognitive_deployment` actions.

Outputs:

- `relay_container_app_name`
- `relay_container_app_id`
- `relay_origin`
- `relay_latest_revision_name`
- If not deployed, outputs should be `null` except `relay_origin`, which can still expose the deterministic planned origin.

## Verification

Run and report actual outputs:

- `/tmp/palancar-terraform-1.15.8/terraform fmt -recursive infra/modules/container-app-workload infra/environments/dev`
- `cd infra/environments/dev && /tmp/palancar-terraform-1.15.8/terraform validate`
- `cd infra/environments/dev && /tmp/palancar-terraform-1.15.8/terraform plan -target=module.container_app_workload -var='deploy_relay_workload=true' -var='relay_image_digest=palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:f4bd511c17b1e5cdbe0e37a82b33d1f69040654352dfb9a8f544193276c14cd9' -out=/tmp/palancar-relay-workload.tfplan`
- Inspect the targeted plan output and verify it contains no `azurerm_cognitive_deployment` actions.
- `git diff --check -- infra/modules/container-app-workload infra/environments/dev`

Do not apply. If `plan -target` reports any `azurerm_cognitive_deployment` action, the task is not complete; fix the dependency path so the workload plan contains no model deployment actions.

## Completion report

List changed files, verification outputs, plan summary, and unresolved risks. End with `DONE` only if complete.
