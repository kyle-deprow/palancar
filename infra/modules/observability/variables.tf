variable "workspace_name" {
  description = "Log Analytics workspace name."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9-]{2,61}[A-Za-z0-9]$", var.workspace_name))
    error_message = "workspace_name must be a 4-63 character Azure Log Analytics workspace name."
  }
}

variable "application_insights_name" {
  description = "Workspace-based Application Insights name."
  type        = string
  nullable    = false

  validation {
    condition = (
      length(var.application_insights_name) >= 1 &&
      length(var.application_insights_name) <= 224 &&
      trimspace(var.application_insights_name) == var.application_insights_name &&
      !endswith(var.application_insights_name, ".") &&
      can(regex("^[A-Za-z0-9][A-Za-z0-9._ -]*$", var.application_insights_name))
    )
    error_message = "application_insights_name must be 1-224 characters from the conservative alphanumeric, space, dot, underscore, and hyphen subset, with no trailing space or dot."
  }
}

variable "resource_group_name" {
  description = "Resource group containing observability resources."
  type        = string
  nullable    = false

  validation {
    condition = (
      length(var.resource_group_name) >= 1 &&
      length(var.resource_group_name) <= 90 &&
      trimspace(var.resource_group_name) == var.resource_group_name &&
      !endswith(var.resource_group_name, ".") &&
      can(regex("^[A-Za-z0-9][A-Za-z0-9._()-]*$", var.resource_group_name))
    )
    error_message = "resource_group_name must be 1-90 characters from the conservative alphanumeric, dot, underscore, hyphen, and parentheses subset, with no trailing space or dot."
  }
}

variable "location" {
  description = "Reviewed Azure region for observability resources."
  type        = string
  nullable    = false

  validation {
    condition     = var.location == "eastus2"
    error_message = "location must be the reviewed deployable region eastus2."
  }
}

variable "tags" {
  description = "Required foundation tags."
  type        = map(string)
  nullable    = false

  validation {
    condition = (
      length(var.tags) >= 1 &&
      length(var.tags) <= 15 &&
      alltrue([
        for key, value in var.tags :
        length(key) >= 1 &&
        length(key) <= 512 &&
        length(value) >= 1 &&
        length(value) <= 256 &&
        trimspace(key) == key &&
        trimspace(value) == value &&
        length(regexall("[<>%&\\\\?/]", key)) == 0
      ])
    )
    error_message = "tags must contain 1-15 entries; keys must be 1-512 trimmed characters without <, >, %, &, backslash, ?, or /, and values must be 1-256 trimmed characters. The 15-tag limit is required by saved searches."
  }
}

variable "retention_in_days" {
  description = "Operational telemetry retention; fixed to 30 days by policy."
  type        = number
  nullable    = false
  default     = 30

  validation {
    condition     = var.retention_in_days == 30
    error_message = "retention_in_days must remain exactly 30 days."
  }
}

variable "alert_action_group_ids" {
  description = "Azure Monitor action group resource IDs notified by every enabled relay alert."
  type        = set(string)
  nullable    = false
  default     = []

  validation {
    condition = (
      length(var.alert_action_group_ids) <= 5 &&
      alltrue([
        for id in var.alert_action_group_ids :
        try(
          length(split("/", id)) == 9 &&
          split("/", id)[0] == "" &&
          split("/", id)[1] == "subscriptions" &&
          can(regex("^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", split("/", id)[2])) &&
          split("/", id)[3] == "resourceGroups" &&
          length(split("/", id)[4]) >= 1 &&
          length(split("/", id)[4]) <= 90 &&
          can(regex("^[A-Za-z0-9._()-]+$", split("/", id)[4])) &&
          !endswith(split("/", id)[4], ".") &&
          split("/", id)[5] == "providers" &&
          split("/", id)[6] == "Microsoft.Insights" &&
          split("/", id)[7] == "actionGroups" &&
          length(split("/", id)[8]) >= 1 &&
          length(split("/", id)[8]) <= 260 &&
          trimspace(split("/", id)[8]) == split("/", id)[8] &&
          can(regex("^[A-Za-z0-9 ._()-]+$", split("/", id)[8])) &&
          !endswith(split("/", id)[8], "."),
          false,
        )
      ])
    )
    error_message = "alert_action_group_ids must contain at most five strict Azure Monitor action group ARM IDs: UUID subscription; 1-90 character resource group using the reviewed Azure subset without a trailing period; and 1-260 character action group using alphanumerics, spaces, dots, underscores, hyphens, or parentheses without leading/trailing spaces or a trailing period."
  }
}

variable "alerts_enabled" {
  description = "Whether to create the six baseline relay operational alerts."
  type        = bool
  nullable    = false
  default     = false

  validation {
    condition     = !var.alerts_enabled || (length(var.alert_action_group_ids) >= 1 && length(var.alert_action_group_ids) <= 5)
    error_message = "alerts_enabled requires one to five valid alert_action_group_ids."
  }
}

variable "alert_thresholds" {
  description = "Positive integer thresholds for low-cardinality relay operational alerts."
  type = object({
    provider_failure_count        = number
    state_store_failure_count     = number
    first_partial_latency_mean_ms = number
    final_latency_mean_ms         = number
    translation_latency_mean_ms   = number
    suggestion_latency_mean_ms    = number
  })
  nullable = false
  default = {
    provider_failure_count        = 5
    state_store_failure_count     = 1
    first_partial_latency_mean_ms = 1500
    final_latency_mean_ms         = 1200
    translation_latency_mean_ms   = 5000
    suggestion_latency_mean_ms    = 5000
  }

  validation {
    condition = alltrue([
      for threshold in values(var.alert_thresholds) :
      threshold > 0 && threshold == floor(threshold)
    ])
    error_message = "Every alert threshold must be a positive integer."
  }

  validation {
    condition = (
      var.alert_thresholds.provider_failure_count <= 1000000 &&
      var.alert_thresholds.state_store_failure_count <= 1000000 &&
      var.alert_thresholds.first_partial_latency_mean_ms <= 300000 &&
      var.alert_thresholds.final_latency_mean_ms <= 300000 &&
      var.alert_thresholds.translation_latency_mean_ms <= 300000 &&
      var.alert_thresholds.suggestion_latency_mean_ms <= 300000
    )
    error_message = "Count thresholds must not exceed 1,000,000 and latency thresholds must not exceed 300,000 ms."
  }
}
