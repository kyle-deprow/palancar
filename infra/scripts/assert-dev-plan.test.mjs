import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { acceptsPlan, runCli } from "./assert-dev-plan.mjs";

const cliPath = fileURLToPath(new URL("./assert-dev-plan.mjs", import.meta.url));

const deploymentAddress =
  'module.foundry.azurerm_cognitive_deployment.this["gpt-4o-mini-transcribe"]';
const containerAppAddress =
  "module.container_app_workload[0].azapi_resource.this";

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
        template: { scale },
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
