data "azurerm_client_config" "current" {
  count = var.grant_apply_principal_blob_data_contributor ? 1 : 0
}

locals {
  derived_suffix = substr(sha256("${var.subscription_id}-${var.environment}"), 0, 8)
  suffix         = var.state_suffix == "auto" ? local.derived_suffix : var.state_suffix
  name_seed      = substr(replace("${var.prefix}${var.environment}", "-", ""), 0, 12)
  account_name   = substr("${local.name_seed}${local.suffix}", 0, 24)
  tags = {
    application         = var.prefix
    environment         = var.environment
    managed-by          = "terraform"
    data-classification = "infrastructure-state"
  }
}

resource "azurerm_resource_group" "state" {
  name     = "rg-${var.prefix}-${var.environment}-tfstate-${local.suffix}"
  location = var.location
  tags     = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_account" "state" {
  name                              = local.account_name
  resource_group_name               = azurerm_resource_group.state.name
  location                          = azurerm_resource_group.state.location
  account_kind                      = "StorageV2"
  account_tier                      = "Standard"
  account_replication_type          = "LRS"
  cross_tenant_replication_enabled  = false
  infrastructure_encryption_enabled = true
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  public_network_access_enabled     = true
  allow_nested_items_to_be_public   = false
  default_to_oauth_authentication   = true
  shared_access_key_enabled         = false
  local_user_enabled                = false
  tags                              = local.tags

  blob_properties {
    versioning_enabled            = true
    change_feed_enabled           = true
    change_feed_retention_in_days = 14

    delete_retention_policy {
      days = 14
    }

    container_delete_retention_policy {
      days = 14
    }

    restore_policy {
      days = 13
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "apply_principal_blob_data" {
  count              = var.grant_apply_principal_blob_data_contributor ? 1 : 0
  scope              = azurerm_storage_account.state.id
  role_definition_id = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${var.blob_data_contributor_role_definition_id}"
  principal_id       = data.azurerm_client_config.current[0].object_id
  name               = uuidv5("url", "${azurerm_storage_account.state.id}/blob-data-contributor/${data.azurerm_client_config.current[0].object_id}")
}

resource "azurerm_storage_container" "bootstrap" {
  name                  = var.bootstrap_container_name
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"

  depends_on = [azurerm_role_assignment.apply_principal_blob_data]

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "dev" {
  name                  = var.dev_container_name
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"

  depends_on = [azurerm_role_assignment.apply_principal_blob_data]

  lifecycle {
    prevent_destroy = true
  }
}
