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
    condition     = can(regex("^/subscriptions/[^/]+/resourceGroups/[^/]+$", var.resource_group_id))
    error_message = "resource_group_id must be a resource-group ARM resource ID."
  }
}

variable "resource_group_name" {
  description = "Resource group name."
  type        = string

  validation {
    condition     = trimspace(var.resource_group_name) != ""
    error_message = "resource_group_name must be nonempty."
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
      "^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/[^/]+/[^/]+/.+$",
      var.container_app_environment_id
    ))
    error_message = "container_app_environment_id must be a nonempty ARM resource ID."
  }
}

variable "image_digest" {
  description = "Immutable ACR image digest."
  type        = string

  validation {
    condition = can(regex(
      "^[a-z0-9.-]+\\.azurecr\\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$",
      var.image_digest
    ))
    error_message = "image_digest must be an immutable lower-case ACR sha256 digest."
  }
}

variable "acr_login_server" {
  description = "ACR login server hostname."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9.-]+\\.azurecr\\.io$", var.acr_login_server))
    error_message = "acr_login_server must be an ACR login server hostname."
  }
}

variable "image_pull_identity_id" {
  description = "Image-pull user-assigned identity ARM resource ID."
  type        = string

  validation {
    condition = can(regex(
      "(?i)^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[^/]+$",
      var.image_pull_identity_id
    ))
    error_message = "image_pull_identity_id must be a user-assigned managed identity ARM resource ID."
  }
}

variable "runtime_identity_id" {
  description = "Runtime user-assigned identity ARM resource ID."
  type        = string

  validation {
    condition = can(regex(
      "(?i)^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[^/]+$",
      var.runtime_identity_id
    ))
    error_message = "runtime_identity_id must be a user-assigned managed identity ARM resource ID."
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
    condition     = trimspace(var.environment) != ""
    error_message = "environment must be nonempty."
  }
}

variable "relay_origin" {
  description = "Canonical Azure-provided WebSocket origin for the relay."
  type        = string

  validation {
    condition = can(regex(
      "^wss://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.azurecontainerapps\\.io$",
      var.relay_origin
    ))
    error_message = "relay_origin must be a canonical Azure-provided wss:// origin without a path, query, or fragment."
  }
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
  description = "Minimum relay replica count; development may scale to zero or remain warm."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 1], var.min_replicas)
    error_message = "min_replicas must be exactly 0 or 1."
  }
}

variable "security_mode" {
  description = "Relay security persistence mode. Deployed workloads require Azure Table storage."
  type        = string
  default     = "azure-table"
}

variable "transcription_provider" {
  description = "Relay transcription provider. Azure transcription remains blocked."
  type        = string
  default     = "mock"
}

variable "azure_transcription_endpoint" {
  description = "Qualification-blocked Azure transcription endpoint; must remain empty."
  type        = string
  default     = ""
}

variable "azure_transcription_deployment" {
  description = "Qualification-blocked Azure transcription deployment; must remain empty."
  type        = string
  default     = ""
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
    condition = var.litellm_image_digest == "" || can(regex(
      "^[a-z0-9.-]+\\.azurecr\\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$",
      var.litellm_image_digest
    ))
    error_message = "litellm_image_digest must be empty or an immutable lower-case ACR sha256 digest."
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
    condition     = trimspace(var.litellm_upstream_model) == "" || length(var.litellm_upstream_model) <= 128
    error_message = "litellm_upstream_model must be empty or at most 128 characters."
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
}

variable "azure_api_version" {
  description = "Qualification-blocked LiteLLM Azure API version; must remain empty."
  type        = string
  default     = ""
}
