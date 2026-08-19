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

  assert {
    condition = azapi_resource.this.body.properties.template.containers[0].env[13] == {
      name  = "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON"
      value = "[\"https://even-webview.synthetic.invalid\"]"
    }
    error_message = "the relay must emit the exact fail-closed browser origin JSON default"
  }

  assert {
    condition = azapi_resource.this.body.properties.template.containers[0].env[14] == {
      name  = "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN"
      value = "false"
    }
    error_message = "the relay must reject null browser origins by default"
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
    condition = azapi_resource.this.body.properties.template.containers[0].env[9] == {
      name  = "PALANCAR_WORKLOAD_TABLE_ENDPOINT"
      value = "https://palancardev.table.core.windows.net"
    }
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
        type                = "Liveness"
        httpGet             = { path = "/health/liveliness", port = 4000 }
        initialDelaySeconds = 10
        periodSeconds       = 30
        timeoutSeconds      = 3
        failureThreshold    = 3
      },
      {
        type             = "Readiness"
        httpGet          = { path = "/health/readiness", port = 4000 }
        periodSeconds    = 10
        timeoutSeconds   = 3
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

run "reject_case_only_duplicate_identities" {
  command = plan

  variables {
    runtime_identity_id = "/SUBSCRIPTIONS/00000000-0000-0000-0000-000000000000/RESOURCEGROUPS/RG-PALANCAR-DEV/PROVIDERS/MICROSOFT.MANAGEDIDENTITY/USERASSIGNEDIDENTITIES/ID-PALANCAR-DEV-IMAGE-PULL"
  }

  expect_failures = [azapi_resource.this]
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
    condition     = azapi_resource.this.body.properties.template.containers[0].env[13].value == "[\"https://even-webview.synthetic.invalid\"]"
    error_message = "explicit null must resolve to the non-null browser origin default"
  }
}

run "explicit_null_allow_null_browser_origin_uses_default" {
  command = plan

  variables {
    allow_null_browser_origin = null
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].env[14].value == "false"
    error_message = "explicit null must resolve to the non-null null-origin default"
  }
}

run "accept_empty_browser_origins" {
  command = plan

  variables {
    browser_allowed_origins = []
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].env[13].value == "[]"
    error_message = "an empty browser origin list must serialize as an empty JSON array"
  }
}

run "accept_exactly_32_unique_browser_origins" {
  command = plan

  variables {
    browser_allowed_origins = [for index in range(32) : "https://app-${index}.example.com"]
  }

  assert {
    condition = jsondecode(azapi_resource.this.body.properties.template.containers[0].env[13].value) == [
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
    condition     = azapi_resource.this.body.properties.template.containers[0].env[13].value == "[\"https://app.example.com:8443\"]"
    error_message = "a canonical non-default browser origin port must serialize unchanged"
  }
}

run "accept_numeric_non_final_browser_origin_label" {
  command = plan

  variables {
    browser_allowed_origins = ["https://1.example.com"]
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].env[13].value == "[\"https://1.example.com\"]"
    error_message = "a numeric non-final DNS label must serialize unchanged"
  }
}

run "accept_true_allow_null_browser_origin" {
  command = plan

  variables {
    allow_null_browser_origin = true
  }

  assert {
    condition     = azapi_resource.this.body.properties.template.containers[0].env[14].value == "true"
    error_message = "allow_null_browser_origin=true must serialize exactly as true"
  }
}
