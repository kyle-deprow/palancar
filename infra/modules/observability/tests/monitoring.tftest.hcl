mock_provider "azurerm" {}

override_resource {
  target          = azurerm_log_analytics_workspace.this
  override_during = plan
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/RG-PALANCAR-TEST/providers/Microsoft.OperationalInsights/workspaces/LAW-PALANCAR-TEST"
  }
}

override_resource {
  target          = azurerm_application_insights.this
  override_during = plan
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/RG-PALANCAR-TEST/providers/Microsoft.Insights/components/APPI-PALANCAR-TEST"
  }
}

variables {
  workspace_name            = "law-palancar-test"
  application_insights_name = "appi-palancar-test"
  resource_group_name       = "rg-palancar-test"
  location                  = "eastus2"
  tags                      = { test = "observability" }
}

run "disabled_contract_has_exact_resources_and_retention" {
  command = plan

  assert {
    condition = (
      azurerm_log_analytics_workspace.this.retention_in_days == 30 &&
      azurerm_log_analytics_workspace.this.immediate_data_purge_on_30_days_enabled == true &&
      azurerm_application_insights.this.retention_in_days == 30 &&
      azurerm_application_insights.this.local_authentication_enabled == false
    )
    error_message = "retention must remain exactly 30 days and Application Insights local authentication must remain disabled"
  }

  assert {
    condition = toset(keys(azurerm_log_analytics_saved_search.relay)) == toset([
      "provider_failures",
      "state_store_failures",
      "transcription_first_partial_mean",
      "transcription_final_mean",
      "translation_mean",
      "suggestion_mean",
      "runtime_activity",
    ])
    error_message = "saved queries must use the exact reviewed seven-key contract"
  }

  assert {
    condition = (
      toset(keys(output.relay_saved_query_ids)) == toset(local.relay_saved_query_keys) &&
      length(azurerm_monitor_scheduled_query_rules_alert_v2.relay) == 0 &&
      length(output.relay_alert_rule_ids) == 0
    )
    error_message = "outputs must expose the exact saved-query keys and alerts must remain disabled by default"
  }

  assert {
    condition = (
      length(local.relay_workbook_items) == 7 &&
      length(jsondecode(azurerm_application_insights_workbook.relay_operations.data_json).items) == 7
    )
    error_message = "the workbook must contain exactly seven saved-query panels"
  }

  assert {
    condition = (
      azurerm_application_insights_workbook.relay_operations.source_id == "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-palancar-test/providers/microsoft.insights/components/appi-palancar-test" &&
      jsondecode(azurerm_application_insights_workbook.relay_operations.data_json).fallbackResourceIds == [
        "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-palancar-test/providers/microsoft.operationalinsights/workspaces/law-palancar-test",
      ]
    )
    error_message = "workbook source and fallback resource IDs must be lowercased"
  }

  assert {
    condition = (
      strcontains(lower(azurerm_application_insights_workbook.relay_operations.display_name), "operational means") &&
      strcontains(lower(azurerm_application_insights_workbook.relay_operations.description), "weighted mean")
    )
    error_message = "workbook wording must describe only reviewed weighted operational signals"
  }
}

run "saved_and_workbook_queries_equal_the_exact_approved_map" {
  command = plan

  assert {
    condition = {
      provider_failures = trimspace(<<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "provider.failure"
        | summarize FailureCount = sum(Sum) by bin(TimeGenerated, 5m)
        | project TimeGenerated, metric_name = "provider.failure", failure_count = FailureCount
      KQL
      )
      state_store_failures = trimspace(<<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "state_store.failure"
        | summarize FailureCount = sum(Sum) by bin(TimeGenerated, 5m)
        | project TimeGenerated, metric_name = "state_store.failure", failure_count = FailureCount
      KQL
      )
      transcription_first_partial_mean = trimspace(<<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "transcription.first_partial_latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount) by bin(TimeGenerated, 5m)
        | where SampleCount > 0
        | project TimeGenerated, metric_name = "transcription.first_partial_latency", sample_count = SampleCount, total_ms = TotalMs, mean_ms = TotalMs / SampleCount
      KQL
      )
      transcription_final_mean = trimspace(<<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "transcription.final_latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount) by bin(TimeGenerated, 5m)
        | where SampleCount > 0
        | project TimeGenerated, metric_name = "transcription.final_latency", sample_count = SampleCount, total_ms = TotalMs, mean_ms = TotalMs / SampleCount
      KQL
      )
      translation_mean = trimspace(<<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "translation.latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount) by bin(TimeGenerated, 5m)
        | where SampleCount > 0
        | project TimeGenerated, metric_name = "translation.latency", sample_count = SampleCount, total_ms = TotalMs, mean_ms = TotalMs / SampleCount
      KQL
      )
      suggestion_mean = trimspace(<<-KQL
        AppMetrics
        | where TimeGenerated > ago(30d)
        | where AppRoleName == "palancar-relay"
        | where Name == "suggestion.latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount) by bin(TimeGenerated, 5m)
        | where SampleCount > 0
        | project TimeGenerated, metric_name = "suggestion.latency", sample_count = SampleCount, total_ms = TotalMs, mean_ms = TotalMs / SampleCount
      KQL
      )
      runtime_activity = trimspace(<<-KQL
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
      )
      } == {
      for key, saved in azurerm_log_analytics_saved_search.relay : key => trimspace(saved.query)
    }
    error_message = "saved queries must exactly equal the visible approved seven-query map"
  }

  assert {
    condition = [
      for item in jsondecode(azurerm_application_insights_workbook.relay_operations.data_json).items :
      trimspace(item.content.query)
      ] == [
      for key in local.relay_saved_query_keys :
      trimspace(azurerm_log_analytics_saved_search.relay[key].query)
    ]
    error_message = "workbook panels must exactly reuse the seven approved saved queries in reviewed order"
  }
}

run "enabled_alerts_equal_the_exact_approved_contract" {
  command = plan

  variables {
    alerts_enabled = true
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Primary On Call",
    ]
  }

  assert {
    condition = toset(keys(azurerm_monitor_scheduled_query_rules_alert_v2.relay)) == toset([
      "provider_failures",
      "state_store_failures",
      "transcription_first_partial_mean",
      "transcription_final_mean",
      "translation_mean",
      "suggestion_mean",
    ])
    error_message = "enabled alerts must use the exact reviewed six-key contract"
  }

  assert {
    condition     = toset(keys(output.relay_alert_rule_ids)) == toset(local.relay_baseline_alert_keys)
    error_message = "alert output IDs must expose the exact six alert keys"
  }

  assert {
    condition = {
      provider_failures = trimspace(<<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "provider.failure"
        | summarize SignalValue = sum(Sum)
      KQL
      )
      state_store_failures = trimspace(<<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "state_store.failure"
        | summarize SignalValue = sum(Sum)
      KQL
      )
      transcription_first_partial_mean = trimspace(<<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "transcription.first_partial_latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)
        | where SampleCount > 0
        | project SignalValue = TotalMs / SampleCount
      KQL
      )
      transcription_final_mean = trimspace(<<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "transcription.final_latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)
        | where SampleCount > 0
        | project SignalValue = TotalMs / SampleCount
      KQL
      )
      translation_mean = trimspace(<<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "translation.latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)
        | where SampleCount > 0
        | project SignalValue = TotalMs / SampleCount
      KQL
      )
      suggestion_mean = trimspace(<<-KQL
        AppMetrics
        | where AppRoleName == "palancar-relay"
        | where Name == "suggestion.latency"
        | summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)
        | where SampleCount > 0
        | project SignalValue = TotalMs / SampleCount
      KQL
      )
      } == {
      for key, alert in azurerm_monitor_scheduled_query_rules_alert_v2.relay :
      key => trimspace(alert.criteria[0].query)
    }
    error_message = "alert queries must exactly equal the visible approved six-query map and contain no 30-day filter"
  }

  assert {
    condition = (
      azurerm_monitor_scheduled_query_rules_alert_v2.relay["provider_failures"].criteria[0].threshold == 5 &&
      azurerm_monitor_scheduled_query_rules_alert_v2.relay["state_store_failures"].criteria[0].threshold == 1 &&
      azurerm_monitor_scheduled_query_rules_alert_v2.relay["transcription_first_partial_mean"].criteria[0].threshold == 1500 &&
      azurerm_monitor_scheduled_query_rules_alert_v2.relay["transcription_final_mean"].criteria[0].threshold == 1200 &&
      azurerm_monitor_scheduled_query_rules_alert_v2.relay["translation_mean"].criteria[0].threshold == 5000 &&
      azurerm_monitor_scheduled_query_rules_alert_v2.relay["suggestion_mean"].criteria[0].threshold == 5000
    )
    error_message = "alerts must use the reviewed default thresholds"
  }

  assert {
    condition = alltrue([
      for key, alert in azurerm_monitor_scheduled_query_rules_alert_v2.relay :
      alert.criteria[0].metric_measure_column == "SignalValue" &&
      alert.criteria[0].operator == "GreaterThanOrEqual" &&
      alert.criteria[0].time_aggregation_method != "Maximum" &&
      alert.criteria[0].failing_periods[0].minimum_failing_periods_to_trigger_alert == 1 &&
      alert.criteria[0].failing_periods[0].number_of_evaluation_periods == 1 &&
      length(alert.criteria[0].dimension) == 0 &&
      length(alert.action[0].action_groups) == 1 &&
      alert.action[0].action_groups[0] == "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Primary On Call" &&
      toset(keys(alert.action[0].custom_properties)) == toset(["service", "signal"]) &&
      alert.action[0].custom_properties["service"] == "relay" &&
      alert.action[0].custom_properties["signal"] == key
    ])
    error_message = "alerts must use SignalValue, exact periods, action wiring, static properties, and no dimensions"
  }

  assert {
    condition = (
      azurerm_monitor_scheduled_query_rules_alert_v2.relay["provider_failures"].criteria[0].time_aggregation_method == "Total" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.relay["state_store_failures"].criteria[0].time_aggregation_method == "Total" &&
      alltrue([
        for key in [
          "transcription_first_partial_mean",
          "transcription_final_mean",
          "translation_mean",
          "suggestion_mean",
        ] : azurerm_monitor_scheduled_query_rules_alert_v2.relay[key].criteria[0].time_aggregation_method == "Average"
      ])
    )
    error_message = "failure alerts must total counts and latency alerts must evaluate weighted means"
  }
}

run "application_insights_name_224_characters_is_valid" {
  command = plan

  variables {
    application_insights_name = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition     = length(var.application_insights_name) == 224
    error_message = "the accepted Application Insights boundary fixture must be exactly 224 characters"
  }
}

run "application_insights_name_225_characters_is_invalid" {
  command = plan

  variables {
    application_insights_name = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  expect_failures = [var.application_insights_name]
}

run "application_insights_bad_names_are_invalid" {
  command = plan

  variables {
    application_insights_name = "appi/palancar"
  }

  expect_failures = [var.application_insights_name]
}

run "application_insights_name_trailing_period_is_invalid" {
  command = plan

  variables {
    application_insights_name = "appi-palancar."
  }

  expect_failures = [var.application_insights_name]
}

run "application_insights_name_trailing_space_is_invalid" {
  command = plan

  variables {
    application_insights_name = "appi-palancar "
  }

  expect_failures = [var.application_insights_name]
}

run "resource_group_name_90_characters_is_valid" {
  command = plan

  variables {
    resource_group_name = "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
  }

  assert {
    condition     = length(var.resource_group_name) == 90
    error_message = "the accepted resource-group boundary fixture must be exactly 90 characters"
  }
}

run "resource_group_name_91_characters_is_invalid" {
  command = plan

  variables {
    resource_group_name = "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
  }

  expect_failures = [var.resource_group_name]
}

run "resource_group_name_trailing_period_is_invalid" {
  command = plan

  variables {
    resource_group_name = "rg-palancar."
  }

  expect_failures = [var.resource_group_name]
}

run "only_eastus2_is_accepted" {
  command = plan

  variables {
    location = "westus2"
  }

  expect_failures = [var.location]
}

run "tag_count_and_lengths_accept_exact_boundaries" {
  command = plan

  variables {
    tags = merge(
      { a = "b" },
      { for index in range(13) : "tag-${index}" => "value" },
      { (join("", [for index in range(512) : "k"])) = join("", [for index in range(256) : "v"]) },
    )
  }

  assert {
    condition = (
      length(var.tags) == 15 &&
      alltrue([for saved in azurerm_log_analytics_saved_search.relay : length(saved.tags) == 15])
    )
    error_message = "all resources, including saved searches, must accept exactly 15 valid tags at key/value length boundaries"
  }
}

run "empty_tags_are_invalid" {
  command = plan

  variables {
    tags = {}
  }

  expect_failures = [var.tags]
}

run "sixteen_tags_are_invalid" {
  command = plan

  variables {
    tags = { for index in range(16) : "tag-${index}" => "value" }
  }

  expect_failures = [var.tags]
}

run "tag_key_513_characters_is_invalid" {
  command = plan

  variables {
    tags = { (join("", [for index in range(513) : "k"])) = "value" }
  }

  expect_failures = [var.tags]
}

run "tag_value_257_characters_is_invalid" {
  command = plan

  variables {
    tags = { test = join("", [for index in range(257) : "v"]) }
  }

  expect_failures = [var.tags]
}

run "empty_tag_key_is_invalid" {
  command = plan

  variables {
    tags = { "" = "value" }
  }

  expect_failures = [var.tags]
}

run "empty_tag_value_is_invalid" {
  command = plan

  variables {
    tags = { test = "" }
  }

  expect_failures = [var.tags]
}

run "untrimmed_tag_is_invalid" {
  command = plan

  variables {
    tags = { test = " observability" }
  }

  expect_failures = [var.tags]
}

run "forbidden_tag_key_characters_are_invalid" {
  command = plan

  variables {
    tags = { "bad<>%&\\?/key" = "value" }
  }

  expect_failures = [var.tags]
}

run "five_action_groups_and_internal_spaces_are_valid" {
  command = plan

  variables {
    alerts_enabled = true
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Primary On Call",
      "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Secondary",
      "/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Tertiary",
      "/subscriptions/44444444-4444-4444-4444-444444444444/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Fourth",
      "/subscriptions/55555555-5555-5555-5555-555555555555/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Fifth",
    ]
  }

  assert {
    condition = alltrue([
      for alert in azurerm_monitor_scheduled_query_rules_alert_v2.relay :
      length(alert.action[0].action_groups) == 5
    ])
    error_message = "all six enabled alerts must wire exactly five valid action groups"
  }
}

run "action_group_component_length_boundaries_are_valid" {
  command = plan

  variables {
    alerts_enabled = true
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/${join("", [for index in range(90) : "r"])}/providers/Microsoft.Insights/actionGroups/Relay ${join("", [for index in range(254) : "a"])}",
      "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/r/providers/Microsoft.Insights/actionGroups/A",
    ]
  }

  assert {
    condition = (
      toset([for id in var.alert_action_group_ids : length(split("/", id)[4])]) == toset([1, 90]) &&
      toset([for id in var.alert_action_group_ids : length(split("/", id)[8])]) == toset([1, 260])
    )
    error_message = "resource-group and action-group names must accept their exact 1/90 and 1/260 character boundaries"
  }
}

run "enabled_alerts_require_an_action_group" {
  command = plan

  variables {
    alerts_enabled = true
  }

  expect_failures = [var.alerts_enabled]
}

run "more_than_five_action_groups_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay One",
      "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Two",
      "/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Three",
      "/subscriptions/44444444-4444-4444-4444-444444444444/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Four",
      "/subscriptions/55555555-5555-5555-5555-555555555555/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Five",
      "/subscriptions/66666666-6666-6666-6666-666666666666/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Six",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_resource_group_91_characters_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/${join("", [for index in range(91) : "r"])}/providers/Microsoft.Insights/actionGroups/Relay Alerts",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_resource_group_trailing_period_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts./providers/Microsoft.Insights/actionGroups/Relay Alerts",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_resource_group_empty_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups//providers/Microsoft.Insights/actionGroups/Relay Alerts",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_name_261_characters_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/${join("", [for index in range(261) : "a"])}",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_name_empty_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_malformed_subscription_uuid_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/not-a-uuid/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Alerts",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_wrong_provider_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Compute/actionGroups/Relay Alerts",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_wrong_resource_type_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Insights/components/Relay Alerts",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_invalid_character_is_rejected" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay#Alerts",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_leading_space_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/ Relay Alerts",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_trailing_space_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Alerts ",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "action_group_trailing_period_is_invalid" {
  command = plan

  variables {
    alert_action_group_ids = [
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/Relay Alerts.",
    ]
  }

  expect_failures = [var.alert_action_group_ids]
}

run "fractional_threshold_is_invalid" {
  command = plan

  variables {
    alert_thresholds = {
      provider_failure_count        = 5
      state_store_failure_count     = 1
      first_partial_latency_mean_ms = 1500.5
      final_latency_mean_ms         = 1200
      translation_latency_mean_ms   = 5000
      suggestion_latency_mean_ms    = 5000
    }
  }

  expect_failures = [var.alert_thresholds]
}

run "count_threshold_above_maximum_is_invalid" {
  command = plan

  variables {
    alert_thresholds = {
      provider_failure_count        = 1000001
      state_store_failure_count     = 1
      first_partial_latency_mean_ms = 1500
      final_latency_mean_ms         = 1200
      translation_latency_mean_ms   = 5000
      suggestion_latency_mean_ms    = 5000
    }
  }

  expect_failures = [var.alert_thresholds]
}

run "latency_threshold_above_maximum_is_invalid" {
  command = plan

  variables {
    alert_thresholds = {
      provider_failure_count        = 5
      state_store_failure_count     = 1
      first_partial_latency_mean_ms = 1500
      final_latency_mean_ms         = 1200
      translation_latency_mean_ms   = 300001
      suggestion_latency_mean_ms    = 5000
    }
  }

  expect_failures = [var.alert_thresholds]
}

run "zero_threshold_is_invalid" {
  command = plan

  variables {
    alert_thresholds = {
      provider_failure_count        = 0
      state_store_failure_count     = 1
      first_partial_latency_mean_ms = 1500
      final_latency_mean_ms         = 1200
      translation_latency_mean_ms   = 5000
      suggestion_latency_mean_ms    = 5000
    }
  }

  expect_failures = [var.alert_thresholds]
}

run "retention_other_than_30_is_invalid" {
  command = plan

  variables {
    retention_in_days = 31
  }

  expect_failures = [var.retention_in_days]
}
