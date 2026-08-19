resource "azapi_resource" "this" {
  type      = "Microsoft.App/jobs@2026-01-01"
  name      = var.name
  parent_id = var.resource_group_id
  location  = var.location
  tags      = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [var.image_pull_identity_id, var.runtime_identity_id]
  }

  body = {
    properties = {
      environmentId = var.container_app_environment_id

      configuration = {
        triggerType = "Schedule"

        scheduleTriggerConfig = {
          cronExpression         = "0 3 * * *"
          replicaCompletionCount = 1
          parallelism            = 1
        }

        replicaRetryLimit = 0
        replicaTimeout    = 300

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
      }

      template = {
        containers = [
          {
            name  = "expiry-cleanup"
            image = var.image_digest

            resources = {
              cpu    = 0.25
              memory = "0.5Gi"
            }

            env = [
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
                name  = "PALANCAR_RELAY_ENVIRONMENT"
                value = var.environment
              },
              {
                name  = "PALANCAR_RELAY_ORIGIN"
                value = var.relay_origin
              },
              {
                name  = "PALANCAR_EXPIRY_CLEANUP_LIMIT"
                value = tostring(var.cleanup_limit)
              },
              {
                name  = "PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS"
                value = tostring(var.cleanup_timeout_ms)
              }
            ]
          }
        ]
      }
    }
  }

  lifecycle {
    precondition {
      condition     = lower(var.image_pull_identity_id) != lower(var.runtime_identity_id)
      error_message = "image-pull and runtime identities must be distinct."
    }

    precondition {
      condition = (
        !can(regex("^[a-z0-9]{5,50}\\.azurecr\\.io$", var.acr_login_server)) ||
        !can(regex("^[a-z0-9]{5,50}\\.azurecr\\.io/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$", var.image_digest)) ||
        split("/", var.image_digest)[0] == var.acr_login_server
      )
      error_message = "image_digest must be hosted by acr_login_server."
    }
  }
}
