import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
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
  )}\nexport { LIFECYCLE_CACHE_ROOT, createLifecycle, runCli, createLifecycleForTests, runCliForTests, reviewedRuntimeShapes, assertInactiveRevisionTemplate };\n`;
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
  assertInactiveRevisionTemplate,
  reviewedRuntimeShapes,
  sha256File,
  sha256Bytes,
  TERRAFORM_PATH,
} = lifecycleModule;

const PLAN_BYTES = Buffer.from("synthetic saved terraform plan\n", "utf8");
const SHA = "a".repeat(64);
const BLOB = "e".repeat(40);
const COMMIT = "f".repeat(40);
const REPO_ROOT = process.cwd();
const REAL_GUARD_PATH = path.join(REPO_ROOT, "infra/scripts/assert-dev-plan.mjs");
const REVIEWED_LUNA_FIXTURE_TEXT = readFileSync(
  path.join(REPO_ROOT, "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json"),
  "utf8",
);
const REVIEWED_RUNTIME_FIXTURE = JSON.parse(readFileSync(
  path.join(REPO_ROOT, "infra/scripts/fixtures/azure-generation-cutover.plan-fixture.json"),
  "utf8",
));
const REVIEWED_CREDENTIAL_FIXTURE = JSON.parse(readFileSync(
  path.join(REPO_ROOT, "infra/scripts/fixtures/azure-credential-cleanup.plan-fixture.json"),
  "utf8",
));
const REAL_BACKEND_PATH = path.join(REPO_ROOT, "infra/environments/dev/backend.hcl");
const REAL_BACKEND = parseCanonicalBackendConfig(readFileSync(REAL_BACKEND_PATH, "utf8"));
const SUBSCRIPTION = REAL_BACKEND.identity.subscription_id;
const TENANT = REAL_BACKEND.identity.tenant_id;
const OBJECT_ID = "00000000-0000-4000-8000-000000000003";
const FOUNDry_ACCOUNT_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.CognitiveServices/accounts/foundry-test`;
const TRANSCRIPTION_ID = `${FOUNDry_ACCOUNT_ID}/deployments/gpt-4o-mini-transcribe`;
const LUNA_ID = `${FOUNDry_ACCOUNT_ID}/deployments/gpt-5.6-luna`;
const RELAY_IMAGE = "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:e9b7e2ea937d3a15f3b3a52e50d9736b5c63c69765c3ee571ab0c06f762436bd";
const REVIEWED_RELAY_IMAGE = "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:" + "c".repeat(63) + "2";
const FIXTURE_REVIEWED_RELAY_IMAGE = "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:" + "1".repeat(64);
const PREDECESSOR_IMAGE = "palancardevacraeeacd8c.azurecr.io/palancar-litellm-proxy@sha256:" + "d".repeat(64);
const IMAGE_PULL_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.ManagedIdentity/userAssignedIdentities/image-pull`;
const RUNTIME_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.ManagedIdentity/userAssignedIdentities/runtime`;
const KEY_VAULT_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.KeyVault/vaults/kv-test`;
const KEY_VAULT_URI = "https://kv-test.vault.azure.net";
const CONTAINER_ENV_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.App/managedEnvironments/cae-test`;
const FOUNDRY_ENDPOINT = "https://foundry-test.openai.azure.com";
const IMAGE_PULL_CLIENT = "00000000-0000-0000-0000-000000000010";
const IMAGE_PULL_PRINCIPAL = "00000000-0000-0000-0000-000000000011";
const RUNTIME_CLIENT = "00000000-0000-0000-0000-000000000012";
const RUNTIME_PRINCIPAL = "00000000-0000-0000-0000-000000000013";
const CLEANUP_IMAGE = "palancardevacraeeacd8c.azurecr.io/palancar-expiry-cleanup@sha256:" + "c".repeat(64);
const CLEANUP_JOB_PARENT_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime`;
const CLEANUP_ENV = Object.freeze([
  { name: "AZURE_CLIENT_ID", value: RUNTIME_CLIENT },
  { name: "PALANCAR_WORKLOAD_TABLE_ENDPOINT", value: "https://palancardevstateaeeacd8c.table.core.windows.net" },
  { name: "PALANCAR_SECURITY_STATE_TABLE", value: "SecurityState" },
  { name: "PALANCAR_RATE_STATE_TABLE", value: "RateState" },
  { name: "PALANCAR_RELAY_ENVIRONMENT", value: "dev" },
  { name: "PALANCAR_RELAY_ORIGIN", value: "wss://ca-palancar-dev-relay-aeeacd8c.graysmoke-757a2980.eastus2.azurecontainerapps.io" },
  { name: "PALANCAR_EXPIRY_CLEANUP_LIMIT", value: "1000" },
  { name: "PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS", value: "240000" },
]);
const CLEANUP_TAGS = Object.freeze({
  application: "palancar",
  environment: "dev",
  "managed-by": "terraform",
  "data-classification": "operational-metadata",
});
const SYSTEM_DATA_ACTOR = "synthetic-user";

function cleanupEnvironment() {
  return CLEANUP_ENV.map((entry) => ({ ...entry }));
}
const GENERATION_PATHS = [
  "packages/generation/src/azure-openai.ts",
  "packages/generation/src/errors.ts",
  "packages/generation/src/evidence.ts",
  "packages/generation/src/service.ts",
  "packages/generation/src/types.ts",
  "packages/generation/test/azure-openai-provider.test.ts",
  "packages/generation/test/generation.test.ts",
];

function fullRoleAssignment(assignment) {
  const name = assignment.id.slice(assignment.id.lastIndexOf("/") + 1);
  const roleDefinitionName = assignment.roleDefinitionId.endsWith("4633458b-17de-408a-b874-0445c86b69e6")
    ? "Key Vault Secrets User"
    : "Cognitive Services OpenAI User";
  return {
    ...assignment,
    condition: null,
    conditionVersion: null,
    createdBy: OBJECT_ID,
    createdOn: "2026-08-22T00:00:00Z",
    delegatedManagedIdentityResourceId: null,
    description: null,
    name,
    principalName: "runtime-test",
    roleDefinitionName,
    type: "Microsoft.Authorization/roleAssignments",
    updatedBy: OBJECT_ID,
    updatedOn: "2026-08-22T00:00:00Z",
  };
}

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
    return [];
  }
  return [
    { name: "PALANCAR_GENERATION_PROVIDER", value: "azure-openai" },
    { name: "PALANCAR_AZURE_GENERATION_ENDPOINT", value: FOUNDRY_ENDPOINT },
    { name: "PALANCAR_AZURE_GENERATION_DEPLOYMENT", value: "gpt-5.6-luna" },
    { name: "AZURE_CLIENT_ID", value: RUNTIME_CLIENT },
    { name: "PALANCAR_TRANSCRIPTION_PROVIDER", value: "azure-realtime" },
    { name: "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT", value: "wss://foundry-test.openai.azure.com/openai/v1/realtime?intent=transcription" },
    { name: "PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT", value: "gpt-4o-mini-transcribe" },
  ];
}

function liveContainerApp(topology, revision) {
  const relay = {
    name: "relay",
    image: topology === "pre" ? RELAY_IMAGE : REVIEWED_RELAY_IMAGE,
    env: relayEnvironment(topology),
    resources: { cpu: 0.25, memory: "0.5Gi" },
  };
  const predecessor = {
    name: "litellm",
    image: PREDECESSOR_IMAGE,
    env: [
      { name: "LEGACY_BACKEND", value: "legacy" },
      { name: "LEGACY_MODEL", value: "legacy-model" },
      { name: "LEGACY_RUNTIME_SECRET", secretRef: "litellm-master-key" },
      { name: "LEGACY_PROVIDER_SECRET", secretRef: "openrouter-api-key" },
    ],
    resources: { cpu: 0.75, memory: "1.5Gi" },
  };
  const containers = topology === "pre" ? [relay, predecessor] : [relay];
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
        maxInactiveRevisions: 1,
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

function retainedRuntimePredecessorRevision() {
  const predecessor = liveRevision("revision-before", "pre");
  predecessor.properties.active = false;
  predecessor.properties.trafficWeight = 0;
  predecessor.properties.replicaCount = 0;
  return predecessor;
}

function reviewedRuntimeShow(phase = "runtime-cutover") {
  const before = phase === "credential-cleanup" || phase === "terminal"
    ? liveContainerApp("post", "revision-after")
    : liveContainerApp("pre", "revision-before");
  const after = phase === "credential-cleanup" || phase === "terminal"
    ? structuredClone(before)
    : liveContainerApp("post", "revision-after");
  for (const app of [before, after]) {
    app.properties.configuration.ingress.traffic = [{ latestRevision: true, weight: 100 }];
  }
  const addressed = (app) => ({
    address: "module.container_app_workload[0].azapi_resource.this",
    values: { body: { identity: app.identity, properties: app.properties } },
  });
  const cleanupJob = {
    body: {
      properties: {
        environmentId: CONTAINER_ENV_ID,
        configuration: {
          triggerType: "Schedule",
          scheduleTriggerConfig: { cronExpression: "0 3 * * *", replicaCompletionCount: 1, parallelism: 1 },
          replicaRetryLimit: 0,
          replicaTimeout: 300,
          registries: [{ server: "palancardevacraeeacd8c.azurecr.io", identity: IMAGE_PULL_ID }],
          identitySettings: [
            { identity: IMAGE_PULL_ID.replace("resourceGroups", "resourcegroups"), lifecycle: "None" },
            { identity: RUNTIME_ID.replace("resourceGroups", "resourcegroups"), lifecycle: "Main" },
          ],
        },
        template: {
          containers: [{
            name: "expiry-cleanup",
            image: CLEANUP_IMAGE,
            resources: { cpu: 0.25, memory: "0.5Gi" },
            env: cleanupEnvironment(),
          }],
        },
      },
    },
    create_headers: null,
    create_query_parameters: null,
    delete_headers: null,
    delete_query_parameters: null,
    id: `${CLEANUP_JOB_PARENT_ID}/providers/Microsoft.App/jobs/cleanup-job`,
    identity: [{ identity_ids: [IMAGE_PULL_ID, RUNTIME_ID], principal_id: "", tenant_id: "", type: "UserAssigned" }],
    ignore_body_changes: null,
    ignore_casing: false,
    ignore_missing_property: true,
    ignore_null_property: false,
    ignore_other_items_in_list: null,
    list_unique_id_property: null,
    location: "eastus2",
    locks: null,
    name: "cleanup-job",
    output: null,
    parent_id: CLEANUP_JOB_PARENT_ID,
    read_headers: null,
    read_query_parameters: null,
    replace_triggers_external_values: null,
    replace_triggers_refs: null,
    response_export_values: null,
    retry: null,
    schema_validation_enabled: true,
    sensitive_body: null,
    sensitive_body_version: null,
    tags: CLEANUP_TAGS,
    timeouts: null,
    type: "Microsoft.App/jobs@2026-01-01",
    update_headers: null,
    update_query_parameters: null,
  };
  const addressedCleanupJob = {
    address: "module.expiry_cleanup_job[0].azapi_resource.this",
    values: cleanupJob,
  };
  return {
    format_version: "1.2",
    variables: {
      relay_image_digest: { value: REVIEWED_RELAY_IMAGE },
      expiry_cleanup_image_digest: { value: CLEANUP_IMAGE },
    },
    resource_changes: [
      {
        address: "module.container_app_workload[0].azapi_resource.this",
        change: {
          actions: [phase === "credential-cleanup" || phase === "terminal" ? "no-op" : "update"],
          before: addressed(before).values,
          after: addressed(after).values,
        },
      },
      {
        address: "module.expiry_cleanup_job[0].azapi_resource.this",
        change: { actions: ["no-op"], before: cleanupJob, after: structuredClone(cleanupJob) },
      },
    ],
    prior_state: { values: { root_module: { resources: [addressed(before), addressedCleanupJob] } } },
    planned_values: { root_module: { resources: [addressed(after), addressedCleanupJob] } },
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
    "infra/scripts/fixtures/azure-generation-cutover.plan-fixture.json",
    "infra/scripts/fixtures/azure-credential-cleanup.plan-fixture.json",
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
  const closure = `${root}-closure`;
  let tick = Date.now();
  let serial = 7;
  let lineage = "lineage-1";
  let revision = "revision-before";
  let applyStatus = "success";
  let modelCase = "ok";
  let topology = "pre";
  let runtimeSecretsEnabled = true;
  let liveAppMutator = (value) => value;
  let liveRevisionMutator = (value) => topology === "post"
    ? [value, retainedRuntimePredecessorRevision()]
    : value;
  let roleMutator = (value) => value;
  let roleListMutator = (value) => value;
  let httpMutator = (value) => value;
  let diagnosticExecutionName = "diagnostic-execution-1";
  let diagnosticExecutionStatus = "Succeeded";
  let diagnosticStartStatus = "success";
  let diagnosticRestMode = "empty";
  let diagnosticJobMutator = (value) => value;
  let diagnosticRuntimeIdentityShowCount = 0;
  let diagnosticRuntimeIdentityMutator = (value) => value;
  let diagnosticImagePullIdentityMutator = (value) => value;
  let diagnosticPostRuntimeIdentityStatus = "success";
  let diagnosticStartClockAdvanceMs = 0;
  let diagnosticRequestId;
  let diagnosticRunId;
  let diagnosticPlanSha;
  let reviewedShowMutator = (value) => value;
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
            localizedValue: modelCase === "quota-localized-bad"
              ? `Tokens Per Minute (thousands) - ${quotaModel}`
              : `One Thousand Tokens Per Minute - ${quotaModel} - GlobalStandard`,
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
      if (request.argv[0] === "identity" && request.argv[1] === "show") {
        const identityId = request.argv[request.argv.indexOf("--ids") + 1];
        if (identityId === IMAGE_PULL_ID) {
          const imagePullIdentity = diagnosticImagePullIdentityMutator({
            id: IMAGE_PULL_ID,
            clientId: IMAGE_PULL_CLIENT,
            principalId: IMAGE_PULL_PRINCIPAL,
          });
          return {
            status: 0,
            stdout: JSON.stringify(imagePullIdentity),
          };
        }
        diagnosticRuntimeIdentityShowCount += 1;
        if (diagnosticRuntimeIdentityShowCount >= 2 && diagnosticPostRuntimeIdentityStatus !== "success") {
          return diagnosticPostRuntimeIdentityStatus === "ambiguous"
            ? { status: null, exitCode: null, stdout: "", stderr: "" }
            : { status: 1, exitCode: 1, stdout: "", stderr: "identity unavailable\n" };
        }
        const runtimeIdentity = diagnosticRuntimeIdentityMutator({
          id: RUNTIME_ID,
          clientId: RUNTIME_CLIENT,
          principalId: RUNTIME_PRINCIPAL,
        }, diagnosticRuntimeIdentityShowCount);
        return {
          status: 0,
          stdout: JSON.stringify(runtimeIdentity),
        };
      }
      if (request.argv[0] === "containerapp" && request.argv[1] === "job" && request.argv[2] === "show") {
        return {
          status: 0,
          stdout: JSON.stringify(diagnosticJobMutator({
            id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.App/jobs/cleanup-job`,
            name: "cleanup-job",
            location: "eastus2",
            resourceGroup: "rg-runtime",
            type: "Microsoft.App/jobs",
            tags: {
              application: "palancar",
              environment: "dev",
              "managed-by": "terraform",
              "data-classification": "operational-metadata",
            },
            systemData: {
              createdAt: "2026-08-22T00:00:00Z",
              createdBy: SYSTEM_DATA_ACTOR,
              createdByType: "User",
              lastModifiedAt: "2026-08-22T00:00:00Z",
              lastModifiedBy: SYSTEM_DATA_ACTOR,
              lastModifiedByType: "User",
            },
            identity: {
              type: "UserAssigned",
              userAssignedIdentities: {
                [IMAGE_PULL_ID]: { clientId: IMAGE_PULL_CLIENT, principalId: IMAGE_PULL_PRINCIPAL },
                [RUNTIME_ID]: { clientId: RUNTIME_CLIENT, principalId: RUNTIME_PRINCIPAL },
              },
            },
            properties: {
              environmentId: CONTAINER_ENV_ID,
              provisioningState: "Succeeded",
              runningStatus: "Ready",
              eventStreamEndpoint: "https://eastus2.azurecontainerapps.dev/subscriptions/" + SUBSCRIPTION + "/resourceGroups/rg-runtime/containerApps/cleanup-job/eventstream",
              outboundIpAddresses: ["20.42.8.12"],
              workloadProfileName: null,
              configuration: {
                dapr: null,
                eventTriggerConfig: null,
                manualTriggerConfig: null,
                triggerType: "Schedule",
                scheduleTriggerConfig: { cronExpression: "0 3 * * *", replicaCompletionCount: 1, parallelism: 1 },
                replicaRetryLimit: 0,
                replicaTimeout: 300,
                registries: [{ server: "palancardevacraeeacd8c.azurecr.io", identity: IMAGE_PULL_ID, username: "", passwordSecretRef: "" }],
                identitySettings: [
                  { identity: IMAGE_PULL_ID, lifecycle: "None" },
                  { identity: RUNTIME_ID, lifecycle: "Main" },
                ],
                secrets: null,
              },
              template: {
                initContainers: null,
                volumes: null,
                containers: [{
                  name: "expiry-cleanup",
                  image: CLEANUP_IMAGE,
                  imageType: "ContainerImage",
                  env: cleanupEnvironment(),
                  resources: { cpu: 0.25, memory: "0.5Gi", ephemeralStorage: "1Gi" },
                  probes: null,
                  command: null,
                  args: null,
                }],
              },
            },
          })),
        };
      }
      if (request.argv[0] === "containerapp" && request.argv[1] === "job" && request.argv[2] === "start") {
        tick += diagnosticStartClockAdvanceMs;
        const environmentArgs = request.argv.slice(request.argv.indexOf("--env-vars") + 1, request.argv.indexOf("--cpu"));
        diagnosticRequestId = environmentArgs.find((entry) => entry.startsWith("PALANCAR_DIAGNOSTIC_REQUEST_ID="))?.slice("PALANCAR_DIAGNOSTIC_REQUEST_ID=".length);
        diagnosticRunId = environmentArgs.find((entry) => entry.startsWith("PALANCAR_DIAGNOSTIC_RUN_ID="))?.slice("PALANCAR_DIAGNOSTIC_RUN_ID=".length);
        diagnosticPlanSha = environmentArgs.find((entry) => entry.startsWith("PALANCAR_DIAGNOSTIC_PLAN_SHA256="))?.slice("PALANCAR_DIAGNOSTIC_PLAN_SHA256=".length);
        if (diagnosticStartStatus === "ambiguous") return { status: null, exitCode: null, stdout: "", stderr: "" };
        if (diagnosticStartStatus === "failure") return { status: 1, exitCode: 1, stdout: "", stderr: "rejected\n" };
        return {
          status: 0,
          stdout: JSON.stringify({
            id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.App/jobs/cleanup-job/executions/${diagnosticExecutionName}`,
            name: diagnosticExecutionName,
          }),
        };
      }
      if (request.argv[0] === "containerapp" && request.argv[1] === "job" && request.argv[2] === "execution" && request.argv[3] === "show") {
        return {
          status: 0,
          stdout: JSON.stringify({
            id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.App/jobs/cleanup-job/executions/${diagnosticExecutionName}`,
            name: diagnosticExecutionName,
            properties: {
              status: diagnosticExecutionStatus,
              exitCode: diagnosticExecutionStatus === "Succeeded" ? 0 : 20,
              result: diagnosticExecutionStatus === "Succeeded" ? "passed" : "failed",
              template: {
                containers: [{
                  name: "expiry-cleanup",
                  image: REVIEWED_RELAY_IMAGE,
                  command: ["node"],
                  args: ["apps/relay/dist/azure-generation-diagnostic.js"],
                  env: [
                    { name: "AZURE_CLIENT_ID", value: RUNTIME_CLIENT },
                    { name: "PALANCAR_AZURE_GENERATION_ENDPOINT", value: FOUNDRY_ENDPOINT },
                    { name: "PALANCAR_AZURE_GENERATION_DEPLOYMENT", value: "gpt-5.6-luna" },
                    { name: "PALANCAR_DIAGNOSTIC_REQUEST_ID", value: diagnosticRequestId },
                    { name: "PALANCAR_DIAGNOSTIC_RUN_ID", value: diagnosticRunId },
                    { name: "PALANCAR_DIAGNOSTIC_PLAN_SHA256", value: diagnosticPlanSha },
                  ],
                  resources: { cpu: 0.25, memory: "0.5Gi" },
                }],
              },
            },
          }),
        };
      }
      if (request.argv[0] === "rest") {
        const diagnosticExecution = {
          id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.App/jobs/cleanup-job/executions/${diagnosticExecutionName}`,
          name: diagnosticExecutionName,
          properties: {
            status: diagnosticExecutionStatus,
            exitCode: diagnosticExecutionStatus === "Succeeded" ? 0 : 20,
            result: diagnosticExecutionStatus === "Succeeded" ? "passed" : "failed",
            template: {
              containers: [{
                name: "expiry-cleanup",
                image: REVIEWED_RELAY_IMAGE,
                command: ["node"],
                args: ["apps/relay/dist/azure-generation-diagnostic.js"],
                env: [
                  { name: "AZURE_CLIENT_ID", value: RUNTIME_CLIENT },
                  { name: "PALANCAR_AZURE_GENERATION_ENDPOINT", value: FOUNDRY_ENDPOINT },
                  { name: "PALANCAR_AZURE_GENERATION_DEPLOYMENT", value: "gpt-5.6-luna" },
                  { name: "PALANCAR_DIAGNOSTIC_REQUEST_ID", value: diagnosticRequestId },
                  { name: "PALANCAR_DIAGNOSTIC_RUN_ID", value: diagnosticRunId },
                  { name: "PALANCAR_DIAGNOSTIC_PLAN_SHA256", value: diagnosticPlanSha },
                ],
                resources: { cpu: 0.25, memory: "0.5Gi" },
              }],
            },
          },
        };
        const restUrl = request.argv[request.argv.indexOf("--url") + 1] ?? "";
        if (diagnosticRestMode === "absolute-match" && restUrl.includes("$skiptoken=next")) {
          return { status: 0, stdout: JSON.stringify({ value: [diagnosticExecution], nextLink: null }) };
        }
        if (diagnosticRestMode === "cycle") {
          return {
            status: 0,
            stdout: JSON.stringify({
              value: [],
              nextLink: "https://management.azure.com/subscriptions/" + SUBSCRIPTION +
                "/resourceGroups/rg-runtime/providers/Microsoft.App/jobs/cleanup-job/executions?api-version=2025-07-01",
            }),
          };
        }
        if (diagnosticRestMode === "absolute-match") {
          return {
            status: 0,
            stdout: JSON.stringify({
              value: [],
              nextLink: "https://management.azure.com/subscriptions/" + SUBSCRIPTION +
                "/resourceGroups/rg-runtime/providers/Microsoft.App/jobs/cleanup-job/executions?api-version=2025-07-01&$skiptoken=next",
            }),
          };
        }
        if (diagnosticRestMode === "cap-exhaustion") {
          const parsedUrl = new URL(restUrl);
          const page = Number(parsedUrl.searchParams.get("$skiptoken") ?? "0");
          return {
            status: 0,
            stdout: JSON.stringify({
              value: page === 0 ? [diagnosticExecution] : [],
              nextLink: `https://management.azure.com/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.App/jobs/cleanup-job/executions?api-version=2025-07-01&$skiptoken=${page + 1}`,
            }),
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ value: [], nextLink: null }),
        };
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
        if (request.argv.includes("--all")) {
          return {
            status: 2,
            exitCode: 2,
            stdout: "",
            stderr: "group or scope are not required when --all is used\n",
          };
        }
        const scope = request.argv[request.argv.indexOf("--scope") + 1];
        const applyRoleMutator = request.argv.includes("--assignee-object-id");
        const mutateRoleList = (assignments) => roleListMutator(
          applyRoleMutator ? roleMutator(assignments, request) : assignments,
          request,
        );
        if (scope === KEY_VAULT_ID) {
          const assignments = runtimeSecretsEnabled
            ? [fullRoleAssignment({
                id: `${scope}/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000021`,
                principalId: RUNTIME_PRINCIPAL,
                principalType: "ServicePrincipal",
                roleDefinitionId: `/subscriptions/${SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`,
                scope,
              })]
            : [];
          return { status: 0, stdout: JSON.stringify(mutateRoleList(assignments)) };
        }
        const role = scope === FOUNDry_ACCOUNT_ID
          ? "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"
          : undefined;
        if (role === undefined) return { status: 0, stdout: JSON.stringify(mutateRoleList([])) };
        return {
          status: 0,
          stdout: JSON.stringify(mutateRoleList([fullRoleAssignment({
            id: `${scope}/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000020`,
            principalId: RUNTIME_PRINCIPAL,
            principalType: "ServicePrincipal",
            roleDefinitionId: `/subscriptions/${SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/${role}`,
            scope,
          })])),
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
            runtime_openai_user_role_assignment_id: { value: `${FOUNDry_ACCOUNT_ID}/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000020` },
            image_pull_identity_id: { value: IMAGE_PULL_ID },
            container_app_environment_id: { value: CONTAINER_ENV_ID },
            expiry_cleanup_job_name: { value: "cleanup-job" },
            expiry_cleanup_job_id: { value: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-runtime/providers/Microsoft.App/jobs/cleanup-job` },
          }),
        };
      }
      if (request.argv[0] === "plan") {
        const planPath = request.argv.find((arg) => arg.startsWith("-out=")).slice(5);
        writeExclusive(planPath, PLAN_BYTES);
        return { status: 0, stdout: "" };
      }
      if (request.argv[0] === "show") {
        return {
          status: 0,
          stdout: JSON.stringify(reviewedShowMutator(reviewedRuntimeShow(request.phase))),
        };
      }
      if (request.argv[0] === "apply") {
        if (applyStatus === "throw") throw new Error("runner failure");
        if (applyStatus === "success" && request.phase === "runtime-cutover") {
          topology = "post";
          revision = "revision-after";
        }
        if (applyStatus === "success" && request.phase === "credential-cleanup") runtimeSecretsEnabled = false;
        return { status: applyStatus === "success" ? 0 : applyStatus === "failure" ? 1 : null, stdout: "" };
      }
    }
    if (request.command.endsWith("assert-dev-plan.mjs")) return { status: 0, stdout: "" };
    return { status: 0, stdout: "" };
  };
  const cleanupRunner = ({ operation, runId, root: cleanupRoot }) => {
    const directory = path.join(cleanupRoot, runId);
    const paths = {
      descriptor: path.join(directory, "vault-descriptor.json"),
      manifest: path.join(directory, "create-manifest.json"),
      operation: path.join(directory, "cleanup-manifest.json"),
      absence: path.join(directory, "cleanup-absence-receipt.json"),
      state: path.join(directory, "cleanup-state-000000.json"),
      anchor: path.join(directory, "cleanup-state-anchor.json"),
    };
    const descriptor = JSON.parse(readFileSync(paths.descriptor, "utf8"));
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
    const unsignedOperation = {
      version: 2,
      type: "cleanup",
      status: "completed",
      operation: "credential-cleanup",
      runId,
      phase: "credential-cleanup",
      planSha256: manifest.planSha256,
      bindingSha256: manifest.bindingSha256,
      createdAt: manifest.createdAt,
      repositoryCommit: manifest.bindings.repositoryCommit,
      contextSha256: manifest.bindingSha256,
      runtimeSecretReferences: [],
      supersession: descriptor.supersession ?? null,
    };
    const publishOperation = () => {
      writeExclusive(paths.operation, {
        ...unsignedOperation,
        sha256: sha256Bytes(canonicalJson(unsignedOperation)),
      });
    };
    const inventory = (absent) => ({
      activeNames: absent ? [] : ["openrouter-api-key", "litellm-master-key"],
      deletedNames: [],
      targetStates: ["openrouter-api-key", "litellm-master-key"].map((name) => ({
        name,
        activeCount: absent ? 0 : 1,
        deletedCount: 0,
        state: absent ? "absent" : "active",
      })),
    });
    const publishState = (sequence, status, stateInventory, previousStateSha256, absenceReceiptSha256 = null) => {
      const value = {
        version: 1,
        type: "key-vault-cleanup-state",
        runId,
        phase: "credential-cleanup",
        sequence,
        status,
        attempts: 0,
        cumulativeElapsedMs: 0,
        attemptStartedAt: null,
        operationStartedAt: Date.now(),
        accountingCursor: Date.now(),
        retryNotBefore: null,
        absenceReceiptSha256,
        manifestSha256: sha256Bytes(readFileSync(paths.operation)),
        inventory: stateInventory,
        inventorySha256: sha256Bytes(canonicalJson(stateInventory)),
        previousStateSha256,
        stateSha256: null,
      };
      value.stateSha256 = sha256Bytes(canonicalJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "stateSha256"))));
      const statePath = path.join(directory, `cleanup-state-${String(sequence).padStart(6, "0")}.json`);
      writeExclusive(statePath, value);
      const anchor = {
        version: 1,
        type: "key-vault-cleanup-state-anchor",
        runId,
        phase: "credential-cleanup",
        stateSequence: sequence,
        stateSha256: value.stateSha256,
        stateFileSha256: sha256Bytes(readFileSync(statePath)),
        manifestSha256: value.manifestSha256,
        anchorSha256: null,
      };
      anchor.anchorSha256 = sha256Bytes(canonicalJson(Object.fromEntries(Object.entries(anchor).filter(([key]) => key !== "anchorSha256"))));
      writeExclusive(sequence === 0 ? paths.anchor : path.join(directory, `cleanup-state-anchor-${String(sequence).padStart(6, "0")}.json`), anchor);
      return value;
    };
    if (operation === "start") {
      publishOperation();
      publishState(0, "start-inventory-validated", inventory(false), null);
      return { status: "started" };
    }
    if (operation === "resume") {
      if (!existsSync(paths.operation)) publishOperation();
      if (!existsSync(paths.absence)) {
        const unsignedAbsence = {
          version: 2,
          type: "absence",
          status: "absent",
          operation: "credential-cleanup",
          runId,
          phase: "credential-cleanup",
          planSha256: manifest.planSha256,
          bindingSha256: manifest.bindingSha256,
          createdAt: unsignedOperation.createdAt,
          repositoryCommit: unsignedOperation.repositoryCommit,
          contextSha256: unsignedOperation.contextSha256,
          inventory: { keyVault: "absent", runtimeSecretReferences: 0 },
          supersession: unsignedOperation.supersession,
        };
        const absence = {
          ...unsignedAbsence,
          sha256: sha256Bytes(canonicalJson(unsignedAbsence)),
        };
        writeExclusive(paths.absence, absence);
        const previous = JSON.parse(readFileSync(paths.state, "utf8"));
        publishState(1, "complete", inventory(true), sha256Bytes(readFileSync(paths.state)), sha256Bytes(canonicalJson(absence)));
        void previous;
      }
      return { status: "absent" };
    }
    if (operation === "assert-absent") return { status: "absent" };
    throw new Error(`unexpected cleanup operation ${operation}`);
  };
  const baseOptions = {
    root,
    closure,
    repoRoot,
    workdir,
    inheritedEnvironment: {},
    lowLevel: {
      processRunner: run,
      cleanupRunner,
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
    closure,
    workdir,
    backendConfigPath,
    calls,
    setSerial(value) { serial = value; },
    setLineage(value) { lineage = value; },
    setRevision(value) { revision = value; },
    setTopology(value) {
      topology = value;
      if (value === "post") revision = "revision-after";
    },
    setRuntimeSecretsEnabled(value) { runtimeSecretsEnabled = value; },
    setLiveAppMutator(value) { liveAppMutator = value; },
    setLiveRevisionMutator(value) { liveRevisionMutator = value; },
    setRoleMutator(value) { roleMutator = value; },
    setRoleListMutator(value) { roleListMutator = value; },
    setHttpMutator(value) { httpMutator = value; },
    setApplyStatus(value) { applyStatus = value; },
    setModelCase(value) { modelCase = value; },
    setDiagnosticExecution(value) { diagnosticExecutionName = value; },
    setDiagnosticStatus(value) { diagnosticExecutionStatus = value; },
    setDiagnosticStartStatus(value) { diagnosticStartStatus = value; },
    setDiagnosticRestMode(value) { diagnosticRestMode = value; },
    setDiagnosticJobMutator(value) { diagnosticJobMutator = value; },
    setDiagnosticRuntimeIdentityMutator(value) { diagnosticRuntimeIdentityMutator = value; },
    setDiagnosticImagePullIdentityMutator(value) { diagnosticImagePullIdentityMutator = value; },
    setDiagnosticPostRuntimeIdentityStatus(value) { diagnosticPostRuntimeIdentityStatus = value; },
    setDiagnosticStartClockAdvance(value) { diagnosticStartClockAdvanceMs = value; },
    setReviewedShowMutator(value) { reviewedShowMutator = value; },
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

function roleAssignmentCalls(harness, start = 0) {
  return harness.calls.slice(start).filter(
    (call) => call.command === "/usr/bin/az" &&
      call.argv[0] === "role" && call.argv[1] === "assignment" && call.argv[2] === "list",
  );
}

function assertExactScopedRoleAssignmentArgv(call, scope, principalId = undefined) {
  assert.deepEqual(call.argv, [
    "role", "assignment", "list",
    "--scope", scope,
    ...(principalId === undefined ? [] : ["--assignee-object-id", principalId]),
    "--fill-principal-name", "false",
    "--fill-role-definition-name", "false",
    "-o", "json",
  ]);
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

function checkpointPath(harness, runId, checkpointName) {
  const entry = readdirSync(path.join(harness.root, runId)).find((name) =>
    new RegExp(`^\\d{6}-${checkpointName}\\.json$`).test(name),
  );
  assert.ok(entry, `missing ${checkpointName} checkpoint`);
  return path.join(harness.root, runId, entry);
}

function rewriteManifestArgv(harness, runId, argv) {
  const runDirectory = path.join(harness.root, runId);
  const paths = harness.paths(runId);
  const manifestPath = harness.paths(runId).manifest;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.argv = argv;
  manifest.bindings.argv = argv;
  manifest.bindingSha256 = sha256Bytes(canonicalJson(manifest.bindings));
  replaceExisting(manifestPath, manifest);
  const manifestCheckpointPath = checkpointPath(harness, runId, "manifest");
  const manifestCheckpointSequence = JSON.parse(readFileSync(manifestCheckpointPath, "utf8")).sequence;

  for (const entry of readdirSync(runDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || /^\d{6}-[a-z0-9-]+\.json$/.test(entry.name)) continue;
    const filePath = path.join(runDirectory, entry.name);
    let value;
    try {
      value = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (value?.bindingSha256 !== undefined) {
      value.bindingSha256 = manifest.bindingSha256;
      replaceExisting(filePath, value);
    }
  }

  for (const entry of readdirSync(runDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d{6}-[a-z0-9-]+\.json$/.test(entry.name)) continue;
    const filePath = path.join(runDirectory, entry.name);
    const checkpoint = JSON.parse(readFileSync(filePath, "utf8"));
    if (checkpoint.name === "plan-started") checkpoint.argv = argv;
    if (checkpoint.name === "temp-plan") checkpoint.planSha256 = manifest.planSha256;
    if (checkpoint.name === "published-plan") {
      checkpoint.planSha256 = manifest.planSha256;
      checkpoint.planPath = paths.plan;
    }
    if (checkpoint.name === "terraform-exit-known" && checkpoint.sequence < manifestCheckpointSequence) {
      checkpoint.operation = "create";
      checkpoint.status = "success";
      checkpoint.exitCode = 0;
    }
    if (checkpoint.name === "manifest") {
      checkpoint.manifestSha256 = sha256File(manifestPath);
      checkpoint.planSha256 = manifest.planSha256;
    }
    if (checkpoint.name === "guard-receipt") {
      const receiptPath = existsSync(`${paths.guard}.consumed`) ? `${paths.guard}.consumed` : paths.guard;
      if (existsSync(receiptPath)) checkpoint.receiptSha256 = sha256File(receiptPath);
    }
    if (checkpoint.name === "preflight-receipt") {
      const receiptPath = existsSync(`${paths.preflight}.consumed`) ? `${paths.preflight}.consumed` : paths.preflight;
      if (existsSync(receiptPath)) checkpoint.receiptSha256 = sha256File(receiptPath);
    }
    if (checkpoint.name === "receipts-consumed") {
      checkpoint.guardReceiptSha256 = sha256File(`${paths.guard}.consumed`);
      checkpoint.preflightReceiptSha256 = sha256File(`${paths.preflight}.consumed`);
    }
    if (checkpoint.name === "apply-receipt") {
      checkpoint.receiptSha256 = sha256File(paths.apply);
    }
    if (checkpoint.name === "global-state-advancement") {
      checkpoint.applyReceiptSha256 = sha256File(paths.apply);
    }
    replaceExisting(filePath, checkpoint);
  }
}

function setProtectedRuntimeSecretsRole(harness, enabled) {
  replaceExisting(
    path.join(harness.workdir, "terraform.tfvars"),
    `enable_runtime_secrets_user_assignment = ${enabled ? "true" : "false"}\noperator_principal_id = "${OBJECT_ID}"\n`,
  );
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
  const planPath = path.join(runDirectory, "plan.tfplan");
  const planArgv = [
    "plan",
    "-refresh=true",
    "-input=false",
    "-lock=true",
    "-lock-timeout=5m",
    `-out=${planPath}`,
  ];
  const bindings = {
    repositoryCommit: COMMIT,
    argv: planArgv,
    backend: REAL_BACKEND.identity,
    liveRevision: "revision-before",
    runtimeIdentityId: RUNTIME_ID,
    runtimeIdentityClientId: RUNTIME_CLIENT,
    runtimeIdentityPrincipalId: RUNTIME_PRINCIPAL,
    accountId: FOUNDry_ACCOUNT_ID,
    runtimeOpenAiRoleAssignmentId: `${FOUNDry_ACCOUNT_ID}/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000020`,
  };
  const manifest = {
    version: 1,
    runId,
    phase,
    createdAt,
    processExit: 0,
    planSha256,
    argv: planArgv,
    bindings,
    bindingSha256: sha256Bytes(canonicalJson(bindings)),
  };
  writeExclusive(planPath, planText);
  writeExclusive(path.join(runDirectory, "create-manifest.json"), manifest);
  const show = reviewedRuntimeShow(phase);
  writeExclusive(path.join(runDirectory, "show.json"), show);
  const showSha256 = sha256Bytes(canonicalJson(show));
  const guard = {
    version: 1,
    type: "guard",
    runId,
    phase,
    planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt,
    guard: GUARD_MAPPINGS[phase],
    showSha256,
    guardArgv: [`--mode=${GUARD_MAPPINGS[phase]}`],
    stdinSha256: showSha256,
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
  if (phase === "credential-cleanup") writeSeedCleanupArtifacts(harness, runId);
  const checkpointNames = [
    "run-directory",
    "plan-started",
    "temp-plan",
    "published-plan",
    "terraform-exit-known",
    "manifest",
    "show-json",
    "guard-receipt",
    ...(phase === "credential-cleanup" ? ["vault-descriptor", "cleanup-start"] : []),
    "preflight-receipt",
    "applying",
    "receipts-consumed",
    "terraform-exit-ambiguous",
    "apply-receipt",
    "global-state-advancement",
  ];
  for (const [index, name] of checkpointNames.entries()) {
    const details = name === "plan-started"
      ? { argv: planArgv }
      : name === "temp-plan"
        ? { planSha256 }
      : name === "published-plan"
        ? { planSha256, planPath }
      : name === "terraform-exit-known"
        ? { operation: "create", status: "success", exitCode: 0 }
      : name === "guard-receipt"
      ? { receiptSha256: sha256Bytes(canonicalJson(guard)) }
      : name === "vault-descriptor"
        ? { descriptorSha256: sha256Bytes(readFileSync(harness.paths(runId).descriptor)) }
        : name === "cleanup-start"
          ? { cleanupOperationManifestSha256: sha256Bytes(readFileSync(harness.paths(runId).cleanupOperation)), guardReceiptSha256: sha256Bytes(canonicalJson(guard)) }
      : name === "preflight-receipt"
        ? {
            receiptSha256: sha256Bytes(canonicalJson(preflight)),
            ...(manifest.phase === "runtime-cutover"
              ? { diagnosticReceiptSha256: sha256Bytes(readFileSync(harness.paths(runId).diagnostic)) }
              : manifest.phase === "credential-cleanup"
                ? {
                    cleanupOperationManifestSha256: sha256Bytes(readFileSync(harness.paths(runId).cleanupOperation)),
                    absenceReceiptSha256: sha256Bytes(readFileSync(harness.paths(runId).absence)),
                  }
                : {}),
          }
        : name === "receipts-consumed"
          ? {
              guardReceiptSha256: sha256Bytes(canonicalJson(guard)),
              preflightReceiptSha256: sha256Bytes(canonicalJson(preflight)),
            }
            : name === "show-json"
              ? { showSha256 }
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
    lastCheckpoint: "global-state-advancement",
  });
  appendStateSnapshot(harness, state);
}

function forceUnknownRun(harness, runId) {
  const statePath = path.join(harness.root, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const run = state.runs.find((candidate) => candidate.id === runId);
  assert.ok(run);
  const manifest = JSON.parse(readFileSync(harness.paths(runId).manifest, "utf8"));
  if (!existsSync(harness.paths(runId).show)) writeExclusive(harness.paths(runId).show, reviewedRuntimeShow(manifest.phase));
  const checkpointNames = [
    "show-json",
    "guard-receipt",
    ...(manifest.phase === "credential-cleanup" ? ["vault-descriptor", "cleanup-start"] : []),
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
      : name === "vault-descriptor"
        ? { descriptorSha256: sha256Bytes(readFileSync(harness.paths(runId).descriptor)) }
        : name === "cleanup-start"
          ? { cleanupOperationManifestSha256: sha256Bytes(readFileSync(harness.paths(runId).cleanupOperation)), guardReceiptSha256: sha256Bytes(canonicalJson(guard)) }
      : name === "preflight-receipt"
        ? {
            receiptSha256: sha256Bytes(canonicalJson(preflight)),
            ...(manifest.phase === "runtime-cutover"
              ? { diagnosticReceiptSha256: sha256Bytes(readFileSync(harness.paths(runId).diagnostic)) }
                : manifest.phase === "credential-cleanup"
                ? {
                    cleanupOperationManifestSha256: sha256Bytes(readFileSync(harness.paths(runId).cleanupOperation)),
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
    path.join(harness.root, runId, `${String(7 + checkpointNames.length).padStart(6, "0")}-apply-receipt.json`),
    {
      version: 1,
      type: "lifecycle-checkpoint",
      sequence: 7 + checkpointNames.length,
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
  if (!existsSync(harness.paths(runId).show)) {
    writeExclusive(harness.paths(runId).show, reviewedRuntimeShow());
  }
  const showSha256 = sha256Bytes(readFileSync(harness.paths(runId).show, "utf8"));
  const reviewedDigest = sha256Bytes(canonicalJson({
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    argv: manifest.argv,
    showSha256,
  }));
  const requestId = "00000000-0000-4000-8000-000000000021";
  const identity = {
    resourceId: RUNTIME_ID,
    principalId: RUNTIME_PRINCIPAL,
    clientId: RUNTIME_CLIENT,
    planSha256: manifest.planSha256,
    job: { requestId, executionName: "palancar-runtime-diagnostic" },
  };
  const openAiRole = {
    id: `${FOUNDry_ACCOUNT_ID}/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000020`,
    principalId: RUNTIME_PRINCIPAL,
    principalType: "ServicePrincipal",
    roleDefinitionId: `/subscriptions/${SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`,
    scope: FOUNDry_ACCOUNT_ID,
  };
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
    imageDigest: REVIEWED_RELAY_IMAGE,
    digestCount: 1,
    reviewedDigest,
    submission: { requestId, executionName: "palancar-runtime-diagnostic", artifactSha256: reviewedDigest },
    request: { requestId, operation: "start", argv: ["node", "apps/relay/dist/azure-generation-diagnostic.js"] },
    activity: { requestId, status: "Succeeded", terminal: true },
    execution: {
      baseline: "pre-cutover",
      result: "passed",
      retryCount: 0,
      exitCode: 0,
      terminalResult: "succeeded",
    },
    identity: { before: identity, after: identity },
    openAiRole: { before: openAiRole, after: openAiRole },
    runtimeSecretReferences: [],
  }));
}

function writeCleanupArtifacts(harness, runId) {
  void harness;
  void runId;
}

function writeTerminalArtifacts(harness, runId) {
  const manifest = JSON.parse(readFileSync(harness.paths(runId).manifest, "utf8"));
  writeExclusive(path.join(harness.root, runId, "terminal-live-receipt.json"), protectedReceipt({
    version: 2,
    type: "live",
    status: "passed",
    operation: "terminal-live",
    runId,
    phase: manifest.phase,
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt: manifest.createdAt,
    repositoryCommit: manifest.bindings.repositoryCommit,
    contextSha256: manifest.bindingSha256,
  }));
}

function writeSeedCleanupArtifacts(harness, runId) {
  const paths = harness.paths(runId);
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
  const descriptor = {
    version: 1,
    type: "credential-cleanup-vault-descriptor",
    runId,
    phase: "credential-cleanup",
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    contextSha256: manifest.bindingSha256,
    vaultResourceId: KEY_VAULT_ID,
    vaultUri: `${KEY_VAULT_URI}/`,
    subscription: SUBSCRIPTION,
    tenant: TENANT,
    cloud: "AzureCloud",
    callerIdentity: { userType: "user", objectId: OBJECT_ID },
    targetNames: ["openrouter-api-key", "litellm-master-key"],
    startState: "start",
  };
  writeExclusive(paths.descriptor, descriptor);
  const unsignedOperation = {
    version: 2,
    type: "cleanup",
    status: "completed",
    operation: "credential-cleanup",
    runId,
    phase: "credential-cleanup",
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt: manifest.createdAt,
    repositoryCommit: manifest.bindings.repositoryCommit,
    contextSha256: manifest.bindingSha256,
    runtimeSecretReferences: [],
    supersession: null,
  };
  writeExclusive(paths.cleanupOperation, {
    ...unsignedOperation,
    sha256: sha256Bytes(canonicalJson(unsignedOperation)),
  });
  const unsignedAbsence = {
    version: 2,
    type: "absence",
    status: "absent",
    operation: "credential-cleanup",
    runId,
    phase: "credential-cleanup",
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt: manifest.createdAt,
    repositoryCommit: manifest.bindings.repositoryCommit,
    contextSha256: manifest.bindingSha256,
    inventory: { keyVault: "absent", runtimeSecretReferences: 0 },
    supersession: null,
  };
  writeExclusive(paths.absence, {
    ...unsignedAbsence,
    sha256: sha256Bytes(canonicalJson(unsignedAbsence)),
  });
  const stateInventory = {
    activeNames: ["openrouter-api-key", "litellm-master-key"],
    deletedNames: [],
    targetStates: ["openrouter-api-key", "litellm-master-key"].map((name) => ({ name, activeCount: 1, deletedCount: 0, state: "active" })),
  };
  const state0 = {
    version: 1,
    type: "key-vault-cleanup-state",
    runId,
    phase: "credential-cleanup",
    sequence: 0,
    status: "start-inventory-validated",
    attempts: 0,
    cumulativeElapsedMs: 0,
    attemptStartedAt: null,
    operationStartedAt: Date.now(),
    accountingCursor: Date.now(),
    retryNotBefore: null,
    absenceReceiptSha256: null,
    manifestSha256: sha256Bytes(readFileSync(paths.cleanupOperation)),
    inventory: stateInventory,
    inventorySha256: sha256Bytes(canonicalJson(stateInventory)),
    previousStateSha256: null,
    stateSha256: null,
  };
  state0.stateSha256 = sha256Bytes(canonicalJson(Object.fromEntries(Object.entries(state0).filter(([key]) => key !== "stateSha256"))));
  writeExclusive(paths.cleanupState, state0);
  const anchor0 = {
    version: 1,
    type: "key-vault-cleanup-state-anchor",
    runId,
    phase: "credential-cleanup",
    stateSequence: 0,
    stateSha256: state0.stateSha256,
    stateFileSha256: sha256Bytes(readFileSync(paths.cleanupState)),
    manifestSha256: state0.manifestSha256,
    anchorSha256: null,
  };
  anchor0.anchorSha256 = sha256Bytes(canonicalJson(Object.fromEntries(Object.entries(anchor0).filter(([key]) => key !== "anchorSha256"))));
  writeExclusive(paths.cleanupStateAnchor, anchor0);
  const completedInventory = {
    activeNames: [],
    deletedNames: [],
    targetStates: ["openrouter-api-key", "litellm-master-key"].map((name) => ({ name, activeCount: 0, deletedCount: 0, state: "absent" })),
  };
  const state1 = { ...state0, sequence: 1, status: "complete", absenceReceiptSha256: sha256Bytes(readFileSync(paths.absence)), inventory: completedInventory, inventorySha256: sha256Bytes(canonicalJson(completedInventory)), previousStateSha256: sha256Bytes(readFileSync(paths.cleanupState)), stateSha256: null };
  state1.stateSha256 = sha256Bytes(canonicalJson(Object.fromEntries(Object.entries(state1).filter(([key]) => key !== "stateSha256"))));
  writeExclusive(path.join(path.dirname(paths.cleanupState), "cleanup-state-000001.json"), state1);
  const anchor1 = { ...anchor0, stateSequence: 1, stateSha256: state1.stateSha256, stateFileSha256: sha256Bytes(readFileSync(path.join(path.dirname(paths.cleanupState), "cleanup-state-000001.json"))), anchorSha256: null };
  anchor1.anchorSha256 = sha256Bytes(canonicalJson(Object.fromEntries(Object.entries(anchor1).filter(([key]) => key !== "anchorSha256"))));
  writeExclusive(path.join(path.dirname(paths.cleanupState), "cleanup-state-anchor-000001.json"), anchor1);
}

function writeRevocationEvidence(harness) {
  const root = harness.root;
  const keySha256 = "b".repeat(64);
  const envPath = path.join(harness.workdir, ".env");
  const env = {
    path: envPath,
    sha256: "c".repeat(64),
    size: 1,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    mode: 0o600,
    dev: 1,
    ino: 1,
    assignment_count: 1,
    removed_sha256: "d".repeat(64),
    removed_size: 0,
  };
  const securityIdentity = {
    key_fingerprint: keySha256,
    provider_key_fingerprint: null,
    key_id: null,
    local_mask: "****",
    endpoint: "https://openrouter.ai/api/v1/key",
    endpoint_id: null,
    account_id: null,
    account_name: null,
    provider_stable_sha256: "e".repeat(64),
  };
  const responseSha256 = sha256Bytes(`${canonicalJson(securityIdentity)}\n`);
  const masked = { label: "****", expires_at: null, limit: null };
  const raw = { sha256: responseSha256, size: 1, uid: env.uid, gid: env.gid, mode: 0o600, dev: 1, ino: 1 };
  const removalIntent = { path: envPath, original_sha256: env.sha256, original_size: env.size, uid: env.uid, gid: env.gid, mode: env.mode, dev: env.dev, ino: env.ino, removed_sha256: env.removed_sha256, removed_size: env.removed_size, assignment_count: 1 };
  const base = { schema: 1, kind: "openrouter-revocation", response_sha256: responseSha256, key_sha256: keySha256, security_identity: securityIdentity, masked, captured_at: new Date().toISOString(), env, raw };
  const preflight = { ...base, state: "preflight-captured", raw: null };
  const captured = { ...base, state: "preflight-captured" };
  const awaiting = { ...captured, state: "awaiting-user" };
  const revoked = { ...base, state: "revoked", revoked_at: new Date().toISOString(), removal_intent: removalIntent };
  const localRemoved = { ...revoked, state: "local-removed", local_removed_at: new Date().toISOString() };
  [preflight, captured, awaiting, revoked, localRemoved].forEach((state, sequence) => {
    writeExclusive(
      path.join(root, sequence === 0 ? "openrouter-revocation-state.json" : `openrouter-revocation-state.json.seq-${String(sequence).padStart(8, "0")}`),
      state,
    );
  });
  writeExclusive(path.join(root, "openrouter-revocation-receipt.json"), {
    schema: 1,
    kind: "openrouter-revocation",
    state: "revoked",
    http_status: 401,
    response_sha256: responseSha256,
    recorded_at: new Date().toISOString(),
  });
  writeExclusive(path.join(root, "openrouter-revocation.lock"), "");
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
    if (phase === "credential-cleanup") harness.setRuntimeSecretsEnabled(false);
  }
  return runId;
}

function prepareInvalidatedLegacyModel(harness) {
  initialize(harness);
  const runId = harness.lifecycle.create("model-bootstrap").runId;
  harness.lifecycle.guard("model-bootstrap", runId);
  harness.lifecycle.preflight("model-bootstrap", runId);
  harness.advance(2 * 60 * 1000 + 1);
  expectCode(() => harness.lifecycle.apply("model-bootstrap", runId), "preflight-expired");
  const manifest = JSON.parse(readFileSync(harness.paths(runId).manifest, "utf8"));
  rewriteManifestArgv(harness, runId, manifest.argv.map((argument) =>
    argument === `-out=${harness.paths(runId).plan}`
      ? `-out=${harness.paths(runId).planTemp}`
      : argument,
  ));
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

function prepareRuntimeGuarded(harness) {
  initialize(harness);
  advanceThrough(harness, "model-bootstrap");
  const runtime = harness.lifecycle.create("runtime-cutover");
  harness.lifecycle.guard("runtime-cutover", runtime.runId);
  return runtime.runId;
}

function prepareTerminal(harness) {
  initialize(harness);
  advanceThrough(harness, "model-bootstrap");
  advanceThrough(harness, "runtime-cutover");
  setProtectedRuntimeSecretsRole(harness, false);
  advanceThrough(harness, "credential-cleanup");
  writeRevocationEvidence(harness);
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
  harness.setRevision("revision-after");
  harness.setRuntimeSecretsEnabled(false);
  seedAppliedPhase(harness, "credential-cleanup", "seed-credential", "runtime-applied", "credentials-and-RBAC-cleaned");
  writeRevocationEvidence(harness);
  const terminal = harness.lifecycle.create("terminal");
  harness.lifecycle.guard("terminal", terminal.runId);
  writeTerminalArtifacts(harness, terminal.runId);
  return terminal.runId;
}

function prepareCredential(harness) {
  initialize(harness);
  advanceThrough(harness, "model-bootstrap");
  advanceThrough(harness, "runtime-cutover");
  setProtectedRuntimeSecretsRole(harness, false);
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
  harness.setLiveRevisionMutator((active) => [active, retainedRuntimePredecessorRevision()]);
  forceUnknownRun(harness, runtime.runId);
  return runtime.runId;
}

function prepareCredentialReconcile(harness) {
  initialize(harness);
  seedAppliedPhase(harness, "model-bootstrap", "seed-model", "manual-Luna-absent", "model-applied");
  seedAppliedPhase(harness, "runtime-cutover", "seed-runtime", "model-applied", "runtime-applied");
  harness.setTopology("post");
  harness.setRevision("revision-after");
  setProtectedRuntimeSecretsRole(harness, false);
  harness.setRuntimeSecretsEnabled(false);
  const cleanup = harness.lifecycle.create("credential-cleanup");
  writeSeedCleanupArtifacts(harness, cleanup.runId);
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
  for (const value of ["protected-test-token-value-1234567890"]) {
    assert.equal(processEvidence.includes(value), false);
    assert.equal(artifacts.includes(value), false);
    assert.equal(String(error?.message ?? error?.code ?? "").includes(value), false);
  }
}

test("diagnostic invoking is a durable exactly-once fence and reconciles absolute Azure pagination", () => {
  const harness = makeHarness();
  try {
    const runId = prepareRuntimeGuarded(harness);
    harness.setDiagnosticStartStatus("ambiguous");
    harness.setDiagnosticRestMode("empty");
    expectCode(() => harness.lifecycle.diagnostic("runtime-cutover", runId), "diagnostic-start-unknown");
    const startCallsAfterAmbiguous = harness.calls.filter(
      (call) => call.command === "/usr/bin/az" && call.argv[0] === "containerapp" &&
        call.argv[1] === "job" && call.argv[2] === "start",
    );
    assert.equal(startCallsAfterAmbiguous.length, 1);
    assert.equal(startCallsAfterAmbiguous[0].argv.includes("--registry-identity"), false);
    assert.deepEqual(
      startCallsAfterAmbiguous[0].argv.slice(startCallsAfterAmbiguous[0].argv.indexOf("--command"), startCallsAfterAmbiguous[0].argv.indexOf("--env-vars")),
      ["--command", "node", "--args", "apps/relay/dist/azure-generation-diagnostic.js"],
    );
    assert.equal(existsSync(harness.paths(runId).diagnosticIntent), true);
    assert.equal(existsSync(harness.paths(runId).diagnosticInvoking), true);
    assert.equal(existsSync(harness.paths(runId).diagnosticSubmission), false);

    harness.setDiagnosticRestMode("absolute-match");
    assert.deepEqual(harness.lifecycle.diagnostic("runtime-cutover", runId), {
      runId,
      phase: "runtime-cutover",
      status: "diagnostic-passed",
      execution: "diagnostic-execution-1",
    });
    const artifactPaths = [
      harness.paths(runId).diagnosticIntent,
      harness.paths(runId).diagnosticInvoking,
      harness.paths(runId).diagnosticSubmission,
      harness.paths(runId).diagnostic,
    ];
    const artifactHashes = artifactPaths.map((filePath) => sha256Bytes(readFileSync(filePath)));
    assert.equal(harness.calls.filter((call) => call.argv[2] === "start").length, 1);
    assert.equal(harness.calls.some((call) => call.argv[0] === "rest" && call.argv.join(" ").includes("management.azure.com")), true);

    assert.deepEqual(harness.lifecycle.diagnostic("runtime-cutover", runId), {
      runId,
      phase: "runtime-cutover",
      status: "diagnostic-passed",
      execution: "existing",
    });
    assert.deepEqual(artifactPaths.map((filePath) => sha256Bytes(readFileSync(filePath))), artifactHashes);
    assert.equal(harness.calls.filter((call) => call.argv[2] === "start").length, 1);
  } finally {
    harness.cleanup();
  }
});

test("diagnostic refreshes runtime identity after terminal execution and never replays start", () => {
  const harness = makeHarness();
  try {
    const runId = prepareRuntimeGuarded(harness);
    const diagnosticCallStart = harness.calls.length;
    harness.setDiagnosticRestMode("absolute-match");
    assert.deepEqual(harness.lifecycle.diagnostic("runtime-cutover", runId), {
      runId,
      phase: "runtime-cutover",
      status: "diagnostic-passed",
      execution: "diagnostic-execution-1",
    });
    const diagnosticCalls = harness.calls.slice(diagnosticCallStart);
    const identityShows = diagnosticCalls.filter((call) =>
      call.argv[0] === "identity" && call.argv[1] === "show" && call.argv[call.argv.indexOf("--ids") + 1] === RUNTIME_ID);
    const jobShowIndex = diagnosticCalls.findIndex((call) =>
      call.argv[0] === "containerapp" && call.argv[1] === "job" && call.argv[2] === "show");
    const executionShowIndex = diagnosticCalls.findIndex((call) =>
      call.argv[0] === "containerapp" && call.argv[1] === "job" && call.argv[2] === "execution");
    const startCalls = diagnosticCalls.filter((call) =>
      call.argv[0] === "containerapp" && call.argv[1] === "job" && call.argv[2] === "start");
    const roleQueries = diagnosticCalls.filter((call) =>
      call.argv[0] === "role" && call.argv[1] === "assignment" && call.argv[2] === "list" &&
      call.argv.includes("--assignee-object-id"));
    assert.equal(identityShows.length, 2);
    assert.ok(identityShows[0] !== undefined);
    assert.ok(identityShows[1] !== undefined);
    assert.ok(diagnosticCalls.indexOf(identityShows[0]) < jobShowIndex);
    assert.ok(jobShowIndex < executionShowIndex);
    assert.ok(executionShowIndex < diagnosticCalls.indexOf(identityShows[1]));
    assert.equal(roleQueries.length, 2);
    assert.ok(startCalls[0] !== undefined);
    assert.ok(diagnosticCalls.indexOf(roleQueries[0]) < diagnosticCalls.indexOf(startCalls[0]));
    assert.ok(executionShowIndex < diagnosticCalls.indexOf(roleQueries[1]));
    assert.equal(startCalls.length, 1);
  } finally {
    harness.cleanup();
  }

  for (const failure of [
    {
      configure(harness) {
        harness.setDiagnosticRuntimeIdentityMutator((identity, count) => count === 2
          ? { ...identity, principalId: "00000000-0000-0000-0000-000000000099" }
          : identity);
      },
    },
    {
      configure(harness) { harness.setDiagnosticPostRuntimeIdentityStatus("missing"); },
    },
    {
      configure(harness) { harness.setDiagnosticPostRuntimeIdentityStatus("ambiguous"); },
    },
  ]) {
    const failed = makeHarness();
    try {
      const failedRunId = prepareRuntimeGuarded(failed);
      failed.setDiagnosticRestMode("absolute-match");
      failure.configure(failed);
      expectCode(() => failed.lifecycle.diagnostic("runtime-cutover", failedRunId), "diagnostic-identity");
      assert.equal(failed.calls.filter((call) =>
        call.argv[0] === "identity" && call.argv[1] === "show" && call.argv[call.argv.indexOf("--ids") + 1] === RUNTIME_ID).length, 2);
      assert.equal(failed.calls.filter((call) =>
        call.argv[0] === "containerapp" && call.argv[1] === "job" && call.argv[2] === "start").length, 1);
      assert.equal(existsSync(failed.paths(failedRunId).diagnostic), false);
    } finally {
      failed.cleanup();
    }
  }
});

test("diagnostic identity proofs case-fold resource IDs and retain Terraform canonical receipts", () => {
  const harness = makeHarness();
  try {
    const uppercaseResourceId = (identity) => ({ ...identity, id: identity.id.toUpperCase() });
    const runId = prepareRuntimeGuarded(harness);
    harness.setDiagnosticRuntimeIdentityMutator(uppercaseResourceId);
    harness.setDiagnosticImagePullIdentityMutator(uppercaseResourceId);
    harness.setDiagnosticRestMode("absolute-match");

    assert.deepEqual(harness.lifecycle.diagnostic("runtime-cutover", runId), {
      runId,
      phase: "runtime-cutover",
      status: "diagnostic-passed",
      execution: "diagnostic-execution-1",
    });

    const receipt = JSON.parse(readFileSync(harness.paths(runId).diagnostic, "utf8"));
    assert.equal(receipt.identity.before.resourceId, RUNTIME_ID);
    assert.equal(receipt.identity.after.resourceId, RUNTIME_ID);
  } finally {
    harness.cleanup();
  }
});

test("diagnostic identity proofs reject changed resource-ID segments and exact UUID mismatches", () => {
  const resourceIdMutations = [
    (id) => id.replace(`/subscriptions/${SUBSCRIPTION}/`, `/subscriptions/${"0".repeat(SUBSCRIPTION.length)}/`),
    (id) => id.replace("/resourceGroups/rg-runtime/", "/resourceGroups/rg-other/"),
    (id) => id.replace("/providers/Microsoft.ManagedIdentity/", "/providers/Microsoft.Other/"),
    (id) => id.replace("/userAssignedIdentities/runtime", "/systemAssignedIdentities/runtime"),
    (id) => id.replace(/\/runtime$/, "/runtime-other"),
  ];
  for (const mutateResourceId of resourceIdMutations) {
    const harness = makeHarness();
    try {
      const runId = prepareRuntimeGuarded(harness);
      harness.setDiagnosticRuntimeIdentityMutator((identity) => ({
        ...identity,
        id: mutateResourceId(identity.id),
      }));
      expectCode(() => harness.lifecycle.diagnostic("runtime-cutover", runId), "diagnostic-identity");
      assert.equal(existsSync(harness.paths(runId).diagnosticIntent), false);
    } finally {
      harness.cleanup();
    }
  }

  for (const mutateIdentity of [
    (identity) => ({ ...identity, clientId: RUNTIME_CLIENT.replace("12", "99") }),
    (identity) => ({ ...identity, principalId: RUNTIME_PRINCIPAL.replace("13", "99") }),
  ]) {
    const harness = makeHarness();
    try {
      const runId = prepareRuntimeGuarded(harness);
      harness.setDiagnosticRuntimeIdentityMutator(mutateIdentity);
      expectCode(() => harness.lifecycle.diagnostic("runtime-cutover", runId), "diagnostic-identity");
      assert.equal(existsSync(harness.paths(runId).diagnosticIntent), false);
    } finally {
      harness.cleanup();
    }
  }
});

test("diagnostic Job contract accepts display regions and omitted null container fields", () => {
  const harness = makeHarness();
  try {
    const runId = prepareRuntimeGuarded(harness);
    harness.setDiagnosticJobMutator((job) => {
      const next = structuredClone(job);
      next.location = "East US 2";
      delete next.properties.template.containers[0].command;
      delete next.properties.template.containers[0].args;
      delete next.properties.template.containers[0].probes;
      return next;
    });
    assert.deepEqual(harness.lifecycle.diagnostic("runtime-cutover", runId), {
      runId,
      phase: "runtime-cutover",
      status: "diagnostic-passed",
      execution: "diagnostic-execution-1",
    });
  } finally {
    harness.cleanup();
  }
});

test("diagnostic reconciliation rejects a canonical nextLink cycle without retrying start", () => {
  const harness = makeHarness();
  try {
    const runId = prepareRuntimeGuarded(harness);
    harness.setDiagnosticStartStatus("ambiguous");
    harness.setDiagnosticRestMode("cycle");
    expectCode(() => harness.lifecycle.diagnostic("runtime-cutover", runId), "diagnostic-execution-pagination");
    assert.equal(harness.calls.filter((call) => call.argv[2] === "start").length, 1);
    assert.equal(existsSync(harness.paths(runId).diagnosticInvoking), true);
    assert.equal(existsSync(harness.paths(runId).diagnosticSubmission), false);
  } finally {
    harness.cleanup();
  }
});

test("diagnostic Job contract requires the complete Azure CLI live schema before intent or start", () => {
  for (const mutate of [
    (job) => { job.properties.provisioningState = "Creating"; },
    (job) => { job.properties.runningStatus = "Running"; },
    (job) => { job.properties.runningState = "Running"; },
    (job) => { job.location = "westus"; },
    (job) => { job.location = "East-US-2"; },
    (job) => { job.location = "East  US 2"; },
    (job) => { job.location = " East US 2"; },
    (job) => { job.location = "eastus\u00002"; },
    (job) => { job.resourceGroup = "rg-other"; },
    (job) => { job.tags.environment = "prod"; },
    (job) => { job.tags.forged = "unexpected"; },
    (job) => { job.properties.outboundIpAddresses = []; },
    (job) => { job.properties.outboundIpAddresses = ["not-an-ip"]; },
    (job) => { job.properties.outboundIpAddresses = ["20.42.8.12", "20.42.8.13"]; },
    ...[
      "10.1.2.3", "172.16.1.1", "192.168.1.1", "127.0.0.1", "169.254.1.1",
      "100.64.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
      "192.31.196.0", "192.31.196.255", "192.52.193.0", "192.52.193.255",
      "192.175.48.0", "192.175.48.255", "224.0.0.1", "240.0.0.1", "0.0.0.0", "255.255.255.255",
    ].map((address) => (job) => { job.properties.outboundIpAddresses = [address]; }),
    (job) => { job.properties.eventStreamEndpoint = "not-an-endpoint"; },
    (job) => { job.properties.eventStreamEndpoint = "https://attacker.example.invalid/subscriptions/" + SUBSCRIPTION + "/resourceGroups/rg-runtime/containerApps/cleanup-job/eventstream"; },
    (job) => { job.properties.eventStreamEndpoint = "https://eastus2.azurecontainerapps.dev/subscriptions/" + SUBSCRIPTION + "/resourceGroups/rg-runtime/jobs/cleanup-job/eventstream"; },
    (job) => { job.properties.eventStreamEndpoint = "https://eastus2.azurecontainerapps.dev:444/subscriptions/" + SUBSCRIPTION + "/resourceGroups/rg-runtime/containerApps/cleanup-job/eventstream"; },
    (job) => { job.properties.eventStreamEndpoint = "https://user:password@eastus2.azurecontainerapps.dev/subscriptions/" + SUBSCRIPTION + "/resourceGroups/rg-runtime/containerApps/cleanup-job/eventstream"; },
    (job) => { job.properties.eventStreamEndpoint = "https://eastus2.azurecontainerapps.dev/subscriptions/" + SUBSCRIPTION + "/resourceGroups/rg-runtime/containerApps/cleanup-job/eventstream?unexpected=1"; },
    (job) => { job.properties.eventStreamEndpoint = "https://eastus2.azurecontainerapps.dev/subscriptions/" + SUBSCRIPTION + "/resourceGroups/rg-runtime/containerApps/cleanup-job/eventstream#unexpected"; },
    (job) => { delete job.systemData; },
    (job) => { delete job.systemData.createdAt; },
    (job) => { job.systemData.password = "unexpected"; },
    (job) => { job.systemData.createdAt = "not-a-time"; },
    (job) => { job.systemData.lastModifiedAt = "2026-08-21T23:59:59Z"; },
    (job) => { job.systemData.createdByType = "Application"; },
    (job) => { job.systemData.lastModifiedByType = "ServicePrincipal"; },
    (job) => { job.systemData.createdBy = "00000000-0000-4000-8000-000000000003"; },
    (job) => { job.systemData.lastModifiedBy = "different-user"; },
    (job) => { job.properties.configuration.scheduleTriggerConfig.cronExpression = "0 * * * *"; },
    (job) => { job.properties.configuration.dapr = {}; },
    (job) => { job.properties.configuration.eventTriggerConfig = {}; },
    (job) => { job.properties.configuration.manualTriggerConfig = {}; },
    (job) => { job.properties.configuration.secrets = []; },
    (job) => { job.properties.configuration.registries[0].username = "unexpected"; },
    (job) => { job.properties.configuration.registries[0].passwordSecretRef = "unexpected"; },
    (job) => { job.properties.template.containers[0].env[0].value = "00000000-0000-0000-0000-000000000099"; },
    (job) => { job.properties.template.containers[0].env[5].value = "wss://attacker.example.invalid"; },
    (job) => { job.properties.template.containers[0].env[6].value = "1001"; },
    (job) => { job.properties.template.containers[0].env.pop(); },
    (job) => { job.properties.template.containers[0].env.push({ name: "PASSWORD", value: "unexpected" }); },
    (job) => { job.properties.template.containers[0].image = "palancardevacraeeacd8c.azurecr.io/other@sha256:" + "c".repeat(64); },
    (job) => { job.identity.userAssignedIdentities[IMAGE_PULL_ID].clientId = "00000000-0000-0000-0000-000000000099"; },
    (job) => { job.identity.userAssignedIdentities[RUNTIME_ID].principalId = "00000000-0000-0000-0000-000000000099"; },
    (job) => { job.identity.userAssignedIdentities[RUNTIME_ID].extra = "unexpected"; },
    (job) => { job.properties.template.initContainers = []; },
    (job) => { job.properties.template.volumes = []; },
    (job) => { job.properties.template.containers[0].imageType = "Docker"; },
    (job) => { job.properties.template.containers[0].command = []; },
    (job) => { job.properties.template.containers[0].args = []; },
    (job) => { job.properties.template.containers[0].probes = []; },
    (job) => { job.properties.template.containers[0].unexpected = null; },
    (job) => { job.properties.template.containers[0].resources.ephemeralStorage = "2Gi"; },
    (job) => { job.properties.workloadProfileName = "Consumption"; },
    (job) => { delete job.resourceGroup; },
    (job) => { delete job.properties.outboundIpAddresses; },
    (job) => {
      delete job.location;
      delete job.resourceGroup;
      delete job.tags;
      delete job.systemData;
      delete job.properties.runningStatus;
      delete job.properties.eventStreamEndpoint;
      delete job.properties.outboundIpAddresses;
      delete job.properties.workloadProfileName;
      delete job.properties.configuration.dapr;
      delete job.properties.configuration.secrets;
      delete job.properties.template.initContainers;
      delete job.properties.template.volumes;
      delete job.properties.template.containers[0].imageType;
    },
  ]) {
    const harness = makeHarness();
    try {
      const runId = prepareRuntimeGuarded(harness);
      harness.setDiagnosticJobMutator((job) => {
        const next = structuredClone(job);
        mutate(next);
        return next;
      });
      expectCode(() => harness.lifecycle.diagnostic("runtime-cutover", runId), "diagnostic-job");
      assert.equal(existsSync(harness.paths(runId).diagnosticIntent), false);
      assert.equal(harness.calls.some((call) => call.argv[0] === "containerapp" && call.argv[1] === "job" && call.argv[2] === "start"), false);
    } finally {
      harness.cleanup();
    }
  }
});

test("diagnostic Job contract accepts only adjacent globally routable IPv4 boundaries", () => {
  for (const address of [
    "192.0.1.1",
    "192.31.195.255", "192.31.197.1",
    "192.52.192.255", "192.52.194.1",
    "192.175.47.255", "192.175.49.1",
    "198.17.255.255", "198.20.0.1",
  ]) {
    const harness = makeHarness();
    try {
      const runId = prepareRuntimeGuarded(harness);
      harness.setDiagnosticJobMutator((job) => {
        const next = structuredClone(job);
        next.properties.outboundIpAddresses = [address];
        return next;
      });
      harness.setDiagnosticRestMode("absolute-match");
      assert.deepEqual(harness.lifecycle.diagnostic("runtime-cutover", runId), {
        runId,
        phase: "runtime-cutover",
        status: "diagnostic-passed",
        execution: "diagnostic-execution-1",
      });
    } finally {
      harness.cleanup();
    }
  }
});

test("diagnostic reconciliation fails closed at the 32-page cap even with an earlier match", () => {
  const harness = makeHarness();
  try {
    const runId = prepareRuntimeGuarded(harness);
    harness.setDiagnosticStartStatus("ambiguous");
    harness.setDiagnosticRestMode("cap-exhaustion");
    expectCode(() => harness.lifecycle.diagnostic("runtime-cutover", runId), "diagnostic-execution-pagination");
    assert.equal(harness.calls.filter((call) => call.argv[2] === "start").length, 1);
    assert.equal(harness.calls.filter((call) => call.argv[0] === "rest").length, 32);
  } finally {
    harness.cleanup();
  }
});

test("diagnostic submission and polling share one bounded end-to-end deadline", () => {
  const harness = makeHarness();
  try {
    const runId = prepareRuntimeGuarded(harness);
    harness.setDiagnosticStartClockAdvance(300 * 1000 + 1);
    expectCode(() => harness.lifecycle.diagnostic("runtime-cutover", runId), "diagnostic-execution-timeout");
    assert.equal(harness.calls.filter((call) => call.argv[2] === "start").length, 1);
    assert.equal(harness.calls.some((call) => call.argv[0] === "containerapp" && call.argv[1] === "job" && call.argv[2] === "execution"), false);
  } finally {
    harness.cleanup();
  }
});

test("reviewed latest-revision ingress normalizes only to a concrete live revision", () => {
  const happy = makeHarness();
  try {
    const runId = prepareRuntime(happy);
    assert.deepEqual(happy.lifecycle.preflight("runtime-cutover", runId), {
      runId,
      phase: "runtime-cutover",
      status: "preflighted",
    });
  } finally {
    happy.cleanup();
  }

  for (const mutate of [
    (show) => {
      for (const entry of show.resource_changes) {
        if (entry.address === "module.container_app_workload[0].azapi_resource.this") {
          entry.change.after.body.properties.configuration.ingress.traffic[0].latestRevision = false;
          entry.change.before.body.properties.configuration.ingress.traffic[0].latestRevision = false;
        }
      }
      for (const root of [show.prior_state.values.root_module, show.planned_values.root_module]) {
        root.resources[0].values.body.properties.configuration.ingress.traffic[0].latestRevision = false;
      }
    },
    (show) => {
      for (const entry of show.resource_changes) {
        if (entry.address === "module.container_app_workload[0].azapi_resource.this") {
          for (const side of [entry.change.before, entry.change.after]) {
            side.body.properties.configuration.ingress.traffic[0].revisionName = "substituted-revision";
            delete side.body.properties.configuration.ingress.traffic[0].latestRevision;
          }
        }
      }
      for (const root of [show.prior_state.values.root_module, show.planned_values.root_module]) {
        root.resources[0].values.body.properties.configuration.ingress.traffic[0].revisionName = "substituted-revision";
        delete root.resources[0].values.body.properties.configuration.ingress.traffic[0].latestRevision;
      }
    },
  ]) {
    const negative = makeHarness();
    try {
      negative.setReviewedShowMutator((show) => {
        const next = structuredClone(show);
        mutate(next);
        return next;
      });
      const runId = prepareRuntime(negative);
      expectCode(() => negative.lifecycle.preflight("runtime-cutover", runId), "runtime-topology");
    } finally {
      negative.cleanup();
    }
  }
});

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
    }, "runtime-revisions-template"],
    ["wrong full image digest", (containers) => {
      containers.find((container) => container.name === "relay").image =
        "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:" + "0".repeat(64);
    }, "runtime-topology"],
    ["extra container", (containers) => {
      containers.push({ name: "helper", image: REVIEWED_RELAY_IMAGE, env: [] });
    }, "runtime-topology"],
    ["unexpected secret", (containers) => {
      containers[1].env.push({ name: "UNEXPECTED_SECRET", secretRef: "retired-secret" });
    }, "runtime-topology"],
  ];
  for (const [label, mutate, code] of topologyCases) {
    const negative = makeHarness();
    try {
      const runId = prepareRuntime(negative);
      mutateBoth(negative, (value) => mutatePreTopology(value, mutate));
      assert.throws(() => negative.lifecycle.preflight("runtime-cutover", runId), (error) => {
        if (error?.code !== code) throw new Error(`${label}: expected ${code}, got ${error?.code}`);
        return true;
      });
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
    ["replacement diagnostic", (receipt) => { receipt.imageDigest = REVIEWED_RELAY_IMAGE.replace(/c{6}/, "000000"); }, "diagnostic-receipt-context"],
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

test("reviewed cutover fixtures enforce move-before-delete and direct one-container topology", () => {
  const appAddress = "module.container_app_workload[0].azapi_resource.this";
  const roleAddress = "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user[0]";
  const priorRoleAddress = "module.workload_key_vault.azurerm_role_assignment.runtime_secrets_user";
  const runtimeApp = REVIEWED_RUNTIME_FIXTURE.resource_changes.find((entry) => entry.address === appAddress);
  const runtimeRole = REVIEWED_RUNTIME_FIXTURE.resource_changes.find((entry) => entry.address === roleAddress);
  const credentialApp = REVIEWED_CREDENTIAL_FIXTURE.resource_changes.find((entry) => entry.address === appAddress);
  const credentialRole = REVIEWED_CREDENTIAL_FIXTURE.resource_changes.find((entry) => entry.address === roleAddress);
  assert.deepEqual(runtimeApp.change.actions, ["update"]);
  assert.equal(runtimeApp.change.before.body.properties.template.containers.length, 2);
  assert.equal(runtimeApp.change.after.body.properties.template.containers.length, 1);
  assert.equal(
    runtimeApp.change.after.body.properties.template.containers[0].image,
    FIXTURE_REVIEWED_RELAY_IMAGE,
  );
  assert.deepEqual(runtimeApp.change.after.body.properties.configuration.secrets, []);
  assert.equal(runtimeApp.change.after.body.properties.configuration.maxInactiveRevisions, 1);
  assert.deepEqual(runtimeRole.change.actions, ["no-op"]);
  assert.equal(runtimeRole.previous_address, priorRoleAddress);
  assert.deepEqual(credentialApp.change.actions, ["no-op"]);
  assert.deepEqual(credentialRole.change.actions, ["delete"]);
  assert.equal(Object.hasOwn(credentialRole, "previous_address"), false);
  assert.doesNotMatch(JSON.stringify(runtimeApp.change.after), /LIT(?:ELLM)|OPEN(?:ROUTER)/i);
  assert.doesNotMatch(JSON.stringify(REVIEWED_CREDENTIAL_FIXTURE), /LIT(?:ELLM)|OPEN(?:ROUTER)/i);
});

test("real credential cleanup plan is phase-bound to an exact no-op topology", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "palancar-reviewed-credential-"));
  const showPath = path.join(directory, "show.json");
  try {
    writeExclusive(showPath, REVIEWED_CREDENTIAL_FIXTURE);
    const reviewed = reviewedRuntimeShapes({ show: showPath }, "credential-cleanup");
    assert.equal(reviewed.before.containers.length, 1);
    assert.deepEqual(reviewed.before, reviewed.after);

    const update = structuredClone(REVIEWED_CREDENTIAL_FIXTURE);
    update.resource_changes.find(
      (entry) => entry.address === "module.container_app_workload[0].azapi_resource.this",
    ).change.actions = ["update"];
    replaceExisting(showPath, update);
    expectCode(
      () => reviewedRuntimeShapes({ show: showPath }, "credential-cleanup"),
      "diagnostic-plan-topology",
    );

    const cleanupUpdate = structuredClone(REVIEWED_CREDENTIAL_FIXTURE);
    cleanupUpdate.resource_changes.find(
      (entry) => entry.address === "module.expiry_cleanup_job[0].azapi_resource.this",
    ).change.actions = ["update"];
    replaceExisting(showPath, cleanupUpdate);
    expectCode(
      () => reviewedRuntimeShapes({ show: showPath }, "credential-cleanup"),
      "diagnostic-plan-topology",
    );

    const cleanupEnvDrift = structuredClone(REVIEWED_CREDENTIAL_FIXTURE);
    cleanupEnvDrift.resource_changes.find(
      (entry) => entry.address === "module.expiry_cleanup_job[0].azapi_resource.this",
    ).change.after.body.properties.template.containers[0].env[0].value =
      "00000000-0000-0000-0000-000000000099";
    replaceExisting(showPath, cleanupEnvDrift);
    expectCode(
      () => reviewedRuntimeShapes({ show: showPath }, "credential-cleanup"),
      "diagnostic-plan-topology",
    );

    const drift = structuredClone(REVIEWED_CREDENTIAL_FIXTURE);
    const appChange = drift.resource_changes.find(
      (entry) => entry.address === "module.container_app_workload[0].azapi_resource.this",
    ).change;
    appChange.after.body.properties.template.containers[0].image =
      `${appChange.after.body.properties.template.containers[0].image.slice(0, -64)}${"0".repeat(64)}`;
    replaceExisting(showPath, drift);
    expectCode(
      () => reviewedRuntimeShapes({ show: showPath }, "credential-cleanup"),
      "diagnostic-plan-topology",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime post reconciliation retains the real predecessor contract and isolates active retired references", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "palancar-reviewed-runtime-"));
  const showPath = path.join(directory, "show.json");
  try {
    writeExclusive(showPath, REVIEWED_RUNTIME_FIXTURE);
    const reviewed = reviewedRuntimeShapes({ show: showPath }, "runtime-cutover");
    const appChange = REVIEWED_RUNTIME_FIXTURE.resource_changes.find(
      (entry) => entry.address === "module.container_app_workload[0].azapi_resource.this",
    ).change;
    const predecessorTemplate = structuredClone(appChange.before.body.properties.template);
    assert.doesNotThrow(() => assertInactiveRevisionTemplate(
      predecessorTemplate,
      reviewed,
      "post",
      "runtime-revisions-inactive",
    ));
    for (const mutate of [
      (template) => { template.containers[0].image = `${template.containers[0].image.slice(0, -64)}${"0".repeat(64)}`; },
      (template) => { template.scale.minReplicas = 2; },
    ]) {
      const negative = structuredClone(predecessorTemplate);
      mutate(negative);
      expectCode(
        () => assertInactiveRevisionTemplate(negative, reviewed, "post", "runtime-revisions-inactive"),
        "runtime-revisions-inactive",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  for (const mutate of [
    (predecessor) => { predecessor.name = "wrong-predecessor"; predecessor.id = predecessor.id.replace(/\/revisions\/[^/]+$/, "/revisions/wrong-predecessor"); },
    (predecessor) => { predecessor.properties.trafficWeight = 1; },
    (predecessor) => { predecessor.properties.replicaCount = 1; },
  ]) {
    const harness = makeHarness();
    try {
      const runId = prepareRuntimeReconcile(harness);
      harness.setTopology("post");
      harness.setSerial(8);
      harness.setLiveRevisionMutator((active) => {
        const predecessor = retainedRuntimePredecessorRevision();
        mutate(predecessor);
        return [active, predecessor];
      });
      expectCode(() => harness.lifecycle.reconcile("runtime-cutover", runId), "reconcile-unknown");
    } finally {
      harness.cleanup();
    }
  }

  const activeNegative = makeHarness();
  try {
    const runId = prepareRuntimeReconcile(activeNegative);
    activeNegative.setTopology("post");
    activeNegative.setSerial(8);
    const addRetiredReference = (container) => {
      container.env.push({ name: "LEGACY_RUNTIME_SECRET", secretRef: "openrouter-api-key" });
    };
    activeNegative.setLiveAppMutator((app) => {
      const next = structuredClone(app);
      addRetiredReference(next.properties.template.containers[0]);
      return next;
    });
    activeNegative.setLiveRevisionMutator((active) => {
      const next = structuredClone(active);
      addRetiredReference(next.properties.template.containers[0]);
      return [next, retainedRuntimePredecessorRevision()];
    });
    expectCode(() => activeNegative.lifecycle.reconcile("runtime-cutover", runId), "reconcile-unknown");
  } finally {
    activeNegative.cleanup();
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
    const operation = JSON.parse(readFileSync(happy.paths(runId).cleanupOperation, "utf8"));
    assert.deepEqual(Object.keys(operation).sort(), [
      "bindingSha256", "contextSha256", "createdAt", "operation", "phase", "planSha256",
      "repositoryCommit", "runId", "runtimeSecretReferences", "sha256", "status", "supersession", "type", "version",
    ].sort());
    happy.lifecycle.apply("credential-cleanup", runId);
    const absence = JSON.parse(readFileSync(happy.paths(runId).absence, "utf8"));
    assert.equal(absence.type, "absence");
    assert.equal(absence.inventory.keyVault, "absent");
    assert.equal(happy.httpCalls.length, 0);
    assertSensitiveValuesClosed(happy);
  } finally {
    happy.cleanup();
  }

  const appCases = [
    ["API-key env", (value) => {
      value.properties.template.containers[0].env.push({ name: "AZURE_API_KEY", value: "redacted" });
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
});

test("A3 Key Vault direct data-plane absence, pagination, and secret evidence stay closed", () => {
  const happy = makeHarness();
  try {
    const runId = prepareCredential(happy);
    happy.setTopology("post");
    happy.lifecycle.preflight("credential-cleanup", runId);
    assert.deepEqual(happy.httpCalls.map((call) => call.method), []);
    assertSensitiveValuesClosed(happy);
  } finally {
    happy.cleanup();
  }

});

test("credential cleanup binds the retained predecessor to the completed runtime run", () => {
  const happy = makeHarness();
  try {
    const runId = prepareCredential(happy);
    happy.setTopology("post");
    assert.deepEqual(happy.lifecycle.preflight("credential-cleanup", runId), {
      runId,
      phase: "credential-cleanup",
      status: "preflighted",
    });
  } finally {
    happy.cleanup();
  }

  const revisionCases = [
    ["name", (revision) => {
      revision.name = "revision-substituted";
      revision.id = revision.id.replace(/\/revisions\/[^/]+$/, "/revisions/revision-substituted");
    }],
    ["topology", (revision) => {
      revision.properties.template.containers[0].image =
        `${revision.properties.template.containers[0].image.slice(0, -64)}${"0".repeat(64)}`;
    }],
    ["traffic", (revision) => { revision.properties.trafficWeight = 1; }],
    ["replicas", (revision) => { revision.properties.replicaCount = 1; }],
  ];
  for (const [, mutate] of revisionCases) {
    const negative = makeHarness();
    try {
      const runId = prepareCredential(negative);
      negative.setTopology("post");
      negative.setLiveRevisionMutator((active) => {
        const predecessor = retainedRuntimePredecessorRevision();
        mutate(predecessor);
        return [active, predecessor];
      });
      expectCode(
        () => negative.lifecycle.preflight("credential-cleanup", runId),
        "credential-revisions-inactive",
      );
    } finally {
      negative.cleanup();
    }
  }

  for (const [label, mutate, expected] of [
    ["missing", (revisions) => revisions.slice(0, 1), "credential-revisions-inactive"],
    ["extra", (revisions) => [...revisions, structuredClone(revisions[1])], "credential-revisions-set"],
  ]) {
    void label;
    const negative = makeHarness();
    try {
      const runId = prepareCredential(negative);
      negative.setTopology("post");
      negative.setLiveRevisionMutator((active) => {
        const revisions = [active, retainedRuntimePredecessorRevision()];
        return mutate(revisions);
      });
      expectCode(() => negative.lifecycle.preflight("credential-cleanup", runId), expected);
    } finally {
      negative.cleanup();
    }
  }

  const evidenceNegative = makeHarness();
  try {
    const runId = prepareCredential(evidenceNegative);
    const runtime = evidenceNegative.lifecycle.readState().runs.find(
      (run) => run.phase === "runtime-cutover" && run.status === "applied",
    );
    assert.ok(runtime);
    const showPath = evidenceNegative.paths(runtime.id).show;
    const show = JSON.parse(readFileSync(showPath, "utf8"));
    const change = show.resource_changes.find(
      (entry) => entry.address === "module.container_app_workload[0].azapi_resource.this",
    ).change;
    change.before.body.properties.template.containers[0].image =
      `${change.before.body.properties.template.containers[0].image.slice(0, -64)}${"0".repeat(64)}`;
    replaceExisting(showPath, show);
    assert.throws(
      () => evidenceNegative.lifecycle.preflight("credential-cleanup", runId),
      (error) => error?.code === "diagnostic-plan-topology",
    );
  } finally {
    evidenceNegative.cleanup();
  }
});

test("active revision validation covers the complete reviewed template in both post phases", () => {
  const mutations = [
    ["cpu", (template) => { template.containers[0].resources.cpu = 0.5; }],
    ["memory", (template) => { template.containers[0].resources.memory = "1Gi"; }],
    ["command", (template) => { template.containers[0].command = ["node", "changed"]; }],
    ["args", (template) => { template.containers[0].args = ["changed"]; }],
    ["probe", (template) => { template.containers[0].probes = [{ type: "Readiness", httpGet: { path: "/changed", port: 8787 } }]; }],
    ["scale", (template) => { template.scale.maxReplicas = 2; }],
  ];

  for (const [label, mutate] of mutations) {
    const runtime = makeHarness();
    try {
      const runId = prepareRuntimeReconcile(runtime);
      runtime.setTopology("post");
      runtime.setSerial(8);
      runtime.setLiveRevisionMutator((active) => {
        const next = structuredClone(active);
        mutate(next.properties.template);
        return [next, retainedRuntimePredecessorRevision()];
      });
      expectCode(() => runtime.lifecycle.reconcile("runtime-cutover", runId), "reconcile-unknown");
    } finally {
      runtime.cleanup();
    }

    const credential = makeHarness();
    try {
      const runId = prepareCredential(credential);
      credential.setTopology("post");
      credential.setLiveRevisionMutator((active) => {
        const next = structuredClone(active);
        mutate(next.properties.template);
        return [next, retainedRuntimePredecessorRevision()];
      });
      expectCode(
        () => credential.lifecycle.preflight("credential-cleanup", runId),
        "credential-revisions-template",
      );
    } finally {
      credential.cleanup();
    }
    void label;
  }
});

test("protected role flags and the prior apply proof gate lifecycle boundaries", () => {
  {
    const harness = makeHarness();
    try {
      initialize(harness);
      advanceThrough(harness, "model-bootstrap");
      setProtectedRuntimeSecretsRole(harness, false);
      expectCode(() => harness.lifecycle.create("runtime-cutover"), "runtime-secrets-role-disabled");
    } finally {
      harness.cleanup();
    }
  }
  {
    const harness = makeHarness();
    try {
      const runId = prepareRuntime(harness);
      setProtectedRuntimeSecretsRole(harness, false);
      expectCode(() => harness.lifecycle.preflight("runtime-cutover", runId), "runtime-secrets-role-disabled");
    } finally {
      harness.cleanup();
    }
  }
  {
    const harness = makeHarness();
    try {
      const runId = prepareRuntime(harness);
      harness.lifecycle.preflight("runtime-cutover", runId);
      setProtectedRuntimeSecretsRole(harness, false);
      expectCode(() => harness.lifecycle.apply("runtime-cutover", runId), "runtime-secrets-role-disabled");
      assert.equal(
        harness.calls.filter((call) => call.argv[0] === "apply" && call.phase === "runtime-cutover").length,
        0,
      );
    } finally {
      harness.cleanup();
    }
  }
  {
    const harness = makeHarness();
    try {
      const runId = prepareCredential(harness);
      setProtectedRuntimeSecretsRole(harness, true);
      harness.setTopology("post");
      expectCode(() => harness.lifecycle.preflight("credential-cleanup", runId), "runtime-secrets-role-enabled");
    } finally {
      harness.cleanup();
    }
  }
  {
    const harness = makeHarness();
    try {
      initialize(harness);
      seedAppliedPhase(harness, "model-bootstrap", "seed-model", "manual-Luna-absent", "model-applied");
      seedAppliedPhase(harness, "runtime-cutover", "seed-runtime", "model-applied", "runtime-applied");
      const state = harness.lifecycle.readState();
      state.runs.find((run) => run.id === "seed-runtime").lastCheckpoint = "apply-receipt";
      appendStateSnapshot(harness, state);
      setProtectedRuntimeSecretsRole(harness, false);
      expectCode(() => harness.lifecycle.create("credential-cleanup"), "phase-apply-proof");
    } finally {
      harness.cleanup();
    }
  }
});

test("scoped role-assignment proofs use exact-scope argv at every lifecycle call site", () => {
  const runtime = makeHarness();
  try {
    initialize(runtime);
    const calls = roleAssignmentCalls(runtime);
    assert.ok(calls.length >= 1);
    for (const call of calls) assertExactScopedRoleAssignmentArgv(call, FOUNDry_ACCOUNT_ID);
  } finally {
    runtime.cleanup();
  }

  const diagnostic = makeHarness();
  try {
    const runId = prepareRuntimeGuarded(diagnostic);
    const start = diagnostic.calls.length;
    assert.deepEqual(diagnostic.lifecycle.diagnostic("runtime-cutover", runId), {
      runId,
      phase: "runtime-cutover",
      status: "diagnostic-passed",
      execution: "diagnostic-execution-1",
    });
    const calls = roleAssignmentCalls(diagnostic, start);
    assert.equal(calls.filter((call) => call.argv.includes("--assignee-object-id")).length, 2);
    for (const call of calls) {
      assertExactScopedRoleAssignmentArgv(
        call,
        FOUNDry_ACCOUNT_ID,
        call.argv.includes("--assignee-object-id") ? RUNTIME_PRINCIPAL : undefined,
      );
    }
  } finally {
    diagnostic.cleanup();
  }

  const credential = makeHarness();
  try {
    const runId = prepareCredentialReconcile(credential);
    const start = credential.calls.length;
    credential.setSerial(8);
    assert.deepEqual(credential.lifecycle.reconcile("credential-cleanup", runId), {
      runId,
      phase: "credential-cleanup",
      status: "applied",
      state: "credentials-and-RBAC-cleaned",
    });
    const calls = roleAssignmentCalls(credential, start).filter(
      (call) => call.argv.includes("--assignee-object-id"),
    );
    assert.equal(calls.length, 2);
    assertExactScopedRoleAssignmentArgv(calls[0], KEY_VAULT_ID, RUNTIME_PRINCIPAL);
    assertExactScopedRoleAssignmentArgv(calls[1], FOUNDry_ACCOUNT_ID, RUNTIME_PRINCIPAL);
  } finally {
    credential.cleanup();
  }

  const terminal = makeHarness();
  try {
    const runId = prepareTerminal(terminal);
    const start = terminal.calls.length;
    assert.equal(terminal.lifecycle.finalize("terminal", runId).status, "finalized");
    const calls = roleAssignmentCalls(terminal, start).filter(
      (call) => call.argv.includes("--assignee-object-id"),
    );
    assert.equal(calls.length, 2);
    assertExactScopedRoleAssignmentArgv(calls[0], KEY_VAULT_ID, RUNTIME_PRINCIPAL);
    assertExactScopedRoleAssignmentArgv(calls[1], FOUNDry_ACCOUNT_ID, RUNTIME_PRINCIPAL);
  } finally {
    terminal.cleanup();
  }
});

test("scoped role-assignment proofs accept full records but reject missing, malformed, or incorrect security fields", () => {
  const runtimeMutations = [
    (assignment) => {
      const next = { ...assignment };
      delete next.id;
      return next;
    },
    (assignment) => ({ ...assignment, principalId: 42 }),
    (assignment) => ({ ...assignment, roleDefinitionId: `${assignment.roleDefinitionId}-wrong` }),
    (assignment) => ({ ...assignment, scope: `${assignment.scope}/wrong` }),
  ];
  for (const mutate of runtimeMutations) {
    const runtime = makeHarness();
    try {
      runtime.setRoleListMutator((assignments, request) => request.argv.includes("--assignee-object-id")
        ? assignments
        : assignments.map(mutate));
      expectCode(() => initialize(runtime), "runtime-openai-role");
    } finally {
      runtime.cleanup();
    }
  }

  const diagnostic = makeHarness();
  try {
    const runId = prepareRuntimeGuarded(diagnostic);
    diagnostic.setRoleMutator((assignments) => assignments.map((assignment) => ({
      ...assignment,
      roleDefinitionId: `${assignment.roleDefinitionId}-wrong`,
    })));
    expectCode(() => diagnostic.lifecycle.diagnostic("runtime-cutover", runId), "diagnostic-openai-role");
  } finally {
    diagnostic.cleanup();
  }

  const rbacMutations = [
    (assignment) => {
      const next = { ...assignment };
      delete next.principalId;
      return next;
    },
    (assignment) => ({ ...assignment, principalId: 42 }),
    (assignment) => ({ ...assignment, roleDefinitionId: `${assignment.roleDefinitionId}-wrong` }),
    (assignment) => ({ ...assignment, scope: `${assignment.scope}/wrong` }),
  ];
  for (const mutate of rbacMutations) {
    const credential = makeHarness();
    try {
      const runId = prepareCredentialReconcile(credential);
      credential.setSerial(8);
      credential.setRoleMutator((assignments, request) => request.argv.includes("--assignee-object-id")
        ? assignments.map(mutate)
        : assignments);
      expectCode(() => credential.lifecycle.reconcile("credential-cleanup", runId), "reconcile-unknown");
    } finally {
      credential.cleanup();
    }

    const terminal = makeHarness();
    try {
      const runId = prepareTerminal(terminal);
      terminal.setRoleMutator((assignments, request) => request.argv.includes("--assignee-object-id")
        ? assignments.map(mutate)
        : assignments);
      expectCode(() => terminal.lifecycle.finalize("terminal", runId), "terminal-openai-rbac");
    } finally {
      terminal.cleanup();
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
    const inventory = terminal.receiptInventory.map(({ label }) => ({
      label,
      sha256: sha256Bytes(readFileSync(path.join(happy.root, label))),
    }));
    assert.equal(terminal.receiptSetSha256, sha256Bytes(canonicalJson(inventory)));
    assert.equal(inventory.some(({ label }) => label.endsWith("/diagnostic-receipt.json")), true);
    assert.equal(inventory.some(({ label }) => label.endsWith("/cleanup-absence-receipt.json")), true);
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
      expectCode(() => negative.lifecycle.readState(), "live-receipt-context");
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
        next.properties.template.containers[0].env.push({ name: "PALANCAR_AZURE_GENERATION_DEPLOYMENT", value: "gpt-4o" });
        return next;
      };
      negative.setLiveAppMutator(mutate);
      negative.setLiveRevisionMutator(mutate);
      assert.throws(() => negative.lifecycle.finalize("terminal", runId), (error) => {
        assert.match(error?.code ?? "", /^credential-/);
        return true;
      });
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

test("real Luna guard entrypoint is executable under the closed child environment", () => {
  const guardStat = lstatSync(REAL_GUARD_PATH);
  assert.equal(guardStat.isFile(), true);
  assert.equal(guardStat.isSymbolicLink(), false);
  assert.notEqual(guardStat.mode & 0o111, 0);

  const runDirectory = mkdtempSync(path.join(tmpdir(), "palancar-lifecycle-guard-run-"));
  chmodSync(runDirectory, 0o700);
  try {
    const child = spawnSync(REAL_GUARD_PATH, ["--mode=luna-model-bootstrap"], {
      cwd: REPO_ROOT,
      env: buildChildEnvironment(runDirectory, {}),
      encoding: "utf8",
      input: REVIEWED_LUNA_FIXTURE_TEXT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.equal(child.status, 0);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, "");
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
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
    749257,
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

test("applied historical model manifest temp argv migrates before runtime creation", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const modelRunId = advanceThrough(harness, "model-bootstrap");
    const manifest = JSON.parse(readFileSync(harness.paths(modelRunId).manifest, "utf8"));
    const legacyArgv = manifest.argv.map((argument) =>
      argument === `-out=${harness.paths(modelRunId).plan}`
        ? `-out=${harness.paths(modelRunId).planTemp}`
        : argument,
    );
    rewriteManifestArgv(harness, modelRunId, legacyArgv);

    assert.equal(harness.lifecycle.readState().state, "model-applied");
    const runtime = harness.lifecycle.create("runtime-cutover");
    assert.equal(runtime.phase, "runtime-cutover");
    assert.equal(runtime.status, "created");
  } finally {
    harness.cleanup();
  }
});

test("invalidated historical model temp argv is closed and does not replace an applied predecessor", () => {
  const harness = makeHarness();
  try {
    const invalidatedRunId = prepareInvalidatedLegacyModel(harness);

    const invalidated = harness.lifecycle.readState().runs.find((run) => run.id === invalidatedRunId);
    assert.equal(invalidated.status, "invalidated");
    assert.equal(invalidated.lastCheckpoint, "preflight-receipt");

    const appliedRunId = advanceThrough(harness, "model-bootstrap");
    const appliedManifest = JSON.parse(readFileSync(harness.paths(appliedRunId).manifest, "utf8"));
    rewriteManifestArgv(harness, appliedRunId, appliedManifest.argv.map((argument) =>
      argument === `-out=${harness.paths(appliedRunId).plan}`
        ? `-out=${harness.paths(appliedRunId).planTemp}`
        : argument,
    ));

    assert.equal(harness.lifecycle.readState().state, "model-applied");
    assert.equal(harness.lifecycle.create("runtime-cutover").status, "created");
  } finally {
    harness.cleanup();
  }
});

test("invalidated legacy model history requires coherent closure evidence", () => {
  const cases = [
    ["missing invalidated checkpoint", "checkpoint-integrity", (harness, runId) => {
      rmSync(checkpointPath(harness, runId, "invalidated"));
    }],
    ["invalidated reason", "invalidated-history", (harness, runId) => {
      const filePath = checkpointPath(harness, runId, "invalidated");
      const checkpoint = JSON.parse(readFileSync(filePath, "utf8"));
      replaceExisting(filePath, { ...checkpoint, reason: "forged-reason" });
    }],
    ["invalidated last checkpoint", "invalidated-history", (harness, runId) => {
      const filePath = checkpointPath(harness, runId, "invalidated");
      const checkpoint = JSON.parse(readFileSync(filePath, "utf8"));
      replaceExisting(filePath, { ...checkpoint, lastCheckpoint: "manifest" });
    }],
    ["state last checkpoint", "invalidated-history", (harness, runId) => {
      const state = harness.lifecycle.readState();
      state.runs.find((run) => run.id === runId).lastCheckpoint = "manifest";
      appendStateSnapshot(harness, state);
    }],
  ];

  for (const [label, code, tamper] of cases) {
    const harness = makeHarness();
    try {
      const runId = prepareInvalidatedLegacyModel(harness);
      tamper(harness, runId);
      expectCode(() => harness.lifecycle.readState(), code);
    } finally {
      harness.cleanup();
    }
    void label;
  }
});

test("invalidated legacy model history accepts protected optional checkpoint provenance", () => {
  const cases = [
    ["state retains durable checkpoint", (harness, runId) => {
      const filePath = checkpointPath(harness, runId, "invalidated");
      const checkpoint = JSON.parse(readFileSync(filePath, "utf8"));
      delete checkpoint.lastCheckpoint;
      replaceExisting(filePath, checkpoint);
      const run = harness.lifecycle.readState().runs.find((candidate) => candidate.id === runId);
      assert.equal(run.status, "invalidated");
      assert.equal(run.lastCheckpoint, "preflight-receipt");
    }],
    ["both durable checkpoints absent", (harness, runId) => {
      const checkpointPathname = checkpointPath(harness, runId, "invalidated");
      const checkpoint = JSON.parse(readFileSync(checkpointPathname, "utf8"));
      delete checkpoint.lastCheckpoint;
      replaceExisting(checkpointPathname, checkpoint);
      const state = harness.lifecycle.readState();
      delete state.runs.find((candidate) => candidate.id === runId).lastCheckpoint;
      appendStateSnapshot(harness, state);
      const run = harness.lifecycle.readState().runs.find((candidate) => candidate.id === runId);
      assert.equal(run.status, "invalidated");
      assert.equal(run.lastCheckpoint, undefined);
    }],
  ];

  for (const [label, verify] of cases) {
    const harness = makeHarness();
    try {
      const runId = prepareInvalidatedLegacyModel(harness);
      verify(harness, runId);
    } finally {
      harness.cleanup();
    }
    void label;
  }
});

test("legacy manifest argv stays fail-closed for new runs and arbitrary applied argv", () => {
  const createdHarness = makeHarness();
  try {
    initialize(createdHarness);
    const created = createdHarness.lifecycle.create("model-bootstrap");
    const manifest = JSON.parse(readFileSync(createdHarness.paths(created.runId).manifest, "utf8"));
    rewriteManifestArgv(createdHarness, created.runId, manifest.argv.map((argument) =>
      argument === `-out=${createdHarness.paths(created.runId).plan}`
        ? `-out=${createdHarness.paths(created.runId).planTemp}`
        : argument,
    ));
    expectCode(() => createdHarness.lifecycle.guard("model-bootstrap", created.runId), "manifest-mismatch");
  } finally {
    createdHarness.cleanup();
  }

  const appliedHarness = makeHarness();
  try {
    initialize(appliedHarness);
    const runId = advanceThrough(appliedHarness, "model-bootstrap");
    const manifest = JSON.parse(readFileSync(appliedHarness.paths(runId).manifest, "utf8"));
    rewriteManifestArgv(appliedHarness, runId, manifest.argv.map((argument) =>
      argument === `-out=${appliedHarness.paths(runId).plan}`
        ? `-out=${appliedHarness.paths(runId).unexpectedPlan}`
        : argument,
    ));
    expectCode(() => appliedHarness.lifecycle.create("runtime-cutover"), "manifest-mismatch");
  } finally {
    appliedHarness.cleanup();
  }
});

test("legacy applied model argv requires every immutable plan and apply proof", () => {
  const cases = [
    ["published-plan", "checkpoint-integrity", (harness, runId) => {
      const filePath = checkpointPath(harness, runId, "published-plan");
      const checkpoint = JSON.parse(readFileSync(filePath, "utf8"));
      replaceExisting(filePath, { ...checkpoint, planSha256: "b".repeat(64) });
    }],
    ["manifest", "manifest-hash", (harness, runId) => {
      const filePath = checkpointPath(harness, runId, "manifest");
      const checkpoint = JSON.parse(readFileSync(filePath, "utf8"));
      replaceExisting(filePath, { ...checkpoint, manifestSha256: "b".repeat(64) });
    }],
    ["binding argv", "binding-hash", (harness, runId) => {
      const filePath = harness.paths(runId).manifest;
      const manifest = JSON.parse(readFileSync(filePath, "utf8"));
      manifest.bindings.argv = manifest.argv.map((argument) =>
        argument === `-out=${harness.paths(runId).planTemp}`
          ? `-out=${harness.paths(runId).plan}`
          : argument,
      );
      manifest.bindingSha256 = sha256Bytes(canonicalJson(manifest.bindings));
      replaceExisting(filePath, manifest);
      const manifestCheckpointPath = checkpointPath(harness, runId, "manifest");
      const manifestCheckpoint = JSON.parse(readFileSync(manifestCheckpointPath, "utf8"));
      replaceExisting(manifestCheckpointPath, { ...manifestCheckpoint, manifestSha256: sha256File(filePath) });
    }],
    ["plan-started argv", "checkpoint-integrity", (harness, runId) => {
      const filePath = checkpointPath(harness, runId, "plan-started");
      const checkpoint = JSON.parse(readFileSync(filePath, "utf8"));
      replaceExisting(filePath, { ...checkpoint, argv: ["plan", "-out=forged.tfplan"] });
    }],
    ["temp-plan hash", "checkpoint-integrity", (harness, runId) => {
      const filePath = checkpointPath(harness, runId, "temp-plan");
      const checkpoint = JSON.parse(readFileSync(filePath, "utf8"));
      replaceExisting(filePath, { ...checkpoint, planSha256: "b".repeat(64) });
    }],
    ["published-plan path", "checkpoint-integrity", (harness, runId) => {
      const filePath = checkpointPath(harness, runId, "published-plan");
      const checkpoint = JSON.parse(readFileSync(filePath, "utf8"));
      replaceExisting(filePath, { ...checkpoint, planPath: `${harness.paths(runId).plan}.forged` });
    }],
    ["create exit evidence", "checkpoint-integrity", (harness, runId) => {
      const filePath = checkpointPath(harness, runId, "terraform-exit-known");
      const checkpoint = JSON.parse(readFileSync(filePath, "utf8"));
      replaceExisting(filePath, { ...checkpoint, status: "failure" });
    }],
    ["apply receipt", "apply-mismatch", (harness, runId) => {
      const filePath = harness.paths(runId).apply;
      const receipt = JSON.parse(readFileSync(filePath, "utf8"));
      replaceExisting(filePath, { ...receipt, appliedAt: new Date(Date.parse(receipt.appliedAt) + 1000).toISOString() });
    }],
    ["global advancement", "phase-apply-proof", (harness, runId) => {
      const filePath = checkpointPath(harness, runId, "global-state-advancement");
      const checkpoint = JSON.parse(readFileSync(filePath, "utf8"));
      replaceExisting(filePath, { ...checkpoint, to: "runtime-applied" });
    }],
    ["binding", "binding-hash", (harness, runId) => {
      const filePath = harness.paths(runId).manifest;
      const manifest = JSON.parse(readFileSync(filePath, "utf8"));
      manifest.bindings.repositoryCommit = "0".repeat(40);
      replaceExisting(filePath, manifest);
      const checkpointPathValue = checkpointPath(harness, runId, "manifest");
      const checkpoint = JSON.parse(readFileSync(checkpointPathValue, "utf8"));
      replaceExisting(checkpointPathValue, { ...checkpoint, manifestSha256: sha256File(filePath) });
    }],
    ["plan", "plan-hash", (harness, runId) => {
      replaceExisting(harness.paths(runId).plan, "tampered plan\n");
    }],
  ];

  for (const [label, code, tamper] of cases) {
    const harness = makeHarness();
    try {
      initialize(harness);
      const runId = advanceThrough(harness, "model-bootstrap");
      const manifest = JSON.parse(readFileSync(harness.paths(runId).manifest, "utf8"));
      rewriteManifestArgv(harness, runId, manifest.argv.map((argument) =>
        argument === `-out=${harness.paths(runId).plan}`
          ? `-out=${harness.paths(runId).planTemp}`
          : argument,
      ));
      tamper(harness, runId);
      expectCode(() => harness.lifecycle.readState(), code);
    } finally {
      harness.cleanup();
    }
    void label;
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
    ["quota-localized-bad", "model-quota"],
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
    harness.setLiveRevisionMutator((active) => [active, retainedRuntimePredecessorRevision()]);
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

test("B2a repeated unknown reconciliation appends sequenced receipts and never reapplies", () => {
  const harness = makeHarness();
  try {
    const runId = prepareRuntimeReconcile(harness);
    harness.setTopology("post");
    harness.setLiveRevisionMutator((value) => [value, structuredClone(value)]);
    const applyCalls = harness.calls.filter((call) => call.argv[0] === "apply").length;
    expectCode(() => harness.lifecycle.reconcile("runtime-cutover", runId), "reconcile-unknown");
    expectCode(() => harness.lifecycle.reconcile("runtime-cutover", runId), "reconcile-unknown");
    const reconcileFiles = readdirSync(path.join(harness.root, runId))
      .filter((entry) => /^reconcile-receipt-\d{6}\.json$/.test(entry))
      .sort();
    assert.deepEqual(reconcileFiles, [
      "reconcile-receipt-000001.json",
      "reconcile-receipt-000002.json",
    ]);
    assert.deepEqual(reconcileFiles.map((entry) => JSON.parse(readFileSync(path.join(harness.root, runId, entry), "utf8")).status), [
      "unknown",
      "unknown",
    ]);
    assert.equal(harness.calls.filter((call) => call.argv[0] === "apply").length, applyCalls);
    assert.equal(harness.lifecycle.readState().runs.find((run) => run.id === runId).status, "unknown");
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
    expectCode(() => harness.lifecycle.readState(), "terminal-receipt-inventory");
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
    setProtectedRuntimeSecretsRole(harness, false);
    advanceThrough(harness, "credential-cleanup");
    const terminal = harness.lifecycle.create("terminal");
    harness.lifecycle.guard("terminal", terminal.runId);
    writeRevocationEvidence(harness);
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
      next.properties.template.containers.push({ name: "extra", image: REVIEWED_RELAY_IMAGE, env: [] });
      return next;
    }, "credential-revisions-template"],
    [(value) => {
      const next = structuredClone(value);
      next.properties.template.containers[0].env.push({ name: "AZURE_API_KEY", value: "redacted" });
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
      next.properties.template.containers[0].env.push({ name: "AZURE_API_KEY", value: "redacted" });
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
      assert.equal(guard.input, JSON.stringify(reviewedRuntimeShow(phase)));
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
      assert.equal(count("/usr/bin/git", "rev-parse"), 7);
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
    setProtectedRuntimeSecretsRole(harness, false);
    const old = harness.lifecycle.create("credential-cleanup");
    expectCode(() => harness.lifecycle.supersede("credential-cleanup", old.runId), "out-of-order-operation");
    harness.lifecycle.guard("credential-cleanup", old.runId);
    harness.setTopology("post");
    harness.lifecycle.preflight("credential-cleanup", old.runId);
    harness.advance(30 * 60 * 1000 + 1);
    expectCode(() => harness.lifecycle.apply("credential-cleanup", old.runId), "plan-expired");
    harness.options.lowLevel.cleanupRunner({ operation: "resume", runId: old.runId, root: harness.root });
    const cleanupPath = harness.paths(old.runId).cleanupOperation;
    const cleanup = JSON.parse(readFileSync(cleanupPath, "utf8"));
    replaceExisting(cleanupPath, { ...cleanup, runId: "wrong-run" });
    expectCode(() => harness.lifecycle.supersede("credential-cleanup", old.runId), "cleanup-operation-context");
    replaceExisting(cleanupPath, cleanup);
    const replacement = harness.lifecycle.supersede("credential-cleanup", old.runId);
    assert.equal(replacement.supersedes, old.runId);
    const replacementManifest = JSON.parse(readFileSync(harness.paths(replacement.runId).manifest, "utf8"));
    assert.deepEqual(replacementManifest.supersession, {
      oldRunId: old.runId,
      cleanupManifestSha256: sha256Bytes(readFileSync(harness.paths(old.runId).cleanupOperation)),
      absenceReceiptSha256: sha256Bytes(readFileSync(harness.paths(old.runId).absence)),
      contextSha256: JSON.parse(readFileSync(harness.paths(old.runId).manifest, "utf8")).bindingSha256,
    });
    expectCode(() => harness.lifecycle.supersede("credential-cleanup", old.runId), "out-of-order-operation");
  } finally {
    harness.cleanup();
  }
});

test("external closure is create-only, resumable, exact-root, and deleted", () => {
  const harness = makeHarness();
  try {
    const runId = prepareTerminal(harness);
    harness.lifecycle.finalize("terminal", runId);
    assert.deepEqual(harness.lifecycle.close("terminal", runId), { status: "deleted" });
    assert.equal(existsSync(harness.root), false);
    assert.equal(existsSync(path.join(harness.closure, "closure-tombstone.json")), true);
    assert.equal(existsSync(path.join(harness.closure, "closure-inventory.json")), true);
    assert.equal(existsSync(path.join(harness.closure, "closure-state-000000.json")), true);
    assert.equal(existsSync(path.join(harness.closure, "closure-state-000001.json")), true);
    assert.deepEqual(harness.lifecycle.close("terminal", runId), { status: "deleted" });
    expectCode(() => harness.lifecycle.readState(), "closure-present");
    expectCode(() => harness.lifecycle.create("terminal"), "closure-present");
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

test("Sol probe: revocation producer sequence names and interrupted owned manifests register", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const token = "0123456789abcdef01234567";
    const stateTarget = "openrouter-revocation-state.json.seq-00000001";
    const temporary = `${stateTarget}.tmp-123-${token}`;
    writeExclusive(
      path.join(harness.root, `openrouter-revocation-owned-temp-123-${token}.json`),
      {
        schema: 1,
        kind: "openrouter-revocation-temp-manifest",
        operation_kind: "state",
        target: stateTarget,
        temporary,
        sha256: sha256Bytes("temp"),
        size: 4,
        pid: 123,
      },
    );
    writeExclusive(path.join(harness.root, temporary), "temp");
    writeExclusive(
      path.join(harness.root, "openrouter-revocation-owned-temp-124-abcdefabcdefabcdefabcdef.json"),
      "",
    );
    assert.doesNotThrow(() => harness.lifecycle.readState());

    writeExclusive(path.join(harness.root, `${stateTarget}.tmp-125-${token}`), "foreign");
    expectCode(() => harness.lifecycle.readState(), "revocation-temporary-manifest");
  } finally {
    harness.cleanup();
  }
});

test("Sol probe: an orphaned reconcile receipt has no checkpoint bijection", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    const runId = harness.lifecycle.create("model-bootstrap").runId;
    forceUnknownRun(harness, runId);
    harness.setModelCase("luna-present");
    harness.setSerial(8);
    harness.lifecycle.reconcile("model-bootstrap", runId);
    writeExclusive(harness.paths(runId).reconcile.replace("000001", "000002"), {
      version: 1,
      type: "reconcile",
    });
    expectCode(() => harness.lifecycle.readState(), "reconcile-receipt-checkpoint");
  } finally {
    harness.cleanup();
  }
});

test("Sol probe: diagnostic identity proof cannot be arbitrary equal before and after", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    advanceThrough(harness, "model-bootstrap");
    const runId = harness.lifecycle.create("runtime-cutover").runId;
    harness.lifecycle.guard("runtime-cutover", runId);
    writeRuntimeDiagnostic(harness, runId);
    replaceProtectedReceipt(harness.paths(runId).diagnostic, (receipt) => {
      receipt.identity.before.principalId = "00000000-0000-4000-8000-000000000099";
      receipt.identity.after.principalId = "00000000-0000-4000-8000-000000000099";
    });
    expectCode(() => harness.lifecycle.preflight("runtime-cutover", runId), "diagnostic-identity");
  } finally {
    harness.cleanup();
  }
});

test("Sol probe: inactive revisions accept only reviewed secret-free structures", () => {
  const harness = makeHarness();
  try {
    initialize(harness);
    advanceThrough(harness, "model-bootstrap");
    const runId = harness.lifecycle.create("runtime-cutover").runId;
    harness.lifecycle.guard("runtime-cutover", runId);
    writeRuntimeDiagnostic(harness, runId);
    harness.setLiveRevisionMutator((active) => {
      const inactive = structuredClone(active);
      inactive.name = "revision-inactive";
      inactive.id = inactive.id.replace(/\/revisions\/[^/]+$/, "/revisions/revision-inactive");
      inactive.properties.active = false;
      inactive.properties.trafficWeight = 0;
      inactive.properties.template.containers[0].image = `${REVIEWED_RELAY_IMAGE.slice(0, -64)}${"c".repeat(64)}`;
      return [active, inactive];
    });
    expectCode(() => harness.lifecycle.preflight("runtime-cutover", runId), "runtime-revisions-inactive");
  } finally {
    harness.cleanup();
  }
});

test("Sol probe: terminal inventory closes over every predecessor journal and auxiliary", () => {
  const harness = makeHarness();
  try {
    const runId = prepareTerminalFromSeed(harness);
    harness.lifecycle.finalize("terminal", runId);
    const inventory = JSON.parse(readFileSync(harness.paths(runId).terminal, "utf8")).receiptInventory;
    const labels = new Set(inventory.map((entry) => entry.label));
    assert.equal([...labels].some((label) => label.startsWith("seed-model/")), true);
    assert.equal([...labels].some((label) => label.endsWith("/diagnostic-receipt.json")), true);
    assert.equal(labels.has("seed-credential/cleanup-state-anchor-000001.json"), true);
    assert.equal(labels.has("openrouter-revocation-state.json.seq-00000004"), true);
    assert.equal(labels.has("openrouter-revocation.lock"), true);
  } finally {
    harness.cleanup();
  }
});

test("Sol probe: plan artifact hashing uses the 64 MiB plan ceiling", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "palancar-plan-limit-"));
  const filePath = path.join(directory, "plan.tfplan");
  const bytes = Buffer.alloc(9 * 1024 * 1024, 0x70);
  const fd = openSync(filePath, "wx", 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  try {
    assert.equal(sha256File(filePath), sha256Bytes(bytes));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
