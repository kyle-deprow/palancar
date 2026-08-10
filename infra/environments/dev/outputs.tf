output "resource_group_name" {
  description = "Development foundation resource group."
  value       = azurerm_resource_group.foundation.name
}

output "resource_group_id" {
  description = "Development foundation resource group ID."
  value       = azurerm_resource_group.foundation.id
}

output "region" {
  description = "Development foundation region."
  value       = var.location
}

output "acr_login_server" {
  description = "ACR login server for a later immutable relay image."
  value       = module.container_registry.login_server
}

output "acr_id" {
  description = "ACR resource ID."
  value       = module.container_registry.id
}

output "container_app_environment_id" {
  description = "Empty Consumption Container Apps environment ID."
  value       = module.container_app_environment.id
}

output "container_app_environment_name" {
  description = "Consumption Container Apps environment name."
  value       = module.container_app_environment.name
}

output "container_app_environment_default_domain" {
  description = "Azure-provided Container Apps environment default domain."
  value       = module.container_app_environment.default_domain
}

output "workload_table_endpoint" {
  description = "Workload Table endpoint; no key is exposed."
  value       = module.workload_state.table_endpoint
}

output "security_state_table_name" {
  description = "SecurityState table name."
  value       = module.workload_state.security_state_name
}

output "rate_state_table_name" {
  description = "RateState table name."
  value       = module.workload_state.rate_state_name
}

output "security_state_table_id" {
  description = "SecurityState table ID."
  value       = module.workload_state.security_state_id
}

output "rate_state_table_id" {
  description = "RateState table ID."
  value       = module.workload_state.rate_state_id
}

output "foundry_endpoint" {
  description = "Foundry/OpenAI endpoint."
  value       = module.foundry.endpoint
}

output "foundry_account_id" {
  description = "Foundry/OpenAI account ID."
  value       = module.foundry.account_id
}

output "foundry_deployment_names" {
  description = "Pinned Foundry deployment names."
  value       = module.foundry.deployment_names
}

output "runtime_identity_client_id" {
  description = "Runtime managed identity client ID."
  value       = module.identities_rbac.runtime_client_id
}

output "runtime_identity_id" {
  description = "Runtime managed identity resource ID."
  value       = module.identities_rbac.runtime_identity_id
}

output "image_pull_identity_id" {
  description = "Image-pull managed identity resource ID."
  value       = module.identities_rbac.image_pull_identity_id
}

output "application_insights_connection_string" {
  description = "Workspace-based Application Insights connection string. Treat as sensitive application configuration."
  value       = module.observability.application_insights_connection_string
  sensitive   = true
}
