#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";

const MODEL_SPIKE_MODE = "model-spike";
const FULL_DEPLOY_MODE = "full-deploy";
const RUNTIME_ROLLOUT_MODE = "runtime-rollout";
const PINNED_DEPLOYMENT_NAME = "gpt-4o-mini-transcribe";
const MODEL_SPIKE_DEPLOYMENT =
  `module.foundry.azurerm_cognitive_deployment.this["${PINNED_DEPLOYMENT_NAME}"]`;
const RETIRED_DEPLOYMENT = "gpt-5-6-luna";
const CONTAINER_APP = "module.container_app_workload[0].azapi_resource.this";
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

function hasNonPassingCheck(plan) {
  if (plan.checks === undefined) {
    return false;
  }

  if (!Array.isArray(plan.checks)) {
    return true;
  }

  return plan.checks.some(
    (check) => !isObject(check) || check.status !== "pass",
  );
}

function hasResourceDrift(plan) {
  if (plan.resource_drift === undefined) {
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
    ingress.transport !== "http" ||
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

  if (
    !isObject(body) ||
    !isObject(properties) ||
    !isObject(configuration) ||
    !isObject(template) ||
    configuration.activeRevisionsMode !== "Single" ||
    !hasExactIngress(configuration.ingress) ||
    !Array.isArray(identities) ||
    identities.length !== 1 ||
    identities[0]?.type !== "UserAssigned" ||
    !Array.isArray(identities[0]?.identity_ids) ||
    identities[0].identity_ids.length !== 2 ||
    !identities[0].identity_ids.every(isUserAssignedIdentity) ||
    identities[0].identity_ids[0] === identities[0].identity_ids[1] ||
    (after.sensitive_body !== undefined && after.sensitive_body !== null) ||
    containsHelperTopology(body)
  ) {
    return false;
  }

  const [imagePullIdentity, runtimeIdentity] = identities[0].identity_ids;
  const identitySettings = configuration.identitySettings;
  const registries = configuration.registries;
  if (
    !Array.isArray(identitySettings) ||
    identitySettings.length !== 2 ||
    !hasExactKeys(identitySettings[0], ["identity", "lifecycle"]) ||
    identitySettings[0].identity !== imagePullIdentity ||
    identitySettings[0].lifecycle !== "None" ||
    !hasExactKeys(identitySettings[1], ["identity", "lifecycle"]) ||
    identitySettings[1].identity !== runtimeIdentity ||
    identitySettings[1].lifecycle !== "Main" ||
    !Array.isArray(registries) ||
    registries.length !== 1 ||
    !hasExactKeys(registries[0], ["server", "identity"]) ||
    registries[0].identity !== imagePullIdentity ||
    typeof registries[0].server !== "string" ||
    !/^[a-z0-9.-]+\.azurecr\.io$/.test(registries[0].server)
  ) {
    return false;
  }

  const secrets = valuesByName(configuration.secrets);
  const masterSecret = secrets?.get("litellm-master-key");
  const openRouterSecret = secrets?.get("openrouter-api-key");
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
    !relay.image.startsWith(`${registries[0].server}/`) ||
    !isImmutableAcrImage(litellm?.image) ||
    !litellm.image.startsWith(`${registries[0].server}/`) ||
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
        type: "Startup",
        path: "/health/liveliness",
        port: 4000,
        initialDelaySeconds: 10,
        periodSeconds: 10,
        timeoutSeconds: 3,
        failureThreshold: 10,
      },
      {
        type: "Liveness",
        path: "/health/liveliness",
        port: 4000,
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
    !hasEnvValue(relayEnv, "PALANCAR_SECURITY_STATE_TABLE", "SecurityState") ||
    !hasEnvValue(relayEnv, "PALANCAR_RATE_STATE_TABLE", "RateState") ||
    !isUserAssignedIdentity(runtimeIdentity) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(relayEnv.get("AZURE_CLIENT_ID")?.value) ||
    typeof relayEnv.get("PALANCAR_RELAY_ENVIRONMENT")?.value !== "string" ||
    relayEnv.get("PALANCAR_RELAY_ENVIRONMENT").value.trim() === "" ||
    !/^wss:\/\/[a-z0-9.-]+\.azurecontainerapps\.io$/.test(relayEnv.get("PALANCAR_RELAY_ORIGIN")?.value) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(relayEnv.get("PALANCAR_GATE_POLICY_VERSION")?.value) ||
    typeof relayEnv.get("PALANCAR_WORKLOAD_TABLE_ENDPOINT")?.value !== "string" ||
    !/^https:\/\/[a-z0-9]+\.table\.core\.windows\.net\/$/.test(relayEnv.get("PALANCAR_WORKLOAD_TABLE_ENDPOINT").value)
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

function hasObjectKeys(value, keys) {
  return isObject(value) && keys.every((key) => Object.hasOwn(value, key));
}

function hasExactPinnedModelAfter(after) {
  if (!isObject(after)) {
    return false;
  }

  const models = after.model;
  const skus = after.sku;

  return (
    Array.isArray(models) &&
    models.length === 1 &&
    hasObjectKeys(models[0], ["format", "name", "version"]) &&
    models[0].format === "OpenAI" &&
    models[0].name === PINNED_DEPLOYMENT_NAME &&
    models[0].version === "2025-12-15" &&
    Array.isArray(skus) &&
    skus.length === 1 &&
    hasObjectKeys(skus[0], ["name", "capacity"]) &&
    skus[0].name === "GlobalStandard" &&
    skus[0].capacity === 1 &&
    after.version_upgrade_option === "NoAutoUpgrade"
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
      change.address === MODEL_SPIKE_DEPLOYMENT &&
      isCreate(actions) &&
      hasExactPinnedModelAfter(change.change.after)
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
      hasExactPinnedModelAfter(change.change.after)
    ) {
      pinnedDeploymentEntries += 1;
      continue;
    }

    if (
      change.address === CONTAINER_APP &&
      (isUpdate(actions) || isNoOp(actions)) &&
      hasAllowedScale(change.change.after)
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
    ![MODEL_SPIKE_MODE, FULL_DEPLOY_MODE, RUNTIME_ROLLOUT_MODE].includes(mode)
  ) {
    return false;
  }

  if (hasNonPassingCheck(plan) || hasResourceDrift(plan)) {
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

  return acceptsFullDeploy(changes, requiredNoOpAddresses);
}

function getMode(argv) {
  if (argv.length !== 1 || !argv[0].startsWith("--mode=")) {
    return undefined;
  }

  const mode = argv[0].slice("--mode=".length);
  return [MODEL_SPIKE_MODE, FULL_DEPLOY_MODE, RUNTIME_ROLLOUT_MODE].includes(mode)
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
