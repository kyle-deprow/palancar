mock_provider "azurerm" {
  mock_resource "azurerm_role_assignment" {
    defaults = {
      id = "/subscriptions/11111111-1111-1111-1111-111111111111/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    }
  }
}
mock_provider "azapi" {}

override_data {
  target = module.workload_key_vault.data.azurerm_client_config.current
  values = {
    tenant_id = "22222222-2222-2222-2222-222222222222"
  }
}

override_resource {
  target          = azurerm_resource_group.foundation
  override_during = plan
  values = {
    id = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234"
  }
}

override_resource {
  target          = module.container_registry.azurerm_container_registry.this
  override_during = plan
  values = {
    id           = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.ContainerRegistry/registries/palancardevacrtest1234"
    login_server = "palancardevacrtest1234.azurecr.io"
  }
}

override_resource {
  target          = module.workload_state.azurerm_storage_account.this
  override_during = plan
  values = {
    id                     = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.Storage/storageAccounts/palancardevstatetest1234"
    name                   = "palancardevstatetest1234"
    primary_table_endpoint = "https://palancardevstatetest1234.table.core.windows.net/"
  }
}

override_resource {
  target          = module.workload_state.azapi_resource.security
  override_during = plan
  values = {
    id   = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.Storage/storageAccounts/palancardevstatetest1234/tableServices/default/tables/SecurityState"
    name = "SecurityState"
  }
}

override_resource {
  target          = module.workload_state.azapi_resource.rate
  override_during = plan
  values = {
    id   = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.Storage/storageAccounts/palancardevstatetest1234/tableServices/default/tables/RateState"
    name = "RateState"
  }
}

override_resource {
  target          = module.container_app_environment.azurerm_container_app_environment.this
  override_during = plan
  values = {
    id             = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.App/managedEnvironments/cae-palancar-dev-test1234"
    name           = "cae-palancar-dev-test1234"
    default_domain = "example.azurecontainerapps.io"
  }
}

override_resource {
  target          = module.observability.azurerm_log_analytics_workspace.this
  override_during = plan
  values = {
    id = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.OperationalInsights/workspaces/law-palancar-dev-test1234"
  }
}

override_resource {
  target          = module.observability.azurerm_application_insights.this
  override_during = plan
  values = {
    id                = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.Insights/components/appi-palancar-dev-test1234"
    connection_string = "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://palancardev.in.applicationinsights.azure.com;LiveEndpoint=https://palancardev.livediagnostics.monitor.azure.com;ApplicationId=00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target          = module.identities_rbac.azurerm_user_assigned_identity.image_pull
  override_during = plan
  values = {
    id           = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull"
    client_id    = "88888888-8888-4888-8888-888888888888"
    principal_id = "99999999-9999-4999-8999-999999999999"
  }
}

override_resource {
  target          = module.foundry.azurerm_cognitive_account.this
  override_during = plan
  values = {
    id       = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.CognitiveServices/accounts/palancardevopenaitest1234"
    endpoint = "https://palancardev.openai.azure.com/"
  }
}

override_resource {
  target          = module.identities_rbac.azurerm_user_assigned_identity.runtime
  override_during = plan
  values = {
    id           = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime"
    principal_id = "11111111-1111-1111-1111-111111111111"
    client_id    = "77777777-7777-4777-8777-777777777777"
  }
}

override_resource {
  target          = module.workload_key_vault.azurerm_key_vault.this
  override_during = plan
  values = {
    id        = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.KeyVault/vaults/kvpalancardevtest1234"
    vault_uri = "https://kvpalancardevtest1234.vault.azure.net/"
  }
}

override_resource {
  target          = module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user[0]
  override_during = plan
  values = {
    id = "/subscriptions/11111111-1111-1111-1111-111111111111/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  }
}

variables {
  subscription_id = "11111111-1111-1111-1111-111111111111"
  tenant_id       = "22222222-2222-2222-2222-222222222222"
  location        = "eastus2"
  prefix          = "palancar"
  environment     = "dev"
  state_suffix    = "test1234"

  budget_amount     = 100
  budget_start_date = "2026-08-01T00:00:00Z"
  budget_end_date   = "2027-08-01T00:00:00Z"
  budget_contact_emails = [
    "zulu@relay.synthetic.example.net",
    "alpha@relay.synthetic.example.net",
  ]
  budget_forecast_threshold = 80

  workload_state_public_network_access_enabled = true
  retention_in_days                            = 30
  foundry_deployments                          = {}

  operator_principal_id                     = "33333333-3333-4333-8333-333333333333"
  acr_pull_role_definition_id               = "44444444-4444-4444-4444-444444444444"
  table_data_contributor_role_definition_id = "55555555-5555-5555-5555-555555555555"
  openai_user_role_definition_id            = "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"

  relay_image_digest          = ""
  expiry_cleanup_image_digest = ""
  deploy_relay_workload       = false
  relay_min_replicas          = 1

  browser_allowed_origins                = ["https://client.synthetic.invalid"]
  allow_null_browser_origin              = false
  enable_runtime_secrets_user_assignment = true
}

run "relay_runtime_contract_is_exact" {
  command = plan

  variables {
    foundry_deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
      "gpt-5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
    deploy_relay_workload                  = true
    relay_image_digest                     = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest            = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    enable_runtime_secrets_user_assignment = true
  }

  assert {
    condition     = local.required_foundry_deployments == var.foundry_deployments
    error_message = "relay-enabled plans must compare against the exact two-entry Foundry deployment contract"
  }

  assert {
    condition     = module.foundry.endpoint == "https://palancardev.openai.azure.com/"
    error_message = "the Foundry module must retain its exact HTTPS endpoint"
  }

  assert {
    condition     = sort(module.foundry.deployment_names) == sort(["gpt-4o-mini-transcribe", "gpt-5.6-luna"])
    error_message = "the Foundry module must retain exactly the transcription and Luna deployment names"
  }

  assert {
    condition = (
      local.relay_generation_endpoint == "https://palancardev.openai.azure.com" &&
      local.relay_generation_deployment == "gpt-5.6-luna" &&
      local.relay_transcription_provider == "azure-realtime" &&
      local.relay_transcription_endpoint == "wss://palancardev.openai.azure.com/openai/v1/realtime?intent=transcription" &&
      local.relay_transcription_deployment == "gpt-4o-mini-transcribe" &&
      local.relay_deployment_slot == "dev"
    )
    error_message = "the enabled relay must use the exact generation and realtime transcription contract"
  }

  assert {
    condition = (
      module.container_app_workload[0].name == local.names.relay_container_app &&
      output.runtime_identity_id == "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime" &&
      output.runtime_identity_client_id == "77777777-7777-4777-8777-777777777777"
    )
    error_message = "the enabled relay and runtime UAMI outputs must retain their exact reviewed identities"
  }

  assert {
    condition = (
      module.workload_key_vault.uri == "https://kvpalancardevtest1234.vault.azure.net/"
    )
    error_message = "the runtime Key Vault module must retain its URI while the role remains managed independently"
  }

  assert {
    condition = (
      var.enable_runtime_secrets_user_assignment == true &&
      module.workload_key_vault.runtime_secrets_user_role_assignment_id != null &&
      module.workload_key_vault.runtime_secrets_user_role_assignment_id == "/subscriptions/11111111-1111-1111-1111-111111111111/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    )
    error_message = "the runtime cutover must explicitly enable the indexed Key Vault Secrets User assignment and expose a non-null module output"
  }
}

run "runtime_secrets_assignment_cleanup_preserves_runtime_contract" {
  command = plan

  variables {
    foundry_deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
      "gpt-5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
    deploy_relay_workload                  = true
    relay_image_digest                     = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest            = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    enable_runtime_secrets_user_assignment = false
  }

  assert {
    condition = (
      var.enable_runtime_secrets_user_assignment == false &&
      module.workload_key_vault.runtime_secrets_user_role_assignment_id == null
    )
    error_message = "runtime assignment cleanup must omit the indexed Key Vault Secrets User assignment and produce a null module output"
  }

  assert {
    condition = (
      module.foundry.endpoint == "https://palancardev.openai.azure.com/" &&
      sort(module.foundry.deployment_names) == sort(["gpt-4o-mini-transcribe", "gpt-5.6-luna"]) &&
      local.relay_generation_endpoint == "https://palancardev.openai.azure.com" &&
      local.relay_generation_deployment == "gpt-5.6-luna" &&
      local.relay_transcription_provider == "azure-realtime" &&
      local.relay_transcription_endpoint == "wss://palancardev.openai.azure.com/openai/v1/realtime?intent=transcription" &&
      local.relay_transcription_deployment == "gpt-4o-mini-transcribe" &&
      local.relay_deployment_slot == "dev"
    )
    error_message = "disabling the runtime Key Vault assignment must preserve the exact Foundry, generation, and realtime transcription contract"
  }

  assert {
    condition = (
      output.runtime_identity_id == "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime" &&
      output.runtime_identity_client_id == "77777777-7777-4777-8777-777777777777" &&
      module.workload_key_vault.uri == "https://kvpalancardevtest1234.vault.azure.net/"
    )
    error_message = "disabling the runtime Key Vault assignment must preserve the runtime identity outputs and Key Vault URI"
  }
}

run "relay_rejects_missing_luna" {
  command = plan

  variables {
    foundry_deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
    deploy_relay_workload       = true
    relay_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [azurerm_resource_group.foundation]
}

run "relay_rejects_extra_deployment" {
  command = plan

  variables {
    foundry_deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
      "gpt-5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
      "gpt-4o-mini-transcribe-extra" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 2
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
    deploy_relay_workload       = true
    relay_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [azurerm_resource_group.foundation]
}

run "relay_rejects_luna_capacity_1000" {
  command = plan

  variables {
    foundry_deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
      "gpt-5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1000
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
    deploy_relay_workload       = true
    relay_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [azurerm_resource_group.foundation]
}

run "relay_rejects_luna_capacity_1012" {
  command = plan

  variables {
    foundry_deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
      "gpt-5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1012
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
    deploy_relay_workload       = true
    relay_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [azurerm_resource_group.foundation]
}

run "relay_rejects_luna_capacity_1014" {
  command = plan

  variables {
    foundry_deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
      "gpt-5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1014
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
    deploy_relay_workload       = true
    relay_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [azurerm_resource_group.foundation]
}

run "relay_rejects_wrong_luna_version" {
  command = plan

  variables {
    foundry_deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
      "gpt-5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-01-01"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
    deploy_relay_workload       = true
    relay_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [azurerm_resource_group.foundation]
}

run "relay_rejects_wrong_luna_sku" {
  command = plan

  variables {
    foundry_deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
      "gpt-5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "Standard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
    deploy_relay_workload       = true
    relay_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.foundry_deployments]
}

run "relay_rejects_wrong_luna_upgrade_option" {
  command = plan

  variables {
    foundry_deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
      "gpt-5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "Once"
      }
    }
    deploy_relay_workload       = true
    relay_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.foundry_deployments]
}

run "relay_action_group_contract_is_exact" {
  command = plan

  assert {
    condition     = local.relay_action_group_id == "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.Insights/actionGroups/ag-palancar-dev-relay-test1234"
    error_message = "relay_action_group_id must be the exact plan-known ID built only from inputs and locals"
  }

  assert {
    condition     = output.relay_action_group_id == "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev-test1234/providers/Microsoft.Insights/actionGroups/ag-palancar-dev-relay-test1234"
    error_message = "the root action-group output must expose the exact plan-known ID"
  }

  assert {
    condition = (
      azurerm_monitor_action_group.relay.name == "ag-palancar-dev-relay-test1234" &&
      azurerm_monitor_action_group.relay.resource_group_name == "rg-palancar-dev-test1234" &&
      azurerm_monitor_action_group.relay.short_name == "r-test1234" &&
      azurerm_monitor_action_group.relay.enabled == true &&
      azurerm_monitor_action_group.relay.location == "global" &&
      length(azurerm_monitor_action_group.relay.tags) == 4 &&
      azurerm_monitor_action_group.relay.tags["application"] == "palancar" &&
      azurerm_monitor_action_group.relay.tags["environment"] == "dev" &&
      azurerm_monitor_action_group.relay.tags["managed-by"] == "terraform" &&
      azurerm_monitor_action_group.relay.tags["data-classification"] == "operational-metadata"
    )
    error_message = "the relay action group must use the exact reviewed name, short name, global location, enabled state, resource group, and tags"
  }

  assert {
    condition = (
      length(azurerm_monitor_action_group.relay.email_receiver) == 2 &&
      {
        for receiver in azurerm_monitor_action_group.relay.email_receiver : receiver.name => {
          email_address           = receiver.email_address
          use_common_alert_schema = receiver.use_common_alert_schema
        }
        } == {
        budget-contact-0001 = {
          email_address           = "alpha@relay.synthetic.example.net"
          use_common_alert_schema = true
        }
        budget-contact-0002 = {
          email_address           = "zulu@relay.synthetic.example.net"
          use_common_alert_schema = true
        }
      }
    )
    error_message = "email receivers must map sorted contacts to exact stable ordinal names with common alert schema enabled"
  }

  assert {
    condition = (
      length(azurerm_monitor_action_group.relay.arm_role_receiver) == 0 &&
      length(azurerm_monitor_action_group.relay.automation_runbook_receiver) == 0 &&
      length(azurerm_monitor_action_group.relay.azure_app_push_receiver) == 0 &&
      length(azurerm_monitor_action_group.relay.azure_function_receiver) == 0 &&
      length(azurerm_monitor_action_group.relay.event_hub_receiver) == 0 &&
      length(azurerm_monitor_action_group.relay.itsm_receiver) == 0 &&
      length(azurerm_monitor_action_group.relay.logic_app_receiver) == 0 &&
      length(azurerm_monitor_action_group.relay.sms_receiver) == 0 &&
      length(azurerm_monitor_action_group.relay.voice_receiver) == 0 &&
      length(azurerm_monitor_action_group.relay.webhook_receiver) == 0
    )
    error_message = "the relay action group must configure no non-email receiver type"
  }
}

run "embedded_tab_contact_is_invalid" {
  command = plan

  variables {
    budget_contact_emails = ["embedded\twhitespace@relay.synthetic.example.net"]
  }

  expect_failures = [var.budget_contact_emails]
}

run "embedded_newline_contact_is_invalid" {
  command = plan

  variables {
    budget_contact_emails = ["embedded\nwhitespace@relay.synthetic.example.net"]
  }

  expect_failures = [var.budget_contact_emails]
}
