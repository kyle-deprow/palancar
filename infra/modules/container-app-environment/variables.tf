variable "name" {
  description = "Container Apps environment name."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group containing the environment."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "log_analytics_workspace_id" {
  description = "Workspace resource ID."
  type        = string
}

variable "tags" {
  description = "Required foundation tags."
  type        = map(string)
}
