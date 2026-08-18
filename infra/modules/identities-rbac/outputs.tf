output "image_pull_identity_id" {
  description = "Image-pull user-assigned identity resource ID."
  value       = azurerm_user_assigned_identity.image_pull.id
}

output "image_pull_client_id" {
  description = "Image-pull user-assigned identity client ID."
  value       = azurerm_user_assigned_identity.image_pull.client_id
}

output "image_pull_principal_id" {
  description = "Image-pull user-assigned identity principal ID."
  value       = azurerm_user_assigned_identity.image_pull.principal_id
}

output "runtime_identity_id" {
  description = "Runtime user-assigned identity resource ID."
  value       = azurerm_user_assigned_identity.runtime.id
}

output "runtime_client_id" {
  description = "Runtime user-assigned identity client ID."
  value       = azurerm_user_assigned_identity.runtime.client_id
}

output "runtime_principal_id" {
  description = "Runtime user-assigned identity principal ID."
  value       = azurerm_user_assigned_identity.runtime.principal_id
}

output "operator_security_table_role_assignment_id" {
  description = "SecurityState-scoped Storage Table Data Contributor assignment for the smoke-test operator."
  value       = azurerm_role_assignment.operator_security_table.id
}

output "operator_rate_table_role_assignment_id" {
  description = "RateState-scoped Storage Table Data Contributor assignment for the smoke-test operator."
  value       = azurerm_role_assignment.operator_rate_table.id
}
