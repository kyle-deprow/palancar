output "id" {
  description = "Budget resource ID."
  value       = azurerm_consumption_budget_resource_group.this.id
}

output "name" {
  description = "Budget resource name."
  value       = azurerm_consumption_budget_resource_group.this.name
}
