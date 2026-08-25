#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
  statSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const DEFAULT_WORKDIR = path.join(REPOSITORY_ROOT, "infra/environments/dev");

export const EVIDENCE_ROOT =
  "/home/dev/.local/state/palancar/azure-foundry-entra-cutover";
export const CLOSURE_PATH =
  "/home/dev/.local/state/palancar/azure-foundry-entra-cutover-closure";
const CLEANUP_UTILITY_PATH = path.join(
  path.dirname(SCRIPT_PATH),
  "cleanup-key-vault-credentials.mjs",
);
const CLEANUP_UTILITY_RELATIVE_PATH = "infra/scripts/cleanup-key-vault-credentials.mjs";
const LIFECYCLE_CACHE_ROOT =
  "/home/dev/.local/state/palancar/azure-foundry-entra-cutover-cache";
export const TERRAFORM_PATH = "/home/dev/.local/bin/terraform-1.15.8";
export const TERRAFORM_SHA256 =
  "00f55981f5215594c418cd6b20f44fa4c99f9126650602e65d533d131005ea81";
export const AZ_PATH = "/usr/bin/az";
export const BACKEND_SHA256 =
  "171c599d84b399299b6bed79a730396ff9500df2f43c906f193db647d194fb22";
export const GENERATION_DIFF_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const RETIRED_SECRET_NAMES = Object.freeze([
  "openrouter-api-key",
  "litellm-master-key",
]);
const ENTRA_ROLES = Object.freeze({
  acrPull: "7f951dda-4ed3-4680-a7ca-43fe172d538d",
  tableDataContributor: "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3",
  openAiUser: "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd",
  monitoringMetricsPublisher: "3913510d-42f4-4e42-8a64-420c390055eb",
  keyVaultSecretsUser: "4633458b-17de-408a-b874-0445c86b69e6",
});
const ROLE_ASSIGNMENT_SECURITY_KEYS = Object.freeze([
  "id", "principalId", "principalType", "roleDefinitionId", "scope",
]);
const PRIVATE_HTTP_MAX_BYTES = 256 * 1024;
const PRIVATE_HTTP_TIMEOUT_MS = 30 * 1000;
const AZURE_VAULT_SCOPE = "https://vault.azure.net";
const AZURE_VAULT_API_VERSION = "7.4";

export const PHASES = Object.freeze([
  "model-bootstrap",
  "runtime-cutover",
  "credential-cleanup",
  "terminal",
]);
export const OPERATIONS = Object.freeze([
  "init",
  "create",
  "guard",
  "diagnostic",
  "preflight",
  "apply",
  "reconcile",
  "supersede",
  "finalize",
  "close",
]);
export const GUARD_MAPPINGS = Object.freeze({
  "model-bootstrap": "luna-model-bootstrap",
  "runtime-cutover": "azure-generation-cutover",
  "credential-cleanup": "azure-credential-cleanup",
  terminal: "final-rollout-complete",
});
const SUPPORTED_GUARD_MAPPINGS = Object.freeze([
  "luna-model-bootstrap",
  "azure-generation-cutover",
  "azure-credential-cleanup",
  "final-rollout-complete",
]);

const STATE_NAMES = Object.freeze([
  "manual-Luna-absent",
  "model-applied",
  "runtime-applied",
  "credentials-and-RBAC-cleaned",
  "terminal-verified",
]);
const STATE_FOR_PHASE = Object.freeze({
  "model-bootstrap": "manual-Luna-absent",
  "runtime-cutover": "model-applied",
  "credential-cleanup": "runtime-applied",
  terminal: "credentials-and-RBAC-cleaned",
});
const ADVANCED_STATE = Object.freeze({
  "model-bootstrap": "model-applied",
  "runtime-cutover": "runtime-applied",
  "credential-cleanup": "credentials-and-RBAC-cleaned",
  terminal: "terminal-verified",
});
const PLAN_MAX_AGE_MS = Object.freeze({
  "model-bootstrap": 15 * 60 * 1000,
  "runtime-cutover": 15 * 60 * 1000,
  "credential-cleanup": 30 * 60 * 1000,
  terminal: 30 * 60 * 1000,
});
const PREFLIGHT_MAX_AGE_MS = 2 * 60 * 1000;
const RECEIPT_MAX_BYTES = 1024;
const JSON_MAX_BYTES = 8 * 1024 * 1024;
const PLAN_MAX_BYTES = 64 * 1024 * 1024;
const REVOCATION_RAW_MAX_BYTES = 1024 * 1024;
const REVOCATION_LOCK_MAX_BYTES = 128;
const EXECUTABLE_MAX_BYTES = 256 * 1024 * 1024;
const COMMAND_OUTPUT_MAX_BYTES = JSON_MAX_BYTES;
const COMMAND_TIMEOUT_MS = 120 * 1000;
const IMAGE_VERIFIER_TIMEOUT_MS = 120 * 1000;
const IMAGE_VERIFIER_OUTPUT_MAX_BYTES = 64 * 1024;
const IMAGE_VERIFIER_PATH = "infra/scripts/verify-acr-image-platform.mjs";
const IMAGE_VERIFIER_ARTIFACT_NAME = "verify-acr-image-platform.mjs";
const ACR_LOGIN_SERVER_RE = /^[a-z0-9]{5,50}\.azurecr\.io$/;
const IMAGE_REFERENCE_RE = /^([a-z0-9]{5,50}\.azurecr\.io)\/(palancar-relay|palancar-expiry-cleanup)@(sha256:[a-f0-9]{64})$/;
const IMAGE_DESCRIPTOR_KEYS = Object.freeze([
  "version", "reference", "repository", "manifestDigest", "manifestMediaType",
  "configDigest", "configMediaType", "os", "architecture", "variant",
]);
const IMAGE_MANIFEST_MEDIA_TYPES = Object.freeze({
  "application/vnd.oci.image.manifest.v1+json": "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json": "application/vnd.docker.container.image.v1+json",
});
const APPLY_TIMEOUT_MS = 15 * 60 * 1000;
const ARTIFACT_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const APPLY_TERM_GRACE_MS = 250;
const APPLY_KILL_GRACE_MS = 500;
const PRODUCTION_CLI_TIMEOUT_MS = APPLY_TIMEOUT_MS + COMMAND_TIMEOUT_MS + APPLY_TERM_GRACE_MS + APPLY_KILL_GRACE_MS;
const INTERNAL_LOCKED_MARKER = "--__palancar-internal-locked-b1b";
const INTERNAL_APPLY_RUNNER_MARKER = "--__palancar-internal-apply-runner-b1b";
const CLEANUP_INTERNAL_LOCKED_MARKER = "--__palancar-cleanup-locked-b1b";
const TEST_FACTORY_TOKEN = Object.freeze({});
const TEST_FACTORY_PATH = SCRIPT_PATH;
const TEST_EXECUTION = new AsyncLocalStorage();
const TEST_FACTORY_CONTEXTS = new WeakMap();
const TEST_EXECUTABLE_HASH_CACHE = new Map();
const TEST_ADAPTER_PROFILES = Object.freeze(["unit", "production"]);
const PRODUCTION_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
});
const STATE_FILE_RE = /^state-(\d{12})\.json$/;
const CHECKPOINT_FILE_RE = /^(\d{6})-([a-z0-9-]+)\.json$/;
const CHECKPOINT_ORDER = Object.freeze([
  "run-directory",
  "image-platform-verified",
  "plan-started",
  "terraform-exit-ambiguous",
  "temp-plan",
  "published-plan",
  "terraform-exit-known",
  "manifest",
  "show-json",
  "guard-receipt",
  "vault-descriptor",
  "cleanup-start",
  "preflight-receipt",
  "applying",
  "receipts-consumed",
  "apply-receipt",
  "reconcile",
  "global-state-advancement",
  "invalidated",
  "superseded",
]);
const CHECKPOINT_ORDER_INDEX = new Map(
  CHECKPOINT_ORDER.map((name, index) => [name, index]),
);
const UID = typeof process.getuid === "function" ? process.getuid() : undefined;
const RUNTIME_SECRETS_ASSIGNMENT = "enable_runtime_secrets_user_assignment";
const GENERATION_PATHS = Object.freeze([
  "packages/generation/src/azure-openai.ts",
  "packages/generation/src/errors.ts",
  "packages/generation/src/evidence.ts",
  "packages/generation/src/service.ts",
  "packages/generation/src/types.ts",
  "packages/generation/test/azure-openai-provider.test.ts",
  "packages/generation/test/generation.test.ts",
]);
const REVIEWED_DEPENDENCIES = Object.freeze({
  "model-bootstrap": Object.freeze([
    "infra/scripts/dev-plan-lifecycle.mjs",
    IMAGE_VERIFIER_PATH,
    "infra/scripts/assert-dev-plan.mjs",
    "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
    "infra/scripts/fixtures/azure-generation-cutover.plan-fixture.json",
    "infra/scripts/fixtures/azure-credential-cleanup.plan-fixture.json",
    // assert-dev-plan.mjs imports this fixture while its module is loaded.
    "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
  ]),
  "runtime-cutover": Object.freeze([
    "infra/scripts/dev-plan-lifecycle.mjs",
    IMAGE_VERIFIER_PATH,
    "infra/scripts/assert-dev-plan.mjs",
    "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
    "infra/scripts/fixtures/azure-generation-cutover.plan-fixture.json",
    "infra/scripts/fixtures/azure-credential-cleanup.plan-fixture.json",
    "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
  ]),
  "credential-cleanup": Object.freeze([
    "infra/scripts/dev-plan-lifecycle.mjs",
    IMAGE_VERIFIER_PATH,
    "infra/scripts/assert-dev-plan.mjs",
    "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
    "infra/scripts/fixtures/azure-generation-cutover.plan-fixture.json",
    "infra/scripts/fixtures/azure-credential-cleanup.plan-fixture.json",
    "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
  ]),
  terminal: Object.freeze([
    "infra/scripts/dev-plan-lifecycle.mjs",
    IMAGE_VERIFIER_PATH,
    "infra/scripts/assert-dev-plan.mjs",
    "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
    "infra/scripts/fixtures/azure-generation-cutover.plan-fixture.json",
    "infra/scripts/fixtures/azure-credential-cleanup.plan-fixture.json",
    "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
  ]),
});
const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLEANUP_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_CHILD_ENV_KEYS = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "AZURE_CONFIG_DIR",
  "XDG_CACHE_HOME",
  "CHECKPOINT_DISABLE",
  "TF_IN_AUTOMATION",
  "TF_CLI_CONFIG_FILE",
]);

const BACKEND_IDENTITY_KEYS = Object.freeze([
  "container_name",
  "key",
  "resource_group_name",
  "storage_account_name",
  "subscription_id",
  "tenant_id",
  "type",
  "use_azuread_auth",
  "use_cli",
]);
const BACKEND_CONFIG_KEYS = Object.freeze([
  "subscription_id",
  "tenant_id",
  "resource_group_name",
  "storage_account_name",
  "container_name",
  "key",
  "use_azuread_auth",
  "use_cli",
]);
const BACKEND_CACHE_OPTIONAL_KEYS = Object.freeze([
  "access_key",
  "ado_pipeline_service_connection_id",
  "client_certificate",
  "client_certificate_password",
  "client_certificate_path",
  "client_id",
  "client_id_file_path",
  "client_secret",
  "client_secret_file_path",
  "endpoint",
  "environment",
  "lookup_blob_endpoint",
  "metadata_host",
  "msi_endpoint",
  "oidc_request_token",
  "oidc_request_url",
  "oidc_token",
  "oidc_token_file_path",
  "sas_token",
  "snapshot",
  "use_aks_workload_identity",
  "use_msi",
  "use_oidc",
]);
const HIGH_LEVEL_PROVIDER_KEYS = Object.freeze([
  "metadataCheck",
  "contextProvider",
  "terraformExecutor",
  "showExecutor",
  "guardExecutor",
  "preflightVerifier",
  "liveInspector",
  "terminalReceiptProvider",
  "cleanupValidator",
  "worktreeChecker",
]);
export const CHECKPOINTS = Object.freeze([
  "run-directory",
  "plan-started",
  "temp-plan",
  "terraform-exit-known",
  "terraform-exit-ambiguous",
  "published-plan",
  "manifest",
  "show-json",
  "guard-receipt",
  "vault-descriptor",
  "cleanup-start",
  "preflight-receipt",
  "applying",
  "receipts-consumed",
  "apply-receipt",
  "global-state-advancement",
  "reconcile",
  "invalidated",
  "superseded",
]);
const CLEANUP_TARGET_NAMES = Object.freeze([
  "openrouter-api-key",
  "litellm-master-key",
]);
const DIAGNOSTIC_COMMAND = Object.freeze([
  "node",
  "apps/relay/dist/azure-generation-diagnostic.js",
]);
const DIAGNOSTIC_CONTAINER_NAME = "expiry-cleanup";
const DIAGNOSTIC_MAX_POLLS = 150;
const DIAGNOSTIC_POLL_DELAY_MS = 2000;
const DIAGNOSTIC_JOB_TIMEOUT_MS = 300 * 1000;
const DIAGNOSTIC_REQUEST_VERSION = 1;
const DIAGNOSTIC_JOB_TAGS = Object.freeze({
  application: "palancar",
  environment: "dev",
  "managed-by": "terraform",
  "data-classification": "operational-metadata",
});
const DIAGNOSTIC_JOB_ADDRESS = "module.expiry_cleanup_job[0].azapi_resource.this";
const DIAGNOSTIC_JOB_MODULE_ADDRESS = "module.expiry_cleanup_job[0]";
const DIAGNOSTIC_JOB_ENV_NAMES = Object.freeze([
  "AZURE_CLIENT_ID",
  "PALANCAR_WORKLOAD_TABLE_ENDPOINT",
  "PALANCAR_SECURITY_STATE_TABLE",
  "PALANCAR_RATE_STATE_TABLE",
  "PALANCAR_RELAY_ENVIRONMENT",
  "PALANCAR_RELAY_ORIGIN",
  "PALANCAR_EXPIRY_CLEANUP_LIMIT",
  "PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS",
]);
// IANA's IPv4 special-purpose registry, plus the non-unicast class ranges.
// Keep these as explicit CIDRs: 192.0/16 is not a special-purpose block.
const DIAGNOSTIC_NON_GLOBAL_IPV4_CIDRS = Object.freeze([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.31.196.0/24",
  "192.52.193.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "192.175.48.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
]);
const REVOCATION_FIXED_FILES = Object.freeze([
  "openrouter-revocation-state.json",
  "openrouter-revocation-raw-response.json",
  "openrouter-revocation-receipt.json",
  "openrouter-revocation.lock",
]);
const REVOCATION_STATE_RE = /^openrouter-revocation-state\.json(?:\.seq-(\d{8}))?$/;
const REVOCATION_TEMP_RE = /^(openrouter-revocation-state\.json(?:\.seq-\d{8})?|openrouter-revocation-raw-response\.json|openrouter-revocation-receipt\.json|openrouter-revocation\.lock)\.tmp-(\d+)-([a-f0-9]{24})$/;
const REVOCATION_MANIFEST_RE = /^openrouter-revocation-owned-temp-(\d+)-([a-f0-9]{24})\.json$/;
// Shared evidence contract with cleanup-key-vault-credentials.mjs:
// JOURNAL_COMMITMENT_DIRECTORY_NAME must remain identical in both scripts.
export const JOURNAL_COMMITMENT_DIRECTORY_NAME = ".cleanup-journal-commitments";
const CLEANUP_JOURNAL_ARTIFACT_RE = /^cleanup-(?:operation-head(?:-intent)?|journal-commitment|mutation-(?:intent|commitment))-\d{6}\.json$/u;
const CLOSURE_STATE_RE = /^closure-state-(\d{6})\.json$/;
const CLOSURE_TOMBSTONE_FILENAME = "closure-tombstone.json";
const CLOSURE_INVENTORY_FILENAME = "closure-inventory.json";

export class LifecycleError extends Error {
  constructor(code) {
    super(String(code).replace(/[^a-z0-9._-]/gi, "-"));
    this.name = "LifecycleError";
    this.code = this.message;
  }
}

function reject(code) {
  throw new LifecycleError(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedValue(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(sortedValue(value));
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function freezeDeep(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function currentTestExecution() {
  const execution = TEST_EXECUTION.getStore();
  return execution?.factoryToken === TEST_FACTORY_TOKEN ? execution : undefined;
}

function syncFileDescriptor(fd, filePath, code) {
  const execution = currentTestExecution();
  if (execution?.fsyncAdapter !== undefined) {
    execution.fsyncAdapter(fd, filePath, code);
    return;
  }
  fsyncSync(fd);
}

function testSnapshot(key, producer) {
  const execution = currentTestExecution();
  const operation = execution?.operation;
  if (operation === undefined) return producer();
  if (execution.adapterProfile === "production") return producer();
  if (operation.snapshots.has(key)) return operation.snapshots.get(key);
  const snapshot = freezeDeep(producer());
  operation.snapshots.set(key, snapshot);
  return snapshot;
}

function testStableSnapshot(key, producer) {
  const execution = currentTestExecution();
  if (execution === undefined) return producer();
  execution.stableSnapshots ??= new Map();
  if (execution.stableSnapshots.has(key)) return execution.stableSnapshots.get(key);
  const snapshot = freezeDeep(producer());
  execution.stableSnapshots.set(key, snapshot);
  return snapshot;
}

function cacheableCommand(command, args) {
  if (command === "/usr/bin/git") return true;
  if (command === AZ_PATH) return true;
  if (command === TERRAFORM_PATH) {
    return ["state", "workspace", "output"].includes(args[0]);
  }
  return false;
}

const GIT_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_NO_REPLACE_OBJECTS: "1",
});

function gitArgs(args) {
  return ["--no-replace-objects", ...args];
}

function commandSnapshotKey(command, args, options) {
  return canonicalJson({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    timeoutMs: options.timeoutMs,
  });
}

export function sha256File(filePath, maxBytes = PLAN_MAX_BYTES) {
  const stat = assertRegular(filePath, null, "artifact");
  failIf(stat.size > maxBytes, "artifact-too-large");
  return sha256Bytes(readFileSync(filePath));
}

function evidenceFileMaxBytes(label) {
  const name = path.basename(label);
  if (name.endsWith(".tfplan")) return PLAN_MAX_BYTES;
  if (name === "openrouter-revocation-raw-response.json" ||
      /^openrouter-revocation-raw-response\.json\.tmp-/.test(name)) {
    return REVOCATION_RAW_MAX_BYTES;
  }
  if (name === "openrouter-revocation.lock" ||
      /^openrouter-revocation\.lock\.tmp-/.test(name)) {
    return REVOCATION_LOCK_MAX_BYTES;
  }
  return JSON_MAX_BYTES;
}

function sha256EvidenceFile(filePath, label = filePath) {
  return sha256File(filePath, evidenceFileMaxBytes(label));
}

function terraformExecutableSha256() {
  const execution = currentTestExecution();
  if (execution === undefined) {
    return sha256File(TERRAFORM_PATH, EXECUTABLE_MAX_BYTES);
  }

  // Test suites exercise each fail-closed boundary through many isolated
  // harnesses. Avoid repeatedly reading the same 104 MiB executable while
  // retaining replacement detection. This cache is unreachable from the
  // production composition, which deliberately re-hashes at every boundary.
  const regular = assertRegular(TERRAFORM_PATH, null, "artifact");
  failIf(regular.size > EXECUTABLE_MAX_BYTES, "artifact-too-large");
  let identity;
  try {
    const stat = lstatSync(TERRAFORM_PATH, { bigint: true });
    failIf(!stat.isFile() || stat.isSymbolicLink(), "artifact-not-regular");
    identity = canonicalJson({
      path: realpathSync(TERRAFORM_PATH),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      uid: stat.uid.toString(),
      mode: stat.mode.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    });
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    reject("artifact-stat");
  }
  const cached = TEST_EXECUTABLE_HASH_CACHE.get(identity);
  if (cached !== undefined) return cached;
  const digest = sha256Bytes(readFileSync(TERRAFORM_PATH));
  TEST_EXECUTABLE_HASH_CACHE.clear();
  TEST_EXECUTABLE_HASH_CACHE.set(identity, digest);
  return digest;
}

function optionalSha256File(filePath, maxBytes = PLAN_MAX_BYTES) {
  try {
    lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return sha256File(filePath, maxBytes);
}

function boundedFileText(filePath, maxBytes, code) {
  assertRegular(filePath, null, code);
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    reject(`${code}-stat`);
  }
  failIf(stat.size > maxBytes, `${code}-too-large`);
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    reject(`${code}-read`);
  }
}

function hashJson(value) {
  return sha256Bytes(canonicalJson(value));
}

function same(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function sameBindingsForOperation(a, b, operation) {
  if (operation !== "reconcile") return same(a, b);
  const left = { ...a };
  const right = { ...b };
  // The manifest records the serial observed before apply.  A successful
  // apply may have advanced the remote state's serial, while every other
  // context binding remains immutable during reconciliation.
  delete left.stateSerial;
  delete right.stateSerial;
  delete left.liveRevision;
  delete right.liveRevision;
  // Reconciliation may resume an apply whose reviewed code was committed
  // after the run was created.  The recorded code identities are validated
  // against their recorded commit separately below; all remaining bindings
  // still compare to the live context here.
  for (const key of ["repositoryCommit", "lifecycleSha256", "guardSha256", "dependencyBlobs"]) {
    delete left[key];
    delete right[key];
  }
  return same(left, right);
}

function sameCompletePlanContext(before, after) {
  const left = { ...before };
  const right = { ...after };
  delete left.planSha256;
  delete right.planSha256;
  return same(left, right);
}

function normalizedContextBeforePlan(raw, expected) {
  // A plan digest does not exist at the pre-plan boundary.  Normalize the
  // complete context with a schema-valid sentinel and remove only that
  // digest before comparison; the published plan digest is supplied by the
  // post-plan snapshot and is bound into the manifest.
  return normalizeContext(raw, {
    ...expected,
    planSha256: "0".repeat(64),
  });
}

function assertReconcileSerial(current, planned) {
  failIf(
    !Number.isSafeInteger(current) ||
      !Number.isSafeInteger(planned) ||
      current < planned,
    "reconcile-state-serial",
  );
  return current === planned ? "pre" : "post";
}

function failIf(condition, code) {
  if (condition) reject(code);
}

function assertPhase(phase) {
  failIf(!PHASES.includes(phase), "invalid-phase");
}

function exactGuardArgv(phase) {
  assertPhase(phase);
  const mapping = GUARD_MAPPINGS[phase];
  failIf(
    typeof mapping !== "string" ||
      mapping.length === 0 ||
      !SUPPORTED_GUARD_MAPPINGS.includes(mapping) ||
      Object.keys(GUARD_MAPPINGS).length !== PHASES.length,
    "guard-mapping",
  );
  return [`--mode=${mapping}`];
}

function assertRunId(runId) {
  failIf(typeof runId !== "string" || !RUN_ID_RE.test(runId), "invalid-run-id");
  failIf(runId === "." || runId === "..", "invalid-run-id");
}

function fileMode(stat) {
  return stat.mode & 0o777;
}

function assertOwned(stat, mode, code) {
  failIf(!stat.isFile() && !stat.isDirectory(), code);
  failIf(UID !== undefined && stat.uid !== UID, `${code}-owner`);
  failIf(mode !== undefined && mode !== null && fileMode(stat) !== mode, `${code}-mode`);
}

function assertRegular(filePath, mode = ARTIFACT_MODE, code = "invalid-artifact") {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    reject(`${code}-missing`);
  }
  failIf(stat.isSymbolicLink(), `${code}-symlink`);
  assertOwned(stat, mode, code);
  failIf(!stat.isFile(), code);
  return stat;
}

function assertDirectory(directoryPath, code = "invalid-directory") {
  let stat;
  try {
    stat = lstatSync(directoryPath);
  } catch {
    reject(`${code}-missing`);
  }
  failIf(stat.isSymbolicLink(), `${code}-symlink`);
  assertOwned(stat, DIRECTORY_MODE, code);
  failIf(!stat.isDirectory(), code);
  let resolved;
  try {
    resolved = realpathSync(directoryPath);
  } catch {
    reject(`${code}-realpath`);
  }
  failIf(resolved !== path.resolve(directoryPath), `${code}-noncanonical`);
  return stat;
}

function assertCanonicalDirectory(directoryPath, code) {
  let real;
  try {
    real = path.resolve(path.dirname(directoryPath), path.basename(directoryPath));
    real = path.resolve(real);
    const actual = path.resolve(realpathSync(real));
    failIf(actual !== real, `${code}-noncanonical`);
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    reject(`${code}-realpath`);
  }
  assertDirectory(directoryPath, code);
}

function ensureDirectory(directoryPath, code) {
  let existing;
  try {
    existing = lstatSync(directoryPath);
  } catch (error) {
    if (error?.code !== "ENOENT") reject(`${code}-stat`);
  }
  if (existing === undefined) {
    try {
      mkdirSync(directoryPath, { mode: DIRECTORY_MODE });
      chmodSync(directoryPath, DIRECTORY_MODE);
    } catch {
      reject(`${code}-create`);
    }
  }
  assertDirectory(directoryPath, code);
}

function fsyncDirectory(directoryPath) {
  let fd;
  try {
    fd = openSync(directoryPath, "r");
    syncFileDescriptor(fd, directoryPath, "directory-fsync");
  } catch {
    reject("directory-fsync");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncFile(filePath, code) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    syncFileDescriptor(fd, filePath, code);
  } catch {
    reject(code);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function createSecureEmptyFile(filePath, code) {
  const parent = path.dirname(filePath);
  assertDirectory(parent, "artifact-parent");
  pathExists(filePath, code);
  let fd;
  try {
    fd = openSync(filePath, "wx", ARTIFACT_MODE);
    fchmodSync(fd, ARTIFACT_MODE);
    assertOwned(fstatSync(fd), ARTIFACT_MODE, `${code}-temporary`);
    syncFileDescriptor(fd, filePath, code);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(parent);
    assertRegular(filePath, ARTIFACT_MODE, code);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof LifecycleError) throw error;
    removeTemporary(filePath);
    reject(`${code}-create`);
  }
}

function writeAll(fd, value, maxBytes = JSON_MAX_BYTES) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  failIf(bytes.byteLength > maxBytes, "artifact-too-large");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    failIf(!Number.isInteger(written) || written <= 0, "artifact-write");
    offset += written;
  }
}

function pathExists(filePath, code) {
  try {
    lstatSync(filePath);
    reject(`${code}-exists`);
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    if (error?.code !== "ENOENT") reject(`${code}-stat`);
  }
}

function removeTemporary(filePath) {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || (UID !== undefined && stat.uid !== UID)) return;
    unlinkSync(filePath);
  } catch {
    // Cleanup failures never replace the content-safe operation error.
  }
}

function copyNoReplaceForTests(temporary, destination, code) {
  assertRegular(temporary, ARTIFACT_MODE, `${code}-temporary`);
  pathExists(destination, code);
  let created = false;
  try {
    copyFileSync(temporary, destination, 1);
    created = true;
    assertRegular(destination, ARTIFACT_MODE, code);
    unlinkSync(temporary);
    const execution = currentTestExecution();
    if (execution?.operation !== undefined) {
      execution.operation.directories.add(path.dirname(destination));
    }
    assertRegular(destination, ARTIFACT_MODE, code);
  } catch (error) {
    if (created) removeTemporary(destination);
    if (error?.code === "EEXIST") reject(`${code}-exists`);
    if (error instanceof LifecycleError) throw error;
    reject(`${code}-publish`);
  }
}

function publishNoReplaceWithProductionAdapters(temporary, destination, code) {
  assertRegular(temporary, ARTIFACT_MODE, `${code}-temporary`);
  pathExists(destination, code);
  atomicRenameNoReplace(temporary, destination, code);
  fsyncDirectory(path.dirname(destination));
  assertRegular(destination, ARTIFACT_MODE, code);
}

function publishNoReplace(temporary, destination, code) {
  pathExists(destination, code);
  try {
    const execution = currentTestExecution();
    if (execution?.publisher !== undefined) {
      execution.publisher(temporary, destination, code);
      return;
    }
    atomicRenameNoReplace(temporary, destination, code);
    fsyncDirectory(path.dirname(destination));
    assertRegular(destination, ARTIFACT_MODE, code);
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    reject(`${code}-publish`);
  }
}

/*
 * Node's fs.rename() is an atomic rename, but it replaces an existing target.
 * The lifecycle protocol needs the Linux renameat2(2) RENAME_NOREPLACE
 * operation.  Keep the syscall in one tiny, bounded helper so every durable
 * publication has the same no-replacement semantics; hard-link/unlink is not
 * a substitute for this operation.
 */
function atomicRenameNoReplace(source, destination, code) {
  const script = [
    "import ctypes, os, sys",
    "libc = ctypes.CDLL(None, use_errno=True)",
    "fn = getattr(libc, 'renameat2', None)",
    "if fn is None: sys.exit(90)",
    "fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]",
    "fn.restype = ctypes.c_int",
    "if fn(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1) != 0:",
    "    error = ctypes.get_errno()",
    "    sys.exit(17 if error == 17 else 91)",
  ].join("\n");
  const result = spawnSync(
    "/usr/bin/python3",
    ["-c", script, source, destination],
    {
      cwd: path.dirname(destination),
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4096,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 17) reject(`${code}-exists`);
  failIf(result.status !== 0, `${code}-publish`);
}

function exclusiveText(filePath, text, code = "artifact") {
  const parent = path.dirname(filePath);
  assertDirectory(parent, "artifact-parent");
  pathExists(filePath, code);
  const temporary = path.join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd;
  try {
    fd = openSync(temporary, "wx", ARTIFACT_MODE);
    fchmodSync(fd, ARTIFACT_MODE);
    const descriptor = fstatSync(fd);
    assertOwned(descriptor, ARTIFACT_MODE, `${code}-temporary`);
    failIf(!descriptor.isFile(), `${code}-temporary`);
    writeAll(fd, text, JSON_MAX_BYTES);
    syncFileDescriptor(fd, temporary, `${code}-fsync`);
    closeSync(fd);
    fd = undefined;
    publishNoReplace(temporary, filePath, code);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    removeTemporary(temporary);
    if (error instanceof LifecycleError) throw error;
    reject(`${code}-create`);
  }
}

function replaceText(filePath, text, code = "state") {
  const parent = path.dirname(filePath);
  assertDirectory(parent, "state-parent");
  if (existsSync(filePath)) assertRegular(filePath, ARTIFACT_MODE, code);
  const temporary = path.join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd;
  try {
    fd = openSync(temporary, "wx", ARTIFACT_MODE);
    fchmodSync(fd, ARTIFACT_MODE);
    const descriptor = fstatSync(fd);
    assertOwned(descriptor, ARTIFACT_MODE, `${code}-temporary`);
    failIf(!descriptor.isFile(), `${code}-temporary`);
    writeAll(fd, text, JSON_MAX_BYTES);
    syncFileDescriptor(fd, temporary, `${code}-fsync`);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, filePath);
    fsyncDirectory(parent);
    assertRegular(filePath, ARTIFACT_MODE, code);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    removeTemporary(temporary);
    if (error instanceof LifecycleError) throw error;
    reject(`${code}-replace`);
  }
}

function exclusiveJson(filePath, value, code) {
  const text = canonicalJson(value);
  failIf(Buffer.byteLength(text) > JSON_MAX_BYTES, "artifact-too-large");
  exclusiveText(filePath, text, code);
}

function replaceJson(filePath, value, code) {
  replaceText(filePath, canonicalJson(value), code);
}

function readJson(filePath, code) {
  assertRegular(filePath, ARTIFACT_MODE, code);
  try {
    const stat = statSync(filePath);
    failIf(stat.size > JSON_MAX_BYTES, `${code}-too-large`);
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    reject(`${code}-json`);
  }
}

function stateHashValue(state) {
  const value = { ...state };
  delete value.stateSha256;
  return value;
}

function stateCanonicalSha256(state) {
  return hashJson(stateHashValue(state));
}

function assertStateSnapshotIntegrity(snapshot, filePath, previousFilePath = undefined) {
  validateState(snapshot);
  failIf(snapshot.stateSha256 !== stateCanonicalSha256(snapshot), "state-history");
  if (previousFilePath === undefined) {
    failIf(snapshot.previousSnapshotSha256 !== null, "state-history");
  } else {
    failIf(
      snapshot.previousSnapshotSha256 !== sha256File(previousFilePath, JSON_MAX_BYTES),
      "state-history",
    );
  }
  void filePath;
  return snapshot;
}

function checkpointNamed(checkpoints, name, code = "checkpoint-integrity") {
  const matches = checkpoints.filter((checkpoint) => checkpoint.name === name);
  failIf(matches.length !== 1, code);
  return matches[0];
}

function assertCheckpointArtifact(filePath, checkpoint, hashKey, code) {
  failIf(!isSha(checkpoint?.[hashKey]), `${code}-checkpoint`);
  const stat = assertRegular(filePath, ARTIFACT_MODE, code);
  failIf(stat.size > JSON_MAX_BYTES, `${code}-too-large`);
  const actual = sha256Bytes(readFileSync(filePath));
  failIf(actual !== checkpoint[hashKey], `${code}-hash`);
  return actual;
}

function validateManifestArgv(manifest, artifacts, checkpoints, run) {
  if (same(manifest.argv, exactCreateArgv(artifacts.plan))) return;

  failIf(
    !same(manifest.argv, exactCreateArgv(artifacts.planTemp)) ||
      run.phase !== "model-bootstrap" ||
      !["applied", "invalidated"].includes(run.status),
    "manifest-mismatch",
  );

  // The temporary output pathname is accepted only as a migration proof for
  // a closed historical model run.  Re-check the complete create provenance
  // so changing an argv record cannot turn an incomplete or tampered run into
  // an acceptable predecessor or historical invalidation.
  const legacyArgv = exactCreateArgv(artifacts.planTemp);
  const planStarted = checkpointNamed(checkpoints, "plan-started");
  failIf(!same(planStarted.argv, legacyArgv), "checkpoint-integrity");

  const tempPlan = checkpointNamed(checkpoints, "temp-plan");
  failIf(!isSha(tempPlan.planSha256), "checkpoint-integrity");

  const published = checkpointNamed(checkpoints, "published-plan");
  failIf(
    published.planSha256 !== tempPlan.planSha256 ||
      published.planPath !== artifacts.plan,
    "checkpoint-integrity",
  );

  const createExitCheckpoints = checkpoints.filter((checkpoint) =>
    checkpoint.name === "terraform-exit-known" && checkpoint.operation === "create",
  );
  failIf(createExitCheckpoints.length !== 1, "checkpoint-integrity");
  const terraformExit = createExitCheckpoints[0];
  failIf(
    terraformExit.operation !== "create" ||
      terraformExit.status !== "success" ||
      terraformExit.exitCode !== 0,
    "checkpoint-integrity",
  );

  const manifestCheckpoint = checkpointNamed(checkpoints, "manifest");
  assertCheckpointArtifact(artifacts.manifest, manifestCheckpoint, "manifestSha256", "manifest");
  failIf(
    manifestCheckpoint.planSha256 !== manifest.planSha256 ||
      tempPlan.planSha256 !== manifest.planSha256,
    "checkpoint-integrity",
  );
  assertRegular(artifacts.plan, ARTIFACT_MODE, "plan");
  failIf(sha256File(artifacts.plan) !== manifest.planSha256, "plan-hash");
  failIf(
    !isObject(manifest.bindings) ||
      !same(manifest.bindings.argv, manifest.argv) ||
      bindingHash(manifest.bindings) !== manifest.bindingSha256,
    "binding-hash",
  );

  if (run.status === "invalidated") {
    const invalidated = checkpointNamed(checkpoints, "invalidated");
    const durable = checkpoints.at(-2);
    const runLastCheckpoint = run.lastCheckpoint;
    const invalidatedLastCheckpoint = invalidated.lastCheckpoint;
    failIf(
      checkpoints.at(-1) !== invalidated ||
        checkpoints.some((checkpoint) =>
          ["apply-receipt", "global-state-advancement"].includes(checkpoint.name),
        ) ||
        typeof run.reason !== "string" ||
        run.reason.length === 0 ||
        invalidated.reason !== run.reason ||
        durable === undefined ||
        durable.name === "invalidated" ||
        (runLastCheckpoint !== undefined && runLastCheckpoint !== durable.name) ||
        (invalidatedLastCheckpoint !== undefined && invalidatedLastCheckpoint !== durable.name) ||
        (runLastCheckpoint !== undefined &&
          invalidatedLastCheckpoint !== undefined &&
          runLastCheckpoint !== invalidatedLastCheckpoint),
      "invalidated-history",
    );
    return;
  }

  failIf(
    run.lastCheckpoint !== "global-state-advancement",
    "manifest-mismatch",
  );

  const applyCheckpoint = checkpointNamed(checkpoints, "apply-receipt");
  readReceiptAtCheckpoint(
    artifacts.apply,
    applyCheckpoint,
    manifest,
    "apply",
    ["applied"],
  );
  failIf(applyCheckpoint.status !== "applied", "phase-apply-proof");

  const advancement = checkpointNamed(checkpoints, "global-state-advancement");
  failIf(
    advancement.from !== STATE_FOR_PHASE[run.phase] ||
      advancement.to !== ADVANCED_STATE[run.phase] ||
      !isSha(advancement.applyReceiptSha256) ||
      advancement.applyReceiptSha256 !== sha256File(artifacts.apply, JSON_MAX_BYTES),
    "phase-apply-proof",
  );
}

function validateLegacyAppliedModelJournal(artifacts, checkpoints, manifest, run) {
  const code = "legacy-manifest";
  const runKeys = [
    "appliedAt", "applyingAt", "createdAt", "guardedAt", "id", "lastCheckpoint",
    "phase", "preflightAt", "status",
  ];
  assertKnownKeys(run, runKeys, code);
  assertRequiredKeys(run, runKeys, code);
  failIf(
    run.phase !== "model-bootstrap" ||
    run.status !== "applied" ||
    run.lastCheckpoint !== "global-state-advancement",
    code,
  );
  failIf(!RUN_ID_RE.test(run.id), code);
  for (const key of ["appliedAt", "applyingAt", "createdAt", "guardedAt", "preflightAt"]) {
    failIf(typeof run[key] !== "string" || !Number.isFinite(jsonDate(run[key])), code);
  }
  const runCreatedAt = jsonDate(run.createdAt);
  const manifestCreatedAt = jsonDate(manifest.createdAt);
  failIf(
    !Number.isFinite(manifestCreatedAt) ||
      runCreatedAt > manifestCreatedAt ||
      manifestCreatedAt - runCreatedAt > 1000,
    code,
  );
  const expectedNames = [
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
    "terraform-exit-known",
    "apply-receipt",
    "global-state-advancement",
  ];
  failIf(!same(checkpoints.map((checkpoint) => checkpoint.name), expectedNames), "legacy-checkpoint-order");

  const commonCheckpointKeys = [
    "createdAt", "name", "phase", "runId", "sequence", "type", "version",
  ];
  const checkpointKeys = new Map([
    ["run-directory", commonCheckpointKeys],
    ["plan-started", [...commonCheckpointKeys, "argv"]],
    ["temp-plan", [...commonCheckpointKeys, "planSha256"]],
    ["published-plan", [...commonCheckpointKeys, "planPath", "planSha256"]],
    ["terraform-exit-known:create", [...commonCheckpointKeys, "exitCode", "operation", "status"]],
    ["manifest", [...commonCheckpointKeys, "manifestSha256", "planSha256"]],
    ["show-json", [...commonCheckpointKeys, "showSha256"]],
    ["guard-receipt", [...commonCheckpointKeys, "guard", "receiptSha256", "showSha256"]],
    ["preflight-receipt", [...commonCheckpointKeys, "receiptSha256", "verifierSha256"]],
    ["applying", [...commonCheckpointKeys, "applyingAt", "planSha256"]],
    ["receipts-consumed", [...commonCheckpointKeys, "guardReceiptSha256", "preflightReceiptSha256"]],
    ["terraform-exit-known:apply", [...commonCheckpointKeys, "exitCode", "status"]],
    ["apply-receipt", [...commonCheckpointKeys, "receiptSha256", "status"]],
    ["global-state-advancement", [...commonCheckpointKeys, "applyReceiptSha256", "from", "to"]],
  ]);
  const seenExit = { value: 0 };
  for (const checkpoint of checkpoints) {
    const key = checkpoint.name === "terraform-exit-known"
      ? `terraform-exit-known:${seenExit.value++ === 0 ? "create" : "apply"}`
      : checkpoint.name;
    const keys = checkpointKeys.get(key);
    failIf(keys === undefined, "legacy-checkpoint-schema");
    assertKnownKeys(checkpoint, keys, "legacy-checkpoint-schema");
    assertRequiredKeys(checkpoint, keys, "legacy-checkpoint-schema");
    failIf(
      checkpoint.version !== 1 ||
        checkpoint.type !== "lifecycle-checkpoint" ||
        checkpoint.runId !== run.id ||
        checkpoint.phase !== "model-bootstrap" ||
        typeof checkpoint.createdAt !== "string" ||
        !Number.isFinite(jsonDate(checkpoint.createdAt)),
      "legacy-checkpoint-schema",
    );
  }

  const expectedArtifacts = new Set([
    ...expectedNames.map((name, index) => `${String(index + 1).padStart(6, "0")}-${name}.json`),
    "apply-receipt.json",
    "create-manifest.json",
    "guard-receipt.json.consumed",
    "plan.tfplan",
    "preflight-receipt.json.consumed",
    "show.json",
    "tf-cli.tfrc",
  ]);
  for (const entry of readdirSync(path.dirname(artifacts.manifest), { withFileTypes: true })) {
    failIf(
      entry.isSymbolicLink() || !entry.isFile() || !expectedArtifacts.has(entry.name),
      "legacy-artifacts",
    );
  }
  for (const name of expectedArtifacts) {
    assertRegular(path.join(path.dirname(artifacts.manifest), name), ARTIFACT_MODE, "legacy-artifacts");
  }
  failIf(readFileSync(path.join(path.dirname(artifacts.manifest), "tf-cli.tfrc")).byteLength !== 0, "legacy-artifacts");

  const planStarted = checkpointNamed(checkpoints, "plan-started");
  failIf(!same(planStarted.argv, exactCreateArgv(artifacts.planTemp)), "checkpoint-integrity");
  const tempPlan = checkpointNamed(checkpoints, "temp-plan");
  failIf(!isSha(tempPlan.planSha256) || tempPlan.planSha256 !== manifest.planSha256, "checkpoint-integrity");
  const published = checkpointNamed(checkpoints, "published-plan");
  failIf(
    published.planSha256 !== manifest.planSha256 || published.planPath !== artifacts.plan,
    "checkpoint-integrity",
  );
  const exits = checkpoints.filter((checkpoint) => checkpoint.name === "terraform-exit-known");
  failIf(
    exits.length !== 2 ||
      exits[0].operation !== "create" ||
      Object.hasOwn(exits[1], "operation") ||
      exits.some((checkpoint) => checkpoint.status !== "success" || checkpoint.exitCode !== 0),
    "checkpoint-integrity",
  );

  assertKnownKeys(manifest, [
    "argv", "bindingSha256", "bindings", "createdAt", "phase", "planSha256",
    "processExit", "runId", "version",
  ], code);
  assertRequiredKeys(manifest, [
    "argv", "bindingSha256", "bindings", "createdAt", "phase", "planSha256",
    "processExit", "runId", "version",
  ], code);
  failIf(
    manifest.version !== 1 ||
      manifest.runId !== run.id ||
      manifest.phase !== "model-bootstrap" ||
      !Number.isFinite(manifestCreatedAt) ||
      manifest.processExit !== 0 ||
      !Array.isArray(manifest.argv) ||
      !same(manifest.argv, exactCreateArgv(artifacts.planTemp)) ||
      !isSha(manifest.planSha256) ||
      !isSha(manifest.bindingSha256),
    code,
  );
  const transitionTimes = [
    manifestCreatedAt,
    jsonDate(run.guardedAt),
    jsonDate(run.preflightAt),
    jsonDate(run.applyingAt),
    jsonDate(run.appliedAt),
  ];
  failIf(
    transitionTimes.some((value) => !Number.isFinite(value)) ||
      transitionTimes.some((value, index) => index > 0 && value < transitionTimes[index - 1]),
    code,
  );
  const guardCheckpoint = checkpointNamed(checkpoints, "guard-receipt");
  const guardCheckpointAt = jsonDate(guardCheckpoint.createdAt);
  const guardedAt = jsonDate(run.guardedAt);
  failIf(
    !Number.isFinite(guardCheckpointAt) ||
      guardCheckpointAt < manifestCreatedAt ||
      guardedAt < guardCheckpointAt ||
      guardedAt - guardCheckpointAt > 1000,
    code,
  );
  const bindingKeys = [
    "argv", "azureContextHash", "backend", "backendConfigurationSha256", "backendSha256",
    "callerHash", "cwd", "dependencyBlobs", "guard", "guardSha256", "lifecycleSha256",
    "liveRevision", "phase", "planSha256", "repositoryCommit", "stateLineage", "stateSerial",
    "terraformSha256", "workspace",
  ];
  assertKnownKeys(manifest.bindings, bindingKeys, "legacy-binding");
  assertRequiredKeys(manifest.bindings, bindingKeys, "legacy-binding");
  const bindings = manifest.bindings;
  const backend = normalizeBackend(bindings.backend);
  const expectedAzureContextHash = hashJson({
    cloud: "AzureCloud",
    subscription: backend.identity.subscription_id,
    tenant: backend.identity.tenant_id,
  });
  failIf(
    !Array.isArray(bindings.argv) ||
      !same(bindings.argv, manifest.argv) ||
      !isSha(bindings.azureContextHash) ||
      !isSha(bindings.backendConfigurationSha256) ||
      !isSha(bindings.backendSha256) ||
      bindings.backendSha256 !== backend.sha256 ||
      bindings.backendConfigurationSha256 !== bindings.backendSha256 ||
      !isSha(bindings.callerHash) ||
      typeof bindings.cwd !== "string" || bindings.cwd.length === 0 ||
      !Array.isArray(bindings.dependencyBlobs) ||
      bindings.dependencyBlobs.length === 0 ||
      bindings.azureContextHash !== expectedAzureContextHash ||
      !isSha(bindings.guardSha256) ||
      !isSha(bindings.lifecycleSha256) ||
      typeof bindings.liveRevision !== "string" || bindings.liveRevision.length === 0 ||
      bindings.phase !== "model-bootstrap" ||
      bindings.planSha256 !== manifest.planSha256 ||
      !isCommit(bindings.repositoryCommit) ||
      typeof bindings.stateLineage !== "string" || bindings.stateLineage.length === 0 ||
      !Number.isSafeInteger(bindings.stateSerial) || bindings.stateSerial < 0 ||
      !isSha(bindings.terraformSha256) ||
      bindings.workspace !== "default" ||
      bindings.guard !== GUARD_MAPPINGS["model-bootstrap"],
    "legacy-binding",
  );
  const dependencyPaths = new Set();
  for (const dependency of bindings.dependencyBlobs) {
    assertKnownKeys(dependency, ["blob", "path", "sha256"], "legacy-binding");
    assertRequiredKeys(dependency, ["blob", "path", "sha256"], "legacy-binding");
    failIf(
      typeof dependency.path !== "string" || dependency.path.length === 0 ||
        dependencyPaths.has(dependency.path) ||
        !/^[a-f0-9]{40}$/.test(dependency.blob) ||
        !isSha(dependency.sha256),
      "legacy-binding",
    );
    dependencyPaths.add(dependency.path);
  }
  failIf(!same(
    bindings.dependencyBlobs.map((dependency) => dependency.path),
    [
      "infra/scripts/assert-dev-plan.mjs",
      "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
      "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
    ],
  ), "legacy-binding");
  failIf(bindingHash(bindings) !== manifest.bindingSha256, "binding-hash");

  const manifestCheckpoint = checkpointNamed(checkpoints, "manifest");
  failIf(
    manifestCheckpoint.planSha256 !== manifest.planSha256 ||
      manifestCheckpoint.manifestSha256 !== sha256File(artifacts.manifest, JSON_MAX_BYTES),
    "checkpoint-integrity",
  );
  assertRegular(artifacts.plan, ARTIFACT_MODE, "plan");
  failIf(sha256File(artifacts.plan, JSON_MAX_BYTES) !== manifest.planSha256, "plan-hash");
  failIf(
    !isObject(manifest.bindings) ||
      !same(manifest.bindings.argv, manifest.argv) ||
      bindingHash(manifest.bindings) !== manifest.bindingSha256,
    "binding-hash",
  );

  const showCheckpoint = checkpointNamed(checkpoints, "show-json");
  assertCheckpointArtifact(artifacts.show, showCheckpoint, "showSha256", "show-json");
  const guard = readReceiptAtCheckpoint(
    `${artifacts.guard}.consumed`,
    checkpointNamed(checkpoints, "guard-receipt"),
    manifest,
    "guard",
  );
  failIf(guard.showSha256 !== showCheckpoint.showSha256, "show-hash");
  const preflight = readReceiptAtCheckpoint(
    `${artifacts.preflight}.consumed`,
    checkpointNamed(checkpoints, "preflight-receipt"),
    manifest,
    "preflight",
  );
  failIf(
    !isSha(preflight.verifierSha256) ||
      guard.createdAt !== manifest.createdAt ||
      preflight.createdAt !== run.preflightAt,
    "preflight-receipt-schema",
  );
  const consumed = checkpointNamed(checkpoints, "receipts-consumed");
  failIf(
    consumed.guardReceiptSha256 !== sha256File(`${artifacts.guard}.consumed`, JSON_MAX_BYTES) ||
      consumed.preflightReceiptSha256 !== sha256File(`${artifacts.preflight}.consumed`, JSON_MAX_BYTES),
    "checkpoint-integrity",
  );
  const apply = readReceiptAtCheckpoint(
    artifacts.apply,
    checkpointNamed(checkpoints, "apply-receipt"),
    manifest,
    "apply",
    ["applied"],
  );
  const applying = checkpointNamed(checkpoints, "applying");
  failIf(
    applying.applyingAt !== run.applyingAt ||
      apply.status !== "applied" ||
      typeof apply.appliedAt !== "string" ||
      !Number.isFinite(jsonDate(apply.appliedAt)) ||
      apply.appliedAt !== run.appliedAt,
    "phase-apply-proof",
  );
  failIf(
    guard.createdAt !== manifest.createdAt,
    "legacy-manifest",
  );
  const advancement = checkpointNamed(checkpoints, "global-state-advancement");
  failIf(
    advancement.from !== STATE_FOR_PHASE[run.phase] ||
      advancement.to !== ADVANCED_STATE[run.phase] ||
      !isSha(advancement.applyReceiptSha256) ||
      advancement.applyReceiptSha256 !== sha256File(artifacts.apply, JSON_MAX_BYTES),
    "phase-apply-proof",
  );
}

function immutableManifest(runDirectory, artifacts, checkpoints, run) {
  const checkpoint = checkpointNamed(checkpoints, "manifest");
  assertCheckpointArtifact(artifacts.manifest, checkpoint, "manifestSha256", "manifest");
  const manifest = readJson(artifacts.manifest, "manifest");
  failIf(
    manifest.runId !== run.id || manifest.phase !== run.phase || !Array.isArray(manifest.argv) ||
      (!same(manifest.argv, exactCreateArgv(artifacts.plan)) &&
        !same(manifest.argv, exactCreateArgv(artifacts.planTemp))),
    "manifest-mismatch",
  );
  validateManifestArgv(manifest, artifacts, checkpoints, run);
  assertRegular(artifacts.plan, ARTIFACT_MODE, "plan");
  failIf(sha256File(artifacts.plan) !== manifest.planSha256, "plan-hash");
  const bindings = isObject(manifest.bindings) ? manifest.bindings : {};
  const hasImagePlatforms = Object.hasOwn(bindings, "imagePlatforms");
  const hasAcrLoginServer = Object.hasOwn(bindings, "acrLoginServer");
  const hasImageCheckpoint = checkpoints.some((checkpoint) => checkpoint.name === "image-platform-verified");
  const hasVerifierArtifact = existsSync(artifacts.verifier);
  const hasAnyImageEvidence = hasImagePlatforms || hasAcrLoginServer || hasImageCheckpoint || hasVerifierArtifact;
  const hasCompleteImageEvidence = hasImagePlatforms && hasAcrLoginServer && hasImageCheckpoint && hasVerifierArtifact;
  failIf(hasAnyImageEvidence && !hasCompleteImageEvidence, "image-platform-checkpoint");
  const legacyAppliedModel = !hasAnyImageEvidence &&
    run.phase === "model-bootstrap" &&
    run.status === "applied" &&
    run.lastCheckpoint === "global-state-advancement";
  if (legacyAppliedModel) {
    validateLegacyAppliedModelJournal(artifacts, checkpoints, manifest, run);
  } else if (!hasAnyImageEvidence && run.status !== "invalidated") {
    reject("image-platform-checkpoint");
  } else if (hasCompleteImageEvidence) {
    const imagePlatforms = validateImagePlatformBinding(
      manifest.bindings?.imagePlatforms,
      manifest.bindings?.acrLoginServer,
    );
    const imageCheckpoint = checkpointNamed(checkpoints, "image-platform-verified");
    validateImagePlatformCheckpoint(imageCheckpoint, imagePlatforms);
    assertImmutableVerifierArtifact(artifacts.verifier, imagePlatforms.verifierSha256, "image-platform-checkpoint");
  }
  failIf(bindingHash(manifest.bindings) !== manifest.bindingSha256, "binding-hash");
  const published = checkpointNamed(checkpoints, "published-plan");
  failIf(published.planSha256 !== manifest.planSha256, "checkpoint-integrity");
  failIf(checkpoint.manifestSha256 !== sha256File(artifacts.manifest), "checkpoint-integrity");
  return manifest;
}

function validateImagePlatformCheckpoint(checkpoint, binding) {
  assertKnownKeys(checkpoint, [
    "version", "type", "sequence", "name", "runId", "phase", "createdAt",
    "verifierSha256", "verifierPath", "descriptorSetSha256",
  ], "image-platform-checkpoint");
  assertRequiredKeys(checkpoint, [
    "version", "type", "sequence", "name", "runId", "phase", "createdAt",
    "verifierSha256", "verifierPath", "descriptorSetSha256",
  ], "image-platform-checkpoint");
  failIf(
    checkpoint.version !== 1 ||
      checkpoint.type !== "lifecycle-checkpoint" ||
      checkpoint.name !== "image-platform-verified" ||
      !isSha(checkpoint.verifierSha256) ||
      checkpoint.verifierPath !== IMAGE_VERIFIER_ARTIFACT_NAME ||
      !isSha(checkpoint.descriptorSetSha256) ||
      checkpoint.verifierSha256 !== binding.verifierSha256 ||
      checkpoint.descriptorSetSha256 !== hashJson(binding.images),
    "image-platform-checkpoint",
  );
  return checkpoint;
}

function assertReceiptSchema(receipt, manifest, type, statusValues = undefined) {
  assertReceiptMatches(receipt, manifest, type);
  failIf(!Number.isInteger(receipt.version) || receipt.version !== 1, `${type}-schema`);
  failIf(!isObject(receipt) || typeof receipt.createdAt !== "string" || !Number.isFinite(jsonDate(receipt.createdAt)), `${type}-schema`);
  if (statusValues !== undefined) {
    failIf(!statusValues.includes(receipt.status), `${type}-receipt-status`);
  }
  if (type === "guard") {
    assertKnownKeys(receipt, [
      "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
      "guard", "showSha256", "guardArgv", "stdinSha256", "result",
    ], "guard-receipt-schema");
    assertRequiredKeys(receipt, [
      "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
      "guard", "showSha256", "guardArgv", "stdinSha256", "result",
    ], "guard-receipt-schema");
    failIf(
      receipt.createdAt !== manifest.createdAt ||
        receipt.guard !== GUARD_MAPPINGS[manifest.phase] ||
        !same(receipt.guardArgv, exactGuardArgv(manifest.phase)) ||
        !isSha(receipt.showSha256) ||
        receipt.stdinSha256 !== receipt.showSha256 ||
        receipt.result !== "passed",
      "guard-receipt-schema",
    );
  } else if (type === "preflight") {
    assertKnownKeys(receipt, [
      "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
      "result", "verifierSha256",
    ], "preflight-receipt-schema");
    assertRequiredKeys(receipt, [
      "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
      "result", "verifierSha256",
    ], "preflight-receipt-schema");
    failIf(receipt.result !== "passed" || !isSha(receipt.verifierSha256), "preflight-receipt-schema");
  } else if (type === "apply") {
    assertKnownKeys(receipt, [
      "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
      "status", "appliedAt",
    ], "apply-receipt-schema");
    assertRequiredKeys(receipt, [
      "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
      "status", "appliedAt",
    ], "apply-receipt-schema");
  } else if (type === "reconcile") {
    assertKnownKeys(receipt, [
      "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
      "status", "reconciledAt",
    ], "reconcile-receipt-schema");
    assertRequiredKeys(receipt, [
      "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
      "status", "reconciledAt",
    ], "reconcile-receipt-schema");
  }
  return receipt;
}

function readReceiptAtCheckpoint(filePath, checkpoint, manifest, type, statusValues = undefined) {
  try {
    assertCheckpointArtifact(filePath, checkpoint, "receiptSha256", `${type}-receipt`);
  } catch (error) {
    if (type === "apply" && error instanceof LifecycleError && error.code === "apply-receipt-hash") {
      reject("apply-mismatch");
    }
    throw error;
  }
  assertReceiptFileSize(filePath, `${type}-receipt`);
  const receipt = readJson(filePath, `${type}-receipt`);
  assertReceiptSchema(receipt, manifest, type, statusValues);
  return receipt;
}

function atomicConsume(filePath, consumedPath, code) {
  assertRegular(filePath, ARTIFACT_MODE, code);
  pathExists(consumedPath, `${code}-already-consumed`);
  try {
    atomicRenameNoReplace(filePath, consumedPath, code);
    fsyncDirectory(path.dirname(filePath));
  } catch {
    reject(`${code}-consume`);
  }
  assertRegular(consumedPath, ARTIFACT_MODE, `${code}-consumed`);
}

function validateState(state) {
  failIf(
    !isObject(state) || state.version !== 1 || !STATE_NAMES.includes(state.state),
    "invalid-state",
  );
  failIf(!Array.isArray(state.runs), "invalid-state-runs");
  failIf(!Number.isSafeInteger(state.stateSerial) || state.stateSerial < 0, "invalid-state-serial");
  failIf(state.sequence !== state.stateSerial, "invalid-state-sequence");
  failIf(
    state.previousSnapshotSha256 !== null && !isSha(state.previousSnapshotSha256),
    "invalid-state-chain",
  );
  failIf(!isSha(state.stateSha256), "invalid-state-hash");
  if (state.updatedAt !== undefined) failIf(!Number.isFinite(jsonDate(state.updatedAt)), "invalid-state-time");
  const ids = new Set();
  for (const run of state.runs) {
    failIf(
      !isObject(run) ||
        typeof run.id !== "string" ||
        !RUN_ID_RE.test(run.id) ||
        !PHASES.includes(run.phase) ||
        ![
          "created",
          "guarded",
          "preflighted",
          "applying",
          "unknown",
          "applied",
          "finalized",
          "invalidated",
          "superseded",
        ].includes(run.status),
      "invalid-state-run",
    );
    failIf(ids.has(run.id), "duplicate-run");
    ids.add(run.id);
    if (run.phase === "terminal") {
      failIf(run.status === "applied", "invalid-terminal-history");
    } else {
      failIf(run.status === "finalized", "invalid-finalize-history");
    }
    if (run.status === "superseded") {
      failIf(run.phase !== "credential-cleanup" || !RUN_ID_RE.test(run.supersededBy ?? ""), "invalid-supersession");
    }
    if (run.supersession !== undefined) {
      assertKnownKeys(
        run.supersession,
        ["oldRunId", "cleanupManifestSha256", "absenceReceiptSha256", "contextSha256"],
        "invalid-supersession",
      );
      assertRequiredKeys(
        run.supersession,
        ["oldRunId", "cleanupManifestSha256", "absenceReceiptSha256", "contextSha256"],
        "invalid-supersession",
      );
      failIf(
        run.phase !== "credential-cleanup" ||
          !RUN_ID_RE.test(run.supersession.oldRunId) ||
          !isSha(run.supersession.cleanupManifestSha256) ||
          !isSha(run.supersession.absenceReceiptSha256) ||
          !isSha(run.supersession.contextSha256),
        "invalid-supersession",
      );
    }
  }
  return state;
}

function phaseIndex(phase) {
  return PHASES.indexOf(phase);
}

function stateIndex(stateName) {
  return STATE_NAMES.indexOf(stateName);
}

function assertClosedGlobalState(state) {
  validateState(state);
  const target = stateIndex(state.state);
  const applied = new Map();
  const finalized = new Map();
  const active = new Map();
  const ids = new Set(state.runs.map((run) => run.id));
  for (const run of state.runs) {
    const index = phaseIndex(run.phase);
    failIf(target < PHASES.length && index > target, "global-state-history");
    if (run.status === "applied") {
      failIf(applied.has(run.phase), "duplicate-applied-run");
      applied.set(run.phase, run);
    }
    if (run.status === "finalized") {
      failIf(finalized.has(run.phase), "duplicate-finalized-run");
      finalized.set(run.phase, run);
    }
    if (activeStatus(run.status)) {
      failIf(active.has(run.phase), "duplicate-active-run");
      active.set(run.phase, run);
      failIf(target >= PHASES.length || index !== target, "global-state-history");
    }
    if (run.supersededBy !== undefined) {
      failIf(!ids.has(run.supersededBy), "invalid-supersession-target");
    }
    if (run.status === "superseded") {
      const replacement = state.runs.find((candidate) => candidate.id === run.supersededBy);
      failIf(!replacement || replacement.phase !== run.phase, "invalid-supersession-target");
      failIf(replacement.supersession?.oldRunId !== run.id, "invalid-supersession-history");
    }
  }
  for (let index = 0; index < PHASES.length; index += 1) {
    const phase = PHASES[index];
    if (index < target) {
      if (phase === "terminal") failIf(!finalized.has(phase), "global-state-history");
      else failIf(!applied.has(phase), "global-state-history");
      failIf(active.has(phase), "global-state-history");
    } else if (index >= target) {
      failIf(applied.has(phase) || finalized.has(phase), "global-state-history");
    }
  }
  if (target === PHASES.length - 1) {
    failIf(!applied.has("model-bootstrap") || !applied.has("runtime-cutover") || !applied.has("credential-cleanup"), "global-state-history");
  }
  return state;
}

function activeStatus(status) {
  return ["created", "guarded", "preflighted", "applying", "unknown"].includes(
    status,
  );
}

function jsonDate(value) {
  return new Date(value).getTime();
}

function isSha(value) {
  return typeof value === "string" && HASH_RE.test(value);
}

function isCommit(value) {
  return typeof value === "string" && COMMIT_RE.test(value);
}

function normalizeBackend(backend) {
  if (isObject(backend?.identity) && Object.hasOwn(backend, "sha256")) {
    backend = backend.identity;
  }
  failIf(!isObject(backend), "backend-context");
  failIf(
    canonicalJson(Object.keys(backend).sort()) !==
      canonicalJson([...BACKEND_IDENTITY_KEYS].sort()),
    "backend-keys",
  );
  const identity = Object.fromEntries(
    BACKEND_IDENTITY_KEYS.map((key) => [key, backend[key]]),
  );
  failIf(
    Object.values(identity).some(
      (value) => value === undefined || value === null || value === "",
    ),
    "backend-context",
  );
  failIf(
    typeof identity.type !== "string" ||
      typeof identity.resource_group_name !== "string" ||
      typeof identity.storage_account_name !== "string" ||
      typeof identity.container_name !== "string" ||
      typeof identity.key !== "string" ||
      typeof identity.subscription_id !== "string" ||
      typeof identity.tenant_id !== "string" ||
      identity.use_azuread_auth !== true ||
      identity.use_cli !== true,
    "backend-context",
  );
  failIf(identity.type !== "azurerm", "backend-type");
  return {
    identity: Object.freeze(identity),
    sha256: sha256Bytes(canonicalBackendIdentityText(identity)),
  };
}

function canonicalBackendIdentityText(identity) {
  return `${canonicalJson(identity)}\n`;
}

export function canonicalBackendIdentityJson(backend) {
  const identity = normalizeBackend(backend).identity;
  return canonicalBackendIdentityText(identity);
}

export function calculateBackendHash(backend) {
  const normalized = normalizeBackend(backend);
  return normalized.sha256;
}

function parseBackendScalar(value, code) {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const match = /^"([^"\\]*(?:\\.[^"\\]*)*)"$/.exec(trimmed);
  if (!match) reject(code);
  try {
    return JSON.parse(trimmed);
  } catch {
    reject(code);
  }
}

export function parseCanonicalBackendConfig(text) {
  failIf(typeof text !== "string", "backend-config");
  const values = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([a-z][a-z0-9_]*)\s*=\s*(.+)$/.exec(trimmed);
    failIf(!match, "backend-config");
    const [, key, value] = match;
    failIf(!BACKEND_CONFIG_KEYS.includes(key) || Object.hasOwn(values, key), "backend-keys");
    values[key] = parseBackendScalar(value, "backend-config");
  }
  failIf(
    canonicalJson(Object.keys(values).sort()) !==
      canonicalJson([...BACKEND_CONFIG_KEYS].sort()),
    "backend-keys",
  );
  const identity = {
    container_name: values.container_name,
    key: values.key,
    resource_group_name: values.resource_group_name,
    storage_account_name: values.storage_account_name,
    subscription_id: values.subscription_id,
    tenant_id: values.tenant_id,
    type: "azurerm",
    use_azuread_auth: values.use_azuread_auth,
    use_cli: values.use_cli,
  };
  return normalizeBackend(identity);
}

function normalizeContext(raw, expected) {
  failIf(!isObject(raw), "context-missing");
  if (raw.phase !== undefined) failIf(raw.phase !== expected.phase, "phase-context");
  if (raw.cwd !== undefined) failIf(raw.cwd !== expected.cwd, "working-directory");
  if (raw.planSha256 !== undefined) {
    failIf(raw.planSha256 !== expected.planSha256, "plan-hash");
  }
  if (raw.argv !== undefined) failIf(!same(raw.argv, expected.argv), "argv-context");
  const calculatedBackend = normalizeBackend(raw.backend);
  const backend = calculatedBackend;
  const runtimeBackend = {
    subscription: backend.identity.subscription_id,
    tenant: backend.identity.tenant_id,
  };
  const azure = raw.azure ?? raw.azureContext;
  const caller = raw.caller;
  failIf(!isObject(azure), "azure-context");
  failIf(
    azure.cloud !== "AzureCloud" ||
      typeof azure.subscription !== "string" ||
      typeof azure.tenant !== "string",
    "azure-context",
  );
  failIf(
    runtimeBackend.subscription !== azure.subscription ||
      runtimeBackend.tenant !== azure.tenant,
    "binding-mismatch",
  );
  failIf(!isObject(caller) || caller.userType !== "user", "caller-account-type");
  failIf(
    typeof caller.objectId !== "string" || caller.objectId.length === 0,
    "caller-object-id",
  );
  if (raw.protectedOperatorId !== undefined) {
    failIf(raw.protectedOperatorId !== caller.objectId, "caller-operator");
  }
  const calculatedCallerHash = hashJson({
    cloud: azure.cloud,
    subscription: azure.subscription,
    tenant: azure.tenant,
    userType: caller.userType,
    objectId: caller.objectId,
  });
  const calculatedAzureContextHash = hashJson({
    cloud: azure.cloud,
    subscription: azure.subscription,
    tenant: azure.tenant,
  });
  if (raw.callerHash !== undefined) {
    failIf(raw.callerHash !== calculatedCallerHash, "identity-hash");
  }
  if (raw.azureContextHash !== undefined) {
    failIf(raw.azureContextHash !== calculatedAzureContextHash, "identity-hash");
  }
  const callerHash = calculatedCallerHash;
  const azureContextHash = calculatedAzureContextHash;
  const imagePlatforms = expected.imagePlatforms ?? raw.imagePlatforms;
  if (imagePlatforms !== undefined) {
    validateImagePlatformBinding(imagePlatforms, raw.acrLoginServer);
    failIf(!same(raw.imagePlatforms, imagePlatforms), "image-platform-binding");
  }
  const bindings = {
    planSha256: expected.planSha256,
    terraformSha256: raw.terraformSha256,
    lifecycleSha256: raw.lifecycleSha256,
    guardSha256: raw.guardSha256,
    dependencyBlobs: raw.dependencyBlobs,
    repositoryCommit: raw.repositoryCommit,
    cwd: raw.cwd,
    phase: expected.phase,
    argv: expected.argv,
    backend: backend.identity,
    backendSha256: backend.sha256,
    backendConfigurationSha256: backend.sha256,
    workspace: raw.workspace,
    stateLineage: raw.stateLineage,
    stateSerial: raw.stateSerial,
    liveRevision: raw.liveRevision,
    runtimeIdentityId: raw.runtimeIdentityId,
    runtimeIdentityClientId: raw.runtimeIdentityClientId,
    runtimeIdentityPrincipalId: raw.runtimeIdentityPrincipalId,
    accountId: raw.accountId,
    runtimeOpenAiRoleAssignmentId: raw.runtimeOpenAiRoleAssignmentId,
    azureContextHash,
    callerHash,
    guard: GUARD_MAPPINGS[expected.phase],
    acrLoginServer: raw.acrLoginServer,
    ...(imagePlatforms === undefined ? {} : { imagePlatforms }),
  };
  failIf(!isSha(bindings.planSha256), "plan-hash");
  failIf(!isSha(bindings.terraformSha256), "terraform-hash");
  failIf(!isSha(bindings.lifecycleSha256), "lifecycle-hash");
  failIf(!isSha(bindings.guardSha256), "guard-hash");
  failIf(
    !Array.isArray(bindings.dependencyBlobs) ||
      bindings.dependencyBlobs.some(
        (entry) => !isObject(entry) || !isSha(entry.sha256) || typeof entry.blob !== "string",
      ),
    "dependency-hash",
  );
  failIf(!isCommit(bindings.repositoryCommit), "repository-commit");
  failIf(bindings.cwd !== expected.cwd, "working-directory");
  failIf(bindings.workspace !== "default", "workspace");
  failIf(
    typeof bindings.stateLineage !== "string" ||
      !Number.isSafeInteger(bindings.stateSerial) ||
      bindings.stateSerial < 0,
    "state-context",
  );
  failIf(
    bindings.liveRevision !== null &&
      bindings.liveRevision !== undefined &&
      typeof bindings.liveRevision !== "string",
    "live-context",
  );
  failIf(
      typeof bindings.runtimeIdentityId !== "string" ||
      !/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[^/]+$/.test(bindings.runtimeIdentityId) ||
      !UUID_RE.test(bindings.runtimeIdentityClientId ?? "") ||
      !UUID_RE.test(bindings.runtimeIdentityPrincipalId ?? ""),
    "runtime-identity",
  );
  const accountParts = resourceIdParts(bindings.accountId, "account-context");
  failIf(accountParts.subscription !== azure.subscription, "binding-mismatch");
  const roleAssignmentPrefix = `${bindings.accountId}/providers/Microsoft.Authorization/roleAssignments/`;
  failIf(
    typeof bindings.runtimeOpenAiRoleAssignmentId !== "string" ||
      !bindings.runtimeOpenAiRoleAssignmentId.startsWith(roleAssignmentPrefix) ||
      !UUID_RE.test(bindings.runtimeOpenAiRoleAssignmentId.slice(roleAssignmentPrefix.length)),
    "runtime-openai-role",
  );
  failIf(!same(bindings.argv, expected.argv), "argv-context");
  failIf(!isSha(bindings.backendConfigurationSha256), "backend-hash");
  failIf(typeof bindings.acrLoginServer !== "string" || !ACR_LOGIN_SERVER_RE.test(bindings.acrLoginServer), "acr-login-server");
  return bindings;
}

function bindingHash(bindings) {
  return hashJson(bindings);
}

function gitResult(repoRoot, args, processRunner, phase) {
  const result = commandResult(
    "/usr/bin/git",
    gitArgs(args),
    {
      cwd: repoRoot,
      env: GIT_ENVIRONMENT,
      timeoutMs: COMMAND_TIMEOUT_MS,
      phase,
    },
    processRunner,
  );
  failIf(result.status !== "success", "git-check");
  return result.stdout;
}

function cleanupUtilitySha256AtCommit(repositoryCommit, processRunner) {
  if (!isCommit(repositoryCommit)) return null;
  const result = commandResult(
    "/usr/bin/git",
    gitArgs(["cat-file", "blob", `${repositoryCommit}:${CLEANUP_UTILITY_RELATIVE_PATH}`]),
    {
      cwd: REPOSITORY_ROOT,
      env: GIT_ENVIRONMENT,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: EXECUTABLE_MAX_BYTES,
      phase: "cleanup-operation-version-context",
    },
    processRunner,
  );
  if (result.status !== "success") return null;
  return sha256Bytes(result.stdout);
}

function reviewedBlobAtCommit(repoRoot, repositoryCommit, relativePath, processRunner) {
  const objectName = `${repositoryCommit}:${relativePath}`;
  const blob = commandResult(
    "/usr/bin/git",
    gitArgs(["rev-parse", objectName]),
    {
      cwd: repoRoot,
      env: GIT_ENVIRONMENT,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: 128,
      phase: "reconcile-code-binding",
    },
    processRunner,
  );
  if (blob.status !== "success") return null;
  const blobId = blob.stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(blobId)) return null;
  const contents = commandResult(
    "/usr/bin/git",
    gitArgs(["cat-file", "blob", objectName]),
    {
      cwd: repoRoot,
      env: GIT_ENVIRONMENT,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: JSON_MAX_BYTES,
      phase: "reconcile-code-binding",
    },
    processRunner,
  );
  if (contents.status !== "success") return null;
  return { blob: blobId, sha256: sha256Bytes(contents.stdout) };
}

function historicalCodeBindingsMatch(repoRoot, phase, current, recorded, processRunner) {
  if (!isCommit(recorded.repositoryCommit) || !isCommit(current.repositoryCommit)) return false;
  if (!isSha(recorded.lifecycleSha256) || !isSha(recorded.guardSha256) ||
      !Array.isArray(recorded.dependencyBlobs)) return false;

  const ancestor = commandResult(
    "/usr/bin/git",
    gitArgs(["merge-base", "--is-ancestor", recorded.repositoryCommit, current.repositoryCommit]),
    {
      cwd: repoRoot,
      env: GIT_ENVIRONMENT,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: 128,
      phase: "reconcile-code-binding",
    },
    processRunner,
  );
  if (ancestor.status !== "success") return false;

  const expectedDependencies = current.dependencyBlobs;
  if (!Array.isArray(expectedDependencies) ||
      recorded.dependencyBlobs.length !== expectedDependencies.length ||
      !recorded.dependencyBlobs.every((entry, index) =>
        isObject(entry) &&
        canonicalJson(Object.keys(entry).sort()) === canonicalJson(["blob", "path", "sha256"]) &&
        entry.path === expectedDependencies[index]?.path &&
        /^[a-f0-9]{40}$/.test(entry.blob ?? "") &&
        isSha(entry.sha256),
      )) {
    return false;
  }

  const lifecyclePath = REVIEWED_DEPENDENCIES[phase]?.[0];
  const guardPath = "infra/scripts/assert-dev-plan.mjs";
  if (typeof lifecyclePath !== "string") return false;
  const lifecycle = reviewedBlobAtCommit(repoRoot, recorded.repositoryCommit, lifecyclePath, processRunner);
  const guard = reviewedBlobAtCommit(repoRoot, recorded.repositoryCommit, guardPath, processRunner);
  if (lifecycle?.sha256 !== recorded.lifecycleSha256 || guard?.sha256 !== recorded.guardSha256) return false;

  return recorded.dependencyBlobs.every((entry) => {
    const resolved = reviewedBlobAtCommit(repoRoot, recorded.repositoryCommit, entry.path, processRunner);
    return resolved?.blob === entry.blob && resolved.sha256 === entry.sha256;
  });
}

function reviewedFileIdentity(repoRoot, relativePath, processRunner) {
  const absolute = path.join(repoRoot, relativePath);
  assertRegular(absolute, null, "reviewed-file");
  if (relativePath.endsWith(".json")) {
    const text = boundedFileText(absolute, JSON_MAX_BYTES, "reviewed-fixture");
    parseJsonText(text, "reviewed-fixture");
  }
  const headBlob = gitResult(repoRoot, ["rev-parse", `HEAD:${relativePath}`], processRunner).trim();
  failIf(!/^[a-f0-9]{40}$/.test(headBlob), "reviewed-file-blob");
  const currentBlob = gitResult(repoRoot, ["hash-object", relativePath], processRunner).trim();
  failIf(currentBlob !== headBlob, "reviewed-file-changed");
  return { path: relativePath, blob: headBlob, sha256: sha256File(absolute, JSON_MAX_BYTES) };
}

function parseStatusLine(line) {
  if (line.length < 3) reject("worktree-status");
  return { status: line.slice(0, 2), file: line.slice(3) };
}

function checkWorktree(repoRoot, phase, processRunner) {
  const lines = gitResult(
    repoRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    processRunner,
    phase,
  )
    .split("\n")
    .filter(Boolean)
    .map(parseStatusLine);
  for (const entry of lines) {
    failIf(entry.file.includes("\0"), "worktree-path");
    failIf(entry.status !== " M", "worktree-staged");
  }
  if (phase !== "model-bootstrap") {
    failIf(lines.length !== 0, "worktree-dirty");
    return;
  }
  // A clean worktree is the normal post-bootstrap state.  Retain support for
  // the interrupted generation handoff below, but do not force callers to
  // recreate that historical diff merely to initialize a compatible state.
  if (lines.length === 0) return;
  const changed = new Set(lines.map((entry) => entry.file));
  failIf(
    [...changed].some((file) => !GENERATION_PATHS.includes(file)) ||
      changed.size !== GENERATION_PATHS.length ||
      !GENERATION_PATHS.every((file) => changed.has(file)),
    "worktree-generation-paths",
  );
  const diff = gitResult(
    repoRoot,
    ["diff", "--binary", "--", ...GENERATION_PATHS],
    processRunner,
    phase,
  );
  failIf(sha256Bytes(diff) !== GENERATION_DIFF_SHA256, "worktree-generation-diff");
}

function boundedProcessResult(result, maxOutputBytes = COMMAND_OUTPUT_MAX_BYTES) {
  if (result === undefined || result === null) {
    return { status: "ambiguous", exitCode: null, stdout: "", stderr: "" };
  }
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout.toString("utf8")
    : typeof result.stdout === "string"
      ? result.stdout
      : "";
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.toString("utf8")
    : typeof result.stderr === "string"
      ? result.stderr
      : "";
  failIf(Buffer.byteLength(stdout) > maxOutputBytes, "command-output-too-large");
  failIf(Buffer.byteLength(stderr) > maxOutputBytes, "command-output-too-large");
  if (result.timedOut === true || result.status === null || result.signal !== undefined && result.status === null) {
    return { status: "ambiguous", exitCode: null, stdout: "", stderr: "", timedOut: true };
  }
  if (result.error && result.status === undefined) {
    return { status: "ambiguous", exitCode: null, stdout: "", stderr: "" };
  }
  const exitCode = Number.isInteger(result.exitCode)
    ? result.exitCode
    : result.status;
  return {
    status: exitCode === 0 ? "success" : "failure",
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    stdout,
    stderr,
  };
}

function commandResult(command, args, options, processRunner) {
  const request = {
    command,
    argv: [...args],
    phase: options.phase,
    cwd: options.cwd,
    env: { ...options.env },
    input: options.input,
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? COMMAND_OUTPUT_MAX_BYTES,
    killSignal: "SIGKILL",
    processGroup: options.processGroup === true,
  };
  let result;
  try {
    if (processRunner) {
      result = processRunner(request);
    } else if (options.processGroup === true) {
      const helper = spawnSync(
        "/usr/bin/node",
        [SCRIPT_PATH, INTERNAL_APPLY_RUNNER_MARKER, ...args],
        {
        cwd: options.cwd,
          env: options.env,
          encoding: "utf8",
          timeout: request.timeoutMs + APPLY_TERM_GRACE_MS + APPLY_KILL_GRACE_MS,
          killSignal: request.killSignal,
          maxBuffer: request.maxOutputBytes,
          stdio: childStdioWithKernelLock(["ignore", "pipe", "pipe"]),
        },
      );
      if (helper.status !== 0 || helper.error || typeof helper.stdout !== "string") {
        return { status: "ambiguous", exitCode: null, stdout: "", stderr: "" };
      }
      if (Buffer.byteLength(helper.stdout) > request.maxOutputBytes) {
        return { status: "ambiguous", exitCode: null, stdout: "", stderr: "" };
      }
      const parsed = JSON.parse(helper.stdout);
      if (!isObject(parsed) || !["success", "failure", "ambiguous"].includes(parsed.status)) {
        return { status: "ambiguous", exitCode: null, stdout: "", stderr: "" };
      }
      return {
        status: parsed.status,
        exitCode: Number.isInteger(parsed.exitCode) ? parsed.exitCode : null,
        stdout: "",
        stderr: "",
        ...(parsed.timedOut === true ? { timedOut: true } : {}),
      };
    } else {
      result = spawnSync(command, args, {
        cwd: options.cwd,
        env: options.env,
        input: options.input,
        encoding: "utf8",
        timeout: request.timeoutMs,
        killSignal: request.killSignal,
        maxBuffer: request.maxOutputBytes,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  } catch {
    return { status: "ambiguous", exitCode: null, stdout: "", stderr: "" };
  }
  return boundedProcessResult(result, request.maxOutputBytes);
}

function runCommand(config, command, args, options = {}) {
  const request = { cwd: config.workdir, env: config.childEnvironment, ...options };
  const execute = () => commandResult(command, args, request, config.processRunner);
  if (!cacheableCommand(command, args) || options.fresh === true) return execute();
  return testSnapshot(
    `command:${commandSnapshotKey(command, args, request)}`,
    execute,
  );
}

function parseCommandJson(result, code) {
  failIf(result.status !== "success", code);
  failIf(Buffer.byteLength(result.stdout) > JSON_MAX_BYTES, `${code}-too-large`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    reject(`${code}-json`);
  }
}

function checkInheritedEnvironment(environment) {
  for (const key of Object.keys(environment)) {
    failIf(
      key === "AZURE_CONFIG_DIR" || /^(TF_|ARM_|MSI_|IDENTITY_)/.test(key),
      "contaminated-environment",
    );
  }
}

function assertOnlyEntry(directory, expected, code) {
  const entries = readdirSync(directory, { withFileTypes: true });
  failIf(
    entries.length > 1 ||
      (entries.length === 1 && entries[0].name !== expected) ||
      entries.some((entry) => entry.isSymbolicLink()),
    code,
  );
}

function ensureLifecycleCache() {
  const parent = path.dirname(LIFECYCLE_CACHE_ROOT);
  assertDirectory(parent, "lifecycle-cache-parent");
  ensureDirectory(LIFECYCLE_CACHE_ROOT, "lifecycle-cache");
  assertOnlyEntry(LIFECYCLE_CACHE_ROOT, "Microsoft", "lifecycle-cache-entries");

  const microsoft = path.join(LIFECYCLE_CACHE_ROOT, "Microsoft");
  ensureDirectory(microsoft, "lifecycle-cache-microsoft");
  assertOnlyEntry(microsoft, "DeveloperTools", "lifecycle-cache-entries");

  const developerTools = path.join(microsoft, "DeveloperTools");
  ensureDirectory(developerTools, "lifecycle-cache-developer-tools");
  assertOnlyEntry(developerTools, "deviceid", "lifecycle-cache-entries");

  const deviceIdPath = path.join(developerTools, "deviceid");
  if (existsSync(deviceIdPath)) {
    const deviceIdStat = assertRegular(
      deviceIdPath,
      ARTIFACT_MODE,
      "lifecycle-cache-device-id",
    );
    failIf(deviceIdStat.size !== 36, "lifecycle-cache-device-id");
    failIf(!UUID_RE.test(readFileSync(deviceIdPath, "utf8")), "lifecycle-cache-device-id");
  } else {
    exclusiveText(deviceIdPath, randomUUID(), "lifecycle-cache-device-id");
  }
  assertOnlyEntry(developerTools, "deviceid", "lifecycle-cache-entries");
  fsyncDirectory(developerTools);
  fsyncDirectory(microsoft);
  fsyncDirectory(LIFECYCLE_CACHE_ROOT);
  return LIFECYCLE_CACHE_ROOT;
}

export function buildChildEnvironment(runDirectory, inherited = process.env) {
  checkInheritedEnvironment(inherited);
  const configPath = path.join(runDirectory, "tf-cli.tfrc");
  if (existsSync(configPath)) {
    assertRegular(configPath, ARTIFACT_MODE, "terraform-cli-config");
    failIf(statSync(configPath).size > JSON_MAX_BYTES, "terraform-cli-config");
    failIf(readFileSync(configPath).byteLength !== 0, "terraform-cli-config");
  } else {
    exclusiveText(configPath, "", "terraform-cli-config");
  }
  const cacheRoot = ensureLifecycleCache();
  const environment = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    AZURE_CONFIG_DIR: "/home/dev/.azure",
    XDG_CACHE_HOME: cacheRoot,
    CHECKPOINT_DISABLE: "1",
    TF_IN_AUTOMATION: "1",
    TF_CLI_CONFIG_FILE: configPath,
  };
  failIf(
    !same(Object.keys(environment), ALLOWED_CHILD_ENV_KEYS),
    "child-environment",
  );
  return environment;
}

function defaultGuardScript(guardPath) {
  return guardPath ?? path.join(REPOSITORY_ROOT, "infra/scripts/assert-dev-plan.mjs");
}

function defaultBackendIdentity(config) {
  const backendText = boundedFileText(
    config.backendConfigPath,
    JSON_MAX_BYTES,
    "backend-config",
  );
  const parsed = parseCanonicalBackendConfig(backendText);
  failIf(parsed.sha256 !== BACKEND_SHA256, "backend-hash");
  return parsed;
}

function assertPrivateRegular(filePath, code) {
  const stat = assertRegular(filePath, null, code);
  failIf((fileMode(stat) & ~ARTIFACT_MODE) !== 0, `${code}-mode`);
  return stat;
}

function assertCacheDirectory(directoryPath) {
  let stat;
  try {
    stat = lstatSync(directoryPath);
  } catch {
    reject("terraform-cache-directory-missing");
  }
  failIf(stat.isSymbolicLink() || !stat.isDirectory(), "terraform-cache-directory");
  failIf(UID !== undefined && stat.uid !== UID, "terraform-cache-directory-owner");
  try {
    failIf(realpathSync(directoryPath) !== path.resolve(directoryPath), "terraform-cache-directory-noncanonical");
  } catch {
    reject("terraform-cache-directory-realpath");
  }
}

function parseJsonText(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    reject(`${code}-json`);
  }
}

export function parseTerraformStateCache(cache, backend, account) {
  failIf(!isObject(cache), "terraform-cache");
  failIf(
    canonicalJson(Object.keys(cache).sort()) !==
      canonicalJson(["backend", "terraform_version", "version"]),
    "terraform-cache",
  );
  failIf(cache.version !== 3 || cache.terraform_version !== "1.15.8", "terraform-cache");
  const normalized = normalizeBackend(backend);
  const cachedBackend = cache.backend;
  failIf(
    !isObject(cachedBackend) ||
      canonicalJson(Object.keys(cachedBackend).sort()) !==
        canonicalJson(["config", "hash", "type"]) ||
      cachedBackend.type !== normalized.identity.type ||
      !Number.isSafeInteger(cachedBackend.hash) ||
      cachedBackend.hash < 0,
    "terraform-cache-backend",
  );
  const cachedConfig = cachedBackend.config;
  failIf(!isObject(cachedConfig), "terraform-cache-config");
  for (const key of BACKEND_CONFIG_KEYS) {
    failIf(!Object.hasOwn(cachedConfig, key), "terraform-cache-config");
    failIf(cachedConfig[key] !== normalized.identity[key], "binding-mismatch");
  }
  for (const key of Object.keys(cachedConfig)) {
    failIf(
      !BACKEND_CONFIG_KEYS.includes(key) && !BACKEND_CACHE_OPTIONAL_KEYS.includes(key),
      "terraform-cache-config",
    );
    if (!BACKEND_CONFIG_KEYS.includes(key)) failIf(cachedConfig[key] !== null, "terraform-cache-config");
  }
  failIf(
    !isObject(account) ||
      account.cloud !== "AzureCloud" ||
      account.subscription !== normalized.identity.subscription_id ||
      account.tenant !== normalized.identity.tenant_id,
    "binding-mismatch",
  );
  return {
    type: cachedBackend.type,
    config: cachedConfig,
    hash: cachedBackend.hash,
  };
}

function defaultTerraformStateCache(config, backend, account) {
  return testSnapshot(`terraform-cache:${config.workdir}:${config.contextOperation ?? "bootstrap"}`, () => {
    const cacheDirectory = path.join(config.workdir, ".terraform");
    assertCacheDirectory(cacheDirectory);
    const cachePath = path.join(cacheDirectory, "terraform.tfstate");
    assertPrivateRegular(cachePath, "terraform-cache");
    const text = boundedFileText(cachePath, JSON_MAX_BYTES, "terraform-cache");
    return parseTerraformStateCache(parseJsonText(text, "terraform-cache"), backend, account);
  });
}

function defaultOperatorId(workdir) {
  const tfvars = path.join(workdir, "terraform.tfvars");
  const match = boundedFileText(tfvars, JSON_MAX_BYTES, "operator-config").match(
    /^operator_principal_id\s*=\s*"([0-9a-f-]+)"\s*$/m,
  );
  failIf(!match || !UUID_RE.test(match[1]), "operator-config");
  return match[1];
}

function protectedRuntimeSecretsRoleEnabled(config, expected) {
  const tfvarsPath = path.join(config.workdir, "terraform.tfvars");
  const stat = assertRegular(tfvarsPath, null, "runtime-secrets-role");
  failIf((fileMode(stat) & 0o077) !== 0 || fileMode(stat) > 0o600, "runtime-secrets-role-mode");
  let source;
  try {
    source = readFileSync(tfvarsPath, "utf8");
  } catch {
    reject("runtime-secrets-role-read");
  }
  const assignmentPattern = new RegExp(
    `(?:^|[\\r\\n])[ \\t]*${RUNTIME_SECRETS_ASSIGNMENT}[ \\t]*=[ \\t]*(true|false)[ \\t]*(?:#[^\\r\\n]*)?(?=[\\r\\n]|$)`,
    "g",
  );
  const occurrences = [...source.matchAll(new RegExp(`\\b${RUNTIME_SECRETS_ASSIGNMENT}\\b[ \\t]*=`, "g"))];
  failIf(occurrences.length > 1, "runtime-secrets-role-assignments");
  const matches = [...source.matchAll(assignmentPattern)];
  failIf(matches.length !== occurrences.length, "runtime-secrets-role-value");
  const enabled = matches.length === 0 || matches[0][1] === "true";
  if (expected === true) failIf(!enabled, "runtime-secrets-role-disabled");
  else failIf(enabled, "runtime-secrets-role-enabled");
  return enabled;
}

function defaultAccount(config) {
  return testSnapshot(`azure-account:${config.workdir}:${config.contextOperation ?? "bootstrap"}`, () => {
    const account = runCommand(config, AZ_PATH, ["account", "show", "--output", "json"]);
    const accountJson = parseCommandJson(account, "azure-account");
    const userType = accountJson?.user?.type;
    failIf(userType !== "user", "caller-account-type");
    const identity = runCommand(config, AZ_PATH, [
      "ad",
      "signed-in-user",
      "show",
      "--output",
      "json",
    ]);
    const identityJson = parseCommandJson(identity, "caller-object-id");
    const objectId = identityJson?.id ?? identityJson?.objectId;
    failIf(typeof objectId !== "string" || objectId.length === 0, "caller-object-id");
    const subscription = accountJson?.id;
    const tenant = accountJson?.tenantId;
    const cloud = accountJson?.environmentName;
    failIf(
      typeof subscription !== "string" ||
        typeof tenant !== "string" ||
        cloud !== "AzureCloud",
      "azure-context",
    );
    return { cloud, subscription, tenant, userType, objectId };
  });
}

function defaultReviewIdentity(config) {
  return testSnapshot(`review-identity:${config.repoRoot}:${config.reviewedPhase}`, () => {
    const paths = REVIEWED_DEPENDENCIES[config.reviewedPhase];
    failIf(!Array.isArray(paths), "reviewed-dependencies");
    const dependencies = paths.map((relativePath) =>
      reviewedFileIdentity(config.repoRoot, relativePath, config.processRunner),
    );
    const guard = dependencies.find((entry) => entry.path === "infra/scripts/assert-dev-plan.mjs");
    failIf(!isObject(guard), "reviewed-dependencies");
    return {
      repositoryCommit: gitResult(config.repoRoot, ["rev-parse", "HEAD"], config.processRunner).trim(),
      lifecycleSha256: dependencies[0].sha256,
      guardSha256: guard.sha256,
      dependencyBlobs: dependencies.slice(1),
    };
  });
}

function defaultRemoteState(config) {
  return testSnapshot(`remote-state:${config.workdir}:${config.contextOperation ?? "bootstrap"}`, () => {
    const state = runCommand(config, TERRAFORM_PATH, ["state", "pull"]);
    return parseTerraformStateJson(parseCommandJson(state, "remote-state"));
  });
}

function parseTerraformStateJson(state) {
  failIf(
    !isObject(state) ||
      typeof state.lineage !== "string" ||
      state.lineage.length === 0 ||
      !Number.isSafeInteger(state.serial) ||
      state.serial < 0,
    "state-context",
  );
  return { stateLineage: state.lineage, stateSerial: state.serial };
}

function defaultContext(config, request) {
  const imageSnapshotKey = config.imagePlatforms === undefined ? "no-image" : hashJson(config.imagePlatforms);
  return testSnapshot(
    `context:${config.workdir}:${request.phase}:${request.operation ?? config.contextOperation ?? "bootstrap"}:${config.contextOperation ?? "bootstrap"}:${imageSnapshotKey}`,
    () => {
    const backend = defaultBackendIdentity(config);
    const account = defaultAccount(config);
    defaultTerraformStateCache(config, backend.identity, account);
    failIf(
      backend.identity.subscription_id !== account.subscription ||
        backend.identity.tenant_id !== account.tenant ||
        account.cloud !== "AzureCloud",
      "binding-mismatch",
    );
    const state = defaultRemoteState(config);
    const operator = defaultOperatorId(config.workdir);
    failIf(account.objectId !== operator, "caller-operator");
    const reviewed = defaultReviewIdentity({ ...config, reviewedPhase: request.phase });
    const outputs = defaultOutputs({ ...config, account });
    const workspace = runCommand(config, TERRAFORM_PATH, ["workspace", "show"]);
    failIf(workspace.status !== "success" || workspace.stdout.trim() !== "default", "workspace");
    return {
      terraformSha256: testStableSnapshot(
        `terraform-executable:${TERRAFORM_PATH}`,
        terraformExecutableSha256,
      ),
      lifecycleSha256: reviewed.lifecycleSha256,
      guardSha256: reviewed.guardSha256,
      dependencyBlobs: reviewed.dependencyBlobs,
      repositoryCommit: reviewed.repositoryCommit,
      cwd: config.workdir,
      backend: backend.identity,
      workspace: "default",
      stateLineage: state.stateLineage,
      stateSerial: state.stateSerial,
      azure: account,
      caller: { userType: account.userType, objectId: account.objectId },
      liveRevision: outputs.relayRevision,
      runtimeIdentityId: outputs.runtimeIdentityId,
      runtimeIdentityClientId: outputs.runtimeIdentityClientId,
      runtimeIdentityPrincipalId: outputs.runtimeIdentityPrincipalId,
      accountId: outputs.accountId,
      runtimeOpenAiRoleAssignmentId: outputs.runtimeOpenAiRoleAssignmentId,
      acrLoginServer: outputs.acrLoginServer,
      ...(config.imagePlatforms === undefined ? {} : { imagePlatforms: config.imagePlatforms }),
    };
    },
  );
}

function normalizeInjectedContext(raw, expected) {
  return normalizeContext(raw, expected);
}

function parseStatus(result) {
  if (result === true || result === 0 || result?.status === "success" || result?.status === "passed") {
    return "success";
  }
  if (result?.status === "ambiguous") return "ambiguous";
  return "failure";
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function makeRunId() {
  return `${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`;
}

function artifactPaths(runDirectory) {
  return {
    plan: path.join(runDirectory, "plan.tfplan"),
    planTemp: path.join(runDirectory, ".plan.tfplan.tmp"),
    manifest: path.join(runDirectory, "create-manifest.json"),
    show: path.join(runDirectory, "show.json"),
    guard: path.join(runDirectory, "guard-receipt.json"),
    descriptor: path.join(runDirectory, "vault-descriptor.json"),
    cleanupOperation: path.join(runDirectory, "cleanup-manifest.json"),
    cleanupState: path.join(runDirectory, "cleanup-state-000000.json"),
    cleanupStatePattern: path.join(runDirectory, "cleanup-state-*.json"),
    cleanupStateAnchor: path.join(runDirectory, "cleanup-state-anchor.json"),
    cleanupStateAnchorPattern: path.join(runDirectory, "cleanup-state-anchor-*.json"),
    preflight: path.join(runDirectory, "preflight-receipt.json"),
    apply: path.join(runDirectory, "apply-receipt.json"),
    reconcile: path.join(runDirectory, "reconcile-receipt-000001.json"),
    reconcilePattern: path.join(runDirectory, "reconcile-receipt-*.json"),
    terminal: path.join(runDirectory, "terminal-receipts.json"),
    diagnosticIntent: path.join(runDirectory, "diagnostic-intent.json"),
    diagnosticInvoking: path.join(runDirectory, "diagnostic-invoking.json"),
    diagnosticSubmission: path.join(runDirectory, "diagnostic-submission.json"),
    diagnostic: path.join(runDirectory, "diagnostic-receipt.json"),
    absence: path.join(runDirectory, "cleanup-absence-receipt.json"),
    verifier: path.join(runDirectory, IMAGE_VERIFIER_ARTIFACT_NAME),
  };
}

function reconcileReceiptPath(runDirectory, sequence) {
  failIf(!Number.isSafeInteger(sequence) || sequence < 1, "reconcile-sequence");
  return path.join(runDirectory, `reconcile-receipt-${String(sequence).padStart(6, "0")}.json`);
}

function readReconcileReceiptPaths(runDirectory) {
  const paths = [];
  for (const entry of readdirSync(runDirectory, { withFileTypes: true })) {
    const match = /^reconcile-receipt-(\d{6})\.json$/.exec(entry.name);
    if (!match) {
      if (entry.name === "reconcile-receipt.json" || entry.name.startsWith("reconcile-receipt-")) {
        reject("reconcile-receipt-name");
      }
      continue;
    }
    failIf(entry.isSymbolicLink(), "reconcile-receipt-symlink");
    paths.push({ sequence: Number(match[1]), path: path.join(runDirectory, entry.name) });
  }
  paths.sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < paths.length; index += 1) {
    failIf(paths[index].sequence !== index + 1, "reconcile-sequence");
  }
  return paths;
}

function reconcilePathForCheckpoint(runDirectory, checkpoint) {
  const sequence = checkpoint?.reconcileSequence;
  failIf(!Number.isSafeInteger(sequence) || sequence < 1, "reconcile-checkpoint");
  const filePath = reconcileReceiptPath(runDirectory, sequence);
  failIf(path.dirname(filePath) !== runDirectory, "reconcile-checkpoint");
  return filePath;
}

function validateReconcileReceiptCheckpointBijection(runDirectory, checkpoints) {
  const receiptPaths = readReconcileReceiptPaths(runDirectory);
  const reconcileCheckpoints = checkpoints
    .filter((checkpoint) => checkpoint.name === "reconcile")
    .sort((left, right) => left.reconcileSequence - right.reconcileSequence);
  failIf(receiptPaths.length !== reconcileCheckpoints.length, "reconcile-receipt-checkpoint");
  for (let index = 0; index < reconcileCheckpoints.length; index += 1) {
    const checkpoint = reconcileCheckpoints[index];
    const expectedSequence = index + 1;
    failIf(checkpoint.reconcileSequence !== expectedSequence, "reconcile-checkpoint");
    const receipt = receiptPaths[index];
    failIf(receipt.sequence !== expectedSequence, "reconcile-sequence");
    failIf(!isSha(checkpoint.receiptSha256), "reconcile-checkpoint");
    failIf(sha256EvidenceFile(receipt.path, path.basename(receipt.path)) !== checkpoint.receiptSha256, "reconcile-receipt-hash");
  }
}

function checkpointFile(runDirectory, sequence, name) {
  failIf(!CHECKPOINT_ORDER_INDEX.has(name), "invalid-checkpoint");
  return path.join(runDirectory, `${String(sequence).padStart(6, "0")}-${name}.json`);
}

function readCheckpoints(runDirectory, expected = {}) {
  const checkpoints = [];
  for (const entry of readdirSync(runDirectory, { withFileTypes: true })) {
    const match = CHECKPOINT_FILE_RE.exec(entry.name);
    if (!match) continue;
    failIf(entry.isSymbolicLink(), "checkpoint-symlink");
    const value = readJson(path.join(runDirectory, entry.name), "checkpoint");
    const sequence = Number(match[1]);
    const name = match[2];
    failIf(value.sequence !== sequence || value.name !== name, "checkpoint-integrity");
    if (expected.runId !== undefined) failIf(value.runId !== expected.runId, "checkpoint-context");
    if (expected.phase !== undefined) failIf(value.phase !== expected.phase, "checkpoint-context");
    failIf(!CHECKPOINT_ORDER_INDEX.has(name), "checkpoint-name");
    checkpoints.push(value);
  }
  checkpoints.sort((a, b) => a.sequence - b.sequence);
  for (let index = 0; index < checkpoints.length; index += 1) {
    failIf(checkpoints[index].sequence !== index + 1, "checkpoint-sequence");
    if (index === 0) failIf(checkpoints[index].name !== "run-directory", "checkpoint-order");
  }
  const seen = new Set();
  for (const checkpoint of checkpoints) {
    if (seen.has(checkpoint.name)) {
      failIf(!["terraform-exit-known", "terraform-exit-ambiguous", "reconcile"].includes(checkpoint.name), "checkpoint-replacement");
    }
    seen.add(checkpoint.name);
  }
  if (expected.phase !== undefined && expected.skipReconcileBijection !== true) {
    validateCheckpointSequence(checkpoints, expected.phase);
    validateReconcileReceiptCheckpointBijection(runDirectory, checkpoints);
  }
  return checkpoints;
}

function checkpointNames(runDirectory, expected = {}) {
  return new Set(readCheckpoints(runDirectory, expected).map((checkpoint) => checkpoint.name));
}

function validateCheckpointSequence(checkpoints, phase) {
  const names = checkpoints.map((checkpoint) => checkpoint.name);
  const invalidatedIndex = names.indexOf("invalidated");
  if (invalidatedIndex >= 0) failIf(invalidatedIndex !== names.length - 1, "checkpoint-order");
  const core = invalidatedIndex >= 0 ? names.slice(0, invalidatedIndex) : names;
  if (core.length === 0) return;
  let index = 0;
  const consume = (expected, required = false) => {
    if (index === core.length) {
      failIf(required, "checkpoint-order");
      return false;
    }
    failIf(core[index] !== expected, "checkpoint-order");
    index += 1;
    return true;
  };
  consume("run-directory", true);
  if (core.length === 1) return;
  if (core[index] === "image-platform-verified") {
    index += 1;
    if (index === core.length) return;
  }
  consume("plan-started", true);
  if (index < core.length && core[index] === "terraform-exit-ambiguous") {
    index += 1;
  } else {
    if (!consume("temp-plan")) return;
    if (index === core.length) return;
    consume("published-plan", true);
    if (index === core.length) return;
    consume("terraform-exit-known", true);
    if (index === core.length) return;
    consume("manifest", true);
    if (index === core.length) return;
    if (phase === "terminal") {
      consume("show-json");
      consume("guard-receipt");
      consume("global-state-advancement");
    } else {
      consume("show-json");
      consume("guard-receipt");
      if (phase === "credential-cleanup") {
        consume("vault-descriptor");
        consume("cleanup-start");
        failIf(index < core.length && core[index] === "preflight-receipt" &&
          (names.indexOf("vault-descriptor") < 0 || names.indexOf("cleanup-start") < 0), "checkpoint-order");
      }
      consume("preflight-receipt");
      consume("applying");
      if (index < core.length && core[index] === "receipts-consumed") {
        index += 1;
      }
      if (index < core.length && ["terraform-exit-known", "terraform-exit-ambiguous"].includes(core[index])) {
        index += 1;
        if (!consume("apply-receipt")) return;
        if (index < core.length && core[index] === "global-state-advancement") {
          index += 1;
        }
      }
      while (index < core.length && core[index] === "reconcile") index += 1;
      if (index < core.length && core[index] === "global-state-advancement") {
        index += 1;
      }
    }
  }
  failIf(index !== core.length, "checkpoint-order");
}

function checkpointFault(config, name, record) {
  const candidate = config.checkpointFault;
  if (candidate === name || (Array.isArray(candidate) && candidate.includes(name))) {
    reject(`checkpoint-fault-${name}`);
  }
  if (typeof candidate === "function") {
    const result = candidate(name, record);
    if (result === true || result === name) reject(`checkpoint-fault-${name}`);
  }
}

function writeCheckpoint(config, runDirectory, runId, phase, name, details = {}) {
  assertDirectory(runDirectory, "run-directory");
  const existing = readCheckpoints(runDirectory, {
    runId,
    phase,
    ...(name === "reconcile" ? { skipReconcileBijection: true } : {}),
  });
  failIf(
    existing.some((checkpoint) => checkpoint.name === name) &&
      !["terraform-exit-known", "terraform-exit-ambiguous", "reconcile"].includes(name),
    "checkpoint-replacement",
  );
  const sequence = existing.length + 1;
  const record = {
    version: 1,
    type: "lifecycle-checkpoint",
    sequence,
    name,
    runId,
    phase,
    createdAt: nowIso(config.now),
    ...details,
  };
  exclusiveJson(checkpointFile(runDirectory, sequence, name), record, "checkpoint");
  checkpointFault(config, name, record);
  return record;
}

function exactCreateArgv(planPath) {
  return [
    "plan",
    "-refresh=true",
    "-input=false",
    "-lock=true",
    "-lock-timeout=5m",
    `-out=${planPath}`,
  ];
}

function exactApplyArgv(planPath) {
  return ["apply", "-input=false", "-lock=true", "-lock-timeout=5m", planPath];
}

function exactShowArgv(planPath) {
  return ["show", "-json", planPath];
}

function assertPlanAge(manifest, phase, now) {
  const created = jsonDate(manifest.createdAt);
  failIf(!Number.isFinite(created), "manifest-time");
  if (now() - created > PLAN_MAX_AGE_MS[phase] || now() < created) {
    reject("plan-expired");
  }
}

function assertPreflightAge(receipt, now) {
  const created = jsonDate(receipt.createdAt);
  failIf(!Number.isFinite(created), "preflight-time");
  failIf(now() - created > PREFLIGHT_MAX_AGE_MS || now() < created, "preflight-expired");
}

function updateRun(state, runId, update) {
  const index = state.runs.findIndex((run) => run.id === runId);
  failIf(index < 0, "run-not-registered");
  state.runs[index] = { ...state.runs[index], ...update };
}

function processGroupLive(pgid) {
  let signalAlive = false;
  try {
    process.kill(-pgid, 0);
    signalAlive = true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return undefined;
  }
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
    } catch {
      continue;
    }
    const closingParen = stat.lastIndexOf(") ");
    if (closingParen < 0) return undefined;
    const fields = stat.slice(closingParen + 2).split(" ");
    if (fields[2] === String(pgid) && fields[0] !== "Z") return true;
  }
  return signalAlive ? false : false;
}

function waitForProcessGroupDead(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      const live = processGroupLive(pgid);
      if (live === false) {
        resolve(true);
        return;
      }
      if (live === undefined || Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function signalProcessGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessGroup(pgid) {
  signalProcessGroup(pgid, "SIGTERM");
  if (await waitForProcessGroupDead(pgid, APPLY_TERM_GRACE_MS)) return true;
  signalProcessGroup(pgid, "SIGKILL");
  return waitForProcessGroupDead(pgid, APPLY_KILL_GRACE_MS);
}

function applyProcessGroup(argv, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(TERRAFORM_PATH, argv, {
        cwd,
        env,
        detached: true,
        stdio: childStdioWithKernelLock(["ignore", "pipe", "pipe"]),
      });
    } catch {
      resolve({ status: "ambiguous", exitCode: null, stdout: "", stderr: "" });
      return;
    }
    const pgid = child.pid;
    if (!Number.isInteger(pgid) || pgid <= 0) {
      resolve({ status: "ambiguous", exitCode: null, stdout: "", stderr: "" });
      return;
    }
    let outputBytes = 0;
    let outputOverflow = false;
    let terminating = false;
    let settled = false;
    let timer;
    const result = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const ambiguous = (timedOut = false) => ({
      status: "ambiguous",
      exitCode: null,
      stdout: "",
      stderr: "",
      ...(timedOut ? { timedOut: true } : {}),
    });
    const observeOutput = (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > COMMAND_OUTPUT_MAX_BYTES) {
        outputOverflow = true;
        void terminate(false);
      }
    };
    child.stdout.on("data", observeOutput);
    child.stderr.on("data", observeOutput);
    const finishAfterClose = async (exitCode) => {
      if (terminating) return;
      const dead = await waitForProcessGroupDead(pgid, APPLY_TERM_GRACE_MS);
      if (!dead || outputOverflow) {
        terminating = true;
        const killed = await terminateProcessGroup(pgid);
        result(killed ? ambiguous() : ambiguous());
        return;
      }
      result({
        status: exitCode === 0 ? "success" : "failure",
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        stdout: "",
        stderr: "",
      });
    };
    const terminate = async (timedOut) => {
      if (terminating || settled) return;
      terminating = true;
      const dead = await terminateProcessGroup(pgid);
      result(dead ? ambiguous(timedOut) : ambiguous(timedOut));
    };
    child.once("error", () => {
      void terminate(false);
    });
    child.once("close", (exitCode) => {
      void finishAfterClose(exitCode);
    });
    timer = setTimeout(() => {
      void terminate(true);
    }, timeoutMs);
  });
}

async function applyRunnerMain(argv) {
  failIf(inheritedKernelLockDescriptor() === undefined, "kernel-lock-inherited");
  failIf(
    !(argv.length === 5 &&
      argv[0] === "apply" &&
      argv[1] === "-input=false" &&
      argv[2] === "-lock=true" &&
      argv[3] === "-lock-timeout=5m" &&
      typeof argv[4] === "string" &&
      path.isAbsolute(argv[4])),
    "apply-runner-arguments",
  );
  return applyProcessGroup(argv, process.cwd(), { ...process.env }, APPLY_TIMEOUT_MS);
}

function runPath(config, runId) {
  assertRunId(runId);
  const directory = path.join(config.root, runId);
  failIf(path.dirname(directory) !== config.root, "invalid-run-path");
  return directory;
}

function parseRun(config, state, phase, runId) {
  assertPhase(phase);
  const runDirectory = runPath(config, runId);
  assertDirectory(runDirectory, "run-directory");
  const entry = state.runs.find((run) => run.id === runId);
  failIf(!entry, "run-not-registered");
  failIf(entry.phase !== phase, "cross-phase-run");
  return { runDirectory, entry, artifacts: artifactPaths(runDirectory) };
}

function runErrorInvalidates(code) {
  if (typeof code !== "string") return false;
  if (["plan-expired", "preflight-expired"].includes(code)) {
    return false;
  }
  return /(?:mismatch|hash|integrity|symlink|mode|owner|noncanonical|replacement|context|receipt|artifact|checkpoint|state-history|image-platform|diagnostic-plan-image|acr-login-server|reviewed-file|guard-rejected)/.test(code);
}

function assertAppliedPhaseProof(config, state, phase) {
  const completed = state.runs.find(
    (run) => run.phase === phase && run.status === "applied",
  );
  failIf(!completed || completed.lastCheckpoint !== "global-state-advancement", "phase-apply-proof");
  const directory = runPath(config, completed.id);
  const artifacts = artifactPaths(directory);
  const checkpoints = readCheckpoints(directory, {
    runId: completed.id,
    phase,
  });
  const manifest = immutableManifest(
    directory,
    artifacts,
    checkpoints,
    completed,
  );
  const apply = readReceiptAtCheckpoint(
    artifacts.apply,
    checkpointNamed(checkpoints, "apply-receipt"),
    manifest,
    "apply",
    ["applied"],
  );
  const advancement = checkpointNamed(checkpoints, "global-state-advancement");
  failIf(
    advancement.from !== STATE_FOR_PHASE[phase] ||
      advancement.to !== ADVANCED_STATE[phase] ||
      advancement.applyReceiptSha256 !== sha256File(artifacts.apply),
    "phase-apply-proof",
  );
  return apply;
}

function appliedPhasePredecessorEvidence(config, state, phase, codePrefix, inventory = []) {
  const candidates = state.runs.filter(
    (run) => run.phase === phase && run.status === "applied",
  );
  failIf(candidates.length !== 1, `${codePrefix}-run`);
  const entry = candidates[0];
  failIf(entry.lastCheckpoint !== "global-state-advancement", `${codePrefix}-run`);
  const runDirectory = runPath(config, entry.id);
  const artifacts = artifactPaths(runDirectory);
  const checkpoints = readCheckpoints(runDirectory, {
    runId: entry.id,
    phase,
  });
  const manifest = immutableManifest(runDirectory, artifacts, checkpoints, entry);
  const showCheckpoint = checkpointNamed(checkpoints, "show-json");
  assertCheckpointArtifact(artifacts.show, showCheckpoint, "showSha256", `${codePrefix}-show`);
  const consumed = checkpointNamed(checkpoints, "receipts-consumed");
  const consumedGuard = `${artifacts.guard}.consumed`;
  const consumedPreflight = `${artifacts.preflight}.consumed`;
  assertCheckpointArtifact(
    consumedGuard,
    consumed,
    "guardReceiptSha256",
    `${codePrefix}-guard`,
  );
  assertCheckpointArtifact(
    consumedPreflight,
    consumed,
    "preflightReceiptSha256",
    `${codePrefix}-preflight`,
  );
  const guard = assertReceiptSchema(
    readJson(consumedGuard, `${codePrefix}-guard`),
    manifest,
    "guard",
  );
  failIf(guard.showSha256 !== showCheckpoint.showSha256, `${codePrefix}-show`);
  assertReceiptSchema(
    readJson(consumedPreflight, `${codePrefix}-preflight`),
    manifest,
    "preflight",
  );
  const applyCheckpoint = checkpointNamed(checkpoints, "apply-receipt");
  readReceiptAtCheckpoint(
    artifacts.apply,
    applyCheckpoint,
    manifest,
    "apply",
    ["applied"],
  );
  const reconcileCheckpoints = checkpoints.filter((checkpoint) => checkpoint.name === "reconcile");
  for (const checkpoint of reconcileCheckpoints) {
    readReceiptAtCheckpoint(
      reconcilePathForCheckpoint(runDirectory, checkpoint),
      checkpoint,
      manifest,
      "reconcile",
      ["applied", "invalidated", "unknown"],
    );
  }
  if (reconcileCheckpoints.length > 0) {
    const last = reconcileCheckpoints.at(-1);
    const lastReceipt = readReceiptAtCheckpoint(
      reconcilePathForCheckpoint(runDirectory, last),
      last,
      manifest,
      "reconcile",
      ["applied"],
    );
    void lastReceipt;
  }
  const advancement = checkpointNamed(checkpoints, "global-state-advancement");
  failIf(
    advancement.from !== STATE_FOR_PHASE[phase] ||
      advancement.to !== ADVANCED_STATE[phase] ||
      !isSha(advancement.applyReceiptSha256) ||
      advancement.applyReceiptSha256 !== sha256File(artifacts.apply, JSON_MAX_BYTES),
    `${codePrefix}-global-state`,
  );
  validatedRunEvidence(config, inventory, entry, artifacts, checkpoints);
  return { entry, runDirectory, artifacts, checkpoints, manifest };
}

function runtimeCutoverPredecessorEvidence(config, state) {
  const runtime = appliedPhasePredecessorEvidence(
    config,
    state,
    "runtime-cutover",
    "credential-runtime-predecessor",
  );
  requiredDiagnostic(runtime);
  const reviewed = reviewedRuntimeShapes(runtime.artifacts, "runtime-cutover");
  failIf(
    reviewed.before.containers.length !== 2 ||
      reviewed.before.containers.filter((container) => container.name === "relay").length !== 1,
    "credential-runtime-predecessor-topology",
  );
  const predecessorRevision = runtime.manifest.bindings.liveRevision;
  failIf(
    typeof predecessorRevision !== "string" || predecessorRevision.length === 0,
    "credential-runtime-predecessor-revision",
  );
  return {
    ...runtime,
    reviewed,
    revisionName: predecessorRevision,
  };
}

function assertStateForCreate(state, phase, config = undefined) {
  failIf(state.state !== STATE_FOR_PHASE[phase], "out-of-order-phase");
  if (phase === "credential-cleanup" && config !== undefined) {
    assertAppliedPhaseProof(config, state, "runtime-cutover");
  }
  failIf(
    state.runs.some((run) => run.phase === phase && activeStatus(run.status)),
    "phase-already-active",
  );
}

function assertRunStatus(entry, allowed) {
  failIf(!allowed.includes(entry.status), "out-of-order-operation");
}

function manifestFor(phase, runId, createdAt, planHash, bindings, argv, exitCode = 0) {
  return {
    version: 1,
    runId,
    phase,
    createdAt,
    processExit: exitCode,
    planSha256: planHash,
    argv,
    bindings,
    bindingSha256: bindingHash(bindings),
  };
}

function receiptFor(type, manifest, extra = {}) {
  return {
    version: 1,
    type,
    runId: manifest.runId,
    phase: manifest.phase,
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    createdAt: manifest.createdAt,
    ...extra,
  };
}

function assertReceiptMatches(receipt, manifest, type) {
  failIf(
    !isObject(receipt) ||
      receipt.type !== type ||
      receipt.runId !== manifest.runId ||
      receipt.phase !== manifest.phase ||
      receipt.planSha256 !== manifest.planSha256 ||
      receipt.bindingSha256 !== manifest.bindingSha256,
    `${type}-mismatch`,
  );
}

function assertApplyReceipt(receipt, manifest) {
  assertReceiptSchema(receipt, manifest, "apply", ["applied", "unknown"]);
  ensureReceiptSize(receipt);
  return receipt;
}

function assertReceiptFileSize(filePath, code = "receipt") {
  const stat = assertRegular(filePath, ARTIFACT_MODE, code);
  failIf(stat.size > RECEIPT_MAX_BYTES, `${code}-too-large`);
}

function ensureReceiptSize(receipt) {
  failIf(Buffer.byteLength(canonicalJson(receipt)) > RECEIPT_MAX_BYTES, "receipt-too-large");
}

function kernelPathFor(config) {
  return config.kernelLockPath ?? path.join(path.dirname(config.root), `${path.basename(config.root)}.kernel.lock`);
}

function ensureKernelParentDirectory(filePath, code) {
  const parent = path.dirname(filePath);
  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch (error) {
    if (error?.code !== "ENOENT") reject(`${code}-parent`);
    try {
      mkdirSync(parent, { recursive: true, mode: DIRECTORY_MODE });
      parentStat = lstatSync(parent);
    } catch {
      reject(`${code}-parent-create`);
    }
  }
  failIf(parentStat.isSymbolicLink() || !parentStat.isDirectory(), `${code}-parent`);
  try {
    failIf(realpathSync(parent) !== path.resolve(parent), `${code}-parent-noncanonical`);
  } catch {
    reject(`${code}-parent-realpath`);
  }
  failIf(UID !== undefined && parentStat.uid !== UID, `${code}-parent-owner`);
}

function inheritedKernelLockDescriptor(lockPath = undefined) {
  const expected = path.resolve(lockPath ?? kernelPathFor({ root: EVIDENCE_ROOT }));
  let entries;
  try {
    entries = readdirSync(`/proc/${process.pid}/fd`, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    let target;
    try {
      target = readlinkSync(`/proc/${process.pid}/fd/${entry.name}`);
    } catch {
      continue;
    }
    if (path.resolve(target) === expected) return Number(entry.name);
  }
  return undefined;
}

function childStdioWithKernelLock(stdio) {
  const fd = inheritedKernelLockDescriptor();
  if (fd === undefined) return stdio;
  const result = [...stdio];
  while (result.length <= fd) result.push("ignore");
  result[fd] = fd;
  return result;
}

function ensureKernelFile(filePath, code) {
  const parent = path.dirname(filePath);
  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch {
    reject(`${code}-parent`);
  }
  failIf(parentStat.isSymbolicLink() || !parentStat.isDirectory(), `${code}-parent`);
  try {
    failIf(realpathSync(parent) !== path.resolve(parent), `${code}-parent-noncanonical`);
  } catch {
    reject(`${code}-parent-realpath`);
  }
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") reject(`${code}-stat`);
  }
  if (stat === undefined) {
    let fd;
    try {
      fd = openSync(filePath, "wx", ARTIFACT_MODE);
      fchmodSync(fd, ARTIFACT_MODE);
      syncFileDescriptor(fd, filePath, code);
    } catch {
      if (fd !== undefined) closeSync(fd);
      reject(`${code}-create`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    fsyncDirectory(parent);
  }
  assertRegular(filePath, ARTIFACT_MODE, code);
}

const PRODUCTION_IN_PROCESS_LOCKS = new Set();

function memoryLockForTests(config, callback) {
  const execution = currentTestExecution();
  failIf(execution?.locks === undefined, "test-lock-context");
  const lockPath = kernelPathFor(config);
  if (execution.locks.has(lockPath)) reject("lock-contention");
  execution.locks.add(lockPath);
  try {
    return callback();
  } finally {
    execution.locks.delete(lockPath);
  }
}

function inProcessLock(config, callback) {
  const lockPath = kernelPathFor(config);
  ensureKernelFile(lockPath, "kernel-lock");
  const execution = currentTestExecution();
  const locks = execution?.locks ?? PRODUCTION_IN_PROCESS_LOCKS;
  if (locks.has(lockPath)) reject("lock-contention");
  locks.add(lockPath);
  try {
    return callback();
  } finally {
    locks.delete(lockPath);
  }
}

function withLock(config, callback, allowClosure = false) {
  if (allowClosure) ensureClosureRoot(config);
  else ensureRoot(config);
  if (config.lockMode === "inherited") {
    return TEST_EXECUTION.run(undefined, callback);
  }
  const execute = () => {
    if (typeof config.lockAdapter === "function") {
      return config.lockAdapter(config, callback);
    }
    return inProcessLock(config, callback);
  };
  if (config.testExecution === undefined) {
    return TEST_EXECUTION.run(undefined, execute);
  }
  return TEST_EXECUTION.run(config.testExecution, () => {
    const previousOperation = config.testExecution.operation;
    const operation = { snapshots: new Map(), directories: new Set() };
    config.testExecution.operation = operation;
    let failure;
    try {
      return execute();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        for (const directory of operation.directories) {
          if (existsSync(directory)) fsyncDirectory(directory);
        }
      } catch (error) {
        if (failure === undefined) throw error;
      }
      config.testExecution.operation = previousOperation;
    }
  });
}

function auxiliaryEvidenceName(name) {
  return name === JOURNAL_COMMITMENT_DIRECTORY_NAME ||
    REVOCATION_FIXED_FILES.includes(name) || REVOCATION_STATE_RE.test(name) ||
    REVOCATION_TEMP_RE.test(name) || REVOCATION_MANIFEST_RE.test(name);
}

function validateCleanupJournalEvidence(config) {
  const parent = path.join(config.root, JOURNAL_COMMITMENT_DIRECTORY_NAME);
  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    reject("cleanup-journal-directory");
  }
  failIf(parentStat.isSymbolicLink(), "cleanup-journal-directory-symlink");
  assertDirectory(parent, "cleanup-journal-directory");

  const entries = [];
  for (const runEntry of readdirSync(parent, { withFileTypes: true })) {
    failIf(
      runEntry.isSymbolicLink() || !runEntry.isDirectory() || !RUN_ID_RE.test(runEntry.name),
      "cleanup-journal-run-directory",
    );
    const runDirectory = path.join(parent, runEntry.name);
    assertDirectory(runDirectory, "cleanup-journal-run-directory");
    for (const fileEntry of readdirSync(runDirectory, { withFileTypes: true })) {
      failIf(
        fileEntry.isSymbolicLink() || !fileEntry.isFile() ||
          !CLEANUP_JOURNAL_ARTIFACT_RE.test(fileEntry.name),
        "cleanup-journal-file",
      );
      const filePath = path.join(runDirectory, fileEntry.name);
      assertRegular(filePath, ARTIFACT_MODE, "cleanup-journal-file");
      const label = path.relative(config.root, filePath);
      failIf(label === "" || label.startsWith("..") || path.isAbsolute(label), "cleanup-journal-path");
      entries.push({ label, sha256: sha256EvidenceFile(filePath, label) });
    }
  }
  return entries.sort((left, right) => left.label.localeCompare(right.label));
}

function validateRevocationFile(filePath, code) {
  const stat = assertRegular(filePath, ARTIFACT_MODE, code);
  failIf(stat.size > JSON_MAX_BYTES, `${code}-too-large`);
  return readJson(filePath, code);
}

function validRevocationString(value, maxLength = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function revocationIdentityDigest(identity) {
  return sha256Bytes(`${canonicalJson(identity)}\n`);
}

function validateRevocationFileBinding(value, allowNull, code) {
  if (value === null && allowNull) return;
  failIf(!isObject(value), code);
  assertKnownKeys(value, ["sha256", "size", "uid", "gid", "mode", "dev", "ino"], code);
  assertRequiredKeys(value, ["sha256", "size", "uid", "gid", "mode", "dev", "ino"], code);
  failIf(!isSha(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 0 ||
    !Number.isSafeInteger(value.uid) || value.uid < 0 || !Number.isSafeInteger(value.gid) || value.gid < 0 ||
    !Number.isSafeInteger(value.dev) || value.dev < 0 || !Number.isSafeInteger(value.ino) || value.ino < 0 ||
    value.mode !== 0o600, code);
}

function validateRevocationState(value, code) {
  failIf(!isObject(value) || value.schema !== 1 || value.kind !== "openrouter-revocation" ||
    !["preflight-captured", "awaiting-user", "revoked", "local-removed"].includes(value.state) ||
    !isSha(value.response_sha256) || !isSha(value.key_sha256) || typeof value.captured_at !== "string" ||
    !isObject(value.security_identity) || !isObject(value.masked) || !isObject(value.env) ||
    !same(Object.keys(value.security_identity).sort(), ["key_fingerprint", "provider_key_fingerprint", "key_id", "local_mask", "endpoint", "endpoint_id", "account_id", "account_name", "provider_stable_sha256"].sort()) ||
    !same(Object.keys(value.masked).sort(), ["expires_at", "label", "limit"]) ||
    !same(Object.keys(value.env).sort(), ["assignment_count", "dev", "gid", "ino", "mode", "path", "removed_sha256", "removed_size", "sha256", "size", "uid"].sort()),
    code,
  );
  failIf(!validRevocationString(value.captured_at, 64) || !Number.isFinite(Date.parse(value.captured_at)) || value.masked.label !== "****" ||
    (value.masked.expires_at !== null && (!validRevocationString(value.masked.expires_at, 128) || !Number.isFinite(Date.parse(value.masked.expires_at)))) ||
    (value.masked.limit !== null && (typeof value.masked.limit !== "number" || value.masked.limit < 0)) ||
    value.security_identity.key_fingerprint !== value.key_sha256 || value.security_identity.local_mask !== "****" ||
    value.security_identity.endpoint !== "https://openrouter.ai/api/v1/key" ||
    !isSha(value.security_identity.provider_stable_sha256) ||
    (value.security_identity.provider_key_fingerprint !== null && !isSha(value.security_identity.provider_key_fingerprint)) ||
    ["key_id", "endpoint_id", "account_id", "account_name"].some((key) =>
      value.security_identity[key] !== null && !validRevocationString(value.security_identity[key], 4096)) ||
    value.response_sha256 !== revocationIdentityDigest(value.security_identity) ||
    value.env.assignment_count !== 1 || !path.isAbsolute(value.env.path) || !validRevocationString(value.env.path, 4096) ||
    !isSha(value.env.sha256) || !isSha(value.env.removed_sha256) ||
    !Number.isSafeInteger(value.env.size) || value.env.size < 0 || !Number.isSafeInteger(value.env.removed_size) || value.env.removed_size < 0 ||
    !Number.isSafeInteger(value.env.uid) || value.env.uid < 0 || !Number.isSafeInteger(value.env.gid) || value.env.gid < 0 ||
    !Number.isSafeInteger(value.env.dev) || value.env.dev < 0 || !Number.isSafeInteger(value.env.ino) || value.env.ino < 0 ||
    !Number.isSafeInteger(value.env.mode) || value.env.mode < 0 || (value.env.mode & ~0o600) !== 0, code);
  const expected = ["schema", "kind", "state", "response_sha256", "key_sha256", "security_identity", "masked", "captured_at", "env", "raw"];
  if (value.state === "revoked") expected.push("revoked_at", "removal_intent");
  if (value.state === "local-removed") expected.push("revoked_at", "removal_intent", "local_removed_at");
  failIf(!same(Object.keys(value).sort(), expected.sort()), code);
  validateRevocationFileBinding(value.raw, true, code);
  if (value.raw !== null) failIf(value.raw.sha256 !== value.response_sha256, code);
  if (value.state === "revoked" || value.state === "local-removed") {
    failIf(!validRevocationString(value.revoked_at, 64) || !Number.isFinite(Date.parse(value.revoked_at)) || !isObject(value.removal_intent), code);
    assertKnownKeys(value.removal_intent, ["path", "original_sha256", "original_size", "uid", "gid", "mode", "dev", "ino", "removed_sha256", "removed_size", "assignment_count"], code);
    assertRequiredKeys(value.removal_intent, ["path", "original_sha256", "original_size", "uid", "gid", "mode", "dev", "ino", "removed_sha256", "removed_size", "assignment_count"], code);
    failIf(!path.isAbsolute(value.removal_intent.path) || !validRevocationString(value.removal_intent.path, 4096) ||
      !isSha(value.removal_intent.original_sha256) || !isSha(value.removal_intent.removed_sha256) ||
      !Number.isSafeInteger(value.removal_intent.original_size) || value.removal_intent.original_size < 0 ||
      !Number.isSafeInteger(value.removal_intent.removed_size) || value.removal_intent.removed_size < 0 ||
      !Number.isSafeInteger(value.removal_intent.uid) || value.removal_intent.uid < 0 ||
      !Number.isSafeInteger(value.removal_intent.gid) || value.removal_intent.gid < 0 ||
      !Number.isSafeInteger(value.removal_intent.dev) || value.removal_intent.dev < 0 ||
      !Number.isSafeInteger(value.removal_intent.ino) || value.removal_intent.ino < 0 ||
      !Number.isSafeInteger(value.removal_intent.mode) || value.removal_intent.mode < 0 ||
      (value.removal_intent.mode & ~0o600) !== 0 || value.removal_intent.assignment_count !== 1 ||
      value.removal_intent.path !== value.env.path || value.removal_intent.original_sha256 !== value.env.sha256 ||
      value.removal_intent.original_size !== value.env.size || value.removal_intent.removed_sha256 !== value.env.removed_sha256 ||
      value.removal_intent.removed_size !== value.env.removed_size || value.removal_intent.uid !== value.env.uid ||
      value.removal_intent.gid !== value.env.gid || value.removal_intent.mode !== value.env.mode ||
      value.removal_intent.dev !== value.env.dev || value.removal_intent.ino !== value.env.ino, code);
  }
  if (value.state === "local-removed") {
    failIf(!validRevocationString(value.local_removed_at, 64) || !Number.isFinite(Date.parse(value.local_removed_at)), code);
  }
  return value;
}

function validateRevocationEvidence(config, { requireComplete = false } = {}) {
  const entries = [];
  const names = readdirSync(config.root, { withFileTypes: true });
  for (const entry of names) {
    if (!entry.name.startsWith("openrouter-revocation")) continue;
    failIf(
      !REVOCATION_FIXED_FILES.includes(entry.name) &&
        !REVOCATION_STATE_RE.test(entry.name) &&
        !REVOCATION_TEMP_RE.test(entry.name) &&
        !REVOCATION_MANIFEST_RE.test(entry.name),
      "revocation-name",
    );
  }
  const stateEntries = names
    .filter((entry) => REVOCATION_STATE_RE.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const states = [];
  for (const entry of stateEntries) {
    const value = validateRevocationFile(path.join(config.root, entry.name), "revocation-state");
    validateRevocationState(value, "revocation-state");
    const sequence = entry.name === "openrouter-revocation-state.json"
      ? 0
      : Number(REVOCATION_STATE_RE.exec(entry.name)?.[1]);
    states.push({ sequence, value, name: entry.name });
  }
  for (let index = 0; index < states.length; index += 1) failIf(states[index].sequence !== index, "revocation-state-sequence");
  if (states.length > 0) {
    failIf(states[0].value.state !== "preflight-captured", "revocation-state-transition");
    for (let index = 1; index < states.length; index += 1) {
      const previous = states[index - 1].value;
      const current = states[index].value;
      for (const field of ["response_sha256", "key_sha256", "security_identity", "captured_at", "env", "masked"]) {
        failIf(!same(previous[field], current[field]), "revocation-state-context");
      }
      if (previous.raw !== null && current.raw !== null) failIf(!same(previous.raw, current.raw), "revocation-state-context");
      failIf(previous.raw !== null && current.raw === null, "revocation-state-context");
      const allowed = (previous.state === "preflight-captured" &&
        ["preflight-captured", "awaiting-user"].includes(current.state)) ||
        (previous.state === "awaiting-user" && current.state === "revoked") ||
        (previous.state === "revoked" && current.state === "local-removed");
      failIf(!allowed || (["awaiting-user", "revoked", "local-removed"].includes(current.state) && current.raw === null), "revocation-state-transition");
    }
  }
  const receiptPath = path.join(config.root, "openrouter-revocation-receipt.json");
  if (existsSync(receiptPath)) {
    const receipt = validateRevocationFile(receiptPath, "revocation-receipt");
    assertKnownKeys(receipt, ["schema", "kind", "state", "http_status", "response_sha256", "recorded_at"], "revocation-receipt");
    failIf(receipt.schema !== 1 || receipt.kind !== "openrouter-revocation" || receipt.state !== "revoked" ||
      receipt.http_status !== 401 || !isSha(receipt.response_sha256) || !Number.isFinite(Date.parse(receipt.recorded_at)), "revocation-receipt");
    failIf(states.length === 0 || !["revoked", "local-removed"].includes(states.at(-1).value.state) ||
      receipt.response_sha256 !== states.at(-1).value.response_sha256, "revocation-receipt");
  }
  for (const fixed of REVOCATION_FIXED_FILES) {
    const filePath = path.join(config.root, fixed);
    if (existsSync(filePath) && fixed !== "openrouter-revocation-receipt.json" && !REVOCATION_STATE_RE.test(fixed)) {
      const stat = assertRegular(filePath, ARTIFACT_MODE, "revocation-auxiliary");
      if (fixed === "openrouter-revocation.lock") {
        failIf(stat.size > 128, "revocation-lock");
        const text = readFileSync(filePath, "utf8");
        const normalized = text.trim();
        failIf(normalized !== "" &&
          !/^\d+ [a-f0-9]{24}$/u.test(normalized) &&
          !/^\d+(?: [a-f0-9]{0,23})?$/u.test(normalized), "revocation-lock");
      }
    }
  }
  const rawPath = path.join(config.root, "openrouter-revocation-raw-response.json");
  if (existsSync(rawPath) && states.at(-1)?.value.raw !== null && states.at(-1)?.value.raw !== undefined) {
    const raw = states.at(-1).value.raw;
    const rawStat = assertRegular(rawPath, ARTIFACT_MODE, "revocation-raw");
    failIf(rawStat.size !== raw.size || sha256EvidenceFile(rawPath, "openrouter-revocation-raw-response.json") !== raw.sha256, "revocation-raw");
  } else if (existsSync(rawPath)) {
    reject("revocation-raw-binding");
  }
  if (requireComplete) failIf(existsSync(rawPath), "revocation-raw-present");
  const ownedTemporaryNames = new Set();
  for (const entry of names) {
    if (REVOCATION_MANIFEST_RE.test(entry.name)) {
      const manifestPath = path.join(config.root, entry.name);
      const manifestStat = assertRegular(manifestPath, ARTIFACT_MODE, "revocation-temp-manifest");
      failIf(manifestStat.size > JSON_MAX_BYTES, "revocation-temp-manifest-too-large");
      const manifestMatch = REVOCATION_MANIFEST_RE.exec(entry.name);
      const manifestText = readFileSync(manifestPath, "utf8");
      // The producer creates the exact owned-manifest name before writing its
      // JSON. A crash at that boundary leaves an empty, but still legitimate,
      // ownership marker; register it without ever treating an unowned temp
      // name as evidence.
      if (manifestText.length === 0) {
        failIf(Number(manifestMatch?.[1]) <= 0, "revocation-temp-manifest");
        ownedTemporaryNames.add(`__empty-owned-manifest-${entry.name}`);
        continue;
      }
      let value;
      try {
        value = JSON.parse(manifestText);
      } catch {
        reject("revocation-temp-manifest");
      }
      assertKnownKeys(value, ["schema", "kind", "operation_kind", "target", "temporary", "sha256", "size", "pid"], "revocation-temp-manifest");
      failIf(value.schema !== 1 || value.kind !== "openrouter-revocation-temp-manifest" ||
        !["state", "raw", "receipt", "lock"].includes(value.operation_kind) || !isSha(value.sha256) ||
        !Number.isSafeInteger(value.size) || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
        !REVOCATION_TEMP_RE.test(value.temporary) || Number(manifestMatch?.[1]) !== value.pid ||
        manifestMatch?.[2] !== REVOCATION_TEMP_RE.exec(value.temporary)?.[3], "revocation-temp-manifest");
      const expectedTarget = value.operation_kind === "state"
        ? (REVOCATION_STATE_RE.test(value.target) ? value.target : undefined)
        : value.operation_kind === "raw" ? "openrouter-revocation-raw-response.json"
          : value.operation_kind === "receipt" ? "openrouter-revocation-receipt.json"
            : "openrouter-revocation.lock";
      failIf(expectedTarget === undefined || value.target !== expectedTarget || !value.temporary.startsWith(`${value.target}.tmp-`), "revocation-temp-manifest");
      ownedTemporaryNames.add(value.temporary);
      const temporaryPath = path.join(config.root, value.temporary);
      if (existsSync(temporaryPath)) {
        const temporaryStat = assertRegular(temporaryPath, ARTIFACT_MODE, "revocation-temporary");
        const temporaryLimit = value.operation_kind === "raw" ? REVOCATION_RAW_MAX_BYTES
          : value.operation_kind === "lock" ? REVOCATION_LOCK_MAX_BYTES : JSON_MAX_BYTES;
        failIf(value.size > temporaryLimit || temporaryStat.size !== value.size ||
          sha256EvidenceFile(temporaryPath, value.temporary) !== value.sha256, "revocation-temporary");
      }
    } else if (REVOCATION_TEMP_RE.test(entry.name)) {
      assertRegular(path.join(config.root, entry.name), ARTIFACT_MODE, "revocation-temporary");
      const temporaryMatch = REVOCATION_TEMP_RE.exec(entry.name);
      const ownedTarget = temporaryMatch?.[1];
      const temporaryPath = path.join(config.root, entry.name);
      const temporaryLimit = ownedTarget === "openrouter-revocation-raw-response.json" ? REVOCATION_RAW_MAX_BYTES
        : ownedTarget === "openrouter-revocation.lock" ? REVOCATION_LOCK_MAX_BYTES : JSON_MAX_BYTES;
      const temporaryStat = lstatSync(temporaryPath);
      failIf(temporaryStat.size > temporaryLimit, "revocation-temporary-too-large");
    }
  }
  for (const entry of names) {
    if (REVOCATION_TEMP_RE.test(entry.name)) failIf(!ownedTemporaryNames.has(entry.name), "revocation-temporary-manifest");
  }
  if (requireComplete) failIf(states.at(-1)?.value.state !== "local-removed" || !existsSync(receiptPath), "revocation-incomplete");
  for (const entry of names) {
    if (entry.name === JOURNAL_COMMITMENT_DIRECTORY_NAME) continue;
    if (auxiliaryEvidenceName(entry.name)) entries.push({
      label: entry.name,
      sha256: sha256EvidenceFile(path.join(config.root, entry.name), entry.name),
    });
  }
  entries.push(...validateCleanupJournalEvidence(config));
  return entries.sort((a, b) => a.label.localeCompare(b.label));
}

function ensureClosureRoot(config) {
  failIf(path.resolve(config.closure) === path.resolve(config.root), "closure-path");
  failIf(path.dirname(path.resolve(config.closure)) !== path.dirname(path.resolve(config.root)), "closure-path");
  let parent;
  try {
    parent = lstatSync(path.dirname(config.root));
  } catch {
    reject("closure-parent");
  }
  failIf(parent.isSymbolicLink() || !parent.isDirectory(), "closure-parent");
  try {
    failIf(realpathSync(path.dirname(config.root)) !== path.resolve(path.dirname(config.root)), "closure-parent-noncanonical");
  } catch {
    reject("closure-parent-realpath");
  }
  if (existsSync(config.root)) assertCanonicalDirectory(config.root, "evidence-root");
  else failIf(!existsSync(config.closure), "evidence-root");
  if (existsSync(config.closure)) assertCanonicalDirectory(config.closure, "closure");
}

function closureFilePath(config, filename) {
  const filePath = path.join(config.closure, filename);
  failIf(path.dirname(filePath) !== config.closure, "closure-path");
  return filePath;
}

function closureStatePath(config, sequence) {
  failIf(!Number.isSafeInteger(sequence) || sequence < 0, "closure-sequence");
  return closureFilePath(config, `closure-state-${String(sequence).padStart(6, "0")}.json`);
}

function closureInventoryEntries(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      failIf(entry.isSymbolicLink(), "closure-symlink");
      if (entry.isDirectory()) {
        visit(filePath);
      } else {
        failIf(!entry.isFile(), "closure-entry");
        const relative = path.relative(root, filePath);
        failIf(relative === "" || relative.startsWith("..") || path.isAbsolute(relative), "closure-entry");
        entries.push({ label: relative, sha256: sha256EvidenceFile(filePath, relative) });
      }
    }
  };
  visit(root);
  entries.sort((left, right) => left.label.localeCompare(right.label));
  return entries;
}

function validateClosureBundle(config) {
  ensureClosureRoot(config);
  assertDirectory(config.closure, "closure");
  const tombstonePath = closureFilePath(config, CLOSURE_TOMBSTONE_FILENAME);
  const inventoryPath = closureFilePath(config, CLOSURE_INVENTORY_FILENAME);
  const tombstone = readJson(tombstonePath, "closure-tombstone");
  const inventory = readJson(inventoryPath, "closure-inventory");
  assertKnownKeys(tombstone, ["version", "type", "root", "inventorySha256", "status", "createdAt"], "closure-tombstone");
  assertRequiredKeys(tombstone, ["version", "type", "root", "inventorySha256", "status", "createdAt"], "closure-tombstone");
  failIf(tombstone.version !== 1 || tombstone.type !== "lifecycle-closure-tombstone" ||
    tombstone.root !== config.root || tombstone.status !== "prepared" || !isSha(tombstone.inventorySha256), "closure-tombstone");
  failIf(!Number.isFinite(jsonDate(tombstone.createdAt)), "closure-tombstone");
  assertKnownKeys(inventory, ["version", "type", "root", "runCount", "entries", "entriesSha256"], "closure-inventory");
  assertRequiredKeys(inventory, ["version", "type", "root", "runCount", "entries", "entriesSha256"], "closure-inventory");
  failIf(inventory.version !== 1 || inventory.type !== "lifecycle-closure-inventory" || inventory.root !== config.root ||
    !Number.isSafeInteger(inventory.runCount) || inventory.runCount < 1 || !Array.isArray(inventory.entries) ||
    !isSha(inventory.entriesSha256) || inventory.entriesSha256 !== hashJson(inventory.entries) ||
    tombstone.inventorySha256 !== sha256File(inventoryPath, JSON_MAX_BYTES), "closure-inventory");
  let previous;
  for (const entry of inventory.entries) {
    assertKnownKeys(entry, ["label", "sha256"], "closure-inventory-entry");
    assertRequiredKeys(entry, ["label", "sha256"], "closure-inventory-entry");
    failIf(typeof entry.label !== "string" || entry.label === "" || entry.label.startsWith("..") || path.isAbsolute(entry.label) ||
      !isSha(entry.sha256) || (previous !== undefined && previous >= entry.label), "closure-inventory-entry");
    previous = entry.label;
  }
  const states = readdirSync(config.closure, { withFileTypes: true })
    .filter((entry) => CLOSURE_STATE_RE.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of readdirSync(config.closure, { withFileTypes: true })) {
    failIf(entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()), "closure-entry");
    failIf(entry.name !== CLOSURE_TOMBSTONE_FILENAME && entry.name !== CLOSURE_INVENTORY_FILENAME && !CLOSURE_STATE_RE.test(entry.name), "closure-entry");
  }
  failIf(states.length === 0, "closure-state");
  const values = states.map((entry, index) => {
    failIf(entry.isSymbolicLink(), "closure-state-symlink");
    const sequence = Number(CLOSURE_STATE_RE.exec(entry.name)[1]);
    failIf(sequence !== index, "closure-state-sequence");
    const value = readJson(path.join(config.closure, entry.name), "closure-state");
    assertKnownKeys(value, ["version", "type", "sequence", "status", "createdAt", "tombstoneSha256", "inventorySha256"], "closure-state");
    assertRequiredKeys(value, ["version", "type", "sequence", "status", "createdAt", "tombstoneSha256", "inventorySha256"], "closure-state");
    failIf(value.version !== 1 || value.type !== "lifecycle-closure-state" || value.sequence !== sequence ||
      !["prepared", "deleted"].includes(value.status) || !isSha(value.tombstoneSha256) ||
      !isSha(value.inventorySha256) || value.tombstoneSha256 !== sha256File(tombstonePath, JSON_MAX_BYTES) ||
      value.inventorySha256 !== sha256File(inventoryPath, JSON_MAX_BYTES), "closure-state");
    failIf(!Number.isFinite(jsonDate(value.createdAt)), "closure-state");
    return value;
  });
  failIf(values[0].status !== "prepared" || values.slice(1).some((value) => value.status !== "deleted") || values.filter((value) => value.status === "deleted").length > 1, "closure-state");
  if (values.at(-1).status === "deleted") failIf(existsSync(config.root), "closure-deleted-root");
  return { tombstone, inventory, states: values, tombstonePath, inventoryPath };
}

function writeClosurePrepared(config, state, terminalRun) {
  ensureClosureRoot(config);
  try {
    mkdirSync(config.closure, { mode: DIRECTORY_MODE });
    chmodSync(config.closure, DIRECTORY_MODE);
  } catch {
    reject("closure-create");
  }
  assertDirectory(config.closure, "closure");
  terminalPredecessorEvidence(config, state, terminalRun);
  const entries = closureInventoryEntries(config.root);
  const inventory = {
    version: 1,
    type: "lifecycle-closure-inventory",
    root: config.root,
    runCount: state.runs.length,
    entries,
    entriesSha256: hashJson(entries),
  };
  exclusiveJson(closureFilePath(config, CLOSURE_INVENTORY_FILENAME), inventory, "closure-inventory");
  const inventorySha256 = sha256File(closureFilePath(config, CLOSURE_INVENTORY_FILENAME), JSON_MAX_BYTES);
  const tombstone = {
    version: 1,
    type: "lifecycle-closure-tombstone",
    root: config.root,
    inventorySha256,
    status: "prepared",
    createdAt: nowIso(config.now),
  };
  exclusiveJson(closureFilePath(config, CLOSURE_TOMBSTONE_FILENAME), tombstone, "closure-tombstone");
  const tombstoneSha256 = sha256File(closureFilePath(config, CLOSURE_TOMBSTONE_FILENAME), JSON_MAX_BYTES);
  exclusiveJson(closureStatePath(config, 0), {
    version: 1,
    type: "lifecycle-closure-state",
    sequence: 0,
    status: "prepared",
    createdAt: nowIso(config.now),
    tombstoneSha256,
    inventorySha256,
  }, "closure-state");
  fsyncDirectory(config.closure);
  return validateClosureBundle(config);
}

function validateDeletionAgainstInventory(config, inventory) {
  if (!existsSync(config.root)) return;
  assertCanonicalDirectory(config.root, "evidence-root");
  const actual = closureInventoryEntries(config.root);
  const expected = new Map(inventory.entries.map((entry) => [entry.label, entry.sha256]));
  for (const entry of actual) failIf(expected.get(entry.label) !== entry.sha256, "closure-inventory-mismatch");
}

function closeEvidenceRoot(config, state) {
  let bundle;
  if (existsSync(config.closure)) {
    bundle = validateClosureBundle(config);
  } else {
    const terminal = state?.runs.find((run) => run.phase === "terminal" && run.status === "finalized");
    failIf(!terminal || state.state !== "terminal-verified", "closure-not-ready");
    bundle = writeClosurePrepared(config, state, {
      runId: terminal.id,
      runDirectory: runPath(config, terminal.id),
      artifacts: artifactPaths(runPath(config, terminal.id)),
      manifest: immutableManifest(
        runPath(config, terminal.id),
        artifactPaths(runPath(config, terminal.id)),
        readCheckpoints(runPath(config, terminal.id), { runId: terminal.id, phase: "terminal" }),
        terminal,
      ),
    });
  }
  if (bundle.states.at(-1).status === "deleted") return { status: "deleted" };
  validateDeletionAgainstInventory(config, bundle.inventory);
  if (existsSync(config.root)) {
    rmSync(config.root, { recursive: true, force: true });
    fsyncDirectory(path.dirname(config.root));
  }
  failIf(existsSync(config.root), "closure-root-present");
  exclusiveJson(closureStatePath(config, 1), {
    version: 1,
    type: "lifecycle-closure-state",
    sequence: 1,
    status: "deleted",
    createdAt: nowIso(config.now),
    tombstoneSha256: sha256File(bundle.tombstonePath, JSON_MAX_BYTES),
    inventorySha256: sha256File(bundle.inventoryPath, JSON_MAX_BYTES),
  }, "closure-state");
  fsyncDirectory(config.closure);
  return { status: "deleted" };
}

function ensureRoot(config) {
  try {
    lstatSync(config.closure);
    reject("closure-present");
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    if (error?.code !== "ENOENT") reject("closure-present");
  }
  let rootStat;
  try {
    rootStat = lstatSync(config.root);
  } catch (error) {
    if (error?.code !== "ENOENT") reject("evidence-root-stat");
  }
  if (rootStat === undefined) {
    const parent = path.dirname(config.root);
    try {
      mkdirSync(parent, { recursive: true, mode: DIRECTORY_MODE });
    } catch {
      reject("evidence-parent-create");
    }
    let parentStat;
    try {
      parentStat = lstatSync(parent);
    } catch {
      reject("evidence-parent");
    }
    failIf(parentStat.isSymbolicLink() || !parentStat.isDirectory(), "evidence-parent");
    try {
      failIf(realpathSync(parent) !== path.resolve(parent), "evidence-parent-noncanonical");
    } catch {
      reject("evidence-parent-realpath");
    }
    failIf(UID !== undefined && parentStat.uid !== UID, "evidence-parent-owner");
    try {
      mkdirSync(config.root, { mode: DIRECTORY_MODE });
      chmodSync(config.root, DIRECTORY_MODE);
    } catch {
      reject("evidence-root-create");
    }
  }
  assertCanonicalDirectory(config.root, "evidence-root");
}

function loadState(config) {
  const statePath = path.join(config.root, "state.json");
  const snapshots = [];
  for (const entry of readdirSync(config.root, { withFileTypes: true })) {
    const match = STATE_FILE_RE.exec(entry.name);
    if (!match) continue;
    failIf(entry.isSymbolicLink(), "state-snapshot-symlink");
    const snapshotPath = path.join(config.root, entry.name);
    assertRegular(snapshotPath, ARTIFACT_MODE, "state-snapshot");
    const snapshot = readJson(snapshotPath, "state-snapshot");
    validateState(snapshot);
    failIf(snapshot.stateSerial !== Number(match[1]), "state-snapshot-serial");
    snapshots.push({ snapshot, path: snapshotPath });
  }
  snapshots.sort((a, b) => a.snapshot.stateSerial - b.snapshot.stateSerial);
  for (let index = 0; index < snapshots.length; index += 1) {
    const current = snapshots[index];
    failIf(current.snapshot.stateSerial !== index, "state-history");
    const previous = snapshots[index - 1];
    assertStateSnapshotIntegrity(current.snapshot, current.path, previous?.path);
  }
  let current;
  try {
    assertRegular(statePath, ARTIFACT_MODE, "state");
    current = readJson(statePath, "state");
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "state-missing") current = null;
    else throw error;
  }
  const latest = snapshots.at(-1);
  if (current === null && latest === undefined) {
    validateRevocationEvidence(config);
    for (const entry of readdirSync(config.root, { withFileTypes: true })) {
      if (auxiliaryEvidenceName(entry.name) || entry.name === "state.json" || STATE_FILE_RE.test(entry.name)) continue;
      failIf(true, "unregistered-run");
    }
    return null;
  }
  failIf(latest === undefined || current === null, "state-history");
  assertStateSnapshotIntegrity(
    current,
    statePath,
    current.stateSerial === 0 ? undefined : snapshots[current.stateSerial - 1].path,
  );
  failIf(current.stateSerial > latest.snapshot.stateSerial, "state-history");
  const currentSnapshot = snapshots[current.stateSerial];
  failIf(
    currentSnapshot === undefined ||
      sha256File(statePath, JSON_MAX_BYTES) !== sha256File(currentSnapshot.path, JSON_MAX_BYTES) ||
      !same(current, currentSnapshot.snapshot),
    "state-history",
  );
  if (current.stateSerial < latest.snapshot.stateSerial) {
    replaceJson(statePath, latest.snapshot, "state");
    current = latest.snapshot;
  }
  failIf(sha256File(statePath, JSON_MAX_BYTES) !== sha256File(latest.path, JSON_MAX_BYTES), "state-history");
  failIf(!same(current, latest.snapshot), "state-history");
  const state = current;
  recoverUnregisteredRunDirectories(config, state);
  recoverStateFromCheckpoints(config, state);
  assertClosedGlobalState(state);
  const registered = new Set(state.runs.map((run) => run.id));
  validateRevocationEvidence(config);
  for (const entry of readdirSync(config.root, { withFileTypes: true })) {
    if (entry.name === "state.json" || STATE_FILE_RE.test(entry.name)) continue;
    if (auxiliaryEvidenceName(entry.name)) continue;
    failIf(entry.isSymbolicLink(), "unregistered-symlink");
    failIf(!entry.isDirectory() || !registered.has(entry.name), "unregistered-run");
  }
  for (const id of registered) assertDirectory(runPath(config, id), "registered-run");
  return state;
}

function recoverUnregisteredRunDirectories(config, state) {
  const registered = new Set(state.runs.map((run) => run.id));
  for (const entry of readdirSync(config.root, { withFileTypes: true })) {
    if (entry.name === "state.json" || STATE_FILE_RE.test(entry.name) || registered.has(entry.name)) continue;
    if (auxiliaryEvidenceName(entry.name)) continue;
    failIf(entry.isSymbolicLink() || !entry.isDirectory() || !RUN_ID_RE.test(entry.name), "unregistered-run");
    const directory = path.join(config.root, entry.name);
    assertDirectory(directory, "unregistered-run");
    failIf(readdirSync(directory).length !== 0, "unregistered-run");
    try {
      rmdirSync(directory);
      fsyncDirectory(config.root);
    } catch {
      reject("unregistered-run-recovery");
    }
  }
}

function recoverStateFromCheckpoints(config, state) {
  let changed = false;
  for (const run of state.runs) {
    const directory = runPath(config, run.id);
    let checkpoints = readCheckpoints(directory, { runId: run.id, phase: run.phase });
    let names = new Set(checkpoints.map((checkpoint) => checkpoint.name));
    const artifacts = artifactPaths(directory);
    if (run.status === "created" && checkpoints.length === 0) {
      writeCheckpoint(config, directory, run.id, run.phase, "run-directory", { recovered: true });
      checkpoints = readCheckpoints(directory, { runId: run.id, phase: run.phase });
      names = new Set(checkpoints.map((checkpoint) => checkpoint.name));
    }
    if (!["invalidated", "superseded"].includes(run.status) && names.has("image-platform-verified")) {
      try {
        const imageCheckpoint = checkpointNamed(checkpoints, "image-platform-verified");
        failIf(
          imageCheckpoint.verifierPath !== IMAGE_VERIFIER_ARTIFACT_NAME ||
            !isSha(imageCheckpoint.verifierSha256),
          "image-platform-checkpoint",
        );
        assertImmutableVerifierArtifact(artifacts.verifier, imageCheckpoint.verifierSha256, "image-platform-checkpoint");
      } catch (error) {
        if (!(error instanceof LifecycleError) || !error.code.startsWith("image-platform-checkpoint")) throw error;
        if (!names.has("invalidated")) {
          writeCheckpoint(config, directory, run.id, run.phase, "invalidated", {
            reason: "image-platform-checkpoint",
            recovered: true,
          });
        }
        run.status = "invalidated";
        run.reason = "image-platform-checkpoint";
        run.invalidatedAt = nowIso(config.now);
        changed = true;
        continue;
      }
    }
    if (
      !["invalidated", "superseded"].includes(run.status) &&
      !names.has("manifest") &&
      !names.has("applying")
    ) {
      writeCheckpoint(config, directory, run.id, run.phase, "invalidated", {
        reason: "incomplete-create",
        recovered: true,
      });
      run.status = "invalidated";
      run.reason = "incomplete-create";
      run.invalidatedAt = nowIso(config.now);
      changed = true;
      continue;
    }
    const needsManifest = [
      "guarded", "preflighted", "applying", "unknown", "applied", "finalized",
    ].includes(run.status) || names.has("guard-receipt") || names.has("preflight-receipt") ||
      names.has("apply-receipt") || names.has("reconcile") || names.has("global-state-advancement");
    const manifest = needsManifest
      ? immutableManifest(directory, artifacts, checkpoints, run)
      : undefined;
    const closedRun = ["invalidated", "superseded"].includes(run.status);
    if (!closedRun && names.has("guard-receipt") && existsSync(artifacts.guard)) {
      const checkpoint = checkpointNamed(checkpoints, "guard-receipt");
      readReceiptAtCheckpoint(artifacts.guard, checkpoint, manifest, "guard");
      if (run.status === "created") {
        run.status = "guarded";
        run.guardedAt = run.guardedAt ?? nowIso(config.now);
        changed = true;
      }
    }
    if (!closedRun && names.has("guard-receipt") && !existsSync(artifacts.guard) && !names.has("receipts-consumed")) {
      reject("guard-receipt-missing");
    }
    if (!closedRun && run.phase === "credential-cleanup" && names.has("vault-descriptor")) {
      const descriptorCheckpoint = checkpointNamed(checkpoints, "vault-descriptor");
      assertCheckpointArtifact(artifacts.descriptor, descriptorCheckpoint, "descriptorSha256", "vault-descriptor");
      validateCleanupDescriptor(artifacts.descriptor, manifest);
    }
    if (!closedRun && run.phase === "credential-cleanup" && names.has("cleanup-start")) {
      const startCheckpoint = checkpointNamed(checkpoints, "cleanup-start");
      assertCheckpointArtifact(artifacts.cleanupOperation, startCheckpoint, "cleanupOperationManifestSha256", "cleanup-operation");
      requiredCleanup({
        manifest,
        artifacts,
        guardReceiptSha256: startCheckpoint.guardReceiptSha256,
        processRunner: config.processRunner,
      }, { requireAbsence: false });
    }
    if (!closedRun && names.has("preflight-receipt") && existsSync(artifacts.preflight)) {
      const checkpoint = checkpointNamed(checkpoints, "preflight-receipt");
      const preflight = readReceiptAtCheckpoint(artifacts.preflight, checkpoint, manifest, "preflight");
      validateRecoveryEvidenceArtifacts(run.phase, artifacts, checkpoint, manifest, config.processRunner);
      if (run.status === "guarded") {
        run.status = "preflighted";
        run.preflightAt = run.preflightAt ?? preflight.createdAt;
        changed = true;
      }
    }
    if (!closedRun && names.has("preflight-receipt") && !existsSync(artifacts.preflight) && !names.has("receipts-consumed")) {
      reject("preflight-receipt-missing");
    }
    if (!closedRun && names.has("preflight-receipt") && !existsSync(artifacts.preflight)) {
      validateRecoveryEvidenceArtifacts(
        run.phase,
        artifacts,
        checkpointNamed(checkpoints, "preflight-receipt"),
        manifest,
        config.processRunner,
      );
    }
    if (run.status === "preflighted" && names.has("applying")) {
      run.status = "applying";
      run.applyingAt = run.applyingAt ?? nowIso(config.now);
      changed = true;
    }
    if (!closedRun && run.status === "applying" && !names.has("apply-receipt")) {
      const applying = checkpointNamed(checkpoints, "applying");
      const applyExit = checkpoints.find((checkpoint) =>
        checkpoint.sequence > applying.sequence &&
          ["terraform-exit-known", "terraform-exit-ambiguous"].includes(checkpoint.name),
      );
      let apply;
      if (existsSync(artifacts.apply)) {
        assertReceiptFileSize(artifacts.apply, "apply-receipt");
        apply = assertApplyReceipt(readJson(artifacts.apply, "apply-receipt"), manifest);
      } else {
        if (applyExit === undefined) {
          writeCheckpoint(config, directory, run.id, run.phase, "terraform-exit-ambiguous", {
            status: "ambiguous",
            exitCode: null,
            recovered: true,
          });
        }
        apply = {
          ...receiptFor("apply", manifest, { status: "unknown" }),
          appliedAt: nowIso(config.now),
        };
        ensureReceiptSize(apply);
        exclusiveJson(artifacts.apply, apply, "apply-receipt");
      }
      writeCheckpoint(config, directory, run.id, run.phase, "apply-receipt", {
        receiptSha256: sha256File(artifacts.apply),
        status: apply.status,
        recovered: true,
      });
      checkpoints = readCheckpoints(directory, { runId: run.id, phase: run.phase });
      names = new Set(checkpoints.map((checkpoint) => checkpoint.name));
    }
    if (!closedRun && run.status !== "unknown" && names.has("receipts-consumed")) {
      const checkpoint = checkpointNamed(checkpoints, "receipts-consumed");
      const consumedGuard = `${artifacts.guard}.consumed`;
      const consumedPreflight = `${artifacts.preflight}.consumed`;
      assertCheckpointArtifact(consumedGuard, checkpoint, "guardReceiptSha256", "guard-receipt-consumed");
      assertCheckpointArtifact(consumedPreflight, checkpoint, "preflightReceiptSha256", "preflight-receipt-consumed");
      assertReceiptSchema(
        readJson(consumedGuard, "guard-receipt-consumed"),
        manifest,
        "guard",
      );
      assertReceiptSchema(
        readJson(consumedPreflight, "preflight-receipt-consumed"),
        manifest,
        "preflight",
      );
    }
    if (!closedRun && run.status !== "unknown" && names.has("apply-receipt")) {
      const applyCheckpoint = checkpointNamed(checkpoints, "apply-receipt");
      const apply = readReceiptAtCheckpoint(artifacts.apply, applyCheckpoint, manifest, "apply", ["applied", "unknown"]);
      if (apply.status === "applied" && ["applying", "unknown"].includes(run.status)) {
        run.status = "applied";
        run.appliedAt = run.appliedAt ?? apply.appliedAt;
        changed = true;
      } else if (run.status === "applying") {
        run.status = "unknown";
        run.unknownAt = run.unknownAt ?? apply.appliedAt;
        changed = true;
      }
    }
    if (!closedRun && names.has("reconcile")) {
      const reconcileCheckpoints = checkpoints.filter((checkpoint) => checkpoint.name === "reconcile");
      for (const reconcileCheckpoint of reconcileCheckpoints) {
        const reconcilePath = reconcilePathForCheckpoint(directory, reconcileCheckpoint);
        readReceiptAtCheckpoint(
          reconcilePath,
          reconcileCheckpoint,
          manifest,
          "reconcile",
          ["applied", "invalidated", "unknown"],
        );
      }
      const reconcile = readReceiptAtCheckpoint(
        reconcilePathForCheckpoint(directory, reconcileCheckpoints.at(-1)),
        reconcileCheckpoints.at(-1),
        manifest,
        "reconcile",
        ["applied", "invalidated", "unknown"],
      );
      if (run.status === "applying" || run.status === "unknown") {
        const previousStatus = run.status;
        if (reconcile.status === "applied") run.status = "applied";
        else if (reconcile.status === "invalidated") run.status = "invalidated";
        else failIf(reconcile.status !== "unknown", "reconcile-receipt-status");
        if (run.status !== previousStatus) changed = true;
      }
    }
    const advancement = checkpoints.find((checkpoint) => checkpoint.name === "global-state-advancement");
    const sourceState = STATE_FOR_PHASE[run.phase];
    const targetState = run.phase === "terminal" ? "terminal-verified" : ADVANCED_STATE[run.phase];
    if (advancement !== undefined) {
      if (run.phase === "terminal") validateFinalTerminalEvidence(config, directory, advancement, state);
      failIf(
        advancement.from !== sourceState || advancement.to !== targetState,
        "global-state-history",
      );
      if (advancement.applyReceiptSha256 !== undefined) {
        failIf(
          !isSha(advancement.applyReceiptSha256) ||
            sha256File(artifacts.apply, JSON_MAX_BYTES) !== advancement.applyReceiptSha256,
          "global-state-history",
        );
      }
      if (state.state === sourceState) {
        if (run.status === "applied" || (run.phase === "terminal" && run.status === "guarded")) {
          state.state = targetState;
          if (run.phase === "terminal") run.status = "finalized";
          changed = true;
        } else {
          failIf(run.status !== "invalidated" && run.status !== "superseded", "global-state-history");
        }
      } else {
        failIf(stateIndex(state.state) < stateIndex(targetState), "global-state-history");
        failIf(
          run.status !== "applied" && run.status !== "finalized" &&
            run.status !== "invalidated" && run.status !== "superseded",
          "global-state-history",
        );
      }
    } else if (run.status === "applied") {
      // A crash after a durable applied receipt but before the global
      // advancement checkpoint must commit the already-recorded result; it
      // must never invoke Terraform again.  The checkpoint is created by
      // recovery while the kernel lock is held.
      failIf(run.phase === "terminal" || state.state !== sourceState, "global-state-history");
      writeCheckpoint(config, directory, run.id, run.phase, "global-state-advancement", {
        from: sourceState,
        to: targetState,
        applyReceiptSha256: sha256File(artifacts.apply),
        recovered: true,
      });
      state.state = targetState;
      changed = true;
    }
  }
  if (changed) saveState(config, state);
}

function saveState(config, state) {
  assertClosedGlobalState(state);
  const previousSerial = state.stateSerial;
  const previousSnapshotPath = path.join(
    config.root,
    `state-${String(previousSerial).padStart(12, "0")}.json`,
  );
  assertRegular(previousSnapshotPath, ARTIFACT_MODE, "state-snapshot");
  const previousSnapshotSha256 = sha256File(previousSnapshotPath, JSON_MAX_BYTES);
  const next = {
    ...state,
    stateSerial: previousSerial + 1,
    sequence: previousSerial + 1,
    previousSnapshotSha256,
    updatedAt: nowIso(config.now),
  };
  next.stateSha256 = stateCanonicalSha256(next);
  const snapshotPath = path.join(config.root, `state-${String(next.stateSerial).padStart(12, "0")}.json`);
  exclusiveJson(snapshotPath, next, "state-snapshot");
  replaceJson(path.join(config.root, "state.json"), next, "state");
  Object.assign(state, next);
}

function requireState(config) {
  const state = loadState(config);
  failIf(state === null, "state-absent-use-init");
  return state;
}

function rejectAutomaticTerraformVariableSources(workdir) {
  let entries;
  try {
    entries = readdirSync(workdir, { withFileTypes: true });
  } catch {
    reject("terraform-variable-sources");
  }
  const automatic = /^(?:terraform\.tfvars\.json|.*\.auto\.tfvars(?:\.json)?)$/;
  for (const entry of entries) {
    failIf(automatic.test(entry.name), "terraform-variable-sources");
  }
}

function addTerminalInventoryEntry(inventory, root, filePath, label = undefined) {
  const relative = label ?? path.relative(root, filePath);
  failIf(relative === "" || relative.startsWith("..") || path.isAbsolute(relative), "terminal-receipt-path");
  failIf(inventory.some((entry) => entry.label === relative), "terminal-receipt-inventory");
  inventory.push({ label: relative, sha256: sha256EvidenceFile(filePath, relative) });
}

function validatedRunEvidence(config, inventory, entry, artifacts, checkpoints) {
  const directory = runPath(config, entry.id);
  const allowed = new Set([
    "plan.tfplan",
    IMAGE_VERIFIER_ARTIFACT_NAME,
    "tf-cli.tfrc",
    "create-manifest.json",
    "show.json",
    "guard-receipt.json.consumed",
    "preflight-receipt.json.consumed",
    "apply-receipt.json",
  ]);
  if (entry.phase === "runtime-cutover") allowed.add("diagnostic-receipt.json");
  if (entry.phase === "runtime-cutover") {
    allowed.add("diagnostic-intent.json");
    allowed.add("diagnostic-invoking.json");
    allowed.add("diagnostic-submission.json");
  }
  if (entry.phase === "credential-cleanup") {
    for (const name of [
      "vault-descriptor.json",
      "cleanup-manifest.json",
      "cleanup-absence-receipt.json",
    ]) allowed.add(name);
  }
  const permitted = (name) => CHECKPOINT_FILE_RE.test(name) ||
    allowed.has(name) ||
    /^reconcile-receipt-\d{6}\.json$/.test(name) ||
    /^cleanup-manifest-\d{6}\.json$/.test(name) ||
    /^cleanup-state-\d{6}\.json$/.test(name) ||
    /^cleanup-state-anchor(?:-\d{6})?\.json$/.test(name) ||
    /^cleanup-journal-head-\d{6}\.json$/.test(name);
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    failIf(item.isSymbolicLink() || !item.isFile() || !permitted(item.name), "terminal-receipt-inventory");
  }
  for (const checkpoint of checkpoints) {
    addTerminalInventoryEntry(inventory, config.root, path.join(directory, `${String(checkpoint.sequence).padStart(6, "0")}-${checkpoint.name}.json`), `${entry.id}/${String(checkpoint.sequence).padStart(6, "0")}-${checkpoint.name}.json`);
  }
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (!item.isFile() || CHECKPOINT_FILE_RE.test(item.name)) continue;
    addTerminalInventoryEntry(inventory, config.root, path.join(directory, item.name), `${entry.id}/${item.name}`);
  }
}

function terminalPredecessorEvidence(config, state, terminalRequest) {
  const inventory = [];
  const root = config.root;
  const add = (filePath, label) => addTerminalInventoryEntry(inventory, root, filePath, label);
  const terminalCheckpoints = readCheckpoints(terminalRequest.runDirectory, {
    runId: terminalRequest.runId,
    phase: "terminal",
  });
  add(terminalRequest.artifacts.manifest);
  const terminalGuard = checkpointNamed(terminalCheckpoints, "guard-receipt");
  readReceiptAtCheckpoint(terminalRequest.artifacts.guard, terminalGuard, terminalRequest.manifest, "guard");
  add(terminalRequest.artifacts.guard);
  const applied = (phase) => appliedPhasePredecessorEvidence(
    config,
    state,
    phase,
    "terminal-predecessor",
    inventory,
  );

  applied("model-bootstrap");
  const runtime = applied("runtime-cutover");
  requiredDiagnostic({ manifest: runtime.manifest, artifacts: runtime.artifacts });

  const credential = applied("credential-cleanup");
  const consumed = checkpointNamed(credential.checkpoints, "receipts-consumed");
  const cleanup = requiredCleanup({
    manifest: credential.manifest,
    artifacts: credential.artifacts,
    guardReceiptSha256: consumed.guardReceiptSha256,
    processRunner: config.processRunner,
  });

  const revocation = validateRevocationEvidence(config, { requireComplete: true });
  const revocationReceipt = revocation.find((entry) => entry.label === "openrouter-revocation-receipt.json");
  failIf(revocationReceipt === undefined, "terminal-revocation");
  for (const entry of revocation) add(path.join(root, entry.label), entry.label);

  const livePath = path.join(terminalRequest.runDirectory, "terminal-live-receipt.json");
  assertExactReceipt(
    livePath,
    "live-receipt",
    terminalRequest.manifest,
    { type: "live", status: "passed", operation: "terminal-live" },
  );
  add(livePath);
  inventory.sort((left, right) => left.label.localeCompare(right.label));
  void cleanup;
  return inventory;
}

function validateFinalTerminalEvidence(config, runDirectory, advancement, state) {
  const artifacts = artifactPaths(runDirectory);
  const checkpoints = readCheckpoints(runDirectory, {
    runId: advancement.runId,
    phase: "terminal",
  });
  const terminal = state.runs.find((run) => run.id === advancement.runId && run.phase === "terminal");
  failIf(!terminal, "terminal-run");
  const manifest = immutableManifest(
    runDirectory,
    artifacts,
    checkpoints,
    terminal,
  );
  assertCheckpointArtifact(artifacts.terminal, advancement, "terminalReceiptSha256", "terminal-receipt");
  failIf(!Array.isArray(advancement.receiptInventory), "terminal-receipt-inventory");
  const checkpointInventory = advancement.receiptInventory;
  failIf(
    checkpointInventory.length === 0 ||
      checkpointInventory.some((entry) => !isObject(entry) || !isSha(entry.sha256)),
    "terminal-receipt-inventory",
  );
  for (const entry of checkpointInventory) {
    assertKnownKeys(entry, ["label", "sha256"], "terminal-receipt-inventory");
    assertRequiredKeys(entry, ["label", "sha256"], "terminal-receipt-inventory");
  }
  const terminalReceipt = readJson(artifacts.terminal, "terminal-receipts");
  assertReceiptMatches(terminalReceipt, manifest, "terminal");
  assertKnownKeys(terminalReceipt, [
    "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
    "result", "receiptInventory", "receiptSetSha256",
  ], "terminal-receipt-schema");
  assertRequiredKeys(terminalReceipt, [
    "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
    "result", "receiptInventory", "receiptSetSha256",
  ], "terminal-receipt-schema");
  failIf(terminalReceipt.version !== 1 || terminalReceipt.result !== "verified", "terminal-receipt-schema");
  const inventory = terminalPredecessorEvidence(config, state, {
    runDirectory,
    runId: advancement.runId,
    manifest,
    artifacts,
  });
  failIf(!same(terminalReceipt.receiptInventory, inventory), "terminal-receipt-inventory");
  failIf(!same(advancement.receiptInventory, inventory), "terminal-receipt-inventory");
  failIf(
    !isSha(terminalReceipt.receiptSetSha256) ||
      !isSha(advancement.receiptSetSha256) ||
      terminalReceipt.receiptSetSha256 !== advancement.receiptSetSha256,
    "terminal-receipt-set",
  );
  failIf(hashJson(inventory) !== terminalReceipt.receiptSetSha256, "terminal-receipt-set");
}

function createRunDirectory(config, runId) {
  const directory = runPath(config, runId);
  failIf(existsSync(directory), "run-exists");
  try {
    mkdirSync(directory, { mode: DIRECTORY_MODE });
    chmodSync(directory, DIRECTORY_MODE);
  } catch {
    reject("run-create");
  }
  assertDirectory(directory, "run-directory");
  fsyncDirectory(config.root);
  return directory;
}

function defaultTerraformExecutor(request) {
  failIf(terraformExecutableSha256() !== TERRAFORM_SHA256, "terraform-hash");
  if (request.operation === "create" && request.processRunner === undefined && request.tempPlanPath) {
    createSecureEmptyFile(request.tempPlanPath, "temp-plan");
  }
  const argv = request.operation === "create" && request.processRunner === undefined && request.tempPlanPath
    ? request.argv.map((argument) => argument === `-out=${request.planPath}` ? `-out=${request.tempPlanPath}` : argument)
    : request.argv;
  return commandResult(TERRAFORM_PATH, argv, {
    cwd: request.cwd,
    env: request.env,
    timeoutMs: request.operation === "apply" ? APPLY_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
    processGroup: request.operation === "apply",
  }, request.processRunner);
}

function cleanupUtilityResult(result, operation) {
  if (result === true || result === 0 || result?.status === "success" || result?.status === "started" || result?.status === "absent") {
    return { status: "success", result };
  }
  if (result?.status === "ambiguous") reject(`cleanup-${operation}-unknown`);
  reject(`cleanup-${operation}`);
}

function runCleanupUtility(config, operation, runId) {
  const runner = config.cleanupRunner;
  if (typeof runner === "function") {
    return cleanupUtilityResult(runner({
      command: CLEANUP_UTILITY_PATH,
      operation,
      runId,
      argv: [operation, runId],
      root: config.root,
    }), operation);
  }
  const lockFd = inheritedKernelLockDescriptor(config.kernelLockPath);
  failIf(lockFd === undefined, "cleanup-lock-inherited");
  let lockToken;
  try {
    lockToken = readFileSync(kernelPathFor(config), "utf8").trim();
  } catch {
    reject("cleanup-lock-token");
  }
  failIf(!/^[a-f0-9]{64}$/.test(lockToken), "cleanup-lock-token");
  let child;
  try {
    const childStdio = ["ignore", "pipe", "pipe", lockFd];
    child = spawnSync(process.execPath, [
      CLEANUP_UTILITY_PATH,
      CLEANUP_INTERNAL_LOCKED_MARKER,
      operation,
      runId,
    ], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...PRODUCTION_ENV,
        PALANCAR_CLEANUP_LOCK_FD: "3",
        PALANCAR_CLEANUP_LOCK_TOKEN: lockToken,
      },
      encoding: "utf8",
      timeout: 180 * 1000,
      killSignal: "SIGKILL",
      maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
      stdio: childStdio,
    });
  } catch {
    reject(`cleanup-${operation}-unknown`);
  }
  if (child.error || child.status === null) reject(`cleanup-${operation}-unknown`);
  failIf(child.status !== 0 || child.stdout !== "success\n" || child.stderr !== "", `cleanup-${operation}`);
  return { status: "success" };
}

function createVaultDescriptor(config, run, manifest, bindings, supersession = undefined) {
  const providerConfig = {
    ...config,
    childEnvironment: buildChildEnvironment(run.runDirectory, config.inheritedEnvironment),
    account: {
      cloud: "AzureCloud",
      subscription: bindings.backend.subscription_id,
      tenant: bindings.backend.tenant_id,
    },
  };
  const outputs = defaultOutputs(providerConfig);
  requireRuntimeOutputs(outputs);
  const vaultUri = outputs.keyVaultUri.endsWith("/") ? outputs.keyVaultUri : `${outputs.keyVaultUri}/`;
  const descriptor = {
    version: 1,
    type: "credential-cleanup-vault-descriptor",
    runId: manifest.runId,
    phase: "credential-cleanup",
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    contextSha256: manifest.bindingSha256,
    vaultResourceId: outputs.keyVaultId,
    vaultUri,
    subscription: bindings.backend.subscription_id,
    tenant: bindings.backend.tenant_id,
    cloud: "AzureCloud",
    callerIdentity: {
      userType: "user",
      objectId: defaultOperatorId(config.workdir),
    },
    targetNames: [...CLEANUP_TARGET_NAMES],
    startState: "start",
    ...(supersession === undefined ? {} : { supersession }),
  };
  failIf(!UUID_RE.test(descriptor.callerIdentity.objectId ?? ""), "cleanup-caller");
  exclusiveJson(run.artifacts.descriptor, descriptor, "vault-descriptor");
  validateCleanupDescriptor(run.artifacts.descriptor, manifest);
  return descriptor;
}

function defaultShowExecutor(request) {
  failIf(terraformExecutableSha256() !== TERRAFORM_SHA256, "terraform-hash");
  return commandResult(TERRAFORM_PATH, exactShowArgv(request.planPath), {
    cwd: request.cwd,
    env: request.env,
    phase: request.phase,
    timeoutMs: COMMAND_TIMEOUT_MS,
  }, request.processRunner);
}

function defaultGuardExecutor(request) {
  const result = commandResult(
    defaultGuardScript(request.guardScript),
    exactGuardArgv(request.phase),
    {
      cwd: REPOSITORY_ROOT,
      env: request.env,
      input: request.input,
      phase: request.phase,
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
    request.processRunner,
  );
  return result;
}

function resourceIdParts(resourceId, code) {
  failIf(typeof resourceId !== "string", code);
  const match = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.CognitiveServices\/accounts\/([^/?#]+)$/.exec(
    resourceId,
  );
  failIf(!match, code);
  return { subscription: match[1], resourceGroup: match[2], account: match[3] };
}

function parseImageReference(value, code) {
  const match = typeof value === "string" ? IMAGE_REFERENCE_RE.exec(value) : null;
  failIf(match === null, code);
  return { host: match[1], repository: match[2], digest: match[3], reference: value };
}

function parseProtectedImageTfvars(config, acrLoginServer) {
  const tfvarsPath = path.join(config.workdir, "terraform.tfvars");
  const stat = assertPrivateRegular(tfvarsPath, "image-platform-tfvars");
  failIf(stat.size > JSON_MAX_BYTES, "image-platform-tfvars-too-large");
  const source = boundedFileText(tfvarsPath, JSON_MAX_BYTES, "image-platform-tfvars");
  const values = new Map();
  const names = ["relay_image_digest", "expiry_cleanup_image_digest"];
  const assignmentPattern = /^(relay_image_digest|expiry_cleanup_image_digest)\s*=\s*("[^"]*")\s*$/;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#[^\r\n]*$/, "").trim();
    if (line.length === 0) continue;
    const targetMention = names.some((name) => new RegExp(`\\b${name}\\b`).test(line));
    const match = assignmentPattern.exec(line);
    if (match !== null) {
      failIf(values.has(match[1]), "image-platform-tfvars-duplicate");
      const parsed = parseImageReference(match[2].slice(1, -1), "image-platform-tfvars-value");
      values.set(match[1], parsed);
      continue;
    }
    failIf(targetMention, "image-platform-tfvars-assignment");
  }
  failIf(values.size !== names.length, "image-platform-tfvars-missing");
  const relay = values.get("relay_image_digest");
  const cleanup = values.get("expiry_cleanup_image_digest");
  failIf(relay.host !== acrLoginServer || cleanup.host !== acrLoginServer, "image-platform-host");
  failIf(relay.repository !== "palancar-relay" || cleanup.repository !== "palancar-expiry-cleanup", "image-platform-repository");
  return { relay, cleanup };
}

function validateImagePlatformDescriptor(value, reference, repository, acrLoginServer, code) {
  assertKnownKeys(value, IMAGE_DESCRIPTOR_KEYS, code);
  assertRequiredKeys(value, IMAGE_DESCRIPTOR_KEYS, code);
  const parsed = parseImageReference(value.reference, code);
  failIf(
    value.version !== 1 ||
      parsed.host !== acrLoginServer ||
      parsed.repository !== repository ||
      value.reference !== reference ||
      value.repository !== repository ||
      value.manifestDigest !== parsed.digest ||
      !/^sha256:[a-f0-9]{64}$/.test(value.configDigest) ||
      !Object.hasOwn(IMAGE_MANIFEST_MEDIA_TYPES, value.manifestMediaType) ||
      value.configMediaType !== IMAGE_MANIFEST_MEDIA_TYPES[value.manifestMediaType] ||
      value.os !== "linux" ||
      value.architecture !== "amd64" ||
      value.variant !== null,
    code,
  );
  return value;
}

function parseImageVerifierOutput(result, reference, repository, acrLoginServer) {
  const code = "image-platform-verification";
  failIf(result.status !== "success" || result.stderr !== "", code);
  const output = result.stdout;
  failIf(typeof output !== "string" || output.length === 0 || !output.endsWith("\n"), code);
  const body = output.slice(0, -1);
  failIf(
    body.includes("\n") || body.includes("\r") || body.trim() !== body ||
      Buffer.byteLength(output) > IMAGE_VERIFIER_OUTPUT_MAX_BYTES,
    code,
  );
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    reject(code);
  }
  return validateImagePlatformDescriptor(value, reference, repository, acrLoginServer, code);
}

function imageVerifierIdentity(reviewed, code = "image-platform-verification") {
  const entry = reviewed.dependencyBlobs.find((candidate) => candidate.path === IMAGE_VERIFIER_PATH);
  failIf(!isObject(entry) || !isSha(entry.sha256) || typeof entry.path !== "string", code);
  return entry;
}

function imagePlatformBinding(verifierSha256, descriptors) {
  const images = [...descriptors].sort((left, right) =>
    left.repository < right.repository ? -1 : left.repository > right.repository ? 1 : 0,
  );
  failIf(
    images.length !== 2 ||
      images[0].repository !== "palancar-expiry-cleanup" ||
      images[1].repository !== "palancar-relay" ||
      !isSha(verifierSha256),
    "image-platform-binding",
  );
  return { version: 1, verifierSha256, images };
}

function validateImagePlatformBinding(value, expectedAcrLoginServer, code = "image-platform-binding") {
  failIf(
    typeof expectedAcrLoginServer !== "string" || !ACR_LOGIN_SERVER_RE.test(expectedAcrLoginServer),
    code,
  );
  assertKnownKeys(value, ["version", "verifierSha256", "images"], code);
  assertRequiredKeys(value, ["version", "verifierSha256", "images"], code);
  failIf(value.version !== 1 || !isSha(value.verifierSha256) || !Array.isArray(value.images), code);
  failIf(value.images.length !== 2, code);
  const seen = new Set();
  for (const descriptor of value.images) {
    const parsed = parseImageReference(descriptor?.reference, code);
    failIf(seen.has(parsed.repository), code);
    seen.add(parsed.repository);
    validateImagePlatformDescriptor(
      descriptor,
      descriptor.reference,
      parsed.repository,
      expectedAcrLoginServer,
      code,
    );
    failIf(parsed.host !== expectedAcrLoginServer, code);
  }
  failIf(!seen.has("palancar-relay") || !seen.has("palancar-expiry-cleanup"), code);
  failIf(value.images[0].repository !== "palancar-expiry-cleanup" || value.images[1].repository !== "palancar-relay", code);
  return value;
}

function assertImmutableVerifierArtifact(filePath, expectedSha256, code = "image-platform-verification") {
  failIf(
    typeof filePath !== "string" || path.basename(filePath) !== IMAGE_VERIFIER_ARTIFACT_NAME ||
      !isSha(expectedSha256),
    code,
  );
  assertRegular(filePath, ARTIFACT_MODE, code);
  failIf(statSync(filePath).size > EXECUTABLE_MAX_BYTES, code);
  failIf(sha256File(filePath, EXECUTABLE_MAX_BYTES) !== expectedSha256, code);
}

function materializeReviewedVerifier(config, artifacts, reviewed, code = "image-platform-verification") {
  const entry = imageVerifierIdentity(reviewed, code);
  const source = path.join(config.repoRoot, IMAGE_VERIFIER_PATH);
  assertReviewedVerifierSource(config, entry.sha256, code);
  let bytes;
  try {
    bytes = readFileSync(source);
  } catch {
    reject(code);
  }
  failIf(sha256Bytes(bytes) !== entry.sha256, code);
  exclusiveText(artifacts.verifier, bytes, code);
  assertImmutableVerifierArtifact(artifacts.verifier, entry.sha256, code);
  return artifacts.verifier;
}

function assertReviewedVerifierSource(config, expectedSha256, code = "image-platform-verification") {
  const source = path.join(config.repoRoot, IMAGE_VERIFIER_PATH);
  const stat = assertRegular(source, null, code);
  failIf(stat.size > EXECUTABLE_MAX_BYTES, code);
  failIf(sha256File(source, EXECUTABLE_MAX_BYTES) !== expectedSha256, code);
}

function runImageVerifier(config, phase, env, subscription, verifierSha256, verifierPath, reference, repository, acrLoginServer) {
  assertImmutableVerifierArtifact(verifierPath, verifierSha256, "image-platform-verification");
  const result = runCommand(
    { ...config, childEnvironment: env },
    "/usr/bin/node",
    [verifierPath, "verify", subscription, acrLoginServer, reference],
    {
      phase: "image-platform-verification",
      cwd: config.repoRoot,
      env,
      timeoutMs: IMAGE_VERIFIER_TIMEOUT_MS,
      maxOutputBytes: IMAGE_VERIFIER_OUTPUT_MAX_BYTES,
      fresh: true,
    },
  );
  return {
    descriptor: parseImageVerifierOutput(result, reference, repository, acrLoginServer),
    verifierSha256,
  };
}

function verifyImagePlatforms(config, phase, env, context, expected = undefined, verifierPath = undefined) {
  const code = "image-platform-verification";
  try {
    failIf(!isObject(context) || !isObject(context.backend), code);
    const subscription = context.backend.subscription_id ?? context.azure?.subscription;
    failIf(
      subscription !== context.backend.subscription_id ||
        typeof subscription !== "string" ||
        typeof context.acrLoginServer !== "string" ||
        !ACR_LOGIN_SERVER_RE.test(context.acrLoginServer),
      code,
    );
    const refs = parseProtectedImageTfvars(config, context.acrLoginServer);
    const verifier = imageVerifierIdentity(context, code);
    assertReviewedVerifierSource(config, verifier.sha256, code);
    failIf(typeof verifierPath !== "string", code);
    assertImmutableVerifierArtifact(verifierPath, verifier.sha256, code);
    const relay = runImageVerifier(
      config,
      phase,
      env,
      subscription,
      verifier.sha256,
      verifierPath,
      refs.relay.reference,
      refs.relay.repository,
      context.acrLoginServer,
    );
    const cleanup = runImageVerifier(
      config,
      phase,
      env,
      subscription,
      verifier.sha256,
      verifierPath,
      refs.cleanup.reference,
      refs.cleanup.repository,
      context.acrLoginServer,
    );
    const binding = imagePlatformBinding(verifier.sha256, [relay.descriptor, cleanup.descriptor]);
    validateImagePlatformBinding(binding, context.acrLoginServer, code);
    if (expected !== undefined) failIf(!same(binding, expected), code);
    return binding;
  } catch (error) {
    if (error instanceof LifecycleError && error.code === code) throw error;
    reject(code);
  }
}

function defaultOutputs(config) {
  return testSnapshot(`terraform-outputs:${config.workdir}:${config.contextOperation ?? "bootstrap"}`, () => {
    const output = runCommand(config, TERRAFORM_PATH, ["output", "-json"]);
    const values = parseCommandJson(output, "terraform-output");
    failIf(!isObject(values), "terraform-output");
    const get = (name, required = true) => {
      const descriptor = values[name];
      if (required) failIf(!isObject(descriptor) || !Object.hasOwn(descriptor, "value"), "terraform-output");
      return descriptor?.value;
    };
    const accountParts = resourceIdParts(get("foundry_account_id"), "foundry-account");
    failIf(accountParts.subscription !== config.account.subscription, "binding-mismatch");
    const resourceGroup = get("resource_group_name");
    failIf(resourceGroup !== accountParts.resourceGroup, "resource-context");
    const acrLoginServer = get("acr_login_server");
    failIf(typeof acrLoginServer !== "string" || !ACR_LOGIN_SERVER_RE.test(acrLoginServer), "acr-login-server");
    const outputs = {
      resourceGroup,
      region: get("region"),
      acrLoginServer,
      accountId: get("foundry_account_id"),
      account: accountParts.account,
      foundryResourceGroup: accountParts.resourceGroup,
      foundryEndpoint: get("foundry_endpoint", false),
      containerAppEnvironmentId: get("container_app_environment_id", false),
      relayContainerApp: get("relay_container_app_name", false),
      relayRevision: get("relay_latest_revision_name", false),
      relayContainerAppId: get("relay_container_app_id", false),
      expiryCleanupJobName: get("expiry_cleanup_job_name", false),
      expiryCleanupJobId: get("expiry_cleanup_job_id", false),
      keyVault: get("key_vault_name", false),
      keyVaultId: get("key_vault_id", false),
      keyVaultUri: get("key_vault_uri", false),
      runtimeIdentityId: get("runtime_identity_id", false),
      runtimeIdentityClientId: get("runtime_identity_client_id", false),
      imagePullIdentityId: get("image_pull_identity_id", false),
      runtimeOpenAiRoleAssignmentId: get("runtime_openai_user_role_assignment_id", false),
      runtimeMonitoringRoleAssignmentId: get("runtime_application_insights_role_assignment_id", false),
      runtimeSecretsUserRoleAssignmentId: get("runtime_secrets_user_role_assignment_id", false),
      applicationInsightsId: get("application_insights_id", false),
      workloadStateStorageAccountId: get("workload_state_storage_account_id", false),
    };
    outputs.runtimeIdentityPrincipalId = runtimeIdentityPrincipalFromAccountRole(config, outputs);
    return outputs;
  });
}

function runtimeIdentityPrincipalFromAccountRole(config, outputs) {
  failIf(typeof outputs.accountId !== "string" || typeof outputs.runtimeOpenAiRoleAssignmentId !== "string", "runtime-openai-role");
  const assignments = azJson(config, [
    "role", "assignment", "list",
    "--scope", outputs.accountId,
    "--fill-principal-name", "false",
    "--fill-role-definition-name", "false",
    "-o", "json",
  ], "runtime-openai-role");
  failIf(!Array.isArray(assignments), "runtime-openai-role");
  const projected = assignments.map(projectRoleAssignmentSecurityFields);
  const matches = projected.filter((assignment) => assignment.id === outputs.runtimeOpenAiRoleAssignmentId);
  failIf(matches.length !== 1, "runtime-openai-role");
  const assignment = matches[0];
  assertKnownKeys(assignment, ROLE_ASSIGNMENT_SECURITY_KEYS, "runtime-openai-role");
  assertRequiredKeys(assignment, ROLE_ASSIGNMENT_SECURITY_KEYS, "runtime-openai-role");
  const assignmentPrefix = `${outputs.accountId}/providers/Microsoft.Authorization/roleAssignments/`;
  const validTypes = typeof assignment.id === "string" &&
    typeof assignment.principalId === "string" &&
    typeof assignment.principalType === "string" &&
    typeof assignment.roleDefinitionId === "string" &&
    typeof assignment.scope === "string";
  failIf(
    !validTypes ||
      !assignment.id.startsWith(assignmentPrefix) ||
      !UUID_RE.test(assignment.id.slice(assignmentPrefix.length)) ||
      !UUID_RE.test(assignment.principalId) ||
      assignment.principalType !== "ServicePrincipal" ||
      assignment.roleDefinitionId !== roleDefinitionResourceId(config.account.subscription, ENTRA_ROLES.openAiUser) ||
      assignment.scope !== outputs.accountId,
    "runtime-openai-role",
  );
  return assignment.principalId;
}

function azJson(config, args, code, options = {}) {
  return parseCommandJson(runCommand(config, AZ_PATH, args, options), code);
}

const MODEL_BOOTSTRAP_CONTRACT = Object.freeze({
  transcriptionDeployment: "gpt-4o-mini-transcribe",
  transcriptionVersion: "2025-12-15",
  lunaDeployment: "gpt-5.6-luna",
  lunaVersion: "2026-07-09",
  format: "OpenAI",
  sku: "GlobalStandard",
  transcriptionCapacity: 1,
  lunaCapacity: 1013,
  upgradeOption: "NoAutoUpgrade",
  accountKind: "OpenAI",
  quotaUnit: "Count",
  quotaLocalizedPrefix: "One Thousand Tokens Per Minute - ",
});

function assertKnownKeys(value, keys, code) {
  failIf(!isObject(value), code);
  const allowed = new Set(keys);
  failIf(Object.keys(value).some((key) => !allowed.has(key)), code);
}

function assertRequiredKeys(value, keys, code) {
  for (const key of keys) failIf(!Object.hasOwn(value, key), code);
}

function pagedAzureList(value, code) {
  failIf(!Array.isArray(value), code);
  return value;
}

function deploymentIdParts(resourceId, code) {
  failIf(typeof resourceId !== "string", code);
  const match = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.CognitiveServices\/accounts\/([^/]+)\/deployments\/([^/]+)$/.exec(resourceId);
  failIf(!match, code);
  return {
    subscription: match[1],
    resourceGroup: match[2],
    account: match[3],
    deployment: match[4],
  };
}

function validateDeploymentItem(item, outputs, config) {
  assertKnownKeys(item, ["etag", "id", "name", "properties", "resourceGroup", "sku", "systemData", "tags", "type"], "deployment-response");
  assertRequiredKeys(item, ["id", "name", "properties", "sku"], "deployment-response");
  failIf(typeof item.name !== "string" || item.name.length === 0, "deployment-response");
  if (item.type !== undefined) {
    failIf(item.type !== "Microsoft.CognitiveServices/accounts/deployments", "deployment-context");
  }
  const id = deploymentIdParts(item.id, "deployment-context");
  failIf(
    id.subscription !== config.account.subscription ||
      id.resourceGroup !== outputs.foundryResourceGroup ||
      id.account !== outputs.account ||
      id.deployment !== item.name,
    "deployment-context",
  );
  assertKnownKeys(item.properties, [
    "callRateLimit",
    "capabilities",
    "capacitySettings",
    "currentCapacity",
    "dynamicThrottlingEnabled",
    "model",
    "parentDeploymentName",
    "provisioningState",
    "raiPolicyName",
    "rateLimits",
    "scaleSettings",
    "spilloverDeploymentName",
    "versionUpgradeOption",
  ], "deployment-response");
  assertRequiredKeys(item.properties, ["model", "provisioningState", "spilloverDeploymentName", "versionUpgradeOption"], "deployment-response");
  failIf(item.properties.spilloverDeploymentName !== null, "deployment-spillover");
  assertKnownKeys(item.properties.model, [
    "callRateLimit",
    "format",
    "name",
    "publisher",
    "source",
    "sourceAccount",
    "version",
  ], "deployment-response");
  assertRequiredKeys(item.properties.model, ["format", "name", "version"], "deployment-response");
  failIf(
    typeof item.properties.provisioningState !== "string" ||
      typeof item.properties.versionUpgradeOption !== "string",
    "deployment-response",
  );
  assertKnownKeys(item.sku, ["capacity", "family", "name", "size", "tier"], "deployment-response");
  assertRequiredKeys(item.sku, ["capacity", "name"], "deployment-response");
  failIf(!Number.isSafeInteger(item.sku.capacity) || item.sku.capacity < 0, "deployment-response");
  failIf(typeof item.sku.name !== "string" || item.sku.name.length === 0, "deployment-response");
  return {
    name: item.name,
    modelName: item.properties.model.name,
    version: item.properties.model.version,
    format: item.properties.model.format,
    sku: item.sku.name,
    capacity: item.sku.capacity,
    provisioningState: item.properties.provisioningState,
    versionUpgradeOption: item.properties.versionUpgradeOption,
  };
}

function isAzureNotFound(result) {
  if (result?.status !== "failure" || !Number.isInteger(result.exitCode) || result.exitCode === 0) return false;
  if (result.exitCode === 404) return true;
  const errorText = [result.stderr, result.stdout]
    .filter((value) => typeof value === "string")
    .join("\n");
  if (/\b404\b/.test(errorText)) return true;
  return /\b(?:DeploymentNotFound|ResourceNotFound|NotFound)\b/i.test(errorText);
}

function showLunaDeployment(config, outputs) {
  const result = runCommand(config, AZ_PATH, [
    "cognitiveservices",
    "account",
    "deployment",
    "show",
    "--name",
    outputs.account,
    "--resource-group",
    outputs.foundryResourceGroup,
    "--subscription",
    config.account.subscription,
    "--deployment-name",
    MODEL_BOOTSTRAP_CONTRACT.lunaDeployment,
    "--output",
    "json",
  ]);
  if (result.status === "success") {
    const deployment = parseCommandJson(result, "luna-deployment");
    const descriptor = validateDeploymentItem(deployment, outputs, config);
    failIf(descriptor.name !== MODEL_BOOTSTRAP_CONTRACT.lunaDeployment, "luna-deployment");
    reject("luna-present");
  }
  failIf(!isAzureNotFound(result), "luna-deployment-query");
}

function verifyAccountContext(config, outputs) {
  failIf(
    typeof outputs.account !== "string" ||
      typeof outputs.foundryResourceGroup !== "string" ||
      typeof outputs.region !== "string" ||
      outputs.region.length === 0,
    "account-context",
  );
  const account = azJson(config, [
    "cognitiveservices",
    "account",
    "show",
    "--name",
    outputs.account,
    "--resource-group",
    outputs.foundryResourceGroup,
    "--subscription",
    config.account.subscription,
    "--output",
    "json",
  ], "account-context");
  assertKnownKeys(account, ["etag", "id", "identity", "kind", "location", "name", "properties", "resourceGroup", "sku", "systemData", "tags", "type"], "account-context");
  assertRequiredKeys(account, ["id", "kind", "location", "name"], "account-context");
  const parts = resourceIdParts(account.id, "account-context");
  failIf(
    parts.subscription !== config.account.subscription ||
      parts.resourceGroup !== outputs.foundryResourceGroup ||
      parts.account !== outputs.account ||
      account.name !== outputs.account ||
      account.location !== outputs.region ||
      account.kind !== MODEL_BOOTSTRAP_CONTRACT.accountKind,
    "account-context",
  );
  return { kind: account.kind, location: account.location };
}

function verifyDeploymentMetadata(config, outputs) {
  const deploymentList = azJson(config, [
    "cognitiveservices",
    "account",
    "deployment",
    "list",
    "--name",
    outputs.account,
    "--resource-group",
    outputs.foundryResourceGroup,
    "--subscription",
    config.account.subscription,
    "--output",
    "json",
  ], "deployment-list");
  const entries = pagedAzureList(deploymentList, "deployment-response");
  const deployments = entries.map((item) => validateDeploymentItem(item, outputs, config));
  const names = new Set();
  for (const deployment of deployments) {
    failIf(names.has(deployment.name), "deployment-duplicate");
    names.add(deployment.name);
    if (deployment.name === MODEL_BOOTSTRAP_CONTRACT.lunaDeployment) reject("luna-present");
  }
  const transcription = deployments.find(
    (deployment) => deployment.name === MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment,
  );
  failIf(!transcription, "transcription-missing");
  failIf(
    transcription.modelName !== MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment ||
      transcription.format !== MODEL_BOOTSTRAP_CONTRACT.format ||
      transcription.version !== MODEL_BOOTSTRAP_CONTRACT.transcriptionVersion ||
      transcription.sku !== MODEL_BOOTSTRAP_CONTRACT.sku ||
      transcription.capacity !== MODEL_BOOTSTRAP_CONTRACT.transcriptionCapacity ||
      transcription.provisioningState !== "Succeeded" ||
      transcription.versionUpgradeOption !== MODEL_BOOTSTRAP_CONTRACT.upgradeOption,
    "transcription-contract",
  );
  return deployments;
}

function catalogIdParts(resourceId, code) {
  failIf(typeof resourceId !== "string", code);
  const match = /^\/subscriptions\/([^/]+)\/providers\/Microsoft\.CognitiveServices\/locations\/([^/]+)\/models\/([^/]+)$/.exec(resourceId);
  failIf(!match, code);
  return { subscription: match[1], location: match[2], model: match[3] };
}

function validateCatalogItem(item, outputs, config) {
  assertKnownKeys(item, ["description", "id", "kind", "location", "model", "name", "skuName", "type"], "model-catalog");
  assertRequiredKeys(item, ["description", "id", "kind", "location", "model", "name", "skuName", "type"], "model-catalog");
  failIf(
    item.description !== null ||
      typeof item.kind !== "string" ||
      typeof item.location !== "string" ||
      typeof item.name !== "string" ||
      typeof item.skuName !== "string" ||
      typeof item.type !== "string",
    "model-catalog",
  );
  const id = catalogIdParts(item.id, "model-catalog");
  const expectedLocation = outputs.region.toLowerCase();
  failIf(
    id.subscription !== config.account.subscription ||
      id.location.toLowerCase() !== expectedLocation ||
      item.location.toLowerCase() !== expectedLocation ||
      id.location.toLowerCase() !== item.location.toLowerCase() ||
      item.type !== "Microsoft.CognitiveServices/locations/models" ||
      item.name !== id.model,
    "catalog-context",
  );
  assertKnownKeys(item.model, [
    "baseModel",
    "callRateLimit",
    "capabilities",
    "deprecation",
    "description",
    "finetuneCapabilities",
    "format",
    "isDefaultVersion",
    "lifecycleStatus",
    "maxCapacity",
    "modelCatalogAssetId",
    "models",
    "name",
    "publisher",
    "replacementConfig",
    "routingModes",
    "skus",
    "source",
    "sourceAccount",
    "systemData",
    "version",
  ], "model-catalog");
  assertRequiredKeys(item.model, ["format", "name", "version", "lifecycleStatus", "skus"], "model-catalog");
  failIf(
    typeof item.kind !== "string" ||
      typeof item.model.format !== "string" ||
      typeof item.model.name !== "string" ||
      typeof item.model.version !== "string" ||
      typeof item.model.lifecycleStatus !== "string" ||
      item.name !== `${item.model.format}.${item.model.name}.${item.model.version}` ||
      !Array.isArray(item.model.skus),
    "model-catalog",
  );
  const skus = item.model.skus.map((sku) => {
    assertKnownKeys(sku, ["capacity", "cost", "costs", "deprecationDate", "name", "rateLimits", "usageName"], "model-catalog");
    assertRequiredKeys(sku, ["name"], "model-catalog");
    failIf(typeof sku.name !== "string" || sku.name.length === 0, "model-catalog");
    return sku.name;
  });
  return {
    kind: item.kind,
    format: item.model.format,
    modelName: item.model.name,
    version: item.model.version,
    lifecycleStatus: item.model.lifecycleStatus,
    skus,
  };
}

function verifyCatalog(config, outputs, accountContext) {
  const catalog = azJson(config, [
    "cognitiveservices",
    "model",
    "list",
    "--location",
    outputs.region,
    "--subscription",
    config.account.subscription,
    "--output",
    "json",
  ], "model-catalog");
  const entries = pagedAzureList(catalog, "model-catalog");
  const descriptors = entries.map((item) => validateCatalogItem(item, outputs, config));
  const candidates = [];
  for (const descriptor of descriptors) {
    const isExactModel =
      descriptor.kind === accountContext.kind &&
      descriptor.format === MODEL_BOOTSTRAP_CONTRACT.format &&
      descriptor.modelName === MODEL_BOOTSTRAP_CONTRACT.lunaDeployment &&
      descriptor.version === MODEL_BOOTSTRAP_CONTRACT.lunaVersion &&
      descriptor.lifecycleStatus === "GenerallyAvailable";
    if (!isExactModel) continue;
    const globalStandardCount = descriptor.skus.filter(
      (sku) => sku === MODEL_BOOTSTRAP_CONTRACT.sku,
    ).length;
    failIf(globalStandardCount > 1, "catalog-duplicate");
    if (globalStandardCount === 1) {
      candidates.push({
        kind: descriptor.kind,
        format: descriptor.format,
        modelName: descriptor.modelName,
        version: descriptor.version,
        sku: MODEL_BOOTSTRAP_CONTRACT.sku,
      });
    }
  }
  failIf(candidates.length > 1, "catalog-duplicate");
  failIf(candidates.length !== 1, "catalog-model");
  return candidates[0];
}

function validateQuotaItem(item) {
  assertKnownKeys(item, ["currentValue", "limit", "name", "nextResetTime", "quotaPeriod", "status", "unit"], "model-quota");
  assertRequiredKeys(item, ["currentValue", "limit", "name", "status", "unit"], "model-quota");
  assertKnownKeys(item.name, ["localizedValue", "value"], "model-quota");
  assertRequiredKeys(item.name, ["localizedValue", "value"], "model-quota");
  failIf(
    typeof item.name.value !== "string" ||
      typeof item.name.localizedValue !== "string" ||
      item.unit !== MODEL_BOOTSTRAP_CONTRACT.quotaUnit ||
      !Number.isSafeInteger(item.currentValue) ||
      !Number.isSafeInteger(item.limit) ||
      item.currentValue < 0 ||
      item.limit < item.currentValue ||
      item.status !== null,
    "model-quota",
  );
  return {
    nameValue: item.name.value,
    localizedValue: item.name.localizedValue,
    unit: item.unit,
    currentValue: item.currentValue,
    limit: item.limit,
    available: item.limit - item.currentValue,
  };
}

function verifyQuota(config, outputs, catalogReceipt) {
  const quota = azJson(config, [
    "cognitiveservices",
    "usage",
    "list",
    "--location",
    outputs.region,
    "--subscription",
    config.account.subscription,
    "--output",
    "json",
  ], "model-quota");
  const entries = pagedAzureList(quota, "model-quota");
  const descriptors = entries.map(validateQuotaItem);
  const expectedName = `OpenAI.${MODEL_BOOTSTRAP_CONTRACT.sku}.${MODEL_BOOTSTRAP_CONTRACT.lunaDeployment}`;
  const exact = descriptors.filter((descriptor) => descriptor.nameValue === expectedName);
  failIf(exact.length > 1, "quota-duplicate");
  failIf(exact.length !== 1, "quota-unreleased");
  const selected = exact[0];
  failIf(
    selected.localizedValue !==
      `${MODEL_BOOTSTRAP_CONTRACT.quotaLocalizedPrefix}${MODEL_BOOTSTRAP_CONTRACT.lunaDeployment} - ${MODEL_BOOTSTRAP_CONTRACT.sku}`,
    "model-quota",
  );
  failIf(selected.available < MODEL_BOOTSTRAP_CONTRACT.lunaCapacity, "quota-unreleased");
  failIf(
    catalogReceipt.modelName !== MODEL_BOOTSTRAP_CONTRACT.lunaDeployment ||
      catalogReceipt.sku !== MODEL_BOOTSTRAP_CONTRACT.sku,
    "quota-context",
  );
  return selected;
}

function verifyModelMetadata(config, outputs) {
  const accountContext = verifyAccountContext(config, outputs);
  showLunaDeployment(config, outputs);
  const deployments = verifyDeploymentMetadata(config, outputs);
  const catalog = verifyCatalog(config, outputs, accountContext);
  const quota = verifyQuota(config, outputs, catalog);
  const deploymentReceipt = deployments.map((deployment) => ({
    name: deployment.name,
    modelName: deployment.modelName,
    version: deployment.version,
    format: deployment.format,
    sku: deployment.sku,
    capacity: deployment.capacity,
    provisioningState: deployment.provisioningState,
    versionUpgradeOption: deployment.versionUpgradeOption,
  }));
  const catalogReceipt = {
    region: accountContext.location,
    kind: catalog.kind,
    format: catalog.format,
    modelName: catalog.modelName,
    version: catalog.version,
    sku: catalog.sku,
  };
  const quotaReceipt = {
    region: accountContext.location,
    provider: "OpenAI",
    sku: MODEL_BOOTSTRAP_CONTRACT.sku,
    modelName: MODEL_BOOTSTRAP_CONTRACT.lunaDeployment,
    unit: quota.unit,
    currentValue: quota.currentValue,
    limit: quota.limit,
    available: quota.available,
  };
  return {
    deploymentsSha256: hashJson(deploymentReceipt),
    catalogSha256: hashJson(catalogReceipt),
    quotaSha256: hashJson(quotaReceipt),
  };
}

function exactModelDeployment(descriptor, expected) {
  return descriptor.name === expected.name &&
    descriptor.modelName === expected.modelName &&
    descriptor.version === expected.version &&
    descriptor.format === MODEL_BOOTSTRAP_CONTRACT.format &&
    descriptor.sku === MODEL_BOOTSTRAP_CONTRACT.sku &&
    descriptor.capacity === expected.capacity &&
    descriptor.provisioningState === "Succeeded" &&
    descriptor.versionUpgradeOption === MODEL_BOOTSTRAP_CONTRACT.upgradeOption;
}

function readModelDeploymentState(config, outputs) {
  verifyAccountContext(config, outputs);
  const deploymentList = azJson(config, [
    "cognitiveservices",
    "account",
    "deployment",
    "list",
    "--name",
    outputs.account,
    "--resource-group",
    outputs.foundryResourceGroup,
    "--subscription",
    config.account.subscription,
    "--output",
    "json",
  ], "reconcile-model-deployments");
  const entries = pagedAzureList(deploymentList, "reconcile-model-deployments");
  const deployments = entries.map((item) => validateDeploymentItem(item, outputs, config));
  const names = new Set();
  for (const deployment of deployments) {
    failIf(names.has(deployment.name), "reconcile-model-deployments");
    names.add(deployment.name);
  }
  return deployments;
}

function inspectModelBootstrapPre(config, outputs) {
  const deployments = readModelDeploymentState(config, outputs);
  failIf(deployments.length !== 1, "reconcile-model-pre");
  failIf(
    !exactModelDeployment(deployments[0], {
      name: MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment,
      modelName: MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment,
      version: MODEL_BOOTSTRAP_CONTRACT.transcriptionVersion,
      capacity: MODEL_BOOTSTRAP_CONTRACT.transcriptionCapacity,
    }),
    "reconcile-model-pre",
  );
  // A list that omits Luna is not sufficient evidence of absence: retain the
  // existing not-found check for the exact predecessor classification.
  showLunaDeployment(config, outputs);
  return true;
}

function inspectModelBootstrapPost(config, outputs) {
  const deployments = readModelDeploymentState(config, outputs);
  failIf(deployments.length !== 2, "reconcile-model-post");
  const transcription = deployments.find(
    (deployment) => deployment.name === MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment,
  );
  const luna = deployments.find(
    (deployment) => deployment.name === MODEL_BOOTSTRAP_CONTRACT.lunaDeployment,
  );
  failIf(
    !transcription ||
      !luna ||
      !exactModelDeployment(transcription, {
        name: MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment,
        modelName: MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment,
        version: MODEL_BOOTSTRAP_CONTRACT.transcriptionVersion,
        capacity: MODEL_BOOTSTRAP_CONTRACT.transcriptionCapacity,
      }) ||
      !exactModelDeployment(luna, {
        name: MODEL_BOOTSTRAP_CONTRACT.lunaDeployment,
        modelName: MODEL_BOOTSTRAP_CONTRACT.lunaDeployment,
        version: MODEL_BOOTSTRAP_CONTRACT.lunaVersion,
        capacity: MODEL_BOOTSTRAP_CONTRACT.lunaCapacity,
      }),
    "reconcile-model-post",
  );
  return true;
}

function assertArtifactEnvelope(filePath, code, expected = {}) {
  const value = readJson(filePath, code);
  failIf(!isObject(value), code);
  for (const [key, expectedValue] of Object.entries(expected)) {
    failIf(value[key] !== expectedValue, `${code}-context`);
  }
  const digest = value.sha256;
  failIf(!isSha(digest), `${code}-hash`);
  const unsigned = { ...value };
  delete unsigned.sha256;
  failIf(digest !== hashJson(unsigned), `${code}-hash`);
  return { value, digest, fileSha256: sha256File(filePath) };
}

function assertReceiptContext(value, manifest, code) {
  failIf(
    value.repositoryCommit !== manifest.bindings.repositoryCommit ||
      value.contextSha256 !== manifest.bindingSha256 ||
      value.createdAt !== manifest.createdAt,
    `${code}-context`,
  );
}

function assertExactReceipt(filePath, code, manifest, expected) {
  const checked = assertArtifactEnvelope(filePath, code, {
    version: 2,
    runId: manifest.runId,
    phase: manifest.phase,
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    ...expected,
  });
  assertReceiptContext(checked.value, manifest, code);
  return checked;
}

function reviewedRuntimeDigest(manifest, artifacts) {
  failIf(!manifest || !artifacts, "diagnostic-plan-context");
  return hashJson({
    planSha256: manifest.planSha256,
    bindingSha256: manifest.bindingSha256,
    argv: manifest.argv,
    showSha256: sha256File(artifacts.show, JSON_MAX_BYTES),
  });
}

function canonicalRuntimeContainer(container, code) {
  assertKnownKeys(container, ["name", "image", "env", "resources", "probes", "command", "args"], code);
  assertRequiredKeys(container, ["name", "image"], code);
  failIf(typeof container.name !== "string" || !/^[-a-z0-9]{1,63}$/i.test(container.name), code);
  failIf(typeof container.image !== "string" || !/^.+@sha256:[a-f0-9]{64}$/i.test(container.image), code);
  const env = container.env === undefined ? [] : container.env;
  assertEnvironmentEntries(env, code);
  const values = env.map((entry) => ({
    name: entry.name,
    ...(entry.value === undefined ? {} : { value: entry.value }),
    ...(entry.secretRef === undefined ? {} : { secretRef: entry.secretRef }),
  }));
  failIf(new Set(values.map((entry) => entry.name)).size !== values.length, code);
  const resources = container.resources === undefined ? undefined : container.resources;
  if (resources !== undefined) {
    assertKnownKeys(resources, ["cpu", "memory"], code);
    assertRequiredKeys(resources, ["cpu", "memory"], code);
  }
  return {
    name: container.name,
    image: container.image,
    env: values,
    ...(container.command === undefined ? {} : { command: [...container.command] }),
    ...(container.args === undefined ? {} : { args: [...container.args] }),
    ...(container.probes === undefined ? {} : { probes: structuredClone(container.probes) }),
    ...(resources === undefined ? {} : { resources }),
  };
}

function canonicalRuntimeTemplate(template, code) {
  assertContainerTemplate(template, code);
  failIf(template.revisionSuffix !== undefined || template.volumes !== undefined, code);
  const containers = template.containers.map((container) => canonicalRuntimeContainer(container, code));
  failIf(new Set(containers.map((container) => container.name)).size !== containers.length, code);
  let scale;
  if (template.scale !== undefined) {
    assertKnownKeys(template.scale, ["minReplicas", "maxReplicas"], code);
    assertRequiredKeys(template.scale, ["minReplicas", "maxReplicas"], code);
    scale = {
      minReplicas: template.scale.minReplicas,
      maxReplicas: template.scale.maxReplicas,
    };
  }
  return {
    containers,
    ...(scale === undefined ? {} : { scale }),
  };
}

function projectRuntimeTemplateEnvironment(template, compareEnvironmentValues) {
  if (compareEnvironmentValues) return template;
  return {
    ...template,
    containers: template.containers.map((container) => ({
      ...container,
      env: container.env.map((entry) => ({
        name: entry.name,
        ...(entry.secretRef === undefined ? {} : { secretRef: entry.secretRef }),
      })),
    })),
  };
}

function canonicalRuntimeIdentity(value, code) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    failIf(value.length !== 1, code);
    return canonicalRuntimeIdentity(value[0], code);
  }
  if (Array.isArray(value.identity_ids)) {
    assertKnownKeys(value, ["identity_ids", "principal_id", "tenant_id", "type"], code);
    assertRequiredKeys(value, ["identity_ids", "type"], code);
    failIf(value.type !== "UserAssigned" || value.identity_ids.length === 0, code);
    const identities = value.identity_ids.map(identityKey).sort();
    failIf(new Set(identities).size !== identities.length, code);
    return { type: value.type, userAssignedIdentities: identities };
  }
  assertKnownKeys(value, ["type", "userAssignedIdentities"], code);
  assertRequiredKeys(value, ["type", "userAssignedIdentities"], code);
  failIf(typeof value.type !== "string" || !isObject(value.userAssignedIdentities), code);
  const identities = Object.keys(value.userAssignedIdentities).map(identityKey).sort();
  failIf(identities.length === 0 || new Set(identities).size !== identities.length, code);
  return { type: value.type, userAssignedIdentities: identities };
}

function canonicalRuntimeShape(value, code) {
  failIf(!isObject(value), code);
  const body = isObject(value.body) ? value.body : value;
  const properties = isObject(body.properties) ? body.properties : body;
  const configuration = isObject(properties.configuration) ? properties.configuration : {};
  const template = properties.template;
  failIf(!isObject(template) || !Array.isArray(template.containers), code);
  const containers = template.containers.map((container) => canonicalRuntimeContainer(container, code));
  failIf(containers.length === 0 || new Set(containers.map((entry) => entry.name)).size !== containers.length, code);
  const normalizeIdentity = (value) => typeof value === "string" ? identityKey(value) : value;
  const registries = configuration.registries === undefined ? [] : configuration.registries.map((registry) => {
    assertKnownKeys(registry, ["server", "identity", "username", "passwordSecretRef"], code);
    assertRequiredKeys(registry, ["server", "identity"], code);
    failIf(typeof registry.server !== "string" || !/^[a-z0-9-]{5,50}\.azurecr\.io$/i.test(registry.server), code);
    return {
      server: registry.server.toLowerCase(),
      identity: normalizeIdentity(registry.identity),
      ...(registry.username === undefined ? {} : { username: registry.username }),
      ...(registry.passwordSecretRef === undefined ? {} : { passwordSecretRef: registry.passwordSecretRef }),
    };
  });
  const secrets = configuration.secrets === undefined ? [] : configuration.secrets.map((secret) => {
    assertKnownKeys(secret, ["name", "keyVaultUrl", "identity"], code);
    assertRequiredKeys(secret, ["name", "keyVaultUrl", "identity"], code);
    failIf(typeof secret.name !== "string" || typeof secret.keyVaultUrl !== "string", code);
    return { name: secret.name, keyVaultUrl: secret.keyVaultUrl, identity: normalizeIdentity(secret.identity) };
  });
  const identitySettings = configuration.identitySettings === undefined ? [] : configuration.identitySettings.map((setting) => {
    assertKnownKeys(setting, ["identity", "lifecycle"], code);
    assertRequiredKeys(setting, ["identity", "lifecycle"], code);
    return { identity: normalizeIdentity(setting.identity), lifecycle: setting.lifecycle };
  });
  const ingress = isObject(configuration.ingress) ? {
    external: configuration.ingress.external,
    targetPort: configuration.ingress.targetPort,
    transport: configuration.ingress.transport,
    allowInsecure: configuration.ingress.allowInsecure,
    traffic: Array.isArray(configuration.ingress.traffic)
      ? configuration.ingress.traffic.map((traffic) => ({
          ...(traffic.revisionName === undefined ? {} : { revisionName: traffic.revisionName }),
          ...(traffic.latestRevision === undefined ? {} : { latestRevision: traffic.latestRevision }),
          weight: traffic.weight,
        }))
      : [],
  } : undefined;
  const scale = isObject(template.scale) ? {
    minReplicas: template.scale.minReplicas,
    maxReplicas: template.scale.maxReplicas,
  } : undefined;
  const identity = canonicalRuntimeIdentity(body.identity ?? value.identity, code);
  return {
    containers,
    ...(scale === undefined ? {} : { scale }),
    ...(configuration.maxInactiveRevisions === undefined ? {} : { maxInactiveRevisions: configuration.maxInactiveRevisions }),
    ...(ingress === undefined ? {} : { ingress }),
    registries,
    secrets,
    identitySettings,
    ...(identity === undefined ? {} : { identity }),
  };
}

function diagnosticPlanEnvironment(entries, code) {
  failIf(!Array.isArray(entries) || entries.length !== DIAGNOSTIC_JOB_ENV_NAMES.length, code);
  const names = new Set();
  return entries.map((entry, index) => {
    assertKnownKeys(entry, ["name", "value"], code);
    assertRequiredKeys(entry, ["name", "value"], code);
    failIf(
      entry.name !== DIAGNOSTIC_JOB_ENV_NAMES[index] ||
        names.has(entry.name) ||
        typeof entry.value !== "string" ||
        entry.value.length === 0 ||
        entry.value.trim() !== entry.value,
      code,
    );
    names.add(entry.name);
    if (entry.name === "AZURE_CLIENT_ID") {
      failIf(!UUID_RE.test(entry.value), code);
    } else if (entry.name === "PALANCAR_WORKLOAD_TABLE_ENDPOINT") {
      let endpoint;
      try {
        endpoint = new URL(entry.value);
      } catch {
        reject(code);
      }
      failIf(
        endpoint.protocol !== "https:" ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash ||
          !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?\.table\.core\.windows\.net$/i.test(endpoint.hostname) ||
          (endpoint.pathname !== "/" && endpoint.pathname !== ""),
        code,
      );
    } else if (entry.name === "PALANCAR_SECURITY_STATE_TABLE") {
      failIf(entry.value !== "SecurityState", code);
    } else if (entry.name === "PALANCAR_RATE_STATE_TABLE") {
      failIf(entry.value !== "RateState", code);
    } else if (entry.name === "PALANCAR_RELAY_ENVIRONMENT") {
      failIf(entry.value !== "dev", code);
    } else if (entry.name === "PALANCAR_RELAY_ORIGIN") {
      let origin;
      try {
        origin = new URL(entry.value);
      } catch {
        reject(code);
      }
      failIf(
        origin.protocol !== "wss:" ||
          origin.username ||
          origin.password ||
          origin.search ||
          origin.hash ||
          origin.pathname !== "/" ||
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+azurecontainerapps\.io$/i.test(origin.hostname),
        code,
      );
    } else if (entry.name === "PALANCAR_EXPIRY_CLEANUP_LIMIT") {
      failIf(entry.value !== "1000", code);
    } else if (entry.name === "PALANCAR_EXPIRY_CLEANUP_TIMEOUT_MS") {
      failIf(entry.value !== "240000", code);
    }
    return { name: entry.name, value: entry.value };
  });
}

function diagnosticPlanCleanupJob(value, code) {
  assertKnownKeys(value, [
    "body", "create_headers", "create_query_parameters", "delete_headers", "delete_query_parameters",
    "id", "identity", "ignore_body_changes", "ignore_casing", "ignore_missing_property",
    "ignore_null_property", "ignore_other_items_in_list", "list_unique_id_property", "location", "locks",
    "name", "output", "parent_id", "read_headers", "read_query_parameters", "replace_triggers_external_values",
    "replace_triggers_refs", "response_export_values", "retry", "schema_validation_enabled", "sensitive_body",
    "sensitive_body_version", "tags", "timeouts", "type", "update_headers", "update_query_parameters",
  ], code);
  assertRequiredKeys(value, [
    "body", "create_headers", "create_query_parameters", "delete_headers", "delete_query_parameters",
    "id", "identity", "ignore_body_changes", "ignore_casing", "ignore_missing_property",
    "ignore_null_property", "ignore_other_items_in_list", "list_unique_id_property", "location", "locks",
    "name", "output", "parent_id", "read_headers", "read_query_parameters", "replace_triggers_external_values",
    "replace_triggers_refs", "response_export_values", "retry", "schema_validation_enabled", "sensitive_body",
    "sensitive_body_version", "tags", "timeouts", "type", "update_headers", "update_query_parameters",
  ], code);
  failIf(
    typeof value.id !== "string" ||
      value.type !== "Microsoft.App/jobs@2026-01-01" ||
      typeof value.name !== "string" ||
      typeof value.location !== "string" ||
      typeof value.parent_id !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value.name) ||
      !/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+$/.test(value.parent_id) ||
      value.id !== `${value.parent_id}/providers/Microsoft.App/jobs/${value.name}`,
    code,
  );
  assertDiagnosticJobTags(value.tags, code);
  const identity = value.identity;
  failIf(!Array.isArray(identity) || identity.length !== 1, code);
  assertKnownKeys(identity[0], ["identity_ids", "principal_id", "tenant_id", "type"], code);
  assertRequiredKeys(identity[0], ["identity_ids", "principal_id", "tenant_id", "type"], code);
  failIf(
    identity[0].type !== "UserAssigned" ||
      identity[0].principal_id !== "" ||
      identity[0].tenant_id !== "" ||
      !Array.isArray(identity[0].identity_ids) ||
      identity[0].identity_ids.length !== 2,
    code,
  );
  const identityIds = identity[0].identity_ids.map((identityId) => identityKey(identityId, code));
  failIf(new Set(identityIds).size !== identityIds.length, code);
  const body = value.body;
  assertKnownKeys(body, ["properties"], code);
  assertRequiredKeys(body, ["properties"], code);
  const properties = body.properties;
  assertKnownKeys(properties, ["environmentId", "configuration", "template"], code);
  assertRequiredKeys(properties, ["environmentId", "configuration", "template"], code);
  failIf(typeof properties.environmentId !== "string", code);
  const configuration = properties.configuration;
  assertKnownKeys(configuration, [
    "triggerType", "scheduleTriggerConfig", "replicaRetryLimit", "replicaTimeout",
    "registries", "identitySettings",
  ], code);
  assertRequiredKeys(configuration, [
    "triggerType", "scheduleTriggerConfig", "replicaRetryLimit", "replicaTimeout",
    "registries", "identitySettings",
  ], code);
  failIf(configuration.triggerType !== "Schedule" || configuration.replicaRetryLimit !== 0 || configuration.replicaTimeout !== 300, code);
  const schedule = configuration.scheduleTriggerConfig;
  assertKnownKeys(schedule, ["cronExpression", "replicaCompletionCount", "parallelism"], code);
  assertRequiredKeys(schedule, ["cronExpression", "replicaCompletionCount", "parallelism"], code);
  failIf(schedule.cronExpression !== "0 3 * * *" || schedule.replicaCompletionCount !== 1 || schedule.parallelism !== 1, code);
  failIf(!Array.isArray(configuration.registries) || configuration.registries.length !== 1, code);
  const registry = configuration.registries[0];
  assertKnownKeys(registry, ["server", "identity"], code);
  assertRequiredKeys(registry, ["server", "identity"], code);
  failIf(typeof registry.server !== "string" || !/^[a-z0-9-]{5,50}\.azurecr\.io$/i.test(registry.server), code);
  const imagePull = identityKey(registry.identity, code);
  failIf(!identityIds.includes(imagePull), code);
  const runtimeIds = identityIds.filter((identityId) => identityId !== imagePull);
  failIf(runtimeIds.length !== 1, code);
  const runtime = runtimeIds[0];
  failIf(!Array.isArray(configuration.identitySettings) || configuration.identitySettings.length !== 2, code);
  const identitySettings = configuration.identitySettings.map((setting) => {
    assertKnownKeys(setting, ["identity", "lifecycle"], code);
    assertRequiredKeys(setting, ["identity", "lifecycle"], code);
    return { identity: identityKey(setting.identity, code), lifecycle: setting.lifecycle };
  });
  failIf(
    !same(identitySettings, [
      { identity: imagePull, lifecycle: "None" },
      { identity: runtime, lifecycle: "Main" },
    ]) ||
      !same(identitySettings.map((setting) => setting.identity).slice().sort(), identityIds.slice().sort()),
    code,
  );
  const template = properties.template;
  assertKnownKeys(template, ["containers"], code);
  assertRequiredKeys(template, ["containers"], code);
  failIf(!Array.isArray(template.containers) || template.containers.length !== 1, code);
  const container = template.containers[0];
  assertKnownKeys(container, ["name", "image", "resources", "env"], code);
  assertRequiredKeys(container, ["name", "image", "resources", "env"], code);
  failIf(container.name !== "expiry-cleanup" || typeof container.image !== "string", code);
  const resources = container.resources;
  assertKnownKeys(resources, ["cpu", "memory"], code);
  assertRequiredKeys(resources, ["cpu", "memory"], code);
  failIf(resources.cpu !== 0.25 || resources.memory !== "0.5Gi", code);
  const env = diagnosticPlanEnvironment(container.env, code);
  failIf(!new RegExp(`^${registry.server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/palancar-expiry-cleanup@sha256:[a-f0-9]{64}$`, "i").test(container.image), code);
  return {
    id: value.id,
    name: value.name,
    location: value.location,
    resourceGroup: value.parent_id.split("/")[4],
    image: container.image,
    env,
    registryServer: registry.server,
    identityIds: [imagePull, runtime],
  };
}

function sameDiagnosticPlanCleanupJob(left, right, code) {
  const normalize = (value) => {
    if (!isObject(value) || !Array.isArray(value.identity) || value.identity.length === 0 ||
        !isObject(value.identity[0]) || !Array.isArray(value.identity[0].identity_ids)) {
      return undefined;
    }
    const normalized = structuredClone(value);
    normalized.identity[0].identity_ids = normalized.identity[0].identity_ids
      .map((identityId) => identityKey(identityId, code))
      .sort();
    return normalized;
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  failIf(normalizedLeft === undefined || normalizedRight === undefined, code);
  return same(normalizedLeft, normalizedRight);
}

function reviewedDiagnosticJobShape(show, stateAddress) {
  const changeEntries = Array.isArray(show.resource_changes)
    ? show.resource_changes.filter((entry) => entry?.address === DIAGNOSTIC_JOB_ADDRESS)
    : [];
  failIf(changeEntries.length !== 1, "diagnostic-plan-topology");
  const change = changeEntries[0]?.change;
  failIf(!isObject(change) || !same(change.actions, ["no-op"]) || !isObject(change.before) || !isObject(change.after), "diagnostic-plan-topology");
  const prior = stateAddress(show.prior_state?.values?.root_module, DIAGNOSTIC_JOB_ADDRESS, DIAGNOSTIC_JOB_MODULE_ADDRESS, "diagnostic-plan-topology");
  const planned = stateAddress(show.planned_values?.root_module, DIAGNOSTIC_JOB_ADDRESS, DIAGNOSTIC_JOB_MODULE_ADDRESS, "diagnostic-plan-topology");
  failIf(prior === undefined || planned === undefined || !isObject(prior.values) || !isObject(planned.values), "diagnostic-plan-topology");
  failIf(
    !sameDiagnosticPlanCleanupJob(change.before, change.after, "diagnostic-plan-topology") ||
      !sameDiagnosticPlanCleanupJob(change.before, prior.values, "diagnostic-plan-topology") ||
      !sameDiagnosticPlanCleanupJob(change.before, planned.values, "diagnostic-plan-topology"),
    "diagnostic-plan-topology",
  );
  const before = diagnosticPlanCleanupJob(change.before, "diagnostic-plan-topology");
  const after = diagnosticPlanCleanupJob(change.after, "diagnostic-plan-topology");
  const priorShape = diagnosticPlanCleanupJob(prior.values, "diagnostic-plan-topology");
  const plannedShape = diagnosticPlanCleanupJob(planned.values, "diagnostic-plan-topology");
  failIf(
    !same(before, after) || !same(before, priorShape) || !same(before, plannedShape),
    "diagnostic-plan-topology",
  );
  const variableDigest = show.variables?.expiry_cleanup_image_digest?.value;
  failIf(variableDigest !== after.image, "diagnostic-plan-image");
  return after;
}

function reviewedRuntimeShapes(artifacts, phase, showOverride = undefined) {
  failIf(!["runtime-cutover", "credential-cleanup", "terminal"].includes(phase), "diagnostic-plan-phase");
  const show = showOverride ?? parseJsonText(boundedFileText(artifacts.show, JSON_MAX_BYTES, "show-json"), "show-json");
  const address = "module.container_app_workload[0].azapi_resource.this";
  const moduleAddress = "module.container_app_workload[0]";
  const stateAddress = (root, targetAddress, targetModuleAddress, code) => {
    failIf(!isObject(root), code);
    const rootMatches = (root.resources ?? []).filter((resource) => resource?.address === targetAddress);
    const moduleMatches = (root.child_modules ?? [])
      .filter((module) => module?.address === targetModuleAddress)
      .flatMap((module) => (module.resources ?? []).filter((resource) =>
        resource?.address === targetAddress || resource?.address === "azapi_resource.this"));
    const matches = [...rootMatches, ...moduleMatches];
    failIf(matches.length !== 1, code);
    return matches[0];
  };
  const changeEntries = Array.isArray(show.resource_changes)
    ? show.resource_changes.filter((entry) => entry?.address === address)
    : [];
  failIf(changeEntries.length !== 1, "diagnostic-plan-topology");
  const change = changeEntries[0]?.change;
  const expectedActions = phase === "runtime-cutover" ? ["update"] : ["no-op"];
  failIf(!isObject(change) || !same(change.actions, expectedActions) || !isObject(change.before) || !isObject(change.after), "diagnostic-plan-topology");
  const prior = stateAddress(show.prior_state?.values?.root_module, address, moduleAddress, "diagnostic-plan-topology");
  const planned = stateAddress(show.planned_values?.root_module, address, moduleAddress, "diagnostic-plan-topology");
  failIf(prior === undefined || planned === undefined || !isObject(prior.values) || !isObject(planned.values), "diagnostic-plan-topology");
  const before = canonicalRuntimeShape(change.before, "diagnostic-plan-topology");
  const after = canonicalRuntimeShape(change.after, "diagnostic-plan-topology");
  const priorShape = canonicalRuntimeShape(prior.values, "diagnostic-plan-topology");
  const plannedShape = canonicalRuntimeShape(planned.values, "diagnostic-plan-topology");
  if (phase === "runtime-cutover") {
    failIf(
      Object.hasOwn(before, "maxInactiveRevisions") || after.maxInactiveRevisions !== 1,
      "diagnostic-plan-topology",
    );
  } else {
    failIf(
      before.maxInactiveRevisions !== 1 || after.maxInactiveRevisions !== 1,
      "diagnostic-plan-topology",
    );
  }
  if (phase === "runtime-cutover") {
    failIf(!same(before, priorShape) || !same(after, plannedShape), "diagnostic-plan-topology");
  } else {
    failIf(!same(before, after) || !same(before, priorShape) || !same(before, plannedShape), "diagnostic-plan-topology");
  }
  const variableDigest = show.variables?.relay_image_digest?.value;
  const relay = after.containers.find((container) => container.name === "relay");
  failIf(relay === undefined || variableDigest !== relay.image, "diagnostic-plan-image");
  const cleanupJob = reviewedDiagnosticJobShape(show, stateAddress);
  return { before, after, image: relay.image, cleanupJob };
}

function reviewedRuntimeImage(artifacts) {
  return reviewedRuntimeShapes(artifacts, "runtime-cutover").image;
}

function assertGuardBoundImages(artifacts, phase, binding, acrLoginServer, show) {
  try {
    validateImagePlatformBinding(binding, acrLoginServer, "image-platform-verification");
    failIf(!isObject(show), "image-platform-verification");
    const relay = binding.images.find((image) => image.repository === "palancar-relay");
    const cleanup = binding.images.find((image) => image.repository === "palancar-expiry-cleanup");
    failIf(relay === undefined || cleanup === undefined, "image-platform-verification");
    failIf(show.variables?.relay_image_digest?.value !== relay.reference, "image-platform-verification");
    failIf(show.variables?.expiry_cleanup_image_digest?.value !== cleanup.reference, "image-platform-verification");

    const targetNames = new Map([
      ["module.container_app_workload[0].azapi_resource.this", "relay"],
      ["module.container_app_workload[0]", "relay"],
      ["module.expiry_cleanup_job[0].azapi_resource.this", "expiry-cleanup"],
      ["module.expiry_cleanup_job[0]", "expiry-cleanup"],
    ]);
    const expectedImages = new Map([
      ["relay", relay.reference],
      ["expiry-cleanup", cleanup.reference],
    ]);
    const walk = (value, target = undefined) => {
      if (Array.isArray(value)) {
        for (const child of value) walk(child, target);
        return;
      }
      if (!isObject(value)) return;
      const nextTarget = typeof value.address === "string" && targetNames.has(value.address)
        ? targetNames.get(value.address)
        : target;
      if (nextTarget !== undefined && Object.hasOwn(value, "name") && value.name === nextTarget && Object.hasOwn(value, "image")) {
        failIf(value.image !== expectedImages.get(nextTarget), "image-platform-verification");
      }
      for (const child of Object.values(value)) walk(child, nextTarget);
    };
    walk(show.resource_changes?.map((entry) => ({
      address: entry?.address,
      change: { after: entry?.change?.after },
    })));
    walk(show.planned_values);
    walk(show.configuration);

    if (["runtime-cutover", "credential-cleanup", "terminal"].includes(phase)) {
      const reviewed = reviewedRuntimeShapes(artifacts, phase, show);
      failIf(reviewed.image !== relay.reference || reviewed.cleanupJob.image !== cleanup.reference, "image-platform-verification");
    }
  } catch (error) {
    if (error instanceof LifecycleError && [
      "image-platform-verification", "image-platform-binding", "diagnostic-plan-image", "diagnostic-plan-topology",
    ].includes(error.code)) {
      reject("image-platform-verification");
    }
    throw error;
  }
}

function validateDiagnosticIdentity(value, manifest, job, code) {
  assertKnownKeys(value, ["resourceId", "principalId", "clientId", "planSha256", "job"], code);
  assertRequiredKeys(value, ["resourceId", "principalId", "clientId", "planSha256", "job"], code);
  assertKnownKeys(value.job, ["requestId", "executionName"], code);
  assertRequiredKeys(value.job, ["requestId", "executionName"], code);
  const resourceId = canonicalResourceId(value.resourceId, manifest.bindings.runtimeIdentityId, code);
  failIf(
    value.principalId !== manifest.bindings.runtimeIdentityPrincipalId ||
    !UUID_RE.test(value.principalId) ||
    value.clientId !== manifest.bindings.runtimeIdentityClientId ||
    !UUID_RE.test(value.clientId) ||
    value.planSha256 !== manifest.planSha256 ||
    value.job.requestId !== job.requestId ||
    value.job.executionName !== job.executionName,
    code,
  );
  return { ...value, resourceId };
}

function validateDiagnosticOpenAiRole(value, manifest, principalId, code) {
  assertKnownKeys(value, ["id", "principalId", "principalType", "roleDefinitionId", "scope"], code);
  assertRequiredKeys(value, ["id", "principalId", "principalType", "roleDefinitionId", "scope"], code);
  const expectedScope = manifest.bindings.accountId;
  const expectedPrincipalId = manifest.bindings.runtimeIdentityPrincipalId;
  const expectedRole = roleDefinitionResourceId(
    manifest.bindings.backend.subscription_id,
    ENTRA_ROLES.openAiUser,
  );
  const assignmentPrefix = `${expectedScope}/providers/Microsoft.Authorization/roleAssignments/`;
  failIf(
    principalId !== expectedPrincipalId ||
      value.principalId !== expectedPrincipalId ||
      value.principalType !== "ServicePrincipal" ||
      value.roleDefinitionId !== expectedRole ||
      value.scope !== expectedScope ||
      typeof value.id !== "string" || !value.id.startsWith(assignmentPrefix) ||
      !UUID_RE.test(value.id.slice(assignmentPrefix.length)) ||
      value.id !== manifest.bindings.runtimeOpenAiRoleAssignmentId,
    code,
  );
  return value;
}

function requiredDiagnostic(request) {
  const manifest = request.manifest;
  failIf(!manifest, "diagnostic-receipt-context");
  const checked = assertExactReceipt(request.artifacts.diagnostic, "diagnostic-receipt", manifest, {
    type: "diagnostic",
    status: "passed",
    operation: "runtime-cutover-diagnostic",
    imageDigest: reviewedRuntimeImage(request.artifacts),
    digestCount: 1,
  });
  const value = checked.value;
  assertKnownKeys(value, [
    "version", "type", "status", "operation", "runId", "phase", "planSha256", "bindingSha256",
    "createdAt", "repositoryCommit", "contextSha256", "reviewedDigest", "imageDigest", "digestCount",
    "submission", "request", "activity", "execution", "identity", "openAiRole", "runtimeSecretReferences", "sha256",
  ], "diagnostic-receipt-schema");
  assertRequiredKeys(value, ["reviewedDigest", "submission", "request", "activity", "execution", "identity", "openAiRole"], "diagnostic-receipt-schema");
  failIf(value.reviewedDigest !== reviewedRuntimeDigest(manifest, request.artifacts), "diagnostic-plan-context");
  assertKnownKeys(value.submission, ["requestId", "executionName", "artifactSha256"], "diagnostic-submission");
  assertRequiredKeys(value.submission, ["requestId", "executionName", "artifactSha256"], "diagnostic-submission");
  assertKnownKeys(value.request, ["requestId", "operation", "argv"], "diagnostic-request");
  assertRequiredKeys(value.request, ["requestId", "operation", "argv"], "diagnostic-request");
  assertKnownKeys(value.activity, ["requestId", "status", "terminal"], "diagnostic-activity");
  assertRequiredKeys(value.activity, ["requestId", "status", "terminal"], "diagnostic-activity");
  assertKnownKeys(value.execution, ["baseline", "result", "retryCount", "exitCode", "terminalResult"], "diagnostic-execution");
  assertRequiredKeys(value.execution, ["baseline", "result", "retryCount", "exitCode", "terminalResult"], "diagnostic-execution");
  assertKnownKeys(value.identity, ["before", "after"], "diagnostic-identity");
  assertRequiredKeys(value.identity, ["before", "after"], "diagnostic-identity");
  assertKnownKeys(value.openAiRole, ["before", "after"], "diagnostic-openai-role");
  assertRequiredKeys(value.openAiRole, ["before", "after"], "diagnostic-openai-role");
  const identityBefore = value.identity.before;
  const identityAfter = value.identity.after;
  const roleBefore = value.openAiRole.before;
  const roleAfter = value.openAiRole.after;
  const job = {
    requestId: value.submission.requestId,
    executionName: value.submission.executionName,
  };
  const canonicalIdentityBefore = validateDiagnosticIdentity(identityBefore, manifest, job, "diagnostic-identity");
  const canonicalIdentityAfter = validateDiagnosticIdentity(identityAfter, manifest, job, "diagnostic-identity");
  failIf(!same(canonicalIdentityBefore, canonicalIdentityAfter), "diagnostic-identity-transition");
  validateDiagnosticOpenAiRole(roleBefore, manifest, canonicalIdentityBefore.principalId, "diagnostic-openai-role");
  validateDiagnosticOpenAiRole(roleAfter, manifest, canonicalIdentityAfter.principalId, "diagnostic-openai-role");
  failIf(!same(roleBefore, roleAfter), "diagnostic-openai-role-transition");
  failIf(
    value.imageDigest !== reviewedRuntimeImage(request.artifacts) ||
      !/^.+@sha256:[a-f0-9]{64}$/i.test(value.imageDigest) ||
      !isSha(value.reviewedDigest) ||
      !UUID_RE.test(value.submission.requestId) ||
      value.request.requestId !== value.submission.requestId ||
      value.request.operation !== "start" ||
      !same(value.request.argv, DIAGNOSTIC_COMMAND) ||
      value.activity.requestId !== value.submission.requestId ||
      value.activity.status !== "Succeeded" || value.activity.terminal !== true ||
      value.submission.artifactSha256 !== value.reviewedDigest ||
      typeof value.submission.executionName !== "string" || value.submission.executionName.length === 0 ||
      value.execution.baseline !== "pre-cutover" ||
      value.execution.result !== "passed" ||
      value.execution.retryCount !== 0 || value.execution.exitCode !== 0 ||
      value.execution.terminalResult !== "succeeded" ||
      !isObject(value.identity.before) || !isObject(value.identity.after) ||
      !isObject(value.openAiRole.before) || !isObject(value.openAiRole.after),
    "diagnostic-receipt-execution",
  );
  failIf(!Array.isArray(value.runtimeSecretReferences) || value.runtimeSecretReferences.length !== 0, "diagnostic-receipt-secret");
  failIf(
    Object.keys(value).some((key) => key !== "runtimeSecretReferences" && /token|password|api.?key/i.test(key)),
    "diagnostic-receipt-secret",
  );
  return checked;
}

function diagnosticJobIdentity(outputs, config, code = "diagnostic-job") {
  failIf(typeof outputs.expiryCleanupJobName !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(outputs.expiryCleanupJobName), code);
  const match = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/jobs\/([^/]+)$/.exec(
    outputs.expiryCleanupJobId ?? "",
  );
  failIf(match === null || match[1] !== config.account.subscription ||
    match[2] !== outputs.resourceGroup || match[3] !== outputs.expiryCleanupJobName, code);
  return { name: outputs.expiryCleanupJobName, id: outputs.expiryCleanupJobId };
}

function diagnosticManagedIdentity(config, identityId, expected = {}, code = "diagnostic-identity", fresh = false) {
  const value = azJson(config, [
    "identity", "show", "--ids", identityId,
    "--subscription", config.account.subscription, "--output", "json",
  ], code, { fresh });
  failIf(!isObject(value), code);
  const identity = {
    resourceId: value.id ?? value.resourceId,
    principalId: value.principalId,
    clientId: value.clientId,
  };
  const resourceId = canonicalResourceId(identity.resourceId, identityId, code);
  failIf(
    !UUID_RE.test(identity.principalId ?? "") ||
    !UUID_RE.test(identity.clientId ?? "") ||
    (expected.principalId !== undefined && identity.principalId !== expected.principalId) ||
    (expected.clientId !== undefined && identity.clientId !== expected.clientId),
    code,
  );
  return { ...identity, resourceId };
}

function diagnosticIdentity(config, outputs, manifest, job, proof = undefined, fresh = false) {
  const identity = proof ?? diagnosticManagedIdentity(
    config,
    outputs.runtimeIdentityId,
    {
      principalId: manifest.bindings.runtimeIdentityPrincipalId,
      clientId: outputs.runtimeIdentityClientId,
    },
    "diagnostic-identity",
    fresh,
  );
  return {
    ...identity,
    planSha256: manifest.planSha256,
    job,
  };
}

function diagnosticOpenAiRole(config, manifest, fresh = false) {
  const assignments = azJson(config, [
    "role", "assignment", "list", "--scope", manifest.bindings.accountId,
    "--assignee-object-id", manifest.bindings.runtimeIdentityPrincipalId,
    "--fill-principal-name", "false", "--fill-role-definition-name", "false",
    "-o", "json",
  ], "diagnostic-openai-role", { fresh });
  failIf(!Array.isArray(assignments), "diagnostic-openai-role");
  const projected = assignments.filter((assignment) => isObject(assignment)).map(projectRoleAssignmentSecurityFields);
  const expectedId = manifest.bindings.runtimeOpenAiRoleAssignmentId;
  const match = projected.find((assignment) => assignment.id === expectedId);
  failIf(match === undefined, "diagnostic-openai-role");
  return validateDiagnosticOpenAiRole(match, manifest, manifest.bindings.runtimeIdentityPrincipalId, "diagnostic-openai-role");
}

function diagnosticEnvironment(outputs, manifest, requestId) {
  return [
    { name: "AZURE_CLIENT_ID", value: outputs.runtimeIdentityClientId },
    { name: "PALANCAR_AZURE_GENERATION_ENDPOINT", value: assertHttpsEndpoint(outputs.foundryEndpoint, "diagnostic-job") },
    { name: "PALANCAR_AZURE_GENERATION_DEPLOYMENT", value: MODEL_BOOTSTRAP_CONTRACT.lunaDeployment },
    { name: "PALANCAR_DIAGNOSTIC_REQUEST_ID", value: requestId },
    { name: "PALANCAR_DIAGNOSTIC_RUN_ID", value: manifest.runId },
    { name: "PALANCAR_DIAGNOSTIC_PLAN_SHA256", value: manifest.planSha256 },
  ];
}

function diagnosticIpv4Address(value) {
  return isIP(value) === 4;
}

function canonicalAzureRegion(value, code) {
  failIf(typeof value !== "string" || !/^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(value), code);
  return value.toLowerCase().replace(/ /g, "");
}

function diagnosticIpv4ToInteger(value) {
  const [first, second, third, fourth] = value.split(".").map(Number);
  return ((((first * 256) + second) * 256 + third) * 256 + fourth) >>> 0;
}

function diagnosticGlobalIpv4Address(value) {
  if (!diagnosticIpv4Address(value)) return false;
  const address = diagnosticIpv4ToInteger(value);
  return !DIAGNOSTIC_NON_GLOBAL_IPV4_CIDRS.some((cidr) => {
    const [network, prefixText] = cidr.split("/");
    const prefix = Number(prefixText);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const first = (diagnosticIpv4ToInteger(network) & mask) >>> 0;
    const last = first + (2 ** (32 - prefix)) - 1;
    return address >= first && address <= last;
  });
}

function assertDiagnosticEventStreamEndpoint(value, outputs, job, config, code) {
  failIf(typeof value !== "string" || value.length === 0 || value.trim() !== value, code);
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    reject(code);
  }
  failIf(
    endpoint.protocol !== "https:" ||
      endpoint.port !== "" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.azurecontainerapps\.dev$/i.test(endpoint.hostname) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== `/subscriptions/${config.account.subscription}/resourceGroups/${outputs.resourceGroup}/containerApps/${job.name}/eventstream`,
    code,
  );
}

function assertDiagnosticJobTags(value, code) {
  assertKnownKeys(value, Object.keys(DIAGNOSTIC_JOB_TAGS), code);
  assertRequiredKeys(value, Object.keys(DIAGNOSTIC_JOB_TAGS), code);
  failIf(!same(value, DIAGNOSTIC_JOB_TAGS), code);
}

function parseAzureSystemDataTimestamp(value, code) {
  failIf(typeof value !== "string", code);
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})?$/u.exec(value);
  failIf(match === null, code);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const suffix = match[8];
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  failIf(
    month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonth[month - 1] ||
      hour > 23 ||
      minute > 59 ||
      second > 59,
    code,
  );
  failIf(suffix === undefined && fraction.length !== 7, code);

  let offsetMinutes = 0;
  if (suffix !== undefined && suffix !== "Z") {
    const offsetMatch = /^([+-])([0-9]{2}):([0-9]{2})$/u.exec(suffix);
    failIf(offsetMatch === null, code);
    const offsetHours = Number(offsetMatch[2]);
    const offsetMinutePart = Number(offsetMatch[3]);
    failIf(
      offsetHours > 14 ||
        offsetMinutePart > 59 ||
        (offsetHours === 14 && offsetMinutePart !== 0),
      code,
    );
    offsetMinutes = (offsetMatch[1] === "+" ? 1 : -1) *
      (offsetHours * 60 + offsetMinutePart);
  }

  const utcDate = new Date(0);
  utcDate.setUTCFullYear(year, month - 1, day);
  utcDate.setUTCHours(hour, minute, second, 0);
  const epochMilliseconds = utcDate.getTime() - offsetMinutes * 60 * 1000;
  return BigInt(epochMilliseconds) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
}

function assertDiagnosticSystemData(value, code) {
  const keys = [
    "createdAt", "createdBy", "createdByType",
    "lastModifiedAt", "lastModifiedBy", "lastModifiedByType",
  ];
  assertKnownKeys(value, keys, code);
  assertRequiredKeys(value, keys, code);
  failIf(keys.some((key) => !validRevocationString(value[key], 256) || /[\u0080-\u009f]/u.test(value[key])), code);
  const createdAt = parseAzureSystemDataTimestamp(value.createdAt, code);
  const lastModifiedAt = parseAzureSystemDataTimestamp(value.lastModifiedAt, code);
  failIf(
    value.createdByType !== "User" ||
      value.lastModifiedByType !== "User" ||
      createdAt > lastModifiedAt ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.createdBy) ||
      value.createdBy !== value.lastModifiedBy,
    code,
  );
}

function diagnosticJobContract(value, outputs, reviewed, config, identityProofs) {
  assertKnownKeys(value, ["id", "name", "location", "resourceGroup", "type", "identity", "properties", "tags", "systemData"], "diagnostic-job");
  assertRequiredKeys(value, ["id", "name", "location", "resourceGroup", "identity", "properties", "tags", "systemData"], "diagnostic-job");
  const job = diagnosticJobIdentity(outputs, config);
  const guardedJob = reviewed.cleanupJob;
  failIf(!isObject(guardedJob), "diagnostic-job");
  const liveLocation = canonicalAzureRegion(value.location, "diagnostic-job");
  const outputLocation = canonicalAzureRegion(outputs.region, "diagnostic-job");
  const reviewedLocation = canonicalAzureRegion(guardedJob.location, "diagnostic-job");
  failIf(
    value.id !== job.id ||
      value.name !== job.name ||
      liveLocation !== outputLocation ||
      value.resourceGroup !== outputs.resourceGroup ||
      value.type !== "Microsoft.App/jobs",
    "diagnostic-job",
  );
  failIf(
    guardedJob.id !== value.id ||
      guardedJob.name !== value.name ||
      reviewedLocation !== liveLocation ||
      guardedJob.resourceGroup !== value.resourceGroup ||
      !same(guardedJob.identityIds.slice().sort(), [
        identityKey(outputs.imagePullIdentityId),
        identityKey(outputs.runtimeIdentityId),
      ].sort()) ||
      guardedJob.registryServer !== reviewed.after.registries[0]?.server,
    "diagnostic-job",
  );
  assertDiagnosticJobTags(value.tags, "diagnostic-job");
  assertDiagnosticSystemData(value.systemData, "diagnostic-job");
  const properties = value.properties;
  assertKnownKeys(properties, ["environmentId", "configuration", "template", "provisioningState", "runningStatus", "eventStreamEndpoint", "outboundIpAddresses", "workloadProfileName"], "diagnostic-job");
  assertRequiredKeys(properties, ["environmentId", "configuration", "template", "provisioningState", "runningStatus", "eventStreamEndpoint", "outboundIpAddresses", "workloadProfileName"], "diagnostic-job");
  failIf(
    properties.environmentId !== outputs.containerAppEnvironmentId ||
      properties.provisioningState !== "Succeeded" ||
      properties.runningStatus !== "Ready" ||
      properties.workloadProfileName !== null ||
      !Array.isArray(properties.outboundIpAddresses) ||
      properties.outboundIpAddresses.length !== 1 ||
      new Set(properties.outboundIpAddresses).size !== properties.outboundIpAddresses.length ||
      !properties.outboundIpAddresses.every(diagnosticGlobalIpv4Address),
    "diagnostic-job",
  );
  assertDiagnosticEventStreamEndpoint(properties.eventStreamEndpoint, outputs, job, config, "diagnostic-job");
  const identity = value.identity;
  assertKnownKeys(identity, ["type", "userAssignedIdentities"], "diagnostic-job");
  assertRequiredKeys(identity, ["type", "userAssignedIdentities"], "diagnostic-job");
  failIf(identity.type !== "UserAssigned" || !isObject(identity.userAssignedIdentities), "diagnostic-job");
  const identityIds = Object.keys(identity.userAssignedIdentities).map(identityKey).sort();
  failIf(!same(identityIds, [identityKey(outputs.imagePullIdentityId), identityKey(outputs.runtimeIdentityId)].sort()), "diagnostic-job");
  failIf(!isObject(identityProofs) || !isObject(identityProofs.imagePull) || !isObject(identityProofs.runtime), "diagnostic-job");
  const expectedIdentityProofs = new Map([
    [identityKey(outputs.imagePullIdentityId), identityProofs.imagePull],
    [identityKey(outputs.runtimeIdentityId), identityProofs.runtime],
  ]);
  for (const identityId of identityIds) {
    const metadata = identity.userAssignedIdentities[Object.keys(identity.userAssignedIdentities).find((key) => identityKey(key) === identityId)];
    assertKnownKeys(metadata, ["clientId", "principalId"], "diagnostic-job");
    assertRequiredKeys(metadata, ["clientId", "principalId"], "diagnostic-job");
    const proof = expectedIdentityProofs.get(identityId);
    failIf(
      !isObject(proof) ||
        metadata.clientId !== proof.clientId ||
        metadata.principalId !== proof.principalId ||
        !UUID_RE.test(metadata.clientId) ||
        !UUID_RE.test(metadata.principalId),
      "diagnostic-job",
    );
  }
  const configuration = properties.configuration;
  assertKnownKeys(configuration, ["dapr", "eventTriggerConfig", "manualTriggerConfig", "triggerType", "scheduleTriggerConfig", "replicaRetryLimit", "replicaTimeout", "registries", "identitySettings", "secrets"], "diagnostic-job");
  assertRequiredKeys(configuration, ["dapr", "eventTriggerConfig", "manualTriggerConfig", "triggerType", "scheduleTriggerConfig", "replicaRetryLimit", "replicaTimeout", "registries", "identitySettings", "secrets"], "diagnostic-job");
  failIf(
    configuration.dapr !== null ||
      configuration.eventTriggerConfig !== null ||
      configuration.manualTriggerConfig !== null ||
      configuration.secrets !== null ||
      configuration.triggerType !== "Schedule" ||
      configuration.replicaRetryLimit !== 0 ||
      configuration.replicaTimeout !== 300,
    "diagnostic-job",
  );
  const schedule = configuration.scheduleTriggerConfig;
  assertKnownKeys(schedule, ["cronExpression", "replicaCompletionCount", "parallelism"], "diagnostic-job");
  assertRequiredKeys(schedule, ["cronExpression", "replicaCompletionCount", "parallelism"], "diagnostic-job");
  failIf(
    schedule.cronExpression !== "0 3 * * *" ||
      schedule.replicaCompletionCount !== 1 ||
      schedule.parallelism !== 1,
    "diagnostic-job",
  );
  failIf(!Array.isArray(configuration.registries) || configuration.registries.length !== 1, "diagnostic-job");
  const registry = configuration.registries[0];
  assertKnownKeys(registry, ["server", "identity", "username", "passwordSecretRef"], "diagnostic-job");
  assertRequiredKeys(registry, ["server", "identity", "username", "passwordSecretRef"], "diagnostic-job");
  failIf(
    registry.username !== "" ||
      registry.passwordSecretRef !== "" ||
      registry.server !== reviewed.after.registries[0]?.server ||
      identityKey(registry.identity) !== identityKey(outputs.imagePullIdentityId),
    "diagnostic-job",
  );
  failIf(!Array.isArray(configuration.identitySettings) || configuration.identitySettings.length !== 2 ||
    !same(configuration.identitySettings.map((setting) => {
      assertKnownKeys(setting, ["identity", "lifecycle"], "diagnostic-job");
      assertRequiredKeys(setting, ["identity", "lifecycle"], "diagnostic-job");
      return { identity: identityKey(setting.identity), lifecycle: setting.lifecycle };
    }), [
      { identity: identityKey(outputs.imagePullIdentityId), lifecycle: "None" },
      { identity: identityKey(outputs.runtimeIdentityId), lifecycle: "Main" },
    ]), "diagnostic-job");
  const template = properties.template;
  assertKnownKeys(template, ["containers", "initContainers", "volumes"], "diagnostic-job");
  assertRequiredKeys(template, ["containers", "initContainers", "volumes"], "diagnostic-job");
  failIf(template.initContainers !== null || template.volumes !== null ||
    !Array.isArray(template.containers) || template.containers.length !== 1, "diagnostic-job");
  const container = template.containers[0];
  assertKnownKeys(container, ["name", "image", "imageType", "env", "resources", "probes", "command", "args"], "diagnostic-job");
  assertRequiredKeys(container, ["name", "image", "imageType", "env", "resources"], "diagnostic-job");
  failIf(
    container.name !== "expiry-cleanup" ||
      container.imageType !== "ContainerImage" ||
      (container.command !== undefined && container.command !== null) ||
      (container.args !== undefined && container.args !== null) ||
      (container.probes !== undefined && container.probes !== null),
    "diagnostic-job",
  );
  const environment = assertEnvironmentEntries(container.env, "diagnostic-job");
  failIf(environment.some((entry) => Object.hasOwn(entry, "secretRef")), "diagnostic-job");
  failIf(!same(environment, guardedJob.env) || container.image !== guardedJob.image, "diagnostic-job");
  const resources = container.resources;
  assertKnownKeys(resources, ["cpu", "memory", "ephemeralStorage"], "diagnostic-job");
  assertRequiredKeys(resources, ["cpu", "memory", "ephemeralStorage"], "diagnostic-job");
  failIf(resources.cpu !== 0.25 || resources.memory !== "0.5Gi" || resources.ephemeralStorage !== "1Gi", "diagnostic-job");
  const expectedServer = reviewed.after.registries[0]?.server;
  const escapedServer = typeof expectedServer === "string"
    ? expectedServer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : "";
  failIf(!new RegExp(`^${escapedServer}/palancar-expiry-cleanup@sha256:[a-f0-9]{64}$`, "i").test(container.image), "diagnostic-job");
  return { value, job };
}

function immutableDiagnosticArtifact(value, type, manifest, outputs, reviewed, job, requestId, executionName = null) {
  assertKnownKeys(value, [
    "version", "type", "status", "runId", "phase", "planSha256", "bindingSha256",
    "repositoryCommit", "contextSha256", "requestId", "executionName", "job", "imageDigest",
    "argv", "containerName", "env", "identity", "openAiRole", "sha256",
  ], `diagnostic-${type}`);
  assertRequiredKeys(value, [
    "version", "type", "status", "runId", "phase", "planSha256", "bindingSha256",
    "repositoryCommit", "contextSha256", "requestId", "executionName", "job", "imageDigest",
    "argv", "containerName", "env", "identity", "openAiRole", "sha256",
  ], `diagnostic-${type}`);
  const unsigned = { ...value };
  delete unsigned.sha256;
  const code = `diagnostic-${type}`;
  failIf(value.version !== DIAGNOSTIC_REQUEST_VERSION || value.type !== `diagnostic-${type}` ||
    value.status !== (type === "intent" ? "reserved" : type === "invoking" ? "invoking" : "submitted") || value.runId !== manifest.runId ||
    value.phase !== "runtime-cutover" || value.planSha256 !== manifest.planSha256 ||
    value.bindingSha256 !== manifest.bindingSha256 || value.repositoryCommit !== manifest.bindings.repositoryCommit ||
    value.contextSha256 !== manifest.bindingSha256 || !UUID_RE.test(value.requestId) ||
    value.requestId !== requestId || value.executionName !== executionName ||
    !same(value.job, job) || value.imageDigest !== reviewed.image || !same(value.argv, DIAGNOSTIC_COMMAND) ||
    value.containerName !== DIAGNOSTIC_CONTAINER_NAME || !isSha(value.sha256) ||
    !same(value.env, diagnosticEnvironment(outputs, manifest, requestId)) || value.sha256 !== hashJson(unsigned), `${code}-context`);
  validateDiagnosticIdentity(value.identity, manifest, {
    requestId: value.requestId,
    executionName,
  }, `${code}-identity`);
  validateDiagnosticOpenAiRole(value.openAiRole, manifest, manifest.bindings.runtimeIdentityPrincipalId, `${code}-openai-role`);
  return value;
}

function diagnosticExecutionName(value, job, code) {
  failIf(!isObject(value), code);
  const name = value.name;
  const id = value.id;
  failIf(typeof name !== "string" || name.length === 0 ||
    typeof id !== "string" || !id.endsWith(`/jobs/${job.name}/executions/${name}`), code);
  return name;
}

function diagnosticExecutionState(value, job, code) {
  failIf(!isObject(value), code);
  const name = diagnosticExecutionName(value, job, code);
  const properties = isObject(value.properties) ? value.properties : {};
  const status = properties.status;
  const terminal = ["Succeeded", "Failed", "Canceled", "Stopped"].includes(status);
  return {
    name,
    status,
    terminal,
    passed: status === "Succeeded" &&
      (properties.result === undefined || properties.result === "passed") &&
      (properties.exitCode === undefined || properties.exitCode === 0),
    exitCode: properties.exitCode === undefined ? (status === "Succeeded" ? 0 : null) : properties.exitCode,
    result: properties.result === undefined ? (status === "Succeeded" ? "passed" : null) : properties.result,
  };
}

function diagnosticExecutionTemplate(value, expectedEnv, expectedImage, code) {
  failIf(!isObject(value) || !isObject(value.properties), code);
  const template = value.properties.template;
  assertKnownKeys(template, ["containers", "initContainers"], code);
  assertRequiredKeys(template, ["containers", "initContainers"], code);
  failIf(!Array.isArray(template.containers) || template.containers.length !== 1 ||
    !Array.isArray(template.initContainers) || template.initContainers.length !== 0, code);
  const container = template.containers[0];
  assertKnownKeys(container, ["args", "command", "env", "image", "imageType", "name", "resources"], code);
  assertRequiredKeys(container, ["args", "command", "env", "image", "imageType", "name", "resources"], code);
  failIf(container.name !== DIAGNOSTIC_CONTAINER_NAME || container.image !== expectedImage ||
    container.imageType !== "ContainerImage" ||
    !same(container.command, [DIAGNOSTIC_COMMAND[0]]) || !same(container.args, [DIAGNOSTIC_COMMAND[1]]) ||
    !same(container.env, expectedEnv), code);
  const resources = container.resources;
  assertKnownKeys(resources, ["cpu", "memory", "ephemeralStorage"], code);
  assertRequiredKeys(resources, ["cpu", "memory", "ephemeralStorage"], code);
  failIf(!same(resources, { cpu: 0.25, memory: "0.5Gi", ephemeralStorage: "" }), code);
  return container;
}

function diagnosticRestUrl(job) {
  return `${job.id}/executions?api-version=2025-07-01`;
}

function diagnosticNextLink(value, job, code) {
  failIf(typeof value !== "string" || value.length === 0, code);
  let parsed;
  try {
    parsed = new URL(value.startsWith("/") ? `https://management.azure.com${value}` : value);
  } catch {
    reject(code);
  }
  const expectedPath = `${new URL(job.id, "https://management.azure.com").pathname}/executions`;
  failIf(parsed.protocol !== "https:" || parsed.hostname !== "management.azure.com" ||
    parsed.username || parsed.password || parsed.hash || parsed.pathname !== expectedPath ||
    parsed.searchParams.getAll("api-version").length !== 1 ||
    parsed.searchParams.get("api-version") !== "2025-07-01", code);
  return parsed.href;
}

function diagnosticExecutionMatches(value, job, requestId, code) {
  const state = diagnosticExecutionState(value, job, code);
  const containers = value.properties?.template?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) return undefined;
  const env = containers[0].env;
  if (!Array.isArray(env)) return undefined;
  const requestEntry = env.find((entry) => entry?.name === "PALANCAR_DIAGNOSTIC_REQUEST_ID");
  return requestEntry?.value === requestId ? state : undefined;
}

function reconcileDiagnosticSubmission(config, job, requestId, deadline) {
  const baseUrl = diagnosticNextLink(diagnosticRestUrl(job), job, "diagnostic-execution-pagination");
  let url = baseUrl;
  const seenUrls = new Set();
  const matches = [];
  let observedEndOfPages = false;
  for (let page = 0; page < 32; page += 1) {
    if (config.now() > deadline) reject("diagnostic-execution-timeout");
    failIf(seenUrls.has(url), "diagnostic-execution-pagination");
    seenUrls.add(url);
    const result = runCommand(config, AZ_PATH, [
      "rest", "--method", "get", "--url", url, "--output", "json",
    ], { phase: "diagnostic", timeoutMs: COMMAND_TIMEOUT_MS });
    if (result.status === "ambiguous") reject("diagnostic-execution-unknown");
    if (result.status !== "success") reject("diagnostic-execution-query");
    if (config.now() > deadline) reject("diagnostic-execution-timeout");
    const pageValue = parseCommandJson(result, "diagnostic-execution-list");
    assertKnownKeys(pageValue, ["value", "nextLink"], "diagnostic-execution-list");
    assertRequiredKeys(pageValue, ["value", "nextLink"], "diagnostic-execution-list");
    failIf(!Array.isArray(pageValue.value), "diagnostic-execution-list");
    for (const item of pageValue.value) {
      const matched = diagnosticExecutionMatches(item, job, requestId, "diagnostic-execution-list");
      if (matched !== undefined) matches.push({ item, state: matched });
    }
    if (pageValue.nextLink === null) {
      observedEndOfPages = true;
      break;
    }
    url = diagnosticNextLink(pageValue.nextLink, job, "diagnostic-execution-pagination");
  }
  failIf(!observedEndOfPages, "diagnostic-execution-pagination");
  failIf(matches.length > 1, "diagnostic-execution-duplicate");
  failIf(matches.length === 0, "diagnostic-start-unknown");
  return matches[0];
}

const CLEANUP_DESCRIPTOR_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "planSha256", "bindingSha256", "contextSha256",
  "vaultResourceId", "vaultUri", "subscription", "tenant", "cloud", "callerIdentity",
  "targetNames", "startState", "supersession",
]);
const CLEANUP_OPERATION_KEYS = Object.freeze([
  "version", "type", "status", "operation", "runId", "phase", "planSha256", "bindingSha256",
  "createdAt", "repositoryCommit", "contextSha256", "runtimeSecretReferences", "utilitySha256",
  "vaultResourceId", "supersession", "sha256", "journalCommitmentPath", "sequence", "previousManifestSha256",
]);
const CLEANUP_OPERATION_HEAD_KEYS = Object.freeze([
  ...CLEANUP_OPERATION_KEYS, "manifestFilename", "manifestSha256", "previousHeadSha256", "headSha256",
]);
const CLEANUP_OPERATION_HEAD_ANCHOR_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "sequence", "manifestSha256", "headSha256",
  "previousAnchorSha256", "intentSha256", "anchorSha256",
]);
const CLEANUP_OPERATION_HEAD_INTENT_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "sequence", "manifestSha256", "previousHeadSha256",
  "previousAnchorSha256", "intentSha256",
]);
const CLEANUP_ABSENCE_KEYS = Object.freeze([
  "version", "type", "status", "operation", "runId", "phase", "planSha256", "bindingSha256",
  "createdAt", "repositoryCommit", "contextSha256", "inventory", "supersession", "preflightReceiptSha256",
  "preflightVerifierId", "preflightVerifierSha256", "mutationTailSequence", "mutationTailSha256", "sha256",
]);
const CLEANUP_STATE_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "sequence", "status", "attempts", "cumulativeElapsedMs",
  "attemptStartedAt", "operationStartedAt", "accountingCursor", "retryNotBefore", "absenceReceiptSha256",
  "manifestSha256", "inventory", "inventorySha256", "previousStateSha256", "stateSha256",
  "mutationTailSequence", "mutationTailSha256", "preflightReceiptSha256", "preflightVerifierId",
  "preflightVerifierSha256",
]);
const CLEANUP_STATE_ANCHOR_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "stateSequence", "stateSha256", "stateFileSha256",
  "manifestSha256", "anchorSha256", "absenceReceiptSha256", "mutationTailSequence", "mutationTailSha256",
  "preflightReceiptSha256", "preflightVerifierId", "preflightVerifierSha256",
]);
const CLEANUP_JOURNAL_HEAD_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "stateSequence", "stateSha256", "stateFileSha256",
  "manifestSha256", "previousHeadSha256", "headSha256", "absenceReceiptSha256", "mutationTailSequence",
  "mutationTailSha256", "preflightReceiptSha256", "preflightVerifierId", "preflightVerifierSha256",
]);
const CLEANUP_JOURNAL_COMMITMENT_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "latestSequence", "stateSha256", "stateFileSha256",
  "anchorSha256", "headSha256", "manifestSha256", "absenceReceiptSha256", "mutationTailSequence",
  "mutationTailSha256", "previousCommitmentSha256", "commitmentSha256", "preflightReceiptSha256",
  "preflightVerifierId", "preflightVerifierSha256",
]);
const CLEANUP_MUTATION_INTENT_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "sequence", "target", "action", "contextSha256",
  "stateSequence", "stateSha256", "journalCommitmentSha256", "preflightReceiptSha256",
  "preflightVerifierId", "preflightVerifierSha256", "preflightCreatedAt",
  "createdAt", "previousIntentSha256", "intentSha256",
]);
const CLEANUP_MUTATION_COMMITMENT_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "sequence", "intent", "intentSha256", "intentFileSha256",
  "previousCommitmentSha256", "commitmentSha256",
]);
const CLEANUP_OPERATION_VERSION_RE = /^cleanup-manifest-(\d{6})\.json$/u;
const CLEANUP_STATE_RE = /^cleanup-state-(\d{6})\.json$/u;
const CLEANUP_STATE_ANCHOR_RE = /^cleanup-state-anchor-((?!000000)\d{6})\.json$/u;
const CLEANUP_JOURNAL_HEAD_RE = /^cleanup-journal-head-(\d{6})\.json$/u;
const CLEANUP_OPERATION_HEAD_ANCHOR_RE = /^cleanup-operation-head-(\d{6})\.json$/u;
const CLEANUP_OPERATION_HEAD_INTENT_RE = /^cleanup-operation-head-intent-(\d{6})\.json$/u;
const CLEANUP_JOURNAL_COMMITMENT_RE = /^cleanup-journal-commitment-(\d{6})\.json$/u;
const CLEANUP_MUTATION_INTENT_RE = /^cleanup-mutation-intent-(\d{6})\.json$/u;
const CLEANUP_MUTATION_COMMITMENT_RE = /^cleanup-mutation-commitment-(\d{6})\.json$/u;
const CLEANUP_PREFLIGHT_VERIFIER_ID = "palancar.azure-key-vault-cleanup.runtime-preflight.v1";
const CLEANUP_MUTATION_ATTEMPT_LIMIT = 3;
const CLEANUP_CUMULATIVE_ELAPSED_LIMIT_MS = 15 * 60 * 1000;
const CLEANUP_RETRY_BACKOFF_MS = 5_000;

function validateCleanupDescriptor(filePath, manifest, code = "vault-descriptor") {
  const descriptor = readJson(filePath, code);
  assertKnownKeys(descriptor, CLEANUP_DESCRIPTOR_KEYS, code);
  assertRequiredKeys(descriptor, CLEANUP_DESCRIPTOR_KEYS.filter((key) => key !== "supersession"), code);
  failIf(
    descriptor.version !== 1 || descriptor.type !== "credential-cleanup-vault-descriptor" ||
      descriptor.runId !== manifest.runId || descriptor.phase !== "credential-cleanup" ||
      descriptor.planSha256 !== manifest.planSha256 || descriptor.bindingSha256 !== manifest.bindingSha256 ||
      descriptor.contextSha256 !== manifest.bindingSha256 || descriptor.cloud !== "AzureCloud" ||
      descriptor.startState !== "start" || !same(descriptor.targetNames, CLEANUP_TARGET_NAMES),
    `${code}-context`,
  );
  failIf(!isSha(descriptor.planSha256) || !isSha(descriptor.bindingSha256), `${code}-hash`);
  failIf(!isObject(descriptor.callerIdentity) || descriptor.callerIdentity.userType !== "user" ||
    !CLEANUP_GUID_RE.test(descriptor.callerIdentity.objectId), `${code}-caller`);
  failIf(!CLEANUP_GUID_RE.test(descriptor.subscription) || !CLEANUP_GUID_RE.test(descriptor.tenant), `${code}-identity`);
  const resourceMatch = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.KeyVault\/vaults\/([^/]+)$/.exec(
    descriptor.vaultResourceId ?? "",
  );
  failIf(resourceMatch === null || resourceMatch[1] !== descriptor.subscription ||
    !/^[A-Za-z0-9-]{1,127}$/.test(resourceMatch[3]), `${code}-vault`);
  let vaultUri;
  try { vaultUri = new URL(descriptor.vaultUri); } catch { reject(`${code}-vault`); }
  const vaultMatch = /\/providers\/Microsoft\.KeyVault\/vaults\/([^/]+)$/.exec(descriptor.vaultResourceId);
  failIf(vaultUri.protocol !== "https:" || vaultUri.pathname !== "/" || vaultUri.search || vaultUri.hash ||
    vaultUri.username || vaultUri.password || vaultMatch === null ||
    vaultUri.hostname !== `${vaultMatch[1].toLowerCase()}.vault.azure.net`, `${code}-vault`);
  if (descriptor.supersession !== undefined) validateSupersessionShape(descriptor.supersession, `${code}-supersession`);
  return { value: descriptor, fileSha256: sha256File(filePath, JSON_MAX_BYTES) };
}

function validateSupersessionShape(value, code) {
  assertKnownKeys(value, ["oldRunId", "cleanupManifestSha256", "absenceReceiptSha256", "contextSha256"], code);
  assertRequiredKeys(value, ["oldRunId", "cleanupManifestSha256", "absenceReceiptSha256", "contextSha256"], code);
  failIf(!RUN_ID_RE.test(value.oldRunId) || !isSha(value.cleanupManifestSha256) ||
    !isSha(value.absenceReceiptSha256) || !isSha(value.contextSha256), `${code}-hash`);
  return value;
}

function cleanupCanonicalFileSha256(value) {
  return sha256Bytes(`${canonicalJson(value)}\n`);
}

function cleanupOperationVersionPath(directory, sequence) {
  return path.join(directory, `cleanup-manifest-${String(sequence).padStart(6, "0")}.json`);
}

function cleanupJournalDirectoryFor(filePath, runId) {
  return path.join(path.dirname(path.dirname(filePath)), JOURNAL_COMMITMENT_DIRECTORY_NAME, runId);
}

function cleanupOperationHeadValue(operation, manifestSha256, previousHeadSha256) {
  const value = {
    ...operation,
    manifestFilename: path.basename(cleanupOperationVersionPath("/", operation.sequence)),
    manifestSha256,
    previousHeadSha256,
    headSha256: null,
  };
  value.headSha256 = hashJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "headSha256")));
  return value;
}

function validateCleanupOperationValue(operation, manifest, descriptor, code, processRunner) {
  assertKnownKeys(operation, CLEANUP_OPERATION_KEYS, code);
  assertRequiredKeys(operation, CLEANUP_OPERATION_KEYS, code);
  failIf(
    operation.version !== 3 || operation.type !== "cleanup" ||
      !["prepared", "completed"].includes(operation.status) ||
      (operation.sequence === 0 ? operation.status !== "prepared" : operation.status !== "completed") ||
      operation.operation !== "credential-cleanup" ||
      operation.runId !== manifest.runId || operation.phase !== "credential-cleanup" ||
      operation.planSha256 !== manifest.planSha256 || operation.bindingSha256 !== manifest.bindingSha256 ||
      operation.contextSha256 !== descriptor.contextSha256 || operation.createdAt !== manifest.createdAt ||
      operation.repositoryCommit !== manifest.bindings.repositoryCommit ||
      !Array.isArray(operation.runtimeSecretReferences) || operation.runtimeSecretReferences.length !== 0 ||
      !isSha(operation.utilitySha256) ||
      operation.vaultResourceId !== descriptor.vaultResourceId ||
      operation.journalCommitmentPath !== `${JOURNAL_COMMITMENT_DIRECTORY_NAME}/${operation.runId}` ||
      !Number.isSafeInteger(operation.sequence) || operation.sequence < 0 || operation.sequence > 1 ||
      (operation.sequence === 0 ? operation.previousManifestSha256 !== null : !isSha(operation.previousManifestSha256)) ||
      !isSha(operation.sha256) || operation.sha256 !== hashJson(Object.fromEntries(Object.entries(operation).filter(([key]) => key !== "sha256"))),
    `${code}-context`,
  );
  if (operation.supersession !== null) validateSupersessionShape(operation.supersession, `${code}-supersession`);
  failIf(canonicalJson(operation.supersession) !== canonicalJson(descriptor.supersession ?? null), `${code}-supersession`);
  return operation;
}

function cleanupOperationUtilitySha256Allowed(utilitySha256, manifest, processRunner) {
  const currentUtilitySha256 = sha256File(CLEANUP_UTILITY_PATH, EXECUTABLE_MAX_BYTES);
  return utilitySha256 === currentUtilitySha256 ||
    utilitySha256 === cleanupUtilitySha256AtCommit(manifest.bindings.repositoryCommit, processRunner);
}

function validateCleanupOperationHeadJournal(filePath, operation, versions, head, code) {
  const directory = cleanupJournalDirectoryFor(filePath, operation.runId);
  assertDirectory(directory, `${code}-journal`);
  const anchors = new Map();
  const intents = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const anchorMatch = CLEANUP_OPERATION_HEAD_ANCHOR_RE.exec(entry.name);
    const intentMatch = CLEANUP_OPERATION_HEAD_INTENT_RE.exec(entry.name);
    if (anchorMatch) {
      failIf(entry.isSymbolicLink() || !entry.isFile(), `${code}-anchor`);
      anchors.set(Number(anchorMatch[1]), path.join(directory, entry.name));
    } else if (intentMatch) {
      failIf(entry.isSymbolicLink() || !entry.isFile(), `${code}-intent`);
      intents.set(Number(intentMatch[1]), path.join(directory, entry.name));
    } else if (CLEANUP_JOURNAL_COMMITMENT_RE.test(entry.name) || CLEANUP_MUTATION_INTENT_RE.test(entry.name) || CLEANUP_MUTATION_COMMITMENT_RE.test(entry.name)) {
      failIf(entry.isSymbolicLink() || !entry.isFile(), `${code}-journal-file`);
    } else {
      reject(`${code}-journal-name`);
    }
  }
  failIf(anchors.size !== operation.sequence + 1 || intents.size !== operation.sequence + 1, `${code}-journal`);
  for (let sequence = 0; sequence <= operation.sequence; sequence += 1) {
    const version = versions[sequence];
    const versionPath = version.filePath;
    const manifestSha256 = sha256File(versionPath, JSON_MAX_BYTES);
    const intentPath = intents.get(sequence);
    const anchorPath = anchors.get(sequence);
    failIf(intentPath === undefined || anchorPath === undefined, `${code}-journal`);
    const intent = readJson(intentPath, `${code}-intent`);
    assertKnownKeys(intent, CLEANUP_OPERATION_HEAD_INTENT_KEYS, `${code}-intent`);
    assertRequiredKeys(intent, CLEANUP_OPERATION_HEAD_INTENT_KEYS, `${code}-intent`);
    failIf(
      intent.version !== 1 || intent.type !== "key-vault-cleanup-operation-head-intent" ||
        intent.runId !== operation.runId || intent.phase !== operation.phase || intent.sequence !== sequence ||
        intent.manifestSha256 !== manifestSha256 ||
        (sequence === 0 ? intent.previousHeadSha256 !== null : intent.previousHeadSha256 !== readJson(anchors.get(sequence - 1), `${code}-anchor`).headSha256) ||
        (sequence === 0 ? intent.previousAnchorSha256 !== null : intent.previousAnchorSha256 !== sha256File(anchors.get(sequence - 1), JSON_MAX_BYTES)) ||
        !isSha(intent.intentSha256) || intent.intentSha256 !== hashJson(Object.fromEntries(Object.entries(intent).filter(([key]) => key !== "intentSha256"))),
      `${code}-intent`,
    );
    const anchor = readJson(anchorPath, `${code}-anchor`);
    assertKnownKeys(anchor, CLEANUP_OPERATION_HEAD_ANCHOR_KEYS, `${code}-anchor`);
    assertRequiredKeys(anchor, CLEANUP_OPERATION_HEAD_ANCHOR_KEYS, `${code}-anchor`);
    const previousHeadSha256 = sequence === 0 ? null : readJson(anchors.get(sequence - 1), `${code}-anchor`).headSha256;
    const expectedHead = cleanupOperationHeadValue(version.value, manifestSha256, previousHeadSha256);
    const expectedHeadSha256 = cleanupCanonicalFileSha256(expectedHead);
    failIf(
      anchor.version !== 1 || anchor.type !== "key-vault-cleanup-operation-head-anchor" ||
        anchor.runId !== operation.runId || anchor.phase !== operation.phase || anchor.sequence !== sequence ||
        anchor.manifestSha256 !== manifestSha256 || anchor.headSha256 !== expectedHeadSha256 ||
        anchor.previousAnchorSha256 !== (sequence === 0 ? null : sha256File(anchors.get(sequence - 1), JSON_MAX_BYTES)) ||
        anchor.intentSha256 !== sha256File(intentPath, JSON_MAX_BYTES) ||
        !isSha(anchor.anchorSha256) || anchor.anchorSha256 !== hashJson(Object.fromEntries(Object.entries(anchor).filter(([key]) => key !== "anchorSha256"))),
      `${code}-anchor`,
    );
    failIf(path.basename(intentPath) !== `cleanup-operation-head-intent-${String(sequence).padStart(6, "0")}.json` ||
      path.basename(anchorPath) !== `cleanup-operation-head-${String(sequence).padStart(6, "0")}.json`, `${code}-journal`);
    if (sequence === operation.sequence) failIf(anchor.headSha256 !== sha256File(filePath, JSON_MAX_BYTES), `${code}-head`);
  }
  failIf(head.previousHeadSha256 !== (operation.sequence === 0 ? null : readJson(anchors.get(operation.sequence - 1), `${code}-anchor`).headSha256), `${code}-head`);
}

function validateCleanupOperation(filePath, manifest, descriptor, code = "cleanup-operation", processRunner) {
  assertRegular(filePath, undefined, `${code}-head`);
  const directory = path.dirname(filePath);
  const head = readJson(filePath, code);
  assertKnownKeys(head, CLEANUP_OPERATION_HEAD_KEYS, `${code}-head`);
  assertRequiredKeys(head, CLEANUP_OPERATION_HEAD_KEYS, `${code}-head`);
  failIf(!Number.isSafeInteger(head.sequence) || head.sequence < 0, `${code}-head`);
  const versions = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = CLEANUP_OPERATION_VERSION_RE.exec(entry.name);
    if (match) {
      failIf(entry.isSymbolicLink() || !entry.isFile(), `${code}-version`);
      versions.push({ sequence: Number(match[1]), filePath: path.join(directory, entry.name), value: readJson(path.join(directory, entry.name), `${code}-version`) });
    } else if (entry.name.startsWith("cleanup-manifest-")) {
      reject(`${code}-version-name`);
    }
  }
  versions.sort((left, right) => left.sequence - right.sequence);
  failIf(versions.length !== head.sequence + 1, `${code}-history`);
  const utilitySha256 = versions[0]?.value?.utilitySha256;
  failIf(versions.some(({ value }) => value?.utilitySha256 !== utilitySha256), `${code}-history`);
  failIf(!isSha(utilitySha256) || !cleanupOperationUtilitySha256Allowed(utilitySha256, manifest, processRunner), `${code}-version-context`);
  for (let sequence = 0; sequence <= head.sequence; sequence += 1) {
    const version = versions[sequence];
    failIf(version === undefined || version.sequence !== sequence, `${code}-history`);
    const operation = validateCleanupOperationValue(version.value, manifest, descriptor, `${code}-version`, processRunner);
    failIf(operation.sequence !== sequence || path.basename(version.filePath) !== `cleanup-manifest-${String(sequence).padStart(6, "0")}.json` ||
      operation.previousManifestSha256 !== (sequence === 0 ? null : sha256File(versions[sequence - 1].filePath, JSON_MAX_BYTES)), `${code}-history`);
    failIf(sha256File(version.filePath, JSON_MAX_BYTES) !== cleanupCanonicalFileSha256(operation), `${code}-version`);
  }
  const operation = validateCleanupOperationValue(
    Object.fromEntries(CLEANUP_OPERATION_KEYS.map((key) => [key, head[key]])),
    manifest,
    descriptor,
    `${code}-head`,
    processRunner,
  );
  const version = versions[head.sequence];
  failIf(canonicalJson(operation) !== canonicalJson(version.value) ||
    head.manifestFilename !== path.basename(version.filePath) ||
    head.manifestSha256 !== sha256File(version.filePath, JSON_MAX_BYTES) ||
    head.headSha256 !== hashJson(Object.fromEntries(Object.entries(head).filter(([key]) => key !== "headSha256"))),
    `${code}-head`);
  validateCleanupOperationHeadJournal(filePath, operation, versions, head, code);
  return {
    value: operation,
    fileSha256: sha256File(filePath, JSON_MAX_BYTES),
    manifestSha256: head.manifestSha256,
    head,
  };
}

function validatedCleanupPreflightVerifierSha256(request) {
  const directory = path.dirname(request.artifacts.cleanupOperation);
  const checkpoints = Array.isArray(request.checkpoints)
    ? request.checkpoints
    : readCheckpoints(directory, { runId: request.manifest.runId, phase: "credential-cleanup" });
  const preflightCheckpoint = checkpoints.find((checkpoint) => checkpoint.name === "preflight-receipt");
  if (preflightCheckpoint === undefined) return undefined;
  failIf(!isSha(preflightCheckpoint.verifierSha256), "cleanup-preflight-checkpoint");

  const livePath = request.artifacts.preflight;
  const consumedPath = `${livePath}.consumed`;
  const consumedCheckpoint = checkpoints.find((checkpoint) => checkpoint.name === "receipts-consumed");
  const liveExists = existsSync(livePath);
  const consumedExists = existsSync(consumedPath);
  if (consumedCheckpoint === undefined) {
    failIf(!liveExists || consumedExists, "cleanup-preflight-receipt");
  } else {
    failIf(liveExists || !consumedExists || !isSha(consumedCheckpoint.preflightReceiptSha256), "cleanup-preflight-receipt");
  }

  const receiptPath = liveExists ? livePath : consumedPath;
  const receipt = readReceiptAtCheckpoint(receiptPath, preflightCheckpoint, request.manifest, "preflight");
  failIf(receipt.verifierSha256 !== preflightCheckpoint.verifierSha256, "cleanup-preflight-checkpoint");
  if (consumedCheckpoint !== undefined) {
    failIf(
      consumedCheckpoint.preflightReceiptSha256 !== sha256File(receiptPath, JSON_MAX_BYTES),
      "cleanup-preflight-receipt",
    );
  }
  return receipt.verifierSha256;
}

function validateCleanupAbsence(filePath, manifest, operation, preflightVerifierSha256, code = "cleanup-absence") {
  assertRegular(filePath, undefined, code);
  const absence = readJson(filePath, code);
  assertKnownKeys(absence, CLEANUP_ABSENCE_KEYS, code);
  assertRequiredKeys(absence, CLEANUP_ABSENCE_KEYS, code);
  failIf(
      operation.value.status !== "completed" ||
      absence.version !== 3 || absence.type !== "absence" || absence.status !== "absent" ||
      absence.operation !== "credential-cleanup" || absence.runId !== manifest.runId || absence.phase !== "credential-cleanup" ||
      absence.planSha256 !== manifest.planSha256 || absence.bindingSha256 !== manifest.bindingSha256 ||
      absence.contextSha256 !== operation.value.contextSha256 || absence.createdAt !== operation.value.createdAt ||
      absence.repositoryCommit !== manifest.bindings.repositoryCommit ||
      typeof absence.createdAt !== "string" || !Number.isFinite(Date.parse(absence.createdAt)) ||
      !isSha(absence.preflightReceiptSha256) || absence.preflightVerifierId !== CLEANUP_PREFLIGHT_VERIFIER_ID ||
      !isSha(absence.preflightVerifierSha256) ||
      !isSha(preflightVerifierSha256) || absence.preflightVerifierSha256 !== preflightVerifierSha256 ||
      !Number.isSafeInteger(absence.mutationTailSequence) || absence.mutationTailSequence < -1 ||
      (absence.mutationTailSequence === -1 ? absence.mutationTailSha256 !== null : !isSha(absence.mutationTailSha256)) ||
      !isSha(absence.sha256) || absence.sha256 !== hashJson(Object.fromEntries(Object.entries(absence).filter(([key]) => key !== "sha256"))),
    `${code}-context`,
  );
  assertKnownKeys(absence.inventory, ["keyVault", "runtimeSecretReferences"], `${code}-inventory`);
  assertRequiredKeys(absence.inventory, ["keyVault", "runtimeSecretReferences"], `${code}-inventory`);
  failIf(absence.inventory.keyVault !== "absent" || absence.inventory.runtimeSecretReferences !== 0, `${code}-inventory`);
  if (absence.supersession !== null) validateSupersessionShape(absence.supersession, `${code}-supersession`);
  failIf(canonicalJson(absence.supersession) !== canonicalJson(operation.value.supersession ?? null), `${code}-supersession`);
  return { value: absence, fileSha256: sha256File(filePath, JSON_MAX_BYTES) };
}

function cleanupStatePreflightValid(state, preflightVerifierSha256) {
  if (state.status === "start-inventory-validated") {
    return state.preflightReceiptSha256 === null && state.preflightVerifierId === null && state.preflightVerifierSha256 === null;
  }
  return isSha(state.preflightReceiptSha256) && state.preflightVerifierId === CLEANUP_PREFLIGHT_VERIFIER_ID &&
    isSha(state.preflightVerifierSha256) && isSha(preflightVerifierSha256) &&
    state.preflightVerifierSha256 === preflightVerifierSha256;
}

function cleanupValidateMutationEvidence(directory, operation, states, journalCommitments, preflightVerifierSha256, code) {
  const commitments = [];
  const intents = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const commitmentMatch = CLEANUP_MUTATION_COMMITMENT_RE.exec(entry.name);
    const intentMatch = CLEANUP_MUTATION_INTENT_RE.exec(entry.name);
    if (commitmentMatch) {
      failIf(entry.isSymbolicLink() || !entry.isFile(), `${code}-mutation-commitment`);
      commitments.push({ sequence: Number(commitmentMatch[1]), path: path.join(directory, entry.name) });
    } else if (intentMatch) {
      failIf(entry.isSymbolicLink() || !entry.isFile(), `${code}-mutation-intent`);
      intents.push({ sequence: Number(intentMatch[1]), path: path.join(directory, entry.name) });
    } else if (!CLEANUP_OPERATION_HEAD_ANCHOR_RE.test(entry.name) &&
      !CLEANUP_OPERATION_HEAD_INTENT_RE.test(entry.name) && !CLEANUP_JOURNAL_COMMITMENT_RE.test(entry.name)) {
      reject(`${code}-mutation-name`);
    }
  }
  commitments.sort((left, right) => left.sequence - right.sequence);
  intents.sort((left, right) => left.sequence - right.sequence);
  failIf(commitments.length !== intents.length, `${code}-mutation-history`);
  for (let index = 0; index < commitments.length; index += 1) {
    const commitment = commitments[index];
    const intentEntry = intents[index];
    failIf(commitment.sequence !== index || intentEntry.sequence !== index, `${code}-mutation-history`);
    const value = readJson(commitment.path, `${code}-mutation-commitment`);
    commitment.value = value;
    assertKnownKeys(value, CLEANUP_MUTATION_COMMITMENT_KEYS, `${code}-mutation-commitment`);
    assertRequiredKeys(value, CLEANUP_MUTATION_COMMITMENT_KEYS, `${code}-mutation-commitment`);
    const intent = readJson(intentEntry.path, `${code}-mutation-intent`);
    failIf(!isObject(value.intent), `${code}-mutation-commitment`);
    intentEntry.value = intent;
    assertKnownKeys(intent, CLEANUP_MUTATION_INTENT_KEYS, `${code}-mutation-intent`);
    assertRequiredKeys(intent, CLEANUP_MUTATION_INTENT_KEYS, `${code}-mutation-intent`);
    const stateEntry = states[intent.stateSequence];
    const state = stateEntry === undefined ? undefined : readJson(stateEntry.path, `${code}-state`);
    const journal = journalCommitments.find((candidate) => sha256File(candidate.path, JSON_MAX_BYTES) === intent.journalCommitmentSha256);
    failIf(state === undefined || journal === undefined ||
      value.version !== 1 || value.type !== "key-vault-cleanup-mutation-commitment" || value.runId !== operation.value.runId ||
      value.phase !== "credential-cleanup" || value.sequence !== index || value.intent.sequence !== index ||
      !isSha(value.intentSha256) || value.intentSha256 !== value.intent.intentSha256 ||
      !isSha(value.intentFileSha256) || value.intentFileSha256 !== sha256File(intentEntry.path, JSON_MAX_BYTES) ||
      value.intentFileSha256 !== sha256Bytes(`${canonicalJson(intent)}\n`) ||
      (index === 0 ? value.previousCommitmentSha256 !== null : value.previousCommitmentSha256 !== sha256File(commitments[index - 1].path, JSON_MAX_BYTES)) ||
      !isSha(value.commitmentSha256) || value.commitmentSha256 !== hashJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "commitmentSha256"))),
      `${code}-mutation-commitment`);
    failIf(
      intent.version !== 1 || intent.type !== "key-vault-cleanup-mutation-intent" || intent.runId !== operation.value.runId ||
        intent.phase !== "credential-cleanup" || !Number.isSafeInteger(intent.sequence) || intent.sequence !== index ||
        !CLEANUP_TARGET_NAMES.includes(intent.target) || !["delete", "purge"].includes(intent.action) ||
        intent.contextSha256 !== operation.value.contextSha256 || !Number.isSafeInteger(intent.stateSequence) || intent.stateSequence < 0 ||
        !isSha(intent.stateSha256) || intent.stateSha256 !== state.stateSha256 || !isSha(intent.journalCommitmentSha256) ||
        !isSha(intent.preflightReceiptSha256) || intent.preflightVerifierId !== CLEANUP_PREFLIGHT_VERIFIER_ID ||
        !isSha(intent.preflightVerifierSha256) ||
        !isSha(preflightVerifierSha256) || intent.preflightVerifierSha256 !== preflightVerifierSha256 ||
        intent.preflightReceiptSha256 !== state.preflightReceiptSha256 ||
        intent.preflightVerifierId !== state.preflightVerifierId ||
        intent.preflightVerifierSha256 !== state.preflightVerifierSha256 ||
        typeof intent.preflightCreatedAt !== "string" ||
        !Number.isFinite(Date.parse(intent.preflightCreatedAt)) ||
        typeof intent.createdAt !== "string" || !Number.isFinite(Date.parse(intent.createdAt)) ||
        (index === 0 ? intent.previousIntentSha256 !== null : intent.previousIntentSha256 !== sha256File(intents[index - 1].path, JSON_MAX_BYTES)) ||
        !isSha(intent.intentSha256) || intent.intentSha256 !== hashJson(Object.fromEntries(Object.entries(intent).filter(([key]) => key !== "intentSha256"))),
      `${code}-mutation-intent`);
    failIf(canonicalJson(value.intent) !== canonicalJson(intent) ||
      journal.value.latestSequence !== intent.stateSequence || journal.value.stateSha256 !== intent.stateSha256 ||
      journal.value.mutationTailSequence >= index || value.intentFileSha256 !== sha256File(intentEntry.path, JSON_MAX_BYTES), `${code}-mutation-journal`);
  }
  return commitments;
}

function cleanupValidateJournalEvidence(request, operation, stateFiles, anchorFiles, journalHeadFiles, directory, preflightVerifierSha256, code) {
  const journalCommitments = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = CLEANUP_JOURNAL_COMMITMENT_RE.exec(entry.name);
    if (match) {
      failIf(entry.isSymbolicLink() || !entry.isFile(), `${code}-commitment`);
      const commitmentPath = path.join(directory, entry.name);
      journalCommitments.push({ sequence: Number(match[1]), path: commitmentPath, value: readJson(commitmentPath, `${code}-commitment`) });
    } else if (entry.name.startsWith("cleanup-journal-commitment-")) {
      reject(`${code}-commitment-name`);
    }
  }
  journalCommitments.sort((left, right) => left.sequence - right.sequence);
  failIf(journalCommitments.length !== stateFiles.length, `${code}-commitment-history`);
  for (let index = 0; index < stateFiles.length; index += 1) {
    const state = readJson(stateFiles[index].path, `${code}-state`);
    const anchorPath = anchorFiles.get(index);
    const headPath = journalHeadFiles.get(index);
    const commitmentEntry = journalCommitments[index];
    failIf(anchorPath === undefined || headPath === undefined || commitmentEntry === undefined || commitmentEntry.sequence !== index, `${code}-history`);
    const anchor = readJson(anchorPath, `${code}-anchor`);
    const head = readJson(headPath, `${code}-head`);
    const commitment = commitmentEntry.value;
    assertKnownKeys(anchor, CLEANUP_STATE_ANCHOR_KEYS, `${code}-anchor`);
    assertRequiredKeys(anchor, CLEANUP_STATE_ANCHOR_KEYS, `${code}-anchor`);
    assertKnownKeys(head, CLEANUP_JOURNAL_HEAD_KEYS, `${code}-head`);
    assertRequiredKeys(head, CLEANUP_JOURNAL_HEAD_KEYS, `${code}-head`);
    assertKnownKeys(commitment, CLEANUP_JOURNAL_COMMITMENT_KEYS, `${code}-commitment`);
    assertRequiredKeys(commitment, CLEANUP_JOURNAL_COMMITMENT_KEYS, `${code}-commitment`);
    const previousCommitmentPath = index === 0 ? undefined : journalCommitments[index - 1].path;
    const previousHeadPath = index === 0 ? undefined : journalHeadFiles.get(index - 1);
    const preflightValid = cleanupStatePreflightValid(state, preflightVerifierSha256);
    failIf(
      anchor.version !== 1 || anchor.type !== "key-vault-cleanup-state-anchor" || anchor.runId !== request.manifest.runId ||
        anchor.phase !== "credential-cleanup" || anchor.stateSequence !== index || anchor.stateSha256 !== state.stateSha256 ||
        anchor.stateFileSha256 !== sha256File(stateFiles[index].path, JSON_MAX_BYTES) || anchor.manifestSha256 !== operation.manifestSha256 ||
        anchor.absenceReceiptSha256 !== state.absenceReceiptSha256 || anchor.mutationTailSequence !== state.mutationTailSequence ||
        anchor.mutationTailSha256 !== state.mutationTailSha256 || anchor.preflightReceiptSha256 !== state.preflightReceiptSha256 ||
        anchor.preflightVerifierId !== state.preflightVerifierId || anchor.preflightVerifierSha256 !== state.preflightVerifierSha256 ||
        !isSha(anchor.anchorSha256) || anchor.anchorSha256 !== hashJson(Object.fromEntries(Object.entries(anchor).filter(([key]) => key !== "anchorSha256"))),
      `${code}-anchor`);
    failIf(
      head.version !== 1 || head.type !== "key-vault-cleanup-journal-head" || head.runId !== request.manifest.runId ||
        head.phase !== "credential-cleanup" || head.stateSequence !== index || head.stateSha256 !== state.stateSha256 ||
        head.stateFileSha256 !== sha256File(stateFiles[index].path, JSON_MAX_BYTES) || head.manifestSha256 !== operation.manifestSha256 ||
        head.absenceReceiptSha256 !== state.absenceReceiptSha256 || head.mutationTailSequence !== state.mutationTailSequence ||
        head.mutationTailSha256 !== state.mutationTailSha256 ||
        head.previousHeadSha256 !== (index === 0 ? null : sha256File(previousHeadPath, JSON_MAX_BYTES)) ||
        head.preflightReceiptSha256 !== state.preflightReceiptSha256 || head.preflightVerifierId !== state.preflightVerifierId ||
        head.preflightVerifierSha256 !== state.preflightVerifierSha256 || !isSha(head.headSha256) ||
        head.headSha256 !== hashJson(Object.fromEntries(Object.entries(head).filter(([key]) => key !== "headSha256"))),
      `${code}-head`);
    failIf(
      commitment.version !== 1 || commitment.type !== "key-vault-cleanup-journal-commitment" || commitment.runId !== request.manifest.runId ||
        commitment.phase !== "credential-cleanup" || commitment.latestSequence !== index || commitment.stateSha256 !== state.stateSha256 ||
        commitment.stateFileSha256 !== sha256File(stateFiles[index].path, JSON_MAX_BYTES) || commitment.anchorSha256 !== sha256File(anchorPath, JSON_MAX_BYTES) ||
        commitment.headSha256 !== sha256File(headPath, JSON_MAX_BYTES) || commitment.manifestSha256 !== operation.manifestSha256 ||
        commitment.absenceReceiptSha256 !== state.absenceReceiptSha256 || commitment.mutationTailSequence !== state.mutationTailSequence ||
        commitment.mutationTailSha256 !== state.mutationTailSha256 || commitment.preflightReceiptSha256 !== state.preflightReceiptSha256 ||
        commitment.preflightVerifierId !== state.preflightVerifierId || commitment.preflightVerifierSha256 !== state.preflightVerifierSha256 ||
        commitment.previousCommitmentSha256 !== (index === 0 ? null : sha256File(previousCommitmentPath, JSON_MAX_BYTES)) ||
        !isSha(commitment.commitmentSha256) || commitment.commitmentSha256 !== hashJson(Object.fromEntries(Object.entries(commitment).filter(([key]) => key !== "commitmentSha256"))),
      `${code}-commitment`);
    failIf(!preflightValid, `${code}-preflight`);
  }
  const mutationCommitments = cleanupValidateMutationEvidence(directory, operation, stateFiles, journalCommitments, preflightVerifierSha256, code);
  for (const stateFile of stateFiles) {
    const state = readJson(stateFile.path, `${code}-state`);
    if (state.mutationTailSequence === -1) failIf(state.mutationTailSha256 !== null, `${code}-mutation-tail`);
    else failIf(mutationCommitments[state.mutationTailSequence] === undefined ||
      mutationCommitments[state.mutationTailSequence].value.intentFileSha256 !== state.mutationTailSha256, `${code}-mutation-tail`);
  }
  return journalCommitments;
}

function validateCleanupStateEvidence(request, operation, { requireComplete = false, preflightVerifierSha256 } = {}) {
  const directory = path.dirname(request.artifacts.cleanupOperation);
  const stateFiles = [];
  const anchorFiles = new Map();
  const journalHeadFiles = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) reject("cleanup-state-symlink");
    const stateMatch = CLEANUP_STATE_RE.exec(entry.name);
    const anchorMatch = CLEANUP_STATE_ANCHOR_RE.exec(entry.name);
    const headMatch = CLEANUP_JOURNAL_HEAD_RE.exec(entry.name);
    if (stateMatch) stateFiles.push({ sequence: Number(stateMatch[1]), path: path.join(directory, entry.name) });
    else if (entry.name === "cleanup-state-anchor.json") anchorFiles.set(0, path.join(directory, entry.name));
    else if (anchorMatch) anchorFiles.set(Number(anchorMatch[1]), path.join(directory, entry.name));
    else if (headMatch) journalHeadFiles.set(Number(headMatch[1]), path.join(directory, entry.name));
    else if (entry.name.startsWith("cleanup-state-") || entry.name.startsWith("cleanup-journal-head-")) reject("cleanup-state-name");
  }
  stateFiles.sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < stateFiles.length; index += 1) {
    const statePath = stateFiles[index].path;
    const value = readJson(statePath, "cleanup-state");
    assertKnownKeys(value, CLEANUP_STATE_KEYS, "cleanup-state");
    assertRequiredKeys(value, CLEANUP_STATE_KEYS, "cleanup-state");
    const cleanupStateContextInvalid = value.version !== 1 || value.type !== "key-vault-cleanup-state" || value.runId !== request.manifest.runId ||
      value.phase !== "credential-cleanup" || value.sequence !== index ||
      !["start-inventory-validated", "attempting", "unknown", "complete"].includes(value.status) ||
      !Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > CLEANUP_MUTATION_ATTEMPT_LIMIT ||
      !Number.isSafeInteger(value.cumulativeElapsedMs) || value.cumulativeElapsedMs < 0 ||
      value.cumulativeElapsedMs > CLEANUP_CUMULATIVE_ELAPSED_LIMIT_MS ||
      !Number.isFinite(value.operationStartedAt) || !Number.isFinite(value.accountingCursor) ||
      (value.attemptStartedAt !== null && !Number.isFinite(value.attemptStartedAt)) ||
      (value.retryNotBefore !== null && !Number.isFinite(value.retryNotBefore)) ||
      (value.absenceReceiptSha256 !== null && !isSha(value.absenceReceiptSha256)) ||
      value.manifestSha256 !== operation.manifestSha256 || !isObject(value.inventory) ||
      value.inventorySha256 !== hashJson(value.inventory) || !isSha(value.stateSha256) ||
      value.stateSha256 !== hashJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "stateSha256"))) ||
      !Number.isSafeInteger(value.mutationTailSequence) || value.mutationTailSequence < -1 ||
      (value.mutationTailSequence === -1 ? value.mutationTailSha256 !== null : !isSha(value.mutationTailSha256)) ||
      !cleanupStatePreflightValid(value, preflightVerifierSha256);
    failIf(cleanupStateContextInvalid, "cleanup-state-context");
    assertKnownKeys(value.inventory, ["activeNames", "deletedNames", "targetStates"], "cleanup-state-inventory");
    assertRequiredKeys(value.inventory, ["activeNames", "deletedNames", "targetStates"], "cleanup-state-inventory");
    failIf(!Array.isArray(value.inventory.activeNames) || !Array.isArray(value.inventory.deletedNames) ||
      !Array.isArray(value.inventory.targetStates) || value.inventory.activeNames.some((name) => !CLEANUP_TARGET_NAMES.includes(name)) ||
      value.inventory.deletedNames.some((name) => !CLEANUP_TARGET_NAMES.includes(name)) ||
      new Set(value.inventory.activeNames).size !== value.inventory.activeNames.length || new Set(value.inventory.deletedNames).size !== value.inventory.deletedNames.length ||
      !same(value.inventory.targetStates.map((item) => item.name), CLEANUP_TARGET_NAMES), "cleanup-state-targets");
    for (const target of value.inventory.targetStates) {
      assertKnownKeys(target, ["name", "activeCount", "deletedCount", "state"], "cleanup-state-target");
      assertRequiredKeys(target, ["name", "activeCount", "deletedCount", "state"], "cleanup-state-target");
      failIf(!CLEANUP_TARGET_NAMES.includes(target.name) || !["active", "deleted", "absent"].includes(target.state) ||
        ![0, 1].includes(target.activeCount) || ![0, 1].includes(target.deletedCount) || target.activeCount + target.deletedCount > 1 ||
        (target.state === "active" && target.activeCount !== 1) || (target.state === "deleted" && target.deletedCount !== 1) ||
        (target.state === "absent" && (target.activeCount !== 0 || target.deletedCount !== 0)), "cleanup-state-target");
    }
    failIf(!same(value.inventory.activeNames, value.inventory.targetStates.filter((item) => item.activeCount === 1).map((item) => item.name)) ||
      !same(value.inventory.deletedNames, value.inventory.targetStates.filter((item) => item.deletedCount === 1).map((item) => item.name)), "cleanup-state-targets");
    if (index === 0) {
      if (value.status === "complete") {
        failIf(operation.value.supersession === null || value.attempts !== 0 || value.attemptStartedAt !== null || value.retryNotBefore !== null ||
          !isSha(value.absenceReceiptSha256) || value.previousStateSha256 !== null || value.mutationTailSequence !== -1 ||
          value.mutationTailSha256 !== null || value.inventory.targetStates.some((item) => item.state !== "absent"), "cleanup-state-transition");
      } else {
        failIf(value.status !== "start-inventory-validated" || value.attempts !== 0 || value.attemptStartedAt !== null || value.retryNotBefore !== null ||
          value.absenceReceiptSha256 !== null || value.previousStateSha256 !== null || value.mutationTailSequence !== -1 ||
          value.mutationTailSha256 !== null || value.inventory.targetStates.some((item) => item.state !== "active") ||
          operation.value.supersession !== null, "cleanup-state-transition");
      }
    } else {
      const previous = readJson(stateFiles[index - 1].path, "cleanup-state");
      failIf(previous.status === "complete", "cleanup-state-terminal");
      if (value.status === "attempting") failIf(!["start-inventory-validated", "attempting", "unknown"].includes(previous.status) || value.attempts !== previous.attempts + 1 || value.attemptStartedAt === null || value.retryNotBefore !== null || value.absenceReceiptSha256 !== null, "cleanup-state-transition");
      else if (value.status === "unknown") failIf(previous.status !== "attempting" || value.attempts !== previous.attempts || value.attemptStartedAt !== null || value.retryNotBefore === null || value.absenceReceiptSha256 !== null || value.retryNotBefore < value.accountingCursor + CLEANUP_RETRY_BACKOFF_MS, "cleanup-state-transition");
      else if (value.status === "complete") failIf(!["start-inventory-validated", "attempting", "unknown"].includes(previous.status) || value.attempts !== previous.attempts || value.attemptStartedAt !== null || value.retryNotBefore !== null || !isSha(value.absenceReceiptSha256), "cleanup-state-transition");
      else reject("cleanup-state-transition");
      failIf(value.cumulativeElapsedMs < previous.cumulativeElapsedMs || value.mutationTailSequence < previous.mutationTailSequence ||
        (value.mutationTailSequence === previous.mutationTailSequence && value.mutationTailSha256 !== previous.mutationTailSha256), "cleanup-state-transition");
    }
    failIf(value.previousStateSha256 !== (index === 0 ? null : sha256File(stateFiles[index - 1].path, JSON_MAX_BYTES)), "cleanup-state-chain");
  }
  failIf(anchorFiles.size !== stateFiles.length || journalHeadFiles.size !== stateFiles.length, "cleanup-state-history");
  if (stateFiles.length === 0) {
    const journalDirectory = cleanupJournalDirectoryFor(request.artifacts.cleanupOperation, request.manifest.runId);
    if (existsSync(journalDirectory)) {
      for (const entry of readdirSync(journalDirectory, { withFileTypes: true })) {
        if (CLEANUP_JOURNAL_COMMITMENT_RE.test(entry.name) || CLEANUP_MUTATION_INTENT_RE.test(entry.name) || CLEANUP_MUTATION_COMMITMENT_RE.test(entry.name)) {
          reject("cleanup-state-history");
        }
      }
    }
  }
  if (stateFiles.length > 0) {
    const last = readJson(stateFiles.at(-1).path, "cleanup-state");
    failIf(last.status === "complete" && stateFiles.some(({ path: statePath }, index) => index < stateFiles.length - 1 && readJson(statePath, "cleanup-state").status === "complete"), "cleanup-state-terminal");
    const journalDirectory = cleanupJournalDirectoryFor(request.artifacts.cleanupOperation, request.manifest.runId);
    assertDirectory(journalDirectory, "cleanup-journal-directory");
    cleanupValidateJournalEvidence(
      request,
      operation,
      stateFiles,
      anchorFiles,
      journalHeadFiles,
      journalDirectory,
      preflightVerifierSha256,
      "cleanup-journal",
    );
    for (const stateFile of stateFiles) {
      const state = readJson(stateFile.path, "cleanup-state");
      if (state.absenceReceiptSha256 !== null) {
        failIf(!existsSync(request.artifacts.absence) || sha256File(request.artifacts.absence, JSON_MAX_BYTES) !== state.absenceReceiptSha256, "cleanup-absence-linkage");
        const absence = validateCleanupAbsence(
          request.artifacts.absence,
          request.manifest,
          operation,
          preflightVerifierSha256,
        );
        failIf(absence.value.mutationTailSequence !== state.mutationTailSequence ||
          absence.value.mutationTailSha256 !== state.mutationTailSha256 ||
          absence.value.preflightReceiptSha256 !== state.preflightReceiptSha256 ||
          absence.value.preflightVerifierId !== state.preflightVerifierId ||
          absence.value.preflightVerifierSha256 !== state.preflightVerifierSha256,
        "cleanup-absence-linkage");
      }
    }
  }
  if (requireComplete) {
    failIf(stateFiles.length === 0, "cleanup-state-missing");
    const last = readJson(stateFiles.at(-1).path, "cleanup-state");
    failIf(last.status !== "complete" || !last.absenceReceiptSha256, "cleanup-state-incomplete");
  }
  return stateFiles;
}

function requiredCleanup(request, { requireAbsence = true, processRunner = request.processRunner } = {}) {
  const manifest = request.manifest;
  failIf(!manifest, "cleanup-context");
  const descriptor = validateCleanupDescriptor(request.artifacts.descriptor, manifest);
  const operationPath = request.artifacts.cleanupOperation;
  const operation = validateCleanupOperation(
    operationPath,
    manifest,
    descriptor.value,
    "cleanup-operation",
    processRunner,
  );
  const preflightVerifierSha256 = validatedCleanupPreflightVerifierSha256(request);
  let stateFiles = [];
  if (!existsSync(request.artifacts.absence)) {
    stateFiles = validateCleanupStateEvidence(request, operation, { requireComplete: false, preflightVerifierSha256 });
  } else {
    failIf(operation.value.status !== "completed", "cleanup-operation-incomplete");
    stateFiles = validateCleanupStateEvidence(request, operation, { requireComplete: true, preflightVerifierSha256 });
  }
  if (request.guardReceiptSha256 !== undefined) {
    const guardPath = existsSync(`${request.artifacts.guard}.consumed`)
      ? `${request.artifacts.guard}.consumed`
      : request.artifacts.guard;
    failIf(sha256File(guardPath, JSON_MAX_BYTES) !== request.guardReceiptSha256, "cleanup-guard-context");
  }
  let absence;
  if (requireAbsence) {
    absence = validateCleanupAbsence(
      request.artifacts.absence,
      manifest,
      { ...operation, path: operationPath },
      preflightVerifierSha256,
    );
  }
  return { descriptor, operation, absence, preflightVerifierSha256 };
}

function validateRecoveryEvidenceArtifacts(phase, artifacts, checkpoint, manifest, processRunner) {
  if (phase === "runtime-cutover") {
    failIf(!isSha(checkpoint.diagnosticReceiptSha256), "diagnostic-receipt-checkpoint");
    assertCheckpointArtifact(
      artifacts.diagnostic,
      checkpoint,
      "diagnosticReceiptSha256",
      "diagnostic-receipt",
    );
    requiredDiagnostic({ manifest, artifacts });
  } else if (phase === "credential-cleanup") {
    failIf(!isSha(checkpoint.cleanupOperationManifestSha256), "cleanup-operation-checkpoint");
    assertCheckpointArtifact(
      artifacts.cleanupOperation,
      checkpoint,
      "cleanupOperationManifestSha256",
      "cleanup-operation",
    );
    const cleanup = requiredCleanup({
      manifest,
      artifacts,
      guardReceiptSha256: checkpoint.guardReceiptSha256,
      processRunner,
    }, { requireAbsence: false });
    if (checkpoint.absenceReceiptSha256 !== undefined) {
      failIf(!isSha(checkpoint.absenceReceiptSha256), "cleanup-absence-checkpoint");
      assertCheckpointArtifact(artifacts.absence, checkpoint, "absenceReceiptSha256", "cleanup-absence");
      validateCleanupAbsence(
        artifacts.absence,
        manifest,
        { ...cleanup.operation, path: artifacts.cleanupOperation },
        cleanup.preflightVerifierSha256,
      );
    }
  }
}

function assertHttpsEndpoint(value, code) {
  failIf(typeof value !== "string" || value.length === 0 || value.trim() !== value, code);
  let url;
  try {
    url = new URL(value);
  } catch {
    reject(code);
  }
  failIf(url.protocol !== "https:" || url.username || url.password || url.search || url.hash, code);
  failIf(url.pathname !== "/" && url.pathname !== "", code);
  return `https://${url.hostname}`;
}

function identityKey(value, code = "runtime-identity") {
  failIf(
    typeof value !== "string" ||
      !/^\/subscriptions\/[^/]+(?:\/[^/]+)*$/i.test(value),
    code,
  );
  return value.toLowerCase();
}

function canonicalResourceId(value, expected, code) {
  failIf(identityKey(value, code) !== identityKey(expected, code), code);
  return expected;
}

function assertEnvironmentEntries(entries, code) {
  failIf(!Array.isArray(entries), code);
  const names = new Set();
  return entries.map((entry) => {
    assertKnownKeys(entry, ["name", "value", "secretRef"], code);
    assertRequiredKeys(entry, ["name"], code);
    failIf(typeof entry.name !== "string" || entry.name.length === 0 || names.has(entry.name), code);
    names.add(entry.name);
    failIf(Object.hasOwn(entry, "value") && Object.hasOwn(entry, "secretRef"), code);
    if (Object.hasOwn(entry, "value")) failIf(typeof entry.value !== "string", code);
    if (Object.hasOwn(entry, "secretRef")) failIf(typeof entry.secretRef !== "string" || entry.secretRef.length === 0, code);
    return entry;
  });
}

function assertContainerShape(container, code) {
  assertKnownKeys(container, ["name", "image", "env", "resources", "probes", "command", "args"], code);
  assertRequiredKeys(container, ["name", "image", "env"], code);
  failIf(typeof container.name !== "string" || typeof container.image !== "string", code);
  assertEnvironmentEntries(container.env, code);
  if (container.resources !== undefined) failIf(!isObject(container.resources), code);
  if (container.probes !== undefined) failIf(!Array.isArray(container.probes), code);
  return container;
}

function assertContainerTemplate(template, code) {
  assertKnownKeys(template, ["containers", "scale", "revisionSuffix", "volumes"], code);
  assertRequiredKeys(template, ["containers"], code);
  failIf(!Array.isArray(template.containers) || template.containers.length === 0, code);
  template.containers.forEach((container) => assertContainerShape(container, code));
  if (template.scale !== undefined) failIf(!isObject(template.scale), code);
  return template;
}

const LIVE_FQDN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+azurecontainerapps\.io$/i;

function assertLiveResourceType(value, expected, code) {
  failIf(typeof value !== "string", code);
  const actualParts = value.split("/");
  const expectedParts = expected.split("/");
  failIf(actualParts.length !== expectedParts.length ||
    actualParts.some((part, index) => part.toLowerCase() !== expectedParts[index].toLowerCase()), code);
  return value;
}

function assertLiveResourceId(value, outputs, resourceKind, resourceName, code, revisionName) {
  failIf(typeof value !== "string", code);
  const segments = value.split("/");
  const expectedLength = revisionName === undefined ? 9 : 11;
  failIf(segments.length !== expectedLength || segments[0] !== "", code);
  failIf(segments[1].toLowerCase() !== "subscriptions" || segments[3].toLowerCase() !== "resourcegroups" ||
    segments[5].toLowerCase() !== "providers" || segments[6].toLowerCase() !== "microsoft.app", code);
  const subscription = outputs.accountId?.split("/")[2];
  failIf(typeof subscription !== "string" || !UUID_RE.test(segments[2]) || segments[2].toLowerCase() !== subscription.toLowerCase(), code);
  failIf(segments[4] !== outputs.resourceGroup || segments[7].toLowerCase() !== resourceKind.toLowerCase() ||
    segments[8] !== resourceName, code);
  if (revisionName !== undefined) {
    failIf(segments[9].toLowerCase() !== "revisions" || segments[10] !== revisionName, code);
  }
  return value;
}

function assertLiveManagedEnvironmentId(value, outputs, code) {
  const expected = outputs.containerAppEnvironmentId;
  failIf(typeof expected !== "string", code);
  const expectedSegments = expected.split("/");
  failIf(expectedSegments.length !== 9 || expectedSegments[8].length === 0, code);
  assertLiveResourceId(expected, outputs, "managedEnvironments", expectedSegments[8], code);
  assertLiveResourceId(value, outputs, "managedEnvironments", expectedSegments[8], code);
  const normalizeIdentity = (candidate) => candidate.split("/").map((segment, index) =>
    [1, 2, 3, 5, 6, 7].includes(index) ? segment.toLowerCase() : segment,
  ).join("/");
  failIf(normalizeIdentity(value) !== normalizeIdentity(expected), code);
}

function reviewedRelayFqdn(reviewed, code) {
  const relay = reviewed?.after?.containers?.find((container) => container.name === "relay");
  const entry = relay?.env?.find((candidate) => candidate.name === "PALANCAR_RELAY_ORIGIN");
  failIf(!entry || typeof entry.value !== "string", code);
  let origin;
  try {
    origin = new URL(entry.value);
  } catch {
    reject(code);
  }
  failIf(origin.protocol !== "wss:" || origin.username || origin.password || origin.port ||
    origin.search || origin.hash || (origin.pathname !== "/" && origin.pathname !== ""), code);
  failIf(!LIVE_FQDN_RE.test(origin.hostname), code);
  return origin.hostname;
}

function assertLiveFqdn(value, expected, code) {
  failIf(typeof value !== "string" || value !== value.trim() || value.endsWith("."), code);
  const canonical = value.toLowerCase();
  const expectedCanonical = typeof expected === "string" ? expected.toLowerCase() : undefined;
  failIf(!LIVE_FQDN_RE.test(canonical) || canonical !== expectedCanonical, code);
  return canonical;
}

function liveEnvironmentSuffix(appFqdn, code) {
  const canonical = assertLiveFqdn(appFqdn, appFqdn, code);
  const labels = canonical.split(".");
  failIf(labels.length < 3, code);
  return labels.slice(1).join(".");
}

function liveRevisionFqdn(appFqdn, revisionName, code) {
  failIf(typeof revisionName !== "string" || revisionName.length === 0 || revisionName.includes("."), code);
  return `${revisionName}.${liveEnvironmentSuffix(appFqdn, code)}`;
}

function normalizeLiveResourceTuple(resources, code, requireStorage) {
  assertKnownKeys(resources, ["cpu", "memory", "ephemeralStorage"], code);
  assertRequiredKeys(resources, ["cpu", "memory"], code);
  const expectedStorage = resources.cpu === 0.25 && resources.memory === "0.5Gi"
    ? "1Gi"
    : resources.cpu === 0.75 && resources.memory === "1.5Gi"
      ? "4Gi"
      : undefined;
  failIf(expectedStorage === undefined, code);
  if (requireStorage) assertRequiredKeys(resources, ["ephemeralStorage"], code);
  if (requireStorage) {
    failIf(resources.ephemeralStorage !== expectedStorage, code);
  } else {
    failIf(Object.hasOwn(resources, "ephemeralStorage"), code);
  }
  return { cpu: resources.cpu, memory: resources.memory };
}

function normalizeLiveProbe(probe, code) {
  assertKnownKeys(probe, [
    "failureThreshold", "initialDelaySeconds", "periodSeconds", "tcpSocket", "httpGet", "timeoutSeconds", "type",
  ], code);
  assertRequiredKeys(probe, ["failureThreshold", "periodSeconds", "timeoutSeconds", "type"], code);
  failIf(!["Liveness", "Readiness", "Startup"].includes(probe.type) ||
    !Number.isInteger(probe.failureThreshold) || probe.failureThreshold < 1 ||
    !Number.isInteger(probe.periodSeconds) || probe.periodSeconds < 1 ||
    !Number.isInteger(probe.timeoutSeconds) || probe.timeoutSeconds < 1, code);
  if (Object.hasOwn(probe, "initialDelaySeconds")) {
    failIf(!Number.isInteger(probe.initialDelaySeconds) || probe.initialDelaySeconds < 0, code);
  }
  const hasTcp = Object.hasOwn(probe, "tcpSocket");
  const hasHttp = Object.hasOwn(probe, "httpGet");
  failIf(hasTcp === hasHttp, code);
  if (hasTcp) {
    assertKnownKeys(probe.tcpSocket, ["port"], code);
    assertRequiredKeys(probe.tcpSocket, ["port"], code);
    failIf(!Number.isInteger(probe.tcpSocket.port) || probe.tcpSocket.port < 1 || probe.tcpSocket.port > 65535, code);
  } else {
    assertKnownKeys(probe.httpGet, ["path", "port"], code);
    assertRequiredKeys(probe.httpGet, ["path", "port"], code);
    failIf(typeof probe.httpGet.path !== "string" || probe.httpGet.path.length === 0 ||
      !Number.isInteger(probe.httpGet.port) || probe.httpGet.port < 1 || probe.httpGet.port > 65535, code);
  }
  return structuredClone(probe);
}

function normalizeLiveCommand(value, code) {
  if (value === null || value === undefined) return undefined;
  failIf(!Array.isArray(value) || value.some((item) => typeof item !== "string"), code);
  return [...value];
}

function normalizeLiveContainer(container, code, source) {
  assertKnownKeys(container, ["name", "image", "imageType", "env", "resources", "probes", "command", "args"], code);
  assertRequiredKeys(container, ["name", "image", "env", "resources", ...(source === "app" ? ["imageType"] : [])], code);
  failIf(typeof container.name !== "string" || typeof container.image !== "string", code);
  const env = assertEnvironmentEntries(container.env, code).map((entry) => ({ ...entry }));
  // Older Container Apps API responses synthesized a default probe for
  // containers with none configured; newer responses omit the key. The
  // Terraform template configures no probes, so absent/null is the
  // expected live shape.
  const rawProbes = container.probes ?? [];
  failIf(!Array.isArray(rawProbes), code);
  const probes = rawProbes.map((probe) => normalizeLiveProbe(probe, code));
  const command = normalizeLiveCommand(container.command, code);
  const args = normalizeLiveCommand(container.args, code);
  if (source === "app") {
    failIf(container.imageType !== "ContainerImage", code);
  } else {
    failIf(Object.hasOwn(container, "imageType"), code);
  }
  const resources = container.resources === undefined
    ? undefined
    : normalizeLiveResourceTuple(container.resources, code, source === "app");
  return {
    name: container.name,
    image: container.image,
    env,
    ...(probes.length === 0 ? {} : { probes }),
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(resources === undefined ? {} : { resources }),
  };
}

function normalizeLiveScale(scale, code) {
  if (scale === undefined) return undefined;
  assertKnownKeys(scale, ["minReplicas", "maxReplicas", "cooldownPeriod", "pollingInterval", "rules"], code);
  assertRequiredKeys(scale, ["minReplicas", "maxReplicas"], code);
  // Newer API responses report null for unset cooldown/polling instead of
  // omitting the keys or echoing the platform defaults.
  if (Object.hasOwn(scale, "cooldownPeriod")) failIf(scale.cooldownPeriod !== 300 && scale.cooldownPeriod !== null, code);
  if (Object.hasOwn(scale, "pollingInterval")) failIf(scale.pollingInterval !== 30 && scale.pollingInterval !== null, code);
  if (Object.hasOwn(scale, "rules")) failIf(scale.rules !== null, code);
  return { minReplicas: scale.minReplicas, maxReplicas: scale.maxReplicas };
}

function normalizeLiveTemplate(template, code, source) {
  const allowedKeys = ["containers", "initContainers", "scale", "revisionSuffix", "volumes", "serviceBinds", "terminationGracePeriodSeconds"];
  if (source === "app") allowedKeys.push("customMetricsSettings");
  assertKnownKeys(template, allowedKeys, code);
  assertRequiredKeys(template, ["containers"], code);
  failIf(!Array.isArray(template.containers) || template.containers.length === 0, code);
  if (Object.hasOwn(template, "initContainers")) failIf(template.initContainers !== null, code);
  if (Object.hasOwn(template, "volumes")) failIf(template.volumes !== null, code);
  for (const key of ["serviceBinds", "terminationGracePeriodSeconds", ...(source === "app" ? ["customMetricsSettings"] : [])]) {
    if (Object.hasOwn(template, key)) failIf(template[key] !== null, code);
  }
  if (Object.hasOwn(template, "revisionSuffix")) {
    failIf(template.revisionSuffix !== (source === "app" ? "" : null), code);
  }
  const containers = template.containers.map((container) => normalizeLiveContainer(container, code, source));
  let scale;
  if (source === "revision") {
    assertRequiredKeys(template, ["scale"], code);
    assertKnownKeys(template.scale, ["minReplicas", "maxReplicas", "cooldownPeriod", "pollingInterval", "rules"], code);
    assertRequiredKeys(template.scale, ["minReplicas", "maxReplicas", "cooldownPeriod", "pollingInterval", "rules"], code);
    failIf(template.scale.cooldownPeriod !== null || template.scale.pollingInterval !== null || template.scale.rules !== null, code);
    scale = { minReplicas: template.scale.minReplicas, maxReplicas: template.scale.maxReplicas };
  } else {
    scale = normalizeLiveScale(template.scale, code);
  }
  return { containers, ...(scale === undefined ? {} : { scale }) };
}

function normalizeLiveIngress(ingress, expectedFqdn, code) {
  assertKnownKeys(ingress, [
    "external", "targetPort", "transport", "allowInsecure", "traffic", "fqdn", "exposedPort",
    "clientCertificateMode", "corsPolicy", "customDomains", "ipSecurityRestrictions", "stickySessions",
    "additionalPortMappings", "targetPortHttpScheme",
  ], code);
  assertRequiredKeys(ingress, ["external", "targetPort", "transport", "allowInsecure", "traffic", "fqdn", "exposedPort"], code);
  failIf(ingress.external !== true || ingress.targetPort !== 8787 || ingress.transport !== "Http" || ingress.allowInsecure !== false, code);
  if (Object.hasOwn(ingress, "fqdn")) assertLiveFqdn(ingress.fqdn, expectedFqdn, code);
  if (Object.hasOwn(ingress, "exposedPort")) failIf(ingress.exposedPort !== 0, code);
  for (const key of ["clientCertificateMode", "corsPolicy", "customDomains", "ipSecurityRestrictions", "stickySessions", "additionalPortMappings", "targetPortHttpScheme"]) {
    if (Object.hasOwn(ingress, key)) failIf(ingress[key] !== null, code);
  }
  failIf(!Array.isArray(ingress.traffic) || ingress.traffic.length !== 1, code);
  const traffic = ingress.traffic[0];
  assertKnownKeys(traffic, ["revisionName", "weight", "latestRevision"], code);
  assertRequiredKeys(traffic, ["weight"], code);
  failIf(traffic.weight !== 100, code);
  if (traffic.latestRevision === true) {
    failIf(Object.hasOwn(traffic, "revisionName"), code);
    return { external: ingress.external, targetPort: ingress.targetPort, transport: ingress.transport, allowInsecure: ingress.allowInsecure, traffic: [{ latestRevision: true, weight: 100 }] };
  }
  failIf(typeof traffic.revisionName !== "string" || traffic.revisionName.length === 0 ||
    Object.hasOwn(traffic, "latestRevision"), code);
  return { external: ingress.external, targetPort: ingress.targetPort, transport: ingress.transport, allowInsecure: ingress.allowInsecure, traffic: [{ revisionName: traffic.revisionName, weight: 100 }] };
}

function normalizeLiveConfiguration(configuration, outputs, reviewed, expectedFqdn, code) {
  assertKnownKeys(configuration, [
    "activeRevisionsMode", "ingress", "maxInactiveRevisions", "registries", "identitySettings", "secrets",
    "dapr", "runtime", "service", "revisionTransitionThreshold", "targetLabel",
  ], code);
  assertRequiredKeys(configuration, ["activeRevisionsMode", "ingress", "maxInactiveRevisions", "registries", "identitySettings", "secrets"], code);
  failIf(configuration.activeRevisionsMode !== "Single" || (configuration.maxInactiveRevisions !== 1 && configuration.maxInactiveRevisions !== null), code);
  for (const key of ["dapr", "runtime", "service", "revisionTransitionThreshold"]) {
    if (Object.hasOwn(configuration, key)) failIf(configuration[key] !== null, code);
  }
  if (Object.hasOwn(configuration, "targetLabel")) failIf(configuration.targetLabel !== "", code);
  const ingress = normalizeLiveIngress(configuration.ingress, expectedFqdn, code);
  failIf(!Array.isArray(configuration.registries) || configuration.registries.length !== 1, code);
  const registry = configuration.registries[0];
  assertKnownKeys(registry, ["server", "identity", "username", "passwordSecretRef"], code);
  assertRequiredKeys(registry, ["server", "identity"], code);
  if (Object.hasOwn(registry, "username")) failIf(registry.username !== "", code);
  if (Object.hasOwn(registry, "passwordSecretRef")) failIf(registry.passwordSecretRef !== "", code);
  const reviewedRegistry = reviewed.after.registries[0];
  failIf(reviewedRegistry === undefined || registry.server !== reviewedRegistry.server ||
    identityKey(registry.identity) !== reviewedRegistry.identity ||
    identityKey(registry.identity) !== identityKey(outputs.imagePullIdentityId), code);
  failIf(!Array.isArray(configuration.identitySettings) || configuration.identitySettings.length !== 2, code);
  const settings = configuration.identitySettings.map((setting) => {
    assertKnownKeys(setting, ["identity", "lifecycle"], code);
    assertRequiredKeys(setting, ["identity", "lifecycle"], code);
    failIf(typeof setting.identity !== "string", code);
    return { identity: identityKey(setting.identity), lifecycle: setting.lifecycle };
  });
  const settingMap = new Map(settings.map((setting) => [setting.identity, setting.lifecycle]));
  failIf(settingMap.get(identityKey(outputs.imagePullIdentityId)) !== "None" || settingMap.get(identityKey(outputs.runtimeIdentityId)) !== "Main", code);
  failIf(settings[0].identity !== identityKey(outputs.imagePullIdentityId) || settings[0].lifecycle !== "None" ||
    settings[1].identity !== identityKey(outputs.runtimeIdentityId) || settings[1].lifecycle !== "Main", code);
  // Newer Container Apps API responses serialize the empty secrets
  // collection as null instead of [].
  failIf(configuration.secrets !== null && !Array.isArray(configuration.secrets), code);
  return {
    activeRevisionsMode: configuration.activeRevisionsMode,
    ingress,
    maxInactiveRevisions: configuration.maxInactiveRevisions,
    registries: [{ server: registry.server, identity: identityKey(registry.identity) }],
    identitySettings: settings,
    secrets: (configuration.secrets ?? []).map((secret) => ({ ...secret })),
  };
}

function assertContainerAppResponse(value, outputs, reviewed, code) {
  assertKnownKeys(value, ["id", "name", "resourceGroup", "location", "type", "identity", "properties", "tags", "systemData", "kind", "managedBy", "sku"], code);
  assertRequiredKeys(value, ["id", "name", "resourceGroup", "location", "type", "identity", "properties"], code);
  const liveLocation = canonicalAzureRegion(value.location, code);
  const outputLocation = canonicalAzureRegion(outputs.region, code);
  failIf(value.name !== outputs.relayContainerApp || liveLocation !== outputLocation, code);
  assertLiveResourceType(value.type, "Microsoft.App/containerApps", code);
  assertLiveResourceId(value.id, outputs, "containerApps", outputs.relayContainerApp, code);
  failIf(value.resourceGroup !== outputs.resourceGroup, code);
  const expectedFqdn = reviewedRelayFqdn(reviewed, code);
  const properties = value.properties;
  assertKnownKeys(properties, [
    "managedEnvironmentId", "provisioningState", "runningStatus", "latestRevisionName", "latestReadyRevisionName",
    "latestRevisionFqdn", "configuration", "template", "eventStreamEndpoint",
    "outboundIpAddresses", "customDomainVerificationId", "workloadProfileName",
    "workloadProfileType", "delegatedSubnetId", "environmentId", "delegatedIdentities", "patchingMode",
  ], code);
  assertRequiredKeys(properties, ["configuration", "template", "provisioningState", "runningStatus"], code);
  failIf(properties.provisioningState !== "Succeeded" || properties.runningStatus !== "Running", code);
  if (Object.hasOwn(properties, "managedEnvironmentId")) assertLiveManagedEnvironmentId(properties.managedEnvironmentId, outputs, code);
  if (Object.hasOwn(properties, "environmentId")) assertLiveManagedEnvironmentId(properties.environmentId, outputs, code);
  if (Object.hasOwn(properties, "delegatedIdentities")) failIf(!Array.isArray(properties.delegatedIdentities) || properties.delegatedIdentities.length !== 0, code);
  if (Object.hasOwn(properties, "patchingMode")) failIf(properties.patchingMode !== "Automatic", code);
  const latestKeys = ["latestRevisionName", "latestReadyRevisionName", "latestRevisionFqdn"];
  assertRequiredKeys(properties, latestKeys, code);
  {
    failIf(typeof properties.latestRevisionName !== "string" || typeof properties.latestReadyRevisionName !== "string", code);
    assertLiveFqdn(properties.latestRevisionFqdn, liveRevisionFqdn(expectedFqdn, properties.latestRevisionName, code), code);
  }
  const configuration = normalizeLiveConfiguration(properties.configuration, outputs, reviewed, expectedFqdn, code);
  const template = normalizeLiveTemplate(properties.template, code, "app");
  const identity = value.identity;
  assertKnownKeys(identity, ["type", "userAssignedIdentities"], code);
  assertRequiredKeys(identity, ["type", "userAssignedIdentities"], code);
  failIf(identity.type !== "UserAssigned" || !isObject(identity.userAssignedIdentities), code);
  const identityIds = Object.keys(identity.userAssignedIdentities);
  failIf(identityIds.length !== 2, code);
  for (const id of [outputs.imagePullIdentityId, outputs.runtimeIdentityId]) {
    const actual = identityIds.find((candidate) => identityKey(candidate) === identityKey(id));
    failIf(!actual, code);
    assertKnownKeys(identity.userAssignedIdentities[actual], ["clientId", "principalId"], code);
    assertRequiredKeys(identity.userAssignedIdentities[actual], ["clientId", "principalId"], code);
    failIf(!UUID_RE.test(identity.userAssignedIdentities[actual].clientId) || !UUID_RE.test(identity.userAssignedIdentities[actual].principalId), code);
  }
  const normalizedProperties = {
    provisioningState: properties.provisioningState,
    runningStatus: properties.runningStatus,
    configuration,
    template,
    ...(Object.hasOwn(properties, "latestRevisionName") ? {
      latestRevisionName: properties.latestRevisionName,
      latestReadyRevisionName: properties.latestReadyRevisionName,
      latestRevisionFqdn: properties.latestRevisionFqdn,
    } : {}),
  };
  const normalizedValue = {
    id: value.id,
    name: value.name,
    location: value.location,
    type: value.type,
    identity: structuredClone(identity),
    properties: normalizedProperties,
  };
  return {
    value: normalizedValue,
    properties: normalizedProperties,
    configuration,
    ingress: configuration.ingress,
    template,
    identity: normalizedValue.identity,
    location: liveLocation,
    fqdn: expectedFqdn,
  };
}

function assertSecretConfiguration(configuration, outputs, mode, code) {
  // Newer Container Apps API responses serialize the empty secrets
  // collection as null instead of [].
  const secrets = configuration.secrets ?? [];
  failIf(!Array.isArray(secrets), code);
  configuration = { ...configuration, secrets };
  if (mode === "pre") {
    failIf(configuration.secrets.length !== RETIRED_SECRET_NAMES.length, code);
    const names = new Set();
    for (const secret of configuration.secrets) {
      assertKnownKeys(secret, ["name", "keyVaultUrl", "identity"], code);
      assertRequiredKeys(secret, ["name", "keyVaultUrl", "identity"], code);
      failIf(!RETIRED_SECRET_NAMES.includes(secret.name) || names.has(secret.name), code);
      names.add(secret.name);
      const vaultUri = assertHttpsEndpoint(outputs.keyVaultUri, code);
      failIf(secret.keyVaultUrl !== `${vaultUri}/secrets/${secret.name}`, code);
      failIf(identityKey(secret.identity) !== identityKey(outputs.runtimeIdentityId), code);
    }
    failIf(names.size !== RETIRED_SECRET_NAMES.length, code);
    return;
  }
  failIf(configuration.secrets.length !== 0, code);
}

function environmentMap(container, code) {
  return new Map(assertEnvironmentEntries(container.env, code).map((entry) => [entry.name, entry]));
}

function assertNoRetiredReferences(value, code) {
  const references = [];
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!isObject(entry)) return;
    for (const [key, child] of Object.entries(entry)) {
      if (key === "secretRef" || key === "keyVaultUrl") references.push(child);
      visit(child);
    }
  };
  visit(value);
  failIf(references.length !== 0, code);
  return references;
}

function assertNoRetiredProviderText(value, code) {
  const visit = (entry) => {
    if (typeof entry === "string") {
      failIf(/(?:LIT(?:ELLM)|OPEN(?:ROUTER))/i.test(entry), code);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (isObject(entry)) Object.values(entry).forEach(visit);
  };
  visit(value);
}

function assertReviewedTopology(app, outputs, reviewed, mode, code, options = {}) {
  const expected = mode === "pre" ? reviewed.before : reviewed.after;
  failIf(expected === undefined, code);
  const actual = canonicalRuntimeShape(app.value, code);
  const canonicalIngressComparison = (ingress, sourceCode, source) => {
    failIf(!isObject(ingress), sourceCode);
    assertKnownKeys(ingress, ["external", "targetPort", "transport", "allowInsecure", "traffic"], sourceCode);
    assertRequiredKeys(ingress, ["external", "targetPort", "transport", "allowInsecure", "traffic"], sourceCode);
    failIf(!Array.isArray(ingress.traffic) || ingress.traffic.length !== 1, sourceCode);
    const traffic = ingress.traffic[0];
    assertKnownKeys(traffic, ["revisionName", "latestRevision", "weight"], sourceCode);
    assertRequiredKeys(traffic, ["weight"], sourceCode);
    failIf(traffic.weight !== 100, sourceCode);
    if (source === "reviewed") {
      failIf(traffic.latestRevision !== true || Object.hasOwn(traffic, "revisionName"), sourceCode);
    } else {
      failIf(typeof traffic.revisionName !== "string" || traffic.revisionName.length === 0 ||
        Object.hasOwn(traffic, "latestRevision"), sourceCode);
    }
    return {
      external: ingress.external,
      targetPort: ingress.targetPort,
      transport: ingress.transport,
      allowInsecure: ingress.allowInsecure,
      traffic: [{ weight: traffic.weight }],
    };
  };
  const expectedIngress = expected.ingress === undefined
    ? undefined
    : canonicalIngressComparison(expected.ingress, code, "reviewed");
  const actualIngress = actual.ingress === undefined
    ? undefined
    : canonicalIngressComparison(actual.ingress, code, "live");
  const projectContainers = (containers) => options.compareEnvironmentValues === false
    ? containers.map((container) => ({
        ...container,
        env: container.env.map((entry) => ({
          name: entry.name,
          ...(entry.secretRef === undefined ? {} : { secretRef: entry.secretRef }),
        })),
      }))
    : containers;
  const expectedShape = {
    containers: projectContainers(expected.containers),
    ...(expected.scale === undefined ? {} : { scale: expected.scale }),
    ...(expected.maxInactiveRevisions === undefined ? {} : { maxInactiveRevisions: expected.maxInactiveRevisions }),
    ...(expectedIngress === undefined ? {} : { ingress: expectedIngress }),
    registries: expected.registries,
    secrets: expected.secrets,
    identitySettings: expected.identitySettings,
    ...(expected.identity === undefined ? {} : { identity: expected.identity }),
  };
  const actualShape = {
    containers: projectContainers(actual.containers),
    ...(actual.scale === undefined ? {} : { scale: actual.scale }),
    ...(actual.maxInactiveRevisions === undefined ? {} : { maxInactiveRevisions: actual.maxInactiveRevisions }),
    ...(actualIngress === undefined ? {} : { ingress: actualIngress }),
    registries: actual.registries,
    secrets: actual.secrets,
    identitySettings: actual.identitySettings,
    ...(actual.identity === undefined ? {} : { identity: actual.identity }),
  };
  failIf(!same(actualShape, expectedShape), code);
  return expected;
}

function assertPreCutoverTopology(app, outputs, reviewed, expectedRevision) {
  assertReviewedTopology(app, outputs, reviewed, "pre", "runtime-topology");
  assertSecretConfiguration(app.configuration, outputs, "pre", "runtime-topology");
  failIf(app.template.containers.length < 2, "runtime-topology");
  const relay = app.template.containers.find((container) => container.name === "relay");
  const predecessor = app.template.containers.find((container) => container.name !== "relay");
  failIf(!relay, "runtime-topology");
  const relayEnv = environmentMap(relay, "runtime-topology");
  void relayEnv;
  failIf(!predecessor, "runtime-topology");
  failIf(app.ingress.traffic[0].revisionName !== expectedRevision, "runtime-revision");
  return { relay, predecessor, imageDigest: relay.image, revisionName: expectedRevision };
}

function expectedRealtimeEndpoint(outputs, code) {
  const endpoint = assertHttpsEndpoint(outputs.foundryEndpoint, code);
  return `wss://${new URL(endpoint).hostname}/openai/v1/realtime?intent=transcription`;
}

function assertPostCutoverTopology(app, outputs, reviewed, expectedRevision) {
  assertNoRetiredReferences(app, "credential-secret-reference");
  assertReviewedTopology(app, outputs, reviewed, "post", "credential-topology", { compareEnvironmentValues: false });
  assertSecretConfiguration(app.configuration, outputs, "post", "credential-topology");
  failIf(app.template.containers.length !== 1 || app.template.containers[0].name !== "relay", "credential-topology");
  const relay = app.template.containers[0];
  assertNoRetiredProviderText(app, "credential-topology");
  const env = environmentMap(relay, "credential-topology");
  const reviewedRelay = reviewed.after.containers.find((container) => container.name === "relay");
  const reviewedEnv = environmentMap({ env: reviewedRelay?.env }, "credential-topology");
  const directAzureNames = new Set([
    "PALANCAR_GENERATION_PROVIDER",
    "PALANCAR_AZURE_GENERATION_ENDPOINT",
    "PALANCAR_AZURE_GENERATION_DEPLOYMENT",
    "AZURE_CLIENT_ID",
    "PALANCAR_TRANSCRIPTION_PROVIDER",
    "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT",
    "PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT",
  ]);
  for (const [name, expectedEntry] of reviewedEnv) {
    const actualEntry = env.get(name);
    if (!directAzureNames.has(name)) {
      failIf(actualEntry?.value !== expectedEntry.value || actualEntry?.secretRef !== expectedEntry.secretRef, "credential-topology");
    }
  }
  const generationEndpoint = assertHttpsEndpoint(outputs.foundryEndpoint, "credential-direct-azure");
  failIf(
    env.get("PALANCAR_GENERATION_PROVIDER")?.value !== "azure-openai" ||
      env.get("PALANCAR_AZURE_GENERATION_ENDPOINT")?.value !== generationEndpoint ||
      env.get("PALANCAR_AZURE_GENERATION_DEPLOYMENT")?.value !== MODEL_BOOTSTRAP_CONTRACT.lunaDeployment ||
      env.get("AZURE_CLIENT_ID")?.value !== outputs.runtimeIdentityClientId ||
    env.get("PALANCAR_TRANSCRIPTION_PROVIDER")?.value !== "azure-realtime" ||
      env.get("PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT")?.value !== expectedRealtimeEndpoint(outputs, "credential-topology") ||
      env.get("PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT")?.value !== MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment,
    "credential-direct-azure",
  );
  for (const entry of env.values()) {
    failIf(/(?:API[_-]?KEY|INFERENCE[_-]?SCOPE|GENERATION[_-]?API[_-]?VERSION)/i.test(entry.name), "credential-topology");
  }
  failIf(!isObject(relay.resources) || relay.resources.cpu !== 0.25 || relay.resources.memory !== "0.5Gi", "credential-topology");
  failIf(!isObject(app.template.scale) || app.template.scale.minReplicas !== 1 || app.template.scale.maxReplicas !== 1, "credential-topology");
  failIf(app.ingress.traffic[0].revisionName !== expectedRevision, "credential-revision");
  return { relay, imageDigest: relay.image, revisionName: expectedRevision };
}

function assertPostCutoverTemplateSecurity(app, template, reviewed) {
  assertNoRetiredReferences(template, "credential-secret-reference");
  assertNoRetiredProviderText(template, "credential-topology");
  failIf(template.containers.length !== 1 || template.containers[0].name !== "relay", "credential-topology");
  const env = environmentMap(template.containers[0], "credential-topology");
  const reviewedRelay = reviewed.after.containers.find((container) => container.name === "relay");
  const reviewedEnv = environmentMap({ env: reviewedRelay?.env }, "credential-topology");
  const directAzureNames = new Set([
    "PALANCAR_GENERATION_PROVIDER",
    "PALANCAR_AZURE_GENERATION_ENDPOINT",
    "PALANCAR_AZURE_GENERATION_DEPLOYMENT",
    "AZURE_CLIENT_ID",
    "PALANCAR_TRANSCRIPTION_PROVIDER",
    "PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT",
    "PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT",
  ]);
  for (const [name, expectedEntry] of reviewedEnv) {
    const actualEntry = env.get(name);
    if (!directAzureNames.has(name)) {
      failIf(actualEntry?.value !== expectedEntry.value || actualEntry?.secretRef !== expectedEntry.secretRef, "credential-topology");
    }
  }
  const generationEndpoint = assertHttpsEndpoint(app.outputs.foundryEndpoint, "credential-direct-azure");
  failIf(
    env.get("PALANCAR_GENERATION_PROVIDER")?.value !== "azure-openai" ||
      env.get("PALANCAR_AZURE_GENERATION_ENDPOINT")?.value !== generationEndpoint ||
      env.get("PALANCAR_AZURE_GENERATION_DEPLOYMENT")?.value !== MODEL_BOOTSTRAP_CONTRACT.lunaDeployment ||
      env.get("AZURE_CLIENT_ID")?.value !== app.outputs.runtimeIdentityClientId ||
      env.get("PALANCAR_TRANSCRIPTION_PROVIDER")?.value !== "azure-realtime" ||
      env.get("PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT")?.value !== expectedRealtimeEndpoint(app.outputs, "credential-topology") ||
      env.get("PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT")?.value !== MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment,
    "credential-direct-azure",
  );
  for (const entry of env.values()) {
    failIf(/(?:API[_-]?KEY|INFERENCE[_-]?SCOPE|GENERATION[_-]?API[_-]?VERSION)/i.test(entry.name), "credential-topology");
  }
}

function assertInactiveRevisionTemplate(template, reviewed, mode, code) {
  assertContainerTemplate(template, code);
  assertKnownKeys(template, ["containers", "scale"], code);
  assertRequiredKeys(template, ["containers", "scale"], code);
  assertKnownKeys(template.scale, ["minReplicas", "maxReplicas"], code);
  assertRequiredKeys(template.scale, ["minReplicas", "maxReplicas"], code);
  failIf(template.volumes !== undefined || template.revisionSuffix !== undefined, code);
  const expected = mode === "post" ? reviewed.before : reviewed.after;
  failIf(!same(
    template.containers.map((container) => canonicalRuntimeContainer(container, code)),
    expected.containers,
  ), code);
  failIf(!same(template.scale, expected.scale), code);
}

function normalizeLiveRevision(value, app, outputs, code) {
  assertKnownKeys(value, ["id", "name", "resourceGroup", "type", "properties", "location", "tags", "systemData"], code);
  assertRequiredKeys(value, ["id", "name", "resourceGroup", "type", "properties"], code);
  failIf(value.resourceGroup !== outputs.resourceGroup, code);
  assertLiveResourceType(value.type, "Microsoft.App/containerApps/revisions", code);
  assertLiveResourceId(value.id, outputs, "containerApps", outputs.relayContainerApp, code, value.name);
  if (Object.hasOwn(value, "location")) {
    const location = canonicalAzureRegion(value.location, code);
    failIf(location !== app.location, code);
  }
  const properties = value.properties;
  assertKnownKeys(properties, [
    "active", "healthState", "provisioningState", "runningState", "trafficWeight", "template",
    "createdTime", "lastActiveTime", "replicas", "replicaCount", "fqdn",
  ], code);
  assertRequiredKeys(properties, ["active", "healthState", "provisioningState", "runningState", "trafficWeight", "template"], code);
  failIf(typeof value.name !== "string" || typeof properties.active !== "boolean", code);
  const allowedRunningStates = properties.active
    ? ["Running", "RunningAtMaxScale"]
    : ["Running", "Stopped"];
  failIf(properties.healthState !== "Healthy" || properties.provisioningState !== "Provisioned" ||
    !allowedRunningStates.includes(properties.runningState), code);
  failIf(Object.hasOwn(properties, "replicas") && Object.hasOwn(properties, "replicaCount"), code);
  const reportedReplicas = Object.hasOwn(properties, "replicas") ? properties.replicas : properties.replicaCount;
  if (reportedReplicas !== undefined) {
    failIf(!Number.isInteger(reportedReplicas) || reportedReplicas < 0, code);
    if (properties.active) failIf(reportedReplicas !== 1, code);
  }
  if (properties.active) failIf(reportedReplicas !== 1, code);
  assertRequiredKeys(properties, ["fqdn"], code);
  assertLiveFqdn(properties.fqdn, liveRevisionFqdn(app.fqdn, value.name, code), code);
  const sourceTemplate = normalizeLiveTemplate(properties.template, `${code}-template`, "revision");
  const template = sourceTemplate;
  return {
    revision: {
      id: value.id,
      name: value.name,
      type: value.type,
      properties: {
        active: properties.active,
        healthState: properties.healthState,
        provisioningState: properties.provisioningState,
        runningState: properties.runningState,
        trafficWeight: properties.trafficWeight,
        template,
      },
    },
    properties: {
      active: properties.active,
      healthState: properties.healthState,
      provisioningState: properties.provisioningState,
      runningState: properties.runningState,
      trafficWeight: properties.trafficWeight,
      template,
      reportedReplicas,
    },
  };
}

function assertRevisionResponse(value, app, reviewed, expectedRevision, expectedInactiveRevision, mode, phase, code, options = {}) {
  const allowedModes = {
    "runtime-cutover": new Set(["pre", "post"]),
    "credential-cleanup": new Set(["post"]),
    terminal: new Set(["post"]),
  };
  failIf(!Object.hasOwn(allowedModes, phase) || !allowedModes[phase].has(mode), `${code}-phase`);
  failIf(!isObject(reviewed.before) || !isObject(reviewed.after), `${code}-inactive`);
  const runtimePre = phase === "runtime-cutover" && mode === "pre";
  if (phase === "runtime-cutover") {
    failIf(
      Object.hasOwn(reviewed.before, "maxInactiveRevisions") ||
        reviewed.after.maxInactiveRevisions !== 1,
      `${code}-inactive`,
    );
  } else {
    failIf(
      reviewed.before.maxInactiveRevisions !== 1 || reviewed.after.maxInactiveRevisions !== 1,
      `${code}-inactive`,
    );
  }
  failIf(!Array.isArray(value) || value.length === 0, code);
  const revisions = value.map((revision) => normalizeLiveRevision(revision, app, app.outputs, code));
  const active = revisions.filter(({ properties }) => properties.active === true);
  failIf(active.length !== 1, `${code}-active`);
  const inactive = revisions.filter(({ properties }) => properties.active === false);
  if (runtimePre) {
    failIf(inactive.length !== 0, `${code}-set`);
  } else {
    // Azure retention eventually purges the retained predecessor entirely,
    // so post-cutover phases may legitimately observe zero inactive
    // revisions; more than one violates maxInactiveRevisions = 1.
    failIf(inactive.length > 1, `${code}-set`);
  }
  const retainedPredecessor = options.inactiveRevisionContract;
  if (retainedPredecessor !== undefined) {
    failIf(
      !isObject(retainedPredecessor) ||
        typeof retainedPredecessor.revisionName !== "string" ||
        !isObject(retainedPredecessor.reviewed),
      `${code}-inactive`,
    );
  }
  if (runtimePre) {
    failIf(retainedPredecessor !== undefined || expectedInactiveRevision !== undefined, `${code}-inactive`);
  } else {
    failIf(
      retainedPredecessor !== undefined &&
        expectedInactiveRevision !== undefined &&
        retainedPredecessor.revisionName !== expectedInactiveRevision,
      `${code}-inactive`,
    );
    if (inactive.length === 1) {
      const boundInactiveRevision = retainedPredecessor?.revisionName ?? expectedInactiveRevision;
      if (boundInactiveRevision !== undefined) {
        failIf(typeof boundInactiveRevision !== "string" || boundInactiveRevision.length === 0, `${code}-inactive`);
        failIf(inactive[0]?.revision.name !== boundInactiveRevision, `${code}-inactive`);
      }
    }
  }
  const selected = active[0];
  const selectedName = selected.revision.name;
  failIf(expectedRevision !== undefined && selectedName !== expectedRevision, `${code}-traffic`);
  failIf(selected.properties.trafficWeight !== 100, `${code}-traffic`);
  failIf(app.ingress.traffic.length !== 1 || app.ingress.traffic[0].weight !== 100, `${code}-traffic`);
  const traffic = app.ingress.traffic[0];
  if (traffic.latestRevision === true) {
    failIf(Object.hasOwn(traffic, "revisionName"), `${code}-traffic`);
  } else {
    failIf(traffic.revisionName !== selectedName, `${code}-traffic`);
  }
  const reconciledTraffic = [{ revisionName: selectedName, weight: 100 }];
  if (app.properties.latestRevisionName !== undefined) {
    failIf(app.properties.latestRevisionName !== selectedName || app.properties.latestReadyRevisionName !== selectedName ||
      app.properties.latestRevisionFqdn.toLowerCase() !== liveRevisionFqdn(app.fqdn, selectedName, `${code}-traffic`).toLowerCase(), `${code}-traffic`);
  }
  const appTemplate = canonicalRuntimeTemplate(app.template, `${code}-template`);
  const revisionTemplate = canonicalRuntimeTemplate(selected.properties.template, `${code}-template`);
  failIf(!same(appTemplate, revisionTemplate), `${code}-template`);
  if (mode === "post") {
    assertPostCutoverTemplateSecurity(app, selected.properties.template, reviewed);
  }
  for (const candidate of inactive) {
    failIf(candidate.properties.trafficWeight !== 0, `${code}-inactive`);
    if (candidate.properties.reportedReplicas !== undefined) failIf(candidate.properties.reportedReplicas !== 0, `${code}-inactive`);
    const inactiveReviewed = retainedPredecessor?.reviewed ?? reviewed;
    const inactiveMode = retainedPredecessor === undefined ? mode : "post";
    assertInactiveRevisionTemplate(candidate.properties.template, inactiveReviewed, inactiveMode, `${code}-inactive`);
  }
  const expectedTemplate = mode === "pre" ? reviewed.before : reviewed.after;
  failIf(
    !same(
      projectRuntimeTemplateEnvironment(revisionTemplate, options.compareEnvironmentValues ?? mode === "pre"),
      projectRuntimeTemplateEnvironment({
        containers: expectedTemplate.containers,
        ...(expectedTemplate.scale === undefined ? {} : { scale: expectedTemplate.scale }),
      }, options.compareEnvironmentValues ?? mode === "pre"),
    ),
    `${code}-template`,
  );
  failIf(app.configuration.activeRevisionsMode !== "Single", `${code}-inactive`);
  if (runtimePre) {
    failIf(app.configuration.maxInactiveRevisions !== null, `${code}-inactive`);
  } else {
    failIf(expectedTemplate.maxInactiveRevisions !== 1, `${code}-inactive`);
    failIf(app.configuration.maxInactiveRevisions !== 1 && app.configuration.maxInactiveRevisions !== null, `${code}-inactive`);
  }
  const projectedConfiguration = {
    ...app.configuration,
    maxInactiveRevisions: 1,
    ingress: { ...app.configuration.ingress, traffic: reconciledTraffic },
  };
  if (runtimePre) delete projectedConfiguration.maxInactiveRevisions;
  const projectedProperties = {
    ...app.properties,
    configuration: projectedConfiguration,
  };
  const topologyApp = {
    ...app,
    value: { ...app.value, properties: projectedProperties },
    properties: projectedProperties,
    configuration: projectedConfiguration,
    ingress: projectedConfiguration.ingress,
  };
  const topology = mode === "pre"
    ? assertPreCutoverTopology(topologyApp, { ...app.outputs }, reviewed, selectedName)
    : assertPostCutoverTopology(topologyApp, { ...app.outputs }, reviewed, selectedName);
  return { revisions, selected, topology, revisionName: selectedName };
}

function parseContainerAppAndRevisions(config, outputs, request, mode) {
  const reviewed = reviewedRuntimeShapes(request.artifacts, request.phase);
  const appResponse = azJson(config, [
    "containerapp", "show", "--name", outputs.relayContainerApp,
    "--resource-group", outputs.resourceGroup,
    "--subscription", config.account.subscription,
    "--output", "json",
  ], "containerapp-show");
  const app = assertContainerAppResponse(appResponse, outputs, reviewed, mode === "pre" ? "runtime-containerapp" : "credential-containerapp");
  app.outputs = outputs;
  const expectedRevision = request.allowRevisionChange
    ? undefined
    : request.expectedRevision ?? request.manifest.bindings.liveRevision;
  if (expectedRevision !== undefined) {
    failIf(typeof expectedRevision !== "string" || expectedRevision.length === 0, `${mode === "pre" ? "runtime" : "credential"}-revision`);
  }
  const expectedInactiveRevision = mode === "post" && request.phase === "runtime-cutover"
    ? request.manifest.bindings.liveRevision
    : undefined;
  if (mode === "post" && request.phase === "runtime-cutover") {
    failIf(typeof expectedInactiveRevision !== "string" || expectedInactiveRevision.length === 0, "runtime-revision");
  }
  const revisionResponse = azJson(config, [
    "containerapp", "revision", "list", "--name", outputs.relayContainerApp,
    "--resource-group", outputs.resourceGroup,
    "--subscription", config.account.subscription,
    "--output", "json",
  ], "containerapp-revisions");
  const revision = assertRevisionResponse(
    revisionResponse,
    app,
    reviewed,
    expectedRevision,
    expectedInactiveRevision,
    mode,
    request.phase,
    mode === "pre" ? "runtime-revisions" : "credential-revisions",
    {
      inactiveRevisionContract: request.inactiveRevisionContract,
      compareEnvironmentValues: mode === "pre",
    },
  );
  return { appResponse, revisionResponse, app, revision };
}

function parseAccessToken(result, config) {
  const tokenResponse = parseCommandJson(result, "entra-token");
  assertKnownKeys(tokenResponse, ["accessToken", "expiresOn", "expires_on", "subscription", "tenant", "tokenType"], "entra-token");
  assertRequiredKeys(tokenResponse, ["accessToken", "expiresOn", "subscription", "tenant"], "entra-token");
  failIf(
      typeof tokenResponse.accessToken !== "string" || tokenResponse.accessToken.length < 20 ||
      typeof tokenResponse.expiresOn !== "string" || tokenResponse.subscription === undefined ||
      typeof tokenResponse.tenant !== "string" ||
      tokenResponse.expires_on !== undefined &&
        (typeof tokenResponse.expires_on !== "number" ||
          !Number.isFinite(tokenResponse.expires_on) ||
          !Number.isInteger(tokenResponse.expires_on) ||
          tokenResponse.expires_on <= 0) ||
      tokenResponse.subscription !== config.account.subscription ||
      tokenResponse.tenant !== config.account.tenant,
    "entra-token",
  );
  return tokenResponse.accessToken;
}

function privateHttpGet(config, request) {
  let result;
  if (config.privateHttpGet !== undefined) {
    try {
      result = config.privateHttpGet({
        method: "GET",
        url: request.url,
        headers: { Authorization: `Bearer ${request.token}`, Accept: "application/json" },
        timeoutMs: PRIVATE_HTTP_TIMEOUT_MS,
        maxBytes: PRIVATE_HTTP_MAX_BYTES,
      });
    } catch {
      reject("keyvault-http");
    }
  } else {
    const python = [
      "import json, ssl, sys, urllib.request",
      "request = json.loads(sys.stdin.read())",
      "context = ssl.create_default_context()",
      "req = urllib.request.Request(request['url'], headers={'Authorization': 'Bearer ' + request['token'], 'Accept': 'application/json'}, method='GET')",
      "try:",
      "    with urllib.request.urlopen(req, timeout=30, context=context) as response:",
      "        body = response.read(262145)",
      "        if len(body) > 262144: sys.exit(42)",
      "        print(json.dumps({'statusCode': response.status, 'body': body.decode('utf-8')}))",
      "except urllib.error.HTTPError as error:",
      "    body = error.read(262145)",
      "    if len(body) > 262144: sys.exit(42)",
      "    print(json.dumps({'statusCode': error.code, 'body': body.decode('utf-8')}))",
      "except Exception:",
      "    sys.exit(43)",
    ].join("\n");
    const processResult = spawnSync("/usr/bin/python3", ["-c", python], {
      input: JSON.stringify({ url: request.url, token: request.token }),
      encoding: "utf8",
      timeout: PRIVATE_HTTP_TIMEOUT_MS,
      maxBuffer: PRIVATE_HTTP_MAX_BYTES,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const bounded = boundedProcessResult(processResult);
    failIf(bounded.status !== "success", "keyvault-http");
    result = parseJsonText(bounded.stdout, "keyvault-http");
  }
  failIf(!isObject(result), "keyvault-http");
  assertKnownKeys(result, ["statusCode", "body", "headers"], "keyvault-http");
  assertRequiredKeys(result, ["statusCode", "body"], "keyvault-http");
  failIf(!Number.isInteger(result.statusCode) || typeof result.body !== "string" || Buffer.byteLength(result.body) > PRIVATE_HTTP_MAX_BYTES, "keyvault-http");
  return result;
}

function vaultDataPlaneBase(outputs, code) {
  const endpoint = assertHttpsEndpoint(outputs.keyVaultUri, code);
  const url = new URL(endpoint);
  failIf(!/^[a-z0-9-]+\.vault\.azure\.net$/.test(url.hostname), code);
  return endpoint;
}

function parseVaultList(result, outputs, allowRetired = false) {
  failIf(result.statusCode !== 200, "keyvault-secrets");
  const value = parseJsonText(result.body, "keyvault-secrets");
  assertKnownKeys(value, ["value", "nextLink"], "keyvault-secrets");
  assertRequiredKeys(value, ["value", "nextLink"], "keyvault-secrets");
  failIf(value.nextLink !== null || !Array.isArray(value.value), "keyvault-secrets-pagination");
  return value.value.map((secret) => {
    assertKnownKeys(secret, ["id", "attributes", "contentType", "tags", "managed", "name"], "keyvault-secrets");
    assertRequiredKeys(secret, ["id", "attributes"], "keyvault-secrets");
    failIf(typeof secret.id !== "string" || !isObject(secret.attributes), "keyvault-secrets");
    assertKnownKeys(secret.attributes, ["enabled", "created", "updated", "recoveryLevel", "recoverableDays"], "keyvault-secrets");
    assertRequiredKeys(secret.attributes, ["enabled"], "keyvault-secrets");
    failIf(typeof secret.attributes.enabled !== "boolean", "keyvault-secrets");
    const base = vaultDataPlaneBase(outputs, "keyvault-endpoint");
    const prefix = `${base}/secrets/`;
    failIf(!secret.id.startsWith(prefix), "keyvault-secrets-context");
    const match = /^([^/?#]+)(?:\/([^/?#]+))?$/u.exec(secret.id.slice(prefix.length));
    failIf(!match, "keyvault-secrets");
    if (!allowRetired && RETIRED_SECRET_NAMES.includes(match[1])) reject("keyvault-secret-present");
    failIf(match[2] !== undefined, "keyvault-secrets");
    failIf(typeof secret.name !== "undefined" && secret.name !== match[1], "keyvault-secrets");
    return match[1];
  });
}

function assertVaultSecretMissing(result) {
  failIf(result.statusCode !== 404, "keyvault-secret-present");
  const value = parseJsonText(result.body, "keyvault-secret-absence");
  assertKnownKeys(value, ["error"], "keyvault-secret-absence");
  assertRequiredKeys(value, ["error"], "keyvault-secret-absence");
  assertKnownKeys(value.error, ["code", "message"], "keyvault-secret-absence");
  assertRequiredKeys(value.error, ["code", "message"], "keyvault-secret-absence");
  failIf(value.error.code !== "SecretNotFound" || typeof value.error.message !== "string", "keyvault-secret-absence");
}

function verifyKeyVaultAbsence(config, outputs) {
  const tokenResult = runCommand(config, AZ_PATH, [
    "account", "get-access-token", "--resource", AZURE_VAULT_SCOPE, "--output", "json",
  ], { timeoutMs: COMMAND_TIMEOUT_MS });
  const token = parseAccessToken(tokenResult, config);
  const base = vaultDataPlaneBase(outputs, "keyvault-endpoint");
  const list = privateHttpGet(config, {
    url: `${base}/secrets?api-version=${AZURE_VAULT_API_VERSION}&maxresults=25`,
    token,
  });
  const names = parseVaultList(list, outputs);
  for (const name of RETIRED_SECRET_NAMES) {
    failIf(names.includes(name), "keyvault-secret-present");
    const missing = privateHttpGet(config, {
      url: `${base}/secrets/${name}?api-version=${AZURE_VAULT_API_VERSION}`,
      token,
    });
    assertVaultSecretMissing(missing);
  }
  return { status: "absent", secretNames: [] };
}

function verifyKeyVaultPresence(config, outputs) {
  const tokenResult = runCommand(config, AZ_PATH, [
    "account", "get-access-token", "--resource", AZURE_VAULT_SCOPE, "--output", "json",
  ], { timeoutMs: COMMAND_TIMEOUT_MS });
  const token = parseAccessToken(tokenResult, config);
  const base = vaultDataPlaneBase(outputs, "keyvault-endpoint");
  const list = privateHttpGet(config, {
    url: `${base}/secrets?api-version=${AZURE_VAULT_API_VERSION}&maxresults=25`,
    token,
  });
  const names = parseVaultList(list, outputs, true);
  const retired = names.filter((name) => RETIRED_SECRET_NAMES.includes(name));
  failIf(
    retired.length !== RETIRED_SECRET_NAMES.length ||
      new Set(retired).size !== RETIRED_SECRET_NAMES.length,
    "keyvault-secret-absence",
  );
  return { status: "present", secretNames: [...RETIRED_SECRET_NAMES] };
}

function roleDefinitionResourceId(subscription, roleUuid) {
  return `/subscriptions/${subscription}/providers/Microsoft.Authorization/roleDefinitions/${roleUuid}`;
}

function projectRoleAssignmentSecurityFields(assignment) {
  if (!isObject(assignment)) return {};
  return Object.fromEntries(
    ROLE_ASSIGNMENT_SECURITY_KEYS
      .filter((key) => Object.hasOwn(assignment, key))
      .map((key) => [key, assignment[key]]),
  );
}

function parseRoleAssignments(value, expected, code) {
  failIf(!Array.isArray(value), code);
  return value.map((rawAssignment) => {
    const assignment = projectRoleAssignmentSecurityFields(rawAssignment);
    assertKnownKeys(assignment, ROLE_ASSIGNMENT_SECURITY_KEYS, code);
    assertRequiredKeys(assignment, ROLE_ASSIGNMENT_SECURITY_KEYS, code);
    const validTypes = typeof assignment.id === "string" &&
      typeof assignment.principalId === "string" &&
      typeof assignment.principalType === "string" &&
      typeof assignment.roleDefinitionId === "string" &&
      typeof assignment.scope === "string";
    const assignmentPrefix = validTypes
      ? `${assignment.scope}/providers/Microsoft.Authorization/roleAssignments/`
      : "";
    const assignmentId = validTypes && assignment.id.startsWith(assignmentPrefix) &&
      UUID_RE.test(assignment.id.slice(assignmentPrefix.length));
    failIf(
        !validTypes ||
        !assignmentId ||
        !UUID_RE.test(assignment.principalId) ||
        assignment.principalId !== expected.principalId ||
        assignment.principalType !== "ServicePrincipal" ||
        assignment.roleDefinitionId !== expected.roleDefinitionId ||
        assignment.scope !== expected.scope,
      code,
    );
    return assignment;
  });
}

function verifyRoleAssignment(config, outputs, principalId, scope, roleUuid, required, code) {
  failIf(typeof scope !== "string" || scope.length === 0, code);
  const result = azJson(config, [
    "role", "assignment", "list",
    "--scope", scope,
    "--assignee-object-id", principalId,
    "--fill-principal-name", "false",
    "--fill-role-definition-name", "false",
    "-o", "json",
  ], code);
  const assignments = parseRoleAssignments(result, {
    principalId,
    roleDefinitionId: roleDefinitionResourceId(config.account.subscription, roleUuid),
    scope,
  }, code);
  failIf(required ? assignments.length !== 1 : assignments.length !== 0, `${code}-${required ? "missing" : "present"}`);
  return { required, count: assignments.length, scope, roleUuid };
}

function runtimePrincipalId(app, outputs, code) {
  failIf(!isObject(app.identity) || app.identity.type !== "UserAssigned" ||
    !isObject(app.identity.userAssignedIdentities), code);
  const identityIds = Object.keys(app.identity.userAssignedIdentities);
  const runtimeIdentityKey = identityKey(outputs.runtimeIdentityId, code);
  const identityId = identityIds.find((id) => identityKey(id, code) === runtimeIdentityKey);
  failIf(!identityId, code);
  const identity = app.identity.userAssignedIdentities[identityId];
  assertKnownKeys(identity, ["clientId", "principalId"], code);
  assertRequiredKeys(identity, ["clientId", "principalId"], code);
  failIf(identity.clientId !== outputs.runtimeIdentityClientId ||
    identity.principalId !== outputs.runtimeIdentityPrincipalId ||
    !UUID_RE.test(identity.principalId), code);
  return identity.principalId;
}

function verifyTerminalRbac(config, outputs, app) {
  const principalId = runtimePrincipalId(app, outputs, "terminal-rbac");
  const evidence = {
    retiredRuntimeSecrets: verifyRoleAssignment(
      config, outputs, principalId, outputs.keyVaultId,
      ENTRA_ROLES.keyVaultSecretsUser, false, "terminal-runtime-rbac",
    ),
    runtimeOpenAi: verifyRoleAssignment(
      config, outputs, principalId, outputs.accountId,
      ENTRA_ROLES.openAiUser, true, "terminal-openai-rbac",
    ),
  };
  if (outputs.applicationInsightsId !== undefined) {
    evidence.runtimeMonitoring = verifyRoleAssignment(
      config, outputs, principalId, outputs.applicationInsightsId,
      ENTRA_ROLES.monitoringMetricsPublisher, true, "terminal-monitoring-rbac",
    );
  }
  return evidence;
}

function verifyCredentialRbac(config, outputs, app, retiredRequired) {
  const principalId = runtimePrincipalId(app, outputs, "reconcile-credential-rbac");
  const evidence = {
    retiredRuntimeSecrets: verifyRoleAssignment(
      config,
      outputs,
      principalId,
      outputs.keyVaultId,
      ENTRA_ROLES.keyVaultSecretsUser,
      retiredRequired,
      "reconcile-credential-runtime-rbac",
    ),
    runtimeOpenAi: verifyRoleAssignment(
      config,
      outputs,
      principalId,
      outputs.accountId,
      ENTRA_ROLES.openAiUser,
      true,
      "reconcile-credential-openai-rbac",
    ),
  };
  if (outputs.applicationInsightsId !== undefined) {
    evidence.runtimeMonitoring = verifyRoleAssignment(
      config,
      outputs,
      principalId,
      outputs.applicationInsightsId,
      ENTRA_ROLES.monitoringMetricsPublisher,
      true,
      "reconcile-credential-monitoring-rbac",
    );
  }
  return evidence;
}

function credentialLiveState(config, outputs, request) {
  const predecessor = request.inactiveRevisionContract ??
    runtimeCutoverPredecessorEvidence(config, request.state);
  return parseContainerAppAndRevisions(config, outputs, {
    ...request,
    allowRevisionChange: false,
    expectedRevision: request.manifest.bindings.liveRevision,
    inactiveRevisionContract: predecessor,
  }, "post");
}

function inspectCredentialCleanupPre(config, outputs, request) {
  const live = credentialLiveState(config, outputs, request);
  const secrets = verifyKeyVaultPresence(config, outputs);
  const rbac = verifyCredentialRbac(config, outputs, live.app, true);
  return { live, secrets, rbac };
}

function inspectCredentialCleanupPost(config, outputs, request) {
  const live = credentialLiveState(config, outputs, request);
  const secrets = verifyKeyVaultAbsence(config, outputs);
  const rbac = verifyCredentialRbac(config, outputs, live.app, false);
  return { live, secrets, rbac };
}

function verifyTerminalDeployments(config, outputs) {
  const deploymentList = azJson(config, [
    "cognitiveservices", "account", "deployment", "list",
    "--name", outputs.account,
    "--resource-group", outputs.foundryResourceGroup,
    "--subscription", config.account.subscription,
    "--output", "json",
  ], "terminal-deployments");
  const entries = pagedAzureList(deploymentList, "terminal-deployments");
  const deployments = entries.map((item) => validateDeploymentItem(item, outputs, config));
  failIf(deployments.length !== 2, "terminal-deployment-set");
  const names = new Set(deployments.map((deployment) => deployment.name));
  failIf(names.size !== 2, "terminal-deployment-set");
  const transcription = deployments.find((deployment) => deployment.name === MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment);
  const luna = deployments.find((deployment) => deployment.name === MODEL_BOOTSTRAP_CONTRACT.lunaDeployment);
  failIf(!transcription || !luna, "terminal-deployment-set");
  failIf(
    transcription.modelName !== MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment ||
      transcription.version !== MODEL_BOOTSTRAP_CONTRACT.transcriptionVersion ||
      transcription.format !== MODEL_BOOTSTRAP_CONTRACT.format ||
      transcription.sku !== MODEL_BOOTSTRAP_CONTRACT.sku ||
      transcription.capacity !== MODEL_BOOTSTRAP_CONTRACT.transcriptionCapacity ||
      transcription.provisioningState !== "Succeeded" ||
      transcription.versionUpgradeOption !== MODEL_BOOTSTRAP_CONTRACT.upgradeOption ||
      luna.modelName !== MODEL_BOOTSTRAP_CONTRACT.lunaDeployment ||
      luna.version !== MODEL_BOOTSTRAP_CONTRACT.lunaVersion ||
      luna.format !== MODEL_BOOTSTRAP_CONTRACT.format ||
      luna.sku !== MODEL_BOOTSTRAP_CONTRACT.sku ||
      luna.capacity !== MODEL_BOOTSTRAP_CONTRACT.lunaCapacity ||
      luna.provisioningState !== "Succeeded" ||
      luna.versionUpgradeOption !== MODEL_BOOTSTRAP_CONTRACT.upgradeOption,
    "terminal-deployment-contract",
  );
  return deployments;
}

function liveReadOnlyChecks(config, outputs, request, mode) {
  const state = defaultRemoteState(config);
  const retainedPredecessor = request.inactiveRevisionContract ??
    (["credential-cleanup", "terminal"].includes(request.phase)
      ? runtimeCutoverPredecessorEvidence(config, request.state)
      : undefined);
  const live = parseContainerAppAndRevisions(config, outputs, {
    ...request,
    ...(retainedPredecessor === undefined
      ? {}
      : { inactiveRevisionContract: retainedPredecessor }),
  }, mode);
  return { ...state, ...live };
}

function requireRuntimeOutputs(outputs) {
  failIf(typeof outputs.relayContainerApp !== "string" || outputs.relayContainerApp.length === 0, "runtime-resource");
  failIf(typeof outputs.keyVault !== "string" || outputs.keyVault.length === 0, "cleanup-resource");
  for (const [key, code] of [
    ["keyVaultUri", "cleanup-resource"],
    ["keyVaultId", "cleanup-resource"],
    ["relayContainerAppId", "runtime-resource"],
    ["runtimeIdentityId", "runtime-identity"],
    ["runtimeIdentityPrincipalId", "runtime-identity"],
    ["imagePullIdentityId", "image-pull-identity"],
    ["foundryEndpoint", "foundry-endpoint"],
  ]) {
    failIf(typeof outputs[key] !== "string" || outputs[key].length === 0, code);
  }
}

function defaultMetadataCheck(config) {
  rejectAutomaticTerraformVariableSources(config.workdir);
  const directory = path.join(config.root, `.init-${process.pid}-${randomBytes(6).toString("hex")}`);
  mkdirSync(directory, { mode: DIRECTORY_MODE });
  try {
    const env = buildChildEnvironment(directory, config.inheritedEnvironment);
    const scoped = { ...config, childEnvironment: env };
    const context = defaultContext(scoped, { phase: "model-bootstrap" });
    const outputs = defaultOutputs({ ...scoped, account: context.azure });
    verifyModelMetadata({ ...scoped, account: context.azure }, outputs);
    return true;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function defaultPreflightVerifier(config, request) {
  const providerConfig = {
    ...config,
    childEnvironment: request.env,
    account: {
      cloud: "AzureCloud",
      subscription: request.bindings.backend.subscription_id,
      tenant: request.bindings.backend.tenant_id,
    },
  };
  const outputs = defaultOutputs(providerConfig);
  let evidence;
  if (request.phase === "model-bootstrap") {
    evidence = verifyModelMetadata(providerConfig, outputs);
  } else if (request.phase === "runtime-cutover") {
    requireRuntimeOutputs(outputs);
    const diagnostic = requiredDiagnostic(request);
    const live = liveReadOnlyChecks(providerConfig, outputs, request, "pre");
    evidence = {
      diagnosticSha256: diagnostic.fileSha256,
      containerAppSha256: hashJson(live.appResponse),
      revisionsSha256: hashJson(live.revisionResponse),
    };
  } else if (request.phase === "credential-cleanup") {
    requireRuntimeOutputs(outputs);
    const cleanup = requiredCleanup(
      { ...request, processRunner: config.processRunner },
      { requireAbsence: false },
    );
    const live = liveReadOnlyChecks(providerConfig, outputs, request, "post");
    evidence = {
      cleanupOperationManifestSha256: cleanup.operation.fileSha256,
      containerAppSha256: hashJson(live.appResponse),
      revisionsSha256: hashJson(live.revisionResponse),
    };
  } else {
    reject("invalid-phase");
  }
  return { status: "success", verifierSha256: hashJson(evidence) };
}

function boundedDiagnosticDelay() {
  if (currentTestExecution() !== undefined) return;
  spawnSync("/usr/bin/sleep", [String(DIAGNOSTIC_POLL_DELAY_MS / 1000)], {
    cwd: REPOSITORY_ROOT,
    env: PRODUCTION_ENV,
    encoding: "utf8",
    timeout: DIAGNOSTIC_POLL_DELAY_MS + 1000,
    maxBuffer: 1024,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function defaultLiveInspector(config, request) {
  const providerConfig = {
    ...config,
    childEnvironment: request.env,
    account: {
      cloud: "AzureCloud",
      subscription: request.bindings.backend.subscription_id,
      tenant: request.bindings.backend.tenant_id,
    },
  };
  const outputs = defaultOutputs(providerConfig);
  try {
    lstatSync(request.artifacts.apply);
    assertReceiptFileSize(request.artifacts.apply, "apply-receipt");
    assertApplyReceipt(readJson(request.artifacts.apply, "apply-receipt"), request.manifest);
    sha256File(request.artifacts.apply);
  } catch (error) {
    if (
      error?.code !== "ENOENT" &&
      !(error instanceof LifecycleError && error.code === "apply-receipt-missing")
    ) {
      throw error;
    }
  }
  if (request.phase === "runtime-cutover") {
    requireRuntimeOutputs(outputs);
    requiredDiagnostic(request);
  }
  if (request.phase === "credential-cleanup") {
    requireRuntimeOutputs(outputs);
    requiredCleanup({ ...request, processRunner: config.processRunner });
  }
  const state = defaultRemoteState(providerConfig);
  failIf(state.stateLineage !== request.bindings.stateLineage, "binding-mismatch");
  const serialSide = assertReconcileSerial(
    state.stateSerial,
    request.manifest.bindings.stateSerial,
  );

  const safelyInspect = (callback) => {
    try {
      callback();
      return true;
    } catch {
      // Live evidence that is malformed, partial, or otherwise not one of
      // the exact phase states is an unresolved reconciliation, not proof of
      // either side of the transition.
      return false;
    }
  };

  if (request.phase === "model-bootstrap") {
    if (serialSide === "post" && safelyInspect(() => inspectModelBootstrapPost(providerConfig, outputs))) {
      return { outcome: "post" };
    }
    if (serialSide === "pre" && safelyInspect(() => inspectModelBootstrapPre(providerConfig, outputs))) {
      return { outcome: "pre" };
    }
    return { outcome: "unknown" };
  }

  if (request.phase === "runtime-cutover") {
    const post = safelyInspect(() => {
      const live = parseContainerAppAndRevisions(providerConfig, outputs, {
        ...request,
        allowRevisionChange: true,
      }, "post");
      failIf(
        live.revisionName === request.manifest.bindings.liveRevision,
        "reconcile-runtime-revision",
      );
    });
    if (serialSide === "post" && post) return { outcome: "post" };

    const pre = safelyInspect(() => {
      parseContainerAppAndRevisions(providerConfig, outputs, {
        ...request,
        allowRevisionChange: false,
        expectedRevision: request.manifest.bindings.liveRevision,
      }, "pre");
    });
    if (serialSide === "pre" && pre) return { outcome: "pre" };
    return { outcome: "unknown" };
  }

  if (request.phase === "credential-cleanup") {
    if (serialSide === "post" && safelyInspect(() => inspectCredentialCleanupPost(providerConfig, outputs, request))) {
      return { outcome: "post" };
    }
    if (serialSide === "pre" && safelyInspect(() => inspectCredentialCleanupPre(providerConfig, outputs, request))) {
      return { outcome: "pre" };
    }
    return { outcome: "unknown" };
  }

  return { outcome: "unknown" };
}

function defaultTerminalReceiptProvider(config, request) {
  const providerConfig = {
    ...config,
    childEnvironment: request.env,
    account: {
      cloud: "AzureCloud",
      subscription: request.bindings.backend.subscription_id,
      tenant: request.bindings.backend.tenant_id,
    },
  };
  const evidence = {};
  const inventory = terminalPredecessorEvidence(config, request.state, request);
  evidence.live = assertExactReceipt(
    path.join(request.runDirectory, "terminal-live-receipt.json"),
    "live-receipt",
    request.manifest,
    { type: "live", status: "passed", operation: "terminal-live" },
  );
  assertKnownKeys(evidence.live.value, [
    "version", "type", "status", "operation", "runId", "phase", "planSha256", "bindingSha256",
    "createdAt", "repositoryCommit", "contextSha256", "sha256",
  ], "live-receipt-schema");
  const outputs = defaultOutputs(providerConfig);
  requireRuntimeOutputs(outputs);
  const live = liveReadOnlyChecks(providerConfig, outputs, {
    ...request,
    expectedRevision: outputs.relayRevision,
    inactiveRevisionContract: runtimeCutoverPredecessorEvidence(config, request.state),
  }, "post");
  const keyVault = verifyKeyVaultAbsence(providerConfig, outputs);
  const deployments = verifyTerminalDeployments(providerConfig, outputs);
  const rbac = verifyTerminalRbac(providerConfig, outputs, live.app);
  evidence.liveState = {
    containerAppSha256: hashJson(live.appResponse),
    revisionsSha256: hashJson(live.revisionResponse),
    keyVault: keyVault.status,
    deployments: deployments.map((deployment) => ({
      name: deployment.name,
      version: deployment.version,
      provisioningState: deployment.provisioningState,
    })),
    rbac,
  };
  return {
    status: "success",
    receiptInventory: inventory,
    receiptSetSha256: hashJson(inventory),
  };
}

function defaultCleanupValidator(config, request) {
  const providerConfig = {
    ...config,
    childEnvironment: request.env,
    account: {
      cloud: "AzureCloud",
      subscription: request.manifest.bindings.backend.subscription_id,
      tenant: request.manifest.bindings.backend.tenant_id,
    },
  };
  const evidence = requiredCleanup({
    ...request,
    artifacts: request.artifacts,
    processRunner: config.processRunner,
  });
  const outputs = defaultOutputs(providerConfig);
  requireRuntimeOutputs(outputs);
  const live = liveReadOnlyChecks(providerConfig, outputs, request, "post");
  const keyVault = verifyKeyVaultAbsence(providerConfig, outputs);
  return {
    status: "success",
    evidenceSha256: hashJson({
      cleanup: evidence.operation.fileSha256,
      absence: evidence.absence.fileSha256,
      keyVault: keyVault.status,
      containerApp: hashJson(live.appResponse),
      revisions: hashJson(live.revisionResponse),
    }),
  };
}

export function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return undefined;
  const [operation, phase, runId, extra] = argv;
  if (operation === "init" && argv.length === 1) return { operation };
  if (operation === "create" && argv.length === 2 && PHASES.includes(phase)) {
    return { operation, phase };
  }
  if (
    operation === "diagnostic" &&
    argv.length === 3 &&
    phase === "runtime-cutover" &&
    RUN_ID_RE.test(runId)
  ) {
    return { operation, phase, runId };
  }
  if (
    ["guard", "preflight", "apply", "reconcile"].includes(operation) &&
    argv.length === 3 &&
    PHASES.includes(phase) &&
    phase !== "terminal" &&
    RUN_ID_RE.test(runId)
  ) {
    return { operation, phase, runId };
  }
  if (
    operation === "guard" &&
    argv.length === 3 &&
    phase === "terminal" &&
    RUN_ID_RE.test(runId)
  ) {
    return { operation, phase, runId };
  }
  if (
    operation === "supersede" &&
    argv.length === 3 &&
    phase === "credential-cleanup" &&
    RUN_ID_RE.test(runId)
  ) {
    return { operation, phase, runId };
  }
  if (
    operation === "finalize" &&
    argv.length === 3 &&
    phase === "terminal" &&
    RUN_ID_RE.test(runId)
  ) {
    return { operation, phase, runId };
  }
  if (
    operation === "close" &&
    argv.length === 3 &&
    phase === "terminal" &&
    RUN_ID_RE.test(runId)
  ) {
    return { operation, phase, runId };
  }
  void extra;
  return undefined;
}

function isActualNodeTestContext() {
  // NODE_TEST_CONTEXT is set by node:test for its test workers.  No
  // application-defined CLI flag or environment variable is accepted here.
  return typeof process.env.NODE_TEST_CONTEXT === "string" &&
    process.env.NODE_TEST_CONTEXT.startsWith("child-");
}

function testFactoryInternal(options) {
  failIf(!isActualNodeTestContext(), "test-factory-unavailable");
  failIf(!isObject(options), "composition-options");
  const lowLevel = options.lowLevel ?? {};
  const adapterProfile = lowLevel.testAdapterProfile ?? "unit";
  failIf(!TEST_ADAPTER_PROFILES.includes(adapterProfile), "test-adapter-profile");
  if (lowLevel.testFsyncObserver !== undefined) {
    failIf(typeof lowLevel.testFsyncObserver !== "function", "test-fsync-observer");
  }
  let execution = TEST_FACTORY_CONTEXTS.get(options);
  if (execution === undefined) execution = currentTestExecution();
  if (execution === undefined) {
    execution = {
      factoryToken: TEST_FACTORY_TOKEN,
      locks: new Set(),
      operation: undefined,
      adapterProfile,
      fsyncObserver: lowLevel.testFsyncObserver,
    };
    execution.fsyncAdapter = adapterProfile === "production"
      ? (fd, filePath, code) => {
          fsyncSync(fd);
          execution.fsyncObserver?.({ fd, filePath, code });
        }
      : () => {};
    execution.publisher = adapterProfile === "production"
      ? publishNoReplaceWithProductionAdapters
      : copyNoReplaceForTests;
    execution.lockAdapter = adapterProfile === "production"
      ? inProcessLock
      : memoryLockForTests;
    TEST_FACTORY_CONTEXTS.set(options, execution);
  }
  failIf(execution.adapterProfile !== adapterProfile, "test-adapter-context");
  return {
    testFactoryToken: TEST_FACTORY_TOKEN,
    testFactoryPath: TEST_FACTORY_PATH,
    testExecution: execution,
  };
}

function createLifecycleInternal(options = {}, internal = {}) {
  const testComposition =
    internal.testFactoryToken === TEST_FACTORY_TOKEN &&
    internal.testFactoryPath === TEST_FACTORY_PATH;
  const productionComposition = internal.production === true;
  failIf(!testComposition && !productionComposition, "composition");
  failIf(!isObject(options), "composition-options");
  if (productionComposition) {
    failIf(Object.keys(options).length !== 0, "production-options");
  }
  for (const key of HIGH_LEVEL_PROVIDER_KEYS) {
    failIf(Object.hasOwn(options, key), "provider-injection");
  }
  failIf(Object.hasOwn(options, "skipWorktreeCheck"), "provider-injection");
  const lowLevel = options.lowLevel ?? {};
  failIf(!isObject(lowLevel), "low-level-injection");
  const resolvedWorkdir = path.resolve(options.workdir ?? DEFAULT_WORKDIR);
  failIf(Object.hasOwn(options, "backendConfigPath"), "backend-context");
  const config = {
    root: path.resolve(options.root ?? EVIDENCE_ROOT),
    closure: path.resolve(options.closure ?? CLOSURE_PATH),
    repoRoot: path.resolve(options.repoRoot ?? REPOSITORY_ROOT),
    workdir: resolvedWorkdir,
    backendConfigPath: path.join(resolvedWorkdir, "backend.hcl"),
    now: lowLevel.clock?.now ?? (() => Date.now()),
    inheritedEnvironment: options.inheritedEnvironment ?? process.env,
    processRunner: lowLevel.processRunner,
    cleanupRunner: lowLevel.cleanupRunner,
    privateHttpGet:
      lowLevel.privateHttpGet ??
      lowLevel.privateHttpsGet ??
      lowLevel.httpsGet ??
      lowLevel.httpRequest ??
      lowLevel.httpGet,
    checkpointFault:
      lowLevel.faultAtCheckpoint ??
      lowLevel.checkpointFault ??
      lowLevel.failAtCheckpoint,
    lockAdapter: lowLevel.lockAdapter ?? internal.testExecution?.lockAdapter,
    lockMode: internal.lockMode ?? "in-process",
    ...(internal.testExecution !== undefined
      ? { testExecution: internal.testExecution }
      : {}),
    guardScript: path.join(REPOSITORY_ROOT, "infra/scripts/assert-dev-plan.mjs"),
  };
  config.kernelLockPath = path.join(path.dirname(config.root), `${path.basename(config.root)}.kernel.lock`);
  failIf(path.isAbsolute(config.root) === false, "evidence-root");

  function operationContext(phase, operation, run, planPath, argv, env, imagePlatformsOverride = undefined) {
    const imagePlatforms = imagePlatformsOverride ?? run?.manifest?.bindings?.imagePlatforms ?? config.imagePlatforms;
    const expected = {
      phase,
      planSha256: run?.manifest?.planSha256,
      cwd: config.workdir,
      argv,
      ...(imagePlatforms === undefined ? {} : { imagePlatforms }),
    };
    const raw = defaultContext(
      { ...config, childEnvironment: env, contextOperation: operation, ...(imagePlatforms === undefined ? {} : { imagePlatforms }) },
      { phase, operation, planPath, argv, env },
    );
    return normalizeInjectedContext(raw, expected);
  }

  function readManifest(run) {
    const checkpoints = readCheckpoints(run.runDirectory, {
      runId: run.entry.id,
      phase: run.entry.phase,
    });
    const checkpointSet = new Set(checkpoints.map((checkpoint) => checkpoint.name));
    const manifestCheckpoint = checkpointNamed(checkpoints, "manifest");
    assertCheckpointArtifact(run.artifacts.manifest, manifestCheckpoint, "manifestSha256", "manifest");
    const manifest = readJson(run.artifacts.manifest, "manifest");
    failIf(
      manifest.runId !== run.entry.id ||
        manifest.phase !== run.entry.phase ||
        !Array.isArray(manifest.argv) ||
        (!same(manifest.argv, exactCreateArgv(run.artifacts.plan)) &&
          !same(manifest.argv, exactCreateArgv(run.artifacts.planTemp))),
      "manifest-mismatch",
    );
    validateManifestArgv(manifest, run.artifacts, checkpoints, run.entry);
    assertRegular(run.artifacts.plan, ARTIFACT_MODE, "plan");
    failIf(sha256File(run.artifacts.plan) !== manifest.planSha256, "plan-hash");
    const imagePlatforms = validateImagePlatformBinding(
      manifest.bindings?.imagePlatforms,
      manifest.bindings?.acrLoginServer,
    );
    validateImagePlatformCheckpoint(checkpointNamed(checkpoints, "image-platform-verified"), imagePlatforms);
    assertImmutableVerifierArtifact(run.artifacts.verifier, imagePlatforms.verifierSha256, "image-platform-checkpoint");
    failIf(bindingHash(manifest.bindings) !== manifest.bindingSha256, "binding-hash");
    failIf(!checkpointSet.has("published-plan") || !checkpointSet.has("manifest"), "checkpoint-integrity");
    for (const checkpoint of checkpoints) {
      if (checkpoint.name === "published-plan") {
        failIf(checkpoint.planSha256 !== manifest.planSha256, "checkpoint-integrity");
      }
      if (checkpoint.name === "manifest") {
        failIf(checkpoint.manifestSha256 !== manifestCheckpoint.manifestSha256, "checkpoint-integrity");
      }
    }
    return manifest;
  }

  function revalidate(run, operation, manifest, env) {
    assertPlanAge(manifest, run.entry.phase, config.now);
    const current = operationContext(
      run.entry.phase,
      operation,
      { manifest },
      run.artifacts.plan,
      manifest.argv,
      env,
    );
    failIf(!sameBindingsForOperation(current, manifest.bindings, operation), "binding-mismatch");
    return current;
  }

  function invalidate(configState, runId, reason) {
    const run = configState.runs.find((candidate) => candidate.id === runId);
    failIf(!run, "run-not-registered");
    if (run.status !== "invalidated" && run.status !== "superseded") {
      const directory = runPath(config, runId);
      const names = checkpointNames(directory, { runId, phase: run.phase });
      if (!names.has("invalidated")) {
        writeCheckpoint(config, directory, runId, run.phase, "invalidated", {
          reason,
          lastCheckpoint: run.lastCheckpoint,
        });
      }
      updateRun(configState, runId, {
        status: "invalidated",
        reason,
        invalidatedAt: nowIso(config.now),
      });
      saveState(config, configState);
    }
  }

  function handleRunFailure(state, runId, error) {
    if (!(error instanceof LifecycleError) || !runErrorInvalidates(error.code)) return;
    try {
      invalidate(state, runId, error.code);
    } catch {
      // Preserve the original integrity failure.  A failed invalidation is
      // still fail-closed because the operation never returns success.
    }
  }

  function init() {
    ensureRoot(config);
    return withLock(config, () => {
      checkWorktreeIfInjected("model-bootstrap");
      failIf(loadState(config) !== null, "state-exists");
      const checked = defaultMetadataCheck(config);
      failIf(checked !== true && checked?.status !== "passed", "metadata-rejected");
      const state = {
        version: 1,
        state: "manual-Luna-absent",
        stateSerial: 0,
        sequence: 0,
        previousSnapshotSha256: null,
        createdAt: nowIso(config.now),
        runs: [],
      };
      state.stateSha256 = stateCanonicalSha256(state);
      exclusiveJson(
        path.join(config.root, "state-000000000000.json"),
        state,
        "state-snapshot",
      );
      exclusiveJson(path.join(config.root, "state.json"), state, "state");
      return { state: state.state };
    });
  }

  function create(phase, supersession = undefined) {
    assertPhase(phase);
    let operationState;
    let operationRunId;
    try {
      return withLock(config, () => {
      const state = requireState(config);
      operationState = state;
      assertStateForCreate(state, phase, config);
      checkWorktreeIfInjected(phase);
      checkInheritedEnvironment(config.inheritedEnvironment);
      if (phase === "runtime-cutover") protectedRuntimeSecretsRoleEnabled(config, true);
      if (phase === "credential-cleanup") protectedRuntimeSecretsRoleEnabled(config, false);
      rejectAutomaticTerraformVariableSources(config.workdir);
      const runId = makeRunId();
      operationRunId = runId;
      const runDirectory = createRunDirectory(config, runId);
      const artifacts = artifactPaths(runDirectory);
      state.runs.push({
        id: runId,
        phase,
        status: "created",
        createdAt: nowIso(config.now),
      });
      saveState(config, state);
      writeCheckpoint(config, runDirectory, runId, phase, "run-directory");
      const env = buildChildEnvironment(runDirectory, config.inheritedEnvironment);
      const planArgv = exactCreateArgv(artifacts.plan);
      const manifestArgv = planArgv;
      const prePlanRaw = defaultContext(
        { ...config, childEnvironment: env, contextOperation: "create-before-plan" },
        { phase, operation: "create", planPath: artifacts.plan, argv: manifestArgv, env },
      );
      const prePlanContext = normalizedContextBeforePlan(
        prePlanRaw,
        { phase, cwd: config.workdir, argv: manifestArgv },
      );
      const verifierPath = materializeReviewedVerifier(config, artifacts, prePlanContext);
      const imagePlatforms = verifyImagePlatforms(config, phase, env, prePlanContext, undefined, verifierPath);
      writeCheckpoint(config, runDirectory, runId, phase, "image-platform-verified", {
        verifierSha256: imagePlatforms.verifierSha256,
        verifierPath: IMAGE_VERIFIER_ARTIFACT_NAME,
        descriptorSetSha256: hashJson(imagePlatforms.images),
      });
      updateRun(state, runId, { lastCheckpoint: "image-platform-verified" });
      const planStartedAt = nowIso(config.now);
      writeCheckpoint(config, runDirectory, runId, phase, "plan-started", {
        argv: manifestArgv,
        createdAt: planStartedAt,
      });
      updateRun(state, runId, { lastCheckpoint: "plan-started" });
      const beforePlan = normalizedContextBeforePlan(
        { ...prePlanRaw, imagePlatforms },
        { phase, cwd: config.workdir, argv: manifestArgv, imagePlatforms },
      );
      let result;
      try {
        result = defaultTerraformExecutor({
          operation: "create",
          phase,
          runId,
          argv: planArgv,
          cwd: config.workdir,
          env,
          planPath: artifacts.plan,
          tempPlanPath: artifacts.planTemp,
          processRunner: config.processRunner,
        });
      } catch {
        result = { status: "ambiguous" };
      }
      const resultStatus = parseStatus(result);
      if (resultStatus !== "success") {
        writeCheckpoint(config, runDirectory, runId, phase, "terraform-exit-ambiguous", {
          status: "ambiguous",
        });
        updateRun(state, runId, { status: "invalidated", reason: "terraform-create" });
        saveState(config, state);
        reject("terraform-create");
      }
      const producedPlan = config.processRunner === undefined ? artifacts.planTemp : artifacts.plan;
      assertRegular(producedPlan, ARTIFACT_MODE, "temp-plan");
      fsyncFile(producedPlan, "plan-fsync");
      if (producedPlan !== artifacts.plan) publishNoReplace(producedPlan, artifacts.plan, "published-plan");
      assertRegular(artifacts.plan, ARTIFACT_MODE, "plan");
      fsyncFile(artifacts.plan, "plan-fsync");
      const planHash = sha256File(artifacts.plan);
      writeCheckpoint(config, runDirectory, runId, phase, "temp-plan", {
        planSha256: planHash,
      });
      updateRun(state, runId, { lastCheckpoint: "temp-plan" });
      // Terraform's fixed -out path is the protocol's private temporary
      // pathname until its validated, fsynced bytes receive this publication
      // checkpoint.  The manifest path is never accepted from the caller.
      writeCheckpoint(config, runDirectory, runId, phase, "published-plan", {
        planSha256: planHash,
        planPath: artifacts.plan,
      });
      updateRun(state, runId, { lastCheckpoint: "published-plan" });
      writeCheckpoint(config, runDirectory, runId, phase, "terraform-exit-known", {
        operation: "create",
        status: "success",
        exitCode: 0,
      });
      updateRun(state, runId, { lastCheckpoint: "terraform-exit-known" });
      const context = operationContext(
        phase,
        "create",
        { manifest: { planSha256: planHash, runId } },
        artifacts.plan,
        manifestArgv,
        env,
        imagePlatforms,
      );
      failIf(!sameCompletePlanContext(beforePlan, context), "binding-mismatch");
      const startedManifest = { phase, createdAt: planStartedAt };
      try {
        assertPlanAge(startedManifest, phase, config.now);
      } catch (error) {
        if (error instanceof LifecycleError && error.code === "plan-expired") {
          updateRun(state, runId, { status: "invalidated", reason: "plan-expired" });
          saveState(config, state);
        }
        throw error;
      }
      const manifest = manifestFor(
        phase,
        runId,
        planStartedAt,
        planHash,
        context,
        manifestArgv,
        0,
      );
      if (supersession) manifest.supersession = supersession;
      exclusiveJson(artifacts.manifest, manifest, "manifest");
      writeCheckpoint(config, runDirectory, runId, phase, "manifest", {
        manifestSha256: sha256File(artifacts.manifest),
        planSha256: manifest.planSha256,
      });
      updateRun(state, runId, { createdAt: manifest.createdAt, lastCheckpoint: "manifest" });
      return { runId, phase, status: "created" };
      });
    } catch (error) {
      if (operationState !== undefined && operationRunId !== undefined) {
        try {
          withLock(config, () => {
            handleRunFailure(operationState, operationRunId, error);
          });
        } catch {
          // Preserve the original operation error.  A failed invalidation is
          // still fail-closed because the operation never returns success.
        }
      }
      throw error;
    }
  }

  function checkWorktreeIfInjected(phase) {
    checkWorktree(config.repoRoot, phase, config.processRunner);
  }

  function guard(phase, runId) {
    assertPhase(phase);
    assertRunId(runId);
    return withLock(config, () => {
      checkWorktreeIfInjected(phase);
      const state = requireState(config);
      const run = parseRun(config, state, phase, runId);
      assertRunStatus(run.entry, ["created"]);
      let env;
      try {
        for (const evidencePath of [
          run.artifacts.show,
          run.artifacts.guard,
          `${run.artifacts.guard}.consumed`,
        ]) {
          try {
            lstatSync(evidencePath);
            reject("guard-artifact-integrity");
          } catch (error) {
            if (error instanceof LifecycleError) throw error;
            if (error?.code !== "ENOENT") reject("guard-artifact-integrity");
          }
        }
        const manifest = readManifest(run);
        env = buildChildEnvironment(run.runDirectory, config.inheritedEnvironment);
        assertReviewedVerifierSource(
          config,
          manifest.bindings.imagePlatforms.verifierSha256,
          "image-platform-verification",
        );
        let guardContext;
        try {
          guardContext = revalidate(run, "guard", manifest, env);
        } catch (error) {
          if (error instanceof LifecycleError && error.code === "reviewed-file-changed") {
            reject("image-platform-verification");
          }
          throw error;
        }
        verifyImagePlatforms(
          config,
          phase,
          env,
          guardContext,
          manifest.bindings.imagePlatforms,
          run.artifacts.verifier,
        );
        const shown = defaultShowExecutor({
          operation: "guard",
          phase,
          runId,
          argv: exactShowArgv(run.artifacts.plan),
          cwd: config.workdir,
          env,
          planPath: run.artifacts.plan,
          processRunner: config.processRunner,
        });
        failIf(parseStatus(shown) !== "success", "terraform-show");
        const input = typeof shown === "string" ? shown : shown?.stdout;
        failIf(typeof input !== "string" || input.length === 0, "terraform-show");
        failIf(Buffer.byteLength(input) > JSON_MAX_BYTES, "terraform-show-too-large");
        let show;
        try {
          show = JSON.parse(input);
        } catch {
          reject("terraform-show-json");
        }
        assertGuardBoundImages(
          run.artifacts,
          phase,
          manifest.bindings.imagePlatforms,
          manifest.bindings.acrLoginServer,
          show,
        );
        const guardResult = defaultGuardExecutor({
          operation: "guard",
          phase,
          runId,
          mapping: GUARD_MAPPINGS[phase],
          input,
          cwd: config.repoRoot,
          env,
          guardScript: config.guardScript,
          processRunner: config.processRunner,
        });
        failIf(parseStatus(guardResult) !== "success", "guard-rejected");
        exclusiveText(run.artifacts.show, input, "show-json");
        writeCheckpoint(config, run.runDirectory, runId, phase, "show-json", {
          showSha256: sha256Bytes(input),
        });
        updateRun(state, runId, { lastCheckpoint: "show-json" });
        const receipt = receiptFor("guard", manifest, {
          guard: GUARD_MAPPINGS[phase],
          showSha256: sha256Bytes(input),
          guardArgv: exactGuardArgv(phase),
          stdinSha256: sha256Bytes(input),
          result: "passed",
        });
        ensureReceiptSize(receipt);
        exclusiveJson(run.artifacts.guard, receipt, "guard-receipt");
        writeCheckpoint(config, run.runDirectory, runId, phase, "guard-receipt", {
          receiptSha256: sha256File(run.artifacts.guard),
          showSha256: receipt.showSha256,
          guard: receipt.guard,
        });
        if (phase === "credential-cleanup") {
          const descriptor = createVaultDescriptor(config, run, manifest, manifest.bindings, manifest.supersession);
          writeCheckpoint(config, run.runDirectory, runId, phase, "vault-descriptor", {
            descriptorSha256: sha256File(run.artifacts.descriptor),
            planSha256: manifest.planSha256,
            targetNames: descriptor.targetNames,
          });
        }
        updateRun(state, runId, { status: "guarded", guardedAt: nowIso(config.now), lastCheckpoint: phase === "credential-cleanup" ? "vault-descriptor" : "guard-receipt" });
        saveState(config, state);
        return { runId, phase, status: "guarded" };
      } catch (error) {
        if (error instanceof LifecycleError && error.code === "plan-expired") {
          invalidate(state, runId, "expired");
        }
        handleRunFailure(state, runId, error);
        throw error;
      }
    });
  }

  function diagnostic(phase, runId) {
    failIf(phase !== "runtime-cutover", "diagnostic-phase");
    assertRunId(runId);
    return withLock(config, () => {
      checkWorktreeIfInjected(phase);
      const state = requireState(config);
      const run = parseRun(config, state, phase, runId);
      assertRunStatus(run.entry, ["guarded"]);
      const manifest = readManifest(run);
      const env = buildChildEnvironment(run.runDirectory, config.inheritedEnvironment);
      protectedRuntimeSecretsRoleEnabled(config, true);
      const bindings = revalidate(run, "diagnostic", manifest, env);
      const checkpoints = readCheckpoints(run.runDirectory, { runId, phase });
      const guardReceipt = readReceiptAtCheckpoint(
        run.artifacts.guard,
        checkpointNamed(checkpoints, "guard-receipt"),
        manifest,
        "guard",
      );
      const showCheckpoint = checkpointNamed(checkpoints, "show-json");
      assertCheckpointArtifact(run.artifacts.show, showCheckpoint, "showSha256", "show-json");
      failIf(guardReceipt.showSha256 !== sha256File(run.artifacts.show, JSON_MAX_BYTES), "show-hash");
      const providerConfig = {
        ...config,
        childEnvironment: env,
        account: {
          cloud: "AzureCloud",
          subscription: bindings.backend.subscription_id,
          tenant: bindings.backend.tenant_id,
        },
      };
      const outputs = defaultOutputs(providerConfig);
      const job = diagnosticJobIdentity(outputs, providerConfig);
      const reviewed = reviewedRuntimeShapes(run.artifacts, phase);
      const reviewedDigest = reviewedRuntimeDigest(manifest, run.artifacts);
      const runtimeIdentityProof = diagnosticManagedIdentity(
        providerConfig,
        outputs.runtimeIdentityId,
        {
          principalId: manifest.bindings.runtimeIdentityPrincipalId,
          clientId: outputs.runtimeIdentityClientId,
        },
        "diagnostic-identity",
      );
      const imagePullIdentityProof = diagnosticManagedIdentity(
        providerConfig,
        outputs.imagePullIdentityId,
        undefined,
        "diagnostic-image-pull-identity",
      );
      const jobResponse = azJson(providerConfig, [
        "containerapp", "job", "show", "--name", job.name,
        "--resource-group", outputs.resourceGroup,
        "--subscription", bindings.backend.subscription_id,
        "--output", "json",
      ], "diagnostic-job");
      diagnosticJobContract(jobResponse, outputs, reviewed, providerConfig, {
        imagePull: imagePullIdentityProof,
        runtime: runtimeIdentityProof,
      });

      if (existsSync(run.artifacts.diagnostic)) {
        requiredDiagnostic({ manifest, artifacts: run.artifacts });
        return { runId, phase, status: "diagnostic-passed", execution: "existing" };
      }

      const requestId = existsSync(run.artifacts.diagnosticIntent)
        ? readJson(run.artifacts.diagnosticIntent, "diagnostic-intent").requestId
        : randomUUID();
      let intent;
      if (existsSync(run.artifacts.diagnosticIntent)) {
        intent = immutableDiagnosticArtifact(
          readJson(run.artifacts.diagnosticIntent, "diagnostic-intent"),
          "intent", manifest, outputs, reviewed, job, requestId, null,
        );
      } else {
        const identity = diagnosticIdentity(providerConfig, outputs, manifest, {
          requestId,
          executionName: null,
        }, runtimeIdentityProof);
        const openAiRole = diagnosticOpenAiRole(providerConfig, manifest);
        const unsigned = {
          version: DIAGNOSTIC_REQUEST_VERSION,
          type: "diagnostic-intent",
          status: "reserved",
          runId,
          phase,
          planSha256: manifest.planSha256,
          bindingSha256: manifest.bindingSha256,
          repositoryCommit: manifest.bindings.repositoryCommit,
          contextSha256: manifest.bindingSha256,
          requestId,
          executionName: null,
          job,
          imageDigest: reviewed.image,
          argv: [...DIAGNOSTIC_COMMAND],
          containerName: DIAGNOSTIC_CONTAINER_NAME,
          env: diagnosticEnvironment(outputs, manifest, requestId),
          identity,
          openAiRole,
        };
        exclusiveJson(run.artifacts.diagnosticIntent, {
          ...unsigned,
          sha256: hashJson(unsigned),
        }, "diagnostic-intent");
        intent = immutableDiagnosticArtifact(
          readJson(run.artifacts.diagnosticIntent, "diagnostic-intent"),
          "intent", manifest, outputs, reviewed, job, requestId, null,
        );
      }

      let invoking;
      let createdInvokingThisCall = false;
      if (existsSync(run.artifacts.diagnosticInvoking)) {
        invoking = immutableDiagnosticArtifact(
          readJson(run.artifacts.diagnosticInvoking, "diagnostic-invoking"),
          "invoking", manifest, outputs, reviewed, job, requestId, null,
        );
      } else {
        createdInvokingThisCall = true;
        const unsigned = { ...intent, type: "diagnostic-invoking", status: "invoking" };
        delete unsigned.sha256;
        exclusiveJson(run.artifacts.diagnosticInvoking, {
          ...unsigned,
          sha256: hashJson(unsigned),
        }, "diagnostic-invoking");
        invoking = immutableDiagnosticArtifact(
          readJson(run.artifacts.diagnosticInvoking, "diagnostic-invoking"),
          "invoking", manifest, outputs, reviewed, job, requestId, null,
        );
      }

      const diagnosticDeadline = config.now() + DIAGNOSTIC_JOB_TIMEOUT_MS;
      let submission;
      if (existsSync(run.artifacts.diagnosticSubmission)) {
        submission = immutableDiagnosticArtifact(
          readJson(run.artifacts.diagnosticSubmission, "diagnostic-submission"),
          "submission", manifest, outputs, reviewed, job, requestId,
          readJson(run.artifacts.diagnosticSubmission, "diagnostic-submission").executionName,
        );
      } else {
        let executionName;
        if (createdInvokingThisCall) {
          const started = runCommand(providerConfig, AZ_PATH, [
            "containerapp", "job", "start",
            "--name", job.name,
            "--resource-group", outputs.resourceGroup,
            "--subscription", bindings.backend.subscription_id,
            "--container-name", DIAGNOSTIC_CONTAINER_NAME,
            "--image", reviewed.image,
            "--command", DIAGNOSTIC_COMMAND[0],
            "--args", DIAGNOSTIC_COMMAND[1],
            "--env-vars", ...diagnosticEnvironment(outputs, manifest, requestId).map((entry) => `${entry.name}=${entry.value}`),
            "--cpu", "0.25",
            "--memory", "0.5Gi",
            "--output", "json",
          ], { phase: "diagnostic", timeoutMs: COMMAND_TIMEOUT_MS });
          if (started.status === "success") {
            const response = parseCommandJson(started, "diagnostic-start-response");
            if (config.now() > diagnosticDeadline) reject("diagnostic-execution-timeout");
            executionName = diagnosticExecutionName(response, job, "diagnostic-start-response");
          } else if (started.status !== "ambiguous") {
            reject("diagnostic-start-failed");
          }
        }
        if (executionName === undefined) {
          const matched = reconcileDiagnosticSubmission(providerConfig, job, requestId, diagnosticDeadline);
          executionName = matched.state.name;
        }
        const unsigned = {
          ...invoking,
          type: "diagnostic-submission",
          status: "submitted",
          executionName,
          identity: {
            ...invoking.identity,
            job: { requestId, executionName },
          },
        };
        delete unsigned.sha256;
        exclusiveJson(run.artifacts.diagnosticSubmission, {
          ...unsigned,
          sha256: hashJson(unsigned),
        }, "diagnostic-submission");
        submission = immutableDiagnosticArtifact(
          readJson(run.artifacts.diagnosticSubmission, "diagnostic-submission"),
          "submission", manifest, outputs, reviewed, job, requestId, executionName,
        );
      }

      const executionName = submission.executionName;
      let execution;
      for (let attempt = 0; attempt < DIAGNOSTIC_MAX_POLLS && config.now() <= diagnosticDeadline; attempt += 1) {
        const observed = runCommand(providerConfig, AZ_PATH, [
          "containerapp", "job", "execution", "show",
          "--name", job.name,
          "--resource-group", outputs.resourceGroup,
          "--subscription", bindings.backend.subscription_id,
          "--job-execution-name", executionName,
          "--output", "json",
        ], { phase: "diagnostic", timeoutMs: COMMAND_TIMEOUT_MS });
        if (observed.status === "ambiguous") reject("diagnostic-execution-unknown");
        if (observed.status !== "success") reject("diagnostic-execution-query");
        if (config.now() > diagnosticDeadline) reject("diagnostic-execution-timeout");
        const parsed = parseCommandJson(observed, "diagnostic-execution-response");
        const stateValue = diagnosticExecutionState(parsed, job, "diagnostic-execution-response");
        diagnosticExecutionTemplate(parsed, submission.env, reviewed.image, "diagnostic-execution-template");
        if (stateValue.name !== executionName) reject("diagnostic-execution-context");
        if (stateValue.terminal) {
          execution = stateValue;
          break;
        }
        boundedDiagnosticDelay();
      }
      failIf(execution === undefined, "diagnostic-execution-timeout");
      failIf(!execution.passed, "diagnostic-execution-failed");

      const afterIdentity = diagnosticIdentity(providerConfig, outputs, manifest, {
        requestId,
        executionName,
      }, undefined, true);
      const afterRole = diagnosticOpenAiRole(providerConfig, manifest, true);
      const identityWithoutExecution = (value) => {
        const { job, ...identity } = value;
        void job;
        return identity;
      };
      failIf(!same(identityWithoutExecution(intent.identity), identityWithoutExecution(afterIdentity)), "diagnostic-identity-transition");
      failIf(!same(intent.openAiRole, afterRole), "diagnostic-openai-role-transition");
      const beforeIdentity = {
        ...intent.identity,
        job: { requestId, executionName },
      };
      const unsignedReceipt = {
        version: 2,
        type: "diagnostic",
        status: "passed",
        operation: "runtime-cutover-diagnostic",
        runId,
        phase,
        planSha256: manifest.planSha256,
        bindingSha256: manifest.bindingSha256,
        createdAt: manifest.createdAt,
        repositoryCommit: manifest.bindings.repositoryCommit,
        contextSha256: manifest.bindingSha256,
        reviewedDigest,
        imageDigest: reviewed.image,
        digestCount: 1,
        submission: { requestId, executionName, artifactSha256: reviewedDigest },
        request: { requestId, operation: "start", argv: [...DIAGNOSTIC_COMMAND] },
        activity: { requestId, status: "Succeeded", terminal: true },
        execution: { baseline: "pre-cutover", result: "passed", retryCount: 0, exitCode: execution.exitCode, terminalResult: "succeeded" },
        identity: { before: beforeIdentity, after: afterIdentity },
        openAiRole: { before: intent.openAiRole, after: afterRole },
        runtimeSecretReferences: [],
      };
      exclusiveJson(run.artifacts.diagnostic, { ...unsignedReceipt, sha256: hashJson(unsignedReceipt) }, "diagnostic-receipt");
      requiredDiagnostic({ manifest, artifacts: run.artifacts });
      return { runId, phase, status: "diagnostic-passed", execution: executionName };
    });
  }

  function preflight(phase, runId) {
    assertPhase(phase);
    failIf(phase === "terminal", "terminal-preflight");
    assertRunId(runId);
    return withLock(config, () => {
      checkWorktreeIfInjected(phase);
      const state = requireState(config);
      const run = parseRun(config, state, phase, runId);
      assertRunStatus(run.entry, ["guarded"]);
      try {
        const manifest = readManifest(run);
        const env = buildChildEnvironment(run.runDirectory, config.inheritedEnvironment);
        if (phase === "runtime-cutover") protectedRuntimeSecretsRoleEnabled(config, true);
        if (phase === "credential-cleanup") protectedRuntimeSecretsRoleEnabled(config, false);
        const bindings = revalidate(run, "preflight", manifest, env);
        let cleanupStart;
        if (phase === "credential-cleanup") {
          const descriptorCheckpoint = checkpointNamed(
            readCheckpoints(run.runDirectory, { runId, phase }),
            "vault-descriptor",
          );
          assertCheckpointArtifact(
            run.artifacts.descriptor,
            descriptorCheckpoint,
            "descriptorSha256",
            "vault-descriptor",
          );
          validateCleanupDescriptor(run.artifacts.descriptor, manifest);
          const currentCheckpoints = readCheckpoints(run.runDirectory, { runId, phase });
          cleanupStart = currentCheckpoints.find((checkpoint) => checkpoint.name === "cleanup-start");
          if (cleanupStart === undefined) {
            if (!existsSync(run.artifacts.cleanupOperation)) {
              runCleanupUtility(config, "start", runId);
            } else {
              const existing = requiredCleanup({
                manifest,
                artifacts: run.artifacts,
                guardReceiptSha256: sha256File(run.artifacts.guard, JSON_MAX_BYTES),
                processRunner: config.processRunner,
              }, { requireAbsence: false });
              if (existing.operation.value.status === "prepared") {
                runCleanupUtility(config, "resume", runId);
              } else if (existing.operation.value.supersession === null &&
                !existsSync(run.artifacts.absence) && !existsSync(run.artifacts.cleanupState)) {
                reject("cleanup-state-missing");
              }
            }
            const cleanup = requiredCleanup({
              manifest,
              artifacts: run.artifacts,
              guardReceiptSha256: sha256File(run.artifacts.guard, JSON_MAX_BYTES),
              processRunner: config.processRunner,
            }, { requireAbsence: false });
            cleanupStart = writeCheckpoint(config, run.runDirectory, runId, phase, "cleanup-start", {
              cleanupOperationManifestSha256: cleanup.operation.fileSha256,
              guardReceiptSha256: sha256File(run.artifacts.guard, JSON_MAX_BYTES),
            });
          } else {
            failIf(!isSha(cleanupStart.cleanupOperationManifestSha256), "cleanup-operation-checkpoint");
            assertCheckpointArtifact(
              run.artifacts.cleanupOperation,
              cleanupStart,
              "cleanupOperationManifestSha256",
              "cleanup-operation",
            );
            requiredCleanup({
              manifest,
              artifacts: run.artifacts,
              guardReceiptSha256: cleanupStart.guardReceiptSha256,
              processRunner: config.processRunner,
            }, { requireAbsence: false });
          }
        }
        const verified = defaultPreflightVerifier(config, {
          operation: "preflight",
          phase,
          runId,
          state,
          env,
          cwd: config.workdir,
          bindings,
          manifest,
          artifacts: run.artifacts,
          runDirectory: run.runDirectory,
        });
        failIf(parseStatus(verified) !== "success", "preflight-rejected");
        failIf(!isObject(verified) || !isSha(verified.verifierSha256), "preflight-verifier");
        let evidence = {};
        if (phase === "runtime-cutover") {
          evidence = {
            diagnosticReceiptSha256: requiredDiagnostic({ manifest, artifacts: run.artifacts }).fileSha256,
          };
        } else if (phase === "credential-cleanup") {
          const cleanup = requiredCleanup({
            manifest,
            artifacts: run.artifacts,
            guardReceiptSha256: cleanupStart.guardReceiptSha256,
            processRunner: config.processRunner,
          }, { requireAbsence: false });
          evidence = {
            cleanupOperationManifestSha256: cleanup.operation.fileSha256,
          };
        }
        const receipt = receiptFor("preflight", manifest, {
          result: "passed",
          createdAt: nowIso(config.now),
          verifierSha256: verified.verifierSha256,
        });
        ensureReceiptSize(receipt);
        exclusiveJson(run.artifacts.preflight, receipt, "preflight-receipt");
        writeCheckpoint(config, run.runDirectory, runId, phase, "preflight-receipt", {
          receiptSha256: sha256File(run.artifacts.preflight),
          verifierSha256: receipt.verifierSha256,
          ...evidence,
        });
        updateRun(state, runId, { status: "preflighted", preflightAt: receipt.createdAt, lastCheckpoint: "preflight-receipt" });
        saveState(config, state);
        return { runId, phase, status: "preflighted" };
      } catch (error) {
        if (error instanceof LifecycleError && error.code === "plan-expired") {
          invalidate(state, runId, "expired");
        }
        handleRunFailure(state, runId, error);
        throw error;
      }
    });
  }

  function apply(phase, runId) {
    assertPhase(phase);
    failIf(phase === "terminal", "terminal-apply");
    assertRunId(runId);
    return withLock(config, () => {
      checkWorktreeIfInjected(phase);
      const state = requireState(config);
      const run = parseRun(config, state, phase, runId);
      assertRunStatus(run.entry, ["preflighted"]);
      let env;
      let invocationMayHaveStarted = false;
      try {
        const manifest = readManifest(run);
        env = buildChildEnvironment(run.runDirectory, config.inheritedEnvironment);
        if (phase === "runtime-cutover") protectedRuntimeSecretsRoleEnabled(config, true);
        if (phase === "credential-cleanup") protectedRuntimeSecretsRoleEnabled(config, false);
        revalidate(run, "apply", manifest, env);
        const checkpoints = readCheckpoints(run.runDirectory, { runId, phase });
        readReceiptAtCheckpoint(
          run.artifacts.guard,
          checkpointNamed(checkpoints, "guard-receipt"),
          manifest,
          "guard",
        );
        const preflightCheckpoint = checkpointNamed(checkpoints, "preflight-receipt");
        const preflightReceipt = readReceiptAtCheckpoint(
          run.artifacts.preflight,
          preflightCheckpoint,
          manifest,
          "preflight",
        );
        validateRecoveryEvidenceArtifacts(phase, run.artifacts, preflightCheckpoint, manifest, config.processRunner);
        assertPreflightAge(preflightReceipt, config.now);
        const applyingAt = nowIso(config.now);
        writeCheckpoint(config, run.runDirectory, runId, phase, "applying", {
          applyingAt,
          planSha256: manifest.planSha256,
        });
        updateRun(state, runId, { status: "applying", applyingAt, lastCheckpoint: "applying" });
        saveState(config, state);
        atomicConsume(
          run.artifacts.guard,
          `${run.artifacts.guard}.consumed`,
          "guard-receipt",
        );
        atomicConsume(
          run.artifacts.preflight,
          `${run.artifacts.preflight}.consumed`,
          "preflight-receipt",
        );
        writeCheckpoint(config, run.runDirectory, runId, phase, "receipts-consumed", {
          guardReceiptSha256: sha256File(`${run.artifacts.guard}.consumed`),
          preflightReceiptSha256: sha256File(`${run.artifacts.preflight}.consumed`),
        });
        updateRun(state, runId, { lastCheckpoint: "receipts-consumed" });
        let result;
        try {
          invocationMayHaveStarted = true;
          result = defaultTerraformExecutor({
            operation: "apply",
            phase,
            runId,
            argv: exactApplyArgv(run.artifacts.plan),
            cwd: config.workdir,
            env,
            planPath: run.artifacts.plan,
            processRunner: config.processRunner,
          });
        } catch {
          result = { status: "ambiguous" };
        }
        const resultStatus = parseStatus(result);
        const exitCheckpoint = resultStatus === "ambiguous" ? "terraform-exit-ambiguous" : "terraform-exit-known";
        writeCheckpoint(config, run.runDirectory, runId, phase, exitCheckpoint, {
          status: resultStatus,
          exitCode: result?.exitCode ?? null,
        });
        updateRun(state, runId, { lastCheckpoint: exitCheckpoint });
        if (resultStatus === "success") {
          if (phase === "credential-cleanup") {
            runCleanupUtility(config, "resume", runId);
            const cleanup = requiredCleanup({
              manifest,
              artifacts: run.artifacts,
              guardReceiptSha256: sha256File(`${run.artifacts.guard}.consumed`, JSON_MAX_BYTES),
              processRunner: config.processRunner,
            });
            failIf(cleanup.absence === undefined, "cleanup-absence-missing");
          }
          const receipt = {
            ...receiptFor("apply", manifest, { status: "applied" }),
            appliedAt: nowIso(config.now),
          };
          ensureReceiptSize(receipt);
          exclusiveJson(run.artifacts.apply, receipt, "apply-receipt");
          writeCheckpoint(config, run.runDirectory, runId, phase, "apply-receipt", {
            receiptSha256: sha256File(run.artifacts.apply),
            status: receipt.status,
          });
          updateRun(state, runId, { status: "applied", appliedAt: receipt.appliedAt, lastCheckpoint: "apply-receipt" });
          writeCheckpoint(config, run.runDirectory, runId, phase, "global-state-advancement", {
            from: state.state,
            to: ADVANCED_STATE[phase],
            applyReceiptSha256: sha256File(run.artifacts.apply),
          });
          state.state = ADVANCED_STATE[phase];
          updateRun(state, runId, { lastCheckpoint: "global-state-advancement" });
          saveState(config, state);
          return { runId, phase, status: "applied", state: state.state };
        }
        const receipt = {
          ...receiptFor("apply", manifest, { status: "unknown" }),
          appliedAt: nowIso(config.now),
        };
        ensureReceiptSize(receipt);
        exclusiveJson(run.artifacts.apply, receipt, "apply-receipt");
        writeCheckpoint(config, run.runDirectory, runId, phase, "apply-receipt", {
          receiptSha256: sha256File(run.artifacts.apply),
          status: receipt.status,
        });
        updateRun(state, runId, { status: "unknown", unknownAt: receipt.appliedAt, lastCheckpoint: "apply-receipt" });
        saveState(config, state);
        reject("apply-unknown");
      } catch (error) {
        const runEntry = state.runs.find((candidate) => candidate.id === runId);
        let durableCheckpoints = [];
        try {
          durableCheckpoints = readCheckpoints(run.runDirectory, { runId, phase });
        } catch {
          // The recovery block below remains fail-closed if checkpoint
          // integrity itself cannot be established.
        }
        const invocationStarted = invocationMayHaveStarted ||
          ["applying", "unknown", "applied"].includes(runEntry?.status) ||
          durableCheckpoints.some((checkpoint) => checkpoint.name === "applying");
        if (!invocationStarted) {
          if (
            error instanceof LifecycleError &&
            ["plan-expired", "preflight-expired"].includes(error.code)
          ) {
            invalidate(state, runId, error.code);
          }
          handleRunFailure(state, runId, error);
          throw error;
        }

        try {
          const manifest = readJson(run.artifacts.manifest, "manifest");
          const checkpoints = readCheckpoints(run.runDirectory, { runId, phase });
          const applyCheckpoint = checkpoints.find((checkpoint) => checkpoint.name === "apply-receipt");
          const advancement = checkpoints.find((checkpoint) => checkpoint.name === "global-state-advancement");
          const applyingCheckpoint = checkpoints.find((checkpoint) => checkpoint.name === "applying");
          const exitCheckpoint = checkpoints.find((checkpoint) =>
            checkpoint.sequence > (applyingCheckpoint?.sequence ?? Number.MAX_SAFE_INTEGER) &&
              ["terraform-exit-known", "terraform-exit-ambiguous"].includes(checkpoint.name),
          );
          const applyPresent = existsSync(run.artifacts.apply);
          let applyReceipt;
          let applyReceiptError;
          if (applyPresent) {
            try {
              if (applyCheckpoint !== undefined) {
                applyReceipt = readReceiptAtCheckpoint(
                  run.artifacts.apply,
                  applyCheckpoint,
                  manifest,
                  "apply",
                  ["applied", "unknown"],
                );
              } else {
                assertReceiptFileSize(run.artifacts.apply, "apply-receipt");
                applyReceipt = assertApplyReceipt(readJson(run.artifacts.apply, "apply-receipt"), manifest);
              }
            } catch (receiptError) {
              applyReceiptError = receiptError;
            }
          }

          if (applyReceiptError === undefined && applyReceipt?.status === "applied") {
            if (applyReceipt === undefined || applyReceipt.status !== "applied") {
              reject("global-state-history");
            }
            if (applyCheckpoint === undefined) {
              writeCheckpoint(config, run.runDirectory, runId, phase, "apply-receipt", {
                receiptSha256: sha256File(run.artifacts.apply),
                status: applyReceipt.status,
              });
            }
            if (advancement === undefined) {
              writeCheckpoint(config, run.runDirectory, runId, phase, "global-state-advancement", {
                from: state.state,
                to: ADVANCED_STATE[phase],
                applyReceiptSha256: sha256File(run.artifacts.apply),
                recovered: true,
              });
            }
            state.state = ADVANCED_STATE[phase];
            updateRun(state, runId, {
              status: "applied",
              appliedAt: applyReceipt.appliedAt ?? nowIso(config.now),
              lastCheckpoint: "global-state-advancement",
            });
            saveState(config, state);
          } else {
            if (exitCheckpoint === undefined && applyCheckpoint === undefined) {
              writeCheckpoint(config, run.runDirectory, runId, phase, "terraform-exit-ambiguous", {
                status: "ambiguous",
                exitCode: null,
                recovered: true,
              });
            }
            if (!applyPresent && applyCheckpoint === undefined) {
              const unknownReceipt = {
                ...receiptFor("apply", manifest, { status: "unknown" }),
                appliedAt: nowIso(config.now),
              };
              ensureReceiptSize(unknownReceipt);
              exclusiveJson(run.artifacts.apply, unknownReceipt, "apply-receipt");
              applyReceipt = unknownReceipt;
            }
            if (applyReceiptError === undefined && applyCheckpoint === undefined && applyReceipt?.status === "unknown") {
              writeCheckpoint(config, run.runDirectory, runId, phase, "apply-receipt", {
                receiptSha256: sha256File(run.artifacts.apply),
                status: "unknown",
              });
            }
            updateRun(state, runId, {
              status: "unknown",
              unknownAt: applyReceipt?.appliedAt ?? nowIso(config.now),
              lastCheckpoint: applyCheckpoint?.name ?? checkpoints.at(-1)?.name ?? runEntry.lastCheckpoint,
            });
            saveState(config, state);
          }
        } catch {
          // Preserve the original post-invocation failure without exposing
          // executor output or replacing an immutable receipt.
        }
        throw error;
      }
    });
  }

  function reconcile(phase, runId) {
    assertPhase(phase);
    failIf(phase === "terminal", "terminal-reconcile");
    assertRunId(runId);
    return withLock(config, () => {
      checkWorktreeIfInjected(phase);
      const state = requireState(config);
      const run = parseRun(config, state, phase, runId);
      assertRunStatus(run.entry, ["applying", "unknown"]);
      try {
      const manifest = readManifest(run);
      const env = buildChildEnvironment(run.runDirectory, config.inheritedEnvironment);
      const bindings = operationContext(
        phase,
        "reconcile",
        { manifest },
        run.artifacts.plan,
        manifest.argv,
        env,
      );
      failIf(!sameBindingsForOperation(bindings, manifest.bindings, "reconcile"), "binding-mismatch");
      failIf(
        !historicalCodeBindingsMatch(
          config.repoRoot,
          phase,
          bindings,
          manifest.bindings,
          config.processRunner,
        ),
        "binding-mismatch",
      );
      assertReconcileSerial(bindings.stateSerial, manifest.bindings.stateSerial);
      const checkpoints = readCheckpoints(run.runDirectory, { runId, phase });
      if (checkpoints.some((checkpoint) => checkpoint.name === "receipts-consumed")) {
        const consumed = checkpointNamed(checkpoints, "receipts-consumed");
        assertCheckpointArtifact(
          `${run.artifacts.guard}.consumed`,
          consumed,
          "guardReceiptSha256",
          "guard-receipt-consumed",
        );
        assertCheckpointArtifact(
          `${run.artifacts.preflight}.consumed`,
          consumed,
          "preflightReceiptSha256",
          "preflight-receipt-consumed",
        );
        assertReceiptSchema(readJson(`${run.artifacts.guard}.consumed`, "guard-receipt-consumed"), manifest, "guard");
        assertReceiptSchema(readJson(`${run.artifacts.preflight}.consumed`, "preflight-receipt-consumed"), manifest, "preflight");
      }
      if (checkpoints.some((checkpoint) => checkpoint.name === "apply-receipt")) {
        readReceiptAtCheckpoint(
          run.artifacts.apply,
          checkpointNamed(checkpoints, "apply-receipt"),
          manifest,
          "apply",
          ["applied", "unknown"],
        );
      }
      if (checkpoints.some((checkpoint) => checkpoint.name === "reconcile")) {
        for (const checkpoint of checkpoints.filter((candidate) => candidate.name === "reconcile")) {
          readReceiptAtCheckpoint(
            reconcilePathForCheckpoint(run.runDirectory, checkpoint),
            checkpoint,
            manifest,
            "reconcile",
            ["applied", "invalidated", "unknown"],
          );
        }
      }
      if (phase === "credential-cleanup") {
        runCleanupUtility(config, "resume", runId);
      }
      const inspected = defaultLiveInspector(config, {
        operation: "reconcile",
        phase,
        runId,
        state,
        manifest,
        bindings,
        env,
        cwd: config.workdir,
        artifacts: run.artifacts,
        runDirectory: run.runDirectory,
      });
      const outcome = inspected?.outcome;
      failIf(!["post", "pre", "mixed", "unknown"].includes(outcome), "reconcile-unknown");
      if (outcome === "post") {
        const receipt = {
          ...receiptFor("reconcile", manifest, { status: "applied" }),
          reconciledAt: nowIso(config.now),
        };
        ensureReceiptSize(receipt);
        const sequence = readReconcileReceiptPaths(run.runDirectory).length + 1;
        const reconcilePath = reconcileReceiptPath(run.runDirectory, sequence);
        exclusiveJson(reconcilePath, receipt, "reconcile-receipt");
        writeCheckpoint(config, run.runDirectory, runId, phase, "reconcile", {
          receiptSha256: sha256File(reconcilePath),
          reconcileSequence: sequence,
          outcome,
          status: receipt.status,
        });
        updateRun(state, runId, { status: "applied", reconciledAt: receipt.reconciledAt, lastCheckpoint: "reconcile" });
        writeCheckpoint(config, run.runDirectory, runId, phase, "global-state-advancement", {
          from: state.state,
          to: ADVANCED_STATE[phase],
          applyReceiptSha256: optionalSha256File(run.artifacts.apply),
        });
        state.state = ADVANCED_STATE[phase];
        updateRun(state, runId, { lastCheckpoint: "global-state-advancement" });
        saveState(config, state);
        return { runId, phase, status: "applied", state: state.state };
      }
      if (outcome === "pre") {
        const receipt = {
          ...receiptFor("reconcile", manifest, { status: "invalidated" }),
          reconciledAt: nowIso(config.now),
        };
        ensureReceiptSize(receipt);
        const sequence = readReconcileReceiptPaths(run.runDirectory).length + 1;
        const reconcilePath = reconcileReceiptPath(run.runDirectory, sequence);
        exclusiveJson(reconcilePath, receipt, "reconcile-receipt");
        writeCheckpoint(config, run.runDirectory, runId, phase, "reconcile", {
          receiptSha256: sha256File(reconcilePath),
          reconcileSequence: sequence,
          outcome,
          status: receipt.status,
        });
        updateRun(state, runId, { status: "invalidated", invalidatedAt: receipt.reconciledAt, lastCheckpoint: "reconcile" });
        saveState(config, state);
        return { runId, phase, status: "invalidated" };
      }
      const receipt = {
        ...receiptFor("reconcile", manifest, { status: "unknown" }),
        reconciledAt: nowIso(config.now),
      };
      ensureReceiptSize(receipt);
      const sequence = readReconcileReceiptPaths(run.runDirectory).length + 1;
      const reconcilePath = reconcileReceiptPath(run.runDirectory, sequence);
      exclusiveJson(reconcilePath, receipt, "reconcile-receipt");
      writeCheckpoint(config, run.runDirectory, runId, phase, "reconcile", {
        receiptSha256: sha256File(reconcilePath),
        reconcileSequence: sequence,
        outcome,
        status: receipt.status,
      });
      updateRun(state, runId, { lastCheckpoint: "reconcile" });
      reject("reconcile-unknown");
      } catch (error) {
        const entry = state.runs.find((candidate) => candidate.id === runId);
        if (entry?.status === "applying") {
          updateRun(state, runId, {
            status: "unknown",
            unknownAt: nowIso(config.now),
          });
          saveState(config, state);
        }
        throw error;
      }
    });
  }

  function supersede(phase, oldRunId) {
    failIf(phase !== "credential-cleanup", "supersede-phase");
    assertRunId(oldRunId);
    return withLock(config, () => {
      checkWorktreeIfInjected(phase);
      const state = requireState(config);
      const old = parseRun(config, state, phase, oldRunId);
      assertRunStatus(old.entry, ["invalidated"]);
      failIf(!["expired", "plan-expired", "preflight-expired"].includes(old.entry.reason), "supersede-status");
      const oldManifest = readManifest(old);
      failIf(config.now() - jsonDate(oldManifest.createdAt) <= PLAN_MAX_AGE_MS[phase], "plan-not-expired");
      const oldEnv = buildChildEnvironment(old.runDirectory, config.inheritedEnvironment);
      const oldBindings = operationContext(
        phase,
        "supersede",
        { manifest: oldManifest },
        old.artifacts.plan,
        oldManifest.argv,
        oldEnv,
      );
      failIf(!same(oldBindings, oldManifest.bindings), "binding-mismatch");
      const oldCheckpoints = readCheckpoints(old.runDirectory, { runId: oldRunId, phase });
      const consumed = oldCheckpoints.find((checkpoint) => checkpoint.name === "receipts-consumed");
      const cleanup = requiredCleanup({
        manifest: oldManifest,
        artifacts: old.artifacts,
        guardReceiptSha256: consumed?.guardReceiptSha256 ?? sha256File(old.artifacts.guard, JSON_MAX_BYTES),
        processRunner: config.processRunner,
      });
      const cleanupArtifactSha256 = cleanup.operation.fileSha256;
      const absenceArtifactSha256 = cleanup.absence.fileSha256;
      runCleanupUtility(config, "assert-absent", oldRunId);
      const valid = defaultCleanupValidator(config, {
        phase,
        runId: oldRunId,
        state,
        manifest: oldManifest,
        cleanup: cleanup.operation.value,
        absence: cleanup.absence.value,
        artifacts: old.artifacts,
        runDirectory: old.runDirectory,
        env: oldEnv,
      });
      failIf(parseStatus(valid) !== "success", "cleanup-context");
      const supersession = {
        oldRunId,
        cleanupManifestSha256: cleanupArtifactSha256,
        absenceReceiptSha256: absenceArtifactSha256,
        contextSha256: oldManifest.bindingSha256,
      };
      const result = createUnderLock(phase, supersession, state);
      updateRun(state, oldRunId, { status: "superseded", supersededBy: result.runId });
      saveState(config, state);
      return result;
    });
  }

  function createUnderLock(phase, supersession, state) {
    let operationRunId;
    try {
      return createUnderLockBody(phase, supersession, state, (runId) => {
        operationRunId = runId;
      });
    } catch (error) {
      if (operationRunId !== undefined) handleRunFailure(state, operationRunId, error);
      throw error;
    }
  }

  function createUnderLockBody(phase, supersession, state, onRunId) {
    assertStateForCreate(state, phase, config);
    checkInheritedEnvironment(config.inheritedEnvironment);
    if (phase === "runtime-cutover") protectedRuntimeSecretsRoleEnabled(config, true);
    if (phase === "credential-cleanup") protectedRuntimeSecretsRoleEnabled(config, false);
    rejectAutomaticTerraformVariableSources(config.workdir);
    const runId = makeRunId();
    onRunId(runId);
    const runDirectory = createRunDirectory(config, runId);
    const artifacts = artifactPaths(runDirectory);
    state.runs.push({
      id: runId,
      phase,
      status: "created",
      createdAt: nowIso(config.now),
      ...(supersession ? { supersession } : {}),
    });
    saveState(config, state);
    writeCheckpoint(config, runDirectory, runId, phase, "run-directory");
    const env = buildChildEnvironment(runDirectory, config.inheritedEnvironment);
    const planArgv = exactCreateArgv(artifacts.plan);
    const manifestArgv = planArgv;
    const prePlanRaw = defaultContext(
      { ...config, childEnvironment: env, contextOperation: "create-before-plan" },
      { phase, operation: "create", planPath: artifacts.plan, argv: manifestArgv, env },
    );
    const prePlanContext = normalizedContextBeforePlan(
      prePlanRaw,
      { phase, cwd: config.workdir, argv: manifestArgv },
    );
    const verifierPath = materializeReviewedVerifier(config, artifacts, prePlanContext);
    const imagePlatforms = verifyImagePlatforms(config, phase, env, prePlanContext, undefined, verifierPath);
    writeCheckpoint(config, runDirectory, runId, phase, "image-platform-verified", {
      verifierSha256: imagePlatforms.verifierSha256,
      verifierPath: IMAGE_VERIFIER_ARTIFACT_NAME,
      descriptorSetSha256: hashJson(imagePlatforms.images),
    });
    updateRun(state, runId, { lastCheckpoint: "image-platform-verified" });
    const planStartedAt = nowIso(config.now);
    writeCheckpoint(config, runDirectory, runId, phase, "plan-started", {
      argv: manifestArgv,
      createdAt: planStartedAt,
      });
      updateRun(state, runId, { lastCheckpoint: "plan-started" });
    const beforePlan = normalizedContextBeforePlan(
      { ...prePlanRaw, imagePlatforms },
      { phase, cwd: config.workdir, argv: manifestArgv, imagePlatforms },
    );
    let result;
    try {
      result = defaultTerraformExecutor({
        operation: "create",
        phase,
        runId,
        argv: planArgv,
        cwd: config.workdir,
        env,
        planPath: artifacts.plan,
        tempPlanPath: artifacts.planTemp,
        supersession,
        processRunner: config.processRunner,
      });
    } catch {
      result = { status: "ambiguous" };
    }
    if (parseStatus(result) !== "success") {
      writeCheckpoint(config, runDirectory, runId, phase, "terraform-exit-ambiguous", { status: "ambiguous" });
      updateRun(state, runId, { status: "invalidated", reason: "terraform-create" });
      saveState(config, state);
      reject("terraform-create");
    }
    const producedPlan = config.processRunner === undefined ? artifacts.planTemp : artifacts.plan;
    assertRegular(producedPlan, ARTIFACT_MODE, "temp-plan");
    fsyncFile(producedPlan, "plan-fsync");
    if (producedPlan !== artifacts.plan) publishNoReplace(producedPlan, artifacts.plan, "published-plan");
    assertRegular(artifacts.plan, ARTIFACT_MODE, "plan");
    fsyncFile(artifacts.plan, "plan-fsync");
    const planHash = sha256File(artifacts.plan);
    writeCheckpoint(config, runDirectory, runId, phase, "temp-plan", { planSha256: planHash });
    updateRun(state, runId, { lastCheckpoint: "temp-plan" });
    writeCheckpoint(config, runDirectory, runId, phase, "published-plan", {
      planSha256: planHash,
      planPath: artifacts.plan,
    });
    updateRun(state, runId, { lastCheckpoint: "published-plan" });
    writeCheckpoint(config, runDirectory, runId, phase, "terraform-exit-known", {
      operation: "create",
      status: "success",
      exitCode: 0,
    });
    updateRun(state, runId, { lastCheckpoint: "terraform-exit-known" });
    const context = operationContext(
      phase,
      "create",
      { manifest: { planSha256: planHash, runId } },
      artifacts.plan,
      manifestArgv,
      env,
      imagePlatforms,
    );
    failIf(!sameCompletePlanContext(beforePlan, context), "binding-mismatch");
    try {
      assertPlanAge({ phase, createdAt: planStartedAt }, phase, config.now);
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "plan-expired") {
        updateRun(state, runId, { status: "invalidated", reason: "plan-expired" });
        saveState(config, state);
      }
      throw error;
    }
    const manifest = manifestFor(phase, runId, planStartedAt, planHash, context, manifestArgv);
    manifest.supersession = supersession;
    exclusiveJson(artifacts.manifest, manifest, "manifest");
    writeCheckpoint(config, runDirectory, runId, phase, "manifest", {
      manifestSha256: sha256File(artifacts.manifest),
      planSha256: manifest.planSha256,
    });
    updateRun(state, runId, { createdAt: manifest.createdAt });
    return { runId, phase, status: "created", supersedes: supersession.oldRunId };
  }

  function finalize(phase, runId) {
    failIf(phase !== "terminal", "finalize-phase");
    assertRunId(runId);
    return withLock(config, () => {
      checkWorktreeIfInjected(phase);
      const state = requireState(config);
      const run = parseRun(config, state, phase, runId);
      assertRunStatus(run.entry, ["guarded"]);
      failIf(state.state !== "credentials-and-RBAC-cleaned", "out-of-order-phase");
      try {
      const manifest = readManifest(run);
      const env = buildChildEnvironment(run.runDirectory, config.inheritedEnvironment);
      const bindings = revalidate(run, "finalize", manifest, env);
      const checkpoints = readCheckpoints(run.runDirectory, { runId, phase });
      const guardReceipt = readReceiptAtCheckpoint(
        run.artifacts.guard,
        checkpointNamed(checkpoints, "guard-receipt"),
        manifest,
        "guard",
      );
      failIf(
        !same(guardReceipt.guardArgv, exactGuardArgv(phase)) ||
          guardReceipt.stdinSha256 !== guardReceipt.showSha256,
        "guard-mismatch",
      );
      const showCheckpoint = checkpointNamed(checkpoints, "show-json");
      assertCheckpointArtifact(run.artifacts.show, showCheckpoint, "showSha256", "show-json");
      const showText = boundedFileText(run.artifacts.show, JSON_MAX_BYTES, "show-json");
      failIf(sha256Bytes(showText) !== guardReceipt.showSha256, "show-hash");
      const terminal = defaultTerminalReceiptProvider(config, {
        operation: "finalize",
        phase,
        runId,
        state,
        manifest,
        bindings,
        env,
        cwd: config.workdir,
        artifacts: run.artifacts,
        runDirectory: run.runDirectory,
      });
      failIf(parseStatus(terminal) !== "success", "terminal-receipts");
      failIf(!isObject(terminal) || !isSha(terminal.receiptSetSha256), "terminal-receipt-set");
      const expectedInventory = terminal.receiptInventory;
      failIf(!same(terminal.receiptInventory, expectedInventory), "terminal-receipt-inventory");
      failIf(hashJson(expectedInventory) !== terminal.receiptSetSha256, "terminal-receipt-set");
      const receipt = receiptFor("terminal", manifest, {
        result: "verified",
        receiptInventory: expectedInventory,
        receiptSetSha256: terminal.receiptSetSha256,
      });
      failIf(Buffer.byteLength(canonicalJson(receipt)) > JSON_MAX_BYTES, "terminal-receipt-too-large");
      exclusiveJson(run.artifacts.terminal, receipt, "terminal-receipts");
      writeCheckpoint(config, run.runDirectory, runId, phase, "global-state-advancement", {
        from: state.state,
        to: "terminal-verified",
        receiptInventory: expectedInventory,
        receiptSetSha256: terminal.receiptSetSha256,
        terminalReceiptSha256: sha256File(run.artifacts.terminal),
      });
      updateRun(state, runId, { status: "finalized", finalizedAt: nowIso(config.now), lastCheckpoint: "global-state-advancement" });
      state.state = "terminal-verified";
      saveState(config, state);
      return { runId, phase, status: "finalized", state: state.state };
      } catch (error) {
        if (error instanceof LifecycleError && error.code === "plan-expired") {
          invalidate(state, runId, "expired");
        }
        handleRunFailure(state, runId, error);
        throw error;
      }
    });
  }

  function close(phase, runId) {
    failIf(phase !== "terminal", "close-phase");
    assertRunId(runId);
    return withLock(config, () => {
      checkWorktreeIfInjected(phase);
      if (existsSync(config.closure)) return closeEvidenceRoot(config, undefined);
      const state = requireState(config);
      const run = parseRun(config, state, phase, runId);
      failIf(run.entry.status !== "finalized" || state.state !== "terminal-verified", "closure-not-ready");
      return closeEvidenceRoot(config, state);
    }, true);
  }

  function execute(parsed) {
    failIf(!parsed, "usage");
    switch (parsed.operation) {
      case "init":
        return init();
      case "create":
        return create(parsed.phase);
      case "guard":
        return guard(parsed.phase, parsed.runId);
      case "diagnostic":
        return diagnostic(parsed.phase, parsed.runId);
      case "preflight":
        return preflight(parsed.phase, parsed.runId);
      case "apply":
        return apply(parsed.phase, parsed.runId);
      case "reconcile":
        return reconcile(parsed.phase, parsed.runId);
      case "supersede":
        return supersede(parsed.phase, parsed.runId);
      case "finalize":
        return finalize(parsed.phase, parsed.runId);
      case "close":
        return close(parsed.phase, parsed.runId);
      default:
        reject("usage");
    }
  }

  return Object.freeze({
    config: Object.freeze({ ...config }),
    init,
    create,
    guard,
    diagnostic,
    preflight,
    apply,
    reconcile,
    supersede,
    finalize,
    close,
    execute,
    parseCli,
    paths: (runId) => artifactPaths(runPath(config, runId)),
    readState: () => {
      ensureRoot(config);
      return loadState(config);
    },
  });
}

function createLifecycle() {
  failIf(arguments.length !== 0, "production-options");
  return createLifecycleInternal({}, { production: true });
}

function runCliInternal(argv, options, internal) {
  const parsed = parseCli(argv);
  if (!parsed) return 2;
  try {
    if (internal.lockMode === "inherited") {
      failIf(inheritedKernelLockDescriptor() === undefined, "kernel-lock-inherited");
    }
    const result = createLifecycleInternal(options, internal).execute(parsed);
    if (parsed.operation === "create") {
      failIf(!isObject(result) || typeof result.runId !== "string" || !RUN_ID_RE.test(result.runId), "run-id-output");
      process.stdout.write(`${result.runId}\n`);
    } else {
      process.stdout.write("success\n");
    }
    return 0;
  } catch (error) {
    if (error instanceof LifecycleError) {
      process.stderr.write(`dev-plan-lifecycle: rejected ${error.code}\n`);
    } else {
      process.stderr.write("dev-plan-lifecycle: rejected internal-error\n");
    }
    return 1;
  }
}

function runCli(argv) {
  if (arguments.length !== 1) return 2;
  return runCliInternal(argv, {}, { production: true });
}

function createLifecycleForTests(options = {}) {
  const internal = testFactoryInternal(options);
  return TEST_EXECUTION.run(internal.testExecution, () =>
    createLifecycleInternal(options, internal),
  );
}

function runCliForTests(argv, options = {}) {
  const internal = testFactoryInternal(options);
  return TEST_EXECUTION.run(internal.testExecution, () =>
    runCliInternal(argv, options, internal),
  );
}

// The test harness exports these helpers from an instrumented module copy.
void createLifecycle;
void runCli;
void createLifecycleForTests;
void runCliForTests;

function runLockedCli(argv) {
  return runCliInternal(argv, {}, { production: true, lockMode: "inherited" });
}

function closedCliArgs(parsed) {
  const args = [parsed.operation];
  if (parsed.phase !== undefined) args.push(parsed.phase);
  if (parsed.runId !== undefined) args.push(parsed.runId);
  return Object.freeze(args);
}

function productionLockPath() {
  return kernelPathFor({ root: EVIDENCE_ROOT });
}

function productionError() {
  process.stderr.write("dev-plan-lifecycle: rejected operation\n");
  return 1;
}

function runProductionCli(argv) {
  const parsed = parseCli(argv);
  if (!parsed) return 2;
  const lockPath = productionLockPath();
  try {
    ensureKernelParentDirectory(lockPath, "kernel-lock");
    ensureKernelFile(lockPath, "kernel-lock");
  } catch {
    return productionError();
  }
  let child;
  try {
    child = spawnSync(
      "/usr/bin/flock",
      ["-n", lockPath, "/usr/bin/node", SCRIPT_PATH, INTERNAL_LOCKED_MARKER, ...closedCliArgs(parsed)],
      {
        cwd: REPOSITORY_ROOT,
        env: { ...PRODUCTION_ENV },
        encoding: "utf8",
        timeout: PRODUCTION_CLI_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    return productionError();
  }
  if (child.status !== 0 || child.error || typeof child.stdout !== "string") return productionError();
  const expected = parsed.operation === "create"
    ? new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\\n$`)
    : /^success\n$/;
  if (!expected.test(child.stdout) || child.stderr !== "") return productionError();
  process.stdout.write(child.stdout);
  return 0;
}

function isMainModule() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH;
}

if (isMainModule()) {
  if (process.argv[2] === INTERNAL_APPLY_RUNNER_MARKER) {
    applyRunnerMain(process.argv.slice(3))
      .then((result) => {
        process.stdout.write(canonicalJson(result));
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  } else if (process.argv[2] === INTERNAL_LOCKED_MARKER) {
    process.exitCode = runLockedCli(process.argv.slice(3));
  } else {
    const code = runProductionCli(process.argv.slice(2));
    if (code === 2) process.stderr.write("dev-plan-lifecycle: usage error\n");
    process.exitCode = code;
  }
}
