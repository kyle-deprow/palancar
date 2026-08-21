mock_provider "azurerm" {
  override_during = plan

  mock_data "azurerm_client_config" {
    defaults = {
      object_id       = "00000000-0000-0000-0000-000000000002"
      subscription_id = "00000000-0000-0000-0000-000000000000"
      tenant_id       = "00000000-0000-0000-0000-000000000001"
    }
  }

  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-workload-key-vault/providers/Microsoft.KeyVault/vaults/kv-workload-test"
      vault_uri = "https://kv-workload-test.vault.azure.net/"
    }
  }

  mock_resource "azurerm_role_assignment" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-workload-key-vault/providers/Microsoft.KeyVault/vaults/kv-workload-test/providers/Microsoft.Authorization/roleAssignments/11111111-1111-1111-1111-111111111111"
    }
  }
}

variables {
  name                 = "kv-workload-test"
  resource_group_name  = "rg-workload-key-vault"
  location             = "eastus2"
  tags                 = { test = "runtime-role-assignment" }
  runtime_principal_id = "00000000-0000-0000-0000-000000000003"
}

run "default_creates_indexed_runtime_assignment" {
  command = plan

  assert {
    condition     = length(resource.azurerm_role_assignment.runtime_secrets_user) == 1
    error_message = "the default must create exactly one indexed runtime Secrets User assignment"
  }

  assert {
    condition = (
      resource.azurerm_role_assignment.runtime_secrets_user[0].name == uuidv5(
        "url",
        "${resource.azurerm_role_assignment.runtime_secrets_user[0].scope}/runtime/${var.runtime_principal_id}/${resource.azurerm_role_assignment.runtime_secrets_user[0].role_definition_id}"
      ) &&
      resource.azurerm_role_assignment.runtime_secrets_user[0].role_definition_id == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6" &&
      resource.azurerm_role_assignment.runtime_secrets_user[0].principal_id == var.runtime_principal_id &&
      resource.azurerm_role_assignment.runtime_secrets_user[0].scope == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-workload-key-vault/providers/Microsoft.KeyVault/vaults/kv-workload-test" &&
      resource.azurerm_role_assignment.runtime_secrets_user[0].principal_type == "ServicePrincipal"
    )
    error_message = "the indexed runtime assignment must use the exact deterministic name, Secrets User role, runtime principal, Key Vault scope, and principal type"
  }

  assert {
    condition     = output.runtime_secrets_user_role_assignment_id != null
    error_message = "the enabled runtime assignment output must be non-null"
  }
}

run "explicit_true_creates_indexed_runtime_assignment" {
  command = plan

  variables {
    enable_runtime_secrets_user_assignment = true
  }

  assert {
    condition     = length(resource.azurerm_role_assignment.runtime_secrets_user) == 1
    error_message = "explicit true must create exactly one indexed runtime Secrets User assignment"
  }

  assert {
    condition = (
      resource.azurerm_role_assignment.runtime_secrets_user[0].name == uuidv5(
        "url",
        "${resource.azurerm_role_assignment.runtime_secrets_user[0].scope}/runtime/${var.runtime_principal_id}/${resource.azurerm_role_assignment.runtime_secrets_user[0].role_definition_id}"
      ) &&
      resource.azurerm_role_assignment.runtime_secrets_user[0].role_definition_id == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6" &&
      resource.azurerm_role_assignment.runtime_secrets_user[0].principal_id == var.runtime_principal_id &&
      resource.azurerm_role_assignment.runtime_secrets_user[0].scope == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-workload-key-vault/providers/Microsoft.KeyVault/vaults/kv-workload-test" &&
      resource.azurerm_role_assignment.runtime_secrets_user[0].principal_type == "ServicePrincipal"
    )
    error_message = "explicit true must use the exact deterministic name, Secrets User role, runtime principal, Key Vault scope, and principal type"
  }
}

run "false_omits_runtime_assignment_and_output" {
  command = plan

  variables {
    enable_runtime_secrets_user_assignment = false
  }

  assert {
    condition     = length(resource.azurerm_role_assignment.runtime_secrets_user) == 0
    error_message = "false must omit the runtime Secrets User assignment"
  }

  assert {
    condition     = output.runtime_secrets_user_role_assignment_id == null
    error_message = "false must produce a null runtime assignment output"
  }
}

run "migration_source_destination_contract" {
  command = plan

  assert {
    condition = trimspace(file("${path.module}/moved.tf")) == trimspace(<<-EOT
      moved {
        from = azurerm_role_assignment.runtime_secrets_user
        to   = azurerm_role_assignment.runtime_secrets_user[0]
      }
    EOT
    )
    error_message = "the moved block must map the unindexed runtime assignment to index zero exactly"
  }

  assert {
    condition = (
      length(resource.azurerm_role_assignment.runtime_secrets_user) == 1 &&
      resource.azurerm_role_assignment.runtime_secrets_user[0].principal_id == var.runtime_principal_id
    )
    error_message = "the migration destination must be the indexed runtime Secrets User assignment without changing its principal"
  }

  assert {
    condition     = output.runtime_secrets_user_role_assignment_id == resource.azurerm_role_assignment.runtime_secrets_user[0].id
    error_message = "the migration destination output must resolve to the indexed assignment ID"
  }
}
