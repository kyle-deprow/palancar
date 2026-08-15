variable "name" {
  description = "Azure OpenAI account name."
  type        = string
}

variable "custom_subdomain_name" {
  description = "Custom subdomain used by the OpenAI endpoint."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group containing the account."
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

variable "deployments" {
  description = "Pinned OpenAI model deployments."
  type = map(object({
    model_name             = string
    model_version          = string
    model_format           = string
    sku_name               = string
    capacity               = number
    version_upgrade_option = string
  }))

  validation {
    condition = alltrue([
      for deployment_name, deployment in var.deployments :
      can(regex("^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$", deployment_name)) &&
      trimspace(deployment.model_name) != "" &&
      trimspace(deployment.model_version) != "" &&
      deployment.model_format == "OpenAI" &&
      deployment.capacity > 0 &&
      deployment.capacity == floor(deployment.capacity) &&
      deployment.sku_name == "GlobalStandard" &&
      deployment.version_upgrade_option == "NoAutoUpgrade"
    ])
    error_message = "Deployments require Azure-safe names, nonempty model/version, OpenAI format, GlobalStandard, positive integer capacity, and NoAutoUpgrade."
  }
}
