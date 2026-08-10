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
      }

      template = {
        containers = [
          {
            name  = "relay"
            image = var.image_digest

            resources = {
              cpu    = var.cpu
              memory = var.memory
            }

            env = [
              {
                name  = "NODE_ENV"
                value = "production"
              },
              {
                name  = "PORT"
                value = tostring(var.target_port)
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
            ]

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
        ]

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
      condition     = trimspace(var.image_digest) != ""
      error_message = "image_digest must be nonempty when the relay workload is deployed."
    }
  }
}
