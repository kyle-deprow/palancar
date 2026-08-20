resource "azurerm_monitor_action_group" "relay" {
  name                = local.names.relay_action_group
  resource_group_name = azurerm_resource_group.foundation.name
  short_name          = substr("r-${local.suffix}", 0, 12)
  enabled             = true
  location            = "global"
  tags                = local.tags

  dynamic "email_receiver" {
    for_each = local.relay_contact_emails

    content {
      name                    = format("budget-contact-%04d", email_receiver.key + 1)
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }
}
