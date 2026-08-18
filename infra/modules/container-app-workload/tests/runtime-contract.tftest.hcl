mock_provider "azapi" {}

variables {
  name                                    = "ca-palancar-dev-relay-test"
  resource_group_id                       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev"
  resource_group_name                     = "rg-palancar-dev"
  location                                = "eastus2"
  tags                                    = { test = "runtime-contract" }
  container_app_environment_id            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae-palancar-dev"
  image_digest                            = "palancardev.azurecr.io/palancar-relay@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  acr_login_server                        = "palancardev.azurecr.io"
  image_pull_identity_id                  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull"
  runtime_identity_id                     = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime"
  runtime_identity_client_id              = "00000000-0000-0000-0000-000000000001"
  runtime_secrets_user_role_assignment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000002"
  workload_table_endpoint                 = "https://palancardev.table.core.windows.net/"
  security_state_table_name               = "SecurityState"
  rate_state_table_name                   = "RateState"
  environment                             = "dev"
  relay_origin                            = "wss://ca-palancar-dev-relay-test.example.azurecontainerapps.io"
  key_vault_uri                           = "https://palancar-vault.vault.azure.net/"
}

run "disabled_sidecar_is_empty_and_scale_to_zero" {
  command = plan

  assert {
    condition     = azapi_resource.this.body.properties.template.scale.minReplicas == 0
    error_message = "the relay must scale to zero by default"
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
    condition     = azapi_resource.this.body.properties.template.containers[1].image == "palancardev.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    error_message = "the LiteLLM image must be an immutable digest in the relay ACR"
  }

  assert {
    condition = azapi_resource.this.body.properties.template.containers[1].env == [
      { name = "PALANCAR_LITELLM_BACKEND", value = "openrouter" },
      { name = "PALANCAR_LITELLM_UPSTREAM_MODEL", value = "openrouter/openai/gpt-4o-mini" },
      { name = "LITELLM_MASTER_KEY", secretRef = "litellm-master-key" },
      { name = "OPENROUTER_API_KEY", secretRef = "openrouter-api-key" },
    ]
    error_message = "the LiteLLM sidecar must emit only the qualified OpenRouter environment"
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.scale.minReplicas == 1
    error_message = "one warm replica must remain an exact supported option"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.configuration.ingress) == jsonencode({
      external      = true
      targetPort    = 8787
      transport     = "http"
      allowInsecure = false
      traffic       = [{ latestRevision = true, weight = 100 }]
    })
    error_message = "ingress must be exact external HTTP on 8787 with only latest-revision traffic"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.template.containers[0].probes) == jsonencode([
      {
        type                = "Liveness"
        httpGet             = { path = "/healthz", port = 8787 }
        initialDelaySeconds = 10
        periodSeconds       = 10
        timeoutSeconds      = 3
        failureThreshold    = 3
      },
      {
        type                = "Readiness"
        httpGet             = { path = "/readyz", port = 8787 }
        initialDelaySeconds = 5
        periodSeconds       = 5
        timeoutSeconds      = 3
        failureThreshold    = 3
      },
    ])
    error_message = "relay probes must match the exact HTTP contract"
  }

  assert {
    condition = jsonencode(azapi_resource.this.body.properties.template.containers[1].probes) == jsonencode([
      {
        type                = "Startup"
        httpGet             = { path = "/health/liveliness", port = 4000 }
        initialDelaySeconds = 10
        periodSeconds       = 10
        timeoutSeconds      = 3
        failureThreshold    = 10
      },
      {
        type             = "Liveness"
        httpGet          = { path = "/health/liveliness", port = 4000 }
        periodSeconds    = 30
        timeoutSeconds   = 3
        failureThreshold = 3
      },
      {
        type             = "Readiness"
        httpGet          = { path = "/health/readiness", port = 4000 }
        periodSeconds    = 10
        timeoutSeconds   = 3
        failureThreshold = 3
      },
    ])
    error_message = "LiteLLM probes must match the exact HTTP contract"
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

  expect_failures = [azapi_resource.this]
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

run "reject_azure_transcription" {
  command = plan

  variables {
    transcription_provider         = "azure"
    azure_transcription_endpoint   = "https://fixture.invalid"
    azure_transcription_deployment = "fixture"
  }

  expect_failures = [azapi_resource.this]
}

run "reject_invalid_minimum" {
  command = plan

  variables {
    min_replicas = 2
  }

  expect_failures = [var.min_replicas]
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
