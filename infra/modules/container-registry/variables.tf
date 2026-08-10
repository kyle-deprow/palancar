variable "name" {
  description = "Globally unique lower-case Azure Container Registry name."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group containing ACR."
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
