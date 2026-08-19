mock_provider "azurerm" {}

override_resource {
  target          = azurerm_user_assigned_identity.runtime
  override_during = plan
  values = {
    principal_id = "11111111-1111-1111-1111-111111111111"
  }
}

variables {
  subscription_id                                 = "00000000-0000-0000-0000-000000000000"
  resource_group_name                             = "rg-palancar-dev"
  location                                        = "eastus2"
  prefix                                          = "palancar"
  environment                                     = "dev"
  tags                                            = { test = "operator-rbac" }
  container_registry_id                           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ContainerRegistry/registries/palancardev"
  workload_state_storage_account_id               = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Storage/storageAccounts/palancardev"
  security_state_table_id                         = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Storage/storageAccounts/palancardev/tableServices/default/tables/SecurityState"
  rate_state_table_id                             = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Storage/storageAccounts/palancardev/tableServices/default/tables/RateState"
  operator_principal_id                           = "00000000-0000-0000-0000-000000000003"
  cognitive_account_id                            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.CognitiveServices/accounts/palancardev"
  application_insights_id                         = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/palancardev"
  acr_pull_role_definition_id                     = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
  table_data_contributor_role_definition_id       = "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3"
  openai_user_role_definition_id                  = "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"
  monitoring_metrics_publisher_role_definition_id = "3913510d-42f4-4e42-8a64-420c390055eb"
}

run "exact_operator_table_assignments" {
  command = plan

  assert {
    condition     = azurerm_role_assignment.runtime_table.scope == var.workload_state_storage_account_id
    error_message = "runtime identity table access must remain scoped to the storage account"
  }

  assert {
    condition     = azurerm_role_assignment.runtime_application_insights.scope == var.application_insights_id
    error_message = "runtime monitoring access must use the exact Application Insights component scope"
  }

  assert {
    condition = (
      azurerm_role_assignment.runtime_application_insights.role_definition_id == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/3913510d-42f4-4e42-8a64-420c390055eb" &&
      azurerm_role_assignment.runtime_application_insights.principal_id == "11111111-1111-1111-1111-111111111111" &&
      azurerm_user_assigned_identity.runtime.principal_id == "11111111-1111-1111-1111-111111111111" &&
      azurerm_role_assignment.runtime_application_insights.principal_type == "ServicePrincipal"
    )
    error_message = "runtime monitoring access must use Monitoring Metrics Publisher on the runtime service principal"
  }

  assert {
    condition = (
      azurerm_role_assignment.runtime_application_insights.name == "b3aecc72-a3e5-566d-95e4-8ce2fe6ce695" &&
      uuidv5(
        "url",
        "scope=/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/palancardev|principal_id=11111111-1111-1111-1111-111111111111|role_definition_id=/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/3913510d-42f4-4e42-8a64-420c390055eb"
      ) == "b3aecc72-a3e5-566d-95e4-8ce2fe6ce695"
    )
    error_message = "runtime monitoring assignment name must use the reviewed labeled scope, runtime principal, and full role-definition seed"
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

run "reject_resource_group_application_insights_scope" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_malformed_application_insights_id" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/not-a-subscription/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/palancardev"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_wrong_monitoring_role_definition_id" {
  command = plan

  variables {
    monitoring_metrics_publisher_role_definition_id = "00000000-0000-0000-0000-000000000000"
  }

  expect_failures = [var.monitoring_metrics_publisher_role_definition_id]
}

run "minimum_application_insights_segments_are_valid" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/r/providers/Microsoft.Insights/components/c"
  }

  assert {
    condition = (
      length(split("/", azurerm_role_assignment.runtime_application_insights.scope)[4]) == 1 &&
      length(split("/", azurerm_role_assignment.runtime_application_insights.scope)[8]) == 1
    )
    error_message = "one-character resource-group and component segments must remain valid"
  }
}

run "maximum_application_insights_segments_are_valid" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/${join("", [for index in range(90) : "r"])}/providers/Microsoft.Insights/components/${join("", [for index in range(224) : "c"])}"
  }

  assert {
    condition = (
      length(split("/", azurerm_role_assignment.runtime_application_insights.scope)[4]) == 90 &&
      length(split("/", azurerm_role_assignment.runtime_application_insights.scope)[8]) == 224
    )
    error_message = "90-character resource-group and 224-character component boundaries must remain valid"
  }
}

run "reject_resource_group_segment_over_maximum" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/${join("", [for index in range(91) : "r"])}/providers/Microsoft.Insights/components/palancardev"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_component_segment_over_maximum" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/${join("", [for index in range(225) : "c"])}"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_query_suffix" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/palancardev?api-version=2020-02-02"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_fragment_suffix" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/palancardev#fragment"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_percent_encoding" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/palancar%2fdev"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_whitespace" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/palancar dev"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_control_character" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/palancar\ndev"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_missing_component_name" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_extra_child_scope" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/palancardev/liveMetrics/default"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_arm_path_case_injection" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/microsoft.insights/components/palancardev"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_uppercase_subscription_id" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-00000000000A"
  }

  expect_failures = [var.subscription_id]
}

run "reject_uppercase_application_insights_subscription_uuid" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-00000000000A/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/palancardev"
  }

  expect_failures = [var.application_insights_id]
}

run "reject_cross_subscription_application_insights_id" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-palancar-dev/providers/Microsoft.Insights/components/palancardev"
  }

  expect_failures = [azurerm_role_assignment.runtime_application_insights]
}

run "reject_trailing_period_segments" {
  command = plan

  variables {
    application_insights_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev./providers/Microsoft.Insights/components/palancardev."
  }

  expect_failures = [var.application_insights_id]
}
