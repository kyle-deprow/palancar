output "state_resource_group_name" {
  description = "Resource group containing the Terraform state account."
  value       = azurerm_resource_group.state.name
}

output "state_storage_account_name" {
  description = "Storage account name for the Entra-authenticated Terraform backend."
  value       = azurerm_storage_account.state.name
}

output "state_storage_account_id" {
  description = "Storage account resource ID."
  value       = azurerm_storage_account.state.id
}

output "bootstrap_state_container_name" {
  description = "Private blob container dedicated to bootstrap state."
  value       = azurerm_storage_container.bootstrap.name
}

output "dev_state_container_name" {
  description = "Private blob container dedicated to development state."
  value       = azurerm_storage_container.dev.name
}

output "bootstrap_state_key" {
  description = "Stable backend key for this bootstrap state."
  value       = "bootstrap/terraform.tfstate"
}

output "dev_state_key" {
  description = "Stable backend key reserved for the development foundation state."
  value       = "dev/terraform.tfstate"
}

output "state_suffix" {
  description = "Effective deterministic naming suffix."
  value       = local.suffix
}
