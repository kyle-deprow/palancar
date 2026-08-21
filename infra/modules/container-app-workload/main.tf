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
        activeRevisionsMode  = "Single"
        maxInactiveRevisions = 1

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

        secrets = []
      }

      template = {
        containers = [
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
                  value = "azure-openai"
                },
                {
                  name  = "PALANCAR_AZURE_GENERATION_ENDPOINT"
                  value = var.azure_generation_endpoint
                },
                {
                  name  = "PALANCAR_AZURE_GENERATION_DEPLOYMENT"
                  value = var.azure_generation_deployment
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
                  name  = "PALANCAR_DEPLOYMENT_SLOT"
                  value = var.deployment_slot
                },
                {
                  name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
                  value = local.relay_application_insights_connection_string
                },
                {
                  name  = "APPLICATIONINSIGHTS_STATSBEAT_DISABLED"
                  value = "true"
                },
                {
                  name  = "APPLICATION_INSIGHTS_NO_STATSBEAT"
                  value = "true"
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
                },
              ],
              var.transcription_provider == "azure-realtime" ? [
                {
                  name  = "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT"
                  value = var.azure_transcription_endpoint
                },
                {
                  name  = "PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT"
                  value = var.azure_transcription_deployment
                }
              ] : [],
              [
                {
                  name  = "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON"
                  value = jsonencode(var.browser_allowed_origins)
                },
                {
                  name  = "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN"
                  value = tostring(var.allow_null_browser_origin)
                },
                {
                  name  = "PALANCAR_LANGUAGE_BOUNDARY_MODE"
                  value = var.language_boundary_mode
                }
              ]
            )
          }
        ]

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
      condition     = trimspace(var.runtime_openai_user_role_assignment_id) != ""
      error_message = "runtime_openai_user_role_assignment_id must be nonempty."
    }

    precondition {
      condition     = trimspace(var.runtime_monitoring_metrics_publisher_role_assignment_id) != ""
      error_message = "runtime_monitoring_metrics_publisher_role_assignment_id must be nonempty."
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
        var.deployment_slot == "dev" ||
        var.language_boundary_mode == "deny-all"
      )
      error_message = "development-provisional language boundary mode is permitted only when deployment_slot is dev; staging and production require deny-all."
    }

    precondition {
      condition = anytrue([
        var.transcription_provider == "mock" &&
        var.azure_transcription_endpoint == "" &&
        var.azure_transcription_deployment == "",
        var.transcription_provider == "azure-realtime" &&
        var.azure_transcription_endpoint != "" &&
        var.azure_transcription_deployment == "gpt-4o-mini-transcribe",
      ])
      error_message = "transcription_provider must be mock with empty Azure fields or azure-realtime with the canonical endpoint and gpt-4o-mini-transcribe deployment."
    }

    precondition {
      condition     = var.azure_generation_deployment == "gpt-5.6-luna"
      error_message = "azure_generation_deployment must be exactly gpt-5.6-luna."
    }
  }
}
