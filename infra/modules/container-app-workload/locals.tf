locals {
  application_insights_segments = split(";", var.application_insights_connection_string)

  application_insights_values_by_key = {
    for segment in local.application_insights_segments :
    try(split("=", segment)[0], "") => try(split("=", segment)[1], "")...
  }

  application_insights_instrumentation_key = lower(try(
    local.application_insights_values_by_key["InstrumentationKey"][0],
    ""
  ))
  application_insights_ingestion_endpoint = trimsuffix(try(
    local.application_insights_values_by_key["IngestionEndpoint"][0],
    ""
  ), "/")

  relay_application_insights_connection_string = join(";", [
    "InstrumentationKey=${local.application_insights_instrumentation_key}",
    "IngestionEndpoint=${local.application_insights_ingestion_endpoint}",
  ])
}
