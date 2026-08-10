variable "subscription_id" {
  description = "Azure subscription that owns the Terraform state bootstrap resources."
  type        = string
  default     = "a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1"

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a UUID."
  }
}

variable "tenant_id" {
  description = "Microsoft Entra tenant used by the Azure CLI identity."
  type        = string
  default     = "c69da7c1-f194-493b-9697-5b4bc8b56f37"

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.tenant_id))
    error_message = "tenant_id must be a UUID."
  }
}

variable "location" {
  description = "Azure region for the bootstrap resources."
  type        = string
  default     = "eastus2"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.location))
    error_message = "location must be a lower-case Azure region name."
  }
}

variable "prefix" {
  description = "Lower-case naming prefix."
  type        = string
  default     = "palancar"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,14}[a-z0-9])$", var.prefix))
    error_message = "prefix must be 2-16 characters and contain only lower-case letters, digits, and internal hyphens."
  }
}

variable "environment" {
  description = "Lower-case environment name used in deterministic naming."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,14}[a-z0-9])$", var.environment))
    error_message = "environment must be 2-16 characters and contain only lower-case letters, digits, and internal hyphens."
  }
}

variable "state_suffix" {
  description = "Optional 4-12 character lower-case suffix; auto derives eight hex characters from subscription and environment."
  type        = string
  default     = "auto"

  validation {
    condition     = var.state_suffix == "auto" || can(regex("^[a-z0-9]{4,12}$", var.state_suffix))
    error_message = "state_suffix must be auto or 4-12 lower-case letters/digits."
  }
}

variable "bootstrap_container_name" {
  description = "Private blob container dedicated to bootstrap Terraform state."
  type        = string
  default     = "tfstate-bootstrap"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$", var.bootstrap_container_name))
    error_message = "bootstrap_container_name must be a valid lower-case Azure blob container name."
  }
}

variable "dev_container_name" {
  description = "Private blob container dedicated to development Terraform state."
  type        = string
  default     = "tfstate-dev"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$", var.dev_container_name))
    error_message = "dev_container_name must be a valid lower-case Azure blob container name."
  }

  validation {
    condition     = var.dev_container_name != var.bootstrap_container_name
    error_message = "dev_container_name must differ from bootstrap_container_name."
  }
}

variable "grant_apply_principal_blob_data_contributor" {
  description = "Grant the current Azure CLI apply principal Storage Blob Data Contributor on the bootstrap account. Keep enabled for the initial Entra-authenticated container creation."
  type        = bool
  default     = true
}

variable "blob_data_contributor_role_definition_id" {
  description = "Stable role definition ID for Storage Blob Data Contributor."
  type        = string
  default     = "ba92f5b4-2d11-453d-a403-e96b0029c9fe"

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.blob_data_contributor_role_definition_id))
    error_message = "blob_data_contributor_role_definition_id must be a UUID."
  }
}
