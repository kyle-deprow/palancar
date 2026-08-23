import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  acceptsPlan,
  createLegacyFinalReferencePlan,
  runCli,
} from "./assert-dev-plan.mjs";

const cliPath = fileURLToPath(new URL("./assert-dev-plan.mjs", import.meta.url));
const terminalFixtureText = readFileSync(
  new URL(
    "./fixtures/final-rollout-transition.plan-fixture.json",
    import.meta.url,
  ),
  "utf8",
);
const terminalFixture = JSON.parse(terminalFixtureText);
const finalTransitionFixture = createLegacyFinalReferencePlan(terminalFixture);
const finalFixtureText = JSON.stringify(finalTransitionFixture);
const lunaFixtureText = readFileSync(
  new URL(
    "./fixtures/luna-model-bootstrap.plan-fixture.json",
    import.meta.url,
  ),
  "utf8",
);
const lunaModelBootstrapFixture = JSON.parse(lunaFixtureText);
const runtimeCutoverFixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/azure-generation-cutover.plan-fixture.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const credentialCleanupFixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/azure-credential-cleanup.plan-fixture.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const postCutoverRelayImage =
  "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:" + "b".repeat(64);
const lunaDeploymentAddress =
  'module.foundry.azurerm_cognitive_deployment.this["gpt-5.6-luna"]';
const lunaTranscriptionAddress =
  'module.foundry.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"]';
const lunaContainerAppAddress =
  "module.container_app_workload[0].azapi_resource.this";
const FIXTURE_LOG_ANALYTICS_PRIMARY_SHARED_KEY =
  "EREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREREQ==";
const FIXTURE_LOG_ANALYTICS_SECONDARY_SHARED_KEY =
  "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIg==";
const FIXTURE_STORAGE_PRIMARY_ACCESS_KEY =
  "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMw==";
const FIXTURE_STORAGE_SECONDARY_ACCESS_KEY =
  "RERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERA==";
const FIXTURE_APP_INSIGHTS_INSTRUMENTATION_KEY =
  "00000000-0000-4000-8000-000000000099";
const FIXTURE_APP_INSIGHTS_APPLICATION_ID =
  "00000000-0000-4000-8000-000000000098";
const FIXTURE_APP_INSIGHTS_FULL_CONNECTION =
  `InstrumentationKey=${FIXTURE_APP_INSIGHTS_INSTRUMENTATION_KEY};` +
  "IngestionEndpoint=https://eastus2-3.in.applicationinsights.azure.com/;" +
  "LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;" +
  `ApplicationId=${FIXTURE_APP_INSIGHTS_APPLICATION_ID}`;

function postCutoverRelayImageRolloutFixture() {
  const candidate = clone(credentialCleanupFixture);
  const terminalApp = cutoverChange(candidate, lunaContainerAppAddress);
  const generationApp = cutoverChange(
    runtimeCutoverFixture,
    lunaContainerAppAddress,
  );
  const before = clone(terminalApp.change.after);
  const after = clone(before);
  delete before.body.properties.template.containers[0].probes;
  delete after.body.properties.template.containers[0].probes;
  after.body.properties.template.containers[0].image = postCutoverRelayImage;
  delete after.output;
  const beforeSensitive = clone(terminalApp.change.before_sensitive);
  delete beforeSensitive.body.properties.template.containers[0].probes;
  terminalApp.change = {
    ...clone(generationApp.change),
    before,
    after,
    before_sensitive: beforeSensitive,
    after_sensitive: clone(generationApp.change.after_sensitive),
    before_identity: clone(generationApp.change.before_identity),
    after_identity: clone(generationApp.change.after_identity),
  };
  const planned = finalValueResource(
    candidate.planned_values.root_module,
    lunaContainerAppAddress,
  );
  const prior = finalValueResource(
    candidate.prior_state.values.root_module,
    lunaContainerAppAddress,
  );
  planned.values = clone(after);
  planned.sensitive_values = clone(generationApp.change.after_sensitive);
  prior.values = clone(before);
  prior.sensitive_values = clone(beforeSensitive);
  const secretsRole = cutoverChange(
    candidate,
    "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user[0]",
  );
  secretsRole.change = {
    ...clone(secretsRole.change),
    actions: ["no-op"],
    after: clone(secretsRole.change.before),
    after_unknown: {},
    after_sensitive: clone(secretsRole.change.before_sensitive),
  };
  const priorSecretsRole = finalValueResource(
    candidate.prior_state.values.root_module,
    secretsRole.address,
  );
  const plannedKeyVault = candidate.planned_values.root_module.child_modules.find(
    (module) => module.address === "module.workload_key_vault",
  );
  assert.ok(priorSecretsRole);
  assert.ok(plannedKeyVault);
  plannedKeyVault.resources.push({
    address: priorSecretsRole.address,
    index: priorSecretsRole.index,
    mode: priorSecretsRole.mode,
    name: priorSecretsRole.name,
    provider_name: priorSecretsRole.provider_name,
    schema_version: priorSecretsRole.schema_version,
    type: priorSecretsRole.type,
    values: clone(secretsRole.change.after),
    sensitive_values: clone(secretsRole.change.after_sensitive),
  });
  candidate.variables.relay_image_digest.value = postCutoverRelayImage;
  candidate.variables.enable_runtime_secrets_user_assignment.value = true;
  candidate.output_changes.relay_latest_revision_name = clone(
    runtimeCutoverFixture.output_changes.relay_latest_revision_name,
  );
  candidate.planned_values.outputs.relay_latest_revision_name = clone(
    runtimeCutoverFixture.planned_values.outputs.relay_latest_revision_name,
  );
  candidate.prior_state.values.outputs.relay_latest_revision_name = clone(
    runtimeCutoverFixture.prior_state.values.outputs.relay_latest_revision_name,
  );
  candidate.applyable = true;
  return candidate;
}
const FIXTURE_APP_INSIGHTS_RELAY_CONNECTION =
  `InstrumentationKey=${FIXTURE_APP_INSIGHTS_INSTRUMENTATION_KEY};` +
  "IngestionEndpoint=https://eastus2-3.in.applicationinsights.azure.com";
const FIXTURE_SYNTHETIC_KEYS = [
  FIXTURE_LOG_ANALYTICS_PRIMARY_SHARED_KEY,
  FIXTURE_LOG_ANALYTICS_SECONDARY_SHARED_KEY,
  FIXTURE_STORAGE_PRIMARY_ACCESS_KEY,
  FIXTURE_STORAGE_SECONDARY_ACCESS_KEY,
];
const APPROVED_FIXTURE_SENSITIVE_VALUES = new Set([
  null,
  "",
  ...FIXTURE_SYNTHETIC_KEYS,
  FIXTURE_APP_INSIGHTS_INSTRUMENTATION_KEY,
  FIXTURE_APP_INSIGHTS_FULL_CONNECTION,
  FIXTURE_APP_INSIGHTS_RELAY_CONNECTION,
]);

const deploymentAddress =
  'module.foundry.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"]';
const foundryCognitiveAccountId =
  "/subscriptions/a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1/resourceGroups/rg-palancar-dev-aeeacd8c/providers/Microsoft.CognitiveServices/accounts/palancardevopenaiaeeacd8c";
const azurermProviderName = "registry.terraform.io/hashicorp/azurerm";
const containerAppAddress =
  "module.container_app_workload[0].azapi_resource.this";
const operatorPrincipalId = "00000000-0000-0000-0000-000000000003";
const operatorSecurityRoleAddress =
  "module.identities_rbac.azurerm_role_assignment.operator_security_table";
const operatorRateRoleAddress =
  "module.identities_rbac.azurerm_role_assignment.operator_rate_table";
const cliRoleAddress =
  "module.workload_key_vault.azurerm_role_assignment.terraform_cli_secrets_officer";
const RETIRED_WORKLOAD_INPUTS = [
  "key_vault_uri",
  "runtime_secrets_user_role_assignment_id",
];
const OPERATOR_ROLE_ASSIGNMENTS_FOR_TEST = new Set([
  operatorSecurityRoleAddress,
  operatorRateRoleAddress,
]);
const fixtureSubscriptionId = "00000000-0000-0000-0000-000000000000";
const tableRoleDefinitionId =
  `/subscriptions/${fixtureSubscriptionId}/providers/Microsoft.Authorization/roleDefinitions/0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3`;
const tableServiceId =
  `/subscriptions/${fixtureSubscriptionId}/resourceGroups/rg-palancar-dev/providers/Microsoft.Storage/storageAccounts/palancardev/tableServices/default`;

const unrelatedCheckAddress = {
  kind: "resource",
  mode: "managed",
  name: "example",
  to_display: "terraform_data.example",
  type: "terraform_data",
};
const rootFoundryVariableCheckAddress = {
  kind: "var",
  name: "foundry_deployments",
  to_display: "var.foundry_deployments",
};
const moduleFoundryVariableCheckAddress = {
  kind: "var",
  module: "module.foundry",
  name: "deployments",
  to_display: "module.foundry.var.deployments",
};
const moduleFoundryResourceCheckAddress = {
  kind: "resource",
  mode: "managed",
  module: "module.foundry",
  name: "this",
  to_display: "module.foundry.azurerm_cognitive_account.this",
  type: "azurerm_cognitive_account",
};
const cognitiveDeploymentCheckAddress = {
  kind: "resource",
  mode: "managed",
  module: "module.foundry",
  name: "this",
  to_display: "module.foundry.azurerm_cognitive_deployment.this",
  type: "azurerm_cognitive_deployment",
};
const containerAppCheckAddress = {
  kind: "resource",
  mode: "managed",
  module: "module.container_app_workload[0]",
  name: "this",
  to_display: "module.container_app_workload[0].azapi_resource.this",
  type: "azapi_resource",
};
const identityCheckAddress = {
  kind: "resource",
  mode: "managed",
  module: "module.identities_rbac",
  name: "runtime",
  to_display: "module.identities_rbac.azurerm_user_assigned_identity.runtime",
  type: "azurerm_user_assigned_identity",
};
const keyVaultCheckAddress = {
  kind: "resource",
  mode: "managed",
  module: "module.workload_key_vault",
  name: "this",
  to_display: "module.workload_key_vault.azurerm_key_vault.this",
  type: "azurerm_key_vault",
};
const unrelatedRootVariableCheckAddress = {
  kind: "var",
  name: "deploy_relay_workload",
  to_display: "var.deploy_relay_workload",
};
const directDependencyCheckAddress = {
  kind: "resource",
  mode: "managed",
  module: "module.budget",
  name: "this",
  to_display:
    "module.budget.azurerm_consumption_budget_resource_group.this",
  type: "azurerm_consumption_budget_resource_group",
};
const unrelatedOutputCheckAddress = {
  kind: "output_value",
  name: "example",
  to_display: "output.example",
};
const unrelatedCheckBlockAddress = {
  kind: "check",
  name: "example",
  to_display: "check.example",
};
const nestedFoundryCheckBlockAddress = {
  kind: "check",
  module: "module.wrapper.module.foundry",
  name: "example",
  to_display: "module.wrapper.module.foundry.check.example",
};
const nestedFoundryVariableCheckAddress = {
  kind: "var",
  module: 'module.wrapper[0].module.foundry["primary"]',
  name: "deployments",
  to_display:
    'module.wrapper[0].module.foundry["primary"].var.deployments',
};
const nestedBudgetVariableCheckAddress = {
  kind: "var",
  module: "module.wrapper.module.budget",
  name: "amount",
  to_display: "module.wrapper.module.budget.var.amount",
};
const nestedObservabilityResourceCheckAddress = {
  kind: "resource",
  mode: "managed",
  module: "module.wrapper.module.observability",
  name: "example",
  to_display:
    "module.wrapper.module.observability.terraform_data.example",
  type: "terraform_data",
};
const instantiatedObservabilityResourceCheckAddress = {
  ...nestedObservabilityResourceCheckAddress,
  module: 'module.wrapper[0].module.observability["primary"]',
  to_display:
    'module.wrapper[0].module.observability["primary"].terraform_data.example',
};
const unrelatedDataCheckAddress = {
  kind: "resource",
  mode: "data",
  name: "current",
  to_display: "data.azurerm_client_config.current",
  type: "azurerm_client_config",
};
const unrelatedModuleDataCheckAddress = {
  ...unrelatedDataCheckAddress,
  module: "module.unrelated",
  to_display: "module.unrelated.data.azurerm_client_config.current",
};

function terraformCheck(address, status, instanceKey = undefined) {
  const instanceAddress = {
    ...(address.module === undefined ? {} : { module: address.module }),
    to_display:
      instanceKey === undefined
        ? address.to_display
        : `${address.to_display}[${JSON.stringify(instanceKey)}]`,
    ...(instanceKey === undefined ? {} : { instance_key: instanceKey }),
  };

  return {
    address: clone(address),
    status,
    instances: [{ address: instanceAddress, status }],
  };
}

function terraformCheckWithInstanceStatuses(parentStatus, instanceStatuses) {
  return {
    address: clone(unrelatedCheckAddress),
    status: parentStatus,
    instances: instanceStatuses.map((status, instanceKey) => ({
      address: {
        instance_key: instanceKey,
        to_display: `terraform_data.example[${instanceKey}]`,
      },
      status,
    })),
  };
}

const passCheck = terraformCheck(unrelatedCheckAddress, "pass");

const foundationAddresses = [
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
];

function change(address, actions, after = undefined) {
  return {
    address,
    change: {
      actions,
      ...(after === undefined ? {} : { after }),
    },
  };
}

function plan(resourceChanges, extras = {}) {
  return {
    format_version: "1.2",
    resource_changes: resourceChanges,
    ...extras,
  };
}

function clone(value) {
  return structuredClone(value);
}

function fixtureUuidV5Url(name) {
  const namespace = Buffer.from(
    "6ba7b8119dad11d180b400c04fd430c8",
    "hex",
  );
  const bytes = createHash("sha1")
    .update(Buffer.concat([namespace, Buffer.from(name)]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function operatorRoleAssignment(
  address,
  tableName,
  actions = ["create"],
  serviceId = tableServiceId,
) {
  const scope = `${serviceId}/tables/${tableName}`;
  return change(address, actions, {
    name: fixtureUuidV5Url(
      `${scope}/operator/${operatorPrincipalId}/${tableRoleDefinitionId}`,
    ),
    scope,
    role_definition_id: tableRoleDefinitionId,
    principal_id: operatorPrincipalId,
    principal_type: "User",
  });
}

const pinnedAfter = {
  cognitive_account_id: foundryCognitiveAccountId,
  dynamic_throttling_enabled: null,
  name: "gpt-4o-mini-transcribe",
  model: [
    {
      format: "OpenAI",
      name: "gpt-4o-mini-transcribe",
      version: "2025-12-15",
    },
  ],
  sku: [
    {
      capacity: 1,
      family: null,
      name: "GlobalStandard",
      size: null,
      tier: null,
    },
  ],
  timeouts: null,
  version_upgrade_option: "NoAutoUpgrade",
};

function modelCreate(after) {
  return {
    address: deploymentAddress,
    module_address: "module.foundry",
    mode: "managed",
    type: "azurerm_cognitive_deployment",
    name: "this",
    index: "gpt-4o-mini-transcribe",
    provider_name: azurermProviderName,
    change: {
      actions: ["create"],
      before: null,
      after,
      after_unknown: {
        id: true,
        model: [{}],
        rai_policy_name: true,
        sku: [{}],
      },
      before_sensitive: false,
      after_sensitive: {
        model: [{}],
        sku: [{}],
      },
    },
  };
}

const miniCreate = modelCreate(pinnedAfter);
const miniNoOp = change(deploymentAddress, ["no-op"], pinnedAfter);

function containerAppAfter(scale = { minReplicas: 0, maxReplicas: 1 }) {
  return {
    body: {
      properties: {
        template: {
          containers: [
            {
              name: "relay",
              env: [
                envValue(
                  "PALANCAR_LANGUAGE_BOUNDARY_MODE",
                  "development-provisional",
                ),
                envValue(
                  "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
                  '["https://even-webview.synthetic.invalid"]',
                ),
                envValue("PALANCAR_ALLOW_NULL_BROWSER_ORIGIN", "false"),
              ],
            },
          ],
          scale,
        },
      },
    },
  };
}

const appUpdate = change(
  containerAppAddress,
  ["update"],
  containerAppAfter(),
);
const appNoOp = change(containerAppAddress, ["no-op"], containerAppAfter());

const imagePullIdentity =
  "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-image-pull";
const runtimeIdentity =
  "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-palancar-dev-runtime";
const relayImage = `palancardev.azurecr.io/palancar-relay@sha256:${"1".repeat(64)}`;
const litellmImage = `palancardev.azurecr.io/palancar-litellm-proxy@sha256:${"2".repeat(64)}`;

function envValue(name, value) {
  return { name, value };
}

function envSecret(name, secretRef) {
  return { name, secretRef };
}

function runtimeContainerAppAfter(minReplicas = 0) {
  return {
    identity: [
      {
        type: "UserAssigned",
        identity_ids: [imagePullIdentity, runtimeIdentity],
      },
    ],
    body: {
      properties: {
        managedEnvironmentId:
          "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-palancar-dev/providers/Microsoft.App/managedEnvironments/cae-palancar-dev",
        configuration: {
          activeRevisionsMode: "Single",
          ingress: {
            external: true,
            targetPort: 8787,
            transport: "Http",
            allowInsecure: false,
            traffic: [{ latestRevision: true, weight: 100 }],
          },
          registries: [
            { server: "palancardev.azurecr.io", identity: imagePullIdentity },
          ],
          identitySettings: [
            {
              identity: imagePullIdentity.replace("/resourceGroups/", "/resourcegroups/"),
              lifecycle: "None",
            },
            {
              identity: runtimeIdentity.replace("/resourceGroups/", "/resourcegroups/"),
              lifecycle: "Main",
            },
          ],
          secrets: [
            {
              name: "litellm-master-key",
              keyVaultUrl:
                "https://palancar-vault.vault.azure.net/secrets/litellm-master-key",
              identity: runtimeIdentity,
            },
            {
              name: "openrouter-api-key",
              keyVaultUrl:
                "https://palancar-vault.vault.azure.net/secrets/openrouter-api-key",
              identity: runtimeIdentity,
            },
          ],
        },
        template: {
          containers: [
            {
              name: "relay",
              image: relayImage,
              resources: { cpu: 0.25, memory: "0.5Gi" },
              probes: [
                {
                  type: "Liveness",
                  httpGet: { path: "/healthz", port: 8787 },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                  timeoutSeconds: 3,
                  failureThreshold: 3,
                },
                {
                  type: "Readiness",
                  httpGet: { path: "/readyz", port: 8787 },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                  timeoutSeconds: 3,
                  failureThreshold: 3,
                },
              ],
              env: [
                envValue("NODE_ENV", "production"),
                envValue("PORT", "8787"),
                envValue("PALANCAR_GENERATION_PROVIDER", "litellm"),
                envValue("PALANCAR_RELAY_BIND_HOST", "0.0.0.0"),
                envValue("PALANCAR_RELAY_ENVIRONMENT", "dev"),
                envValue(
                  "PALANCAR_RELAY_ORIGIN",
                  "wss://ca-palancar-dev.example.azurecontainerapps.io",
                ),
                envValue("PALANCAR_GATE_POLICY_VERSION", "1.0.0"),
                envValue(
                  "AZURE_CLIENT_ID",
                  "00000000-0000-0000-0000-000000000001",
                ),
                envValue(
                  "PALANCAR_LANGUAGE_BOUNDARY_MODE",
                  "development-provisional",
                ),
                envValue("PALANCAR_SECURITY_MODE", "azure-table"),
                envValue(
                  "PALANCAR_WORKLOAD_TABLE_ENDPOINT",
                  "https://palancardev.table.core.windows.net",
                ),
                envValue("PALANCAR_SECURITY_STATE_TABLE", "SecurityState"),
                envValue("PALANCAR_RATE_STATE_TABLE", "RateState"),
                envValue("PALANCAR_TRANSCRIPTION_PROVIDER", "mock"),
                envValue(
                  "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
                  '["https://even-webview.synthetic.invalid"]',
                ),
                envValue("PALANCAR_ALLOW_NULL_BROWSER_ORIGIN", "false"),
                envValue(
                  "PALANCAR_LITELLM_BASE_URL",
                  "http://127.0.0.1:4000",
                ),
                envValue("PALANCAR_LITELLM_MODEL", "palancar-generation"),
                envSecret("PALANCAR_LITELLM_API_KEY", "litellm-master-key"),
              ],
            },
            {
              name: "litellm",
              image: litellmImage,
              resources: { cpu: 0.25, memory: "0.5Gi" },
              probes: [
                {
                  type: "Liveness",
                  httpGet: { path: "/health/liveliness", port: 4000 },
                  initialDelaySeconds: 10,
                  periodSeconds: 30,
                  timeoutSeconds: 3,
                  failureThreshold: 3,
                },
                {
                  type: "Readiness",
                  httpGet: { path: "/health/readiness", port: 4000 },
                  periodSeconds: 10,
                  timeoutSeconds: 3,
                  failureThreshold: 3,
                },
                {
                  type: "Startup",
                  httpGet: { path: "/health/liveliness", port: 4000 },
                  periodSeconds: 10,
                  timeoutSeconds: 3,
                  failureThreshold: 10,
                },
              ],
              env: [
                envValue("PALANCAR_LITELLM_BACKEND", "openrouter"),
                envValue(
                  "PALANCAR_LITELLM_UPSTREAM_MODEL",
                  "openrouter/openai/gpt-4o-mini",
                ),
                envSecret("LITELLM_MASTER_KEY", "litellm-master-key"),
                envSecret("OPENROUTER_API_KEY", "openrouter-api-key"),
              ],
            },
          ],
          scale: { minReplicas, maxReplicas: 1 },
        },
      },
    },
  };
}

function runtimePlan(appAfter = runtimeContainerAppAfter(), actions = ["update"], extras = {}) {
  return plan(
    [
      ...foundationNoOps.map(clone),
      operatorRoleAssignment(operatorSecurityRoleAddress, "SecurityState"),
      operatorRoleAssignment(operatorRateRoleAddress, "RateState"),
      change(containerAppAddress, actions, appAfter),
    ],
    {
      variables: {
        foundry_deployments: { value: {} },
        operator_principal_id: { value: operatorPrincipalId },
      },
      ...extras,
    },
  );
}

function mutateLanguageBoundary(after, mutation) {
  const env = after.body.properties.template.containers[0].env;
  const index = env.findIndex(
    (entry) => entry.name === "PALANCAR_LANGUAGE_BOUNDARY_MODE",
  );
  assert.notEqual(index, -1);
  if (mutation === "missing") {
    env.splice(index, 1);
    return;
  }
  if (mutation === "deny-all") {
    env[index].value = "deny-all";
    return;
  }
  if (mutation === "duplicate") {
    env.push(envValue(
      "PALANCAR_LANGUAGE_BOUNDARY_MODE",
      "development-provisional",
    ));
    return;
  }
  if (mutation === "secret") {
    delete env[index].value;
    env[index].secretRef = "language-boundary-mode";
    return;
  }
  throw new Error("unsupported language-boundary mutation");
}

function refreshFreeZeroMapRuntimePlan() {
  return runtimePlan(undefined, ["update"], {
    terraform_version: "1.15.8",
    variables: {
      foundry_deployments: { value: {} },
      operator_principal_id: { value: operatorPrincipalId },
      deploy_relay_workload: { value: true },
      enable_litellm_sidecar: { value: true },
    },
    configuration: {
      root_module: {
        resources: [
          {
            address: "azurerm_resource_group.foundation",
            mode: "managed",
            type: "azurerm_resource_group",
            name: "foundation",
          },
        ],
        module_calls: {
          foundry: {
            source: "../../modules/foundry",
            expressions: { deployments: { constant_value: {} } },
            module: {
              resources: [
                {
                  address: "azurerm_cognitive_account.this",
                  mode: "managed",
                  type: "azurerm_cognitive_account",
                  name: "this",
                },
                {
                  address: "azurerm_cognitive_deployment.this",
                  mode: "managed",
                  type: "azurerm_cognitive_deployment",
                  name: "this",
                  for_each_expression: { references: ["var.deployments"] },
                },
              ],
            },
          },
        },
      },
    },
    prior_state: {
      format_version: "1.0",
      values: {
        root_module: {
          child_modules: [
            {
              address: "module.foundry",
              resources: [
                {
                  address: "module.foundry.azurerm_cognitive_account.this",
                  mode: "managed",
                  type: "azurerm_cognitive_account",
                  name: "this",
                  values: { kind: "OpenAI" },
                },
              ],
            },
          ],
        },
      },
    },
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: "module.foundry",
            resources: [
              {
                address: "module.foundry.azurerm_cognitive_account.this",
                mode: "managed",
                type: "azurerm_cognitive_account",
                name: "this",
                values: { kind: "OpenAI" },
              },
            ],
          },
        ],
      },
    },
    resource_drift: [],
    relevant_attributes: [
      {
        resource: "module.container_app_workload[0].azapi_resource.this",
        attribute: ["body"],
      },
      {
        resource: "module.foundry.azurerm_cognitive_deployment.this",
        attribute: [],
      },
    ],
    checks: [passCheck],
  });
}

const foundationNoOps = foundationAddresses.map((address) =>
  change(address, ["no-op"]),
);

function fullPlan(extraChanges = [], extras = {}) {
  return plan(
    [...foundationNoOps.map(clone), miniCreate, ...extraChanges],
    extras,
  );
}

const finalSubscriptionId = "a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1";
const finalResourceGroupId =
  `/subscriptions/${finalSubscriptionId}/resourceGroups/rg-palancar-dev-aeeacd8c`;
const finalAcrLoginServer = "palancardevacraeeacd8c.azurecr.io";
const finalCleanupJobAddress =
  "module.expiry_cleanup_job[0].azapi_resource.this";
const finalFoundryRealtimeEndpoint =
  "wss://palancardevopenaiaeeacd8c.openai.azure.com/openai/v1/realtime?intent=transcription";
const finalRelayImage =
  `${finalAcrLoginServer}/palancar-relay@sha256:${"1".repeat(64)}`;
const finalActionGroupAddress = "azurerm_monitor_action_group.relay";
const finalActionGroupId =
  `${finalResourceGroupId}/providers/Microsoft.Insights/actionGroups/ag-palancar-dev-relay-aeeacd8c`;
const finalAlertAddresses = finalTransitionFixture.resource_changes
  .filter(
    (entry) =>
      entry.type === "azurerm_monitor_scheduled_query_rules_alert_v2",
  )
  .map((entry) => entry.address);

function finalValueModule(root, address) {
  if (address === "") return root;
  for (const child of root.child_modules ?? []) {
    if (child.address === address) return child;
    const nested = finalValueModule(child, address);
    if (nested) return nested;
  }
  return undefined;
}

function finalValueResource(root, address) {
  for (const resource of root.resources ?? []) {
    if (resource.address === address) return resource;
  }
  for (const child of root.child_modules ?? []) {
    const resource = finalValueResource(child, address);
    if (resource) return resource;
  }
  return undefined;
}

function finalChange(planValue, address) {
  return planValue.resource_changes.find((entry) => entry.address === address);
}

function isFinalResourceGroupIdReference(entry) {
  return (
    entry.resource === "azurerm_resource_group.foundation" &&
    Array.isArray(entry.attribute) &&
    entry.attribute.length === 1 &&
    entry.attribute[0] === "id"
  );
}

function finalMakeResourceNoOp(planValue, address, completeAfter) {
  const entry = finalChange(planValue, address);
  const priorSensitive = clone(entry.change.before_sensitive);
  entry.change.actions = ["no-op"];
  entry.change.after = completeAfter;
  entry.change.before = clone(completeAfter);
  entry.change.after_unknown = {};
  entry.change.before_sensitive = clone(priorSensitive);
  entry.change.after_sensitive = clone(priorSensitive);

  if (address === finalCleanupJobAddress) {
    const identity = { id: completeAfter.id, type: null };
    entry.change.before_identity = clone(identity);
    entry.change.after_identity = clone(identity);
  }

  const planned = finalValueResource(
    planValue.planned_values.root_module,
    address,
  );
  planned.values = clone(completeAfter);
  planned.sensitive_values = clone(entry.change.after_sensitive);
  if (entry.change.after_identity) {
    planned.identity_schema_version = 0;
    planned.identity = clone(entry.change.after_identity);
  }

  const moduleAddress = entry.module_address ?? "";
  let module = finalValueModule(
    planValue.prior_state.values.root_module,
    moduleAddress,
  );
  if (!module) {
    module = { resources: [], address: moduleAddress };
    planValue.prior_state.values.root_module.child_modules.push(module);
  }
  const prior = clone(planned);
  const priorIndex = module.resources.findIndex(
    (resource) => resource.address === address,
  );
  if (priorIndex === -1) module.resources.push(prior);
  else module.resources[priorIndex] = prior;
}

function finalRolloutPlan({ idempotent = false } = {}) {
  const planValue = clone(finalTransitionFixture);
  if (!idempotent) return planValue;

  planValue.applyable = false;
  planValue.relevant_attributes = planValue.relevant_attributes.filter(
    (entry) => !isFinalResourceGroupIdReference(entry),
  );

  const appEntry = finalChange(planValue, containerAppAddress);
  const appAfter = clone(appEntry.change.after);
  appAfter.output = clone(appEntry.change.before.output);
  finalMakeResourceNoOp(planValue, containerAppAddress, appAfter);

  for (const [name, outputChange] of Object.entries(planValue.output_changes)) {
    const value =
      name === "relay_latest_revision_name"
        ? appAfter.output.properties.latestRevisionName
        : outputChange.after;
    outputChange.actions = ["no-op"];
    outputChange.before = clone(value);
    outputChange.after = clone(value);
    outputChange.after_unknown = false;
    outputChange.before_sensitive = outputChange.after_sensitive;
    const descriptor = planValue.planned_values.outputs[name];
    descriptor.sensitive = outputChange.after_sensitive;
    descriptor.type ??= "string";
    descriptor.value = clone(value);
    planValue.prior_state.values.outputs[name] = clone(descriptor);
  }
  return planValue;
}

test("final-rollout accepts the reviewed initial and idempotent plans", () => {
  const transition = finalRolloutPlan();
  assert.equal(acceptsPlan(transition, "final-rollout"), true);
  assert.equal(transition.applyable, true);
  assert.equal(transition.relevant_attributes.length, 47);
  const idempotent = finalRolloutPlan({ idempotent: true });
  assert.equal(acceptsPlan(idempotent, "final-rollout"), true);
  assert.equal(idempotent.applyable, false);
  assert.deepEqual(
    idempotent.relevant_attributes,
    transition.relevant_attributes.filter(
      (entry) => !isFinalResourceGroupIdReference(entry),
    ),
  );
  assert.equal(idempotent.resource_changes.length, 39);
  assert.equal(
    idempotent.resource_changes.every(
      (entry) => entry.change.actions[0] === "no-op",
    ),
    true,
  );
  assert.deepEqual(
    finalChange(idempotent, containerAppAddress).change.after_sensitive,
    finalChange(transition, containerAppAddress).change.before_sensitive,
  );
  assert.equal(idempotent.resource_drift, undefined);
});

function rejectsFinalMutation(mutate, idempotent = false) {
  const candidate = finalRolloutPlan({ idempotent });
  mutate(candidate);
  assert.equal(acceptsPlan(candidate, "final-rollout"), false);
}

function approvedFixtureSensitiveLeaves(planValue) {
  const leaves = [];

  function collect(mask, values, path) {
    if (mask === true) {
      leaves.push({ path, value: values });
      return;
    }
    if (Array.isArray(mask)) {
      mask.forEach((entry, index) => {
        collect(entry, values?.[index], `${path}[${index}]`);
      });
      return;
    }
    if (!mask || typeof mask !== "object") return;
    for (const [key, child] of Object.entries(mask)) {
      collect(child, values?.[key], path ? `${path}.${key}` : key);
    }
  }

  function visit(value, path = "") {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "before_sensitive")) {
      collect(value.before_sensitive, value.before, `${path}.before`);
    }
    if (Object.hasOwn(value, "after_sensitive")) {
      collect(value.after_sensitive, value.after, `${path}.after`);
    }
    if (Object.hasOwn(value, "sensitive_values")) {
      collect(value.sensitive_values, value.values, `${path}.values`);
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, path ? `${path}.${key}` : key);
    }
  }

  visit(planValue);
  for (const { path, value } of leaves) {
    const storageConnectionPlaceholder =
      /\.(?:primary|secondary)(?:_blob)?_connection_string$/.test(path) &&
      typeof value === "string" &&
      /^fixture-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
    assert.equal(
      APPROVED_FIXTURE_SENSITIVE_VALUES.has(value) ||
        storageConnectionPlaceholder,
      true,
      `unapproved sensitive fixture value at ${path}`,
    );
  }
  return leaves;
}

function finalAfter(planValue, address) {
  return finalChange(planValue, address).change.after;
}

function mutateFinalAfterCoherently(planValue, address, mutate) {
  const entry = finalChange(planValue, address);
  mutate(entry.change.after);
  const planned = finalValueResource(
    planValue.planned_values.root_module,
    address,
  );
  planned.values = clone(entry.change.after);
  if (entry.change.actions[0] === "no-op") {
    entry.change.before = clone(entry.change.after);
    const prior = finalValueResource(
      planValue.prior_state.values.root_module,
      address,
    );
    prior.values = clone(entry.change.after);
  }
}

function mutateFinalTransitionPriorCoherently(planValue, mutate) {
  const entry = finalChange(planValue, containerAppAddress);
  assert.deepEqual(entry.change.actions, ["update"]);
  mutate(entry.change.before);
  const prior = finalValueResource(
    planValue.prior_state.values.root_module,
    containerAppAddress,
  );
  prior.values = clone(entry.change.before);
}

function mutateFinalContainerAppCoherently(planValue, mutate) {
  mutateFinalAfterCoherently(planValue, containerAppAddress, mutate);
  if (finalChange(planValue, containerAppAddress).change.actions[0] === "update") {
    mutateFinalTransitionPriorCoherently(planValue, mutate);
  }
}

function setFinalPriorRevisionCoherently(planValue, revision) {
  mutateFinalTransitionPriorCoherently(planValue, (before) => {
    before.output.properties.latestRevisionName = revision;
  });
  planValue.prior_state.values.outputs.relay_latest_revision_name.value =
    revision;
  planValue.output_changes.relay_latest_revision_name.before = revision;
}

function mutateFinalJobOutputNoOpCoherently(planValue, mutate) {
  const entry = finalChange(planValue, finalCleanupJobAddress);
  assert.deepEqual(entry.change.actions, ["no-op"]);
  mutate(entry.change.after.output);
  entry.change.before.output = clone(entry.change.after.output);
  const planned = finalValueResource(
    planValue.planned_values.root_module,
    finalCleanupJobAddress,
  );
  planned.values.output = clone(entry.change.after.output);
  const prior = finalValueResource(
    planValue.prior_state.values.root_module,
    finalCleanupJobAddress,
  );
  prior.values.output = clone(entry.change.after.output);
}

function setFinalNoOpOutputCoherently(planValue, name, value) {
  const outputChange = planValue.output_changes[name];
  assert.deepEqual(outputChange.actions, ["no-op"]);
  outputChange.before = clone(value);
  outputChange.after = clone(value);
  planValue.planned_values.outputs[name].value = clone(value);
  planValue.prior_state.values.outputs[name].value = clone(value);
}

function setFinalApplicationInsightsConnectionCoherently(
  planValue,
  transform,
) {
  let fullConnection;
  mutateFinalAfterCoherently(
    planValue,
    "module.observability.azurerm_application_insights.this",
    (after) => {
      after.connection_string = transform(after.connection_string);
      fullConnection = after.connection_string;
    },
  );
  setFinalNoOpOutputCoherently(
    planValue,
    "application_insights_connection_string",
    fullConnection,
  );

  const values = Object.fromEntries(
    fullConnection.split(";").map((segment) => {
      const separator = segment.indexOf("=");
      return [segment.slice(0, separator), segment.slice(separator + 1)];
    }),
  );
  // The reviewed relay receives the canonical reduced connection (key plus
  // ingestion endpoint), so rebuild it from the mutated full provider value.
  const relayConnection =
    `InstrumentationKey=${values.InstrumentationKey.toLowerCase()};` +
    `IngestionEndpoint=${values.IngestionEndpoint.replace(/\/$/, "")}`;
  mutateFinalAfterCoherently(planValue, containerAppAddress, (after) => {
    const env = after.body.properties.template.containers[0].env;
    env.find(
      (entry) => entry.name === "APPLICATIONINSIGHTS_CONNECTION_STRING",
    ).value = relayConnection;
  });
}

function setFinalContactsCoherently(planValue, contacts) {
  planValue.variables.budget_contact_emails.value = clone(contacts);
  mutateFinalAfterCoherently(
    planValue,
    "module.budget.azurerm_consumption_budget_resource_group.this",
    (after) => {
      for (const notification of after.notification) {
        notification.contact_emails = clone(contacts);
      }
    },
  );
  mutateFinalAfterCoherently(planValue, finalActionGroupAddress, (after) => {
    after.email_receiver = contacts.map((email, index) => ({
      email_address: email,
      name: `budget-contact-${String(index + 1).padStart(4, "0")}`,
      use_common_alert_schema: true,
    }));
  });
  const actionGroup = finalChange(planValue, finalActionGroupAddress);
  const sensitiveReceivers = contacts.map(() => ({}));
  actionGroup.change.after_sensitive.email_receiver = clone(sensitiveReceivers);
  if (actionGroup.change.actions[0] === "create") {
    actionGroup.change.after_unknown.email_receiver = clone(sensitiveReceivers);
  } else {
    actionGroup.change.before_sensitive.email_receiver = clone(
      sensitiveReceivers,
    );
  }
  const planned = finalValueResource(
    planValue.planned_values.root_module,
    finalActionGroupAddress,
  );
  planned.sensitive_values.email_receiver = clone(sensitiveReceivers);
  const prior = finalValueResource(
    planValue.prior_state.values.root_module,
    finalActionGroupAddress,
  );
  if (prior) prior.sensitive_values.email_receiver = clone(sensitiveReceivers);
}

test("final-rollout requires the unconditional 39-resource inventory and exact actions", () => {
  const valid = finalRolloutPlan();
  assert.equal(valid.resource_changes.length, 39);
  assert.equal(
    valid.resource_changes.filter((entry) => entry.change.actions[0] === "no-op")
      .length,
    38,
  );
  assert.equal(
    valid.resource_changes.filter((entry) => entry.change.actions[0] === "create")
      .length,
    0,
  );
  assert.equal(
    valid.resource_changes.filter((entry) => entry.change.actions[0] === "update")
      .length,
    1,
  );
  for (const omitted of valid.resource_changes) {
    rejectsFinalMutation((candidate) => {
      candidate.resource_changes = candidate.resource_changes.filter(
        (entry) => entry.address !== omitted.address,
      );
    });
  }
  for (const actions of [["delete"], ["create", "delete"], ["update", "delete"]]) {
    rejectsFinalMutation((candidate) => {
      finalChange(candidate, containerAppAddress).change.actions = actions;
    });
  }
  rejectsFinalMutation((candidate) => {
    candidate.resource_changes.push(clone(candidate.resource_changes[0]));
  });
});

test("final-rollout rejects the superseded nine-create rollout vector", () => {
  const candidate = finalRolloutPlan();
  const createAddresses = new Set([
    "module.identities_rbac.azurerm_role_assignment.runtime_application_insights",
    finalCleanupJobAddress,
    finalActionGroupAddress,
    ...finalAlertAddresses,
  ]);
  for (const entry of candidate.resource_changes) {
    if (createAddresses.has(entry.address)) entry.change.actions = ["create"];
  }
  assert.equal(
    candidate.resource_changes.filter((entry) => entry.change.actions[0] === "no-op")
      .length,
    29,
  );
  assert.equal(
    candidate.resource_changes.filter((entry) => entry.change.actions[0] === "create")
      .length,
    9,
  );
  assert.equal(acceptsPlan(candidate, "final-rollout"), false);
});

test("final-rollout validates and cross-binds the exact relay action group contacts", () => {
  const coherent = finalRolloutPlan();
  setFinalContactsCoherently(coherent, [
    "fixture-contact-0001@redacted.example.net",
    "fixture-contact-0002@redacted.example.net",
  ]);
  assert.equal(acceptsPlan(coherent, "final-rollout"), true);

  rejectsFinalMutation((candidate) => {
    setFinalContactsCoherently(candidate, [
      "fixture-contact-0002@redacted.example.net",
      "fixture-contact-0001@redacted.example.net",
    ]);
  });
  rejectsFinalMutation((candidate) => {
    candidate.variables.budget_contact_emails.value = [
      "fixture-other@redacted.example.net",
    ];
  });
  rejectsFinalMutation((candidate) => {
    mutateFinalAfterCoherently(
      candidate,
      "module.budget.azurerm_consumption_budget_resource_group.this",
      (after) => {
        after.notification[0].contact_emails = [
          "fixture-other@redacted.example.net",
        ];
      },
    );
  });
  rejectsFinalMutation((candidate) => {
    mutateFinalAfterCoherently(candidate, finalActionGroupAddress, (after) => {
      after.email_receiver[0].email_address =
        "fixture-other@redacted.example.net";
    });
  });

  for (const mutate of [
    (after) => { after.enabled = false; },
    (after) => { after.location = "eastus2"; },
    (after) => { after.name += "-other"; },
    (after) => { after.resource_group_name += "-other"; },
    (after) => { after.short_name = "other"; },
    (after) => { after.tags.environment = "prod"; },
    (after) => { after.email_receiver[0].name = "fixture-contact-0001"; },
    (after) => { after.email_receiver[0].use_common_alert_schema = false; },
    (after) => {
      after.sms_receiver.push({ country_code: "1", name: "x", phone_number: "0" });
    },
    (after) => { after.extra_receiver = []; },
  ]) {
    rejectsFinalMutation((candidate) => {
      mutateFinalAfterCoherently(candidate, finalActionGroupAddress, mutate);
    });
  }

  rejectsFinalMutation((candidate) => {
    finalChange(candidate, finalActionGroupAddress).change.after_unknown.extra =
      true;
  });
  rejectsFinalMutation((candidate) => {
    finalChange(candidate, finalActionGroupAddress).change.after_sensitive.extra =
      true;
  });
  rejectsFinalMutation((candidate) => {
    finalChange(candidate, finalActionGroupAddress).change.actions = ["update"];
  });
  rejectsFinalMutation(
    (candidate) => {
      finalChange(candidate, finalActionGroupAddress).change.actions = ["create"];
    },
    true,
  );
  rejectsFinalMutation(
    (candidate) => {
      setFinalNoOpOutputCoherently(
        candidate,
        "relay_action_group_id",
        `${candidate.output_changes.relay_action_group_id.after}-other`,
      );
    },
    true,
  );
});

test("final-rollout validates every exact scheduled-query alert contract", () => {
  for (const address of finalAlertAddresses) {
    for (const mutate of [
      (after) => { after.enabled = false; },
      (after) => { after.severity = 4; },
      (after) => { after.evaluation_frequency = "PT10M"; },
      (after) => { after.window_duration = "PT30M"; },
      (after) => { after.criteria[0].query += "| take 1\n"; },
      (after) => { after.criteria[0].threshold += 1; },
      (after) => { after.criteria[0].time_aggregation_method = "Maximum"; },
      (after) => {
        after.criteria[0].failing_periods[0].minimum_failing_periods_to_trigger_alert =
          2;
      },
      (after) => { after.criteria[0].dimension.push({ name: "SessionId" }); },
      (after) => { after.action[0].action_groups = ["/foreign/action-group"]; },
      (after) => { after.action[0].custom_properties.service = "other"; },
      (after) => { after.action[0].custom_properties.extra = "x"; },
      (after) => { after.action[0].email_subject = "override"; },
      (after) => { after.auto_mitigation_enabled = false; },
      (after) => { after.skip_query_validation = true; },
      (after) => { after.scopes = [finalResourceGroupId]; },
      (after) => { after.name += "-other"; },
      (after) => { after.description += " altered"; },
      (after) => { after.tags.environment = "prod"; },
      (after) => { after.extra = null; },
    ]) {
      rejectsFinalMutation((candidate) => {
        mutateFinalAfterCoherently(candidate, address, mutate);
      });
    }
    rejectsFinalMutation((candidate) => {
      finalChange(candidate, address).change.after_unknown.extra = true;
    });
    rejectsFinalMutation((candidate) => {
      finalChange(candidate, address).change.after_sensitive.extra = true;
    });
    rejectsFinalMutation((candidate) => {
      finalChange(candidate, address).change.actions = ["update"];
    });
    rejectsFinalMutation(
      (candidate) => {
        finalChange(candidate, address).change.actions = ["create"];
      },
      true,
    );
  }
});

test("final-rollout cross-binds the deterministic action-group ID everywhere", () => {
  rejectsFinalMutation((candidate) => {
    candidate.planned_values.outputs.relay_action_group_id.value += "-other";
  });
  rejectsFinalMutation((candidate) => {
    candidate.configuration.root_module.module_calls.observability.expressions.alert_action_group_ids =
      { references: ["local.foreign_action_group_id"] };
  });
  rejectsFinalMutation(
    (candidate) => {
      const foreignId = `${finalActionGroupId}-other`;
      mutateFinalAfterCoherently(candidate, finalActionGroupAddress, (after) => {
        after.name += "-other";
        after.id = foreignId;
      });
      for (const address of finalAlertAddresses) {
        mutateFinalAfterCoherently(candidate, address, (after) => {
          after.action[0].action_groups = [foreignId];
        });
      }
      setFinalNoOpOutputCoherently(
        candidate,
        "relay_action_group_id",
        foreignId,
      );
      candidate.configuration.root_module.module_calls.observability.expressions.alert_action_group_ids =
        { references: ["local.foreign_action_group_id"] };
    },
    true,
  );
});

test("final-rollout rejects action-group and alert address, type, and schema lookalikes", () => {
  for (const address of [finalActionGroupAddress, finalAlertAddresses[0]]) {
    rejectsFinalMutation((candidate) => {
      finalChange(candidate, address).type += "_lookalike";
    });
    rejectsFinalMutation((candidate) => {
      finalValueResource(candidate.planned_values.root_module, address).schema_version +=
        1;
    });
    rejectsFinalMutation((candidate) => {
      finalValueResource(candidate.planned_values.root_module, address).provider_name =
        "registry.terraform.io/hashicorp/lookalike";
    });
    rejectsFinalMutation((candidate) => {
      finalChange(candidate, address).address += "_lookalike";
      finalValueResource(candidate.planned_values.root_module, address).address +=
        "_lookalike";
    });
  }
  rejectsFinalMutation((candidate) => {
    finalChange(candidate, finalAlertAddresses[0]).index = "foreign";
  });
});

test("the final fixture contains only synthetic contacts and credential-free placeholders", () => {
  const contacts = finalTransitionFixture.variables.budget_contact_emails.value;
  assert.deepEqual(contacts, ["fixture-contact-0001@redacted.example.net"]);
  const actionGroup = finalChange(
    finalTransitionFixture,
    finalActionGroupAddress,
  ).change.after;
  assert.deepEqual(
    actionGroup.email_receiver.map((receiver) => receiver.email_address),
    contacts,
  );
  for (const receiver of actionGroup.email_receiver) {
    assert.match(receiver.name, /^budget-contact-\d{4}$/);
    assert.equal(receiver.name.includes(receiver.email_address.split("@")[0]), false);
  }

  assert.match(
    finalFixtureText,
    /palancar-relay@sha256:e9b7e2ea937d3a15f3b3a52e50d9736b5c63c69765c3ee571ab0c06f762436bd/,
  );
  for (const pattern of [
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=]{16,}\b/i,
    /(?:password|api[_-]?key)\s*[:=]\s*[A-Za-z0-9+/=_-]{16,}/i,
  ]) {
    assert.doesNotMatch(finalFixtureText, pattern);
  }

  const parentEnv = new URL("../../../.env", import.meta.url);
  if (existsSync(parentEnv)) {
    const protectedValues = readFileSync(parentEnv, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => line.replace(/^export\s+/, ""))
      .map((line) => {
        const separator = line.indexOf("=");
        return {
          key: line.slice(0, separator),
          value: line
            .slice(separator + 1)
            .trim()
            .replace(/^(?:'([^']*)'|"([^"]*)")$/, "$1$2"),
        };
      })
      .filter(
        ({ key, value }) =>
          /(contact|email|secret|token|password|api.?key|principal|client.?id|instrumentation|connection.?string)/i.test(
            key,
          ) && value.length >= 8,
      );
    const protectedTokens = new Set(
      protectedValues.flatMap(({ value }) => [
        value,
        ...(value.match(/[^\s"'\[\],]+@[^\s"'\[\],]+/g) ?? []),
      ]),
    );
    for (const value of protectedTokens) {
      assert.equal(
        finalFixtureText.includes(value),
        false,
        "fixture contains a protected parent environment value",
      );
    }
  }

  const syntheticUuid = (value) => {
    if (!/^[0-9a-f-]{36}$/.test(value)) return false;
    const counts = new Map();
    for (const character of value.replaceAll("-", "")) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
    return Math.max(...counts.values()) >= 20;
  };
  const taggedValues = [];
  const visit = (value, key = "") => {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, key));
      return;
    }
    if (!value || typeof value !== "object") {
      if (
        typeof value === "string" &&
        /^(?:principal_id|principalId|object_id|client_id|clientId)$/.test(key)
      ) {
        taggedValues.push(value);
      }
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      visit(childValue, childKey);
    }
  };
  visit(finalTransitionFixture);
  assert.equal(
    taggedValues.every((value) => value === "" || syntheticUuid(value)),
    true,
  );
});

test("final-rollout rejects the historical stale predecessor digest", () => {
  const candidate = finalRolloutPlan();
  const liveDigest =
    "e9b7e2ea937d3a15f3b3a52e50d9736b5c63c69765c3ee571ab0c06f762436bd";
  const staleDigest =
    "af41c6ad829046e4e92e548afc50a84e8e0da18ad3e3d37be08e2b877c2809df";
  function replaceDigest(value) {
    if (typeof value === "string") {
      return value.replaceAll(liveDigest, staleDigest);
    }
    if (Array.isArray(value)) {
      return value.map(replaceDigest);
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        value[key] = replaceDigest(child);
      }
    }
    return value;
  }
  replaceDigest(candidate);
  assert.equal(acceptsPlan(candidate, "final-rollout"), false);
});

test("the final fixture permits only approved synthetic sensitive values", () => {
  assert.equal(new Set(FIXTURE_SYNTHETIC_KEYS).size, 4);
  for (const value of FIXTURE_SYNTHETIC_KEYS) {
    assert.match(value, /^[A-Za-z0-9+/]{86}==$/);
  }

  const leaves = approvedFixtureSensitiveLeaves(finalTransitionFixture);
  assert.equal(leaves.length, 66);
  for (const syntheticKey of FIXTURE_SYNTHETIC_KEYS) {
    assert.equal(
      leaves.filter(({ value }) => value === syntheticKey).length,
      4,
    );
  }

  const unknownBase64Key = Buffer.alloc(64, 0x55).toString("base64");
  assert.match(unknownBase64Key, /^[A-Za-z0-9+/]{86}==$/);
  assert.equal(FIXTURE_SYNTHETIC_KEYS.includes(unknownBase64Key), false);
  const candidate = clone(finalTransitionFixture);
  finalChange(
    candidate,
    "module.observability.azurerm_log_analytics_workspace.this",
  ).change.after.primary_shared_key = unknownBase64Key;
  assert.throws(
    () => approvedFixtureSensitiveLeaves(candidate),
    /unapproved sensitive fixture value/,
  );
});

test("final-rollout binds boolean applyable to transition versus idempotent actions", () => {
  assert.equal(finalRolloutPlan().applyable, true);
  assert.equal(finalRolloutPlan({ idempotent: true }).applyable, false);

  rejectsFinalMutation((candidate) => { candidate.applyable = false; });
  rejectsFinalMutation(
    (candidate) => { candidate.applyable = true; },
    true,
  );
  for (const value of [null, 0, 1, "false", "true"]) {
    rejectsFinalMutation((candidate) => { candidate.applyable = value; });
    rejectsFinalMutation(
      (candidate) => { candidate.applyable = value; },
      true,
    );
  }
});

test("final-rollout requires complete/non-errored Terraform 1.15.8 plans", () => {
  for (const mutate of [
    (candidate) => { candidate.complete = false; },
    (candidate) => { candidate.errored = true; },
    (candidate) => { candidate.terraform_version = "1.15.7"; },
    (candidate) => { candidate.deferred_changes = []; },
    (candidate) => { candidate.extra = true; },
  ]) rejectsFinalMutation(mutate);
});

test("final-rollout binds exact relevant attributes to the action envelope", () => {
  const transition = finalRolloutPlan();
  const idempotent = finalRolloutPlan({ idempotent: true });
  const transitionFoundationIds = transition.relevant_attributes.filter(
    isFinalResourceGroupIdReference,
  );
  assert.equal(transition.relevant_attributes.length, 47);
  assert.equal(transitionFoundationIds.length, 1);
  assert.equal(idempotent.relevant_attributes.length, 46);
  assert.deepEqual(
    idempotent.relevant_attributes,
    transition.relevant_attributes.filter(
      (entry) => !isFinalResourceGroupIdReference(entry),
    ),
  );

  rejectsFinalMutation((candidate) => {
    candidate.relevant_attributes = candidate.relevant_attributes.filter(
      (entry) => !isFinalResourceGroupIdReference(entry),
    );
  });
  rejectsFinalMutation(
    (candidate) => {
      candidate.relevant_attributes.push(clone(transitionFoundationIds[0]));
    },
    true,
  );
});

test("final-rollout binds resource sensitivity to update versus no-op actions", () => {
  const transition = finalRolloutPlan();
  const transitionApp = finalChange(transition, containerAppAddress);
  const idempotent = finalRolloutPlan({ idempotent: true });
  const idempotentApp = finalChange(idempotent, containerAppAddress);
  assert.notDeepEqual(
    transitionApp.change.before_sensitive,
    transitionApp.change.after_sensitive,
  );
  assert.deepEqual(
    transitionApp.change.after_sensitive,
    finalChange(finalTransitionFixture, containerAppAddress).change
      .after_sensitive,
  );
  assert.deepEqual(
    idempotentApp.change.after_sensitive,
    transitionApp.change.before_sensitive,
  );
  const expectedAfterSensitive = clone(transitionApp.change.before_sensitive);
  if (Object.hasOwn(transitionApp.change.after_sensitive, "output")) {
    expectedAfterSensitive.output = clone(
      transitionApp.change.after_sensitive.output,
    );
  } else {
    delete expectedAfterSensitive.output;
  }
  assert.deepEqual(transitionApp.change.after_sensitive, expectedAfterSensitive);

  const transitionPrior = finalValueResource(
    transition.prior_state.values.root_module,
    containerAppAddress,
  );
  const transitionPlanned = finalValueResource(
    transition.planned_values.root_module,
    containerAppAddress,
  );
  for (const [values, sensitiveValues] of [
    [transitionApp.change.before, transitionApp.change.before_sensitive],
    [transitionApp.change.after, transitionApp.change.after_sensitive],
    [transitionPrior.values, transitionPrior.sensitive_values],
    [transitionPlanned.values, transitionPlanned.sensitive_values],
  ]) {
    const relayEnv = values.body.properties.template.containers[0].env;
    const relayEnvMask =
      sensitiveValues.body.properties.template.containers[0].env;
    assert.equal(relayEnv.length, 25);
    assert.equal(relayEnvMask.length, relayEnv.length);
    for (const [index, entry] of relayEnv.entries()) {
      assert.deepEqual(
        relayEnvMask[index],
        entry.name === "APPLICATIONINSIGHTS_CONNECTION_STRING"
          ? { value: true }
          : {},
      );
    }
  }

  rejectsFinalMutation((candidate) => {
    const app = finalChange(candidate, containerAppAddress);
    app.change.after_sensitive = clone(app.change.before_sensitive);
    finalValueResource(
      candidate.planned_values.root_module,
      containerAppAddress,
    ).sensitive_values = clone(app.change.after_sensitive);
  });
  rejectsFinalMutation(
    (candidate) => {
      const app = finalChange(candidate, containerAppAddress);
      const transitionAfterSensitive = clone(
        finalChange(finalTransitionFixture, containerAppAddress).change
          .after_sensitive,
      );
      app.change.before_sensitive = clone(transitionAfterSensitive);
      app.change.after_sensitive = clone(transitionAfterSensitive);
      finalValueResource(
        candidate.planned_values.root_module,
        containerAppAddress,
      ).sensitive_values = clone(transitionAfterSensitive);
      finalValueResource(
        candidate.prior_state.values.root_module,
        containerAppAddress,
      ).sensitive_values = clone(transitionAfterSensitive);
    },
    true,
  );
});

test("final-rollout rejects sensitive or malformed relay environment masks", () => {
  const sensitivityMaps = (candidate) => {
    const app = finalChange(candidate, containerAppAddress);
    const prior = finalValueResource(
      candidate.prior_state.values.root_module,
      containerAppAddress,
    );
    const planned = finalValueResource(
      candidate.planned_values.root_module,
      containerAppAddress,
    );
    return [
      app.change.before_sensitive,
      app.change.after_sensitive,
      prior.sensitive_values,
      planned.sensitive_values,
    ];
  };
  const relayEnvMask = (sensitiveValues) =>
    sensitiveValues.body.properties.template.containers[0].env;

  for (const boundaryMask of [{ value: true }, { secretRef: true }]) {
    rejectsFinalMutation((candidate) => {
      for (const sensitiveValues of sensitivityMaps(candidate)) {
        relayEnvMask(sensitiveValues)[24] = clone(boundaryMask);
      }
    });
  }

  rejectsFinalMutation((candidate) => {
    const app = finalChange(candidate, containerAppAddress);
    const prior = finalValueResource(
      candidate.prior_state.values.root_module,
      containerAppAddress,
    );
    relayEnvMask(app.change.before_sensitive)[24] = { value: true };
    relayEnvMask(prior.sensitive_values)[24] = { value: true };
  });

  for (const mutate of [
    (mask) => { mask.pop(); },
    (mask) => { mask.push({}); },
    (mask) => { mask[0] = { value: true }; },
  ]) {
    rejectsFinalMutation((candidate) => {
      for (const sensitiveValues of sensitivityMaps(candidate)) {
        mutate(relayEnvMask(sensitiveValues));
      }
    });
  }
});

test("final-rollout requires the genuine zero-drift transition and idempotent form", () => {
  assert.equal(finalTransitionFixture.resource_drift, undefined);
  assert.equal(finalRolloutPlan().resource_drift, undefined);
  assert.equal(finalRolloutPlan({ idempotent: true }).resource_drift, undefined);
  rejectsFinalMutation((candidate) => { candidate.resource_drift = []; });
  rejectsFinalMutation((candidate) => {
    candidate.resource_drift = [clone(candidate.resource_changes[0])];
  }, true);
});

test("final-rollout rejects import, generated config, deposed state, and malformed action envelopes", () => {
  for (const [where, key] of [
    ["change", "importing"],
    ["change", "generated_config"],
    ["change", "imported"],
    ["change", "deposed"],
    ["resource", "deposed"],
  ]) {
    rejectsFinalMutation((candidate) => {
      const resource = finalChange(candidate, containerAppAddress);
      (where === "change" ? resource.change : resource)[key] =
        key === "generated_config" ? "resource {}" : {};
    });
  }
  rejectsFinalMutation((candidate) => {
    finalChange(candidate, finalCleanupJobAddress).change.before = {};
  });
  rejectsFinalMutation((candidate) => {
    finalChange(candidate, containerAppAddress).change.before = null;
  });
});

test("final-rollout treats the exact ACR and all image repositories literally", () => {
  const substitutions = [
    ["relay_image_digest", "palancardevacraeeacd8cXazurecrYio/palancar-relay"],
    ["litellm_image_digest", "palancardevacraeeacd8c.azurecrXio/palancar-litellm-proxy"],
    ["expiry_cleanup_image_digest", "palancardevacraeeacd8c.azurecr.ioX/palancar-expiry-cleanup"],
  ];
  for (const [name, prefix] of substitutions) {
    rejectsFinalMutation((candidate) => {
      const image = `${prefix}@sha256:${"d".repeat(64)}`;
      candidate.variables[name].value = image;
      if (name === "expiry_cleanup_image_digest") {
        mutateFinalAfterCoherently(candidate, finalCleanupJobAddress, (after) => {
          after.body.properties.template.containers[0].image = image;
        });
      } else {
        const index = name === "relay_image_digest" ? 0 : 1;
        mutateFinalAfterCoherently(candidate, containerAppAddress, (after) => {
          after.body.properties.template.containers[index].image = image;
        });
      }
    });
  }
  rejectsFinalMutation((candidate) => {
    candidate.variables.litellm_image_digest.value =
      candidate.variables.relay_image_digest.value;
  });
  rejectsFinalMutation((candidate) => {
    candidate.variables.relay_image_digest.value =
      `${finalAcrLoginServer}/palancar-relay@sha256:${"d".repeat(64)}`;
  });
  rejectsFinalMutation((candidate) => {
    finalAfter(candidate, containerAppAddress).body.properties.template.containers[0].image =
      candidate.variables.litellm_image_digest.value;
  });
  rejectsFinalMutation((candidate) => {
    finalAfter(candidate, finalCleanupJobAddress).body.properties.template.containers[0].image =
      candidate.variables.relay_image_digest.value;
  });
});

test("final-rollout validates every deterministic role assignment contract", () => {
  const roleAddresses = [
    "module.identities_rbac.azurerm_role_assignment.image_pull_acr",
    "module.identities_rbac.azurerm_role_assignment.runtime_table",
    "module.identities_rbac.azurerm_role_assignment.runtime_openai",
    "module.identities_rbac.azurerm_role_assignment.runtime_application_insights",
    operatorSecurityRoleAddress,
    operatorRateRoleAddress,
    "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user",
    "module.workload_key_vault.azurerm_role_assignment.terraform_cli_secrets_officer",
  ];
  for (const address of roleAddresses) {
    for (const field of ["name", "scope", "role_definition_id", "principal_id", "principal_type"]) {
      rejectsFinalMutation((candidate) => {
        mutateFinalAfterCoherently(candidate, address, (after) => {
          after[field] = `${after[field]}-wrong`;
        });
      });
    }
  }
  rejectsFinalMutation((candidate) => {
    mutateFinalAfterCoherently(candidate, operatorSecurityRoleAddress, (after) => {
      after.scope = finalAfter(candidate, operatorRateRoleAddress).scope;
    });
  });
  rejectsFinalMutation((candidate) => {
    finalAfter(candidate, "module.identities_rbac.azurerm_role_assignment.runtime_table").extra = null;
  });
});

test("v2 recomputes every synthetic-principal-dependent role UUID exactly", () => {
  const roleInputs = [
    [operatorSecurityRoleAddress, (after) =>
      `${after.scope}/operator/${after.principal_id}/${after.role_definition_id}`],
    [operatorRateRoleAddress, (after) =>
      `${after.scope}/operator/${after.principal_id}/${after.role_definition_id}`],
    [cliRoleAddress, (after) =>
      `${after.scope}/terraform-cli/${after.principal_id}/${after.role_definition_id}`],
  ];
  for (const [address, input] of roleInputs) {
    const after = finalChange(finalTransitionFixture, address).change.after;
    const expectedName = fixtureUuidV5Url(input(after));
    assert.equal(after.name, expectedName);
    assert.equal(
      after.id,
      `${after.scope}/providers/Microsoft.Authorization/roleAssignments/${expectedName}`,
    );
  }
});

test("final-rollout rejects a valid UUID with the wrong deterministic role name", () => {
  rejectsFinalMutation((candidate) => {
    const address = operatorSecurityRoleAddress;
    mutateFinalAfterCoherently(candidate, address, (after) => {
      const wrongName = fixtureUuidV5Url(
        `${after.scope}/wrong-role/${after.role_definition_id}`,
      );
      after.name = wrongName;
      after.id = `${after.scope}/providers/Microsoft.Authorization/roleAssignments/${wrongName}`;
    });
    setFinalNoOpOutputCoherently(
      candidate,
      "operator_security_table_role_assignment_id",
      finalAfter(candidate, address).id,
    );
  });
});

test("final-rollout requires exact ordered identities, probes, ingress, containers, and scale", () => {
  const mutations = [
    (after) => { after.identity[0].identity_ids.reverse(); },
    (after) => { after.body.properties.configuration.identitySettings.reverse(); },
    (after) => { after.body.properties.configuration.identitySettings[0].lifecycle = "Main"; },
    (after) => { after.body.properties.configuration.ingress.allowInsecure = true; },
    (after) => { after.body.properties.configuration.ingress.transport = "http"; },
    (after) => { after.body.properties.configuration.ingress.targetPort = 4000; },
    (after) => { after.body.properties.template.containers.reverse(); },
    (after) => { after.body.properties.template.containers[0].probes.reverse(); },
    (after) => { after.body.properties.template.containers[0].probes[0].tcpSocket.port = 4000; },
    (after) => { after.body.properties.template.containers[0].probes[0].httpGet = { path: "/", port: 8787 }; },
    (after) => { after.body.properties.template.containers[0].probes[1].timeoutSeconds = 3; },
    (after) => { after.body.properties.template.containers[1].probes.reverse(); },
    (after) => { after.body.properties.template.containers[1].probes[0].initialDelaySeconds = 11; },
    (after) => { after.body.properties.template.containers[1].probes[0].httpGet = { path: "/", port: 4000 }; },
    (after) => { after.body.properties.template.containers[1].probes[1].timeoutSeconds = 3; },
    (after) => { after.body.properties.template.containers[1].probes[1].httpGet.path = "/always-ready"; },
    (after) => { after.body.properties.template.containers[1].probes[2].httpGet.path = "/health/readiness"; },
    (after) => { after.body.properties.template.scale.minReplicas = 0; },
    (after) => { after.body.properties.template.scale.maxReplicas = 2; },
  ];
  for (const mutate of mutations) {
    rejectsFinalMutation((candidate) => {
      mutateFinalAfterCoherently(candidate, containerAppAddress, mutate);
    });
  }
  rejectsFinalMutation((candidate) => {
    mutateFinalAfterCoherently(candidate, containerAppAddress, (after) => {
      after.body.properties.configuration.identitySettings[0].lifecycle = "Main";
    });
  });
  rejectsFinalMutation((candidate) => {
    mutateFinalAfterCoherently(candidate, containerAppAddress, (after) => {
      after.body.properties.template.containers[0].probes[1].httpGet.path =
        "/always-ready";
    });
  });
});

test("final-rollout pins the remediation resources and aggregate exactly", () => {
  for (const resources of [
    { cpu: 0.25, memory: "0.5Gi" },
    { cpu: 0.5, memory: "1Gi" },
    { cpu: 0.75, memory: "2Gi" },
  ]) {
    rejectsFinalMutation((candidate) => {
      mutateFinalAfterCoherently(candidate, containerAppAddress, (after) => {
        after.body.properties.template.containers[1].resources = clone(resources);
      });
    });
  }
  rejectsFinalMutation((candidate) => {
    finalChange(candidate, containerAppAddress).change.before.body.properties.template.containers[1].resources.cpu = 0.5;
  });
  rejectsFinalMutation((candidate) => {
    mutateFinalAfterCoherently(candidate, containerAppAddress, (after) => {
      after.body.properties.template.containers[0].resources.cpu = 0.5;
    });
  });
  rejectsFinalMutation((candidate) => {
    mutateFinalAfterCoherently(candidate, containerAppAddress, (after) => {
      after.body.properties.template.containers[1].extra = true;
    });
  });
});

test("final-rollout pins the complete prior Container App transition", () => {
  const mutations = [
    (before) => { before.body.properties.template.containers[1].resources.cpu = 0.25; },
    (before) => { before.body.properties.template.containers[1].resources.memory = "0.5Gi"; },
    (before) => { before.body.properties.template.containers[0].resources.cpu = 0.5; },
    (before) => { before.body.properties.template.containers[0].resources.memory = "1Gi"; },
    (before) => { before.body.properties.template.containers[0].image = finalRelayImage; },
    (before) => { before.body.properties.template.containers[0].probes[0].periodSeconds = 11; },
    (before) => { before.body.properties.template.containers[0].env.push({ name: "EXTRA", value: "unexpected" }); },
    (before) => { before.body.properties.configuration.ingress.targetPort = 4000; },
    (before) => { before.output.properties.latestRevisionName += "-altered"; },
  ];
  for (const mutate of mutations) {
    rejectsFinalMutation((candidate) => {
      mutateFinalTransitionPriorCoherently(candidate, mutate);
    });
  }
  for (const staleDigest of [
    "39ce99758799a82e19adf68ce1a60f6dd334b9994565c8f70e37dba9183b3e23",
    "1a884f3cf463b91323a41d4b6ddab7b6a5163dff4bc4f745e7e0b76c1232acbf",
    "d98f53283c4e3209a9bc8b9916b4062f2385c58542f64737700f8a549528185d",
    "7c0a4da718d8214edcf4b0c0e8f74b2b92648cce2af1115858ff6c0f29a0dfb1",
    "ebd41200f7887e940273f1011458910e9e02d31fa19a931e95666e646ae1d045",
    "cab2c5ca0d8ab2d46d71e9079f243f6772e630c753c3c6a7ec04f925b7aae653",
    "cb4c416309ca190e3b8d230b02693fdb837b72b36ee0052e76669abb16bc5cce",
  ]) {
    rejectsFinalMutation((candidate) => {
      mutateFinalTransitionPriorCoherently(candidate, (before) => {
        before.body.properties.template.containers[0].image =
          `${finalAcrLoginServer}/palancar-relay@sha256:${staleDigest}`;
      });
    });
  }
  rejectsFinalMutation((candidate) => {
    setFinalPriorRevisionCoherently(
      candidate,
      "ca-palancar-dev-relay-aeeacd8c--123456x",
    );
  });
});

test("final-rollout requires the complete relay and LiteLLM environments", () => {
  const envMutation = (name, value) => (candidate) => {
    mutateFinalAfterCoherently(candidate, containerAppAddress, (after) => {
      const env = after.body.properties.template.containers[0].env;
      env.find((entry) => entry.name === name).value = value;
    });
  };
  for (const mutate of [
    envMutation("PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT", `${finalFoundryRealtimeEndpoint}/extra`),
    envMutation("PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT", finalFoundryRealtimeEndpoint.replace("?intent=transcription", "?intent=translation")),
    envMutation("PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT", "other"),
    envMutation("PALANCAR_TRANSCRIPTION_PROVIDER", "mock"),
    envMutation("PALANCAR_SECURITY_MODE", "memory"),
    envMutation("APPLICATIONINSIGHTS_STATSBEAT_DISABLED", "false"),
    envMutation("PALANCAR_LITELLM_BASE_URL", "http://localhost:4001"),
  ]) rejectsFinalMutation(mutate);
  rejectsFinalMutation((candidate) => {
    candidate.variables.litellm_upstream_model.value = "openrouter/openai/gpt-4o-mini";
  });
  rejectsFinalMutation((candidate) => {
    mutateFinalAfterCoherently(candidate, containerAppAddress, (after) => {
      after.body.properties.template.containers[1].env[1].value =
        "openrouter/openai/gpt-4o-mini";
    });
  });
  rejectsFinalMutation((candidate) => {
    mutateFinalAfterCoherently(candidate, containerAppAddress, (after) => {
      after.body.properties.configuration.secrets[0].value = "plaintext";
    });
  });
});

test("final-rollout requires the exact plain development language boundary in transition and terminal plans", () => {
  const transition = finalRolloutPlan();
  const transitionChange = finalChange(transition, containerAppAddress).change;
  const prior = finalValueResource(
    transition.prior_state.values.root_module,
    containerAppAddress,
  );
  const planned = finalValueResource(
    transition.planned_values.root_module,
    containerAppAddress,
  );
  for (const values of [
    transitionChange.before,
    prior.values,
    transitionChange.after,
    planned.values,
  ]) {
    const env = values.body.properties.template.containers[0].env;
    assert.equal(env.length, 25);
    assert.deepEqual(env.at(-1), {
      name: "PALANCAR_LANGUAGE_BOUNDARY_MODE",
      value: "development-provisional",
    });
    assert.equal(env.filter(
      (entry) => entry.name === "PALANCAR_LANGUAGE_BOUNDARY_MODE",
    ).length, 1);
  }
  assert.deepEqual(
    transitionChange.before.body.properties.template.containers[0].env,
    transitionChange.after.body.properties.template.containers[0].env,
  );
  assert.deepEqual(
    prior.values.body.properties.template.containers[0].env,
    planned.values.body.properties.template.containers[0].env,
  );

  for (const idempotent of [false, true]) {
    for (const mutation of ["missing", "deny-all", "duplicate", "secret"]) {
      rejectsFinalMutation((candidate) => {
        mutateFinalContainerAppCoherently(candidate, (after) => {
          mutateLanguageBoundary(after, mutation);
        });
      }, idempotent);
    }
    for (const mutate of [
      (after) => {
        after.body.properties.template.containers[0].env.find(
          (entry) => entry.name === "PALANCAR_SECURITY_MODE",
        ).value = "memory";
      },
      (after) => {
        after.body.properties.template.containers[0].env.push(
          envValue("EXTRA", "unexpected"),
        );
      },
    ]) {
      rejectsFinalMutation((candidate) => {
        mutateFinalContainerAppCoherently(candidate, mutate);
      }, idempotent);
    }
  }
});

test("final-rollout binds observability and Container Apps outputs exactly", () => {
  const rotatedKeyPlan = finalRolloutPlan();
  const rotatedKey = "11111111-1111-4111-8111-111111111111";
  let originalKey;
  let rotatedConnection;
  mutateFinalAfterCoherently(
    rotatedKeyPlan,
    "module.observability.azurerm_application_insights.this",
    (after) => {
      originalKey = after.instrumentation_key;
      after.instrumentation_key = rotatedKey;
      after.connection_string = after.connection_string.replace(
        originalKey,
        rotatedKey,
      );
      rotatedConnection = after.connection_string;
    },
  );
  setFinalNoOpOutputCoherently(
    rotatedKeyPlan,
    "application_insights_connection_string",
    rotatedConnection,
  );
  mutateFinalAfterCoherently(
    rotatedKeyPlan,
    containerAppAddress,
    (after) => {
      const env = after.body.properties.template.containers[0].env;
      const connection = env.find(
        (entry) => entry.name === "APPLICATIONINSIGHTS_CONNECTION_STRING",
      );
      connection.value = connection.value.replace(originalKey, rotatedKey);
    },
  );
  mutateFinalTransitionPriorCoherently(rotatedKeyPlan, (before) => {
    const env = before.body.properties.template.containers[0].env;
    const connection = env.find(
      (entry) => entry.name === "APPLICATIONINSIGHTS_CONNECTION_STRING",
    );
    connection.value = connection.value.replace(originalKey, rotatedKey);
  });
  assert.equal(acceptsPlan(rotatedKeyPlan, "final-rollout"), true);

  rejectsFinalMutation((candidate) => {
    setFinalApplicationInsightsConnectionCoherently(candidate, (connection) =>
      connection.replace(
        "https://eastus2.livediagnostics.monitor.azure.com/",
        "https://westus2.livediagnostics.monitor.azure.com/",
      ),
    );
  });

  for (const mutate of [
    (candidate) => { candidate.planned_values.outputs.application_insights_connection_string.value += ";X=1"; },
    (candidate) => { candidate.output_changes.application_insights_connection_string.after += ";X=1"; },
    (candidate) => {
      const env = finalAfter(candidate, containerAppAddress).body.properties.template.containers[0].env;
      env.find((entry) => entry.name === "APPLICATIONINSIGHTS_CONNECTION_STRING").value += "/";
    },
    (candidate) => { candidate.planned_values.outputs.container_app_environment_default_domain.value = "other.azurecontainerapps.io"; },
    (candidate) => { candidate.planned_values.outputs.relay_origin.value = "wss://other.azurecontainerapps.io"; },
    (candidate) => {
      const env = finalAfter(candidate, finalCleanupJobAddress).body.properties.template.containers[0].env;
      env.find((entry) => entry.name === "PALANCAR_RELAY_ORIGIN").value = "wss://other.azurecontainerapps.io";
    },
  ]) rejectsFinalMutation(mutate);

  rejectsFinalMutation((candidate) => {
    const oldHost = "eastus2-3.in.applicationinsights.azure.com";
    const newHost = "other.in.applicationinsights.azure.com";
    let fullConnection;
    mutateFinalAfterCoherently(
      candidate,
      "module.observability.azurerm_application_insights.this",
      (after) => {
        after.connection_string = after.connection_string.replace(oldHost, newHost);
        fullConnection = after.connection_string;
      },
    );
    setFinalNoOpOutputCoherently(
      candidate,
      "application_insights_connection_string",
      fullConnection,
    );
    mutateFinalAfterCoherently(candidate, containerAppAddress, (after) => {
      const env = after.body.properties.template.containers[0].env;
      const connection = env.find(
        (entry) => entry.name === "APPLICATIONINSIGHTS_CONNECTION_STRING",
      );
      connection.value = connection.value.replace(oldHost, newHost);
    });
  });

  rejectsFinalMutation((candidate) => {
    const otherDomain = "other.eastus2.azurecontainerapps.io";
    const appName = finalAfter(candidate, containerAppAddress).name;
    const otherOrigin = `wss://${appName}.${otherDomain}`;
    mutateFinalAfterCoherently(
      candidate,
      "module.container_app_environment.azurerm_container_app_environment.this",
      (after) => { after.default_domain = otherDomain; },
    );
    setFinalNoOpOutputCoherently(
      candidate,
      "container_app_environment_default_domain",
      otherDomain,
    );
    setFinalNoOpOutputCoherently(candidate, "relay_origin", otherOrigin);
    for (const address of [containerAppAddress, finalCleanupJobAddress]) {
      mutateFinalAfterCoherently(candidate, address, (after) => {
        const env = after.body.properties.template.containers[0].env;
        env.find((entry) => entry.name === "PALANCAR_RELAY_ORIGIN").value =
          otherOrigin;
      });
    }
  });

  rejectsFinalMutation((candidate) => {
    mutateFinalAfterCoherently(
      candidate,
      "module.observability.azurerm_application_insights.this",
      (after) => { after.name = "appi-palancar-dev-lookalike"; },
    );
  });

  rejectsFinalMutation((candidate) => {
    mutateFinalAfterCoherently(
      candidate,
      "module.container_app_environment.azurerm_container_app_environment.this",
      (after) => { after.name = "cae-palancar-dev-lookalike"; },
    );
  });
});

test("final-rollout requires the exact expiry cleanup Job contract", () => {
  const mutations = [
    (after) => { after.type = "Microsoft.App/jobs@2025-01-01"; },
    (after) => { after.identity[0].identity_ids.reverse(); },
    (after) => { after.body.properties.configuration.identitySettings.reverse(); },
    (after) => { after.body.properties.configuration.scheduleTriggerConfig.cronExpression = "0 * * * *"; },
    (after) => { after.body.properties.configuration.scheduleTriggerConfig.parallelism = 2; },
    (after) => { after.body.properties.configuration.scheduleTriggerConfig.replicaCompletionCount = 2; },
    (after) => { after.body.properties.configuration.replicaRetryLimit = 1; },
    (after) => { after.body.properties.configuration.replicaTimeout = 301; },
    (after) => { after.body.properties.template.containers[0].resources.cpu = 0.5; },
    (after) => { after.body.properties.template.containers[0].env.push({ name: "EXTRA", value: "x" }); },
    (after) => { after.body.properties.template.containers[0].env[6].value = "1001"; },
    (after) => { after.body.properties.template.containers[0].env[7].value = "240001"; },
    (after) => { after.body.properties.configuration.secrets = []; },
  ];
  for (const mutate of mutations) {
    rejectsFinalMutation((candidate) => {
      mutateFinalAfterCoherently(candidate, finalCleanupJobAddress, mutate);
    });
  }
});

test("final-rollout requires the exact no-op Job provider output shape", () => {
  const mutations = [
    (output) => { output.properties.outboundIpAddresses[0] = "256.1.1.1"; },
    (output) => { output.properties.outboundIpAddresses.push(output.properties.outboundIpAddresses[0]); },
    (output) => { output.properties.outboundIpAddresses[0] = "2001:db8::1"; },
    (output) => { output.properties.outboundIpAddresses = []; },
    (output) => { output.identity.extra = {}; },
    (output) => { delete output.identity.userAssignedIdentities; },
    (output) => {
      const identities = output.identity.userAssignedIdentities;
      const firstId = Object.keys(identities)[0];
      identities[`${firstId}-extra`] = clone(identities[firstId]);
    },
    (output) => {
      const identities = output.identity.userAssignedIdentities;
      const firstId = Object.keys(identities)[0];
      identities[firstId].clientId = "00000000-0000-4000-8000-000000000099";
    },
    (output) => {
      const identities = output.identity.userAssignedIdentities;
      const firstId = Object.keys(identities)[0];
      identities[firstId].principalId = "00000000-0000-4000-8000-000000000099";
    },
  ];
  for (const mutate of mutations) {
    rejectsFinalMutation((candidate) => {
      mutateFinalJobOutputNoOpCoherently(candidate, mutate);
    }, true);
  }
});

test("final-rollout scans exact configuration, planned, prior, relevant, unknown, and sensitive sections", () => {
  const mutations = [
    (candidate) => { candidate.configuration.root_module.resources.push(clone(candidate.configuration.root_module.resources[0])); },
    (candidate) => { candidate.configuration.root_module.module_calls.extra = clone(candidate.configuration.root_module.module_calls.foundry); },
    (candidate) => { candidate.planned_values.root_module.instances = []; },
    (candidate) => { candidate.planned_values.root_module.child_modules[0].resources[0].instances = []; },
    (candidate) => { candidate.prior_state.values.root_module.child_modules[0].resources.push({ address: "module.extra.azapi_resource.this", mode: "managed" }); },
    (candidate) => { candidate.relevant_attributes.push(clone(candidate.relevant_attributes[0])); },
    (candidate) => { candidate.relevant_attributes[0].extra = true; },
    (candidate) => { candidate.checks[0].instances.push(clone(candidate.checks[0].instances[0])); },
    (candidate) => { finalChange(candidate, containerAppAddress).change.after_unknown.extra = true; },
    (candidate) => { finalChange(candidate, containerAppAddress).change.after_sensitive.extra = true; },
    (candidate) => { finalChange(candidate, deploymentAddress).change.after_unknown.model = true; },
  ];
  for (const mutate of mutations) rejectsFinalMutation(mutate);
});

test("final-rollout pins the Terraform v2 boundary reference, check, and unknown envelopes", () => {
  const bodyReferences =
    finalTransitionFixture.configuration.root_module.module_calls
      .container_app_workload.module.resources[0].expressions.body.references;
  assert.deepEqual(bodyReferences, [
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
  ]);

  const boundaryChecks = finalTransitionFixture.checks.filter(
    (check) => check.address.name === "language_boundary_mode",
  );
  assert.deepEqual(boundaryChecks, [
    {
      address: {
        kind: "var",
        module: "module.container_app_workload",
        name: "language_boundary_mode",
        to_display: "module.container_app_workload.var.language_boundary_mode",
      },
      status: "pass",
      instances: [
        {
          address: {
            module: "module.container_app_workload[0]",
            to_display:
              "module.container_app_workload[0].var.language_boundary_mode",
          },
          status: "pass",
        },
      ],
    },
  ]);

  const appChange = finalChange(finalTransitionFixture, containerAppAddress).change;
  const afterEnv = appChange.after.body.properties.template.containers[0].env;
  const unknownEnv =
    appChange.after_unknown.body.properties.template.containers[0].env;
  assert.equal(afterEnv.length, 25);
  assert.equal(unknownEnv.length, afterEnv.length);
  assert.deepEqual(unknownEnv, afterEnv.map(() => ({})));

  rejectsFinalMutation((candidate) => {
    const references =
      candidate.configuration.root_module.module_calls.container_app_workload
        .module.resources[0].expressions.body.references;
    references.splice(
      31,
      4,
      references[32],
      references[33],
      references[34],
      references[31],
    );
  });
  rejectsFinalMutation((candidate) => {
    candidate.checks = candidate.checks.filter(
      (check) => check.address.name !== "language_boundary_mode",
    );
  });
  rejectsFinalMutation((candidate) => {
    candidate.checks.push(clone(boundaryChecks[0]));
  });
  rejectsFinalMutation((candidate) => {
    candidate.checks.find(
      (check) => check.address.name === "language_boundary_mode",
    ).instances[0].status = "fail";
  });
  rejectsFinalMutation((candidate) => {
    finalChange(
      candidate,
      containerAppAddress,
    ).change.after_unknown.body.properties.template.containers[0].env.pop();
  });
});

test("final-rollout requires the genuine child-module hierarchy in planned and prior values", () => {
  rejectsFinalMutation((candidate) => {
    candidate.planned_values.root_module.child_modules.push({
      address: "module.unexpected",
      resources: [],
    });
  });
  rejectsFinalMutation((candidate) => {
    const observability = finalValueModule(
      candidate.planned_values.root_module,
      "module.observability",
    );
    observability.child_modules = [
      { address: "module.observability.module.empty", resources: [] },
    ];
  });
  rejectsFinalMutation(
    (candidate) => {
      candidate.prior_state.values.root_module.child_modules.push({
        address: "module.unexpected",
        resources: [],
      });
    },
    true,
  );
  rejectsFinalMutation(
    (candidate) => {
      const root = candidate.prior_state.values.root_module;
      const index = root.child_modules.findIndex(
        (module) => module.address === "module.container_app_workload[0]",
      );
      const [reparented] = root.child_modules.splice(index, 1);
      const observability = finalValueModule(root, "module.observability");
      observability.child_modules = [reparented];
    },
    true,
  );
});

test("final-rollout enforces exact output action, prior, unknown, and sensitivity coherence", () => {
  rejectsFinalMutation((candidate) => {
    candidate.prior_state.values.outputs.expiry_cleanup_job_id = {
      sensitive: false,
      type: "string",
      value: "unexpected-prior-id",
    };
  });
  rejectsFinalMutation((candidate) => {
    delete candidate.prior_state.values.outputs.acr_id;
  });
  rejectsFinalMutation((candidate) => {
    const change = candidate.output_changes.acr_id;
    change.after = `${change.after}-changed`;
    candidate.planned_values.outputs.acr_id.value = change.after;
  });
  rejectsFinalMutation((candidate) => {
    const change = candidate.output_changes.relay_latest_revision_name;
    change.after = change.before;
    change.after_unknown = false;
    candidate.planned_values.outputs.relay_latest_revision_name = {
      sensitive: false,
      type: "string",
      value: change.after,
    };
  });
  rejectsFinalMutation((candidate) => {
    delete candidate.prior_state.values.outputs.relay_latest_revision_name;
  });
  rejectsFinalMutation((candidate) => {
    candidate.prior_state.values.outputs.relay_latest_revision_name.sensitive =
      true;
    candidate.output_changes.relay_latest_revision_name.before_sensitive = true;
  });
  rejectsFinalMutation((candidate) => {
    const value = "known-too-early";
    const change = candidate.output_changes.expiry_cleanup_job_id;
    change.after = value;
    change.after_unknown = false;
    candidate.planned_values.outputs.expiry_cleanup_job_id = {
      sensitive: false,
      type: "string",
      value,
    };
  });
  rejectsFinalMutation((candidate) => {
    candidate.prior_state.values.outputs.expiry_cleanup_job_name.value +=
      "-altered";
  });
  rejectsFinalMutation((candidate) => {
    candidate.output_changes.acr_id.after_unknown = {};
  });
  rejectsFinalMutation((candidate) => {
    candidate.output_changes.acr_id.after_sensitive = true;
    candidate.output_changes.acr_id.before_sensitive = true;
    candidate.planned_values.outputs.acr_id.sensitive = true;
    candidate.prior_state.values.outputs.acr_id.sensitive = true;
  });
  rejectsFinalMutation((candidate) => {
    candidate.output_changes.acr_id.extra = true;
  });
  rejectsFinalMutation((candidate) => {
    candidate.output_changes.relay_alert_rule_ids.after.provider_failures =
      "/foreign/rule";
  });
  rejectsFinalMutation((candidate) => {
    candidate.output_changes.relay_alert_rule_ids.after_unknown = true;
  });
  rejectsFinalMutation(
    (candidate) => {
      delete candidate.planned_values.outputs.relay_alert_rule_ids.value
        .provider_failures;
      delete candidate.output_changes.relay_alert_rule_ids.before
        .provider_failures;
      delete candidate.output_changes.relay_alert_rule_ids.after
        .provider_failures;
      delete candidate.prior_state.values.outputs.relay_alert_rule_ids.value
        .provider_failures;
    },
    true,
  );
});

test("final-rollout requires all 98 checks to pass with exact envelopes", () => {
  assert.equal(finalTransitionFixture.checks.length, 98);
  assert.equal(
    finalTransitionFixture.checks.every(
      (check) =>
        check.status === "pass" &&
        check.instances.every((instance) => instance.status === "pass"),
    ),
    true,
  );
  rejectsFinalMutation((candidate) => {
    candidate.checks[0].status = "unknown";
  });
  rejectsFinalMutation((candidate) => {
    candidate.checks[0].instances[0].status = "fail";
  });
  rejectsFinalMutation((candidate) => {
    candidate.checks.push(clone(candidate.checks[0]));
  });
  rejectsFinalMutation((candidate) => {
    candidate.checks.reverse();
  });
  rejectsFinalMutation((candidate) => {
    candidate.checks[0].address.to_display += "[0]";
  });
  rejectsFinalMutation(
    (candidate) => {
      candidate.checks[0].status = "unknown";
    },
    true,
  );
});

test("final-rollout rejects extra deployments, workloads, saved-search omissions, and alert configuration changes", () => {
  rejectsFinalMutation((candidate) => {
    candidate.resource_changes.push({
      ...clone(finalChange(candidate, deploymentAddress)),
      address: 'module.foundry.azurerm_cognitive_deployment.this["other"]',
      index: "other",
    });
  });
  rejectsFinalMutation((candidate) => {
    candidate.resource_changes.push({
      ...clone(finalChange(candidate, finalCleanupJobAddress)),
      address: "module.expiry_cleanup_job[1].azapi_resource.this",
      module_address: "module.expiry_cleanup_job[1]",
    });
  });
  const savedSearch = finalTransitionFixture.resource_changes.find((entry) =>
    entry.address.includes('azurerm_log_analytics_saved_search.relay["provider_failures"]'),
  );
  rejectsFinalMutation((candidate) => {
    candidate.resource_changes = candidate.resource_changes.filter(
      (entry) => entry.address !== savedSearch.address,
    );
  });
  rejectsFinalMutation((candidate) => {
    candidate.configuration.root_module.module_calls.observability.module.resources =
      candidate.configuration.root_module.module_calls.observability.module.resources.filter(
        (entry) => entry.type !== "azurerm_monitor_scheduled_query_rules_alert_v2",
      );
  });
});

test("model-spike accepts the exact pinned deployment create", () => {
  assert.equal(acceptsPlan(plan([miniCreate]), "model-spike"), true);
  assert.equal(
    acceptsPlan(plan([miniCreate], { resource_drift: null }), "model-spike"),
    true,
  );
  assert.equal(
    acceptsPlan(plan([miniCreate, appNoOp]), "model-spike"),
    true,
  );
  assert.equal(
    acceptsPlan(
      plan([
        miniCreate,
        change("module.unrelated.resource", ["no-op"]),
      ]),
      "model-spike",
    ),
    true,
  );
});

test("model-spike rejects an imprecise pinned model payload", () => {
  const wrongPayloads = [
    { ...clone(pinnedAfter), cognitive_account_id: `${foundryCognitiveAccountId}/other` },
    { ...clone(pinnedAfter), dynamic_throttling_enabled: false },
    { ...clone(pinnedAfter), timeouts: {} },
    { ...clone(pinnedAfter), model: { ...pinnedAfter.model[0] } },
    {
      ...clone(pinnedAfter),
      model: [{ ...pinnedAfter.model[0], format: "AzureOpenAI" }],
    },
    {
      ...clone(pinnedAfter),
      model: [{ ...pinnedAfter.model[0], name: "gpt-4o-mini" }],
    },
    {
      ...clone(pinnedAfter),
      model: [{ ...pinnedAfter.model[0], version: "2024-01-01" }],
    },
    {
      ...clone(pinnedAfter),
      model: [{ ...pinnedAfter.model[0], source: "caller-controlled" }],
    },
    { ...clone(pinnedAfter), model: [...pinnedAfter.model, pinnedAfter.model[0]] },
    { ...clone(pinnedAfter), sku: [{ name: "Standard", capacity: 1 }] },
    {
      ...clone(pinnedAfter),
      sku: [{ ...pinnedAfter.sku[0], capacity: 2 }],
    },
    {
      ...clone(pinnedAfter),
      sku: [{ ...pinnedAfter.sku[0], tier: "Standard" }],
    },
    { ...clone(pinnedAfter), sku: { name: "GlobalStandard", capacity: 1 } },
    { ...clone(pinnedAfter), version_upgrade_option: "Once" },
    { ...clone(pinnedAfter), caller_controlled: true },
  ];

  for (const after of wrongPayloads) {
    assert.equal(
      acceptsPlan(plan([modelCreate(after)]), "model-spike"),
      false,
    );
  }

  assert.equal(
    acceptsPlan(plan([change(deploymentAddress, ["create"])]), "model-spike"),
    false,
  );
  assert.equal(
    acceptsPlan(
      plan([
        change(
          'module.foundry.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe-2025-12-15"]',
          ["create"],
          pinnedAfter,
        ),
      ]),
      "model-spike",
    ),
    false,
  );

  const missingName = clone(pinnedAfter);
  delete missingName.name;
  assert.equal(
    acceptsPlan(plan([modelCreate(missingName)]), "model-spike"),
    false,
  );

  const wrongName = clone(pinnedAfter);
  wrongName.name = "other";
  assert.equal(
    acceptsPlan(plan([modelCreate(wrongName)]), "model-spike"),
    false,
  );

  for (const key of Object.keys(pinnedAfter)) {
    const missingTopLevelField = clone(pinnedAfter);
    delete missingTopLevelField[key];
    assert.equal(
      acceptsPlan(plan([modelCreate(missingTopLevelField)]), "model-spike"),
      false,
      `missing deployment after.${key} should reject`,
    );
  }

  for (const key of Object.keys(pinnedAfter.model[0])) {
    const missingModelField = clone(pinnedAfter);
    delete missingModelField.model[0][key];
    assert.equal(
      acceptsPlan(plan([modelCreate(missingModelField)]), "model-spike"),
      false,
      `missing deployment model.${key} should reject`,
    );
  }

  for (const key of Object.keys(pinnedAfter.sku[0])) {
    const missingSkuField = clone(pinnedAfter);
    delete missingSkuField.sku[0][key];
    assert.equal(
      acceptsPlan(plan([modelCreate(missingSkuField)]), "model-spike"),
      false,
      `missing deployment sku.${key} should reject`,
    );
  }
});

test("model-spike requires the exact target resource-change envelope", () => {
  for (const key of Object.keys(miniCreate)) {
    const missingEnvelopeField = clone(miniCreate);
    delete missingEnvelopeField[key];
    assert.equal(
      acceptsPlan(plan([missingEnvelopeField]), "model-spike"),
      false,
      `missing resource change ${key} should reject`,
    );
  }

  const envelopeMutations = [
    (resourceChange) => { resourceChange.address += ".caller"; },
    (resourceChange) => { resourceChange.module_address = "module.wrapper.module.foundry"; },
    (resourceChange) => { resourceChange.mode = "data"; },
    (resourceChange) => { resourceChange.type = "terraform_data"; },
    (resourceChange) => { resourceChange.name = "other"; },
    (resourceChange) => { resourceChange.index = "other"; },
    (resourceChange) => { resourceChange.provider_name = "registry.terraform.io/caller/azurerm"; },
    (resourceChange) => { resourceChange.extra = true; },
  ];
  for (const mutate of envelopeMutations) {
    const resourceChange = clone(miniCreate);
    mutate(resourceChange);
    assert.equal(acceptsPlan(plan([resourceChange]), "model-spike"), false);
  }

  for (const key of Object.keys(miniCreate.change)) {
    const missingChangeField = clone(miniCreate);
    delete missingChangeField.change[key];
    assert.equal(
      acceptsPlan(plan([missingChangeField]), "model-spike"),
      false,
      `missing resource change.change.${key} should reject`,
    );
  }

  const extraChangeField = clone(miniCreate);
  extraChangeField.change.extra = true;
  assert.equal(acceptsPlan(plan([extraChangeField]), "model-spike"), false);

  const wrongActions = clone(miniCreate);
  wrongActions.change.actions = ["no-op"];
  assert.equal(acceptsPlan(plan([wrongActions]), "model-spike"), false);
});

test("all modes require the supported Terraform JSON plan format", () => {
  const malformedVersions = [undefined, {}, "1.1", "1.3"];
  const validPlans = [
    [plan([miniCreate]), "model-spike"],
    [fullPlan(), "full-deploy"],
    [runtimePlan(), "runtime-rollout"],
    [finalRolloutPlan(), "final-rollout"],
  ];

  for (const [validPlan, mode] of validPlans) {
    assert.equal(acceptsPlan(validPlan, mode), true);
    for (const formatVersion of malformedVersions) {
      const candidate = clone(validPlan);
      if (formatVersion === undefined) {
        delete candidate.format_version;
      } else {
        candidate.format_version = formatVersion;
      }
      assert.equal(acceptsPlan(candidate, mode), false);
    }
  }
});

test("model-spike rejects unknown or sensitive pinned deployment inputs", () => {
  const mutations = [
    (resourceChange) => { resourceChange.change.after_unknown.name = true; },
    (resourceChange) => { resourceChange.change.after_unknown.model = true; },
    (resourceChange) => { resourceChange.change.after_unknown.model[0].name = true; },
    (resourceChange) => { resourceChange.change.after_unknown.model[0].version = true; },
    (resourceChange) => { resourceChange.change.after_unknown.sku = true; },
    (resourceChange) => { resourceChange.change.after_unknown.sku[0].name = true; },
    (resourceChange) => { resourceChange.change.after_unknown.sku[0].capacity = true; },
    (resourceChange) => { resourceChange.change.after_unknown.version_upgrade_option = true; },
    (resourceChange) => { resourceChange.change.after_sensitive.name = true; },
    (resourceChange) => { resourceChange.change.after_sensitive.model = true; },
    (resourceChange) => { resourceChange.change.after_sensitive.model[0].name = true; },
    (resourceChange) => { resourceChange.change.after_sensitive.model[0].version = true; },
    (resourceChange) => { resourceChange.change.after_sensitive.sku = true; },
    (resourceChange) => { resourceChange.change.after_sensitive.sku[0].name = true; },
    (resourceChange) => { resourceChange.change.after_sensitive.sku[0].capacity = true; },
    (resourceChange) => { resourceChange.change.after_sensitive.version_upgrade_option = true; },
  ];

  for (const mutate of mutations) {
    const resourceChange = clone(miniCreate);
    mutate(resourceChange);
    assert.equal(acceptsPlan(plan([resourceChange]), "model-spike"), false);
  }
});

test("model-spike rejects other mutations and replacements", () => {
  assert.equal(
    acceptsPlan(plan([change("module.other.resource", ["create"])]), "model-spike"),
    false,
  );
  assert.equal(
    acceptsPlan(plan([change(deploymentAddress, ["update"], pinnedAfter)]), "model-spike"),
    false,
  );
  assert.equal(
    acceptsPlan(
      plan([
        change(deploymentAddress, ["create", "delete"], pinnedAfter),
      ]),
      "model-spike",
    ),
    false,
  );
  assert.equal(
    acceptsPlan(
      plan([change(containerAppAddress, ["no-op"]), miniCreate]),
      "model-spike",
    ),
    false,
  );
});

test("model-spike allows only unrelated unknown Terraform checks", () => {
  for (const address of [
    unrelatedCheckAddress,
    containerAppCheckAddress,
    identityCheckAddress,
    keyVaultCheckAddress,
    unrelatedRootVariableCheckAddress,
  ]) {
    assert.equal(
      acceptsPlan(
        plan([miniCreate], {
          checks: [terraformCheck(address, "unknown")],
        }),
        "model-spike",
      ),
      true,
    );
  }
  assert.equal(
    acceptsPlan(
      plan([miniCreate], {
        checks: [
          {
            address: clone(unrelatedRootVariableCheckAddress),
            status: "unknown",
          },
        ],
      }),
      "model-spike",
    ),
    true,
  );

  for (const address of [
    rootFoundryVariableCheckAddress,
    moduleFoundryVariableCheckAddress,
    moduleFoundryResourceCheckAddress,
    cognitiveDeploymentCheckAddress,
    nestedFoundryVariableCheckAddress,
  ]) {
    assert.equal(
      acceptsPlan(
        plan([miniCreate], {
          checks: [terraformCheck(address, "unknown")],
        }),
        "model-spike",
      ),
      false,
    );
  }
  assert.equal(
    acceptsPlan(
      plan([miniCreate], {
        checks: [terraformCheck(cognitiveDeploymentCheckAddress, "unknown", "gpt-4o-mini-transcribe")],
      }),
      "model-spike",
    ),
    false,
  );

  for (const address of [
    unrelatedOutputCheckAddress,
    unrelatedCheckBlockAddress,
    nestedFoundryCheckBlockAddress,
  ]) {
    assert.equal(
      acceptsPlan(
        plan([miniCreate], {
          checks: [terraformCheck(address, "unknown")],
        }),
        "model-spike",
      ),
      false,
    );
  }
  assert.equal(
    acceptsPlan(
      plan([miniCreate], {
        checks: [terraformCheck(directDependencyCheckAddress, "unknown")],
      }),
      "model-spike",
    ),
    false,
  );
  for (const address of [
    nestedBudgetVariableCheckAddress,
    nestedObservabilityResourceCheckAddress,
    instantiatedObservabilityResourceCheckAddress,
  ]) {
    assert.equal(
      acceptsPlan(
        plan([miniCreate], {
          checks: [terraformCheck(address, "unknown")],
        }),
        "model-spike",
      ),
      false,
    );
  }

  for (const status of ["fail", "error"]) {
    assert.equal(
      acceptsPlan(
        plan([miniCreate], {
          checks: [terraformCheck(unrelatedCheckAddress, status)],
        }),
        "model-spike",
      ),
      false,
    );
  }

  assert.equal(
    acceptsPlan(
      plan(
        [miniCreate, change("module.unrelated.resource", ["update"])],
        { checks: [terraformCheck(unrelatedCheckAddress, "unknown")] },
      ),
      "model-spike",
    ),
    false,
  );
});

test("model-spike rejects malformed or lookalike Terraform check addresses", () => {
  const moduleAddress = {
    kind: "resource",
    mode: "managed",
    module: "module.unrelated",
    name: "example",
    to_display: "module.unrelated.terraform_data.example",
    type: "terraform_data",
  };
  const invalidEscapeModule = String.raw`module.unrelated["\q"]`;
  const noncanonicalEscapeModule = String.raw`module.unrelated["\u0061"]`;
  const unpairedSurrogateModule = String.raw`module.unrelated["\ud800"]`;
  const malformedChecks = [
    undefined,
    null,
    {},
    { status: "unknown" },
    { address: "var.foundry_deployments", status: "unknown" },
    {
      address: { ...unrelatedCheckAddress, extra: true },
      status: "unknown",
    },
    { address: clone(unrelatedCheckAddress), status: "UNKNOWN" },
    {
      address: clone(unrelatedCheckAddress),
      status: "unknown",
      instances: { status: "unknown" },
    },
    {
      address: clone(unrelatedCheckAddress),
      status: "unknown",
      instances: [{ status: "unknown" }],
    },
    {
      address: clone(unrelatedCheckAddress),
      status: "unknown",
      instances: [
        {
          address: { to_display: "module.foundry.var.deployments" },
          status: "unknown",
        },
      ],
    },
    {
      address: {
        ...clone(unrelatedCheckAddress),
        to_display: moduleFoundryResourceCheckAddress.to_display,
      },
      status: "unknown",
    },
    {
      address: {
        ...clone(rootFoundryVariableCheckAddress),
        name: "other",
      },
      status: "unknown",
    },
    {
      address: clone(moduleAddress),
      status: "unknown",
      instances: [
        {
          address: {
            module: "module.unrelated[0].module.foundry",
            to_display:
              "module.unrelated[0].module.foundry.terraform_data.example",
          },
          status: "unknown",
        },
      ],
    },
    {
      address: {
        ...clone(moduleAddress),
        module: invalidEscapeModule,
        to_display: `${invalidEscapeModule}.terraform_data.example`,
      },
      status: "unknown",
    },
    {
      address: {
        ...clone(moduleAddress),
        module: noncanonicalEscapeModule,
        to_display: `${noncanonicalEscapeModule}.terraform_data.example`,
      },
      status: "unknown",
    },
    {
      address: clone(moduleAddress),
      status: "unknown",
      instances: [
        {
          address: {
            module: invalidEscapeModule,
            to_display: `${invalidEscapeModule}.terraform_data.example`,
          },
          status: "unknown",
        },
      ],
    },
    {
      address: {
        ...clone(moduleAddress),
        module: unpairedSurrogateModule,
        to_display: `${unpairedSurrogateModule}.terraform_data.example`,
      },
      status: "unknown",
    },
    terraformCheck(unrelatedCheckAddress, "unknown", "\ud800"),
  ];

  for (const check of malformedChecks) {
    assert.equal(
      acceptsPlan(plan([miniCreate], { checks: [check] }), "model-spike"),
      false,
    );
  }
});

test("Terraform data check displays are mode-aware and canonical", () => {
  for (const address of [
    unrelatedDataCheckAddress,
    unrelatedModuleDataCheckAddress,
  ]) {
    assert.equal(
      acceptsPlan(
        plan([miniCreate], {
          checks: [terraformCheck(address, "unknown")],
        }),
        "model-spike",
      ),
      true,
    );
  }

  const missingDataPrefix = clone(unrelatedDataCheckAddress);
  missingDataPrefix.to_display = "azurerm_client_config.current";
  assert.equal(
    acceptsPlan(
      plan([miniCreate], {
        checks: [terraformCheck(missingDataPrefix, "unknown")],
      }),
      "model-spike",
    ),
    false,
  );

  const spuriousDataPrefix = clone(unrelatedCheckAddress);
  spuriousDataPrefix.to_display = "data.terraform_data.example";
  assert.equal(
    acceptsPlan(
      plan([miniCreate], {
        checks: [terraformCheck(spuriousDataPrefix, "unknown")],
      }),
      "model-spike",
    ),
    false,
  );
});

test("Terraform check instances have fail-closed aggregate semantics", () => {
  const acceptedChecks = [
    terraformCheckWithInstanceStatuses("pass", ["pass"]),
    terraformCheckWithInstanceStatuses("unknown", ["pass", "unknown"]),
    {
      address: clone(unrelatedCheckAddress),
      status: "unknown",
    },
    {
      address: {
        kind: "resource",
        mode: "managed",
        module: "module.unrelated",
        name: "example",
        to_display: "module.unrelated.terraform_data.example",
        type: "terraform_data",
      },
      status: "unknown",
      instances: [
        {
          address: {
            module: "module.unrelated[0]",
            to_display: "module.unrelated[0].terraform_data.example",
          },
          status: "unknown",
        },
      ],
    },
  ];

  for (const check of acceptedChecks) {
    assert.equal(
      acceptsPlan(plan([miniCreate], { checks: [check] }), "model-spike"),
      true,
    );
  }

  const rejectedChecks = [
    { address: clone(unrelatedCheckAddress), status: "unknown", instances: null },
    { address: clone(unrelatedCheckAddress), status: "pass", instances: [] },
    { address: clone(unrelatedCheckAddress), status: "unknown", instances: [] },
    terraformCheckWithInstanceStatuses("pass", ["unknown"]),
    terraformCheckWithInstanceStatuses("pass", ["pass", "unknown"]),
    terraformCheckWithInstanceStatuses("unknown", ["pass"]),
    terraformCheckWithInstanceStatuses("unknown", ["fail"]),
    terraformCheckWithInstanceStatuses("unknown", ["error"]),
    terraformCheckWithInstanceStatuses("fail", ["error"]),
    terraformCheckWithInstanceStatuses("error", ["fail"]),
  ];

  const duplicateInstances = terraformCheck(
    unrelatedCheckAddress,
    "unknown",
    0,
  );
  duplicateInstances.instances.push(clone(duplicateInstances.instances[0]));
  rejectedChecks.push(duplicateInstances);

  for (const check of rejectedChecks) {
    assert.equal(
      acceptsPlan(plan([miniCreate], { checks: [check] }), "model-spike"),
      false,
    );
  }
});

test("full-deploy and runtime-rollout keep all check statuses strict", () => {
  assert.equal(
    acceptsPlan(
      fullPlan([], {
        checks: [terraformCheck(unrelatedCheckAddress, "unknown")],
      }),
      "full-deploy",
    ),
    false,
  );
  assert.equal(
    acceptsPlan(
      runtimePlan(undefined, ["update"], {
        checks: [terraformCheck(unrelatedCheckAddress, "unknown")],
      }),
      "runtime-rollout",
    ),
    false,
  );
});

test("Container App update and no-op require the allowed scale values", () => {
  assert.equal(
    acceptsPlan(
      plan([
        miniCreate,
        change(
          containerAppAddress,
          ["update"],
          containerAppAfter({ minReplicas: 1, maxReplicas: 1 }),
        ),
      ]),
      "model-spike",
    ),
    false,
  );
  assert.equal(
    acceptsPlan(
      plan([miniCreate, change(containerAppAddress, ["update"])]),
      "model-spike",
    ),
    false,
  );
  assert.equal(
    acceptsPlan(
      plan([
        miniCreate,
        change(containerAppAddress, ["no-op"], {
          properties: {
            template: { scale: { minReplicas: 0, maxReplicas: 1 } },
          },
        }),
      ]),
      "model-spike",
    ),
    false,
  );
  assert.equal(
    acceptsPlan(
      plan([
        miniCreate,
        change(containerAppAddress, ["no-op"], containerAppAfter({
          minReplicas: 0,
          maxReplicas: 1,
          rules: [],
        })),
      ]),
      "model-spike",
    ),
    true,
  );
});

test("full-deploy accepts a realistic complete foundation plan", () => {
  assert.equal(acceptsPlan(fullPlan(), "full-deploy"), true);
  assert.equal(
    acceptsPlan(
      fullPlan([appUpdate], { checks: [passCheck] }),
      "full-deploy",
    ),
    true,
  );
});

test("full-deploy accepts a complete no-op inventory after deployment", () => {
  const noOpPlan = plan([
    ...foundationNoOps.map(clone),
    miniNoOp,
    appNoOp,
  ], { checks: [passCheck] });

  assert.equal(acceptsPlan(noOpPlan, "full-deploy"), true);
});

test("full-deploy requires the exact fail-closed browser origin policy for Container App mutations and no-ops", () => {
  const policyMutations = [
    (after) => {
      after.body.properties.template.containers[0].env = after.body.properties.template.containers[0].env.filter(
        (item) => item.name !== "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
      );
    },
    (after) => {
      after.body.properties.template.containers[0].env = after.body.properties.template.containers[0].env.filter(
        (item) => item.name !== "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
      );
    },
    (after) => {
      after.body.properties.template.containers[0].env.find(
        (item) => item.name === "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
      ).value = '["https://even-webview.example.com"]';
    },
    (after) => {
      after.body.properties.template.containers[0].env.find(
        (item) => item.name === "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
      ).value = "true";
    },
    (after) => {
      after.body.properties.template.containers[0].env.find(
        (item) => item.name === "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
      ).value = "null";
    },
  ];

  for (const actions of [["update"], ["no-op"]]) {
    for (const mutate of policyMutations) {
      const after = containerAppAfter();
      mutate(after);
      assert.equal(
        acceptsPlan(
          fullPlan([change(containerAppAddress, actions, after)]),
          "full-deploy",
        ),
        false,
      );
    }
  }
});

test("full-deploy requires the exact plain development language boundary on app updates and no-ops", () => {
  for (const actions of [["update"], ["no-op"]]) {
    for (const mutation of ["missing", "deny-all", "duplicate", "secret"]) {
      const after = containerAppAfter();
      mutateLanguageBoundary(after, mutation);
      assert.equal(
        acceptsPlan(
          fullPlan([change(containerAppAddress, actions, after)]),
          "full-deploy",
        ),
        false,
      );
    }
  }
});

test("full-deploy requires configured identities RBAC role assignments", () => {
  const configRoleAssignment =
    "module.identities_rbac.azurerm_role_assignment.extra";
  const stateRoleAssignment =
    "module.identities_rbac.azurerm_role_assignment.from_state";
  const extras = {
    configuration: {
      root_module: {
        child_modules: [
          {
            address: "module.identities_rbac",
            resources: [{ address: configRoleAssignment }],
          },
        ],
      },
    },
    prior_state: {
      values: {
        root_module: {
          child_modules: [
            {
              address: "module.identities_rbac",
              resources: [{ address: stateRoleAssignment }],
            },
          ],
        },
      },
    },
  };

  assert.equal(
    acceptsPlan(
      fullPlan([
        change(configRoleAssignment, ["no-op"]),
        change(stateRoleAssignment, ["no-op"]),
      ], extras),
      "full-deploy",
    ),
    true,
  );
  assert.equal(
    acceptsPlan(
      fullPlan([change(configRoleAssignment, ["create"])], extras),
      "full-deploy",
    ),
    false,
  );
  assert.equal(
    acceptsPlan(
      fullPlan([change(stateRoleAssignment, ["no-op"])], extras),
      "full-deploy",
    ),
    false,
  );
});

test("full-deploy rejects empty, targeted, incomplete, or duplicated plans", () => {
  assert.equal(acceptsPlan(plan([]), "full-deploy"), false);
  assert.equal(acceptsPlan(plan([miniCreate]), "full-deploy"), false);

  for (const omittedAddress of foundationAddresses) {
    const incompleteChanges = fullPlan().resource_changes.filter(
      (resourceChange) => resourceChange.address !== omittedAddress,
    );
    assert.equal(
      acceptsPlan(plan(incompleteChanges), "full-deploy"),
      false,
      `omitting ${omittedAddress} should reject the plan`,
    );
  }

  assert.equal(
    acceptsPlan(
      plan([
        ...foundationNoOps.map(clone),
        miniCreate,
        clone(foundationNoOps[0]),
      ]),
      "full-deploy",
    ),
    false,
  );
});

test("full-deploy discovers configured Key Vault role assignments dynamically", () => {
  const configuredRoleAssignment =
    "module.workload_key_vault.azurerm_role_assignment.audit_reader";
  const extras = {
    configuration: {
      root_module: {
        child_modules: [
          {
            address: "module.workload_key_vault",
            resources: [{ address: configuredRoleAssignment }],
          },
        ],
      },
    },
  };

  assert.equal(
    acceptsPlan(
      fullPlan([change(configuredRoleAssignment, ["no-op"])], extras),
      "full-deploy",
    ),
    true,
  );
  assert.equal(
    acceptsPlan(
      fullPlan([change(configuredRoleAssignment, ["update"])], extras),
      "full-deploy",
    ),
    false,
  );
});

test("full-deploy rejects deletes, replacements, drift, failed checks, and retired deployment", () => {
  assert.equal(
    acceptsPlan(
      fullPlan([
        change(containerAppAddress, ["delete"], containerAppAfter()),
      ]),
      "full-deploy",
    ),
    false,
  );
  assert.equal(
    acceptsPlan(
      fullPlan([
        change(
          containerAppAddress,
          ["update", "delete"],
          containerAppAfter(),
        ),
      ]),
      "full-deploy",
    ),
    false,
  );
  assert.equal(
    acceptsPlan(fullPlan([], { resource_drift: [miniNoOp] }), "full-deploy"),
    false,
  );
  assert.equal(
    acceptsPlan(fullPlan([], { checks: [{ status: "error" }] }), "full-deploy"),
    false,
  );
  assert.equal(
    acceptsPlan(
      fullPlan([
        change(
          'module.foundry.azurerm_cognitive_deployment.this["gpt-5-6-luna"]',
          ["no-op"],
        ),
      ]),
      "full-deploy",
    ),
    false,
  );
});

test("every supplied check must have status exactly pass", () => {
  for (const checks of [
    [{ status: "error" }],
    [{ status: "PASS" }],
    [{ status: "success" }],
    [{ status: 0 }],
    [{}],
    ["pass"],
    { status: "pass" },
  ]) {
    assert.equal(
      acceptsPlan(fullPlan([], { checks }), "full-deploy"),
      false,
    );
  }

  assert.equal(acceptsPlan(fullPlan([], { checks: [] }), "full-deploy"), true);
  assert.equal(
    acceptsPlan(fullPlan([], { checks: [passCheck] }), "full-deploy"),
    true,
  );
});

test("runtime-rollout accepts only the exact OpenRouter workload at min zero or one", () => {
  for (const actions of [["create"], ["update"], ["no-op"]]) {
    assert.equal(
      acceptsPlan(runtimePlan(runtimeContainerAppAfter(0), actions), "runtime-rollout"),
      true,
    );
    assert.equal(
      acceptsPlan(runtimePlan(runtimeContainerAppAfter(1), actions), "runtime-rollout"),
      true,
    );
  }

  const computedIdentityOutputs = runtimePlan();
  computedIdentityOutputs.resource_changes.at(-1).change.after_unknown = {
    identity: [{ principal_id: true, tenant_id: true }],
  };
  assert.equal(
    acceptsPlan(computedIdentityOutputs, "runtime-rollout"),
    true,
  );

  const reversedIdentityOrder = runtimePlan();
  reversedIdentityOrder.resource_changes.at(-1).change.after.identity[0].identity_ids = [
    runtimeIdentity,
    imagePullIdentity,
  ];
  assert.equal(acceptsPlan(reversedIdentityOrder, "runtime-rollout"), true);
});

test("runtime-rollout requires the exact plain development language boundary for every app action", () => {
  for (const actions of [["create"], ["update"], ["no-op"]]) {
    for (const mutation of ["missing", "deny-all", "duplicate", "secret"]) {
      const after = runtimeContainerAppAfter();
      mutateLanguageBoundary(after, mutation);
      assert.equal(acceptsPlan(runtimePlan(after, actions), "runtime-rollout"), false);
    }
  }
});

test("runtime-rollout accepts a realistic refresh-free zero-map plan with only the Container App update", () => {
  const fixture = refreshFreeZeroMapRuntimePlan();
  const staticDeclaration =
    fixture.configuration.root_module.module_calls.foundry.module.resources[1];

  assert.equal(staticDeclaration.type, "azurerm_cognitive_deployment");
  assert.deepEqual(fixture.variables.foundry_deployments.value, {});
  assert.deepEqual(fixture.relevant_attributes, [
    {
      resource: "module.container_app_workload[0].azapi_resource.this",
      attribute: ["body"],
    },
    {
      resource: "module.foundry.azurerm_cognitive_deployment.this",
      attribute: [],
    },
  ]);
  assert.equal(
    fixture.resource_changes.filter(
      (resourceChange) =>
        resourceChange.change.actions[0] !== "no-op",
    ).length,
    3,
  );
  assert.equal(acceptsPlan(fixture, "runtime-rollout"), true);

  staticDeclaration.instances = [];
  assert.equal(acceptsPlan(fixture, "runtime-rollout"), true);
});

test("runtime-rollout requires foundry_deployments to be an exact plain empty map", () => {
  const invalidVariables = [
    undefined,
    {},
    { foundry_deployments: {} },
    { foundry_deployments: { value: {}, extra: true } },
    { foundry_deployments: { value: null } },
    { foundry_deployments: { value: [] } },
    { foundry_deployments: { value: "{}" } },
    { foundry_deployments: { value: { unexpected: true } } },
  ];

  for (const variables of invalidVariables) {
    const fixture = refreshFreeZeroMapRuntimePlan();
    fixture.variables = variables;
    assert.equal(acceptsPlan(fixture, "runtime-rollout"), false);
  }

  const nonPlain = refreshFreeZeroMapRuntimePlan();
  nonPlain.variables.foundry_deployments.value = Object.create(null);
  assert.equal(acceptsPlan(nonPlain, "runtime-rollout"), false);
});

test("runtime-rollout requires an exact canonical operator principal variable", () => {
  const invalidValues = [
    undefined,
    null,
    "00000000-0000-0000-0000-00000000000A",
    "{00000000-0000-0000-0000-000000000003}",
    "00000000000000000000000000000003",
  ];

  for (const value of invalidValues) {
    const fixture = refreshFreeZeroMapRuntimePlan();
    if (value === undefined) {
      delete fixture.variables.operator_principal_id;
    } else {
      fixture.variables.operator_principal_id = { value };
    }
    assert.equal(acceptsPlan(fixture, "runtime-rollout"), false);
  }

  const extraDescriptorKey = refreshFreeZeroMapRuntimePlan();
  extraDescriptorKey.variables.operator_principal_id.extra = true;
  assert.equal(acceptsPlan(extraDescriptorKey, "runtime-rollout"), false);
});

test("runtime-rollout permits exact operator table assignments once, then requires no-op", () => {
  const initial = refreshFreeZeroMapRuntimePlan();
  assert.equal(acceptsPlan(initial, "runtime-rollout"), true);

  const missing = refreshFreeZeroMapRuntimePlan();
  missing.resource_changes = missing.resource_changes.filter(
    (resourceChange) => resourceChange.address !== operatorRateRoleAddress,
  );
  assert.equal(acceptsPlan(missing, "runtime-rollout"), false);

  const invalidMutations = [
    (after) => { after.scope = `${tableServiceId}/tables/Other`; },
    (after) => { after.scope = after.scope.replace("palancardev", "otherdev"); },
    (after) => { after.role_definition_id = after.role_definition_id.replace("0a9a7e1f", "1a9a7e1f"); },
    (after) => { after.principal_id = "00000000-0000-0000-0000-000000000004"; },
    (after) => { after.principal_type = "ServicePrincipal"; },
    (after) => { after.name = "00000000-0000-5000-8000-000000000000"; },
  ];

  for (const mutate of invalidMutations) {
    const fixture = refreshFreeZeroMapRuntimePlan();
    const assignment = fixture.resource_changes.find(
      (resourceChange) =>
        resourceChange.address === operatorSecurityRoleAddress,
    );
    mutate(assignment.change.after);
    assert.equal(acceptsPlan(fixture, "runtime-rollout"), false);
  }

  const crossAccount = refreshFreeZeroMapRuntimePlan();
  const securityIndex = crossAccount.resource_changes.findIndex(
    (resourceChange) =>
      resourceChange.address === operatorSecurityRoleAddress,
  );
  crossAccount.resource_changes[securityIndex] = operatorRoleAssignment(
    operatorSecurityRoleAddress,
    "SecurityState",
    ["create"],
    tableServiceId.replace("palancardev", "otherdev"),
  );
  assert.equal(acceptsPlan(crossAccount, "runtime-rollout"), false);

  const prematureNoOp = refreshFreeZeroMapRuntimePlan();
  for (const resourceChange of prematureNoOp.resource_changes) {
    if (OPERATOR_ROLE_ASSIGNMENTS_FOR_TEST.has(resourceChange.address)) {
      resourceChange.change.actions = ["no-op"];
    }
  }
  assert.equal(acceptsPlan(prematureNoOp, "runtime-rollout"), false);

  const existing = refreshFreeZeroMapRuntimePlan();
  existing.prior_state.values.root_module.child_modules.push({
    address: "module.identities_rbac",
    resources: [
      { address: operatorSecurityRoleAddress, mode: "managed" },
      { address: operatorRateRoleAddress, mode: "managed" },
    ],
  });
  for (const resourceChange of existing.resource_changes) {
    if (OPERATOR_ROLE_ASSIGNMENTS_FOR_TEST.has(resourceChange.address)) {
      resourceChange.change.actions = ["no-op"];
    }
  }
  assert.equal(acceptsPlan(existing, "runtime-rollout"), true);

  const recreateExisting = clone(existing);
  recreateExisting.resource_changes.find(
    (resourceChange) =>
      resourceChange.address === operatorSecurityRoleAddress,
  ).change.actions = ["create"];
  assert.equal(acceptsPlan(recreateExisting, "runtime-rollout"), false);
});

test("runtime-rollout permits only the exact unindexed zero-count cognitive configuration declaration", () => {
  const invalidMutations = [
    (declaration) => {
      declaration.address =
        'azurerm_cognitive_deployment.this["actual-model"]';
    },
    (declaration) => {
      declaration.index = "actual-model";
    },
    (declaration) => {
      declaration.index_expression = { constant_value: "actual-model" };
    },
    (declaration) => {
      declaration.count_expression = { constant_value: 0 };
    },
    (declaration) => {
      declaration.mode = "data";
    },
    (declaration) => {
      delete declaration.mode;
    },
    (declaration) => {
      delete declaration.address;
    },
    (declaration) => {
      delete declaration.type;
    },
    (declaration) => {
      declaration.name = "other";
    },
    (declaration) => {
      delete declaration.for_each_expression;
    },
    (declaration) => {
      declaration.for_each_expression.references = ["var.other"];
    },
    (declaration) => {
      declaration.instances = {};
    },
  ];

  for (const mutate of invalidMutations) {
    const fixture = refreshFreeZeroMapRuntimePlan();
    const declaration =
      fixture.configuration.root_module.module_calls.foundry.module.resources[1];
    mutate(declaration);
    assert.equal(acceptsPlan(fixture, "runtime-rollout"), false);
  }

  const duplicate = refreshFreeZeroMapRuntimePlan();
  const resources =
    duplicate.configuration.root_module.module_calls.foundry.module.resources;
  resources.push(clone(resources[1]));
  assert.equal(acceptsPlan(duplicate, "runtime-rollout"), false);

  const referenced = refreshFreeZeroMapRuntimePlan();
  referenced.configuration.root_module.references = [
    'module.foundry.azurerm_cognitive_deployment.this["actual-model"]',
  ];
  assert.equal(acceptsPlan(referenced, "runtime-rollout"), false);

  const malformed = refreshFreeZeroMapRuntimePlan();
  malformed.configuration.root_module.module_calls.foundry.module.resources[1] = {
    type: "azurerm_cognitive_deployment",
    name: "this",
  };
  assert.equal(acceptsPlan(malformed, "runtime-rollout"), false);
});

test("runtime-rollout rejects cognitive deployment instances in every actual-instance plan section", () => {
  const deploymentInstance = {
    address:
      'module.foundry.azurerm_cognitive_deployment.this["actual-model"]',
    mode: "managed",
    type: "azurerm_cognitive_deployment",
    name: "this",
    index: "actual-model",
    values: { name: "actual-model" },
  };

  const fixtures = [];

  const priorState = refreshFreeZeroMapRuntimePlan();
  priorState.prior_state.values.root_module.child_modules[0].resources.push(
    clone(deploymentInstance),
  );
  fixtures.push(priorState);

  const plannedValues = refreshFreeZeroMapRuntimePlan();
  plannedValues.planned_values.root_module.child_modules[0].resources.push(
    clone(deploymentInstance),
  );
  fixtures.push(plannedValues);

  const noOpChange = refreshFreeZeroMapRuntimePlan();
  noOpChange.resource_changes.push(
    change(deploymentInstance.address, ["no-op"], pinnedAfter),
  );
  fixtures.push(noOpChange);

  const drift = refreshFreeZeroMapRuntimePlan();
  drift.resource_drift.push(
    change(deploymentInstance.address, ["no-op"], pinnedAfter),
  );
  fixtures.push(drift);

  const configuredInstances = refreshFreeZeroMapRuntimePlan();
  configuredInstances.configuration.root_module.module_calls.foundry.module.resources[1].instances = [
    { index_key: "actual-model" },
  ];
  fixtures.push(configuredInstances);

  const topLevelInstances = refreshFreeZeroMapRuntimePlan();
  topLevelInstances.instances = [clone(deploymentInstance)];
  fixtures.push(topLevelInstances);

  const deferredChanges = refreshFreeZeroMapRuntimePlan();
  deferredChanges.deferred_changes = [
    {
      reason: "instance_count_unknown",
      resource_change: change(
        deploymentInstance.address,
        ["no-op"],
        pinnedAfter,
      ),
    },
  ];
  fixtures.push(deferredChanges);

  for (const fixture of fixtures) {
    assert.equal(acceptsPlan(fixture, "runtime-rollout"), false);
  }
});

test("runtime-rollout permits only the exact zero-instance relevant_attributes marker", () => {
  const invalidRelevantAttributes = [
    [
      {
        resource:
          'module.foundry.azurerm_cognitive_deployment.this["actual-model"]',
        attribute: [],
      },
    ],
    [
      {
        resource: "module.foundry.azurerm_cognitive_deployment.this",
        attribute: ["model"],
      },
    ],
    [
      {
        resource: "module.foundry.azurerm_cognitive_deployment.this",
        attribute: [],
        extra: true,
      },
    ],
    [{ resource: "module.foundry.azurerm_cognitive_deployment.this" }],
    [{ attribute: [] }],
    [null],
    { resource: "module.foundry.azurerm_cognitive_deployment.this", attribute: [] },
  ];

  for (const relevantAttributes of invalidRelevantAttributes) {
    const fixture = refreshFreeZeroMapRuntimePlan();
    fixture.relevant_attributes = Array.isArray(relevantAttributes)
      ? [fixture.relevant_attributes[0], ...relevantAttributes]
      : relevantAttributes;
    assert.equal(acceptsPlan(fixture, "runtime-rollout"), false);
  }
});

test("runtime-rollout requires complete no-op foundation and only one safe app action", () => {
  const missingFoundation = runtimePlan();
  missingFoundation.resource_changes.shift();
  assert.equal(acceptsPlan(missingFoundation, "runtime-rollout"), false);

  const changedFoundation = runtimePlan();
  changedFoundation.resource_changes[0].change.actions = ["update"];
  assert.equal(acceptsPlan(changedFoundation, "runtime-rollout"), false);

  for (const actions of [["delete"], ["create", "delete"], ["update", "delete"]]) {
    assert.equal(
      acceptsPlan(runtimePlan(runtimeContainerAppAfter(), actions), "runtime-rollout"),
      false,
    );
  }

  const extra = runtimePlan();
  extra.resource_changes.push(change("module.unexpected.resource", ["no-op"]));
  assert.equal(acceptsPlan(extra, "runtime-rollout"), false);

  const configuredExtra = "module.identities_rbac.azurerm_role_assignment.audit";
  const configuredPlan = runtimePlan(undefined, ["update"], {
    configuration: {
      root_module: {
        child_modules: [
          {
            address: "module.identities_rbac",
            resources: [{ address: configuredExtra }],
          },
        ],
      },
    },
  });
  assert.equal(acceptsPlan(configuredPlan, "runtime-rollout"), false);
  configuredPlan.resource_changes.push(change(configuredExtra, ["no-op"]));
  assert.equal(acceptsPlan(configuredPlan, "runtime-rollout"), true);
});

test("runtime-rollout excludes only data-mode descriptors from managed foundation inventory", () => {
  const dataAddress =
    "module.identities_rbac.data.azurerm_client_config.current";
  const managedAddress =
    "module.identities_rbac.azurerm_monitor_diagnostic_setting.audit";
  const priorState = {
    values: {
      root_module: {
        child_modules: [
          {
            address: "module.identities_rbac",
            resources: [
              {
                address: dataAddress,
                mode: "data",
                type: "azurerm_client_config",
                name: "current",
              },
            ],
          },
        ],
      },
    },
  };

  const dataOnly = runtimePlan(undefined, ["update"], {
    prior_state: clone(priorState),
  });
  assert.equal(acceptsPlan(dataOnly, "runtime-rollout"), true);

  const managed = runtimePlan(undefined, ["update"], {
    prior_state: clone(priorState),
  });
  managed.prior_state.values.root_module.child_modules[0].resources.push({
    address: managedAddress,
    mode: "managed",
    type: "azurerm_monitor_diagnostic_setting",
    name: "audit",
  });
  assert.equal(acceptsPlan(managed, "runtime-rollout"), false);

  managed.resource_changes.push(change(managedAddress, ["no-op"]));
  assert.equal(acceptsPlan(managed, "runtime-rollout"), true);
});

test("runtime-rollout recursively rejects every cognitive deployment, drift, checks, and workload unknowns", () => {
  for (const extras of [
    {
      prior_state: {
        values: {
          type: "azurerm_cognitive_deployment",
          name: "this",
          index: "any-model",
        },
      },
    },
    {
      resource_drift: [change(containerAppAddress, ["no-op"])],
    },
    { checks: [{ status: "error" }] },
  ]) {
    assert.equal(acceptsPlan(runtimePlan(undefined, ["update"], extras), "runtime-rollout"), false);
  }

  const cognitiveNoOp = runtimePlan();
  cognitiveNoOp.resource_changes.push(
    change(
      'module.foundry.azurerm_cognitive_deployment.this["some-model"]',
      ["no-op"],
    ),
  );
  assert.equal(acceptsPlan(cognitiveNoOp, "runtime-rollout"), false);

  const unknown = runtimePlan();
  unknown.resource_changes.at(-1).change.after_unknown = {
    body: { properties: { template: { containers: true } } },
  };
  assert.equal(acceptsPlan(unknown, "runtime-rollout"), false);

  const unknownIdentity = runtimePlan();
  unknownIdentity.resource_changes.at(-1).change.after_unknown = {
    identity: [{ identity_ids: true }],
  };
  assert.equal(acceptsPlan(unknownIdentity, "runtime-rollout"), false);

  const hiddenSensitiveBody = runtimePlan();
  hiddenSensitiveBody.resource_changes.at(-1).change.after_sensitive = {
    body: { properties: true },
  };
  assert.equal(acceptsPlan(hiddenSensitiveBody, "runtime-rollout"), false);

  const sensitiveBodyAttribute = runtimePlan();
  sensitiveBodyAttribute.resource_changes.at(-1).change.after.sensitive_body = {
    properties: { configuration: { secrets: "fixture-secret" } },
  };
  assert.equal(acceptsPlan(sensitiveBodyAttribute, "runtime-rollout"), false);
});

test("runtime-rollout rejects mutable images, identity drift, revision drift, and invalid scale", () => {
  const mutations = [
    (after) => { after.body.properties.template.containers[0].image = "palancardev.azurecr.io/palancar-relay:latest"; },
    (after) => { after.body.properties.template.containers[1].image = "palancardev.azurecr.io/palancar-litellm-proxy:latest"; },
    (after) => { after.body.properties.template.containers[1].image = `otherdev.azurecr.io/palancar-litellm-proxy@sha256:${"2".repeat(64)}`; },
    (after) => { after.body.properties.template.containers[1].image = `ghcr.io/palancar/litellm-proxy@sha256:${"2".repeat(64)}`; },
    (after) => { after.identity[0].identity_ids = [runtimeIdentity]; },
    (after) => { after.identity[0].identity_ids = [imagePullIdentity, imagePullIdentity]; },
    (after) => { after.identity[0].identity_ids = [imagePullIdentity, imagePullIdentity.toUpperCase()]; },
    (after) => { after.body.properties.configuration.identitySettings[0].identity = imagePullIdentity; },
    (after) => { after.body.properties.configuration.identitySettings[1].identity = runtimeIdentity; },
    (after) => { after.body.properties.configuration.identitySettings[0].identity = imagePullIdentity.toLowerCase(); },
    (after) => { after.body.properties.configuration.identitySettings[1].identity = runtimeIdentity.toLowerCase(); },
    (after) => { after.body.properties.configuration.identitySettings[0].lifecycle = "Main"; },
    (after) => { after.body.properties.configuration.registries[0].identity = runtimeIdentity; },
    (after) => { after.body.properties.configuration.secrets[0].identity = imagePullIdentity; },
    (after) => { after.body.properties.configuration.activeRevisionsMode = "Multiple"; },
    (after) => { after.body.properties.template.containers[0].resources.cpu = 0.5; },
    (after) => { after.body.properties.template.containers[1].resources.memory = "1Gi"; },
    (after) => { after.body.properties.template.containers[0].resources.ephemeralStorage = "1Gi"; },
    (after) => { after.body.properties.template.containers[1].resources.ephemeralStorage = "1Gi"; },
    (after) => { after.body.properties.template.scale.minReplicas = 2; },
    (after) => { after.body.properties.template.scale.maxReplicas = 2; },
    (after) => { after.body.properties.template.scale.rules = []; },
  ];

  for (const mutate of mutations) {
    const after = runtimeContainerAppAfter();
    mutate(after);
    assert.equal(acceptsPlan(runtimePlan(after), "runtime-rollout"), false);
  }
});

test("runtime-rollout requires exact body topology and managed environment boundary", () => {
  const mutations = [
    (after) => { after.body.extra = {}; },
    (after) => { after.body.properties.extra = {}; },
    (after) => { after.body.properties.configuration.dapr = {}; },
    (after) => { after.body.properties.template.initContainers = []; },
    (after) => { after.body.properties.template.volumes = []; },
    (after) => { after.body.properties.template.serviceBinds = []; },
    (after) => { after.body.properties.managedEnvironmentId = after.body.properties.managedEnvironmentId.replace("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001"); },
    (after) => { after.body.properties.managedEnvironmentId = after.body.properties.managedEnvironmentId.replace("rg-palancar-dev", "rg-other"); },
    (after) => { after.body.properties.managedEnvironmentId = after.body.properties.managedEnvironmentId.replace("Microsoft.App", "microsoft.app"); },
    (after) => { after.body.properties.managedEnvironmentId = after.body.properties.managedEnvironmentId.replace("managedEnvironments", "managedenvironments"); },
  ];

  for (const mutate of mutations) {
    const after = runtimeContainerAppAfter();
    mutate(after);
    assert.equal(acceptsPlan(runtimePlan(after), "runtime-rollout"), false);
  }
});

test("runtime-rollout requires the exact HTTP ingress and single-revision traffic topology", () => {
  const mutations = [
    (after) => { after.body.properties.configuration.ingress.external = false; },
    (after) => { after.body.properties.configuration.ingress.allowInsecure = true; },
    (after) => { after.body.properties.configuration.ingress.targetPort = 4000; },
    (after) => { after.body.properties.configuration.ingress.transport = "http"; },
    (after) => { after.body.properties.configuration.ingress.transport = "tcp"; },
    (after) => { after.body.properties.configuration.ingress.exposedPort = 8787; },
    (after) => { after.body.properties.configuration.ingress.additionalPortMappings = []; },
    (after) => { after.body.properties.configuration.ingress.traffic[0].latestRevision = false; },
    (after) => { after.body.properties.configuration.ingress.traffic[0].weight = 99; },
    (after) => { after.body.properties.configuration.ingress.traffic[0].revisionName = "old-revision"; },
    (after) => { after.body.properties.configuration.ingress.traffic.push({ latestRevision: true, weight: 0 }); },
  ];

  for (const mutate of mutations) {
    const after = runtimeContainerAppAfter();
    mutate(after);
    assert.equal(acceptsPlan(runtimePlan(after), "runtime-rollout"), false);
  }
});

test("runtime-rollout requires exact secret-free HTTP probes", () => {
  const mutations = [
    (after) => { after.body.properties.template.containers[0].probes[0].httpGet.path = "/wrong"; },
    (after) => { after.body.properties.template.containers[0].probes[0].httpGet.port = 4000; },
    (after) => { after.body.properties.template.containers[0].probes[0].periodSeconds = 11; },
    (after) => { after.body.properties.template.containers[0].probes[1].initialDelaySeconds = 6; },
    (after) => { after.body.properties.template.containers[0].probes[1].failureThreshold = 4; },
    (after) => { after.body.properties.template.containers[1].probes[0].type = "Readiness"; },
    (after) => { after.body.properties.template.containers[1].probes[0].failureThreshold = 9; },
    (after) => { after.body.properties.template.containers[1].probes[0].initialDelaySeconds = 11; },
    (after) => { after.body.properties.template.containers[1].probes[1].periodSeconds = 11; },
    (after) => { after.body.properties.template.containers[1].probes[2].httpGet.path = "/health/readiness"; },
    (after) => { after.body.properties.template.containers[1].probes[2].timeoutSeconds = 4; },
    (after) => { after.body.properties.template.containers[1].probes[2].initialDelaySeconds = 10; },
    (after) => { after.body.properties.template.containers[0].probes[0].httpGet.scheme = "HTTPS"; },
    (after) => { after.body.properties.template.containers[0].probes[0].httpGet.httpHeaders = [{ name: "Authorization", value: "fixture-secret" }]; },
    (after) => {
      const probe = after.body.properties.template.containers[0].probes[0];
      delete probe.httpGet;
      probe.tcpSocket = { port: 8787 };
    },
    (after) => { after.body.properties.template.containers[0].probes.pop(); },
    (after) => { after.body.properties.template.containers[1].probes.push(clone(after.body.properties.template.containers[1].probes[2])); },
    (after) => { after.body.properties.template.containers[1].probes.reverse(); },
  ];

  for (const mutate of mutations) {
    const after = runtimeContainerAppAfter();
    mutate(after);
    assert.equal(acceptsPlan(runtimePlan(after), "runtime-rollout"), false);
  }

  const unknownProbe = runtimePlan();
  unknownProbe.resource_changes.at(-1).change.after_unknown = {
    body: {
      properties: {
        template: { containers: [{ probes: true }] },
      },
    },
  };
  assert.equal(acceptsPlan(unknownProbe, "runtime-rollout"), false);
});

test("runtime-rollout requires exact security, mock transcription, localhost alias, and sidecar env", () => {
  const mutations = [
    (after) => { after.body.properties.template.containers[0].env.find((item) => item.name === "PALANCAR_SECURITY_MODE").value = "memory"; },
    (after) => { after.body.properties.template.containers[0].env.find((item) => item.name === "PALANCAR_TRANSCRIPTION_PROVIDER").value = "azure"; },
    (after) => { after.body.properties.template.containers[0].env.find((item) => item.name === "PALANCAR_LITELLM_BASE_URL").value = "http://127.0.0.1:4001"; },
    (after) => { after.body.properties.template.containers[0].env.find((item) => item.name === "PALANCAR_LITELLM_MODEL").value = "upstream-model"; },
    (after) => { after.body.properties.template.containers[0].env.push(envValue("PALANCAR_FOUNDRY_DEPLOYMENTS", "model")); },
    (after) => { after.body.properties.template.containers[0].env.push(envValue("PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT", "https://fixture.invalid")); },
    (after) => { after.body.properties.template.containers[1].env.find((item) => item.name === "PALANCAR_LITELLM_BACKEND").value = "azure"; },
    (after) => { after.body.properties.template.containers[1].env.find((item) => item.name === "PALANCAR_LITELLM_UPSTREAM_MODEL").value = "azure/model"; },
    (after) => { after.body.properties.template.containers[1].env.push(envValue("AZURE_API_KEY", "fixture-secret")); },
    (after) => { after.body.properties.template.containers.push({ name: "metadata-helper", image: litellmImage }); },
  ];

  for (const mutate of mutations) {
    const after = runtimeContainerAppAfter();
    mutate(after);
    assert.equal(acceptsPlan(runtimePlan(after), "runtime-rollout"), false);
  }
});

test("runtime-rollout requires the exact fail-closed browser origin policy", () => {
  const policyMutations = [
    (after) => {
      after.body.properties.template.containers[0].env = after.body.properties.template.containers[0].env.filter(
        (item) => item.name !== "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
      );
    },
    (after) => {
      after.body.properties.template.containers[0].env = after.body.properties.template.containers[0].env.filter(
        (item) => item.name !== "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
      );
    },
    (after) => {
      after.body.properties.template.containers[0].env.push(
        envValue(
          "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
          '["https://even-webview.synthetic.invalid"]',
        ),
      );
    },
    (after) => {
      after.body.properties.template.containers[0].env.push(
        envValue("PALANCAR_BROWSER_ORIGIN_EXTRA", "fixture"),
      );
    },
    (after) => {
      after.body.properties.template.containers[0].env.find(
        (item) => item.name === "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
      ).value = "not-json";
    },
    (after) => {
      after.body.properties.template.containers[0].env.find(
        (item) => item.name === "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
      ).value = '["https://*.example.com"]';
    },
    (after) => {
      after.body.properties.template.containers[0].env.find(
        (item) => item.name === "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
      ).value =
        '["https://even-webview.synthetic.invalid","https://even-webview.synthetic.invalid"]';
    },
    (after) => {
      after.body.properties.template.containers[0].env.find(
        (item) => item.name === "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
      ).value = '["https://even-webview.example.com"]';
    },
    (after) => {
      after.body.properties.template.containers[0].env.find(
        (item) => item.name === "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
      ).value = "true";
    },
    (after) => {
      after.body.properties.template.containers[0].env.find(
        (item) => item.name === "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
      ).value = "null";
    },
    (after) => {
      const entry = after.body.properties.template.containers[0].env.find(
        (item) => item.name === "PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON",
      );
      delete entry.value;
      entry.secretRef = "browser-origins";
    },
    (after) => {
      const entry = after.body.properties.template.containers[0].env.find(
        (item) => item.name === "PALANCAR_ALLOW_NULL_BROWSER_ORIGIN",
      );
      delete entry.value;
      entry.secretRef = "allow-null-origin";
    },
  ];

  for (const mutate of policyMutations) {
    const after = runtimeContainerAppAfter();
    mutate(after);
    assert.equal(acceptsPlan(runtimePlan(after), "runtime-rollout"), false);
  }
});

test("runtime-rollout requires versionless same-vault Key Vault refs and no plain secrets", () => {
  const mutations = [
    (after) => { after.body.properties.configuration.secrets[0].keyVaultUrl += "/version"; },
    (after) => { after.body.properties.configuration.secrets[1].keyVaultUrl = "https://other-vault.vault.azure.net/secrets/openrouter-api-key"; },
    (after) => { after.body.properties.configuration.secrets[1].keyVaultUrl = "https://palancar-vault.vault.azure.net/secrets/wrong-name"; },
    (after) => { after.body.properties.configuration.secrets[1].value = "fixture-secret"; },
    (after) => {
      const key = after.body.properties.template.containers[1].env.find((item) => item.name === "OPENROUTER_API_KEY");
      delete key.secretRef;
      key.value = "fixture-secret";
    },
  ];

  for (const mutate of mutations) {
    const after = runtimeContainerAppAfter();
    mutate(after);
    assert.equal(acceptsPlan(runtimePlan(after), "runtime-rollout"), false);
  }
});

function lunaBootstrapPlan() {
  return clone(lunaModelBootstrapFixture);
}

function lunaBootstrapChange(candidate, address) {
  const entry = candidate.resource_changes.find(
    (changeEntry) => changeEntry.address === address,
  );
  assert.ok(entry, `missing Luna bootstrap fixture change: ${address}`);
  return entry;
}

function lunaBootstrapValueResource(root, address) {
  for (const resource of root?.resources ?? []) {
    if (resource.address === address) {
      return resource;
    }
  }
  for (const childModule of root?.child_modules ?? []) {
    const resource = lunaBootstrapValueResource(childModule, address);
    if (resource) {
      return resource;
    }
  }
  return undefined;
}

function lunaBootstrapWalk(value, visit) {
  visit(value);
  if (Array.isArray(value)) {
    value.forEach((child) => lunaBootstrapWalk(child, visit));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((child) => lunaBootstrapWalk(child, visit));
  }
}

function lunaBootstrapReplaceString(value, from, to) {
  lunaBootstrapWalk(value, (child) => {
    if (!child || typeof child !== "object") return;
    for (const [key, nested] of Object.entries(child)) {
      if (typeof nested === "string" && nested.includes(from)) {
        child[key] = nested.replaceAll(from, to);
      }
    }
  });
}

function lunaBootstrapRoleValues(candidate, address, mutate) {
  const change = lunaBootstrapChange(candidate, address);
  for (const value of [change.change.before, change.change.after]) {
    mutate(value);
  }
  for (const root of [
    candidate.prior_state.values.root_module,
    candidate.planned_values.root_module,
  ]) {
    mutate(lunaBootstrapValueResource(root, address).values);
  }
}

const lunaBootstrapRoleOutputNames = new Map([
  [
    "module.identities_rbac.azurerm_role_assignment.operator_security_table",
    "operator_security_table_role_assignment_id",
  ],
  [
    "module.identities_rbac.azurerm_role_assignment.operator_rate_table",
    "operator_rate_table_role_assignment_id",
  ],
  [
    "module.identities_rbac.azurerm_role_assignment.runtime_application_insights",
    "runtime_application_insights_role_assignment_id",
  ],
  [
    "module.identities_rbac.azurerm_role_assignment.runtime_openai",
    "runtime_openai_user_role_assignment_id",
  ],
]);

function lunaBootstrapRecomputeRoleIdentity(candidate, address) {
  const change = lunaBootstrapChange(candidate, address);
  const values = [
    change.change.before,
    change.change.after,
    lunaBootstrapValueResource(candidate.prior_state.values.root_module, address)
      .values,
    lunaBootstrapValueResource(candidate.planned_values.root_module, address)
      .values,
  ];
  const nameInput = (value) => {
    if (address.endsWith("image_pull_acr")) {
      return `${value.scope}/image-pull/${value.role_definition_id}`;
    }
    if (
      address.endsWith("runtime_table") ||
      address.endsWith("runtime_openai")
    ) {
      return `${value.scope}/runtime/${value.role_definition_id}`;
    }
    if (address.endsWith("runtime_application_insights")) {
      return `scope=${value.scope}|principal_id=${value.principal_id}|role_definition_id=${value.role_definition_id}`;
    }
    if (address.includes("operator_")) {
      return `${value.scope}/operator/${value.principal_id}/${value.role_definition_id}`;
    }
    if (address.endsWith("runtime_secrets_user")) {
      return `${value.scope}/runtime/${value.principal_id}/${value.role_definition_id}`;
    }
    return `${value.scope}/terraform-cli/${value.principal_id}/${value.role_definition_id}`;
  };
  for (const value of values) {
    const name = fixtureUuidV5Url(nameInput(value));
    value.name = name;
    value.id = `${value.scope}/providers/Microsoft.Authorization/roleAssignments/${name}`;
  }
  const outputName = lunaBootstrapRoleOutputNames.get(address);
  if (outputName) {
    const id = change.change.after.id;
    candidate.planned_values.outputs[outputName].value = id;
    candidate.prior_state.values.outputs[outputName].value = id;
    candidate.output_changes[outputName].before = id;
    candidate.output_changes[outputName].after = id;
  }
}

function lunaBootstrapSetRuntimeClientId(candidate, clientId) {
  for (const address of [lunaContainerAppAddress, "module.expiry_cleanup_job[0].azapi_resource.this"]) {
    const resourceChange = lunaBootstrapChange(candidate, address);
    for (const value of [resourceChange.change.before, resourceChange.change.after]) {
      const container = value.body.properties.template.containers.find(
        (entry) => ["relay", "expiry-cleanup"].includes(entry.name),
      );
      container.env.find((entry) => entry.name === "AZURE_CLIENT_ID").value =
        clientId;
    }
    for (const root of [
      candidate.planned_values.root_module,
      candidate.prior_state.values.root_module,
    ]) {
      const resource = lunaBootstrapValueResource(root, address);
      const container = resource.values.body.properties.template.containers.find(
        (entry) => ["relay", "expiry-cleanup"].includes(entry.name),
      );
      container.env.find((entry) => entry.name === "AZURE_CLIENT_ID").value =
        clientId;
    }
  }
  const identityAddress =
    "module.identities_rbac.azurerm_user_assigned_identity.runtime";
  const identityChange = lunaBootstrapChange(candidate, identityAddress);
  for (const value of [identityChange.change.before, identityChange.change.after]) {
    value.client_id = clientId;
  }
  for (const root of [
    candidate.planned_values.root_module,
    candidate.prior_state.values.root_module,
  ]) {
    lunaBootstrapValueResource(root, identityAddress).values.client_id = clientId;
  }
  for (const output of [
    candidate.planned_values.outputs.runtime_identity_client_id,
    candidate.prior_state.values.outputs.runtime_identity_client_id,
  ]) {
    output.value = clientId;
  }
  candidate.output_changes.runtime_identity_client_id.before = clientId;
  candidate.output_changes.runtime_identity_client_id.after = clientId;
}

function lunaBootstrapSetRelayImage(candidate, image) {
  candidate.variables.relay_image_digest.value = image;
  const resourceChange = lunaBootstrapChange(candidate, lunaContainerAppAddress);
  for (const value of [resourceChange.change.before, resourceChange.change.after]) {
    value.body.properties.template.containers.find(
      (entry) => entry.name === "relay",
    ).image = image;
  }
  for (const root of [
    candidate.planned_values.root_module,
    candidate.prior_state.values.root_module,
  ]) {
    lunaBootstrapValueResource(root, lunaContainerAppAddress).values.body.properties.template.containers.find(
      (entry) => entry.name === "relay",
    ).image = image;
  }
}

function rejectsLunaBootstrapMutation(mutate) {
  const candidate = lunaBootstrapPlan();
  mutate(candidate);
  const accepted = acceptsPlan(candidate, "luna-model-bootstrap");
  assert.equal(accepted, false);
}

test("luna-model-bootstrap binds the Foundry resource .this declaration", () => {
  assert.equal(
    lunaDeploymentAddress,
    'module.foundry.azurerm_cognitive_deployment.this["gpt-5.6-luna"]',
  );
  assert.ok(
    lunaBootstrapPlan().resource_changes.some(
      (entry) => entry.address === lunaDeploymentAddress,
    ),
  );
});

test("luna-model-bootstrap accepts the complete exact Luna transition", () => {
  const candidate = lunaBootstrapPlan();
  assert.equal(acceptsPlan(candidate, "luna-model-bootstrap"), true);
  assert.equal(candidate.resource_changes.length, 40);
  assert.equal(
    Object.keys(candidate.configuration.root_module.module_calls).length,
    10,
  );
  assert.ok(
    candidate.resource_changes.every(
      (entry) =>
        typeof entry.provider_name === "string",
    ),
  );
  const stateResources = [];
  for (const root of [
    candidate.planned_values.root_module,
    candidate.prior_state.values.root_module,
  ]) {
    lunaBootstrapWalk(root, (value) => {
      if (value?.mode === "managed" || value?.mode === "data") {
        stateResources.push(value);
      }
    });
  }
  assert.ok(
    stateResources.length > 0 &&
      stateResources.every(
        (resource) =>
          typeof resource.provider_name === "string" &&
          Number.isInteger(resource.schema_version) &&
          (resource.identity_schema_version === undefined ||
            (Number.isInteger(resource.identity_schema_version) &&
              resource.identity &&
              typeof resource.identity === "object")),
      ),
  );
  assert.equal(candidate.applyable, true);
  assert.equal(
    candidate.resource_changes.filter((entry) =>
      entry.change.actions.includes("create"),
    ).length,
    1,
  );
  assert.deepEqual(
    candidate.output_changes.foundry_deployment_names,
    {
      actions: ["update"],
      before: ["gpt-4o-mini-transcribe"],
      after: ["gpt-4o-mini-transcribe", "gpt-5.6-luna"],
      after_unknown: false,
      before_sensitive: false,
      after_sensitive: false,
    },
  );
});

test("luna-model-bootstrap fixture is complete and contains only synthetic secret material", () => {
  assert.doesNotMatch(lunaFixtureText, /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/i);
  assert.doesNotMatch(lunaFixtureText, /\bBearer\s+[A-Za-z0-9._-]{12,}\b/i);
  assert.doesNotMatch(lunaFixtureText, /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/);

  const sensitiveKeys = new Set([
    "primary_shared_key",
    "secondary_shared_key",
    "primary_access_key",
    "secondary_access_key",
    "primary_connection_string",
    "secondary_connection_string",
    "primary_blob_connection_string",
    "secondary_blob_connection_string",
    "connection_string",
    "instrumentation_key",
    "admin_password",
  ]);
  lunaBootstrapWalk(lunaBootstrapPlan(), (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (!sensitiveKeys.has(key)) continue;
      if (child !== null && typeof child !== "string") continue;
      assert.equal(
        APPROVED_FIXTURE_SENSITIVE_VALUES.has(child) ||
          (typeof child === "string" &&
            /^fixture-[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(child)),
        true,
        `unapproved Luna fixture sensitive value at ${key}`,
      );
    }
  });
});

test("luna-model-bootstrap rejects every Luna identity and contract mutation", () => {
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapChange(candidate, lunaDeploymentAddress).address =
      'module.foundry.azurerm_cognitive_deployment.this["gpt-5.6-luna-copy"]';
  });
  for (const mutate of [
    (after) => { after.name = "gpt-5.6-luna-copy"; },
    (after) => { after.model[0].name = "gpt-5.6-luna-copy"; },
    (after) => { after.model[0].version = "2026-07-08"; },
    (after) => { after.model[0].format = "AzureOpenAI"; },
    (after) => { after.sku[0].name = "Standard"; },
    (after) => { after.version_upgrade_option = "AutoUpgrade"; },
    (after) => { after.sku[0].capacity = 1000; },
    (after) => { after.sku[0].capacity = 1012; },
    (after) => { after.sku[0].capacity = 1014; },
  ]) {
    rejectsLunaBootstrapMutation((candidate) =>
      mutate(lunaBootstrapChange(candidate, lunaDeploymentAddress).change.after),
    );
  }
});

test("luna-model-bootstrap rejects coordinated structural mutations", () => {
  const resourceGroupAddress = "azurerm_resource_group.foundation";
  const mutations = [
    [
      "added configuration subtree",
      (candidate) => {
        candidate.configuration.root_module.module_calls.unexpected = clone(
          candidate.configuration.root_module.module_calls.foundry,
        );
      },
    ],
    [
      "added variable",
      (candidate) => {
        candidate.variables.unexpected = { value: "caller-controlled" };
      },
    ],
    [
      "added relevant attribute",
      (candidate) => {
        candidate.relevant_attributes.push(clone(candidate.relevant_attributes[0]));
      },
    ],
    [
      "added prior resource field",
      (candidate) => {
        lunaBootstrapValueResource(
          candidate.prior_state.values.root_module,
          resourceGroupAddress,
        ).unexpected = true;
      },
    ],
    [
      "added planned resource field",
      (candidate) => {
        lunaBootstrapValueResource(
          candidate.planned_values.root_module,
          resourceGroupAddress,
        ).unexpected = true;
      },
    ],
    [
      "coordinated planned/prior type mutation",
      (candidate) => {
        lunaBootstrapValueResource(
          candidate.prior_state.values.root_module,
          resourceGroupAddress,
        ).type = "terraform_data";
        lunaBootstrapValueResource(
          candidate.planned_values.root_module,
          resourceGroupAddress,
        ).type = "terraform_data";
      },
    ],
    [
      "coordinated resource-change and state type mutation",
      (candidate) => {
        lunaBootstrapChange(candidate, resourceGroupAddress).type =
          "terraform_data";
        lunaBootstrapValueResource(
          candidate.prior_state.values.root_module,
          resourceGroupAddress,
        ).type = "terraform_data";
        lunaBootstrapValueResource(
          candidate.planned_values.root_module,
          resourceGroupAddress,
        ).type = "terraform_data";
      },
    ],
    [
      "resource-change provider metadata mutation",
      (candidate) => {
        lunaBootstrapChange(candidate, resourceGroupAddress).provider_name =
          "registry.terraform.io/caller/azurerm";
      },
    ],
    [
      "resource-change module location mutation",
      (candidate) => {
        lunaBootstrapChange(candidate, lunaTranscriptionAddress).module_address =
          "module.wrapper.module.foundry";
      },
    ],
    [
      "resource-group identity envelope mutation",
      (candidate) => {
        const change = lunaBootstrapChange(candidate, resourceGroupAddress).change;
        change.before_identity.name = "rg-palancar-dev-attacker";
        change.after_identity.name = "rg-palancar-dev-attacker";
      },
    ],
    [
      "prior root structural field",
      (candidate) => {
        candidate.prior_state.values.root_module.unexpected = true;
      },
    ],
    [
      "planned root structural field",
      (candidate) => {
        candidate.planned_values.root_module.unexpected = true;
      },
    ],
    [
      "no-op before/after value mismatch",
      (candidate) => {
        lunaBootstrapChange(candidate, resourceGroupAddress).change.before = {
          unexpected: true,
        };
      },
    ],
    [
      "no-op identity envelope mismatch",
      (candidate) => {
        lunaBootstrapChange(candidate, resourceGroupAddress).change.after_identity.name =
          "rg-palancar-dev-aeeacd8c-other";
      },
    ],
  ];

  for (const [reason, mutate] of mutations) {
    const candidate = lunaBootstrapPlan();
    mutate(candidate);
    assert.equal(
      acceptsPlan(candidate, "luna-model-bootstrap"),
      false,
      `${reason} must reject`,
    );
  }
});

test("luna-model-bootstrap accepts genuine Terraform 1.15.8 dynamic no-op values", () => {
  const candidate = lunaBootstrapPlan();
  const resourceGroupName = "rg-palancar-dev-aeeacd8c";
  const subscriptionId = candidate.variables.subscription_id.value;
  const resourceGroupValues = {
    id: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}`,
    location: candidate.variables.location.value,
    managed_by: "",
    name: resourceGroupName,
    tags: {
      application: "palancar",
      environment: "dev",
      "managed-by": "terraform",
      "data-classification": "operational-metadata",
    },
    timeouts: null,
  };
  const resourceGroupChange = lunaBootstrapChange(
    candidate,
    "azurerm_resource_group.foundation",
  );
  resourceGroupChange.change.before = clone(resourceGroupValues);
  resourceGroupChange.change.after = clone(resourceGroupValues);
  for (const root of [
    candidate.planned_values.root_module,
    candidate.prior_state.values.root_module,
  ]) {
    lunaBootstrapValueResource(root, "azurerm_resource_group.foundation").values =
      clone(resourceGroupValues);
  }
  candidate.planned_values.outputs.resource_group_id.value = resourceGroupValues.id;
  candidate.prior_state.values.outputs.resource_group_id.value = resourceGroupValues.id;
  candidate.output_changes.resource_group_id.before = resourceGroupValues.id;
  candidate.output_changes.resource_group_id.after = resourceGroupValues.id;
  candidate.planned_values.outputs.resource_group_name.value = resourceGroupName;
  candidate.prior_state.values.outputs.resource_group_name.value = resourceGroupName;
  candidate.output_changes.resource_group_name.before = resourceGroupName;
  candidate.output_changes.resource_group_name.after = resourceGroupName;

  lunaBootstrapSetRuntimeClientId(
    candidate,
    "11111111-2222-4333-8444-555555555555",
  );
  assert.equal(acceptsPlan(candidate, "luna-model-bootstrap"), true);
});

test("luna-model-bootstrap accepts coherently rebound live subscription, operator, and contact values", () => {
  const candidate = lunaBootstrapPlan();
  const oldSubscription = candidate.variables.subscription_id.value;
  const liveSubscription = "b7255fdc-572a-4ea3-9d7e-ecb7ee5a87f2";
  lunaBootstrapReplaceString(candidate, oldSubscription, liveSubscription);
  for (const address of [
    "module.identities_rbac.azurerm_role_assignment.image_pull_acr",
    "module.identities_rbac.azurerm_role_assignment.runtime_table",
    "module.identities_rbac.azurerm_role_assignment.runtime_openai",
    "module.identities_rbac.azurerm_role_assignment.runtime_application_insights",
    "module.identities_rbac.azurerm_role_assignment.operator_security_table",
    "module.identities_rbac.azurerm_role_assignment.operator_rate_table",
    "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user",
    "module.workload_key_vault.azurerm_role_assignment.terraform_cli_secrets_officer",
  ]) {
    lunaBootstrapRecomputeRoleIdentity(candidate, address);
  }

  lunaBootstrapReplaceString(
    candidate,
    "fixture-contact-0001@redacted.example.net",
    "operator@contoso.example",
  );
  assert.equal(acceptsPlan(candidate, "luna-model-bootstrap"), true);
});

test("luna-model-bootstrap accepts a coherently rebound operator principal", () => {
  const candidate = lunaBootstrapPlan();
  const oldOperator = candidate.variables.operator_principal_id.value;
  const liveOperator = "00000000-0000-0000-0000-000000000044";
  lunaBootstrapReplaceString(candidate, oldOperator, liveOperator);
  for (const address of [
    "module.identities_rbac.azurerm_role_assignment.operator_security_table",
    "module.identities_rbac.azurerm_role_assignment.operator_rate_table",
  ]) {
    lunaBootstrapRecomputeRoleIdentity(candidate, address);
  }
  assert.equal(acceptsPlan(candidate, "luna-model-bootstrap"), true);
});

test("luna-model-bootstrap rejects coordinated subscription-wide RBAC scope widening", () => {
  rejectsLunaBootstrapMutation((candidate) => {
    const address =
      "module.identities_rbac.azurerm_role_assignment.runtime_openai";
    const subscription = candidate.variables.subscription_id.value;
    lunaBootstrapRoleValues(candidate, address, (value) => {
      value.scope = `/subscriptions/${subscription}`;
    });
  });
});

test("luna-model-bootstrap rejects coordinated RBAC role, principal, and name mutations", () => {
  const address =
    "module.identities_rbac.azurerm_role_assignment.runtime_openai";
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapRoleValues(candidate, address, (value) => {
      value.role_definition_id =
        `/subscriptions/${candidate.variables.subscription_id.value}/providers/Microsoft.Authorization/roleDefinitions/0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3`;
    });
  });
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapRoleValues(candidate, address, (value) => {
      value.principal_id = "00000000-0000-0000-0000-000000000044";
    });
  });
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapRoleValues(candidate, address, (value) => {
      value.name = fixtureUuidV5Url("wrong-runtime-openai-role");
    });
  });
});

test("luna-model-bootstrap cross-binds the pinned predecessor relay image", () => {
  const expectedImage = finalTransitionFixture.resource_changes.find(
    (entry) => entry.address === lunaContainerAppAddress,
  ).change.before.body.properties.template.containers.find(
    (entry) => entry.name === "relay",
  ).image;
  const positive = lunaBootstrapPlan();
  assert.equal(positive.variables.relay_image_digest.value, expectedImage);
  assert.equal(acceptsPlan(positive, "luna-model-bootstrap"), true);

  const [repository, digest] = expectedImage.split("@");
  for (const invalidImage of [
    digest,
    `${repository}:latest`,
    `otherregistry.azurecr.io/${repository.slice(repository.indexOf("/") + 1)}@${digest}`,
    `${repository.replace(/\/[^/]+$/, "/other-relay")}@${digest}`,
    `${repository}@sha256:${"2".repeat(64)}`,
  ]) {
    rejectsLunaBootstrapMutation((candidate) => {
      lunaBootstrapSetRelayImage(candidate, invalidImage);
    });
  }

  const alternateImage = `${repository}@sha256:${"2".repeat(64)}`;
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.variables.relay_image_digest.value = alternateImage;
  });
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapChange(candidate, lunaContainerAppAddress).change.after.body
      .properties.template.containers.find((entry) => entry.name === "relay")
      .image = alternateImage;
  });
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapValueResource(
      candidate.planned_values.root_module,
      lunaContainerAppAddress,
    ).values.body.properties.template.containers.find(
      (entry) => entry.name === "relay",
    ).image = alternateImage;
  });
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapValueResource(
      candidate.prior_state.values.root_module,
      lunaContainerAppAddress,
    ).values.body.properties.template.containers.find(
      (entry) => entry.name === "relay",
    ).image = alternateImage;
  });
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapSetRelayImage(candidate, alternateImage);
  });
});

test("luna-model-bootstrap permits only a valid timestamp variation", () => {
  const candidate = lunaBootstrapPlan();
  candidate.timestamp = "2026-08-20T03:00:00Z";
  assert.equal(acceptsPlan(candidate, "luna-model-bootstrap"), true);
  for (const timestamp of [
    "0",
    "2026-08-20",
    "Thu, 20 Aug 2026 03:00:00 GMT",
    "2026-02-30T03:00:00Z",
    "2026-08-20T03:00:00.000Z",
    "2026-08-20T03:00:00+00:00",
  ]) {
    candidate.timestamp = timestamp;
    assert.equal(
      acceptsPlan(candidate, "luna-model-bootstrap"),
      false,
      `${timestamp} must not be accepted`,
    );
  }
});

test("luna-model-bootstrap rejects extra actions, deployments, and outputs", () => {
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapChange(candidate, lunaDeploymentAddress).change.actions.push(
      "update",
    );
  });
  rejectsLunaBootstrapMutation((candidate) => {
    const extra = clone(lunaBootstrapChange(candidate, lunaDeploymentAddress));
    extra.address =
      'module.foundry.azurerm_cognitive_deployment.this["gpt-5.6-luna-extra"]';
    extra.index = "gpt-5.6-luna-extra";
    candidate.resource_changes.push(extra);
  });
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.output_changes.extra = {
      actions: ["no-op"],
      before: "fixture",
      after: "fixture",
      after_unknown: false,
      before_sensitive: false,
      after_sensitive: false,
    };
  });
});

test("luna-model-bootstrap keeps the application, transcription, RBAC, and all other resources no-op", () => {
  rejectsLunaBootstrapMutation((candidate) => {
    const app = lunaBootstrapChange(candidate, lunaContainerAppAddress);
    app.change.after.body.properties.template.containers[1].env[0].value =
      "mutated";
  });
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapChange(candidate, lunaTranscriptionAddress).change.after.model[0].version =
      "2025-12-14";
  });
  rejectsLunaBootstrapMutation((candidate) => {
    const role = candidate.resource_changes.find((entry) =>
      entry.address.includes("azurerm_role_assignment.runtime_openai"),
    );
    role.change.actions = ["update"];
  });
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.resource_changes = candidate.resource_changes.filter(
      (entry) => entry.address !== lunaTranscriptionAddress,
    );
  });
});

test("luna-model-bootstrap rejects drift, targeting, imports, deposed state, and generated configuration", () => {
  for (const mutate of [
    (candidate) => { candidate.resource_drift = []; },
    (candidate) => { candidate.resource_drift = [{ address: "fixture" }]; },
    (candidate) => { candidate.configuration.target = "fixture"; },
    (candidate) => { candidate.resource_changes[0].change.imports = []; },
    (candidate) => { candidate.resource_changes[0].deposed = "fixture"; },
    (candidate) => { candidate.configuration.generated_config = {}; },
  ]) {
    rejectsLunaBootstrapMutation(mutate);
  }
});

test("luna-model-bootstrap rejects failed, unknown, malformed, and security-relevant check envelopes", () => {
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.checks[0].status = "fail";
  });
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.checks[0].instances[0].status = "unknown";
  });
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.checks = [{ status: "pass" }];
  });
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapChange(candidate, lunaDeploymentAddress).change.after_unknown.model[0].unexpected =
      true;
  });
  rejectsLunaBootstrapMutation((candidate) => {
    lunaBootstrapChange(candidate, lunaDeploymentAddress).change.after_sensitive.model[0].unexpected =
      true;
  });
});

test("luna-model-bootstrap binds output order, values, sensitivity, and actions", () => {
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.output_changes.foundry_deployment_names.after.reverse();
  });
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.prior_state.values.outputs.foundry_deployment_names.value = [];
  });
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.planned_values.outputs.foundry_deployment_names.value = [
      "gpt-4o-mini-transcribe",
    ];
  });
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.output_changes.foundry_deployment_names.after_sensitive = true;
  });
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.output_changes.foundry_deployment_names.actions = ["no-op"];
  });
});

test("luna-model-bootstrap accepts resource changes in Terraform emission order", () => {
  const candidate = lunaBootstrapPlan();
  candidate.resource_changes.sort((left, right) =>
    left.address.localeCompare(right.address),
  );
  candidate.relevant_attributes.reverse();
  assert.equal(runCli(["--mode=luna-model-bootstrap"], JSON.stringify(candidate)), 0);
});

test("luna-model-bootstrap requires the exact unique relevant-attribute set", () => {
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.relevant_attributes.pop();
  });
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.relevant_attributes[0] = clone(candidate.relevant_attributes[1]);
  });
  rejectsLunaBootstrapMutation((candidate) => {
    candidate.relevant_attributes[0].attribute = ["unexpected"];
  });
});

test("luna-model-bootstrap rejects malformed coordinated provider-computed values", () => {
  const mutateEveryStateCopy = (candidate, address, key, value) => {
    const change = lunaBootstrapChange(candidate, address).change;
    change.before[key] = value;
    change.after[key] = value;
    lunaBootstrapValueResource(
      candidate.planned_values.root_module,
      address,
    ).values[key] = value;
    lunaBootstrapValueResource(
      candidate.prior_state.values.root_module,
      address,
    ).values[key] = value;
  };
  rejectsLunaBootstrapMutation((candidate) => {
    mutateEveryStateCopy(
      candidate,
      "module.workload_state.azurerm_storage_account.this",
      "primary_access_key",
      "not-an-azure-storage-key",
    );
  });
  rejectsLunaBootstrapMutation((candidate) => {
    mutateEveryStateCopy(
      candidate,
      "module.observability.azurerm_application_insights.this",
      "app_id",
      "not-an-application-id",
    );
  });
});

test("luna-model-bootstrap CLI usage is exact and content-free", () => {
  const text = JSON.stringify(lunaBootstrapPlan());
  assert.equal(runCli(["--mode=luna-model-bootstrap"], text), 0);
  assert.equal(runCli(["--mode=luna-model-bootstrap", "extra"], text), 2);
  assert.equal(runCli(["--mode=unknown"], text), 2);
  assert.equal(runCli(["--mode=luna-model-bootstrap"], "{"), 1);
  assert.equal(
    runCli(["--mode=luna-model-bootstrap"], JSON.stringify({ format_version: "1.2" })),
    1,
  );
});

test("CLI accepts JSON stdin and uses no plan values in its result", () => {
  const accepted = runCli(
    ["--mode=model-spike"],
    JSON.stringify(plan([miniCreate], { fixture_value: "fixture-value" })),
  );
  assert.equal(accepted, 0);

  const rejected = runCli(
    ["--mode=full-deploy"],
    JSON.stringify(plan([change("module.unexpected.resource", ["update"])])),
  );
  assert.equal(rejected, 1);

  const runtimeAccepted = runCli(
    ["--mode=runtime-rollout"],
    JSON.stringify(runtimePlan()),
  );
  assert.equal(runtimeAccepted, 0);

  const finalAccepted = runCli(
    ["--mode=final-rollout"],
    JSON.stringify(finalRolloutPlan()),
  );
  assert.equal(finalAccepted, 0);

  const lunaAccepted = runCli(
    ["--mode=luna-model-bootstrap"],
    lunaFixtureText,
  );
  assert.equal(lunaAccepted, 0);
});

test("CLI rejection output is fixed and content-free", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "--mode=full-deploy"],
    {
      encoding: "utf8",
      input: JSON.stringify(
        plan([change("module.unexpected.resource", ["update"])]),
      ),
    },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "plan guard rejected plan\n");
});

function cutoverChange(planValue, address) {
  const entry = planValue.resource_changes.find(
    (candidate) => candidate.address === address,
  );
  assert.ok(entry, `missing cutover resource ${address}`);
  return entry;
}

function cutoverResourceCopies(planValue, address) {
  const entry = cutoverChange(planValue, address);
  const planned = finalValueResource(
    planValue.planned_values.root_module,
    address,
  );
  const prior = finalValueResource(
    planValue.prior_state.values.root_module,
    address,
  );
  assert.ok(planned, `missing planned resource ${address}`);
  assert.ok(prior, `missing prior resource ${address}`);
  return [
    entry.change.before,
    entry.change.after,
    planned.values,
    prior.values,
  ];
}

function mutateCutoverResourceCopies(planValue, address, mutate) {
  for (const value of cutoverResourceCopies(planValue, address)) mutate(value);
}

function mutateContainerAppCopies(planValue, mutate) {
  mutateCutoverResourceCopies(planValue, containerAppAddress, mutate);
}

function setContainerAppIdentityIdsEverywhere(planValue, identityIds) {
  mutateContainerAppCopies(planValue, (value) => {
    value.identity[0].identity_ids = clone(identityIds);
  });
}

function makeBenignCutoverResourceDrift(planValue) {
  return [containerAppAddress, finalCleanupJobAddress].map((address) => {
    const source = cutoverChange(planValue, address);
    const entry = clone(source);
    const before = clone(source.change.before);
    const after = clone(before);
    after.identity[0].identity_ids.reverse();
    entry.change = {
      actions: ["update"],
      before,
      after,
      after_unknown: {},
      before_sensitive: clone(source.change.before_sensitive),
      after_sensitive: clone(source.change.before_sensitive),
    };
    return entry;
  });
}

function reverseBenignDriftDirection(entry) {
  for (const [beforeKey, afterKey] of [
    ["before", "after"],
    ["before_sensitive", "after_sensitive"],
  ]) {
    [entry.change[beforeKey], entry.change[afterKey]] = [
      entry.change[afterKey],
      entry.change[beforeKey],
    ];
  }
}

function setBenignDriftIdentityIds(entry, identityIds) {
  entry.change.before.identity[0].identity_ids = clone(identityIds);
  entry.change.after.identity[0].identity_ids = clone(identityIds).reverse();
}

function mutateContainerAppOutputs(planValue, mutate) {
  const entry = cutoverChange(planValue, containerAppAddress);
  const planned = finalValueResource(
    planValue.planned_values.root_module,
    containerAppAddress,
  );
  const prior = finalValueResource(
    planValue.prior_state.values.root_module,
    containerAppAddress,
  );
  assert.ok(planned, "missing planned Container App resource");
  assert.ok(prior, "missing prior Container App resource");
  for (const value of [
    entry.change.before,
    entry.change.after,
    planned.values,
    prior.values,
  ]) {
    if (Object.hasOwn(value, "output")) mutate(value.output);
  }
}

function rebindContainerAppIdEverywhere(planValue) {
  const entry = cutoverChange(planValue, containerAppAddress);
  const replacement = entry.change.after.id.replace(
    /ca-palancar-dev-relay-aeeacd8c$/,
    "ca-palancar-dev-relay-rebound",
  );
  mutateContainerAppCopies(planValue, (value) => {
    value.id = replacement;
  });
  for (const identity of [entry.change.before_identity, entry.change.after_identity]) {
    if (identity) identity.id = replacement;
  }
  for (const output of [
    planValue.output_changes.relay_container_app_id,
    planValue.planned_values.outputs.relay_container_app_id,
    planValue.prior_state.values.outputs.relay_container_app_id,
  ]) {
    if (Object.hasOwn(output, "before")) output.before = replacement;
    if (Object.hasOwn(output, "after")) output.after = replacement;
    if (Object.hasOwn(output, "value")) output.value = replacement;
  }
}

function mutateCutoverNoOpPriorCopy(planValue, address, mutate) {
  const entry = cutoverChange(planValue, address);
  assert.deepEqual(entry.change.actions, ["no-op"]);
  mutate(entry.change.before);
  const prior = finalValueResource(planValue.prior_state.values.root_module, address);
  assert.ok(prior, `missing prior resource ${address}`);
  mutate(prior.values);
}

function rejectsCutoverNoOpSensitiveDivergence(source, mode) {
  const logAnalyticsAddress =
    "module.observability.azurerm_log_analytics_workspace.this";
  const storageAddress =
    "module.workload_state.azurerm_storage_account.this";
  const logPrimaryKey = Buffer.alloc(64, 0x55).toString("base64");
  const logSecondaryKey = Buffer.alloc(64, 0x66).toString("base64");
  const storagePrimaryKey = Buffer.alloc(64, 0x77).toString("base64");
  const storageSecondaryKey = Buffer.alloc(64, 0x88).toString("base64");
  const storageConnection = (name, key, blob) =>
    blob
      ? `DefaultEndpointsProtocol=https;BlobEndpoint=https://${name}.blob.core.windows.net/;AccountName=${name};AccountKey=${key}`
      : `DefaultEndpointsProtocol=https;AccountName=${name};AccountKey=${key};EndpointSuffix=core.windows.net`;

  for (const [address, mutate] of [
    [logAnalyticsAddress, (value) => {
      value.primary_shared_key = logPrimaryKey;
      value.secondary_shared_key = logSecondaryKey;
    }],
    [storageAddress, (value) => {
      value.primary_access_key = storagePrimaryKey;
      value.secondary_access_key = storageSecondaryKey;
      value.primary_connection_string = storageConnection(
        value.name,
        storagePrimaryKey,
        false,
      );
      value.secondary_connection_string = storageConnection(
        value.name,
        storageSecondaryKey,
        false,
      );
      value.primary_blob_connection_string = storageConnection(
        value.name,
        storagePrimaryKey,
        true,
      );
      value.secondary_blob_connection_string = storageConnection(
        value.name,
        storageSecondaryKey,
        true,
      );
    }],
  ]) {
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateCutoverNoOpPriorCopy(candidate, address, mutate);
    });
  }
}

function rejectsCutoverMutation(source, mode, mutate) {
  const candidate = clone(source);
  mutate(candidate);
  assert.equal(acceptsPlan(candidate, mode), false);
}

function rebindTerminalSensitiveLeaves(candidate) {
  const mutateResourceCopies = (address, mutate) => {
    const entry = cutoverChange(candidate, address);
    mutate(entry.change.before);
    mutate(entry.change.after);
    mutate(finalValueResource(candidate.planned_values.root_module, address).values);
    mutate(finalValueResource(candidate.prior_state.values.root_module, address).values);
  };
  const logPrimary = Buffer.alloc(64, 0x55).toString("base64");
  const logSecondary = Buffer.alloc(64, 0x66).toString("base64");
  mutateResourceCopies(
    "module.observability.azurerm_log_analytics_workspace.this",
    (value) => {
      value.primary_shared_key = logPrimary;
      value.secondary_shared_key = logSecondary;
    },
  );

  const storageName = "palancardevstateaeeacd8c";
  const storagePrimary = Buffer.alloc(64, 0x77).toString("base64");
  const storageSecondary = Buffer.alloc(64, 0x88).toString("base64");
  const storageConnection = (key, blob) =>
    blob
      ? `DefaultEndpointsProtocol=https;BlobEndpoint=https://${storageName}.blob.core.windows.net/;AccountName=${storageName};AccountKey=${key}`
      : `DefaultEndpointsProtocol=https;AccountName=${storageName};AccountKey=${key};EndpointSuffix=core.windows.net`;
  mutateResourceCopies(
    "module.workload_state.azurerm_storage_account.this",
    (value) => {
      value.primary_access_key = storagePrimary;
      value.secondary_access_key = storageSecondary;
      value.primary_connection_string = storageConnection(storagePrimary, false);
      value.secondary_connection_string = storageConnection(storageSecondary, false);
      value.primary_blob_connection_string = storageConnection(storagePrimary, true);
      value.secondary_blob_connection_string = storageConnection(storageSecondary, true);
    },
  );

  const applicationInsightsConnection =
    "InstrumentationKey=00000000-0000-4000-8000-000000000111;" +
    "IngestionEndpoint=https://eastus2-3.in.applicationinsights.azure.com/;" +
    "LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;" +
    "ApplicationId=00000000-0000-4000-8000-000000000098";
  const relayConnection =
    "InstrumentationKey=00000000-0000-4000-8000-000000000111;" +
    "IngestionEndpoint=https://eastus2-3.in.applicationinsights.azure.com";
  mutateResourceCopies(
    "module.observability.azurerm_application_insights.this",
    (value) => {
      value.connection_string = applicationInsightsConnection;
      value.instrumentation_key =
        "00000000-0000-4000-8000-000000000111";
    },
  );
  mutateResourceCopies(
    containerAppAddress,
    (value) => {
      for (const environment of value.body.properties.template.containers[0].env) {
        if (environment.name === "APPLICATIONINSIGHTS_CONNECTION_STRING") {
          environment.value = relayConnection;
        }
      }
    },
  );
  for (const output of [
    candidate.output_changes.application_insights_connection_string,
    candidate.planned_values.outputs.application_insights_connection_string,
    candidate.prior_state.values.outputs.application_insights_connection_string,
  ]) {
    if (Object.hasOwn(output, "before")) output.before = applicationInsightsConnection;
    if (Object.hasOwn(output, "after")) output.after = applicationInsightsConnection;
    if (Object.hasOwn(output, "value")) output.value = applicationInsightsConnection;
  }

  mutateResourceCopies(
    "module.container_registry.azurerm_container_registry.this",
    (value) => { value.admin_password = "opaque-admin-password"; },
  );
  mutateResourceCopies(
    "module.container_app_environment.azurerm_container_app_environment.this",
    (value) => { value.dapr_application_insights_connection_string = "opaque-dapr-connection"; },
  );
}

test("Azure generation cutover and credential cleanup fixtures pass only their closed modes", () => {
  assert.equal(
    acceptsPlan(runtimeCutoverFixture, "azure-generation-cutover"),
    true,
  );
  assert.equal(
    acceptsPlan(credentialCleanupFixture, "azure-credential-cleanup"),
    true,
  );
  assert.equal(
    acceptsPlan(runtimeCutoverFixture, "azure-credential-cleanup"),
    false,
  );
  assert.equal(
    acceptsPlan(credentialCleanupFixture, "azure-generation-cutover"),
    false,
  );
});

test("cutover-family relevant attributes are exact order-independent path sets", () => {
  const cases = [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ];
  const permutations = [
    (attributes) => attributes.slice().reverse(),
    (attributes) => attributes.slice(7).concat(attributes.slice(0, 7)),
    (attributes) => [
      ...attributes.filter((_, index) => index % 2 === 1),
      ...attributes.filter((_, index) => index % 2 === 0),
    ],
  ];

  for (const [source, mode] of cases) {
    for (const permute of permutations) {
      const candidate = clone(source);
      candidate.relevant_attributes = permute(candidate.relevant_attributes);
      assert.equal(acceptsPlan(candidate, mode), true);
    }

    rejectsCutoverMutation(source, mode, (candidate) => {
      candidate.relevant_attributes.pop();
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      candidate.relevant_attributes.push({
        resource: "module.unreviewed.azurerm_resource.this",
        attribute: ["id"],
      });
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      candidate.relevant_attributes.push(
        clone(candidate.relevant_attributes[0]),
      );
    });
    for (const mutate of [
      (entry) => { entry.extra = true; },
      (entry) => { entry.resource = 1; },
      (entry) => { entry.attribute = "id"; },
      (entry) => { entry.attribute = [0]; },
    ]) {
      rejectsCutoverMutation(source, mode, (candidate) => {
        mutate(candidate.relevant_attributes[0]);
      });
    }
    for (const reorderedPath of [
      ["id", "forged-child"],
      ["forged-child", "id"],
    ]) {
      rejectsCutoverMutation(source, mode, (candidate) => {
        candidate.relevant_attributes[0].attribute = reorderedPath;
      });
    }
  }
});

test("cutover-family accepts reversed Container App identity sets and fresh metadata", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    for (const resourceDrift of [undefined, null, []]) {
      const candidate = clone(source);
      mutateContainerAppCopies(candidate, (value) => {
        value.identity[0].identity_ids.reverse();
      });
      candidate.relevant_attributes.reverse();
      candidate.timestamp = "2026-08-22T17:30:00Z";
      if (resourceDrift === undefined) {
        delete candidate.resource_drift;
      } else {
        candidate.resource_drift = resourceDrift;
      }
      assert.equal(acceptsPlan(candidate, mode), true, `${mode} drift=${String(resourceDrift)}`);
    }
  }
});

test("cutover-family accepts the app singleton and exact two-entry benign resource drift permutations", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    for (const singletonAddress of [containerAppAddress, finalCleanupJobAddress]) {
      for (const reverseIdentity of [false, true]) {
        for (const reverseDirection of [false, true]) {
          const candidate = clone(source);
          if (reverseIdentity) {
            mutateContainerAppCopies(candidate, (value) => {
              value.identity[0].identity_ids.reverse();
            });
          }
          candidate.resource_drift = makeBenignCutoverResourceDrift(candidate)
            .filter((entry) => entry.address === singletonAddress);
          if (reverseDirection) reverseBenignDriftDirection(candidate.resource_drift[0]);
          candidate.relevant_attributes.reverse();
          candidate.timestamp = "2026-08-22T17:30:00Z";
          assert.equal(
            acceptsPlan(candidate, mode),
            true,
            `${mode} singleton=${singletonAddress} reverseIdentity=${reverseIdentity} reverseDirection=${reverseDirection}`,
          );
        }
      }
    }

    for (const reverseEntries of [false, true]) {
      for (let directionMask = 0; directionMask < 4; directionMask += 1) {
        const candidate = clone(source);
        mutateContainerAppCopies(candidate, (value) => {
          value.identity[0].identity_ids.reverse();
        });
        candidate.resource_drift = makeBenignCutoverResourceDrift(candidate);
        candidate.resource_drift.forEach((entry, index) => {
          if ((directionMask & (1 << index)) !== 0) {
            reverseBenignDriftDirection(entry);
          }
        });
        if (reverseEntries) candidate.resource_drift.reverse();
        candidate.relevant_attributes.reverse();
        candidate.timestamp = "2026-08-22T17:30:00Z";
        assert.equal(
          acceptsPlan(candidate, mode),
          true,
          `${mode} entries=${reverseEntries} directions=${directionMask}`,
        );
      }
    }

  }
});

test("cutover-family benign resource drift requires the exact identity set", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    const [imagePullIdentity, runtimeIdentity] = cutoverChange(
      source,
      containerAppAddress,
    ).change.before.identity[0].identity_ids;
    const wrongIdentity = runtimeIdentity.replace(
      /id-palancar-dev-runtime$/,
      "id-palancar-dev-unexpected",
    );
    for (const address of [containerAppAddress, finalCleanupJobAddress]) {
      for (const identityIds of [
        [imagePullIdentity],
        [imagePullIdentity, runtimeIdentity, wrongIdentity],
        [imagePullIdentity, wrongIdentity],
        [imagePullIdentity, imagePullIdentity],
      ]) {
        rejectsCutoverMutation(source, mode, (candidate) => {
          candidate.resource_drift = makeBenignCutoverResourceDrift(candidate);
          setBenignDriftIdentityIds(
            candidate.resource_drift.find(
              (entry) => entry.address === address,
            ),
            identityIds,
          );
        });
      }
    }
    for (const singletonAddress of [containerAppAddress, finalCleanupJobAddress]) {
      for (const identityIds of [
        [imagePullIdentity],
        [imagePullIdentity, runtimeIdentity, wrongIdentity],
        [imagePullIdentity, wrongIdentity],
        [imagePullIdentity, imagePullIdentity],
      ]) {
        rejectsCutoverMutation(source, mode, (candidate) => {
          const entry = makeBenignCutoverResourceDrift(candidate).find(
            (driftEntry) => driftEntry.address === singletonAddress,
          );
          setBenignDriftIdentityIds(entry, identityIds);
          candidate.resource_drift = [entry];
        });
      }
    }
  }
});

test("cutover-family benign resource drift rejects structural and metadata drift", () => {
  const mutations = [
    (drift) => {
      const extra = clone(drift[0]);
      extra.address = "module.unreviewed.azapi_resource.this";
      drift.push(extra);
    },
    (drift) => {
      drift[1] = clone(drift[0]);
    },
    (drift) => {
      if (drift.length === 1) {
        drift[0].address = "module.unreviewed.azapi_resource.this";
      } else {
        drift[1].address = "module.unreviewed.azapi_resource.this";
      }
    },
    (drift) => {
      drift[0].module_address = "module.container_app_workload[1]";
    },
    (drift) => {
      drift[0].extra = true;
    },
    (drift) => {
      drift[0].change.actions = ["no-op"];
    },
    (drift) => {
      drift[0].change.action_reason = "read_because_config_unknown";
    },
    (drift) => {
      drift[0].change.after_unknown = { identity: true };
    },
    (drift) => {
      drift[0].change.after_sensitive = {};
    },
    (drift) => {
      drift[0].change.before_identity = {
        id: drift[0].change.before.id,
        type: null,
      };
    },
    (drift) => {
      drift[0].change.after_identity = {
        id: drift[0].change.after.id,
        type: null,
      };
    },
    (drift) => {
      drift[0].change.after.identity[0].identity_ids = clone(
        drift[0].change.before.identity[0].identity_ids,
      );
    },
    (drift) => {
      drift[0].change.after.body.properties.configuration.activeRevisionsMode =
        "Multiple";
    },
    (drift) => {
      drift[0].change.after.body.properties.template.containers[0].env[0].value =
        "unexpected";
    },
    (drift) => {
      drift[0].change.after.body.properties.template.containers[0].image =
        `${finalAcrLoginServer}/palancar-relay@sha256:${"9".repeat(64)}`;
    },
    (drift) => {
      drift[0].change.after.output.properties.runningStatus = "Stopped";
    },
    (drift) => {
      drift[0].change.after.body.identity = clone(
        drift[0].change.after.identity,
      );
    },
    (drift) => {
      drift[0].change.after.tags.additional = "changed";
    },
    (drift) => {
      for (const side of ["before", "after"]) {
        drift[0].change[side].tags.additional = "coherent-lookalike";
      }
    },
  ];
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    for (const mutate of mutations) {
      rejectsCutoverMutation(source, mode, (candidate) => {
        candidate.resource_drift = makeBenignCutoverResourceDrift(candidate);
        mutate(candidate.resource_drift);
      });
      for (const singletonAddress of [containerAppAddress, finalCleanupJobAddress]) {
        rejectsCutoverMutation(source, mode, (candidate) => {
          candidate.resource_drift = makeBenignCutoverResourceDrift(candidate)
            .filter((entry) => entry.address === singletonAddress);
          mutate(candidate.resource_drift);
        });
      }
    }
  }
});

test("cutover-family accepts expiry-cleanup Job identity set permutations across all copies", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    for (let reversalMask = 0; reversalMask < 16; reversalMask += 1) {
      const candidate = clone(source);
      cutoverResourceCopies(candidate, finalCleanupJobAddress).forEach(
        (value, index) => {
          if ((reversalMask & (1 << index)) !== 0) {
            value.identity[0].identity_ids.reverse();
          }
        },
      );
      assert.equal(
        acceptsPlan(candidate, mode),
        true,
        `${mode} Job reversal mask=${reversalMask}`,
      );
    }
  }
});

test("cutover-family rejects non-exact expiry-cleanup Job identity sets and path lookalikes", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    const [imagePullIdentity, runtimeIdentity] = cutoverChange(
      source,
      finalCleanupJobAddress,
    ).change.after.identity[0].identity_ids;
    const wrongIdentity = runtimeIdentity.replace(
      /id-palancar-dev-runtime$/,
      "id-palancar-dev-unexpected",
    );
    for (const identityIds of [
      [imagePullIdentity, imagePullIdentity],
      [imagePullIdentity],
      [imagePullIdentity, runtimeIdentity, wrongIdentity],
      [imagePullIdentity, wrongIdentity],
    ]) {
      rejectsCutoverMutation(source, mode, (candidate) => {
        mutateCutoverResourceCopies(
          candidate,
          finalCleanupJobAddress,
          (value) => {
            value.identity[0].identity_ids = clone(identityIds);
          },
        );
      });
    }

    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateCutoverResourceCopies(
        candidate,
        finalCleanupJobAddress,
        (value) => {
          value.identity.push({
            ...clone(value.identity[0]),
            identity_ids: clone(value.identity[0].identity_ids).reverse(),
          });
        },
      );
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateCutoverResourceCopies(
        candidate,
        finalCleanupJobAddress,
        (value) => {
          value.body.identity = clone(value.identity);
        },
      );
    });
  }
});

test("cutover-family does not broaden unordered identity_ids by address or path", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.identity[0].identity_ids.reverse();
      });
      const entry = cutoverChange(candidate, containerAppAddress);
      entry.address = `${containerAppAddress}.malformed`;
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.identity.push({
          ...clone(value.identity[0]),
          identity_ids: clone(value.identity[0].identity_ids).reverse(),
        });
      });
    });
  }
});

test("cutover-family rejects non-exact Container App identity sets", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    const [imagePullIdentity, runtimeIdentity] = cutoverChange(
      source,
      containerAppAddress,
    ).change.after.identity[0].identity_ids;
    const wrongIdentity = runtimeIdentity.replace(
      /id-palancar-dev-runtime$/,
      "id-palancar-dev-unexpected",
    );
    for (const identityIds of [
      [imagePullIdentity, imagePullIdentity],
      [imagePullIdentity],
      [imagePullIdentity, runtimeIdentity, wrongIdentity],
      [imagePullIdentity, wrongIdentity],
    ]) {
      rejectsCutoverMutation(source, mode, (candidate) => {
        setContainerAppIdentityIdsEverywhere(candidate, identityIds);
      });
    }
  }
});

test("cutover-family keeps registry, identitySettings, and client-ID roles pinned", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    const [imagePullIdentity, runtimeIdentity] = cutoverChange(
      source,
      containerAppAddress,
    ).change.after.identity[0].identity_ids;
    for (const address of [containerAppAddress, finalCleanupJobAddress]) {
      rejectsCutoverMutation(source, mode, (candidate) => {
        mutateCutoverResourceCopies(candidate, address, (value) => {
          value.body.properties.configuration.registries[0].identity =
            runtimeIdentity;
        });
      });
      rejectsCutoverMutation(source, mode, (candidate) => {
        mutateCutoverResourceCopies(candidate, address, (value) => {
          const settings =
            value.body.properties.configuration.identitySettings;
          [settings[0].identity, settings[1].identity] = [
            settings[1].identity,
            settings[0].identity,
          ];
        });
      });
      rejectsCutoverMutation(source, mode, (candidate) => {
        mutateCutoverResourceCopies(candidate, address, (value) => {
          const settings =
            value.body.properties.configuration.identitySettings;
          settings[0].identity = runtimeIdentity.replace(
            "resourceGroups",
            "resourcegroups",
          );
          settings[1].identity = imagePullIdentity.replace(
            "resourceGroups",
            "resourcegroups",
          );
        });
      });
    }

    const imagePullClientId = cutoverChange(
      source,
      "module.identities_rbac.azurerm_user_assigned_identity.image_pull",
    ).change.after.client_id;
    for (const address of [containerAppAddress, finalCleanupJobAddress]) {
      rejectsCutoverMutation(source, mode, (candidate) => {
        mutateCutoverResourceCopies(candidate, address, (value) => {
          const env =
            value.body.properties.template.containers[0].env.find(
              (entry) => entry.name === "AZURE_CLIENT_ID",
            );
          assert.ok(env, `missing AZURE_CLIENT_ID for ${address}`);
          env.value = imagePullClientId;
        });
      });
    }
  }
});

test("cutover and terminal references use the exact 90-check Entra-only workload shape", () => {
  for (const fixture of [runtimeCutoverFixture, terminalFixture]) {
    assert.equal(fixture.checks.length, 90);
    assert.equal(
      fixture.checks.some((check) =>
        RETIRED_WORKLOAD_INPUTS.includes(check.address.name),
      ),
      false,
    );
    const workloadCall =
      fixture.configuration.root_module.module_calls.container_app_workload;
    assert.equal(
      RETIRED_WORKLOAD_INPUTS.some((name) =>
        Object.hasOwn(workloadCall.expressions, name) ||
        Object.hasOwn(workloadCall.module.variables, name),
      ),
      false,
    );
  }

  for (const name of RETIRED_WORKLOAD_INPUTS) {
    rejectsCutoverMutation(
      runtimeCutoverFixture,
      "azure-generation-cutover",
      (candidate) => {
        const workloadCall =
          candidate.configuration.root_module.module_calls
            .container_app_workload;
        workloadCall.expressions[name] = {
          references: [`module.workload_key_vault.${name}`],
        };
      },
    );
    rejectsCutoverMutation(
      runtimeCutoverFixture,
      "azure-generation-cutover",
      (candidate) => {
        const workloadCall =
          candidate.configuration.root_module.module_calls
            .container_app_workload;
        workloadCall.module.variables[name] = {
          description: "retired workload dependency",
        };
      },
    );
    rejectsCutoverMutation(
      runtimeCutoverFixture,
      "azure-generation-cutover",
      (candidate) => {
        const check = clone(candidate.checks[0]);
        check.address.name = name;
        check.address.to_display =
          `module.container_app_workload.var.${name}`;
        check.instances[0].address.to_display =
          `module.container_app_workload[0].var.${name}`;
        candidate.checks.splice(1, 0, check);
      },
    );
  }
});

test("cutover modes reject coherent retired dependencies and rebound app identities", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.body.properties.key_vault_uri =
          "https://kvpalancardevaeeacd8.vault.azure.net/";
      });
      const workloadCall =
        candidate.configuration.root_module.module_calls.container_app_workload;
      workloadCall.expressions.key_vault_uri = {
        references: ["module.workload_key_vault.key_vault_uri"],
      };
      workloadCall.module.variables.key_vault_uri = {
        description: "retired workload dependency",
      };
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      rebindContainerAppIdEverywhere(candidate);
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.body.extra = {};
      });
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.body.properties.extra = {};
      });
    });
  }
});

test("cutover modes require the exact Container App provider output contract", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    assert.equal(acceptsPlan(source, mode), true);
    for (const mutate of [
      (output) => {
        output.properties.latestRevisionName =
          "ca-palancar-dev-relay-aeeacd8c--0000000";
      },
      (output) => {
        output.properties.runningStatus = "Stopped";
      },
      (output) => {
        output.predecessor_extra = true;
      },
      (output) => {
        output.properties.configuration.ingress.extra = true;
      },
    ]) {
      rejectsCutoverMutation(source, mode, (candidate) => {
        mutateContainerAppOutputs(candidate, mutate);
      });
    }
  }
});

test("Container App nested envelopes reject coherent cross-copy extra fields", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    assert.equal(acceptsPlan(source, mode), true);
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.body.properties.configuration.identitySettings[0].extra = true;
      });
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.body.properties.configuration.registries[0].passwordSecretRef =
          "unexpected";
      });
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.tags.forged = "unexpected";
      });
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.tags.environment = "production";
      });
    });
  }
});

test("Container App AzAPI controls reject coherent credential and behavior mutations", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    assert.equal(acceptsPlan(source, mode), true);
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.create_headers = {
          Authorization: "Bearer coherent-forgery",
        };
      });
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.create_query_parameters = {
          "api-version": "2026-01-01",
        };
      });
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      mutateContainerAppCopies(candidate, (value) => {
        value.retry.interval_seconds = 11;
      });
    });
  }
});

test("Azure generation cutover requires the indexed no-action Secrets User move", () => {
  const target =
    "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user[0]";
  rejectsCutoverMutation(runtimeCutoverFixture, "azure-generation-cutover", (candidate) => {
    delete cutoverChange(candidate, target).previous_address;
  });
  rejectsCutoverMutation(runtimeCutoverFixture, "azure-generation-cutover", (candidate) => {
    cutoverChange(candidate, target).previous_address =
      "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user[1]";
  });
  rejectsCutoverMutation(runtimeCutoverFixture, "azure-generation-cutover", (candidate) => {
    cutoverChange(candidate, target).change.actions = ["update"];
  });
  rejectsCutoverMutation(runtimeCutoverFixture, "azure-generation-cutover", (candidate) => {
    candidate.resource_changes = candidate.resource_changes.filter(
      (entry) => entry.address !== target,
    );
  });
});

test("Azure generation cutover is direct-Entra, one-container, immutable, and secret-free", () => {
  const appAddress = "module.container_app_workload[0].azapi_resource.this";
  const modelAddress =
    'module.foundry.azurerm_cognitive_deployment.this["gpt-5.6-luna"]';
  const mutations = [
    (candidate) => {
      cutoverChange(candidate, appAddress).change.after.body.properties.template.containers[0].image =
        "palancardevacraeeacd8.azurecr.io/palancar-relay:latest";
    },
    (candidate) => {
      cutoverChange(candidate, appAddress).change.after.body.properties.configuration.maxInactiveRevisions =
        2;
    },
    (candidate) => {
      cutoverChange(candidate, appAddress).change.after.body.properties.configuration.secrets.push(
        { name: "unexpected" },
      );
    },
    (candidate) => {
      cutoverChange(candidate, appAddress).change.after.body.properties.template.containers.push(
        { name: "sidecar" },
      );
    },
    (candidate) => {
      cutoverChange(candidate, appAddress).change.after.body.properties.template.containers[0].env.push(
        { name: "AZURE_API_KEY", value: "fixture-secret" },
      );
    },
    (candidate) => {
      cutoverChange(candidate, appAddress).change.after.body.properties.template.containers[0].resources.cpu =
        0.5;
    },
    (candidate) => {
      cutoverChange(candidate, modelAddress).change.after.model[0].version =
        "2026-01-01";
    },
    (candidate) => {
      cutoverChange(candidate, modelAddress).change.actions = ["update"];
    },
    (candidate) => {
      cutoverChange(candidate, appAddress).change.after_unknown = {
        body: true,
      };
    },
  ];
  for (const mutate of mutations) {
    rejectsCutoverMutation(
      runtimeCutoverFixture,
      "azure-generation-cutover",
      mutate,
    );
  }
  rejectsCutoverNoOpSensitiveDivergence(
    runtimeCutoverFixture,
    "azure-generation-cutover",
  );
});

test("Credential cleanup permits exactly one indexed RBAC delete and no previous address", () => {
  const target =
    "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user[0]";
  const appAddress = "module.container_app_workload[0].azapi_resource.this";
  rejectsCutoverMutation(credentialCleanupFixture, "azure-credential-cleanup", (candidate) => {
    cutoverChange(candidate, target).previous_address =
      "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user";
  });
  rejectsCutoverMutation(credentialCleanupFixture, "azure-credential-cleanup", (candidate) => {
    cutoverChange(candidate, target).change.actions = ["no-op"];
  });
  rejectsCutoverMutation(credentialCleanupFixture, "azure-credential-cleanup", (candidate) => {
    cutoverChange(candidate, target).change.after = {};
  });
  rejectsCutoverMutation(credentialCleanupFixture, "azure-credential-cleanup", (candidate) => {
    cutoverChange(candidate, appAddress).change.actions = ["update"];
  });
  rejectsCutoverMutation(credentialCleanupFixture, "azure-credential-cleanup", (candidate) => {
    candidate.resource_changes.push({
      address: "module.identities_rbac.azurerm_role_assignment.extra",
      change: clone(candidate.resource_changes[0].change),
    });
  });
  rejectsCutoverNoOpSensitiveDivergence(
    credentialCleanupFixture,
    "azure-credential-cleanup",
  );
});

test("Final rollout complete is a terminal exact no-op contract", () => {
  const terminal = clone(terminalFixture);
  assert.equal(acceptsPlan(terminal, "final-rollout-complete"), true);
  for (const mutate of [
    (candidate) => {
      candidate.applyable = true;
    },
    (candidate) => {
      finalChange(candidate, containerAppAddress).change.actions = ["update"];
    },
    (candidate) => {
      candidate.resource_drift = [{ address: "fixture" }];
    },
    (candidate) => {
      candidate.resource_changes.push(clone(candidate.resource_changes[0]));
    },
    (candidate) => {
      finalChange(candidate, containerAppAddress).change.after_unknown = {
        body: true,
      };
    },
  ]) {
    rejectsCutoverMutation(terminal, "final-rollout-complete", mutate);
  }
});

test("new guard modes have closed content-free CLI entry points", () => {
  assert.equal(
    runCli(
      ["--mode=azure-generation-cutover"],
      JSON.stringify(runtimeCutoverFixture),
    ),
    0,
  );
  assert.equal(
    runCli(
      ["--mode=azure-credential-cleanup"],
      JSON.stringify(credentialCleanupFixture),
    ),
    0,
  );
  assert.equal(
    runCli(
      ["--mode=final-rollout-complete"],
      JSON.stringify(terminalFixture),
    ),
    0,
  );
  assert.equal(
    runCli(
      ["--mode=post-cutover-relay-image-rollout"],
      JSON.stringify(postCutoverRelayImageRolloutFixture()),
    ),
    0,
  );
  assert.equal(
    runCli(["--mode=azure-generation-cutover", "extra"], "{}"),
    2,
  );
  assert.equal(runCli(["--mode=final-rollout-complete"], "{"), 1);
});

test("new guard modes enforce the exact resource address set", () => {
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    rejectsCutoverMutation(source, mode, (candidate) => {
      candidate.resource_changes[0].address =
        "module.inventory_substitution.azurerm_resource.this";
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      candidate.resource_changes.pop();
    });
    rejectsCutoverMutation(source, mode, (candidate) => {
      candidate.resource_changes.push(clone(candidate.resource_changes[0]));
    });
  }
});

test("new guard modes require exact boolean applyability", () => {
  for (const [source, mode, expected] of [
    [runtimeCutoverFixture, "azure-generation-cutover", true],
    [credentialCleanupFixture, "azure-credential-cleanup", true],
    [terminalFixture, "final-rollout-complete", false],
  ]) {
    assert.equal(source.applyable, expected);
    assert.equal(acceptsPlan(source, mode), true);
    for (const invalid of [undefined, null, "true", 0, 1, {}, []]) {
      const candidate = clone(source);
      if (invalid === undefined) {
        delete candidate.applyable;
      } else {
        candidate.applyable = invalid;
      }
      assert.equal(
        acceptsPlan(candidate, mode),
        false,
        `${mode} accepted applyable=${String(invalid)}`,
      );
    }
  }
});

test("new guard modes require exact state envelopes and module placement", () => {
  const cases = [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ];
  const mutations = [
    (candidate) => {
      candidate.planned_values.extra = {};
    },
    (candidate) => {
      candidate.prior_state.format_version = "1.2";
    },
    (candidate) => {
      candidate.prior_state.terraform_version = "1.14.0";
    },
    (candidate) => {
      candidate.prior_state.values.extra = {};
    },
    (candidate) => {
      candidate.planned_values.root_module.child_modules[0].address =
        "module.moved";
    },
    (candidate) => {
      const modules = candidate.planned_values.root_module.child_modules;
      const foundry = modules.find((module) => module.address === "module.foundry");
      const observability = modules.find(
        (module) => module.address === "module.observability",
      );
      const index = foundry.resources.findIndex(
        (resource) => resource.address === lunaTranscriptionAddress,
      );
      observability.resources.push(foundry.resources.splice(index, 1)[0]);
    },
    (candidate) => {
      candidate.planned_values.root_module.resources[0].unexpected = true;
    },
  ];
  for (const [source, mode] of cases) {
    for (const mutate of mutations) {
      rejectsCutoverMutation(source, mode, mutate);
    }
  }
});

test("new guard modes require exact output schemas, types, and sensitivity references", () => {
  const cases = [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ];
  const mutations = [
    (candidate) => {
      delete candidate.planned_values.outputs.foundry_deployment_names.type;
    },
    (candidate) => {
      candidate.prior_state.values.outputs.foundry_deployment_names.type = [
        "set",
        "string",
      ];
    },
    (candidate) => {
      candidate.output_changes.foundry_deployment_names.extra = true;
    },
  ];
  for (const [source, mode] of cases) {
    for (const mutate of mutations) {
      rejectsCutoverMutation(source, mode, mutate);
    }
    for (const field of [
      "before_sensitive",
      "after_sensitive",
    ]) {
      for (const invalid of [null, 0, "false", {}, []]) {
        rejectsCutoverMutation(source, mode, (candidate) => {
          candidate.output_changes.application_insights_connection_string[field] =
            invalid;
        });
      }
    }
    for (const section of [
      candidate => candidate.planned_values.outputs,
      candidate => candidate.prior_state.values.outputs,
    ]) {
      for (const invalid of [null, 0, "false", {}, []]) {
        rejectsCutoverMutation(source, mode, (candidate) => {
          section(candidate).application_insights_connection_string.sensitive =
            invalid;
        });
      }
    }
  }
});

test("new guard modes tolerate legitimate Terraform show-json metadata", () => {
  const candidate = clone(terminalFixture);
  candidate.provider_schemas = {
    "registry.terraform.io/hashicorp/azurerm": { version: 1 },
  };
  const app = cutoverChange(candidate, lunaContainerAppAddress);
  app.change.before_identity = { id: app.change.before.id, type: null };
  app.change.after_identity = { id: app.change.after.id, type: null };
  assert.equal(acceptsPlan(candidate, "final-rollout-complete"), true);
});

test("Azure generation cutover binds the immutable predecessor and replacement image", () => {
  const appAddress = "module.container_app_workload[0].azapi_resource.this";
  rejectsCutoverMutation(
    runtimeCutoverFixture,
    "azure-generation-cutover",
    (candidate) => {
      const app = cutoverChange(candidate, appAddress);
      app.change.before.body.properties.template.containers[0].image =
        "palancardevacraeeacd8.azurecr.io/palancar-relay@sha256:" + "d".repeat(64);
    },
  );
  rejectsCutoverMutation(
    runtimeCutoverFixture,
    "azure-generation-cutover",
    (candidate) => {
      const app = cutoverChange(candidate, appAddress);
      app.change.after.body.properties.template.containers[0].image =
        "palancardevacraeeacd8.azurecr.io/palancar-relay:latest";
    },
  );
  rejectsCutoverMutation(
    runtimeCutoverFixture,
    "azure-generation-cutover",
    (candidate) => {
      candidate.variables.relay_image_digest.value =
        "palancardevacraeeacd8.azurecr.io/palancar-relay@sha256:" + "e".repeat(64);
    },
  );
  const rebound = clone(runtimeCutoverFixture);
  const reboundImage =
    "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:" + "f".repeat(64);
  rebound.variables.relay_image_digest.value = reboundImage;
  cutoverChange(rebound, appAddress).change.after.body.properties.template.containers[0].image =
    reboundImage;
  lunaBootstrapValueResource(
    rebound.planned_values.root_module,
    appAddress,
  ).values.body.properties.template.containers[0].image = reboundImage;
  assert.equal(acceptsPlan(rebound, "azure-generation-cutover"), true);
});

test("Azure generation cutover rejects CPU, memory, and replica drift", () => {
  for (const mutate of [
    (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.containers[0].resources.cpu = 0.5;
    },
    (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.containers[0].resources.memory = "1Gi";
    },
    (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.scale.minReplicas = 2;
    },
    (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.scale.maxReplicas = 2;
    },
  ]) {
    rejectsCutoverMutation(
      runtimeCutoverFixture,
      "azure-generation-cutover",
      mutate,
    );
  }
});

test("Azure generation cutover binds both managed identities and every role field", () => {
  const roleAddress =
    "module.identities_rbac.azurerm_role_assignment.runtime_openai";
  for (const mutate of [
    (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.identity[0].identity_ids[1] += "/unexpected";
    },
    (candidate) => {
      cutoverChange(candidate, "module.identities_rbac.azurerm_user_assigned_identity.runtime").change.after.principal_id =
        "44444444-4444-4444-8444-444444444444";
    },
    (candidate) => {
      cutoverChange(candidate, roleAddress).change.after.principal_id =
        "44444444-4444-4444-8444-444444444444";
    },
    (candidate) => {
      cutoverChange(candidate, roleAddress).change.after.scope += "/unexpected";
    },
    (candidate) => {
      cutoverChange(candidate, roleAddress).change.after.role_definition_id += "/unexpected";
    },
    (candidate) => {
      cutoverChange(candidate, roleAddress).change.after.name = "44444444-4444-4444-8444-444444444444";
    },
  ]) {
    rejectsCutoverMutation(
      runtimeCutoverFixture,
      "azure-generation-cutover",
      mutate,
    );
  }
});

test("Azure generation cutover rejects drift in either exact model", () => {
  for (const address of [
    lunaTranscriptionAddress,
    lunaDeploymentAddress,
  ]) {
    rejectsCutoverMutation(
      runtimeCutoverFixture,
      "azure-generation-cutover",
      (candidate) => {
        cutoverChange(candidate, address).change.after.model[0].version =
          "2099-01-01";
      },
    );
    rejectsCutoverMutation(
      runtimeCutoverFixture,
      "azure-generation-cutover",
      (candidate) => {
        cutoverChange(candidate, address).change.actions = ["update"];
      },
    );
  }
});

test("new guard modes reject unknowns in every security-relevant envelope", () => {
  const mutations = [
    (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after_unknown = {
        body: true,
      };
    },
    (candidate) => {
      cutoverChange(candidate, lunaDeploymentAddress).change.after_unknown = {
        model: [{ version: true }],
      };
    },
    (candidate) => {
      cutoverChange(candidate, operatorRateRoleAddress).change.after_unknown = {
        principal_id: true,
      };
    },
    (candidate) => {
      candidate.output_changes.foundry_deployment_names.after_unknown = true;
    },
    (candidate) => {
      candidate.resource_changes[0].change.unknown = true;
    },
  ];
  for (const mutate of mutations) {
    rejectsCutoverMutation(
      runtimeCutoverFixture,
      "azure-generation-cutover",
      mutate,
    );
  }
  rejectsCutoverMutation(
    credentialCleanupFixture,
    "azure-credential-cleanup",
    mutations[3],
  );
  rejectsCutoverMutation(
    terminalFixture,
    "final-rollout-complete",
    mutations[0],
  );
});

test("new guard modes reject action reasons, imports, deposed state, and drift metadata", () => {
  const mutations = [
    (candidate) => {
      candidate.resource_changes[0].change.action_reason = "fixture";
    },
    (candidate) => {
      candidate.resource_changes[0].import = { id: "fixture" };
    },
    (candidate) => {
      candidate.resource_changes[0].deposed = "fixture";
    },
    (candidate) => {
      candidate.resource_drift = [{ address: "fixture" }];
    },
    (candidate) => {
      candidate.deferred_changes = [];
    },
    (candidate) => {
      candidate.configuration.target = "module.container_app_workload";
    },
  ];
  for (const [source, mode] of [
    [runtimeCutoverFixture, "azure-generation-cutover"],
    [credentialCleanupFixture, "azure-credential-cleanup"],
    [terminalFixture, "final-rollout-complete"],
  ]) {
    for (const mutate of mutations) {
      rejectsCutoverMutation(source, mode, mutate);
    }
  }
});

test("final-rollout-complete is the post-cleanup direct-Entra terminal state", () => {
  const app = cutoverChange(terminalFixture, lunaContainerAppAddress).change.after;
  const models = terminalFixture.resource_changes.filter((entry) =>
    entry.address.startsWith("module.foundry.azurerm_cognitive_deployment.this["),
  );
  assert.equal(terminalFixture.applyable, false);
  assert.equal(terminalFixture.resource_changes.every((entry) =>
    entry.change.actions.length === 1 && entry.change.actions[0] === "no-op",
  ), true);
  assert.equal(app.body.properties.configuration.secrets.length, 0);
  assert.equal(app.body.properties.template.containers.length, 1);
  assert.deepEqual(
    models.map((entry) => entry.change.after.name),
    ["gpt-4o-mini-transcribe", "gpt-5.6-luna"],
  );
  assert.equal(
    terminalFixture.resource_changes.some((entry) =>
      entry.address.includes("runtime_secrets_user"),
    ),
    false,
  );
  assert.equal(acceptsPlan(terminalFixture, "final-rollout-complete"), true);

  const rebound = clone(terminalFixture);
  rebindTerminalSensitiveLeaves(rebound);
  assert.equal(acceptsPlan(rebound, "final-rollout-complete"), true);

  const inconsistent = clone(rebound);
  finalValueResource(
    inconsistent.planned_values.root_module,
    "module.workload_state.azurerm_storage_account.this",
  ).values.primary_connection_string = "inconsistent-derived-connection";
  assert.equal(acceptsPlan(inconsistent, "final-rollout-complete"), false);

  const unmasked = clone(rebound);
  cutoverChange(
    unmasked,
    "module.observability.azurerm_log_analytics_workspace.this",
  ).change.after_sensitive.primary_shared_key = false;
  assert.equal(acceptsPlan(unmasked, "final-rollout-complete"), false);

  const invalidType = clone(rebound);
  const storageChange = cutoverChange(
    invalidType,
    "module.workload_state.azurerm_storage_account.this",
  );
  for (const value of [
    storageChange.change.before,
    storageChange.change.after,
    finalValueResource(
      invalidType.planned_values.root_module,
      "module.workload_state.azurerm_storage_account.this",
    ).values,
    finalValueResource(
      invalidType.prior_state.values.root_module,
      "module.workload_state.azurerm_storage_account.this",
    ).values,
  ]) {
    value.primary_access_key = 123;
  }
  assert.equal(acceptsPlan(invalidType, "final-rollout-complete"), false);
});

test("post-cutover relay image rollout accepts the observed provider-shaped update", () => {
  const candidate = postCutoverRelayImageRolloutFixture();
  assert.equal(candidate.applyable, true);
  assert.equal(
    candidate.resource_changes.filter((entry) =>
      entry.change.actions.includes("update"),
    ).length,
    1,
  );
  assert.deepEqual(
    cutoverChange(candidate, lunaContainerAppAddress).change.actions,
    ["update"],
  );
  assert.deepEqual(
    candidate.output_changes.relay_latest_revision_name.actions,
    ["update"],
  );
  assert.equal(
    candidate.output_changes.relay_latest_revision_name.after_unknown,
    true,
  );
  assert.equal(
    Object.values(candidate.output_changes).filter((change) =>
      change.actions.includes("update"),
    ).length,
    1,
  );
  assert.equal(
    Object.entries(candidate.output_changes).every(([name, change]) =>
      name === "relay_latest_revision_name"
        ? change.actions[0] === "update"
        : change.actions[0] === "no-op",
    ),
    true,
  );
  assert.equal(
    acceptsPlan(candidate, "post-cutover-relay-image-rollout"),
    true,
  );
});

test("post-cutover relay image rollout rejects every non-image or incomplete delta", () => {
  const mode = "post-cutover-relay-image-rollout";
  const mutations = [
    ["same relay digest", (candidate) => {
      candidate.variables.relay_image_digest.value =
        cutoverChange(candidate, lunaContainerAppAddress).change.before.body
          .properties.template.containers[0].image;
    }],
    ["mutable tag", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.containers[0].image =
        "palancardevacraeeacd8c.azurecr.io/palancar-relay:latest";
    }],
    ["wrong image host", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.containers[0].image =
        "other.azurecr.io/palancar-relay@sha256:" + "c".repeat(64);
    }],
    ["wrong image repository", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.containers[0].image =
        "palancardevacraeeacd8c.azurecr.io/other@sha256:" + "c".repeat(64);
    }],
    ["second resource action", (candidate) => {
      candidate.resource_changes.push(clone(candidate.resource_changes[0]));
    }],
    ["second app action", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.actions.push("update");
    }],
    ["environment drift", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.containers[0].env[0].value =
        "staging";
    }],
    ["identity drift", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.identity[0].identity_ids[0] += "/drift";
    }],
    ["scale drift", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.scale.minReplicas = 2;
    }],
    ["traffic drift", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.configuration.ingress.traffic[0].weight = 99;
    }],
    ["probe drift", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.containers[0].probes = [];
    }],
    ["resource drift", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.containers[0].resources.cpu = 0.5;
    }],
    ["mutable sidecar", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.template.containers.push({});
    }],
    ["secret drift", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after.body.properties.configuration.secrets.push({});
    }],
    ["model drift", (candidate) => {
      cutoverChange(candidate, lunaDeploymentAddress).change.after.model[0].version = "2099-01-01";
    }],
    ["RBAC drift", (candidate) => {
      cutoverChange(candidate, operatorRateRoleAddress).change.after.role_definition_name = "Owner";
    }],
    ["cleanup image drift", (candidate) => {
      cutoverChange(candidate, finalCleanupJobAddress).change.after.body.properties.template.containers[0].image =
        "palancardevacraeeacd8c.azurecr.io/palancar-expiry-cleanup@sha256:" + "d".repeat(64);
    }],
    ["hidden sensitive value", (candidate) => {
      cutoverChange(candidate, lunaContainerAppAddress).change.after_sensitive.extra = true;
    }],
    ["latest revision output not computed", (candidate) => {
      candidate.output_changes.relay_latest_revision_name.after_unknown = false;
    }],
    ["prior state drift", (candidate) => {
      finalValueResource(candidate.prior_state.values.root_module, lunaContainerAppAddress).values.body.properties.template.containers[0].image =
        "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:" + "e".repeat(64);
    }],
    ["planned state drift", (candidate) => {
      finalValueResource(candidate.planned_values.root_module, lunaContainerAppAddress).values.body.properties.template.containers[0].image =
        "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:" + "f".repeat(64);
    }],
    ["configuration drift", (candidate) => {
      candidate.configuration.extra = true;
    }],
    ["failed check", (candidate) => {
      candidate.checks[0].status = "fail";
    }],
    ["deferred change", (candidate) => {
      candidate.deferred_changes = [];
    }],
    ["unknown resource drift", (candidate) => {
      candidate.resource_drift = [{ address: "fixture" }];
    }],
    ["missing inventory entry", (candidate) => {
      candidate.resource_changes.pop();
    }],
    ["duplicate inventory entry", (candidate) => {
      candidate.resource_changes.push(clone(candidate.resource_changes[0]));
    }],
  ];
  for (const [label, mutate] of mutations) {
    const candidate = postCutoverRelayImageRolloutFixture();
    mutate(candidate);
    assert.equal(acceptsPlan(candidate, mode), false, label);
  }
});
