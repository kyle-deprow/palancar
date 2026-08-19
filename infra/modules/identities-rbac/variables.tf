variable "resource_group_name" {
  description = "Resource group for the managed identities."
  type        = string
}

variable "subscription_id" {
  description = "Subscription used to construct full built-in role-definition resource IDs."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.subscription_id))
    error_message = "subscription_id must be a canonical lower-case UUID."
  }
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "prefix" {
  description = "Naming prefix."
  type        = string
}

variable "environment" {
  description = "Environment name."
  type        = string
}

variable "tags" {
  description = "Required foundation tags."
  type        = map(string)
}

variable "container_registry_id" {
  description = "ACR scope for the image-pull AcrPull assignment."
  type        = string
}

variable "workload_state_storage_account_id" {
  description = "Workload-state account scope for runtime Table Data Contributor."
  type        = string
}

variable "security_state_table_id" {
  description = "Exact SecurityState table scope for the smoke-test operator."
  type        = string

  validation {
    condition = can(regex(
      "^/subscriptions/[0-9a-fA-F-]+/resourceGroups/[^/]+/providers/Microsoft\\.Storage/storageAccounts/[^/]+/tableServices/default/tables/SecurityState$",
      var.security_state_table_id
    ))
    error_message = "security_state_table_id must be the exact SecurityState table resource ID."
  }
}

variable "rate_state_table_id" {
  description = "Exact RateState table scope for the smoke-test operator."
  type        = string

  validation {
    condition = can(regex(
      "^/subscriptions/[0-9a-fA-F-]+/resourceGroups/[^/]+/providers/Microsoft\\.Storage/storageAccounts/[^/]+/tableServices/default/tables/RateState$",
      var.rate_state_table_id
    ))
    error_message = "rate_state_table_id must be the exact RateState table resource ID."
  }
}

variable "operator_principal_id" {
  description = "Canonical Microsoft Entra object ID for the human smoke-test operator."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.operator_principal_id))
    error_message = "operator_principal_id must be a canonical lower-case UUID."
  }
}

variable "cognitive_account_id" {
  description = "Foundry/OpenAI account scope for runtime inference access."
  type        = string
}

variable "application_insights_id" {
  description = "Exact Application Insights component scope for runtime monitoring metrics publishing."
  type        = string

  validation {
    condition = can(regex(
      "^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9](?:[A-Za-z0-9._()-]{0,88}[A-Za-z0-9_()-])?/providers/Microsoft\\.Insights/components/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,222}[A-Za-z0-9_-])?$",
      var.application_insights_id
    ))
    error_message = "application_insights_id must be an exact canonical Application Insights component ARM ID with a 1-90 character resource-group segment and a 1-224 character component segment from the conservative character sets."
  }
}

variable "acr_pull_role_definition_id" {
  description = "Stable AcrPull role definition ID."
  type        = string
  default     = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
}

variable "table_data_contributor_role_definition_id" {
  description = "Stable Storage Table Data Contributor role definition ID."
  type        = string
  default     = "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3"
}

variable "openai_user_role_definition_id" {
  description = "Stable Cognitive Services OpenAI User role definition ID."
  type        = string
  default     = "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"
}

variable "monitoring_metrics_publisher_role_definition_id" {
  description = "Stable Monitoring Metrics Publisher role definition ID."
  type        = string
  default     = "3913510d-42f4-4e42-8a64-420c390055eb"

  validation {
    condition     = var.monitoring_metrics_publisher_role_definition_id == "3913510d-42f4-4e42-8a64-420c390055eb"
    error_message = "monitoring_metrics_publisher_role_definition_id must be the built-in Monitoring Metrics Publisher role UUID 3913510d-42f4-4e42-8a64-420c390055eb."
  }
}
