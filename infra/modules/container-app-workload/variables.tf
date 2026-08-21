variable "name" {
  description = "Canonical 2-32 character Container App name."
  type        = string

  validation {
    condition = (
      length(var.name) >= 2 &&
      length(var.name) <= 32 &&
      can(regex("^[a-z0-9]+(?:-[a-z0-9]+)*$", var.name)) &&
      !strcontains(var.name, "--")
    )
    error_message = "name must contain 2-32 lower-case alphanumeric characters with single internal hyphens only."
  }
}

variable "resource_group_id" {
  description = "Resource group ARM resource ID."
  type        = string

  validation {
    condition = can(regex(
      "^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
      var.resource_group_id
    ))
    error_message = "resource_group_id must be a canonical resource-group ARM ID with a lower-case subscription UUID and bounded lower-case segments."
  }
}

variable "location" {
  description = "Azure region for the Container App."
  type        = string

  validation {
    condition     = trimspace(var.location) != ""
    error_message = "location must be nonempty."
  }
}

variable "tags" {
  description = "Resource tags."
  type        = map(string)
}

variable "container_app_environment_id" {
  description = "Container Apps managed environment ARM resource ID."
  type        = string

  validation {
    condition = can(regex(
      "^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?/providers/Microsoft\\.App/managedEnvironments/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
      var.container_app_environment_id
    ))
    error_message = "container_app_environment_id must be a canonical managed-environment ARM ID with exact path case and bounded lower-case segments."
  }
}

variable "image_digest" {
  description = "Immutable palancar-relay image digest in an ACR."
  type        = string

  validation {
    condition = can(regex(
      "^[a-z0-9]{5,50}\\.azurecr\\.io/palancar-relay@sha256:[0-9a-f]{64}$",
      var.image_digest
    ))
    error_message = "image_digest must use a 5-50 character lower-case ACR name, the exact palancar-relay repository, and an exact lower-case sha256 digest."
  }
}

variable "acr_login_server" {
  description = "ACR login server hostname."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{5,50}\\.azurecr\\.io$", var.acr_login_server))
    error_message = "acr_login_server must contain a 5-50 character lower-case alphanumeric ACR name."
  }
}

variable "image_pull_identity_id" {
  description = "Image-pull user-assigned identity ARM resource ID."
  type        = string

  validation {
    condition = can(regex(
      "^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
      var.image_pull_identity_id
    ))
    error_message = "image_pull_identity_id must be a canonical UAMI ARM ID with exact path case and bounded lower-case segments."
  }
}

variable "runtime_identity_id" {
  description = "Runtime user-assigned identity ARM resource ID."
  type        = string

  validation {
    condition = can(regex(
      "^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
      var.runtime_identity_id
    ))
    error_message = "runtime_identity_id must be a canonical UAMI ARM ID with exact path case and bounded lower-case segments."
  }
}

variable "runtime_identity_client_id" {
  description = "Runtime user-assigned identity client ID."
  type        = string

  validation {
    condition = can(regex(
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      var.runtime_identity_client_id
    ))
    error_message = "runtime_identity_client_id must be a client ID UUID."
  }
}

variable "runtime_openai_user_role_assignment_id" {
  description = "Cognitive Services OpenAI User role assignment ID used as a Terraform dependency token."
  type        = string

  validation {
    condition     = trimspace(var.runtime_openai_user_role_assignment_id) != ""
    error_message = "runtime_openai_user_role_assignment_id must be nonempty."
  }
}

variable "runtime_monitoring_metrics_publisher_role_assignment_id" {
  description = "Monitoring Metrics Publisher role assignment ID used as a Terraform dependency token."
  type        = string

  validation {
    condition     = trimspace(var.runtime_monitoring_metrics_publisher_role_assignment_id) != ""
    error_message = "runtime_monitoring_metrics_publisher_role_assignment_id must be nonempty."
  }
}

variable "workload_table_endpoint" {
  description = "Azure Table endpoint for workload state."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9]{3,24}\\.table\\.core\\.windows\\.net/$", var.workload_table_endpoint))
    error_message = "workload_table_endpoint must be a canonical Azure Table endpoint."
  }
}

variable "security_state_table_name" {
  description = "SecurityState table name."
  type        = string

  validation {
    condition     = var.security_state_table_name == "SecurityState"
    error_message = "security_state_table_name must be exactly SecurityState."
  }
}

variable "rate_state_table_name" {
  description = "RateState table name."
  type        = string

  validation {
    condition     = var.rate_state_table_name == "RateState"
    error_message = "rate_state_table_name must be exactly RateState."
  }
}

variable "environment" {
  description = "Relay environment name."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be exactly dev, staging, or production."
  }
}

variable "relay_origin" {
  description = "Canonical Azure-provided WebSocket origin for the relay."
  type        = string

  validation {
    condition = (
      length(var.relay_origin) <= 259 &&
      length(trimprefix(var.relay_origin, "wss://")) <= 253 &&
      can(regex(
        "^wss://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\\.azurecontainerapps\\.io$",
        var.relay_origin
      ))
    )
    error_message = "relay_origin must be a bounded canonical Azure-provided wss:// DNS origin with labels of at most 63 characters and no path, query, or fragment."
  }
}

variable "browser_allowed_origins" {
  description = "Canonical HTTPS browser origins allowed to access the relay."
  type        = list(string)
  nullable    = false
  default     = ["https://even-webview.synthetic.invalid"]

  validation {
    condition = (
      length(var.browser_allowed_origins) <= 32 &&
      length(var.browser_allowed_origins) == length(toset(var.browser_allowed_origins)) &&
      alltrue([
        for origin in var.browser_allowed_origins :
        can(regex(
          "^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$",
          origin
        )) &&
        length(origin) <= 267 &&
        length(split(":", trimprefix(origin, "https://"))[0]) <= 253 &&
        !can(regex(
          "^https://(?:[a-z0-9-]+\\.)*(?:0x[0-9a-f]*|[0-9]+)(?::[0-9]+)?$",
          origin
        )) &&
        !can(regex(":443$", origin))
      ])
    )
    error_message = "browser_allowed_origins must contain 0-32 unique bounded canonical HTTPS origins with lowercase DNS labels of at most 63 characters, hostnames of at most 253 characters, a non-numeric/IP-like final host label, and no credentials, wildcard, whitespace, path, query, fragment, trailing slash, or explicit default port."
  }
}

variable "allow_null_browser_origin" {
  description = "Whether the relay may accept the literal null browser Origin."
  type        = bool
  nullable    = false
  default     = false
}

variable "gate_policy_version" {
  description = "Gate policy semver used by the relay protocol contract."
  type        = string
  default     = "1.0.0"

  validation {
    condition = length(var.gate_policy_version) >= 5 && length(var.gate_policy_version) <= 32 && can(regex(
      "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$",
      var.gate_policy_version
    ))
    error_message = "gate_policy_version must be a 5-32 character semver-ish major.minor.patch version."
  }
}

variable "target_port" {
  description = "Container App ingress and relay port."
  type        = number
  default     = 8787

  validation {
    condition     = var.target_port == 8787
    error_message = "target_port must be exactly 8787."
  }
}

variable "min_replicas" {
  description = "Minimum relay replica count; deployed workloads remain warm at exactly one replica."
  type        = number
  default     = 1

  validation {
    condition     = var.min_replicas == 1
    error_message = "min_replicas must be exactly 1 for the deployed relay workload."
  }
}

variable "security_mode" {
  description = "Relay security persistence mode. Deployed workloads require Azure Table storage."
  type        = string
  default     = "azure-table"
}

variable "transcription_provider" {
  description = "Relay transcription provider. Production permits mock or Azure realtime transcription."
  type        = string
  default     = "mock"

  validation {
    condition     = contains(["mock", "azure-realtime"], var.transcription_provider)
    error_message = "transcription_provider must be exactly mock or azure-realtime."
  }
}

variable "azure_transcription_endpoint" {
  description = "Canonical Azure realtime transcription endpoint; required only for azure-realtime."
  type        = string
  default     = ""

  validation {
    condition = var.azure_transcription_endpoint == "" || (
      length(var.azure_transcription_endpoint) <= 299 &&
      length(split("/", trimprefix(var.azure_transcription_endpoint, "wss://"))[0]) <= 253 &&
      can(regex(
        "^wss://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.openai\\.azure\\.com/openai/v1/realtime\\?intent=transcription$",
        var.azure_transcription_endpoint
      ))
    )
    error_message = "azure_transcription_endpoint must be empty or a bounded canonical lower-case Azure realtime transcription endpoint with DNS labels of at most 63 characters."
  }
}

variable "azure_transcription_deployment" {
  description = "Azure realtime transcription deployment; only gpt-4o-mini-transcribe is permitted."
  type        = string
  default     = ""

  validation {
    condition     = contains(["", "gpt-4o-mini-transcribe"], var.azure_transcription_deployment)
    error_message = "azure_transcription_deployment must be empty or exactly gpt-4o-mini-transcribe."
  }
}

variable "deployment_slot" {
  description = "Application Insights deployment slot emitted to the relay."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "production"], var.deployment_slot)
    error_message = "deployment_slot must be exactly dev, staging, or production."
  }
}

variable "language_boundary_mode" {
  description = "Explicit relay language boundary mode. Development may use the provisional local detector; staging and production must remain deny-all."
  type        = string

  validation {
    condition     = contains(["deny-all", "development-provisional"], var.language_boundary_mode)
    error_message = "language_boundary_mode must be exactly deny-all or development-provisional."
  }
}

variable "application_insights_connection_string" {
  description = "Required live four-field Application Insights connection string for production relay telemetry."
  type        = string
  sensitive   = true

  validation {
    condition = try(
      trimspace(var.application_insights_connection_string) == var.application_insights_connection_string &&
      length(var.application_insights_connection_string) > 0 &&
      length(var.application_insights_connection_string) <= 2048 &&
      !can(regex("[[:space:]]", var.application_insights_connection_string)) &&
      !can(regex("[[:cntrl:]]", var.application_insights_connection_string)) &&
      length(split(";", var.application_insights_connection_string)) == 4 &&
      length(toset([
        for segment in split(";", var.application_insights_connection_string) :
        split("=", segment)[0]
      ])) == 4 &&
      toset([
        for segment in split(";", var.application_insights_connection_string) :
        split("=", segment)[0]
      ]) == toset(["InstrumentationKey", "IngestionEndpoint", "LiveEndpoint", "ApplicationId"]) &&
      alltrue([
        for segment in split(";", var.application_insights_connection_string) :
        length(split("=", segment)) == 2 && (
          split("=", segment)[0] == "InstrumentationKey" ? can(regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
            split("=", segment)[1]
            )) : split("=", segment)[0] == "ApplicationId" ? can(regex(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            split("=", segment)[1]
            )) : split("=", segment)[0] == "IngestionEndpoint" ? (
            length(split("=", segment)[1]) <= 262 &&
            length(split("/", trimprefix(split("=", segment)[1], "https://"))[0]) <= 253 &&
            can(regex(
              "^https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.in\\.applicationinsights\\.azure\\.com|dc\\.services\\.visualstudio\\.com)/?$",
              split("=", segment)[1]
            ))
            ) : split("=", segment)[0] == "LiveEndpoint" ? (
            length(split("=", segment)[1]) <= 262 &&
            length(split("/", trimprefix(split("=", segment)[1], "https://"))[0]) <= 253 &&
            can(regex(
              "^https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.livediagnostics\\.monitor\\.azure\\.com|live\\.applicationinsights\\.azure\\.com)/?$",
              split("=", segment)[1]
            ))
          ) : false
        )
      ]),
      false
    )
    error_message = "application_insights_connection_string must contain exactly one canonical InstrumentationKey, IngestionEndpoint, LiveEndpoint, and ApplicationId with approved bounded HTTPS hosts and no whitespace, control characters, or extra fields."
  }
}

variable "azure_generation_endpoint" {
  description = "Canonical Azure OpenAI origin used for relay generation."
  type        = string

  validation {
    condition = (
      length(var.azure_generation_endpoint) <= 261 &&
      length(trimprefix(var.azure_generation_endpoint, "https://")) <= 253 &&
      can(regex(
        "^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.openai\\.azure\\.com$",
        var.azure_generation_endpoint
      ))
    )
    error_message = "azure_generation_endpoint must be a canonical lower-case HTTPS Azure OpenAI origin with an exact .openai.azure.com suffix and no port, path, query, fragment, whitespace, or trailing slash."
  }
}

variable "azure_generation_deployment" {
  description = "Fixed Azure OpenAI generation deployment."
  type        = string
  default     = "gpt-5.6-luna"

  validation {
    condition     = var.azure_generation_deployment == "gpt-5.6-luna"
    error_message = "azure_generation_deployment must be exactly gpt-5.6-luna."
  }
}
