resource "azurerm_resource_group" "foundation" {
  name     = local.names.resource_group
  location = var.location
  tags     = local.tags

  lifecycle {
    precondition {
      condition = var.deploy_relay_workload ? (
        trimspace(var.relay_image_digest) != "" &&
        can(regex(
          "^${local.names.acr}\\.azurecr\\.io/palancar-relay@sha256:[0-9a-f]{64}$",
          var.relay_image_digest
        )) &&
        trimspace(var.expiry_cleanup_image_digest) != "" &&
        can(regex(
          "^${local.names.acr}\\.azurecr\\.io/palancar-expiry-cleanup@sha256:[0-9a-f]{64}$",
          var.expiry_cleanup_image_digest
        )) &&
        var.foundry_deployments == local.required_foundry_deployments
        ) : (
        var.relay_image_digest == "" &&
        var.expiry_cleanup_image_digest == ""
      )
      error_message = "A deployed relay requires same-ACR relay and cleanup digests plus the exact two-entry Foundry deployment contract; disabled workloads require empty image values."
    }

    precondition {
      condition = !var.deploy_relay_workload || (
        length(local.names.relay_container_app) >= 2 &&
        length(local.names.relay_container_app) <= 32 &&
        can(regex("^[a-z0-9]+(?:-[a-z0-9]+)*$", local.names.relay_container_app)) &&
        !strcontains(local.names.relay_container_app, "--") &&
        length(local.names.expiry_cleanup_job) >= 2 &&
        length(local.names.expiry_cleanup_job) <= 32 &&
        can(regex("^[a-z0-9]+(?:-[a-z0-9]+)*$", local.names.expiry_cleanup_job)) &&
        !strcontains(local.names.expiry_cleanup_job, "--")
      )
      error_message = "Deployed relay Container App and cleanup Job names must be 2-32 lower-case alphanumeric characters with single internal hyphens only."
    }

    precondition {
      condition = !var.deploy_relay_workload || (
        var.foundry_deployments == local.required_foundry_deployments
      )
      error_message = "A deployed relay requires var.foundry_deployments to equal exactly the two-entry map of pinned gpt-4o-mini-transcribe and gpt-5.6-luna Foundry deployments: transcription version 2025-12-15 and Luna version 2026-07-09, both OpenAI GlobalStandard with capacities 1 and 1013 respectively, and NoAutoUpgrade."
    }

    precondition {
      condition = var.deploy_relay_workload ? (
        local.relay_transcription_provider == "azure-realtime" &&
        local.relay_transcription_deployment == "gpt-4o-mini-transcribe" &&
        local.relay_deployment_slot == "dev"
        ) : (
        local.relay_transcription_provider == "" &&
        local.relay_transcription_deployment == "" &&
        local.relay_deployment_slot == ""
      )
      error_message = "The relay transcription/provider fields must be the exact Azure realtime configuration when enabled and exact empty strings when disabled."
    }
  }
}

module "budget" {
  source = "../../modules/budget"

  name               = "budget-${var.prefix}-${var.environment}"
  resource_group_id  = azurerm_resource_group.foundation.id
  amount             = var.budget_amount
  start_date         = var.budget_start_date
  end_date           = var.budget_end_date
  contact_emails     = var.budget_contact_emails
  forecast_threshold = var.budget_forecast_threshold
}

module "observability" {
  source = "../../modules/observability"

  workspace_name            = local.names.log_analytics
  application_insights_name = local.names.application_insights
  resource_group_name       = azurerm_resource_group.foundation.name
  location                  = var.location
  retention_in_days         = var.retention_in_days
  tags                      = local.tags
  alerts_enabled            = true
  alert_action_group_ids    = [local.relay_action_group_id]

  depends_on = [azurerm_monitor_action_group.relay]
}

module "workload_state" {
  source = "../../modules/workload-state"

  name                          = local.names.workload_state
  resource_group_name           = azurerm_resource_group.foundation.name
  location                      = var.location
  public_network_access_enabled = var.workload_state_public_network_access_enabled
  tags                          = local.tags
}

module "container_registry" {
  source = "../../modules/container-registry"

  name                = local.names.acr
  resource_group_name = azurerm_resource_group.foundation.name
  location            = var.location
  tags                = local.tags
}

module "container_app_environment" {
  source = "../../modules/container-app-environment"

  name                       = local.names.container_environment
  resource_group_name        = azurerm_resource_group.foundation.name
  location                   = var.location
  log_analytics_workspace_id = module.observability.workspace_id
  tags                       = local.tags
}

module "foundry" {
  source = "../../modules/foundry"

  name                  = local.names.foundry
  custom_subdomain_name = local.names.foundry
  resource_group_name   = azurerm_resource_group.foundation.name
  location              = var.location
  tags                  = local.tags
  deployments           = var.foundry_deployments

  # Budget and observability/state foundation precede model deployments.
  depends_on = [module.budget, module.observability, module.workload_state, module.container_registry, module.container_app_environment]
}

module "identities_rbac" {
  source = "../../modules/identities-rbac"

  subscription_id                           = var.subscription_id
  resource_group_name                       = azurerm_resource_group.foundation.name
  location                                  = var.location
  prefix                                    = var.prefix
  environment                               = var.environment
  tags                                      = local.tags
  container_registry_id                     = module.container_registry.id
  workload_state_storage_account_id         = module.workload_state.storage_account_id
  security_state_table_id                   = module.workload_state.security_state_id
  rate_state_table_id                       = module.workload_state.rate_state_id
  operator_principal_id                     = var.operator_principal_id
  cognitive_account_id                      = module.foundry.account_id
  application_insights_id                   = module.observability.application_insights_id
  acr_pull_role_definition_id               = var.acr_pull_role_definition_id
  table_data_contributor_role_definition_id = var.table_data_contributor_role_definition_id
  openai_user_role_definition_id            = var.openai_user_role_definition_id
}

module "workload_key_vault" {
  source = "../../modules/workload-key-vault"

  name                                   = substr("kv${local.name_seed}${local.suffix}", 0, 24)
  resource_group_name                    = azurerm_resource_group.foundation.name
  location                               = var.location
  tags                                   = local.tags
  runtime_principal_id                   = module.identities_rbac.runtime_principal_id
  enable_runtime_secrets_user_assignment = var.enable_runtime_secrets_user_assignment
}

module "container_app_workload" {
  count  = var.deploy_relay_workload ? 1 : 0
  source = "../../modules/container-app-workload"

  name                                                    = local.names.relay_container_app
  resource_group_id                                       = azurerm_resource_group.foundation.id
  location                                                = var.location
  tags                                                    = local.tags
  container_app_environment_id                            = module.container_app_environment.id
  image_digest                                            = var.relay_image_digest
  acr_login_server                                        = module.container_registry.login_server
  image_pull_identity_id                                  = module.identities_rbac.image_pull_identity_id
  runtime_identity_id                                     = module.identities_rbac.runtime_identity_id
  runtime_identity_client_id                              = module.identities_rbac.runtime_client_id
  workload_table_endpoint                                 = module.workload_state.table_endpoint
  security_state_table_name                               = module.workload_state.security_state_name
  rate_state_table_name                                   = module.workload_state.rate_state_name
  environment                                             = var.environment
  relay_origin                                            = local.relay_origin
  min_replicas                                            = var.relay_min_replicas
  browser_allowed_origins                                 = var.browser_allowed_origins
  allow_null_browser_origin                               = var.allow_null_browser_origin
  security_mode                                           = "azure-table"
  transcription_provider                                  = local.relay_transcription_provider
  azure_transcription_endpoint                            = local.relay_transcription_endpoint
  azure_transcription_deployment                          = local.relay_transcription_deployment
  deployment_slot                                         = local.relay_deployment_slot
  language_boundary_mode                                  = "development-provisional"
  application_insights_connection_string                  = module.observability.application_insights_connection_string
  azure_generation_endpoint                               = local.relay_generation_endpoint
  azure_generation_deployment                             = local.relay_generation_deployment
  runtime_openai_user_role_assignment_id                  = module.identities_rbac.runtime_openai_user_role_assignment_id
  runtime_monitoring_metrics_publisher_role_assignment_id = module.identities_rbac.runtime_application_insights_role_assignment_id

  depends_on = [module.identities_rbac, module.foundry]
}

module "expiry_cleanup_job" {
  count  = var.deploy_relay_workload ? 1 : 0
  source = "../../modules/expiry-cleanup-job"

  name                         = local.names.expiry_cleanup_job
  resource_group_id            = azurerm_resource_group.foundation.id
  location                     = var.location
  tags                         = local.tags
  container_app_environment_id = module.container_app_environment.id
  image_digest                 = var.expiry_cleanup_image_digest
  acr_login_server             = module.container_registry.login_server
  image_pull_identity_id       = module.identities_rbac.image_pull_identity_id
  runtime_identity_id          = module.identities_rbac.runtime_identity_id
  runtime_identity_client_id   = module.identities_rbac.runtime_client_id
  workload_table_endpoint      = trimsuffix(module.workload_state.table_endpoint, "/")
  security_state_table_name    = module.workload_state.security_state_name
  rate_state_table_name        = module.workload_state.rate_state_name
  environment                  = var.environment
  relay_origin                 = local.relay_origin
  cleanup_limit                = 1000
  cleanup_timeout_ms           = 240000

  depends_on = [module.identities_rbac]
}
