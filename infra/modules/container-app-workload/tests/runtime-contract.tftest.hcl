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
  runtime_secrets_user_role_assignment_id                 = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000002"
  runtime_openai_user_role_assignment_id                  = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000003"
  runtime_monitoring_metrics_publisher_role_assignment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000004"
  workload_table_endpoint                                 = "https://palancardev.table.core.windows.net/"
  security_state_table_name                               = "SecurityState"
  rate_state_table_name                                   = "RateState"
  environment                                             = "dev"
  deployment_slot                                         = "dev"
  application_insights_connection_string                  = "LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222;IngestionEndpoint=https://eastus2-1.in.applicationinsights.azure.com/;InstrumentationKey=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
  relay_origin                                            = "wss://ca-palancar-dev-relay-test.example.azurecontainerapps.io"
  key_vault_uri                                           = "https://palancar-vault.vault.azure.net/"
}

run "mock_runtime_contract" {
  command = plan

  assert {
    condition     = azapi_resource.this.body.properties.template.scale.minReplicas == 1
    error_message = "the deployed relay must keep exactly one warm replica"
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.scale.maxReplicas == 1
    error_message = "the module must hardcode maxReplicas to one"
  }

  assert {
    condition     = length(azapi_resource.this.body.properties.template.containers) == 1
    error_message = "a disabled sidecar must emit only the relay container"
  }

  assert {
    condition     = length(azapi_resource.this.body.properties.configuration.secrets) == 0
    error_message = "a disabled sidecar must emit no generation secrets"
  }

  assert {
    condition = length(azapi_resource.this.body.properties.template.containers[0].env) == length(toset([
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name
    ]))
    error_message = "mock relay environment names must be unique"
  }

  assert {
    condition = toset([
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name
      ]) == toset([
      "NODE_ENV",
      "PORT",
      "PALANCAR_GENERATION_PROVIDER",
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
    ])
    error_message = "mock mode must emit the exact relay environment key set"
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
      }) == {
      NODE_ENV                               = "production"
      PORT                                   = "8787"
      PALANCAR_GENERATION_PROVIDER           = "mock"
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
    }
    error_message = "mock mode must emit the exact canonical relay environment values"
  }
}

run "live_four_field_connection_is_canonicalized" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB;IngestionEndpoint=https://dc.services.visualstudio.com/;LiveEndpoint=https://live.applicationinsights.azure.com/;ApplicationId=33333333-3333-4333-8333-333333333333"
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
    })["APPLICATIONINSIGHTS_CONNECTION_STRING"] == "InstrumentationKey=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb;IngestionEndpoint=https://dc.services.visualstudio.com"
    error_message = "the live four-field input must emit only the canonical lower-case instrumentation key and slash-free approved ingestion endpoint"
  }

  assert {
    condition = alltrue([
      for item in azapi_resource.this.body.properties.template.containers[0].env :
      !strcontains(try(item.value, ""), "LiveEndpoint=") &&
      !strcontains(try(item.value, ""), "ApplicationId=")
    ])
    error_message = "LiveEndpoint and ApplicationId must never be passed to the relay"
  }
}

run "enabled_openrouter_contract" {
  command = plan

  variables {
    enable_litellm_sidecar        = true
    litellm_image_digest          = "palancardev.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_backend               = "openrouter"
    litellm_upstream_model        = "openrouter/openai/gpt-4o-mini"
    openrouter_api_key_secret_url = "https://palancar-vault.vault.azure.net/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://palancar-vault.vault.azure.net/secrets/litellm-master-key"
    min_replicas                  = 1
  }

  assert {
    condition     = length(azapi_resource.this.body.properties.template.containers) == 2
    error_message = "OpenRouter mode must emit exactly relay and LiteLLM containers"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.configuration.secrets) == jsonencode([
      {
        name        = "litellm-master-key"
        keyVaultUrl = "https://palancar-vault.vault.azure.net/secrets/litellm-master-key"
        identity    = var.runtime_identity_id
      },
      {
        name        = "openrouter-api-key"
        keyVaultUrl = "https://palancar-vault.vault.azure.net/secrets/openrouter-api-key"
        identity    = var.runtime_identity_id
      },
    ])
    error_message = "OpenRouter mode must emit exactly two versionless same-vault secret references using the runtime identity"
  }

  assert {
    condition = (
      length(azapi_resource.this.identity[0].identity_ids) == 2 &&
      toset(azapi_resource.this.identity[0].identity_ids) == toset([
        var.image_pull_identity_id,
        var.runtime_identity_id,
      ])
    )
    error_message = "the workload must use exactly the image-pull and runtime user-assigned identities"
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[1].image == "palancardev.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    error_message = "the LiteLLM image must be an immutable digest in the relay ACR"
  }

  assert {
    condition = length(azapi_resource.this.body.properties.template.containers[1].env) == length(toset([
      for item in azapi_resource.this.body.properties.template.containers[1].env : item.name
    ]))
    error_message = "the LiteLLM sidecar environment names must be unique"
  }

  assert {
    condition = toset([
      for item in azapi_resource.this.body.properties.template.containers[1].env : item.name
      ]) == toset([
      "PALANCAR_LITELLM_BACKEND",
      "PALANCAR_LITELLM_UPSTREAM_MODEL",
      "LITELLM_MASTER_KEY",
      "OPENROUTER_API_KEY",
    ])
    error_message = "the LiteLLM sidecar must emit the exact qualified OpenRouter key set"
  }

  assert {
    condition = {
      for item in azapi_resource.this.body.properties.template.containers[1].env : item.name => {
        value      = try(item.value, null)
        secret_ref = try(item.secretRef, null)
      }
      } == {
      PALANCAR_LITELLM_BACKEND        = { value = "openrouter", secret_ref = null }
      PALANCAR_LITELLM_UPSTREAM_MODEL = { value = "openrouter/openai/gpt-4o-mini", secret_ref = null }
      LITELLM_MASTER_KEY              = { value = null, secret_ref = "litellm-master-key" }
      OPENROUTER_API_KEY              = { value = null, secret_ref = "openrouter-api-key" }
    }
    error_message = "the LiteLLM sidecar must emit the exact qualified OpenRouter values and secret references"
  }

  assert {
    condition = length(azapi_resource.this.body.properties.template.containers[0].env) == length(toset([
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name
    ]))
    error_message = "OpenRouter relay environment names must be unique"
  }

  assert {
    condition = toset([
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name
      ]) == toset([
      "NODE_ENV",
      "PORT",
      "PALANCAR_GENERATION_PROVIDER",
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
      "PALANCAR_LITELLM_BASE_URL",
      "PALANCAR_LITELLM_MODEL",
      "PALANCAR_LITELLM_API_KEY",
    ])
    error_message = "OpenRouter mode must emit the exact relay environment key set"
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => {
        value      = try(item.value, null)
        secret_ref = try(item.secretRef, null)
      }
      }) == {
      NODE_ENV                               = { value = "production", secret_ref = null }
      PORT                                   = { value = "8787", secret_ref = null }
      PALANCAR_GENERATION_PROVIDER           = { value = "litellm", secret_ref = null }
      PALANCAR_RELAY_BIND_HOST               = { value = "0.0.0.0", secret_ref = null }
      PALANCAR_RELAY_ENVIRONMENT             = { value = "dev", secret_ref = null }
      PALANCAR_RELAY_ORIGIN                  = { value = "wss://ca-palancar-dev-relay-test.example.azurecontainerapps.io", secret_ref = null }
      PALANCAR_GATE_POLICY_VERSION           = { value = "1.0.0", secret_ref = null }
      AZURE_CLIENT_ID                        = { value = "00000000-0000-0000-0000-000000000001", secret_ref = null }
      PALANCAR_DEPLOYMENT_SLOT               = { value = "dev", secret_ref = null }
      APPLICATIONINSIGHTS_CONNECTION_STRING  = { value = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2-1.in.applicationinsights.azure.com", secret_ref = null }
      APPLICATIONINSIGHTS_STATSBEAT_DISABLED = { value = "true", secret_ref = null }
      APPLICATION_INSIGHTS_NO_STATSBEAT      = { value = "true", secret_ref = null }
      PALANCAR_SECURITY_MODE                 = { value = "azure-table", secret_ref = null }
      PALANCAR_WORKLOAD_TABLE_ENDPOINT       = { value = "https://palancardev.table.core.windows.net", secret_ref = null }
      PALANCAR_SECURITY_STATE_TABLE          = { value = "SecurityState", secret_ref = null }
      PALANCAR_RATE_STATE_TABLE              = { value = "RateState", secret_ref = null }
      PALANCAR_TRANSCRIPTION_PROVIDER        = { value = "mock", secret_ref = null }
      PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON  = { value = "[\"https://even-webview.synthetic.invalid\"]", secret_ref = null }
      PALANCAR_ALLOW_NULL_BROWSER_ORIGIN     = { value = "false", secret_ref = null }
      PALANCAR_LITELLM_BASE_URL              = { value = "http://127.0.0.1:4000", secret_ref = null }
      PALANCAR_LITELLM_MODEL                 = { value = "palancar-generation", secret_ref = null }
      PALANCAR_LITELLM_API_KEY               = { value = null, secret_ref = "litellm-master-key" }
    }
    error_message = "OpenRouter mode must emit the exact relay values, fixed localhost endpoint, alias, and secret reference"
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.scale.minReplicas == 1
    error_message = "one warm replica must remain an exact supported option"
  }

  assert {
    condition     = azapi_resource.this.body.properties.managedEnvironmentId == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae-palancar-dev"
    error_message = "managedEnvironmentId must be the canonical Container Apps environment in the fixture boundary"
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
    error_message = "identitySettings must only lowercase the resourceGroups path segment"
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => try(item.value, null)
    })["PALANCAR_WORKLOAD_TABLE_ENDPOINT"] == "https://palancardev.table.core.windows.net"
    error_message = "the relay workload table endpoint must be slash-free"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.configuration.ingress) == jsonencode({
      external      = true
      targetPort    = 8787
      transport     = "Http"
      allowInsecure = false
      traffic       = [{ latestRevision = true, weight = 100 }]
    })
    error_message = "ingress must be exact external HTTP on 8787 with only latest-revision traffic"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.template.containers[0].probes) == jsonencode([
      {
        type                = "Liveness"
        tcpSocket           = { port = 8787 }
        initialDelaySeconds = 10
        periodSeconds       = 10
        timeoutSeconds      = 3
        failureThreshold    = 3
      },
      {
        type                = "Readiness"
        httpGet             = { path = "/readyz", port = 8787 }
        initialDelaySeconds = 5
        periodSeconds       = 10
        timeoutSeconds      = 7
        failureThreshold    = 3
      },
    ])
    error_message = "relay probes must match the exact HTTP contract"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.template.containers[1].probes) == jsonencode([
      {
        type                = "Liveness"
        tcpSocket           = { port = 4000 }
        initialDelaySeconds = 10
        periodSeconds       = 30
        timeoutSeconds      = 3
        failureThreshold    = 3
      },
      {
        type             = "Readiness"
        httpGet          = { path = "/health/readiness", port = 4000 }
        periodSeconds    = 10
        timeoutSeconds   = 7
        failureThreshold = 3
      },
      {
        type             = "Startup"
        httpGet          = { path = "/health/liveliness", port = 4000 }
        periodSeconds    = 10
        timeoutSeconds   = 3
        failureThreshold = 10
      },
    ])
    error_message = "LiteLLM probes must match the exact HTTP contract"
  }
}

run "azure_realtime_runtime_contract" {
  command = plan

  variables {
    deployment_slot                = "staging"
    transcription_provider         = "azure-realtime"
    azure_transcription_endpoint   = "wss://palancardev.openai.azure.com/openai/v1/realtime?intent=transcription"
    azure_transcription_deployment = "gpt-4o-mini-transcribe"
  }

  assert {
    condition     = length(azapi_resource.this.body.properties.template.containers) == 1
    error_message = "Azure realtime mode without generation sidecar must emit only the relay container"
  }

  assert {
    condition = length(azapi_resource.this.body.properties.template.containers[0].env) == length(toset([
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name
    ]))
    error_message = "Azure realtime relay environment names must be unique"
  }

  assert {
    condition = toset([
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name
      ]) == toset([
      "NODE_ENV",
      "PORT",
      "PALANCAR_GENERATION_PROVIDER",
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
    ])
    error_message = "Azure realtime mode must emit the exact relay environment key set"
  }

  assert {
    condition = nonsensitive({
      for item in azapi_resource.this.body.properties.template.containers[0].env : item.name => item.value
      }) == {
      NODE_ENV                                = "production"
      PORT                                    = "8787"
      PALANCAR_GENERATION_PROVIDER            = "mock"
      PALANCAR_RELAY_BIND_HOST                = "0.0.0.0"
      PALANCAR_RELAY_ENVIRONMENT              = "dev"
      PALANCAR_RELAY_ORIGIN                   = "wss://ca-palancar-dev-relay-test.example.azurecontainerapps.io"
      PALANCAR_GATE_POLICY_VERSION            = "1.0.0"
      AZURE_CLIENT_ID                         = "00000000-0000-0000-0000-000000000001"
      PALANCAR_DEPLOYMENT_SLOT                = "staging"
      APPLICATIONINSIGHTS_CONNECTION_STRING   = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2-1.in.applicationinsights.azure.com"
      APPLICATIONINSIGHTS_STATSBEAT_DISABLED  = "true"
      APPLICATION_INSIGHTS_NO_STATSBEAT       = "true"
      PALANCAR_SECURITY_MODE                  = "azure-table"
      PALANCAR_WORKLOAD_TABLE_ENDPOINT        = "https://palancardev.table.core.windows.net"
      PALANCAR_SECURITY_STATE_TABLE           = "SecurityState"
      PALANCAR_RATE_STATE_TABLE               = "RateState"
      PALANCAR_TRANSCRIPTION_PROVIDER         = "azure-realtime"
      PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT   = "wss://palancardev.openai.azure.com/openai/v1/realtime?intent=transcription"
      PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT = "gpt-4o-mini-transcribe"
      PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON   = "[\"https://even-webview.synthetic.invalid\"]"
      PALANCAR_ALLOW_NULL_BROWSER_ORIGIN      = "false"
    }
    error_message = "Azure realtime mode must emit the exact canonical relay environment values"
  }

  assert {
    condition = alltrue([
      for item in azapi_resource.this.body.properties.template.containers[0].env :
      !startswith(item.name, "OTEL_") &&
      !startswith(item.name, "OTLP_") &&
      item.name != "AZURE_LOG_LEVEL" &&
      !contains(["AZURE_OPENAI_API_KEY", "AZURE_API_KEY", "OPENAI_API_KEY", "PALANCAR_AZURE_TRANSCRIPTION_API_KEY"], item.name)
    ])
    error_message = "Azure transcription and telemetry must use managed identity and must not emit API keys or forbidden telemetry variables"
  }
}

run "reject_azure_backend" {
  command = plan

  variables {
    litellm_backend = "azure"
  }

  expect_failures = [var.litellm_backend]
}

run "reject_disabled_sidecar_values" {
  command = plan

  variables {
    litellm_backend = "openrouter"
  }

  expect_failures = [azapi_resource.this]
}

run "reject_incomplete_openrouter" {
  command = plan

  variables {
    enable_litellm_sidecar = true
    litellm_backend        = "openrouter"
    litellm_image_digest   = "palancardev.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_upstream_model = "openrouter/openai/gpt-4o-mini"
  }

  expect_failures = [azapi_resource.this]
}

run "reject_azure_fields" {
  command = plan

  variables {
    azure_api_base = "https://fixture.invalid"
  }

  expect_failures = [var.azure_api_base]
}

run "reject_versioned_secret_url" {
  command = plan

  variables {
    enable_litellm_sidecar        = true
    litellm_backend               = "openrouter"
    litellm_image_digest          = "palancardev.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_upstream_model        = "openrouter/openai/gpt-4o-mini"
    openrouter_api_key_secret_url = "https://palancar-vault.vault.azure.net/secrets/openrouter-api-key/version"
    litellm_master_key_secret_url = "https://palancar-vault.vault.azure.net/secrets/litellm-master-key"
  }

  expect_failures = [azapi_resource.this]
}

run "reject_cross_vault_secret_url" {
  command = plan

  variables {
    enable_litellm_sidecar        = true
    litellm_backend               = "openrouter"
    litellm_image_digest          = "palancardev.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_upstream_model        = "openrouter/openai/gpt-4o-mini"
    openrouter_api_key_secret_url = "https://other-vault.vault.azure.net/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://palancar-vault.vault.azure.net/secrets/litellm-master-key"
  }

  expect_failures = [azapi_resource.this]
}

run "reject_security_mode" {
  command = plan

  variables {
    security_mode = "memory"
  }

  expect_failures = [azapi_resource.this]
}

run "reject_unknown_transcription_provider" {
  command = plan

  variables {
    transcription_provider = "azure"
  }

  expect_failures = [var.transcription_provider]
}

run "reject_mock_with_azure_fields" {
  command = plan

  variables {
    azure_transcription_endpoint = "wss://palancardev.openai.azure.com/openai/v1/realtime?intent=transcription"
  }

  expect_failures = [azapi_resource.this]
}

run "reject_azure_realtime_without_fields" {
  command = plan

  variables {
    transcription_provider = "azure-realtime"
  }

  expect_failures = [azapi_resource.this]
}

run "reject_hostile_azure_transcription_endpoint" {
  command = plan

  variables {
    transcription_provider       = "azure-realtime"
    azure_transcription_endpoint = "https://PALANCAR.openai.azure.com/openai/v1/realtime?intent=transcription"
  }

  expect_failures = [var.azure_transcription_endpoint]
}

run "reject_wrong_azure_transcription_deployment" {
  command = plan

  variables {
    transcription_provider         = "azure-realtime"
    azure_transcription_endpoint   = "wss://palancardev.openai.azure.com/openai/v1/realtime?intent=transcription"
    azure_transcription_deployment = "gpt-4o-transcribe"
  }

  expect_failures = [var.azure_transcription_deployment]
}

run "reject_invalid_minimum" {
  command = plan

  variables {
    min_replicas = 2
  }

  expect_failures = [var.min_replicas]
}

run "reject_scale_to_zero" {
  command = plan

  variables {
    min_replicas = 0
  }

  expect_failures = [var.min_replicas]
}

run "reject_hostile_deployment_slot" {
  command = plan

  variables {
    deployment_slot = "prod"
  }

  expect_failures = [var.deployment_slot]
}

run "reject_hostile_telemetry_connection_string" {
  command = plan

  variables {
    application_insights_connection_string = "OTLP=https://127.0.0.1:4317"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_duplicate_telemetry_key" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;InstrumentationKey=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_authorization_telemetry_field" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222;Authorization=ikey"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_aad_audience_telemetry_field" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222;AADAudience=https://monitor.azure.com"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_telemetry_whitespace" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa; IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_telemetry_control_character" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222\n"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_unapproved_ingestion_host" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com.evil.invalid/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_unapproved_live_host" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com.evil.invalid/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_noncanonical_multilabel_telemetry_hosts" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://east.us.in.applicationinsights.azure.com/;LiveEndpoint=https://east.us.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_noncanonical_application_id" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_telemetry_extra_equals" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/?x=y;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_overlong_ingestion_label" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://${join("", [for index in range(64) : "a"])}.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_overlong_live_hostname" {
  command = plan

  variables {
    application_insights_connection_string = "InstrumentationKey=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;IngestionEndpoint=https://eastus2.in.applicationinsights.azure.com/;LiveEndpoint=https://${join(".", [for index in range(4) : join("", [for character in range(63) : "a"])])}.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.application_insights_connection_string]
}

run "reject_missing_rbac_dependency_tokens" {
  command = plan

  variables {
    runtime_secrets_user_role_assignment_id                 = ""
    runtime_openai_user_role_assignment_id                  = ""
    runtime_monitoring_metrics_publisher_role_assignment_id = ""
  }

  expect_failures = [
    var.runtime_secrets_user_role_assignment_id,
    var.runtime_openai_user_role_assignment_id,
    var.runtime_monitoring_metrics_publisher_role_assignment_id,
  ]
}

run "reject_wrong_table_contract" {
  command = plan

  variables {
    security_state_table_name = "OtherSecurityState"
  }

  expect_failures = [var.security_state_table_name]
}

run "reject_relay_image_from_other_registry" {
  command = plan

  variables {
    image_digest = "otherdev.azurecr.io/palancar-relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [azapi_resource.this]
}

run "reject_litellm_image_outside_acr" {
  command = plan

  variables {
    enable_litellm_sidecar        = true
    litellm_backend               = "openrouter"
    litellm_image_digest          = "otherdev.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_upstream_model        = "openrouter/openai/gpt-4o-mini"
    openrouter_api_key_secret_url = "https://palancar-vault.vault.azure.net/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://palancar-vault.vault.azure.net/secrets/litellm-master-key"
  }

  expect_failures = [azapi_resource.this]
}

run "reject_non_acr_litellm_image" {
  command = plan

  variables {
    litellm_image_digest = "ghcr.io/palancar/litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
  }

  expect_failures = [var.litellm_image_digest]
}

run "reject_case_only_duplicate_identities" {
  command = plan

  variables {
    runtime_identity_id = "/SUBSCRIPTIONS/00000000-0000-0000-0000-000000000000/RESOURCEGROUPS/RG-PALANCAR-DEV/PROVIDERS/MICROSOFT.MANAGEDIDENTITY/USERASSIGNEDIDENTITIES/ID-PALANCAR-DEV-IMAGE-PULL"
  }

  expect_failures = [var.runtime_identity_id]
}

run "reject_hostile_arm_resource_ids" {
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

run "reject_arm_id_whitespace_query_fragment_and_missing_segment" {
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

run "reject_overlong_arm_id_segment" {
  command = plan

  variables {
    resource_group_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/${join("", [for index in range(65) : "a"])}"
  }

  expect_failures = [var.resource_group_id]
}

run "reject_invalid_acr_login_server" {
  command = plan

  variables {
    acr_login_server = "bad-name.azurecr.io"
  }

  expect_failures = [var.acr_login_server]
}

run "reject_short_acr_registry_name" {
  command = plan

  variables {
    acr_login_server = "four.azurecr.io"
  }

  expect_failures = [var.acr_login_server]
}

run "reject_mutable_relay_image" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar-relay:latest"
  }

  expect_failures = [var.image_digest]
}

run "reject_uppercase_relay_image_repository" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/Palancar-relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_empty_relay_image_repository_component" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar//relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_dot_relay_image_repository_component" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/./relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_dot_dot_relay_image_repository_component" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar/../relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_uri_character_in_relay_image" {
  command = plan

  variables {
    image_digest = "palancardev.azurecr.io/palancar-relay?tag=bad@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.image_digest]
}

run "reject_mutable_litellm_image" {
  command = plan

  variables {
    litellm_image_digest = "palancardev.azurecr.io/palancar-litellm-proxy:latest"
  }

  expect_failures = [var.litellm_image_digest]
}

run "reject_dot_litellm_image_repository_component" {
  command = plan

  variables {
    litellm_image_digest = "palancardev.azurecr.io/palancar/../litellm@sha256:2222222222222222222222222222222222222222222222222222222222222222"
  }

  expect_failures = [var.litellm_image_digest]
}

run "reject_noncanonical_environment" {
  command = plan

  variables {
    environment = "qa"
  }

  expect_failures = [var.environment]
}

run "reject_environment_whitespace" {
  command = plan

  variables {
    environment = "dev\n"
  }

  expect_failures = [var.environment]
}

run "reject_wrong_litellm_model_provider" {
  command = plan

  variables {
    litellm_upstream_model = "azure/openai/gpt-4o-mini"
  }

  expect_failures = [var.litellm_upstream_model]
}

run "reject_malformed_litellm_model" {
  command = plan

  variables {
    litellm_upstream_model = "openrouter/openai//gpt-4o-mini"
  }

  expect_failures = [var.litellm_upstream_model]
}

run "reject_litellm_model_whitespace" {
  command = plan

  variables {
    litellm_upstream_model = " openrouter/openai/gpt-4o-mini"
  }

  expect_failures = [var.litellm_upstream_model]
}

run "reject_disabled_provider_whitespace" {
  command = plan

  variables {
    azure_api_base    = " "
    azure_api_version = "\n"
  }

  expect_failures = [
    var.azure_api_base,
    var.azure_api_version,
  ]
}

run "reject_disabled_transcription_field_whitespace" {
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

run "reject_overlong_relay_dns_label" {
  command = plan

  variables {
    relay_origin = "wss://${join("", [for index in range(64) : "a"])}.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "reject_overlong_relay_hostname" {
  command = plan

  variables {
    relay_origin = "wss://${join(".", [for index in range(4) : join("", [for character in range(63) : "a"])])}.azurecontainerapps.io"
  }

  expect_failures = [var.relay_origin]
}

run "reject_overlong_browser_dns_label" {
  command = plan

  variables {
    browser_allowed_origins = ["https://${join("", [for index in range(64) : "a"])}.example.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_overlong_browser_hostname" {
  command = plan

  variables {
    browser_allowed_origins = ["https://${join(".", [for index in range(4) : join("", [for character in range(63) : "a"])])}.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_overlong_azure_transcription_dns_label" {
  command = plan

  variables {
    azure_transcription_endpoint = "wss://${join("", [for index in range(64) : "a"])}.openai.azure.com/openai/v1/realtime?intent=transcription"
  }

  expect_failures = [var.azure_transcription_endpoint]
}

run "reject_malformed_browser_origin" {
  command = plan

  variables {
    browser_allowed_origins = ["http://app.example.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_duplicate_browser_origins" {
  command = plan

  variables {
    browser_allowed_origins = [
      "https://app.example.com",
      "https://app.example.com",
    ]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_too_many_browser_origins" {
  command = plan

  variables {
    browser_allowed_origins = [for index in range(33) : "https://app-${index}.example.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_wildcard_browser_origin" {
  command = plan

  variables {
    browser_allowed_origins = ["https://*.example.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_trailing_slash_browser_origin" {
  command = plan

  variables {
    browser_allowed_origins = ["https://app.example.com/"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_explicit_default_browser_origin_port" {
  command = plan

  variables {
    browser_allowed_origins = ["https://app.example.com:443"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_uppercase_browser_origin_host" {
  command = plan

  variables {
    browser_allowed_origins = ["https://APP.example.com"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_numeric_browser_origin_host" {
  command = plan

  variables {
    browser_allowed_origins = ["https://127.0.0.01"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_hex_numeric_browser_origin_host" {
  command = plan

  variables {
    browser_allowed_origins = ["https://0x7f000001"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_decimal_numeric_browser_origin_final_label" {
  command = plan

  variables {
    browser_allowed_origins = ["https://example.01"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_hex_numeric_browser_origin_final_label" {
  command = plan

  variables {
    browser_allowed_origins = ["https://app.0x7f"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_bare_hex_browser_origin_host" {
  command = plan

  variables {
    browser_allowed_origins = ["https://0x"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_bare_hex_browser_origin_final_label" {
  command = plan

  variables {
    browser_allowed_origins = ["https://app.0x"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_too_many_ipv4_browser_origin_components" {
  command = plan

  variables {
    browser_allowed_origins = ["https://1.2.3.4.5"]
  }

  expect_failures = [var.browser_allowed_origins]
}

run "reject_browser_origin_path" {
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

run "accept_empty_browser_origins" {
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

run "accept_exactly_32_unique_browser_origins" {
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

run "accept_canonical_non_default_browser_origin_port" {
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

run "accept_numeric_non_final_browser_origin_label" {
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

run "accept_true_allow_null_browser_origin" {
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
