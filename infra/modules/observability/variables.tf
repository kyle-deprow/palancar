variable "workspace_name" {
  description = "Log Analytics workspace name."
  type        = string
}

variable "application_insights_name" {
  description = "Workspace-based Application Insights name."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group containing observability resources."
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

variable "retention_in_days" {
  description = "Operational telemetry retention; fixed to 30 days by policy."
  type        = number
  default     = 30

  validation {
    condition     = var.retention_in_days == 30
    error_message = "retention_in_days must remain exactly 30 days."
  }
}
