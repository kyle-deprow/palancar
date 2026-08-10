output "id" {
  description = "Relay Container App ARM resource ID."
  value       = azapi_resource.this.id
}

output "name" {
  description = "Relay Container App name."
  value       = azapi_resource.this.name
}

output "fqdn" {
  description = "Azure-provided Container App ingress FQDN."
  value       = try(azapi_resource.this.output.properties.configuration.ingress.fqdn, null)
}

output "latest_revision_name" {
  description = "Latest relay Container App revision name."
  value       = try(azapi_resource.this.output.properties.latestRevisionName, null)
}

output "running_status" {
  description = "Latest relay Container App running status when returned by Azure."
  value       = try(azapi_resource.this.output.properties.runningStatus, null)
}
