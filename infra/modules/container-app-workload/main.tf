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

        # exposedPort is TCP-only in this API schema; HTTP ingress exposes only
        # the relay target and has no additional port mappings.
        ingress = {
          external      = true
          targetPort    = var.target_port
          transport     = "Http"
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
            identity  = replace(var.image_pull_identity_id, "resourceGroups", "resourcegroups")
            lifecycle = "None"
          },
          {
            identity  = replace(var.runtime_identity_id, "resourceGroups", "resourcegroups")
            lifecycle = "Main"
          }
        ]

        secrets = var.enable_litellm_sidecar ? [
          {
            name        = "litellm-master-key"
            keyVaultUrl = var.litellm_master_key_secret_url
            identity    = var.runtime_identity_id
          },
          {
            name        = "openrouter-api-key"
            keyVaultUrl = var.openrouter_api_key_secret_url
            identity    = var.runtime_identity_id
          }
        ] : []
      }

      template = {
        containers = concat(
          [
            {
              name  = "relay"
              image = var.image_digest

              resources = {
                cpu    = 0.25
                memory = "0.5Gi"
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
                    name  = "PALANCAR_SECURITY_MODE"
                    value = var.security_mode
                  },
                  {
                    name  = "PALANCAR_WORKLOAD_TABLE_ENDPOINT"
                    value = trimsuffix(var.workload_table_endpoint, "/")
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
                    name  = "PALANCAR_TRANSCRIPTION_PROVIDER"
                    value = var.transcription_provider
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
                cpu    = 0.25
                memory = "0.5Gi"
              }

              env = [
                {
                  name  = "PALANCAR_LITELLM_BACKEND"
                  value = "openrouter"
                },
                {
                  name  = "PALANCAR_LITELLM_UPSTREAM_MODEL"
                  value = var.litellm_upstream_model
                },
                {
                  name      = "LITELLM_MASTER_KEY"
                  secretRef = "litellm-master-key"
                },
                {
                  name      = "OPENROUTER_API_KEY"
                  secretRef = "openrouter-api-key"
                }
              ]

              probes = [
                {
                  type = "Liveness"
                  httpGet = {
                    path = "/health/liveliness"
                    port = 4000
                  }
                  initialDelaySeconds = 10
                  periodSeconds       = 30
                  timeoutSeconds      = 3
                  failureThreshold    = 3
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
                },
                {
                  type = "Startup"
                  httpGet = {
                    path = "/health/liveliness"
                    port = 4000
                  }
                  periodSeconds    = 10
                  timeoutSeconds   = 3
                  failureThreshold = 10
                }
              ]
            }
          ] : []
        )

        scale = {
          minReplicas = var.min_replicas
          maxReplicas = 1
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
      condition     = lower(var.image_pull_identity_id) != lower(var.runtime_identity_id)
      error_message = "image-pull and runtime identities must be distinct."
    }

    precondition {
      condition     = startswith(var.image_digest, "${var.acr_login_server}/")
      error_message = "image_digest must be hosted by acr_login_server."
    }

    precondition {
      condition     = var.security_mode == "azure-table"
      error_message = "deployed relay workloads require security_mode azure-table."
    }

    precondition {
      condition = (
        var.transcription_provider == "mock" &&
        trimspace(var.azure_transcription_endpoint) == "" &&
        trimspace(var.azure_transcription_deployment) == ""
      )
      error_message = "transcription_provider must be mock and Azure transcription fields must be empty."
    }

    precondition {
      condition = !var.enable_litellm_sidecar || (
        var.litellm_backend == "openrouter" &&
        trimspace(var.litellm_image_digest) != "" &&
        startswith(var.litellm_image_digest, "${var.acr_login_server}/") &&
        startswith(var.litellm_upstream_model, "openrouter/") &&
        trimspace(var.litellm_master_key_secret_url) != "" &&
        trimspace(var.openrouter_api_key_secret_url) != "" &&
        trimspace(var.azure_api_base) == "" &&
        trimspace(var.azure_api_version) == ""
      )
      error_message = "enabled LiteLLM requires the complete OpenRouter configuration, an immutable image in acr_login_server, and empty Azure fields."
    }

    precondition {
      condition = var.enable_litellm_sidecar || (
        trimspace(var.litellm_backend) == "" &&
        trimspace(var.litellm_image_digest) == "" &&
        trimspace(var.litellm_upstream_model) == "" &&
        trimspace(var.litellm_master_key_secret_url) == "" &&
        trimspace(var.openrouter_api_key_secret_url) == "" &&
        trimspace(var.azure_api_base) == "" &&
        trimspace(var.azure_api_version) == ""
      )
      error_message = "all LiteLLM and provider values must be empty when the sidecar is disabled."
    }

    precondition {
      condition = !var.enable_litellm_sidecar || (
        var.openrouter_api_key_secret_url == "${trimsuffix(var.key_vault_uri, "/")}/secrets/openrouter-api-key" &&
        var.litellm_master_key_secret_url == "${trimsuffix(var.key_vault_uri, "/")}/secrets/litellm-master-key"
      )
      error_message = "sidecar secret URLs must be versionless exact-name references in key_vault_uri."
    }
  }
}
