resource "azapi_resource" "this" {
  type      = "Microsoft.App/containerApps@2026-01-01"
  name      = var.name
  parent_id = var.resource_group_id
  location  = var.location
  tags      = var.tags

  retry = {
    error_message_regex  = ["IdentityDoesNotExist"]
    interval_seconds     = 10
    max_interval_seconds = 30
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [var.image_pull_identity_id, var.runtime_identity_id]
  }

  body = {
    properties = {
      managedEnvironmentId = var.container_app_environment_id

      configuration = {
        activeRevisionsMode = "Single"

        ingress = {
          external      = true
          targetPort    = var.target_port
          transport     = "http"
          allowInsecure = false
          traffic = [
            {
              latestRevision = true
              weight         = 100
            }
          ]
        }

        registries = [
          {
            server   = var.acr_login_server
            identity = var.image_pull_identity_id
          }
        ]

        identitySettings = [
          {
            identity  = var.image_pull_identity_id
            lifecycle = "None"
          },
          {
            identity  = var.runtime_identity_id
            lifecycle = "Main"
          }
        ]

        secrets = var.enable_litellm_sidecar ? concat(
          [
            {
              name        = "litellm-master-key"
              keyVaultUrl = var.litellm_master_key_secret_url
              identity    = var.runtime_identity_id
            }
          ],
          var.litellm_backend == "openrouter" ? [
            {
              name        = "openrouter-api-key"
              keyVaultUrl = var.openrouter_api_key_secret_url
              identity    = var.runtime_identity_id
            }
            ] : [
            {
              name        = "azure-api-key"
              keyVaultUrl = var.azure_api_key_secret_url
              identity    = var.runtime_identity_id
            }
          ]
        ) : []
      }

      template = {
        containers = concat(
          [
            {
              name  = "relay"
              image = var.image_digest

              resources = {
                cpu    = var.cpu
                memory = var.memory
              }

              env = concat(
                [
                  {
                    name  = "NODE_ENV"
                    value = "production"
                  },
                  {
                    name  = "PORT"
                    value = tostring(var.target_port)
                  },
                  {
                    name  = "PALANCAR_GENERATION_PROVIDER"
                    value = var.enable_litellm_sidecar ? "litellm" : "mock"
                  },
                  {
                    name  = "PALANCAR_RELAY_BIND_HOST"
                    value = "0.0.0.0"
                  },
                  {
                    name  = "PALANCAR_RELAY_ENVIRONMENT"
                    value = var.environment
                  },
                  {
                    name  = "PALANCAR_RELAY_ORIGIN"
                    value = var.relay_origin
                  },
                  {
                    name  = "PALANCAR_GATE_POLICY_VERSION"
                    value = var.gate_policy_version
                  },
                  {
                    name  = "AZURE_CLIENT_ID"
                    value = var.runtime_identity_client_id
                  },
                  {
                    name  = "PALANCAR_WORKLOAD_TABLE_ENDPOINT"
                    value = var.workload_table_endpoint
                  },
                  {
                    name  = "PALANCAR_SECURITY_STATE_TABLE"
                    value = var.security_state_table_name
                  },
                  {
                    name  = "PALANCAR_RATE_STATE_TABLE"
                    value = var.rate_state_table_name
                  },
                  {
                    name  = "PALANCAR_FOUNDRY_ENDPOINT"
                    value = var.foundry_endpoint
                  },
                  {
                    name  = "PALANCAR_FOUNDRY_DEPLOYMENTS"
                    value = join(",", var.foundry_deployment_names)
                  }
                ],
                var.enable_litellm_sidecar ? [
                  {
                    name  = "PALANCAR_LITELLM_BASE_URL"
                    value = "http://127.0.0.1:4000"
                  },
                  {
                    name  = "PALANCAR_LITELLM_MODEL"
                    value = "palancar-generation"
                  },
                  {
                    name      = "PALANCAR_LITELLM_API_KEY"
                    secretRef = "litellm-master-key"
                  },
                  {
                    name  = "PALANCAR_LITELLM_EXPECTED_BACKEND"
                    value = var.litellm_backend
                  },
                  {
                    name  = "PALANCAR_LITELLM_EXPECTED_UPSTREAM_MODEL"
                    value = var.litellm_upstream_model
                  },
                  {
                    name  = "PALANCAR_LITELLM_METADATA_URL"
                    value = "http://127.0.0.1:4001"
                  }
                ] : []
              )

              probes = [
                {
                  type = "Liveness"
                  httpGet = {
                    path = "/healthz"
                    port = 8787
                  }
                  initialDelaySeconds = 10
                  periodSeconds       = 10
                  timeoutSeconds      = 3
                  failureThreshold    = 3
                },
                {
                  type = "Readiness"
                  httpGet = {
                    path = "/readyz"
                    port = 8787
                  }
                  initialDelaySeconds = 5
                  periodSeconds       = 5
                  timeoutSeconds      = 3
                  failureThreshold    = 3
                }
              ]
            }
          ],
          var.enable_litellm_sidecar ? [
            {
              name  = "litellm"
              image = var.litellm_image_digest

              resources = {
                cpu    = var.litellm_cpu
                memory = var.litellm_memory
              }

              env = concat(
                [
                  {
                    name  = "PALANCAR_LITELLM_BACKEND"
                    value = var.litellm_backend
                  },
                  {
                    name  = "PALANCAR_LITELLM_UPSTREAM_MODEL"
                    value = var.litellm_upstream_model
                  },
                  {
                    name      = "LITELLM_MASTER_KEY"
                    secretRef = "litellm-master-key"
                  }
                ],
                var.litellm_backend == "openrouter" ? [
                  {
                    name      = "OPENROUTER_API_KEY"
                    secretRef = "openrouter-api-key"
                  }
                  ] : [
                  {
                    name  = "AZURE_API_BASE"
                    value = var.azure_api_base
                  },
                  {
                    name  = "AZURE_API_VERSION"
                    value = var.azure_api_version
                  },
                  {
                    name      = "AZURE_API_KEY"
                    secretRef = "azure-api-key"
                  }
                ]
              )

              probes = [
                {
                  type = "Startup"
                  httpGet = {
                    path = "/health/liveliness"
                    port = 4000
                  }
                  initialDelaySeconds = 10
                  periodSeconds       = 10
                  timeoutSeconds      = 3
                  failureThreshold    = 10
                },
                {
                  type = "Liveness"
                  httpGet = {
                    path = "/health/liveliness"
                    port = 4000
                  }
                  periodSeconds    = 30
                  timeoutSeconds   = 3
                  failureThreshold = 3
                },
                {
                  type = "Readiness"
                  httpGet = {
                    path = "/health/readiness"
                    port = 4000
                  }
                  periodSeconds    = 10
                  timeoutSeconds   = 3
                  failureThreshold = 3
                }
              ]
            }
          ] : []
        )

        scale = {
          minReplicas = var.min_replicas
          maxReplicas = var.max_replicas
        }
      }
    }
  }

  response_export_values = [
    "properties.configuration.ingress.fqdn",
    "properties.latestRevisionName",
    "properties.runningStatus",
  ]

  lifecycle {
    precondition {
      condition     = trimspace(var.runtime_secrets_user_role_assignment_id) != ""
      error_message = "runtime_secrets_user_role_assignment_id must be nonempty."
    }

    precondition {
      condition     = trimspace(var.image_digest) != ""
      error_message = "image_digest must be nonempty when the relay workload is deployed."
    }

    precondition {
      condition     = !var.enable_litellm_sidecar || trimspace(var.litellm_image_digest) != ""
      error_message = "litellm_image_digest must be nonempty when the LiteLLM sidecar is enabled."
    }

    precondition {
      condition     = !var.enable_litellm_sidecar || trimspace(var.litellm_master_key_secret_url) != ""
      error_message = "litellm_master_key_secret_url must be nonempty when the LiteLLM sidecar is enabled."
    }

    precondition {
      condition     = !var.enable_litellm_sidecar || trimspace(var.litellm_upstream_model) != ""
      error_message = "litellm_upstream_model must be nonempty when the LiteLLM sidecar is enabled."
    }

    precondition {
      condition = !var.enable_litellm_sidecar || (
        (var.litellm_backend == "openrouter" && startswith(var.litellm_upstream_model, "openrouter/")) ||
        (var.litellm_backend == "azure" && startswith(var.litellm_upstream_model, "azure/"))
      )
      error_message = "litellm_upstream_model must start with openrouter/ for OpenRouter or azure/ for Azure when the LiteLLM sidecar is enabled."
    }

    precondition {
      condition = !var.enable_litellm_sidecar || var.litellm_backend != "openrouter" || (
        trimspace(var.openrouter_api_key_secret_url) != "" &&
        trimspace(var.azure_api_base) == "" &&
        trimspace(var.azure_api_version) == "" &&
        trimspace(var.azure_api_key_secret_url) == ""
      )
      error_message = "OpenRouter sidecar mode requires openrouter_api_key_secret_url and empty Azure API fields."
    }

    precondition {
      condition = !var.enable_litellm_sidecar || var.litellm_backend != "azure" || (
        trimspace(var.azure_api_base) != "" &&
        trimspace(var.azure_api_version) != "" &&
        trimspace(var.azure_api_key_secret_url) != "" &&
        trimspace(var.openrouter_api_key_secret_url) == ""
      )
      error_message = "Azure sidecar mode requires azure_api_base, azure_api_version, azure_api_key_secret_url, and an empty OpenRouter secret URL."
    }

    precondition {
      condition = var.enable_litellm_sidecar || (
        trimspace(var.litellm_image_digest) == "" &&
        trimspace(var.openrouter_api_key_secret_url) == "" &&
        trimspace(var.litellm_master_key_secret_url) == "" &&
        trimspace(var.azure_api_key_secret_url) == ""
      )
      error_message = "LiteLLM image and generation secret URLs must be empty when the LiteLLM sidecar is disabled."
    }
  }
}
