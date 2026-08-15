mock_provider "azurerm" {}

run "zero_deployments" {
  command = plan

  variables {
    name                  = "foundry-test-zero"
    custom_subdomain_name = "foundry-test-zero"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments           = {}
  }

  assert {
    condition     = length(resource.azurerm_cognitive_deployment.this) == 0
    error_message = "an empty deployment map must plan no deployment resources"
  }
}

run "one_deployment" {
  command = plan

  variables {
    name                  = "foundry-test-one"
    custom_subdomain_name = "foundry-test-one"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  assert {
    condition     = resource.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"].name == "gpt-4o-mini-transcribe"
    error_message = "the single deployment must retain its for_each address"
  }
}

run "many_deployments" {
  command = plan

  variables {
    name                  = "foundry-test-many"
    custom_subdomain_name = "foundry-test-many"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
      "gpt-4o-mini-transcribe-2" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 2
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  assert {
    condition     = length(resource.azurerm_cognitive_deployment.this) == 2
    error_message = "all deployment map entries must be planned"
  }
}

run "malformed_deployment_values" {
  command = plan

  variables {
    name                  = "foundry-test-invalid"
    custom_subdomain_name = "foundry-test-invalid"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      "gpt-4o-mini-transcribe" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1.5
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  expect_failures = [var.deployments]
}

run "malformed_deployment_name" {
  command = plan

  variables {
    name                  = "foundry-test-invalid-name"
    custom_subdomain_name = "foundry-test-invalid-name"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      "Bad Deployment" = {
        model_name             = "gpt-4o-mini-transcribe"
        model_version          = "2025-12-15"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  expect_failures = [var.deployments]
}
