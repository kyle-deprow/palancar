resource "azurerm_resource_group" "foundation" {
  name     = local.names.resource_group
  location = var.location
  tags     = local.tags
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
  cognitive_account_id                      = module.foundry.account_id
  acr_pull_role_definition_id               = var.acr_pull_role_definition_id
  table_data_contributor_role_definition_id = var.table_data_contributor_role_definition_id
  openai_user_role_definition_id            = var.openai_user_role_definition_id
}

module "workload_key_vault" {
  source = "../../modules/workload-key-vault"

  name                 = substr("kv${local.name_seed}${local.suffix}", 0, 24)
  resource_group_name  = azurerm_resource_group.foundation.name
  location             = var.location
  tags                 = local.tags
  runtime_principal_id = module.identities_rbac.runtime_principal_id

  depends_on = [module.identities_rbac]
}

module "container_app_workload" {
  count  = var.deploy_relay_workload ? 1 : 0
  source = "../../modules/container-app-workload"

  name                                    = local.names.relay_container_app
  resource_group_id                       = azurerm_resource_group.foundation.id
  resource_group_name                     = azurerm_resource_group.foundation.name
  location                                = var.location
  tags                                    = local.tags
  container_app_environment_id            = module.container_app_environment.id
  image_digest                            = var.relay_image_digest
  acr_login_server                        = module.container_registry.login_server
  image_pull_identity_id                  = module.identities_rbac.image_pull_identity_id
  runtime_identity_id                     = module.identities_rbac.runtime_identity_id
  runtime_identity_client_id              = module.identities_rbac.runtime_client_id
  workload_table_endpoint                 = module.workload_state.table_endpoint
  security_state_table_name               = module.workload_state.security_state_name
  rate_state_table_name                   = module.workload_state.rate_state_name
  foundry_endpoint                        = module.foundry.endpoint
  foundry_deployment_names                = sort(keys(var.foundry_deployments))
  environment                             = var.environment
  relay_origin                            = local.relay_origin
  enable_litellm_sidecar                  = var.enable_litellm_sidecar
  litellm_image_digest                    = var.litellm_image_digest
  litellm_backend                         = var.litellm_backend
  litellm_upstream_model                  = var.litellm_upstream_model
  openrouter_api_key_secret_url           = var.openrouter_api_key_secret_url
  litellm_master_key_secret_url           = var.litellm_master_key_secret_url
  azure_api_base                          = var.azure_api_base
  azure_api_version                       = var.azure_api_version
  azure_api_key_secret_url                = var.azure_api_key_secret_url
  litellm_cpu                             = var.litellm_cpu
  litellm_memory                          = var.litellm_memory
  runtime_secrets_user_role_assignment_id = module.workload_key_vault.runtime_secrets_user_role_assignment_id

  depends_on = [module.identities_rbac]
}
