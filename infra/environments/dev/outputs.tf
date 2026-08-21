output "resource_group_name" {
  description = "Development foundation resource group."
  value       = azurerm_resource_group.foundation.name
}

output "resource_group_id" {
  description = "Development foundation resource group ID."
  value       = azurerm_resource_group.foundation.id
}

output "relay_action_group_id" {
  description = "Azure Monitor action group ID for relay operational alerts."
  value       = local.relay_action_group_id
}

output "relay_alert_rule_ids" {
  description = "Scheduled query alert IDs keyed by relay operational signal."
  value       = module.observability.relay_alert_rule_ids
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
  description = "Reviewed Foundry deployment names."
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

output "runtime_openai_user_role_assignment_id" {
  description = "Cognitive Services OpenAI User role assignment ID for the runtime identity."
  value       = module.identities_rbac.runtime_openai_user_role_assignment_id
}

output "runtime_application_insights_role_assignment_id" {
  description = "Application Insights-scoped Monitoring Metrics Publisher role assignment ID for the runtime identity."
  value       = module.identities_rbac.runtime_application_insights_role_assignment_id
}

output "operator_security_table_role_assignment_id" {
  description = "SecurityState-scoped Storage Table Data Contributor assignment for the smoke-test operator."
  value       = module.identities_rbac.operator_security_table_role_assignment_id
}

output "operator_rate_table_role_assignment_id" {
  description = "RateState-scoped Storage Table Data Contributor assignment for the smoke-test operator."
  value       = module.identities_rbac.operator_rate_table_role_assignment_id
}

output "key_vault_name" {
  description = "Workload Key Vault name."
  value       = module.workload_key_vault.name
}

output "key_vault_id" {
  description = "Workload Key Vault resource ID."
  value       = module.workload_key_vault.id
}

output "key_vault_uri" {
  description = "Workload Key Vault URI."
  value       = module.workload_key_vault.uri
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

output "relay_container_app_name" {
  description = "Relay Container App name when the workload is deployed."
  value       = var.deploy_relay_workload ? module.container_app_workload[0].name : null
}

output "relay_container_app_id" {
  description = "Relay Container App ARM resource ID when the workload is deployed."
  value       = var.deploy_relay_workload ? module.container_app_workload[0].id : null
}

output "relay_origin" {
  description = "Deterministic Azure-provided relay WebSocket origin when the workload is deployed."
  value       = var.deploy_relay_workload ? local.relay_origin : null
}

output "relay_latest_revision_name" {
  description = "Latest relay Container App revision name when the workload is deployed."
  value       = var.deploy_relay_workload ? module.container_app_workload[0].latest_revision_name : null
}

output "expiry_cleanup_job_name" {
  description = "Expiry cleanup Container Apps Job name when the workload is deployed."
  value       = var.deploy_relay_workload ? module.expiry_cleanup_job[0].name : null
}

output "expiry_cleanup_job_id" {
  description = "Expiry cleanup Container Apps Job ARM resource ID when the workload is deployed."
  value       = var.deploy_relay_workload ? module.expiry_cleanup_job[0].id : null
}
