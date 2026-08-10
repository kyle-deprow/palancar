variable "name" {
  description = "Deterministic globally unique workload-state storage account name."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group containing workload state."
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

variable "public_network_access_enabled" {
  description = "Allow the initial Azure-hosted workload and Azure CLI phase to reach the account."
  type        = bool
  default     = true
}
