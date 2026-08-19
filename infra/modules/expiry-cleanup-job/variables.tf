variable "name" {
  description = "Container Apps Job name."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$", var.name))
    error_message = "name must be a lower-case Container Apps Job name."
  }
}

variable "resource_group_id" {
  description = "Resource group ARM resource ID."
  type        = string

  validation {
    condition = can(regex(
      "^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9](?:[A-Za-z0-9._()-]{0,88}[A-Za-z0-9_()-])?$",
      var.resource_group_id
    ))
    error_message = "resource_group_id must be a canonical resource-group ARM ID with a lower-case subscription UUID and a conservative Azure resource-group name."
  }
}

variable "location" {
  description = "Azure region for the Container Apps Job."
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
      "^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9](?:[A-Za-z0-9._()-]{0,88}[A-Za-z0-9_()-])?/providers/Microsoft\\.App/managedEnvironments/[A-Za-z0-9](?:[A-Za-z0-9-]{0,58}[A-Za-z0-9])?$",
      var.container_app_environment_id
    ))
    error_message = "container_app_environment_id must be a canonical Microsoft.App/managedEnvironments ARM ID with safe name segments."
  }
}

variable "image_digest" {
  description = "Immutable lower-case ACR image digest."
  type        = string

  validation {
    condition = can(regex(
      "^[a-z0-9]{5,50}\\.azurecr\\.io/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$",
      var.image_digest
    ))
    error_message = "image_digest must use a 5-50 character lower-case alphanumeric ACR name, safe nonempty lower-case repository components, and an exact lower-case sha256 digest."
  }
}

variable "acr_login_server" {
  description = "Lower-case ACR login server hostname."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{5,50}\\.azurecr\\.io$", var.acr_login_server))
    error_message = "acr_login_server must contain a 5-50 character lower-case alphanumeric registry name followed by .azurecr.io."
  }
}

variable "image_pull_identity_id" {
  description = "Image-pull user-assigned identity ARM resource ID."
  type        = string

  validation {
    condition = can(regex(
      "^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9](?:[A-Za-z0-9._()-]{0,88}[A-Za-z0-9_()-])?/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9_])?$",
      var.image_pull_identity_id
    ))
    error_message = "image_pull_identity_id must be a canonical Microsoft.ManagedIdentity/userAssignedIdentities ARM ID with safe name segments."
  }
}

variable "runtime_identity_id" {
  description = "Runtime user-assigned identity ARM resource ID."
  type        = string

  validation {
    condition = can(regex(
      "^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9](?:[A-Za-z0-9._()-]{0,88}[A-Za-z0-9_()-])?/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9_])?$",
      var.runtime_identity_id
    ))
    error_message = "runtime_identity_id must be a canonical Microsoft.ManagedIdentity/userAssignedIdentities ARM ID with safe name segments."
  }
}

variable "runtime_identity_client_id" {
  description = "Canonical lower-case client ID for the runtime identity."
  type        = string

  validation {
    condition = can(regex(
      "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      var.runtime_identity_client_id
    ))
    error_message = "runtime_identity_client_id must be a canonical lower-case UUID."
  }
}

variable "workload_table_endpoint" {
  description = "Canonical HTTPS Azure Table endpoint with a trailing slash."
  type        = string

  validation {
    condition = can(regex(
      "^https://[a-z0-9]{3,24}\\.table\\.core\\.windows\\.net/$",
      var.workload_table_endpoint
    ))
    error_message = "workload_table_endpoint must be a canonical HTTPS Azure Table endpoint with a trailing slash."
  }
}

variable "security_state_table_name" {
  description = "Security state Table name."
  type        = string

  validation {
    condition     = var.security_state_table_name == "SecurityState"
    error_message = "security_state_table_name must be exactly SecurityState."
  }
}

variable "rate_state_table_name" {
  description = "Rate state Table name."
  type        = string

  validation {
    condition     = var.rate_state_table_name == "RateState"
    error_message = "rate_state_table_name must be exactly RateState."
  }
}

variable "environment" {
  description = "Canonical lower-case relay environment name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,63}$", var.environment))
    error_message = "environment must be a canonical lower-case relay environment name."
  }
}

variable "relay_origin" {
  description = "Canonical Azure Container Apps WebSocket origin."
  type        = string

  validation {
    condition = (
      length(var.relay_origin) <= 255 &&
      can(regex(
        "^wss://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\\.azurecontainerapps\\.io$",
        var.relay_origin
      ))
    )
    error_message = "relay_origin must be at most 255 characters and be a canonical lower-case Azure Container Apps wss:// origin with DNS labels of at most 63 characters and no port, credentials, trailing slash, path, query, or fragment."
  }
}

variable "cleanup_limit" {
  description = "Maximum number of expired rows the cleanup process visits."
  type        = number
  default     = 1000

  validation {
    condition     = var.cleanup_limit >= 1 && var.cleanup_limit <= 10000 && var.cleanup_limit == floor(var.cleanup_limit)
    error_message = "cleanup_limit must be an integer from 1 through 10000."
  }
}

variable "cleanup_timeout_ms" {
  description = "Cleanup process watchdog timeout in milliseconds."
  type        = number
  default     = 240000

  validation {
    condition     = var.cleanup_timeout_ms == 240000
    error_message = "cleanup_timeout_ms must be exactly 240000 milliseconds."
  }
}
