variable "subscription_id" {
  description = "Azure subscription."
  type        = string
  default     = "a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1"

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a UUID."
  }
}

variable "tenant_id" {
  description = "Microsoft Entra tenant."
  type        = string
  default     = "c69da7c1-f194-493b-9697-5b4bc8b56f37"

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.tenant_id))
    error_message = "tenant_id must be a UUID."
  }
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "eastus2"

  validation {
    condition     = var.location == "eastus2"
    error_message = "location must be eastus2 because the reviewed model/version/quota evidence is region-specific."
  }
}

variable "prefix" {
  description = "Lower-case Azure naming prefix."
  type        = string
  default     = "palancar"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,14}[a-z0-9])$", var.prefix))
    error_message = "prefix must be 2-16 characters and contain only lower-case letters, digits, and internal hyphens."
  }
}

variable "environment" {
  description = "Lower-case environment name."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,14}[a-z0-9])$", var.environment))
    error_message = "environment must be 2-16 characters and contain only lower-case letters, digits, and internal hyphens."
  }
}

variable "state_suffix" {
  description = "Optional lower-case suffix; auto derives a stable eight-character subscription/environment suffix."
  type        = string
  default     = "auto"

  validation {
    condition     = var.state_suffix == "auto" || can(regex("^[a-z0-9]{4,12}$", var.state_suffix))
    error_message = "state_suffix must be auto or 4-12 lower-case letters/digits."
  }
}

variable "budget_amount" {
  description = "Monthly resource-group budget amount."
  type        = number
  default     = 100

  validation {
    condition     = var.budget_amount > 0
    error_message = "budget_amount must be positive."
  }
}

variable "budget_start_date" {
  description = "Required RFC3339 monthly budget start at UTC midnight on day 01."
  type        = string

  validation {
    condition     = can(formatdate("YYYY-MM-DD", var.budget_start_date)) && can(regex("^[0-9]{4}-(0[1-9]|1[0-2])-01T00:00:00Z$", var.budget_start_date))
    error_message = "budget_start_date must be RFC3339 at UTC midnight on the first day of a month."
  }
}

variable "budget_end_date" {
  description = "Required RFC3339 budget end at UTC midnight on day 01, after start and no more than five years later."
  type        = string

  validation {
    condition = (
      can(formatdate("YYYY-MM-DD", var.budget_end_date)) &&
      can(regex("^[0-9]{4}-(0[1-9]|1[0-2])-01T00:00:00Z$", var.budget_end_date)) &&
      try(timecmp(var.budget_end_date, var.budget_start_date), 0) > 0 &&
      try(timecmp(var.budget_end_date, timeadd(var.budget_start_date, "43848h")), 1) <= 0
    )
    error_message = "budget_end_date must be first-of-month UTC midnight, after budget_start_date, and within five years."
  }
}

variable "budget_contact_emails" {
  description = "Required live budget contacts; reserved example/test domains are rejected."
  type        = list(string)

  validation {
    condition = length(var.budget_contact_emails) > 0 && alltrue([
      for email in var.budget_contact_emails :
      can(regex("^[^@ ]+@[^@ ]+\\.[^@ ]+$", trimspace(email))) &&
      !can(regex("@(example\\.com|[^@]+\\.(invalid|test|example))$", lower(trimspace(email))))
    ])
    error_message = "budget_contact_emails must contain at least one plausible live address and must not use example.com, .invalid, .test, or .example."
  }
}

variable "budget_forecast_threshold" {
  description = "Forecasted budget notification threshold percentage."
  type        = number
  default     = 80

  validation {
    condition     = var.budget_forecast_threshold > 0 && var.budget_forecast_threshold <= 100
    error_message = "budget_forecast_threshold must be greater than 0 and at most 100."
  }
}

variable "workload_state_public_network_access_enabled" {
  description = "Initial Azure-hosted workload/CLI access posture for workload state."
  type        = bool
  default     = true
}

variable "retention_in_days" {
  description = "Operational telemetry retention, fixed by ADR 0004."
  type        = number
  default     = 30

  validation {
    condition     = var.retention_in_days == 30
    error_message = "retention_in_days must be exactly 30."
  }
}

variable "foundry_deployments" {
  description = "Required reviewed map of exactly two pinned OpenAI model deployments."
  type = map(object({
    model_name             = string
    model_version          = string
    model_format           = string
    sku_name               = string
    capacity               = number
    version_upgrade_option = string
  }))

  validation {
    condition     = length(var.foundry_deployments) == 2
    error_message = "foundry_deployments must contain exactly two distinctly named entries."
  }

  validation {
    condition = alltrue([
      for deployment_name, deployment in var.foundry_deployments :
      trimspace(deployment_name) != "" &&
      trimspace(deployment.model_name) != "" &&
      trimspace(deployment.model_version) != "" &&
      deployment.model_format == "OpenAI" &&
      deployment.sku_name == "GlobalStandard" &&
      deployment.capacity > 0 &&
      deployment.capacity == floor(deployment.capacity) &&
      deployment.version_upgrade_option == "NoAutoUpgrade"
    ])
    error_message = "Each deployment requires nonempty names/version, OpenAI format, GlobalStandard SKU, positive integer capacity, and NoAutoUpgrade."
  }
}

variable "acr_pull_role_definition_id" {
  description = "Verified AcrPull role definition ID."
  type        = string
  default     = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
}

variable "table_data_contributor_role_definition_id" {
  description = "Verified Storage Table Data Contributor role definition ID."
  type        = string
  default     = "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3"
}

variable "openai_user_role_definition_id" {
  description = "Verified Cognitive Services OpenAI User role definition ID."
  type        = string
  default     = "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"
}

variable "relay_image_digest" {
  description = "Optional immutable ACR digest for the relay workload."
  type        = string
  default     = ""

  validation {
    condition = var.relay_image_digest == "" || can(regex(
      "^[a-z0-9.-]+\\.azurecr\\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$",
      var.relay_image_digest
    ))
    error_message = "relay_image_digest must be empty or an immutable lower-case ACR sha256 digest."
  }
}

variable "deploy_relay_workload" {
  description = "Whether to deploy the immutable relay Container App workload."
  type        = bool
  default     = false
}

variable "enable_litellm_sidecar" {
  description = "Whether to add the optional LiteLLM generation sidecar to the relay workload."
  type        = bool
  default     = false
}

variable "litellm_image_digest" {
  description = "Immutable LiteLLM sidecar image digest."
  type        = string
  default     = ""

  validation {
    condition = var.litellm_image_digest == "" || can(regex(
      "^[^[:space:]@]+@sha256:[0-9a-f]{64}$",
      var.litellm_image_digest
    ))
    error_message = "litellm_image_digest must be empty or an immutable image sha256 digest."
  }
}

variable "litellm_backend" {
  description = "LiteLLM upstream backend."
  type        = string
  default     = "openrouter"

  validation {
    condition     = contains(["openrouter", "azure"], var.litellm_backend)
    error_message = "litellm_backend must be openrouter or azure."
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

variable "azure_api_base" {
  description = "Azure OpenAI API base used by LiteLLM in Azure mode."
  type        = string
  default     = ""
}

variable "azure_api_version" {
  description = "Azure OpenAI API version used by LiteLLM in Azure mode."
  type        = string
  default     = ""
}

variable "azure_api_key_secret_url" {
  description = "HTTPS Key Vault secret URL for the Azure OpenAI API key."
  type        = string
  default     = ""

  validation {
    condition     = var.azure_api_key_secret_url == "" || can(regex("^https://[^[:space:]]+$", var.azure_api_key_secret_url))
    error_message = "azure_api_key_secret_url must be empty or an HTTPS URL."
  }
}

variable "litellm_cpu" {
  description = "CPU allocation for the LiteLLM sidecar."
  type        = number
  default     = 0.25

  validation {
    condition     = var.litellm_cpu > 0
    error_message = "litellm_cpu must be positive."
  }
}

variable "litellm_memory" {
  description = "Memory allocation for the LiteLLM sidecar."
  type        = string
  default     = "0.5Gi"

  validation {
    condition     = trimspace(var.litellm_memory) != ""
    error_message = "litellm_memory must be nonempty."
  }
}
