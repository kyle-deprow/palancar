resource "azurerm_storage_account" "this" {
  name                              = var.name
  resource_group_name               = var.resource_group_name
  location                          = var.location
  account_kind                      = "StorageV2"
  account_tier                      = "Standard"
  account_replication_type          = "LRS"
  cross_tenant_replication_enabled  = false
  infrastructure_encryption_enabled = true
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  public_network_access_enabled     = var.public_network_access_enabled
  allow_nested_items_to_be_public   = false
  default_to_oauth_authentication   = true
  shared_access_key_enabled         = false
  local_user_enabled                = false
  tags                              = var.tags
}

resource "azapi_resource" "security" {
  type      = "Microsoft.Storage/storageAccounts/tableServices/tables@2025-01-01"
  name      = "SecurityState"
  parent_id = "${azurerm_storage_account.this.id}/tableServices/default"
  body      = {}
}

resource "azapi_resource" "rate" {
  type      = "Microsoft.Storage/storageAccounts/tableServices/tables@2025-01-01"
  name      = "RateState"
  parent_id = "${azurerm_storage_account.this.id}/tableServices/default"
  body      = {}
}
