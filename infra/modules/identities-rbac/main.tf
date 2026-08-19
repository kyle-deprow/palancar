locals {
  role_definition_ids = {
    acr_pull                     = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${var.acr_pull_role_definition_id}"
    table_data                   = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${var.table_data_contributor_role_definition_id}"
    openai_user                  = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${var.openai_user_role_definition_id}"
    monitoring_metrics_publisher = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${var.monitoring_metrics_publisher_role_definition_id}"
  }
  image_pull_acr_role_assignment_name = uuidv5("url", "${var.container_registry_id}/image-pull/${local.role_definition_ids.acr_pull}")
  runtime_table_role_assignment_name  = uuidv5("url", "${var.workload_state_storage_account_id}/runtime/${local.role_definition_ids.table_data}")
  runtime_openai_role_assignment_name = uuidv5("url", "${var.cognitive_account_id}/runtime/${local.role_definition_ids.openai_user}")
  runtime_application_insights_role_assignment_name = uuidv5(
    "url",
    "scope=${var.application_insights_id}|principal_id=${azurerm_user_assigned_identity.runtime.principal_id}|role_definition_id=${local.role_definition_ids.monitoring_metrics_publisher}"
  )
  operator_security_table_role_assignment_name = uuidv5(
    "url",
    "${var.security_state_table_id}/operator/${var.operator_principal_id}/${local.role_definition_ids.table_data}"
  )
  operator_rate_table_role_assignment_name = uuidv5(
    "url",
    "${var.rate_state_table_id}/operator/${var.operator_principal_id}/${local.role_definition_ids.table_data}"
  )
}

resource "azurerm_user_assigned_identity" "image_pull" {
  name                = "id-${var.prefix}-${var.environment}-image-pull"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

resource "azurerm_user_assigned_identity" "runtime" {
  name                = "id-${var.prefix}-${var.environment}-runtime"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

resource "azurerm_role_assignment" "image_pull_acr" {
  name               = local.image_pull_acr_role_assignment_name
  scope              = var.container_registry_id
  role_definition_id = local.role_definition_ids.acr_pull
  principal_id       = azurerm_user_assigned_identity.image_pull.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "runtime_table" {
  name               = local.runtime_table_role_assignment_name
  scope              = var.workload_state_storage_account_id
  role_definition_id = local.role_definition_ids.table_data
  principal_id       = azurerm_user_assigned_identity.runtime.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "runtime_openai" {
  name               = local.runtime_openai_role_assignment_name
  scope              = var.cognitive_account_id
  role_definition_id = local.role_definition_ids.openai_user
  principal_id       = azurerm_user_assigned_identity.runtime.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "runtime_application_insights" {
  name               = local.runtime_application_insights_role_assignment_name
  scope              = var.application_insights_id
  role_definition_id = local.role_definition_ids.monitoring_metrics_publisher
  principal_id       = azurerm_user_assigned_identity.runtime.principal_id
  principal_type     = "ServicePrincipal"

  lifecycle {
    precondition {
      condition     = try(split("/", var.application_insights_id)[2], "") == var.subscription_id
      error_message = "application_insights_id must belong to subscription_id exactly."
    }
  }
}

resource "azurerm_role_assignment" "operator_security_table" {
  name               = local.operator_security_table_role_assignment_name
  scope              = var.security_state_table_id
  role_definition_id = local.role_definition_ids.table_data
  principal_id       = var.operator_principal_id
  principal_type     = "User"

  lifecycle {
    precondition {
      condition = (
        trimsuffix(var.security_state_table_id, "/tables/SecurityState") ==
        trimsuffix(var.rate_state_table_id, "/tables/RateState")
      )
      error_message = "operator table role assignments must target SecurityState and RateState in the same table service."
    }
  }
}

resource "azurerm_role_assignment" "operator_rate_table" {
  name               = local.operator_rate_table_role_assignment_name
  scope              = var.rate_state_table_id
  role_definition_id = local.role_definition_ids.table_data
  principal_id       = var.operator_principal_id
  principal_type     = "User"
}
