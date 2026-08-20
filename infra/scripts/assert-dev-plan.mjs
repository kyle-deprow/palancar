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
const SUPPORTED_PLAN_FORMAT_VERSION = "1.2";
const PINNED_DEPLOYMENT_NAME = "gpt-4o-mini-transcribe";
const PINNED_MODEL_VERSION = "2025-12-15";
const FOUNDRY_COGNITIVE_ACCOUNT_ID =
  "/subscriptions/a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1/resourceGroups/rg-palancar-dev-aeeacd8c/providers/Microsoft.CognitiveServices/accounts/palancardevopenaiaeeacd8c";
const AZURERM_PROVIDER_NAME = "registry.terraform.io/hashicorp/azurerm";
const EXPECTED_BROWSER_ALLOWED_ORIGINS =
  "https://even-webview.synthetic.invalid";
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
  `${FINAL_ACR_LOGIN_SERVER}/palancar-relay@sha256:cab2c5ca0d8ab2d46d71e9079f243f6772e630c753c3c6a7ec04f925b7aae653`;
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
const FINAL_REFERENCE_PLAN = JSON.parse(
  readFileSync(
    new URL("./fixtures/final-rollout-transition.plan-fixture.json", import.meta.url),
    "utf8",
  ),
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

function hasOnlyKeys(value, keys) {
  return isObject(value) && Object.keys(value).every((key) => keys.includes(key));
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

function hasExactFailClosedBrowserOriginPolicyInContainerApp(after) {
  const containers = valuesByName(after?.body?.properties?.template?.containers);
  const relay = containers?.get("relay");
  return hasExactFailClosedBrowserOriginPolicy(valuesByName(relay?.env));
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
    !hasOnlyKeys(relay, ["name", "image", "resources", "env", "probes"]) ||
    !hasOnlyKeys(litellm, ["name", "image", "resources", "env", "probes"]) ||
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

function hasExactFinalRelayEnvironment(env, runtimeClientId) {
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
    hasExactFinalRelayOrigin(entries.get("PALANCAR_RELAY_ORIGIN")?.value) &&
    hasEnvValue(entries, "PALANCAR_GATE_POLICY_VERSION", "1.0.0") &&
    hasEnvValue(entries, "AZURE_CLIENT_ID", runtimeClientId) &&
    hasEnvValue(entries, "PALANCAR_DEPLOYMENT_SLOT", "dev") &&
    hasExactFinalConnectionString(
      entries.get("APPLICATIONINSIGHTS_CONNECTION_STRING")?.value,
    ) &&
    hasEnvValue(entries, "APPLICATIONINSIGHTS_STATSBEAT_DISABLED", "true") &&
    hasEnvValue(entries, "APPLICATION_INSIGHTS_NO_STATSBEAT", "true") &&
    hasEnvValue(entries, "PALANCAR_SECURITY_MODE", "azure-table") &&
    hasEnvValue(entries, "PALANCAR_WORKLOAD_TABLE_ENDPOINT", FINAL_TABLE_ENDPOINT) &&
    hasEnvValue(entries, "PALANCAR_SECURITY_STATE_TABLE", "SecurityState") &&
    hasEnvValue(entries, "PALANCAR_RATE_STATE_TABLE", "RateState") &&
    hasEnvValue(entries, "PALANCAR_TRANSCRIPTION_PROVIDER", "azure-realtime") &&
    hasEnvValue(
      entries,
      "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT",
      FINAL_FOUNDRY_REALTIME_ENDPOINT,
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

function finalHasExactContainerAppProviderOutput(output, defaultDomain) {
  if (
    !isObject(output) ||
    !finalExactKeys(output, ["properties"]) ||
    !isObject(output.properties)
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
      `${FINAL_CONTAINER_APP_NAME}.${defaultDomain}` &&
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
  const expectedDifferences = [
    "body.properties.template.containers[0].image",
    "output",
  ];
  if (
    !isObject(before) ||
    !isObject(after) ||
    !isDeepStrictEqual(
      finalRecursiveDifferencePaths(before, after),
      expectedDifferences,
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
    const sensitiveMatch = isDeepStrictEqual(
      change.after_sensitive,
      finalExpectedAfterSensitive(resourceChange),
    );
    if (
      !outerMatch ||
      !envelopeMatch ||
      !actionAllowed ||
      !afterObject ||
      !unknownMatch ||
      !sensitiveMatch
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
      if (!hasAllowedScale(change.change.after)) {
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

export function acceptsPlan(plan, mode) {
  if (
    !isObject(plan) ||
    plan.format_version !== SUPPORTED_PLAN_FORMAT_VERSION ||
    ![
      MODEL_SPIKE_MODE,
      FULL_DEPLOY_MODE,
      RUNTIME_ROLLOUT_MODE,
      FINAL_ROLLOUT_MODE,
    ].includes(mode)
  ) {
    return false;
  }

  const hasInvalidChecks =
    mode === FINAL_ROLLOUT_MODE
      ? false
      : mode === MODEL_SPIKE_MODE
        ? hasNonPassingModelSpikeCheck(plan)
        : hasNonPassingCheck(plan);
  if (
    hasInvalidChecks ||
    (mode !== FINAL_ROLLOUT_MODE && hasResourceDrift(plan))
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
