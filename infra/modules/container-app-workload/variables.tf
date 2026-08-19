variable "name" {
  description = "Container App name."
  type        = string

  validation {
    condition     = trimspace(var.name) != ""
    error_message = "name must be nonempty."
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
  description = "Immutable ACR image digest."
  type        = string

  validation {
    condition = try(
      length(var.image_digest) <= 512 &&
      can(regex(
        "^[a-z0-9]{5,50}\\.azurecr\\.io/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$",
        var.image_digest
      )) &&
      alltrue([
        for component in slice(
          split("/", split("@", var.image_digest)[0]),
          1,
          length(split("/", split("@", var.image_digest)[0]))
        ) : length(component) >= 1 && length(component) <= 128
      ]),
      false
    )
    error_message = "image_digest must be an immutable lower-case ACR sha256 digest with a 5-50 character registry and safe bounded repository components."
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

variable "runtime_secrets_user_role_assignment_id" {
  description = "Key Vault Secrets User role assignment ID used as a Terraform dependency token."
  type        = string

  validation {
    condition     = trimspace(var.runtime_secrets_user_role_assignment_id) != ""
    error_message = "runtime_secrets_user_role_assignment_id must be nonempty."
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

variable "enable_litellm_sidecar" {
  description = "Whether to add the optional LiteLLM generation sidecar."
  type        = bool
  default     = false
}

variable "litellm_image_digest" {
  description = "Immutable LiteLLM sidecar image digest in acr_login_server."
  type        = string
  default     = ""

  validation {
    condition = var.litellm_image_digest == "" || try(
      length(var.litellm_image_digest) <= 512 &&
      can(regex(
        "^[a-z0-9]{5,50}\\.azurecr\\.io/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$",
        var.litellm_image_digest
      )) &&
      alltrue([
        for component in slice(
          split("/", split("@", var.litellm_image_digest)[0]),
          1,
          length(split("/", split("@", var.litellm_image_digest)[0]))
        ) : length(component) >= 1 && length(component) <= 128
      ]),
      false
    )
    error_message = "litellm_image_digest must be empty or an immutable lower-case ACR sha256 digest with a 5-50 character registry and safe bounded repository components."
  }
}

variable "litellm_backend" {
  description = "LiteLLM upstream backend; only OpenRouter is production-qualified."
  type        = string
  default     = ""

  validation {
    condition     = contains(["", "openrouter"], var.litellm_backend)
    error_message = "litellm_backend must be empty or openrouter; Azure is not qualified."
  }
}

variable "litellm_upstream_model" {
  description = "Provider-prefixed upstream model routed by LiteLLM."
  type        = string
  default     = ""

  validation {
    condition = var.litellm_upstream_model == "" || (
      length(var.litellm_upstream_model) <= 194 &&
      can(regex(
        "^openrouter/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?/[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$",
        var.litellm_upstream_model
      ))
    )
    error_message = "litellm_upstream_model must be empty or an exact bounded lower-case openrouter/owner/model identifier."
  }
}

variable "openrouter_api_key_secret_url" {
  description = "HTTPS Key Vault secret URL for the OpenRouter API key."
  type        = string
  default     = ""

  validation {
    condition     = var.openrouter_api_key_secret_url == "" || can(regex("^https://[^[:space:]]+$", var.openrouter_api_key_secret_url))
    error_message = "openrouter_api_key_secret_url must be empty or an HTTPS URL."
  }
}

variable "litellm_master_key_secret_url" {
  description = "HTTPS Key Vault secret URL for the LiteLLM master key."
  type        = string
  default     = ""

  validation {
    condition     = var.litellm_master_key_secret_url == "" || can(regex("^https://[^[:space:]]+$", var.litellm_master_key_secret_url))
    error_message = "litellm_master_key_secret_url must be empty or an HTTPS URL."
  }
}

variable "key_vault_uri" {
  description = "Same-vault URI used to validate versionless sidecar secret references."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9-]+\\.vault\\.azure\\.net/$", var.key_vault_uri))
    error_message = "key_vault_uri must be an Azure Key Vault URI ending in a slash."
  }
}

variable "azure_api_base" {
  description = "Qualification-blocked LiteLLM Azure API base; must remain empty."
  type        = string
  default     = ""

  validation {
    condition     = var.azure_api_base == ""
    error_message = "azure_api_base must be exactly empty because Azure generation is not qualified."
  }
}

variable "azure_api_version" {
  description = "Qualification-blocked LiteLLM Azure API version; must remain empty."
  type        = string
  default     = ""

  validation {
    condition     = var.azure_api_version == ""
    error_message = "azure_api_version must be exactly empty because Azure generation is not qualified."
  }
}
