mock_provider "azapi" {}

variables {
  name                         = "caj-palancardev-cleanup-a1b2c3d4"
  resource_group_id            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev"
  location                     = "eastus2"
  tags                         = { test = "runtime-contract" }
  container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae-palancar-dev"
  image_digest                 = "palancardev.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  acr_login_server             = "palancardev.azurecr.io"
  image_pull_identity_id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull"
  runtime_identity_id          = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime"
  runtime_identity_client_id   = "00000000-0000-0000-0000-000000000001"
  workload_table_endpoint      = "https://palancardev.table.core.windows.net"
  security_state_table_name    = "SecurityState"
  rate_state_table_name        = "RateState"
  environment                  = "dev"
  relay_origin                 = "wss://ca-palancar-dev-relay.example.azurecontainerapps.io"
}

run "accept_minimum_job_name" {
  command = plan

  variables {
    name = "a1"
  }

  assert {
    condition     = azapi_resource.this.name == "a1"
    error_message = "a two-character lower-case Container Apps Job name must be accepted"
  }
}

run "accept_current_root_job_name_at_maximum_boundary" {
  command = plan

  variables {
    name = "caj-palancardev-cleanup-a1b2c3d4"
  }

  assert {
    condition     = azapi_resource.this.name == "caj-palancardev-cleanup-a1b2c3d4" && length(azapi_resource.this.name) == 32
    error_message = "the current root Job name structure must be accepted at the thirty-two-character boundary"
  }
}

run "reject_one_character_job_name" {
  command = plan

  variables {
    name = "a"
  }

  expect_failures = [var.name]
}

run "reject_overlong_job_name" {
  command = plan

  variables {
    name = join("", [for index in range(33) : "a"])
  }

  expect_failures = [var.name]
}

run "reject_uppercase_job_name" {
  command = plan

  variables {
    name = "caj-Palancar-cleanup"
  }

  expect_failures = [var.name]
}

run "reject_leading_hyphen_job_name" {
  command = plan

  variables {
    name = "-caj-cleanup"
  }

  expect_failures = [var.name]
}

run "reject_trailing_hyphen_job_name" {
  command = plan

  variables {
    name = "caj-cleanup-"
  }

  expect_failures = [var.name]
}

run "reject_double_hyphen_job_name" {
  command = plan

  variables {
    name = "caj--cleanup"
  }

  expect_failures = [var.name]
}

run "exact_job_contract" {
  command = plan

  assert {
    condition     = azapi_resource.this.type == "Microsoft.App/jobs@2026-01-01"
    error_message = "the module must use exactly Microsoft.App/jobs@2026-01-01"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body) == jsonencode({
      properties = {
        environmentId = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae-palancar-dev"
        configuration = {
          triggerType = "Schedule"
          scheduleTriggerConfig = {
            cronExpression         = "0 3 * * *"
            replicaCompletionCount = 1
            parallelism            = 1
          }
          replicaRetryLimit = 0
          replicaTimeout    = 300
          registries = [
            {
              server   = "palancardev.azurecr.io"
              identity = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull"
            },
          ]
          identitySettings = [
            {
              identity  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull"
              lifecycle = "None"
            },
            {
              identity  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime"
              lifecycle = "Main"
            },
          ]
        }
        template = {
          containers = [
            {
              name  = "expiry-cleanup"
              image = "palancardev.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
              resources = {
                cpu    = 0.25
                memory = "0.5Gi"
              }
              env = [
                {
                  name  = "AZURE_CLIENT_ID"
                  value = "00000000-0000-0000-0000-000000000001"
                },
                {
                  name  = "PALANCAR_WORKLOAD_TABLE_ENDPOINT"
                  value = "https://palancardev.table.core.windows.net"
                },
                {
                  name  = "PALANCAR_SECURITY_STATE_TABLE"
                  value = "SecurityState"
                },
                {
                  name  = "PALANCAR_RATE_STATE_TABLE"
                  value = "RateState"
                },
                {
                  name  = "PALANCAR_RELAY_ENVIRONMENT"
                  value = "dev"
                },
                {
                  name  = "PALANCAR_RELAY_ORIGIN"
                  value = "wss://ca-palancar-dev-relay.example.azurecontainerapps.io"
                },
                {
                  name  = "PALANCAR_EXPIRY_CLEANUP_LIMIT"
                  value = "1000"
                },
                {
                  name  = "PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS"
                  value = "240000"
                },
              ]
            },
          ]
        }
      }
    })
    error_message = "the complete Job body must exactly match the independently literal reviewed payload"
  }

  assert {
    condition = (
      azapi_resource.this.identity[0].type == "UserAssigned" &&
      jsonencode(azapi_resource.this.identity[0].identity_ids) == jsonencode([
        "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull",
        "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime",
      ])
    )
    error_message = "the Job must attach exactly the distinct image-pull and runtime user-assigned identities"
  }

  assert {
    condition = toset(keys(azapi_resource.this.body.properties)) == toset([
      "configuration",
      "environmentId",
      "template",
    ])
    error_message = "the Job properties must contain only environmentId, configuration, and template"
  }

  assert {
    condition     = azapi_resource.this.body.properties.environmentId == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae-palancar-dev"
    error_message = "environmentId must target the supplied Container Apps environment"
  }

  assert {
    condition = toset(keys(azapi_resource.this.body.properties.configuration)) == toset([
      "identitySettings",
      "registries",
      "replicaRetryLimit",
      "replicaTimeout",
      "scheduleTriggerConfig",
      "triggerType",
    ])
    error_message = "configuration must contain only the schedule, retry, timeout, registry, and identity settings"
  }

  assert {
    condition     = azapi_resource.this.body.properties.configuration.triggerType == "Schedule"
    error_message = "the Job must be schedule-triggered"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.configuration.scheduleTriggerConfig) == jsonencode({
      cronExpression         = "0 3 * * *"
      replicaCompletionCount = 1
      parallelism            = 1
    })
    error_message = "the schedule must run daily at 03:00 UTC with one completion and one parallel replica"
  }

  assert {
    condition     = azapi_resource.this.body.properties.configuration.replicaRetryLimit == 0
    error_message = "the Job must not retry failed replicas"
  }

  assert {
    condition     = azapi_resource.this.body.properties.configuration.replicaTimeout == 300
    error_message = "the Azure replica timeout must be exactly 300 seconds"
  }

  assert {
    condition     = length(azapi_resource.this.body.properties.template.containers) == 1
    error_message = "the Job must have exactly one container"
  }

  assert {
    condition     = toset(keys(azapi_resource.this.body.properties.template)) == toset(["containers"])
    error_message = "the Job template must contain only containers"
  }

  assert {
    condition = toset(keys(azapi_resource.this.body.properties.template.containers[0])) == toset([
      "env",
      "image",
      "name",
      "resources",
    ])
    error_message = "the cleanup container must not emit commands, probes, volumes, or other optional fields"
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].name == "expiry-cleanup"
    error_message = "the container name must be expiry-cleanup"
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].image == "palancardev.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    error_message = "the cleanup container must use the supplied immutable digest"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.template.containers[0].resources) == jsonencode({
      cpu    = 0.25
      memory = "0.5Gi"
    })
    error_message = "the cleanup container must use 0.25 CPU and 0.5Gi memory"
  }

  assert {
    condition = azapi_resource.this.body.properties.template.containers[0].env == [
      { name = "AZURE_CLIENT_ID", value = "00000000-0000-0000-0000-000000000001" },
      { name = "PALANCAR_WORKLOAD_TABLE_ENDPOINT", value = "https://palancardev.table.core.windows.net" },
      { name = "PALANCAR_SECURITY_STATE_TABLE", value = "SecurityState" },
      { name = "PALANCAR_RATE_STATE_TABLE", value = "RateState" },
      { name = "PALANCAR_RELAY_ENVIRONMENT", value = "dev" },
      { name = "PALANCAR_RELAY_ORIGIN", value = "wss://ca-palancar-dev-relay.example.azurecontainerapps.io" },
      { name = "PALANCAR_EXPIRY_CLEANUP_LIMIT", value = "1000" },
      { name = "PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS", value = "240000" },
    ]
    error_message = "the container must emit exactly the eight reviewed cleanup environment variables"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.configuration.registries) == jsonencode([
      {
        server   = "palancardev.azurecr.io"
        identity = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull"
      },
    ])
    error_message = "the registry must use only the image-pull identity"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.configuration.identitySettings) == jsonencode([
      {
        identity  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull"
        lifecycle = "None"
      },
      {
        identity  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime"
        lifecycle = "Main"
      },
    ])
    error_message = "identitySettings must assign image-pull None and runtime Main"
  }

  assert {
    condition     = length(azapi_resource.this.body.properties.configuration.registries) == 1
    error_message = "the Job must have exactly one registry configuration"
  }

  assert {
    condition     = try(azapi_resource.this.body.properties.configuration.secrets, null) == null
    error_message = "the Job must emit no secrets"
  }

  assert {
    condition     = try(azapi_resource.this.body.properties.configuration.ingress, null) == null
    error_message = "the Job must emit no ingress"
  }

  assert {
    condition     = try(azapi_resource.this.body.properties.template.volumes, null) == null
    error_message = "the Job must emit no volumes"
  }

  assert {
    condition = alltrue([
      for environment_variable in azapi_resource.this.body.properties.template.containers[0].env :
      toset(keys(environment_variable)) == toset(["name", "value"])
    ])
    error_message = "every cleanup environment entry must contain only name and value with no secret reference"
  }
}

run "accept_non_default_cleanup_limit" {
  command = plan

  variables {
    cleanup_limit = 10000
  }

  assert {
    condition = azapi_resource.this.body.properties.template.containers[0].env[6] == {
      name  = "PALANCAR_EXPIRY_CLEANUP_LIMIT"
      value = "10000"
    }
    error_message = "cleanup_limit must be rendered as the configured decimal value"
  }
}

run "reject_malformed_image_digest" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar-expiry-cleanup:latest"
  }

  expect_failures = [var.image_digest]
}

run "reject_same_identities" {
  command = plan

  variables {
    runtime_identity_id = var.image_pull_identity_id
  }

  expect_failures = [azapi_resource.this]
}

run "reject_uppercase_client_id" {
  command = plan

  variables {
    runtime_identity_client_id = "00000000-0000-0000-0000-00000000000A"
  }

  expect_failures = [var.runtime_identity_client_id]
}

run "reject_trailing_slash_table_endpoint" {
  command = plan

  variables {
    workload_table_endpoint = "https://palancardev.table.core.windows.net/"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "accept_tool_canonical_table_endpoint_without_trailing_slash" {
  command = plan

  variables {
    workload_table_endpoint = "https://palancardev.table.core.windows.net"
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].env[1] == { name = "PALANCAR_WORKLOAD_TABLE_ENDPOINT", value = "https://palancardev.table.core.windows.net" }
    error_message = "the cleanup Job must emit the tool's canonical slash-free Table account origin unchanged"
  }
}

run "reject_wrong_table_name" {
  command = plan

  variables {
    security_state_table_name = "SecurityState2"
  }

  expect_failures = [var.security_state_table_name]
}

run "reject_uppercase_environment" {
  command = plan

  variables {
    environment = "Dev"
  }

  expect_failures = [var.environment]
}

run "reject_non_container_apps_origin" {
  command = plan

  variables {
    relay_origin = "wss://relay.example.com"
  }

  expect_failures = [var.relay_origin]
}

run "reject_cleanup_limit_out_of_range" {
  command = plan

  variables {
    cleanup_limit = 10001
  }

  expect_failures = [var.cleanup_limit]
}

run "reject_non_reviewed_cleanup_timeout" {
  command = plan

  variables {
    cleanup_timeout_ms = 300000
  }

  expect_failures = [var.cleanup_timeout_ms]
}

run "accept_cleanup_limit_lower_boundary" {
  command = plan

  variables {
    cleanup_limit = 1
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].env[6].value == "1"
    error_message = "cleanup_limit must accept the lower boundary of one"
  }
}

run "reject_cleanup_limit_below_lower_boundary" {
  command = plan

  variables {
    cleanup_limit = 0
  }

  expect_failures = [var.cleanup_limit]
}

run "reject_fractional_cleanup_limit" {
  command = plan

  variables {
    cleanup_limit = 1.5
  }

  expect_failures = [var.cleanup_limit]
}

run "accept_minimum_acr_boundary" {
  command = plan

  variables {
    acr_login_server = "abcde.azurecr.io"
    image_digest     = "abcde.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  assert {
    condition     = azapi_resource.this.body.properties.configuration.registries[0].server == "abcde.azurecr.io"
    error_message = "a five-character ACR name must be accepted"
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].image == "abcde.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    error_message = "the exact cleanup repository must be accepted at the minimum ACR-name boundary"
  }
}

run "accept_maximum_acr_boundary" {
  command = plan

  variables {
    acr_login_server = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.azurecr.io"
    image_digest     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  assert {
    condition     = azapi_resource.this.body.properties.configuration.registries[0].server == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.azurecr.io"
    error_message = "a fifty-character ACR name with the exact cleanup repository must be accepted"
  }
}

run "reject_one_character_acr_name" {
  command = plan

  variables {
    acr_login_server = "a.azurecr.io"
  }

  expect_failures = [var.acr_login_server]
}

run "reject_dotted_acr_name" {
  command = plan

  variables {
    acr_login_server = "palan.car.azurecr.io"
  }

  expect_failures = [var.acr_login_server]
}

run "reject_hyphenated_acr_name" {
  command = plan

  variables {
    acr_login_server = "palan-car.azurecr.io"
  }

  expect_failures = [var.acr_login_server]
}

run "reject_acr_name_above_maximum" {
  command = plan

  variables {
    acr_login_server = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.azurecr.io"
  }

  expect_failures = [var.acr_login_server]
}

run "reject_uppercase_acr_name" {
  command = plan

  variables {
    acr_login_server = "Palancar.azurecr.io"
  }

  expect_failures = [var.acr_login_server]
}

run "reject_image_with_one_character_acr_name" {
  command = plan

  variables {
    image_digest = "a.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_image_with_dotted_acr_name" {
  command = plan

  variables {
    image_digest = "palan.car.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_image_with_hyphenated_acr_name" {
  command = plan

  variables {
    image_digest = "palan-car.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_image_with_uppercase_acr_name" {
  command = plan

  variables {
    image_digest = "Palancar.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_image_from_different_valid_acr" {
  command = plan

  variables {
    image_digest = "otherregistry.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [azapi_resource.this]
}

run "reject_wrong_cleanup_repository" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_parent_repository_component" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/../expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_empty_repository" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_empty_repository_component" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar//expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_current_repository_component" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/./expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_nested_parent_repository_component" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/../expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_percent_encoded_repository" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar%2fexpiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_repository_query" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/expiry-cleanup?tag=x@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_repository_fragment" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/expiry-cleanup#tag@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_repository_whitespace" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/expiry cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_repository_control_character" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/expiry\ncleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_uppercase_repository" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/Expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_uppercase_digest_hex" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/expiry-cleanup@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  }

  expect_failures = [var.image_digest]
}

run "reject_resource_group_id_query" {
  command = plan

  variables {
    resource_group_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev?api-version=1"
  }

  expect_failures = [var.resource_group_id]
}

run "reject_resource_group_id_uppercase_subscription" {
  command = plan

  variables {
    resource_group_id = "/subscriptions/00000000-0000-0000-0000-00000000000A/resourceGroups/rg-palancar-dev"
  }

  expect_failures = [var.resource_group_id]
}

run "reject_resource_group_id_whitespace" {
  command = plan

  variables {
    resource_group_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg palancar-dev"
  }

  expect_failures = [var.resource_group_id]
}

run "reject_resource_group_id_control_character" {
  command = plan

  variables {
    resource_group_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar\ndev"
  }

  expect_failures = [var.resource_group_id]
}

run "reject_resource_group_id_percent_encoding" {
  command = plan

  variables {
    resource_group_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar%2fdev"
  }

  expect_failures = [var.resource_group_id]
}

run "reject_resource_group_id_fragment" {
  command = plan

  variables {
    resource_group_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev#fragment"
  }

  expect_failures = [var.resource_group_id]
}

run "reject_resource_group_id_missing_name" {
  command = plan

  variables {
    resource_group_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/"
  }

  expect_failures = [var.resource_group_id]
}

run "reject_resource_group_id_extra_path" {
  command = plan

  variables {
    resource_group_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App"
  }

  expect_failures = [var.resource_group_id]
}

run "reject_environment_id_query" {
  command = plan

  variables {
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae-palancar-dev?api-version=1"
  }

  expect_failures = [var.container_app_environment_id]
}

run "reject_environment_id_wrong_provider_case" {
  command = plan

  variables {
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/microsoft.app/managedEnvironments/cae-palancar-dev"
  }

  expect_failures = [var.container_app_environment_id]
}

run "reject_environment_id_percent_encoding" {
  command = plan

  variables {
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae-palancar%2fdev"
  }

  expect_failures = [var.container_app_environment_id]
}

run "reject_environment_id_whitespace" {
  command = plan

  variables {
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae palancar-dev"
  }

  expect_failures = [var.container_app_environment_id]
}

run "reject_environment_id_missing_name" {
  command = plan

  variables {
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/"
  }

  expect_failures = [var.container_app_environment_id]
}

run "reject_environment_id_extra_path" {
  command = plan

  variables {
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae-palancar-dev/jobs/injected"
  }

  expect_failures = [var.container_app_environment_id]
}

run "reject_image_pull_identity_id_query" {
  command = plan

  variables {
    image_pull_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull?api-version=1"
  }

  expect_failures = [var.image_pull_identity_id]
}

run "reject_image_pull_identity_wrong_provider_case" {
  command = plan

  variables {
    image_pull_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/microsoft.managedidentity/userAssignedIdentities/id-palancar-dev-image-pull"
  }

  expect_failures = [var.image_pull_identity_id]
}

run "reject_image_pull_identity_percent_encoding" {
  command = plan

  variables {
    image_pull_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar%2fdev-image-pull"
  }

  expect_failures = [var.image_pull_identity_id]
}

run "reject_image_pull_identity_missing_name" {
  command = plan

  variables {
    image_pull_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/"
  }

  expect_failures = [var.image_pull_identity_id]
}

run "reject_image_pull_identity_extra_path" {
  command = plan

  variables {
    image_pull_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull/roleAssignments/injected"
  }

  expect_failures = [var.image_pull_identity_id]
}

run "reject_runtime_identity_id_query" {
  command = plan

  variables {
    runtime_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime?api-version=1"
  }

  expect_failures = [var.runtime_identity_id]
}

run "reject_runtime_identity_id_fragment" {
  command = plan

  variables {
    runtime_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime#fragment"
  }

  expect_failures = [var.runtime_identity_id]
}

run "reject_runtime_identity_id_whitespace" {
  command = plan

  variables {
    runtime_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar dev-runtime"
  }

  expect_failures = [var.runtime_identity_id]
}

run "reject_runtime_identity_id_control_character" {
  command = plan

  variables {
    runtime_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar\ndev-runtime"
  }

  expect_failures = [var.runtime_identity_id]
}

run "reject_runtime_identity_id_missing_name" {
  command = plan

  variables {
    runtime_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/"
  }

  expect_failures = [var.runtime_identity_id]
}

run "reject_runtime_identity_id_extra_path" {
  command = plan

  variables {
    runtime_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime/providers/injected"
  }

  expect_failures = [var.runtime_identity_id]
}

run "accept_minimum_relay_origin" {
  command = plan

  variables {
    relay_origin = "wss://a.azurecontainerapps.io"
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].env[5].value == "wss://a.azurecontainerapps.io"
    error_message = "a canonical one-character relay host label must be accepted"
  }
}

run "accept_255_character_relay_origin" {
  command = plan

  variables {
    relay_origin = "wss://${join("", [for _ in range(63) : "a"])}.${join("", [for _ in range(63) : "b"])}.${join("", [for _ in range(63) : "c"])}.${join("", [for _ in range(35) : "d"])}.azurecontainerapps.io"
  }

  assert {
    condition     = length(azapi_resource.this.body.properties.template.containers[0].env[5].value) == 255
    error_message = "a 255-character relay origin with labels no longer than 63 characters must be accepted"
  }
}

run "reject_64_character_relay_label" {
  command = plan

  variables {
    relay_origin = "wss://${join("", [for _ in range(64) : "a"])}.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "reject_256_character_relay_origin" {
  command = plan

  variables {
    relay_origin = "wss://${join("", [for _ in range(63) : "a"])}.${join("", [for _ in range(63) : "b"])}.${join("", [for _ in range(63) : "c"])}.${join("", [for _ in range(36) : "d"])}.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "reject_uppercase_relay_origin" {
  command = plan

  variables {
    relay_origin = "wss://Relay.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "reject_relay_origin_port" {
  command = plan

  variables {
    relay_origin = "wss://relay.azurecontainerapps.io:443"
  }

  expect_failures = [var.relay_origin]
}

run "reject_relay_origin_path" {
  command = plan

  variables {
    relay_origin = "wss://relay.azurecontainerapps.io/socket"
  }

  expect_failures = [var.relay_origin]
}

run "reject_relay_origin_credentials" {
  command = plan

  variables {
    relay_origin = "wss://user:password@relay.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "reject_relay_origin_query" {
  command = plan

  variables {
    relay_origin = "wss://relay.azurecontainerapps.io?query=x"
  }

  expect_failures = [var.relay_origin]
}

run "reject_relay_origin_fragment" {
  command = plan

  variables {
    relay_origin = "wss://relay.azurecontainerapps.io#fragment"
  }

  expect_failures = [var.relay_origin]
}

run "reject_relay_origin_trailing_slash" {
  command = plan

  variables {
    relay_origin = "wss://relay.azurecontainerapps.io/"
  }

  expect_failures = [var.relay_origin]
}

run "reject_relay_origin_wrong_scheme" {
  command = plan

  variables {
    relay_origin = "https://relay.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "reject_relay_origin_whitespace" {
  command = plan

  variables {
    relay_origin = "wss://relay name.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "reject_relay_origin_control_character" {
  command = plan

  variables {
    relay_origin = "wss://relay\nname.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "accept_minimum_table_account_boundary" {
  command = plan

  variables {
    workload_table_endpoint = "https://abc.table.core.windows.net"
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].env[1].value == "https://abc.table.core.windows.net"
    error_message = "a three-character lower-case Table account must be accepted"
  }
}

run "accept_maximum_table_account_boundary" {
  command = plan

  variables {
    workload_table_endpoint = "https://abcdefghijklmnopqrstuvwx.table.core.windows.net"
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].env[1].value == "https://abcdefghijklmnopqrstuvwx.table.core.windows.net"
    error_message = "a twenty-four-character lower-case Table account must be accepted"
  }
}

run "reject_table_account_below_minimum" {
  command = plan

  variables {
    workload_table_endpoint = "https://ab.table.core.windows.net"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_account_above_maximum" {
  command = plan

  variables {
    workload_table_endpoint = "https://abcdefghijklmnopqrstuvwxy.table.core.windows.net"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_endpoint_http" {
  command = plan

  variables {
    workload_table_endpoint = "http://palancardev.table.core.windows.net"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_endpoint_uppercase" {
  command = plan

  variables {
    workload_table_endpoint = "https://PalancarDev.table.core.windows.net"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_endpoint_port" {
  command = plan

  variables {
    workload_table_endpoint = "https://palancardev.table.core.windows.net:443"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_endpoint_path" {
  command = plan

  variables {
    workload_table_endpoint = "https://palancardev.table.core.windows.net/table/"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_endpoint_query" {
  command = plan

  variables {
    workload_table_endpoint = "https://palancardev.table.core.windows.net?query=x"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_endpoint_fragment" {
  command = plan

  variables {
    workload_table_endpoint = "https://palancardev.table.core.windows.net#fragment"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_endpoint_credentials" {
  command = plan

  variables {
    workload_table_endpoint = "https://user:password@palancardev.table.core.windows.net"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_endpoint_double_slash" {
  command = plan

  variables {
    workload_table_endpoint = "https://palancardev.table.core.windows.net//"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_endpoint_percent_encoding" {
  command = plan

  variables {
    workload_table_endpoint = "https://palancardev.table.core.windows.net/%2f"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_endpoint_whitespace" {
  command = plan

  variables {
    workload_table_endpoint = "https://palancar dev.table.core.windows.net"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_table_endpoint_control_character" {
  command = plan

  variables {
    workload_table_endpoint = "https://palancar\ndev.table.core.windows.net"
  }

  expect_failures = [var.workload_table_endpoint]
}

run "reject_client_id_query" {
  command = plan

  variables {
    runtime_identity_client_id = "00000000-0000-0000-0000-000000000001?query=x"
  }

  expect_failures = [var.runtime_identity_client_id]
}

run "reject_client_id_braces" {
  command = plan

  variables {
    runtime_identity_client_id = "{00000000-0000-0000-0000-000000000001}"
  }

  expect_failures = [var.runtime_identity_client_id]
}

run "reject_client_id_whitespace" {
  command = plan

  variables {
    runtime_identity_client_id = "00000000-0000-0000-0000-000000000001 "
  }

  expect_failures = [var.runtime_identity_client_id]
}

run "reject_client_id_control_character" {
  command = plan

  variables {
    runtime_identity_client_id = "00000000-0000-0000-0000-000000000001\n"
  }

  expect_failures = [var.runtime_identity_client_id]
}

run "reject_client_id_wrong_length" {
  command = plan

  variables {
    runtime_identity_client_id = "00000000-0000-0000-0000-00000000001"
  }

  expect_failures = [var.runtime_identity_client_id]
}
