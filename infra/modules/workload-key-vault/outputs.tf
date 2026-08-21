output "name" {
  description = "Key Vault name."
  value       = azurerm_key_vault.this.name
}

output "id" {
  description = "Key Vault resource ID."
  value       = azurerm_key_vault.this.id
}

output "uri" {
  description = "Key Vault URI for secret references."
  value       = azurerm_key_vault.this.vault_uri
}

output "runtime_secrets_user_role_assignment_id" {
  description = "Runtime identity Key Vault Secrets User role assignment ID."
  value       = one(azurerm_role_assignment.runtime_secrets_user[*].id)
}
