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
    relay_container_app   = "ca-${var.prefix}-${var.environment}-relay-${local.suffix}"
    relay_action_group    = "ag-${var.prefix}-${var.environment}-relay-${local.suffix}"
    expiry_cleanup_job    = substr("caj-${local.name_seed}-cleanup-${local.suffix}", 0, 32)
    foundry               = substr("${local.name_seed}openai${local.suffix}", 0, 64)
  }

  relay_contact_emails = sort([
    for email in var.budget_contact_emails : trimspace(email)
  ])

  relay_action_group_id = "/subscriptions/${var.subscription_id}/resourceGroups/${local.names.resource_group}/providers/Microsoft.Insights/actionGroups/${local.names.relay_action_group}"

  relay_origin = "wss://${local.names.relay_container_app}.${module.container_app_environment.default_domain}"

  foundry_generation_endpoint = trimsuffix(module.foundry.endpoint, "/")
  foundry_realtime_endpoint   = "wss://${trimprefix(trimsuffix(module.foundry.endpoint, "/"), "https://")}/openai/v1/realtime?intent=transcription"

  relay_generation_endpoint      = var.deploy_relay_workload ? local.foundry_generation_endpoint : ""
  relay_generation_deployment    = var.deploy_relay_workload ? "gpt-5.6-luna" : ""
  relay_transcription_provider   = var.deploy_relay_workload ? "azure-realtime" : ""
  relay_transcription_endpoint   = var.deploy_relay_workload ? local.foundry_realtime_endpoint : ""
  relay_transcription_deployment = var.deploy_relay_workload ? "gpt-4o-mini-transcribe" : ""
  relay_deployment_slot          = var.deploy_relay_workload ? "dev" : ""

  required_foundry_deployments = tomap({
    "gpt-4o-mini-transcribe" = {
      model_name             = "gpt-4o-mini-transcribe"
      model_version          = "2025-12-15"
      model_format           = "OpenAI"
      sku_name               = "GlobalStandard"
      capacity               = 1
      version_upgrade_option = "NoAutoUpgrade"
    }
    "gpt-5.6-luna" = {
      model_name             = "gpt-5.6-luna"
      model_version          = "2026-07-09"
      model_format           = "OpenAI"
      sku_name               = "GlobalStandard"
      capacity               = 1013
      version_upgrade_option = "NoAutoUpgrade"
    }
  })
}
