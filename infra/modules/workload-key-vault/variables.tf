variable "name" {
  description = "Deterministic globally unique lower-case Key Vault name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,22}[a-z0-9]$", var.name))
    error_message = "name must be 3-24 characters, start with a lower-case letter, end with a lower-case letter or digit, and contain only lower-case letters, digits, and hyphens."
  }
}

variable "resource_group_name" {
  description = "Resource group containing the Key Vault."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "tags" {
  description = "Required foundation tags."
  type        = map(string)
}

variable "runtime_principal_id" {
  description = "Microsoft Entra object ID of the workload runtime identity."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.runtime_principal_id))
    error_message = "runtime_principal_id must be a UUID."
  }
}

variable "key_vault_secrets_user_role_definition_id" {
  description = "Stable built-in Key Vault Secrets User role definition ID."
  type        = string
  default     = "4633458b-17de-408a-b874-0445c86b69e6"
}

variable "key_vault_secrets_officer_role_definition_id" {
  description = "Stable built-in Key Vault Secrets Officer role definition ID."
  type        = string
  default     = "b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
}
