import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  ABSENCE_RECEIPT_FILENAME,
  AZ_PATH,
  AZURE_KEY_VAULT_SERVICE_APPLICATION_ID,
  AZURE_MANAGEMENT_RESOURCE,
  AZURE_VAULT_RESOURCE,
  BACKEND_SHA256,
  CUMULATIVE_ELAPSED_LIMIT_MS,
  createCleanupForTests,
  DESCRIPTOR_FILENAME,
  EVIDENCE_ROOT,
  HTTP_TIMEOUT_MS,
  INVOCATION_DEADLINE_MS,
  JOURNAL_COMMITMENT_DIRECTORY_NAME,
  JOURNAL_COMMITMENT_FILENAME_RE,
  MUTATION_ATTEMPT_LIMIT,
  OUTER_SIGNAL_GRACE_MS,
  OPERATION_MANIFEST_FILENAME,
  PREFLIGHT_MAX_AGE_MS,
  PREFLIGHT_RECEIPT_FILENAME,
  PREFLIGHT_VERIFIER_ARTIFACT,
  PREFLIGHT_VERIFIER_ID,
  productionProcess,
  productionContextReaderForTests,
  RETRY_BACKOFF_MS,
  runCli,
  runOuterFlock,
  parseCli,
  TARGET_SECRET_NAMES,
  TOKEN_TIMEOUT_MS,
  TERRAFORM_PATH,
} from "./cleanup-key-vault-credentials.mjs";

const SUBSCRIPTION = "a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1";
const TENANT = "c69da7c1-f194-493b-9697-5b4bc8b56f37";
const OBJECT_ID = "33333333-3333-4333-8333-333333333333";
const RESOURCE_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-test/providers/Microsoft.KeyVault/vaults/kv-test`;
const VAULT_URI = "https://kv-test.vault.azure.net/";
const PLAN = Buffer.from("protected plan bytes\n", "utf8");
const PLAN_SHA256 = createHash("sha256").update(PLAN).digest("hex");
const CREATE_TIME = "2026-08-21T00:00:00.000Z";
const PREFLIGHT_TIME = "2026-08-21T00:00:30.000Z";
const COMMIT = spawnSync("/usr/bin/git", ["--no-replace-objects", "rev-parse", "HEAD"], {
  cwd: process.cwd(),
  env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1" },
  encoding: "utf8",
}).stdout.trim();
const HISTORICAL_UTILITY_COMMIT = "8a12340084da96135985df11529d4c1c05403fe1";
const NON_ANCESTOR_UTILITY_COMMIT = "73e03fdd1748b4d4fd64581a65fa35956dedfa9f";
const HISTORICAL_UTILITY_SHA256 = "ab715f30be100074ab70727e84ded906b79844db116a87d5ff488a28f1b84edb";
const REVIEWED_DEPENDENCY_PATHS = Object.freeze([
  "infra/scripts/verify-acr-image-platform.mjs",
  "infra/scripts/assert-dev-plan.mjs",
  "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
  "infra/scripts/fixtures/azure-generation-cutover.plan-fixture.json",
  "infra/scripts/fixtures/azure-credential-cleanup.plan-fixture.json",
  "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
]);
const HISTORICAL_CODE_BINDINGS = Object.freeze({
  lifecycleSha256: "c3eef606cf54588cf23e58ed1dc2af955bc9ad718ebb715a9e1b2c470f88f56c",
  guardSha256: "d3035676393f79ff09fc778da7abecd185edebce91573404ac115e550e386272",
  dependencyBlobs: [
    { path: REVIEWED_DEPENDENCY_PATHS[0], blob: "3a23c927add217307d4bfa9cc67bb9fa6bbcb643", sha256: "4f346837cfa1633495d95c5a6d9001336875a8b40fdf60bcfd40176187100035" },
    { path: REVIEWED_DEPENDENCY_PATHS[1], blob: "3160ad8daeec3ed4a496a644293abd55998eba8a", sha256: "d3035676393f79ff09fc778da7abecd185edebce91573404ac115e550e386272" },
    { path: REVIEWED_DEPENDENCY_PATHS[2], blob: "7697d29a239caabe08c71e5c27ce1354ae3eae6f", sha256: "41b2f20ecfe751360093b34c9789f00c07d91838ef264e67fc4d9da37415a5dd" },
    { path: REVIEWED_DEPENDENCY_PATHS[3], blob: "2eab854e5858267c0a926db914998f4b92ccbfeb", sha256: "da7d48c80b91eb3b7f4a88c66d293958160e4c80996c48ad51fd9697f1329b19" },
    { path: REVIEWED_DEPENDENCY_PATHS[4], blob: "5c3b9f712dafb6f59a1f077901309df134ec0da0", sha256: "524ef7341171b1c42eeaa757d6514d74399ae67d5e0d6a004d377b4b230cf312" },
    { path: REVIEWED_DEPENDENCY_PATHS[5], blob: "5b37e1e8be5de49b1b45b29069890b65cbf723b9", sha256: "35605793eaf3d0c4622deb2e6ee2ca615ed4f228d5af392b04ae30a9327ed0bf" },
  ],
});
const CURRENT_CODE_BINDINGS = Object.freeze({
  lifecycleSha256: "4ceb3786137f1c434bd3612383fe692074c92e42e4f416d41dbba40437564550",
  guardSha256: HISTORICAL_CODE_BINDINGS.guardSha256,
  dependencyBlobs: HISTORICAL_CODE_BINDINGS.dependencyBlobs,
});

function codeBindingsForCommit(repositoryCommit) {
  const source = repositoryCommit === HISTORICAL_UTILITY_COMMIT ? HISTORICAL_CODE_BINDINGS : CURRENT_CODE_BINDINGS;
  return {
    lifecycleSha256: source.lifecycleSha256,
    guardSha256: source.guardSha256,
    dependencyBlobs: source.dependencyBlobs.map((entry) => ({ ...entry })),
  };
}
const ACR_LOGIN_SERVER = "palancardev.azurecr.io";
const ACCOUNT_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-palancar-dev/providers/Microsoft.CognitiveServices/accounts/palancar-dev`;
const RUNTIME_IDENTITY_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-palancar-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/palancar-runtime`;
const RUNTIME_IDENTITY_CLIENT_ID = "44444444-4444-4444-8444-444444444444";
const RUNTIME_IDENTITY_PRINCIPAL_ID = "55555555-5555-4555-8555-555555555555";
const RUNTIME_OPENAI_ROLE_ASSIGNMENT_ID = `${ACCOUNT_ID}/providers/Microsoft.Authorization/roleAssignments/66666666-6666-4666-8666-666666666666`;

function imageDescriptor(repository, manifestDigest, configDigest) {
  return {
    version: 1,
    reference: `${ACR_LOGIN_SERVER}/${repository}@${manifestDigest}`,
    repository,
    manifestDigest,
    manifestMediaType: "application/vnd.oci.image.manifest.v1+json",
    configDigest,
    configMediaType: "application/vnd.oci.image.config.v1+json",
    os: "linux",
    architecture: "amd64",
    variant: null,
  };
}

const IMAGE_PLATFORMS = {
  version: 1,
  verifierSha256: "4".repeat(64),
  images: [
    imageDescriptor("palancar-expiry-cleanup", `sha256:${"5".repeat(64)}`, `sha256:${"6".repeat(64)}`),
    imageDescriptor("palancar-relay", `sha256:${"7".repeat(64)}`, `sha256:${"8".repeat(64)}`),
  ],
};

const temporaryRoots = new Set();
after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function productionKernelLockPath() {
  return path.join(path.dirname(EVIDENCE_ROOT), `${path.basename(EVIDENCE_ROOT)}.kernel.lock`);
}

function runCleanupLockProbe(composition, descriptorPath = productionKernelLockPath()) {
  const lockPath = productionKernelLockPath();
  const cleanupScript = new URL("./cleanup-key-vault-credentials.mjs", import.meta.url).pathname;
  const lifecycleScript = new URL("./dev-plan-lifecycle.mjs", import.meta.url).pathname;
  const cleanupMarker = "--__palancar-cleanup-locked-b1b";
  const lifecycleMarker = "--__palancar-internal-locked-b1b";
  const token = readFileSync(lockPath, "utf8").trim();
  const descriptorFd = openSync(descriptorPath, "r");
  try {
    const env = {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      PALANCAR_CLEANUP_LOCK_FD: "3",
      PALANCAR_CLEANUP_LOCK_TOKEN: token,
    };
    if (composition === "parent-neither") {
      return spawnSync(process.execPath, [cleanupScript, cleanupMarker, "not-an-operation"], {
        cwd: "/",
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", descriptorFd],
      });
    }
    if (composition === "direct") {
      return spawnSync("/usr/bin/flock", ["-n", "-x", lockPath, process.execPath, cleanupScript, cleanupMarker, "not-an-operation"], {
        cwd: "/",
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", descriptorFd],
      });
    }

    const nestedCode = `
      import { spawnSync } from "node:child_process";
      const result = spawnSync(${JSON.stringify(process.execPath)}, [
        ${JSON.stringify(cleanupScript)},
        ${JSON.stringify(cleanupMarker)},
        "not-an-operation",
      ], {
        cwd: "/",
        env: {
          ...process.env,
          PALANCAR_CLEANUP_LOCK_FD: "3",
          PALANCAR_CLEANUP_LOCK_TOKEN: ${JSON.stringify(token)},
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", 3],
      });
      process.stdout.write(JSON.stringify({
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }));
    `;
    const parentArgs = [
      "--input-type=module",
      "-e",
      nestedCode,
      lifecycleScript,
      lifecycleMarker,
    ];
    const result = composition === "lifecycle"
      ? spawnSync("/usr/bin/flock", ["-n", lockPath, process.execPath, ...parentArgs], {
          cwd: "/",
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe", descriptorFd],
        })
      : spawnSync(process.execPath, parentArgs, {
          cwd: "/",
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe", descriptorFd],
        });
    return { ...result, probe: result.stdout === "" ? undefined : JSON.parse(result.stdout) };
  } finally {
    closeSync(descriptorFd);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function writeExclusive(filePath, content, mode = 0o600) {
  const fd = openSync(filePath, "wx", mode);
  try {
    const bytes = Buffer.isBuffer(content)
      ? content
      : Buffer.from(`${typeof content === "string" ? content : `${canonicalJson(content)}\n`}`, "utf8");
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  chmodSync(filePath, mode);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function jwt(audience, now) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    aud: audience,
    tid: TENANT,
    oid: OBJECT_ID,
    idtyp: "user",
    exp: Math.floor(now / 1000) + 3600,
  })}.signature`;
}

function listBody(names, kind) {
  const prefix = `${VAULT_URI}${kind === "active" ? "secrets" : "deletedsecrets"}/`;
  return JSON.stringify({ value: names.map((name) => kind === "active"
    ? {
        id: `${prefix}${name}`,
        attributes: { enabled: true },
        tags: {},
      }
    : {
        recoveryId: `${prefix}${name}`,
        deletedDate: 1_700_000_000,
        scheduledPurgeDate: 1_700_086_400,
        id: `${VAULT_URI}secrets/${name}`,
        attributes: { enabled: true },
        tags: {},
      }), nextLink: null });
}

function makeBindings(planPath, repositoryCommit = COMMIT) {
  const reviewed = codeBindingsForCommit(repositoryCommit);
  const backend = {
    container_name: "tfstate-dev",
    key: "dev/terraform.tfstate",
    resource_group_name: "rg-palancar-dev-tfstate-aeeacd8c",
    storage_account_name: "palancardevaeeacd8c",
    subscription_id: SUBSCRIPTION,
    tenant_id: TENANT,
    type: "azurerm",
    use_azuread_auth: true,
    use_cli: true,
  };
  const azureContextHash = hashJson({ cloud: "AzureCloud", subscription: SUBSCRIPTION, tenant: TENANT });
  const callerHash = hashJson({ cloud: "AzureCloud", subscription: SUBSCRIPTION, tenant: TENANT, userType: "user", objectId: OBJECT_ID });
  const bindings = {
    planSha256: PLAN_SHA256,
    terraformSha256: "1".repeat(64),
    lifecycleSha256: reviewed.lifecycleSha256,
    guardSha256: reviewed.guardSha256,
    dependencyBlobs: reviewed.dependencyBlobs,
    repositoryCommit,
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../environments/dev"),
    phase: "credential-cleanup",
    argv: ["plan", "-refresh=true", "-input=false", "-lock=true", "-lock-timeout=5m", `-out=${planPath}`],
    backend,
    backendSha256: BACKEND_SHA256,
    backendConfigurationSha256: BACKEND_SHA256,
    workspace: "default",
    stateLineage: "lineage-test",
    stateSerial: 7,
    liveRevision: "revision-test",
    runtimeIdentityId: RUNTIME_IDENTITY_ID,
    runtimeIdentityClientId: RUNTIME_IDENTITY_CLIENT_ID,
    runtimeIdentityPrincipalId: RUNTIME_IDENTITY_PRINCIPAL_ID,
    accountId: ACCOUNT_ID,
    runtimeOpenAiRoleAssignmentId: RUNTIME_OPENAI_ROLE_ASSIGNMENT_ID,
    azureContextHash,
    callerHash,
    guard: "azure-credential-cleanup",
    acrLoginServer: ACR_LOGIN_SERVER,
    imagePlatforms: IMAGE_PLATFORMS,
  };
  return { bindings, bindingSha256: hashJson(bindings) };
}

function makeHarness(overrides = {}) {
  const root = overrides.root ?? mkdtempSync(path.join(tmpdir(), "palancar-key-vault-cleanup-"));
  chmodSync(root, 0o700);
  if (overrides.root === undefined) temporaryRoots.add(root);
  const runId = overrides.runId ?? "credential-run-1";
  const directory = path.join(root, runId);
  mkdirSync(directory, { mode: 0o700 });
  const active = new Set(TARGET_SECRET_NAMES);
  const deleted = new Set();
  let now = 1_000_000;
  let wallNow = Date.parse(PREFLIGHT_TIME);
  const azCalls = [];
  const httpCalls = [];
  const sleepCalls = [];
  let faultAt = overrides.faultAt;
  const httpState = overrides.httpState ?? {};
  const planPath = path.join(directory, "plan.tfplan");
  const { bindings, bindingSha256 } = makeBindings(planPath, overrides.repositoryCommit ?? COMMIT);
  let liveContext = overrides.liveContext;

  writeExclusive(planPath, PLAN);
  writeExclusive(path.join(directory, "create-manifest.json"), {
    version: 1,
    runId,
    phase: "credential-cleanup",
    createdAt: CREATE_TIME,
    processExit: 0,
    planSha256: PLAN_SHA256,
    argv: bindings.argv,
    bindings,
    bindingSha256,
    ...(overrides.supersession ? { supersession: overrides.supersession } : {}),
  });
  const showSha256 = "a".repeat(64);
  writeExclusive(path.join(directory, "guard-receipt.json"), {
    version: 1,
    type: "guard",
    runId,
    phase: "credential-cleanup",
    planSha256: PLAN_SHA256,
    bindingSha256,
    createdAt: CREATE_TIME,
    guard: "azure-credential-cleanup",
    showSha256,
    guardArgv: ["--mode=azure-credential-cleanup"],
    stdinSha256: showSha256,
    result: "passed",
  });
  const writePreflightFile = () => {
    const receipt = {
      version: 2,
      type: "runtime-preflight",
      runId,
      phase: "credential-cleanup",
      planSha256: PLAN_SHA256,
      bindingSha256,
      contextSha256: bindingSha256,
      createdAt: PREFLIGHT_TIME,
      deadlineAt: new Date(Date.parse(PREFLIGHT_TIME) + PREFLIGHT_MAX_AGE_MS).toISOString(),
      result: "passed",
      verifierId: PREFLIGHT_VERIFIER_ID,
      verifierArtifact: PREFLIGHT_VERIFIER_ARTIFACT,
      verifierSha256: createHash("sha256").update(readFileSync(new URL("./cleanup-key-vault-credentials.mjs", import.meta.url))).digest("hex"),
      runtimeIdentity: { cloud: "AzureCloud", subscription: SUBSCRIPTION, tenant: TENANT, userType: "user", objectId: OBJECT_ID },
      vaultResourceId: RESOURCE_ID,
      vaultUri: VAULT_URI,
      targetNames: [...TARGET_SECRET_NAMES],
      receiptSha256: null,
    };
    receipt.receiptSha256 = hashJson(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptSha256")));
    const filePath = path.join(directory, PREFLIGHT_RECEIPT_FILENAME);
    if (existsSync(filePath)) unlinkSync(filePath);
    writeExclusive(filePath, receipt);
  };
  if (overrides.preflight) writePreflightFile();
  const descriptor = {
    version: 1,
    type: "credential-cleanup-vault-descriptor",
    runId,
    phase: "credential-cleanup",
    planSha256: PLAN_SHA256,
    bindingSha256,
    contextSha256: bindingSha256,
    vaultResourceId: RESOURCE_ID,
    vaultUri: VAULT_URI,
    subscription: SUBSCRIPTION,
    tenant: TENANT,
    cloud: "AzureCloud",
    callerIdentity: { userType: "user", objectId: OBJECT_ID },
    targetNames: [...TARGET_SECRET_NAMES],
    startState: "start",
  };
  if (overrides.supersession) descriptor.supersession = overrides.supersession;
  writeExclusive(path.join(directory, DESCRIPTOR_FILENAME), descriptor);

  const httpRequest = async (request) => {
    httpCalls.push({ ...request });
    if (typeof httpState.onRequest === "function") {
      const result = await httpState.onRequest(request, { active, deleted, now: () => now, directory });
      if (result !== undefined) return result;
    }
    const url = new URL(request.url);
    if (url.hostname === "management.azure.com") {
      return { statusCode: 200, body: JSON.stringify({ id: RESOURCE_ID, type: "Microsoft.KeyVault/vaults", properties: { tenantId: TENANT, vaultUri: VAULT_URI } }) };
    }
    if (request.method === "GET" && url.pathname === "/secrets") return { statusCode: httpState.activeStatus ?? 200, body: httpState.activeBody ?? listBody([...active], "active") };
    if (request.method === "GET" && url.pathname === "/deletedsecrets") return { statusCode: httpState.deletedStatus ?? 200, body: httpState.deletedBody ?? listBody([...deleted], "deleted") };
    if (request.method === "DELETE" && url.pathname.startsWith("/secrets/")) {
      if (httpState.deleteStatus !== undefined) return { statusCode: httpState.deleteStatus, body: "secret-value-must-not-be-read" };
      const name = url.pathname.slice("/secrets/".length);
      active.delete(name);
      deleted.add(name);
      return { statusCode: 202, body: "secret-value-must-not-be-read" };
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/deletedsecrets/")) {
      if (httpState.purgeStatus !== undefined) return { statusCode: httpState.purgeStatus, body: "secret-value-must-not-be-read" };
      const name = url.pathname.slice("/deletedsecrets/".length);
      deleted.delete(name);
      return { statusCode: 202, body: "secret-value-must-not-be-read" };
    }
    throw new Error(`unexpected HTTPS request ${request.method} ${request.url}`);
  };
  const processRunner = async (request) => {
    azCalls.push({ ...request, argv: [...request.argv], env: { ...request.env } });
    if (typeof overrides.processRunner === "function") return overrides.processRunner(request, { now: () => now });
    return { status: 0, stdout: JSON.stringify({ accessToken: jwt(request.argv[3], now) }) };
  };
  const sleep = async (milliseconds) => {
    sleepCalls.push(milliseconds);
    now += milliseconds;
    if (typeof overrides.onSleep === "function") await overrides.onSleep(milliseconds, { active, deleted, now: () => now });
  };
  const rawCleanup = createCleanupForTests({
    root,
    lowLevel: {
      clock: { now: () => now },
      sleep,
      setTimeout: overrides.setTimeout,
      clearTimeout: overrides.clearTimeout,
      wallNow: () => wallNow,
      processRunner,
      httpRequest,
      contextReader: () => liveContext ?? bindings,
      faultAt: (details) => {
        if (typeof faultAt === "function" && faultAt(details) === true) throw new Error("injected fault");
      },
    },
  });
  const cleanup = Object.freeze({
    ...rawCleanup,
    start: async (value) => {
      const result = await rawCleanup.start(value);
      if (overrides.autoPreflight !== false) writePreflightFile();
      return result;
    },
  });
  return {
    cleanup, root, runId, directory, active, deleted, azCalls, httpCalls, sleepCalls,
    bindings,
    setNow(value) { now = value; },
    setWallNow(value) { wallNow = value; },
    setLiveContext(value) { liveContext = value; },
    advance(milliseconds) { now += milliseconds; },
    setFault(value) { faultAt = value; },
    path(filename) { return path.join(directory, filename); },
    writePreflight() {
      writePreflightFile();
    },
  };
}

function stateFiles(harness) {
  return readdirSync(harness.directory).filter((entry) => /^cleanup-state-\d{6}\.json$/u.test(entry)).sort();
}

function commitmentDirectory(harness) {
  return path.join(harness.root, JOURNAL_COMMITMENT_DIRECTORY_NAME, harness.runId);
}

function commitmentFiles(harness) {
  if (!existsSync(commitmentDirectory(harness))) return [];
  return readdirSync(commitmentDirectory(harness)).filter((entry) => JOURNAL_COMMITMENT_FILENAME_RE.test(entry)).sort();
}

function rewriteJson(filePath, mutate) {
  const value = readJson(filePath);
  mutate(value);
  unlinkSync(filePath);
  writeExclusive(filePath, value);
  return value;
}

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function rehashOperationVersion(filePath) {
  return rewriteJson(filePath, (operation) => {
    operation.sha256 = hashJson(Object.fromEntries(Object.entries(operation).filter(([key]) => key !== "sha256")));
  });
}

function rebindPreparedOperationUtility(harness, utilitySha256) {
  const versionPath = harness.path("cleanup-manifest-000000.json");
  rewriteJson(versionPath, (operation) => {
    operation.utilitySha256 = utilitySha256;
  });
  rehashOperationVersion(versionPath);
  const manifestSha256 = fileSha256(versionPath);
  const headPath = harness.path(OPERATION_MANIFEST_FILENAME);
  rewriteJson(headPath, (head) => {
    const version = readJson(versionPath);
    Object.assign(head, version, {
      manifestFilename: "cleanup-manifest-000000.json",
      manifestSha256,
      previousHeadSha256: null,
    });
    head.headSha256 = hashJson(Object.fromEntries(Object.entries(head).filter(([key]) => key !== "headSha256")));
  });
  const journalDirectory = commitmentDirectory(harness);
  const intentPath = path.join(journalDirectory, "cleanup-operation-head-intent-000000.json");
  rewriteJson(intentPath, (intent) => {
    intent.manifestSha256 = manifestSha256;
    intent.intentSha256 = hashJson(Object.fromEntries(Object.entries(intent).filter(([key]) => key !== "intentSha256")));
  });
  const anchorPath = path.join(journalDirectory, "cleanup-operation-head-000000.json");
  rewriteJson(anchorPath, (anchor) => {
    anchor.manifestSha256 = manifestSha256;
    anchor.headSha256 = fileSha256(headPath);
    anchor.intentSha256 = fileSha256(intentPath);
    anchor.anchorSha256 = hashJson(Object.fromEntries(Object.entries(anchor).filter(([key]) => key !== "anchorSha256")));
  });
}

function writeLifecycleCheckpoint(harness, sequence, name, details) {
  writeExclusive(harness.path(`${String(sequence).padStart(6, "0")}-${name}.json`), {
    version: 1,
    type: "lifecycle-checkpoint",
    sequence,
    name,
    runId: harness.runId,
    phase: "credential-cleanup",
    createdAt: CREATE_TIME,
    ...details,
  });
}

function consumeGuardReceipt(harness, { cleanupStart = true, receiptsConsumed = true } = {}) {
  const guardPath = harness.path("guard-receipt.json");
  const consumedPath = harness.path("guard-receipt.json.consumed");
  const bytes = readFileSync(guardPath);
  const guardReceiptSha256 = createHash("sha256").update(bytes).digest("hex");
  writeExclusive(consumedPath, bytes);
  unlinkSync(guardPath);
  let sequence = 1;
  if (cleanupStart) {
    writeLifecycleCheckpoint(harness, sequence, "cleanup-start", {
      cleanupOperationManifestSha256: createHash("sha256").update(readFileSync(harness.path(OPERATION_MANIFEST_FILENAME))).digest("hex"),
      guardReceiptSha256,
    });
    sequence += 1;
  }
  if (receiptsConsumed) {
    const preflightPath = harness.path(PREFLIGHT_RECEIPT_FILENAME);
    writeLifecycleCheckpoint(harness, sequence, "receipts-consumed", {
      guardReceiptSha256,
      preflightReceiptSha256: existsSync(preflightPath)
        ? createHash("sha256").update(readFileSync(preflightPath)).digest("hex")
        : "f".repeat(64),
    });
  }
  return guardReceiptSha256;
}

function rebindStateEnvelope(harness, sequence, mutate) {
  const statePath = harness.path(`cleanup-state-${String(sequence).padStart(6, "0")}.json`);
  const state = readJson(statePath);
  mutate(state);
  state.inventorySha256 = hashJson(state.inventory);
  state.stateSha256 = hashJson(Object.fromEntries(Object.entries(state).filter(([key]) => key !== "stateSha256")));
  unlinkSync(statePath);
  writeExclusive(statePath, state);

  const anchorPath = harness.path(sequence === 0 ? "cleanup-state-anchor.json" : `cleanup-state-anchor-${String(sequence).padStart(6, "0")}.json`);
  const anchor = readJson(anchorPath);
  anchor.stateSha256 = state.stateSha256;
  anchor.stateFileSha256 = createHash("sha256").update(readFileSync(statePath)).digest("hex");
  anchor.manifestSha256 = state.manifestSha256;
  anchor.absenceReceiptSha256 = state.absenceReceiptSha256;
  anchor.mutationTailSequence = state.mutationTailSequence;
  anchor.mutationTailSha256 = state.mutationTailSha256;
  anchor.preflightReceiptSha256 = state.preflightReceiptSha256;
  anchor.preflightVerifierId = state.preflightVerifierId;
  anchor.preflightVerifierSha256 = state.preflightVerifierSha256;
  anchor.anchorSha256 = hashJson(Object.fromEntries(Object.entries(anchor).filter(([key]) => key !== "anchorSha256")));
  unlinkSync(anchorPath);
  writeExclusive(anchorPath, anchor);

  const headPath = harness.path(`cleanup-journal-head-${String(sequence).padStart(6, "0")}.json`);
  const head = readJson(headPath);
  head.stateSha256 = state.stateSha256;
  head.stateFileSha256 = createHash("sha256").update(readFileSync(statePath)).digest("hex");
  head.manifestSha256 = state.manifestSha256;
  head.absenceReceiptSha256 = state.absenceReceiptSha256;
  head.mutationTailSequence = state.mutationTailSequence;
  head.mutationTailSha256 = state.mutationTailSha256;
  head.preflightReceiptSha256 = state.preflightReceiptSha256;
  head.preflightVerifierId = state.preflightVerifierId;
  head.preflightVerifierSha256 = state.preflightVerifierSha256;
  head.headSha256 = hashJson(Object.fromEntries(Object.entries(head).filter(([key]) => key !== "headSha256")));
  unlinkSync(headPath);
  writeExclusive(headPath, head);

  const commitmentPath = path.join(commitmentDirectory(harness), `cleanup-journal-commitment-${String(sequence).padStart(6, "0")}.json`);
  const commitment = readJson(commitmentPath);
  commitment.stateSha256 = state.stateSha256;
  commitment.stateFileSha256 = createHash("sha256").update(readFileSync(statePath)).digest("hex");
  commitment.anchorSha256 = createHash("sha256").update(readFileSync(anchorPath)).digest("hex");
  commitment.headSha256 = createHash("sha256").update(readFileSync(headPath)).digest("hex");
  commitment.manifestSha256 = state.manifestSha256;
  commitment.absenceReceiptSha256 = state.absenceReceiptSha256;
  commitment.mutationTailSequence = state.mutationTailSequence;
  commitment.mutationTailSha256 = state.mutationTailSha256;
  commitment.preflightReceiptSha256 = state.preflightReceiptSha256;
  commitment.preflightVerifierId = state.preflightVerifierId;
  commitment.preflightVerifierSha256 = state.preflightVerifierSha256;
  commitment.commitmentSha256 = hashJson(Object.fromEntries(Object.entries(commitment).filter(([key]) => key !== "commitmentSha256")));
  unlinkSync(commitmentPath);
  writeExclusive(commitmentPath, commitment);
}

function killAtPublicationSubprocess(harness, targetFilename, activeInventory = false) {
  const modulePath = new URL("./cleanup-key-vault-credentials.mjs", import.meta.url).pathname;
  const childCode = `
    import { createCleanupForTests } from ${JSON.stringify(modulePath)};
    import { readFileSync } from "node:fs";
    import path from "node:path";
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = (resource) => encode({ alg: "none", typ: "JWT" }) + "." + encode({
      aud: resource, tid: ${JSON.stringify(TENANT)}, oid: ${JSON.stringify(OBJECT_ID)}, idtyp: "user", exp: 4000,
    }) + ".signature";
    const active = new Set(${JSON.stringify(TARGET_SECRET_NAMES)});
    const deleted = new Set();
    const item = (name, kind) => kind === "active"
      ? { id: ${JSON.stringify(VAULT_URI)} + "secrets/" + name, attributes: { enabled: true }, tags: {} }
      : { recoveryId: ${JSON.stringify(VAULT_URI)} + "deletedsecrets/" + name, deletedDate: 1700000000, scheduledPurgeDate: 1700086400, id: ${JSON.stringify(VAULT_URI)} + "secrets/" + name, attributes: { enabled: true }, tags: {} };
    const cleanup = createCleanupForTests({
      root: process.env.PALANCAR_TEST_ROOT,
      lowLevel: {
        clock: { now: () => 1000000 },
        wallNow: () => ${Date.parse(PREFLIGHT_TIME)},
        sleep: async () => {},
        processRunner: (request) => ({ status: 0, stdout: JSON.stringify({ accessToken: token(request.argv[3]) }) }),
        contextReader: ({ runId }) => JSON.parse(readFileSync(path.join(process.env.PALANCAR_TEST_ROOT, runId, "create-manifest.json"), "utf8")).bindings,
        httpRequest: async (request) => {
          const url = new URL(request.url);
          if (url.hostname === "management.azure.com") return { statusCode: 200, body: JSON.stringify({
            id: ${JSON.stringify(RESOURCE_ID)}, type: "Microsoft.KeyVault/vaults", properties: {
              tenantId: ${JSON.stringify(TENANT)}, vaultUri: ${JSON.stringify(VAULT_URI)},
            },
          }) };
          if (request.method === "GET" && url.pathname === "/secrets") return { statusCode: 200, body: JSON.stringify({ value: ${activeInventory ? "[...active].map((name) => item(name, \"active\"))" : "[]"}, nextLink: null }) };
          if (request.method === "GET" && url.pathname === "/deletedsecrets") return { statusCode: 200, body: JSON.stringify({ value: ${activeInventory ? "[...deleted].map((name) => item(name, \"deleted\"))" : "[]"}, nextLink: null }) };
          if (request.method === "DELETE" && url.pathname.startsWith("/secrets/")) { const name = url.pathname.split("/").at(-1); active.delete(name); deleted.add(name); return { statusCode: 202 }; }
          if (request.method === "DELETE" && url.pathname.startsWith("/deletedsecrets/")) { const name = url.pathname.split("/").at(-1); deleted.delete(name); return { statusCode: 202 }; }
          return { statusCode: 200, body: JSON.stringify({ value: [], nextLink: null }) };
        },
        faultAt: ({ event, filePath }) => {
          if (event === "after-directory-fsync" && filePath?.endsWith(${JSON.stringify(targetFilename)})) process.kill(process.pid, "SIGKILL");
        },
      },
    });
    await cleanup.resume(${JSON.stringify(harness.runId)});
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    cwd: process.cwd(),
    env: { PATH: "/usr/bin:/bin", PALANCAR_TEST_ROOT: harness.root },
    encoding: "utf8",
    timeout: 10_000,
  });
}

function killAtManifestPublicationSubprocess(harness, targetFilename, targetEvent = undefined) {
  const modulePath = new URL("./cleanup-key-vault-credentials.mjs", import.meta.url).pathname;
  const childCode = `
    import { createCleanupForTests } from ${JSON.stringify(modulePath)};
    import { readFileSync } from "node:fs";
    import path from "node:path";
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = (resource) => encode({ alg: "none", typ: "JWT" }) + "." + encode({
      aud: resource, tid: ${JSON.stringify(TENANT)}, oid: ${JSON.stringify(OBJECT_ID)}, idtyp: "user", exp: 4000,
    }) + ".signature";
    let publicationHits = 0;
    const item = (name) => ({ id: ${JSON.stringify(VAULT_URI)} + "secrets/" + name, attributes: { enabled: true }, tags: {} });
    const cleanup = createCleanupForTests({
      root: process.env.PALANCAR_TEST_ROOT,
      lowLevel: {
        clock: { now: () => 1000000 },
        wallNow: () => ${Date.parse(PREFLIGHT_TIME)},
        sleep: async () => {},
        processRunner: (request) => ({ status: 0, stdout: JSON.stringify({ accessToken: token(request.argv[3]) }) }),
        contextReader: ({ runId }) => JSON.parse(readFileSync(path.join(process.env.PALANCAR_TEST_ROOT, runId, "create-manifest.json"), "utf8")).bindings,
        httpRequest: async (request) => {
          const url = new URL(request.url);
          if (url.hostname === "management.azure.com") return { statusCode: 200, body: JSON.stringify({
            id: ${JSON.stringify(RESOURCE_ID)}, type: "Microsoft.KeyVault/vaults", properties: {
              tenantId: ${JSON.stringify(TENANT)}, vaultUri: ${JSON.stringify(VAULT_URI)},
            },
          }) };
          if (request.method === "GET" && url.pathname === "/secrets") return { statusCode: 200, body: JSON.stringify({ value: ${JSON.stringify(TARGET_SECRET_NAMES)}.map(item), nextLink: null }) };
          return { statusCode: 200, body: JSON.stringify({ value: [], nextLink: null }) };
        },
        faultAt: ({ event, filePath }) => {
          const selected = ${targetEvent === undefined ? "undefined" : JSON.stringify(targetEvent)};
          const matches = selected === undefined
            ? (event === "after-directory-fsync" || event === "after-manifest-head-directory-fsync")
            : event === selected;
          if (matches && filePath?.endsWith(${JSON.stringify(targetFilename)}) && ++publicationHits === (${JSON.stringify(targetFilename)} === "cleanup-manifest.json" && selected === undefined ? 2 : 1)) process.kill(process.pid, "SIGKILL");
        },
      },
    });
    await cleanup.start(${JSON.stringify(harness.runId)});
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    cwd: process.cwd(),
    env: { PATH: "/usr/bin:/bin", PALANCAR_TEST_ROOT: harness.root },
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test("CLI is closed and accepts only one strict run ID", () => {
  assert.deepEqual(parseCli(["start", "run-1"]), { operation: "start", runId: "run-1" });
  assert.deepEqual(parseCli(["resume", "run-1"]), { operation: "resume", runId: "run-1" });
  assert.deepEqual(parseCli(["assert-absent", "run-1"]), { operation: "assert-absent", runId: "run-1" });
  for (const argv of [[], ["start"], ["start", "run-1", "extra"], ["start", "../run"], ["start", "run/with-slash"], ["delete", "run-1"], ["resume", "run/with-slash"], ["start", "https://kv-test.vault.azure.net"]]) assert.equal(parseCli(argv), undefined);
});

test("start is after create+guard, before preflight, and publishes its operation before network", async () => {
  const harness = makeHarness({
    httpState: {
      onRequest: (request, controls) => {
        assert.equal(existsSync(path.join(controls.directory, OPERATION_MANIFEST_FILENAME)), true);
        assert.equal(existsSync(path.join(controls.directory, "cleanup-state-000000.json")), false);
        assert.equal(Object.hasOwn(request, "body"), false);
      },
    },
  });
  await harness.cleanup.start(harness.runId);
  const operation = readJson(harness.path(OPERATION_MANIFEST_FILENAME));
  assert.equal(operation.status, "completed");
  assert.equal(/^[a-f0-9]{64}$/u.test(operation.sha256), true);
  assert.equal(stateFiles(harness).length, 1);
  assert.equal(harness.azCalls.length, 2);
  const afterPreflight = makeHarness({ preflight: true });
  await expectCode(afterPreflight.cleanup.start(afterPreflight.runId), "start-after-preflight");
  assert.equal(existsSync(afterPreflight.path(OPERATION_MANIFEST_FILENAME)), false);
});

test("start is single-use and a token/network crash leaves a resumable manifest", async () => {
  const harness = makeHarness({ processRunner: () => ({ status: null, timedOut: true, stdout: "" }) });
  await expectCode(harness.cleanup.start(harness.runId), "token-timeout");
  assert.equal(existsSync(harness.path(OPERATION_MANIFEST_FILENAME)), true);
  await expectCode(harness.cleanup.start(harness.runId), "already-started");
  assert.equal(harness.azCalls[0].command, AZ_PATH);
  assert.deepEqual(harness.azCalls[0].argv, ["account", "get-access-token", "--resource", AZURE_MANAGEMENT_RESOURCE, "--output", "json"]);
});

test("lifecycle 26-key bindings are accepted and new fields are closed and validated", async () => {
  const accepted = makeHarness({ autoPreflight: false });
  await accepted.cleanup.start(accepted.runId);

  const newKeys = [
    "accountId", "acrLoginServer", "imagePlatforms", "runtimeIdentityClientId",
    "runtimeIdentityId", "runtimeIdentityPrincipalId", "runtimeOpenAiRoleAssignmentId",
  ];
  for (const key of newKeys) {
    const missing = makeHarness({ autoPreflight: false });
    rewriteJson(missing.path("create-manifest.json"), (value) => { delete value.bindings[key]; });
    await expectCode(missing.cleanup.start(missing.runId), "context-schema");
  }

  const malformed = [
    ["runtime identity resource ID", (bindings) => { bindings.runtimeIdentityId = "not-an-arm-resource-id"; }, "context-runtime-identity"],
    ["runtime identity client UUID", (bindings) => { bindings.runtimeIdentityClientId = "not-a-uuid"; }, "context-runtime-identity"],
    ["runtime identity principal UUID", (bindings) => { bindings.runtimeIdentityPrincipalId = "not-a-uuid"; }, "context-runtime-identity"],
    ["account subscription", (bindings) => { bindings.accountId = bindings.accountId.replace(SUBSCRIPTION, "not-a-uuid"); }, "context-account"],
    ["OpenAI role assignment resource ID", (bindings) => { bindings.runtimeOpenAiRoleAssignmentId = `${bindings.accountId}/providers/Microsoft.Authorization/roleAssignments/not-a-uuid`; }, "context-runtime-openai-role"],
    ["ACR login server", (bindings) => { bindings.acrLoginServer = "not-a-registry"; }, "context-acr-login-server"],
    ["image verifier digest", (bindings) => { bindings.imagePlatforms.verifierSha256 = "not-a-sha256"; }, "context-image-platform"],
    ["image descriptor digest", (bindings) => { bindings.imagePlatforms.images[0].configDigest = "sha256:not-a-sha256"; }, "context-image-descriptor"],
  ];
  for (const [, mutate, code] of malformed) {
    const harness = makeHarness({ autoPreflight: false });
    const manifest = rewriteJson(harness.path("create-manifest.json"), (value) => {
      mutate(value.bindings);
      value.bindingSha256 = hashJson(value.bindings);
    });
    rewriteJson(harness.path(DESCRIPTOR_FILENAME), (value) => {
      value.bindingSha256 = manifest.bindingSha256;
      value.contextSha256 = manifest.bindingSha256;
    });
    await expectCode(harness.cleanup.start(harness.runId), code);
  }

  const legacy = makeHarness({ autoPreflight: false });
  rewriteJson(legacy.path("create-manifest.json"), (value) => {
    for (const key of newKeys) delete value.bindings[key];
  });
  await expectCode(legacy.cleanup.start(legacy.runId), "context-schema");
});

test("descriptor, create, guard, preflight, operation, and state schemas are closed", async () => {
  for (const [file, expectedCode] of [[DESCRIPTOR_FILENAME, "descriptor-schema"], ["create-manifest.json", "create-manifest-schema"], ["guard-receipt.json", "guard-receipt-schema"]]) {
    const harness = makeHarness();
    const value = readJson(harness.path(file));
    value.unreviewed = true;
    unlinkSync(harness.path(file));
    writeExclusive(harness.path(file), value);
    await expectCode(harness.cleanup.start(harness.runId), expectedCode);
  }
  const preflight = makeHarness({ preflight: true });
  await expectCode(preflight.cleanup.start(preflight.runId), "start-after-preflight");

  const resumedPreflight = makeHarness();
  await resumedPreflight.cleanup.start(resumedPreflight.runId);
  resumedPreflight.writePreflight();
  const preflightValue = readJson(resumedPreflight.path("preflight-receipt.json"));
  preflightValue.extra = true;
  unlinkSync(resumedPreflight.path("preflight-receipt.json"));
  writeExclusive(resumedPreflight.path("preflight-receipt.json"), preflightValue);
  resumedPreflight.active.clear();
  await expectCode(resumedPreflight.cleanup.resume(resumedPreflight.runId), "preflight-receipt-schema");

  for (const [file, expectedCode] of [
    [OPERATION_MANIFEST_FILENAME, "operation-manifest-head-schema"],
    ["cleanup-state-000000.json", "state-schema"],
    ["cleanup-state-000001.json", "state-schema"],
    ["cleanup-state-anchor.json", "state-anchor-schema"],
    ["cleanup-state-anchor-000001.json", "state-anchor-schema"],
    ["cleanup-journal-head-000000.json", "journal-head-schema"],
    ["cleanup-journal-head-000001.json", "journal-head-schema"],
    ["cleanup-journal-commitment-000000.json", "journal-commitment-schema"],
    ["cleanup-journal-commitment-000001.json", "journal-commitment-schema"],
    [ABSENCE_RECEIPT_FILENAME, "absence-receipt-linkage"],
  ]) {
    const harness = makeHarness();
    await harness.cleanup.start(harness.runId);
    harness.active.clear();
    await harness.cleanup.resume(harness.runId);
    const filePath = file.startsWith("cleanup-journal-commitment-")
      ? path.join(commitmentDirectory(harness), file)
      : harness.path(file);
    const value = readJson(filePath);
    value.unreviewed = true;
    unlinkSync(filePath);
    writeExclusive(filePath, value);
    await expectCode(harness.cleanup.resume(harness.runId), expectedCode);
  }
});

test("consumed guard receipts are accepted only with matching lifecycle checkpoint evidence", async () => {
  const resumed = makeHarness();
  await resumed.cleanup.start(resumed.runId);
  const resumedGuardSha256 = consumeGuardReceipt(resumed);
  resumed.active.clear();
  resumed.deleted.clear();
  const resumedResult = await resumed.cleanup.resume(resumed.runId);
  assert.deepEqual(resumedResult, { status: "absent", runId: resumed.runId });
  assert.equal(resumedGuardSha256, createHash("sha256").update(readFileSync(resumed.path("guard-receipt.json.consumed"))).digest("hex"));

  const asserted = makeHarness({ autoPreflight: false });
  await asserted.cleanup.start(asserted.runId);
  consumeGuardReceipt(asserted);
  asserted.active.clear();
  asserted.deleted.clear();
  assert.deepEqual(await asserted.cleanup.assertAbsent(asserted.runId), { status: "absent", runId: asserted.runId });

  const missingCheckpoint = makeHarness({ autoPreflight: false });
  await missingCheckpoint.cleanup.start(missingCheckpoint.runId);
  consumeGuardReceipt(missingCheckpoint, { cleanupStart: false, receiptsConsumed: false });
  await expectCode(missingCheckpoint.cleanup.resume(missingCheckpoint.runId), "guard-receipt-missing");

  const mismatched = makeHarness();
  await mismatched.cleanup.start(mismatched.runId);
  consumeGuardReceipt(mismatched);
  rewriteJson(mismatched.path("000002-receipts-consumed.json"), (checkpoint) => {
    checkpoint.guardReceiptSha256 = "b".repeat(64);
  });
  await expectCode(mismatched.cleanup.resume(mismatched.runId), "guard-receipt-checkpoint-hash");
});

test("start writes exclusive protected artifacts and exact context bindings", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  const operation = readJson(harness.path(OPERATION_MANIFEST_FILENAME));
  assert.deepEqual(operation.runtimeSecretReferences, []);
  assert.equal(operation.contextSha256, operation.bindingSha256);
  for (const file of [DESCRIPTOR_FILENAME, OPERATION_MANIFEST_FILENAME, "cleanup-state-000000.json"]) {
    const stat = lstatSync(harness.path(file));
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.mode & 0o777, 0o600);
  }
});

test("the five cleanup pinning invariants reject self-rehashed mutations", async () => {
  // 1. Sequence 0 cannot be published as completed.
  {
    const harness = makeHarness({
      autoPreflight: false,
      processRunner: () => ({ status: null, timedOut: true, stdout: "" }),
    });
    await expectCode(harness.cleanup.start(harness.runId), "token-timeout");
    const versionPath = harness.path("cleanup-manifest-000000.json");
    rewriteJson(versionPath, (value) => {
      value.status = "completed";
      value.sha256 = hashJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256")));
    });
    const headPath = harness.path(OPERATION_MANIFEST_FILENAME);
    rewriteJson(headPath, (head) => {
      const version = readJson(versionPath);
      Object.assign(head, version, {
        manifestFilename: "cleanup-manifest-000000.json",
        manifestSha256: createHash("sha256").update(readFileSync(versionPath)).digest("hex"),
        previousHeadSha256: null,
      });
      head.headSha256 = hashJson(Object.fromEntries(Object.entries(head).filter(([key]) => key !== "headSha256")));
    });
    const intentPath = path.join(commitmentDirectory(harness), "cleanup-operation-head-intent-000000.json");
    rewriteJson(intentPath, (intent) => {
      intent.manifestSha256 = createHash("sha256").update(readFileSync(versionPath)).digest("hex");
      intent.intentSha256 = hashJson(Object.fromEntries(Object.entries(intent).filter(([key]) => key !== "intentSha256")));
    });
    const anchorPath = path.join(commitmentDirectory(harness), "cleanup-operation-head-000000.json");
    rewriteJson(anchorPath, (anchor) => {
      anchor.manifestSha256 = createHash("sha256").update(readFileSync(versionPath)).digest("hex");
      anchor.headSha256 = createHash("sha256").update(readFileSync(headPath)).digest("hex");
      anchor.intentSha256 = createHash("sha256").update(readFileSync(intentPath)).digest("hex");
      anchor.anchorSha256 = hashJson(Object.fromEntries(Object.entries(anchor).filter(([key]) => key !== "anchorSha256")));
    });
    await expectCode(harness.cleanup.resume(harness.runId), "operation-manifest-context");
  }

  // 2. A mutation intent cannot detach its preflight tuple from its state.
  {
    let crashed = true;
    const harness = makeHarness({
      faultAt: ({ event }) => {
        if (crashed && event === "after-mutation-request") {
          crashed = false;
          return true;
        }
        return false;
      },
    });
    await harness.cleanup.start(harness.runId);
    await assert.rejects(harness.cleanup.resume(harness.runId));
    harness.setFault(undefined);
    const intentPath = path.join(commitmentDirectory(harness), "cleanup-mutation-intent-000000.json");
    const commitmentPath = path.join(commitmentDirectory(harness), "cleanup-mutation-commitment-000000.json");
    const intent = rewriteJson(intentPath, (value) => {
      value.preflightReceiptSha256 = "b".repeat(64);
      value.intentSha256 = hashJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "intentSha256")));
    });
    rewriteJson(commitmentPath, (commitment) => {
      commitment.intent = intent;
      commitment.intentSha256 = intent.intentSha256;
      commitment.intentFileSha256 = createHash("sha256").update(`${canonicalJson(intent)}\n`).digest("hex");
      commitment.commitmentSha256 = hashJson(Object.fromEntries(Object.entries(commitment).filter(([key]) => key !== "commitmentSha256")));
    });
    harness.httpCalls.length = 0;
    await expectCode(harness.cleanup.resume(harness.runId), "mutation-intent-state-preflight");
    assert.equal(harness.httpCalls.some((request) => request.method === "DELETE"), false);
  }

  // 3. Sequence 0 has one anchor filename, with no numeric variant.
  for (const alongside of [false, true]) {
    const harness = makeHarness();
    await harness.cleanup.start(harness.runId);
    const canonicalPath = harness.path("cleanup-state-anchor.json");
    writeExclusive(harness.path("cleanup-state-anchor-000000.json"), readJson(canonicalPath));
    if (!alongside) unlinkSync(canonicalPath);
    harness.httpCalls.length = 0;
    await expectCode(harness.cleanup.resume(harness.runId), "state-name");
    assert.equal(harness.httpCalls.some((request) => request.method === "DELETE"), false);
  }

  // 4. Only the start checkpoint may carry a null preflight tuple.
  {
    let crashed = true;
    const harness = makeHarness({
      faultAt: ({ event, filePath }) => {
        if (crashed && event === "after-directory-fsync" && /cleanup-state-anchor-000001\.json$/u.test(filePath ?? "")) {
          crashed = false;
          return true;
        }
        return false;
      },
    });
    await harness.cleanup.start(harness.runId);
    await assert.rejects(harness.cleanup.resume(harness.runId));
    harness.setFault(undefined);
    rebindStateEnvelope(harness, 1, (state) => {
      state.preflightReceiptSha256 = null;
      state.preflightVerifierId = null;
      state.preflightVerifierSha256 = null;
    });
    await expectCode(harness.cleanup.resume(harness.runId), "state-preflight-verifier");
  }

  // 5. Terminal state and absence receipt carry the same complete preflight tuple.
  {
    const harness = makeHarness();
    await harness.cleanup.start(harness.runId);
    harness.active.clear();
    await harness.cleanup.resume(harness.runId);
    rewriteJson(harness.path(ABSENCE_RECEIPT_FILENAME), (receipt) => {
      receipt.preflightReceiptSha256 = "b".repeat(64);
      receipt.sha256 = hashJson(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "sha256")));
    });
    rebindStateEnvelope(harness, 1, (state) => {
      state.absenceReceiptSha256 = createHash("sha256").update(readFileSync(harness.path(ABSENCE_RECEIPT_FILENAME))).digest("hex");
    });
    await expectCode(harness.cleanup.resume(harness.runId), "absence-receipt-linkage");
  }
});

test("every nested durable schema is directly mutated through its intended validator", async () => {
  const cases = [
    {
      name: "guard argv",
      mutate: (harness) => rewriteJson(harness.path("guard-receipt.json"), (value) => { value.guardArgv[0] = "--mode=wrong"; }),
      run: "start",
      code: "guard-receipt-schema",
    },
    {
      name: "operation head",
      prepare: async (harness) => { await harness.cleanup.start(harness.runId); },
      mutate: (harness) => rewriteJson(harness.path(OPERATION_MANIFEST_FILENAME), (value) => {
        value.manifestFilename = "cleanup-manifest-999999.json";
        value.headSha256 = hashJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "headSha256")));
      }),
      run: "resume",
      code: "operation-manifest-head-context",
    },
    {
      name: "state anchor",
      prepare: async (harness) => { await harness.cleanup.start(harness.runId); },
      mutate: (harness) => rewriteJson(harness.path("cleanup-state-anchor.json"), (value) => {
        value.preflightVerifierId = "wrong-verifier";
        value.anchorSha256 = hashJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "anchorSha256")));
      }),
      run: "resume",
      code: "state-anchor-context",
    },
    {
      name: "journal head",
      prepare: async (harness) => { await harness.cleanup.start(harness.runId); },
      mutate: (harness) => rewriteJson(harness.path("cleanup-journal-head-000000.json"), (value) => {
        value.preflightVerifierId = "wrong-verifier";
        value.headSha256 = hashJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "headSha256")));
      }),
      run: "resume",
      code: "journal-head-context",
    },
    {
      name: "external commitment",
      prepare: async (harness) => { await harness.cleanup.start(harness.runId); },
      mutate: (harness) => rewriteJson(path.join(commitmentDirectory(harness), "cleanup-journal-commitment-000000.json"), (value) => {
        value.preflightVerifierId = "wrong-verifier";
        value.commitmentSha256 = hashJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "commitmentSha256")));
      }),
      run: "resume",
      code: "journal-commitment-context",
    },
    {
      name: "absence receipt",
      prepare: async (harness) => { await harness.cleanup.start(harness.runId); harness.active.clear(); await harness.cleanup.resume(harness.runId); },
      mutate: (harness) => rewriteJson(harness.path(ABSENCE_RECEIPT_FILENAME), (value) => {
        value.preflightVerifierId = "wrong-verifier";
        value.sha256 = hashJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256")));
      }),
      run: "resume",
      code: "absence-receipt-linkage",
    },
    {
      name: "caller identity",
      mutate: (harness) => rewriteJson(harness.path(DESCRIPTOR_FILENAME), (value) => { value.callerIdentity.objectId = "not-a-guid"; }),
      run: "start",
      code: "descriptor-caller",
    },
    {
      name: "binding backend",
      mutate: (harness) => {
        const create = rewriteJson(harness.path("create-manifest.json"), (value) => {
          value.bindings.backend.key = "changed.tfstate";
          value.bindingSha256 = hashJson(value.bindings);
        });
        rewriteJson(harness.path(DESCRIPTOR_FILENAME), (value) => {
          value.bindingSha256 = create.bindingSha256;
          value.contextSha256 = create.bindingSha256;
        });
      },
      run: "start",
      code: "context-backend-hash",
    },
    {
      name: "dependency entry",
      mutate: (harness) => {
        const create = rewriteJson(harness.path("create-manifest.json"), (value) => {
          value.bindings.dependencyBlobs = [{ path: "changed.mjs", blob: "bad", sha256: "1".repeat(64) }];
          value.bindingSha256 = hashJson(value.bindings);
        });
        rewriteJson(harness.path(DESCRIPTOR_FILENAME), (value) => {
          value.bindingSha256 = create.bindingSha256;
          value.contextSha256 = create.bindingSha256;
        });
      },
      run: "start",
      code: "context-dependency",
    },
    {
      name: "supersession",
      mutate: (harness) => rewriteJson(harness.path(DESCRIPTOR_FILENAME), (value) => {
        value.supersession = { oldRunId: "bad/run", cleanupManifestSha256: "0".repeat(64), absenceReceiptSha256: "1".repeat(64), contextSha256: "2".repeat(64) };
      }),
      run: "start",
      code: "invalid-run-id",
    },
    {
      name: "state inventory",
      prepare: async (harness) => { await harness.cleanup.start(harness.runId); },
      mutate: (harness) => rebindStateEnvelope(harness, 0, (state) => { state.inventory.activeNames = ["not-a-target"]; }),
      run: "resume",
      code: "state-inventory-names",
    },
    {
      name: "target state",
      prepare: async (harness) => { await harness.cleanup.start(harness.runId); },
      mutate: (harness) => rebindStateEnvelope(harness, 0, (state) => { state.inventory.targetStates[0].activeCount = 0; }),
      run: "resume",
      code: "state-inventory-state",
    },
  ];
  for (const candidate of cases) {
    const harness = makeHarness({ autoPreflight: candidate.run !== "start" });
    if (candidate.prepare) await candidate.prepare(harness);
    candidate.mutate(harness);
    await expectCode(harness.cleanup[candidate.run](harness.runId), candidate.code);
  }
});

test("a runtime preflight receipt is mandatory, fresh, closed, and journal-bound before every DELETE", async () => {
  const missing = makeHarness({ autoPreflight: false });
  await missing.cleanup.start(missing.runId);
  await expectCode(missing.cleanup.resume(missing.runId), "preflight-receipt-missing");
  assert.equal(missing.httpCalls.some((request) => request.method === "DELETE"), false);

  const tampered = makeHarness();
  await tampered.cleanup.start(tampered.runId);
  rewriteJson(tampered.path(PREFLIGHT_RECEIPT_FILENAME), (value) => {
    value.runtimeIdentity.objectId = "44444444-4444-4444-8444-444444444444";
    value.receiptSha256 = hashJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "receiptSha256")));
  });
  await expectCode(tampered.cleanup.resume(tampered.runId), "preflight-runtime-identity");
  assert.equal(tampered.httpCalls.some((request) => request.method === "DELETE"), false);

  const bound = makeHarness();
  await bound.cleanup.start(bound.runId);
  bound.setFault(({ event, filePath }) => event === "after-directory-fsync" && /cleanup-state-anchor-000001\.json$/u.test(filePath ?? ""));
  // The first durable attempt checkpoint is enough to inspect the receipt
  // binding even when the injected fault prevents the mutation phase.
  await assert.rejects(bound.cleanup.resume(bound.runId));
  const state = readJson(bound.path("cleanup-state-000001.json"));
  assert.equal(state.preflightReceiptSha256.length, 64);
  assert.equal(state.preflightVerifierId, PREFLIGHT_VERIFIER_ID);
  assert.equal(state.preflightVerifierSha256.length, 64);
});

test("resume handles every two-target partial combination without replay", async () => {
  const states = ["active", "deleted", "absent"];
  for (const first of states) {
    for (const second of states) {
      const harness = makeHarness();
      await harness.cleanup.start(harness.runId);
      harness.active.clear();
      harness.deleted.clear();
      for (const [name, state] of [[TARGET_SECRET_NAMES[0], first], [TARGET_SECRET_NAMES[1], second]]) {
        if (state === "active") harness.active.add(name);
        if (state === "deleted") harness.deleted.add(name);
      }
      await harness.cleanup.resume(harness.runId);
      assert.deepEqual([...harness.active], []);
      assert.deepEqual([...harness.deleted], []);
    }
  }
});

test("every mutation crash boundary is reconciled and never reads a mutation body", async () => {
  for (const crashAction of ["delete", "purge"]) {
    const harness = makeHarness();
    await harness.cleanup.start(harness.runId);
    if (crashAction === "purge") {
      harness.active.delete(TARGET_SECRET_NAMES[0]);
      harness.deleted.add(TARGET_SECRET_NAMES[0]);
    }
    let crashed = false;
    harness.setFault(({ event, action }) => event === "after-mutation-request" && action === crashAction && !crashed && (crashed = true));
    await assert.rejects(harness.cleanup.resume(harness.runId));
    harness.setFault(undefined);
    await harness.cleanup.resume(harness.runId);
    const requests = harness.httpCalls.filter((request) => request.method === "DELETE");
    assert.equal(requests.filter((request) => new URL(request.url).pathname.endsWith(`${crashAction === "delete" ? "/secrets" : "/deletedsecrets"}/${TARGET_SECRET_NAMES[0]}`)).length, 1);
    assert.equal(requests.every((request) => request.responseMode === "empty"), true);
    assert.deepEqual([...harness.active], []);
    assert.deepEqual([...harness.deleted], []);
  }
});

test("a SIGKILL after absence receipt publication reconciles the orphan before returning absent", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  harness.active.clear();
  const result = killAtPublicationSubprocess(harness, ABSENCE_RECEIPT_FILENAME);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(stateFiles(harness).length, 1);
  assert.equal(readJson(harness.path(stateFiles(harness)[0])).status, "start-inventory-validated");
  const recovered = await harness.cleanup.resume(harness.runId);
  assert.deepEqual(recovered, { status: "absent", runId: harness.runId });
  const terminal = readJson(harness.path(stateFiles(harness).at(-1)));
  assert.equal(terminal.status, "complete");
  assert.equal(terminal.absenceReceiptSha256, createHash("sha256").update(readFileSync(harness.path(ABSENCE_RECEIPT_FILENAME))).digest("hex"));
});

test("each DELETE is pinned to one fresh preflight receipt through the external mutation chain", async () => {
  let changed = false;
  const harness = makeHarness({
    httpState: {
      onRequest: (request, controls) => {
        if (request.method !== "DELETE") return undefined;
        const url = new URL(request.url);
        const name = url.pathname.split("/").at(-1);
        if (url.pathname.startsWith("/secrets/")) {
          controls.active.delete(name);
          controls.deleted.add(name);
          if (!changed) {
            changed = true;
            rewriteJson(path.join(controls.directory, PREFLIGHT_RECEIPT_FILENAME), (receipt) => {
              receipt.deadlineAt = new Date(Date.parse(receipt.deadlineAt) - 1_000).toISOString();
              receipt.receiptSha256 = hashJson(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptSha256")));
            });
          }
        }
        return { statusCode: 202, body: "must-not-be-read" };
      },
    },
  });
  await harness.cleanup.start(harness.runId);
  await expectCode(harness.cleanup.resume(harness.runId), "purge-preflight-chain");
  assert.equal(harness.httpCalls.filter((request) => request.method === "DELETE").length, 1);
  assert.equal(harness.active.has(TARGET_SECRET_NAMES[1]), true);
  assert.equal(readdirSync(commitmentDirectory(harness)).some((entry) => /^cleanup-mutation-commitment-000000\.json$/u.test(entry)), true);
  assert.equal(readdirSync(commitmentDirectory(harness)).some((entry) => /^cleanup-mutation-intent-000000\.json$/u.test(entry)), true);
});

test("operation head and immutable manifest divergence cannot be authorized by paired self-rehashes", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  const headPath = harness.path(OPERATION_MANIFEST_FILENAME);
  const head = readJson(headPath);
  const immutablePath = harness.path(head.manifestFilename);
  head.previousManifestSha256 = "0".repeat(64);
  head.sha256 = hashJson(Object.fromEntries(Object.entries(head).filter(([key]) => ![
    "manifestFilename", "manifestSha256", "previousHeadSha256", "headSha256", "sha256",
  ].includes(key))));
  head.headSha256 = hashJson(Object.fromEntries(Object.entries(head).filter(([key]) => key !== "headSha256")));
  unlinkSync(headPath);
  writeExclusive(headPath, head);

  const anchorPath = path.join(commitmentDirectory(harness), "cleanup-operation-head-000001.json");
  const anchor = readJson(anchorPath);
  anchor.headSha256 = createHash("sha256").update(readFileSync(headPath)).digest("hex");
  anchor.manifestSha256 = createHash("sha256").update(readFileSync(immutablePath)).digest("hex");
  anchor.anchorSha256 = hashJson(Object.fromEntries(Object.entries(anchor).filter(([key]) => key !== "anchorSha256")));
  unlinkSync(anchorPath);
  writeExclusive(anchorPath, anchor);

  harness.httpCalls.length = 0;
  await expectCode(harness.cleanup.resume(harness.runId), "operation-manifest-head-reference");
  assert.equal(harness.httpCalls.some((request) => request.method === "DELETE"), false);
});

test("every checkpoint carries the exact mutation tail, including genesis, and tail tampering is fail-closed", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  const initialState = readJson(harness.path("cleanup-state-000000.json"));
  assert.deepEqual(
    { sequence: initialState.mutationTailSequence, sha256: initialState.mutationTailSha256 },
    { sequence: -1, sha256: null },
  );
  await harness.cleanup.resume(harness.runId);

  const stateNames = stateFiles(harness);
  const tailIntentPath = path.join(commitmentDirectory(harness), "cleanup-mutation-intent-000003.json");
  const tailHash = createHash("sha256").update(readFileSync(tailIntentPath)).digest("hex");
  const terminalState = readJson(harness.path(stateNames.at(-1)));
  assert.deepEqual(
    { sequence: terminalState.mutationTailSequence, sha256: terminalState.mutationTailSha256 },
    { sequence: 3, sha256: tailHash },
  );
  const receipt = readJson(harness.path(ABSENCE_RECEIPT_FILENAME));
  assert.equal(receipt.mutationTailSequence, terminalState.mutationTailSequence);
  assert.equal(receipt.mutationTailSha256, terminalState.mutationTailSha256);
  for (const stateName of stateNames) {
    const sequence = Number(stateName.match(/(\d{6})/u)[1]);
    const state = readJson(harness.path(stateName));
    const anchor = readJson(harness.path(sequence === 0 ? "cleanup-state-anchor.json" : `cleanup-state-anchor-${String(sequence).padStart(6, "0")}.json`));
    const head = readJson(harness.path(`cleanup-journal-head-${String(sequence).padStart(6, "0")}.json`));
    const commitment = readJson(path.join(commitmentDirectory(harness), `cleanup-journal-commitment-${String(sequence).padStart(6, "0")}.json`));
    for (const checkpoint of [anchor, head, commitment]) {
      assert.equal(checkpoint.mutationTailSequence, state.mutationTailSequence);
      assert.equal(checkpoint.mutationTailSha256, state.mutationTailSha256);
    }
  }

  const changed = makeHarness();
  await changed.cleanup.start(changed.runId);
  let crashed = true;
  changed.setFault(({ event }) => {
    if (crashed && event === "after-mutation-request") {
      crashed = false;
      return true;
    }
    return false;
  });
  await assert.rejects(changed.cleanup.resume(changed.runId));
  changed.setFault(undefined);
  const intentPath = path.join(commitmentDirectory(changed), "cleanup-mutation-intent-000000.json");
  const commitmentPath = path.join(commitmentDirectory(changed), "cleanup-mutation-commitment-000000.json");
  const intent = readJson(intentPath);
  intent.target = TARGET_SECRET_NAMES[1];
  intent.intentSha256 = hashJson(Object.fromEntries(Object.entries(intent).filter(([key]) => key !== "intentSha256")));
  unlinkSync(intentPath);
  writeExclusive(intentPath, intent);
  const mutationCommitment = readJson(commitmentPath);
  mutationCommitment.intent = intent;
  mutationCommitment.intentSha256 = intent.intentSha256;
  mutationCommitment.intentFileSha256 = createHash("sha256").update(`${canonicalJson(intent)}\n`).digest("hex");
  mutationCommitment.commitmentSha256 = hashJson(Object.fromEntries(Object.entries(mutationCommitment).filter(([key]) => key !== "commitmentSha256")));
  unlinkSync(commitmentPath);
  writeExclusive(commitmentPath, mutationCommitment);
  changed.httpCalls.length = 0;
  await expectCode(changed.cleanup.resume(changed.runId), "state-mutation-tail-history");
  assert.equal(changed.httpCalls.some((request) => request.method === "DELETE"), false);

  const selfRehashed = makeHarness();
  await selfRehashed.cleanup.start(selfRehashed.runId);
  selfRehashed.setFault(({ event }) => event === "after-mutation-request");
  await assert.rejects(selfRehashed.cleanup.resume(selfRehashed.runId));
  selfRehashed.setFault(undefined);
  rebindStateEnvelope(selfRehashed, 2, (state) => {
    state.mutationTailSha256 = "e".repeat(64);
  });
  selfRehashed.httpCalls.length = 0;
  await expectCode(selfRehashed.cleanup.resume(selfRehashed.runId), "state-mutation-tail-history");
  assert.equal(selfRehashed.httpCalls.some((request) => request.method === "DELETE"), false);

  const truncated = makeHarness();
  await truncated.cleanup.start(truncated.runId);
  truncated.setFault(({ event }) => event === "after-mutation-request");
  await assert.rejects(truncated.cleanup.resume(truncated.runId));
  truncated.setFault(undefined);
  unlinkSync(path.join(commitmentDirectory(truncated), "cleanup-mutation-intent-000000.json"));
  unlinkSync(path.join(commitmentDirectory(truncated), "cleanup-mutation-commitment-000000.json"));
  truncated.httpCalls.length = 0;
  await expectCode(truncated.cleanup.resume(truncated.runId), "state-mutation-tail-history");
  assert.equal(truncated.httpCalls.some((request) => request.method === "DELETE"), false);

  const replay = makeHarness();
  await replay.cleanup.start(replay.runId);
  replay.setFault(({ event }) => event === "after-mutation-request");
  await assert.rejects(replay.cleanup.resume(replay.runId));
  replay.setFault(undefined);
  const firstCommitment = readJson(path.join(commitmentDirectory(replay), "cleanup-mutation-commitment-000000.json"));
  writeExclusive(path.join(commitmentDirectory(replay), "cleanup-mutation-commitment-000001.json"), firstCommitment);
  replay.httpCalls.length = 0;
  await expectCode(replay.cleanup.resume(replay.runId), "mutation-commitment-context");
  assert.equal(replay.httpCalls.some((request) => request.method === "DELETE"), false);

  const deleted = makeHarness();
  await deleted.cleanup.start(deleted.runId);
  await deleted.cleanup.resume(deleted.runId);
  unlinkSync(path.join(commitmentDirectory(deleted), "cleanup-mutation-intent-000003.json"));
  deleted.httpCalls.length = 0;
  await expectCode(deleted.cleanup.resume(deleted.runId), "mutation-intent-deleted");
  assert.equal(deleted.httpCalls.some((request) => request.method === "DELETE"), false);
});

test("durable absence receipt binds operation, plan, context, and terminal inventory", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  harness.active.clear();
  await harness.cleanup.resume(harness.runId);
  const receipt = readJson(harness.path(ABSENCE_RECEIPT_FILENAME));
  assert.equal(receipt.type, "absence");
  assert.equal(receipt.inventory.keyVault, "absent");
  assert.equal(receipt.inventory.runtimeSecretReferences, 0);
  const { sha256: receiptHash, ...unsignedReceipt } = receipt;
  assert.equal(receiptHash, hashJson(unsignedReceipt));
  assert.equal(readJson(harness.path("cleanup-state-000001.json")).status, "complete");
});

test("recomputed absence receipt mutations cannot detach the terminal journal", async () => {
  const inventoryMutation = makeHarness();
  await inventoryMutation.cleanup.start(inventoryMutation.runId);
  inventoryMutation.active.clear();
  await inventoryMutation.cleanup.resume(inventoryMutation.runId);
  rewriteJson(inventoryMutation.path(ABSENCE_RECEIPT_FILENAME), (receipt) => {
    receipt.inventory.runtimeSecretReferences = 1;
    receipt.sha256 = hashJson(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "sha256")));
  });
  await expectCode(inventoryMutation.cleanup.resume(inventoryMutation.runId), "absence-receipt-linkage");

  const linkageMutation = makeHarness();
  await linkageMutation.cleanup.start(linkageMutation.runId);
  linkageMutation.active.clear();
  await linkageMutation.cleanup.resume(linkageMutation.runId);
  rewriteJson(linkageMutation.path("cleanup-state-000001.json"), (state) => {
    state.absenceReceiptSha256 = "f".repeat(64);
    state.stateSha256 = hashJson(Object.fromEntries(Object.entries(state).filter(([key]) => key !== "stateSha256")));
  });
  await expectCode(linkageMutation.cleanup.resume(linkageMutation.runId), "absence-receipt-linkage");
});

test("only lifecycle artifact names are published and both envelopes are closed v2 self-hashes", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  assert.equal(existsSync(harness.path("cleanup-operation-manifest.json")), false);
  const manifest = readJson(harness.path("cleanup-manifest.json"));
  assert.deepEqual(Object.keys(manifest).sort(), [
    "bindingSha256", "contextSha256", "createdAt", "headSha256", "operation", "phase", "planSha256",
    "journalCommitmentPath", "manifestFilename", "manifestSha256", "previousHeadSha256", "previousManifestSha256",
    "repositoryCommit", "runId", "runtimeSecretReferences", "sequence", "sha256", "status", "supersession", "type", "utilitySha256", "vaultResourceId", "version",
  ].sort());
  const version = readJson(harness.path(manifest.manifestFilename));
  const { sha256: manifestHash, ...unsignedManifest } = version;
  assert.equal(manifest.version, 3);
  assert.equal(manifestHash, hashJson(unsignedManifest));
  assert.equal(manifest.sha256, version.sha256);
  assert.equal(manifest.headSha256, hashJson(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "headSha256"))));
  assert.equal(manifest.manifestFilename, "cleanup-manifest-000001.json");
  assert.equal(existsSync(harness.path("cleanup-manifest-000000.json")), true);
  harness.active.clear();
  await harness.cleanup.resume(harness.runId);
  const receipt = readJson(harness.path(ABSENCE_RECEIPT_FILENAME));
  assert.deepEqual(Object.keys(receipt).sort(), [
    "bindingSha256", "contextSha256", "createdAt", "inventory", "operation", "phase", "planSha256",
    "mutationTailSequence", "mutationTailSha256", "preflightReceiptSha256", "preflightVerifierId", "preflightVerifierSha256", "repositoryCommit", "runId", "sha256", "status", "supersession", "type", "version",
  ].sort());
  const { sha256: absenceHash, ...unsignedReceipt } = receipt;
  assert.equal(receipt.version, 3);
  assert.equal(absenceHash, hashJson(unsignedReceipt));
});

test("prepared manifest recovery only records the exact start proof before any mutation", async () => {
  let fail = true;
  const harness = makeHarness({
    processRunner: (request, controls) => fail
      ? ({ status: null, timedOut: true, stdout: "" })
      : ({ status: 0, stdout: JSON.stringify({ accessToken: jwt(request.argv[3], controls.now()) }) }),
  });
  await expectCode(harness.cleanup.start(harness.runId), "token-timeout");
  assert.equal(stateFiles(harness).length, 0);
  fail = false;
  const checkpoint = await harness.cleanup.resume(harness.runId);
  assert.equal(checkpoint.status, "start-inventory-validated");
  assert.equal(harness.httpCalls.some((request) => request.method === "DELETE"), false);
  assert.equal(stateFiles(harness).length, 1);
  harness.writePreflight();
  await harness.cleanup.resume(harness.runId);
  assert.deepEqual([...harness.active], []);
  assert.deepEqual([...harness.deleted], []);
});

test("utility history accepts current and recorded-commit hashes, but rejects invalid or mixed histories", async () => {
  const currentUtilitySha256 = fileSha256(new URL("./cleanup-key-vault-credentials.mjs", import.meta.url));
  for (const [label, repositoryCommit, utilitySha256, expected] of [
    ["current", COMMIT, currentUtilitySha256, undefined],
    ["historical", HISTORICAL_UTILITY_COMMIT, HISTORICAL_UTILITY_SHA256, undefined],
    ["neither", HISTORICAL_UTILITY_COMMIT, "0".repeat(64), "operation-manifest-version-context"],
    ["non-ancestor", NON_ANCESTOR_UTILITY_COMMIT, HISTORICAL_UTILITY_SHA256, "operation-manifest-version-context"],
    ["unknown-commit", "d".repeat(40), HISTORICAL_UTILITY_SHA256, "operation-manifest-version-context"],
  ]) {
    let blocked = true;
    const harness = makeHarness({
      repositoryCommit,
      autoPreflight: false,
      processRunner: (request, controls) => blocked
        ? ({ status: null, timedOut: true, stdout: "" })
        : ({ status: 0, stdout: JSON.stringify({ accessToken: jwt(request.argv[3], controls.now()) }) }),
    });
    await expectCode(harness.cleanup.start(harness.runId), "token-timeout");
    rebindPreparedOperationUtility(harness, utilitySha256);
    blocked = false;
    if (expected === undefined) {
      assert.deepEqual(await harness.cleanup.resume(harness.runId), {
        status: "start-inventory-validated",
        runId: harness.runId,
      });
    } else {
      await expectCode(harness.cleanup.resume(harness.runId), expected);
    }
    if (label === "historical") {
      harness.writePreflight();
      rewriteJson(harness.path(PREFLIGHT_RECEIPT_FILENAME), (receipt) => {
        receipt.verifierSha256 = HISTORICAL_UTILITY_SHA256;
        receipt.receiptSha256 = hashJson(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptSha256")));
      });
      harness.active.clear();
      assert.deepEqual(await harness.cleanup.resume(harness.runId), { status: "absent", runId: harness.runId });
      assert.deepEqual(await harness.cleanup.assertAbsent(harness.runId), { status: "absent", runId: harness.runId });
    }
  }

  const mixed = makeHarness({
    repositoryCommit: HISTORICAL_UTILITY_COMMIT,
    autoPreflight: false,
    processRunner: () => ({ status: null, timedOut: true, stdout: "" }),
  });
  await expectCode(mixed.cleanup.start(mixed.runId), "token-timeout");
  rebindPreparedOperationUtility(mixed, HISTORICAL_UTILITY_SHA256);
  const firstVersion = readJson(mixed.path("cleanup-manifest-000000.json"));
  const secondVersion = {
    ...firstVersion,
    status: "completed",
    sequence: 1,
    utilitySha256: currentUtilitySha256,
    previousManifestSha256: fileSha256(mixed.path("cleanup-manifest-000000.json")),
    sha256: null,
  };
  secondVersion.sha256 = hashJson(Object.fromEntries(Object.entries(secondVersion).filter(([key]) => key !== "sha256")));
  writeExclusive(mixed.path("cleanup-manifest-000001.json"), secondVersion);
  await expectCode(mixed.cleanup.resume(mixed.runId), "operation-manifest-history");
});

test("external journal heads reject paired tail deletion while terminal receipts remain protected", async () => {
  const terminal = makeHarness();
  await terminal.cleanup.start(terminal.runId);
  terminal.active.clear();
  await terminal.cleanup.resume(terminal.runId);
  unlinkSync(terminal.path("cleanup-state-000001.json"));
  unlinkSync(terminal.path("cleanup-state-anchor-000001.json"));
  terminal.httpCalls.length = 0;
  await expectCode(terminal.cleanup.resume(terminal.runId), "state-history");
  assert.equal(terminal.httpCalls.some((request) => request.method === "DELETE"), false);

  const nonterminal = makeHarness();
  await nonterminal.cleanup.start(nonterminal.runId);
  unlinkSync(nonterminal.path("cleanup-state-000000.json"));
  unlinkSync(nonterminal.path("cleanup-state-anchor.json"));
  await expectCode(nonterminal.cleanup.resume(nonterminal.runId), "state-history");
});

test("external commitment is outside the journal, monotonic, closed, and rejects tail truncation", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  harness.active.clear();
  await harness.cleanup.resume(harness.runId);
  assert.deepEqual(commitmentFiles(harness), [
    "cleanup-journal-commitment-000000.json",
    "cleanup-journal-commitment-000001.json",
  ]);
  assert.equal(path.dirname(commitmentDirectory(harness)), harness.root + `/${JOURNAL_COMMITMENT_DIRECTORY_NAME}`);
  const commitment = readJson(path.join(commitmentDirectory(harness), "cleanup-journal-commitment-000001.json"));
  assert.equal(readJson(harness.path(OPERATION_MANIFEST_FILENAME)).journalCommitmentPath, `${JOURNAL_COMMITMENT_DIRECTORY_NAME}/${harness.runId}`);
  assert.equal(commitment.latestSequence, 1);
  assert.equal(commitment.previousCommitmentSha256.length, 64);
  assert.equal(lstatSync(commitmentDirectory(harness)).mode & 0o777, 0o700);
  assert.equal(lstatSync(path.join(commitmentDirectory(harness), "cleanup-journal-commitment-000001.json")).mode & 0o777, 0o600);

  unlinkSync(harness.path("cleanup-state-000001.json"));
  unlinkSync(harness.path("cleanup-state-anchor-000001.json"));
  unlinkSync(harness.path("cleanup-journal-head-000001.json"));
  await expectCode(harness.cleanup.resume(harness.runId), "journal-commitment-tail");

  const tampered = makeHarness();
  await tampered.cleanup.start(tampered.runId);
  const commitmentPath = path.join(commitmentDirectory(tampered), "cleanup-journal-commitment-000000.json");
  const value = readJson(commitmentPath);
  value.extra = true;
  unlinkSync(commitmentPath);
  writeExclusive(commitmentPath, value);
  await expectCode(tampered.cleanup.resume(tampered.runId), "journal-commitment-schema");
});

test("SIGKILL at the external commitment and its recovery leaves a committed intent chain", async () => {
  const intentCrash = makeHarness();
  await intentCrash.cleanup.start(intentCrash.runId);
  const result = killAtPublicationSubprocess(intentCrash, "cleanup-mutation-commitment-000000.json", true);
  assert.equal(result.signal, "SIGKILL");
  const recovered = await intentCrash.cleanup.resume(intentCrash.runId);
  assert.equal(recovered.status, "absent");
  assert.equal(readdirSync(commitmentDirectory(intentCrash)).filter((entry) => /^cleanup-mutation-commitment-\d{6}\.json$/u.test(entry)).length >= 2, true);
});

test("production subprocess SIGKILLs between state/head/anchor publication and recovers the committed journal", async () => {
  for (const target of [
    "cleanup-state-000001.json",
    "cleanup-journal-head-000001.json",
    "cleanup-state-anchor-000001.json",
  ]) {
    const harness = makeHarness();
    await harness.cleanup.start(harness.runId);
    harness.active.clear();
    const result = killAtPublicationSubprocess(harness, target);
    assert.equal(result.signal, "SIGKILL");
    const recovered = await harness.cleanup.resume(harness.runId);
    assert.equal(recovered.status, "absent");
    assert.equal(stateFiles(harness).length >= 2, true);
  }
});

test("recovery from a durable attempting checkpoint consumes another attempt and fixed backoff", async () => {
  let crashed = true;
  const harness = makeHarness({
    faultAt: ({ event, filePath }) => {
      if (crashed && event === "after-directory-fsync" && /cleanup-state-anchor-000001\.json$/u.test(filePath ?? "")) {
        crashed = false;
        return true;
      }
      return false;
    },
  });
  await harness.cleanup.start(harness.runId);
  await assert.rejects(harness.cleanup.resume(harness.runId));
  assert.equal(harness.httpCalls.some((request) => request.method === "DELETE"), false);
  const attempted = readJson(harness.path("cleanup-state-000001.json"));
  assert.equal(attempted.status, "attempting");
  assert.equal(attempted.attempts, 1);
  await harness.cleanup.resume(harness.runId);
  assert.equal(harness.sleepCalls[0], RETRY_BACKOFF_MS);
  assert.equal(harness.sleepCalls.every((value) => value === RETRY_BACKOFF_MS), true);
  assert.equal(harness.sleepCalls.length, 5);
  assert.deepEqual([...harness.active], []);
  assert.deepEqual([...harness.deleted], []);
  assert.equal(readJson(harness.path("cleanup-state-000002.json")).attempts, 2);
});

test("manifest finalization crash points never create a mutation permission without a durable state", async () => {
  let recoverableFault = true;
  const recoverable = makeHarness({
    faultAt: ({ event }) => {
      if (recoverableFault && event === "before-manifest-head-rename") {
        recoverableFault = false;
        return true;
      }
      return false;
    },
  });
  await assert.rejects(recoverable.cleanup.start(recoverable.runId));
  assert.equal(readJson(recoverable.path(OPERATION_MANIFEST_FILENAME)).status, "prepared");
  const first = await recoverable.cleanup.resume(recoverable.runId);
  assert.equal(first.status, "start-inventory-validated");
  assert.equal(recoverable.httpCalls.some((request) => request.method === "DELETE"), false);

  const failClosed = makeHarness({ faultAt: ({ event }) => event === "after-manifest-head-rename" });
  await assert.rejects(failClosed.cleanup.start(failClosed.runId));
  assert.equal(readJson(failClosed.path(OPERATION_MANIFEST_FILENAME)).status, "completed");
  await expectCode(failClosed.cleanup.resume(failClosed.runId), "state-history");
  assert.equal(failClosed.httpCalls.some((request) => request.method === "DELETE"), false);
});

test("SIGKILL during immutable manifest publication recovers the old committed head without cleanup", async () => {
  const versionCrash = makeHarness({ autoPreflight: false });
  const versionResult = killAtManifestPublicationSubprocess(versionCrash, "cleanup-manifest-000001.json");
  assert.equal(versionResult.signal, "SIGKILL");
  const checkpoint = await versionCrash.cleanup.resume(versionCrash.runId);
  assert.equal(checkpoint.status, "start-inventory-validated");
  assert.equal(readJson(versionCrash.path(OPERATION_MANIFEST_FILENAME)).sequence, 1);

  const headCrash = makeHarness({ autoPreflight: false });
  const headResult = killAtManifestPublicationSubprocess(headCrash, "cleanup-manifest.json");
  assert.equal(headResult.signal, "SIGKILL");
  await expectCode(headCrash.cleanup.resume(headCrash.runId), "state-history");
  assert.equal(existsSync(headCrash.path("cleanup-manifest-000000.json")), true);
  assert.equal(existsSync(headCrash.path("cleanup-manifest-000001.json")), true);
});

test("real SIGKILLs at manifest write, fsync, and rename boundaries recover safely", async () => {
  for (const [target, event] of [
    ["cleanup-manifest-000001.json", "after-file-fsync"],
    ["cleanup-manifest-000001.json", "before-rename"],
    ["cleanup-manifest.json", "after-manifest-head-write"],
    ["cleanup-manifest.json", "after-manifest-head-fsync"],
    ["cleanup-manifest.json", "after-manifest-head-rename"],
  ]) {
    const harness = makeHarness({ autoPreflight: false });
    const result = killAtManifestPublicationSubprocess(harness, target, event);
    assert.equal(result.signal, "SIGKILL");
    if (event === "after-manifest-head-rename") {
      await expectCode(harness.cleanup.resume(harness.runId), "state-history");
    } else {
      const checkpoint = await harness.cleanup.resume(harness.runId);
      assert.equal(checkpoint.status, "start-inventory-validated");
      assert.equal(harness.httpCalls.some((request) => request.method === "DELETE"), false);
    }
  }
});

test("operation head rollback, truncation, and replay are rejected by the external monotonic chain", async () => {
  const rollback = makeHarness();
  await rollback.cleanup.start(rollback.runId);
  rollback.active.clear();
  await rollback.cleanup.resume(rollback.runId);
  const oldOperation = readJson(rollback.path("cleanup-manifest-000000.json"));
  const oldHead = {
    ...oldOperation,
    manifestFilename: "cleanup-manifest-000000.json",
    manifestSha256: createHash("sha256").update(readFileSync(rollback.path("cleanup-manifest-000000.json"))).digest("hex"),
    previousHeadSha256: null,
    headSha256: null,
  };
  oldHead.headSha256 = hashJson(Object.fromEntries(Object.entries(oldHead).filter(([key]) => key !== "headSha256")));
  unlinkSync(rollback.path(OPERATION_MANIFEST_FILENAME));
  writeExclusive(rollback.path(OPERATION_MANIFEST_FILENAME), oldHead);
  await expectCode(rollback.cleanup.resume(rollback.runId), "operation-head-rollback");
  assert.equal(oldHead.sequence, 0);

  const truncated = makeHarness();
  await truncated.cleanup.start(truncated.runId);
  truncated.active.clear();
  await truncated.cleanup.resume(truncated.runId);
  unlinkSync(path.join(commitmentDirectory(truncated), "cleanup-operation-head-000001.json"));
  await expectCode(truncated.cleanup.resume(truncated.runId), "operation-head-rollback");

  const replay = makeHarness();
  await replay.cleanup.start(replay.runId);
  replay.active.clear();
  await replay.cleanup.resume(replay.runId);
  const anchorPath = path.join(commitmentDirectory(replay), "cleanup-operation-head-000001.json");
  const anchor = readJson(path.join(commitmentDirectory(replay), "cleanup-operation-head-000000.json"));
  unlinkSync(anchorPath);
  writeExclusive(anchorPath, anchor);
  await expectCode(replay.cleanup.resume(replay.runId), "operation-head-anchor-context");
});

test("supersession validates prior manifest/absence hashes and inherits only terminal inventory", async () => {
  const oldRun = makeHarness();
  await oldRun.cleanup.start(oldRun.runId);
  oldRun.active.clear();
  await oldRun.cleanup.resume(oldRun.runId);
  const oldManifestSha256 = createHash("sha256").update(readFileSync(oldRun.path(OPERATION_MANIFEST_FILENAME))).digest("hex");
  const oldAbsenceSha256 = createHash("sha256").update(readFileSync(oldRun.path(ABSENCE_RECEIPT_FILENAME))).digest("hex");
  const oldReceipt = readJson(oldRun.path(ABSENCE_RECEIPT_FILENAME));
  const replacement = makeHarness({
    root: oldRun.root,
    runId: "credential-run-2",
    preflight: true,
    supersession: {
      oldRunId: oldRun.runId,
      cleanupManifestSha256: oldManifestSha256,
      absenceReceiptSha256: oldAbsenceSha256,
      contextSha256: oldReceipt.contextSha256,
    },
  });
  replacement.active.clear();
  await replacement.cleanup.start(replacement.runId);
  assert.equal(replacement.httpCalls.some((request) => request.method === "DELETE"), false);
  await replacement.cleanup.assertAbsent(replacement.runId);
  const bad = makeHarness({
    root: oldRun.root,
    runId: "credential-run-3",
    supersession: {
      oldRunId: oldRun.runId,
      cleanupManifestSha256: "d".repeat(64),
      absenceReceiptSha256: oldAbsenceSha256,
      contextSha256: oldReceipt.contextSha256,
    },
  });
  bad.active.clear();
  await expectCode(bad.cleanup.start(bad.runId), "supersession-manifest-hash");
});

test("complete is terminal/read-only forever and recreation requires recovery", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  harness.active.clear();
  await harness.cleanup.resume(harness.runId);
  const before = readdirSync(harness.directory).sort();
  harness.active.add(TARGET_SECRET_NAMES[0]);
  await expectCode(harness.cleanup.resume(harness.runId), "terminal-recreation");
  await expectCode(harness.cleanup.assertAbsent(harness.runId), "terminal-recreation");
  assert.equal(harness.httpCalls.some((request) => request.method === "DELETE"), false);
  assert.deepEqual(readdirSync(harness.directory).sort(), before);
});

test("subsequent preflight is revalidated without making it a prerequisite for start", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  harness.writePreflight();
  harness.active.clear();
  await harness.cleanup.resume(harness.runId);
  const tampered = makeHarness();
  await tampered.cleanup.start(tampered.runId);
  tampered.writePreflight();
  const value = readJson(tampered.path("preflight-receipt.json"));
  value.result = "failed";
  unlinkSync(tampered.path("preflight-receipt.json"));
  writeExclusive(tampered.path("preflight-receipt.json"), value);
  await expectCode(tampered.cleanup.resume(tampered.runId), "preflight-receipt-schema");
});

test("attempt ceiling uses exactly three durable attempts and fixed backoff", async () => {
  const harness = makeHarness({ httpState: { deleteStatus: 500 } });
  await harness.cleanup.start(harness.runId);
  for (let attempt = 0; attempt < MUTATION_ATTEMPT_LIMIT; attempt += 1) await expectCode(harness.cleanup.resume(harness.runId), "delete-rejected");
  await expectCode(harness.cleanup.resume(harness.runId), "attempt-ceiling");
  assert.deepEqual(harness.sleepCalls, [RETRY_BACKOFF_MS, RETRY_BACKOFF_MS]);
  const states = stateFiles(harness).map((file) => readJson(harness.path(file)));
  assert.deepEqual(states.filter((state) => state.status === "attempting").map((state) => state.attempts), [1, 2, 3]);
  assert.deepEqual(states.filter((state) => state.status === "unknown").map((state) => state.attempts), [1, 2, 3]);
  assert.equal(states.at(-1).cumulativeElapsedMs, RETRY_BACKOFF_MS * 2);
});

test("third-attempt reconciliation permits a terminal receipt but never a fourth mutation", async () => {
  let deletes = 0;
  const harness = makeHarness({
    httpState: {
      onRequest: (request, controls) => {
        if (request.method !== "DELETE") return undefined;
        deletes += 1;
        if (deletes === MUTATION_ATTEMPT_LIMIT) {
          controls.active.clear();
          controls.deleted.clear();
        }
        return { statusCode: 500, body: "must-not-be-read" };
      },
    },
  });
  await harness.cleanup.start(harness.runId);
  for (let attempt = 0; attempt < MUTATION_ATTEMPT_LIMIT; attempt += 1) {
    await expectCode(harness.cleanup.resume(harness.runId), "delete-rejected");
  }
  await harness.cleanup.resume(harness.runId);
  assert.equal(deletes, MUTATION_ATTEMPT_LIMIT);
  assert.equal(readJson(harness.path(ABSENCE_RECEIPT_FILENAME)).status, "absent");
  assert.equal(readJson(harness.path(stateFiles(harness).at(-1))).status, "complete");
});

test("near the cumulative ceiling a mutation is not started without convergence time", async () => {
  let deletes = 0;
  const harness = makeHarness({
    httpState: {
      onRequest: (request) => {
        if (request.method === "DELETE") deletes += 1;
        return undefined;
      },
    },
  });
  await harness.cleanup.start(harness.runId);
  harness.advance(CUMULATIVE_ELAPSED_LIMIT_MS - 5_000);
  await expectCode(harness.cleanup.resume(harness.runId), "invocation-deadline");
  assert.equal(deletes, 0);
});

test("cumulative deadline is exact, accounted once, and read-only assertion remains available", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  harness.advance(CUMULATIVE_ELAPSED_LIMIT_MS);
  await expectCode(harness.cleanup.resume(harness.runId), "elapsed-ceiling");
  await expectCode(harness.cleanup.assertAbsent(harness.runId), "secret-not-absent");
  const exact = makeHarness();
  await exact.cleanup.start(exact.runId);
  exact.active.clear();
  exact.advance(CUMULATIVE_ELAPSED_LIMIT_MS);
  await exact.cleanup.assertAbsent(exact.runId);
  assert.equal(exact.sleepCalls.length, 0);
});

test("stale journal resumes read-only past the ceiling when all targets are already absent", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  harness.active.clear();
  harness.deleted.clear();
  harness.advance(CUMULATIVE_ELAPSED_LIMIT_MS + 1);
  const deleteCallsBefore = harness.httpCalls.filter((request) => request.method === "DELETE").length;

  assert.deepEqual(await harness.cleanup.resume(harness.runId), { status: "absent", runId: harness.runId });
  assert.equal(harness.httpCalls.filter((request) => request.method === "DELETE").length, deleteCallsBefore);
  const state = readJson(harness.path(stateFiles(harness).at(-1)));
  assert.equal(state.status, "complete");
  assert.equal(state.sequence, 1);
  assert.equal(state.cumulativeElapsedMs, CUMULATIVE_ELAPSED_LIMIT_MS);
  assert.equal(state.inventory.targetStates.every((target) => target.state === "absent"), true);
});

test("a soft-deleted target blocks verification-only completion past the ceiling", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  harness.active.clear();
  // One target remains soft-deleted (recoverable), so absence is not proven.
  harness.deleted.add("openrouter-api-key");
  harness.advance(CUMULATIVE_ELAPSED_LIMIT_MS + 1);
  await expectCode(harness.cleanup.resume(harness.runId), "elapsed-ceiling");
  const state = readJson(harness.path(stateFiles(harness).at(-1)));
  assert.notEqual(state.status, "complete");
});

test("a delete 404 is journaled as an idempotent already-absent result", async () => {
  let firstDelete = true;
  const harness = makeHarness({
    httpState: {
      onRequest: (request, controls) => {
        if (request.method !== "DELETE" || !firstDelete) return undefined;
        firstDelete = false;
        const name = new URL(request.url).pathname.split("/").at(-1);
        controls.active.delete(name);
        controls.deleted.delete(name);
        return { statusCode: 404, body: "secret-already-absent" };
      },
    },
  });
  await harness.cleanup.start(harness.runId);
  await harness.cleanup.resume(harness.runId);

  assert.equal(readJson(harness.path(stateFiles(harness).at(-1))).status, "complete");
  assert.equal(readJson(harness.path(stateFiles(harness).at(-1))).inventory.targetStates[0].state, "absent");
  assert.equal(readJson(path.join(commitmentDirectory(harness), "cleanup-mutation-intent-000000.json")).action, "delete");
  assert.equal(harness.httpCalls.some((request) => request.method === "DELETE" && request.responseMode !== "empty"), false);
});

test("completed-operation resume confirms after the mutation ceiling without deleting", async () => {
  const harness = makeHarness();
  await harness.cleanup.start(harness.runId);
  harness.active.clear();
  await harness.cleanup.resume(harness.runId);
  const deleteCallsBefore = harness.httpCalls.filter((request) => request.method === "DELETE").length;

  harness.advance(CUMULATIVE_ELAPSED_LIMIT_MS);
  assert.deepEqual(await harness.cleanup.resume(harness.runId), { status: "absent", runId: harness.runId });
  assert.equal(harness.httpCalls.filter((request) => request.method === "DELETE").length, deleteCallsBefore);
});

test("token and HTTP deadlines are bounded and response values remain unread", async () => {
  const tokenHang = makeHarness({ processRunner: () => ({ status: null, timedOut: true, stdout: "" }) });
  await expectCode(tokenHang.cleanup.start(tokenHang.runId), "token-timeout");
  assert.equal(tokenHang.azCalls[0].timeoutMs, TOKEN_TIMEOUT_MS);

  const serviceApplicationAudience = makeHarness({
    processRunner: (request, controls) => ({
      status: 0,
      stdout: JSON.stringify({
        accessToken: jwt(
          request.argv[3] === AZURE_VAULT_RESOURCE
            ? AZURE_KEY_VAULT_SERVICE_APPLICATION_ID
            : request.argv[3],
          controls.now(),
        ),
      }),
    }),
  });
  await serviceApplicationAudience.cleanup.start(serviceApplicationAudience.runId);

  const arrayAudience = makeHarness({
    processRunner: (request, controls) => ({
      status: 0,
      stdout: JSON.stringify({
        accessToken: jwt(
          request.argv[3] === AZURE_VAULT_RESOURCE
            ? [AZURE_VAULT_RESOURCE, AZURE_KEY_VAULT_SERVICE_APPLICATION_ID]
            : request.argv[3],
          controls.now(),
        ),
      }),
    }),
  });
  await expectCode(arrayAudience.cleanup.start(arrayAudience.runId), "token-audience");

  const nonCanonicalManagementAudience = makeHarness({
    processRunner: (request, controls) => ({
      status: 0,
      stdout: JSON.stringify({
        accessToken: jwt(
          request.argv[3] === AZURE_MANAGEMENT_RESOURCE
            ? AZURE_MANAGEMENT_RESOURCE.replace(/\/$/u, "")
            : request.argv[3],
          controls.now(),
        ),
      }),
    }),
  });
  await expectCode(nonCanonicalManagementAudience.cleanup.start(nonCanonicalManagementAudience.runId), "token-audience");

  let bodyRead = 0;
  const mutationBody = makeHarness({
    httpState: {
      onRequest: (request, controls) => {
        if (request.method === "DELETE") {
          const url = new URL(request.url);
          const name = url.pathname.split("/").at(-1);
          if (url.pathname.startsWith("/secrets/")) {
            controls.active.delete(name);
            controls.deleted.add(name);
          } else {
            controls.deleted.delete(name);
          }
          const result = { statusCode: 202 };
          Object.defineProperty(result, "body", { get() { bodyRead += 1; throw new Error("body read"); } });
          return result;
        }
        return undefined;
      },
    },
  });
  await mutationBody.cleanup.start(mutationBody.runId);
  await mutationBody.cleanup.resume(mutationBody.runId);
  assert.equal(bodyRead, 0);
  assert.equal(mutationBody.httpCalls.filter((request) => request.method === "DELETE").every((request) => request.responseMode === "empty"), true);
  assert.equal(INVOCATION_DEADLINE_MS, 180_000);
  assert.equal(HTTP_TIMEOUT_MS, 15_000);
});

test("inventory accepts only exact vault-bound IDs and rejects malformed or duplicate states", async () => {
  const cases = [
    { activeBody: listBody([TARGET_SECRET_NAMES[0], TARGET_SECRET_NAMES[0], TARGET_SECRET_NAMES[1]], "active"), code: "active-inventory-duplicate" },
    { activeBody: listBody([TARGET_SECRET_NAMES[0], TARGET_SECRET_NAMES[1]], "active"), deletedBody: listBody([TARGET_SECRET_NAMES[0]], "deleted"), code: "inventory-both-active-and-deleted" },
    { activeBody: JSON.stringify({ value: [{ id: `${VAULT_URI}secrets/${TARGET_SECRET_NAMES[0]}`, attributes: {} }], nextLink: null }), code: "active-inventory-metadata" },
    { activeBody: JSON.stringify({ value: [{ id: "https://other.vault.azure.net/secrets/openrouter-api-key", attributes: { enabled: true } }], nextLink: null }), code: "active-inventory-context" },
    { activeBody: JSON.stringify({ value: [{ id: `${VAULT_URI}secrets/${TARGET_SECRET_NAMES[0]}`, value: "never-read" }], nextLink: null }), code: "active-inventory-item" },
    { activeBody: JSON.stringify({ value: [{ id: `${VAULT_URI}secrets/${TARGET_SECRET_NAMES[0]}/version`, attributes: { enabled: true } }], nextLink: null }), code: "active-inventory-id" },
    { activeBody: JSON.stringify({ value: [], nextLink: "https://vault.invalid/page" }), code: "active-inventory-schema" },
  ];
  for (const candidate of cases) {
    const harness = makeHarness({ httpState: candidate });
    await expectCode(harness.cleanup.start(harness.runId), candidate.code);
    assert.equal(existsSync(harness.path(OPERATION_MANIFEST_FILENAME)), true);
  }
});

test("active and deleted inventories follow bounded same-vault nextLink pages before exact validation", async () => {
  const paged = makeHarness({
    httpState: {
      onRequest: (request) => {
        const url = new URL(request.url);
        if (request.method !== "GET") return undefined;
        if (url.pathname === "/secrets") {
          if (url.searchParams.get("$skiptoken") === null) {
            return { statusCode: 200, body: JSON.stringify({
              value: [{ id: `${VAULT_URI}secrets/${TARGET_SECRET_NAMES[0]}`, attributes: { enabled: true } }],
              nextLink: `${VAULT_URI}secrets?api-version=7.4&$skiptoken=page-2`,
            }) };
          }
          return { statusCode: 200, body: JSON.stringify({
            value: [{ id: `${VAULT_URI}secrets/${TARGET_SECRET_NAMES[1]}`, attributes: { enabled: true } }],
            nextLink: null,
          }) };
        }
        if (url.pathname === "/deletedsecrets") {
          return { statusCode: 200, body: JSON.stringify({ value: [], nextLink: null }) };
        }
        return undefined;
      },
    },
  });
  await paged.cleanup.start(paged.runId);
  assert.equal(paged.httpCalls.filter((request) => request.method === "GET" && new URL(request.url).pathname === "/secrets").length, 2);

  const duplicate = makeHarness({
    httpState: {
      onRequest: (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/secrets") {
          return { statusCode: 200, body: JSON.stringify({
            value: [{ id: `${VAULT_URI}secrets/${TARGET_SECRET_NAMES[0]}`, attributes: { enabled: true } }],
            nextLink: url.searchParams.has("$skiptoken")
              ? null
              : `${VAULT_URI}secrets?api-version=7.4&$skiptoken=duplicate`,
          }) };
        }
        if (request.method === "GET" && url.pathname === "/deletedsecrets") return { statusCode: 200, body: JSON.stringify({ value: [], nextLink: null }) };
        return undefined;
      },
    },
  });
  await expectCode(duplicate.cleanup.start(duplicate.runId), "active-inventory-duplicate");

  const cycle = makeHarness({
    httpState: {
      onRequest: (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/secrets") {
          return { statusCode: 200, body: JSON.stringify({ value: [], nextLink: request.url }) };
        }
        if (request.method === "GET" && url.pathname === "/deletedsecrets") return { statusCode: 200, body: JSON.stringify({ value: [], nextLink: null }) };
        return undefined;
      },
    },
  });
  await expectCode(cycle.cleanup.start(cycle.runId), "active-inventory-pagination-cycle");
});

test("protected descriptor/state artifacts reject symlinks, wrong modes, removal, and replacement", async () => {
  const symlinkHarness = makeHarness();
  unlinkSync(symlinkHarness.path(DESCRIPTOR_FILENAME));
  symlinkSync(symlinkHarness.path("plan.tfplan"), symlinkHarness.path(DESCRIPTOR_FILENAME));
  await expectCode(symlinkHarness.cleanup.start(symlinkHarness.runId), "descriptor-file");
  const modeHarness = makeHarness();
  chmodSync(modeHarness.path(DESCRIPTOR_FILENAME), 0o644);
  await expectCode(modeHarness.cleanup.start(modeHarness.runId), "descriptor-mode");
  const removed = makeHarness();
  await removed.cleanup.start(removed.runId);
  unlinkSync(removed.path("cleanup-state-000000.json"));
  await expectCode(removed.cleanup.resume(removed.runId), "state-history");
});

test("200 Deleted Secret Bundles are accepted without reading the body", async () => {
  const harness = makeHarness({
    httpState: {
      onRequest: (request, controls) => {
        if (request.method !== "DELETE") return undefined;
        const url = new URL(request.url);
        const name = url.pathname.split("/").at(-1);
        if (url.pathname.startsWith("/secrets/")) {
          controls.active.delete(name);
          controls.deleted.add(name);
        } else {
          controls.deleted.delete(name);
        }
        const result = { statusCode: 200, headers: { "content-type": "application/json", "content-length": "100" } };
        Object.defineProperty(result, "body", { get() { throw new Error("must not read"); } });
        return result;
      },
    },
  });
  await harness.cleanup.start(harness.runId);
  await harness.cleanup.resume(harness.runId);
});

test("live shared-context drift is re-read and rejected before every vault access", async () => {
  const mutations = [
    (value) => ({ ...value, repositoryCommit: "d".repeat(40) }),
    (value) => ({ ...value, terraformSha256: "e".repeat(64) }),
    (value) => ({ ...value, dependencyBlobs: [{ path: "changed.mjs", blob: "f".repeat(40), sha256: "1".repeat(64) }] }),
    (value) => ({ ...value, backend: { ...value.backend, key: "changed.tfstate" } }),
    (value) => ({ ...value, workspace: "changed" }),
    (value) => ({ ...value, stateLineage: "changed-lineage" }),
    (value) => ({ ...value, stateSerial: value.stateSerial + 1 }),
    (value) => ({ ...value, azureContextHash: "2".repeat(64) }),
    (value) => ({ ...value, callerHash: "3".repeat(64) }),
  ];
  for (const mutate of mutations) {
    const harness = makeHarness();
    harness.setLiveContext(mutate(harness.bindings));
    await expectCode(harness.cleanup.start(harness.runId), "live-context-drift");
    assert.equal(harness.azCalls.length, 0);
    assert.equal(existsSync(harness.path(OPERATION_MANIFEST_FILENAME)), true);
  }
});

test("post-apply recovery accepts one state serial advance and historical code identities only on resume/assert-absent", async () => {
  const postApply = makeHarness();
  await postApply.cleanup.start(postApply.runId);
  postApply.active.clear();
  postApply.setLiveContext({ ...postApply.bindings, stateSerial: postApply.bindings.stateSerial + 1 });
  assert.deepEqual(await postApply.cleanup.resume(postApply.runId), { status: "absent", runId: postApply.runId });
  assert.deepEqual(await postApply.cleanup.assertAbsent(postApply.runId), { status: "absent", runId: postApply.runId });

  const serialTooFar = makeHarness();
  await serialTooFar.cleanup.start(serialTooFar.runId);
  serialTooFar.setLiveContext({ ...serialTooFar.bindings, stateSerial: serialTooFar.bindings.stateSerial + 2 });
  await expectCode(serialTooFar.cleanup.resume(serialTooFar.runId), "live-context-drift");

  const changedLineage = makeHarness();
  await changedLineage.cleanup.start(changedLineage.runId);
  changedLineage.setLiveContext({
    ...changedLineage.bindings,
    stateLineage: "changed-lineage",
    stateSerial: changedLineage.bindings.stateSerial + 1,
  });
  await expectCode(changedLineage.cleanup.resume(changedLineage.runId), "live-context-drift");

  const historicalStart = makeHarness({ repositoryCommit: HISTORICAL_UTILITY_COMMIT });
  historicalStart.setLiveContext({
    ...historicalStart.bindings,
    ...CURRENT_CODE_BINDINGS,
    repositoryCommit: COMMIT,
  });
  await expectCode(historicalStart.cleanup.start(historicalStart.runId), "live-context-drift");

  const historicalResume = makeHarness({ repositoryCommit: HISTORICAL_UTILITY_COMMIT });
  await historicalResume.cleanup.start(historicalResume.runId);
  historicalResume.active.clear();
  historicalResume.setLiveContext({
    ...historicalResume.bindings,
    ...CURRENT_CODE_BINDINGS,
    repositoryCommit: COMMIT,
    stateSerial: historicalResume.bindings.stateSerial + 1,
  });
  assert.deepEqual(await historicalResume.cleanup.resume(historicalResume.runId), { status: "absent", runId: historicalResume.runId });
  assert.deepEqual(await historicalResume.cleanup.assertAbsent(historicalResume.runId), { status: "absent", runId: historicalResume.runId });

  const nonAncestor = makeHarness({ repositoryCommit: NON_ANCESTOR_UTILITY_COMMIT });
  await nonAncestor.cleanup.start(nonAncestor.runId);
  nonAncestor.active.clear();
  nonAncestor.setLiveContext({ ...nonAncestor.bindings, stateSerial: nonAncestor.bindings.stateSerial + 1 });
  await expectCode(nonAncestor.cleanup.resume(nonAncestor.runId), "live-context-drift");
});

test("preflight order and age are enforced independently of plan creation", async () => {
  const equal = makeHarness();
  await equal.cleanup.start(equal.runId);
  equal.writePreflight();
  const equalReceipt = readJson(equal.path("preflight-receipt.json"));
  equalReceipt.createdAt = CREATE_TIME;
  equalReceipt.deadlineAt = new Date(Date.parse(CREATE_TIME) + PREFLIGHT_MAX_AGE_MS).toISOString();
  equalReceipt.receiptSha256 = hashJson(Object.fromEntries(Object.entries(equalReceipt).filter(([key]) => key !== "receiptSha256")));
  unlinkSync(equal.path("preflight-receipt.json"));
  writeExclusive(equal.path("preflight-receipt.json"), equalReceipt);
  await expectCode(equal.cleanup.resume(equal.runId), "preflight-order");

  const expired = makeHarness();
  await expired.cleanup.start(expired.runId);
  expired.writePreflight();
  expired.setWallNow(Date.parse(PREFLIGHT_TIME) + 2 * 60 * 1000 + 1);
  await expectCode(expired.cleanup.resume(expired.runId), "preflight-expired");
});

test("child, request, and invocation cancellation abort the underlying operation", async () => {
  let processSignal;
  const token = makeHarness({
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    processRunner: (request) => {
      processSignal = request.signal;
      return new Promise(() => {});
    },
  });
  await expectCode(token.cleanup.start(token.runId), "token-timeout");
  assert.equal(processSignal?.aborted, true);

  let timerCount = 0;
  let httpSignal;
  const request = makeHarness({
    setTimeout: (callback) => {
      timerCount += 1;
      if (timerCount === 2) callback();
      return timerCount;
    },
    clearTimeout: () => {},
    httpState: {
      onRequest: (value) => {
        httpSignal = value.signal;
        return new Promise(() => {});
      },
    },
  });
  await expectCode(request.cleanup.start(request.runId), "arm-timeout");
  assert.equal(httpSignal?.aborted, true);
});

test("test adapters cannot bypass production-context validation with a null reader", () => {
  const harness = makeHarness();
  assert.throws(
    () => createCleanupForTests({
      root: harness.root,
      lowLevel: { processRunner: () => ({ status: 0, stdout: "" }), httpRequest: () => ({ statusCode: 200, body: "" }) },
    }),
    (error) => error?.code === "context-reader",
  );
});

test("production subprocesses use the exact approved cwd for git and Terraform", async () => {
  const root = path.resolve(process.cwd());
  const git = await productionProcess({
    command: "/usr/bin/git",
    argv: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: root,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
  });
  assert.equal(git.status, 0);
  assert.equal(git.timedOut, false);

  const contextHarness = makeHarness();
  const contextCalls = [];
  const contextProcessRunner = async (request) => {
    contextCalls.push({
      command: request.command,
      argv: [...request.argv],
      cwd: request.cwd,
      env: { ...request.env },
    });
    if (request.command === "/usr/bin/git") {
      if (request.argv[0] === "status") return { status: 0, stdout: "" };
      return { status: 0, stdout: `${COMMIT}\n` };
    }
    if (request.command === TERRAFORM_PATH) {
      if (request.argv[0] === "workspace") return { status: 0, stdout: "default\n" };
      return { status: 0, stdout: JSON.stringify({
        lineage: "lineage-test",
        serial: 7,
        outputs: {
          key_vault_id: { value: RESOURCE_ID },
          key_vault_uri: { value: VAULT_URI },
          relay_latest_revision_name: { value: "revision-test" },
        },
      }) };
    }
    if (request.command === AZ_PATH) {
      if (request.argv[0] === "account") return { status: 0, stdout: JSON.stringify({ environmentName: "AzureCloud", id: SUBSCRIPTION, tenantId: TENANT, user: { type: "user" } }) };
      return { status: 0, stdout: JSON.stringify({ id: OBJECT_ID }) };
    }
    throw new Error("unexpected production-context command");
  };
  const context = await productionContextReaderForTests(
    { runId: contextHarness.runId },
    { root: contextHarness.root, processRunner: contextProcessRunner },
  );
  const dependencyPaths = [
    "infra/scripts/verify-acr-image-platform.mjs",
    "infra/scripts/assert-dev-plan.mjs",
    "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
    "infra/scripts/fixtures/azure-generation-cutover.plan-fixture.json",
    "infra/scripts/fixtures/azure-credential-cleanup.plan-fixture.json",
    "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
  ];
  assert.deepEqual(
    contextCalls.map(({ command, argv, cwd }) => ({ command, argv, cwd })),
    [
      { command: "/usr/bin/git", argv: ["status", "--porcelain=v1", "--untracked-files=all"], cwd: root },
      { command: "/usr/bin/git", argv: ["rev-parse", "HEAD"], cwd: root },
      ...dependencyPaths.map((dependency) => ({ command: "/usr/bin/git", argv: ["rev-parse", `HEAD:${dependency}`], cwd: root })),
      { command: TERRAFORM_PATH, argv: ["workspace", "show"], cwd: path.join(root, "infra/environments/dev") },
      { command: TERRAFORM_PATH, argv: ["state", "pull"], cwd: path.join(root, "infra/environments/dev") },
      { command: AZ_PATH, argv: ["account", "show", "--output", "json"], cwd: "/" },
      { command: AZ_PATH, argv: ["ad", "signed-in-user", "show", "--output", "json"], cwd: "/" },
    ],
  );
  for (const call of contextCalls) assert.deepEqual(call.env, {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    AZURE_CONFIG_DIR: "/home/dev/.azure",
    XDG_CACHE_HOME: "/home/dev/.local/state/palancar/azure-foundry-entra-cutover-cache",
  });
  assert.equal(context.repositoryCommit, COMMIT);
  assert.equal(context.cwd, path.join(root, "infra/environments/dev"));
  assert.equal(context.workspace, "default");
  assert.equal(context.stateLineage, "lineage-test");
  assert.equal(context.stateSerial, 7);

  const modulePath = new URL("./cleanup-key-vault-credentials.mjs", import.meta.url).pathname;
  const audienceChild = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { productionAudienceProbeForTests } from ${JSON.stringify(modulePath)};
    try {
      const verdict = await productionAudienceProbeForTests();
      process.stdout.write(verdict === true ? "ok\\n" : "bad\\n");
      if (verdict !== true) process.exitCode = 1;
    } catch {
      process.exitCode = 1;
    }
  `], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", AZURE_CONFIG_DIR: "/home/dev/.azure", XDG_CACHE_HOME: "/home/dev/.local/state/palancar/azure-foundry-entra-cutover-cache" },
    encoding: "utf8",
  });
  assert.equal(audienceChild.status, 0);
  assert.equal(audienceChild.stdout, "ok\n");
  assert.equal(audienceChild.stderr, "");

  const terraformLockPath = path.join(root, "infra/environments/dev/.terraform.tfvars.lock");
  const hadTerraformLock = existsSync(terraformLockPath);
  try {
    const terraform = await productionProcess({
      command: "/home/dev/.local/bin/terraform-1.15.8",
      argv: ["version"],
      cwd: path.join(root, "infra/environments/dev"),
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    assert.equal(terraform.status, 0);
    assert.match(terraform.stdout, /Terraform v1\.15\.8/u);
  } finally {
    if (!hadTerraformLock && existsSync(terraformLockPath)) unlinkSync(terraformLockPath);
  }

  await assert.rejects(
    productionProcess({
      command: "/bin/pwd",
      argv: [],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 5_000,
    }),
    (error) => error?.code === "process-cwd",
  );

  const controller = new AbortController();
  const tree = productionProcess({
    command: "/bin/sh",
    argv: ["-c", "sleep 30 & wait"],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const cancelled = await tree;
  assert.equal(cancelled.timedOut, true);
  assert.equal(cancelled.status, null);
});

test("production lock path is a protected kernel-lock protocol and CLI never accepts a vault argument", async () => {
  const source = readFileSync(new URL("./cleanup-key-vault-credentials.mjs", import.meta.url), "utf8");
  assert.equal(source.includes('spawn("/usr/bin/flock"'), true);
  assert.equal(source.includes('"-n", "-x"'), true);
  assert.equal(source.includes("PALANCAR_CLEANUP_LOCK_TOKEN"), true);
  assert.equal(source.includes("process.kill(-child.pid, signal)"), true);
  assert.equal(source.includes("OUTER_SIGNAL_GRACE_MS"), true);
  assert.equal(OUTER_SIGNAL_GRACE_MS > 0, true);
  assert.equal(source.includes("renameSync(temporary, filePath)"), true);
  assert.equal(parseCli(["start", VAULT_URI]), undefined);
  assert.equal(await runCli(["--__palancar-cleanup-locked-b1b", "start", "run-1"]), 1);
});

test("inherited lock validation accepts direct flock and lifecycle nesting, and rejects forged ancestry", () => {
  const direct = runCleanupLockProbe("direct");
  assert.equal(direct.status, 2);
  assert.equal(direct.stdout, "");
  assert.equal(direct.stderr, "");

  const lifecycle = runCleanupLockProbe("lifecycle");
  assert.equal(lifecycle.status, 0);
  assert.deepEqual(lifecycle.probe, { status: 2, stdout: "", stderr: "" });

  const parentNeither = runCleanupLockProbe("parent-neither");
  assert.equal(parentNeither.status, 1);
  assert.equal(parentNeither.stdout, "");
  assert.equal(parentNeither.stderr, "cleanup-key-vault-credentials: rejected lock-failed\n");

  const wrongGrandparent = runCleanupLockProbe("wrong-grandparent");
  assert.equal(wrongGrandparent.status, 0);
  assert.deepEqual(wrongGrandparent.probe, {
    status: 1,
    stdout: "",
    stderr: "cleanup-key-vault-credentials: rejected lock-failed\n",
  });

  const mismatchedPath = path.join(mkdtempSync(path.join(tmpdir(), "palancar-lock-inode-")), "other.lock");
  temporaryRoots.add(path.dirname(mismatchedPath));
  writeExclusive(mismatchedPath, "not-the-kernel-lock\n");
  const mismatchedInode = runCleanupLockProbe("lifecycle", mismatchedPath);
  assert.equal(mismatchedInode.status, 0);
  assert.deepEqual(mismatchedInode.probe, {
    status: 1,
    stdout: "",
    stderr: "cleanup-key-vault-credentials: rejected lock-failed\n",
  });
});

test("production CLI preserves stdout/stderr and exit status through the real flock subprocess", () => {
  const script = new URL("./cleanup-key-vault-credentials.mjs", import.meta.url).pathname;
  const rejected = spawnSync(process.execPath, [script, "start", "definitely-missing-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  assert.match(rejected.stderr, /cleanup-key-vault-credentials: rejected run-directory-missing\n/u);

  const usage = spawnSync(process.execPath, [script, "start", "run-1", "extra"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, "");
  assert.equal(usage.stderr, "");
});

test("outer signal forwarding kills an ignoring detached child tree after the bounded grace", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "palancar-flock-signal-"));
  temporaryRoots.add(root);
  const lockPath = path.join(root, "lock");
  const lockFd = openSync(lockPath, "wx", 0o600);
  const childCode = "import { spawn } from 'node:child_process'; spawn('/bin/sh', ['-c', \"trap '' TERM INT HUP; sleep 30\"], { stdio: 'ignore' }); setInterval(() => {}, 1000);";
  const operation = runOuterFlock(
    { lockPath, lockFd, token: "a".repeat(64) },
    [],
    process.execPath,
    ["--input-type=module", "-e", childCode],
  );
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 25);
  try {
    const result = await operation;
    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGKILL");
  } finally {
    closeSync(lockFd);
  }
});

test("same-root concurrent operations cannot bypass the descriptor-bound lock", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = makeHarness({ httpState: { onRequest: async () => gate } });
  const first = harness.cleanup.start(harness.runId);
  await new Promise((resolve) => setImmediate(resolve));
  await expectCode(harness.cleanup.resume(harness.runId), "lock-contention");
  release();
  await first;
});
