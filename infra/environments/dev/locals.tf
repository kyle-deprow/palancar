locals {
  derived_suffix = substr(sha256("${var.subscription_id}-${var.environment}"), 0, 8)
  suffix         = var.state_suffix == "auto" ? local.derived_suffix : var.state_suffix
  name_seed      = substr(replace("${var.prefix}${var.environment}", "-", ""), 0, 12)

  tags = {
    application         = var.prefix
    environment         = var.environment
    managed-by          = "terraform"
    data-classification = "operational-metadata"
  }

  names = {
    resource_group        = "rg-${var.prefix}-${var.environment}-${local.suffix}"
    workload_state        = substr("${local.name_seed}state${local.suffix}", 0, 24)
    acr                   = substr("${local.name_seed}acr${local.suffix}", 0, 50)
    log_analytics         = "law-${var.prefix}-${var.environment}-${local.suffix}"
    application_insights  = "appi-${var.prefix}-${var.environment}-${local.suffix}"
    container_environment = "cae-${var.prefix}-${var.environment}-${local.suffix}"
    foundry               = substr("${local.name_seed}openai${local.suffix}", 0, 64)
  }
}
