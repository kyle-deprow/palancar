locals {
  relay_saved_query_keys = [
    "provider_failures",
    "state_store_failures",
    "transcription_first_partial_mean",
    "transcription_final_mean",
    "translation_mean",
    "suggestion_mean",
    "runtime_activity",
  ]

  relay_baseline_alert_keys = [
    "provider_failures",
    "state_store_failures",
    "transcription_first_partial_mean",
    "transcription_final_mean",
    "translation_mean",
    "suggestion_mean",
  ]

  relay_saved_queries = {
    provider_failures = {
      display_name = "Relay provider failures"
      query        = <<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "provider.failure"
        | summarize FailureCount = sum(Sum) by bin(TimeGenerated, 5m)
        | project TimeGenerated, metric_name = "provider.failure", failure_count = FailureCount
      KQL
    }
    state_store_failures = {
      display_name = "Relay state store failures"
      query        = <<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "state_store.failure"
        | summarize FailureCount = sum(Sum) by bin(TimeGenerated, 5m)
        | project TimeGenerated, metric_name = "state_store.failure", failure_count = FailureCount
      KQL
    }
    transcription_first_partial_mean = {
      display_name = "Relay transcription first partial weighted mean latency"
      query        = <<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "transcription.first_partial_latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount) by bin(TimeGenerated, 5m)
        | where SampleCount > 0
        | project TimeGenerated, metric_name = "transcription.first_partial_latency", sample_count = SampleCount, total_ms = TotalMs, mean_ms = TotalMs / SampleCount
      KQL
    }
    transcription_final_mean = {
      display_name = "Relay transcription final weighted mean latency"
      query        = <<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "transcription.final_latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount) by bin(TimeGenerated, 5m)
        | where SampleCount > 0
        | project TimeGenerated, metric_name = "transcription.final_latency", sample_count = SampleCount, total_ms = TotalMs, mean_ms = TotalMs / SampleCount
      KQL
    }
    translation_mean = {
      display_name = "Relay translation weighted mean latency"
      query        = <<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "translation.latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount) by bin(TimeGenerated, 5m)
        | where SampleCount > 0
        | project TimeGenerated, metric_name = "translation.latency", sample_count = SampleCount, total_ms = TotalMs, mean_ms = TotalMs / SampleCount
      KQL
    }
    suggestion_mean = {
      display_name = "Relay suggestion weighted mean latency"
      query        = <<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "suggestion.latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount) by bin(TimeGenerated, 5m)
        | where SampleCount > 0
        | project TimeGenerated, metric_name = "suggestion.latency", sample_count = SampleCount, total_ms = TotalMs, mean_ms = TotalMs / SampleCount
      KQL
    }
    runtime_activity = {
      display_name = "Relay runtime activity"
      query        = <<-KQL
        let CounterActivity = AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name in ("session.start", "translation.result", "suggestion.result")
        | summarize ActivityCount = todouble(sum(Sum)) by bin(TimeGenerated, 5m), Name;
        let TranscriptionActivity = AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "transcription.final_latency"
        | summarize ActivityCount = todouble(sum(ItemCount)) by bin(TimeGenerated, 5m), Name;
        union CounterActivity, TranscriptionActivity
        | project TimeGenerated, metric_name = Name, activity_count = ActivityCount
      KQL
    }
  }

  relay_baseline_alerts = {
    provider_failures = {
      display_name            = "Relay provider failures"
      description             = "Weighted relay provider failures in the evaluation window."
      severity                = 1
      threshold               = var.alert_thresholds.provider_failure_count
      operator                = "GreaterThanOrEqual"
      time_aggregation_method = "Total"
      minimum_failing_periods = 1
      evaluation_periods      = 1
      query                   = <<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "provider.failure"
        | summarize SignalValue = sum(Sum)
      KQL
    }
    state_store_failures = {
      display_name            = "Relay state store failures"
      description             = "Weighted relay state store failures in the evaluation window."
      severity                = 1
      threshold               = var.alert_thresholds.state_store_failure_count
      operator                = "GreaterThanOrEqual"
      time_aggregation_method = "Total"
      minimum_failing_periods = 1
      evaluation_periods      = 1
      query                   = <<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "state_store.failure"
        | summarize SignalValue = sum(Sum)
      KQL
    }
    transcription_first_partial_mean = {
      display_name            = "Relay transcription first partial weighted mean latency"
      description             = "Weighted mean first partial transcription latency in milliseconds."
      severity                = 2
      threshold               = var.alert_thresholds.first_partial_latency_mean_ms
      operator                = "GreaterThanOrEqual"
      time_aggregation_method = "Average"
      minimum_failing_periods = 1
      evaluation_periods      = 1
      query                   = <<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "transcription.first_partial_latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)
        | where SampleCount > 0
        | project SignalValue = TotalMs / SampleCount
      KQL
    }
    transcription_final_mean = {
      display_name            = "Relay transcription final weighted mean latency"
      description             = "Weighted mean final transcription latency in milliseconds."
      severity                = 2
      threshold               = var.alert_thresholds.final_latency_mean_ms
      operator                = "GreaterThanOrEqual"
      time_aggregation_method = "Average"
      minimum_failing_periods = 1
      evaluation_periods      = 1
      query                   = <<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "transcription.final_latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)
        | where SampleCount > 0
        | project SignalValue = TotalMs / SampleCount
      KQL
    }
    translation_mean = {
      display_name            = "Relay translation weighted mean latency"
      description             = "Weighted mean translation latency in milliseconds."
      severity                = 2
      threshold               = var.alert_thresholds.translation_latency_mean_ms
      operator                = "GreaterThanOrEqual"
      time_aggregation_method = "Average"
      minimum_failing_periods = 1
      evaluation_periods      = 1
      query                   = <<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "translation.latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)
        | where SampleCount > 0
        | project SignalValue = TotalMs / SampleCount
      KQL
    }
    suggestion_mean = {
      display_name            = "Relay suggestion weighted mean latency"
      description             = "Weighted mean suggestion latency in milliseconds."
      severity                = 2
      threshold               = var.alert_thresholds.suggestion_latency_mean_ms
      operator                = "GreaterThanOrEqual"
      time_aggregation_method = "Average"
      minimum_failing_periods = 1
      evaluation_periods      = 1
      query                   = <<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "suggestion.latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)
        | where SampleCount > 0
        | project SignalValue = TotalMs / SampleCount
      KQL
    }
  }

  relay_alerts = var.alerts_enabled ? local.relay_baseline_alerts : {}

  relay_workbook_items = [
    for key in local.relay_saved_query_keys : {
      type = 3
      name = "relay-${replace(key, "_", "-")}"
      content = {
        version      = "KqlItem/1.0"
        query        = local.relay_saved_queries[key].query
        size         = 0
        title        = local.relay_saved_queries[key].display_name
        queryType    = 0
        resourceType = "microsoft.operationalinsights/workspaces"
        timeContext = {
          durationMs = 2592000000
        }
      }
    }
  ]
}

resource "azurerm_log_analytics_saved_search" "relay" {
  for_each = local.relay_saved_queries

  name                       = "palancar-relay-${replace(each.key, "_", "-")}"
  display_name               = each.value.display_name
  category                   = "Palancar Relay"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  query                      = each.value.query
  tags                       = var.tags
}

resource "azurerm_application_insights_workbook" "relay_operations" {
  name                = uuidv5("url", "${var.resource_group_name}/${var.application_insights_name}/relay-operations")
  resource_group_name = var.resource_group_name
  location            = var.location
  display_name        = "${var.application_insights_name} relay operational means"
  description         = "Weighted mean latency, failure, and runtime activity signals with bounded dimensions."
  category            = "workbook"
  source_id           = lower(azurerm_application_insights.this.id)
  tags                = var.tags

  data_json = jsonencode({
    version             = "Notebook/1.0"
    items               = local.relay_workbook_items
    fallbackResourceIds = [lower(azurerm_log_analytics_workspace.this.id)]
  })
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "relay" {
  for_each = local.relay_alerts

  name                    = "${var.application_insights_name}-${replace(each.key, "_", "-")}"
  resource_group_name     = var.resource_group_name
  location                = var.location
  display_name            = each.value.display_name
  description             = each.value.description
  enabled                 = true
  severity                = each.value.severity
  scopes                  = [azurerm_log_analytics_workspace.this.id]
  evaluation_frequency    = "PT5M"
  window_duration         = "PT15M"
  auto_mitigation_enabled = true
  skip_query_validation   = false
  tags                    = var.tags

  criteria {
    query                   = each.value.query
    metric_measure_column   = "SignalValue"
    operator                = each.value.operator
    threshold               = each.value.threshold
    time_aggregation_method = each.value.time_aggregation_method

    failing_periods {
      minimum_failing_periods_to_trigger_alert = each.value.minimum_failing_periods
      number_of_evaluation_periods             = each.value.evaluation_periods
    }
  }

  action {
    action_groups = sort(tolist(var.alert_action_group_ids))
    custom_properties = {
      service = "relay"
      signal  = each.key
    }
  }
}
