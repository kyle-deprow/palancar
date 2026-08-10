output "storage_account_id" {
  description = "Workload-state storage account ID."
  value       = azurerm_storage_account.this.id
}

output "storage_account_name" {
  description = "Workload-state storage account name."
  value       = azurerm_storage_account.this.name
}

output "table_endpoint" {
  description = "Azure Table endpoint; no key is exposed."
  value       = azurerm_storage_account.this.primary_table_endpoint
}

output "security_state_id" {
  description = "SecurityState table resource ID."
  value       = azapi_resource.security.id
}

output "security_state_name" {
  description = "SecurityState table name."
  value       = azapi_resource.security.name
}

output "rate_state_id" {
  description = "RateState table resource ID."
  value       = azapi_resource.rate.id
}

output "rate_state_name" {
  description = "RateState table name."
  value       = azapi_resource.rate.name
}
