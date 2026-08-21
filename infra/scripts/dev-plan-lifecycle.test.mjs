import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  watch,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const PRODUCTION_MODULE_PATH = path.join(
  process.cwd(),
  "infra/scripts/dev-plan-lifecycle.mjs",
);
const instrumentedDirectory = mkdtempSync(
  path.join(tmpdir(), "palancar-lifecycle-test-module-"),
);
const instrumentedPath = path.join(instrumentedDirectory, "dev-plan-lifecycle.testable.mjs");
const instrumentedCacheRoot = path.join(instrumentedDirectory, "cache");
const scriptPathDeclaration = "const SCRIPT_PATH = fileURLToPath(import.meta.url);";
const cachePathDeclaration = "const LIFECYCLE_CACHE_ROOT =\n  \"/home/dev/.local/state/palancar/azure-foundry-entra-cutover-cache\";";
const productionSource = readFileSync(PRODUCTION_MODULE_PATH, "utf8");
assert.equal(productionSource.includes(scriptPathDeclaration), true);
assert.equal(productionSource.includes(cachePathDeclaration), true);
const instrumentedSource = `${productionSource
  .replace(
    scriptPathDeclaration,
    `const SCRIPT_PATH = ${JSON.stringify(PRODUCTION_MODULE_PATH)};`,
  )
  .replace(
    cachePathDeclaration,
    `const LIFECYCLE_CACHE_ROOT = ${JSON.stringify(instrumentedCacheRoot)};`,
  )}\nexport { LIFECYCLE_CACHE_ROOT, createLifecycle, runCli, createLifecycleForTests, runCliForTests };\n`;
const instrumentedFd = openSync(instrumentedPath, "wx", 0o600);
try {
  writeSync(instrumentedFd, instrumentedSource, 0, "utf8");
} finally {
  closeSync(instrumentedFd);
}
let lifecycleModule;
try {
  lifecycleModule = await import(pathToFileURL(instrumentedPath).href);
} finally {
  rmSync(instrumentedPath, { force: true });
}
after(() => rmSync(instrumentedDirectory, { recursive: true, force: true }));
const {
  BACKEND_SHA256,
  canonicalBackendIdentityJson,
  GUARD_MAPPINGS,
  PHASES,
  buildChildEnvironment,
  calculateBackendHash,
  canonicalJson,
  createLifecycle,
  createLifecycleForTests,
  LIFECYCLE_CACHE_ROOT,
  parseCanonicalBackendConfig,
  parseTerraformStateCache,
  parseCli,
  runCli,
  runCliForTests,
  sha256Bytes,
  TERRAFORM_PATH,
} = lifecycleModule;

const PLAN_BYTES = Buffer.from("synthetic saved terraform plan\n", "utf8");
const SHA = "a".repeat(64);
const BLOB = "e".repeat(40);
const COMMIT = "f".repeat(40);
const REPO_ROOT = process.cwd();
const REAL_BACKEND_PATH = path.join(REPO_ROOT, "infra/environments/dev/backend.hcl");
const REAL_BACKEND = parseCanonicalBackendConfig(readFileSync(REAL_BACKEND_PATH, "utf8"));
const SUBSCRIPTION = REAL_BACKEND.identity.subscription_id;
const TENANT = REAL_BACKEND.identity.tenant_id;
const OBJECT_ID = "00000000-0000-0000-0000-000000000003";
const FOUNDry_ACCOUNT_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.CognitiveServices/accounts/foundry-test`;
const TRANSCRIPTION_ID = `${FOUNDry_ACCOUNT_ID}/deployments/gpt-4o-mini-transcribe`;
const LUNA_ID = `${FOUNDry_ACCOUNT_ID}/deployments/gpt-5.6-luna`;
const RELAY_IMAGE = "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:e9b7e2ea937d3a15f3b3a52e50d9736b5c63c69765c3ee571ab0c06f762436bd";
const LITELLM_IMAGE = "palancardevacraeeacd8c.azurecr.io/palancar-litellm-proxy@sha256:d065e5e847b543fd22b43ea3b62a6680619d8c76b67c2a7ef6a135b10e3978b3";
const IMAGE_PULL_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.ManagedIdentity/userAssignedIdentities/image-pull`;
const RUNTIME_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.ManagedIdentity/userAssignedIdentities/runtime`;
const KEY_VAULT_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.KeyVault/vaults/kv-test`;
const KEY_VAULT_URI = "https://kv-test.vault.azure.net";
const FOUNDRY_ENDPOINT = "https://foundry-test.openai.azure.com";
const IMAGE_PULL_CLIENT = "00000000-0000-0000-0000-000000000010";
const IMAGE_PULL_PRINCIPAL = "00000000-0000-0000-0000-000000000011";
const RUNTIME_CLIENT = "00000000-0000-0000-0000-000000000012";
const RUNTIME_PRINCIPAL = "00000000-0000-0000-0000-000000000013";
const GENERATION_PATHS = [
  "packages/generation/src/errors.ts",
  "packages/generation/src/evidence.ts",
  "packages/generation/src/litellm.ts",
  "packages/generation/src/service.ts",
  "packages/generation/src/types.ts",
  "packages/generation/test/generation.test.ts",
  "packages/generation/test/litellm-provider.test.ts",
];

function writeExclusive(filePath, value) {
  const fd = openSync(filePath, "wx", 0o600);
  try {
    const text = typeof value === "string" ? value : canonicalJson(value);
    writeSync(fd, text, 0, "utf8");
  } finally {
    closeSync(fd);
  }
}

function writeBackend(filePath, resourceGroup = REAL_BACKEND.identity.resource_group_name) {
  writeExclusive(
    filePath,
    [
      `subscription_id = "${SUBSCRIPTION}"`,
      `tenant_id = "${TENANT}"`,
      `resource_group_name = "${resourceGroup}"`,
      `storage_account_name = "${REAL_BACKEND.identity.storage_account_name}"`,
      `container_name = "${REAL_BACKEND.identity.container_name}"`,
      `key = "${REAL_BACKEND.identity.key}"`,
      "use_azuread_auth = true",
      "use_cli = true",
      "",
    ].join("\n"),
  );
}

function writeTerraformCache(workdir, resourceGroup = REAL_BACKEND.identity.resource_group_name) {
  const directory = path.join(workdir, ".terraform");
  mkdirSync(directory, { mode: 0o700 });
  writeExclusive(path.join(directory, "terraform.tfstate"), {
    version: 3,
    terraform_version: "1.15.8",
    backend: {
      type: "azurerm",
      config: {
        access_key: null,
        ado_pipeline_service_connection_id: null,
        client_certificate: null,
        client_certificate_password: null,
        client_certificate_path: null,
        client_id: null,
        client_id_file_path: null,
        client_secret: null,
        client_secret_file_path: null,
        container_name: REAL_BACKEND.identity.container_name,
        endpoint: null,
        environment: null,
        key: REAL_BACKEND.identity.key,
        lookup_blob_endpoint: null,
        metadata_host: null,
        msi_endpoint: null,
        oidc_request_token: null,
        oidc_request_url: null,
        oidc_token: null,
        oidc_token_file_path: null,
        resource_group_name: resourceGroup,
        sas_token: null,
        snapshot: null,
        storage_account_name: REAL_BACKEND.identity.storage_account_name,
        subscription_id: SUBSCRIPTION,
        tenant_id: TENANT,
        use_aks_workload_identity: null,
        use_azuread_auth: true,
        use_cli: true,
        use_msi: null,
        use_oidc: null,
      },
      hash: 750355294,
    },
  });
}

let generationDiffCache;

function generationDiff() {
  if (generationDiffCache !== undefined) return generationDiffCache;
  generationDiffCache = spawnSync(
    "/usr/bin/git",
    ["diff", "--binary", "--", ...GENERATION_PATHS],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ).stdout;
  return generationDiffCache;
}

function relayEnvironment(topology) {
  if (topology === "pre") {
    return [
      { name: "PALANCAR_GENERATION_PROVIDER", value: "litellm" },
      { name: "PALANCAR_LITELLM_BASE_URL", value: "http://127.0.0.1:4000" },
      { name: "PALANCAR_LITELLM_MODEL", value: "palancar-generation" },
      { name: "PALANCAR_LITELLM_API_KEY", secretRef: "litellm-master-key" },
    ];
  }
  return [
    { name: "PALANCAR_TRANSCRIPTION_PROVIDER", value: "azure-realtime" },
    { name: "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT", value: "wss://foundry-test.openai.azure.com/openai/v1/realtime?intent=transcription" },
    { name: "PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT", value: "gpt-4o-mini-transcribe" },
  ];
}

function liveContainerApp(topology, revision) {
  const relay = {
    name: "relay",
    image: RELAY_IMAGE,
    env: relayEnvironment(topology),
  };
  const containers = topology === "pre"
    ? [
        relay,
        {
          name: "litellm",
          image: LITELLM_IMAGE,
          env: [
            { name: "PALANCAR_LITELLM_BACKEND", value: "openrouter" },
            { name: "PALANCAR_LITELLM_UPSTREAM_MODEL", value: "openrouter/openai/gpt-5.6-luna" },
            { name: "LITELLM_MASTER_KEY", secretRef: "litellm-master-key" },
            { name: "OPENROUTER_API_KEY", secretRef: "openrouter-api-key" },
          ],
        },
      ]
    : [relay];
  return {
    id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.App/containerApps/relay-test`,
    name: "relay-test",
    location: "eastus2",
    type: "Microsoft.App/containerApps",
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: {
        [IMAGE_PULL_ID]: { clientId: IMAGE_PULL_CLIENT, principalId: IMAGE_PULL_PRINCIPAL },
        [RUNTIME_ID]: { clientId: RUNTIME_CLIENT, principalId: RUNTIME_PRINCIPAL },
      },
    },
    properties: {
      provisioningState: "Succeeded",
      runningStatus: "Running",
      configuration: {
        activeRevisionsMode: "Single",
        ingress: {
          external: true,
          targetPort: 8787,
          transport: "Http",
          allowInsecure: false,
          traffic: [{ revisionName: revision, weight: 100 }],
        },
        registries: [{ server: "palancardevacraeeacd8c.azurecr.io", identity: IMAGE_PULL_ID }],
        identitySettings: [
          { identity: IMAGE_PULL_ID.replace("resourceGroups", "resourcegroups"), lifecycle: "None" },
          { identity: RUNTIME_ID.replace("resourceGroups", "resourcegroups"), lifecycle: "Main" },
        ],
        secrets: topology === "pre"
          ? [
              { name: "litellm-master-key", keyVaultUrl: `${KEY_VAULT_URI}/secrets/litellm-master-key`, identity: RUNTIME_ID },
              { name: "openrouter-api-key", keyVaultUrl: `${KEY_VAULT_URI}/secrets/openrouter-api-key`, identity: RUNTIME_ID },
            ]
          : [],
      },
      template: { containers, scale: { minReplicas: 1, maxReplicas: 1 } },
    },
  };
}

function liveRevision(revision, topology) {
  const app = liveContainerApp(topology, revision);
  return {
    id: `${app.id}/revisions/${revision}`,
    name: revision,
    type: "Microsoft.App/containerApps/revisions",
    properties: {
      active: true,
      healthState: "Healthy",
      provisioningState: "Provisioned",
      runningState: "Running",
      trafficWeight: 100,
      template: app.properties.template,
    },
  };
}

function protectedReceipt(value) {
  return { ...value, sha256: sha256Bytes(canonicalJson(value)) };
}

function makeHarness(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "palancar-lifecycle-"));
  chmodSync(root, 0o700);
  const repoRoot = mkdtempSync(path.join(tmpdir(), "palancar-repo-"));
  chmodSync(repoRoot, 0o700);
  const workdir = mkdtempSync(path.join(tmpdir(), "palancar-workdir-"));
  chmodSync(workdir, 0o700);
  for (const file of [
    "infra/scripts/dev-plan-lifecycle.mjs",
    "infra/scripts/assert-dev-plan.mjs",
    "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
    "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
  ]) {
    const target = path.join(repoRoot, file);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeExclusive(target, file.endsWith(".json") ? { reviewed: true } : "reviewed fixture\n");
  }
  const backendConfigPath = path.join(workdir, "backend.hcl");
  const tfvarsPath = path.join(workdir, "terraform.tfvars");
  writeBackend(backendConfigPath);
  writeTerraformCache(workdir);
  writeExclusive(tfvarsPath, `operator_principal_id = "${OBJECT_ID}"\n`);
  const closure = path.join(root, "closure-marker");
  let tick = Date.now();
  let serial = 7;
  let lineage = "lineage-1";
  let revision = "revision-before";
  let applyStatus = "success";
  let modelCase = "ok";
  let topology = "pre";
  let liveAppMutator = (value) => value;
  let liveRevisionMutator = (value) => value;
  let roleMutator = (value) => value;
  let httpMutator = (value) => value;
  const httpCalls = [];
  const calls = [];
  const run = (request) => {
    calls.push({
      command: request.command,
      argv: [...request.argv],
      env: { ...request.env },
      input: request.input,
      phase: request.phase,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      killSignal: request.killSignal,
    });
    if (request.command === "/usr/bin/git") {
      if (request.argv[0] === "status") {
        if (request.phase === "model-bootstrap") {
          return {
            status: 0,
            stdout: GENERATION_PATHS.map((file) => ` M ${file}`).join("\n") + "\n",
          };
        }
        return { status: 0, stdout: "" };
      }
      if (request.argv[0] === "diff") return { status: 0, stdout: generationDiff() };
      if (request.argv[0] === "rev-parse" && request.argv[1] === "HEAD") {
        return { status: 0, stdout: `${COMMIT}\n` };
      }
      if (request.argv[0] === "rev-parse") return { status: 0, stdout: `${BLOB}\n` };
      if (request.argv[0] === "hash-object") return { status: 0, stdout: `${BLOB}\n` };
    }
    if (request.command === "/usr/bin/az") {
      if (request.argv[0] === "account" && request.argv[1] === "get-access-token") {
        return {
          status: 0,
          stdout: JSON.stringify({
            accessToken: "protected-test-token-value-1234567890",
            expiresOn: "2099-01-01 00:00:00.000000",
            subscription: SUBSCRIPTION,
            tenant: TENANT,
            tokenType: "Bearer",
          }),
        };
      }
      if (request.argv[0] === "account") {
        return {
          status: 0,
          stdout: JSON.stringify({
            id: SUBSCRIPTION,
            tenantId: TENANT,
            environmentName: "AzureCloud",
            user: { type: "user" },
          }),
        };
      }
      if (request.argv[0] === "ad") return { status: 0, stdout: JSON.stringify({ id: OBJECT_ID }) };
      if (request.argv[0] === "cognitiveservices" && request.argv[1] === "account" && request.argv[2] === "show") {
        if (modelCase === "account-malformed") return { status: 0, stdout: JSON.stringify([]) };
        return {
          status: 0,
          stdout: JSON.stringify({
            id: FOUNDry_ACCOUNT_ID,
            name: "foundry-test",
            location: modelCase === "account-wrong-region" ? "westus" : "eastus2",
            kind: "OpenAI",
            sku: { name: "S0" },
            type: "Microsoft.CognitiveServices/accounts",
          }),
        };
      }
      if (request.argv[0] === "cognitiveservices" && request.argv[1] === "account" && request.argv[2] === "deployment" && request.argv[3] === "show") {
        if (modelCase === "luna-show-present") {
          return {
            status: 0,
            stdout: JSON.stringify({
              id: LUNA_ID,
              name: "gpt-5.6-luna",
              type: "Microsoft.CognitiveServices/accounts/deployments",
              properties: {
                model: { name: "gpt-5.6-luna", version: "2026-07-09", format: "OpenAI" },
                provisioningState: "Succeeded",
                spilloverDeploymentName: null,
                versionUpgradeOption: "NoAutoUpgrade",
              },
              sku: { name: "GlobalStandard", capacity: 1013 },
            }),
          };
        }
        if (modelCase === "luna-query-error") {
          return { status: 3, exitCode: 3, stderr: "(AuthorizationFailed) denied\n", stdout: "" };
        }
        return {
          status: 3,
          exitCode: 3,
          stderr: "(DeploymentNotFound) The deployment was not found.\nCode: DeploymentNotFound\n",
          stdout: "",
        };
      }
      if (request.argv[0] === "cognitiveservices" && request.argv[1] === "account" && request.argv[2] === "deployment" && request.argv[3] === "list") {
        if (modelCase === "deployment-malformed") return { status: 0, stdout: JSON.stringify({ value: [] }) };
        if (modelCase === "deployment-unknown-shape") return { status: 0, stdout: JSON.stringify({ deployments: [] }) };
        const transcription = {
          id: TRANSCRIPTION_ID,
          name: "gpt-4o-mini-transcribe",
          type: "Microsoft.CognitiveServices/accounts/deployments",
          properties: {
            model: { name: "gpt-4o-mini-transcribe", version: "2025-12-15", format: "OpenAI" },
            provisioningState: modelCase === "transcription-nonterminal" ? "Creating" : "Succeeded",
            spilloverDeploymentName: modelCase === "deployment-spillover" ? "gpt-5.6-luna" : null,
            versionUpgradeOption: modelCase === "upgrade-bad" ? "OnceNewDefaultVersionAvailable" : "NoAutoUpgrade",
          },
          sku: {
            name: "GlobalStandard",
            capacity: modelCase === "transcription-capacity-bad" ? 2 : 1,
          },
        };
        const deployments = modelCase === "transcription-missing" ? [] : [transcription];
        if (modelCase === "transcription-wrong-model") deployments[0].properties.model.name = "gpt-4o";
        if (modelCase === "transcription-wrong-version") deployments[0].properties.model.version = "2025-01-01";
        if (modelCase === "transcription-wrong-sku") deployments[0].sku.name = "Standard";
        if (modelCase === "deployment-duplicate") deployments.push(structuredClone(transcription));
        if (modelCase === "deployment-wrong-context") deployments[0].id = deployments[0].id.replace("rg-runtime", "rg-other");
        if (modelCase === "luna-present" || topology === "post") {
          const lunaModelName = modelCase === "luna-wrong-model" ? "gpt-4o" : "gpt-5.6-luna";
          const lunaVersion = modelCase === "luna-wrong-version" ? "2026-07-08" : "2026-07-09";
          const lunaProvisioningState = modelCase === "luna-nonterminal" ? "Creating" : "Succeeded";
          const lunaSku = modelCase === "luna-wrong-sku" ? "Standard" : "GlobalStandard";
          const lunaCapacity = modelCase === "luna-wrong-capacity" ? 1012 : 1013;
          deployments.push({
            id: LUNA_ID,
            name: "gpt-5.6-luna",
            type: "Microsoft.CognitiveServices/accounts/deployments",
            properties: {
              model: { name: lunaModelName, version: lunaVersion, format: "OpenAI" },
              provisioningState: lunaProvisioningState,
              spilloverDeploymentName: null,
              versionUpgradeOption: "NoAutoUpgrade",
            },
            sku: { name: lunaSku, capacity: lunaCapacity },
          });
        }
        return { status: 0, stdout: JSON.stringify(deployments) };
      }
      if (request.argv[1] === "model") {
        if (modelCase === "catalog-malformed") return { status: 0, stdout: JSON.stringify({ value: [] }) };
        if (modelCase === "catalog-unknown-shape") return { status: 0, stdout: JSON.stringify({ models: [] }) };
        const modelEntry = (kind) => {
          const format = modelCase === "catalog-wrong-format" ? "AzureML" : "OpenAI";
          const version = modelCase === "catalog-bad" || modelCase === "catalog-wrong-version"
            ? "2026-07-08"
            : "2026-07-09";
          const catalogName = `${format}.gpt-5.6-luna.${version}`;
          return {
            description: null,
            id: `/subscriptions/${SUBSCRIPTION}/providers/Microsoft.CognitiveServices/locations/eastus2/models/${catalogName}`,
            kind,
            location: modelCase === "catalog-wrong-region" ? "westus" : "eastus2",
            name: catalogName,
            skuName: "S0",
            type: "Microsoft.CognitiveServices/locations/models",
            model: {
              name: "gpt-5.6-luna",
              format,
              version,
            lifecycleStatus: modelCase === "catalog-not-ga" ? "Preview" : "GenerallyAvailable",
            skus: [{ name: modelCase === "catalog-wrong-sku" ? "Standard" : "GlobalStandard" }],
            },
          };
        };
        return {
          status: 0,
          stdout: JSON.stringify([
            modelEntry(modelCase === "catalog-wrong-kind" ? "AIServices" : "OpenAI"),
            modelEntry("AIServices"),
            ...(modelCase === "catalog-duplicate" ? [modelEntry("OpenAI")] : []),
          ]),
        };
      }
      if (request.argv[1] === "usage") {
        if (modelCase === "quota-malformed") return { status: 0, stdout: JSON.stringify({ value: [] }) };
        if (modelCase === "quota-unknown-shape") return { status: 0, stdout: JSON.stringify({ usages: [] }) };
        const quotaModel = modelCase === "quota-wrong-model" ? "gpt-4o" : "gpt-5.6-luna";
        const quota = {
          name: {
            value: `OpenAI.GlobalStandard.${quotaModel}`,
            localizedValue: `One Thousand Tokens Per Minute - ${quotaModel} - GlobalStandard`,
          },
          currentValue: modelCase === "quota-total-only" ? undefined : (modelCase === "quota-bad" ? 1013 : 0),
          limit: modelCase === "quota-current-only" ? undefined : 1013,
          status: modelCase === "quota-status-blocked"
            ? "Blocked"
            : modelCase === "quota-status-overage"
              ? "InOverage"
              : modelCase === "quota-status-unknown"
                ? "Unknown"
                : null,
          unit: modelCase === "quota-unknown-unit" ? "Tokens" : "Count",
        };
        if (modelCase === "quota-total-only") delete quota.currentValue;
        if (modelCase === "quota-current-only") delete quota.limit;
        const values = modelCase === "quota-unrelated-sufficient"
          ? [{
              name: { value: "OpenAI.GlobalStandard.gpt-4o", localizedValue: "One Thousand Tokens Per Minute - gpt-4o - GlobalStandard" },
              currentValue: 0,
              limit: 2000,
              status: null,
              unit: "Count",
            }]
          : [quota];
        if (modelCase === "quota-duplicate") values.push(structuredClone(values[0]));
        return { status: 0, stdout: JSON.stringify(values) };
      }
      if (request.argv[0] === "containerapp") {
        const app = liveAppMutator(liveContainerApp(topology, revision));
        if (request.argv[1] === "revision") {
          const revisions = liveRevisionMutator(liveRevision(revision, topology));
          return { status: 0, stdout: JSON.stringify(Array.isArray(revisions) ? revisions : [revisions]) };
        }
        return { status: 0, stdout: JSON.stringify(app) };
      }
      if (request.argv[0] === "role" && request.argv[1] === "assignment") {
        const scope = request.argv[request.argv.indexOf("--scope") + 1];
        if (scope === KEY_VAULT_ID) return { status: 0, stdout: JSON.stringify(roleMutator([], request)) };
        const role = scope === FOUNDry_ACCOUNT_ID
          ? "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"
          : undefined;
        if (role === undefined) return { status: 0, stdout: JSON.stringify(roleMutator([], request)) };
        return {
          status: 0,
          stdout: JSON.stringify(roleMutator([{
            id: `${scope}/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000020`,
            principalId: RUNTIME_PRINCIPAL,
            principalType: "ServicePrincipal",
            roleDefinitionId: `/subscriptions/${SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/${role}`,
            scope,
          }], request)),
        };
      }
      if (request.argv[0] === "keyvault") return { status: 0, stdout: JSON.stringify([]) };
    }
    if (request.command === "/home/dev/.local/bin/terraform-1.15.8") {
      if (request.argv[0] === "state") {
        return { status: 0, stdout: JSON.stringify({ lineage, serial }) };
      }
      if (request.argv[0] === "workspace") return { status: 0, stdout: "default\n" };
      if (request.argv[0] === "output") {
        return {
          status: 0,
          stdout: JSON.stringify({
            resource_group_name: { value: "rg-runtime" },
            region: { value: "eastus2" },
            foundry_account_id: {
              value: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.CognitiveServices/accounts/foundry-test`,
            },
            foundry_endpoint: { value: FOUNDRY_ENDPOINT },
            relay_container_app_name: { value: "relay-test" },
            relay_container_app_id: { value: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.App/containerApps/relay-test` },
            relay_latest_revision_name: { value: revision },
            key_vault_name: { value: "kv-test" },
            key_vault_id: { value: KEY_VAULT_ID },
            key_vault_uri: { value: KEY_VAULT_URI },
            runtime_identity_id: { value: RUNTIME_ID },
            runtime_identity_client_id: { value: RUNTIME_CLIENT },
            image_pull_identity_id: { value: IMAGE_PULL_ID },
          }),
        };
      }
      if (request.argv[0] === "plan") {
        const planPath = request.argv.find((arg) => arg.startsWith("-out=")).slice(5);
        writeExclusive(planPath, PLAN_BYTES);
        return { status: 0, stdout: "" };
      }
      if (request.argv[0] === "show") return { status: 0, stdout: JSON.stringify({ format_version: "1.2" }) };
      if (request.argv[0] === "apply") {
        if (applyStatus === "throw") throw new Error("runner failure");
        if (applyStatus === "success" && request.phase === "runtime-cutover") topology = "post";
        return { status: applyStatus === "success" ? 0 : applyStatus === "failure" ? 1 : null, stdout: "" };
      }
    }
    if (request.command.endsWith("assert-dev-plan.mjs")) return { status: 0, stdout: "" };
    return { status: 0, stdout: "" };
  };
  const baseOptions = {
    root,
    closure,
    repoRoot,
    workdir,
    inheritedEnvironment: {},
    lowLevel: {
      processRunner: run,
      privateHttpGet(request) {
        httpCalls.push(request);
        if (request.url.includes("/secrets?")) {
          return httpMutator({ statusCode: 200, body: JSON.stringify({ value: [], nextLink: null }) });
        }
        return httpMutator({
          statusCode: 404,
          body: JSON.stringify({ error: { code: "SecretNotFound", message: "secret absent" } }),
        });
      },
      clock: { now: () => tick },
    },
  };
  const options = {
    ...baseOptions,
    ...overrides,
    lowLevel: { ...baseOptions.lowLevel, ...(overrides.lowLevel ?? {}) },
  };
  const lifecycle = createLifecycleForTests(options);
  return {
    lifecycle,
    options,
    root,
    workdir,
    backendConfigPath,
    calls,
    setSerial(value) { serial = value; },
    setLineage(value) { lineage = value; },
    setRevision(value) { revision = value; },
    setTopology(value) { topology = value; },
    setLiveAppMutator(value) { liveAppMutator = value; },
    setLiveRevisionMutator(value) { liveRevisionMutator = value; },
    setRoleMutator(value) { roleMutator = value; },
    setHttpMutator(value) { httpMutator = value; },
    setApplyStatus(value) { applyStatus = value; },
    setModelCase(value) { modelCase = value; },
    advance(ms) { tick += ms; },
    paths(runId) { return lifecycle.paths(runId); },
    httpCalls,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(`${root}.kernel.lock`, { force: true });
      rmSync(workdir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

function productionHarness(overrides = {}) {
  return makeHarness({
    ...overrides,
    lowLevel: {
      ...(overrides.lowLevel ?? {}),
      testAdapterProfile: "production",
    },
  });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

function assertNoInvalidatedAfterApplying(harness, runId) {
  const state = harness.lifecycle.readState();
  const run = state.runs.find((candidate) => candidate.id === runId);
  assert.ok(run);
  assert.notEqual(run.status, "invalidated");
  const checkpointFiles = readdirSync(path.join(harness.root, runId))
    .filter((entry) => /^\d{6}-[a-z0-9-]+\.json$/.test(entry));
  for (const entry of checkpointFiles) {
    const checkpoint = JSON.parse(readFileSync(path.join(harness.root, runId, entry), "utf8"));
    assert.notEqual(checkpoint.name, "invalidated");
    assert.notEqual(checkpoint.status, "invalidated");
  }
  if (existsSync(harness.paths(runId).apply)) {
    const receipt = JSON.parse(readFileSync(harness.paths(runId).apply, "utf8"));
    assert.notEqual(receipt.status, "invalidated");
  }
  return { state, run };
}

function replaceExisting(filePath, value) {
  rmSync(filePath, { force: true });
  writeExclusive(filePath, value);
}

function appendStateSnapshot(harness, state) {
  const previousPath = path.join(
    harness.root,
    `state-${String(state.stateSerial).padStart(12, "0")}.json`,
  );
  const next = {
    ...state,
    stateSerial: state.stateSerial + 1,
    sequence: state.stateSerial + 1,
    previousSnapshotSha256: sha256Bytes(readFileSync(previousPath)),
  };
  delete next.stateSha256;
  next.stateSha256 = sha256Bytes(canonicalJson(next));
  writeExclusive(
    path.join(harness.root, `state-${String(next.stateSerial).padStart(12, "0")}.json`),
    next,
  );
  replaceExisting(path.join(harness.root, "state.json"), next);
}

function seedAppliedPhase(harness, phase, runId, sourceState, targetState) {
  const runDirectory = path.join(harness.root, runId);
  mkdirSync(runDirectory, { mode: 0o700 });
  const createdAt = new Date().toISOString();
  const planText = canonicalJson(PLAN_BYTES);
  const planSha256 = sha256Bytes(planText);
  const bindings = { repositoryCommit: COMMIT };
  const manifest = {
    version: 1,
    runId,
    phase,
    createdAt,
    processExit: 0,
    planSha256,
    argv: [],
    bindings,
    bindingSha256: sha256Bytes(canonicalJson(bindings)),
  };
  writeExclusive(path.join(runDirectory, "plan.tfplan"), planText);
  writeExclusive(path.join(runDirectory, "create-manifest.json"), manifest);
  const guard = {
    version: 1,
    type: "guard",
    runId,
    phase,
    planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt,
    guard: GUARD_MAPPINGS[phase],
    showSha256: SHA,
    guardArgv: [`--mode=${GUARD_MAPPINGS[phase]}`],
    stdinSha256: SHA,
    result: "passed",
  };
  const preflight = {
    version: 1,
    type: "preflight",
    runId,
    phase,
    planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt,
    result: "passed",
    verifierSha256: SHA,
  };
  const apply = {
    version: 1,
    type: "apply",
    runId,
    phase,
    planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt,
    status: "applied",
    appliedAt: createdAt,
  };
  writeExclusive(path.join(runDirectory, "guard-receipt.json.consumed"), guard);
  writeExclusive(path.join(runDirectory, "preflight-receipt.json.consumed"), preflight);
  writeExclusive(path.join(runDirectory, "apply-receipt.json"), apply);
  if (phase === "runtime-cutover") writeRuntimeDiagnostic(harness, runId);
  if (phase === "credential-cleanup") writeCleanupArtifacts(harness, runId);
  const checkpointNames = [
    "run-directory",
    "plan-started",
    "temp-plan",
    "published-plan",
    "terraform-exit-known",
    "manifest",
    "show-json",
    "guard-receipt",
    "preflight-receipt",
    "applying",
    "receipts-consumed",
    "terraform-exit-ambiguous",
    "apply-receipt",
    "global-state-advancement",
  ];
  for (const [index, name] of checkpointNames.entries()) {
    const details = name === "guard-receipt"
      ? { receiptSha256: sha256Bytes(canonicalJson(guard)) }
      : name === "preflight-receipt"
        ? {
            receiptSha256: sha256Bytes(canonicalJson(preflight)),
            ...(manifest.phase === "runtime-cutover"
              ? { diagnosticReceiptSha256: sha256Bytes(readFileSync(harness.paths(runId).diagnostic)) }
              : manifest.phase === "credential-cleanup"
                ? {
                    cleanupManifestSha256: sha256Bytes(readFileSync(harness.paths(runId).cleanup)),
                    absenceReceiptSha256: sha256Bytes(readFileSync(harness.paths(runId).absence)),
                  }
                : {}),
          }
        : name === "receipts-consumed"
          ? {
              guardReceiptSha256: sha256Bytes(canonicalJson(guard)),
              preflightReceiptSha256: sha256Bytes(canonicalJson(preflight)),
            }
          : name === "published-plan"
            ? { planSha256 }
            : name === "manifest"
              ? { manifestSha256: sha256Bytes(canonicalJson(manifest)), planSha256 }
              : name === "apply-receipt"
                ? { receiptSha256: sha256Bytes(canonicalJson(apply)), status: "applied" }
                : name === "global-state-advancement"
                  ? {
                      from: sourceState,
                      to: targetState,
                      applyReceiptSha256: sha256Bytes(canonicalJson(apply)),
                    }
                  : {};
    writeExclusive(path.join(runDirectory, `${String(index + 1).padStart(6, "0")}-${name}.json`), {
      version: 1,
      type: "lifecycle-checkpoint",
      sequence: index + 1,
      name,
      runId,
      phase,
      createdAt: new Date().toISOString(),
      ...details,
      ...(name === "global-state-advancement"
        ? { from: sourceState, to: targetState }
        : {}),
    });
  }
  const statePath = path.join(harness.root, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.state = targetState;
  state.runs.push({
    id: runId,
    phase,
    status: "applied",
    createdAt: new Date().toISOString(),
  });
  appendStateSnapshot(harness, state);
}

function forceUnknownRun(harness, runId) {
  const statePath = path.join(harness.root, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const run = state.runs.find((candidate) => candidate.id === runId);
  assert.ok(run);
  const manifest = JSON.parse(readFileSync(harness.paths(runId).manifest, "utf8"));
  const checkpointNames = [
    "show-json",
    "guard-receipt",
    "preflight-receipt",
    "applying",
    "receipts-consumed",
    "terraform-exit-ambiguous",
  ];
  const guard = {
    version: 1,
    type: "guard",
    runId,
    phase: manifest.phase,
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt: manifest.createdAt,
    guard: GUARD_MAPPINGS[manifest.phase],
    showSha256: SHA,
    guardArgv: [`--mode=${GUARD_MAPPINGS[manifest.phase]}`],
    stdinSha256: SHA,
    result: "passed",
  };
  const preflight = {
    version: 1,
    type: "preflight",
    runId,
    phase: manifest.phase,
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt: manifest.createdAt,
    result: "passed",
    verifierSha256: SHA,
  };
  writeExclusive(`${harness.paths(runId).guard}.consumed`, guard);
  writeExclusive(`${harness.paths(runId).preflight}.consumed`, preflight);
  for (const [index, name] of checkpointNames.entries()) {
    const details = name === "guard-receipt"
      ? { receiptSha256: sha256Bytes(canonicalJson(guard)) }
      : name === "preflight-receipt"
        ? {
            receiptSha256: sha256Bytes(canonicalJson(preflight)),
            ...(manifest.phase === "runtime-cutover"
              ? { diagnosticReceiptSha256: sha256Bytes(readFileSync(harness.paths(runId).diagnostic)) }
              : manifest.phase === "credential-cleanup"
                ? {
                    cleanupManifestSha256: sha256Bytes(readFileSync(harness.paths(runId).cleanup)),
                    absenceReceiptSha256: sha256Bytes(readFileSync(harness.paths(runId).absence)),
                  }
                : {}),
          }
        : name === "receipts-consumed"
          ? {
              guardReceiptSha256: sha256Bytes(canonicalJson(guard)),
              preflightReceiptSha256: sha256Bytes(canonicalJson(preflight)),
            }
          : {};
    writeExclusive(
      path.join(harness.root, runId, `${String(index + 7).padStart(6, "0")}-${name}.json`),
      {
        version: 1,
        type: "lifecycle-checkpoint",
        sequence: index + 7,
        name,
        runId,
        phase: manifest.phase,
        createdAt: manifest.createdAt,
        ...details,
      },
    );
  }
  const apply = {
    version: 1,
    type: "apply",
    runId,
    phase: manifest.phase,
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt: manifest.createdAt,
    status: "unknown",
    appliedAt: manifest.createdAt,
  };
  writeExclusive(harness.paths(runId).apply, apply);
  writeExclusive(
    path.join(harness.root, runId, "000013-apply-receipt.json"),
    {
      version: 1,
      type: "lifecycle-checkpoint",
      sequence: 13,
      name: "apply-receipt",
      runId,
      phase: manifest.phase,
      createdAt: manifest.createdAt,
      receiptSha256: sha256Bytes(canonicalJson(apply)),
    },
  );
  run.status = "unknown";
  appendStateSnapshot(harness, state);
}

function waitForPath(filePath, timeoutMs = 1500) {
  if (existsSync(filePath)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const directory = path.dirname(filePath);
    const target = path.basename(filePath);
    let watcher;
    const timer = setTimeout(() => {
      watcher?.close();
      reject(new Error(`timed out waiting for ${filePath}`));
    }, timeoutMs);
    watcher = watch(directory, { persistent: false }, (_event, name) => {
      if (String(name) !== target || !existsSync(filePath)) return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    });
  });
}

function waitForKernelRelease(lockPath, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const probe = spawn("/usr/bin/flock", [lockPath, "/usr/bin/true"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      probe.kill("SIGKILL");
      reject(new Error(`kernel lock remained held: ${lockPath}`));
    }, timeoutMs);
    probe.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    probe.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`kernel lock probe failed: ${code}`));
    });
  });
}

async function inheritedLockProbe(label) {
  const root = mkdtempSync(path.join(tmpdir(), `palancar-b1b-${label}-`));
  chmodSync(root, 0o700);
  const lockPath = path.join(root, "lifecycle.kernel.lock");
  const readyPath = path.join(root, "ready");
  const donePath = path.join(root, "done");
  const releasePath = path.join(root, "release");
  const protectedCode = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
    `const watcher = fs.watch(${JSON.stringify(root)}, (_event, name) => { if (String(name) === 'release') { watcher.close(); fs.writeFileSync(${JSON.stringify(donePath)}, 'done'); } });`,
  ].join("\n");
  const outerCode = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const lockFd = fs.readdirSync('/proc/' + process.pid + '/fd').map(Number).find((fd) => { try { return fs.readlinkSync('/proc/' + process.pid + '/fd/' + fd).endsWith('.kernel.lock'); } catch { return false; } });",
    "const stdio = ['ignore', 'ignore', 'ignore'];",
    "while (stdio.length <= lockFd) stdio.push('ignore');",
    "stdio[lockFd] = lockFd;",
    `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(protectedCode)}], { stdio });`,
    "child.unref();",
  ].join("\n");
  const outer = spawn(
    "/usr/bin/flock",
    ["-n", lockPath, process.execPath, "-e", outerCode],
    { stdio: "ignore" },
  );
  try {
    await waitForPath(readyPath);
    outer.kill("SIGKILL");
    const blocked = spawnSync("/usr/bin/flock", ["-n", lockPath, "/usr/bin/true"], {
      stdio: "ignore",
    });
    assert.notEqual(blocked.status, 0, `${label} descendant did not retain the lock`);
    writeExclusive(releasePath, "release");
    await waitForPath(donePath);
    await waitForKernelRelease(lockPath);
  } finally {
    try { outer.kill("SIGKILL"); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

function initialize(harness) {
  assert.deepEqual(harness.lifecycle.init(), { state: "manual-Luna-absent" });
}

function writeRuntimeDiagnostic(harness, runId) {
  const manifest = JSON.parse(readFileSync(harness.paths(runId).manifest, "utf8"));
  writeExclusive(harness.paths(runId).diagnostic, protectedReceipt({
    version: 2,
    type: "diagnostic",
    status: "passed",
    operation: "runtime-cutover-diagnostic",
    runId,
    phase: manifest.phase,
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt: manifest.createdAt,
    repositoryCommit: manifest.bindings.repositoryCommit,
    contextSha256: manifest.bindingSha256,
    imageDigest: RELAY_IMAGE,
    digestCount: 1,
    execution: { baseline: "pre-cutover", result: "passed", retryCount: 0 },
    runtimeSecretReferences: [],
  }));
}

function writeCleanupArtifacts(harness, runId) {
  const manifest = JSON.parse(readFileSync(harness.paths(runId).manifest, "utf8"));
  writeExclusive(harness.paths(runId).cleanup, protectedReceipt({
    version: 2,
    type: "cleanup",
    status: "completed",
    operation: "credential-cleanup",
    runId,
    phase: manifest.phase,
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt: manifest.createdAt,
    repositoryCommit: manifest.bindings.repositoryCommit,
    contextSha256: manifest.bindingSha256,
    runtimeSecretReferences: [],
  }));
  writeExclusive(harness.paths(runId).absence, protectedReceipt({
    version: 2,
    type: "absence",
    status: "absent",
    operation: "credential-cleanup",
    runId,
    phase: manifest.phase,
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt: manifest.createdAt,
    repositoryCommit: manifest.bindings.repositoryCommit,
    contextSha256: manifest.bindingSha256,
    inventory: { keyVault: "absent", runtimeSecretReferences: 0 },
  }));
}

function writeTerminalArtifacts(harness, runId) {
  const manifest = JSON.parse(readFileSync(harness.paths(runId).manifest, "utf8"));
  for (const [type, filename] of [
    ["diagnostic", "diagnostic-receipt.json"],
    ["cleanup", "cleanup-manifest.json"],
    ["absence", "cleanup-absence-receipt.json"],
    ["live", "terminal-live-receipt.json"],
  ]) {
    const receipt = {
      version: 2,
      type,
      runId,
      phase: manifest.phase,
      planSha256: manifest.planSha256,
      bindingSha256: manifest.bindingSha256,
      createdAt: manifest.createdAt,
      repositoryCommit: manifest.bindings.repositoryCommit,
      contextSha256: manifest.bindingSha256,
      status: type === "diagnostic" || type === "live" ? "passed" : type === "cleanup" ? "completed" : "absent",
      ...(type === "diagnostic"
        ? {
            operation: "runtime-cutover-diagnostic",
            imageDigest: RELAY_IMAGE,
            digestCount: 1,
            execution: { baseline: "pre-cutover", result: "passed", retryCount: 0 },
            runtimeSecretReferences: [],
          }
        : {}),
      ...(type === "cleanup"
        ? { operation: "credential-cleanup", runtimeSecretReferences: [] }
        : {}),
      ...(type === "absence"
        ? { operation: "credential-cleanup", inventory: { keyVault: "absent", runtimeSecretReferences: 0 } }
        : {}),
      ...(type === "live" ? { operation: "terminal-live" } : {}),
    };
    writeExclusive(path.join(harness.root, runId, filename), protectedReceipt(receipt));
  }
}

function guardPreflight(harness, phase) {
  const created = harness.lifecycle.create(phase);
  harness.lifecycle.guard(phase, created.runId);
  if (phase === "runtime-cutover") writeRuntimeDiagnostic(harness, created.runId);
  if (phase === "credential-cleanup") writeCleanupArtifacts(harness, created.runId);
  if (phase !== "terminal") harness.lifecycle.preflight(phase, created.runId);
  return created.runId;
}

function advanceThrough(harness, phase) {
  const runId = guardPreflight(harness, phase);
  if (phase !== "terminal") {
    harness.lifecycle.apply(phase, runId);
    if (phase === "runtime-cutover") harness.setTopology("post");
  }
  return runId;
}

function prepareRuntime(harness) {
  initialize(harness);
  advanceThrough(harness, "model-bootstrap");
  const runtime = harness.lifecycle.create("runtime-cutover");
  harness.lifecycle.guard("runtime-cutover", runtime.runId);
  writeRuntimeDiagnostic(harness, runtime.runId);
  return runtime.runId;
}

function prepareTerminal(harness) {
  initialize(harness);
  advanceThrough(harness, "model-bootstrap");
  advanceThrough(harness, "runtime-cutover");
  advanceThrough(harness, "credential-cleanup");
  const terminal = harness.lifecycle.create("terminal");
  harness.lifecycle.guard("terminal", terminal.runId);
  writeTerminalArtifacts(harness, terminal.runId);
  return terminal.runId;
}

function prepareTerminalFromSeed(harness) {
  initialize(harness);
  seedAppliedPhase(harness, "model-bootstrap", "seed-model", "manual-Luna-absent", "model-applied");
  seedAppliedPhase(harness, "runtime-cutover", "seed-runtime", "model-applied", "runtime-applied");
  harness.setTopology("post");
  seedAppliedPhase(harness, "credential-cleanup", "seed-credential", "runtime-applied", "credentials-and-RBAC-cleaned");
  const terminal = harness.lifecycle.create("terminal");
  harness.lifecycle.guard("terminal", terminal.runId);
  writeTerminalArtifacts(harness, terminal.runId);
  return terminal.runId;
}

function prepareCredential(harness) {
  initialize(harness);
  advanceThrough(harness, "model-bootstrap");
  advanceThrough(harness, "runtime-cutover");
  const cleanup = harness.lifecycle.create("credential-cleanup");
  harness.lifecycle.guard("credential-cleanup", cleanup.runId);
  writeCleanupArtifacts(harness, cleanup.runId);
  return cleanup.runId;
}

function prepareRuntimeReconcile(harness) {
  initialize(harness);
  seedAppliedPhase(harness, "model-bootstrap", "seed-model", "manual-Luna-absent", "model-applied");
  const runtime = harness.lifecycle.create("runtime-cutover");
  writeRuntimeDiagnostic(harness, runtime.runId);
  forceUnknownRun(harness, runtime.runId);
  return runtime.runId;
}

function prepareCredentialReconcile(harness) {
  initialize(harness);
  seedAppliedPhase(harness, "model-bootstrap", "seed-model", "manual-Luna-absent", "model-applied");
  seedAppliedPhase(harness, "runtime-cutover", "seed-runtime", "model-applied", "runtime-applied");
  harness.setTopology("post");
  const cleanup = harness.lifecycle.create("credential-cleanup");
  writeCleanupArtifacts(harness, cleanup.runId);
  forceUnknownRun(harness, cleanup.runId);
  return cleanup.runId;
}

function replaceProtectedReceipt(filePath, mutate) {
  const receipt = JSON.parse(readFileSync(filePath, "utf8"));
  delete receipt.sha256;
  mutate(receipt);
  replaceExisting(filePath, protectedReceipt(receipt));
}

function mutatePreTopology(value, mutate) {
  const next = structuredClone(value);
  mutate(next.properties.template.containers);
  return next;
}

function vaultSecretEntry(name, idName = name) {
  return {
    id: `${KEY_VAULT_URI}/secrets/${idName}`,
    name,
    attributes: { enabled: true },
    contentType: null,
    tags: null,
    managed: false,
  };
}

function artifactText(directory) {
  let text = "";
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) text += artifactText(filePath);
    else if (entry.isFile()) text += readFileSync(filePath, "utf8");
  }
  return text;
}

function assertSensitiveValuesClosed(harness, error = undefined) {
  const processEvidence = JSON.stringify(harness.calls);
  const artifacts = artifactText(harness.root);
  for (const value of [KEY_VAULT_ID, KEY_VAULT_URI, "protected-test-token-value-1234567890"]) {
    assert.equal(processEvidence.includes(value), false);
    assert.equal(artifacts.includes(value), false);
    assert.equal(String(error?.message ?? error?.code ?? "").includes(value), false);
  }
}

test("A3 exact runtime predecessor and diagnostic receipt contracts are fail-closed", () => {
  const happy = makeHarness();
  try {
    const runId = prepareRuntime(happy);
    assert.deepEqual(happy.lifecycle.preflight("runtime-cutover", runId), {
      runId,
      phase: "runtime-cutover",
      status: "preflighted",
    });
    const containerAppCall = happy.calls.find(
      (call) => call.command === "/usr/bin/az" && call.argv[0] === "containerapp" && call.argv[1] === "show",
    );
    const revisionCall = happy.calls.find(
      (call) => call.command === "/usr/bin/az" && call.argv[0] === "containerapp" && call.argv[1] === "revision",
    );
    assert.deepEqual(containerAppCall.argv.slice(0, 4), ["containerapp", "show", "--name", "relay-test"]);
    assert.deepEqual(revisionCall.argv.slice(0, 4), ["containerapp", "revision", "list", "--name"]);
  } finally {
    happy.cleanup();
  }

  const mutateBoth = (harness, mutate) => {
    harness.setLiveAppMutator(mutate);
    harness.setLiveRevisionMutator(mutate);
  };
  const topologyCases = [
    ["full image tag", (containers) => {
      containers.find((container) => container.name === "relay").image =
        "palancardevacraeeacd8c.azurecr.io/palancar-relay:latest";
    }, "runtime-topology"],
    ["wrong full image digest", (containers) => {
      containers.find((container) => container.name === "relay").image =
        "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:" + "0".repeat(64);
    }, "runtime-topology"],
    ["wrong LiteLLM backend", (containers) => {
      containers.find((container) => container.name === "litellm").env.find(
        (entry) => entry.name === "PALANCAR_LITELLM_BACKEND",
      ).value = "azure";
    }, "runtime-topology"],
    ["wrong OpenRouter model", (containers) => {
      containers.find((container) => container.name === "litellm").env.find(
        (entry) => entry.name === "PALANCAR_LITELLM_UPSTREAM_MODEL",
      ).value = "openrouter/openai/gpt-4o";
    }, "runtime-topology"],
  ];
  for (const [, mutate, code] of topologyCases) {
    const negative = makeHarness();
    try {
      const runId = prepareRuntime(negative);
      mutateBoth(negative, (value) => mutatePreTopology(value, mutate));
      expectCode(() => negative.lifecycle.preflight("runtime-cutover", runId), code);
    } finally {
      negative.cleanup();
    }
  }

  const revisionCases = [
    ["extra active revision", (value) => [
      value,
      {
        ...structuredClone(value),
        id: value.id.replace(/\/revisions\/[^/]+$/, "/revisions/retired-revision"),
        name: "retired-revision",
        properties: { ...value.properties, active: true, trafficWeight: 0 },
      },
    ], "runtime-revisions-active"],
    ["unhealthy revision", (value) => ({
      ...value,
      properties: { ...value.properties, healthState: "Unhealthy" },
    }), "runtime-revisions"],
    ["incorrect app traffic", (value) => {
      const next = structuredClone(value);
      next.properties.configuration.ingress.traffic[0].weight = 50;
      return next;
    }, "runtime-containerapp"],
  ];
  for (const [, mutate, code] of revisionCases) {
    const negative = makeHarness();
    try {
      const runId = prepareRuntime(negative);
      if (code === "runtime-containerapp") negative.setLiveAppMutator(mutate);
      else negative.setLiveRevisionMutator(mutate);
      expectCode(() => negative.lifecycle.preflight("runtime-cutover", runId), code);
    } finally {
      negative.cleanup();
    }
  }

  for (const [label, mutate, code] of [
    ["stale diagnostic", (receipt) => { receipt.createdAt = "2020-01-01T00:00:00.000Z"; }, "diagnostic-receipt-context"],
    ["mismatched diagnostic", (receipt) => { receipt.planSha256 = "b".repeat(64); }, "diagnostic-receipt-context"],
    ["replacement diagnostic", (receipt) => { receipt.imageDigest = RELAY_IMAGE.replace(/e9b7e2/, "000000"); }, "diagnostic-receipt-context"],
  ]) {
    void label;
    const negative = makeHarness();
    try {
      const runId = prepareRuntime(negative);
      replaceProtectedReceipt(negative.paths(runId).diagnostic, mutate);
      expectCode(() => negative.lifecycle.preflight("runtime-cutover", runId), code);
    } finally {
      negative.cleanup();
    }
  }
});

test("A3 exact credential Entra-only topology and cleanup receipts are fail-closed", () => {
  const happy = makeHarness();
  try {
    const runId = prepareCredential(happy);
    happy.setTopology("post");
    assert.deepEqual(happy.lifecycle.preflight("credential-cleanup", runId), {
      runId,
      phase: "credential-cleanup",
      status: "preflighted",
    });
    assert.equal(happy.httpCalls.length, 3);
    assert.match(happy.httpCalls[0].url, /\/secrets\?api-version=7\.4&maxresults=25$/);
    assert.deepEqual(happy.httpCalls.slice(1).map((call) => call.url), [
      `${KEY_VAULT_URI}/secrets/openrouter-api-key?api-version=7.4`,
      `${KEY_VAULT_URI}/secrets/litellm-master-key?api-version=7.4`,
    ]);
    assert.ok(happy.httpCalls.every((call) => call.headers.Authorization === "Bearer protected-test-token-value-1234567890"));
    assertSensitiveValuesClosed(happy);
  } finally {
    happy.cleanup();
  }

  const appCases = [
    ["sidecar/OpenRouter env", (value) => {
      value.properties.template.containers[0].env.push({ name: "OPENROUTER_API_KEY", value: "redacted" });
    }, "credential-topology", true],
    ["any secretRef", (value) => {
      value.properties.template.containers[0].env.push({ name: "UNEXPECTED_SECRET", secretRef: "retired-secret" });
    }, "credential-secret-reference", true],
    ["wrong endpoint", (value) => {
      value.properties.template.containers[0].env.find(
        (entry) => entry.name === "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT",
      ).value = "wss://wrong.openai.azure.com/openai/v1/realtime?intent=transcription";
    }, "credential-direct-azure", true],
    ["wrong deployment", (value) => {
      value.properties.template.containers[0].env.find(
        (entry) => entry.name === "PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT",
      ).value = "gpt-4o";
    }, "credential-direct-azure", true],
    ["wrong identity", (value) => {
      value.properties.configuration.identitySettings[1].identity = IMAGE_PULL_ID;
    }, "credential-containerapp", false],
  ];
  for (const [, mutate, code, both] of appCases) {
    const negative = makeHarness();
    try {
      const runId = prepareCredential(negative);
      negative.setTopology("post");
      negative.setLiveAppMutator((value) => {
        const next = structuredClone(value);
        mutate(next);
        return next;
      });
      if (both) {
        negative.setLiveRevisionMutator((value) => {
          const next = structuredClone(value);
          mutate(next);
          return next;
        });
      }
      expectCode(() => negative.lifecycle.preflight("credential-cleanup", runId), code);
      assertSensitiveValuesClosed(negative);
    } finally {
      negative.cleanup();
    }
  }

  {
    const negative = makeHarness();
    try {
      const runId = prepareCredential(negative);
      negative.setTopology("post");
      negative.setLiveRevisionMutator((value) => [value, structuredClone(value)]);
      expectCode(() => negative.lifecycle.preflight("credential-cleanup", runId), "credential-revisions-active");
    } finally {
      negative.cleanup();
    }
  }
  for (const [artifact, code] of [["cleanup", "cleanup-manifest-missing"], ["absence", "cleanup-absence-missing"]]) {
    const negative = makeHarness();
    try {
      const runId = prepareCredential(negative);
      negative.setTopology("post");
      rmSync(negative.paths(runId)[artifact]);
      expectCode(() => negative.lifecycle.preflight("credential-cleanup", runId), code);
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareCredential(negative);
      negative.setTopology("post");
      replaceProtectedReceipt(negative.paths(runId).cleanup, (receipt) => { receipt.status = "failed"; });
      expectCode(() => negative.lifecycle.preflight("credential-cleanup", runId), "cleanup-manifest-context");
    } finally {
      negative.cleanup();
    }
  }
});

test("A3 Key Vault direct data-plane absence, pagination, and secret evidence stay closed", () => {
  const happy = makeHarness();
  try {
    const runId = prepareCredential(happy);
    happy.setTopology("post");
    happy.lifecycle.preflight("credential-cleanup", runId);
    assert.deepEqual(happy.httpCalls.map((call) => call.method), ["GET", "GET", "GET"]);
    assertSensitiveValuesClosed(happy);
  } finally {
    happy.cleanup();
  }

  const cases = [
    ["retired secret", (value) => value.statusCode === 200
      ? { ...value, body: JSON.stringify({ value: [vaultSecretEntry("openrouter-api-key")], nextLink: null }) }
      : value, "keyvault-secret-present"],
    ["retired secret version", (value) => value.statusCode === 200
      ? { ...value, body: JSON.stringify({ value: [vaultSecretEntry("openrouter-api-key", "openrouter-api-key/retired-version")], nextLink: null }) }
      : value, "keyvault-secret-present"],
    ["nextLink", (value) => value.statusCode === 200
      ? { ...value, body: JSON.stringify({ value: [], nextLink: `${KEY_VAULT_URI}/secrets?api-version=7.4&page=2` }) }
      : value, "keyvault-secrets-pagination"],
    ["malformed list", (value) => value.statusCode === 200 ? { ...value, body: "{not-json" } : value, "keyvault-secrets-json"],
    ["error response", (value) => value.statusCode === 200 ? value : {
      ...value,
      statusCode: 500,
      body: JSON.stringify({ error: { code: "InternalError", message: "synthetic failure" } }),
    }, "keyvault-secret-present"],
  ];
  for (const [, mutate, code] of cases) {
    const negative = makeHarness();
    try {
      const runId = prepareCredential(negative);
      negative.setTopology("post");
      negative.setHttpMutator(mutate);
      let failure;
      try {
        negative.lifecycle.preflight("credential-cleanup", runId);
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.code, code);
      assertSensitiveValuesClosed(negative, failure);
    } finally {
      negative.cleanup();
    }
  }
});

test("A3 exact terminal inventory and deployment, RBAC, reference, and set-hash checks are fail-closed", () => {
  const happy = makeHarness();
  try {
    const runId = prepareTerminal(happy);
    const result = happy.lifecycle.finalize("terminal", runId);
    assert.deepEqual(result, {
      runId,
      phase: "terminal",
      status: "finalized",
      state: "terminal-verified",
    });
    const terminal = JSON.parse(readFileSync(happy.paths(runId).terminal, "utf8"));
    assert.equal(terminal.result, "verified");
    assert.match(terminal.receiptSetSha256, /^[a-f0-9]{64}$/);
    const inventory = [
      "cleanup-absence-receipt.json",
      "cleanup-manifest.json",
      "diagnostic-receipt.json",
      "terminal-live-receipt.json",
    ].map((label) => ({
      label,
      sha256: sha256Bytes(readFileSync(path.join(happy.root, runId, label))),
    }));
    assert.equal(terminal.receiptSetSha256, sha256Bytes(canonicalJson(inventory)));
    assert.deepEqual(happy.lifecycle.readState().state, "terminal-verified");
  } finally {
    happy.cleanup();
  }

  for (const [label, mutate, code] of [
    ["missing receipt", (harness, runId) => rmSync(path.join(harness.root, runId, "terminal-live-receipt.json")), "live-receipt-missing"],
    ["wrong-status receipt", (harness, runId) => replaceProtectedReceipt(path.join(harness.root, runId, "terminal-live-receipt.json"), (receipt) => { receipt.status = "failed"; }), "live-receipt-context"],
  ]) {
    void label;
    const negative = makeHarness();
    try {
      const runId = prepareTerminal(negative);
      mutate(negative, runId);
      expectCode(() => negative.lifecycle.finalize("terminal", runId), code);
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareTerminal(negative);
      negative.lifecycle.finalize("terminal", runId);
      replaceProtectedReceipt(path.join(negative.root, runId, "terminal-live-receipt.json"), (receipt) => { receipt.operation = "terminal-live-replaced"; });
      expectCode(() => negative.lifecycle.readState(), "terminal-receipt-set");
    } finally {
      negative.cleanup();
    }
  }

  {
    const retiredRole = {
      id: `${KEY_VAULT_ID}/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000021`,
      principalId: RUNTIME_PRINCIPAL,
      principalType: "ServicePrincipal",
      roleDefinitionId: `/subscriptions/${SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`,
      scope: KEY_VAULT_ID,
    };
    const negative = makeHarness();
    try {
      const runId = prepareTerminal(negative);
      negative.setRoleMutator((value, request) => request.argv.includes(KEY_VAULT_ID) ? [retiredRole] : value);
      expectCode(() => negative.lifecycle.finalize("terminal", runId), "terminal-runtime-rbac-present");
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareTerminal(negative);
      negative.setRoleMutator(() => []);
      expectCode(() => negative.lifecycle.finalize("terminal", runId), "terminal-openai-rbac-missing");
    } finally {
      negative.cleanup();
    }
  }
  for (const modelCase of ["luna-wrong-model", "transcription-wrong-model"]) {
    const negative = makeHarness();
    try {
      const runId = prepareTerminal(negative);
      negative.setModelCase(modelCase);
      expectCode(() => negative.lifecycle.finalize("terminal", runId), "terminal-deployment-contract");
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareTerminal(negative);
      const mutate = (value) => {
        const next = structuredClone(value);
        next.properties.template.containers[0].env.push({ name: "LITELLM_BACKEND", value: "openrouter" });
        return next;
      };
      negative.setLiveAppMutator(mutate);
      negative.setLiveRevisionMutator(mutate);
      expectCode(() => negative.lifecycle.finalize("terminal", runId), "credential-topology");
    } finally {
      negative.cleanup();
    }
  }
});

test("CLI and exact child environment remain closed", () => {
  assert.deepEqual(parseCli(["init"]), { operation: "init" });
  assert.deepEqual(parseCli(["create", "model-bootstrap"]), { operation: "create", phase: "model-bootstrap" });
  assert.deepEqual(parseCli(["guard", "terminal", "run_1"]), { operation: "guard", phase: "terminal", runId: "run_1" });
  assert.equal(parseCli(["apply", "terminal", "run_1"]), undefined);
  assert.deepEqual(Object.keys(GUARD_MAPPINGS), PHASES);
  const harness = makeHarness();
  try {
    mkdirSync(path.join(harness.root, "run"), { mode: 0o700 });
    assert.deepEqual(buildChildEnvironment(path.join(harness.root, "run"), {}), {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      AZURE_CONFIG_DIR: "/home/dev/.azure",
      XDG_CACHE_HOME: LIFECYCLE_CACHE_ROOT,
      CHECKPOINT_DISABLE: "1",
      TF_IN_AUTOMATION: "1",
      TF_CLI_CONFIG_FILE: path.join(harness.root, "run/tf-cli.tfrc"),
    });
    expectCode(() => buildChildEnvironment(path.join(harness.root, "run2"), { TF_UNKNOWN: "1" }), "contaminated-environment");
  } finally {
    harness.cleanup();
  }
});

test("lifecycle cache is dedicated, owner-only, canonical, and replacement-safe", () => {
  const harness = makeHarness();
  const target = mkdtempSync(path.join(tmpdir(), "palancar-lifecycle-cache-target-"));
  try {
    mkdirSync(path.join(harness.root, "cache-run"), { mode: 0o700 });
    buildChildEnvironment(path.join(harness.root, "cache-run"), {});
    assert.equal(statSync(LIFECYCLE_CACHE_ROOT).mode & 0o777, 0o700);
    const deviceId = path.join(LIFECYCLE_CACHE_ROOT, "Microsoft/DeveloperTools/deviceid");
    assert.equal(statSync(deviceId).mode & 0o777, 0o600);

    chmodSync(LIFECYCLE_CACHE_ROOT, 0o755);
    expectCode(
      () => buildChildEnvironment(path.join(harness.root, "cache-run"), {}),
      "lifecycle-cache-mode",
    );
    chmodSync(LIFECYCLE_CACHE_ROOT, 0o700);

    replaceExisting(deviceId, "not-a-device-id");
    expectCode(
      () => buildChildEnvironment(path.join(harness.root, "cache-run"), {}),
      "lifecycle-cache-device-id",
    );

    replaceExisting(deviceId, "x".repeat(1024 * 1024));
    expectCode(
      () => buildChildEnvironment(path.join(harness.root, "cache-run"), {}),
      "lifecycle-cache-device-id",
    );

    rmSync(LIFECYCLE_CACHE_ROOT, { recursive: true, force: true });
    symlinkSync(target, LIFECYCLE_CACHE_ROOT);
    expectCode(
      () => buildChildEnvironment(path.join(harness.root, "cache-run"), {}),
      "lifecycle-cache-symlink",
    );
  } finally {
    rmSync(LIFECYCLE_CACHE_ROOT, { recursive: true, force: true });
    buildChildEnvironment(path.join(harness.root, "cache-run"), {});
    rmSync(target, { recursive: true, force: true });
    harness.cleanup();
  }
});

test("backend config has exactly approved keys and a canonical calculated identity hash", () => {
  const text = [
    `subscription_id = "${SUBSCRIPTION}"`,
    `tenant_id = "${TENANT}"`,
    `resource_group_name = "${REAL_BACKEND.identity.resource_group_name}"`,
    `storage_account_name = "${REAL_BACKEND.identity.storage_account_name}"`,
    `container_name = "${REAL_BACKEND.identity.container_name}"`,
    `key = "${REAL_BACKEND.identity.key}"`,
    "use_azuread_auth = true",
    "use_cli = true",
  ].join("\n");
  const parsed = parseCanonicalBackendConfig(text);
  assert.equal(parsed.sha256, calculateBackendHash(parsed.identity));
  assert.equal(parsed.sha256, BACKEND_SHA256);
  expectCode(() => parseCanonicalBackendConfig(`${text}\nextra = true`), "backend-keys");
  expectCode(() => parseCanonicalBackendConfig(text.replace("use_cli = true", "use_cli = false")), "backend-context");
});

test("production wiring binds the real backend cache and exact protected identity", () => {
  const cachePath = path.join(REPO_ROOT, "infra/environments/dev/.terraform/terraform.tfstate");
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.equal(
    canonicalBackendIdentityJson(REAL_BACKEND.identity),
    `{"container_name":"${REAL_BACKEND.identity.container_name}","key":"${REAL_BACKEND.identity.key}","resource_group_name":"${REAL_BACKEND.identity.resource_group_name}","storage_account_name":"${REAL_BACKEND.identity.storage_account_name}","subscription_id":"${REAL_BACKEND.identity.subscription_id}","tenant_id":"${REAL_BACKEND.identity.tenant_id}","type":"azurerm","use_azuread_auth":true,"use_cli":true}\n`,
  );
  assert.equal(REAL_BACKEND.sha256, BACKEND_SHA256);
  assert.equal(
    parseTerraformStateCache(cache, REAL_BACKEND.identity, {
      cloud: "AzureCloud",
      subscription: REAL_BACKEND.identity.subscription_id,
      tenant: REAL_BACKEND.identity.tenant_id,
    }).type,
    "azurerm",
  );
  assert.equal(
    statSync(path.join(REPO_ROOT, "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json")).size,
    749575,
  );
});

test("reviewed fixture JSON is bounded at the fixed 8 MiB ceiling", () => {
  const harness = makeHarness();
  try {
    const fixture = path.join(
      harness.options.repoRoot,
      "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
    );
    replaceExisting(fixture, "x".repeat(8 * 1024 * 1024 + 1));
    expectCode(() => harness.lifecycle.init(), "reviewed-fixture-too-large");
  } finally {
    harness.cleanup();
  }
});

test("production composition uses exact Terraform/Azure argv and metadata-only model checks", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = guardPreflight(harness, "model-bootstrap");
    harness.lifecycle.apply("model-bootstrap", runId);
    const plan = harness.calls.find((call) => call.argv[0] === "plan");
    const apply = harness.calls.find((call) => call.argv[0] === "apply");
    assert.deepEqual(plan.argv, ["plan", "-refresh=true", "-input=false", "-lock=true", "-lock-timeout=5m", `-out=${harness.paths(runId).plan}`]);
    assert.deepEqual(apply.argv, ["apply", "-input=false", "-lock=true", "-lock-timeout=5m", harness.paths(runId).plan]);
    assert.equal(plan.command, "/home/dev/.local/bin/terraform-1.15.8");
    assert.equal(plan.timeoutMs, 120_000);
    assert.equal(apply.timeoutMs, 900_000);
    assert.equal(plan.maxOutputBytes, 8 * 1024 * 1024);
    assert.equal(plan.killSignal, "SIGKILL");
    const manifest = JSON.parse(readFileSync(harness.paths(runId).manifest, "utf8"));
    assert.equal(manifest.bindings.backendSha256, BACKEND_SHA256);
    assert.equal(harness.calls.some((call) => call.command === "/usr/bin/az" && call.argv.join(" ").includes("deployment list")), true);
    assert.equal(harness.calls.some((call) => call.argv[0] === "show"), true);
    assert.equal(harness.calls.filter((call) => call.argv[0] === "show").length, 1);
  } finally {
    harness.cleanup();
  }
});

test("catalog, quota, and transcription failures fail closed", () => {
  for (const [mutation, code] of [
    ["catalog-bad", "catalog-model"],
    ["quota-bad", "quota-unreleased"],
    ["transcription-missing", "transcription-missing"],
    ["luna-present", "luna-present"],
  ]) {
    const harness = makeHarness();
    try {
      harness.setModelCase(mutation);
      expectCode(() => harness.lifecycle.init(), code);
    } finally {
      harness.cleanup();
    }
  }
});

test("A2 exact deployment, catalog, quota, context, and error-shape checks fail closed", () => {
  for (const [mutation, code] of [
    ["transcription-nonterminal", "transcription-contract"],
    ["transcription-wrong-model", "transcription-contract"],
    ["transcription-wrong-version", "transcription-contract"],
    ["transcription-wrong-sku", "transcription-contract"],
    ["transcription-capacity-bad", "transcription-contract"],
    ["upgrade-bad", "transcription-contract"],
    ["deployment-duplicate", "deployment-duplicate"],
    ["deployment-spillover", "deployment-spillover"],
    ["deployment-malformed", "deployment-response"],
    ["deployment-unknown-shape", "deployment-response"],
    ["deployment-wrong-context", "deployment-context"],
    ["luna-show-present", "luna-present"],
    ["luna-query-error", "luna-deployment-query"],
    ["catalog-wrong-version", "catalog-model"],
    ["catalog-wrong-format", "catalog-model"],
    ["catalog-wrong-sku", "catalog-model"],
    ["catalog-wrong-kind", "catalog-model"],
    ["catalog-not-ga", "catalog-model"],
    ["catalog-duplicate", "catalog-duplicate"],
    ["catalog-wrong-region", "catalog-context"],
    ["catalog-malformed", "model-catalog"],
    ["catalog-unknown-shape", "model-catalog"],
    ["quota-unrelated-sufficient", "quota-unreleased"],
    ["quota-wrong-model", "quota-unreleased"],
    ["quota-bad", "quota-unreleased"],
    ["quota-duplicate", "quota-duplicate"],
    ["quota-unknown-unit", "model-quota"],
    ["quota-status-blocked", "model-quota"],
    ["quota-status-overage", "model-quota"],
    ["quota-status-unknown", "model-quota"],
    ["quota-total-only", "model-quota"],
    ["quota-current-only", "model-quota"],
    ["quota-malformed", "model-quota"],
    ["quota-unknown-shape", "model-quota"],
    ["account-wrong-region", "account-context"],
    ["account-malformed", "account-context"],
  ]) {
    const harness = makeHarness();
    try {
      harness.setModelCase(mutation);
      assert.throws(() => harness.lifecycle.init(), (error) => {
        if (error?.code !== code) throw new Error(`${mutation}: expected ${code}, got ${error?.code}`);
        return true;
      });
    } finally {
      harness.cleanup();
    }
  }
});

test("A2 init and model preflight repeat metadata-only checks and bind opaque receipts", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const initDeploymentLists = harness.calls.filter(
      (call) => call.command === "/usr/bin/az" && call.argv.slice(0, 4).join(" ") === "cognitiveservices account deployment list",
    ).length;
    const initCatalogs = harness.calls.filter(
      (call) => call.command === "/usr/bin/az" && call.argv.slice(0, 3).join(" ") === "cognitiveservices model list",
    ).length;
    const initQuotas = harness.calls.filter(
      (call) => call.command === "/usr/bin/az" && call.argv.slice(0, 3).join(" ") === "cognitiveservices usage list",
    ).length;
    const runId = guardPreflight(harness, "model-bootstrap");
    assert.equal(harness.calls.filter((call) => call.argv.slice(0, 4).join(" ") === "cognitiveservices account deployment list").length, initDeploymentLists + 1);
    assert.equal(harness.calls.filter((call) => call.argv.slice(0, 3).join(" ") === "cognitiveservices model list").length, initCatalogs + 1);
    assert.equal(harness.calls.filter((call) => call.argv.slice(0, 3).join(" ") === "cognitiveservices usage list").length, initQuotas + 1);
    assert.equal(harness.calls.some((call) => call.command === "/usr/bin/az" && call.argv.some((argument) => /inference|chat|completion/i.test(argument))), false);
    const receiptText = readFileSync(harness.paths(runId).preflight, "utf8");
    assert.equal(receiptText.includes("foundry-test"), false);
    assert.equal(receiptText.includes(SUBSCRIPTION), false);
  } finally {
    harness.cleanup();
  }
});

test("A2 production CLI errors remain content-safe", () => {
  const harness = makeHarness();
  try {
    harness.setModelCase("luna-query-error");
    const writes = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    let status;
    try {
      status = runCliForTests(["init"], harness.options);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(status, 1);
    assert.deepEqual(writes, ["dev-plan-lifecycle: rejected luna-deployment-query\n"]);
    assert.equal(writes.join("").includes("AuthorizationFailed"), false);
    assert.equal(writes.join("").includes(SUBSCRIPTION), false);
    assert.equal(writes.join("").includes("foundry-test"), false);
  } finally {
    harness.cleanup();
  }
});

test("backend context and current remote serial are revalidated before guard", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const created = harness.lifecycle.create("model-bootstrap");
    harness.setSerial(8);
    expectCode(() => harness.lifecycle.guard("model-bootstrap", created.runId), "binding-mismatch");
  } finally {
    harness.cleanup();
  }
});

test("backend substitution is rejected by the pinned canonical hash", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const created = harness.lifecycle.create("model-bootstrap");
    rmSync(harness.backendConfigPath);
    writeBackend(harness.backendConfigPath, "rg-substituted");
    expectCode(() => harness.lifecycle.guard("model-bootstrap", created.runId), "backend-hash");
  } finally {
    harness.cleanup();
  }
});

test("later production artifacts are required and missing artifacts fail closed", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const model = advanceThrough(harness, "model-bootstrap");
    assert.equal(typeof model, "string");
    const runtime = harness.lifecycle.create("runtime-cutover");
    harness.lifecycle.guard("runtime-cutover", runtime.runId);
    expectCode(() => harness.lifecycle.preflight("runtime-cutover", runtime.runId), "diagnostic-receipt-missing");
  } finally {
    harness.cleanup();
  }
});

test("reconcile performs read-only artifact/state checks and never replays apply", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    advanceThrough(harness, "model-bootstrap");
    const runtime = harness.lifecycle.create("runtime-cutover");
    harness.lifecycle.guard("runtime-cutover", runtime.runId);
    writeRuntimeDiagnostic(harness, runtime.runId);
    harness.lifecycle.preflight("runtime-cutover", runtime.runId);
    harness.setApplyStatus("ambiguous");
    expectCode(() => harness.lifecycle.apply("runtime-cutover", runtime.runId), "apply-unknown");
    const applyCalls = harness.calls.filter((call) => call.argv[0] === "apply").length;
    harness.setTopology("post");
    harness.setRevision("revision-after");
    harness.setSerial(8);
    assert.deepEqual(harness.lifecycle.reconcile("runtime-cutover", runtime.runId), {
      runId: runtime.runId,
      phase: "runtime-cutover",
      status: "applied",
      state: "runtime-applied",
    });
    assert.equal(harness.calls.filter((call) => call.argv[0] === "apply").length, applyCalls);
  } finally {
    harness.cleanup();
  }
});

test("B2a model serial increment post", { concurrency: true }, () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = harness.lifecycle.create("model-bootstrap").runId;
    forceUnknownRun(harness, runId);
    harness.setModelCase("luna-present");
    harness.setSerial(8);
    assert.deepEqual(harness.lifecycle.reconcile("model-bootstrap", runId), {
      runId,
      phase: "model-bootstrap",
      status: "applied",
      state: "model-applied",
    });
  } finally {
    harness.cleanup();
  }
});

test("B2a runtime serial increment post", { concurrency: true }, () => {
  const harness = makeHarness();
  try {
    const runId = prepareRuntimeReconcile(harness);
    harness.setTopology("post");
    harness.setRevision("revision-after");
    harness.setSerial(8);
    assert.deepEqual(harness.lifecycle.reconcile("runtime-cutover", runId), {
      runId,
      phase: "runtime-cutover",
      status: "applied",
      state: "runtime-applied",
    });
  } finally {
    harness.cleanup();
  }
});

test("B2a credential serial increment post", { concurrency: true }, () => {
  const harness = makeHarness();
  try {
    const runId = prepareCredentialReconcile(harness);
    harness.setSerial(8);
    assert.deepEqual(harness.lifecycle.reconcile("credential-cleanup", runId), {
      runId,
      phase: "credential-cleanup",
      status: "applied",
      state: "credentials-and-RBAC-cleaned",
    });
  } finally {
    harness.cleanup();
  }
});

test("B2a unchanged pre invalidates", { concurrency: true }, () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = harness.lifecycle.create("model-bootstrap").runId;
    forceUnknownRun(harness, runId);
    assert.deepEqual(harness.lifecycle.reconcile("model-bootstrap", runId), {
      runId,
      phase: "model-bootstrap",
      status: "invalidated",
    });
    assert.equal(JSON.parse(readFileSync(harness.paths(runId).reconcile, "utf8")).status, "invalidated");
  } finally {
    harness.cleanup();
  }
});

test("B2a mixed unknown", { concurrency: true }, () => {
  const harness = makeHarness();
  try {
    const runId = prepareRuntimeReconcile(harness);
    harness.setTopology("post");
    harness.setLiveRevisionMutator((value) => [value, structuredClone(value)]);
    expectCode(() => harness.lifecycle.reconcile("runtime-cutover", runId), "reconcile-unknown");
    assert.equal(JSON.parse(readFileSync(harness.paths(runId).reconcile, "utf8")).status, "unknown");
    assert.equal(harness.lifecycle.readState().runs.find((run) => run.id === runId).status, "unknown");
  } finally {
    harness.cleanup();
  }
});

test("B2a unknown reconcile recovery is state-snapshot idempotent", () => {
  const harness = makeHarness();
  try {
    const runId = prepareRuntimeReconcile(harness);
    harness.setTopology("post");
    harness.setLiveRevisionMutator((value) => [value, structuredClone(value)]);
    expectCode(() => harness.lifecycle.reconcile("runtime-cutover", runId), "reconcile-unknown");
    const before = harness.lifecycle.readState();
    const beforeSnapshots = readdirSync(harness.root).filter((entry) => /^state-\d{12}\.json$/.test(entry));
    const after = harness.lifecycle.readState();
    const afterSnapshots = readdirSync(harness.root).filter((entry) => /^state-\d{12}\.json$/.test(entry));
    assert.equal(after.stateSerial, before.stateSerial);
    assert.deepEqual(afterSnapshots, beforeSnapshots);
    assert.equal(after.runs.find((run) => run.id === runId).status, "unknown");
  } finally {
    harness.cleanup();
  }
});

test("B2a lineage mismatch rejects", { concurrency: true }, () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = harness.lifecycle.create("model-bootstrap").runId;
    forceUnknownRun(harness, runId);
    harness.setLineage("lineage-2");
    expectCode(() => harness.lifecycle.reconcile("model-bootstrap", runId), "binding-mismatch");
    assert.equal(harness.lifecycle.readState().runs.find((run) => run.id === runId).status, "unknown");
  } finally {
    harness.cleanup();
  }
});

test("B2a no apply argv", { concurrency: true }, () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = harness.lifecycle.create("model-bootstrap").runId;
    forceUnknownRun(harness, runId);
    const beforeReconcile = harness.calls.length;
    assert.deepEqual(harness.lifecycle.reconcile("model-bootstrap", runId), {
      runId,
      phase: "model-bootstrap",
      status: "invalidated",
    });
    assert.equal(harness.calls.slice(beforeReconcile).some((call) => call.argv[0] === "apply"), false);
    assert.equal(harness.calls.filter((call) => call.argv[0] === "apply").length, 0);
  } finally {
    harness.cleanup();
  }
});

test("B2a reconciliation serial and live shape must describe the same exact side", () => {
  for (const [serial, modelCase, code] of [
    [6, "luna-absent", "reconcile-state-serial"],
    [7, "luna-present", "reconcile-unknown"],
    [8, "luna-absent", "reconcile-unknown"],
  ]) {
    const harness = makeHarness();
    try {
      initialize(harness);
      const runId = harness.lifecycle.create("model-bootstrap").runId;
      forceUnknownRun(harness, runId);
      harness.setSerial(serial);
      harness.setModelCase(modelCase);
      expectCode(() => harness.lifecycle.reconcile("model-bootstrap", runId), code);
      assert.equal(
        harness.lifecycle.readState().runs.find((run) => run.id === runId).status,
        "unknown",
      );
    } finally {
      harness.cleanup();
    }
  }

  const advanced = makeHarness();
  try {
    initialize(advanced);
    const runId = advanced.lifecycle.create("model-bootstrap").runId;
    forceUnknownRun(advanced, runId);
    advanced.setSerial(12);
    advanced.setModelCase("luna-present");
    assert.equal(advanced.lifecycle.reconcile("model-bootstrap", runId).status, "applied");
  } finally {
    advanced.cleanup();
  }
});

test("B2b guard and preflight same-envelope replacement and fresh timestamp are rejected", { concurrency: true }, () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = guardPreflight(harness, "model-bootstrap");
    const guardPath = harness.paths(runId).guard;
    const guardText = readFileSync(guardPath, "utf8");
    const guard = JSON.parse(guardText);
    replaceExisting(guardPath, {
      ...guard,
      showSha256: "b".repeat(64),
      stdinSha256: "b".repeat(64),
    });
    expectCode(() => harness.lifecycle.apply("model-bootstrap", runId), "guard-receipt-hash");
    replaceExisting(guardPath, guardText);
    const preflightPath = harness.paths(runId).preflight;
    const preflight = JSON.parse(readFileSync(preflightPath, "utf8"));
    replaceExisting(preflightPath, {
      ...preflight,
      createdAt: new Date(Date.parse(preflight.createdAt) + 1000).toISOString(),
    });
    expectCode(() => harness.lifecycle.apply("model-bootstrap", runId), "preflight-receipt-hash");
  } finally {
    harness.cleanup();
  }
});

test("B2b recovery rejects apply and reconcile artifact replacement without advance", { concurrency: true }, () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = harness.lifecycle.create("model-bootstrap").runId;
    forceUnknownRun(harness, runId);
    const applyPath = harness.paths(runId).apply;
    const apply = JSON.parse(readFileSync(applyPath, "utf8"));
    replaceExisting(applyPath, { ...apply, appliedAt: new Date(Date.parse(apply.appliedAt) + 1000).toISOString() });
    assert.equal(harness.lifecycle.readState().runs.find((run) => run.id === runId).status, "unknown");
    expectCode(() => harness.lifecycle.reconcile("model-bootstrap", runId), "apply-mismatch");
    assert.equal(harness.lifecycle.readState().runs.find((run) => run.id === runId).status, "unknown");
  } finally {
    harness.cleanup();
  }

  const reconcileHarness = makeHarness();
  try {
    initialize(reconcileHarness);
    const reconcileRun = reconcileHarness.lifecycle.create("model-bootstrap").runId;
    forceUnknownRun(reconcileHarness, reconcileRun);
    reconcileHarness.setModelCase("luna-present");
    reconcileHarness.setSerial(8);
    reconcileHarness.lifecycle.reconcile("model-bootstrap", reconcileRun);
    const reconcilePath = reconcileHarness.paths(reconcileRun).reconcile;
    const reconcile = JSON.parse(readFileSync(reconcilePath, "utf8"));
    replaceExisting(reconcilePath, { ...reconcile, reconciledAt: new Date(Date.parse(reconcile.reconciledAt) + 1000).toISOString() });
    expectCode(() => reconcileHarness.lifecycle.readState(), "reconcile-receipt-hash");
  } finally {
    reconcileHarness.cleanup();
  }
});

test("B2b terminal receipt set and terminal receipt hash replacements are rejected", { concurrency: true }, () => {
  const harness = makeHarness();
  try {
    const runId = prepareTerminalFromSeed(harness);
    harness.lifecycle.finalize("terminal", runId);
    const livePath = path.join(harness.root, runId, "terminal-live-receipt.json");
    const liveText = readFileSync(livePath, "utf8");
    replaceExisting(livePath, `${liveText}\n`);
    expectCode(() => harness.lifecycle.readState(), "terminal-receipt-set");
    replaceExisting(livePath, liveText);
    assert.equal(harness.lifecycle.readState().state, "terminal-verified");

    const terminalPath = harness.paths(runId).terminal;
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    replaceExisting(terminalPath, {
      ...terminal,
      createdAt: new Date(Date.parse(terminal.createdAt) + 1000).toISOString(),
    });
    expectCode(() => harness.lifecycle.readState(), "terminal-receipt-hash");
  } finally {
    harness.cleanup();
  }
});

test("B2b global state snapshot hash-chain tamper and reorder stay closed", { concurrency: true }, () => {
  const tamperHarness = makeHarness();
  try {
    initialize(tamperHarness);
    const statePath = path.join(tamperHarness.root, "state-000000000000.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    replaceExisting(statePath, { ...state, state: "model-applied" });
    expectCode(() => tamperHarness.lifecycle.readState(), "state-history");
  } finally {
    tamperHarness.cleanup();
  }

  const reorderHarness = makeHarness();
  try {
    initialize(reorderHarness);
    const created = reorderHarness.lifecycle.create("model-bootstrap");
    reorderHarness.lifecycle.guard("model-bootstrap", created.runId);
    const earlierPath = path.join(reorderHarness.root, "state-000000000001.json");
    const laterPath = path.join(reorderHarness.root, "state-000000000002.json");
    replaceExisting(earlierPath, JSON.parse(readFileSync(laterPath, "utf8")));
    expectCode(() => reorderHarness.lifecycle.readState(), "state-snapshot-serial");
  } finally {
    reorderHarness.cleanup();
  }
});

test("B2b expired terminal finalization durably invalidates and permits replacement create", { concurrency: true }, () => {
  const harness = makeHarness();
  try {
    const expired = prepareTerminalFromSeed(harness);
    harness.advance(30 * 60 * 1000 + 1);
    expectCode(() => harness.lifecycle.finalize("terminal", expired), "plan-expired");
    const state = harness.lifecycle.readState();
    const run = state.runs.find((candidate) => candidate.id === expired);
    assert.equal(run.status, "invalidated");
    assert.equal(run.reason, "expired");
    const replacement = harness.lifecycle.create("terminal");
    assert.equal(replacement.phase, "terminal");
    assert.notEqual(replacement.runId, expired);
  } finally {
    harness.cleanup();
  }
});

test("freshness starts before plan execution and stale work is invalidated", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const created = harness.lifecycle.create("model-bootstrap");
    harness.advance(15 * 60 * 1000 + 1);
    expectCode(() => harness.lifecycle.guard("model-bootstrap", created.runId), "plan-expired");
  } finally {
    harness.cleanup();
  }
});

test("phase progression, cleanup evidence, and terminal receipts remain ordered", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    advanceThrough(harness, "model-bootstrap");
    advanceThrough(harness, "runtime-cutover");
    advanceThrough(harness, "credential-cleanup");
    const terminal = harness.lifecycle.create("terminal");
    harness.lifecycle.guard("terminal", terminal.runId);
    writeTerminalArtifacts(harness, terminal.runId);
    assert.deepEqual(harness.lifecycle.finalize("terminal", terminal.runId), {
      runId: terminal.runId,
      phase: "terminal",
      status: "finalized",
      state: "terminal-verified",
    });
    expectCode(() => harness.lifecycle.apply("terminal", terminal.runId), "terminal-apply");
  } finally {
    harness.cleanup();
  }

  for (const [label, mutate, code] of [
    ["predecessor-image", (value) => {
      const next = structuredClone(value);
      next.properties.template.containers[0].image = "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      return next;
    }, "runtime-revisions-template"],
    ["predecessor-traffic", (value) => {
      const next = structuredClone(value);
      next.properties.configuration.ingress.traffic[0].weight = 99;
      return next;
    }, "runtime-containerapp"],
  ]) {
    void label;
    const negative = makeHarness();
    try {
      const runId = prepareRuntime(negative);
      negative.setLiveAppMutator(mutate);
      expectCode(() => negative.lifecycle.preflight("runtime-cutover", runId), code);
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareRuntime(negative);
      negative.setLiveRevisionMutator((value) => ({ ...value, name: "revision-wrong" }));
      expectCode(() => negative.lifecycle.preflight("runtime-cutover", runId), "runtime-revisions");
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareCredential(negative);
      negative.setTopology("post");
      negative.setHttpMutator((value) => value.statusCode === 200
        ? { ...value, body: JSON.stringify({ value: [] }) }
        : value);
      expectCode(() => negative.lifecycle.preflight("credential-cleanup", runId), "keyvault-secrets");
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareRuntime(negative);
      const receipt = JSON.parse(readFileSync(negative.paths(runId).diagnostic, "utf8"));
      replaceExisting(negative.paths(runId).diagnostic, { ...receipt, sha256: "b".repeat(64) });
      expectCode(() => negative.lifecycle.preflight("runtime-cutover", runId), "diagnostic-receipt-hash");
    } finally {
      negative.cleanup();
    }
  }
  for (const [mutate, code] of [
    [(value) => {
      const next = structuredClone(value);
      next.properties.template.containers.push(liveContainerApp("pre", "revision-before").properties.template.containers[1]);
      return next;
    }, "credential-revisions-template"],
    [(value) => {
      const next = structuredClone(value);
      next.properties.template.containers[0].env.push({ name: "OPENROUTER_API_KEY", value: "redacted" });
      return next;
    }, "credential-revisions-template"],
    [(value) => {
      const next = structuredClone(value);
      next.properties.configuration.secrets.push({ name: "openrouter-api-key", keyVaultUrl: `${KEY_VAULT_URI}/secrets/openrouter-api-key`, identity: RUNTIME_ID });
      return next;
    }, "credential-topology"],
  ]) {
    const negative = makeHarness();
    try {
      const runId = prepareCredential(negative);
      negative.setTopology("post");
      negative.setLiveAppMutator(mutate);
      if (code === "credential-revisions-template") negative.setLiveRevisionMutator((value) => {
        const next = structuredClone(value);
        if (next.properties.template.containers.length === 1 && mutate.toString().includes("push")) {
          next.properties.template.containers.push(liveContainerApp("pre", "revision-before").properties.template.containers[1]);
        } else {
          next.properties.template.containers[0].env.push({ name: "OPENROUTER_API_KEY", value: "redacted" });
        }
        return next;
      });
      assert.throws(
        () => negative.lifecycle.preflight("credential-cleanup", runId),
        (error) => typeof error?.code === "string" && error.code.startsWith("credential-"),
      );
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareCredential(negative);
      negative.setTopology("post");
      negative.setHttpMutator((value) => value.statusCode === 200
        ? { ...value, body: JSON.stringify({ value: [], nextLink: "https://vault.invalid/page" }) }
        : value);
      expectCode(() => negative.lifecycle.preflight("credential-cleanup", runId), "keyvault-secrets-pagination");
      assert.equal(JSON.stringify(negative.calls).includes("protected-test-token-value"), false);
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareTerminal(negative);
      negative.setRoleMutator(() => []);
      expectCode(() => negative.lifecycle.finalize("terminal", runId), "terminal-openai-rbac-missing");
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareTerminal(negative);
      const receipt = JSON.parse(readFileSync(path.join(negative.root, runId, "terminal-live-receipt.json"), "utf8"));
      replaceExisting(path.join(negative.root, runId, "terminal-live-receipt.json"), { ...receipt, status: "failed" });
      expectCode(() => negative.lifecycle.finalize("terminal", runId), "live-receipt-context");
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareTerminal(negative);
      negative.setModelCase("transcription-nonterminal");
      expectCode(() => negative.lifecycle.finalize("terminal", runId), "terminal-deployment-contract");
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareTerminal(negative);
      const receiptPath = path.join(negative.root, runId, "terminal-live-receipt.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      replaceExisting(receiptPath, { ...receipt, sha256: "c".repeat(64) });
      expectCode(() => negative.lifecycle.finalize("terminal", runId), "live-receipt-hash");
    } finally {
      negative.cleanup();
    }
  }
  {
    const negative = makeHarness();
    try {
      const runId = prepareTerminal(negative);
      rmSync(path.join(negative.root, runId, "terminal-live-receipt.json"));
      expectCode(() => negative.lifecycle.finalize("terminal", runId), "live-receipt-missing");
    } finally {
      negative.cleanup();
    }
  }
});

test("C1 production composition rejects lifecycle and CLI option injection", () => {
  expectCode(() => createLifecycle({ metadataCheck: () => true }), "production-options");
  expectCode(() => createLifecycle({ contextProvider: () => ({}) }), "production-options");
  assert.equal(runCli(["init"], { root: "/tmp/injected" }), 2);
});

test("C1 production module exports no mutating API even with forged test context", () => {
  const moduleUrl = pathToFileURL(
    path.join(REPO_ROOT, "infra/scripts/dev-plan-lifecycle.mjs"),
  ).href;
  const childEnvironment = { ...process.env, NODE_TEST_CONTEXT: "child-forged" };
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(moduleUrl)}).then((module) => {
        const names = ["createLifecycle", "runCli", "createLifecycleForTests", "runCliForTests"];
        const absent = names.every((name) => !Object.hasOwn(module, name));
        process.stdout.write(absent ? "mutating-exports-absent" : "unexpected-export");
        process.exitCode = absent ? 0 : 1;
      }).catch((error) => {
        process.stdout.write(error?.code ?? "import-error");
        process.exitCode = 1;
      });`,
      "--",
      "--palancar-test-factory",
    ],
    {
      cwd: REPO_ROOT,
      env: childEnvironment,
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "mutating-exports-absent");
  assert.equal(child.stderr, "");
});

test("C1 all four guard mappings, argv, and stdin are exact", () => {
  const harness = makeHarness();
  try {
    prepareTerminal(harness);
    const state = harness.lifecycle.readState();
    const showCalls = harness.calls.filter((call) => call.argv[0] === "show");
    assert.equal(showCalls.length, PHASES.length);
    for (const [index, phase] of PHASES.entries()) {
      const show = showCalls[index];
      const guard = harness.calls.find(
        (call) => call.command.endsWith("assert-dev-plan.mjs") && call.phase === phase,
      );
      assert.ok(show);
      assert.ok(guard);
      const expectedArgv = [`--mode=${GUARD_MAPPINGS[phase]}`];
      assert.deepEqual(guard.argv, expectedArgv);
      assert.equal(guard.input, JSON.stringify({ format_version: "1.2" }));
      assert.equal(guard.env.CHECKPOINT_DISABLE, "1");
      const run = state.runs.find((candidate) => candidate.phase === phase);
      assert.ok(run);
      const receiptPath = phase === "terminal"
        ? harness.paths(run.id).guard
        : `${harness.paths(run.id).guard}.consumed`;
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      assert.equal(receipt.guard, GUARD_MAPPINGS[phase]);
      assert.deepEqual(receipt.guardArgv, expectedArgv);
      assert.equal(receipt.stdinSha256, receipt.showSha256);
      assert.equal(receipt.stdinSha256, sha256Bytes(guard.input));
    }
  } finally {
    harness.cleanup();
  }
});

test("C1 future guard phases fail closed without an alias fallback", () => {
  assert.equal(parseCli(["guard", "future-cutover", "run_1"]), undefined);
  const harness = makeHarness();
  try {
    expectCode(
      () => harness.lifecycle.guard("future-cutover", "run_1"),
      "invalid-phase",
    );
  } finally {
    harness.cleanup();
  }
});

test("C2 test execution adapters are isolated and cache one immutable context snapshot", { concurrency: true }, async () => {
  const left = makeHarness();
  const right = makeHarness();
  try {
    await Promise.all([
      Promise.resolve().then(() => initialize(left)),
      Promise.resolve().then(() => initialize(right)),
    ]);
    const beforeLeft = left.calls.length;
    const beforeRight = right.calls.length;
    const [leftRun, rightRun] = await Promise.all([
      Promise.resolve().then(() => left.lifecycle.create("model-bootstrap")),
      Promise.resolve().then(() => right.lifecycle.create("model-bootstrap")),
    ]);
    assert.equal(leftRun.status, "created");
    assert.equal(rightRun.status, "created");
    for (const [harness, before] of [[left, beforeLeft], [right, beforeRight]]) {
      const calls = harness.calls.slice(before);
      const count = (command, argv) => calls.filter(
        (call) => call.command === command && call.argv[0] === argv,
      ).length;
      assert.equal(count("/usr/bin/git", "rev-parse"), 5);
      assert.equal(count(TERRAFORM_PATH, "state"), 1);
      assert.equal(count(TERRAFORM_PATH, "output"), 1);
      assert.equal(count(TERRAFORM_PATH, "workspace"), 1);
      assert.equal(count("/usr/bin/az", "account"), 1);
      assert.equal(count("/usr/bin/az", "ad"), 1);
    }
  } finally {
    left.cleanup();
    right.cleanup();
  }
});

test("C2 test publisher production profile is no-replace, durable, and does not spawn Python", () => {
  const source = readFileSync(path.join(REPO_ROOT, "infra/scripts/dev-plan-lifecycle.mjs"), "utf8");
  const productionPublisherStart = source.indexOf("function publishNoReplaceWithProductionAdapters");
  const publisher = source.slice(
    productionPublisherStart,
    source.indexOf("\nfunction publishNoReplace(", productionPublisherStart),
  );
  assert.match(publisher, /atomicRenameNoReplace/);
  assert.match(publisher, /fsyncDirectory/);
  assert.doesNotMatch(publisher, /spawnSync/);

  const harness = productionHarness();
  try {
    initialize(harness);
    const created = harness.lifecycle.create("model-bootstrap");
    symlinkSync(harness.paths(created.runId).plan, harness.paths(created.runId).show);
    expectCode(
      () => harness.lifecycle.guard("model-bootstrap", created.runId),
      "show-json-exists",
    );
    assert.equal(harness.lifecycle.readState().runs[0].status, "created");
  } finally {
    harness.cleanup();
  }
});

test("C2b unit adapters skip physical fsync while production durability fsyncs and rejects replacement", () => {
  let unitFsyncs = 0;
  const unit = makeHarness({ lowLevel: { testFsyncObserver: () => { unitFsyncs += 1; } } });
  try {
    initialize(unit);
    unit.lifecycle.create("model-bootstrap");
    assert.equal(unitFsyncs, 0);
  } finally {
    unit.cleanup();
  }

  let productionFsyncs = 0;
  const durable = productionHarness({
    lowLevel: { testFsyncObserver: () => { productionFsyncs += 1; } },
  });
  try {
    initialize(durable);
    const created = durable.lifecycle.create("model-bootstrap");
    assert.ok(productionFsyncs > 0);
    replaceExisting(durable.paths(created.runId).plan, "replacement\n");
    expectCode(() => durable.lifecycle.guard("model-bootstrap", created.runId), "plan-hash");
    assert.equal(durable.lifecycle.readState().runs[0].status, "invalidated");
  } finally {
    durable.cleanup();
  }
});

test("C2 production composition never receives the test adapters and retains real publication", () => {
  const source = readFileSync(path.join(REPO_ROOT, "infra/scripts/dev-plan-lifecycle.mjs"), "utf8");
  const lifecycle = createLifecycle();
  assert.equal(Object.hasOwn(lifecycle.config, "testExecution"), false);
  assert.match(source, /TEST_EXECUTION\.run\(undefined, callback\)/);
  assert.match(source, /function atomicRenameNoReplace/);
  assert.match(source, /spawnSync\(\s*"\/usr\/bin\/python3"/);
  for (const name of ["createLifecycle", "runCli", "createLifecycleForTests", "runCliForTests"]) {
    assert.doesNotMatch(source, new RegExp(`export\\s+function\\s+${name}\\b`));
  }
  assert.match(source, /spawnSync\(\s*"\/usr\/bin\/flock"/);
});

test("create persists each plan boundary and faults never permit a replay", () => {
  for (const checkpoint of [
    "run-directory",
    "plan-started",
    "temp-plan",
    "published-plan",
    "terraform-exit-known",
    "manifest",
  ]) {
    const harness = makeHarness({ lowLevel: { faultAtCheckpoint: checkpoint } });
    try {
      initialize(harness);
      expectCode(() => harness.lifecycle.create("model-bootstrap"), `checkpoint-fault-${checkpoint}`);
      assert.equal(harness.calls.filter((call) => call.argv[0] === "plan").length, [
        "temp-plan",
        "published-plan",
        "terraform-exit-known",
        "manifest",
      ].includes(checkpoint) ? 1 : 0);
      const state = harness.lifecycle.readState();
      const run = state.runs[0];
      assert.equal(run.status, "invalidated");
      const names = readdirSync(path.join(harness.root, run.id))
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => entry.replace(/^\d{6}-/, "").replace(/\.json$/, ""));
      assert.ok(names.includes(checkpoint));
      assert.ok(names.includes("invalidated"));
    } finally {
      harness.cleanup();
    }
  }
});

test("faults at guard, apply, and reconcile checkpoints invalidate without replay", () => {
  for (const checkpoint of ["show-json", "guard-receipt"]) {
    const harness = makeHarness({ lowLevel: { faultAtCheckpoint: checkpoint } });
    try {
      initialize(harness);
      const created = harness.lifecycle.create("model-bootstrap");
      expectCode(() => harness.lifecycle.guard("model-bootstrap", created.runId), `checkpoint-fault-${checkpoint}`);
      assert.equal(harness.lifecycle.readState().runs[0].status, "invalidated");
    } finally {
      harness.cleanup();
    }
  }
  {
    const harness = makeHarness({ lowLevel: { faultAtCheckpoint: "preflight-receipt" } });
    try {
      initialize(harness);
      const created = harness.lifecycle.create("model-bootstrap");
      harness.lifecycle.guard("model-bootstrap", created.runId);
      expectCode(() => harness.lifecycle.preflight("model-bootstrap", created.runId), "checkpoint-fault-preflight-receipt");
      assert.equal(harness.lifecycle.readState().runs[0].status, "invalidated");
    } finally {
      harness.cleanup();
    }
  }
  for (const checkpoint of ["applying", "receipts-consumed", "terraform-exit-ambiguous", "apply-receipt", "global-state-advancement"]) {
    const harness = makeHarness({ lowLevel: { faultAtCheckpoint: checkpoint } });
    try {
      initialize(harness);
      const created = harness.lifecycle.create("model-bootstrap");
      harness.lifecycle.guard("model-bootstrap", created.runId);
      harness.lifecycle.preflight("model-bootstrap", created.runId);
      if (checkpoint === "terraform-exit-ambiguous") harness.setApplyStatus("ambiguous");
      expectCode(() => harness.lifecycle.apply("model-bootstrap", created.runId), `checkpoint-fault-${checkpoint}`);
      let recovered;
      try {
        recovered = harness.lifecycle.readState();
      } catch (error) {
        const names = readdirSync(path.join(harness.root, created.runId))
          .filter((entry) => entry.endsWith(".json"))
          .sort()
          .join(",");
        throw new Error(`${checkpoint}: ${error?.code ?? "unknown"}: ${names}`, { cause: error });
      }
      const expectedStatus = ["apply-receipt", "global-state-advancement"].includes(checkpoint)
        ? "applied"
        : "unknown";
      assert.equal(recovered.runs[0].status, expectedStatus);
      assert.equal(recovered.state, expectedStatus === "applied" ? "model-applied" : "manual-Luna-absent");
    } finally {
      harness.cleanup();
    }
  }
  {
    const harness = makeHarness({ lowLevel: { faultAtCheckpoint: "reconcile" } });
    try {
      initialize(harness);
      advanceThrough(harness, "model-bootstrap");
      const runtime = harness.lifecycle.create("runtime-cutover");
      harness.lifecycle.guard("runtime-cutover", runtime.runId);
      writeRuntimeDiagnostic(harness, runtime.runId);
      harness.lifecycle.preflight("runtime-cutover", runtime.runId);
      harness.setApplyStatus("ambiguous");
      expectCode(() => harness.lifecycle.apply("runtime-cutover", runtime.runId), "apply-unknown");
      harness.setRevision("revision-after");
      expectCode(() => harness.lifecycle.reconcile("runtime-cutover", runtime.runId), "checkpoint-fault-reconcile");
      assert.equal(harness.lifecycle.readState().runs.find((run) => run.id === runtime.runId).status, "unknown");
    } finally {
      harness.cleanup();
    }
  }
});

test("kernel lock excludes a genuine concurrent process and leaves a stable secure lock", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "palancar-kernel-"));
  chmodSync(root, 0o700);
  const lock = `${root}.kernel.lock`;
  writeExclusive(lock, "");
  const holder = spawn(
    "/usr/bin/flock",
    ["-n", lock, process.execPath, "-e", "process.stdout.write('ready'); process.stdin.resume();"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  try {
    await new Promise((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout.once("data", resolve);
    });
    const contender = spawnSync("/usr/bin/flock", ["-n", lock, "/usr/bin/true"], { stdio: "ignore" });
    assert.notEqual(contender.status, 0);
  } finally {
    holder.kill("SIGTERM");
    await new Promise((resolve) => holder.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
    rmSync(lock, { force: true });
  }
});

test("global state and run history reject invalid progression", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const created = harness.lifecycle.create("model-bootstrap");
    expectCode(() => harness.lifecycle.preflight("model-bootstrap", created.runId), "out-of-order-operation");
    const state = harness.lifecycle.readState();
    state.state = "runtime-applied";
    replaceExisting(path.join(harness.root, "state.json"), state);
    assert.throws(
      () => harness.lifecycle.create("runtime-cutover"),
      (error) => ["global-state-history", "state-history"].includes(error?.code),
    );
  } finally {
    harness.cleanup();
  }
});

test("receipt replacement, status, and bounded reconcile are fail-closed", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    advanceThrough(harness, "model-bootstrap");
    const runtime = harness.lifecycle.create("runtime-cutover");
    harness.lifecycle.guard("runtime-cutover", runtime.runId);
    writeRuntimeDiagnostic(harness, runtime.runId);
    harness.lifecycle.preflight("runtime-cutover", runtime.runId);
    harness.setApplyStatus("ambiguous");
    expectCode(() => harness.lifecycle.apply("runtime-cutover", runtime.runId), "apply-unknown");
    const receiptPath = harness.paths(runtime.runId).apply;
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 1024);
    assert.equal(receipt.status, "unknown");
    replaceExisting(receiptPath, { ...receipt, planSha256: "b".repeat(64) });
    expectCode(() => harness.lifecycle.reconcile("runtime-cutover", runtime.runId), "apply-mismatch");
    assert.equal(harness.lifecycle.readState().runs.find((run) => run.id === runtime.runId).status, "unknown");
  } finally {
    harness.cleanup();
  }
});

test("artifact symlink and mode attacks invalidate the run", () => {
  const symlinkHarness = makeHarness();
  try {
    initialize(symlinkHarness);
    const created = symlinkHarness.lifecycle.create("model-bootstrap");
    const manifest = symlinkHarness.paths(created.runId).manifest;
    rmSync(manifest);
    symlinkSync(symlinkHarness.paths(created.runId).plan, manifest);
    expectCode(() => symlinkHarness.lifecycle.guard("model-bootstrap", created.runId), "manifest-symlink");
    assert.equal(symlinkHarness.lifecycle.readState().runs[0].status, "invalidated");
  } finally {
    symlinkHarness.cleanup();
  }
  const modeHarness = makeHarness();
  try {
    initialize(modeHarness);
    const created = modeHarness.lifecycle.create("model-bootstrap");
    chmodSync(modeHarness.paths(created.runId).plan, 0o644);
    expectCode(() => modeHarness.lifecycle.guard("model-bootstrap", created.runId), "plan-mode");
    assert.equal(modeHarness.lifecycle.readState().runs[0].status, "invalidated");
  } finally {
    modeHarness.cleanup();
  }
});

test("B1a exit1 produces unknown apply evidence without invalidation", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = guardPreflight(harness, "model-bootstrap");
    harness.setApplyStatus("failure");
    expectCode(() => harness.lifecycle.apply("model-bootstrap", runId), "apply-unknown");
    assert.equal(JSON.parse(readFileSync(harness.paths(runId).apply, "utf8")).status, "unknown");
    assertNoInvalidatedAfterApplying(harness, runId);
  } finally {
    harness.cleanup();
  }
});

test("B1a ambiguous-timeout produces unknown apply evidence without invalidation", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = guardPreflight(harness, "model-bootstrap");
    harness.setApplyStatus("ambiguous");
    expectCode(() => harness.lifecycle.apply("model-bootstrap", runId), "apply-unknown");
    assert.equal(JSON.parse(readFileSync(harness.paths(runId).apply, "utf8")).status, "unknown");
    assertNoInvalidatedAfterApplying(harness, runId);
  } finally {
    harness.cleanup();
  }
});

test("B1a runner throw produces unknown apply evidence without invalidation", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = guardPreflight(harness, "model-bootstrap");
    harness.setApplyStatus("throw");
    expectCode(() => harness.lifecycle.apply("model-bootstrap", runId), "apply-unknown");
    assert.equal(JSON.parse(readFileSync(harness.paths(runId).apply, "utf8")).status, "unknown");
    assertNoInvalidatedAfterApplying(harness, runId);
  } finally {
    harness.cleanup();
  }
});

test("B1a checkpoint after invocation preserves unknown without invalidation", () => {
  let faultArmed = false;
  const harness = makeHarness({
    lowLevel: {
      checkpointFault: (name) => faultArmed && name === "terraform-exit-known",
    },
  });
  try {
    initialize(harness);
    const runId = guardPreflight(harness, "model-bootstrap");
    faultArmed = true;
    expectCode(
      () => harness.lifecycle.apply("model-bootstrap", runId),
      "checkpoint-fault-terraform-exit-known",
    );
    assert.equal(JSON.parse(readFileSync(harness.paths(runId).apply, "utf8")).status, "unknown");
    assertNoInvalidatedAfterApplying(harness, runId);
  } finally {
    harness.cleanup();
  }
});

test("B1a applied receipt then checkpoint error preserves applied without invalidation", () => {
  const harness = makeHarness({ lowLevel: { faultAtCheckpoint: "apply-receipt" } });
  try {
    initialize(harness);
    const runId = guardPreflight(harness, "model-bootstrap");
    expectCode(
      () => harness.lifecycle.apply("model-bootstrap", runId),
      "checkpoint-fault-apply-receipt",
    );
    const { state, run } = assertNoInvalidatedAfterApplying(harness, runId);
    assert.equal(run.status, "applied");
    assert.equal(state.state, "model-applied");
    assert.equal(JSON.parse(readFileSync(harness.paths(runId).apply, "utf8")).status, "applied");
  } finally {
    harness.cleanup();
  }
});

test("B1a global advancement checkpoint recovery preserves applied without invalidation", () => {
  const harness = makeHarness({ lowLevel: { faultAtCheckpoint: "global-state-advancement" } });
  try {
    initialize(harness);
    const runId = guardPreflight(harness, "model-bootstrap");
    expectCode(
      () => harness.lifecycle.apply("model-bootstrap", runId),
      "checkpoint-fault-global-state-advancement",
    );
    const { state, run } = assertNoInvalidatedAfterApplying(harness, runId);
    assert.equal(run.status, "applied");
    assert.equal(state.state, "model-applied");
    assert.equal(JSON.parse(readFileSync(harness.paths(runId).apply, "utf8")).status, "applied");
  } finally {
    harness.cleanup();
  }
});

test("B1a process-death recovery synthesizes ambiguous exit and unknown evidence", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = guardPreflight(harness, "model-bootstrap");
    const runDirectory = path.join(harness.root, runId);
    const sequence = readdirSync(runDirectory)
      .filter((entry) => /^\d{6}-[a-z0-9-]+\.json$/.test(entry)).length + 1;
    writeExclusive(path.join(runDirectory, `${String(sequence).padStart(6, "0")}-applying.json`), {
      version: 1,
      type: "lifecycle-checkpoint",
      sequence,
      name: "applying",
      runId,
      phase: "model-bootstrap",
      createdAt: new Date().toISOString(),
      applyingAt: new Date().toISOString(),
      planSha256: JSON.parse(readFileSync(harness.paths(runId).manifest, "utf8")).planSha256,
    });

    const beforeApplyCalls = harness.calls.filter((call) => call.argv[0] === "apply").length;
    const recovered = harness.lifecycle.readState();
    assert.equal(recovered.runs.find((run) => run.id === runId).status, "unknown");
    assert.equal(harness.calls.filter((call) => call.argv[0] === "apply").length, beforeApplyCalls);
    const checkpointNames = readdirSync(runDirectory)
      .filter((entry) => /^\d{6}-[a-z0-9-]+\.json$/.test(entry))
      .sort()
      .map((entry) => entry.replace(/^\d{6}-/, "").replace(/\.json$/, ""));
    assert.deepEqual(checkpointNames.slice(-2), ["terraform-exit-ambiguous", "apply-receipt"]);
    assert.equal(JSON.parse(readFileSync(harness.paths(runId).apply, "utf8")).status, "unknown");
  } finally {
    harness.cleanup();
  }
});

test("recovery consumes a durable applied reconcile receipt from unknown state", () => {
  const harness = makeHarness({ lowLevel: { faultAtCheckpoint: "reconcile" } });
  try {
    initialize(harness);
    const runId = harness.lifecycle.create("model-bootstrap").runId;
    forceUnknownRun(harness, runId);
    harness.setModelCase("luna-present");
    harness.setSerial(12);
    expectCode(
      () => harness.lifecycle.reconcile("model-bootstrap", runId),
      "checkpoint-fault-reconcile",
    );
    const recovered = harness.lifecycle.readState();
    assert.equal(recovered.runs.find((run) => run.id === runId).status, "applied");
    assert.equal(recovered.state, "model-applied");
    assert.equal(
      readdirSync(path.join(harness.root, runId)).some((entry) => entry.endsWith("-global-state-advancement.json")),
      true,
    );
  } finally {
    harness.cleanup();
  }
});

test("create crash recovery repairs state publication and closes incomplete runs", () => {
  const orphan = makeHarness();
  try {
    initialize(orphan);
    const orphanId = "run_orphan_crash";
    const orphanDirectory = path.join(orphan.root, orphanId);
    mkdirSync(orphanDirectory, { mode: 0o700 });
    assert.equal(orphan.lifecycle.readState().state, "manual-Luna-absent");
    assert.equal(existsSync(orphanDirectory), false);
  } finally {
    orphan.cleanup();
  }

  for (const prefix of [[], ["run-directory"], ["run-directory", "plan-started"]]) {
    const harness = makeHarness();
    try {
      initialize(harness);
      const oldCurrent = readFileSync(path.join(harness.root, "state.json"), "utf8");
      const runId = `run_incomplete_${prefix.length}`;
      const runDirectory = path.join(harness.root, runId);
      mkdirSync(runDirectory, { mode: 0o700 });
      for (const [index, name] of prefix.entries()) {
        writeExclusive(path.join(runDirectory, `${String(index + 1).padStart(6, "0")}-${name}.json`), {
          version: 1,
          type: "lifecycle-checkpoint",
          sequence: index + 1,
          name,
          runId,
          phase: "model-bootstrap",
          createdAt: new Date().toISOString(),
        });
      }
      const state = JSON.parse(oldCurrent);
      state.runs.push({
        id: runId,
        phase: "model-bootstrap",
        status: "created",
        createdAt: new Date().toISOString(),
      });
      appendStateSnapshot(harness, state);
      replaceExisting(path.join(harness.root, "state.json"), oldCurrent);

      const recovered = harness.lifecycle.readState();
      const run = recovered.runs.find((candidate) => candidate.id === runId);
      assert.equal(run.status, "invalidated");
      assert.equal(run.reason, "incomplete-create");
      const names = readdirSync(runDirectory)
        .filter((entry) => /^\d{6}-[a-z0-9-]+\.json$/.test(entry))
        .sort();
      assert.match(names.at(-1), /-invalidated\.json$/);
    } finally {
      harness.cleanup();
    }
  }
});

test("supersede rejects active, wrong, and reused expired cleanup runs", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    advanceThrough(harness, "model-bootstrap");
    advanceThrough(harness, "runtime-cutover");
    const old = harness.lifecycle.create("credential-cleanup");
    writeCleanupArtifacts(harness, old.runId);
    expectCode(() => harness.lifecycle.supersede("credential-cleanup", old.runId), "out-of-order-operation");
    harness.advance(30 * 60 * 1000 + 1);
    expectCode(() => harness.lifecycle.guard("credential-cleanup", old.runId), "plan-expired");
    const cleanupPath = harness.paths(old.runId).cleanup;
    const cleanup = JSON.parse(readFileSync(cleanupPath, "utf8"));
    replaceExisting(cleanupPath, { ...cleanup, runId: "wrong-run" });
    expectCode(() => harness.lifecycle.supersede("credential-cleanup", old.runId), "cleanup-context");
    replaceExisting(cleanupPath, cleanup);
    const replacement = harness.lifecycle.supersede("credential-cleanup", old.runId);
    assert.equal(replacement.supersedes, old.runId);
    expectCode(() => harness.lifecycle.supersede("credential-cleanup", old.runId), "out-of-order-operation");
  } finally {
    harness.cleanup();
  }
});

test("CLI create emits only the opaque run ID", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const writes = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    let status;
    try {
      status = runCliForTests(["create", "model-bootstrap"], harness.options);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.equal(status, 0);
    assert.equal(writes.length, 1);
    assert.match(writes[0], /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\n$/);
  } finally {
    harness.cleanup();
  }
});

test("B1b two actual lifecycle CLI operations contend through the private test adapter", () => {
  const harness = makeHarness();
  let nestedStatus;
  let entered = false;
  let options;
  const originalRunner = harness.options.lowLevel.processRunner;
  options = {
    ...harness.options,
    lowLevel: {
      ...harness.options.lowLevel,
      processRunner(request) {
        if (!entered && request.command === "/usr/bin/git" && request.argv[0] === "status") {
          entered = true;
          nestedStatus = runCliForTests(["init"], options);
        }
        return originalRunner(request);
      },
    },
  };
  const stdout = [];
  const stderr = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    assert.equal(runCliForTests(["init"], options), 0);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    harness.cleanup();
  }
  assert.equal(nestedStatus, 1);
  assert.deepEqual(stdout, ["success\n"]);
  assert.deepEqual(stderr, ["dev-plan-lifecycle: rejected lock-contention\n"]);
});

test("B1b killing the outer lifecycle parent leaves the inherited kernel lock held", async () => {
  await inheritedLockProbe("outer-kill");
});

test("B1b killing lifecycle during a fake apply child holds the lock until apply exits", async () => {
  await inheritedLockProbe("fake-apply");
});

test("B1b apply timeout owns a process group and has no fixed watcher shutdown", () => {
  const source = readFileSync(path.join(REPO_ROOT, "infra/scripts/dev-plan-lifecycle.mjs"), "utf8");
  assert.match(source, /detached: true/);
  assert.match(source, /process\.kill\(-pgid, signal\)/);
  assert.match(source, /SIGTERM/);
  assert.match(source, /SIGKILL/);
  assert.match(source, /waitForProcessGroupDead/);
  assert.doesNotMatch(source, /kernel-holder|setInterval|Atomics\.wait|sleepSynchronously/);

  const fakeTerraform = "process.stdout.write('ready\\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const groupProbe = [
    "const { spawn } = require('node:child_process');",
    `const leader = spawn(process.execPath, ['-e', ${JSON.stringify(fakeTerraform)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });`,
    `const deadline = Date.now() + 1500;`,
    "const finish = () => {",
    "  try { process.kill(-leader.pid, 0); }",
    "  catch (error) { if (error?.code === 'ESRCH') process.exit(0); }",
    "  if (Date.now() >= deadline) process.exit(1);",
    "  setTimeout(finish, 5);",
    "};",
    "leader.stdout.once('data', () => {",
    "  process.kill(-leader.pid, 'SIGTERM');",
    "  process.kill(-leader.pid, 'SIGKILL');",
    "  finish();",
    "});",
    "setTimeout(() => process.exit(1), 1500);",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", groupProbe], {
    stdio: "ignore",
    timeout: 2500,
  });
  assert.equal(result.status, 0);
});
