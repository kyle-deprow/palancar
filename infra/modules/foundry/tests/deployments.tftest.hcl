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

  assert {
    condition     = length(output.deployment_names) == 0
    error_message = "an empty deployment map must report no deployment names"
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

  assert {
    condition     = output.deployment_names == tolist(["gpt-4o-mini-transcribe"])
    error_message = "deployment names must come from the reviewed deployment map"
  }
}

run "exact_pinned_deployments" {
  command = plan

  variables {
    name                  = "foundry-test-exact"
    custom_subdomain_name = "foundry-test-exact"
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
      "gpt-5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  assert {
    condition = (
      length(resource.azurerm_cognitive_deployment.this) == 2 &&
      resource.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"].model[0].name == "gpt-4o-mini-transcribe" &&
      resource.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"].model[0].format == "OpenAI" &&
      resource.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"].model[0].version == "2025-12-15" &&
      resource.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"].sku[0].name == "GlobalStandard" &&
      resource.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"].sku[0].capacity == 1 &&
      resource.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"].version_upgrade_option == "NoAutoUpgrade" &&
      resource.azurerm_cognitive_deployment.this["gpt-5.6-luna"].name == "gpt-5.6-luna" &&
      resource.azurerm_cognitive_deployment.this["gpt-5.6-luna"].model[0].name == "gpt-5.6-luna" &&
      resource.azurerm_cognitive_deployment.this["gpt-5.6-luna"].model[0].format == "OpenAI" &&
      resource.azurerm_cognitive_deployment.this["gpt-5.6-luna"].model[0].version == "2026-07-09" &&
      resource.azurerm_cognitive_deployment.this["gpt-5.6-luna"].sku[0].name == "GlobalStandard" &&
      resource.azurerm_cognitive_deployment.this["gpt-5.6-luna"].sku[0].capacity == 1013 &&
      resource.azurerm_cognitive_deployment.this["gpt-5.6-luna"].version_upgrade_option == "NoAutoUpgrade"
    )
    error_message = "the exact two-entry deployment contract must preserve every pinned Luna and transcription field"
  }

  assert {
    condition     = output.deployment_names == tolist(["gpt-4o-mini-transcribe", "gpt-5.6-luna"])
    error_message = "the exact deployment contract must report both pinned deployment names"
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

run "leading_dot_deployment_name" {
  command = plan

  variables {
    name                  = "foundry-test-leading-dot"
    custom_subdomain_name = "foundry-test-leading-dot"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      ".gpt-5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  expect_failures = [var.deployments]
}

run "trailing_dot_deployment_name" {
  command = plan

  variables {
    name                  = "foundry-test-trailing-dot"
    custom_subdomain_name = "foundry-test-trailing-dot"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      "gpt-5.6-luna." = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  expect_failures = [var.deployments]
}

run "doubled_dot_deployment_name" {
  command = plan

  variables {
    name                  = "foundry-test-doubled-dot"
    custom_subdomain_name = "foundry-test-doubled-dot"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      "gpt-5..6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  expect_failures = [var.deployments]
}

run "adjacent_mixed_punctuation_deployment_name" {
  command = plan

  variables {
    name                  = "foundry-test-mixed-punctuation"
    custom_subdomain_name = "foundry-test-mixed-punctuation"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      "gpt-5.-6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  expect_failures = [var.deployments]
}

run "uppercase_deployment_name" {
  command = plan

  variables {
    name                  = "foundry-test-uppercase"
    custom_subdomain_name = "foundry-test-uppercase"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      "gpt-5.6-Luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  expect_failures = [var.deployments]
}

run "whitespace_deployment_name" {
  command = plan

  variables {
    name                  = "foundry-test-whitespace"
    custom_subdomain_name = "foundry-test-whitespace"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      "gpt-5.6 luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  expect_failures = [var.deployments]
}

run "invalid_character_deployment_name" {
  command = plan

  variables {
    name                  = "foundry-test-invalid-character"
    custom_subdomain_name = "foundry-test-invalid-character"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      "gpt_5.6-luna" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  expect_failures = [var.deployments]
}

run "overlong_deployment_name" {
  command = plan

  variables {
    name                  = "foundry-test-overlong"
    custom_subdomain_name = "foundry-test-overlong"
    resource_group_name   = "rg-foundry-test"
    location              = "eastus2"
    tags                  = { test = "foundry" }
    deployments = {
      "gpt-5.6-luna-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" = {
        model_name             = "gpt-5.6-luna"
        model_version          = "2026-07-09"
        model_format           = "OpenAI"
        sku_name               = "GlobalStandard"
        capacity               = 1013
        version_upgrade_option = "NoAutoUpgrade"
      }
    }
  }

  expect_failures = [var.deployments]
}
