#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

const MODEL_SPIKE_MODE = "model-spike";
const FULL_DEPLOY_MODE = "full-deploy";
const RUNTIME_ROLLOUT_MODE = "runtime-rollout";
const FINAL_ROLLOUT_MODE = "final-rollout";
const LUNA_MODEL_BOOTSTRAP_MODE = "luna-model-bootstrap";
const AZURE_GENERATION_CUTOVER_MODE = "azure-generation-cutover";
const AZURE_CREDENTIAL_CLEANUP_MODE = "azure-credential-cleanup";
const POST_CUTOVER_RELAY_IMAGE_ROLLOUT_MODE =
  "post-cutover-relay-image-rollout";
const FINAL_ROLLOUT_COMPLETE_MODE = "final-rollout-complete";
const SUPPORTED_PLAN_FORMAT_VERSION = "1.2";
const PINNED_DEPLOYMENT_NAME = "gpt-4o-mini-transcribe";
const PINNED_MODEL_VERSION = "2025-12-15";
const LUNA_DEPLOYMENT_NAME = "gpt-5.6-luna";
const LUNA_MODEL_VERSION = "2026-07-09";
const LUNA_MODEL_CAPACITY = 1013;
const BOOTSTRAP_ROLE_DEFINITION_IDS = Object.freeze({
  acr: "7f951dda-4ed3-4680-a7ca-43fe172d538d",
  table: "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3",
  openai: "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd",
  monitoring: "3913510d-42f4-4e42-8a64-420c390055eb",
  secretsUser: "4633458b-17de-408a-b874-0445c86b69e6",
  secretsOfficer: "b86a8fe4-44ce-4948-aee5-eccb2c155cd7",
});
const FOUNDRY_COGNITIVE_ACCOUNT_ID =
  "/subscriptions/a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1/resourceGroups/rg-palancar-dev-aeeacd8c/providers/Microsoft.CognitiveServices/accounts/palancardevopenaiaeeacd8c";
const AZURERM_PROVIDER_NAME = "registry.terraform.io/hashicorp/azurerm";
const EXPECTED_BROWSER_ALLOWED_ORIGINS =
  "https://even-webview.synthetic.invalid";
const EXPECTED_LANGUAGE_BOUNDARY_MODE = "development-provisional";
const MODEL_SPIKE_DEPLOYMENT =
  `module.foundry.azurerm_cognitive_deployment.this["${PINNED_DEPLOYMENT_NAME}"]`;
const RETIRED_DEPLOYMENT = "gpt-5-6-luna";
const CONTAINER_APP = "module.container_app_workload[0].azapi_resource.this";
const EXPIRY_CLEANUP_JOB = "module.expiry_cleanup_job[0].azapi_resource.this";
const FINAL_SUBSCRIPTION_ID =
  "a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1";
const FINAL_RESOURCE_GROUP_NAME = "rg-palancar-dev-aeeacd8c";
const FINAL_RESOURCE_GROUP_ID =
  `/subscriptions/${FINAL_SUBSCRIPTION_ID}/resourceGroups/${FINAL_RESOURCE_GROUP_NAME}`;
const FINAL_ACR_LOGIN_SERVER = "palancardevacraeeacd8c.azurecr.io";
const FINAL_RELAY_PRIOR_IMAGE =
  `${FINAL_ACR_LOGIN_SERVER}/palancar-relay@sha256:e9b7e2ea937d3a15f3b3a52e50d9736b5c63c69765c3ee571ab0c06f762436bd`;
// This is the reviewed live predecessor for the direct-Entra cutover.  It is
// deliberately independent of prior_state: prior state is an input to be
// checked, not the source of the rollout contract.
const CUTOVER_RELAY_PRIOR_IMAGE = FINAL_RELAY_PRIOR_IMAGE;
const FINAL_TABLE_ACCOUNT = "palancardevstateaeeacd8c";
const FINAL_TABLE_ENDPOINT = `https://${FINAL_TABLE_ACCOUNT}.table.core.windows.net`;
const FINAL_TABLE_SERVICE_ID =
  `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.Storage/storageAccounts/${FINAL_TABLE_ACCOUNT}/tableServices/default`;
const FINAL_CONTAINER_ENVIRONMENT_ID =
  `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.App/managedEnvironments/cae-palancar-dev-aeeacd8c`;
const FINAL_CONTAINER_ENVIRONMENT_NAME = "cae-palancar-dev-aeeacd8c";
const FINAL_CONTAINER_ENVIRONMENT_DEFAULT_DOMAIN =
  "graysmoke-757a2980.eastus2.azurecontainerapps.io";
const FINAL_IMAGE_PULL_IDENTITY =
  `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull`;
const FINAL_RUNTIME_IDENTITY =
  `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime`;
const FINAL_APPLICATION_INSIGHTS_ID =
  `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.Insights/components/appi-palancar-dev-aeeacd8c`;
const FINAL_APPLICATION_INSIGHTS_NAME = "appi-palancar-dev-aeeacd8c";
const FINAL_APPLICATION_INSIGHTS_INGESTION_ENDPOINT =
  "https://eastus2-3.in.applicationinsights.azure.com/";
const FINAL_APPLICATION_INSIGHTS_LIVE_ENDPOINT =
  "https://eastus2.livediagnostics.monitor.azure.com/";
const FINAL_KEY_VAULT_HOST = "kvpalancardevaeeacd8c.vault.azure.net";
const FINAL_FOUNDRY_REALTIME_ENDPOINT =
  "wss://palancardevopenaiaeeacd8c.openai.azure.com/openai/v1/realtime?intent=transcription";
const FINAL_CONTAINER_APP_NAME = "ca-palancar-dev-relay-aeeacd8c";
const FINAL_PRIOR_RELAY_REVISION_NAME =
  /^ca-palancar-dev-relay-aeeacd8c--[0-9]{7}$/;
const FINAL_RELAY_ORIGIN =
  `wss://${FINAL_CONTAINER_APP_NAME}.${FINAL_CONTAINER_ENVIRONMENT_DEFAULT_DOMAIN}`;
const FINAL_ACTION_GROUP_ADDRESS = "azurerm_monitor_action_group.relay";
const FINAL_ACTION_GROUP_NAME = "ag-palancar-dev-relay-aeeacd8c";
const FINAL_ACTION_GROUP_ID =
  `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.Insights/actionGroups/${FINAL_ACTION_GROUP_NAME}`;
const FINAL_WORKSPACE_ID =
  `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.OperationalInsights/workspaces/law-palancar-dev-aeeacd8c`;
const FINAL_CLEANUP_JOB_NAME = "caj-palancardev-cleanup-aeeacd8c";
const FINAL_ROLE_DEFINITION_MONITORING_ID =
  "3913510d-42f4-4e42-8a64-420c390055eb";
const FINAL_GENERATION_MODEL = "openrouter/openai/gpt-5.6-luna";
const CUTOVER_CONTAINER_APP = CONTAINER_APP;
const CUTOVER_ACR_LOGIN_SERVER = "palancardevacraeeacd8c.azurecr.io";
const CUTOVER_TRANSCRIPTION_DEPLOYMENT =
  `module.foundry.azurerm_cognitive_deployment.this["${PINNED_DEPLOYMENT_NAME}"]`;
const CUTOVER_LUNA_DEPLOYMENT =
  `module.foundry.azurerm_cognitive_deployment.this["${LUNA_DEPLOYMENT_NAME}"]`;
const CUTOVER_RUNTIME_SECRETS_USER =
  "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user[0]";
const CUTOVER_RUNTIME_SECRETS_USER_PREVIOUS =
  "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user";
const CUTOVER_CREDENTIAL_CLEANUP_BENIGN_ACTION_REASON =
  "delete_because_count_index";
const CUTOVER_CREDENTIAL_CLEANUP_BENIGN_MISSING_RELEVANT_ATTRIBUTE_KEYS =
  new Set([
    JSON.stringify(["azurerm_resource_group.foundation", ["id"]]),
    JSON.stringify([
      "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user",
      [],
    ]),
  ]);
const CUTOVER_RETIRED_WORKLOAD_DEPENDENCIES = Object.freeze([
  "key_vault_uri",
  "runtime_secrets_user_role_assignment_id",
]);
// These are AzAPI provider controls, not part of the reviewed Container App
// body.  Keep them pinned independently so a coherent value copied through
// the change and state snapshots cannot turn into an unreviewed provider
// behavior change.
const CUTOVER_CONTAINER_APP_CONTROL_FIELDS = Object.freeze({
  create_headers: null,
  create_query_parameters: null,
  delete_headers: null,
  delete_query_parameters: null,
  ignore_body_changes: null,
  ignore_casing: false,
  ignore_missing_property: true,
  ignore_null_property: false,
  ignore_other_items_in_list: null,
  list_unique_id_property: null,
  locks: null,
  read_headers: null,
  read_query_parameters: null,
  replace_triggers_external_values: null,
  replace_triggers_refs: null,
  response_export_values: [
    "properties.configuration.ingress.fqdn",
    "properties.latestRevisionName",
    "properties.runningStatus",
  ],
  retry: {
    error_message_regex: ["IdentityDoesNotExist"],
    interval_seconds: 10,
    max_interval_seconds: 30,
    multiplier: 1.5,
    randomization_factor: 0.5,
  },
  schema_validation_enabled: true,
  sensitive_body: null,
  sensitive_body_version: null,
  timeouts: null,
  update_headers: null,
  update_query_parameters: null,
});
const CUTOVER_CONTAINER_APP_CONTROL_KEYS = Object.freeze(
  Object.keys(CUTOVER_CONTAINER_APP_CONTROL_FIELDS),
);
const CUTOVER_RUNTIME_ENVIRONMENT_NAMES = Object.freeze([
  "NODE_ENV",
  "PORT",
  "PALANCAR_GENERATION_PROVIDER",
  "PALANCAR_AZURE_GENERATION_ENDPOINT",
  "PALANCAR_AZURE_GENERATION_DEPLOYMENT",
  "PALANCAR_RELAY_BIND_HOST",
  "PALANCAR_RELAY_ENVIRONMENT",
  "PALANCAR_RELAY_ORIGIN",
  "PALANCAR_GATE_POLICY_VERSION",
  "AZURE_CLIENT_ID",
  "PALANCAR_DEPLOYMENT_SLOT",
  "APPLICATIONINSIGHTS_CONNECTION_STRING",
  "APPLICATIONINSIGHTS_STATSBEAT_DISABLED",
  "APPLICATION_INSIGHTS_NO_STATSBEAT",
  "PALANCAR_SECURITY_MODE",
  "PALANCAR_WORKLOAD_TABLE_ENDPOINT",
  "PALANCAR_SECURITY_STATE_TABLE",
  "PALANCAR_RATE_STATE_TABLE",
  "PALANCAR_TRANSCRIPTION_PROVIDER",
  "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT",
  "PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT",
  "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
  "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
  "PALANCAR_LANGUAGE_BOUNDARY_MODE",
]);
const CUTOVER_FOUNDATION_NO_OP_ADDRESSES = Object.freeze([
  "azurerm_resource_group.foundation",
  "module.budget.azurerm_consumption_budget_resource_group.this",
  "module.observability.azurerm_log_analytics_workspace.this",
  "module.observability.azurerm_application_insights.this",
  "module.workload_state.azurerm_storage_account.this",
  "module.workload_state.azapi_resource.security",
  "module.workload_state.azapi_resource.rate",
  "module.container_registry.azurerm_container_registry.this",
  "module.container_app_environment.azurerm_container_app_environment.this",
  "module.foundry.azurerm_cognitive_account.this",
  "module.identities_rbac.azurerm_user_assigned_identity.image_pull",
  "module.identities_rbac.azurerm_user_assigned_identity.runtime",
  "module.workload_key_vault.azurerm_key_vault.this",
  "module.workload_key_vault.azurerm_role_assignment.terraform_cli_secrets_officer",
  "module.expiry_cleanup_job[0].azapi_resource.this",
  "module.identities_rbac.azurerm_role_assignment.image_pull_acr",
  "module.identities_rbac.azurerm_role_assignment.runtime_table",
  "module.identities_rbac.azurerm_role_assignment.runtime_openai",
  "module.identities_rbac.azurerm_role_assignment.runtime_application_insights",
  "module.identities_rbac.azurerm_role_assignment.operator_security_table",
  "module.identities_rbac.azurerm_role_assignment.operator_rate_table",
  "azurerm_monitor_action_group.relay",
  "module.observability.azurerm_application_insights_workbook.relay_operations",
  "module.observability.azurerm_log_analytics_saved_search.relay[\"provider_failures\"]",
  "module.observability.azurerm_log_analytics_saved_search.relay[\"runtime_activity\"]",
  "module.observability.azurerm_log_analytics_saved_search.relay[\"state_store_failures\"]",
  "module.observability.azurerm_log_analytics_saved_search.relay[\"suggestion_mean\"]",
  "module.observability.azurerm_log_analytics_saved_search.relay[\"transcription_final_mean\"]",
  "module.observability.azurerm_log_analytics_saved_search.relay[\"transcription_first_partial_mean\"]",
  "module.observability.azurerm_log_analytics_saved_search.relay[\"translation_mean\"]",
  "module.observability.azurerm_monitor_scheduled_query_rules_alert_v2.relay[\"provider_failures\"]",
  "module.observability.azurerm_monitor_scheduled_query_rules_alert_v2.relay[\"state_store_failures\"]",
  "module.observability.azurerm_monitor_scheduled_query_rules_alert_v2.relay[\"suggestion_mean\"]",
  "module.observability.azurerm_monitor_scheduled_query_rules_alert_v2.relay[\"transcription_final_mean\"]",
  "module.observability.azurerm_monitor_scheduled_query_rules_alert_v2.relay[\"transcription_first_partial_mean\"]",
  "module.observability.azurerm_monitor_scheduled_query_rules_alert_v2.relay[\"translation_mean\"]",
  CUTOVER_TRANSCRIPTION_DEPLOYMENT,
  CUTOVER_LUNA_DEPLOYMENT,
]);
const CUTOVER_RESOURCE_INVENTORY = new Set([
  ...CUTOVER_FOUNDATION_NO_OP_ADDRESSES,
  CUTOVER_CONTAINER_APP,
  CUTOVER_RUNTIME_SECRETS_USER,
]);
const TERMINAL_REFERENCE_PLAN = JSON.parse(
  readFileSync(
    new URL("./fixtures/final-rollout-transition.plan-fixture.json", import.meta.url),
    "utf8",
  ),
);
const CUTOVER_GENERATION_REFERENCE_PLAN = JSON.parse(
  readFileSync(
    new URL("./fixtures/azure-generation-cutover.plan-fixture.json", import.meta.url),
    "utf8",
  ),
);
const CUTOVER_CREDENTIAL_CLEANUP_REFERENCE_PLAN = JSON.parse(
  readFileSync(
    new URL("./fixtures/azure-credential-cleanup.plan-fixture.json", import.meta.url),
    "utf8",
  ),
);
const FINAL_REFERENCE_PLAN = createLegacyFinalReferencePlan(
  TERMINAL_REFERENCE_PLAN,
);
const MODEL_BOOTSTRAP_REFERENCE_PLAN = JSON.parse(
  readFileSync(
    new URL("./fixtures/luna-model-bootstrap.plan-fixture.json", import.meta.url),
    "utf8",
  ),
);
const LUNA_DEPLOYMENT =
  `module.foundry.azurerm_cognitive_deployment.this["${LUNA_DEPLOYMENT_NAME}"]`;
const MODEL_BOOTSTRAP_RESOURCE_ADDRESSES = new Set(
  MODEL_BOOTSTRAP_REFERENCE_PLAN.resource_changes.map((entry) => entry.address),
);
const FINAL_MONITORING_ROLE_ASSIGNMENT =
  "module.identities_rbac.azurerm_role_assignment.runtime_application_insights";
const FINAL_ALERT_CONTRACTS = new Map([
  [
    "provider_failures",
    {
      displayName: "Relay provider failures",
      description: "Weighted relay provider failures in the evaluation window.",
      severity: 1,
      threshold: 5,
      aggregation: "Total",
      query:
        'AppMetrics\n| where AppRoleName == "palancar-relay"\n| where Name == "provider.failure"\n| summarize SignalValue = sum(Sum)\n',
    },
  ],
  [
    "state_store_failures",
    {
      displayName: "Relay state store failures",
      description:
        "Weighted relay state store failures in the evaluation window.",
      severity: 1,
      threshold: 1,
      aggregation: "Total",
      query:
        'AppMetrics\n| where AppRoleName == "palancar-relay"\n| where Name == "state_store.failure"\n| summarize SignalValue = sum(Sum)\n',
    },
  ],
  [
    "transcription_first_partial_mean",
    {
      displayName: "Relay transcription first partial weighted mean latency",
      description:
        "Weighted mean first partial transcription latency in milliseconds.",
      severity: 2,
      threshold: 1500,
      aggregation: "Average",
      query:
        'AppMetrics\n| where AppRoleName == "palancar-relay"\n| where Name == "transcription.first_partial_latency"\n| summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)\n| where SampleCount > 0\n| project SignalValue = TotalMs / SampleCount\n',
    },
  ],
  [
    "transcription_final_mean",
    {
      displayName: "Relay transcription final weighted mean latency",
      description: "Weighted mean final transcription latency in milliseconds.",
      severity: 2,
      threshold: 1200,
      aggregation: "Average",
      query:
        'AppMetrics\n| where AppRoleName == "palancar-relay"\n| where Name == "transcription.final_latency"\n| summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)\n| where SampleCount > 0\n| project SignalValue = TotalMs / SampleCount\n',
    },
  ],
  [
    "translation_mean",
    {
      displayName: "Relay translation weighted mean latency",
      description: "Weighted mean translation latency in milliseconds.",
      severity: 2,
      threshold: 5000,
      aggregation: "Average",
      query:
        'AppMetrics\n| where AppRoleName == "palancar-relay"\n| where Name == "translation.latency"\n| summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)\n| where SampleCount > 0\n| project SignalValue = TotalMs / SampleCount\n',
    },
  ],
  [
    "suggestion_mean",
    {
      displayName: "Relay suggestion weighted mean latency",
      description: "Weighted mean suggestion latency in milliseconds.",
      severity: 2,
      threshold: 5000,
      aggregation: "Average",
      query:
        'AppMetrics\n| where AppRoleName == "palancar-relay"\n| where Name == "suggestion.latency"\n| summarize TotalMs = sum(Sum), SampleCount = sum(ItemCount)\n| where SampleCount > 0\n| project SignalValue = TotalMs / SampleCount\n',
    },
  ],
]);
const FINAL_ALERT_ADDRESSES = new Set(
  [...FINAL_ALERT_CONTRACTS.keys()].map(
    (key) =>
      `module.observability.azurerm_monitor_scheduled_query_rules_alert_v2.relay["${key}"]`,
  ),
);
const ZERO_INSTANCE_DEPLOYMENT_ADDRESS =
  "module.foundry.azurerm_cognitive_deployment.this";
const CONFIGURED_ZERO_INSTANCE_DEPLOYMENT_ADDRESS =
  "azurerm_cognitive_deployment.this";
const STORAGE_TABLE_DATA_CONTRIBUTOR_ROLE_ID =
  "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3";
const URL_NAMESPACE_UUID = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const OPERATOR_ROLE_ASSIGNMENTS = new Map([
  [
    "module.identities_rbac.azurerm_role_assignment.operator_security_table",
    "SecurityState",
  ],
  [
    "module.identities_rbac.azurerm_role_assignment.operator_rate_table",
    "RateState",
  ],
]);
const CONFIGURED_ROLE_ASSIGNMENT_PREFIXES = [
  "module.identities_rbac.azurerm_role_assignment.",
  "module.workload_key_vault.azurerm_role_assignment.",
];
const FOUNDATION_ADDRESS_PREFIXES = [
  "module.budget.",
  "module.observability.",
  "module.workload_state.",
  "module.container_registry.",
  "module.container_app_environment.",
  "module.foundry.",
  "module.identities_rbac.",
  "module.workload_key_vault.",
];

// These are the resources that must already exist when a full development
// plan is inspected. Keep this inventory explicit so a targeted or partial
// plan cannot pass merely because it contains only allowed actions.
const FOUNDATION_NO_OP_ADDRESSES = new Set([
  "azurerm_resource_group.foundation",
  "module.budget.azurerm_consumption_budget_resource_group.this",
  "module.observability.azurerm_log_analytics_workspace.this",
  "module.observability.azurerm_application_insights.this",
  "module.workload_state.azurerm_storage_account.this",
  "module.workload_state.azapi_resource.security",
  "module.workload_state.azapi_resource.rate",
  "module.container_registry.azurerm_container_registry.this",
  "module.container_app_environment.azurerm_container_app_environment.this",
  "module.foundry.azurerm_cognitive_account.this",
  "module.identities_rbac.azurerm_user_assigned_identity.image_pull",
  "module.identities_rbac.azurerm_user_assigned_identity.runtime",
  "module.workload_key_vault.azurerm_key_vault.this",
  "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user",
  "module.workload_key_vault.azurerm_role_assignment.terraform_cli_secrets_officer",
]);

const FINAL_ROLE_ASSIGNMENT_ADDRESSES = new Set([
  "module.identities_rbac.azurerm_role_assignment.image_pull_acr",
  "module.identities_rbac.azurerm_role_assignment.runtime_table",
  "module.identities_rbac.azurerm_role_assignment.runtime_openai",
  FINAL_MONITORING_ROLE_ASSIGNMENT,
  ...OPERATOR_ROLE_ASSIGNMENTS.keys(),
  "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user",
  "module.workload_key_vault.azurerm_role_assignment.terraform_cli_secrets_officer",
]);
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasRetiredDeployment(value) {
  if (Array.isArray(value)) {
    return value.some(hasRetiredDeployment);
  }

  if (!isObject(value)) {
    return false;
  }

  if (
    value.address ===
      `module.foundry.azurerm_cognitive_deployment.this["${RETIRED_DEPLOYMENT}"]` ||
    (value.type === "azurerm_cognitive_deployment" &&
      value.name === "this" &&
      value.index === RETIRED_DEPLOYMENT)
  ) {
    return true;
  }

  return Object.values(value).some(hasRetiredDeployment);
}

function hasCognitiveDeploymentReference(value) {
  if (
    typeof value === "string" &&
    value.includes("azurerm_cognitive_deployment")
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some(hasCognitiveDeploymentReference);
  }

  if (!isObject(value)) {
    return false;
  }

  if (
    value.type === "azurerm_cognitive_deployment" ||
    (typeof value.address === "string" &&
      value.address.includes(".azurerm_cognitive_deployment."))
  ) {
    return true;
  }

  return Object.values(value).some(hasCognitiveDeploymentReference);
}

function isExactConfiguredZeroInstanceDeployment(value) {
  const forEachExpression = value.for_each_expression;

  return (
    value.address === CONFIGURED_ZERO_INSTANCE_DEPLOYMENT_ADDRESS &&
    value.mode === "managed" &&
    value.type === "azurerm_cognitive_deployment" &&
    value.name === "this" &&
    !Object.hasOwn(value, "index") &&
    !Object.hasOwn(value, "index_expression") &&
    !Object.hasOwn(value, "count_expression") &&
    hasExactKeys(forEachExpression, ["references"]) &&
    Array.isArray(forEachExpression.references) &&
    forEachExpression.references.length === 1 &&
    forEachExpression.references[0] === "var.deployments" &&
    (!Object.hasOwn(value, "instances") ||
      (Array.isArray(value.instances) && value.instances.length === 0))
  );
}

function hasInvalidConfiguredCognitiveDeployment(value, scan = { count: 0 }) {
  if (
    typeof value === "string" &&
    value.includes("azurerm_cognitive_deployment")
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((item) =>
      hasInvalidConfiguredCognitiveDeployment(item, scan),
    );
  }

  if (!isObject(value)) {
    return false;
  }

  const isCognitiveDeploymentNode =
    value.type === "azurerm_cognitive_deployment" &&
    typeof value.address === "string";
  const hasCognitiveAddress =
    typeof value.address === "string" &&
    value.address.includes("azurerm_cognitive_deployment");

  if (isCognitiveDeploymentNode || hasCognitiveAddress) {
    if (!isExactConfiguredZeroInstanceDeployment(value)) {
      return true;
    }

    scan.count += 1;
    if (scan.count > 1) {
      return true;
    }

    return Object.entries(value).some(
      ([key, child]) =>
        !["address", "type"].includes(key) &&
        hasInvalidConfiguredCognitiveDeployment(child, scan),
    );
  }

  return Object.values(value).some((child) =>
    hasInvalidConfiguredCognitiveDeployment(child, scan),
  );
}

function hasInvalidCognitiveRelevantAttributes(value) {
  if (value === undefined) {
    return false;
  }

  if (!Array.isArray(value)) {
    return true;
  }

  return value.some((relevantAttribute) => {
    if (
      !hasExactKeys(relevantAttribute, ["resource", "attribute"]) ||
      typeof relevantAttribute.resource !== "string" ||
      !Array.isArray(relevantAttribute.attribute)
    ) {
      return true;
    }

    if (!hasCognitiveDeploymentReference(relevantAttribute)) {
      return false;
    }

    return (
      relevantAttribute.resource !== ZERO_INSTANCE_DEPLOYMENT_ADDRESS ||
      relevantAttribute.attribute.length !== 0
    );
  });
}

function hasActualCognitiveDeployment(plan) {
  const actualInstanceSources = [
    plan.prior_state,
    plan.planned_values,
    plan.resource_changes,
    plan.resource_drift,
    plan.deferred_changes,
    plan.instances,
  ];

  return (
    actualInstanceSources.some(hasCognitiveDeploymentReference) ||
    hasInvalidConfiguredCognitiveDeployment(plan.configuration) ||
    hasInvalidCognitiveRelevantAttributes(plan.relevant_attributes)
  );
}

function hasExactEmptyFoundryDeploymentsVariable(plan) {
  const configuredVariable = plan.variables?.foundry_deployments;
  const value = configuredVariable?.value;

  return (
    hasExactKeys(configuredVariable, ["value"]) &&
    isObject(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 0
  );
}

function exactCanonicalUuidVariable(plan, name) {
  const configuredVariable = plan.variables?.[name];
  const value = configuredVariable?.value;

  return hasExactKeys(configuredVariable, ["value"]) &&
    typeof value === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
    ? value
    : undefined;
}

function uuidBytes(uuid) {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

function uuidV5Url(name) {
  const bytes = createHash("sha1")
    .update(Buffer.concat([uuidBytes(URL_NAMESPACE_UUID), Buffer.from(name)]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function exactOperatorRoleAssignmentTableService(
  change,
  tableName,
  operatorPrincipalId,
) {
  const after = change.change.after;
  if (!isObject(after)) {
    return undefined;
  }

  const scopePattern = new RegExp(
    `^/subscriptions/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/resourceGroups/[^/]+/providers/Microsoft\\.Storage/storageAccounts/[^/]+/tableServices/default/tables/${tableName}$`,
  );
  const scopeMatch =
    typeof after.scope === "string" ? scopePattern.exec(after.scope) : null;
  if (scopeMatch === null) {
    return undefined;
  }

  const roleDefinitionId =
    `/subscriptions/${scopeMatch[1]}/providers/Microsoft.Authorization/roleDefinitions/${STORAGE_TABLE_DATA_CONTRIBUTOR_ROLE_ID}`;
  const expectedName = uuidV5Url(
    `${after.scope}/operator/${operatorPrincipalId}/${roleDefinitionId}`,
  );

  return (
    after.name === expectedName &&
    after.role_definition_id === roleDefinitionId &&
    after.principal_id === operatorPrincipalId &&
    after.principal_type === "User"
  )
    ? after.scope.slice(0, -`/tables/${tableName}`.length)
    : undefined;
}

const CHECK_STATUSES = new Set(["pass", "fail", "error", "unknown"]);
const CHECK_KINDS = new Set(["check", "output_value", "resource", "var"]);
const MODEL_SPIKE_UNKNOWN_CHECK_KINDS = new Set(["resource", "var"]);
const TERRAFORM_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const TERRAFORM_IDENTIFIER_PREFIX = /^[A-Za-z_][A-Za-z0-9_-]*/;
const COGNITIVE_RESOURCE_TYPES = new Set([
  "azurerm_cognitive_account",
  "azurerm_cognitive_deployment",
]);
const MODEL_SPIKE_DIRECT_DEPENDENCY_MODULES = new Set([
  "budget",
  "foundry",
  "observability",
]);
const MODEL_SPIKE_DIRECT_DEPENDENCY_PREFIXES = [
  "azurerm_resource_group.foundation",
  "module.budget",
  "module.observability",
  "module.workload_state",
  "module.container_registry",
  "module.container_app_environment",
  "var.location",
];

function hasOnlyPairedUnicodeSurrogates(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }

  return true;
}

function parseTerraformInstanceKey(value, offset) {
  if (value[offset] !== "[") {
    return { nextOffset: offset };
  }

  const keyOffset = offset + 1;
  if (value[keyOffset] === '"') {
    let quoteOffset = keyOffset + 1;
    while (quoteOffset < value.length) {
      if (value[quoteOffset] === "\\") {
        quoteOffset += 2;
        continue;
      }
      if (value[quoteOffset] === '"') {
        break;
      }
      quoteOffset += 1;
    }

    if (quoteOffset >= value.length || value[quoteOffset + 1] !== "]") {
      return undefined;
    }

    const literal = value.slice(keyOffset, quoteOffset + 1);
    let key;
    try {
      key = JSON.parse(literal);
    } catch {
      return undefined;
    }

    if (
      typeof key !== "string" ||
      !hasOnlyPairedUnicodeSurrogates(key) ||
      JSON.stringify(key) !== literal
    ) {
      return undefined;
    }

    return { key, nextOffset: quoteOffset + 2 };
  }

  const closingOffset = value.indexOf("]", keyOffset);
  if (closingOffset === -1) {
    return undefined;
  }
  const literal = value.slice(keyOffset, closingOffset);
  if (!/^(?:0|[1-9][0-9]*)$/.test(literal)) {
    return undefined;
  }
  const key = Number(literal);
  if (!Number.isSafeInteger(key)) {
    return undefined;
  }

  return { key, nextOffset: closingOffset + 1 };
}

function parseTerraformModuleAddress(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const segments = [];
  let offset = 0;
  while (offset < value.length) {
    if (!value.startsWith("module.", offset)) {
      return undefined;
    }
    offset += "module.".length;

    const nameMatch = TERRAFORM_IDENTIFIER_PREFIX.exec(value.slice(offset));
    if (nameMatch === null) {
      return undefined;
    }
    const name = nameMatch[0];
    offset += name.length;

    const parsedKey = parseTerraformInstanceKey(value, offset);
    if (parsedKey === undefined) {
      return undefined;
    }
    offset = parsedKey.nextOffset;
    segments.push(
      parsedKey.key === undefined ? { name } : { name, key: parsedKey.key },
    );

    if (offset === value.length) {
      return segments;
    }
    if (value[offset] !== ".") {
      return undefined;
    }
    offset += 1;
  }

  return undefined;
}

function isTerraformModuleAddress(value) {
  return parseTerraformModuleAddress(value) !== undefined;
}

function isModuleInstanceOf(staticModule, instanceModule) {
  const staticSegments = parseTerraformModuleAddress(staticModule);
  const instanceSegments = parseTerraformModuleAddress(instanceModule);
  if (
    staticSegments === undefined ||
    instanceSegments === undefined ||
    staticSegments.length !== instanceSegments.length
  ) {
    return false;
  }

  return staticSegments.every((staticSegment, index) => {
    const instanceSegment = instanceSegments[index];
    return (
      staticSegment.name === instanceSegment.name &&
      (!Object.hasOwn(staticSegment, "key") ||
        (Object.hasOwn(instanceSegment, "key") &&
          staticSegment.key === instanceSegment.key))
    );
  });
}

function checkAddressDisplay(address) {
  const prefix = address.module === undefined ? "" : `${address.module}.`;

  switch (address.kind) {
    case "check":
      return `${prefix}check.${address.name}`;
    case "output_value":
      return `${prefix}output.${address.name}`;
    case "resource":
      return `${prefix}${address.mode === "data" ? "data." : ""}${address.type}.${address.name}`;
    case "var":
      return `${prefix}var.${address.name}`;
    default:
      return undefined;
  }
}

function hasValidCheckAddress(address) {
  if (
    !isObject(address) ||
    typeof address.kind !== "string" ||
    !CHECK_KINDS.has(address.kind) ||
    typeof address.name !== "string" ||
    !TERRAFORM_IDENTIFIER.test(address.name) ||
    typeof address.to_display !== "string"
  ) {
    return false;
  }

  if (
    Object.hasOwn(address, "module") &&
    !isTerraformModuleAddress(address.module)
  ) {
    return false;
  }

  if (address.kind === "resource") {
    if (
      !hasExactKeys(address, [
        "kind",
        "to_display",
        "mode",
        "type",
        "name",
        ...(Object.hasOwn(address, "module") ? ["module"] : []),
      ]) ||
      !["managed", "data"].includes(address.mode) ||
      typeof address.type !== "string" ||
      !TERRAFORM_IDENTIFIER.test(address.type)
    ) {
      return false;
    }
  } else if (
    !hasExactKeys(address, [
      "kind",
      "to_display",
      "name",
      ...(Object.hasOwn(address, "module") ? ["module"] : []),
    ])
  ) {
    return false;
  }

  return address.to_display === checkAddressDisplay(address);
}

function hasValidCheckInstanceAddress(staticAddress, instanceAddress) {
  if (!isObject(instanceAddress) || typeof instanceAddress.to_display !== "string") {
    return false;
  }

  const hasModule = Object.hasOwn(instanceAddress, "module");
  if (hasModule !== Object.hasOwn(staticAddress, "module")) {
    return false;
  }

  if (
    hasModule &&
    !isModuleInstanceOf(staticAddress.module, instanceAddress.module)
  ) {
    return false;
  }

  const hasInstanceKey = Object.hasOwn(instanceAddress, "instance_key");
  if (
    hasInstanceKey &&
    (staticAddress.kind !== "resource" ||
      !(
        (typeof instanceAddress.instance_key === "number" &&
          Number.isSafeInteger(instanceAddress.instance_key) &&
          instanceAddress.instance_key >= 0) ||
        (typeof instanceAddress.instance_key === "string" &&
          hasOnlyPairedUnicodeSurrogates(instanceAddress.instance_key))
      ))
  ) {
    return false;
  }

  const expectedKeys = [
    "to_display",
    ...(hasModule ? ["module"] : []),
    ...(hasInstanceKey ? ["instance_key"] : []),
  ];
  if (!hasExactKeys(instanceAddress, expectedKeys)) {
    return false;
  }

  const addressForDisplay = {
    ...staticAddress,
    ...(hasModule ? { module: instanceAddress.module } : {}),
  };
  const instanceSuffix = hasInstanceKey
    ? `[${JSON.stringify(instanceAddress.instance_key)}]`
    : "";
  return (
    instanceAddress.to_display ===
    `${checkAddressDisplay(addressForDisplay)}${instanceSuffix}`
  );
}

function hasValidCheckInstance(staticAddress, instance) {
  if (
    !isObject(instance) ||
    !hasExactKeys(instance, [
      "address",
      "status",
      ...(Object.hasOwn(instance, "problems") ? ["problems"] : []),
    ]) ||
    !CHECK_STATUSES.has(instance.status) ||
    !hasValidCheckInstanceAddress(staticAddress, instance.address)
  ) {
    return false;
  }

  if (Object.hasOwn(instance, "problems")) {
    return (
      ["fail", "error"].includes(instance.status) &&
      Array.isArray(instance.problems) &&
      instance.problems.every(
        (problem) =>
          hasExactKeys(problem, ["message"]) &&
          typeof problem.message === "string",
      )
    );
  }

  return true;
}

function hasValidCheck(check) {
  const hasInstances = isObject(check) && Object.hasOwn(check, "instances");
  if (
    !hasExactKeys(check, [
      "address",
      "status",
      ...(hasInstances ? ["instances"] : []),
    ]) ||
    !hasValidCheckAddress(check.address) ||
    !CHECK_STATUSES.has(check.status)
  ) {
    return false;
  }

  if (!hasInstances) {
    return check.status === "unknown";
  }

  if (
    !Array.isArray(check.instances) ||
    check.instances.length === 0 ||
    !check.instances.every((instance) =>
      hasValidCheckInstance(check.address, instance),
    )
  ) {
    return false;
  }

  const instanceDisplays = check.instances.map(
    (instance) => instance.address.to_display,
  );
  if (new Set(instanceDisplays).size !== instanceDisplays.length) {
    return false;
  }

  const instanceStatuses = check.instances.map((instance) => instance.status);
  const aggregateStatus = instanceStatuses.includes("error")
    ? "error"
    : instanceStatuses.includes("fail")
      ? "fail"
      : instanceStatuses.includes("unknown")
        ? "unknown"
        : "pass";
  return check.status === aggregateStatus;
}

function checkAddressIsModelRelevant(address) {
  const moduleSegments = parseTerraformModuleAddress(address.module);
  const moduleIsDirectDependency =
    moduleSegments !== undefined &&
    moduleSegments.some((segment) =>
      MODEL_SPIKE_DIRECT_DEPENDENCY_MODULES.has(segment.name),
    );
  const isDirectModelDependency = MODEL_SPIKE_DIRECT_DEPENDENCY_PREFIXES.some(
    (prefix) =>
      address.to_display === prefix ||
      address.to_display.startsWith(`${prefix}.`) ||
      address.to_display.startsWith(`${prefix}[`),
  );

  return (
    moduleIsDirectDependency ||
    isDirectModelDependency ||
    (address.kind === "var" &&
      address.name === "foundry_deployments") ||
    (address.kind === "resource" &&
      COGNITIVE_RESOURCE_TYPES.has(address.type))
  );
}

function checkIsModelRelevant(check) {
  return (
    checkAddressIsModelRelevant(check.address) ||
    (check.instances ?? []).some((instance) =>
      checkAddressIsModelRelevant({
        ...check.address,
        ...(Object.hasOwn(instance.address, "module")
          ? { module: instance.address.module }
          : {}),
      }),
    )
  );
}

function hasNonPassingCheck(plan) {
  if (plan.checks === undefined) {
    return false;
  }

  if (!Array.isArray(plan.checks)) {
    return true;
  }

  return plan.checks.some(
    (check) =>
      !hasValidCheck(check) ||
      check.status !== "pass" ||
      (check.instances ?? []).some((instance) => instance.status !== "pass"),
  );
}

function hasNonPassingModelSpikeCheck(plan) {
  if (plan.checks === undefined) {
    return false;
  }

  if (!Array.isArray(plan.checks)) {
    return true;
  }

  return plan.checks.some((check) => {
    if (!hasValidCheck(check)) {
      return true;
    }

    if (check.status === "pass") {
      return false;
    }
    if (check.status !== "unknown") {
      return true;
    }

    return (
      !MODEL_SPIKE_UNKNOWN_CHECK_KINDS.has(check.address.kind) ||
      checkIsModelRelevant(check)
    );
  });
}

function hasResourceDrift(plan) {
  if (plan.resource_drift === undefined || plan.resource_drift === null) {
    return false;
  }

  return !Array.isArray(plan.resource_drift) || plan.resource_drift.length > 0;
}

function isNoOp(actions) {
  return actions.length === 1 && actions[0] === "no-op";
}

function isCreate(actions) {
  return actions.length === 1 && actions[0] === "create";
}

function isUpdate(actions) {
  return actions.length === 1 && actions[0] === "update";
}

function hasAllowedScale(after) {
  const scale = after?.body?.properties?.template?.scale;

  return (
    isObject(scale) &&
    scale.minReplicas === 0 &&
    scale.maxReplicas === 1
  );
}

function hasExactKeys(value, keys) {
  return (
    isObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasUnknownValue(value) {
  if (value === true) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some(hasUnknownValue);
  }

  return isObject(value) && Object.values(value).some(hasUnknownValue);
}

function hasUnknownIdentityInput(value) {
  if (value === undefined) {
    return false;
  }

  if (value === true || !Array.isArray(value)) {
    return true;
  }

  return value.some(
    (identity) =>
      identity === true ||
      !isObject(identity) ||
      hasUnknownValue(identity.identity_ids) ||
      hasUnknownValue(identity.type),
  );
}

function valuesByName(values) {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const entries = new Map();
  for (const value of values) {
    if (!isObject(value) || typeof value.name !== "string" || entries.has(value.name)) {
      return undefined;
    }
    entries.set(value.name, value);
  }
  return entries;
}

function hasExactNamedEntries(entries, names) {
  return (
    entries instanceof Map &&
    entries.size === names.length &&
    names.every((name) => entries.has(name))
  );
}

function hasEnvValue(entries, name, value) {
  const entry = entries?.get(name);
  return hasExactKeys(entry, ["name", "value"]) && entry.value === value;
}

function hasEnvSecret(entries, name, secretRef) {
  const entry = entries?.get(name);
  return (
    hasExactKeys(entry, ["name", "secretRef"]) &&
    entry.secretRef === secretRef
  );
}

function hasExactFailClosedBrowserOriginPolicy(entries) {
  const allowedOrigins = entries?.get("PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON");
  const allowNullOrigin = entries?.get("PALANCAR_ALLOW_NULL_BROWSER_ORIGIN");

  if (
    !hasExactKeys(allowedOrigins, ["name", "value"]) ||
    !hasExactKeys(allowNullOrigin, ["name", "value"]) ||
    typeof allowedOrigins.value !== "string" ||
    allowNullOrigin.value !== "false"
  ) {
    return false;
  }

  try {
    const parsed = JSON.parse(allowedOrigins.value);
    return (
      Array.isArray(parsed) &&
      parsed.length === 1 &&
      parsed[0] === EXPECTED_BROWSER_ALLOWED_ORIGINS
    );
  } catch {
    return false;
  }
}

function hasExactDevelopmentLanguageBoundary(entries) {
  return hasEnvValue(
    entries,
    "PALANCAR_LANGUAGE_BOUNDARY_MODE",
    EXPECTED_LANGUAGE_BOUNDARY_MODE,
  );
}

function hasExactFailClosedBrowserOriginPolicyInContainerApp(after) {
  const containers = valuesByName(after?.body?.properties?.template?.containers);
  const relay = containers?.get("relay");
  const entries = valuesByName(relay?.env);
  return (
    hasExactFailClosedBrowserOriginPolicy(entries) &&
    hasExactDevelopmentLanguageBoundary(entries)
  );
}

function isImmutableAcrImage(value) {
  return (
    typeof value === "string" &&
    /^[a-z0-9.-]+\.azurecr\.io\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(value)
  );
}

function isUserAssignedIdentity(value) {
  return (
    typeof value === "string" &&
    /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[^/]+$/i.test(value)
  );
}

function isCanonicalUserAssignedIdentity(value) {
  return (
    typeof value === "string" &&
    /^\/subscriptions\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/resourceGroups\/[^/]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[^/]+$/.test(value)
  );
}

function sameIdentityCaseInsensitive(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function hasExactManagedEnvironmentId(value, identity) {
  const identityMatch =
    typeof identity === "string"
      ? /^\/subscriptions\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[^/]+$/i.exec(identity)
      : null;
  const environmentMatch =
    typeof value === "string"
      ? /^\/subscriptions\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/managedEnvironments\/[^/]+$/.exec(value)
      : null;

  return (
    identityMatch !== null &&
    environmentMatch !== null &&
    environmentMatch[1] === identityMatch[1].toLowerCase() &&
    environmentMatch[2].toLowerCase() === identityMatch[2].toLowerCase()
  );
}

function containsHelperTopology(value) {
  if (value === 4001 || value === "4001") {
    return true;
  }

  if (typeof value === "string") {
    return (
      value.includes(":4001") ||
      value.includes("PALANCAR_LITELLM_METADATA") ||
      value.includes("PALANCAR_LITELLM_EXPECTED_BACKEND") ||
      value.includes("PALANCAR_LITELLM_EXPECTED_UPSTREAM_MODEL")
    );
  }

  if (Array.isArray(value)) {
    return value.some(containsHelperTopology);
  }

  return isObject(value) && Object.values(value).some(containsHelperTopology);
}

function hasExactSecret(entry, name, runtimeIdentity, expectedPath) {
  if (
    !hasExactKeys(entry, ["name", "keyVaultUrl", "identity"]) ||
    entry.name !== name ||
    entry.identity !== runtimeIdentity ||
    typeof entry.keyVaultUrl !== "string"
  ) {
    return false;
  }

  try {
    const url = new URL(entry.keyVaultUrl);
    return (
      url.protocol === "https:" &&
      /^[a-z0-9-]+\.vault\.azure\.net$/.test(url.hostname) &&
      url.pathname === expectedPath &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function hasExactIngress(ingress) {
  if (
    !hasExactKeys(ingress, [
      "external",
      "targetPort",
      "transport",
      "allowInsecure",
      "traffic",
    ]) ||
    ingress.external !== true ||
    ingress.targetPort !== 8787 ||
    ingress.transport !== "Http" ||
    ingress.allowInsecure !== false ||
    !Array.isArray(ingress.traffic) ||
    ingress.traffic.length !== 1
  ) {
    return false;
  }

  const traffic = ingress.traffic[0];
  return (
    hasExactKeys(traffic, ["latestRevision", "weight"]) &&
    traffic.latestRevision === true &&
    traffic.weight === 100
  );
}

function hasExactHttpProbe(probe, expected) {
  const expectedKeys = [
    "type",
    "httpGet",
    ...(expected.initialDelaySeconds === undefined
      ? []
      : ["initialDelaySeconds"]),
    "periodSeconds",
    "timeoutSeconds",
    "failureThreshold",
  ];

  return (
    hasExactKeys(probe, expectedKeys) &&
    probe.type === expected.type &&
    hasExactKeys(probe.httpGet, ["path", "port"]) &&
    probe.httpGet.path === expected.path &&
    probe.httpGet.port === expected.port &&
    probe.initialDelaySeconds === expected.initialDelaySeconds &&
    probe.periodSeconds === expected.periodSeconds &&
    probe.timeoutSeconds === expected.timeoutSeconds &&
    probe.failureThreshold === expected.failureThreshold
  );
}

function hasExactProbes(probes, expectedProbes) {
  return (
    Array.isArray(probes) &&
    probes.length === expectedProbes.length &&
    probes.every((probe, index) =>
      hasExactHttpProbe(probe, expectedProbes[index]),
    )
  );
}

function hasExactRuntimeContainerApp(change) {
  if (
    hasUnknownValue(change.change.after_unknown?.body) ||
    hasUnknownIdentityInput(change.change.after_unknown?.identity) ||
    hasUnknownValue(change.change.after_sensitive?.body) ||
    hasUnknownValue(change.change.after_sensitive?.identity)
  ) {
    return false;
  }

  const after = change.change.after;
  const body = after?.body;
  const properties = body?.properties;
  const configuration = properties?.configuration;
  const template = properties?.template;
  const identities = after?.identity;
  const registries = configuration?.registries;
  const registry = Array.isArray(registries) ? registries[0] : undefined;
  const imagePullIdentity = registry?.identity;
  const secrets = valuesByName(configuration?.secrets);
  const masterSecret = secrets?.get("litellm-master-key");
  const openRouterSecret = secrets?.get("openrouter-api-key");
  const runtimeIdentity = masterSecret?.identity;
  const identityIds = identities?.[0]?.identity_ids;

  if (
    !isObject(body) ||
    !isObject(properties) ||
    !isObject(configuration) ||
    !isObject(template) ||
    !hasExactKeys(body, ["properties"]) ||
    !hasExactKeys(properties, [
      "managedEnvironmentId",
      "configuration",
      "template",
    ]) ||
    !hasExactKeys(configuration, [
      "activeRevisionsMode",
      "ingress",
      "registries",
      "identitySettings",
      "secrets",
    ]) ||
    !hasExactKeys(template, ["containers", "scale"]) ||
    configuration.activeRevisionsMode !== "Single" ||
    !hasExactIngress(configuration.ingress) ||
    !Array.isArray(identities) ||
    identities.length !== 1 ||
    !hasExactKeys(identities[0], ["type", "identity_ids"]) ||
    identities[0]?.type !== "UserAssigned" ||
    !Array.isArray(identityIds) ||
    identityIds.length !== 2 ||
    !identityIds.every(isUserAssignedIdentity) ||
    !isCanonicalUserAssignedIdentity(imagePullIdentity) ||
    !isCanonicalUserAssignedIdentity(runtimeIdentity) ||
    !sameIdentityCaseInsensitive(masterSecret?.identity, openRouterSecret?.identity) ||
    sameIdentityCaseInsensitive(imagePullIdentity, runtimeIdentity) ||
    !identityIds.some((identity) =>
      sameIdentityCaseInsensitive(identity, imagePullIdentity),
    ) ||
    !identityIds.some((identity) =>
      sameIdentityCaseInsensitive(identity, runtimeIdentity),
    ) ||
    !hasExactManagedEnvironmentId(
      properties.managedEnvironmentId,
      imagePullIdentity,
    ) ||
    (after.sensitive_body !== undefined && after.sensitive_body !== null) ||
    containsHelperTopology(body)
  ) {
    return false;
  }

  const identitySettings = configuration.identitySettings;
  if (
    !Array.isArray(identitySettings) ||
    identitySettings.length !== 2 ||
    !hasExactKeys(identitySettings[0], ["identity", "lifecycle"]) ||
    identitySettings[0].identity !== imagePullIdentity.replace("/resourceGroups/", "/resourcegroups/") ||
    identitySettings[0].lifecycle !== "None" ||
    !hasExactKeys(identitySettings[1], ["identity", "lifecycle"]) ||
    identitySettings[1].identity !== runtimeIdentity.replace("/resourceGroups/", "/resourcegroups/") ||
    identitySettings[1].lifecycle !== "Main" ||
    !Array.isArray(registries) ||
    registries.length !== 1 ||
    !hasExactKeys(registry, ["server", "identity"]) ||
    registry.identity !== imagePullIdentity ||
    typeof registry.server !== "string" ||
    !/^[a-z0-9.-]+\.azurecr\.io$/.test(registry.server)
  ) {
    return false;
  }

  if (
    !hasExactNamedEntries(secrets, ["litellm-master-key", "openrouter-api-key"]) ||
    !hasExactSecret(masterSecret, "litellm-master-key", runtimeIdentity, "/secrets/litellm-master-key") ||
    !hasExactSecret(openRouterSecret, "openrouter-api-key", runtimeIdentity, "/secrets/openrouter-api-key") ||
    new URL(masterSecret.keyVaultUrl).origin !== new URL(openRouterSecret.keyVaultUrl).origin
  ) {
    return false;
  }

  const containers = valuesByName(template.containers);
  const relay = containers?.get("relay");
  const litellm = containers?.get("litellm");
  if (
    !hasExactNamedEntries(containers, ["relay", "litellm"]) ||
    !hasExactKeys(relay, ["name", "image", "resources", "env", "probes"]) ||
    !hasExactKeys(litellm, ["name", "image", "resources", "env", "probes"]) ||
    !isImmutableAcrImage(relay?.image) ||
    !relay.image.startsWith(`${registry.server}/`) ||
    !isImmutableAcrImage(litellm?.image) ||
    !litellm.image.startsWith(`${registry.server}/`) ||
    !hasExactKeys(relay?.resources, ["cpu", "memory"]) ||
    !hasExactKeys(litellm?.resources, ["cpu", "memory"]) ||
    relay?.resources?.cpu !== 0.25 ||
    relay?.resources?.memory !== "0.5Gi" ||
    litellm?.resources?.cpu !== 0.25 ||
    litellm?.resources?.memory !== "0.5Gi" ||
    !hasExactProbes(relay?.probes, [
      {
        type: "Liveness",
        path: "/healthz",
        port: 8787,
        initialDelaySeconds: 10,
        periodSeconds: 10,
        timeoutSeconds: 3,
        failureThreshold: 3,
      },
      {
        type: "Readiness",
        path: "/readyz",
        port: 8787,
        initialDelaySeconds: 5,
        periodSeconds: 5,
        timeoutSeconds: 3,
        failureThreshold: 3,
      },
    ]) ||
    !hasExactProbes(litellm?.probes, [
      {
        type: "Liveness",
        path: "/health/liveliness",
        port: 4000,
        initialDelaySeconds: 10,
        periodSeconds: 30,
        timeoutSeconds: 3,
        failureThreshold: 3,
      },
      {
        type: "Readiness",
        path: "/health/readiness",
        port: 4000,
        periodSeconds: 10,
        timeoutSeconds: 3,
        failureThreshold: 3,
      },
      {
        type: "Startup",
        path: "/health/liveliness",
        port: 4000,
        periodSeconds: 10,
        timeoutSeconds: 3,
        failureThreshold: 10,
      },
    ])
  ) {
    return false;
  }

  const relayEnvNames = [
    "NODE_ENV",
    "PORT",
    "PALANCAR_GENERATION_PROVIDER",
    "PALANCAR_RELAY_BIND_HOST",
    "PALANCAR_RELAY_ENVIRONMENT",
    "PALANCAR_RELAY_ORIGIN",
    "PALANCAR_GATE_POLICY_VERSION",
    "AZURE_CLIENT_ID",
    "PALANCAR_LANGUAGE_BOUNDARY_MODE",
    "PALANCAR_SECURITY_MODE",
    "PALANCAR_WORKLOAD_TABLE_ENDPOINT",
    "PALANCAR_SECURITY_STATE_TABLE",
    "PALANCAR_RATE_STATE_TABLE",
    "PALANCAR_TRANSCRIPTION_PROVIDER",
    "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
    "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
    "PALANCAR_LITELLM_BASE_URL",
    "PALANCAR_LITELLM_MODEL",
    "PALANCAR_LITELLM_API_KEY",
  ];
  const relayEnv = valuesByName(relay.env);
  if (
    !hasExactNamedEntries(relayEnv, relayEnvNames) ||
    ![...relayEnv.values()].every((entry) =>
      entry.name === "PALANCAR_LITELLM_API_KEY"
        ? hasExactKeys(entry, ["name", "secretRef"])
        : hasExactKeys(entry, ["name", "value"]),
    ) ||
    !hasEnvValue(relayEnv, "NODE_ENV", "production") ||
    !hasEnvValue(relayEnv, "PORT", "8787") ||
    !hasEnvValue(relayEnv, "PALANCAR_GENERATION_PROVIDER", "litellm") ||
    !hasEnvValue(relayEnv, "PALANCAR_RELAY_BIND_HOST", "0.0.0.0") ||
    !hasEnvSecret(relayEnv, "PALANCAR_LITELLM_API_KEY", "litellm-master-key") ||
    !hasEnvValue(relayEnv, "PALANCAR_LITELLM_BASE_URL", "http://127.0.0.1:4000") ||
    !hasEnvValue(relayEnv, "PALANCAR_LITELLM_MODEL", "palancar-generation") ||
    !hasEnvValue(relayEnv, "PALANCAR_SECURITY_MODE", "azure-table") ||
    !hasExactDevelopmentLanguageBoundary(relayEnv) ||
    !hasEnvValue(relayEnv, "PALANCAR_TRANSCRIPTION_PROVIDER", "mock") ||
    !hasExactFailClosedBrowserOriginPolicy(relayEnv) ||
    !hasEnvValue(relayEnv, "PALANCAR_SECURITY_STATE_TABLE", "SecurityState") ||
    !hasEnvValue(relayEnv, "PALANCAR_RATE_STATE_TABLE", "RateState") ||
    !isUserAssignedIdentity(runtimeIdentity) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(relayEnv.get("AZURE_CLIENT_ID")?.value) ||
    typeof relayEnv.get("PALANCAR_RELAY_ENVIRONMENT")?.value !== "string" ||
    relayEnv.get("PALANCAR_RELAY_ENVIRONMENT").value.trim() === "" ||
    !/^wss:\/\/[a-z0-9.-]+\.azurecontainerapps\.io$/.test(relayEnv.get("PALANCAR_RELAY_ORIGIN")?.value) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(relayEnv.get("PALANCAR_GATE_POLICY_VERSION")?.value) ||
    typeof relayEnv.get("PALANCAR_WORKLOAD_TABLE_ENDPOINT")?.value !== "string" ||
    !/^https:\/\/[a-z0-9]+\.table\.core\.windows\.net$/.test(relayEnv.get("PALANCAR_WORKLOAD_TABLE_ENDPOINT").value)
  ) {
    return false;
  }

  const litellmEnv = valuesByName(litellm.env);
  if (
    !hasExactNamedEntries(litellmEnv, [
      "PALANCAR_LITELLM_BACKEND",
      "PALANCAR_LITELLM_UPSTREAM_MODEL",
      "LITELLM_MASTER_KEY",
      "OPENROUTER_API_KEY",
    ]) ||
    ![...litellmEnv.values()].every((entry) =>
      ["LITELLM_MASTER_KEY", "OPENROUTER_API_KEY"].includes(entry.name)
        ? hasExactKeys(entry, ["name", "secretRef"])
        : hasExactKeys(entry, ["name", "value"]),
    ) ||
    !hasEnvValue(litellmEnv, "PALANCAR_LITELLM_BACKEND", "openrouter") ||
    typeof litellmEnv.get("PALANCAR_LITELLM_UPSTREAM_MODEL")?.value !== "string" ||
    !litellmEnv.get("PALANCAR_LITELLM_UPSTREAM_MODEL").value.startsWith("openrouter/") ||
    !hasEnvSecret(litellmEnv, "LITELLM_MASTER_KEY", "litellm-master-key") ||
    !hasEnvSecret(litellmEnv, "OPENROUTER_API_KEY", "openrouter-api-key")
  ) {
    return false;
  }

  return (
    hasExactKeys(template.scale, ["minReplicas", "maxReplicas"]) &&
    [0, 1].includes(template.scale.minReplicas) &&
    template.scale.maxReplicas === 1
  );
}

function hasExactPinnedModelAfter(after) {
  if (!isObject(after)) {
    return false;
  }

  const models = after.model;
  const skus = after.sku;

  return (
    hasExactKeys(after, [
      "cognitive_account_id",
      "dynamic_throttling_enabled",
      "model",
      "name",
      "sku",
      "timeouts",
      "version_upgrade_option",
    ]) &&
    after.cognitive_account_id === FOUNDRY_COGNITIVE_ACCOUNT_ID &&
    after.dynamic_throttling_enabled === null &&
    after.name === PINNED_DEPLOYMENT_NAME &&
    Array.isArray(models) &&
    models.length === 1 &&
    hasExactKeys(models[0], ["format", "name", "version"]) &&
    models[0].format === "OpenAI" &&
    models[0].name === PINNED_DEPLOYMENT_NAME &&
    models[0].version === PINNED_MODEL_VERSION &&
    Array.isArray(skus) &&
    skus.length === 1 &&
    hasExactKeys(skus[0], ["capacity", "family", "name", "size", "tier"]) &&
    skus[0].name === "GlobalStandard" &&
    skus[0].capacity === 1 &&
    skus[0].family === null &&
    skus[0].size === null &&
    skus[0].tier === null &&
    after.timeouts === null &&
    after.version_upgrade_option === "NoAutoUpgrade"
  );
}

function isExactEmptyObjectList(value) {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    hasExactKeys(value[0], [])
  );
}

function hasExactPinnedModelCreateState(change) {
  return (
    hasExactKeys(change, [
      "actions",
      "before",
      "after",
      "after_unknown",
      "before_sensitive",
      "after_sensitive",
    ]) &&
    isCreate(change.actions) &&
    change.before === null &&
    change.before_sensitive === false &&
    hasExactPinnedModelAfter(change.after) &&
    hasExactKeys(change.after_unknown, [
      "id",
      "model",
      "rai_policy_name",
      "sku",
    ]) &&
    change.after_unknown.id === true &&
    change.after_unknown.rai_policy_name === true &&
    isExactEmptyObjectList(change.after_unknown.model) &&
    isExactEmptyObjectList(change.after_unknown.sku) &&
    hasExactKeys(change.after_sensitive, ["model", "sku"]) &&
    isExactEmptyObjectList(change.after_sensitive.model) &&
    isExactEmptyObjectList(change.after_sensitive.sku)
  );
}

function hasExactPinnedModelCreateResourceChange(resourceChange) {
  return (
    hasExactKeys(resourceChange, [
      "address",
      "module_address",
      "mode",
      "type",
      "name",
      "index",
      "provider_name",
      "change",
    ]) &&
    resourceChange.address === MODEL_SPIKE_DEPLOYMENT &&
    resourceChange.module_address === "module.foundry" &&
    resourceChange.mode === "managed" &&
    resourceChange.type === "azurerm_cognitive_deployment" &&
    resourceChange.name === "this" &&
    resourceChange.index === PINNED_DEPLOYMENT_NAME &&
    resourceChange.provider_name === AZURERM_PROVIDER_NAME &&
    hasExactPinnedModelCreateState(resourceChange.change)
  );
}

function isConfiguredRoleAssignmentAddress(address) {
  return (
    typeof address === "string" &&
    CONFIGURED_ROLE_ASSIGNMENT_PREFIXES.some(
      (prefix) =>
        address.startsWith(prefix) && address.length > prefix.length,
    )
  );
}

function collectRoleAssignmentAddresses(value, addresses) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRoleAssignmentAddresses(item, addresses);
    }
    return;
  }

  if (!isObject(value)) {
    return;
  }

  if (isConfiguredRoleAssignmentAddress(value.address)) {
    addresses.add(value.address);
  }

  for (const child of Object.values(value)) {
    collectRoleAssignmentAddresses(child, addresses);
  }
}

function configuredRoleAssignmentAddresses(plan) {
  const addresses = new Set();

  for (const source of [
    plan.resource_changes,
    plan.configuration,
    plan.prior_state,
  ]) {
    collectRoleAssignmentAddresses(source, addresses);
  }

  return addresses;
}

function isFoundationAddress(address) {
  return (
    address === "azurerm_resource_group.foundation" ||
    FOUNDATION_ADDRESS_PREFIXES.some((prefix) => address.startsWith(prefix))
  );
}

function collectConfiguredFoundationAddresses(value, addresses) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectConfiguredFoundationAddresses(item, addresses);
    }
    return;
  }

  if (!isObject(value)) {
    return;
  }

  if (
    value.mode !== "data" &&
    typeof value.address === "string" &&
    isFoundationAddress(value.address)
  ) {
    addresses.add(value.address);
  }

  for (const child of Object.values(value)) {
    collectConfiguredFoundationAddresses(child, addresses);
  }
}

function configuredFoundationAddresses(plan) {
  const addresses = new Set();
  for (const source of [plan.configuration, plan.prior_state]) {
    collectConfiguredFoundationAddresses(source, addresses);
  }
  return addresses;
}

function collectPriorManagedAddresses(value, addresses) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPriorManagedAddresses(item, addresses);
    }
    return;
  }

  if (!isObject(value)) {
    return;
  }

  if (
    value.mode !== "data" &&
    typeof value.address === "string"
  ) {
    addresses.add(value.address);
  }

  for (const child of Object.values(value)) {
    collectPriorManagedAddresses(child, addresses);
  }
}

function priorManagedAddresses(plan) {
  const addresses = new Set();
  collectPriorManagedAddresses(plan.prior_state, addresses);
  return addresses;
}

function exactFinalImageVariables(plan) {
  const imageVariables = [
    ["relay_image_digest", "palancar-relay"],
    ["litellm_image_digest", "palancar-litellm-proxy"],
    ["expiry_cleanup_image_digest", "palancar-expiry-cleanup"],
  ];
  const images = {};

  for (const [name, repository] of imageVariables) {
    const descriptor = plan.variables?.[name];
    const value = descriptor?.value;
    if (
      !hasExactKeys(descriptor, ["value"]) ||
      typeof value !== "string" ||
      !new RegExp(
        `^${FINAL_ACR_LOGIN_SERVER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@sha256:[0-9a-f]{64}$`,
      ).test(value)
    ) {
      return undefined;
    }
    images[repository] = value;
  }

  return new Set(Object.values(images)).size === imageVariables.length
    ? images
    : undefined;
}

function hasExactFinalFoundryDeploymentsVariable(plan) {
  const descriptor = plan.variables?.foundry_deployments;
  const deployments = descriptor?.value;
  if (
    !hasExactKeys(descriptor, ["value"]) ||
    !isObject(deployments) ||
    Object.getPrototypeOf(deployments) !== Object.prototype ||
    !hasExactKeys(deployments, [PINNED_DEPLOYMENT_NAME])
  ) {
    return false;
  }

  const deployment = deployments[PINNED_DEPLOYMENT_NAME];
  return (
    hasExactKeys(deployment, [
      "model_name",
      "model_version",
      "model_format",
      "sku_name",
      "capacity",
      "version_upgrade_option",
    ]) &&
    deployment.model_name === PINNED_DEPLOYMENT_NAME &&
    deployment.model_version === PINNED_MODEL_VERSION &&
    deployment.model_format === "OpenAI" &&
    deployment.sku_name === "GlobalStandard" &&
    deployment.capacity === 1 &&
    deployment.version_upgrade_option === "NoAutoUpgrade"
  );
}

function hasFinalNoUnknowns(resourceChange) {
  const unknown = resourceChange.change.after_unknown;
  if (unknown === undefined || unknown === null) {
    return true;
  }
  if (!isObject(unknown)) {
    return false;
  }

  return Object.entries(unknown).every(
    ([key, value]) => key === "id" && value === true,
  );
}

function hasExactFinalTags(value) {
  return (
    hasExactKeys(value, [
      "application",
      "environment",
      "managed-by",
      "data-classification",
    ]) &&
    value.application === "palancar" &&
    value.environment === "dev" &&
    value["managed-by"] === "terraform" &&
    value["data-classification"] === "operational-metadata"
  );
}

function hasExactFinalTcpProbe(probe, expected) {
  return (
    hasExactKeys(probe, [
      "type",
      "tcpSocket",
      ...(expected.initialDelaySeconds === undefined
        ? []
        : ["initialDelaySeconds"]),
      "periodSeconds",
      "timeoutSeconds",
      "failureThreshold",
    ]) &&
    probe.type === expected.type &&
    hasExactKeys(probe.tcpSocket, ["port"]) &&
    probe.tcpSocket.port === expected.port &&
    probe.initialDelaySeconds === expected.initialDelaySeconds &&
    probe.periodSeconds === expected.periodSeconds &&
    probe.timeoutSeconds === expected.timeoutSeconds &&
    probe.failureThreshold === expected.failureThreshold
  );
}

function hasExactFinalConnectionString(value) {
  return (
    typeof value === "string" &&
    /^InstrumentationKey=[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12};IngestionEndpoint=https:\/\/[a-z0-9.-]+\.in\.applicationinsights\.azure\.com$/.test(
      value,
    )
  );
}

function hasExactFinalRelayOrigin(value) {
  return (
    typeof value === "string" &&
    new RegExp(
      `^wss://${FINAL_CONTAINER_APP_NAME}\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.azurecontainerapps\\.io$`,
    ).test(value)
  );
}

function hasExactFinalRelayEnvironment(env, runtimeClientId, bindings = {}) {
  const names = [
    "NODE_ENV",
    "PORT",
    "PALANCAR_GENERATION_PROVIDER",
    "PALANCAR_RELAY_BIND_HOST",
    "PALANCAR_RELAY_ENVIRONMENT",
    "PALANCAR_RELAY_ORIGIN",
    "PALANCAR_GATE_POLICY_VERSION",
    "AZURE_CLIENT_ID",
    "PALANCAR_DEPLOYMENT_SLOT",
    "PALANCAR_LANGUAGE_BOUNDARY_MODE",
    "APPLICATIONINSIGHTS_CONNECTION_STRING",
    "APPLICATIONINSIGHTS_STATSBEAT_DISABLED",
    "APPLICATION_INSIGHTS_NO_STATSBEAT",
    "PALANCAR_SECURITY_MODE",
    "PALANCAR_WORKLOAD_TABLE_ENDPOINT",
    "PALANCAR_SECURITY_STATE_TABLE",
    "PALANCAR_RATE_STATE_TABLE",
    "PALANCAR_TRANSCRIPTION_PROVIDER",
    "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT",
    "PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT",
    "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
    "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
    "PALANCAR_LITELLM_BASE_URL",
    "PALANCAR_LITELLM_MODEL",
    "PALANCAR_LITELLM_API_KEY",
  ];
  const entries = valuesByName(env);
  if (
    !hasExactNamedEntries(entries, names) ||
    ![...entries.values()].every((entry) =>
      entry.name === "PALANCAR_LITELLM_API_KEY"
        ? hasExactKeys(entry, ["name", "secretRef"])
        : hasExactKeys(entry, ["name", "value"]),
    )
  ) {
    return false;
  }

  return (
    hasEnvValue(entries, "NODE_ENV", "production") &&
    hasEnvValue(entries, "PORT", "8787") &&
    hasEnvValue(entries, "PALANCAR_GENERATION_PROVIDER", "litellm") &&
    hasEnvValue(entries, "PALANCAR_RELAY_BIND_HOST", "0.0.0.0") &&
    hasEnvValue(entries, "PALANCAR_RELAY_ENVIRONMENT", "dev") &&
    (bindings.relayOrigin === undefined
      ? hasExactFinalRelayOrigin(entries.get("PALANCAR_RELAY_ORIGIN")?.value)
      : hasEnvValue(entries, "PALANCAR_RELAY_ORIGIN", bindings.relayOrigin)) &&
    hasEnvValue(entries, "PALANCAR_GATE_POLICY_VERSION", "1.0.0") &&
    hasEnvValue(entries, "AZURE_CLIENT_ID", runtimeClientId) &&
    hasEnvValue(entries, "PALANCAR_DEPLOYMENT_SLOT", "dev") &&
    hasExactDevelopmentLanguageBoundary(entries) &&
    (bindings.relayConnection === undefined
      ? hasExactFinalConnectionString(
          entries.get("APPLICATIONINSIGHTS_CONNECTION_STRING")?.value,
        )
      : entries.get("APPLICATIONINSIGHTS_CONNECTION_STRING")?.value ===
        bindings.relayConnection) &&
    hasEnvValue(entries, "APPLICATIONINSIGHTS_STATSBEAT_DISABLED", "true") &&
    hasEnvValue(entries, "APPLICATION_INSIGHTS_NO_STATSBEAT", "true") &&
    hasEnvValue(entries, "PALANCAR_SECURITY_MODE", "azure-table") &&
    hasEnvValue(
      entries,
      "PALANCAR_WORKLOAD_TABLE_ENDPOINT",
      bindings.tableEndpoint ?? FINAL_TABLE_ENDPOINT,
    ) &&
    hasEnvValue(entries, "PALANCAR_SECURITY_STATE_TABLE", "SecurityState") &&
    hasEnvValue(entries, "PALANCAR_RATE_STATE_TABLE", "RateState") &&
    hasEnvValue(entries, "PALANCAR_TRANSCRIPTION_PROVIDER", "azure-realtime") &&
    hasEnvValue(
      entries,
      "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT",
      bindings.transcriptionEndpoint ?? FINAL_FOUNDRY_REALTIME_ENDPOINT,
    ) &&
    hasEnvValue(
      entries,
      "PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT",
      PINNED_DEPLOYMENT_NAME,
    ) &&
    hasExactFailClosedBrowserOriginPolicy(entries) &&
    hasEnvValue(entries, "PALANCAR_LITELLM_BASE_URL", "http://127.0.0.1:4000") &&
    hasEnvValue(entries, "PALANCAR_LITELLM_MODEL", "palancar-generation") &&
    hasEnvSecret(entries, "PALANCAR_LITELLM_API_KEY", "litellm-master-key")
  );
}

function hasExactFinalSidecarEnvironment(env) {
  const entries = valuesByName(env);
  return (
    hasExactNamedEntries(entries, [
      "PALANCAR_LITELLM_BACKEND",
      "PALANCAR_LITELLM_UPSTREAM_MODEL",
      "LITELLM_MASTER_KEY",
      "OPENROUTER_API_KEY",
    ]) &&
    [...entries.values()].every((entry) =>
      ["LITELLM_MASTER_KEY", "OPENROUTER_API_KEY"].includes(entry.name)
        ? hasExactKeys(entry, ["name", "secretRef"])
        : hasExactKeys(entry, ["name", "value"]),
    ) &&
    hasEnvValue(entries, "PALANCAR_LITELLM_BACKEND", "openrouter") &&
    hasEnvValue(
      entries,
      "PALANCAR_LITELLM_UPSTREAM_MODEL",
      FINAL_GENERATION_MODEL,
    ) &&
    hasEnvSecret(entries, "LITELLM_MASTER_KEY", "litellm-master-key") &&
    hasEnvSecret(entries, "OPENROUTER_API_KEY", "openrouter-api-key")
  );
}

function hasExactFinalContainerApp(change, images, runtimeClientId) {
  if (
    !hasFinalNoUnknowns(change) ||
    hasUnknownValue(change.change.after_sensitive?.body) ||
    hasUnknownValue(change.change.after_sensitive?.identity)
  ) {
    return false;
  }

  const after = change.change.after;
  const body = after?.body;
  const properties = body?.properties;
  const configuration = properties?.configuration;
  const template = properties?.template;
  const identities = after?.identity;
  const identityIds = identities?.[0]?.identity_ids;
  const identitySettings = configuration?.identitySettings;
  const registry = configuration?.registries?.[0];
  const secrets = valuesByName(configuration?.secrets);
  const masterSecret = secrets?.get("litellm-master-key");
  const openRouterSecret = secrets?.get("openrouter-api-key");

  if (
    !isObject(after) ||
    !hasExactKeys(after, [
      "body",
      "identity",
      "location",
      "name",
      "parent_id",
      "response_export_values",
      "retry",
      "tags",
      "type",
    ]) ||
    after.type !== "Microsoft.App/containerApps@2026-01-01" ||
    after.name !== FINAL_CONTAINER_APP_NAME ||
    after.location !== "eastus2" ||
    after.parent_id !== FINAL_RESOURCE_GROUP_ID ||
    !hasExactFinalTags(after.tags) ||
    !Array.isArray(after.response_export_values) ||
    after.response_export_values.length !== 3 ||
    after.response_export_values[0] !== "properties.configuration.ingress.fqdn" ||
    after.response_export_values[1] !== "properties.latestRevisionName" ||
    after.response_export_values[2] !== "properties.runningStatus" ||
    !hasExactKeys(after.retry, [
      "error_message_regex",
      "interval_seconds",
      "max_interval_seconds",
    ]) ||
    !Array.isArray(after.retry.error_message_regex) ||
    after.retry.error_message_regex.length !== 1 ||
    after.retry.error_message_regex[0] !== "IdentityDoesNotExist" ||
    after.retry.interval_seconds !== 10 ||
    after.retry.max_interval_seconds !== 30 ||
    !hasExactKeys(body, ["properties"]) ||
    !hasExactKeys(properties, [
      "managedEnvironmentId",
      "configuration",
      "template",
    ]) ||
    properties.managedEnvironmentId !== FINAL_CONTAINER_ENVIRONMENT_ID ||
    !hasExactKeys(configuration, [
      "activeRevisionsMode",
      "ingress",
      "registries",
      "identitySettings",
      "secrets",
    ]) ||
    configuration.activeRevisionsMode !== "Single" ||
    !hasExactIngress(configuration.ingress) ||
    !Array.isArray(identities) ||
    identities.length !== 1 ||
    !hasExactKeys(identities[0], ["type", "identity_ids"]) ||
    identities[0].type !== "UserAssigned" ||
    !Array.isArray(identityIds) ||
    identityIds.length !== 2 ||
    identityIds[0] !== FINAL_IMAGE_PULL_IDENTITY ||
    identityIds[1] !== FINAL_RUNTIME_IDENTITY ||
    !Array.isArray(configuration.registries) ||
    configuration.registries.length !== 1 ||
    !hasExactKeys(registry, ["server", "identity"]) ||
    registry.server !== FINAL_ACR_LOGIN_SERVER ||
    registry.identity !== FINAL_IMAGE_PULL_IDENTITY ||
    !Array.isArray(identitySettings) ||
    identitySettings.length !== 2 ||
    !hasExactKeys(identitySettings[0], ["identity", "lifecycle"]) ||
    identitySettings[0].identity !==
      FINAL_IMAGE_PULL_IDENTITY.replace("resourceGroups", "resourcegroups") ||
    identitySettings[0].lifecycle !== "None" ||
    !hasExactKeys(identitySettings[1], ["identity", "lifecycle"]) ||
    identitySettings[1].identity !==
      FINAL_RUNTIME_IDENTITY.replace("resourceGroups", "resourcegroups") ||
    identitySettings[1].lifecycle !== "Main" ||
    !hasExactKeys(template, ["containers", "scale"]) ||
    !hasExactKeys(template.scale, ["minReplicas", "maxReplicas"]) ||
    template.scale.minReplicas !== 1 ||
    template.scale.maxReplicas !== 1 ||
    !hasExactNamedEntries(
      secrets,
      ["litellm-master-key", "openrouter-api-key"],
    ) ||
    !hasExactKeys(masterSecret, ["name", "keyVaultUrl", "identity"]) ||
    !hasExactKeys(openRouterSecret, ["name", "keyVaultUrl", "identity"]) ||
    masterSecret.name !== "litellm-master-key" ||
    openRouterSecret.name !== "openrouter-api-key" ||
    masterSecret.identity !== FINAL_RUNTIME_IDENTITY ||
    openRouterSecret.identity !== FINAL_RUNTIME_IDENTITY ||
    masterSecret.keyVaultUrl !==
      `https://${FINAL_KEY_VAULT_HOST}/secrets/litellm-master-key` ||
    openRouterSecret.keyVaultUrl !==
      `https://${FINAL_KEY_VAULT_HOST}/secrets/openrouter-api-key`
  ) {
    return false;
  }

  const containers = valuesByName(template.containers);
  const relay = containers?.get("relay");
  const litellm = containers?.get("litellm");
  return (
    hasExactNamedEntries(containers, ["relay", "litellm"]) &&
    hasExactKeys(relay, ["name", "image", "resources", "env", "probes"]) &&
    hasExactKeys(litellm, ["name", "image", "resources", "env", "probes"]) &&
    relay.image === images["palancar-relay"] &&
    litellm.image === images["palancar-litellm-proxy"] &&
    hasExactKeys(relay.resources, ["cpu", "memory"]) &&
    hasExactKeys(litellm.resources, ["cpu", "memory"]) &&
    relay.resources.cpu === 0.25 &&
    relay.resources.memory === "0.5Gi" &&
    litellm.resources.cpu === 0.75 &&
    litellm.resources.memory === "1.5Gi" &&
    Array.isArray(relay.probes) &&
    relay.probes.length === 2 &&
    Array.isArray(litellm.probes) &&
    litellm.probes.length === 3 &&
    hasExactFinalTcpProbe(relay.probes[0], {
      type: "Liveness",
      port: 8787,
      initialDelaySeconds: 10,
      periodSeconds: 10,
      timeoutSeconds: 3,
      failureThreshold: 3,
    }) &&
    hasExactProbes(relay.probes.slice(1), [
      {
        type: "Readiness",
        path: "/readyz",
        port: 8787,
        initialDelaySeconds: 5,
        periodSeconds: 10,
        timeoutSeconds: 7,
        failureThreshold: 3,
      },
    ]) &&
    hasExactFinalTcpProbe(litellm.probes[0], {
      type: "Liveness",
      port: 4000,
      initialDelaySeconds: 10,
      periodSeconds: 30,
      timeoutSeconds: 3,
      failureThreshold: 3,
    }) &&
    hasExactProbes(litellm.probes.slice(1), [
      {
        type: "Readiness",
        path: "/health/readiness",
        port: 4000,
        periodSeconds: 10,
        timeoutSeconds: 7,
        failureThreshold: 3,
      },
      {
        type: "Startup",
        path: "/health/liveliness",
        port: 4000,
        periodSeconds: 10,
        timeoutSeconds: 3,
        failureThreshold: 10,
      },
    ]) &&
    hasExactFinalRelayEnvironment(relay.env, runtimeClientId) &&
    hasExactFinalSidecarEnvironment(litellm.env)
  );
}

function hasExactFinalCleanupJob(change, images, runtimeClientId, relayOrigin) {
  if (
    !hasFinalNoUnknowns(change) ||
    hasUnknownValue(change.change.after_sensitive?.body) ||
    hasUnknownValue(change.change.after_sensitive?.identity)
  ) {
    return false;
  }

  const after = change.change.after;
  const body = after?.body;
  const properties = body?.properties;
  const configuration = properties?.configuration;
  const template = properties?.template;
  const identities = after?.identity;
  const identityIds = identities?.[0]?.identity_ids;
  const registry = configuration?.registries?.[0];
  const containers = template?.containers;
  const container = containers?.[0];

  return (
    isObject(after) &&
    hasExactKeys(after, [
      "body",
      "identity",
      "location",
      "name",
      "parent_id",
      "tags",
      "type",
    ]) &&
    after.type === "Microsoft.App/jobs@2026-01-01" &&
    after.name === FINAL_CLEANUP_JOB_NAME &&
    after.location === "eastus2" &&
    after.parent_id === FINAL_RESOURCE_GROUP_ID &&
    hasExactFinalTags(after.tags) &&
    !Object.hasOwn(after, "retry") &&
    !Object.hasOwn(after, "response_export_values") &&
    hasExactKeys(body, ["properties"]) &&
    hasExactKeys(properties, ["environmentId", "configuration", "template"]) &&
    properties.environmentId === FINAL_CONTAINER_ENVIRONMENT_ID &&
    hasExactKeys(configuration, [
      "triggerType",
      "scheduleTriggerConfig",
      "replicaRetryLimit",
      "replicaTimeout",
      "registries",
      "identitySettings",
    ]) &&
    configuration.triggerType === "Schedule" &&
    hasExactKeys(configuration.scheduleTriggerConfig, [
      "cronExpression",
      "replicaCompletionCount",
      "parallelism",
    ]) &&
    configuration.scheduleTriggerConfig.cronExpression === "0 3 * * *" &&
    configuration.scheduleTriggerConfig.replicaCompletionCount === 1 &&
    configuration.scheduleTriggerConfig.parallelism === 1 &&
    configuration.replicaRetryLimit === 0 &&
    configuration.replicaTimeout === 300 &&
    Array.isArray(identities) &&
    identities.length === 1 &&
    hasExactKeys(identities[0], ["type", "identity_ids"]) &&
    identities[0].type === "UserAssigned" &&
    Array.isArray(identityIds) &&
    identityIds.length === 2 &&
    identityIds[0] === FINAL_IMAGE_PULL_IDENTITY &&
    identityIds[1] === FINAL_RUNTIME_IDENTITY &&
    Array.isArray(configuration.registries) &&
    configuration.registries.length === 1 &&
    hasExactKeys(registry, ["server", "identity"]) &&
    registry.server === FINAL_ACR_LOGIN_SERVER &&
    registry.identity === FINAL_IMAGE_PULL_IDENTITY &&
    Array.isArray(configuration.identitySettings) &&
    configuration.identitySettings.length === 2 &&
    hasExactKeys(configuration.identitySettings[0], ["identity", "lifecycle"]) &&
    configuration.identitySettings[0].identity ===
      FINAL_IMAGE_PULL_IDENTITY.replace("resourceGroups", "resourcegroups") &&
    configuration.identitySettings[0].lifecycle === "None" &&
    hasExactKeys(configuration.identitySettings[1], ["identity", "lifecycle"]) &&
    configuration.identitySettings[1].identity ===
      FINAL_RUNTIME_IDENTITY.replace("resourceGroups", "resourcegroups") &&
    configuration.identitySettings[1].lifecycle === "Main" &&
    hasExactKeys(template, ["containers"]) &&
    Array.isArray(containers) &&
    containers.length === 1 &&
    hasExactKeys(container, ["name", "image", "resources", "env"]) &&
    container.name === "expiry-cleanup" &&
    container.image === images["palancar-expiry-cleanup"] &&
    hasExactKeys(container.resources, ["cpu", "memory"]) &&
    container.resources.cpu === 0.25 &&
    container.resources.memory === "0.5Gi" &&
    (() => {
      const entries = valuesByName(container.env);
      return (
        hasExactNamedEntries(entries, [
          "AZURE_CLIENT_ID",
          "PALANCAR_WORKLOAD_TABLE_ENDPOINT",
          "PALANCAR_SECURITY_STATE_TABLE",
          "PALANCAR_RATE_STATE_TABLE",
          "PALANCAR_RELAY_ENVIRONMENT",
          "PALANCAR_RELAY_ORIGIN",
          "PALANCAR_EXPIRY_CLEANUP_LIMIT",
          "PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS",
        ]) &&
        [...entries.values()].every((entry) =>
          hasExactKeys(entry, ["name", "value"]),
        ) &&
        hasEnvValue(entries, "AZURE_CLIENT_ID", runtimeClientId) &&
        hasEnvValue(entries, "PALANCAR_WORKLOAD_TABLE_ENDPOINT", FINAL_TABLE_ENDPOINT) &&
        hasEnvValue(entries, "PALANCAR_SECURITY_STATE_TABLE", "SecurityState") &&
        hasEnvValue(entries, "PALANCAR_RATE_STATE_TABLE", "RateState") &&
        hasEnvValue(entries, "PALANCAR_RELAY_ENVIRONMENT", "dev") &&
        (relayOrigin === undefined
          ? hasExactFinalRelayOrigin(
              entries.get("PALANCAR_RELAY_ORIGIN")?.value,
            )
          : hasEnvValue(entries, "PALANCAR_RELAY_ORIGIN", relayOrigin)) &&
        hasEnvValue(entries, "PALANCAR_EXPIRY_CLEANUP_LIMIT", "1000") &&
        hasEnvValue(entries, "PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS", "240000")
      );
    })()
  );
}

const FINAL_REFERENCE_CHANGES = new Map(
  FINAL_REFERENCE_PLAN.resource_changes.map((entry) => [entry.address, entry]),
);
const FINAL_INVENTORY = new Set(FINAL_REFERENCE_CHANGES.keys());
const FINAL_ROLE_DEFINITION_IDS = {
  acr: "7f951dda-4ed3-4680-a7ca-43fe172d538d",
  table: STORAGE_TABLE_DATA_CONTRIBUTOR_ROLE_ID,
  openai: "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd",
  monitoring: FINAL_ROLE_DEFINITION_MONITORING_ID,
  secretsUser: "4633458b-17de-408a-b874-0445c86b69e6",
  secretsOfficer: "b86a8fe4-44ce-4948-aee5-eccb2c155cd7",
};

function finalExactKeys(value, keys) {
  return isObject(value) && hasExactKeys(value, keys);
}

function finalUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  );
}

function finalIsEmptyObject(value) {
  return finalExactKeys(value, []);
}

function finalVariableValue(plan, name) {
  const descriptor = plan.variables?.[name];
  return finalExactKeys(descriptor, ["value"]) ? descriptor.value : undefined;
}

function finalHasExactVariables(plan) {
  if (
    !isObject(plan.variables) ||
    !hasExactKeys(plan.variables, Object.keys(FINAL_REFERENCE_PLAN.variables))
  ) {
    return false;
  }

  const dynamicVariables = new Set([
    "budget_contact_emails",
    "operator_principal_id",
    "relay_image_digest",
    "litellm_image_digest",
    "expiry_cleanup_image_digest",
  ]);
  for (const [name, expected] of Object.entries(FINAL_REFERENCE_PLAN.variables)) {
    const descriptor = plan.variables[name];
    if (!finalExactKeys(descriptor, ["value"])) {
      return false;
    }
    if (!dynamicVariables.has(name) && !isDeepStrictEqual(descriptor, expected)) {
      return false;
    }
  }

  const emails = finalVariableValue(plan, "budget_contact_emails");
  const operator = finalVariableValue(plan, "operator_principal_id");
  return (
    Array.isArray(emails) &&
    emails.length > 0 &&
    new Set(emails).size === emails.length &&
    isDeepStrictEqual(emails, emails.slice().sort()) &&
    emails.every(
      (email) =>
        typeof email === "string" &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    ) &&
    finalUuid(operator) &&
    operator !== "00000000-0000-0000-0000-000000000000" &&
    finalVariableValue(plan, "litellm_upstream_model") ===
      FINAL_GENERATION_MODEL &&
    exactFinalImageVariables(plan) !== undefined &&
    hasExactFinalFoundryDeploymentsVariable(plan)
  );
}

function finalRelevantAttributeKey(entry) {
  if (
    !finalExactKeys(entry, ["resource", "attribute"]) ||
    typeof entry.resource !== "string" ||
    !Array.isArray(entry.attribute) ||
    !entry.attribute.every((part) => typeof part === "string")
  ) {
    return undefined;
  }
  return JSON.stringify([entry.resource, entry.attribute]);
}

function finalHasExactRelevantAttributes(plan, transitionActions) {
  if (!Array.isArray(plan.relevant_attributes)) {
    return false;
  }
  const actual = plan.relevant_attributes.map(finalRelevantAttributeKey);
  const expected = FINAL_REFERENCE_PLAN.relevant_attributes
    .filter(
      (entry) =>
        transitionActions ||
        !(
          entry.resource === "azurerm_resource_group.foundation" &&
          isDeepStrictEqual(entry.attribute, ["id"])
        ),
    )
    .map(finalRelevantAttributeKey);
  return (
    actual.every((entry) => entry !== undefined) &&
    new Set(actual).size === actual.length &&
    actual.length === expected.length &&
    actual.slice().sort().every((entry, index) => entry === expected.sort()[index])
  );
}

function finalCollectValueResources(rootModule) {
  const resources = new Map();
  const moduleAddresses = new Set();
  let valid = true;

  function visit(module, expectedAddress, isRoot) {
    if (!isObject(module)) {
      valid = false;
      return;
    }
    const keys = [
      "resources",
      ...(isRoot ? [] : ["address"]),
      ...(Object.hasOwn(module, "child_modules") ? ["child_modules"] : []),
    ];
    if (!finalExactKeys(module, keys)) {
      valid = false;
      return;
    }
    if (!isRoot) {
      if (module.address !== expectedAddress || moduleAddresses.has(module.address)) {
        valid = false;
        return;
      }
      moduleAddresses.add(module.address);
    }
    if (!Array.isArray(module.resources)) {
      valid = false;
      return;
    }
    for (const resource of module.resources) {
      if (
        !isObject(resource) ||
        typeof resource.address !== "string" ||
        resources.has(resource.address) ||
        (!isRoot && !resource.address.startsWith(`${expectedAddress}.`)) ||
        (isRoot && resource.address.startsWith("module."))
      ) {
        valid = false;
        continue;
      }
      resources.set(resource.address, resource);
    }
    if (Object.hasOwn(module, "child_modules")) {
      if (!Array.isArray(module.child_modules)) {
        valid = false;
        return;
      }
      for (const child of module.child_modules) {
        visit(child, child?.address, false);
      }
    }
  }

  visit(rootModule, "", true);
  return valid ? resources : undefined;
}

function finalValueModuleStructure(rootModule) {
  const parents = new Map();
  const resourceModules = new Map();
  let valid = true;

  function visit(module, parentAddress, isRoot) {
    if (!isObject(module) || !Array.isArray(module.resources)) {
      valid = false;
      return;
    }
    const moduleAddress = isRoot ? "" : module.address;
    if (!isRoot) {
      if (
        typeof moduleAddress !== "string" ||
        parents.has(moduleAddress)
      ) {
        valid = false;
        return;
      }
      parents.set(moduleAddress, parentAddress);
    }
    for (const resource of module.resources) {
      if (
        !isObject(resource) ||
        typeof resource.address !== "string" ||
        resourceModules.has(resource.address)
      ) {
        valid = false;
        continue;
      }
      resourceModules.set(resource.address, moduleAddress);
    }
    for (const child of module.child_modules ?? []) {
      visit(child, moduleAddress, false);
    }
  }

  visit(rootModule, "", true);
  return valid ? { parents, resourceModules } : undefined;
}

function finalMapsEqual(actual, expected) {
  return (
    actual.size === expected.size &&
    [...expected].every(([key, value]) => actual.get(key) === value)
  );
}

function finalHasExactValueModuleHierarchies(plan, priorResources) {
  const planned = finalValueModuleStructure(plan.planned_values.root_module);
  const prior = finalValueModuleStructure(plan.prior_state.values.root_module);
  const referencePlanned = finalValueModuleStructure(
    FINAL_REFERENCE_PLAN.planned_values.root_module,
  );
  const referencePrior = finalValueModuleStructure(
    FINAL_REFERENCE_PLAN.prior_state.values.root_module,
  );
  if (!planned || !prior || !referencePlanned || !referencePrior) {
    return false;
  }
  if (!finalMapsEqual(planned.parents, referencePlanned.parents)) {
    return false;
  }

  const expectedPriorParents = new Map(referencePrior.parents);
  for (const address of priorResources.keys()) {
    let moduleAddress =
      referencePrior.resourceModules.get(address) ??
      referencePlanned.resourceModules.get(address);
    if (moduleAddress === undefined) {
      return false;
    }
    while (moduleAddress !== "") {
      const parentAddress = referencePlanned.parents.get(moduleAddress);
      if (parentAddress === undefined) {
        return false;
      }
      expectedPriorParents.set(moduleAddress, parentAddress);
      moduleAddress = parentAddress;
    }
  }
  return finalMapsEqual(prior.parents, expectedPriorParents);
}

function finalResourceEnvelopeMatches(resource, change, section, sensitive) {
  const reference =
    section === "planned"
      ? finalCollectValueResources(FINAL_REFERENCE_PLAN.planned_values.root_module)?.get(
          change.address,
        )
      : finalCollectValueResources(
          FINAL_REFERENCE_PLAN.prior_state.values.root_module,
        )?.get(change.address) ??
        finalCollectValueResources(
          FINAL_REFERENCE_PLAN.planned_values.root_module,
        )?.get(change.address);
  if (!reference) {
    return false;
  }

  const allowedKeys = new Set([
    "address",
    "mode",
    "type",
    "name",
    ...(Object.hasOwn(reference, "index") ? ["index"] : []),
    "provider_name",
    "schema_version",
    "values",
    "sensitive_values",
    ...(section === "prior" && Object.hasOwn(resource, "depends_on")
      ? ["depends_on"]
      : []),
    ...(Object.hasOwn(change.change, `${section === "prior" ? "before" : "after"}_identity`)
      ? ["identity_schema_version", "identity"]
      : []),
  ]);
  if (!finalExactKeys(resource, [...allowedKeys])) {
    return false;
  }
  for (const key of ["address", "mode", "type", "name", "provider_name", "schema_version"]) {
    if (!isDeepStrictEqual(resource[key], reference[key])) {
      return false;
    }
  }
  if (
    Object.hasOwn(reference, "index") &&
    !isDeepStrictEqual(resource.index, reference.index)
  ) {
    return false;
  }
  if (
    Object.hasOwn(resource, "depends_on") &&
    (!Array.isArray(resource.depends_on) ||
      !resource.depends_on.every((entry) => typeof entry === "string"))
  ) {
    return false;
  }
  return (
    isDeepStrictEqual(resource.values, sensitive.values) &&
    isDeepStrictEqual(resource.sensitive_values, sensitive.map) &&
    (!Object.hasOwn(resource, "identity") ||
      (resource.identity_schema_version === 0 &&
        isDeepStrictEqual(resource.identity, sensitive.identity)))
  );
}

function finalRoleDefinitionId(uuid) {
  return `/subscriptions/${FINAL_SUBSCRIPTION_ID}/providers/Microsoft.Authorization/roleDefinitions/${uuid}`;
}

function finalRoleId(scope, name) {
  return `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`;
}

function finalExpectedRole(address, context) {
  const acrScope = `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.ContainerRegistry/registries/palancardevacraeeacd8c`;
  const storageScope = `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.Storage/storageAccounts/${FINAL_TABLE_ACCOUNT}`;
  const keyVaultScope = `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.KeyVault/vaults/kvpalancardevaeeacd8c`;
  const foundryScope = FOUNDRY_COGNITIVE_ACCOUNT_ID;
  const tableScope = (name) => `${FINAL_TABLE_SERVICE_ID}/tables/${name}`;
  const definitions = Object.fromEntries(
    Object.entries(FINAL_ROLE_DEFINITION_IDS).map(([key, value]) => [
      key,
      finalRoleDefinitionId(value),
    ]),
  );

  const contracts = {
    "module.identities_rbac.azurerm_role_assignment.image_pull_acr": {
      scope: acrScope,
      role: definitions.acr,
      roleName: "AcrPull",
      principal: context.imagePullPrincipal,
      principalType: "ServicePrincipal",
      nameInput: `${acrScope}/image-pull/${definitions.acr}`,
    },
    "module.identities_rbac.azurerm_role_assignment.runtime_table": {
      scope: storageScope,
      role: definitions.table,
      roleName: "Storage Table Data Contributor",
      principal: context.runtimePrincipal,
      principalType: "ServicePrincipal",
      nameInput: `${storageScope}/runtime/${definitions.table}`,
    },
    "module.identities_rbac.azurerm_role_assignment.runtime_openai": {
      scope: foundryScope,
      role: definitions.openai,
      roleName: "Cognitive Services OpenAI User",
      principal: context.runtimePrincipal,
      principalType: "ServicePrincipal",
      nameInput: `${foundryScope}/runtime/${definitions.openai}`,
    },
    [FINAL_MONITORING_ROLE_ASSIGNMENT]: {
      scope: FINAL_APPLICATION_INSIGHTS_ID,
      role: definitions.monitoring,
      roleName: "Monitoring Metrics Publisher",
      principal: context.runtimePrincipal,
      principalType: "ServicePrincipal",
      nameInput: `scope=${FINAL_APPLICATION_INSIGHTS_ID}|principal_id=${context.runtimePrincipal}|role_definition_id=${definitions.monitoring}`,
    },
    "module.identities_rbac.azurerm_role_assignment.operator_security_table": {
      scope: tableScope("SecurityState"),
      role: definitions.table,
      roleName: "Storage Table Data Contributor",
      principal: context.operatorPrincipal,
      principalType: "User",
      nameInput: `${tableScope("SecurityState")}/operator/${context.operatorPrincipal}/${definitions.table}`,
    },
    "module.identities_rbac.azurerm_role_assignment.operator_rate_table": {
      scope: tableScope("RateState"),
      role: definitions.table,
      roleName: "Storage Table Data Contributor",
      principal: context.operatorPrincipal,
      principalType: "User",
      nameInput: `${tableScope("RateState")}/operator/${context.operatorPrincipal}/${definitions.table}`,
    },
    "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user": {
      scope: keyVaultScope,
      role: definitions.secretsUser,
      roleName: "Key Vault Secrets User",
      principal: context.runtimePrincipal,
      principalType: "ServicePrincipal",
      nameInput: `${keyVaultScope}/runtime/${context.runtimePrincipal}/${definitions.secretsUser}`,
    },
    "module.workload_key_vault.azurerm_role_assignment.terraform_cli_secrets_officer": {
      scope: keyVaultScope,
      role: definitions.secretsOfficer,
      roleName: "Key Vault Secrets Officer",
      principal: context.cliPrincipal,
      principalType: "User",
      nameInput: `${keyVaultScope}/terraform-cli/${context.cliPrincipal}/${definitions.secretsOfficer}`,
    },
  };
  return contracts[address];
}

function finalHasExactRoleChange(resourceChange, context) {
  const contract = finalExpectedRole(resourceChange.address, context);
  if (!contract) {
    return false;
  }
  const after = resourceChange.change.after;
  const name = after?.name;
  const expectedName = uuidV5Url(contract.nameInput);
  if (!finalUuid(name) || name !== expectedName) {
    return false;
  }
  const common = {
    name,
    principal_id: contract.principal,
    principal_type: contract.principalType,
    role_definition_id: contract.role,
    scope: contract.scope,
  };
  if (!Object.entries(common).every(([key, value]) => after?.[key] === value)) {
    return false;
  }

  if (isCreate(resourceChange.change.actions)) {
    return (
      finalExactKeys(after, [
        "condition",
        "delegated_managed_identity_resource_id",
        "description",
        "name",
        "principal_id",
        "principal_type",
        "role_definition_id",
        "scope",
        "timeouts",
      ]) &&
      after.condition === null &&
      after.delegated_managed_identity_resource_id === null &&
      after.description === null &&
      after.timeouts === null
    );
  }

  return (
    finalExactKeys(after, [
      "condition",
      "condition_version",
      "delegated_managed_identity_resource_id",
      "description",
      "id",
      "name",
      "principal_id",
      "principal_type",
      "role_definition_id",
      "role_definition_name",
      "scope",
      "skip_service_principal_aad_check",
      "timeouts",
    ]) &&
    after.condition === "" &&
    after.condition_version === "" &&
    after.delegated_managed_identity_resource_id === "" &&
    after.description === "" &&
    after.id === finalRoleId(contract.scope, name) &&
    after.role_definition_name === contract.roleName &&
    after.skip_service_principal_aad_check === null &&
    after.timeouts === null
  );
}

function finalAzapiIdentity(after, action) {
  if (!Array.isArray(after?.identity) || after.identity.length !== 1) {
    return false;
  }
  const identity = after.identity[0];
  const expectedKeys = isCreate(action)
    ? ["identity_ids", "type"]
    : ["identity_ids", "principal_id", "tenant_id", "type"];
  return (
    finalExactKeys(identity, expectedKeys) &&
    identity.type === "UserAssigned" &&
    isDeepStrictEqual(identity.identity_ids, [
      FINAL_IMAGE_PULL_IDENTITY,
      FINAL_RUNTIME_IDENTITY,
    ]) &&
    (isCreate(action) ||
      (identity.principal_id === "" && identity.tenant_id === ""))
  );
}

function finalHasExactContainerAppProviderOutput(
  output,
  defaultDomain,
  appName = FINAL_CONTAINER_APP_NAME,
) {
  if (
    !isObject(output) ||
    !finalExactKeys(output, ["properties"]) ||
    !isObject(output.properties) ||
    typeof appName !== "string"
  ) {
    return false;
  }
  const properties = output.properties;
  return (
    finalExactKeys(properties, [
      "configuration",
      "latestRevisionName",
      "runningStatus",
    ]) &&
    finalExactKeys(properties.configuration, ["ingress"]) &&
    finalExactKeys(properties.configuration.ingress, ["fqdn"]) &&
    properties.configuration.ingress.fqdn ===
      `${appName}.${defaultDomain}` &&
    typeof properties.latestRevisionName === "string" &&
    FINAL_PRIOR_RELAY_REVISION_NAME.test(properties.latestRevisionName) &&
    properties.runningStatus === "Running"
  );
}

function finalHasExactJobProviderOutput(output, after, context) {
  const referenceOutput =
    FINAL_REFERENCE_CHANGES.get(EXPIRY_CLEANUP_JOB).change.after.output;
  if (
    !isObject(output) ||
    !finalExactKeys(output, Object.keys(referenceOutput)) ||
    output.id !== after.id ||
    output.type !== referenceOutput.type ||
    !hasExactFinalTags(output.tags)
  ) {
    return false;
  }

  const referenceProperties = referenceOutput.properties;
  const properties = output.properties;
  const outboundIpAddresses = properties?.outboundIpAddresses;
  if (
    !finalExactKeys(properties, Object.keys(referenceProperties)) ||
    properties.provisioningState !== referenceProperties.provisioningState ||
    !Array.isArray(outboundIpAddresses) ||
    outboundIpAddresses.length === 0 ||
    new Set(outboundIpAddresses).size !== outboundIpAddresses.length ||
    !outboundIpAddresses.every((value) => isIP(value) === 4)
  ) {
    return false;
  }

  const referenceEventStreamEndpoint =
    referenceProperties.eventStreamEndpoint;
  let eventStreamUrl;
  try {
    eventStreamUrl = new URL(referenceEventStreamEndpoint);
  } catch {
    return false;
  }
  const expectedEventStreamEndpoint =
    `${eventStreamUrl.origin}/subscriptions/${FINAL_SUBSCRIPTION_ID}/resourceGroups/${FINAL_RESOURCE_GROUP_NAME}/containerApps/${after.name}/eventstream`;
  if (properties.eventStreamEndpoint !== expectedEventStreamEndpoint) {
    return false;
  }

  if (
    !isDeepStrictEqual(properties.configuration, referenceProperties.configuration) ||
    !isDeepStrictEqual(properties.template, referenceProperties.template)
  ) {
    return false;
  }

  if (!finalExactKeys(output.identity, ["userAssignedIdentities"])) {
    return false;
  }
  const identities = output.identity.userAssignedIdentities;
  const expectedIdentityIds = after.identity?.[0]?.identity_ids?.map((id) =>
    id.replace("resourceGroups", "resourcegroups"),
  );
  if (
    !Array.isArray(expectedIdentityIds) ||
    expectedIdentityIds.length !== 2 ||
    !isObject(identities) ||
    !hasExactKeys(identities, expectedIdentityIds)
  ) {
    return false;
  }

  const expectedIdentityValues = new Map([
    [
      expectedIdentityIds[0],
      {
        clientId: context.imagePullClient,
        principalId: context.imagePullPrincipal,
      },
    ],
    [
      expectedIdentityIds[1],
      {
        clientId: context.runtimeClient,
        principalId: context.runtimePrincipal,
      },
    ],
  ]);
  return expectedIdentityIds.every(
    (id) =>
      finalExactKeys(identities[id], ["clientId", "principalId"]) &&
      isDeepStrictEqual(identities[id], expectedIdentityValues.get(id)),
  );
}

function finalAzapiProviderEnvelope(
  after,
  kind,
  action,
  defaultDomain,
  context,
) {
  const referenceChange = FINAL_REFERENCE_CHANGES.get(
    kind === "app" ? CONTAINER_APP : EXPIRY_CLEANUP_JOB,
  );
  const referenceAfter = referenceChange.change.after;
  const keys = Object.keys(referenceAfter).filter(
    (key) => !(isCreate(action) && key === "id"),
  );
  if (!isCreate(action) && !keys.includes("id")) {
    keys.push("id");
  }
  if (isNoOp(action) && !keys.includes("output")) {
    keys.push("output");
  }
  if (!isNoOp(action)) {
    const outputIndex = keys.indexOf("output");
    if (outputIndex !== -1) {
      keys.splice(outputIndex, 1);
    }
  }
  if (!finalExactKeys(after, keys)) {
    return false;
  }

  for (const key of Object.keys(referenceAfter)) {
    if (["body", "id", "identity", "output"].includes(key)) {
      continue;
    }
    if (!isDeepStrictEqual(after[key], referenceAfter[key])) {
      return false;
    }
  }
  const expectedId =
    kind === "app"
      ? `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.App/containerApps/${FINAL_CONTAINER_APP_NAME}`
      : `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.App/jobs/${FINAL_CLEANUP_JOB_NAME}`;
  if (!isCreate(action) && after.id !== expectedId) {
    return false;
  }
  if (!finalAzapiIdentity(after, action)) {
    return false;
  }
  if (isNoOp(action)) {
    if (kind === "app") {
      if (
        !finalHasExactContainerAppProviderOutput(
          after.output,
          defaultDomain,
        )
      ) {
        return false;
      }
    } else if (!finalHasExactJobProviderOutput(after.output, after, context)) {
      return false;
    }
  }
  return true;
}

function finalRecursiveDifferencePaths(before, after, path = "") {
  if (isDeepStrictEqual(before, after)) {
    return [];
  }
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].sort().flatMap((key) => {
      const childPath = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) {
        return [childPath];
      }
      return finalRecursiveDifferencePaths(before[key], after[key], childPath);
    });
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    return [...Array(length).keys()].flatMap((index) => {
      const childPath = `${path}[${index}]`;
      if (index >= before.length || index >= after.length) {
        return [childPath];
      }
      return finalRecursiveDifferencePaths(before[index], after[index], childPath);
    });
  }
  return [path];
}

function finalHasExactTransitionContainerAppPrior(
  resourceChange,
  images,
  defaultDomain,
  plan,
) {
  if (!isUpdate(resourceChange.change.actions)) {
    return true;
  }
  const before = resourceChange.change.before;
  const after = resourceChange.change.after;
  const referenceChange = FINAL_REFERENCE_CHANGES.get(CONTAINER_APP)?.change;
  const priorResource = finalCollectValueResources(
    plan.prior_state?.values?.root_module,
  )?.get(CONTAINER_APP);
  const expectedDifferences = [
    "body.properties.template.containers[0].image",
    "output",
  ];
  const expectedSensitivityDifferences = ["output"];
  if (
    !isObject(before) ||
    !isObject(after) ||
    !referenceChange ||
    !priorResource ||
    !isDeepStrictEqual(
      finalRecursiveDifferencePaths(before, after),
      expectedDifferences,
    ) ||
    !isDeepStrictEqual(
      resourceChange.change.before_sensitive,
      referenceChange.before_sensitive,
    ) ||
    !isDeepStrictEqual(
      resourceChange.change.after_sensitive,
      referenceChange.after_sensitive,
    ) ||
    !isDeepStrictEqual(
      priorResource.sensitive_values,
      referenceChange.before_sensitive,
    ) ||
    !isDeepStrictEqual(
      finalRecursiveDifferencePaths(
        resourceChange.change.before_sensitive,
        resourceChange.change.after_sensitive,
      ),
      expectedSensitivityDifferences,
    )
  ) {
    return false;
  }

  const beforeContainers = before.body?.properties?.template?.containers;
  const afterContainers = after.body?.properties?.template?.containers;
  if (
    !Array.isArray(beforeContainers) ||
    !Array.isArray(afterContainers) ||
    beforeContainers.length !== 2 ||
    afterContainers.length !== 2
  ) {
    return false;
  }

  const beforeRelay = beforeContainers[0];
  const afterRelay = afterContainers[0];
  const beforeLiteLLM = beforeContainers[1];
  const afterLiteLLM = afterContainers[1];
  const priorRevision =
    plan.prior_state?.values?.outputs?.relay_latest_revision_name?.value;
  const revisionChange = plan.output_changes?.relay_latest_revision_name;
  return (
    finalHasExactContainerAppProviderOutput(
      before.output,
      defaultDomain,
    ) &&
    FINAL_PRIOR_RELAY_REVISION_NAME.test(priorRevision) &&
    before.output.properties.latestRevisionName === priorRevision &&
    revisionChange?.before === priorRevision &&
    beforeRelay?.name === "relay" &&
    afterRelay?.name === "relay" &&
    beforeLiteLLM?.name === "litellm" &&
    afterLiteLLM?.name === "litellm" &&
    beforeRelay.image === FINAL_RELAY_PRIOR_IMAGE &&
    afterRelay.image === images["palancar-relay"] &&
    afterRelay.image !== FINAL_RELAY_PRIOR_IMAGE &&
    hasExactKeys(beforeRelay?.resources, ["cpu", "memory"]) &&
    hasExactKeys(afterRelay?.resources, ["cpu", "memory"]) &&
    beforeRelay.resources.cpu === 0.25 &&
    beforeRelay.resources.memory === "0.5Gi" &&
    afterRelay.resources.cpu === 0.25 &&
    afterRelay.resources.memory === "0.5Gi" &&
    hasExactKeys(beforeLiteLLM?.resources, ["cpu", "memory"]) &&
    hasExactKeys(afterLiteLLM?.resources, ["cpu", "memory"]) &&
    beforeLiteLLM.resources.cpu === 0.75 &&
    beforeLiteLLM.resources.memory === "1.5Gi" &&
    afterLiteLLM.resources.cpu === 0.75 &&
    afterLiteLLM.resources.memory === "1.5Gi"
  );
}

function finalNormalizedAppContractChange(resourceChange) {
  const after = resourceChange.change.after;
  return {
    change: {
      after: {
        body: after.body,
        identity: [
          {
            type: after.identity[0].type,
            identity_ids: after.identity[0].identity_ids,
          },
        ],
        location: after.location,
        name: after.name,
        parent_id: after.parent_id,
        response_export_values: after.response_export_values,
        retry: {
          error_message_regex: after.retry.error_message_regex,
          interval_seconds: after.retry.interval_seconds,
          max_interval_seconds: after.retry.max_interval_seconds,
        },
        tags: after.tags,
        type: after.type,
      },
      after_unknown: {},
      after_sensitive: {},
    },
  };
}

function finalNormalizedJobContractChange(resourceChange) {
  const after = resourceChange.change.after;
  return {
    change: {
      after: {
        body: after.body,
        identity: [
          {
            type: after.identity[0].type,
            identity_ids: after.identity[0].identity_ids,
          },
        ],
        location: after.location,
        name: after.name,
        parent_id: after.parent_id,
        tags: after.tags,
        type: after.type,
      },
      after_unknown: {},
      after_sensitive: {},
    },
  };
}

function finalApplicationInsightsConnection(fullConnection) {
  if (typeof fullConnection !== "string") {
    return undefined;
  }
  const values = new Map();
  for (const segment of fullConnection.split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0 || separator === segment.length - 1) {
      return undefined;
    }
    const key = segment.slice(0, separator);
    if (values.has(key)) {
      return undefined;
    }
    values.set(key, segment.slice(separator + 1));
  }
  if (
    !isDeepStrictEqual([...values.keys()], [
      "InstrumentationKey",
      "IngestionEndpoint",
      "LiveEndpoint",
      "ApplicationId",
    ])
  ) {
    return undefined;
  }
  const instrumentationKey = values.get("InstrumentationKey")?.toLowerCase();
  const ingestionEndpoint = values.get("IngestionEndpoint");
  const liveEndpoint = values.get("LiveEndpoint");
  const applicationId = values.get("ApplicationId")?.toLowerCase();
  if (
    !finalUuid(instrumentationKey) ||
    !finalUuid(applicationId) ||
    ingestionEndpoint !== FINAL_APPLICATION_INSIGHTS_INGESTION_ENDPOINT ||
    liveEndpoint !== FINAL_APPLICATION_INSIGHTS_LIVE_ENDPOINT
  ) {
    return undefined;
  }
  return {
    applicationId,
    instrumentationKey,
    liveEndpoint,
    relay: `InstrumentationKey=${instrumentationKey};IngestionEndpoint=${ingestionEndpoint.replace(/\/$/, "")}`,
  };
}

function finalAlertId(name) {
  return `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.Insights/scheduledQueryRules/${name}`;
}

function finalHasExactActionGroup(resourceChange, contacts) {
  const after = resourceChange?.change?.after;
  const noOp = isNoOp(resourceChange?.change?.actions);
  const receiverKeys = [
    "arm_role_receiver",
    "automation_runbook_receiver",
    "azure_app_push_receiver",
    "azure_function_receiver",
    "event_hub_receiver",
    "itsm_receiver",
    "logic_app_receiver",
    "sms_receiver",
    "voice_receiver",
    "webhook_receiver",
  ];
  const expectedKeys = [
    ...receiverKeys,
    "email_receiver",
    "enabled",
    ...(noOp ? ["id"] : []),
    "location",
    "name",
    "resource_group_name",
    "short_name",
    "tags",
    "timeouts",
  ];
  const receivers = after?.email_receiver;
  return (
    finalExactKeys(after, expectedKeys) &&
    receiverKeys.every(
      (key) => Array.isArray(after[key]) && after[key].length === 0,
    ) &&
    Array.isArray(receivers) &&
    receivers.length === contacts.length &&
    receivers.every(
      (receiver, index) =>
        finalExactKeys(receiver, [
          "email_address",
          "name",
          "use_common_alert_schema",
        ]) &&
        receiver.email_address === contacts[index] &&
        receiver.name === `budget-contact-${String(index + 1).padStart(4, "0")}` &&
        receiver.use_common_alert_schema === true,
    ) &&
    after.enabled === true &&
    (!noOp || after.id === FINAL_ACTION_GROUP_ID) &&
    after.location === "global" &&
    after.name === FINAL_ACTION_GROUP_NAME &&
    after.resource_group_name === FINAL_RESOURCE_GROUP_NAME &&
    after.short_name === "r-aeeacd8c" &&
    hasExactFinalTags(after.tags) &&
    after.timeouts === null
  );
}

function finalHasExactAlert(resourceChange) {
  const key = resourceChange?.index;
  const contract = FINAL_ALERT_CONTRACTS.get(key);
  const after = resourceChange?.change?.after;
  const referenceAfter = FINAL_REFERENCE_CHANGES.get(resourceChange.address)?.change
    ?.after;
  const noOp = isNoOp(resourceChange?.change?.actions);
  if (!contract || !referenceAfter) {
    return false;
  }
  const expectedName = `${FINAL_APPLICATION_INSIGHTS_NAME}-${key.replaceAll("_", "-")}`;
  const action = after?.action?.[0];
  const criteria = after?.criteria?.[0];
  const periods = criteria?.failing_periods?.[0];
  return (
    finalExactKeys(after, [
      "action",
      "auto_mitigation_enabled",
      ...(noOp
        ? [
            "created_with_api_version",
            "id",
            "is_a_legacy_log_analytics_rule",
            "is_workspace_alerts_storage_configured",
          ]
        : []),
      "criteria",
      "description",
      "display_name",
      "enabled",
      "evaluation_frequency",
      "identity",
      "location",
      "mute_actions_after_alert_duration",
      "name",
      "query_time_range_override",
      "resource_group_name",
      "scopes",
      "severity",
      "skip_query_validation",
      "tags",
      "target_resource_types",
      "timeouts",
      "window_duration",
      "workspace_alerts_storage_enabled",
    ]) &&
    Array.isArray(after.action) &&
    after.action.length === 1 &&
    finalExactKeys(action, [
      "action_groups",
      "custom_properties",
      "email_subject",
    ]) &&
    isDeepStrictEqual(action.action_groups, [FINAL_ACTION_GROUP_ID]) &&
    finalExactKeys(action.custom_properties, ["service", "signal"]) &&
    action.custom_properties.service === "relay" &&
    action.custom_properties.signal === key &&
    action.email_subject === referenceAfter.action[0].email_subject &&
    after.auto_mitigation_enabled === true &&
    Array.isArray(after.criteria) &&
    after.criteria.length === 1 &&
    finalExactKeys(criteria, [
      "dimension",
      "failing_periods",
      "metric_measure_column",
      "operator",
      "query",
      "resource_id_column",
      "threshold",
      "time_aggregation_method",
    ]) &&
    Array.isArray(criteria.dimension) &&
    criteria.dimension.length === 0 &&
    Array.isArray(criteria.failing_periods) &&
    criteria.failing_periods.length === 1 &&
    finalExactKeys(periods, [
      "minimum_failing_periods_to_trigger_alert",
      "number_of_evaluation_periods",
    ]) &&
    periods.minimum_failing_periods_to_trigger_alert === 1 &&
    periods.number_of_evaluation_periods === 1 &&
    criteria.metric_measure_column === "SignalValue" &&
    criteria.operator === "GreaterThanOrEqual" &&
    criteria.query === contract.query &&
    criteria.resource_id_column === referenceAfter.criteria[0].resource_id_column &&
    criteria.threshold === contract.threshold &&
    criteria.time_aggregation_method === contract.aggregation &&
    after.description === contract.description &&
    after.display_name === contract.displayName &&
    after.enabled === true &&
    after.evaluation_frequency === "PT5M" &&
    Array.isArray(after.identity) &&
    after.identity.length === 0 &&
    after.location === "eastus2" &&
    after.mute_actions_after_alert_duration ===
      referenceAfter.mute_actions_after_alert_duration &&
    after.name === expectedName &&
    after.query_time_range_override === referenceAfter.query_time_range_override &&
    after.resource_group_name === FINAL_RESOURCE_GROUP_NAME &&
    isDeepStrictEqual(after.scopes, [FINAL_WORKSPACE_ID]) &&
    after.severity === contract.severity &&
    after.skip_query_validation === false &&
    hasExactFinalTags(after.tags) &&
    isDeepStrictEqual(after.target_resource_types, []) &&
    after.timeouts === null &&
    after.window_duration === "PT15M" &&
    after.workspace_alerts_storage_enabled === false &&
    (!noOp ||
      (after.created_with_api_version === referenceAfter.created_with_api_version &&
        after.id === finalAlertId(expectedName) &&
        after.is_a_legacy_log_analytics_rule === false &&
        after.is_workspace_alerts_storage_configured === false))
  );
}

function finalHasExactAlertInventory(plan, changesByAddress) {
  const contacts = finalVariableValue(plan, "budget_contact_emails");
  const actionGroup = changesByAddress.get(FINAL_ACTION_GROUP_ADDRESS);
  const budget = changesByAddress.get(
    "module.budget.azurerm_consumption_budget_resource_group.this",
  )?.change.after;
  const notifications = budget?.notification;
  const configuredActionGroups =
    plan.configuration?.root_module?.module_calls?.observability?.expressions
      ?.alert_action_group_ids;
  const referenceConfiguredActionGroups =
    FINAL_REFERENCE_PLAN.configuration.root_module.module_calls.observability
      .expressions.alert_action_group_ids;
  if (
    !Array.isArray(contacts) ||
    !finalHasExactActionGroup(actionGroup, contacts) ||
    !Array.isArray(notifications) ||
    notifications.length !== 4 ||
    notifications.some(
      (notification) =>
        !isDeepStrictEqual(notification.contact_emails, contacts),
    ) ||
    !isDeepStrictEqual(configuredActionGroups, referenceConfiguredActionGroups) ||
    plan.planned_values?.outputs?.relay_action_group_id?.value !==
      FINAL_ACTION_GROUP_ID ||
    plan.output_changes?.relay_action_group_id?.after !== FINAL_ACTION_GROUP_ID
  ) {
    return false;
  }

  for (const address of FINAL_ALERT_ADDRESSES) {
    if (!finalHasExactAlert(changesByAddress.get(address))) {
      return false;
    }
  }

  const alertOutput = plan.planned_values?.outputs?.relay_alert_rule_ids;
  if (Object.hasOwn(alertOutput ?? {}, "value")) {
    const expectedIds = Object.fromEntries(
      [...FINAL_ALERT_CONTRACTS.keys()].map((key) => {
        const name = `${FINAL_APPLICATION_INSIGHTS_NAME}-${key.replaceAll("_", "-")}`;
        return [key, finalAlertId(name)];
      }),
    );
    if (!isDeepStrictEqual(alertOutput.value, expectedIds)) {
      return false;
    }
  }
  return true;
}

function finalCriticalBindings(plan, changesByAddress) {
  const appInsights = changesByAddress.get(
    "module.observability.azurerm_application_insights.this",
  )?.change.after;
  const environment = changesByAddress.get(
    "module.container_app_environment.azurerm_container_app_environment.this",
  )?.change.after;
  const app = changesByAddress.get(CONTAINER_APP)?.change.after;
  const job = changesByAddress.get(EXPIRY_CLEANUP_JOB)?.change.after;
  const fullConnection =
    plan.planned_values?.outputs?.application_insights_connection_string?.value;
  const defaultDomain =
    plan.planned_values?.outputs?.container_app_environment_default_domain?.value;
  const relayOrigin = plan.planned_values?.outputs?.relay_origin?.value;
  const connection = finalApplicationInsightsConnection(fullConnection);
  const appContainers = app?.body?.properties?.template?.containers;
  const relay = Array.isArray(appContainers) ? appContainers[0] : undefined;
  const relayEnv = valuesByName(relay?.env);
  const jobEnv = valuesByName(
    job?.body?.properties?.template?.containers?.[0]?.env,
  );
  return (
    appInsights?.id === FINAL_APPLICATION_INSIGHTS_ID &&
    appInsights?.name === FINAL_APPLICATION_INSIGHTS_NAME &&
    appInsights?.resource_group_name === FINAL_RESOURCE_GROUP_NAME &&
    appInsights?.location === "eastus2" &&
    connection?.instrumentationKey ===
      appInsights?.instrumentation_key?.toLowerCase() &&
    connection?.applicationId === appInsights?.app_id?.toLowerCase() &&
    connection?.liveEndpoint === FINAL_APPLICATION_INSIGHTS_LIVE_ENDPOINT &&
    environment?.id === FINAL_CONTAINER_ENVIRONMENT_ID &&
    environment?.name === FINAL_CONTAINER_ENVIRONMENT_NAME &&
    environment?.resource_group_name === FINAL_RESOURCE_GROUP_NAME &&
    environment?.location === "eastus2" &&
    defaultDomain === FINAL_CONTAINER_ENVIRONMENT_DEFAULT_DOMAIN &&
    defaultDomain === environment?.default_domain &&
    fullConnection === appInsights?.connection_string &&
    connection?.relay ===
      relayEnv?.get("APPLICATIONINSIGHTS_CONNECTION_STRING")?.value &&
    relayOrigin === FINAL_RELAY_ORIGIN &&
    relayEnv?.get("PALANCAR_RELAY_ORIGIN")?.value === FINAL_RELAY_ORIGIN &&
    jobEnv?.get("PALANCAR_RELAY_ORIGIN")?.value === FINAL_RELAY_ORIGIN &&
    plan.output_changes?.application_insights_connection_string?.after ===
      fullConnection &&
    plan.output_changes?.container_app_environment_default_domain?.after ===
      defaultDomain &&
    plan.output_changes?.relay_origin?.after === relayOrigin
  );
}

function finalHasExactTopology(plan, changesByAddress, context, images) {
  const deployment = changesByAddress.get(MODEL_SPIKE_DEPLOYMENT);
  const app = changesByAddress.get(CONTAINER_APP);
  const job = changesByAddress.get(EXPIRY_CLEANUP_JOB);
  const deploymentReference = FINAL_REFERENCE_CHANGES.get(
    MODEL_SPIKE_DEPLOYMENT,
  ).change.after;
  const defaultDomain =
    plan.planned_values?.outputs?.container_app_environment_default_domain?.value;
  if (
    !isNoOp(deployment.change.actions) ||
    !isDeepStrictEqual(deployment.change.after, deploymentReference)
  ) {
    return false;
  }

  const appProvider = finalAzapiProviderEnvelope(
    app.change.after,
    "app",
    app.change.actions,
    defaultDomain,
    context,
  );
  const appContract = hasExactFinalContainerApp(
    finalNormalizedAppContractChange(app),
    images,
    context.runtimeClient,
  );
  const appPriorContract = finalHasExactTransitionContainerAppPrior(
    app,
    images,
    defaultDomain,
    plan,
  );
  const jobProvider = finalAzapiProviderEnvelope(
    job.change.after,
    "job",
    job.change.actions,
    defaultDomain,
    context,
  );
  const jobContract = hasExactFinalCleanupJob(
    finalNormalizedJobContractChange(job),
    images,
    context.runtimeClient,
    plan.planned_values.outputs.relay_origin.value,
  );
  const criticalBindings = finalCriticalBindings(plan, changesByAddress);
  if (
    !appProvider ||
    !appContract ||
    !appPriorContract ||
    !jobProvider ||
    !jobContract
  ) {
    return false;
  }

  const appContainers = app.change.after.body.properties.template.containers;
  return (
    appContainers[0].name === "relay" &&
    appContainers[1].name === "litellm" &&
    appContainers[1].env[1]?.name === "PALANCAR_LITELLM_UPSTREAM_MODEL" &&
    appContainers[1].env[1]?.value === FINAL_GENERATION_MODEL &&
    criticalBindings
  );
}

function finalExpectedAfterUnknown(resourceChange) {
  const action = resourceChange.change.actions;
  const reference = FINAL_REFERENCE_CHANGES.get(resourceChange.address);
  if (isNoOp(action)) {
    return {};
  }
  if (isUpdate(action)) {
    return reference.change.after_unknown;
  }
  if (resourceChange.address === EXPIRY_CLEANUP_JOB) {
    return reference.change.after_unknown;
  }
  if (
    resourceChange.address === FINAL_ACTION_GROUP_ADDRESS
  ) {
    const expected = structuredClone(reference.change.after_unknown);
    expected.email_receiver = resourceChange.change.after.email_receiver.map(
      () => ({}),
    );
    return expected;
  }
  if (FINAL_ALERT_ADDRESSES.has(resourceChange.address)) {
    return reference.change.after_unknown;
  }
  if (FINAL_ROLE_ASSIGNMENT_ADDRESSES.has(resourceChange.address)) {
    return FINAL_REFERENCE_CHANGES.get(
      FINAL_MONITORING_ROLE_ASSIGNMENT,
    ).change.after_unknown;
  }
  if (resourceChange.address === CONTAINER_APP) {
    const expected = structuredClone(reference.change.after_unknown);
    expected.id = true;
    expected.identity[0].principal_id = true;
    expected.identity[0].tenant_id = true;
    return expected;
  }
  return undefined;
}

function finalExpectedAfterSensitive(resourceChange) {
  const reference = FINAL_REFERENCE_CHANGES.get(resourceChange.address).change;
  const expected = structuredClone(
    isNoOp(resourceChange.change.actions)
      ? reference.before_sensitive
      : reference.after_sensitive,
  );
  if (resourceChange.address === FINAL_ACTION_GROUP_ADDRESS) {
    expected.email_receiver = resourceChange.change.after.email_receiver.map(
      () => ({}),
    );
  }
  return expected;
}

function finalExpectedBeforeSensitive(resourceChange) {
  const reference = FINAL_REFERENCE_CHANGES.get(resourceChange.address).change;
  const expected = structuredClone(reference.before_sensitive);
  if (resourceChange.address === FINAL_ACTION_GROUP_ADDRESS) {
    expected.email_receiver = resourceChange.change.after.email_receiver.map(
      () => ({}),
    );
  }
  return expected;
}

function finalChangeEnvelopeKeys(resourceChange) {
  const keys = [
    "actions",
    "before",
    "after",
    "after_unknown",
    "before_sensitive",
    "after_sensitive",
  ];
  const action = resourceChange.change.actions;
  const reference = FINAL_REFERENCE_CHANGES.get(resourceChange.address);
  if (
    !isCreate(action) &&
    (Object.hasOwn(reference.change, "before_identity") ||
      [CONTAINER_APP, EXPIRY_CLEANUP_JOB].includes(resourceChange.address))
  ) {
    keys.push("before_identity", "after_identity");
  }
  return keys;
}

function finalExpectedResourceIdentity(resourceChange, side) {
  const after = resourceChange.change.after;
  if (resourceChange.type === "azapi_resource") {
    return {
      id: after.id,
      type: null,
    };
  }
  const reference = FINAL_REFERENCE_CHANGES.get(resourceChange.address);
  return reference.change[`${side}_identity`];
}

function finalActionAllowed(resourceChange, priorResources) {
  const action = resourceChange.change.actions;
  const address = resourceChange.address;
  if (address === CONTAINER_APP) {
    return isCreate(action) || isUpdate(action) || isNoOp(action);
  }
  if (address === EXPIRY_CLEANUP_JOB) {
    return isCreate(action) || isNoOp(action);
  }
  if (
    address === FINAL_ACTION_GROUP_ADDRESS ||
    FINAL_ALERT_ADDRESSES.has(address)
  ) {
    return priorResources.has(address) ? isNoOp(action) : isCreate(action);
  }
  if (
    address === FINAL_MONITORING_ROLE_ASSIGNMENT ||
    OPERATOR_ROLE_ASSIGNMENTS.has(address)
  ) {
    return priorResources.has(address) ? isNoOp(action) : isCreate(action);
  }
  return isNoOp(action);
}

function finalHasCoherentResourceChanges(plan, changesByAddress, context) {
  const plannedResources = finalCollectValueResources(
    plan.planned_values?.root_module,
  );
  const priorResources = finalCollectValueResources(
    plan.prior_state?.values?.root_module,
  );
  if (!plannedResources || !priorResources) {
    return false;
  }
  if (
    plannedResources.size !== FINAL_INVENTORY.size ||
    [...FINAL_INVENTORY].some((address) => !plannedResources.has(address))
  ) {
    return false;
  }
  if (!finalHasExactValueModuleHierarchies(plan, priorResources)) {
    return false;
  }

  for (const [address, resourceChange] of changesByAddress) {
    const change = resourceChange.change;
    const action = change.actions;
    const expectedOuter = FINAL_REFERENCE_CHANGES.get(address);
    const outerMatch =
      finalExactKeys(resourceChange, Object.keys(expectedOuter)) &&
      Object.keys(expectedOuter).every(
        (key) =>
          key === "change" ||
          isDeepStrictEqual(resourceChange[key], expectedOuter[key]),
      );
    const envelopeMatch = finalExactKeys(
      change,
      finalChangeEnvelopeKeys(resourceChange),
    );
    const actionAllowed = finalActionAllowed(resourceChange, priorResources);
    const afterObject = isObject(change.after);
    const unknownMatch = isDeepStrictEqual(
      change.after_unknown,
      finalExpectedAfterUnknown(resourceChange),
    );
    const expectedBeforeSensitive = isCreate(action)
      ? false
      : finalExpectedBeforeSensitive(resourceChange);
    const sensitiveMatch = isDeepStrictEqual(
      change.after_sensitive,
      finalExpectedAfterSensitive(resourceChange),
    );
    const sensitiveValuesValid = isCreate(action)
      ? cutoverSensitiveMaskValuesValid(
          change.after,
          FINAL_REFERENCE_CHANGES.get(address).change.after,
          change.after_sensitive,
        )
      : cutoverSensitiveMaskValuesValid(
          change.before,
          FINAL_REFERENCE_CHANGES.get(address).change.before,
          expectedBeforeSensitive,
        ) &&
        cutoverSensitiveMaskValuesValid(
          change.after,
          FINAL_REFERENCE_CHANGES.get(address).change.after,
          change.after_sensitive,
        );
    if (
      !outerMatch ||
      !envelopeMatch ||
      !actionAllowed ||
      !afterObject ||
      !unknownMatch ||
      !sensitiveMatch ||
      !isDeepStrictEqual(change.before_sensitive, expectedBeforeSensitive) ||
      !sensitiveValuesValid
    ) {
      return false;
    }

    const prior = priorResources.get(address);
    const planned = plannedResources.get(address);
    if (isCreate(action)) {
      if (
        change.before !== null ||
        change.before_sensitive !== false ||
        prior !== undefined
      ) {
        return false;
      }
    } else {
      const priorMatch =
        Boolean(prior) &&
        isObject(change.before) &&
        isDeepStrictEqual(prior.values, change.before) &&
        isDeepStrictEqual(prior.sensitive_values, change.before_sensitive);
      if (!priorMatch) {
        return false;
      }
      if (isNoOp(action) && !isDeepStrictEqual(change.before, change.after)) {
        return false;
      }
      if (
        isNoOp(action) &&
        !isDeepStrictEqual(change.before_sensitive, change.after_sensitive)
      ) {
        return false;
      }
    }

    const plannedEnvelopeIsCoherent = finalResourceEnvelopeMatches(planned, resourceChange, "planned", {
        values: change.after,
        map: change.after_sensitive,
        identity: change.after_identity,
      });
    const priorEnvelopeIsIncoherent = !isCreate(action) && !finalResourceEnvelopeMatches(prior, resourceChange, "prior", {
          values: change.before,
          map: change.before_sensitive,
          identity: change.before_identity,
    });
    if (!plannedEnvelopeIsCoherent || priorEnvelopeIsIncoherent) {
      return false;
    }

    if (!isCreate(action) && Object.hasOwn(change, "before_identity")) {
      if (
        !isDeepStrictEqual(
          change.before_identity,
          finalExpectedResourceIdentity(resourceChange, "before"),
        ) ||
        !isDeepStrictEqual(
          change.after_identity,
          finalExpectedResourceIdentity(resourceChange, "after"),
        )
      ) {
        return false;
      }
    }

    if (
      resourceChange.type === "azurerm_role_assignment" &&
      !finalHasExactRoleChange(resourceChange, context)
    ) {
      return false;
    }
  }

  const expectedPrior = [...changesByAddress.values()].filter(
    (entry) => !isCreate(entry.change.actions),
  );
  const storageAddress = "module.workload_state.azurerm_storage_account.this";
  if (
    !cutoverSensitiveStorageContract(
      changesByAddress.get(storageAddress)?.change.after,
      TERMINAL_REFERENCE_PLAN.resource_changes.find(
        (entry) => entry.address === storageAddress,
      )?.change.after,
    )
  ) {
    return false;
  }
  const clientConfig = priorResources.get(
    "module.workload_key_vault.data.azurerm_client_config.current",
  );
  const clientValues = clientConfig?.values;
  const clientConfigValid =
    finalExactKeys(clientConfig, [
      "address",
      "mode",
      "type",
      "name",
      "provider_name",
      "schema_version",
      "values",
      "sensitive_values",
    ]) &&
    clientConfig.mode === "data" &&
    clientConfig.type === "azurerm_client_config" &&
    clientConfig.name === "current" &&
    clientConfig.provider_name === AZURERM_PROVIDER_NAME &&
    clientConfig.schema_version === 0 &&
    finalExactKeys(clientValues, [
      "client_id",
      "id",
      "object_id",
      "subscription_id",
      "tenant_id",
      "timeouts",
    ]) &&
    finalUuid(clientValues.client_id) &&
    typeof clientValues.id === "string" &&
    clientValues.id.length > 0 &&
    clientValues.object_id === context.cliPrincipal &&
    clientValues.subscription_id === FINAL_SUBSCRIPTION_ID &&
    clientValues.tenant_id === finalVariableValue(plan, "tenant_id") &&
    clientValues.timeouts === null &&
    finalIsEmptyObject(clientConfig.sensitive_values);
  const result = (
    clientConfigValid &&
    priorResources.size === expectedPrior.length + 1 &&
    expectedPrior.every((entry) => priorResources.has(entry.address)) &&
    finalHasExactAlertInventory(plan, changesByAddress)
  );
  return result;
}

function bootstrapChangeMetadata(resourceChange) {
  const metadata = { ...resourceChange };
  delete metadata.change;
  return metadata;
}

const BOOTSTRAP_DYNAMIC_KEYS = new Set([
  "app_id",
  "client_id",
  "connection_string",
  "fqdn",
  "id",
  "instrumentation_key",
  "image",
  "latestRevisionName",
  "object_id",
  "parent_id",
  "principal_id",
  "primary_access_key",
  "primary_shared_key",
  "secondary_access_key",
  "secondary_shared_key",
  "subscription_id",
  "tenant_id",
]);

function bootstrapIsDynamicLeaf(reference, path) {
  const key = path.at(-1);
  return (
    (key === "value" && path.includes("outputs") && typeof reference === "string") ||
    (typeof reference === "string" &&
      (reference.startsWith("/subscriptions/") ||
        reference.includes("/subscriptions/") ||
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reference) ||
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reference) ||
        reference.includes(".azurecontainerapps.io") ||
        reference.includes(".table.core.windows.net") ||
        reference.includes(".openai.azure.com") ||
        reference.includes(".vault.azure.net") ||
        reference.includes(".applicationinsights.azure.com") ||
        reference.includes(".livediagnostics.monitor.azure.com") ||
        /^ca-[a-z0-9-]+--[0-9]{7}$/.test(reference) ||
        reference.startsWith("InstrumentationKey="))) ||
    (typeof reference === "string" &&
      (BOOTSTRAP_DYNAMIC_KEYS.has(key) ||
        (key !== undefined && key.endsWith("_connection_string")) ||
        (key !== undefined && key.endsWith("_id"))))
  );
}

function bootstrapCanonicalStorageConnectionString(value, key) {
  if (key === "secondary_blob_connection_string" && value === "") {
    return true;
  }
  if (typeof value !== "string") return false;
  const segments = value.split(";").map((entry) => entry.split("="));
  const expectedKeys = key?.includes("_blob_")
    ? ["DefaultEndpointsProtocol", "BlobEndpoint", "AccountName", "AccountKey"]
    : ["DefaultEndpointsProtocol", "AccountName", "AccountKey", "EndpointSuffix"];
  if (
    segments.length !== expectedKeys.length ||
    segments.some(([name], index) => name !== expectedKeys[index])
  ) {
    return false;
  }
  const values = Object.fromEntries(
    segments.map(([name, ...parts]) => [name, parts.join("=")]),
  );
  return (
    values.DefaultEndpointsProtocol === "https" &&
    /^[a-z0-9]{3,24}$/.test(values.AccountName ?? "") &&
    /^[A-Za-z0-9+/]{86}==$/.test(values.AccountKey ?? "") &&
    (key?.includes("_blob_")
      ? /^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/$/.test(
          values.BlobEndpoint ?? "",
        )
      : values.EndpointSuffix === "core.windows.net")
  );
}

function bootstrapHasStructuralEnvelope(
  actual,
  reference,
  {
    allowDynamicLeaves = false,
  } = {},
  path = [],
) {
  if (
    allowDynamicLeaves &&
    bootstrapIsDynamicLeaf(reference, path)
  ) {
    if (typeof reference !== "string") {
      return isDeepStrictEqual(actual, reference);
    }
    if (typeof actual !== typeof reference || actual === undefined) {
      return false;
    }
    if (actual === reference) {
      return true;
    }
    const key = path.at(-1);
    if (
      [
        "client_id",
        "object_id",
        "principal_id",
        "subscription_id",
        "tenant_id",
      ].includes(key)
    ) {
      return finalUuid(actual);
    }
    if (key === "app_id") {
      return finalUuid(actual);
    }
    if (key === "image") {
      return isImmutableAcrImage(actual);
    }
    if ([
      "primary_access_key",
      "primary_shared_key",
      "secondary_access_key",
      "secondary_shared_key",
    ].includes(key)) {
      return typeof actual === "string" &&
        actual.length === 88 &&
        /^[A-Za-z0-9+/]{86}==$/.test(actual);
    }
    if (key !== undefined && key.endsWith("_connection_string")) {
      return bootstrapCanonicalStorageConnectionString(actual, key);
    }
    if (key === "id" || (key !== undefined && key.endsWith("_id"))) {
      return typeof reference === "string" &&
        reference.startsWith("/subscriptions/")
        ? bootstrapCanonicalDynamicAzureId(actual)
        : actual === reference;
    }
    if (typeof actual === "string" && actual.includes("@")) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actual);
    }
    return true;
  }

  if (Array.isArray(reference)) {
    return (
      Array.isArray(actual) &&
      actual.length === reference.length &&
      reference.every((child, index) =>
        bootstrapHasStructuralEnvelope(
          actual[index],
          child,
          { allowDynamicLeaves },
          [...path, String(index)],
        ),
      )
    );
  }

  if (isObject(reference)) {
    const referenceKeys = Object.keys(reference);
    const actualKeys = isObject(actual) ? Object.keys(actual) : [];
    const dynamicKeyMap =
      allowDynamicLeaves &&
      referenceKeys.length === actualKeys.length &&
      referenceKeys.every(bootstrapCanonicalDynamicAzureId) &&
      actualKeys.every(bootstrapCanonicalDynamicAzureId);
    return (
      isObject(actual) &&
      (hasExactKeys(actual, referenceKeys) || dynamicKeyMap) &&
      Object.entries(reference).every(([key, child], index) => {
        const actualKey = dynamicKeyMap ? actualKeys[index] : key;
        const childResult = bootstrapHasStructuralEnvelope(
          actual[actualKey],
          child,
          { allowDynamicLeaves },
          [...path, actualKey],
        );
        return childResult;
      })
    );
  }

  return actual === reference;
}

function bootstrapHasCanonicalTimestamp(value) {
  const match =
    typeof value === "string" &&
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value);
  if (!match) {
    return false;
  }

  const [, year, month, day, hour, minute, second] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

function bootstrapHasExactResourceMetadata(resourceChange) {
  const reference = MODEL_BOOTSTRAP_REFERENCE_PLAN.resource_changes.find(
    (entry) => entry.address === resourceChange.address,
  );
  return (
    reference !== undefined &&
    isDeepStrictEqual(
      bootstrapChangeMetadata(resourceChange),
      bootstrapChangeMetadata(reference),
    )
  );
}

function bootstrapValueResourceMetadata(resource) {
  const metadata = { ...resource };
  delete metadata.values;
  delete metadata.sensitive_values;
  return metadata;
}

function collectBootstrapResourceEntries(
  value,
  moduleAddress = "",
  resources = new Map(),
) {
  if (!isObject(value)) {
    return resources;
  }

  if (
    value.mode === "managed" &&
    typeof value.address === "string" &&
    Object.hasOwn(value, "values")
  ) {
    if (resources.has(value.address)) {
      resources.set(value.address, undefined);
    } else {
      resources.set(value.address, { resource: value, moduleAddress });
    }
  }

  for (const resource of value.resources ?? []) {
    collectBootstrapResourceEntries(resource, moduleAddress, resources);
  }
  for (const childModule of value.child_modules ?? []) {
    if (isObject(childModule) && typeof childModule.address === "string") {
      collectBootstrapResourceEntries(childModule, childModule.address, resources);
    } else {
      collectBootstrapResourceEntries(childModule, undefined, resources);
    }
  }
  return resources;
}

function bootstrapStateResourceMetadataMatchesChange(
  entry,
  resourceChange,
) {
  if (entry === undefined) {
    return isCreate(resourceChange.change.actions) && resourceChange.change.before === null;
  }
  if (!entry || !bootstrapHasExactResourceMetadata(resourceChange)) {
    return false;
  }

  const stateMetadata = bootstrapValueResourceMetadata(entry.resource);
  const changeMetadata = bootstrapChangeMetadata(resourceChange);
  for (const key of [
    "address",
    "mode",
    "type",
    "name",
    "index",
    "provider_name",
  ]) {
    if (Object.hasOwn(changeMetadata, key) &&
      (!Object.hasOwn(stateMetadata, key) ||
        !isDeepStrictEqual(stateMetadata[key], changeMetadata[key]))) {
      return false;
    }
  }

  const hasModuleAddress = entry.moduleAddress !== "";
  const expectedIdentity = resourceChange.change.after_identity;
  if (Object.hasOwn(stateMetadata, "identity")) {
    if (
      !Object.hasOwn(resourceChange.change, "after_identity") ||
      !isDeepStrictEqual(stateMetadata.identity, expectedIdentity)
    ) {
      return false;
    }
  } else if (Object.hasOwn(resourceChange.change, "after_identity")) {
    return false;
  }
  return (
    hasModuleAddress === Object.hasOwn(changeMetadata, "module_address") &&
    (!hasModuleAddress || changeMetadata.module_address === entry.moduleAddress)
  );
}

function bootstrapHasExactStateResourceMetadata(plan) {
  const resourceMetadata = collectBootstrapResourceEntries(
    plan.planned_values?.root_module,
  );
  const resourceGroup = resourceMetadata.get("azurerm_resource_group.foundation")
    ?.resource?.values;
  const subscriptionId = plan.variables?.subscription_id?.value;
  const resourceGroupName = resourceGroup?.name;
  const identityMatches = (resource, reference) => {
    if (!Object.hasOwn(reference, "identity")) {
      return !Object.hasOwn(resource, "identity");
    }
    if (!isObject(resource.identity) || !isObject(reference.identity)) {
      return false;
    }
    if (!hasExactKeys(resource.identity, Object.keys(reference.identity))) {
      return false;
    }
    for (const [key, expected] of Object.entries(reference.identity)) {
      const actual = resource.identity[key];
      if (key === "subscription_id") {
        if (actual !== subscriptionId) return false;
      } else if (key === "resource_group_name") {
        if (actual !== resourceGroupName) return false;
      } else if (key === "id") {
        if (!bootstrapCanonicalArmId(actual)) return false;
        if (resource.values?.id !== undefined && actual !== resource.values.id) {
          return false;
        }
      } else if (key === "name") {
        if (typeof actual !== "string" || actual.length === 0) return false;
        if (resource.values?.name !== undefined && actual !== resource.values.name) {
          return false;
        }
      } else if (!isDeepStrictEqual(actual, expected)) {
        return false;
      }
    }
    return true;
  };
  const actualSections = [
    [
      collectBootstrapResourceEntries(plan.prior_state?.values?.root_module),
      collectBootstrapResourceEntries(
        MODEL_BOOTSTRAP_REFERENCE_PLAN.prior_state?.values?.root_module,
      ),
    ],
    [
      collectBootstrapResourceEntries(plan.planned_values?.root_module),
      collectBootstrapResourceEntries(
        MODEL_BOOTSTRAP_REFERENCE_PLAN.planned_values?.root_module,
      ),
    ],
  ];

  return actualSections.every(([actual, reference]) => {
    if (actual.size !== reference.size) {
      return false;
    }
    return [...actual.entries()].every(([address, entry]) => {
      const expected = reference.get(address);
      return (
        entry !== undefined &&
        expected !== undefined &&
        entry.moduleAddress === expected.moduleAddress &&
        hasExactKeys(
          bootstrapValueResourceMetadata(entry.resource),
          Object.keys(bootstrapValueResourceMetadata(expected.resource)),
        ) &&
        Object.entries(bootstrapValueResourceMetadata(expected.resource)).every(
          ([key, expectedValue]) =>
            key === "identity"
              ? identityMatches(entry.resource, expected.resource)
              : isDeepStrictEqual(entry.resource[key], expectedValue),
        )
      );
    });
  });
}

function bootstrapHasStructuralResourceChange(resourceChange, reference) {
  if (
    !hasExactKeys(resourceChange, Object.keys(reference)) ||
    !bootstrapHasExactResourceMetadata(resourceChange) ||
    !hasExactKeys(resourceChange.change, Object.keys(reference.change))
  ) {
    return false;
  }

  const actualChange = resourceChange.change;
  const referenceChange = reference.change;
  for (const key of Object.keys(referenceChange)) {
    if (key === "before" || key === "after") {
      if (
        !bootstrapHasStructuralEnvelope(
          actualChange[key],
          referenceChange[key],
          { allowDynamicLeaves: true },
          ["resource_changes", resourceChange.address, "change", key],
        )
      ) {
        return false;
      }
      continue;
    }

    if (
      !bootstrapHasStructuralEnvelope(
        actualChange[key],
        referenceChange[key],
        { allowDynamicLeaves: true },
        ["resource_changes", resourceChange.address, "change", key],
      )
    ) {
      return false;
    }
  }
  return true;
}

function bootstrapHasExactResourceChanges(changes) {
  const references = MODEL_BOOTSTRAP_REFERENCE_PLAN.resource_changes;
  if (!Array.isArray(changes) || changes.length !== references.length) {
    return false;
  }
  const changesByAddress = new Map(
    changes.map((resourceChange) => [resourceChange.address, resourceChange]),
  );
  return (
    changesByAddress.size === references.length &&
    references.every((reference) => {
      const resourceChange = changesByAddress.get(reference.address);
      return resourceChange !== undefined &&
        bootstrapHasStructuralResourceChange(resourceChange, reference);
    })
  );
}

function bootstrapHasExactLunaAfter(after, plan) {
  const foundryId = collectBootstrapManagedResources(
    plan.planned_values?.root_module,
  ).get("module.foundry.azurerm_cognitive_account.this")?.values?.id;
  return (
    hasExactKeys(after, [
      "cognitive_account_id",
      "dynamic_throttling_enabled",
      "model",
      "name",
      "sku",
      "timeouts",
      "version_upgrade_option",
    ]) &&
    typeof foundryId === "string" &&
    after.cognitive_account_id === foundryId &&
    after.dynamic_throttling_enabled === null &&
    after.name === LUNA_DEPLOYMENT_NAME &&
    Array.isArray(after.model) &&
    after.model.length === 1 &&
    hasExactKeys(after.model[0], ["format", "name", "version"]) &&
    after.model[0].format === "OpenAI" &&
    after.model[0].name === LUNA_DEPLOYMENT_NAME &&
    after.model[0].version === LUNA_MODEL_VERSION &&
    Array.isArray(after.sku) &&
    after.sku.length === 1 &&
    hasExactKeys(after.sku[0], ["capacity", "family", "name", "size", "tier"]) &&
    after.sku[0].capacity === LUNA_MODEL_CAPACITY &&
    after.sku[0].family === null &&
    after.sku[0].name === "GlobalStandard" &&
    after.sku[0].size === null &&
    after.sku[0].tier === null &&
    after.timeouts === null &&
    after.version_upgrade_option === "NoAutoUpgrade"
  );
}

function bootstrapHasExactLunaCreate(resourceChange, plan) {
  const change = resourceChange.change;
  return (
    bootstrapHasExactResourceMetadata(resourceChange) &&
    hasExactKeys(change, [
      "actions",
      "before",
      "after",
      "after_unknown",
      "before_sensitive",
      "after_sensitive",
    ]) &&
    isCreate(change.actions) &&
    change.before === null &&
    change.before_sensitive === false &&
    bootstrapHasExactLunaAfter(change.after, plan) &&
    isDeepStrictEqual(change.after_unknown, {
      id: true,
      model: [{}],
      rai_policy_name: true,
      sku: [{}],
    }) &&
    isDeepStrictEqual(change.after_sensitive, {
      model: [{}],
      sku: [{}],
    })
  );
}

function hasBootstrapForbiddenPlanStructure(value) {
  const forbiddenKeys = new Set([
    "deposed",
    "generated_config",
    "import",
    "imports",
    "replace_paths",
    "target",
    "targets",
  ]);
  function visit(candidate) {
    if (Array.isArray(candidate)) {
      return candidate.some(visit);
    }
    if (!isObject(candidate)) {
      return false;
    }
    return Object.entries(candidate).some(([key, child]) => {
      if (forbiddenKeys.has(key)) {
        return true;
      }
      if (
        typeof child === "string" &&
        /(?:^|\s)(?:-target|--target|replace|destroy)(?:\s|$)/.test(child)
      ) {
        return true;
      }
      return visit(child);
    });
  }
  return visit(value);
}

function collectBootstrapManagedResources(value, resources = new Map()) {
  if (Array.isArray(value)) {
    for (const child of value) {
      collectBootstrapManagedResources(child, resources);
    }
    return resources;
  }
  if (!isObject(value)) {
    return resources;
  }
  if (
    value.mode === "managed" &&
    typeof value.address === "string" &&
    Object.hasOwn(value, "values")
  ) {
    if (resources.has(value.address)) {
      resources.set(value.address, undefined);
    } else {
      resources.set(value.address, value);
    }
  }
  for (const child of Object.values(value)) {
    collectBootstrapManagedResources(child, resources);
  }
  return resources;
}

function bootstrapHasCoherentState(plan, changesByAddress) {
  const prior = plan.prior_state;
  const planned = plan.planned_values;
  if (
    !isObject(prior) ||
    prior.format_version !== "1.0" ||
    !isObject(prior.values) ||
    !isObject(planned) ||
    !isObject(planned.root_module) ||
    !isObject(prior.values.root_module)
  ) {
    return false;
  }

  const priorStructure = bootstrapHasStructuralEnvelope(
      prior,
      MODEL_BOOTSTRAP_REFERENCE_PLAN.prior_state,
      { allowDynamicLeaves: true },
    );
  const normalizedPlanned = structuredClone(planned);
  const normalizedPlannedEntries = collectBootstrapResourceEntries(
    normalizedPlanned.root_module,
  );
  for (const address of [CONTAINER_APP, EXPIRY_CLEANUP_JOB]) {
    const entry = normalizedPlannedEntries.get(address);
    const referenceEntry = collectBootstrapResourceEntries(
      MODEL_BOOTSTRAP_REFERENCE_PLAN.planned_values.root_module,
    ).get(address);
    if (
      entry?.resource?.values &&
      referenceEntry?.resource?.values &&
      Object.hasOwn(entry.resource.values, "output") &&
      !Object.hasOwn(referenceEntry.resource.values, "output")
    ) {
      delete entry.resource.values.output;
      delete entry.resource.sensitive_values.output;
    }
  }
  const plannedStructure = bootstrapHasStructuralEnvelope(
      normalizedPlanned,
      MODEL_BOOTSTRAP_REFERENCE_PLAN.planned_values,
      { allowDynamicLeaves: true },
    );
  const stateMetadata = bootstrapHasExactStateResourceMetadata(plan);
  if (!priorStructure || !plannedStructure || !stateMetadata) {
    return false;
  }

  const priorResources = collectBootstrapManagedResources(
    prior.values.root_module,
  );
  const plannedResources = collectBootstrapManagedResources(
    planned.root_module,
  );
  const priorEntries = collectBootstrapResourceEntries(prior.values.root_module);
  const plannedEntries = collectBootstrapResourceEntries(planned.root_module);
  const expectedPrior = new Set(
    [...MODEL_BOOTSTRAP_RESOURCE_ADDRESSES].filter(
      (address) => address !== LUNA_DEPLOYMENT,
    ),
  );
  const expectedPlanned = new Set(MODEL_BOOTSTRAP_RESOURCE_ADDRESSES);
  if (
    priorResources.size !== expectedPrior.size ||
    plannedResources.size !== expectedPlanned.size ||
    [...expectedPrior].some((address) => !priorResources.has(address)) ||
    [...expectedPlanned].some((address) => !plannedResources.has(address)) ||
    [...priorResources.values()].some((resource) => resource === undefined) ||
    [...plannedResources.values()].some((resource) => resource === undefined)
  ) {
    return false;
  }

  for (const [address, resourceChange] of changesByAddress) {
    const change = resourceChange.change;
    const priorResource = priorResources.get(address);
    const plannedResource = plannedResources.get(address);
    const priorEntry = priorEntries.get(address);
    const plannedEntry = plannedEntries.get(address);
    if (!plannedResource) {
      return false;
    }
    if (isCreate(change.actions)) {
      if (priorResource !== undefined || change.before !== null) {
        return false;
      }
    } else if (!priorResource) {
      return false;
    } else if (
      !isDeepStrictEqual(change.before, change.after) ||
      !isDeepStrictEqual(change.before_sensitive, change.after_sensitive) ||
      !isDeepStrictEqual(change.before_identity, change.after_identity)
    ) {
      return false;
    }
    const plannedMetadataMatch = bootstrapStateResourceMetadataMatchesChange(
      plannedEntry,
      resourceChange,
    );
    const priorMetadataMatch = isCreate(change.actions) ||
      bootstrapStateResourceMetadataMatchesChange(priorEntry, resourceChange);
    if (!plannedMetadataMatch || !priorMetadataMatch) {
      return false;
    }
    const plannedValuesMatch = bootstrapPlannedValuesMatchChange(
      plannedResource.values,
      change.after,
      address,
    );
    const plannedSensitiveExpected = structuredClone(change.after_sensitive);
    if (
      address === CONTAINER_APP &&
      !Object.hasOwn(plannedResource.values, "output")
    ) {
      delete plannedSensitiveExpected.output;
    }
    const plannedSensitiveMatch = isDeepStrictEqual(
      plannedResource.sensitive_values,
      plannedSensitiveExpected,
    );
    const priorValuesMatch = isCreate(change.actions) ||
      isDeepStrictEqual(priorResource.values, change.before);
    const priorSensitiveMatch = isCreate(change.actions) ||
      isDeepStrictEqual(priorResource.sensitive_values, change.before_sensitive);
    if (
      !plannedValuesMatch ||
      !plannedSensitiveMatch ||
      !priorValuesMatch ||
      !priorSensitiveMatch
    ) {
      return false;
    }
  }
  return true;
}

function bootstrapHasExactRelevantAttributes(attributes) {
  const reference = MODEL_BOOTSTRAP_REFERENCE_PLAN.relevant_attributes;
  if (!Array.isArray(attributes) || attributes.length !== reference.length) {
    return false;
  }
  const canonical = (entry) => {
    if (
      !isObject(entry) ||
      !hasExactKeys(entry, ["resource", "attribute"]) ||
      typeof entry.resource !== "string" ||
      !Array.isArray(entry.attribute) ||
      !entry.attribute.every((part) => typeof part === "string")
    ) {
      return undefined;
    }
    return `${entry.resource}\0${JSON.stringify(entry.attribute)}`;
  };
  const actualKeys = attributes.map(canonical);
  const referenceKeys = reference.map(canonical);
  if (
    actualKeys.some((key) => key === undefined) ||
    referenceKeys.some((key) => key === undefined)
  ) {
    return false;
  }
  const actualSet = new Set(actualKeys);
  const referenceSet = new Set(referenceKeys);
  return (
    actualSet.size === attributes.length &&
    referenceSet.size === reference.length &&
    [...referenceSet].every((key) => actualSet.has(key))
  );
}

function bootstrapHasExactConfiguration(plan) {
  const appCall =
    plan.configuration?.root_module?.module_calls?.container_app_workload;
  const referenceAppCall =
    MODEL_BOOTSTRAP_REFERENCE_PLAN.configuration.root_module.module_calls
      .container_app_workload;
  return (
    bootstrapHasStructuralEnvelope(
      plan.configuration,
      MODEL_BOOTSTRAP_REFERENCE_PLAN.configuration,
      { allowDynamicLeaves: true },
    ) &&
    hasExactKeys(appCall, Object.keys(referenceAppCall)) &&
    appCall.expressions.image_digest.references.length === 1 &&
    appCall.expressions.image_digest.references[0] ===
      "var.relay_image_digest"
  );
}

function bootstrapHasExactVariables(plan) {
  const referenceVariables = MODEL_BOOTSTRAP_REFERENCE_PLAN.variables;
  if (
    !isObject(plan.variables) ||
    !hasExactKeys(plan.variables, Object.keys(referenceVariables))
  ) {
    return false;
  }

  const canonicalUuid = (value) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
  const canonicalDate = (value) =>
    typeof value === "string" &&
    bootstrapHasCanonicalTimestamp(value) &&
    value.endsWith("T00:00:00Z");
  const canonicalContact = (value) =>
    typeof value === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value);
  const canonicalAcrImage = (value) =>
    typeof value === "string" &&
    /^[a-z0-9-]+\.azurecr\.io\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(
      value,
    );
  const canonicalSecretUrl = (value, secretName) =>
    typeof value === "string" &&
    new RegExp(
      `^https://[a-z0-9-]+\\.vault\\.azure\\.net/secrets/${secretName}$`,
    ).test(value);
  const deployments = plan.variables.foundry_deployments?.value;
  const deploymentsValid =
    isObject(deployments) &&
    hasExactKeys(deployments, [PINNED_DEPLOYMENT_NAME, LUNA_DEPLOYMENT_NAME]) &&
    hasExactKeys(deployments[PINNED_DEPLOYMENT_NAME], [
      "model_name",
      "model_version",
      "model_format",
      "sku_name",
      "capacity",
      "version_upgrade_option",
    ]) &&
    hasExactKeys(deployments[LUNA_DEPLOYMENT_NAME], [
      "model_name",
      "model_version",
      "model_format",
      "sku_name",
      "capacity",
      "version_upgrade_option",
    ]) &&
    isDeepStrictEqual(deployments, {
      [PINNED_DEPLOYMENT_NAME]: {
        model_name: PINNED_DEPLOYMENT_NAME,
        model_version: PINNED_MODEL_VERSION,
        model_format: "OpenAI",
        sku_name: "GlobalStandard",
        capacity: 1,
        version_upgrade_option: "NoAutoUpgrade",
      },
      [LUNA_DEPLOYMENT_NAME]: {
        model_name: LUNA_DEPLOYMENT_NAME,
        model_version: LUNA_MODEL_VERSION,
        model_format: "OpenAI",
        sku_name: "GlobalStandard",
        capacity: LUNA_MODEL_CAPACITY,
        version_upgrade_option: "NoAutoUpgrade",
      },
    });
  if (!deploymentsValid) {
    return false;
  }

  for (const [name, reference] of Object.entries(referenceVariables)) {
    const descriptor = plan.variables[name];
    if (!hasExactKeys(descriptor, ["value"])) {
      return false;
    }
    const value = descriptor.value;
    const expected = reference.value;
    const isValid =
      name === "subscription_id" ||
      name === "tenant_id" ||
      name === "operator_principal_id"
        ? canonicalUuid(value)
        : name === "budget_contact_emails"
          ? Array.isArray(value) &&
            value.length > 0 &&
            value.every(canonicalContact)
          : name === "budget_start_date" || name === "budget_end_date"
            ? canonicalDate(value)
            : name === "litellm_master_key_secret_url"
              ? canonicalSecretUrl(value, "litellm-master-key")
              : name === "openrouter_api_key_secret_url"
                ? canonicalSecretUrl(value, "openrouter-api-key")
                : name === "relay_image_digest"
                  ? value === FINAL_RELAY_PRIOR_IMAGE
                  : name === "litellm_image_digest" ||
                      name === "expiry_cleanup_image_digest"
                    ? canonicalAcrImage(value)
                    : name === "foundry_deployments"
                      ? deploymentsValid
                      : isDeepStrictEqual(value, expected);
    if (!isValid) {
      return false;
    }
  }

  const start = plan.variables.budget_start_date.value;
  const end = plan.variables.budget_end_date.value;
  return new Date(start).getTime() < new Date(end).getTime();
}

function bootstrapHasExactContactBindings(plan) {
  const expected = new Set(plan.variables?.budget_contact_emails?.value ?? []);
  if (
    expected.size === 0 ||
    [...expected].some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value))
  ) {
    return false;
  }
  const observed = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isObject(value)) {
      if (
        typeof value === "string" &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value)
      ) {
        observed.add(value);
      }
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(plan);
  return observed.size > 0 && [...observed].every((value) => expected.has(value));
}

function bootstrapHasTerraformValueType(value, type) {
  if (type === "string") return typeof value === "string";
  if (type === "bool") return typeof value === "boolean";
  if (type === "number") return typeof value === "number";
  if (!Array.isArray(type) || type.length !== 2) return false;
  if (type[0] === "object") {
    return (
      isObject(value) &&
      isObject(type[1]) &&
      hasExactKeys(value, Object.keys(type[1])) &&
      Object.entries(type[1]).every(([key, childType]) =>
        bootstrapHasTerraformValueType(value[key], childType),
      )
    );
  }
  if (!(type[0] === "list" || type[0] === "set")) return false;
  return Array.isArray(value) && value.every((entry) =>
    bootstrapHasTerraformValueType(entry, type[1]),
  );
}

function bootstrapCanonicalArmId(value) {
  return (
    typeof value === "string" &&
    /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+(?:\/providers\/[^/]+\/.+)?$/i.test(
      value,
    )
  );
}

function bootstrapCanonicalDynamicAzureId(value) {
  return (
    typeof value === "string" &&
    /^\/subscriptions\/[0-9a-f-]{36}(?:\/[^\s/]+)*$/i.test(value)
  );
}

function bootstrapCanonicalOutputValue(name, value, referenceValue) {
  if (
    typeof referenceValue === "string" &&
    referenceValue.startsWith("fixture-")
  ) {
    if (value === referenceValue) return true;
  }
  if (name === "foundry_deployment_names") {
    return isDeepStrictEqual(value, [
      PINNED_DEPLOYMENT_NAME,
      LUNA_DEPLOYMENT_NAME,
    ]);
  }
  if (name === "relay_alert_rule_ids") {
    return (
      isObject(value) &&
      hasExactKeys(value, [
        "provider_failures",
        "state_store_failures",
        "suggestion_mean",
        "transcription_final_mean",
        "transcription_first_partial_mean",
        "translation_mean",
      ]) &&
      Object.values(value).every((entry) => bootstrapCanonicalArmId(entry))
    );
  }
  if (name === "runtime_identity_client_id") {
    return finalUuid(value);
  }
  if (name.endsWith("_id")) {
    return bootstrapCanonicalArmId(value);
  }
  if (name.endsWith("_name") || name === "region") {
    return (
      typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(value)
    );
  }
  if (name === "acr_login_server") {
    return typeof value === "string" && /^[a-z0-9-]+\.azurecr\.io$/.test(value);
  }
  if (name === "key_vault_uri") {
    return (
      typeof value === "string" &&
      /^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/$/.test(value)
    );
  }
  if (name === "foundry_endpoint") {
    return (
      typeof value === "string" &&
      /^https:\/\/[a-z0-9-]+\.openai\.azure\.com\/$/.test(value)
    );
  }
  if (name === "relay_origin") {
    return (
      typeof value === "string" &&
      /^wss:\/\/[a-z0-9-]+\.[a-z0-9.-]+\.azurecontainerapps\.io$/.test(value)
    );
  }
  if (name === "container_app_environment_default_domain") {
    return (
      typeof value === "string" &&
      /^[a-z0-9-]+\.[a-z0-9-]+\.azurecontainerapps\.io$/.test(value)
    );
  }
  return typeof value === "string" && value.length > 0;
}

function bootstrapValueAtPath(value, path) {
  let current = value;
  for (const key of path) {
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    current = current[key];
  }
  return current;
}

function bootstrapHasOutputResourceBindings(plan, plannedOutputs) {
  const resources = collectBootstrapManagedResources(
    plan.planned_values?.root_module,
  );
  const bindings = new Map([
    ["resource_group_id", ["azurerm_resource_group.foundation", ["id"]]],
    ["resource_group_name", ["azurerm_resource_group.foundation", ["name"]]],
    [
      "foundry_account_id",
      ["module.foundry.azurerm_cognitive_account.this", ["id"]],
    ],
    [
      "foundry_endpoint",
      ["module.foundry.azurerm_cognitive_account.this", ["endpoint"]],
    ],
    [
      "relay_container_app_id",
      [CONTAINER_APP, ["id"]],
    ],
    [
      "relay_container_app_name",
      [CONTAINER_APP, ["name"]],
    ],
    [
      "expiry_cleanup_job_id",
      [EXPIRY_CLEANUP_JOB, ["id"]],
    ],
    [
      "expiry_cleanup_job_name",
      [EXPIRY_CLEANUP_JOB, ["name"]],
    ],
    [
      "image_pull_identity_id",
      [
        "module.identities_rbac.azurerm_user_assigned_identity.image_pull",
        ["id"],
      ],
    ],
    [
      "runtime_identity_id",
      [
        "module.identities_rbac.azurerm_user_assigned_identity.runtime",
        ["id"],
      ],
    ],
    [
      "runtime_identity_client_id",
      [
        "module.identities_rbac.azurerm_user_assigned_identity.runtime",
        ["client_id"],
      ],
    ],
  ]);

  return [...bindings].every(([name, [address, path]]) => {
    const resource = resources.get(address);
    if (!resource) {
      return false;
    }
    const expected = bootstrapValueAtPath(resource.values, path);
    const actual = plannedOutputs[name]?.value;
    return expected !== undefined && isDeepStrictEqual(actual, expected);
  });
}

function bootstrapHasExactOutputs(plan) {
  const referencePlanned = MODEL_BOOTSTRAP_REFERENCE_PLAN.planned_values.outputs;
  const referencePrior = MODEL_BOOTSTRAP_REFERENCE_PLAN.prior_state.values.outputs;
  const referenceChanges = MODEL_BOOTSTRAP_REFERENCE_PLAN.output_changes;
  const planned = plan.planned_values?.outputs;
  const prior = plan.prior_state?.values?.outputs;
  const changes = plan.output_changes;
  const expectedNames = Object.keys(referenceChanges);
  const shapeChecks = {
    plannedKeys: hasExactKeys(planned, expectedNames),
    priorKeys: hasExactKeys(prior, expectedNames),
    changeKeys: hasExactKeys(changes, expectedNames),
    plannedStructure: bootstrapHasStructuralEnvelope(planned, referencePlanned, {
      allowDynamicLeaves: true,
    }),
    priorStructure: bootstrapHasStructuralEnvelope(prior, referencePrior, {
      allowDynamicLeaves: true,
    }),
    changesStructure: bootstrapHasStructuralEnvelope(changes, referenceChanges, {
      allowDynamicLeaves: true,
    }),
  };
  if (Object.values(shapeChecks).some((value) => !value)) {
    return false;
  }

  for (const name of expectedNames) {
    const descriptor = planned[name];
    const priorDescriptor = prior[name];
    const outputChange = changes[name];
    const referenceChange = referenceChanges[name];
    const referenceValue = referencePlanned[name].value;
    const valueTypeIsValid =
      name === "foundry_deployment_names"
        ? Array.isArray(descriptor.value) &&
          descriptor.value.every((entry) => typeof entry === "string")
        : bootstrapHasTerraformValueType(descriptor.value, descriptor.type);
    const priorValueTypeIsValid =
      name === "foundry_deployment_names"
        ? Array.isArray(priorDescriptor.value) &&
          priorDescriptor.value.every((entry) => typeof entry === "string")
        : bootstrapHasTerraformValueType(
            priorDescriptor.value,
            priorDescriptor.type,
          );
    if (
      !hasExactKeys(descriptor, Object.keys(referencePlanned[name])) ||
      !hasExactKeys(priorDescriptor, Object.keys(referencePrior[name])) ||
      !hasExactKeys(outputChange, Object.keys(referenceChange)) ||
      descriptor.sensitive !== priorDescriptor.sensitive ||
      !isDeepStrictEqual(descriptor.type, priorDescriptor.type) ||
      !valueTypeIsValid ||
      !priorValueTypeIsValid ||
      !bootstrapCanonicalOutputValue(name, descriptor.value, referenceValue) ||
      (name !== "foundry_deployment_names" &&
        !isDeepStrictEqual(outputChange.before, priorDescriptor.value)) ||
      !isDeepStrictEqual(outputChange.after, descriptor.value) ||
      outputChange.after_unknown !== false ||
      outputChange.before_sensitive !== priorDescriptor.sensitive ||
      outputChange.after_sensitive !== descriptor.sensitive ||
      !isDeepStrictEqual(outputChange.actions, referenceChange.actions)
    ) {
      return false;
    }

    if (name === "foundry_deployment_names") {
      if (
        !isDeepStrictEqual(outputChange.before, [PINNED_DEPLOYMENT_NAME]) ||
        !isDeepStrictEqual(outputChange.after, [
          PINNED_DEPLOYMENT_NAME,
          LUNA_DEPLOYMENT_NAME,
        ]) ||
        !isDeepStrictEqual(priorDescriptor.value, [
          PINNED_DEPLOYMENT_NAME,
          LUNA_DEPLOYMENT_NAME,
        ])
      ) {
        return false;
      }
    } else if (
      !isNoOp(outputChange.actions) ||
      !isDeepStrictEqual(outputChange.before, outputChange.after)
    ) {
      return false;
    }
  }

  const bindingsValid = bootstrapHasOutputResourceBindings(plan, planned);
  return bindingsValid;
}

function bootstrapHasResourceGroupPayload(value, plan) {
  const subscriptionId = plan.variables?.subscription_id?.value;
  const expectedName = FINAL_RESOURCE_GROUP_NAME;
  return (
    hasExactKeys(value, [
      "id",
      "location",
      "managed_by",
      "name",
      "tags",
      "timeouts",
    ]) &&
    value.id === `/subscriptions/${subscriptionId}/resourceGroups/${value.name}` &&
    value.location === plan.variables?.location?.value &&
    value.managed_by === "" &&
    value.name === expectedName &&
    hasExactFinalTags(value.tags) &&
    value.timeouts === null
  );
}

function bootstrapHasResourceGroupIdentity(identity, plan) {
  return (
    hasExactKeys(identity, ["name", "subscription_id"]) &&
    identity.name === FINAL_RESOURCE_GROUP_NAME &&
    identity.subscription_id === plan.variables?.subscription_id?.value
  );
}

function bootstrapHasExactResourceGroupNoOp(plan, changesByAddress) {
  const resourceChange = changesByAddress.get("azurerm_resource_group.foundation");
  const planned = collectBootstrapManagedResources(
    plan.planned_values?.root_module,
  ).get("azurerm_resource_group.foundation");
  const prior = collectBootstrapManagedResources(
    plan.prior_state?.values?.root_module,
  ).get("azurerm_resource_group.foundation");
  const change = resourceChange?.change;
  return (
    resourceChange !== undefined &&
    isNoOp(change.actions) &&
    bootstrapHasResourceGroupPayload(change.before, plan) &&
    bootstrapHasResourceGroupPayload(change.after, plan) &&
    bootstrapHasResourceGroupPayload(planned?.values, plan) &&
    bootstrapHasResourceGroupPayload(prior?.values, plan) &&
    bootstrapHasResourceGroupIdentity(change.before_identity, plan) &&
    bootstrapHasResourceGroupIdentity(change.after_identity, plan)
  );
}

function bootstrapHasExactRelayImageCrossBinding(plan, changesByAddress) {
  const relayImageValue = plan.variables?.relay_image_digest?.value;
  const relayImage = FINAL_RELAY_PRIOR_IMAGE;
  const appCall =
    plan.configuration?.root_module?.module_calls?.container_app_workload;
  const imageReference = appCall?.expressions?.image_digest?.references;
  if (
    relayImageValue !== relayImage ||
    !Array.isArray(imageReference) ||
    imageReference.length !== 1 ||
    imageReference[0] !== "var.relay_image_digest"
  ) {
    return false;
  }

  const appChange = changesByAddress.get(CONTAINER_APP)?.change;
  const appPlanned = collectBootstrapManagedResources(
    plan.planned_values?.root_module,
  ).get(CONTAINER_APP);
  const appPrior = collectBootstrapManagedResources(
    plan.prior_state?.values?.root_module,
  ).get(CONTAINER_APP);
  const images = [
    appChange?.before,
    appChange?.after,
    appPrior?.values,
  ].map((value) =>
    value?.body?.properties?.template?.containers?.find(
      (container) => container.name === "relay",
    )?.image,
  );
  const plannedImage = appPlanned?.values?.body?.properties?.template?.containers?.find(
    (container) => container.name === "relay",
  )?.image;
  return (
    images.every((image) => image === relayImage) &&
    plannedImage === relayImage
  );
}

function bootstrapPlannedValuesMatchChange(resourceValues, changeValues, address) {
  if (isDeepStrictEqual(resourceValues, changeValues)) {
    return true;
  }
  if (
    address !== CONTAINER_APP ||
    !isObject(resourceValues) ||
    !isObject(changeValues)
  ) {
    return false;
  }
  const actual = structuredClone(resourceValues);
  const expected = structuredClone(changeValues);
  delete expected.output;
  return isDeepStrictEqual(actual, expected);
}

function bootstrapNormalizeSubscription(value, subscriptionId) {
  const referenceSubscription =
    MODEL_BOOTSTRAP_REFERENCE_PLAN.variables.subscription_id.value;
  const normalized = structuredClone(value);
  const visit = (candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) => {
        if (typeof child === "string") {
          candidate[index] = child.replaceAll(subscriptionId, referenceSubscription);
        } else {
          visit(child);
        }
      });
      return;
    }
    if (!isObject(candidate)) {
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (typeof child === "string") {
        candidate[key] = child.replaceAll(subscriptionId, referenceSubscription);
      } else {
        visit(child);
      }
    }
  };
  visit(normalized);
  return normalized;
}

function bootstrapHasExactFixedNoOpContracts(plan, changesByAddress) {
  const relayImageValue = plan.variables?.relay_image_digest?.value;
  const litellmImage = plan.variables?.litellm_image_digest?.value;
  const expiryImage = plan.variables?.expiry_cleanup_image_digest?.value;
  const images = {
    "palancar-relay": FINAL_RELAY_PRIOR_IMAGE,
    "palancar-litellm-proxy": litellmImage,
    "palancar-expiry-cleanup": expiryImage,
  };
  const app = changesByAddress.get(CONTAINER_APP);
  const cleanupJob = changesByAddress.get(EXPIRY_CLEANUP_JOB);
  const subscriptionId = plan.variables?.subscription_id?.value;
  const normalizedApp = app && {
    change: {
      ...app.change,
      after: bootstrapNormalizeSubscription(app.change.after, subscriptionId),
    },
  };
  const normalizedCleanupJob = cleanupJob && {
    change: {
      ...cleanupJob.change,
      after: bootstrapNormalizeSubscription(
        cleanupJob.change.after,
        subscriptionId,
      ),
    },
  };
  const normalizedAppContract =
    app && finalNormalizedAppContractChange(normalizedApp);
  const normalizedCleanupJobContract =
    cleanupJob && finalNormalizedJobContractChange(normalizedCleanupJob);
  const runtimeClientId = app?.change?.after?.body?.properties?.template?.containers
    ?.find((container) => container.name === "relay")
    ?.env?.find((entry) => entry.name === "AZURE_CLIENT_ID")?.value;
  const result = (
    relayImageValue === FINAL_RELAY_PRIOR_IMAGE &&
    isImmutableAcrImage(images["palancar-litellm-proxy"]) &&
    isImmutableAcrImage(images["palancar-expiry-cleanup"]) &&
    finalUuid(runtimeClientId) &&
    app !== undefined &&
    cleanupJob !== undefined &&
    hasExactFinalContainerApp(
      normalizedAppContract,
      images,
      runtimeClientId,
    ) &&
    hasExactFinalCleanupJob(
      normalizedCleanupJobContract,
      images,
      runtimeClientId,
    )
  );
  return result;
}

function bootstrapRuntimeClientId(value) {
  return value?.body?.properties?.template?.containers
    ?.find((container) =>
      ["relay", "expiry-cleanup"].includes(container.name),
    )
    ?.env?.find((entry) => entry.name === "AZURE_CLIENT_ID")?.value;
}

function bootstrapHasExactRuntimeIdentityBinding(plan, changesByAddress) {
  const plannedResources = collectBootstrapManagedResources(
    plan.planned_values?.root_module,
  );
  const priorResources = collectBootstrapManagedResources(
    plan.prior_state?.values?.root_module,
  );
  const appChange = changesByAddress.get(CONTAINER_APP)?.change;
  const cleanupChange = changesByAddress.get(EXPIRY_CLEANUP_JOB)?.change;
  const ids = [
    bootstrapRuntimeClientId(appChange?.before),
    bootstrapRuntimeClientId(appChange?.after),
    bootstrapRuntimeClientId(plannedResources.get(CONTAINER_APP)?.values),
    bootstrapRuntimeClientId(priorResources.get(CONTAINER_APP)?.values),
    bootstrapRuntimeClientId(cleanupChange?.before),
    bootstrapRuntimeClientId(cleanupChange?.after),
    bootstrapRuntimeClientId(
      plannedResources.get(EXPIRY_CLEANUP_JOB)?.values,
    ),
    bootstrapRuntimeClientId(priorResources.get(EXPIRY_CLEANUP_JOB)?.values),
  ];
  if (!ids.every(finalUuid) || !ids.every((id) => id === ids[0])) {
    return false;
  }

  const outputValues = [
    plan.planned_values?.outputs?.runtime_identity_client_id?.value,
    plan.prior_state?.values?.outputs?.runtime_identity_client_id?.value,
    plan.output_changes?.runtime_identity_client_id?.before,
    plan.output_changes?.runtime_identity_client_id?.after,
  ];
  const referenceOutput =
    MODEL_BOOTSTRAP_REFERENCE_PLAN.planned_values.outputs
      .runtime_identity_client_id.value;
  if (outputValues.every((value) => value === referenceOutput)) {
    const referenceApp = collectBootstrapManagedResources(
      MODEL_BOOTSTRAP_REFERENCE_PLAN.planned_values.root_module,
    ).get(CONTAINER_APP);
    return ids[0] === bootstrapRuntimeClientId(referenceApp?.values);
  }
  return outputValues.every((value) => value === ids[0]);
}

function bootstrapHasExactDynamicResourceBindings(plan) {
  const subscriptionId = plan.variables?.subscription_id?.value;
  if (!finalUuid(subscriptionId)) {
    return false;
  }
  const resources = collectBootstrapManagedResources(
    plan.planned_values?.root_module,
  );
  const valueOf = (address) => resources.get(address)?.values;
  const resourceGroup = valueOf("azurerm_resource_group.foundation");
  const storage = valueOf("module.workload_state.azurerm_storage_account.this");
  const rate = valueOf("module.workload_state.azapi_resource.rate");
  const security = valueOf("module.workload_state.azapi_resource.security");
  const environment = valueOf(
    "module.container_app_environment.azurerm_container_app_environment.this",
  );
  const app = valueOf(CONTAINER_APP);
  const job = valueOf(EXPIRY_CLEANUP_JOB);
  const foundry = valueOf("module.foundry.azurerm_cognitive_account.this");
  const pinned = valueOf(MODEL_SPIKE_DEPLOYMENT);
  const resourceGroupId = resourceGroup?.id;
  const storageId = storage?.id;
  const tableServiceId = rate?.parent_id;
  const foundryId = foundry?.id;
  const environmentId = environment?.id;
  const resourceGroupName = resourceGroup?.name;
  const allCanonicalIds = (value) => {
    if (typeof value === "string") {
      const match = /\/subscriptions\/([^/]+)/i.exec(value);
      return match === null || match[1].toLowerCase() === subscriptionId.toLowerCase();
    }
    if (Array.isArray(value)) return value.every(allCanonicalIds);
    return !isObject(value) || Object.values(value).every(allCanonicalIds);
  };
  if (
    !allCanonicalIds(plan.prior_state) ||
    !allCanonicalIds(plan.planned_values) ||
    !allCanonicalIds(plan.resource_changes) ||
    !allCanonicalIds(plan.output_changes)
  ) {
    return false;
  }
  if (
    !isObject(resourceGroup) ||
    !bootstrapCanonicalArmId(resourceGroupId) ||
    resourceGroupId !==
      `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}` ||
    typeof resourceGroupName !== "string" ||
    !isObject(storage) ||
    !bootstrapCanonicalArmId(storageId) ||
    !isObject(rate) ||
    !isObject(security) ||
    !isObject(environment) ||
    !bootstrapCanonicalArmId(environmentId) ||
    !isObject(app) ||
    !isObject(job) ||
    !isObject(foundry) ||
    !bootstrapCanonicalArmId(foundryId) ||
    !isObject(pinned)
  ) {
    return false;
  }
  const resourceIdHasName = (id, kind, name) =>
    typeof id === "string" &&
    id.endsWith(`/providers/Microsoft.${kind}/${name}`);
  if (
    !resourceIdHasName(environmentId, "App/managedEnvironments", environment.name) ||
    app.parent_id !== resourceGroupId ||
    job.parent_id !== resourceGroupId ||
    app.body?.properties?.managedEnvironmentId !== environmentId ||
    job.body?.properties?.environmentId !== environmentId ||
    !resourceIdHasName(app.id, "App/containerApps", app.name) ||
    !resourceIdHasName(job.id, "App/jobs", job.name) ||
    !resourceIdHasName(foundryId, "CognitiveServices/accounts", foundry.name) ||
    foundry.endpoint !== undefined &&
      (typeof foundry.endpoint !== "string" ||
        !/^https:\/\/[a-z0-9-]+\.openai\.azure\.com\/$/.test(foundry.endpoint)) ||
    pinned.id !== `${foundryId}/deployments/${PINNED_DEPLOYMENT_NAME}` ||
    !bootstrapCanonicalArmId(storageId) ||
    !isObject(rate.body) ||
    !isObject(security.body) ||
    rate.id !== `${tableServiceId}/tables/RateState` ||
    security.id !== `${tableServiceId}/tables/SecurityState` ||
    !bootstrapCanonicalArmId(tableServiceId)
  ) {
    return false;
  }
  const outputValues = plan.planned_values?.outputs;
  const outputBindings = new Map([
    ["resource_group_id", resourceGroupId],
    ["resource_group_name", resourceGroupName],
    ["foundry_account_id", foundryId],
    ["foundry_endpoint", foundry.endpoint],
    ["relay_container_app_id", app.id],
    ["relay_container_app_name", app.name],
    ["expiry_cleanup_job_id", job.id],
    ["expiry_cleanup_job_name", job.name],
    [
      "image_pull_identity_id",
      valueOf("module.identities_rbac.azurerm_user_assigned_identity.image_pull")?.id,
    ],
    [
      "runtime_identity_id",
      valueOf("module.identities_rbac.azurerm_user_assigned_identity.runtime")?.id,
    ],
    [
      "runtime_identity_client_id",
      valueOf("module.identities_rbac.azurerm_user_assigned_identity.runtime")
        ?.client_id,
    ],
  ]);
  return [...outputBindings].every(
    ([name, expected]) =>
      expected !== undefined &&
      isDeepStrictEqual(outputValues?.[name]?.value, expected),
  );
}

function collectBootstrapAllStateResources(value, resources = new Map()) {
  if (!isObject(value)) return resources;
  if (
    typeof value.address === "string" &&
    (value.mode === "managed" || value.mode === "data") &&
    Object.hasOwn(value, "values")
  ) {
    if (resources.has(value.address)) {
      resources.set(value.address, undefined);
    } else {
      resources.set(value.address, value);
    }
  }
  for (const child of value.resources ?? []) {
    collectBootstrapAllStateResources(child, resources);
  }
  for (const child of value.child_modules ?? []) {
    collectBootstrapAllStateResources(child, resources);
  }
  return resources;
}

function bootstrapHasExactRoleAssignments(plan, changesByAddress) {
  const variables = plan.variables;
  const sub = variables?.subscription_id?.value;
  const planned = collectBootstrapAllStateResources(
    plan.planned_values?.root_module,
  );
  const prior = collectBootstrapAllStateResources(
    plan.prior_state?.values?.root_module,
  );
  const valueOf = (address) => planned.get(address)?.values;
  const imagePrincipal = valueOf(
    "module.identities_rbac.azurerm_user_assigned_identity.image_pull",
  )?.principal_id;
  const runtimePrincipal = valueOf(
    "module.identities_rbac.azurerm_user_assigned_identity.runtime",
  )?.principal_id;
  const cliPrincipal = valueOf(
    "module.workload_key_vault.data.azurerm_client_config.current",
  )?.object_id ??
    prior.get("module.workload_key_vault.data.azurerm_client_config.current")
      ?.values?.object_id;
  const scopes = {
    acr: valueOf("module.container_registry.azurerm_container_registry.this")?.id,
    storage: valueOf("module.workload_state.azurerm_storage_account.this")?.id,
    foundry: valueOf("module.foundry.azurerm_cognitive_account.this")?.id,
    monitoring: valueOf("module.observability.azurerm_application_insights.this")?.id,
    securityTable: valueOf("module.workload_state.azapi_resource.security")?.id,
    rateTable: valueOf("module.workload_state.azapi_resource.rate")?.id,
    keyVault: valueOf("module.workload_key_vault.azurerm_key_vault.this")?.id,
  };
  const roleDefinition = (variableName, expectedGuid) => {
    const value = variables?.[variableName]?.value;
    return value === expectedGuid
      ? `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${value}`
      : undefined;
  };
  const definitions = {
    acr: roleDefinition("acr_pull_role_definition_id", BOOTSTRAP_ROLE_DEFINITION_IDS.acr),
    table: roleDefinition(
      "table_data_contributor_role_definition_id",
      BOOTSTRAP_ROLE_DEFINITION_IDS.table,
    ),
    openai: roleDefinition(
      "openai_user_role_definition_id",
      BOOTSTRAP_ROLE_DEFINITION_IDS.openai,
    ),
    monitoring: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${BOOTSTRAP_ROLE_DEFINITION_IDS.monitoring}`,
    secretsUser: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${BOOTSTRAP_ROLE_DEFINITION_IDS.secretsUser}`,
    secretsOfficer: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${BOOTSTRAP_ROLE_DEFINITION_IDS.secretsOfficer}`,
  };
  if (
    !finalUuid(sub) ||
    !finalUuid(imagePrincipal) ||
    !finalUuid(runtimePrincipal) ||
    !finalUuid(cliPrincipal) ||
    Object.values(scopes).some((value) => !bootstrapCanonicalArmId(value)) ||
    Object.values(definitions).some((value) => value === undefined)
  ) {
    return false;
  }
  const contracts = new Map([
    [
      "module.identities_rbac.azurerm_role_assignment.image_pull_acr",
      {
        scope: scopes.acr,
        role: definitions.acr,
        roleName: "AcrPull",
        principal: imagePrincipal,
        principalType: "ServicePrincipal",
        nameInput: `${scopes.acr}/image-pull/${definitions.acr}`,
      },
    ],
    [
      "module.identities_rbac.azurerm_role_assignment.runtime_table",
      {
        scope: scopes.storage,
        role: definitions.table,
        roleName: "Storage Table Data Contributor",
        principal: runtimePrincipal,
        principalType: "ServicePrincipal",
        nameInput: `${scopes.storage}/runtime/${definitions.table}`,
      },
    ],
    [
      "module.identities_rbac.azurerm_role_assignment.runtime_openai",
      {
        scope: scopes.foundry,
        role: definitions.openai,
        roleName: "Cognitive Services OpenAI User",
        principal: runtimePrincipal,
        principalType: "ServicePrincipal",
        nameInput: `${scopes.foundry}/runtime/${definitions.openai}`,
      },
    ],
    [
      FINAL_MONITORING_ROLE_ASSIGNMENT,
      {
        scope: scopes.monitoring,
        role: definitions.monitoring,
        roleName: "Monitoring Metrics Publisher",
        principal: runtimePrincipal,
        principalType: "ServicePrincipal",
        nameInput: `scope=${scopes.monitoring}|principal_id=${runtimePrincipal}|role_definition_id=${definitions.monitoring}`,
      },
    ],
    [
      "module.identities_rbac.azurerm_role_assignment.operator_security_table",
      {
        scope: scopes.securityTable,
        role: definitions.table,
        roleName: "Storage Table Data Contributor",
        principal: variables.operator_principal_id.value,
        principalType: "User",
        nameInput: `${scopes.securityTable}/operator/${variables.operator_principal_id.value}/${definitions.table}`,
      },
    ],
    [
      "module.identities_rbac.azurerm_role_assignment.operator_rate_table",
      {
        scope: scopes.rateTable,
        role: definitions.table,
        roleName: "Storage Table Data Contributor",
        principal: variables.operator_principal_id.value,
        principalType: "User",
        nameInput: `${scopes.rateTable}/operator/${variables.operator_principal_id.value}/${definitions.table}`,
      },
    ],
    [
      "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user",
      {
        scope: scopes.keyVault,
        role: definitions.secretsUser,
        roleName: "Key Vault Secrets User",
        principal: runtimePrincipal,
        principalType: "ServicePrincipal",
        nameInput: `${scopes.keyVault}/runtime/${runtimePrincipal}/${definitions.secretsUser}`,
      },
    ],
    [
      "module.workload_key_vault.azurerm_role_assignment.terraform_cli_secrets_officer",
      {
        scope: scopes.keyVault,
        role: definitions.secretsOfficer,
        roleName: "Key Vault Secrets Officer",
        principal: cliPrincipal,
        principalType: "User",
        nameInput: `${scopes.keyVault}/terraform-cli/${cliPrincipal}/${definitions.secretsOfficer}`,
      },
    ],
  ]);
  for (const [address, contract] of contracts) {
    const resourceChange = changesByAddress.get(address);
    if (
      resourceChange === undefined ||
      !isNoOp(resourceChange.change.actions) ||
      !finalUuid(contract.principal) ||
      !finalUuid(contract.scope.match(/\/subscriptions\/([^/]+)/i)?.[1])
    ) {
      return false;
    }
    const expectedName = uuidV5Url(contract.nameInput);
    const expectedId = `${contract.scope}/providers/Microsoft.Authorization/roleAssignments/${expectedName}`;
    const referenceAfter = resourceChange.change.after;
    const values = [
      resourceChange.change.before,
      resourceChange.change.after,
      prior.get(address)?.values,
      planned.get(address)?.values,
    ];
    for (const value of values) {
      if (
        !isObject(value) ||
        !hasExactKeys(value, Object.keys(referenceAfter)) ||
        value.name !== expectedName ||
        value.id !== expectedId ||
        value.scope !== contract.scope ||
        value.role_definition_id !== contract.role ||
        value.role_definition_name !== contract.roleName ||
        value.principal_id !== contract.principal ||
        value.principal_type !== contract.principalType ||
        value.condition !== "" ||
        value.condition_version !== "" ||
        value.delegated_managed_identity_resource_id !== "" ||
        value.description !== "" ||
        value.skip_service_principal_aad_check !== null ||
        value.timeouts !== null
      ) {
        return false;
      }
    }
  }
  return true;
}

function acceptsLunaModelBootstrap(plan, changes) {
  if (
    !hasExactKeys(plan, Object.keys(MODEL_BOOTSTRAP_REFERENCE_PLAN)) ||
    plan.terraform_version !== "1.15.8" ||
    plan.applyable !== true ||
    plan.complete !== true ||
    plan.errored !== false ||
    typeof plan.timestamp !== "string" ||
    !bootstrapHasCanonicalTimestamp(plan.timestamp) ||
    hasBootstrapForbiddenPlanStructure(plan) ||
    hasRetiredDeployment(plan) ||
    !bootstrapHasExactVariables(plan) ||
    !bootstrapHasExactContactBindings(plan) ||
    !bootstrapHasExactConfiguration(plan) ||
    !bootstrapHasExactRelevantAttributes(plan.relevant_attributes) ||
    !Array.isArray(plan.checks) ||
    hasNonPassingCheck(plan) ||
    !bootstrapHasStructuralEnvelope(
      plan.checks,
      MODEL_BOOTSTRAP_REFERENCE_PLAN.checks,
      { allowDynamicLeaves: true },
    ) ||
    !bootstrapHasExactOutputs(plan) ||
    !bootstrapHasCoherentState(
      plan,
      new Map(changes.map((change) => [change.address, change])),
    ) ||
    !bootstrapHasExactResourceChanges(changes)
  ) {
    return false;
  }

  const changesByAddress = new Map(
    changes.map((change) => [change.address, change]),
  );
  if (
    !bootstrapHasExactResourceGroupNoOp(plan, changesByAddress) ||
    !bootstrapHasExactRelayImageCrossBinding(plan, changesByAddress) ||
    !bootstrapHasExactFixedNoOpContracts(plan, changesByAddress) ||
    !bootstrapHasExactRuntimeIdentityBinding(plan, changesByAddress) ||
    !bootstrapHasExactDynamicResourceBindings(plan) ||
    !bootstrapHasExactRoleAssignments(plan, changesByAddress)
  ) {
    return false;
  }

  let lunaCreates = 0;
  for (const resourceChange of changes) {
    if (
      !MODEL_BOOTSTRAP_RESOURCE_ADDRESSES.has(resourceChange.address) ||
      !bootstrapHasExactResourceMetadata(resourceChange)
    ) {
      return false;
    }
    if (resourceChange.address === LUNA_DEPLOYMENT) {
      if (!bootstrapHasExactLunaCreate(resourceChange, plan)) {
        return false;
      }
      lunaCreates += 1;
      continue;
    }

    if (!isNoOp(resourceChange.change.actions)) {
      return false;
    }
  }

  return (
    changes.length === MODEL_BOOTSTRAP_RESOURCE_ADDRESSES.size &&
    lunaCreates === 1
  );
}

function finalHasExactOutputs(plan) {
  const expectedNames = Object.keys(FINAL_REFERENCE_PLAN.planned_values.outputs);
  const planned = plan.planned_values?.outputs;
  const prior = plan.prior_state?.values?.outputs;
  const changes = plan.output_changes;
  if (
    !isObject(planned) ||
    !isObject(prior) ||
    !isObject(changes) ||
    !hasExactKeys(planned, expectedNames) ||
    !hasExactKeys(changes, expectedNames)
  ) {
    return false;
  }

  const transitionPriorAnomalies = new Set([
    "expiry_cleanup_job_name",
    "relay_action_group_id",
    "runtime_openai_user_role_assignment_id",
  ]);
  const expectedPriorNames = [];
  for (const name of expectedNames) {
    const descriptor = planned[name];
    const outputChange = changes[name];
    const referenceDescriptor = FINAL_REFERENCE_PLAN.planned_values.outputs[name];
    const referenceChange = FINAL_REFERENCE_PLAN.output_changes[name];
    const referencePrior = FINAL_REFERENCE_PLAN.prior_state.values.outputs[name];
    const hasAfter = Object.hasOwn(outputChange, "after");
    const descriptorHasValue = Object.hasOwn(descriptor, "value");
    const inferredType =
      name === "relay_alert_rule_ids"
        ? [
            "object",
            Object.fromEntries(
              [...FINAL_ALERT_CONTRACTS.keys()].map((key) => [key, "string"]),
            ),
          ]
        : "string";
    const descriptorKeys = [
      "sensitive",
      ...(descriptorHasValue ? ["type", "value"] : []),
    ];
    if (
      !finalExactKeys(descriptor, descriptorKeys) ||
      descriptor.sensitive !== referenceDescriptor.sensitive ||
      (Object.hasOwn(referenceDescriptor, "type")
        ? !isDeepStrictEqual(descriptor.type, referenceDescriptor.type)
        : descriptorHasValue &&
          !isDeepStrictEqual(descriptor.type, inferredType)) ||
      !finalExactKeys(outputChange, [
        "actions",
        "before",
        ...(hasAfter ? ["after"] : []),
        "after_unknown",
        "before_sensitive",
        "after_sensitive",
      ]) ||
      !(
        isDeepStrictEqual(outputChange.actions, referenceChange.actions) ||
        isNoOp(outputChange.actions)
      ) ||
      (!isNoOp(outputChange.actions) &&
        (name !== "relay_latest_revision_name" ||
          !isDeepStrictEqual(outputChange.actions, referenceChange.actions))) ||
      typeof outputChange.before_sensitive !== "boolean" ||
      typeof outputChange.after_sensitive !== "boolean" ||
      outputChange.before_sensitive !== descriptor.sensitive ||
      outputChange.after_sensitive !== descriptor.sensitive ||
      (isNoOp(outputChange.actions)
        ? outputChange.after_unknown !== false ||
          !hasAfter ||
          !descriptorHasValue ||
          !isDeepStrictEqual(descriptor.value, outputChange.after)
        : !isDeepStrictEqual(descriptor, referenceDescriptor))
    ) {
      return false;
    }

    const hasPrior = Object.hasOwn(prior, name);
    const sensitiveOutput =
      outputChange.before_sensitive === true ||
      outputChange.after_sensitive === true;
    if (
      sensitiveOutput &&
      (!descriptorHasValue ||
        !cutoverOpaqueSensitiveLeafMatches(
          outputChange.before,
          referenceChange.before,
        ) ||
        !cutoverOpaqueSensitiveLeafMatches(
          outputChange.after,
          referenceChange.after,
        ) ||
        !cutoverOpaqueSensitiveLeafMatches(
          descriptor.value,
          referenceDescriptor.value,
        ))
    ) {
      return false;
    }
    if (hasPrior) {
      expectedPriorNames.push(name);
      if (
        !finalExactKeys(prior[name], ["sensitive", "type", "value"]) ||
        !isDeepStrictEqual(
          prior[name].type,
          descriptor.type ?? referencePrior?.type,
        )
      ) {
        return false;
      }
      if (
        sensitiveOutput &&
        !cutoverOpaqueSensitiveLeafMatches(
          prior[name].value,
          referencePrior.value,
        )
      ) {
        return false;
      }
    }

    if (isCreate(outputChange.actions)) {
      if (
        outputChange.before !== null ||
        outputChange.before_sensitive !== false
      ) {
        return false;
      }
      if (hasPrior) {
        // Terraform 1.15.8 retained these two output descriptors while their
        // producing resources were absent. Only the genuine reviewed
        // transition envelopes receive this narrow compatibility exception.
        if (
          !transitionPriorAnomalies.has(name) ||
          !isDeepStrictEqual(outputChange, referenceChange) ||
          !isDeepStrictEqual(descriptor, referenceDescriptor) ||
          !isDeepStrictEqual(prior[name], referencePrior)
        ) {
          return false;
        }
      }
    } else {
      if (
        !hasPrior ||
        !isDeepStrictEqual(prior[name].value, outputChange.before) ||
        prior[name].sensitive !== outputChange.before_sensitive
      ) {
        return false;
      }
      if (isNoOp(outputChange.actions)) {
        if (
          !hasAfter ||
          outputChange.after_unknown ||
          !isDeepStrictEqual(outputChange.before, outputChange.after) ||
          outputChange.before_sensitive !== outputChange.after_sensitive
        ) {
          return false;
        }
      } else if (isUpdate(outputChange.actions)) {
        if (
          name !== "relay_latest_revision_name" ||
          hasAfter ||
          outputChange.after_unknown !== true
        ) {
          return false;
        }
      } else {
        return false;
      }
    }
  }
  return hasExactKeys(prior, expectedPriorNames);
}

function finalHasExactChecks(checks) {
  return isDeepStrictEqual(checks, FINAL_REFERENCE_PLAN.checks);
}

function finalHasExactPlanSections(plan) {
  const result = (
    finalExactKeys(plan, Object.keys(FINAL_REFERENCE_PLAN)) &&
    plan.terraform_version === "1.15.8" &&
    plan.complete === true &&
    typeof plan.applyable === "boolean" &&
    plan.errored === false &&
    typeof plan.timestamp === "string" &&
    !Number.isNaN(Date.parse(plan.timestamp)) &&
    finalExactKeys(plan.planned_values, ["outputs", "root_module"]) &&
    finalExactKeys(plan.prior_state, [
      "format_version",
      "terraform_version",
      "values",
    ]) &&
    plan.prior_state.format_version === "1.0" &&
    plan.prior_state.terraform_version === "1.15.8" &&
    finalExactKeys(plan.prior_state.values, ["outputs", "root_module"]) &&
    finalExactKeys(plan.configuration, ["provider_config", "root_module"]) &&
    isDeepStrictEqual(plan.configuration, FINAL_REFERENCE_PLAN.configuration) &&
    finalHasExactOutputs(plan)
  );
  return result;
}

function acceptsFinalRolloutV2(plan, changes) {
  if (!finalHasExactPlanSections(plan) || !finalHasExactVariables(plan)) {
    return false;
  }
  const changesByAddress = new Map(changes.map((entry) => [entry.address, entry]));
  if (
    changes.length !== 39 ||
    changesByAddress.size !== 39 ||
    [...FINAL_INVENTORY].some((address) => !changesByAddress.has(address))
  ) {
    return false;
  }

  const transitionActions = [...changesByAddress].every(
    ([address, entry]) =>
      isDeepStrictEqual(
        entry.change.actions,
        FINAL_REFERENCE_CHANGES.get(address).change.actions,
      ),
  );
  const idempotentActions = [...changesByAddress.values()].every((entry) =>
    isNoOp(entry.change.actions),
  );
  if (
    transitionActions === idempotentActions ||
    plan.applyable !== transitionActions ||
    !finalHasExactRelevantAttributes(plan, transitionActions)
  ) {
    return false;
  }
  const outputActionsMatch = Object.entries(plan.output_changes).every(
    ([name, outputChange]) =>
      transitionActions
        ? isDeepStrictEqual(
            outputChange.actions,
            FINAL_REFERENCE_PLAN.output_changes[name].actions,
          )
        : isNoOp(outputChange.actions),
  );
  if (!outputActionsMatch) {
    return false;
  }
  if (!finalHasExactChecks(plan.checks)) {
    return false;
  }

  if (Object.hasOwn(plan, "resource_drift")) {
    return false;
  }

  const runtimeIdentity = changesByAddress.get(
    "module.identities_rbac.azurerm_user_assigned_identity.runtime",
  ).change.after;
  const imagePullIdentity = changesByAddress.get(
    "module.identities_rbac.azurerm_user_assigned_identity.image_pull",
  ).change.after;
  const priorResources = finalCollectValueResources(
    plan.prior_state?.values?.root_module,
  );
  const cliPrincipal = priorResources?.get(
    "module.workload_key_vault.data.azurerm_client_config.current",
  )?.values?.object_id;
  const context = {
    operatorPrincipal: finalVariableValue(plan, "operator_principal_id"),
    cliPrincipal,
    runtimePrincipal: runtimeIdentity.principal_id,
    runtimeClient: runtimeIdentity.client_id,
    imagePullPrincipal: imagePullIdentity.principal_id,
    imagePullClient: imagePullIdentity.client_id,
  };
  if (
    !finalUuid(context.runtimePrincipal) ||
    !finalUuid(context.runtimeClient) ||
    !finalUuid(context.imagePullPrincipal) ||
    !finalUuid(context.imagePullClient) ||
    !finalUuid(context.cliPrincipal) ||
    new Set([
      context.operatorPrincipal,
      context.runtimePrincipal,
      context.runtimeClient,
      context.imagePullPrincipal,
    ]).size !== 4
  ) {
    return false;
  }

  const images = exactFinalImageVariables(plan);
  const coherentResources = finalHasCoherentResourceChanges(
    plan,
    changesByAddress,
    context,
  );
  const exactTopology = finalHasExactTopology(
    plan,
    changesByAddress,
    context,
    images,
  );
  return coherentResources && exactTopology;
}

function isWellFormedResourceChange(change) {
  return (
    isObject(change) &&
    typeof change.address === "string" &&
    isObject(change.change) &&
    Array.isArray(change.change.actions) &&
    change.change.actions.every((action) => typeof action === "string")
  );
}

function acceptsModelSpike(changes) {
  let targetCreates = 0;

  for (const change of changes) {
    const actions = change.change.actions;

    if (
      hasExactPinnedModelCreateResourceChange(change)
    ) {
      targetCreates += 1;
      continue;
    }

    if (isNoOp(actions) && change.address === CONTAINER_APP) {
      if (
        !hasAllowedScale(change.change.after) ||
        !hasExactFailClosedBrowserOriginPolicyInContainerApp(
          change.change.after,
        )
      ) {
        return false;
      }

      continue;
    }

    if (isNoOp(actions)) {
      continue;
    }

    return false;
  }

  return targetCreates === 1;
}

function acceptsFullDeploy(changes, requiredNoOpAddresses) {
  const seenAddresses = new Set();
  let pinnedDeploymentEntries = 0;

  for (const change of changes) {
    const actions = change.change.actions;

    if (seenAddresses.has(change.address)) {
      return false;
    }
    seenAddresses.add(change.address);

    if (requiredNoOpAddresses.has(change.address)) {
      if (!isNoOp(actions)) {
        return false;
      }

      continue;
    }

    if (
      change.address === MODEL_SPIKE_DEPLOYMENT &&
      (isCreate(actions) || isNoOp(actions)) &&
      (isCreate(actions)
        ? hasExactPinnedModelCreateResourceChange(change)
        : hasExactPinnedModelAfter(change.change.after))
    ) {
      pinnedDeploymentEntries += 1;
      continue;
    }

    if (
      change.address === CONTAINER_APP &&
      (isUpdate(actions) || isNoOp(actions)) &&
      hasAllowedScale(change.change.after) &&
      hasExactFailClosedBrowserOriginPolicyInContainerApp(change.change.after)
    ) {
      continue;
    }

    return false;
  }

  return (
    pinnedDeploymentEntries === 1 &&
    [...requiredNoOpAddresses].every((address) =>
      seenAddresses.has(address),
    )
  );
}

function acceptsRuntimeRollout(
  changes,
  requiredNoOpAddresses,
  existingManagedAddresses,
  operatorPrincipalId,
) {
  const seenAddresses = new Set();
  let containerAppEntries = 0;
  let operatorRoleAssignmentEntries = 0;
  const operatorTableServices = new Set();

  for (const change of changes) {
    const actions = change.change.actions;
    if (seenAddresses.has(change.address)) {
      return false;
    }
    seenAddresses.add(change.address);

    const operatorTableName = OPERATOR_ROLE_ASSIGNMENTS.get(change.address);
    if (operatorTableName !== undefined) {
      const expectedActions = existingManagedAddresses.has(change.address)
        ? isNoOp(actions)
        : isCreate(actions);
      const tableService = exactOperatorRoleAssignmentTableService(
        change,
        operatorTableName,
        operatorPrincipalId,
      );
      if (
        !expectedActions ||
        tableService === undefined
      ) {
        return false;
      }
      operatorTableServices.add(tableService);
      operatorRoleAssignmentEntries += 1;
      continue;
    }

    if (requiredNoOpAddresses.has(change.address)) {
      if (!isNoOp(actions)) {
        return false;
      }
      continue;
    }

    if (
      change.address === CONTAINER_APP &&
      (isCreate(actions) || isUpdate(actions) || isNoOp(actions)) &&
      hasExactRuntimeContainerApp(change)
    ) {
      containerAppEntries += 1;
      continue;
    }

    return false;
  }

  return (
    containerAppEntries === 1 &&
    operatorRoleAssignmentEntries === OPERATOR_ROLE_ASSIGNMENTS.size &&
    operatorTableServices.size === 1 &&
    [...requiredNoOpAddresses].every((address) => seenAddresses.has(address))
  );
}

// `final-rollout` is a retained pre-cutover mode.  Its historical reference
// is kept in memory so the terminal fixture can describe the post-cleanup
// Entra-only state without changing the old guard contract.
export function createLegacyFinalReferencePlan(source) {
  const plan = structuredClone(source);
  const appAddress = CUTOVER_CONTAINER_APP;
  const lunaAddress = CUTOVER_LUNA_DEPLOYMENT;
  const roleAddress =
    "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user";
  const app = plan.resource_changes.find((entry) => entry.address === appAddress);
  const sourceApp = app?.change?.after;
  const sourceAppMask = app?.change?.after_sensitive ?? {};

  const findValueResource = (root, address) => {
    for (const resource of root?.resources ?? []) {
      if (resource.address === address) return resource;
    }
    for (const child of root?.child_modules ?? []) {
      const resource = findValueResource(child, address);
      if (resource) return resource;
    }
    return undefined;
  };
  const removeValueResource = (root, address) => {
    if (!root) return;
    if (Array.isArray(root.resources)) {
      root.resources = root.resources.filter(
        (resource) => resource.address !== address,
      );
    }
    for (const child of root.child_modules ?? []) {
      removeValueResource(child, address);
    }
  };
  const addValueResource = (root, moduleAddress, resource) => {
    const module = (function findModule(current) {
      if (!moduleAddress) return current;
      for (const child of current?.child_modules ?? []) {
        if (child.address === moduleAddress) return child;
        const nested = findModule(child);
        if (nested) return nested;
      }
      return undefined;
    })(root);
    if (module) {
      module.resources ??= [];
      module.resources.push(resource);
    }
  };
  const maskFor = (value, mask) => {
    if (mask === true) return true;
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        maskFor(entry, Array.isArray(mask) ? mask[index] : undefined),
      );
    }
    if (isObject(value)) {
      const result = {};
      for (const [key, child] of Object.entries(value)) {
        if (isObject(mask) && Object.hasOwn(mask, key)) {
          result[key] = maskFor(child, mask[key]);
        }
      }
      return result;
    }
    return undefined;
  };
  const envValues = (entries) => new Map(
    (entries ?? []).map((entry) => [entry.name, entry]),
  );
  const legacyApp = (direct, image) => {
    const result = structuredClone(direct);
    const properties = result.body.properties;
    const configuration = properties.configuration;
    delete configuration.maxInactiveRevisions;
    configuration.secrets = [
      {
        name: "litellm-master-key",
        keyVaultUrl: `https://${FINAL_KEY_VAULT_HOST}/secrets/litellm-master-key`,
        identity: FINAL_RUNTIME_IDENTITY,
      },
      {
        name: "openrouter-api-key",
        keyVaultUrl: `https://${FINAL_KEY_VAULT_HOST}/secrets/openrouter-api-key`,
        identity: FINAL_RUNTIME_IDENTITY,
      },
    ];
    const relay = properties.template.containers[0];
    const relayEntries = envValues(relay.env);
    const relayNames = [
      "NODE_ENV",
      "PORT",
      "PALANCAR_GENERATION_PROVIDER",
      "PALANCAR_RELAY_BIND_HOST",
      "PALANCAR_RELAY_ENVIRONMENT",
      "PALANCAR_RELAY_ORIGIN",
      "PALANCAR_GATE_POLICY_VERSION",
      "AZURE_CLIENT_ID",
      "PALANCAR_DEPLOYMENT_SLOT",
      "APPLICATIONINSIGHTS_CONNECTION_STRING",
      "APPLICATIONINSIGHTS_STATSBEAT_DISABLED",
      "APPLICATION_INSIGHTS_NO_STATSBEAT",
      "PALANCAR_SECURITY_MODE",
      "PALANCAR_WORKLOAD_TABLE_ENDPOINT",
      "PALANCAR_SECURITY_STATE_TABLE",
      "PALANCAR_RATE_STATE_TABLE",
      "PALANCAR_TRANSCRIPTION_PROVIDER",
      "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT",
      "PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT",
      "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
      "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
    ];
    relay.env = relayNames.map((name) => structuredClone(relayEntries.get(name)));
    relay.env[2].value = "litellm";
    relay.env.push(
      { name: "PALANCAR_LITELLM_BASE_URL", value: "http://127.0.0.1:4000" },
      { name: "PALANCAR_LITELLM_MODEL", value: "palancar-generation" },
      { name: "PALANCAR_LITELLM_API_KEY", secretRef: "litellm-master-key" },
      {
        name: "PALANCAR_LANGUAGE_BOUNDARY_MODE",
        value: EXPECTED_LANGUAGE_BOUNDARY_MODE,
      },
    );
    relay.image = image;
    const sidecar = {
      name: "litellm",
      image: `${FINAL_ACR_LOGIN_SERVER}/palancar-litellm-proxy@sha256:${"b".repeat(64)}`,
      resources: { cpu: 0.75, memory: "1.5Gi" },
      env: [
        { name: "PALANCAR_LITELLM_BACKEND", value: "openrouter" },
        {
          name: "PALANCAR_LITELLM_UPSTREAM_MODEL",
          value: FINAL_GENERATION_MODEL,
        },
        { name: "LITELLM_MASTER_KEY", secretRef: "litellm-master-key" },
        { name: "OPENROUTER_API_KEY", secretRef: "openrouter-api-key" },
      ],
      probes: [
        {
          failureThreshold: 3,
          initialDelaySeconds: 10,
          periodSeconds: 30,
          tcpSocket: { port: 4000 },
          timeoutSeconds: 3,
          type: "Liveness",
        },
        {
          failureThreshold: 3,
          httpGet: { path: "/health/readiness", port: 4000 },
          periodSeconds: 10,
          timeoutSeconds: 7,
          type: "Readiness",
        },
        {
          failureThreshold: 10,
          httpGet: { path: "/health/liveliness", port: 4000 },
          periodSeconds: 10,
          timeoutSeconds: 3,
          type: "Startup",
        },
      ],
    };
    properties.template.containers = [relay, sidecar];
    return result;
  };

  const legacyAfter = legacyApp(sourceApp, source.variables.relay_image_digest.value);
  const legacyBefore = legacyApp(sourceApp, FINAL_RELAY_PRIOR_IMAGE);
  delete legacyAfter.output;
  const appMask = (value) => {
    const result = maskFor(value, sourceAppMask);
    result.body = {
      properties: {
        configuration: {
          identitySettings: [{}, {}],
          ingress: { traffic: [{}] },
          registries: [{}],
          secrets: value.body.properties.configuration.secrets.map(() => ({})),
        },
        template: {
          containers: value.body.properties.template.containers.map((container) => ({
            env: container.env.map((entry) =>
              entry.name === "APPLICATIONINSIGHTS_CONNECTION_STRING"
                ? { value: true }
                : {},
            ),
            probes: container.probes.map((probe) =>
              Object.hasOwn(probe, "tcpSocket")
                ? { tcpSocket: {} }
                : { httpGet: {} },
            ),
            resources: {},
          })),
          scale: {},
        },
      },
    };
    result.identity = [{ identity_ids: [false, false] }];
    result.response_export_values = [false, false, false];
    result.retry = { error_message_regex: [false] };
    result.tags = {};
    return result;
  };
  const legacyMask = appMask(legacyAfter);
  const beforeMask = structuredClone(appMask(legacyBefore));
  beforeMask.output = { properties: { configuration: { ingress: {} } } };
  const unknown = {
    body: {
      properties: {
        configuration: {
          identitySettings: [{}, {}],
          ingress: { traffic: [{}] },
          registries: [{}],
          secrets: [{}, {}],
        },
        template: {
          containers: legacyAfter.body.properties.template.containers.map(
            (container) => ({
              env: container.env.map(() => ({})),
              probes: container.probes.map((probe) =>
                Object.hasOwn(probe, "tcpSocket")
                  ? { tcpSocket: {} }
                  : { httpGet: {} },
              ),
              resources: {},
            }),
          ),
          scale: {},
        },
      },
    },
    identity: [{ identity_ids: [false, false] }],
    response_export_values: [false, false, false],
    retry: { error_message_regex: [false] },
    tags: {},
  };

  plan.variables = structuredClone(plan.variables);
  delete plan.variables.enable_runtime_secrets_user_assignment;
  plan.variables.azure_api_base = { value: "" };
  plan.variables.azure_api_version = { value: "" };
  plan.variables.enable_litellm_sidecar = { value: true };
  plan.variables.litellm_backend = { value: "openrouter" };
  plan.variables.litellm_image_digest = {
    value: `${FINAL_ACR_LOGIN_SERVER}/palancar-litellm-proxy@sha256:${"b".repeat(64)}`,
  };
  plan.variables.litellm_master_key_secret_url = {
    value: `https://${FINAL_KEY_VAULT_HOST}/secrets/litellm-master-key`,
  };
  plan.variables.litellm_upstream_model = { value: FINAL_GENERATION_MODEL };
  plan.variables.openrouter_api_key_secret_url = {
    value: `https://${FINAL_KEY_VAULT_HOST}/secrets/openrouter-api-key`,
  };
  plan.variables.foundry_deployments.value = {
    [PINNED_DEPLOYMENT_NAME]: {
      capacity: 1,
      model_format: "OpenAI",
      model_name: PINNED_DEPLOYMENT_NAME,
      model_version: PINNED_MODEL_VERSION,
      sku_name: "GlobalStandard",
      version_upgrade_option: "NoAutoUpgrade",
    },
  };

  plan.resource_changes = plan.resource_changes
    .filter((entry) => entry.address !== lunaAddress)
    .map((entry) => {
      if (entry.address !== appAddress) return entry;
      entry.change.actions = ["update"];
      entry.change.before = legacyBefore;
      entry.change.after = legacyAfter;
      entry.change.after_unknown = unknown;
      entry.change.before_sensitive = beforeMask;
      entry.change.after_sensitive = legacyMask;
      entry.change.before_identity = {
        id: legacyBefore.id,
        type: null,
      };
      entry.change.after_identity = {
        id: legacyAfter.id,
        type: null,
      };
      return entry;
    });
  const role = {
    address: roleAddress,
    module_address: "module.workload_key_vault",
    mode: "managed",
    type: "azurerm_role_assignment",
    name: "runtime_secrets_user",
    provider_name: AZURERM_PROVIDER_NAME,
    change: {
      actions: ["no-op"],
      before: {
        condition: "",
        condition_version: "",
        delegated_managed_identity_resource_id: "",
        description: "",
        id: `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.KeyVault/vaults/kvpalancardevaeeacd8c/providers/Microsoft.Authorization/roleAssignments/e0913fc6-a326-5228-9c51-09ea847d1803`,
        name: "e0913fc6-a326-5228-9c51-09ea847d1803",
        principal_id: "11111111-1111-4111-8111-111111111111",
        principal_type: "ServicePrincipal",
        role_definition_id: finalRoleDefinitionId(BOOTSTRAP_ROLE_DEFINITION_IDS.secretsUser),
        role_definition_name: "Key Vault Secrets User",
        scope: `${FINAL_RESOURCE_GROUP_ID}/providers/Microsoft.KeyVault/vaults/kvpalancardevaeeacd8c`,
        skip_service_principal_aad_check: null,
        timeouts: null,
      },
      after_unknown: {},
      before_sensitive: {},
      after_sensitive: {},
    },
  };
  role.change.after = structuredClone(role.change.before);
  plan.resource_changes.push(role);

  for (const root of [
    plan.planned_values.root_module,
    plan.prior_state.values.root_module,
  ]) {
    removeValueResource(root, lunaAddress);
    removeValueResource(root, roleAddress);
  }
  const plannedApp = findValueResource(plan.planned_values.root_module, appAddress);
  plannedApp.values = structuredClone(legacyAfter);
  plannedApp.sensitive_values = structuredClone(legacyMask);
  const priorApp = findValueResource(plan.prior_state.values.root_module, appAddress);
  priorApp.values = structuredClone(legacyBefore);
  priorApp.sensitive_values = structuredClone(beforeMask);
  const roleValue = {
    address: roleAddress,
    mode: "managed",
    type: "azurerm_role_assignment",
    name: "runtime_secrets_user",
    provider_name: AZURERM_PROVIDER_NAME,
    schema_version: 0,
    values: structuredClone(role.change.after),
    sensitive_values: {},
  };
  addValueResource(plan.planned_values.root_module, "module.workload_key_vault", structuredClone(roleValue));
  addValueResource(plan.prior_state.values.root_module, "module.workload_key_vault", structuredClone(roleValue));

  plan.output_changes.foundry_deployment_names = {
    actions: ["no-op"],
    before: [PINNED_DEPLOYMENT_NAME],
    after: [PINNED_DEPLOYMENT_NAME],
    after_unknown: false,
    before_sensitive: false,
    after_sensitive: false,
  };
  plan.planned_values.outputs.foundry_deployment_names = {
    sensitive: false,
    type: ["list", "string"],
    value: [PINNED_DEPLOYMENT_NAME],
  };
  plan.prior_state.values.outputs.foundry_deployment_names = {
    sensitive: false,
    type: ["list", "string"],
    value: [PINNED_DEPLOYMENT_NAME],
  };
  const priorRevision = legacyBefore.output?.properties?.latestRevisionName;
  plan.output_changes.relay_latest_revision_name = {
    actions: ["update"],
    before: priorRevision,
    after_unknown: true,
    before_sensitive: false,
    after_sensitive: false,
  };
  plan.planned_values.outputs.relay_latest_revision_name = { sensitive: false };
  plan.prior_state.values.outputs.relay_latest_revision_name = {
    sensitive: false,
    type: "string",
    value: priorRevision,
  };

  plan.configuration.root_module.module_calls.container_app_workload.module.resources[0].expressions.body.references = [
    "var.container_app_environment_id",
    "var.target_port",
    "var.acr_login_server",
    "var.image_pull_identity_id",
    "var.image_pull_identity_id",
    "var.runtime_identity_id",
    "var.enable_litellm_sidecar",
    "var.litellm_master_key_secret_url",
    "var.runtime_identity_id",
    "var.openrouter_api_key_secret_url",
    "var.runtime_identity_id",
    "var.image_digest",
    "var.target_port",
    "var.enable_litellm_sidecar",
    "var.environment",
    "var.relay_origin",
    "var.gate_policy_version",
    "var.runtime_identity_client_id",
    "var.deployment_slot",
    "local.relay_application_insights_connection_string",
    "var.security_mode",
    "var.workload_table_endpoint",
    "var.security_state_table_name",
    "var.rate_state_table_name",
    "var.transcription_provider",
    "var.transcription_provider",
    "var.azure_transcription_endpoint",
    "var.azure_transcription_deployment",
    "var.browser_allowed_origins",
    "var.allow_null_browser_origin",
    "var.enable_litellm_sidecar",
    "var.language_boundary_mode",
    "var.enable_litellm_sidecar",
    "var.litellm_image_digest",
    "var.litellm_upstream_model",
    "var.min_replicas",
  ];
  const extraChecks = [
    "litellm_backend",
    "litellm_image_digest",
    "litellm_master_key_secret_url",
    "litellm_upstream_model",
    "openrouter_api_key_secret_url",
    "enable_litellm_sidecar",
    "azure_api_base",
    "azure_api_version",
  ];
  for (const name of extraChecks) {
    const check = structuredClone(plan.checks[0]);
    check.address = {
      kind: "var",
      name,
      to_display: `var.${name}`,
    };
    check.instances = [{ address: { to_display: `var.${name}` }, status: "pass" }];
    plan.checks.push(check);
  }
  plan.applyable = true;
  return plan;
}

function cutoverExactModelAfter(name) {
  const reference = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (entry) =>
      entry.address ===
      `module.foundry.azurerm_cognitive_deployment.this["${name}"]`,
  );
  return reference?.change?.after;
}

const CUTOVER_RBAC_ADDRESSES = new Set([
  "module.identities_rbac.azurerm_role_assignment.image_pull_acr",
  "module.identities_rbac.azurerm_role_assignment.runtime_table",
  "module.identities_rbac.azurerm_role_assignment.runtime_openai",
  FINAL_MONITORING_ROLE_ASSIGNMENT,
  ...OPERATOR_ROLE_ASSIGNMENTS.keys(),
  "module.workload_key_vault.azurerm_role_assignment.terraform_cli_secrets_officer",
]);
const CUTOVER_IDENTITY_ADDRESSES = new Set([
  "module.identities_rbac.azurerm_user_assigned_identity.image_pull",
  "module.identities_rbac.azurerm_user_assigned_identity.runtime",
]);
const CUTOVER_BENIGN_DRIFT_ADDRESSES = new Set([
  CUTOVER_CONTAINER_APP,
  EXPIRY_CLEANUP_JOB,
]);
const CUTOVER_BENIGN_DRIFT_CHANGE_KEYS = Object.freeze([
  "actions",
  "before",
  "after",
  "after_unknown",
  "before_sensitive",
  "after_sensitive",
]);

function cutoverHasForbiddenMetadata(value, atRoot = true) {
  if (Array.isArray(value)) {
    return value.some((entry) => cutoverHasForbiddenMetadata(entry, false));
  }
  if (!isObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (
      ["action_reason", "deposed", "import", "imports", "importing", "unknown"].includes(
        key,
      )
    ) {
      return true;
    }
    if (key === "resource_drift") {
      if (!atRoot) return true;
      continue;
    }
    if (key === "deferred_changes") return true;
    if (cutoverHasForbiddenMetadata(child, false)) {
      return true;
    }
  }
  return false;
}

function cutoverExactPlanEnvelope(plan, applyable) {
  return (
    isObject(plan) &&
    plan.format_version === SUPPORTED_PLAN_FORMAT_VERSION &&
    plan.terraform_version === "1.15.8" &&
    Array.isArray(plan.resource_changes) &&
    isObject(plan.variables) &&
    isObject(plan.planned_values) &&
    isObject(plan.output_changes) &&
    isObject(plan.prior_state) &&
    isObject(plan.configuration) &&
    Array.isArray(plan.relevant_attributes) &&
    Array.isArray(plan.checks) &&
    typeof plan.timestamp === "string" &&
    !Number.isNaN(Date.parse(plan.timestamp)) &&
    typeof applyable === "boolean" &&
    plan.applyable === applyable &&
    plan.complete === true &&
    plan.errored === false &&
    !Object.hasOwn(plan.configuration, "target") &&
    !Object.hasOwn(plan.configuration, "generated_config") &&
    cutoverHasExactBenignResourceDrift(plan) &&
    !cutoverHasForbiddenMetadata(plan)
  );
}

function cutoverExactResourceChange(
  change,
  expectedKeys = undefined,
  expectedAfterUnknown = undefined,
) {
  const exactKeys = expectedKeys ?? [
    "actions",
    "before",
    "after",
    "after_unknown",
    "before_sensitive",
    "after_sensitive",
    ...(Object.hasOwn(change ?? {}, "before_identity")
      ? ["before_identity", "after_identity"]
      : []),
  ];
  return (
    isObject(change) &&
    Array.isArray(change.actions) &&
    change.actions.length > 0 &&
    change.actions.every((action) => typeof action === "string") &&
    hasExactKeys(change, exactKeys) &&
    Object.hasOwn(change, "before") &&
    Object.hasOwn(change, "after") &&
    isObject(change.after_unknown) &&
    (expectedAfterUnknown === undefined
      ? !hasUnknownValue(change.after_unknown)
      : isDeepStrictEqual(change.after_unknown, expectedAfterUnknown)) &&
    Object.hasOwn(change, "before_sensitive") &&
    Object.hasOwn(change, "after_sensitive") &&
    cutoverHasSensitiveEnvelope(change.before_sensitive) &&
    cutoverHasSensitiveEnvelope(change.after_sensitive)
  );
}

function cutoverHasSensitiveEnvelope(value) {
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.every((entry) => cutoverHasSensitiveEnvelope(entry));
  }
  return (
    isObject(value) &&
    Object.values(value).every((entry) => cutoverHasSensitiveEnvelope(entry))
  );
}

function cutoverExactResourceEntry(
  entry,
  requirePrevious = false,
  allowCredentialCleanupActionReason = false,
) {
  const reference = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (candidate) => candidate.address === entry?.address,
  );
  const expectedOuterKeys = reference
    ? Object.keys(reference)
    : [
        "address",
        "module_address",
        "mode",
        "type",
        "name",
        "provider_name",
        "change",
        "index",
        ...(requirePrevious ? ["previous_address"] : []),
        ...(allowCredentialCleanupActionReason &&
        entry?.address === CUTOVER_RUNTIME_SECRETS_USER &&
        Object.hasOwn(entry, "action_reason")
          ? ["action_reason"]
          : []),
      ];
  const expectedChangeKeys = reference
    ? [
        ...new Set([
          ...Object.keys(reference.change),
          ...(entry?.type === "azapi_resource" &&
          Object.hasOwn(entry.change, "before_identity") &&
          Object.hasOwn(entry.change, "after_identity")
            ? ["before_identity", "after_identity"]
            : []),
        ]),
      ]
    : [
        "actions",
        "before",
        "after",
        "after_unknown",
        "before_sensitive",
        "after_sensitive",
      ];
  const expectedAfterUnknown =
    entry?.address === CUTOVER_CONTAINER_APP &&
    isUpdate(entry?.change?.actions)
      ? CUTOVER_GENERATION_REFERENCE_PLAN.resource_changes.find(
          (candidate) => candidate.address === CUTOVER_CONTAINER_APP,
        )?.change.after_unknown
      : undefined;
  return (
    isObject(entry) &&
    typeof entry.address === "string" &&
    hasExactKeys(entry, expectedOuterKeys) &&
    cutoverExactResourceChange(
      entry.change,
      expectedChangeKeys,
      expectedAfterUnknown,
    ) &&
    (requirePrevious
      ? entry.previous_address === CUTOVER_RUNTIME_SECRETS_USER_PREVIOUS
      : !Object.hasOwn(entry, "previous_address"))
  );
}

function cutoverIsUnorderedIdentityIdsPath(address, path) {
  return (
    CUTOVER_BENIGN_DRIFT_ADDRESSES.has(address) &&
    path.length === 3 &&
    path[0] === "identity" &&
    path[1] === 0 &&
    path[2] === "identity_ids"
  );
}

function cutoverExactNoOp(change, address) {
  return (
    isNoOp(change.actions) &&
    cutoverExactValueEqual(change.before, change.after, address) &&
    isDeepStrictEqual(change.after_unknown, {}) &&
    isDeepStrictEqual(change.before_sensitive, change.after_sensitive)
  );
}

function cutoverExactUnorderedArrayEqual(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    new Set(expected).size === expected.length &&
    actual.every((value) => expected.includes(value)) &&
    expected.every((value) => actual.includes(value))
  );
}

function cutoverExactValueEqual(actual, expected, address, path = []) {
  if (cutoverIsUnorderedIdentityIdsPath(address, path)) {
    return cutoverExactUnorderedArrayEqual(actual, expected);
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((value, index) =>
        cutoverExactValueEqual(
          value,
          expected[index],
          address,
          [...path, index],
        ),
      )
    );
  }
  if (isObject(actual) || isObject(expected)) {
    return (
      isObject(actual) &&
      isObject(expected) &&
      hasExactKeys(actual, Object.keys(expected)) &&
      Object.entries(expected).every(([key, value]) =>
        cutoverExactValueEqual(actual[key], value, address, [...path, key]),
      )
    );
  }
  return Object.is(actual, expected);
}

function cutoverHasExactIdentitySet(
  identityIds,
  imagePullIdentity,
  runtimeIdentity,
) {
  const expected = [imagePullIdentity, runtimeIdentity];
  return (
    expected.every(isUserAssignedIdentity) &&
    new Set(expected).size === expected.length &&
    cutoverExactUnorderedArrayEqual(identityIds, expected) &&
    identityIds.every(isUserAssignedIdentity) &&
    identityIds.length === expected.length
  );
}

function cutoverHasExactBenignDriftEntry(
  plan,
  entry,
  expectedIdentityIds,
) {
  const address = entry?.address;
  const reference = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (candidate) => candidate.address === address,
  );
  const resourceChange = plan.resource_changes.find(
    (candidate) => candidate.address === address,
  );
  const change = entry?.change;
  const before = change?.before;
  const after = change?.after;
  const beforeIdentityIds = before?.identity?.[0]?.identity_ids;
  const afterIdentityIds = after?.identity?.[0]?.identity_ids;
  return (
    CUTOVER_BENIGN_DRIFT_ADDRESSES.has(address) &&
    reference !== undefined &&
    resourceChange !== undefined &&
    isObject(entry) &&
    hasExactKeys(entry, Object.keys(reference)) &&
    cutoverResourceTypeMatchesReference(entry, reference) &&
    isObject(change) &&
    hasExactKeys(change, CUTOVER_BENIGN_DRIFT_CHANGE_KEYS) &&
    isDeepStrictEqual(change.actions, ["update"]) &&
    isObject(before) &&
    isObject(after) &&
    !isDeepStrictEqual(before, after) &&
    cutoverExactValueEqual(before, after, address) &&
    cutoverExactValueEqual(
      before,
      resourceChange.change.before,
      address,
    ) &&
    cutoverExactValueEqual(
      after,
      resourceChange.change.before,
      address,
    ) &&
    cutoverHasExactIdentitySet(
      beforeIdentityIds,
      expectedIdentityIds.imagePull,
      expectedIdentityIds.runtime,
    ) &&
    cutoverHasExactIdentitySet(
      afterIdentityIds,
      expectedIdentityIds.imagePull,
      expectedIdentityIds.runtime,
    ) &&
    beforeIdentityIds[0] === afterIdentityIds[1] &&
    beforeIdentityIds[1] === afterIdentityIds[0] &&
    isDeepStrictEqual(change.after_unknown, {}) &&
    isDeepStrictEqual(
      change.before_sensitive,
      resourceChange.change.before_sensitive,
    ) &&
    isDeepStrictEqual(
      change.after_sensitive,
      resourceChange.change.before_sensitive,
    )
  );
}

function cutoverHasExactBenignResourceDrift(plan) {
  const drift = plan.resource_drift;
  if (drift === undefined || drift === null) return true;
  if (!Array.isArray(drift)) return false;
  if (drift.length === 0) return true;
  if (drift.length < 1 || drift.length > CUTOVER_BENIGN_DRIFT_ADDRESSES.size) return false;

  const addresses = new Set(drift.map((entry) => entry?.address));
  if (
    addresses.size !== drift.length ||
    [...addresses].some((address) => !CUTOVER_BENIGN_DRIFT_ADDRESSES.has(address))
  ) {
    return false;
  }

  const expectedIdentityIds = {
    imagePull: plan.resource_changes.find(
      (entry) =>
        entry.address ===
        "module.identities_rbac.azurerm_user_assigned_identity.image_pull",
    )?.change?.after?.id,
    runtime: plan.resource_changes.find(
      (entry) =>
        entry.address ===
        "module.identities_rbac.azurerm_user_assigned_identity.runtime",
    )?.change?.after?.id,
  };
  return drift.every((entry) =>
    cutoverHasExactBenignDriftEntry(plan, entry, expectedIdentityIds),
  );
}

function cutoverExactModelChange(change, name, bindings = []) {
  return (
    cutoverExactNoOp(change) &&
    isDeepStrictEqual(
      change.after,
      cutoverRebindReference(
        cutoverExactModelAfter(name),
        bindings,
      ),
    )
  );
}

function cutoverCollectValueResources(rootModule) {
  const resources = new Map();
  let valid = isObject(rootModule);
  function visit(module) {
    if (!isObject(module) || !Array.isArray(module.resources)) {
      valid = false;
      return;
    }
    for (const resource of module.resources) {
      if (
        !isObject(resource) ||
        typeof resource.address !== "string" ||
        resources.has(resource.address) ||
        !Object.hasOwn(resource, "values") ||
        !Object.hasOwn(resource, "sensitive_values")
      ) {
        valid = false;
        continue;
      }
      resources.set(resource.address, resource);
    }
    for (const child of module.child_modules ?? []) visit(child);
  }
  visit(rootModule);
  return valid ? resources : undefined;
}

function cutoverCollectValueResourceLocations(rootModule) {
  const resources = new Map();
  let valid = isObject(rootModule);

  function visit(module, moduleAddress) {
    if (!isObject(module) || !Array.isArray(module.resources)) {
      valid = false;
      return;
    }
    for (const resource of module.resources) {
      if (
        !isObject(resource) ||
        typeof resource.address !== "string" ||
        resources.has(resource.address)
      ) {
        valid = false;
        continue;
      }
      resources.set(resource.address, { moduleAddress, resource });
    }
    if (
      Object.hasOwn(module, "child_modules") &&
      !Array.isArray(module.child_modules)
    ) {
      valid = false;
      return;
    }
    for (const child of module.child_modules ?? []) {
      if (!isObject(child) || typeof child.address !== "string") {
        valid = false;
        continue;
      }
      visit(child, child.address);
    }
  }

  visit(rootModule, "");
  return valid ? resources : undefined;
}

function cutoverExactModuleHierarchy(actual, reference) {
  if (
    !isObject(actual) ||
    !isObject(reference) ||
    !hasExactKeys(actual, Object.keys(reference)) ||
    (Object.hasOwn(reference, "address") &&
      actual.address !== reference.address) ||
    !Array.isArray(actual.resources) ||
    !Array.isArray(reference.resources)
  ) {
    return false;
  }
  const actualChildren = actual.child_modules;
  const referenceChildren = reference.child_modules;
  if (referenceChildren === undefined) {
    return actualChildren === undefined;
  }
  return (
    Array.isArray(actualChildren) &&
    actualChildren.length === referenceChildren.length &&
    actualChildren.every((child, index) =>
      cutoverExactModuleHierarchy(child, referenceChildren[index]),
    )
  );
}

function cutoverHasExactStateEnvelopes(plan) {
  return (
    isObject(plan.planned_values) &&
    hasExactKeys(plan.planned_values, ["outputs", "root_module"]) &&
    isObject(plan.planned_values.outputs) &&
    isObject(plan.planned_values.root_module) &&
    isObject(plan.prior_state) &&
    hasExactKeys(plan.prior_state, [
      "format_version",
      "terraform_version",
      "values",
    ]) &&
    plan.prior_state.format_version === "1.0" &&
    plan.prior_state.terraform_version === "1.15.8" &&
    isObject(plan.prior_state.values) &&
    hasExactKeys(plan.prior_state.values, ["outputs", "root_module"]) &&
    isObject(plan.prior_state.values.outputs) &&
    isObject(plan.prior_state.values.root_module)
  );
}

function cutoverExactStructure(actual, expected, path = "") {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((entry, index) =>
        cutoverExactStructure(entry, expected[index], `${path}[${index}]`),
      )
    );
  }
  if (isObject(expected)) {
    return (
      isObject(actual) &&
      hasExactKeys(actual, Object.keys(expected)) &&
      Object.keys(expected).every((key) =>
        cutoverExactStructure(
          actual[key],
          expected[key],
          path ? `${path}.${key}` : key,
        ),
      )
    );
  }
  // Terraform configuration contains defaults for values that are supplied
  // at plan time.  Those defaults are not a second source of authority, but
  // their type and location remain part of the reviewed configuration shape.
  if (
    path === "root_module.variables.tenant_id.default" &&
    typeof actual === "string"
  ) {
    return finalUuid(actual);
  }
  if (
    [
      "root_module.variables.relay_image_digest.default",
      "root_module.variables.expiry_cleanup_image_digest.default",
    ].includes(path)
  ) {
    return actual === "";
  }
  return actual === expected;
}

function cutoverCheckShape(check) {
  return (
    isObject(check) &&
    hasExactKeys(check, ["address", "status", "instances"]) &&
    isObject(check.address) &&
    Array.isArray(check.instances) &&
    check.status === "pass" &&
    check.instances.every(
      (instance) =>
        isObject(instance) &&
        hasExactKeys(instance, ["address", "status"]) &&
        isObject(instance.address) &&
        instance.status === "pass",
    )
  );
}

function cutoverHasExactChecks(plan) {
  const expected = TERMINAL_REFERENCE_PLAN.checks;
  return (
    Array.isArray(plan.checks) &&
    plan.checks.length === expected.length &&
    plan.checks.every((check, index) => {
      const reference = expected[index];
      return (
        cutoverCheckShape(check) &&
        isDeepStrictEqual(check.address, reference.address) &&
        check.instances.length === reference.instances.length &&
        check.instances.every((instance, instanceIndex) =>
          isDeepStrictEqual(
            instance.address,
            reference.instances[instanceIndex].address,
          ),
        )
      );
    })
  );
}

function cutoverRelevantAttributeKey(entry) {
  if (
    !isObject(entry) ||
    !hasExactKeys(entry, ["resource", "attribute"]) ||
    typeof entry.resource !== "string" ||
    !Array.isArray(entry.attribute) ||
    !entry.attribute.every((part) => typeof part === "string")
  ) {
    return undefined;
  }
  return JSON.stringify([entry.resource, entry.attribute]);
}

function cutoverHasExactRelevantAttributes(plan, mode) {
  const reference =
    mode === AZURE_GENERATION_CUTOVER_MODE
      ? CUTOVER_GENERATION_REFERENCE_PLAN.relevant_attributes
      : mode === AZURE_CREDENTIAL_CLEANUP_MODE
        ? CUTOVER_CREDENTIAL_CLEANUP_REFERENCE_PLAN.relevant_attributes
        : mode === POST_CUTOVER_RELAY_IMAGE_ROLLOUT_MODE ||
            mode === FINAL_ROLLOUT_COMPLETE_MODE
          ? TERMINAL_REFERENCE_PLAN.relevant_attributes
          : undefined;
  if (
    !Array.isArray(plan.relevant_attributes) ||
    !Array.isArray(reference) ||
    (mode !== AZURE_CREDENTIAL_CLEANUP_MODE &&
      plan.relevant_attributes.length !== reference.length) ||
    (mode === AZURE_CREDENTIAL_CLEANUP_MODE &&
      (plan.relevant_attributes.length > reference.length ||
        plan.relevant_attributes.length <
          reference.length -
            CUTOVER_CREDENTIAL_CLEANUP_BENIGN_MISSING_RELEVANT_ATTRIBUTE_KEYS.size))
  ) {
    return false;
  }
  const actualKeys = plan.relevant_attributes.map(cutoverRelevantAttributeKey);
  const referenceKeys = reference.map(cutoverRelevantAttributeKey);
  if (
    actualKeys.some((key) => key === undefined) ||
    referenceKeys.some((key) => key === undefined)
  ) {
    return false;
  }
  const actualSet = new Set(actualKeys);
  const referenceSet = new Set(referenceKeys);
  const allowedMissingKeys =
    mode === AZURE_CREDENTIAL_CLEANUP_MODE
      ? CUTOVER_CREDENTIAL_CLEANUP_BENIGN_MISSING_RELEVANT_ATTRIBUTE_KEYS
      : new Set();
  return (
    actualSet.size === actualKeys.length &&
    referenceSet.size === referenceKeys.length &&
    [...referenceSet].every(
      (key) => actualSet.has(key) || allowedMissingKeys.has(key),
    ) &&
    [...actualSet].every((key) => referenceSet.has(key))
  );
}

function cutoverHasExactConfiguration(plan) {
  return (
    isObject(plan.configuration) &&
    cutoverExactStructure(
      plan.configuration,
      TERMINAL_REFERENCE_PLAN.configuration,
    )
  );
}

function cutoverHasNoRetiredWorkloadDependencies(configuration) {
  const workloadCall =
    configuration?.root_module?.module_calls?.container_app_workload;
  if (!isObject(workloadCall)) return false;

  function containsRetiredDependency(value) {
    if (Array.isArray(value)) {
      return value.some(containsRetiredDependency);
    }
    if (!isObject(value)) {
      return (
        typeof value === "string" &&
        CUTOVER_RETIRED_WORKLOAD_DEPENDENCIES.some((name) =>
          value.includes(name),
        )
      );
    }
    return Object.entries(value).some(
      ([key, child]) =>
        CUTOVER_RETIRED_WORKLOAD_DEPENDENCIES.some((name) =>
          key.includes(name),
        ) || containsRetiredDependency(child),
    );
  }

  return !containsRetiredDependency(workloadCall);
}

function cutoverReferenceValueResources() {
  return {
    planned: cutoverCollectValueResources(
      TERMINAL_REFERENCE_PLAN.planned_values.root_module,
    ),
    prior: cutoverCollectValueResources(
      TERMINAL_REFERENCE_PLAN.prior_state.values.root_module,
    ),
  };
}

function cutoverHasExactStateResourceMetadata(
  resource,
  address,
  referenceResources,
  state = "planned",
) {
  if (!isObject(resource)) return false;
  const reference = referenceResources?.get(address);
  if (reference !== undefined) {
    return (
      hasExactKeys(resource, Object.keys(reference)) &&
      resource.address === address &&
      resource.mode === reference.mode &&
      resource.type === reference.type &&
      resource.name === reference.name &&
      resource.provider_name === reference.provider_name &&
      resource.schema_version === reference.schema_version &&
      (!Object.hasOwn(reference, "index") ||
        isDeepStrictEqual(resource.index, reference.index)) &&
      isObject(resource.values) &&
      isObject(resource.sensitive_values)
    );
  }
  if (
    address === CUTOVER_RUNTIME_SECRETS_USER ||
    address === CUTOVER_RUNTIME_SECRETS_USER_PREVIOUS
  ) {
    const roleKeys = [
      "address",
      "mode",
      "type",
      "name",
      "provider_name",
      "schema_version",
      "values",
      "sensitive_values",
      ...(state === "prior" ? ["depends_on"] : []),
      ...(address === CUTOVER_RUNTIME_SECRETS_USER ? ["index"] : []),
    ];
    const referenceRole = cutoverFindValueResource(
      CUTOVER_GENERATION_REFERENCE_PLAN.prior_state.values.root_module,
      address,
    );
    const roleResult = (
      hasExactKeys(resource, roleKeys) &&
      resource.address === address &&
      resource.mode === "managed" &&
      resource.type === "azurerm_role_assignment" &&
      resource.name === "runtime_secrets_user" &&
      resource.provider_name === AZURERM_PROVIDER_NAME &&
      resource.schema_version === 0 &&
      (address === CUTOVER_RUNTIME_SECRETS_USER
        ? resource.index === 0
        : !Object.hasOwn(resource, "index")) &&
      (state !== "prior" ||
        isDeepStrictEqual(resource.depends_on, referenceRole?.depends_on)) &&
      isObject(resource.values) &&
      isObject(resource.sensitive_values)
    );
    return roleResult;
  }
  return false;
}

function cutoverFindValueResource(root, address) {
  for (const resource of root?.resources ?? []) {
    if (resource.address === address) return resource;
  }
  for (const child of root?.child_modules ?? []) {
    const resource = cutoverFindValueResource(child, address);
    if (resource) return resource;
  }
  return undefined;
}

function cutoverExactClientConfig(resource, plan) {
  const values = resource?.values;
  return (
    isObject(resource) &&
    hasExactKeys(resource, [
      "address",
      "mode",
      "type",
      "name",
      "provider_name",
      "schema_version",
      "values",
      "sensitive_values",
    ]) &&
    resource.address ===
      "module.workload_key_vault.data.azurerm_client_config.current" &&
    resource.mode === "data" &&
    resource.type === "azurerm_client_config" &&
    resource.name === "current" &&
    resource.provider_name === AZURERM_PROVIDER_NAME &&
    resource.schema_version === 0 &&
    hasExactKeys(values, [
      "client_id",
      "id",
      "object_id",
      "subscription_id",
      "tenant_id",
      "timeouts",
    ]) &&
    finalUuid(values.client_id) &&
    finalUuid(values.object_id) &&
    typeof values.id === "string" &&
    values.id.length > 0 &&
    values.subscription_id === plan.variables.subscription_id.value &&
    values.tenant_id === plan.variables.tenant_id.value &&
    values.timeouts === null &&
    isDeepStrictEqual(resource.sensitive_values, {})
  );
}

function cutoverHasExactStateInventories(plan, changes, mode, planned, prior) {
  if (!planned || !prior) {
    return false;
  }
  const envelopes = cutoverHasExactStateEnvelopes(plan);
  const plannedHierarchy = cutoverExactModuleHierarchy(
    plan.planned_values.root_module,
    TERMINAL_REFERENCE_PLAN.planned_values.root_module,
  );
  const priorHierarchy = cutoverExactModuleHierarchy(
    plan.prior_state.values.root_module,
    TERMINAL_REFERENCE_PLAN.prior_state.values.root_module,
  );
  if (!envelopes || !plannedHierarchy || !priorHierarchy) {
    return false;
  }
  const plannedLocations = cutoverCollectValueResourceLocations(
    plan.planned_values.root_module,
  );
  const priorLocations = cutoverCollectValueResourceLocations(
    plan.prior_state.values.root_module,
  );
  const referencePlannedLocations = cutoverCollectValueResourceLocations(
    TERMINAL_REFERENCE_PLAN.planned_values.root_module,
  );
  const referencePriorLocations = cutoverCollectValueResourceLocations(
    TERMINAL_REFERENCE_PLAN.prior_state.values.root_module,
  );
  if (
    !plannedLocations ||
    !priorLocations ||
    !referencePlannedLocations ||
    !referencePriorLocations
  ) {
    return false;
  }
  const changeAddresses = new Set(changes.map((entry) => entry.address));
  const plannedExpected = new Set(changeAddresses);
  const priorExpected = new Set(changeAddresses);
  const dataAddress =
    "module.workload_key_vault.data.azurerm_client_config.current";
  priorExpected.add(dataAddress);
  if (mode === AZURE_GENERATION_CUTOVER_MODE) {
    plannedExpected.delete(CUTOVER_RUNTIME_SECRETS_USER);
    plannedExpected.add(CUTOVER_RUNTIME_SECRETS_USER);
    priorExpected.delete(CUTOVER_RUNTIME_SECRETS_USER_PREVIOUS);
    priorExpected.add(CUTOVER_RUNTIME_SECRETS_USER);
  } else if (mode === AZURE_CREDENTIAL_CLEANUP_MODE) {
    plannedExpected.delete(CUTOVER_RUNTIME_SECRETS_USER);
  }
  const exactLocations = (actual, reference, extraAddresses) => {
    if (actual.size !== reference.size + extraAddresses.size) return false;
    for (const [address, location] of actual) {
      const expected = reference.get(address);
      if (expected !== undefined) {
        if (location.moduleAddress !== expected.moduleAddress) {
          return false;
        }
      } else if (
        !extraAddresses.has(address) ||
        location.moduleAddress !== "module.workload_key_vault"
      ) {
        return false;
      }
    }
    return true;
  };
  const plannedExtra = new Set(
    mode === AZURE_GENERATION_CUTOVER_MODE
      ? [CUTOVER_RUNTIME_SECRETS_USER]
      : mode === POST_CUTOVER_RELAY_IMAGE_ROLLOUT_MODE
        ? [CUTOVER_RUNTIME_SECRETS_USER]
      : [],
  );
  const priorExtra = new Set(
    mode === AZURE_GENERATION_CUTOVER_MODE
      ? [CUTOVER_RUNTIME_SECRETS_USER]
      : mode === AZURE_CREDENTIAL_CLEANUP_MODE
        ? [CUTOVER_RUNTIME_SECRETS_USER]
        : mode === POST_CUTOVER_RELAY_IMAGE_ROLLOUT_MODE
          ? [CUTOVER_RUNTIME_SECRETS_USER]
        : [],
  );
  if (
    !exactLocations(
      plannedLocations,
      referencePlannedLocations,
      plannedExtra,
    ) ||
    !exactLocations(priorLocations, referencePriorLocations, priorExtra)
  ) {
    return false;
  }
  // The indexed Secrets User assignment is the only resource whose prior
  // address is intentionally different from its change address.
  const exactSet = (actual, expected) =>
    actual.size === expected.size &&
    [...expected].every((address) => actual.has(address));
  const plannedSet = exactSet(new Set(planned.keys()), plannedExpected);
  const priorSet = exactSet(new Set(prior.keys()), priorExpected);
  if (!plannedSet || !priorSet) {
    return false;
  }
  const clientConfig = cutoverExactClientConfig(prior.get(dataAddress), plan);
  if (!clientConfig) {
    return false;
  }
  const refs = cutoverReferenceValueResources();
  for (const [address, resource] of planned) {
    if (address === dataAddress) continue;
    if (!cutoverHasExactStateResourceMetadata(resource, address, refs.planned, "planned")) {
      return false;
    }
  }
  for (const [address, resource] of prior) {
    if (address === dataAddress) continue;
    if (!cutoverHasExactStateResourceMetadata(resource, address, refs.prior, "prior")) {
      return false;
    }
  }
  return true;
}

function cutoverResourceTypeMatchesReference(entry, reference) {
  return (
    reference !== undefined &&
    entry.type === reference.type &&
    entry.mode === reference.mode &&
    entry.name === reference.name &&
    entry.provider_name === reference.provider_name &&
    (Object.hasOwn(reference, "module_address")
      ? entry.module_address === reference.module_address
      : !Object.hasOwn(entry, "module_address")) &&
    (Object.hasOwn(reference, "index")
      ? isDeepStrictEqual(entry.index, reference.index)
      : !Object.hasOwn(entry, "index"))
  );
}

function cutoverIndexedRoleMetadata(entry) {
  return (
    entry.module_address === "module.workload_key_vault" &&
    entry.mode === "managed" &&
    entry.type === "azurerm_role_assignment" &&
    entry.name === "runtime_secrets_user" &&
    entry.provider_name === AZURERM_PROVIDER_NAME &&
    entry.index === 0
  );
}

function cutoverExactEntryMetadata(entry) {
  if (entry.address === CUTOVER_RUNTIME_SECRETS_USER) {
    return cutoverIndexedRoleMetadata(entry);
  }
  return cutoverResourceTypeMatchesReference(
    entry,
    TERMINAL_REFERENCE_PLAN.resource_changes.find(
      (reference) => reference.address === entry.address,
    ),
  );
}

function cutoverValueResourceMetadataMatches(resource, address) {
  if (!isObject(resource)) return false;
  if (
    address === CUTOVER_RUNTIME_SECRETS_USER ||
    address === CUTOVER_RUNTIME_SECRETS_USER_PREVIOUS
  ) {
    return (
      resource.address === address &&
      resource.mode === "managed" &&
      resource.type === "azurerm_role_assignment" &&
      resource.name === "runtime_secrets_user" &&
      resource.provider_name === AZURERM_PROVIDER_NAME &&
      (address === CUTOVER_RUNTIME_SECRETS_USER
        ? resource.index === 0
        : !Object.hasOwn(resource, "index"))
    );
  }
  const reference = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (entry) => entry.address === address,
  );
  return (
    reference !== undefined &&
    resource.address === address &&
    resource.mode === reference.mode &&
    resource.type === reference.type &&
    resource.name === reference.name &&
    resource.provider_name === reference.provider_name &&
    (Object.hasOwn(reference, "index")
      ? isDeepStrictEqual(resource.index, reference.index)
      : !Object.hasOwn(resource, "index"))
  );
}

function cutoverResourceChangeStateCoherent(plan, entry, planned, prior) {
  const action = entry.change.actions;
  const previousAddress = entry.previous_address ?? entry.address;
  const priorAddress =
    entry.address === CUTOVER_RUNTIME_SECRETS_USER &&
    !prior?.has(previousAddress)
      ? entry.address
      : previousAddress;
  const priorValue = prior?.get(priorAddress);
  const plannedValue = planned?.get(entry.address);
  if (
    isNoOp(action) &&
    (!cutoverExactValueEqual(
      entry.change.before,
      entry.change.after,
      entry.address,
    ) ||
      !isDeepStrictEqual(
        entry.change.before_sensitive,
        entry.change.after_sensitive,
      ))
  ) {
    return false;
  }
  if (action[0] === "delete") {
    return (
      priorValue !== undefined &&
      plannedValue === undefined &&
      cutoverValueResourceMetadataMatches(priorValue, priorAddress) &&
      cutoverExactValueEqual(
        priorValue.values,
        entry.change.before,
        entry.address,
      ) &&
      isDeepStrictEqual(priorValue.sensitive_values, entry.change.before_sensitive)
    );
  }
  if (
    plannedValue === undefined ||
    !cutoverValueResourceMetadataMatches(plannedValue, entry.address)
  ) return false;
  if (
    !cutoverExactValueEqual(
      plannedValue.values,
      entry.change.after,
      entry.address,
    ) ||
    !isDeepStrictEqual(
      plannedValue.sensitive_values,
      entry.change.after_sensitive,
    )
  ) {
    return false;
  }
  if (isCreate(action)) return priorValue === undefined;
  return (
    priorValue !== undefined &&
    cutoverValueResourceMetadataMatches(priorValue, priorAddress) &&
    cutoverExactValueEqual(
      priorValue.values,
      entry.change.before,
      entry.address,
    ) &&
    isDeepStrictEqual(
      priorValue.sensitive_values,
      entry.change.before_sensitive,
    )
  );
}

function cutoverExactFoundryModels(changesByAddress, bindings = []) {
  return (
    cutoverExactModelChange(
      changesByAddress.get(CUTOVER_TRANSCRIPTION_DEPLOYMENT)?.change,
      PINNED_DEPLOYMENT_NAME,
      bindings,
    ) &&
    cutoverExactModelChange(
      changesByAddress.get(CUTOVER_LUNA_DEPLOYMENT)?.change,
      LUNA_DEPLOYMENT_NAME,
      bindings,
    )
  );
}

function cutoverParseApplicationInsightsConnection(value, resource) {
  if (typeof value !== "string" || !isObject(resource)) return undefined;
  const parts = value.split(";");
  const parsed = new Map();
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0 || separator === part.length - 1) return undefined;
    const key = part.slice(0, separator);
    if (parsed.has(key)) return undefined;
    parsed.set(key, part.slice(separator + 1));
  }
  if (
    !isDeepStrictEqual([...parsed.keys()], [
      "InstrumentationKey",
      "IngestionEndpoint",
      "LiveEndpoint",
      "ApplicationId",
    ])
  ) {
    return undefined;
  }
  const instrumentationKey = parsed.get("InstrumentationKey")?.toLowerCase();
  const applicationId = parsed.get("ApplicationId")?.toLowerCase();
  const ingestionEndpoint = parsed.get("IngestionEndpoint");
  const liveEndpoint = parsed.get("LiveEndpoint");
  if (
    !finalUuid(instrumentationKey) ||
    !finalUuid(applicationId) ||
    !/^https:\/\/[a-z0-9.-]+\.in\.applicationinsights\.azure\.com\/$/.test(
      ingestionEndpoint ?? "",
    ) ||
    !/^https:\/\/[a-z0-9.-]+\.livediagnostics\.monitor\.azure\.com\/$/.test(
      liveEndpoint ?? "",
    ) ||
    resource.instrumentation_key?.toLowerCase() !== instrumentationKey ||
    resource.app_id?.toLowerCase() !== applicationId
  ) {
    return undefined;
  }
  return {
    instrumentationKey,
    applicationId,
    ingestionEndpoint,
    liveEndpoint,
    full: value,
    relay: `InstrumentationKey=${instrumentationKey};IngestionEndpoint=${ingestionEndpoint.replace(
      /\/$/,
      "",
    )}`,
  };
}

function cutoverIdentityContext(
  changesByAddress,
  priorResources,
  plannedOutputs,
  priorOutputs,
  outputChanges,
  operatorPrincipal,
  tenant,
) {
  const imagePullChange = changesByAddress.get(
    "module.identities_rbac.azurerm_user_assigned_identity.image_pull",
  )?.change;
  const runtimeChange = changesByAddress.get(
    "module.identities_rbac.azurerm_user_assigned_identity.runtime",
  )?.change;
  const environmentChange = changesByAddress.get(
    "module.container_app_environment.azurerm_container_app_environment.this",
  )?.change;
  const imagePull = imagePullChange?.after;
  const runtime = runtimeChange?.after;
  const imagePullIdentity = imagePull?.id;
  const runtimeIdentity = runtime?.id;
  const cli = priorResources?.get(
    "module.workload_key_vault.data.azurerm_client_config.current",
  )?.values?.object_id;
  const appIdentityIds = changesByAddress.get(CUTOVER_CONTAINER_APP)?.change
    .after?.identity?.[0]?.identity_ids;
  const appAfter = changesByAddress.get(CUTOVER_CONTAINER_APP)?.change.after;
  const priorApp = priorResources?.get(CUTOVER_CONTAINER_APP)?.values;
  const storageAfter = changesByAddress.get(
    "module.workload_state.azurerm_storage_account.this",
  )?.change.after;
  const environmentAfter = changesByAddress.get(
    "module.container_app_environment.azurerm_container_app_environment.this",
  )?.change.after;
  const registryAfter = changesByAddress.get(
    "module.container_registry.azurerm_container_registry.this",
  )?.change.after;
  const foundryAfter = changesByAddress.get(
    "module.foundry.azurerm_cognitive_account.this",
  )?.change.after;
  const resourceGroupAfter = changesByAddress.get(
    "azurerm_resource_group.foundation",
  )?.change.after;
  const appInsightsAfter = changesByAddress.get(
    "module.observability.azurerm_application_insights.this",
  )?.change.after;
  const defaultDomain = environmentAfter?.default_domain;
  const tableEndpoint = storageAfter?.primary_table_endpoint;
  const foundryEndpoint = foundryAfter?.endpoint;
  const relayOrigin =
    typeof appAfter?.name === "string" && typeof defaultDomain === "string"
      ? `wss://${appAfter.name}.${defaultDomain}`
      : undefined;
  const appInsightsConnection = cutoverParseApplicationInsightsConnection(
    appInsightsAfter?.connection_string,
    appInsightsAfter,
  );
  const rootOutput = (outputs, name) => outputs?.[name]?.value;
  const expectedFqdn =
    typeof appAfter?.name === "string" && typeof defaultDomain === "string"
      ? `${appAfter.name}.${defaultDomain}`
      : undefined;
  const priorFqdn =
    priorApp?.output?.properties?.configuration?.ingress?.fqdn;
  const priorRevision = priorApp?.output?.properties?.latestRevisionName;
  const priorRootRevision = rootOutput(
    priorOutputs,
    "relay_latest_revision_name",
  );
  const revisionChange = outputChanges?.relay_latest_revision_name;
  const expectedContainerAppId =
    typeof resourceGroupAfter?.id === "string"
      ? `${resourceGroupAfter.id}/providers/Microsoft.App/containerApps/${FINAL_CONTAINER_APP_NAME}`
      : undefined;
  const rootOutputsMatch = [
    ["relay_container_app_id", expectedContainerAppId],
    ["relay_container_app_name", appAfter?.name],
    ["container_app_environment_id", environmentAfter?.id],
    ["container_app_environment_name", environmentAfter?.name],
    ["container_app_environment_default_domain", defaultDomain],
    ["relay_origin", relayOrigin],
  ].every(([name, expected]) => rootOutput(plannedOutputs, name) === expected);
  if (
    !isObject(imagePull) ||
    !isObject(runtime) ||
    !isDeepStrictEqual(imagePullChange?.actions, ["no-op"]) ||
    !isDeepStrictEqual(runtimeChange?.actions, ["no-op"]) ||
    !isDeepStrictEqual(environmentChange?.actions, ["no-op"]) ||
    !cutoverExactNoOp(
      imagePullChange ?? {},
      "module.identities_rbac.azurerm_user_assigned_identity.image_pull",
    ) ||
    !cutoverExactNoOp(
      runtimeChange ?? {},
      "module.identities_rbac.azurerm_user_assigned_identity.runtime",
    ) ||
    !cutoverExactNoOp(
      environmentChange ?? {},
      "module.container_app_environment.azurerm_container_app_environment.this",
    ) ||
    !finalUuid(imagePull.principal_id) ||
    !finalUuid(imagePull.client_id) ||
    !finalUuid(runtime.principal_id) ||
    !finalUuid(runtime.client_id) ||
    !finalUuid(runtime.tenant_id) ||
    !finalUuid(imagePull.tenant_id) ||
    !finalUuid(tenant) ||
    runtime.tenant_id !== tenant ||
    imagePull.tenant_id !== tenant ||
    !finalUuid(cli) ||
    !finalUuid(operatorPrincipal) ||
    !isUserAssignedIdentity(imagePullIdentity) ||
    !isUserAssignedIdentity(runtimeIdentity) ||
    !cutoverHasExactIdentitySet(
      appIdentityIds,
      imagePullIdentity,
      runtimeIdentity,
    ) ||
    imagePull.principal_id === runtime.principal_id ||
    imagePull.client_id === runtime.client_id ||
    !isObject(appAfter) ||
    !isObject(storageAfter) ||
    !isObject(environmentAfter) ||
    !isObject(registryAfter) ||
    !isObject(foundryAfter) ||
    !isObject(resourceGroupAfter) ||
    !isObject(appInsightsAfter) ||
    !isUserAssignedIdentity(imagePull.id) ||
    !isUserAssignedIdentity(runtime.id) ||
    imagePull.id !== imagePullIdentity ||
    runtime.id !== runtimeIdentity ||
    typeof expectedContainerAppId !== "string" ||
    appAfter.id !== expectedContainerAppId ||
    !isObject(appAfter.body?.properties) ||
    appAfter.body.properties.managedEnvironmentId !== environmentAfter?.id ||
    !isObject(priorApp?.output?.properties) ||
    typeof expectedFqdn !== "string" ||
    priorFqdn !== expectedFqdn ||
    typeof priorRevision !== "string" ||
    priorRevision !== priorRootRevision ||
    priorRevision !== revisionChange?.before ||
    !rootOutputsMatch ||
    typeof tableEndpoint !== "string" ||
    !/^https:\/\/[a-z0-9.-]+\.table\.core\.windows\.net\/$/.test(
      tableEndpoint,
    ) ||
    typeof foundryEndpoint !== "string" ||
    !/^https:\/\/[a-z0-9.-]+\.openai\.azure\.com\/?$/.test(foundryEndpoint) ||
    typeof registryAfter.login_server !== "string" ||
    !/^[a-z0-9.-]+\.azurecr\.io$/.test(registryAfter.login_server) ||
    typeof defaultDomain !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.azurecontainerapps\.io$/.test(
      defaultDomain,
    ) ||
    !isObject(appInsightsConnection)
  ) {
    return undefined;
  }
  return {
    imagePullPrincipal: imagePull.principal_id,
    imagePullClient: imagePull.client_id,
    runtimePrincipal: runtime.principal_id,
    runtimeClient: runtime.client_id,
    tenant: runtime.tenant_id,
    cliPrincipal: cli,
    operatorPrincipal,
    imagePullIdentity,
    runtimeIdentity,
    resourceGroupId: resourceGroupAfter.id,
    resourceGroupName: resourceGroupAfter.name,
    containerAppId: expectedContainerAppId,
    containerAppName: appAfter.name,
    containerEnvironmentId: environmentAfter.id,
    containerEnvironmentName: environmentAfter.name,
    defaultDomain,
    relayOrigin,
    tableEndpoint: tableEndpoint.replace(/\/$/, ""),
    workloadTableEndpoint: tableEndpoint,
    foundryEndpoint: foundryEndpoint.replace(/\/$/, ""),
    acrLoginServer: registryAfter.login_server,
    appInsightsId: appInsightsAfter.id,
    appInsightsName: appInsightsAfter.name,
    appInsightsConnection,
  };
}

function cutoverExpectedRole(address, context) {
  const legacyAddress =
    address === CUTOVER_RUNTIME_SECRETS_USER
      ? "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user"
      : address;
  const contract = finalExpectedRole(legacyAddress, context);
  if (
    contract &&
    legacyAddress === FINAL_MONITORING_ROLE_ASSIGNMENT &&
    context.appInsightsId !== undefined
  ) {
    return {
      ...contract,
      scope: context.appInsightsId,
      nameInput: `scope=${context.appInsightsId}|principal_id=${context.runtimePrincipal}|role_definition_id=${contract.role}`,
    };
  }
  return contract;
}

function cutoverExactRoleChange(entry, context, action) {
  const contract = cutoverExpectedRole(entry.address, context);
  if (!contract || !cutoverExactResourceChange(entry.change)) return false;
  const after = entry.change.after;
  const before = entry.change.before;
  const expectedName = uuidV5Url(contract.nameInput);
  const expected = {
    name: expectedName,
    principal_id: contract.principal,
    principal_type: contract.principalType,
    role_definition_id: contract.role,
    scope: contract.scope,
  };
  const shape = (value) =>
    isObject(value) &&
    Object.entries(expected).every(([key, valuePart]) => value[key] === valuePart) &&
    finalExactKeys(value, [
      "condition",
      "condition_version",
      "delegated_managed_identity_resource_id",
      "description",
      "id",
      "name",
      "principal_id",
      "principal_type",
      "role_definition_id",
      "role_definition_name",
      "scope",
      "skip_service_principal_aad_check",
      "timeouts",
    ]) &&
    value.condition === "" &&
    value.condition_version === "" &&
    value.delegated_managed_identity_resource_id === "" &&
    value.description === "" &&
    value.id === finalRoleId(contract.scope, expectedName) &&
    value.role_definition_name === contract.roleName &&
    value.skip_service_principal_aad_check === null &&
    value.timeouts === null;
  if (action === "delete") {
    return (
      isDeepStrictEqual(entry.change.actions, ["delete"]) &&
      shape(before) &&
      after === null &&
      isDeepStrictEqual(entry.change.after_unknown, {})
    );
  }
  return (
    action === "no-op" &&
    cutoverExactNoOp(entry.change, entry.address) &&
    shape(after)
  );
}

function cutoverExactIdentityChange(entry, context) {
  const isImagePull =
    entry.address ===
    "module.identities_rbac.azurerm_user_assigned_identity.image_pull";
  const isRuntime =
    entry.address ===
    "module.identities_rbac.azurerm_user_assigned_identity.runtime";
  const after = entry.change.after;
  const expectedName = isImagePull ? "image-pull" : "runtime";
  const expectedResourceName = `id-palancar-dev-${expectedName}`;
  const expectedId = isImagePull
    ? context.imagePullIdentity
    : context.runtimeIdentity;
  return (
    (isImagePull || isRuntime) &&
    cutoverExactNoOp(entry.change, entry.address) &&
    isObject(after) &&
    hasExactKeys(after, [
      "client_id",
      "id",
      "isolation_scope",
      "location",
      "name",
      "principal_id",
      "resource_group_name",
      "tags",
      "tenant_id",
      "timeouts",
    ]) &&
    after.id === expectedId &&
    after.id.endsWith(`/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${expectedResourceName}`) &&
    after.location === "eastus2" &&
    after.name === expectedResourceName &&
    after.resource_group_name === FINAL_RESOURCE_GROUP_NAME &&
    after.isolation_scope === "" &&
    after.timeouts === null &&
    hasExactFinalTags(after.tags) &&
    after.tenant_id === context.tenant &&
    after.client_id ===
      (isImagePull ? context.imagePullClient : context.runtimeClient) &&
    after.principal_id ===
      (isImagePull ? context.imagePullPrincipal : context.runtimePrincipal)
  );
}

function cutoverHasExactContainerAppControlFields(value) {
  return (
    isObject(value) &&
    CUTOVER_CONTAINER_APP_CONTROL_KEYS.every(
      (key) =>
        Object.hasOwn(value, key) &&
        isDeepStrictEqual(value[key], CUTOVER_CONTAINER_APP_CONTROL_FIELDS[key]),
    )
  );
}

function cutoverExactDirectApp(
  after,
  expectedImage,
  context,
  { update = false, omitProbes = false } = {},
) {
  const properties = after?.body?.properties;
  const configuration = properties?.configuration;
  const template = properties?.template;
  const containers = template?.containers;
  const container = containers?.[0];
  const identity = after?.identity?.[0];
  const identityIds = identity?.identity_ids;
  const settings = configuration?.identitySettings;
  const env = valuesByName(container?.env);
  const expectedKeys = [
    "body",
    "create_headers",
    "create_query_parameters",
    "delete_headers",
    "delete_query_parameters",
    "id",
    "identity",
    "ignore_body_changes",
    "ignore_casing",
    "ignore_missing_property",
    "ignore_null_property",
    "ignore_other_items_in_list",
    "list_unique_id_property",
    "location",
    "locks",
    "name",
    "parent_id",
    "read_headers",
    "read_query_parameters",
    "replace_triggers_external_values",
    "replace_triggers_refs",
    "response_export_values",
    "retry",
    "schema_validation_enabled",
    "sensitive_body",
    "sensitive_body_version",
    "tags",
    "timeouts",
    "type",
    "update_headers",
    "update_query_parameters",
    ...(update ? [] : ["output"]),
  ];
  const expectedEnvironment = new Map([
    ["NODE_ENV", "production"],
    ["PORT", "8787"],
    ["PALANCAR_GENERATION_PROVIDER", "azure-openai"],
    ["PALANCAR_AZURE_GENERATION_ENDPOINT", context.foundryEndpoint],
    ["PALANCAR_AZURE_GENERATION_DEPLOYMENT", LUNA_DEPLOYMENT_NAME],
    ["PALANCAR_RELAY_BIND_HOST", "0.0.0.0"],
    ["PALANCAR_RELAY_ENVIRONMENT", "dev"],
    ["PALANCAR_RELAY_ORIGIN", context.relayOrigin],
    ["PALANCAR_GATE_POLICY_VERSION", "1.0.0"],
    ["AZURE_CLIENT_ID", context.runtimeClient],
    ["PALANCAR_DEPLOYMENT_SLOT", "dev"],
    [
      "APPLICATIONINSIGHTS_CONNECTION_STRING",
      context.appInsightsConnection.relay,
    ],
    ["APPLICATIONINSIGHTS_STATSBEAT_DISABLED", "true"],
    ["APPLICATION_INSIGHTS_NO_STATSBEAT", "true"],
    ["PALANCAR_SECURITY_MODE", "azure-table"],
    ["PALANCAR_WORKLOAD_TABLE_ENDPOINT", context.tableEndpoint],
    ["PALANCAR_SECURITY_STATE_TABLE", "SecurityState"],
    ["PALANCAR_RATE_STATE_TABLE", "RateState"],
    ["PALANCAR_TRANSCRIPTION_PROVIDER", "azure-realtime"],
    [
      "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT",
      `${context.foundryEndpoint.replace("https://", "wss://")}/openai/v1/realtime?intent=transcription`,
    ],
    ["PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT", PINNED_DEPLOYMENT_NAME],
    [
      "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
      JSON.stringify([EXPECTED_BROWSER_ALLOWED_ORIGINS]),
    ],
    ["PALANCAR_ALLOW_NULL_BROWSER_ORIGIN", "false"],
    ["PALANCAR_LANGUAGE_BOUNDARY_MODE", EXPECTED_LANGUAGE_BOUNDARY_MODE],
  ]);
  const probesMatch =
    update ||
    (omitProbes && !Object.hasOwn(container ?? {}, "probes")) ||
    (Array.isArray(container?.probes) &&
      container.probes.length === 2 &&
      hasExactFinalTcpProbe(container.probes[0], {
        type: "Liveness",
        port: 8787,
        initialDelaySeconds: 10,
        periodSeconds: 10,
        timeoutSeconds: 3,
        failureThreshold: 3,
      }) &&
      hasExactProbes(container.probes.slice(1), [
        {
          type: "Readiness",
          path: "/readyz",
          port: 8787,
          initialDelaySeconds: 5,
          periodSeconds: 10,
          timeoutSeconds: 7,
          failureThreshold: 3,
        },
      ]));
  return (
    isObject(after) &&
    hasExactKeys(after, expectedKeys) &&
    cutoverHasExactContainerAppControlFields(after) &&
    after.id ===
      `${context.resourceGroupId}/providers/Microsoft.App/containerApps/${FINAL_CONTAINER_APP_NAME}` &&
    after.location === "eastus2" &&
    after.name === FINAL_CONTAINER_APP_NAME &&
    after.parent_id === context.resourceGroupId &&
    after.type === "Microsoft.App/containerApps@2026-01-01" &&
    hasExactFinalTags(after.tags) &&
    isObject(after.body) &&
    hasExactKeys(after.body, ["properties"]) &&
    isObject(properties) &&
    hasExactKeys(properties, ["configuration", "managedEnvironmentId", "template"]) &&
    properties.managedEnvironmentId === context.containerEnvironmentId &&
    hasExactKeys(configuration, [
      "activeRevisionsMode",
      "identitySettings",
      "ingress",
      "maxInactiveRevisions",
      "registries",
      "secrets",
    ]) &&
    configuration.activeRevisionsMode === "Single" &&
    configuration.maxInactiveRevisions === 1 &&
    hasExactIngress(configuration.ingress) &&
    Array.isArray(configuration.secrets) &&
    configuration.secrets.length === 0 &&
    Array.isArray(configuration.registries) &&
    configuration.registries.length === 1 &&
    configuration.registries.every((registry) =>
      hasExactKeys(registry, ["identity", "server"]),
    ) &&
    isUserAssignedIdentity(configuration.registries[0].identity) &&
    configuration.registries[0].server === context.acrLoginServer &&
    Array.isArray(after.identity) &&
    after.identity.length === 1 &&
    hasExactKeys(identity, ["identity_ids", "principal_id", "tenant_id", "type"]) &&
    identity?.type === "UserAssigned" &&
    identity?.principal_id === "" &&
    identity?.tenant_id === "" &&
    cutoverHasExactIdentitySet(
      identityIds,
      context.imagePullIdentity,
      context.runtimeIdentity,
    ) &&
    configuration.registries[0].identity === context.imagePullIdentity &&
    Array.isArray(settings) &&
    settings.length === 2 &&
    settings.every((setting) => hasExactKeys(setting, ["identity", "lifecycle"])) &&
    settings[0]?.identity === context.imagePullIdentity.replace("resourceGroups", "resourcegroups") &&
    settings[0]?.lifecycle === "None" &&
    settings[1]?.identity === context.runtimeIdentity.replace("resourceGroups", "resourcegroups") &&
    settings[1]?.lifecycle === "Main" &&
    Array.isArray(containers) &&
    containers.length === 1 &&
    hasExactKeys(template, ["containers", "scale"]) &&
    hasExactKeys(
      container,
      update || omitProbes
        ? ["env", "image", "name", "resources"]
        : ["env", "image", "name", "probes", "resources"],
    ) &&
    container.name === "relay" &&
    container.image === expectedImage &&
    isImmutableAcrImage(container.image) &&
    container.image.startsWith(`${context.acrLoginServer}/palancar-relay@sha256:`) &&
    hasExactKeys(container.resources, ["cpu", "memory"]) &&
    container.resources.cpu === 0.25 &&
    container.resources.memory === "0.5Gi" &&
    probesMatch &&
    hasExactKeys(template.scale, ["maxReplicas", "minReplicas"]) &&
    template.scale.maxReplicas === 1 &&
    template.scale.minReplicas === 1 &&
    hasExactNamedEntries(env, CUTOVER_RUNTIME_ENVIRONMENT_NAMES) &&
    [...env.values()].every((entry) => hasExactKeys(entry, ["name", "value"])) &&
    [...expectedEnvironment].every(([name, value]) => hasEnvValue(env, name, value)) &&
    !containsHelperTopology(after) &&
    (update
      ? !Object.hasOwn(after, "output")
      : finalHasExactContainerAppProviderOutput(
          after.output,
          context.defaultDomain,
          after.name,
        ))
  );
}

function cutoverExactPredecessorApp(before, context, predecessorImage) {
  const properties = before?.body?.properties;
  const configuration = properties?.configuration;
  const template = properties?.template;
  const containers = template?.containers;
  const identity = before?.identity?.[0];
  const identityIds = identity?.identity_ids;
  const relay = containers?.[0];
  const sidecar = containers?.[1];
  const secrets = valuesByName(configuration?.secrets);
  return (
    isObject(before) &&
    hasExactKeys(before, [
      "body",
      "create_headers",
      "create_query_parameters",
      "delete_headers",
      "delete_query_parameters",
      "id",
      "identity",
      "ignore_body_changes",
      "ignore_casing",
      "ignore_missing_property",
      "ignore_null_property",
      "ignore_other_items_in_list",
      "list_unique_id_property",
      "location",
      "locks",
      "name",
      "output",
      "parent_id",
      "read_headers",
      "read_query_parameters",
      "replace_triggers_external_values",
      "replace_triggers_refs",
      "response_export_values",
      "retry",
      "schema_validation_enabled",
      "sensitive_body",
      "sensitive_body_version",
      "tags",
      "timeouts",
      "type",
      "update_headers",
      "update_query_parameters",
    ]) &&
    cutoverHasExactContainerAppControlFields(before) &&
    before.id ===
      `${context.resourceGroupId}/providers/Microsoft.App/containerApps/${FINAL_CONTAINER_APP_NAME}` &&
    before.location === "eastus2" &&
    before.name === FINAL_CONTAINER_APP_NAME &&
    before.parent_id === context.resourceGroupId &&
    before.type === "Microsoft.App/containerApps@2026-01-01" &&
    hasExactFinalTags(before.tags) &&
    isObject(before.body) &&
    hasExactKeys(before.body, ["properties"]) &&
    isObject(properties) &&
    hasExactKeys(properties, ["configuration", "managedEnvironmentId", "template"]) &&
    properties.managedEnvironmentId === context.containerEnvironmentId &&
    hasExactKeys(configuration, [
      "activeRevisionsMode",
      "identitySettings",
      "ingress",
      "registries",
      "secrets",
    ]) &&
    configuration.activeRevisionsMode === "Single" &&
    hasExactIngress(configuration.ingress) &&
    Array.isArray(before.identity) &&
    before.identity.length === 1 &&
    hasExactKeys(identity, ["identity_ids", "principal_id", "tenant_id", "type"]) &&
    identity.type === "UserAssigned" &&
    cutoverHasExactIdentitySet(
      identityIds,
      context.imagePullIdentity,
      context.runtimeIdentity,
    ) &&
    Array.isArray(configuration.registries) &&
    configuration.registries.length === 1 &&
    configuration.registries.every((registry) =>
      hasExactKeys(registry, ["identity", "server"]),
    ) &&
    configuration.registries[0].identity === context.imagePullIdentity &&
    configuration.registries[0].server === context.acrLoginServer &&
    Array.isArray(configuration.identitySettings) &&
    configuration.identitySettings.length === 2 &&
    configuration.identitySettings.every((setting) =>
      hasExactKeys(setting, ["identity", "lifecycle"]),
    ) &&
    configuration.identitySettings[0].identity === context.imagePullIdentity.replace("resourceGroups", "resourcegroups") &&
    configuration.identitySettings[0].lifecycle === "None" &&
    configuration.identitySettings[1].identity === context.runtimeIdentity.replace("resourceGroups", "resourcegroups") &&
    configuration.identitySettings[1].lifecycle === "Main" &&
    hasExactNamedEntries(secrets, ["litellm-master-key", "openrouter-api-key"]) &&
    [...secrets.values()].every((secret) =>
      hasExactKeys(secret, ["name", "keyVaultUrl", "identity"]),
    ) &&
    secrets.get("litellm-master-key").identity === context.runtimeIdentity &&
    secrets.get("openrouter-api-key").identity === context.runtimeIdentity &&
    secrets.get("litellm-master-key").keyVaultUrl === `https://${FINAL_KEY_VAULT_HOST}/secrets/litellm-master-key` &&
    secrets.get("openrouter-api-key").keyVaultUrl === `https://${FINAL_KEY_VAULT_HOST}/secrets/openrouter-api-key` &&
    Array.isArray(containers) &&
    containers.length === 2 &&
    hasExactKeys(template, ["containers", "scale"]) &&
    hasExactKeys(relay, ["env", "image", "name", "probes", "resources"]) &&
    hasExactKeys(sidecar, ["env", "image", "name", "probes", "resources"]) &&
    relay.name === "relay" &&
    sidecar.name === "litellm" &&
    relay.image === predecessorImage &&
    isImmutableAcrImage(predecessorImage) &&
    predecessorImage.startsWith(`${context.acrLoginServer}/palancar-relay@sha256:`) &&
    isImmutableAcrImage(sidecar.image) &&
    sidecar.image.startsWith(`${CUTOVER_ACR_LOGIN_SERVER}/palancar-litellm-proxy@sha256:`) &&
    relay.resources.cpu === 0.25 &&
    relay.resources.memory === "0.5Gi" &&
    hasExactKeys(relay.resources, ["cpu", "memory"]) &&
    sidecar.resources.cpu === 0.75 &&
    sidecar.resources.memory === "1.5Gi" &&
    hasExactKeys(sidecar.resources, ["cpu", "memory"]) &&
    Array.isArray(relay.probes) &&
    relay.probes.length === 2 &&
    hasExactFinalTcpProbe(relay.probes[0], {
      type: "Liveness",
      port: 8787,
      initialDelaySeconds: 10,
      periodSeconds: 10,
      timeoutSeconds: 3,
      failureThreshold: 3,
    }) &&
    hasExactProbes(relay.probes.slice(1), [
      {
        type: "Readiness",
        path: "/readyz",
        port: 8787,
        initialDelaySeconds: 5,
        periodSeconds: 10,
        timeoutSeconds: 7,
        failureThreshold: 3,
      },
    ]) &&
    Array.isArray(sidecar.probes) &&
    sidecar.probes.length === 3 &&
    hasExactFinalTcpProbe(sidecar.probes[0], {
      type: "Liveness",
      port: 4000,
      initialDelaySeconds: 10,
      periodSeconds: 30,
      timeoutSeconds: 3,
      failureThreshold: 3,
    }) &&
    hasExactProbes(sidecar.probes.slice(1), [
      {
        type: "Readiness",
        path: "/health/readiness",
        port: 4000,
        periodSeconds: 10,
        timeoutSeconds: 7,
        failureThreshold: 3,
      },
      {
        type: "Startup",
        path: "/health/liveliness",
        port: 4000,
        periodSeconds: 10,
        timeoutSeconds: 3,
        failureThreshold: 10,
      },
    ]) &&
    hasExactKeys(template.scale, ["maxReplicas", "minReplicas"]) &&
    template.scale.maxReplicas === 1 &&
    template.scale.minReplicas === 1 &&
    hasExactFinalRelayEnvironment(relay.env, context.runtimeClient, {
      relayConnection: context.appInsightsConnection.relay,
      tableEndpoint: context.tableEndpoint,
      relayOrigin: context.relayOrigin,
      transcriptionEndpoint: `${context.foundryEndpoint.replace(
        "https://",
        "wss://",
      )}/openai/v1/realtime?intent=transcription`,
    }) &&
    hasExactFinalSidecarEnvironment(sidecar.env)
    &&
    finalHasExactContainerAppProviderOutput(
      before.output,
      context.defaultDomain,
      before.name,
    )
  );
}

function cutoverExactCleanupImage(after, expectedImage, acrLoginServer = CUTOVER_ACR_LOGIN_SERVER) {
  const image = after?.body?.properties?.template?.containers?.[0]?.image;
  return (
    typeof expectedImage === "string" &&
    isImmutableAcrImage(expectedImage) &&
    expectedImage.startsWith(`${acrLoginServer}/palancar-expiry-cleanup@sha256:`) &&
    image === expectedImage
  );
}

function cutoverParseStorageConnectionString(value, blob) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const expectedKeys = blob
    ? ["DefaultEndpointsProtocol", "BlobEndpoint", "AccountName", "AccountKey"]
    : ["DefaultEndpointsProtocol", "AccountName", "AccountKey", "EndpointSuffix"];
  const segments = value.split(";");
  if (
    segments.length !== expectedKeys.length ||
    segments.some((segment, index) => {
      const separator = segment.indexOf("=");
      return (
        separator <= 0 ||
        segment.slice(0, separator) !== expectedKeys[index] ||
        segment.slice(separator + 1).length === 0
      );
    })
  ) {
    return undefined;
  }
  return Object.fromEntries(
    segments.map((segment) => {
      const separator = segment.indexOf("=");
      return [segment.slice(0, separator), segment.slice(separator + 1)];
    }),
  );
}

function cutoverSensitiveStorageContract(storage, referenceStorage) {
  if (!isObject(storage) || !isObject(referenceStorage)) return false;
  const keys = [
    "primary_access_key",
    "secondary_access_key",
    "primary_connection_string",
    "secondary_connection_string",
    "primary_blob_connection_string",
    "secondary_blob_connection_string",
  ];
  const rebound = keys.some((key) => storage[key] !== referenceStorage[key]);
  if (!rebound) return true;

  const primaryKey = storage.primary_access_key;
  const secondaryKey = storage.secondary_access_key;
  if (
    typeof storage.name !== "string" ||
    !/^[a-z0-9]{3,24}$/.test(storage.name) ||
    ![primaryKey, secondaryKey].every(
      (key) => typeof key === "string" && /^[A-Za-z0-9+/]{86}==$/.test(key),
    )
  ) {
    return false;
  }

  const expected = (key, blob) => ({
    DefaultEndpointsProtocol: "https",
    ...(blob
      ? { BlobEndpoint: `https://${storage.name}.blob.core.windows.net/` }
      : {}),
    AccountName: storage.name,
    AccountKey: key,
    ...(blob ? {} : { EndpointSuffix: "core.windows.net" }),
  });
  for (const [prefix, accessKey] of [
    ["primary", primaryKey],
    ["secondary", secondaryKey],
  ]) {
    for (const suffix of ["connection_string", "blob_connection_string"]) {
      const value = storage[`${prefix}_${suffix}`];
      if (prefix === "secondary" && suffix === "blob_connection_string" && value === "") {
        continue;
      }
      const parsed = cutoverParseStorageConnectionString(
        value,
        suffix.startsWith("blob_"),
      );
      if (!isDeepStrictEqual(parsed, expected(accessKey, suffix.startsWith("blob_")))) {
        return false;
      }
    }
  }
  return true;
}

function cutoverVariablesMatchReference(plan) {
  const rebound = new Set([
    "budget_contact_emails",
    "operator_principal_id",
    "tenant_id",
    "relay_image_digest",
    "expiry_cleanup_image_digest",
  ]);
  const result = Object.entries(TERMINAL_REFERENCE_PLAN.variables).every(
    ([name, reference]) => {
      const descriptor = plan.variables[name];
      if (!isObject(descriptor) || !Object.hasOwn(descriptor, "value")) {
        return false;
      }
      if (name === "enable_runtime_secrets_user_assignment") {
        return typeof descriptor.value === "boolean";
      }
      if (rebound.has(name)) {
        const reboundMatch = name === "budget_contact_emails"
          ? Array.isArray(descriptor.value)
          : name === "operator_principal_id" || name === "tenant_id"
          ? finalUuid(descriptor.value)
          : (
          isImmutableAcrImage(descriptor.value) &&
          descriptor.value.startsWith(
            `${CUTOVER_ACR_LOGIN_SERVER}/${name === "relay_image_digest" ? "palancar-relay" : "palancar-expiry-cleanup"}@sha256:`,
          )
          );
        return reboundMatch;
      }
      return isDeepStrictEqual(descriptor, reference);
    },
  );
  const contacts = plan.variables.budget_contact_emails?.value;
  const operator = plan.variables.operator_principal_id?.value;
  return (
    result &&
    Array.isArray(contacts) &&
    contacts.length > 0 &&
    new Set(contacts).size === contacts.length &&
    contacts.every(
      (email) =>
        typeof email === "string" &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    ) &&
    finalUuid(operator) &&
    operator !== "00000000-0000-0000-0000-000000000000"
  );
}

function cutoverPlanForForbiddenMetadata(plan, mode) {
  if (mode !== AZURE_CREDENTIAL_CLEANUP_MODE) return plan;

  const resourceChanges = plan?.resource_changes;
  if (!Array.isArray(resourceChanges)) return plan;
  const targetIndex = resourceChanges.findIndex(
    (entry) =>
      isObject(entry) && entry.address === CUTOVER_RUNTIME_SECRETS_USER,
  );
  if (targetIndex === -1) return plan;

  const target = resourceChanges[targetIndex];
  if (!Object.hasOwn(target, "action_reason")) return plan;
  if (
    target.action_reason !==
    CUTOVER_CREDENTIAL_CLEANUP_BENIGN_ACTION_REASON
  ) {
    return undefined;
  }

  const targetWithoutActionReason = { ...target };
  delete targetWithoutActionReason.action_reason;
  const resourceChangesWithoutActionReason = resourceChanges.slice();
  resourceChangesWithoutActionReason[targetIndex] = targetWithoutActionReason;
  return {
    ...plan,
    resource_changes: resourceChangesWithoutActionReason,
  };
}

function cutoverStateSections(plan, mode, expectedEnable, expectedApplyable) {
  const planForMetadata = cutoverPlanForForbiddenMetadata(plan, mode);
  if (
    !cutoverExactPlanEnvelope(planForMetadata, expectedApplyable) ||
    !cutoverHasExactStateEnvelopes(plan) ||
    !hasExactKeys(
      plan.variables,
      Object.keys(TERMINAL_REFERENCE_PLAN.variables),
    ) ||
    plan.variables.enable_runtime_secrets_user_assignment?.value !==
      expectedEnable ||
    !hasExactKeys(plan.variables.enable_runtime_secrets_user_assignment, ["value"]) ||
    !cutoverVariablesMatchReference(plan) ||
    !cutoverHasExactChecks(plan) ||
    !cutoverHasExactRelevantAttributes(plan, mode) ||
    !cutoverHasNoRetiredWorkloadDependencies(
      TERMINAL_REFERENCE_PLAN.configuration,
    ) ||
    !cutoverHasNoRetiredWorkloadDependencies(plan.configuration) ||
    !cutoverHasExactConfiguration(plan) ||
    Object.keys(plan.variables).some((name) => /litellm|openrouter/i.test(name)) ||
    JSON.stringify(plan.configuration).match(/litellm|openrouter/i) ||
    !plan.checks.every((check) => check?.status === "pass") ||
    hasNonPassingCheck(plan)
  ) {
    return false;
  }
  return true;
}

function cutoverAddBinding(bindings, reference, actual) {
  if (
    typeof reference !== "string" ||
    typeof actual !== "string" ||
    reference.length === 0
  ) return;
  if (reference === actual) return;
  if (!bindings.some(([source]) => source === reference)) {
    bindings.push([reference, actual]);
  }
}

function cutoverAddPathBinding(bindings, reference, actual, path) {
  let expected = reference;
  let observed = actual;
  for (const part of path) {
    expected = expected?.[part];
    observed = observed?.[part];
  }
  cutoverAddBinding(bindings, expected, observed);
}

function cutoverBindings(plan, changesByAddress) {
  const bindings = [];
  const referenceVariables = TERMINAL_REFERENCE_PLAN.variables;
  for (const name of [
    "subscription_id",
    "tenant_id",
    "operator_principal_id",
    "relay_image_digest",
    "expiry_cleanup_image_digest",
  ]) {
    cutoverAddBinding(
      bindings,
      referenceVariables[name]?.value,
      plan.variables[name]?.value,
    );
  }
  const referenceContacts = referenceVariables.budget_contact_emails?.value;
  const contacts = plan.variables.budget_contact_emails?.value;
  if (Array.isArray(referenceContacts) && Array.isArray(contacts)) {
    referenceContacts.forEach((email, index) =>
      cutoverAddBinding(bindings, email, contacts[index]),
    );
  }

  for (const address of CUTOVER_IDENTITY_ADDRESSES) {
    const reference = TERMINAL_REFERENCE_PLAN.resource_changes.find(
      (entry) => entry.address === address,
    )?.change.after;
    const actual = changesByAddress.get(address)?.change.after;
    for (const key of ["id", "principal_id", "client_id", "tenant_id"]) {
      cutoverAddBinding(bindings, reference?.[key], actual?.[key]);
      if (key === "id") {
        cutoverAddBinding(
          bindings,
          reference?.[key]?.replace("/resourceGroups/", "/resourcegroups/"),
          actual?.[key]?.replace("/resourceGroups/", "/resourcegroups/"),
        );
      }
    }
  }

  for (const referenceEntry of TERMINAL_REFERENCE_PLAN.resource_changes) {
    if (referenceEntry.type !== "azurerm_role_assignment") continue;
    const actualEntry = changesByAddress.get(referenceEntry.address);
    cutoverAddBinding(
      bindings,
      referenceEntry.change.after?.id,
      actualEntry?.change.after?.id,
    );
  }

  const referenceAppInsights = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (entry) =>
      entry.address ===
      "module.observability.azurerm_application_insights.this",
  )?.change.after;
  const appInsights = changesByAddress.get(
    "module.observability.azurerm_application_insights.this",
  )?.change.after;
  // Provider-generated Application Insights secrets are matched through their
  // exact sensitivity masks below.  They are deliberately not global string
  // bindings: an identical fixture literal in an unmasked location must not
  // acquire live meaning by substitution.
  for (const key of ["id", "app_id"]) {
    cutoverAddBinding(bindings, referenceAppInsights?.[key], appInsights?.[key]);
  }

  const referenceEnvironment = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (entry) =>
      entry.address ===
      "module.container_app_environment.azurerm_container_app_environment.this",
  )?.change.after;
  const environment = changesByAddress.get(
    "module.container_app_environment.azurerm_container_app_environment.this",
  )?.change.after;
  cutoverAddBinding(bindings, referenceEnvironment?.id, environment?.id);
  cutoverAddBinding(
    bindings,
    referenceEnvironment?.default_domain,
    environment?.default_domain,
  );

  const referenceStorage = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (entry) => entry.address === "module.workload_state.azurerm_storage_account.this",
  )?.change.after;
  const storage = changesByAddress.get(
    "module.workload_state.azurerm_storage_account.this",
  )?.change.after;
  for (const key of ["id", "primary_table_endpoint", "primary_table_host"]) {
    cutoverAddBinding(bindings, referenceStorage?.[key], storage?.[key]);
  }

  const referenceFoundry = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (entry) => entry.address === "module.foundry.azurerm_cognitive_account.this",
  )?.change.after;
  const foundry = changesByAddress.get(
    "module.foundry.azurerm_cognitive_account.this",
  )?.change.after;
  for (const key of ["id", "endpoint"]) {
    cutoverAddBinding(bindings, referenceFoundry?.[key], foundry?.[key]);
  }
  cutoverAddPathBinding(
    bindings,
    referenceFoundry,
    foundry,
    ["identity", 0, "principal_id"],
  );
  for (const name of [PINNED_DEPLOYMENT_NAME, LUNA_DEPLOYMENT_NAME]) {
    const address =
      `module.foundry.azurerm_cognitive_deployment.this["${name}"]`;
    const referenceModel = TERMINAL_REFERENCE_PLAN.resource_changes.find(
      (entry) => entry.address === address,
    )?.change.after;
    const actualModel = changesByAddress.get(address)?.change.after;
    for (const key of ["id", "rai_policy_name"]) {
      cutoverAddBinding(bindings, referenceModel?.[key], actualModel?.[key]);
    }
    for (const key of ["family", "size", "tier"]) {
      cutoverAddPathBinding(
        bindings,
        referenceModel,
        actualModel,
        ["sku", 0, key],
      );
    }
  }

  const referenceApp = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (entry) => entry.address === CUTOVER_CONTAINER_APP,
  )?.change.after;
  const referenceAppBefore = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (entry) => entry.address === CUTOVER_CONTAINER_APP,
  )?.change.before;
  const app = changesByAddress.get(CUTOVER_CONTAINER_APP)?.change.after;
  const appBefore = changesByAddress.get(CUTOVER_CONTAINER_APP)?.change.before;
  for (const key of ["id", "name", "parent_id"]) {
    cutoverAddBinding(bindings, referenceApp?.[key], app?.[key]);
  }
  cutoverAddPathBinding(
    bindings,
    referenceAppBefore,
    appBefore,
    ["output", "properties", "latestRevisionName"],
  );
  cutoverAddPathBinding(
    bindings,
    referenceAppBefore,
    appBefore,
    ["output", "properties", "configuration", "ingress", "fqdn"],
  );
  const referenceRevision =
    TERMINAL_REFERENCE_PLAN.output_changes.relay_latest_revision_name?.before;
  const generationReferenceRevision =
    CUTOVER_GENERATION_REFERENCE_PLAN.output_changes.relay_latest_revision_name?.before;
  const actualRevision = plan.output_changes.relay_latest_revision_name?.before;
  cutoverAddBinding(bindings, referenceRevision, actualRevision);
  cutoverAddBinding(bindings, generationReferenceRevision, actualRevision);

  const referenceJob = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (entry) => entry.address === EXPIRY_CLEANUP_JOB,
  )?.change.after;
  const job = changesByAddress.get(EXPIRY_CLEANUP_JOB)?.change.after;
  for (const key of ["id", "name", "parent_id"]) {
    cutoverAddBinding(bindings, referenceJob?.[key], job?.[key]);
  }
  cutoverAddPathBinding(
    bindings,
    referenceJob,
    job,
    ["output", "eventStreamEndpoint"],
  );
  cutoverAddPathBinding(
    bindings,
    referenceJob,
    job,
    ["output", "properties", "outboundIpAddresses", 0],
  );

  return bindings.sort((left, right) => right[0].length - left[0].length);
}

function cutoverRebindReference(value, bindings) {
  if (typeof value === "string") {
    return bindings.reduce(
      (result, [reference, actual]) => result.replaceAll(reference, actual),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cutoverRebindReference(entry, bindings));
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        cutoverRebindReference(key, bindings),
        cutoverRebindReference(child, bindings),
      ]),
    );
  }
  return value;
}

function cutoverSensitiveMaskChild(mask, key) {
  if (Array.isArray(mask)) return mask[key] ?? false;
  if (isObject(mask)) return mask[key] ?? false;
  return false;
}

function cutoverOpaqueSensitiveLeafMatches(actual, reference) {
  if (isDeepStrictEqual(actual, reference)) return true;
  if (typeof actual !== typeof reference) return false;
  if (typeof reference === "string") {
    return actual.length > 0;
  }
  return false;
}

function cutoverSensitiveMaskValuesValid(actual, reference, sensitive) {
  if (sensitive === true) {
    return cutoverOpaqueSensitiveLeafMatches(actual, reference);
  }
  if (Array.isArray(sensitive)) {
    if (!sensitive.some(cutoverSensitiveMaskHasMarkedValue)) return true;
    return (
      Array.isArray(actual) &&
      actual.length === sensitive.length &&
      sensitive.every((child, index) =>
        cutoverSensitiveMaskValuesValid(actual[index], reference?.[index], child),
      )
    );
  }
  if (isObject(sensitive)) {
    if (!Object.values(sensitive).some(cutoverSensitiveMaskHasMarkedValue)) {
      return true;
    }
    return (
      isObject(actual) &&
      Object.entries(sensitive).every(([key, child]) =>
        Object.hasOwn(actual, key) &&
        cutoverSensitiveMaskValuesValid(actual[key], reference?.[key], child),
      )
    );
  }
  return true;
}

function cutoverSensitiveMaskHasMarkedValue(mask) {
  if (mask === true) return true;
  if (Array.isArray(mask)) return mask.some(cutoverSensitiveMaskHasMarkedValue);
  if (isObject(mask)) {
    return Object.values(mask).some(cutoverSensitiveMaskHasMarkedValue);
  }
  return false;
}

function cutoverSensitiveMaskMatches(
  actualValue,
  referenceValue,
  actualMask,
  referenceMask,
  bindings,
) {
  if (referenceMask === true) {
    return (
      actualMask === true &&
      actualValue !== undefined &&
      cutoverOpaqueSensitiveLeafMatches(
        actualValue,
        cutoverRebindReference(referenceValue, bindings),
      )
    );
  }
  if (referenceMask === false) {
    return actualMask === undefined || actualMask === false;
  }
  if (Array.isArray(referenceMask)) {
    if (actualMask === undefined) {
      return !cutoverSensitiveMaskHasMarkedValue(referenceMask);
    }
    return (
      Array.isArray(actualMask) &&
      actualMask.length === referenceMask.length &&
      referenceMask.every((child, index) =>
        cutoverSensitiveMaskMatches(
          actualValue?.[index],
          referenceValue?.[index],
          actualMask[index],
          child,
          bindings,
        ),
      )
    );
  }
  if (isObject(referenceMask)) {
    if (actualMask === undefined) {
      return !cutoverSensitiveMaskHasMarkedValue(referenceMask);
    }
    if (!isObject(actualMask)) return false;
    if (
      Object.keys(actualMask).some((key) =>
        !Object.hasOwn(referenceMask, key),
      )
    ) return false;
    return Object.entries(referenceMask).every(([key, child]) =>
      cutoverSensitiveMaskMatches(
        actualValue?.[key],
        referenceValue?.[key],
        actualMask[key],
        child,
        bindings,
      ),
    );
  }
  return false;
}

function cutoverSensitiveStructureMatches(
  actual,
  reference,
  sensitive,
  bindings,
  address,
  path = [],
) {
  if (sensitive === true) {
    return cutoverOpaqueSensitiveLeafMatches(actual, reference);
  }
  if (Array.isArray(reference)) {
    if (cutoverIsUnorderedIdentityIdsPath(address, path)) {
      const expected = reference.map((identity) =>
        cutoverRebindReference(identity, bindings),
      );
      return cutoverExactUnorderedArrayEqual(actual, expected);
    }
    return (
      Array.isArray(actual) &&
      actual.length === reference.length &&
      reference.every((child, index) =>
        cutoverSensitiveStructureMatches(
          actual[index],
          child,
          cutoverSensitiveMaskChild(sensitive, index),
          bindings,
          address,
          [...path, index],
        ),
      )
    );
  }
  if (isObject(reference)) {
    if (!isObject(actual)) return false;
    const expectedKeys = Object.keys(reference).map((key) =>
      cutoverRebindReference(key, bindings),
    );
    return (
      new Set(expectedKeys).size === expectedKeys.length &&
      hasExactKeys(actual, expectedKeys) &&
      Object.entries(reference).every(([key, child], index) =>
        cutoverSensitiveStructureMatches(
          actual[expectedKeys[index]],
          child,
          cutoverSensitiveMaskChild(sensitive, key),
          bindings,
          address,
          [...path, key],
        ),
      )
    );
  }
  return isDeepStrictEqual(actual, cutoverRebindReference(reference, bindings));
}

function cutoverReferenceAfterMatches(
  actual,
  reference,
  bindings,
  address = reference?.address,
) {
  return (
    reference !== undefined &&
    cutoverSensitiveStructureMatches(
      actual,
      reference.change.after,
      reference.change.after_sensitive,
      bindings,
      address,
    )
  );
}

function cutoverExpectedSensitive(entry, bindings) {
  const address = entry.address;
  if (address === CUTOVER_RUNTIME_SECRETS_USER) {
    return {
      before: {},
      after: isDeepStrictEqual(entry.change.actions, ["delete"]) ? false : {},
    };
  }
  if (address === CUTOVER_CONTAINER_APP && isUpdate(entry.change.actions)) {
    const transition = FINAL_REFERENCE_PLAN.resource_changes.find(
      (candidate) => candidate.address === CUTOVER_CONTAINER_APP,
    )?.change;
    const terminal = TERMINAL_REFERENCE_PLAN.resource_changes.find(
      (candidate) => candidate.address === CUTOVER_CONTAINER_APP,
    )?.change;
    return {
      before: cutoverRebindReference(transition?.before_sensitive, bindings),
      after: cutoverRebindReference(terminal?.after_sensitive, bindings),
    };
  }
  const reference = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (candidate) => candidate.address === address,
  )?.change;
  return {
    before: cutoverRebindReference(reference?.before_sensitive, bindings),
    after: cutoverRebindReference(reference?.after_sensitive, bindings),
  };
}

function cutoverHasExactChangeEnvelope(
  entry,
  bindings,
  allowOmittedContainerAppProbes = false,
) {
  const expected = cutoverExpectedSensitive(entry, bindings);
  const reference = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (candidate) => candidate.address === entry.address,
  );
  const appUpdate =
    entry.address === CUTOVER_CONTAINER_APP &&
    isUpdate(entry.change.actions);
  const noOpAppWithOmittedProbes =
    allowOmittedContainerAppProbes &&
    entry.address === CUTOVER_CONTAINER_APP &&
    isNoOp(entry.change.actions) &&
    !Object.hasOwn(
      entry.change.after?.body?.properties?.template?.containers?.[0] ?? {},
      "probes",
    ) &&
    !Object.hasOwn(
      entry.change.before?.body?.properties?.template?.containers?.[0] ?? {},
      "probes",
    );
  const afterSensitiveMatches = appUpdate || noOpAppWithOmittedProbes
    ? cutoverSensitiveMaskMatches(
        entry.change.after,
        reference?.change?.after,
        entry.change.after_sensitive,
        expected.after,
        bindings,
      )
    : isDeepStrictEqual(entry.change.after_sensitive, expected.after);
  const unknownMatches = isDeepStrictEqual(
    entry.change.after_unknown,
    appUpdate
      ? CUTOVER_GENERATION_REFERENCE_PLAN.resource_changes.find(
          (candidate) => candidate.address === CUTOVER_CONTAINER_APP,
        )?.change.after_unknown
      : {},
  );
  const beforeSensitiveMatches = noOpAppWithOmittedProbes
    ? cutoverSensitiveMaskMatches(
        entry.change.before,
        reference?.change?.before,
        entry.change.before_sensitive,
        expected.before,
        bindings,
      )
    : isDeepStrictEqual(entry.change.before_sensitive, expected.before);
  if (
    !unknownMatches ||
    !beforeSensitiveMatches ||
    !afterSensitiveMatches
  ) {
    return false;
  }
  for (const side of ["before", "after"]) {
    const identityKey = `${side}_identity`;
    if (!Object.hasOwn(entry.change, identityKey)) continue;
    const expectedIdentity =
      entry.type === "azapi_resource"
        ? { id: entry.change[side]?.id, type: null }
        : cutoverRebindReference(reference?.change?.[identityKey], bindings);
    if (!isDeepStrictEqual(entry.change[identityKey], expectedIdentity)) {
      return false;
    }
  }
  return true;
}

function cutoverExactSecuritySchema(plan, changesByAddress, context) {
  const storage = changesByAddress.get(
    "module.workload_state.azurerm_storage_account.this",
  )?.change.after;
  const referenceStorage = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (entry) => entry.address === "module.workload_state.azurerm_storage_account.this",
  )?.change.after;
  const tableServiceId = `${storage?.id}/tableServices/default`;
  const checkTable = (address, tableName) => {
    const after = changesByAddress.get(address)?.change.after;
    return (
      isObject(after) &&
      hasExactKeys(after, [
        "body",
        "create_headers",
        "create_query_parameters",
        "delete_headers",
        "delete_query_parameters",
        "id",
        "identity",
        "ignore_body_changes",
        "ignore_casing",
        "ignore_missing_property",
        "ignore_null_property",
        "ignore_other_items_in_list",
        "list_unique_id_property",
        "location",
        "locks",
        "name",
        "output",
        "parent_id",
        "read_headers",
        "read_query_parameters",
        "replace_triggers_external_values",
        "replace_triggers_refs",
        "response_export_values",
        "retry",
        "schema_validation_enabled",
        "sensitive_body",
        "sensitive_body_version",
        "tags",
        "timeouts",
        "type",
        "update_headers",
        "update_query_parameters",
      ]) &&
      after.name === tableName &&
      after.parent_id === tableServiceId &&
      after.id === `${tableServiceId}/tables/${tableName}` &&
      isDeepStrictEqual(after.body, {}) &&
      Array.isArray(after.identity) &&
      after.identity.length === 0 &&
      after.ignore_casing === false &&
      after.ignore_missing_property === true &&
      after.ignore_null_property === false &&
      after.schema_validation_enabled === true &&
      isObject(after.output) &&
      hasExactKeys(after.output, ["id", "properties", "type"]) &&
      after.output.id === after.id &&
      hasExactKeys(after.output.properties, ["tableName"]) &&
      after.output.properties.tableName === tableName &&
      after.output.type === "Microsoft.Storage/storageAccounts/tableServices/tables" &&
      after.type === "Microsoft.Storage/storageAccounts/tableServices/tables@2025-01-01"
    );
  };
  const applicationInsights = changesByAddress.get(
    "module.observability.azurerm_application_insights.this",
  )?.change.after;
  const appInsightsConnection = cutoverParseApplicationInsightsConnection(
    applicationInsights?.connection_string,
    applicationInsights,
  );
  const app = changesByAddress.get(CUTOVER_CONTAINER_APP)?.change.after;
  const relay = app?.body?.properties?.template?.containers?.[0];
  const cleanup = changesByAddress.get(EXPIRY_CLEANUP_JOB)?.change.after;
  const cleanupEnv = valuesByName(
    cleanup?.body?.properties?.template?.containers?.[0]?.env,
  );
  const budget = changesByAddress.get(
    "module.budget.azurerm_consumption_budget_resource_group.this",
  )?.change.after;
  const actionGroup = changesByAddress.get(FINAL_ACTION_GROUP_ADDRESS)?.change.after;
  const contacts = plan.variables.budget_contact_emails?.value;
  return (
    cutoverSensitiveStorageContract(storage, referenceStorage) &&
    checkTable("module.workload_state.azapi_resource.security", "SecurityState") &&
    checkTable("module.workload_state.azapi_resource.rate", "RateState") &&
    storage?.primary_table_endpoint === context.workloadTableEndpoint &&
    context.workloadTableEndpoint.endsWith("/") &&
    isObject(appInsightsConnection) &&
    appInsightsConnection.full ===
      plan.planned_values.outputs.application_insights_connection_string?.value &&
    appInsightsConnection.full ===
      plan.prior_state.values.outputs.application_insights_connection_string?.value &&
    relay?.env?.find((entry) => entry.name === "APPLICATIONINSIGHTS_CONNECTION_STRING")
      ?.value === appInsightsConnection.relay &&
    cleanupEnv.get("PALANCAR_WORKLOAD_TABLE_ENDPOINT")?.value ===
      context.tableEndpoint &&
    Array.isArray(contacts) &&
    Array.isArray(actionGroup?.email_receiver) &&
    actionGroup.email_receiver.length === contacts.length &&
    actionGroup.email_receiver.every(
      (receiver, index) =>
        receiver.email_address === contacts[index] &&
        receiver.name === `budget-contact-${String(index + 1).padStart(4, "0")}` &&
        receiver.use_common_alert_schema === true,
    ) &&
    Array.isArray(budget?.notification) &&
    budget.notification.length === 4 &&
    budget.notification.every((notification) =>
      isDeepStrictEqual(notification.contact_emails, contacts),
    )
  );
}

function cutoverExactAddressSet(changes, expected) {
  const addresses = changes.map((entry) => entry.address);
  return (
    addresses.length === expected.size &&
    new Set(addresses).size === addresses.length &&
    addresses.every((address) => expected.has(address))
  );
}

function cutoverTerminalNoOp(plan, changes) {
  const referenceChanges = new Map(
    TERMINAL_REFERENCE_PLAN.resource_changes.map((entry) => [entry.address, entry]),
  );
  if (!cutoverExactAddressSet(changes, new Set(referenceChanges.keys()))) return false;
  const byAddress = new Map(changes.map((entry) => [entry.address, entry]));
  const planned = cutoverCollectValueResources(plan.planned_values.root_module);
  const prior = cutoverCollectValueResources(plan.prior_state.values.root_module);
  if (!planned || !prior) return false;
  if (!cutoverHasExactStateInventories(
    plan,
    changes,
    FINAL_ROLLOUT_COMPLETE_MODE,
    planned,
    prior,
  )) return false;
  const context = cutoverIdentityContext(
    byAddress,
    prior,
    plan.planned_values.outputs,
    plan.prior_state.values.outputs,
    plan.output_changes,
    plan.variables.operator_principal_id?.value,
    plan.variables.tenant_id?.value,
  );
  if (!context) return false;
  const bindings = cutoverBindings(plan, byAddress);
  if (!cutoverExactSecuritySchema(plan, byAddress, context)) return false;
  const images = plan.variables;
  const relayImage = images.relay_image_digest?.value;
  if (
    typeof relayImage !== "string" ||
    !isImmutableAcrImage(relayImage) ||
    relayImage !== byAddress.get(CUTOVER_CONTAINER_APP)?.change.after?.body?.properties?.template?.containers?.[0]?.image
  ) return false;
  for (const entry of changes) {
    if (
      !cutoverExactResourceEntry(entry) ||
      !isDeepStrictEqual(entry.change.actions, ["no-op"]) ||
      !cutoverExactNoOp(entry.change, entry.address) ||
      !cutoverHasExactChangeEnvelope(entry, bindings)
    ) return false;
    const reference = referenceChanges.get(entry.address);
    if (!cutoverResourceTypeMatchesReference(entry, reference)) return false;
    if (!cutoverResourceChangeStateCoherent(plan, entry, planned, prior)) return false;
    if (entry.address === CUTOVER_CONTAINER_APP) {
      if (!cutoverExactDirectApp(entry.change.after, relayImage, context)) return false;
    } else if (entry.address === CUTOVER_TRANSCRIPTION_DEPLOYMENT) {
      if (!cutoverExactModelChange(entry.change, PINNED_DEPLOYMENT_NAME, bindings)) return false;
    } else if (entry.address === CUTOVER_LUNA_DEPLOYMENT) {
      if (!cutoverExactModelChange(entry.change, LUNA_DEPLOYMENT_NAME, bindings)) return false;
    } else if (CUTOVER_IDENTITY_ADDRESSES.has(entry.address)) {
      if (!cutoverExactIdentityChange(entry, context)) return false;
    } else if (CUTOVER_RBAC_ADDRESSES.has(entry.address)) {
      if (!cutoverExactRoleChange(entry, context, "no-op")) return false;
    } else if (entry.address === EXPIRY_CLEANUP_JOB) {
      if (!cutoverReferenceAfterMatches(entry.change.after, reference, bindings, entry.address) || !cutoverExactCleanupImage(entry.change.after, images.expiry_cleanup_image_digest?.value, context.acrLoginServer)) return false;
    } else if (!cutoverReferenceAfterMatches(entry.change.after, reference, bindings, entry.address)) {
      return false;
    }
  }
  return cutoverExactFoundryModels(byAddress, bindings) && cutoverExactOutputs(plan, true, bindings);
}

function cutoverExactOutputs(
  plan,
  terminal,
  bindings = [],
  relayRevisionUpdate = false,
) {
  const expectedNames = Object.keys(TERMINAL_REFERENCE_PLAN.output_changes);
  if (
    !hasExactKeys(plan.output_changes, expectedNames) ||
    !hasExactKeys(plan.planned_values.outputs, expectedNames) ||
    !hasExactKeys(plan.prior_state.values.outputs, expectedNames)
  ) return false;
  for (const name of expectedNames) {
    const change = plan.output_changes[name];
    const planned = plan.planned_values.outputs[name];
    const prior = plan.prior_state.values.outputs[name];
    const referencePlan =
      (relayRevisionUpdate || !terminal) && name === "relay_latest_revision_name"
        ? CUTOVER_GENERATION_REFERENCE_PLAN
        : TERMINAL_REFERENCE_PLAN;
    const reference = referencePlan.output_changes[name];
    const expectedChange = cutoverRebindReference(reference, bindings);
    const expectedPlanned = cutoverRebindReference(
      referencePlan.planned_values.outputs[name],
      bindings,
    );
    const expectedPrior = cutoverRebindReference(
      referencePlan.prior_state.values.outputs[name],
      bindings,
    );
    const sensitiveOutput =
      reference.before_sensitive === true || reference.after_sensitive === true;
    const outputChangeMatches =
      isObject(change) &&
      hasExactKeys(change, Object.keys(expectedChange)) &&
      isDeepStrictEqual(
        Object.fromEntries(
          Object.entries(change).filter(([key]) =>
            !["before", "after"].includes(key),
          ),
        ),
        Object.fromEntries(
          Object.entries(expectedChange).filter(([key]) =>
            !["before", "after"].includes(key),
          ),
        ),
      ) &&
      (sensitiveOutput
        ? cutoverOpaqueSensitiveLeafMatches(change.before, reference.before) &&
          (!Object.hasOwn(expectedChange, "after") ||
            cutoverOpaqueSensitiveLeafMatches(change.after, reference.after))
        : isDeepStrictEqual(change.before, expectedChange.before) &&
          (!Object.hasOwn(expectedChange, "after") ||
            isDeepStrictEqual(change.after, expectedChange.after)));
    const plannedMatches =
      isObject(planned) &&
      (sensitiveOutput
        ? hasExactKeys(planned, Object.keys(expectedPlanned)) &&
          isDeepStrictEqual(
            { ...planned, value: undefined },
            { ...expectedPlanned, value: undefined },
          ) &&
          cutoverOpaqueSensitiveLeafMatches(planned.value, expectedPlanned.value)
        : isDeepStrictEqual(planned, expectedPlanned));
    const priorMatches =
      isObject(prior) &&
      (sensitiveOutput
        ? hasExactKeys(prior, Object.keys(expectedPrior)) &&
          isDeepStrictEqual(
            { ...prior, value: undefined },
            { ...expectedPrior, value: undefined },
          ) &&
          cutoverOpaqueSensitiveLeafMatches(prior.value, expectedPrior.value)
        : isDeepStrictEqual(prior, expectedPrior));
    if (
      !outputChangeMatches ||
      !plannedMatches ||
      !priorMatches ||
      typeof change.before_sensitive !== "boolean" ||
      typeof change.after_sensitive !== "boolean" ||
      typeof planned.sensitive !== "boolean" ||
      typeof prior.sensitive !== "boolean" ||
      planned.sensitive !== change.after_sensitive ||
      prior.sensitive !== change.before_sensitive
    ) return false;
    if (
      sensitiveOutput &&
      (!isDeepStrictEqual(change.before, prior.value) ||
        !isDeepStrictEqual(change.after, planned.value) ||
        !isDeepStrictEqual(change.before, change.after) ||
        !isDeepStrictEqual(prior.value, planned.value))
    ) {
      return false;
    }
  }
  const models = plan.output_changes.foundry_deployment_names.after;
  return isDeepStrictEqual(models, [PINNED_DEPLOYMENT_NAME, LUNA_DEPLOYMENT_NAME]);
}

function acceptsAzureGenerationCutover(plan, changes) {
  const sections = cutoverStateSections(
    plan,
    AZURE_GENERATION_CUTOVER_MODE,
    true,
    true,
  );
  const addresses = cutoverExactAddressSet(changes, CUTOVER_RESOURCE_INVENTORY);
  if (!sections || !addresses) {
    return false;
  }
  const byAddress = new Map(changes.map((entry) => [entry.address, entry]));
  const planned = cutoverCollectValueResources(plan.planned_values.root_module);
  const prior = cutoverCollectValueResources(plan.prior_state.values.root_module);
  const context = cutoverIdentityContext(
    byAddress,
    prior,
    plan.planned_values.outputs,
    plan.prior_state.values.outputs,
    plan.output_changes,
    plan.variables.operator_principal_id?.value,
    plan.variables.tenant_id?.value,
  );
  const relayImage = plan.variables.relay_image_digest?.value;
  if (!planned || !prior || !context || !isImmutableAcrImage(relayImage)) {
    return false;
  }
  const inventories = cutoverHasExactStateInventories(
    plan,
    changes,
    AZURE_GENERATION_CUTOVER_MODE,
    planned,
    prior,
  );
  if (!inventories) {
    return false;
  }
  const bindings = cutoverBindings(plan, byAddress);
  const security = cutoverExactSecuritySchema(plan, byAddress, context);
  if (!security) {
    return false;
  }
  for (const entry of changes) {
    const resource = cutoverExactResourceEntry(
      entry,
      entry.address === CUTOVER_RUNTIME_SECRETS_USER,
    );
    const actions = isDeepStrictEqual(
      entry.change.actions,
      [entry.address === CUTOVER_CONTAINER_APP ? "update" : "no-op"],
    );
    const envelope = cutoverHasExactChangeEnvelope(entry, bindings);
    if (!resource || !actions || !envelope) {
      return false;
    }
    const metadata = cutoverExactEntryMetadata(entry);
    if (!metadata) {
      return false;
    }
    const coherent = cutoverResourceChangeStateCoherent(plan, entry, planned, prior);
    if (!coherent) {
      return false;
    }
    if (entry.address === CUTOVER_CONTAINER_APP) {
      const predecessor = cutoverExactPredecessorApp(
        entry.change.before,
        context,
        CUTOVER_RELAY_PRIOR_IMAGE,
      );
      const direct = cutoverExactDirectApp(
        entry.change.after,
        relayImage,
        context,
        { update: true },
      );
      if (!isUpdate(entry.change.actions) || !predecessor || !direct) {
        return false;
      }
    } else if (entry.address === CUTOVER_RUNTIME_SECRETS_USER) {
      const valid = cutoverExactRoleChange(entry, context, "no-op");
      if (!valid) return false;
    } else if (entry.address === CUTOVER_TRANSCRIPTION_DEPLOYMENT) {
      const valid = cutoverExactModelChange(entry.change, PINNED_DEPLOYMENT_NAME, bindings);
      if (!valid) return false;
    } else if (entry.address === CUTOVER_LUNA_DEPLOYMENT) {
      const valid = cutoverExactModelChange(entry.change, LUNA_DEPLOYMENT_NAME, bindings);
      if (!valid) return false;
    } else if (CUTOVER_IDENTITY_ADDRESSES.has(entry.address)) {
      const valid = cutoverExactIdentityChange(entry, context);
      if (!valid) return false;
    } else if (CUTOVER_RBAC_ADDRESSES.has(entry.address)) {
      const valid = cutoverExactRoleChange(entry, context, "no-op");
      if (!valid) return false;
    } else if (entry.address === EXPIRY_CLEANUP_JOB) {
      const valid = cutoverReferenceAfterMatches(entry.change.after, TERMINAL_REFERENCE_PLAN.resource_changes.find((x) => x.address === EXPIRY_CLEANUP_JOB), bindings, entry.address) && cutoverExactCleanupImage(entry.change.after, plan.variables.expiry_cleanup_image_digest?.value, context.acrLoginServer);
      if (!valid) return false;
    } else {
      const valid = cutoverReferenceAfterMatches(
        entry.change.after,
        TERMINAL_REFERENCE_PLAN.resource_changes.find(
          (x) => x.address === entry.address,
        ),
        bindings,
        entry.address,
      );
      if (!valid) return false;
    }
  }
  const models = cutoverExactFoundryModels(byAddress, bindings);
  const outputs = cutoverExactOutputs(plan, false, bindings);
  return models && outputs;
}

function acceptsAzureCredentialCleanup(plan, changes) {
  if (
    !cutoverStateSections(
      plan,
      AZURE_CREDENTIAL_CLEANUP_MODE,
      false,
      true,
    ) ||
    !cutoverExactAddressSet(changes, CUTOVER_RESOURCE_INVENTORY)
  ) return false;
  const byAddress = new Map(changes.map((entry) => [entry.address, entry]));
  const planned = cutoverCollectValueResources(plan.planned_values.root_module);
  const prior = cutoverCollectValueResources(plan.prior_state.values.root_module);
  const context = cutoverIdentityContext(
    byAddress,
    prior,
    plan.planned_values.outputs,
    plan.prior_state.values.outputs,
    plan.output_changes,
    plan.variables.operator_principal_id?.value,
    plan.variables.tenant_id?.value,
  );
  const relayImage = plan.variables.relay_image_digest?.value;
  if (!planned || !prior || !context || !isImmutableAcrImage(relayImage)) return false;
  if (!cutoverHasExactStateInventories(
    plan,
    changes,
    AZURE_CREDENTIAL_CLEANUP_MODE,
    planned,
    prior,
  )) return false;
  const bindings = cutoverBindings(plan, byAddress);
  if (!cutoverExactSecuritySchema(plan, byAddress, context)) return false;
  for (const entry of changes) {
    // The live cleanup plan omits provider-computed probes from this no-op
    // Container App entry; keep that compatibility local to this mode.
    const omitContainerAppProbes =
      entry.address === CUTOVER_CONTAINER_APP &&
      !Object.hasOwn(
        entry.change.after?.body?.properties?.template?.containers?.[0] ?? {},
        "probes",
      ) &&
      !Object.hasOwn(
        entry.change.before?.body?.properties?.template?.containers?.[0] ?? {},
        "probes",
      );
    if (
      !cutoverExactResourceEntry(entry, false, true) ||
      !isDeepStrictEqual(
        entry.change.actions,
        [entry.address === CUTOVER_RUNTIME_SECRETS_USER ? "delete" : "no-op"],
      ) ||
      !cutoverHasExactChangeEnvelope(
        entry,
        bindings,
        omitContainerAppProbes,
      )
    ) return false;
    if (!cutoverExactEntryMetadata(entry)) return false;
    if (!cutoverResourceChangeStateCoherent(plan, entry, planned, prior)) return false;
    if (entry.address === CUTOVER_CONTAINER_APP) {
      if (
        !cutoverExactNoOp(entry.change, entry.address) ||
        !cutoverExactDirectApp(entry.change.after, relayImage, context, {
          omitProbes: omitContainerAppProbes,
        })
      ) return false;
    } else if (entry.address === CUTOVER_RUNTIME_SECRETS_USER) {
      if (!cutoverExactRoleChange(entry, context, "delete")) return false;
    } else if (entry.address === CUTOVER_TRANSCRIPTION_DEPLOYMENT) {
      if (!cutoverExactModelChange(entry.change, PINNED_DEPLOYMENT_NAME, bindings)) return false;
    } else if (entry.address === CUTOVER_LUNA_DEPLOYMENT) {
      if (!cutoverExactModelChange(entry.change, LUNA_DEPLOYMENT_NAME, bindings)) return false;
    } else if (CUTOVER_IDENTITY_ADDRESSES.has(entry.address)) {
      if (!cutoverExactIdentityChange(entry, context)) return false;
    } else if (CUTOVER_RBAC_ADDRESSES.has(entry.address)) {
      if (!cutoverExactRoleChange(entry, context, "no-op")) return false;
    } else if (entry.address === EXPIRY_CLEANUP_JOB) {
      if (!cutoverReferenceAfterMatches(entry.change.after, TERMINAL_REFERENCE_PLAN.resource_changes.find((x) => x.address === EXPIRY_CLEANUP_JOB), bindings, entry.address) || !cutoverExactCleanupImage(entry.change.after, plan.variables.expiry_cleanup_image_digest?.value, context.acrLoginServer)) return false;
    } else if (!cutoverReferenceAfterMatches(entry.change.after, TERMINAL_REFERENCE_PLAN.resource_changes.find((x) => x.address === entry.address), bindings, entry.address)) return false;
  }
  const models = cutoverExactFoundryModels(byAddress, bindings);
  const outputs = cutoverExactOutputs(plan, true, bindings);
  return models && outputs;
}

function cutoverHasExactRelayImageChangeEnvelope(entry, bindings) {
  const terminalChange = TERMINAL_REFERENCE_PLAN.resource_changes.find(
    (candidate) => candidate.address === CUTOVER_CONTAINER_APP,
  )?.change;
  const generationChange = CUTOVER_GENERATION_REFERENCE_PLAN.resource_changes.find(
    (candidate) => candidate.address === CUTOVER_CONTAINER_APP,
  )?.change;
  if (!terminalChange || !generationChange) return false;
  const expectedBeforeSensitive = structuredClone(terminalChange.before_sensitive);
  delete expectedBeforeSensitive.body?.properties?.template?.containers?.[0]
    ?.probes;
  const afterSensitiveMatches = cutoverSensitiveMaskMatches(
    entry.change.after,
    generationChange.after,
    entry.change.after_sensitive,
    generationChange.after_sensitive,
    bindings,
  );
  if (
    !isDeepStrictEqual(
      entry.change.before_sensitive,
      cutoverRebindReference(expectedBeforeSensitive, bindings),
    ) ||
    !isDeepStrictEqual(
      entry.change.after_unknown,
      generationChange.after_unknown,
    ) ||
    !afterSensitiveMatches
  ) {
    return false;
  }
  for (const side of ["before", "after"]) {
    const identityKey = `${side}_identity`;
    if (!Object.hasOwn(entry.change, identityKey)) return false;
    if (
      !isDeepStrictEqual(entry.change[identityKey], {
        id: entry.change[side]?.id,
        type: null,
      })
    ) {
      return false;
    }
  }
  return true;
}

function acceptsPostCutoverRelayImageRollout(plan, changes) {
  if (
    !cutoverStateSections(
      plan,
      POST_CUTOVER_RELAY_IMAGE_ROLLOUT_MODE,
      true,
      true,
    ) ||
    !cutoverExactAddressSet(
      changes,
      new Set(
        CUTOVER_CREDENTIAL_CLEANUP_REFERENCE_PLAN.resource_changes.map(
          (entry) => entry.address,
        ),
      ),
    )
  ) {
    return false;
  }
  const byAddress = new Map(changes.map((entry) => [entry.address, entry]));
  const planned = cutoverCollectValueResources(plan.planned_values.root_module);
  const prior = cutoverCollectValueResources(plan.prior_state.values.root_module);
  const context = cutoverIdentityContext(
    byAddress,
    prior,
    plan.planned_values.outputs,
    plan.prior_state.values.outputs,
    plan.output_changes,
    plan.variables.operator_principal_id?.value,
    plan.variables.tenant_id?.value,
  );
  const appEntry = byAddress.get(CUTOVER_CONTAINER_APP);
  const beforeImage =
    appEntry?.change?.before?.body?.properties?.template?.containers?.[0]?.image;
  const relayImage = plan.variables.relay_image_digest?.value;
  if (
    !planned ||
    !prior ||
    !context ||
    !isImmutableAcrImage(beforeImage) ||
    !isImmutableAcrImage(relayImage) ||
    beforeImage === relayImage ||
    !relayImage.startsWith(`${context.acrLoginServer}/palancar-relay@sha256:`)
  ) {
    return false;
  }
  if (
    !cutoverHasExactStateInventories(
      plan,
      changes,
      POST_CUTOVER_RELAY_IMAGE_ROLLOUT_MODE,
      planned,
      prior,
    )) {
    return false;
  }
  const bindings = cutoverBindings(plan, byAddress);
  if (!cutoverExactSecuritySchema(plan, byAddress, context)) return false;
  const referenceChanges = new Map(
    TERMINAL_REFERENCE_PLAN.resource_changes.map((entry) => [entry.address, entry]),
  );
  for (const entry of changes) {
    const isApp = entry.address === CUTOVER_CONTAINER_APP;
    if (
      !cutoverExactResourceEntry(entry) ||
      !cutoverExactEntryMetadata(entry) ||
      !cutoverResourceChangeStateCoherent(plan, entry, planned, prior) ||
      !isDeepStrictEqual(entry.change.actions, [isApp ? "update" : "no-op"])
    ) {
      return false;
    }
    if (isApp) {
      if (
        !cutoverHasExactRelayImageChangeEnvelope(entry, bindings) ||
        !cutoverExactDirectApp(entry.change.before, beforeImage, context, {
          omitProbes: true,
        }) ||
        !cutoverExactDirectApp(entry.change.after, relayImage, context, {
          update: true,
        })
      ) {
        return false;
      }
      continue;
    }
    if (
      !cutoverExactNoOp(entry.change, entry.address) ||
      !cutoverHasExactChangeEnvelope(entry, bindings)
    ) {
      return false;
    }
    const reference = referenceChanges.get(entry.address);
    if (entry.address === CUTOVER_RUNTIME_SECRETS_USER) {
      if (!cutoverExactRoleChange(entry, context, "no-op")) return false;
    } else if (entry.address === CUTOVER_TRANSCRIPTION_DEPLOYMENT) {
      if (!cutoverExactModelChange(entry.change, PINNED_DEPLOYMENT_NAME, bindings)) {
        return false;
      }
    } else if (entry.address === CUTOVER_LUNA_DEPLOYMENT) {
      if (!cutoverExactModelChange(entry.change, LUNA_DEPLOYMENT_NAME, bindings)) {
        return false;
      }
    } else if (CUTOVER_IDENTITY_ADDRESSES.has(entry.address)) {
      if (!cutoverExactIdentityChange(entry, context)) return false;
    } else if (CUTOVER_RBAC_ADDRESSES.has(entry.address)) {
      if (!cutoverExactRoleChange(entry, context, "no-op")) return false;
    } else if (entry.address === EXPIRY_CLEANUP_JOB) {
      if (
        !cutoverReferenceAfterMatches(entry.change.after, reference, bindings, entry.address) ||
        !cutoverExactCleanupImage(
          entry.change.after,
          plan.variables.expiry_cleanup_image_digest?.value,
          context.acrLoginServer,
        )
      ) {
        return false;
      }
    } else if (!cutoverReferenceAfterMatches(entry.change.after, reference, bindings, entry.address)) {
      return false;
    }
  }
  return (
    cutoverExactFoundryModels(byAddress, bindings) &&
    cutoverExactOutputs(plan, false, bindings, true)
  );
}

function acceptsFinalRolloutComplete(plan, changes) {
  return (
    cutoverStateSections(
      plan,
      FINAL_ROLLOUT_COMPLETE_MODE,
      false,
      false,
    ) &&
    plan.applyable === false &&
    cutoverTerminalNoOp(plan, changes)
  );
}

export function acceptsPlan(plan, mode) {
  if (
    !isObject(plan) ||
    plan.format_version !== SUPPORTED_PLAN_FORMAT_VERSION ||
    ![
      MODEL_SPIKE_MODE,
      FULL_DEPLOY_MODE,
      RUNTIME_ROLLOUT_MODE,
      FINAL_ROLLOUT_MODE,
      LUNA_MODEL_BOOTSTRAP_MODE,
      AZURE_GENERATION_CUTOVER_MODE,
      AZURE_CREDENTIAL_CLEANUP_MODE,
      POST_CUTOVER_RELAY_IMAGE_ROLLOUT_MODE,
      FINAL_ROLLOUT_COMPLETE_MODE,
    ].includes(mode)
  ) {
    return false;
  }

  const hasInvalidChecks =
    mode === FINAL_ROLLOUT_MODE || mode === FINAL_ROLLOUT_COMPLETE_MODE
      ? false
      : mode === MODEL_SPIKE_MODE
        ? hasNonPassingModelSpikeCheck(plan)
        : hasNonPassingCheck(plan);
  const modeValidatesItsOwnResourceDrift =
    mode === FINAL_ROLLOUT_MODE ||
    mode === AZURE_GENERATION_CUTOVER_MODE ||
    mode === AZURE_CREDENTIAL_CLEANUP_MODE ||
    mode === POST_CUTOVER_RELAY_IMAGE_ROLLOUT_MODE ||
    mode === FINAL_ROLLOUT_COMPLETE_MODE;
  if (
    hasInvalidChecks ||
    (!modeValidatesItsOwnResourceDrift &&
      hasResourceDrift(plan))
  ) {
    return false;
  }

  if (hasRetiredDeployment(plan)) {
    return false;
  }

  const changes = plan.resource_changes === undefined ? [] : plan.resource_changes;
  if (!Array.isArray(changes) || !changes.every(isWellFormedResourceChange)) {
    return false;
  }

  if (new Set(changes.map((change) => change.address)).size !== changes.length) {
    return false;
  }

  if (mode === MODEL_SPIKE_MODE) {
    return acceptsModelSpike(changes);
  }

  if (mode === LUNA_MODEL_BOOTSTRAP_MODE) {
    return acceptsLunaModelBootstrap(plan, changes);
  }

  if (mode === AZURE_GENERATION_CUTOVER_MODE) {
    return acceptsAzureGenerationCutover(plan, changes);
  }

  if (mode === AZURE_CREDENTIAL_CLEANUP_MODE) {
    return acceptsAzureCredentialCleanup(plan, changes);
  }

  if (mode === POST_CUTOVER_RELAY_IMAGE_ROLLOUT_MODE) {
    return acceptsPostCutoverRelayImageRollout(plan, changes);
  }

  if (mode === FINAL_ROLLOUT_COMPLETE_MODE) {
    return acceptsFinalRolloutComplete(plan, changes);
  }

  const requiredNoOpAddresses = new Set(FOUNDATION_NO_OP_ADDRESSES);
  for (const address of configuredRoleAssignmentAddresses(plan)) {
    requiredNoOpAddresses.add(address);
  }

  if (mode === RUNTIME_ROLLOUT_MODE) {
    const operatorPrincipalId = exactCanonicalUuidVariable(
      plan,
      "operator_principal_id",
    );
    if (
      operatorPrincipalId === undefined ||
      !hasExactEmptyFoundryDeploymentsVariable(plan) ||
      hasActualCognitiveDeployment(plan)
    ) {
      return false;
    }
    const existingManagedAddresses = priorManagedAddresses(plan);
    for (const address of configuredFoundationAddresses(plan)) {
      if (!OPERATOR_ROLE_ASSIGNMENTS.has(address)) {
        requiredNoOpAddresses.add(address);
      }
    }
    for (const address of OPERATOR_ROLE_ASSIGNMENTS.keys()) {
      if (existingManagedAddresses.has(address)) {
        requiredNoOpAddresses.delete(address);
      }
    }
    return acceptsRuntimeRollout(
      changes,
      requiredNoOpAddresses,
      existingManagedAddresses,
      operatorPrincipalId,
    );
  }

  if (mode === FINAL_ROLLOUT_MODE) {
    return acceptsFinalRolloutV2(plan, changes);
  }

  return acceptsFullDeploy(changes, requiredNoOpAddresses);
}

function getMode(argv) {
  if (argv.length !== 1 || !argv[0].startsWith("--mode=")) {
    return undefined;
  }

  const mode = argv[0].slice("--mode=".length);
  return [
    MODEL_SPIKE_MODE,
    FULL_DEPLOY_MODE,
    RUNTIME_ROLLOUT_MODE,
    FINAL_ROLLOUT_MODE,
    LUNA_MODEL_BOOTSTRAP_MODE,
    AZURE_GENERATION_CUTOVER_MODE,
    AZURE_CREDENTIAL_CLEANUP_MODE,
    POST_CUTOVER_RELAY_IMAGE_ROLLOUT_MODE,
    FINAL_ROLLOUT_COMPLETE_MODE,
  ].includes(mode)
    ? mode
    : undefined;
}

export function runCli(argv, input) {
  const mode = getMode(argv);
  if (mode === undefined) {
    return 2;
  }

  let plan;
  try {
    plan = JSON.parse(input);
  } catch {
    return 1;
  }

  return acceptsPlan(plan, mode) ? 0 : 1;
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  const exitCode = runCli(process.argv.slice(2), readFileSync(0, "utf8"));
  if (exitCode !== 0) {
    process.stderr.write(
      exitCode === 2 ? "plan guard usage error\n" : "plan guard rejected plan\n",
    );
  }
  process.exitCode = exitCode;
}
