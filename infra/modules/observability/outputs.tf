output "workspace_id" {
  description = "Log Analytics workspace ID."
  value       = azurerm_log_analytics_workspace.this.id
}

output "workspace_name" {
  description = "Log Analytics workspace name."
  value       = azurerm_log_analytics_workspace.this.name
}

output "application_insights_id" {
  description = "Application Insights resource ID."
  value       = azurerm_application_insights.this.id
}

output "application_insights_connection_string" {
  description = "Application Insights connection string for reviewed application configuration."
  value       = azurerm_application_insights.this.connection_string
  sensitive   = true
}

output "relay_saved_query_ids" {
  description = "Saved Log Analytics query IDs keyed by low-cardinality relay operational signal."
  value = {
    for key, query in azurerm_log_analytics_saved_search.relay : key => query.id
  }
}

output "relay_operations_workbook_id" {
  description = "Application Insights workbook ID for aggregate relay operational signals."
  value       = azurerm_application_insights_workbook.relay_operations.id
}

output "relay_alert_rule_ids" {
  description = "Scheduled query alert IDs keyed by relay signal; empty when alerts are disabled."
  value = {
    for key, alert in azurerm_monitor_scheduled_query_rules_alert_v2.relay : key => alert.id
  }
}
