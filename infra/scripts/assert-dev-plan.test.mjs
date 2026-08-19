import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { acceptsPlan, runCli } from "./assert-dev-plan.mjs";

const cliPath = fileURLToPath(new URL("./assert-dev-plan.mjs", import.meta.url));

const deploymentAddress =
  'module.foundry.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"]';
const containerAppAddress =
  "module.container_app_workload[0].azapi_resource.this";
const operatorPrincipalId = "00000000-0000-0000-0000-000000000003";
const operatorSecurityRoleAddress =
  "module.identities_rbac.azurerm_role_assignment.operator_security_table";
const operatorRateRoleAddress =
  "module.identities_rbac.azurerm_role_assignment.operator_rate_table";
const OPERATOR_ROLE_ASSIGNMENTS_FOR_TEST = new Set([
  operatorSecurityRoleAddress,
  operatorRateRoleAddress,
]);
const fixtureSubscriptionId = "00000000-0000-0000-0000-000000000000";
const tableRoleDefinitionId =
  `/subscriptions/${fixtureSubscriptionId}/providers/Microsoft.Authorization/roleDefinitions/0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3`;
const tableServiceId =
  `/subscriptions/${fixtureSubscriptionId}/resourceGroups/rg-palancar-dev/providers/Microsoft.Storage/storageAccounts/palancardev/tableServices/default`;

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
  name: "gpt-4o-mini-transcribe",
  model: [
    {
      format: "OpenAI",
      name: "gpt-4o-mini-transcribe",
      version: "2025-12-15",
    },
  ],
  sku: [{ name: "GlobalStandard", capacity: 1 }],
  version_upgrade_option: "NoAutoUpgrade",
};

const miniCreate = change(deploymentAddress, ["create"], pinnedAfter);
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
    checks: [{ status: "pass" }],
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

test("model-spike accepts the exact pinned deployment create", () => {
  assert.equal(acceptsPlan(plan([miniCreate]), "model-spike"), true);
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
    { ...clone(pinnedAfter), model: [...pinnedAfter.model, pinnedAfter.model[0]] },
    { ...clone(pinnedAfter), sku: [{ name: "Standard", capacity: 1 }] },
    { ...clone(pinnedAfter), sku: [{ name: "GlobalStandard", capacity: 2 }] },
    { ...clone(pinnedAfter), sku: { name: "GlobalStandard", capacity: 1 } },
    { ...clone(pinnedAfter), version_upgrade_option: "Once" },
  ];

  for (const after of wrongPayloads) {
    assert.equal(
      acceptsPlan(plan([change(deploymentAddress, ["create"], after)]), "model-spike"),
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

  const afterWithoutRedundantName = clone(pinnedAfter);
  delete afterWithoutRedundantName.name;
  assert.equal(
    acceptsPlan(
      plan([change(deploymentAddress, ["create"], afterWithoutRedundantName)]),
      "model-spike",
    ),
    true,
  );
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
      fullPlan([appUpdate], { checks: [{ status: "pass" }] }),
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
  ], { checks: [{ status: "pass" }] });

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
    acceptsPlan(fullPlan([], { checks: [{ status: "pass" }] }), "full-deploy"),
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
