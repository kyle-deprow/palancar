moved {
  from = azurerm_role_assignment.runtime_secrets_user
  to   = azurerm_role_assignment.runtime_secrets_user[0]
}
