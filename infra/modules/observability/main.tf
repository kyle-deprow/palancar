resource "azurerm_log_analytics_workspace" "this" {
  name                                    = var.workspace_name
  resource_group_name                     = var.resource_group_name
  location                                = var.location
  sku                                     = "PerGB2018"
  retention_in_days                       = var.retention_in_days
  immediate_data_purge_on_30_days_enabled = true
  tags                                    = var.tags
}

resource "azurerm_application_insights" "this" {
  name                         = var.application_insights_name
  resource_group_name          = var.resource_group_name
  location                     = var.location
  application_type             = "web"
  workspace_id                 = azurerm_log_analytics_workspace.this.id
  retention_in_days            = var.retention_in_days
  local_authentication_enabled = false
  tags                         = var.tags
}
