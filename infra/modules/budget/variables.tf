variable "name" {
  description = "Budget resource name."
  type        = string
}

variable "resource_group_id" {
  description = "Resource group scope for the budget."
  type        = string
}

variable "amount" {
  description = "Monthly budget amount in the subscription currency."
  type        = number

  validation {
    condition     = var.amount > 0
    error_message = "amount must be positive."
  }
}

variable "start_date" {
  description = "RFC3339 monthly budget start at UTC midnight on day 01."
  type        = string

  validation {
    condition     = can(formatdate("YYYY-MM-DD", var.start_date)) && can(regex("^[0-9]{4}-(0[1-9]|1[0-2])-01T00:00:00Z$", var.start_date))
    error_message = "start_date must be RFC3339 at UTC midnight on the first day of a month."
  }
}

variable "end_date" {
  description = "RFC3339 budget end at UTC midnight on day 01, after start and no more than five years later."
  type        = string

  validation {
    condition = (
      can(formatdate("YYYY-MM-DD", var.end_date)) &&
      can(regex("^[0-9]{4}-(0[1-9]|1[0-2])-01T00:00:00Z$", var.end_date)) &&
      try(timecmp(var.end_date, var.start_date), 0) > 0 &&
      try(timecmp(var.end_date, timeadd(var.start_date, "43848h")), 1) <= 0
    )
    error_message = "end_date must be first-of-month UTC midnight, after start_date, and within five years."
  }
}

variable "contact_emails" {
  description = "At least one syntactically plausible budget notification address."
  type        = list(string)

  validation {
    condition = length(var.contact_emails) > 0 && alltrue([
      for email in var.contact_emails :
      can(regex("^[^@ ]+@[^@ ]+\\.[^@ ]+$", trimspace(email))) &&
      !can(regex("@(example\\.com|[^@]+\\.(invalid|test|example))$", lower(trimspace(email))))
    ])
    error_message = "contact_emails must contain at least one plausible live address and must not use reserved example/test domains."
  }
}

variable "forecast_threshold" {
  description = "Forecasted spend threshold percentage."
  type        = number
  default     = 80

  validation {
    condition     = var.forecast_threshold > 0 && var.forecast_threshold <= 100
    error_message = "forecast_threshold must be greater than 0 and at most 100."
  }
}
