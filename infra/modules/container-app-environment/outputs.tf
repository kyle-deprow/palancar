output "id" {
  description = "Container Apps environment ID."
  value       = azurerm_container_app_environment.this.id
}

output "name" {
  description = "Container Apps environment name."
  value       = azurerm_container_app_environment.this.name
}

output "default_domain" {
  description = "Default Azure-provided Container Apps domain."
  value       = azurerm_container_app_environment.this.default_domain
}
