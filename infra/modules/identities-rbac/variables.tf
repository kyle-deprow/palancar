variable "resource_group_name" {
  description = "Resource group for the managed identities."
  type        = string
}

variable "subscription_id" {
  description = "Subscription used to construct full built-in role-definition resource IDs."
  type        = string
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
