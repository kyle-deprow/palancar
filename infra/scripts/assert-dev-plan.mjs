#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MODEL_SPIKE_MODE = "model-spike";
const FULL_DEPLOY_MODE = "full-deploy";
const PINNED_DEPLOYMENT_NAME = "gpt-4o-mini-transcribe";
const MODEL_SPIKE_DEPLOYMENT =
  `module.foundry.azurerm_cognitive_deployment.this["${PINNED_DEPLOYMENT_NAME}"]`;
const RETIRED_DEPLOYMENT = "gpt-5-6-luna";
const CONTAINER_APP = "module.container_app_workload[0].azapi_resource.this";
const CONFIGURED_ROLE_ASSIGNMENT_PREFIXES = [
  "module.identities_rbac.azurerm_role_assignment.",
  "module.workload_key_vault.azurerm_role_assignment.",
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

export function acceptsPlan(plan, mode) {
  if (!isObject(plan) || ![MODEL_SPIKE_MODE, FULL_DEPLOY_MODE].includes(mode)) {
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

  return acceptsFullDeploy(changes, requiredNoOpAddresses);
}

function getMode(argv) {
  if (argv.length !== 1 || !argv[0].startsWith("--mode=")) {
    return undefined;
  }

  const mode = argv[0].slice("--mode=".length);
  return [MODEL_SPIKE_MODE, FULL_DEPLOY_MODE].includes(mode) ? mode : undefined;
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
