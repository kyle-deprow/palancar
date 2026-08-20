mock_provider "azurerm" {}
mock_provider "azapi" {}

override_data {
  target = module.workload_key_vault.data.azurerm_client_config.current
  values = {
    tenant_id = "22222222-2222-2222-2222-222222222222"
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
  openai_user_role_definition_id            = "66666666-6666-6666-6666-666666666666"

  relay_image_digest          = ""
  expiry_cleanup_image_digest = ""
  deploy_relay_workload       = false
  relay_min_replicas          = 1

  browser_allowed_origins   = ["https://client.synthetic.invalid"]
  allow_null_browser_origin = false

  enable_litellm_sidecar = false
  litellm_image_digest   = ""
  litellm_backend        = ""
  litellm_upstream_model = ""

  openrouter_api_key_secret_url = ""
  litellm_master_key_secret_url = ""
  azure_api_base                = ""
  azure_api_version             = ""
}

run "relay_accepts_exact_foundry_deployments" {
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
    deploy_relay_workload         = true
    relay_image_digest            = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest   = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    enable_litellm_sidecar        = true
    litellm_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_backend               = "openrouter"
    litellm_upstream_model        = "openrouter/openai/gpt-5.6-luna"
    openrouter_api_key_secret_url = "https://vault.synthetic.invalid/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://vault.synthetic.invalid/secrets/litellm-master-key"
  }

  assert {
    condition     = local.required_foundry_deployments == var.foundry_deployments
    error_message = "relay-enabled plans must compare against the exact two-entry Foundry deployment contract"
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
    deploy_relay_workload         = true
    relay_image_digest            = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest   = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    enable_litellm_sidecar        = true
    litellm_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_backend               = "openrouter"
    litellm_upstream_model        = "openrouter/openai/gpt-5.6-luna"
    openrouter_api_key_secret_url = "https://vault.synthetic.invalid/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://vault.synthetic.invalid/secrets/litellm-master-key"
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
    deploy_relay_workload         = true
    relay_image_digest            = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest   = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    enable_litellm_sidecar        = true
    litellm_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_backend               = "openrouter"
    litellm_upstream_model        = "openrouter/openai/gpt-5.6-luna"
    openrouter_api_key_secret_url = "https://vault.synthetic.invalid/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://vault.synthetic.invalid/secrets/litellm-master-key"
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
    deploy_relay_workload         = true
    relay_image_digest            = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest   = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    enable_litellm_sidecar        = true
    litellm_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_backend               = "openrouter"
    litellm_upstream_model        = "openrouter/openai/gpt-5.6-luna"
    openrouter_api_key_secret_url = "https://vault.synthetic.invalid/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://vault.synthetic.invalid/secrets/litellm-master-key"
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
    deploy_relay_workload         = true
    relay_image_digest            = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest   = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    enable_litellm_sidecar        = true
    litellm_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_backend               = "openrouter"
    litellm_upstream_model        = "openrouter/openai/gpt-5.6-luna"
    openrouter_api_key_secret_url = "https://vault.synthetic.invalid/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://vault.synthetic.invalid/secrets/litellm-master-key"
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
    deploy_relay_workload         = true
    relay_image_digest            = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest   = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    enable_litellm_sidecar        = true
    litellm_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_backend               = "openrouter"
    litellm_upstream_model        = "openrouter/openai/gpt-5.6-luna"
    openrouter_api_key_secret_url = "https://vault.synthetic.invalid/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://vault.synthetic.invalid/secrets/litellm-master-key"
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
    deploy_relay_workload         = true
    relay_image_digest            = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest   = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    enable_litellm_sidecar        = true
    litellm_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_backend               = "openrouter"
    litellm_upstream_model        = "openrouter/openai/gpt-5.6-luna"
    openrouter_api_key_secret_url = "https://vault.synthetic.invalid/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://vault.synthetic.invalid/secrets/litellm-master-key"
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
    deploy_relay_workload         = true
    relay_image_digest            = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest   = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    enable_litellm_sidecar        = true
    litellm_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_backend               = "openrouter"
    litellm_upstream_model        = "openrouter/openai/gpt-5.6-luna"
    openrouter_api_key_secret_url = "https://vault.synthetic.invalid/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://vault.synthetic.invalid/secrets/litellm-master-key"
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
    deploy_relay_workload         = true
    relay_image_digest            = "palancardevacrtest1234.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    expiry_cleanup_image_digest   = "palancardevacrtest1234.azurecr.io/palancar-expiry-cleanup@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    enable_litellm_sidecar        = true
    litellm_image_digest          = "palancardevacrtest1234.azurecr.io/palancar-litellm-proxy@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    litellm_backend               = "openrouter"
    litellm_upstream_model        = "openrouter/openai/gpt-5.6-luna"
    openrouter_api_key_secret_url = "https://vault.synthetic.invalid/secrets/openrouter-api-key"
    litellm_master_key_secret_url = "https://vault.synthetic.invalid/secrets/litellm-master-key"
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
