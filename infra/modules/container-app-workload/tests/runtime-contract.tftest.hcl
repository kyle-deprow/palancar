mock_provider "azapi" {}

variables {
  name                                                    = "ca-palancar-dev-relay-test"
  resource_group_id                                       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev"
  location                                                = "eastus2"
  tags                                                    = { test = "runtime-contract" }
  container_app_environment_id                            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae-palancar-dev"
  image_digest                                            = "palancardev.azurecr.io/palancar-relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  acr_login_server                                        = "palancardev.azurecr.io"
  image_pull_identity_id                                  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull"
  runtime_identity_id                                     = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime"
  runtime_identity_client_id                              = "00000000-0000-0000-0000-000000000001"
  runtime_openai_user_role_assignment_id                  = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000003"
  runtime_monitoring_metrics_publisher_role_assignment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000004"
  workload_table_endpoint                                 = "https://palancardev.table.core.windows.net/"
  security_state_table_name                               = "SecurityState"
  rate_state_table_name                                   = "RateState"
  environment                                             = "dev"
  deployment_slot                                         = "dev"
  language_boundary_mode                                  = "development-provisional"
  application_insights_connection_string                  = "LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222;IngestionEndpoint=https://eastus2-1.in.applicationinsights.azure.com/;InstrumentationKey=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
  relay_origin                                            = "wss://ca-palancar-dev-relay-test.example.azurecontainerapps.io"
  azure_generation_endpoint                               = "https://palancardev.openai.azure.com"
  azure_generation_deployment                             = "gpt-5.6-luna"
}

run "azure_generation_runtime_contract" {
  command = plan

  assert {
    condition = (
      azapi_resource.this.body.properties.configuration.activeRevisionsMode == "Single" &&
      azapi_resource.this.body.properties.configuration.maxInactiveRevisions == 1
    )
    error_message = "the workload must use single revisions and retain exactly one inactive predecessor"
  }

  assert {
    condition = (
      azapi_resource.this.body.properties.template.scale.minReplicas == 1 &&
      azapi_resource.this.body.properties.template.scale.maxReplicas == 1
    )
    error_message = "the deployed relay must keep exactly one warm replica with a hard maximum of one"
  }

  assert {
    condition = (
      length(azapi_resource.this.body.properties.template.containers) == 1 &&
      azapi_resource.this.body.properties.template.containers[0].name == "relay" &&
      azapi_resource.this.body.properties.template.containers[0].image == var.image_digest &&
      azapi_resource.this.body.properties.template.containers[0].resources == {
        cpu    = 0.25
        memory = "0.5Gi"
      }
    )
    error_message = "the workload must contain only the immutable 0.25 CPU/0.5 GiB relay container"
  }

  assert {
    condition     = azapi_resource.this.body.properties.configuration.secrets == []
    error_message = "the Entra-only workload must emit an empty secrets collection"
  }

  assert {
    condition = (
      length(azapi_resource.this.body.properties.template.containers[0].env) == length(toset([
        for item in azapi_resource.this.body.properties.template.containers[0].env : item.name
      ])) &&
      alltrue([
        for item in azapi_resource.this.body.properties.template.containers[0].env :
        toset(keys(item)) == toset(["name", "value"]) &&
        contains(keys(item), "value") &&
        !contains(keys(item), "secretRef")
      ])
    )
    error_message = "relay environment names must be unique and every entry must be nonsecret"
  }

  assert {
    condition = (
      toset(keys(azapi_resource.this.body)) == toset(["properties"]) &&
      toset(keys(azapi_resource.this.body.properties)) == toset([
        "managedEnvironmentId",
        "configuration",
        "template",
      ]) &&
      toset(keys(azapi_resource.this.body.properties.configuration)) == toset([
        "activeRevisionsMode",
        "maxInactiveRevisions",
        "ingress",
        "registries",
        "identitySettings",
        "secrets",
      ]) &&
      toset(keys(azapi_resource.this.body.properties.configuration.ingress)) == toset([
        "external",
        "targetPort",
        "transport",
        "allowInsecure",
        "traffic",
      ]) &&
      alltrue([
        for item in azapi_resource.this.body.properties.configuration.ingress.traffic :
        toset(keys(item)) == toset(["latestRevision", "weight"])
      ]) &&
      alltrue([
        for item in azapi_resource.this.body.properties.configuration.registries :
        toset(keys(item)) == toset(["server", "identity"]) &&
        !contains(keys(item), "passwordSecretRef") &&
        !contains(keys(item), "secretRef")
      ]) &&
      length(azapi_resource.this.body.properties.configuration.registries) == 1 &&
      alltrue([
        for item in azapi_resource.this.body.properties.configuration.identitySettings :
        toset(keys(item)) == toset(["identity", "lifecycle"])
      ]) &&
      azapi_resource.this.body.properties.configuration.secrets == [] &&
      toset(keys(azapi_resource.this.body.properties.template)) == toset(["containers", "scale"]) &&
      toset(keys(azapi_resource.this.body.properties.template.scale)) == toset(["minReplicas", "maxReplicas"]) &&
      length(azapi_resource.this.body.properties.template.containers) == 1 &&
      toset(keys(azapi_resource.this.body.properties.template.containers[0])) == toset([
        "name",
        "image",
        "resources",
        "env",
      ]) &&
      !contains(keys(azapi_resource.this.body.properties.template.containers[0]), "probes") &&
      toset(keys(azapi_resource.this.body.properties.template.containers[0].resources)) == toset(["cpu", "memory"])
    )
    error_message = "the Azure generation workload body must use the exact probe-free, secret-free body, container, registry, and resource key sets"
  }

  assert {
    condition = (
      azapi_resource.this.body.properties.managedEnvironmentId == var.container_app_environment_id &&
      jsonencode(azapi_resource.this.body.properties.configuration.ingress) == jsonencode({
        external      = true
        targetPort    = 8787
        transport     = "Http"
        allowInsecure = false
        traffic       = [{ latestRevision = true, weight = 100 }]
      }) &&
      jsonencode(azapi_resource.this.body.properties.configuration.registries) == jsonencode([
        {
          server   = var.acr_login_server
          identity = var.image_pull_identity_id
        },
      ])
    )
    error_message = "the workload must use the canonical environment, ingress, and passwordless ACR registry contract"
  }

  assert {
    condition = toset([
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name
      ]) == toset([
      "NODE_ENV",
      "PORT",
      "PALANCAR_GENERATION_PROVIDER",
      "PALANCAR_AZURE_GENERATION_ENDPOINT",
      "PALANCAR_AZURE_GENERATION_DEPLOYMENT",
      "PALANCAR_RELAY_BIND_HOST",
      "PALANCAR_RELAY_ENVIRONMENT",
      "PALANCAR_RELAY_ORIGIN",
      "PALANCAR_GATE_POLICY_VERSION",
      "AZURE_CLIENT_ID",
      "PALANCAR_DEPLOYMENT_SLOT",
      "APPLICATIONINSIGHTS_CONNECTION_STRING",
      "APPLICATIONINSIGHTS_STATSBEAT_DISABLED",
      "APPLICATION_INSIGHTS_NO_STATSBEAT",
      "PALANCAR_SECURITY_MODE",
      "PALANCAR_WORKLOAD_TABLE_ENDPOINT",
      "PALANCAR_SECURITY_STATE_TABLE",
      "PALANCAR_RATE_STATE_TABLE",
      "PALANCAR_TRANSCRIPTION_PROVIDER",
      "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
      "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
      "PALANCAR_LANGUAGE_BOUNDARY_MODE",
    ])
    error_message = "the relay must emit exactly the Azure generation and retained runtime environment key set"
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
      }) == {
      NODE_ENV                               = "production"
      PORT                                   = "8787"
      PALANCAR_GENERATION_PROVIDER           = "azure-openai"
      PALANCAR_AZURE_GENERATION_ENDPOINT     = "https://palancardev.openai.azure.com"
      PALANCAR_AZURE_GENERATION_DEPLOYMENT   = "gpt-5.6-luna"
      PALANCAR_RELAY_BIND_HOST               = "0.0.0.0"
      PALANCAR_RELAY_ENVIRONMENT             = "dev"
      PALANCAR_RELAY_ORIGIN                  = "wss://ca-palancar-dev-relay-test.example.azurecontainerapps.io"
      PALANCAR_GATE_POLICY_VERSION           = "1.0.0"
      AZURE_CLIENT_ID                        = "00000000-0000-0000-0000-000000000001"
      PALANCAR_DEPLOYMENT_SLOT               = "dev"
      APPLICATIONINSIGHTS_CONNECTION_STRING  = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2-1.in.applicationinsights.azure.com"
      APPLICATIONINSIGHTS_STATSBEAT_DISABLED = "true"
      APPLICATION_INSIGHTS_NO_STATSBEAT      = "true"
      PALANCAR_SECURITY_MODE                 = "azure-table"
      PALANCAR_WORKLOAD_TABLE_ENDPOINT       = "https://palancardev.table.core.windows.net"
      PALANCAR_SECURITY_STATE_TABLE          = "SecurityState"
      PALANCAR_RATE_STATE_TABLE              = "RateState"
      PALANCAR_TRANSCRIPTION_PROVIDER        = "mock"
      PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON  = "[\"https://even-webview.synthetic.invalid\"]"
      PALANCAR_ALLOW_NULL_BROWSER_ORIGIN     = "false"
      PALANCAR_LANGUAGE_BOUNDARY_MODE        = "development-provisional"
    }
    error_message = "the relay must emit the exact canonical Azure generation and retained runtime values"
  }

  assert {
    condition = (
      length(azapi_resource.this.identity[0].identity_ids) == 2 &&
      toset(azapi_resource.this.identity[0].identity_ids) == toset([
        var.image_pull_identity_id,
        var.runtime_identity_id,
      ])
    )
    error_message = "the workload must retain exactly the image-pull and runtime user-assigned identities"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.configuration.identitySettings) == jsonencode([
      {
        identity  = replace(var.image_pull_identity_id, "resourceGroups", "resourcegroups")
        lifecycle = "None"
      },
      {
        identity  = replace(var.runtime_identity_id, "resourceGroups", "resourcegroups")
        lifecycle = "Main"
      },
    ])
    error_message = "identitySettings must retain the image-pull None and runtime Main lifecycles"
  }
}

run "azure_realtime_runtime_contract" {
  command = plan

  variables {
    deployment_slot                = "staging"
    language_boundary_mode         = "deny-all"
    transcription_provider         = "azure-realtime"
    azure_transcription_endpoint   = "wss://palancardev.openai.azure.com/openai/v1/realtime?intent=transcription"
    azure_transcription_deployment = "gpt-4o-mini-transcribe"
  }

  assert {
    condition = (
      length(azapi_resource.this.body.properties.template.containers) == 1 &&
      toset([
        for item in azapi_resource.this.body.properties.template.containers[0].env : item.name
        ]) == toset([
        "NODE_ENV",
        "PORT",
        "PALANCAR_GENERATION_PROVIDER",
        "PALANCAR_AZURE_GENERATION_ENDPOINT",
        "PALANCAR_AZURE_GENERATION_DEPLOYMENT",
        "PALANCAR_RELAY_BIND_HOST",
        "PALANCAR_RELAY_ENVIRONMENT",
        "PALANCAR_RELAY_ORIGIN",
        "PALANCAR_GATE_POLICY_VERSION",
        "AZURE_CLIENT_ID",
        "PALANCAR_DEPLOYMENT_SLOT",
        "APPLICATIONINSIGHTS_CONNECTION_STRING",
        "APPLICATIONINSIGHTS_STATSBEAT_DISABLED",
        "APPLICATION_INSIGHTS_NO_STATSBEAT",
        "PALANCAR_SECURITY_MODE",
        "PALANCAR_WORKLOAD_TABLE_ENDPOINT",
        "PALANCAR_SECURITY_STATE_TABLE",
        "PALANCAR_RATE_STATE_TABLE",
        "PALANCAR_TRANSCRIPTION_PROVIDER",
        "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT",
        "PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT",
        "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
        "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
        "PALANCAR_LANGUAGE_BOUNDARY_MODE",
      ])
    )
    error_message = "Azure realtime mode must preserve transcription fields alongside the fixed generation fields"
  }

  assert {
    condition = alltrue([
      for item in azapi_resource.this.body.properties.template.containers[0].env :
      toset(keys(item)) == toset(["name", "value"]) && !contains(keys(item), "secretRef")
    ])
    error_message = "Azure realtime mode must keep the one relay container secret-free"
  }

  assert {
    condition = alltrue([
      nonsensitive({
        for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
      })["PALANCAR_AZURE_GENERATION_DEPLOYMENT"] == "gpt-5.6-luna",
      nonsensitive({
        for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
      })["PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT"] == "gpt-4o-mini-transcribe",
    ])
    error_message = "generation and transcription deployments must remain independently fixed"
  }
}

run "canonicalizes_live_telemetry_fields" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB;IngestionEndpoint=https://dc.services.visualstudio.com/;LiveEndpoint=https://live.applicationinsights.azure.com/;ApplicationId=33333333-3333-4333-8333-333333333333"
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
    })["APPLICATIONINSIGHTS_CONNECTION_STRING"] == "InstrumentationKey=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb;IngestionEndpoint=https://dc.services.visualstudio.com"
    error_message = "telemetry must emit only the canonical lower-case instrumentation key and slash-free ingestion endpoint"
  }
}

run "accepts_boundary_container_app_names" {
  command = plan

  variables {
    name = "aa"
  }

  assert {
    condition     = azapi_resource.this.name == "aa"
    error_message = "a two-character lower-case Container App name must be accepted"
  }
}

run "accepts_maximum_container_app_name" {
  command = plan

  variables {
    name = join("", [for index in range(32) : "a"])
  }

  assert {
    condition     = length(azapi_resource.this.name) == 32
    error_message = "a thirty-two-character lower-case Container App name must be accepted"
  }
}

run "rejects_invalid_container_app_names" {
  command = plan

  variables {
    name = "ca--relay"
  }

  expect_failures = [var.name]
}

run "rejects_generation_endpoint_uppercase" {
  command = plan

  variables {
    azure_generation_endpoint = "https://Palancardev.openai.azure.com"
  }

  expect_failures = [var.azure_generation_endpoint]
}

run "rejects_generation_endpoint_trailing_slash" {
  command = plan

  variables {
    azure_generation_endpoint = "https://palancardev.openai.azure.com/"
  }

  expect_failures = [var.azure_generation_endpoint]
}

run "rejects_generation_endpoint_leading_whitespace" {
  command = plan

  variables {
    azure_generation_endpoint = " https://palancardev.openai.azure.com"
  }

  expect_failures = [var.azure_generation_endpoint]
}

run "rejects_generation_endpoint_trailing_whitespace" {
  command = plan

  variables {
    azure_generation_endpoint = "https://palancardev.openai.azure.com "
  }

  expect_failures = [var.azure_generation_endpoint]
}

run "rejects_generation_endpoint_userinfo" {
  command = plan

  variables {
    azure_generation_endpoint = "https://user@palancardev.openai.azure.com"
  }

  expect_failures = [var.azure_generation_endpoint]
}

run "rejects_generation_endpoint_explicit_port" {
  command = plan

  variables {
    azure_generation_endpoint = "https://palancardev.openai.azure.com:443"
  }

  expect_failures = [var.azure_generation_endpoint]
}

run "rejects_generation_endpoint_path" {
  command = plan

  variables {
    azure_generation_endpoint = "https://palancardev.openai.azure.com/openai"
  }

  expect_failures = [var.azure_generation_endpoint]
}

run "rejects_generation_endpoint_query" {
  command = plan

  variables {
    azure_generation_endpoint = "https://palancardev.openai.azure.com?api-version=2026-01-01"
  }

  expect_failures = [var.azure_generation_endpoint]
}

run "rejects_generation_endpoint_fragment" {
  command = plan

  variables {
    azure_generation_endpoint = "https://palancardev.openai.azure.com#fragment"
  }

  expect_failures = [var.azure_generation_endpoint]
}

run "rejects_generation_endpoint_wrong_scheme" {
  command = plan

  variables {
    azure_generation_endpoint = "http://palancardev.openai.azure.com"
  }

  expect_failures = [var.azure_generation_endpoint]
}

run "rejects_generation_endpoint_wrong_suffix" {
  command = plan

  variables {
    azure_generation_endpoint = "https://palancardev.openai.azure.net"
  }

  expect_failures = [var.azure_generation_endpoint]
}

run "rejects_generation_deployment_alias" {
  command = plan

  variables {
    azure_generation_deployment = "gpt-5.6-luna-2026-07-09"
  }

  expect_failures = [var.azure_generation_deployment]
}

run "rejects_generation_deployment_case_and_whitespace" {
  command = plan

  variables {
    azure_generation_deployment = " GPT-5.6-LUNA "
  }

  expect_failures = [var.azure_generation_deployment]
}

run "rejects_missing_runtime_role_dependencies" {
  command = plan

  variables {
    runtime_openai_user_role_assignment_id                  = ""
    runtime_monitoring_metrics_publisher_role_assignment_id = ""
  }

  expect_failures = [
    var.runtime_openai_user_role_assignment_id,
    var.runtime_monitoring_metrics_publisher_role_assignment_id,
  ]
}

run "rejects_wrong_security_mode" {
  command = plan

  variables {
    security_mode = "memory"
  }

  expect_failures = [azapi_resource.this]
}

run "rejects_wrong_table_contract" {
  command = plan

  variables {
    security_state_table_name = "OtherSecurityState"
  }

  expect_failures = [var.security_state_table_name]
}

run "rejects_unknown_transcription_provider" {
  command = plan

  variables {
    transcription_provider = "azure"
  }

  expect_failures = [var.transcription_provider]
}

run "rejects_mock_with_transcription_fields" {
  command = plan

  variables {
    azure_transcription_endpoint   = "wss://palancardev.openai.azure.com/openai/v1/realtime?intent=transcription"
    azure_transcription_deployment = "gpt-4o-mini-transcribe"
  }

  expect_failures = [azapi_resource.this]
}

run "rejects_azure_realtime_without_transcription_fields" {
  command = plan

  variables {
    transcription_provider = "azure-realtime"
  }

  expect_failures = [azapi_resource.this]
}

run "rejects_wrong_transcription_deployment" {
  command = plan

  variables {
    transcription_provider         = "azure-realtime"
    azure_transcription_endpoint   = "wss://palancardev.openai.azure.com/openai/v1/realtime?intent=transcription"
    azure_transcription_deployment = "gpt-4o"
  }

  expect_failures = [var.azure_transcription_deployment]
}

run "rejects_hostile_azure_transcription_endpoint" {
  command = plan

  variables {
    transcription_provider       = "azure-realtime"
    azure_transcription_endpoint = "https://PALANCAR.openai.azure.com/openai/v1/realtime?intent=transcription"
  }

  expect_failures = [var.azure_transcription_endpoint]
}

run "rejects_disabled_transcription_field_whitespace" {
  command = plan

  variables {
    azure_transcription_endpoint   = " "
    azure_transcription_deployment = "\n"
  }

  expect_failures = [
    var.azure_transcription_endpoint,
    var.azure_transcription_deployment,
  ]
}

run "rejects_overlong_azure_transcription_dns_label" {
  command = plan

  variables {
    azure_transcription_endpoint = "wss://${join("", [for index in range(64) : "a"])}.openai.azure.com/openai/v1/realtime?intent=transcription"
  }

  expect_failures = [var.azure_transcription_endpoint]
}

run "rejects_provisional_boundary_outside_dev" {
  command = plan

  variables {
    deployment_slot        = "production"
    language_boundary_mode = "development-provisional"
  }

  expect_failures = [azapi_resource.this]
}

run "rejects_hostile_deployment_slot" {
  command = plan

  variables {
    deployment_slot = "prod"
  }

  expect_failures = [var.deployment_slot]
}

run "rejects_unknown_language_boundary_mode" {
  command = plan

  variables {
    language_boundary_mode = "provisional"
  }

  expect_failures = [var.language_boundary_mode]
}

run "rejects_uppercase_language_boundary_mode" {
  command = plan

  variables {
    language_boundary_mode = "DEVELOPMENT-PROVISIONAL"
  }

  expect_failures = [var.language_boundary_mode]
}

run "rejects_language_boundary_mode_whitespace" {
  command = plan

  variables {
    language_boundary_mode = "development-provisional "
  }

  expect_failures = [var.language_boundary_mode]
}

run "rejects_provisional_language_boundary_in_staging" {
  command = plan

  variables {
    deployment_slot        = "staging"
    language_boundary_mode = "development-provisional"
  }

  expect_failures = [azapi_resource.this]
}

run "production_deny_all_language_boundary_is_explicit" {
  command = plan

  variables {
    deployment_slot        = "production"
    language_boundary_mode = "deny-all"
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
    })["PALANCAR_LANGUAGE_BOUNDARY_MODE"] == "deny-all"
    error_message = "production must emit exactly one plain deny-all language boundary value"
  }
}

run "rejects_invalid_replica_controls" {
  command = plan

  variables {
    min_replicas = 2
    target_port  = 8080
  }

  expect_failures = [
    var.min_replicas,
    var.target_port,
  ]
}

run "rejects_invalid_minimum_replica_count" {
  command = plan

  variables {
    min_replicas = 2
  }

  expect_failures = [var.min_replicas]
}

run "rejects_scale_to_zero" {
  command = plan

  variables {
    min_replicas = 0
  }

  expect_failures = [var.min_replicas]
}

run "rejects_image_from_another_registry" {
  command = plan

  variables {
    image_digest = "otherdev.azurecr.io/palancar-relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [azapi_resource.this]
}

run "rejects_mutable_image" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar-relay:latest"
  }

  expect_failures = [var.image_digest]
}

run "rejects_wrong_image_repository" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar-worker@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "rejects_uppercase_image_repository" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/Palancar-relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "rejects_empty_image_repository_component" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar//relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "rejects_dot_image_repository_component" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/./relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "rejects_dot_dot_image_repository_component" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/../relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "rejects_uri_character_in_image" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar-relay?tag=bad@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "rejects_case_only_duplicate_identities" {
  command = plan

  variables {
    runtime_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull"
  }

  expect_failures = [azapi_resource.this]
}

run "rejects_hostile_arm_resource_ids" {
  command = plan

  variables {
    resource_group_id            = "/subscriptions/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/resourceGroups/rg-palancar-dev"
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/microsoft.app/managedEnvironments/cae-palancar-dev"
    image_pull_identity_id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id%2fpalancar"
    runtime_identity_id          = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime/extra"
  }

  expect_failures = [
    var.resource_group_id,
    var.container_app_environment_id,
    var.image_pull_identity_id,
    var.runtime_identity_id,
  ]
}

run "rejects_invalid_acr_login_server" {
  command = plan

  variables {
    acr_login_server = "PALANCAR.azurecr.io"
  }

  expect_failures = [var.acr_login_server]
}

run "rejects_short_acr_registry_name" {
  command = plan

  variables {
    acr_login_server = "four.azurecr.io"
  }

  expect_failures = [var.acr_login_server]
}

run "rejects_invalid_environment" {
  command = plan

  variables {
    environment = " dev "
  }

  expect_failures = [var.environment]
}

run "rejects_noncanonical_environment" {
  command = plan

  variables {
    environment = "qa"
  }

  expect_failures = [var.environment]
}

run "rejects_invalid_relay_origin" {
  command = plan

  variables {
    relay_origin = "https://ca-palancar-dev-relay-test.example.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "rejects_overlong_relay_dns_label" {
  command = plan

  variables {
    relay_origin = "wss://${join("", [for index in range(64) : "a"])}.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "rejects_overlong_relay_hostname" {
  command = plan

  variables {
    relay_origin = "wss://${join(".", [for index in range(4) : join("", [for character in range(63) : "a"])])}.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "rejects_invalid_browser_origin" {
  command = plan

  variables {
    browser_allowed_origins = ["*"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_duplicate_browser_origins" {
  command = plan

  variables {
    browser_allowed_origins = [
      "https://even-webview.synthetic.invalid",
      "https://even-webview.synthetic.invalid",
    ]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_hostile_telemetry_connection_string" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA;IngestionEndpoint=https://evil.example.com/;LiveEndpoint=https://live.applicationinsights.azure.com/;ApplicationId=33333333-3333-4333-8333-333333333333"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_telemetry_extra_fields" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA;IngestionEndpoint=https://dc.services.visualstudio.com/;LiveEndpoint=https://live.applicationinsights.azure.com/;ApplicationId=33333333-3333-4333-8333-333333333333;Extra=value"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_noncanonical_telemetry_host_labels" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA;IngestionEndpoint=https://west.eastus2-1.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.foo.livediagnostics.monitor.azure.com/;ApplicationId=33333333-3333-4333-8333-333333333333"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_noncanonical_application_id" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA;IngestionEndpoint=https://dc.services.visualstudio.com/;LiveEndpoint=https://live.applicationinsights.azure.com/;ApplicationId=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_one_character_container_app_name" {
  command = plan

  variables {
    name = "a"
  }

  expect_failures = [var.name]
}

run "rejects_overlong_container_app_name" {
  command = plan

  variables {
    name = join("", [for index in range(33) : "a"])
  }

  expect_failures = [var.name]
}

run "rejects_uppercase_container_app_name" {
  command = plan

  variables {
    name = "ca-Palancar-relay"
  }

  expect_failures = [var.name]
}

run "rejects_leading_hyphen_container_app_name" {
  command = plan

  variables {
    name = "-ca-relay"
  }

  expect_failures = [var.name]
}

run "rejects_trailing_hyphen_container_app_name" {
  command = plan

  variables {
    name = "ca-relay-"
  }

  expect_failures = [var.name]
}

run "rejects_arm_id_whitespace_query_fragment_and_missing_segment" {
  command = plan

  variables {
    resource_group_id            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg palancar"
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae-palancar-dev?api-version=1"
    image_pull_identity_id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar#fragment"
    runtime_identity_id          = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/id-palancar-dev-runtime"
  }

  expect_failures = [
    var.resource_group_id,
    var.container_app_environment_id,
    var.image_pull_identity_id,
    var.runtime_identity_id,
  ]
}

run "rejects_overlong_arm_id_segment" {
  command = plan

  variables {
    resource_group_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/${join("", [for index in range(65) : "a"])}"
  }

  expect_failures = [var.resource_group_id]
}

run "rejects_telemetry_control_protocol" {
  command = plan

  variables {
    application_insights_connection_string = "OTLP=https://127.0.0.1:4317"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_duplicate_telemetry_key" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;InstrumentationKey=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_authorization_telemetry_field" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222;Authorization=ikey"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_aad_audience_telemetry_field" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222;AADAudience=https://monitor.azure.com"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_telemetry_whitespace" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa; IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_telemetry_control_character" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222\n"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_unapproved_ingestion_host" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com.evil.invalid/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_unapproved_live_host" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com.evil.invalid/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_noncanonical_multilabel_telemetry_hosts" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://east.us.in.applicationinsights.azure.com/;LiveEndpoint=https://east.us.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_telemetry_extra_equals" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/?x=y;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_overlong_ingestion_label" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://${join("", [for index in range(64) : "a"])}.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_overlong_live_hostname" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://${join(".", [for index in range(4) : join("", [for character in range(63) : "a"])])}.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "rejects_overlong_browser_dns_label" {
  command = plan

  variables {
    browser_allowed_origins = ["https://${join("", [for index in range(64) : "a"])}.example.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_overlong_browser_hostname" {
  command = plan

  variables {
    browser_allowed_origins = ["https://${join(".", [for index in range(4) : join("", [for character in range(63) : "a"])])}.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_malformed_browser_origin" {
  command = plan

  variables {
    browser_allowed_origins = ["http://app.example.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_duplicate_canonical_browser_origins" {
  command = plan

  variables {
    browser_allowed_origins = [
      "https://app.example.com",
      "https://app.example.com",
    ]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_too_many_browser_origins" {
  command = plan

  variables {
    browser_allowed_origins = [for index in range(33) : "https://app-${index}.example.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_wildcard_browser_origin" {
  command = plan

  variables {
    browser_allowed_origins = ["https://*.example.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_trailing_slash_browser_origin" {
  command = plan

  variables {
    browser_allowed_origins = ["https://app.example.com/"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_explicit_default_browser_origin_port" {
  command = plan

  variables {
    browser_allowed_origins = ["https://app.example.com:443"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_uppercase_browser_origin_host" {
  command = plan

  variables {
    browser_allowed_origins = ["https://APP.example.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_numeric_browser_origin_host" {
  command = plan

  variables {
    browser_allowed_origins = ["https://127.0.0.01"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_hex_numeric_browser_origin_host" {
  command = plan

  variables {
    browser_allowed_origins = ["https://0x7f000001"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_decimal_numeric_browser_origin_final_label" {
  command = plan

  variables {
    browser_allowed_origins = ["https://example.01"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_hex_numeric_browser_origin_final_label" {
  command = plan

  variables {
    browser_allowed_origins = ["https://app.0x7f"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_bare_hex_browser_origin_host" {
  command = plan

  variables {
    browser_allowed_origins = ["https://0x"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_bare_hex_browser_origin_final_label" {
  command = plan

  variables {
    browser_allowed_origins = ["https://app.0x"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_too_many_ipv4_browser_origin_components" {
  command = plan

  variables {
    browser_allowed_origins = ["https://1.2.3.4.5"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "rejects_browser_origin_path" {
  command = plan

  variables {
    browser_allowed_origins = ["https://app.example.com/path"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "explicit_null_browser_allowed_origins_use_default" {
  command = plan

  variables {
    browser_allowed_origins = null
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
    })["PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON"] == "[\"https://even-webview.synthetic.invalid\"]"
    error_message = "explicit null must resolve to the non-null browser origin default"
  }
}

run "explicit_null_allow_null_browser_origin_uses_default" {
  command = plan

  variables {
    allow_null_browser_origin = null
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
    })["PALANCAR_ALLOW_NULL_BROWSER_ORIGIN"] == "false"
    error_message = "explicit null must resolve to the non-null null-origin default"
  }
}

run "accepts_empty_browser_origins" {
  command = plan

  variables {
    browser_allowed_origins = []
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
    })["PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON"] == "[]"
    error_message = "an empty browser origin list must serialize as an empty JSON array"
  }
}

run "accepts_exactly_32_unique_browser_origins" {
  command = plan

  variables {
    browser_allowed_origins = [for index in range(32) : "https://app-${index}.example.com"]
  }

  assert {
    condition = jsondecode(nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
      })["PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON"]) == [
      for index in range(32) : "https://app-${index}.example.com"
    ]
    error_message = "exactly 32 unique canonical DNS browser origins must serialize unchanged"
  }
}

run "accepts_canonical_non_default_browser_origin_port" {
  command = plan

  variables {
    browser_allowed_origins = ["https://app.example.com:8443"]
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
    })["PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON"] == "[\"https://app.example.com:8443\"]"
    error_message = "a canonical non-default browser origin port must serialize unchanged"
  }
}

run "accepts_numeric_non_final_browser_origin_label" {
  command = plan

  variables {
    browser_allowed_origins = ["https://1.example.com"]
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
    })["PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON"] == "[\"https://1.example.com\"]"
    error_message = "a numeric non-final DNS label must serialize unchanged"
  }
}

run "accepts_true_allow_null_browser_origin" {
  command = plan

  variables {
    allow_null_browser_origin = true
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
    })["PALANCAR_ALLOW_NULL_BROWSER_ORIGIN"] == "true"
    error_message = "allow_null_browser_origin=true must serialize exactly as true"
  }
}
