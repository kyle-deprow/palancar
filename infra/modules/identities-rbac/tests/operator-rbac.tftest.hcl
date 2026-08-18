mock_provider "azurerm" {}

variables {
  subscription_id                           = "00000000-0000-0000-0000-000000000000"
  resource_group_name                       = "rg-palancar-dev"
  location                                  = "eastus2"
  prefix                                    = "palancar"
  environment                               = "dev"
  tags                                      = { test = "operator-rbac" }
  container_registry_id                     = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ContainerRegistry/registries/palancardev"
  workload_state_storage_account_id         = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Storage/storageAccounts/palancardev"
  security_state_table_id                   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Storage/storageAccounts/palancardev/tableServices/default/tables/SecurityState"
  rate_state_table_id                       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Storage/storageAccounts/palancardev/tableServices/default/tables/RateState"
  operator_principal_id                     = "00000000-0000-0000-0000-000000000003"
  cognitive_account_id                      = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.CognitiveServices/accounts/palancardev"
  acr_pull_role_definition_id               = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
  table_data_contributor_role_definition_id = "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3"
  openai_user_role_definition_id            = "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"
}

run "exact_operator_table_assignments" {
  command = plan

  assert {
    condition     = azurerm_role_assignment.runtime_table.scope == var.workload_state_storage_account_id
    error_message = "runtime identity table access must remain scoped to the storage account"
  }

  assert {
    condition     = azurerm_role_assignment.operator_security_table.scope == var.security_state_table_id
    error_message = "operator SecurityState access must use the exact table scope"
  }

  assert {
    condition     = azurerm_role_assignment.operator_rate_table.scope == var.rate_state_table_id
    error_message = "operator RateState access must use the exact table scope"
  }

  assert {
    condition = (
      azurerm_role_assignment.operator_security_table.role_definition_id == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3" &&
      azurerm_role_assignment.operator_rate_table.role_definition_id == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3"
    )
    error_message = "both operator grants must use Storage Table Data Contributor"
  }

  assert {
    condition = (
      azurerm_role_assignment.operator_security_table.principal_id == var.operator_principal_id &&
      azurerm_role_assignment.operator_rate_table.principal_id == var.operator_principal_id &&
      azurerm_role_assignment.operator_security_table.principal_type == "User" &&
      azurerm_role_assignment.operator_rate_table.principal_type == "User"
    )
    error_message = "both operator grants must target the reviewed Entra user"
  }

  assert {
    condition = (
      azurerm_role_assignment.operator_security_table.name == uuidv5("url", "${var.security_state_table_id}/operator/${var.operator_principal_id}//subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3") &&
      azurerm_role_assignment.operator_rate_table.name == uuidv5("url", "${var.rate_state_table_id}/operator/${var.operator_principal_id}//subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3")
    )
    error_message = "operator role assignment names must be deterministic per exact table scope"
  }
}

run "reject_noncanonical_operator_principal" {
  command = plan

  variables {
    operator_principal_id = "00000000-0000-0000-0000-00000000000A"
  }

  expect_failures = [var.operator_principal_id]
}

run "reject_wrong_security_table_scope" {
  command = plan

  variables {
    security_state_table_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Storage/storageAccounts/palancardev/tableServices/default/tables/Other"
  }

  expect_failures = [var.security_state_table_id]
}

run "reject_cross_account_table_scopes" {
  command = plan

  variables {
    rate_state_table_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Storage/storageAccounts/otherdev/tableServices/default/tables/RateState"
  }

  expect_failures = [azurerm_role_assignment.operator_security_table]
}
