output "account_id" {
  description = "Foundry/OpenAI cognitive account ID."
  value       = azurerm_cognitive_account.this.id
}

output "account_name" {
  description = "Foundry/OpenAI cognitive account name."
  value       = azurerm_cognitive_account.this.name
}

output "endpoint" {
  description = "Foundry/OpenAI endpoint."
  value       = azurerm_cognitive_account.this.endpoint
}

output "deployment_names" {
  description = "Pinned deployment names."
  value       = sort(keys(var.deployments))
}
