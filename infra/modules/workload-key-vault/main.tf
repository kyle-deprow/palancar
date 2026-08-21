data "azurerm_client_config" "current" {}

locals {
  role_definition_ids = {
    secrets_user    = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${var.key_vault_secrets_user_role_definition_id}"
    secrets_officer = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${var.key_vault_secrets_officer_role_definition_id}"
  }

  runtime_role_assignment_name = uuidv5(
    "url",
    "${azurerm_key_vault.this.id}/runtime/${var.runtime_principal_id}/${local.role_definition_ids.secrets_user}"
  )
  cli_role_assignment_name = uuidv5(
    "url",
    "${azurerm_key_vault.this.id}/terraform-cli/${data.azurerm_client_config.current.object_id}/${local.role_definition_ids.secrets_officer}"
  )
}

resource "azurerm_key_vault" "this" {
  name                          = var.name
  resource_group_name           = var.resource_group_name
  location                      = var.location
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  public_network_access_enabled = true
  soft_delete_retention_days    = 7
  purge_protection_enabled      = false
  tags                          = var.tags
}

resource "azurerm_role_assignment" "runtime_secrets_user" {
  count              = var.enable_runtime_secrets_user_assignment ? 1 : 0
  name               = local.runtime_role_assignment_name
  scope              = azurerm_key_vault.this.id
  role_definition_id = local.role_definition_ids.secrets_user
  principal_id       = var.runtime_principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "terraform_cli_secrets_officer" {
  name               = local.cli_role_assignment_name
  scope              = azurerm_key_vault.this.id
  role_definition_id = local.role_definition_ids.secrets_officer
  principal_id       = data.azurerm_client_config.current.object_id
}
