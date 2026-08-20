# Relay alert action-group implementation contract

Status: Approved for bounded implementation
Date: 2026-08-19

## Objective

Create one root-managed Azure Monitor action group from the existing protected
development budget contacts and enable the observability module's exact six
reviewed relay scheduled-query alerts. Keep the reusable observability and
budget module implementations unchanged.

## Ownership

The implementation worker owns only:

- `infra/environments/dev/alerts.tf` (new)
- `infra/environments/dev/locals.tf`
- `infra/environments/dev/main.tf`
- `infra/environments/dev/variables.tf`
- `infra/environments/dev/outputs.tf`
- `infra/environments/dev/terraform.tfvars.example`
- `infra/environments/dev/tests/alerts.tftest.hcl` (new)

`infra/README.md` is temporarily owned by the concurrent plan-guard fixer and
must not be changed in this slice. The parent will integrate operational notes
after both lanes settle. All modules, guard files/fixtures, protected inputs,
state, Azure resources, images, and credentials are out of scope.

## Exact design

- Add `azurerm_monitor_action_group.relay` in the dev root.
- Name it `ag-${var.prefix}-${var.environment}-relay-${local.suffix}` and use
  short name `substr("r-${local.suffix}", 0, 12)`.
- Configure it as enabled, global, with the exact root tags.
- Add one email receiver per sorted, trimmed existing
  `budget_contact_emails` value. Receiver names are stable ordinal names
  `budget-contact-0001`, `budget-contact-0002`, and so on; names never contain
  or hash recipient data. Every receiver uses common alert schema. Configure no
  SMS, voice, webhook, role, function, push, automation, Logic App, Event Hub,
  or other receiver type.
- Add plan-known local action-group ID built only from inputs and locals:
  `/subscriptions/${var.subscription_id}/resourceGroups/${local.names.resource_group}/providers/Microsoft.Insights/actionGroups/${local.names.relay_action_group}`.
  Do not reference a computed resource ID.
- Pass `alerts_enabled = true` and exactly that one local ID as
  `alert_action_group_ids` to `module.observability`. Add explicit
  `depends_on = [azurerm_monitor_action_group.relay]` because the local ID does
  not create an implicit resource dependency.
- Strengthen `budget_contact_emails`: non-null, 1-1000 values, each already
  trimmed, at most 64 characters, existing conservative syntax and reserved-
  domain rejection, no whitespace character anywhere (including embedded tabs
  or newlines), and case-insensitive uniqueness. Do not add a second
  contact input or mark the collection sensitive because Terraform must use it
  for dynamic block iteration. Never expose recipient values in outputs,
  reports, fixtures, logs, or committed examples.
- Add non-PII root outputs `relay_action_group_id` and
  `relay_alert_rule_ids`; the latter is the existing six-key module output.
- Update only the description/comment for the example budget contacts to say
  they also receive relay operational alerts. Do not add a real address.

The dependency is resource group -> action group -> observability module ->
six alerts. There is no dependency back to the action group.

## Acceptance and verification

The existing observability module tests remain authoritative for exact six
keys, KQL, thresholds, severity, aggregation, periods, no dimensions, static
properties, and action-group wiring.

Add a mocked dev-root native Terraform test proving the action-group ID is the
exact plan-known string, the exact action-group/receiver shape is planned, and
contacts containing embedded tab or newline whitespace fail
`var.budget_contact_emails`. Mock both configured providers and use only
synthetic values; never use protected inputs, live contacts, state, or Azure.

Run with exact Terraform 1.15.8:

```sh
terraform -chdir=infra/environments/dev fmt -check -recursive
terraform -chdir=infra/environments/dev validate
terraform -chdir=infra/environments/dev test
terraform -chdir=infra/modules/observability test
git diff --check
```

Do not run Terraform init/plan/apply, Azure commands, or create module-local
lockfiles. Report changed files and real check results, and use `DONE` only when
the bounded slice is complete.
