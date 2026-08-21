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
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const DEFAULT_WORKDIR = path.join(REPOSITORY_ROOT, "infra/environments/dev");

export const EVIDENCE_ROOT =
  "/home/dev/.local/state/palancar/azure-foundry-entra-cutover";
export const CLOSURE_PATH =
  "/home/dev/.local/state/palancar/azure-foundry-entra-cutover-closure";
const LIFECYCLE_CACHE_ROOT =
  "/home/dev/.local/state/palancar/azure-foundry-entra-cutover-cache";
export const TERRAFORM_PATH = "/home/dev/.local/bin/terraform-1.15.8";
export const TERRAFORM_SHA256 =
  "00f55981f5215594c418cd6b20f44fa4c99f9126650602e65d533d131005ea81";
export const AZ_PATH = "/usr/bin/az";
export const BACKEND_SHA256 =
  "171c599d84b399299b6bed79a730396ff9500df2f43c906f193db647d194fb22";
export const GENERATION_DIFF_SHA256 =
  "180bd86ed88774121cd531a98b9b0dd0d5aa0b01c39af7c11ea64c62ad5a324f";

const RUNTIME_RELAY_IMAGE =
  "palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:e9b7e2ea937d3a15f3b3a52e50d9736b5c63c69765c3ee571ab0c06f762436bd";
const RUNTIME_LITELLM_IMAGE =
  "palancardevacraeeacd8c.azurecr.io/palancar-litellm-proxy@sha256:d065e5e847b543fd22b43ea3b62a6680619d8c76b67c2a7ef6a135b10e3978b3";
const RUNTIME_LITELLM_MODEL = "palancar-generation";
const RUNTIME_LITELLM_BASE_URL = "http://127.0.0.1:4000";
const RUNTIME_OPENROUTER_MODEL = "openrouter/openai/gpt-5.6-luna";
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
  "preflight",
  "apply",
  "reconcile",
  "supersede",
  "finalize",
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
const EXECUTABLE_MAX_BYTES = 256 * 1024 * 1024;
const COMMAND_OUTPUT_MAX_BYTES = JSON_MAX_BYTES;
const COMMAND_TIMEOUT_MS = 120 * 1000;
const APPLY_TIMEOUT_MS = 15 * 60 * 1000;
const ARTIFACT_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const APPLY_TERM_GRACE_MS = 250;
const APPLY_KILL_GRACE_MS = 500;
const PRODUCTION_CLI_TIMEOUT_MS = APPLY_TIMEOUT_MS + COMMAND_TIMEOUT_MS + APPLY_TERM_GRACE_MS + APPLY_KILL_GRACE_MS;
const INTERNAL_LOCKED_MARKER = "--__palancar-internal-locked-b1b";
const INTERNAL_APPLY_RUNNER_MARKER = "--__palancar-internal-apply-runner-b1b";
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
  "plan-started",
  "terraform-exit-ambiguous",
  "temp-plan",
  "published-plan",
  "terraform-exit-known",
  "manifest",
  "show-json",
  "guard-receipt",
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
const GENERATION_PATHS = Object.freeze([
  "packages/generation/src/errors.ts",
  "packages/generation/src/evidence.ts",
  "packages/generation/src/litellm.ts",
  "packages/generation/src/service.ts",
  "packages/generation/src/types.ts",
  "packages/generation/test/generation.test.ts",
  "packages/generation/test/litellm-provider.test.ts",
]);
const REVIEWED_DEPENDENCIES = Object.freeze({
  "model-bootstrap": Object.freeze([
    "infra/scripts/dev-plan-lifecycle.mjs",
    "infra/scripts/assert-dev-plan.mjs",
    "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
    // assert-dev-plan.mjs imports this fixture while its module is loaded.
    "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
  ]),
  "runtime-cutover": Object.freeze([
    "infra/scripts/dev-plan-lifecycle.mjs",
    "infra/scripts/assert-dev-plan.mjs",
    "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
    "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
  ]),
  "credential-cleanup": Object.freeze([
    "infra/scripts/dev-plan-lifecycle.mjs",
    "infra/scripts/assert-dev-plan.mjs",
    "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
    "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
  ]),
  terminal: Object.freeze([
    "infra/scripts/dev-plan-lifecycle.mjs",
    "infra/scripts/assert-dev-plan.mjs",
    "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
    "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
  ]),
});
const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
const RUN_STATUSES = Object.freeze([
  "created",
  "guarded",
  "preflighted",
  "applying",
  "unknown",
  "applied",
  "finalized",
  "invalidated",
  "superseded",
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
  "preflight-receipt",
  "applying",
  "receipts-consumed",
  "apply-receipt",
  "global-state-advancement",
  "reconcile",
  "invalidated",
  "superseded",
]);
const TERMINAL_RECEIPTS = Object.freeze([
  ["diagnostic", "diagnostic-receipt.json"],
  ["cleanup", "cleanup-manifest.json"],
  ["absence", "cleanup-absence-receipt.json"],
  ["live", "terminal-live-receipt.json"],
]);

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
  return same(left, right);
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

function assertOperation(operation) {
  failIf(!OPERATIONS.includes(operation), "invalid-operation");
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

function immutableManifest(runDirectory, artifacts, checkpoints, run) {
  const checkpoint = checkpointNamed(checkpoints, "manifest");
  assertCheckpointArtifact(artifacts.manifest, checkpoint, "manifestSha256", "manifest");
  const manifest = readJson(artifacts.manifest, "manifest");
  failIf(
    manifest.runId !== run.id || manifest.phase !== run.phase || !Array.isArray(manifest.argv),
    "manifest-mismatch",
  );
  assertRegular(artifacts.plan, ARTIFACT_MODE, "plan");
  failIf(sha256File(artifacts.plan) !== manifest.planSha256, "plan-hash");
  failIf(bindingHash(manifest.bindings) !== manifest.bindingSha256, "binding-hash");
  const published = checkpointNamed(checkpoints, "published-plan");
  failIf(published.planSha256 !== manifest.planSha256, "checkpoint-integrity");
  failIf(checkpoint.manifestSha256 !== sha256File(artifacts.manifest), "checkpoint-integrity");
  return manifest;
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
    azureContextHash,
    callerHash,
    guard: GUARD_MAPPINGS[expected.phase],
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
  failIf(!same(bindings.argv, expected.argv), "argv-context");
  failIf(!isSha(bindings.backendConfigurationSha256), "backend-hash");
  return bindings;
}

function bindingHash(bindings) {
  return hashJson(bindings);
}

function gitResult(repoRoot, args, processRunner, phase) {
  const result = commandResult(
    "/usr/bin/git",
    args,
    {
      cwd: repoRoot,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeoutMs: COMMAND_TIMEOUT_MS,
      phase,
    },
    processRunner,
  );
  failIf(result.status !== "success", "git-check");
  return result.stdout;
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

function boundedProcessResult(result) {
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
  failIf(Buffer.byteLength(stdout) > COMMAND_OUTPUT_MAX_BYTES, "command-output-too-large");
  failIf(Buffer.byteLength(stderr) > COMMAND_OUTPUT_MAX_BYTES, "command-output-too-large");
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
    maxOutputBytes: COMMAND_OUTPUT_MAX_BYTES,
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
          maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
          stdio: childStdioWithKernelLock(["ignore", "pipe", "pipe"]),
        },
      );
      if (helper.status !== 0 || helper.error || typeof helper.stdout !== "string") {
        return { status: "ambiguous", exitCode: null, stdout: "", stderr: "" };
      }
      if (Buffer.byteLength(helper.stdout) > COMMAND_OUTPUT_MAX_BYTES) {
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
        maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  } catch {
    return { status: "ambiguous", exitCode: null, stdout: "", stderr: "" };
  }
  return boundedProcessResult(result);
}

function runCommand(config, command, args, options = {}) {
  const request = { cwd: config.workdir, env: config.childEnvironment, ...options };
  const execute = () => commandResult(command, args, request, config.processRunner);
  if (!cacheableCommand(command, args)) return execute();
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
  return testSnapshot(`terraform-cache:${config.workdir}`, () => {
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

function defaultAccount(config) {
  return testSnapshot(`azure-account:${config.workdir}`, () => {
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
    return {
      repositoryCommit: gitResult(config.repoRoot, ["rev-parse", "HEAD"], config.processRunner).trim(),
      lifecycleSha256: dependencies[0].sha256,
      guardSha256: dependencies[1].sha256,
      dependencyBlobs: dependencies.slice(1),
    };
  });
}

function defaultRemoteState(config) {
  return testSnapshot(`remote-state:${config.workdir}`, () => {
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
  return testSnapshot(`context:${config.workdir}:${request.phase}`, () => {
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
    };
  });
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
    preflight: path.join(runDirectory, "preflight-receipt.json"),
    apply: path.join(runDirectory, "apply-receipt.json"),
    reconcile: path.join(runDirectory, "reconcile-receipt.json"),
    terminal: path.join(runDirectory, "terminal-receipts.json"),
    diagnostic: path.join(runDirectory, "diagnostic-receipt.json"),
    cleanup: path.join(runDirectory, "cleanup-manifest.json"),
    absence: path.join(runDirectory, "cleanup-absence-receipt.json"),
  };
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
      failIf(!["terraform-exit-known", "terraform-exit-ambiguous"].includes(checkpoint.name), "checkpoint-replacement");
    }
    seen.add(checkpoint.name);
  }
  if (expected.phase !== undefined) validateCheckpointSequence(checkpoints, expected.phase);
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
      consume("reconcile");
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
  const existing = readCheckpoints(runDirectory, { runId, phase });
  failIf(
    existing.some((checkpoint) => checkpoint.name === name) &&
      !["terraform-exit-known", "terraform-exit-ambiguous"].includes(name),
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
  return /(?:mismatch|hash|integrity|symlink|mode|owner|noncanonical|replacement|context|receipt|artifact|checkpoint|state-history)/.test(code);
}

function assertStateForCreate(state, phase) {
  failIf(state.state !== STATE_FOR_PHASE[phase], "out-of-order-phase");
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

function withLock(config, callback) {
  ensureRoot(config);
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
  if (current === null && latest === undefined) return null;
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
  for (const entry of readdirSync(config.root, { withFileTypes: true })) {
    if (entry.name === "state.json" || STATE_FILE_RE.test(entry.name)) continue;
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
    if (!closedRun && names.has("preflight-receipt") && existsSync(artifacts.preflight)) {
      const checkpoint = checkpointNamed(checkpoints, "preflight-receipt");
      const preflight = readReceiptAtCheckpoint(artifacts.preflight, checkpoint, manifest, "preflight");
      validateRecoveryEvidenceArtifacts(run.phase, artifacts, checkpoint, manifest);
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
      const reconcileCheckpoint = checkpointNamed(checkpoints, "reconcile");
      const reconcile = readReceiptAtCheckpoint(
        artifacts.reconcile,
        reconcileCheckpoint,
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
      if (run.phase === "terminal") validateFinalTerminalEvidence(directory, advancement);
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

function validateFinalTerminalEvidence(runDirectory, advancement) {
  const artifacts = artifactPaths(runDirectory);
  const checkpoints = readCheckpoints(runDirectory, {
    runId: advancement.runId,
    phase: "terminal",
  });
  const manifest = immutableManifest(
    runDirectory,
    artifacts,
    checkpoints,
    { id: advancement.runId, phase: "terminal" },
  );
  assertCheckpointArtifact(artifacts.terminal, advancement, "terminalReceiptSha256", "terminal-receipt");
  failIf(!Array.isArray(advancement.receiptInventory), "terminal-receipt-inventory");
  const checkpointInventory = advancement.receiptInventory;
  failIf(
    checkpointInventory.length !== TERMINAL_RECEIPTS.length ||
      checkpointInventory.some((entry) => !isObject(entry) || !isSha(entry.sha256)),
    "terminal-receipt-inventory",
  );
  for (const entry of checkpointInventory) {
    assertKnownKeys(entry, ["label", "sha256"], "terminal-receipt-inventory");
    assertRequiredKeys(entry, ["label", "sha256"], "terminal-receipt-inventory");
  }
  const expectedLabels = TERMINAL_RECEIPTS.map(([, filename]) => filename).sort();
  const checkpointLabels = checkpointInventory.map((entry) => entry.label).sort();
  failIf(!same(expectedLabels, checkpointLabels), "terminal-receipt-inventory");
  for (const entry of checkpointInventory) {
    try {
      assertCheckpointArtifact(
        path.join(runDirectory, entry.label),
        { receiptSha256: entry.sha256 },
        "receiptSha256",
        "terminal-receipt",
      );
    } catch (error) {
      if (error instanceof LifecycleError && error.code.startsWith("terminal-receipt-")) {
        reject("terminal-receipt-set");
      }
      throw error;
    }
  }
  const terminal = readJson(artifacts.terminal, "terminal-receipts");
  assertReceiptMatches(terminal, manifest, "terminal");
  assertKnownKeys(terminal, [
    "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
    "result", "receiptInventory", "receiptSetSha256",
  ], "terminal-receipt-schema");
  assertRequiredKeys(terminal, [
    "version", "type", "runId", "phase", "planSha256", "bindingSha256", "createdAt",
    "result", "receiptInventory", "receiptSetSha256",
  ], "terminal-receipt-schema");
  failIf(terminal.version !== 1 || terminal.result !== "verified", "terminal-receipt-schema");
  requiredDiagnostic({ manifest, artifacts });
  requiredCleanup({ manifest, artifacts });
  const live = assertExactReceipt(
    path.join(runDirectory, "terminal-live-receipt.json"),
    "live-receipt",
    manifest,
    { type: "live", status: "passed", operation: "terminal-live" },
  );
  assertKnownKeys(live.value, [
    "version", "type", "status", "operation", "runId", "phase", "planSha256", "bindingSha256",
    "createdAt", "repositoryCommit", "contextSha256", "sha256",
  ], "live-receipt-schema");
  const inventory = TERMINAL_RECEIPTS
    .map(([, filename]) => ({
      label: filename,
      sha256: sha256File(path.join(runDirectory, filename), JSON_MAX_BYTES),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  failIf(!same(terminal.receiptInventory, inventory), "terminal-receipt-inventory");
  failIf(!same(advancement.receiptInventory, inventory), "terminal-receipt-inventory");
  failIf(
    !isSha(terminal.receiptSetSha256) ||
      !isSha(advancement.receiptSetSha256) ||
      terminal.receiptSetSha256 !== advancement.receiptSetSha256,
    "terminal-receipt-set",
  );
  failIf(hashJson(inventory) !== terminal.receiptSetSha256, "terminal-receipt-set");
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

function defaultShowExecutor(request) {
  failIf(terraformExecutableSha256() !== TERRAFORM_SHA256, "terraform-hash");
  return commandResult(TERRAFORM_PATH, exactShowArgv(request.planPath), {
    cwd: request.cwd,
    env: request.env,
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

function defaultOutputs(config) {
  return testSnapshot(`terraform-outputs:${config.workdir}`, () => {
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
    return {
      resourceGroup,
      region: get("region"),
      accountId: get("foundry_account_id"),
      account: accountParts.account,
      foundryResourceGroup: accountParts.resourceGroup,
      foundryEndpoint: get("foundry_endpoint", false),
      relayContainerApp: get("relay_container_app_name", false),
      relayRevision: get("relay_latest_revision_name", false),
      relayContainerAppId: get("relay_container_app_id", false),
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
  });
}

function azJson(config, args, code) {
  return parseCommandJson(runCommand(config, AZ_PATH, args), code);
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
  const match = /^([^\.]+)\.([^\.]+)\.(.+)$/.exec(item.name.value);
  failIf(!match, "model-quota");
  failIf(
    item.name.localizedValue !==
      `${MODEL_BOOTSTRAP_CONTRACT.quotaLocalizedPrefix}${match[3]} - ${match[2]}`,
    "model-quota",
  );
  return {
    provider: match[1],
    sku: match[2],
    modelName: match[3],
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
  const exact = descriptors.filter(
    (descriptor) =>
      descriptor.provider === "OpenAI" &&
      descriptor.sku === MODEL_BOOTSTRAP_CONTRACT.sku &&
      descriptor.modelName === MODEL_BOOTSTRAP_CONTRACT.lunaDeployment,
  );
  failIf(exact.length > 1, "quota-duplicate");
  failIf(exact.length !== 1, "quota-unreleased");
  const selected = exact[0];
  failIf(selected.available < MODEL_BOOTSTRAP_CONTRACT.lunaCapacity, "quota-unreleased");
  failIf(
    catalogReceipt.modelName !== selected.modelName ||
      catalogReceipt.sku !== selected.sku,
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
    provider: quota.provider,
    sku: quota.sku,
    modelName: quota.modelName,
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

function requiredDiagnostic(request) {
  const manifest = request.manifest;
  failIf(!manifest, "diagnostic-receipt-context");
  const checked = assertExactReceipt(request.artifacts.diagnostic, "diagnostic-receipt", manifest, {
    type: "diagnostic",
    status: "passed",
    operation: "runtime-cutover-diagnostic",
    imageDigest: RUNTIME_RELAY_IMAGE,
    digestCount: 1,
  });
  const value = checked.value;
  assertKnownKeys(value, [
    "version", "type", "status", "operation", "runId", "phase", "planSha256", "bindingSha256",
    "createdAt", "repositoryCommit", "contextSha256", "imageDigest", "digestCount", "execution",
    "runtimeSecretReferences", "sha256",
  ], "diagnostic-receipt-schema");
  assertKnownKeys(value.execution, ["baseline", "result", "retryCount"], "diagnostic-receipt-schema");
  assertRequiredKeys(value.execution, ["baseline", "result", "retryCount"], "diagnostic-receipt-schema");
  failIf(
    value.execution.baseline !== "pre-cutover" ||
      value.execution.result !== "passed" ||
      value.execution.retryCount !== 0,
    "diagnostic-receipt-execution",
  );
  failIf(!Array.isArray(value.runtimeSecretReferences) || value.runtimeSecretReferences.length !== 0, "diagnostic-receipt-secret");
  failIf(
    Object.keys(value).some((key) => key !== "runtimeSecretReferences" && /token|password|api.?key/i.test(key)),
    "diagnostic-receipt-secret",
  );
  return checked;
}

function requiredCleanup(request) {
  const manifest = request.manifest;
  failIf(!manifest, "cleanup-context");
  const cleanup = assertExactReceipt(request.artifacts.cleanup, "cleanup-manifest", manifest, {
    type: "cleanup",
    status: "completed",
    operation: "credential-cleanup",
  });
  const absence = assertExactReceipt(request.artifacts.absence, "cleanup-absence", manifest, {
    type: "absence",
    status: "absent",
    operation: "credential-cleanup",
  });
  assertKnownKeys(cleanup.value, [
    "version", "type", "status", "operation", "runId", "phase", "planSha256", "bindingSha256",
    "createdAt", "repositoryCommit", "contextSha256", "runtimeSecretReferences", "sha256",
  ], "cleanup-manifest-schema");
  assertKnownKeys(absence.value, [
    "version", "type", "status", "operation", "runId", "phase", "planSha256", "bindingSha256",
    "createdAt", "repositoryCommit", "contextSha256", "inventory", "sha256",
  ], "cleanup-absence-schema");
  failIf(!Array.isArray(cleanup.value.runtimeSecretReferences) || cleanup.value.runtimeSecretReferences.length !== 0, "cleanup-context");
  assertKnownKeys(absence.value.inventory, ["keyVault", "runtimeSecretReferences"], "cleanup-absence-schema");
  assertRequiredKeys(absence.value.inventory, ["keyVault", "runtimeSecretReferences"], "cleanup-absence-schema");
  failIf(
    absence.value.inventory.keyVault !== "absent" ||
      absence.value.inventory.runtimeSecretReferences !== 0,
    "cleanup-absence-context",
  );
  return { cleanup, absence };
}

function validateRecoveryEvidenceArtifacts(phase, artifacts, checkpoint, manifest) {
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
    failIf(
      !isSha(checkpoint.cleanupManifestSha256) || !isSha(checkpoint.absenceReceiptSha256),
      "cleanup-receipt-checkpoint",
    );
    assertCheckpointArtifact(
      artifacts.cleanup,
      checkpoint,
      "cleanupManifestSha256",
      "cleanup-manifest",
    );
    assertCheckpointArtifact(
      artifacts.absence,
      checkpoint,
      "absenceReceiptSha256",
      "cleanup-absence",
    );
    requiredCleanup({ manifest, artifacts });
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

function identityKey(value) {
  failIf(typeof value !== "string" || !value.startsWith("/subscriptions/"), "runtime-identity");
  return value.toLowerCase();
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

function assertContainerAppResponse(value, outputs, code) {
  assertKnownKeys(value, ["id", "name", "location", "type", "identity", "properties", "tags", "systemData", "kind", "managedBy", "sku"], code);
  assertRequiredKeys(value, ["id", "name", "location", "type", "identity", "properties"], code);
  failIf(value.name !== outputs.relayContainerApp || value.location !== outputs.region, code);
  failIf(value.type !== "Microsoft.App/containerApps", code);
  failIf(
    typeof value.id !== "string" ||
      value.id !== outputs.relayContainerAppId ||
      !value.id.startsWith(`/subscriptions/${outputs.accountId ? outputs.accountId.split("/")[2] : ""}/resourceGroups/${outputs.resourceGroup}/providers/Microsoft.App/containerApps/`),
    code,
  );
  const properties = value.properties;
  assertKnownKeys(properties, [
    "managedEnvironmentId", "provisioningState", "runningStatus", "latestRevisionName",
    "latestReadyRevisionName", "configuration", "template", "eventStreamEndpoint",
    "outboundIpAddresses", "customDomainVerificationId", "workloadProfileName",
    "workloadProfileType", "delegatedSubnetId", "environmentId",
  ], code);
  assertRequiredKeys(properties, ["configuration", "template", "provisioningState", "runningStatus"], code);
  failIf(properties.provisioningState !== "Succeeded" || properties.runningStatus !== "Running", code);
  const configuration = properties.configuration;
  assertKnownKeys(configuration, ["activeRevisionsMode", "ingress", "registries", "identitySettings", "secrets"], code);
  assertRequiredKeys(configuration, ["activeRevisionsMode", "ingress", "registries", "identitySettings", "secrets"], code);
  failIf(configuration.activeRevisionsMode !== "Single", code);
  const ingress = configuration.ingress;
  assertKnownKeys(ingress, ["external", "targetPort", "transport", "allowInsecure", "traffic"], code);
  assertRequiredKeys(ingress, ["external", "targetPort", "transport", "allowInsecure", "traffic"], code);
  failIf(ingress.external !== true || ingress.targetPort !== 8787 || ingress.transport !== "Http" || ingress.allowInsecure !== false, code);
  failIf(!Array.isArray(ingress.traffic) || ingress.traffic.length !== 1, code);
  ingress.traffic.forEach((traffic) => {
    assertKnownKeys(traffic, ["revisionName", "weight", "latestRevision"], code);
    assertRequiredKeys(traffic, ["revisionName", "weight"], code);
    failIf(typeof traffic.revisionName !== "string" || traffic.weight !== 100, code);
  });
  failIf(!Array.isArray(configuration.registries) || configuration.registries.length !== 1, code);
  const registry = configuration.registries[0];
  assertKnownKeys(registry, ["server", "identity", "username", "passwordSecretRef"], code);
  assertRequiredKeys(registry, ["server", "identity"], code);
  failIf(registry.server !== RUNTIME_RELAY_IMAGE.split("/")[0] || identityKey(registry.identity) !== identityKey(outputs.imagePullIdentityId), code);
  failIf(!Array.isArray(configuration.identitySettings) || configuration.identitySettings.length !== 2, code);
  const settings = configuration.identitySettings.map((setting) => {
    assertKnownKeys(setting, ["identity", "lifecycle"], code);
    assertRequiredKeys(setting, ["identity", "lifecycle"], code);
    failIf(typeof setting.identity !== "string", code);
    return { identity: identityKey(setting.identity), lifecycle: setting.lifecycle };
  });
  const settingMap = new Map(settings.map((setting) => [setting.identity, setting.lifecycle]));
  failIf(settingMap.get(identityKey(outputs.imagePullIdentityId)) !== "None", code);
  failIf(settingMap.get(identityKey(outputs.runtimeIdentityId)) !== "Main", code);
  failIf(
    settings[0].identity !== identityKey(outputs.imagePullIdentityId) ||
      settings[0].lifecycle !== "None" ||
      settings[1].identity !== identityKey(outputs.runtimeIdentityId) ||
      settings[1].lifecycle !== "Main",
    code,
  );
  const template = assertContainerTemplate(properties.template, code);
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
  return { value, properties, configuration, ingress, template, identity };
}

function assertSecretConfiguration(configuration, outputs, mode, code) {
  failIf(!Array.isArray(configuration.secrets), code);
  if (mode === "pre") {
    failIf(configuration.secrets.length !== 2, code);
    const expected = new Map([
      ["openrouter-api-key", "openrouter-api-key"],
      ["litellm-master-key", "litellm-master-key"],
    ]);
    const names = new Set();
    for (const secret of configuration.secrets) {
      assertKnownKeys(secret, ["name", "keyVaultUrl", "identity"], code);
      assertRequiredKeys(secret, ["name", "keyVaultUrl", "identity"], code);
      failIf(!expected.has(secret.name), code);
      failIf(names.has(secret.name), code);
      names.add(secret.name);
      const vaultUri = assertHttpsEndpoint(outputs.keyVaultUri, code);
      failIf(secret.keyVaultUrl !== `${vaultUri}/secrets/${expected.get(secret.name)}`, code);
      failIf(identityKey(secret.identity) !== identityKey(outputs.runtimeIdentityId), code);
    }
    failIf(names.size !== expected.size, code);
  } else {
    failIf(configuration.secrets.length !== 0, code);
  }
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

function assertPreCutoverTopology(app, outputs, expectedRevision) {
  assertSecretConfiguration(app.configuration, outputs, "pre", "runtime-topology");
  failIf(app.template.containers.length !== 2, "runtime-topology");
  const relay = app.template.containers.find((container) => container.name === "relay");
  const litellm = app.template.containers.find((container) => container.name === "litellm");
  failIf(!relay || !litellm || relay.image !== RUNTIME_RELAY_IMAGE || litellm.image !== RUNTIME_LITELLM_IMAGE, "runtime-topology");
  const relayEnv = environmentMap(relay, "runtime-topology");
  const litellmEnv = environmentMap(litellm, "runtime-topology");
  failIf(
    relayEnv.get("PALANCAR_GENERATION_PROVIDER")?.value !== "litellm" ||
      relayEnv.get("PALANCAR_LITELLM_BASE_URL")?.value !== RUNTIME_LITELLM_BASE_URL ||
      relayEnv.get("PALANCAR_LITELLM_MODEL")?.value !== RUNTIME_LITELLM_MODEL ||
      relayEnv.get("PALANCAR_LITELLM_API_KEY")?.secretRef !== "litellm-master-key" ||
      litellmEnv.get("PALANCAR_LITELLM_BACKEND")?.value !== "openrouter" ||
      litellmEnv.get("PALANCAR_LITELLM_UPSTREAM_MODEL")?.value !== RUNTIME_OPENROUTER_MODEL ||
      litellmEnv.get("LITELLM_MASTER_KEY")?.secretRef !== "litellm-master-key" ||
      litellmEnv.get("OPENROUTER_API_KEY")?.secretRef !== "openrouter-api-key",
    "runtime-topology",
  );
  failIf(app.ingress.traffic[0].revisionName !== expectedRevision, "runtime-revision");
  return { relay, litellm, imageDigest: relay.image, revisionName: expectedRevision };
}

function expectedRealtimeEndpoint(outputs, code) {
  const endpoint = assertHttpsEndpoint(outputs.foundryEndpoint, code);
  return `wss://${new URL(endpoint).hostname}/openai/v1/realtime?intent=transcription`;
}

function assertPostCutoverTopology(app, outputs, expectedRevision) {
  assertSecretConfiguration(app.configuration, outputs, "post", "credential-topology");
  failIf(app.template.containers.length !== 1 || app.template.containers[0].name !== "relay", "credential-topology");
  const relay = app.template.containers[0];
  failIf(relay.image !== RUNTIME_RELAY_IMAGE, "credential-topology");
  assertNoRetiredReferences(app, "credential-secret-reference");
  const env = environmentMap(relay, "credential-topology");
  failIf(
    env.get("PALANCAR_TRANSCRIPTION_PROVIDER")?.value !== "azure-realtime" ||
      env.get("PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT")?.value !== expectedRealtimeEndpoint(outputs, "credential-topology") ||
      env.get("PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT")?.value !== MODEL_BOOTSTRAP_CONTRACT.transcriptionDeployment,
    "credential-direct-azure",
  );
  for (const entry of env.values()) {
    failIf(/(?:LITELLM|OPENROUTER)/i.test(entry.name) || /(?:LITELLM|OPENROUTER)/i.test(entry.value ?? ""), "credential-topology");
  }
  failIf(app.ingress.traffic[0].revisionName !== expectedRevision, "credential-revision");
  return { relay, imageDigest: relay.image, revisionName: expectedRevision };
}

function assertRevisionResponse(value, app, expectedRevision, mode, code) {
  failIf(!Array.isArray(value) || value.length === 0, code);
  const revisions = value.map((revision) => {
    assertKnownKeys(revision, ["id", "name", "type", "properties", "location", "tags", "systemData"], code);
    assertRequiredKeys(revision, ["id", "name", "properties"], code);
    failIf(
      revision.type !== undefined && revision.type !== "Microsoft.App/containerApps/revisions",
      code,
    );
    failIf(typeof revision.id !== "string" || !revision.id.endsWith(`/revisions/${revision.name}`), code);
    const properties = revision.properties;
    assertKnownKeys(properties, ["active", "healthState", "provisioningState", "runningState", "trafficWeight", "template", "createdTime", "lastActiveTime", "replicaCount"], code);
    assertRequiredKeys(properties, ["active", "healthState", "provisioningState", "runningState", "trafficWeight", "template"], code);
    failIf(typeof revision.name !== "string" || typeof properties.active !== "boolean", code);
    failIf(properties.healthState !== "Healthy" || properties.provisioningState !== "Provisioned" || properties.runningState !== "Running", code);
    assertContainerTemplate(properties.template, code);
    return { revision, properties };
  });
  const active = revisions.filter(({ properties }) => properties.active === true);
  failIf(active.length !== 1, `${code}-active`);
  const selected = active[0];
  const selectedName = selected.revision.name;
  failIf(expectedRevision !== undefined && selectedName !== expectedRevision, `${code}-traffic`);
  failIf(selected.properties.trafficWeight !== 100, `${code}-traffic`);
  failIf(app.ingress.traffic.length !== 1 || app.ingress.traffic[0].revisionName !== selectedName || app.ingress.traffic[0].weight !== 100, `${code}-traffic`);
  const appContainers = app.template.containers.map((container) => ({
    name: container.name,
    image: container.image,
    env: container.env,
  }));
  const revisionContainers = selected.properties.template.containers.map((container) => ({
    name: container.name,
    image: container.image,
    env: container.env,
  }));
  failIf(!same(appContainers, revisionContainers), `${code}-template`);
  const topology = mode === "pre"
    ? assertPreCutoverTopology(app, { ...app.outputs }, selectedName)
    : assertPostCutoverTopology(app, { ...app.outputs }, selectedName);
  return { revisions, selected, topology, revisionName: selectedName };
}

function parseContainerAppAndRevisions(config, outputs, request, mode) {
  const appResponse = azJson(config, [
    "containerapp", "show", "--name", outputs.relayContainerApp,
    "--resource-group", outputs.resourceGroup,
    "--subscription", config.account.subscription,
    "--output", "json",
  ], "containerapp-show");
  const app = assertContainerAppResponse(appResponse, outputs, mode === "pre" ? "runtime-containerapp" : "credential-containerapp");
  app.outputs = outputs;
  const expectedRevision = request.allowRevisionChange
    ? undefined
    : request.expectedRevision ?? request.manifest.bindings.liveRevision;
  if (expectedRevision !== undefined) {
    failIf(typeof expectedRevision !== "string" || expectedRevision.length === 0, `${mode === "pre" ? "runtime" : "credential"}-revision`);
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
    expectedRevision,
    mode,
    mode === "pre" ? "runtime-revisions" : "credential-revisions",
  );
  return { appResponse, revisionResponse, app, revision };
}

function parseAccessToken(result, config) {
  const tokenResponse = parseCommandJson(result, "entra-token");
  assertKnownKeys(tokenResponse, ["accessToken", "expiresOn", "subscription", "tenant", "tokenType"], "entra-token");
  assertRequiredKeys(tokenResponse, ["accessToken", "expiresOn", "subscription", "tenant"], "entra-token");
  failIf(
      typeof tokenResponse.accessToken !== "string" || tokenResponse.accessToken.length < 20 ||
      typeof tokenResponse.expiresOn !== "string" || tokenResponse.subscription === undefined ||
      typeof tokenResponse.tenant !== "string" ||
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

function parseRoleAssignments(value, expected, code) {
  failIf(!Array.isArray(value), code);
  return value.map((assignment) => {
    assertKnownKeys(assignment, [
      "id", "name", "principalId", "principalType", "roleDefinitionId", "scope",
      "condition", "conditionVersion", "description", "createdOn", "updatedOn",
    ], code);
    assertRequiredKeys(assignment, ["id", "principalId", "principalType", "roleDefinitionId", "scope"], code);
    failIf(
      typeof assignment.id !== "string" ||
        assignment.principalId !== expected.principalId ||
        assignment.principalType !== "ServicePrincipal" ||
        assignment.roleDefinitionId.toLowerCase() !== expected.roleDefinitionId.toLowerCase() ||
        assignment.scope.toLowerCase() !== expected.scope.toLowerCase(),
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
    "--all",
    "--output", "json",
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
  const identityId = Object.keys(app.identity.userAssignedIdentities)
    .find((id) => identityKey(id) === identityKey(outputs.runtimeIdentityId));
  failIf(!identityId, code);
  return app.identity.userAssignedIdentities[identityId].principalId;
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
  return parseContainerAppAndRevisions(config, outputs, {
    ...request,
    allowRevisionChange: false,
    expectedRevision: request.manifest.bindings.liveRevision,
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
  const live = parseContainerAppAndRevisions(config, outputs, request, mode);
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
    ["imagePullIdentityId", "image-pull-identity"],
    ["foundryEndpoint", "foundry-endpoint"],
  ]) {
    failIf(typeof outputs[key] !== "string" || outputs[key].length === 0, code);
  }
}

function defaultMetadataCheck(config) {
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
    failIf(live.revision.topology.imageDigest !== diagnostic.value.imageDigest, "diagnostic-image-linkage");
    evidence = {
      diagnosticSha256: diagnostic.fileSha256,
      containerAppSha256: hashJson(live.appResponse),
      revisionsSha256: hashJson(live.revisionResponse),
    };
  } else if (request.phase === "credential-cleanup") {
    requireRuntimeOutputs(outputs);
    const cleanup = requiredCleanup(request);
    const live = liveReadOnlyChecks(providerConfig, outputs, request, "post");
    const absence = verifyKeyVaultAbsence(providerConfig, outputs);
    evidence = {
      cleanupSha256: cleanup.cleanup.fileSha256,
      absenceSha256: cleanup.absence.fileSha256,
      keyVault: absence.status,
      containerAppSha256: hashJson(live.appResponse),
      revisionsSha256: hashJson(live.revisionResponse),
    };
  } else {
    reject("invalid-phase");
  }
  return { status: "success", verifierSha256: hashJson(evidence) };
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
    requiredCleanup(request);
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
  const inventory = [];
  evidence.diagnostic = requiredDiagnostic(request);
  evidence.cleanup = requiredCleanup(request);
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
  for (const [, filename] of TERMINAL_RECEIPTS) {
    const filePath = path.join(request.runDirectory, filename);
    inventory.push({ label: filename, sha256: sha256File(filePath, JSON_MAX_BYTES) });
  }
  const outputs = defaultOutputs(providerConfig);
  requireRuntimeOutputs(outputs);
  const live = liveReadOnlyChecks(providerConfig, outputs, {
    ...request,
    expectedRevision: outputs.relayRevision,
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
  inventory.sort((left, right) => left.label.localeCompare(right.label));
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
  const evidence = requiredCleanup({ ...request, artifacts: request.artifacts });
  const outputs = defaultOutputs(providerConfig);
  requireRuntimeOutputs(outputs);
  const live = liveReadOnlyChecks(providerConfig, outputs, request, "post");
  const keyVault = verifyKeyVaultAbsence(providerConfig, outputs);
  return {
    status: "success",
    evidenceSha256: hashJson({
      cleanup: evidence.cleanup.fileSha256,
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

  function operationContext(phase, operation, run, planPath, argv, env) {
    const expected = {
      phase,
      planSha256: run?.manifest?.planSha256,
      cwd: config.workdir,
      argv,
    };
    const raw = defaultContext(
      { ...config, childEnvironment: env },
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
        !Array.isArray(manifest.argv),
      "manifest-mismatch",
    );
    assertRegular(run.artifacts.plan, ARTIFACT_MODE, "plan");
    failIf(sha256File(run.artifacts.plan) !== manifest.planSha256, "plan-hash");
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
        writeCheckpoint(config, directory, runId, run.phase, "invalidated", { reason });
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
      assertStateForCreate(state, phase);
      checkWorktreeIfInjected(phase);
      checkInheritedEnvironment(config.inheritedEnvironment);
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
      const manifestArgv = config.processRunner === undefined ? exactCreateArgv(artifacts.planTemp) : planArgv;
      const planStartedAt = nowIso(config.now);
      writeCheckpoint(config, runDirectory, runId, phase, "plan-started", {
        argv: manifestArgv,
        createdAt: planStartedAt,
      });
      updateRun(state, runId, { lastCheckpoint: "plan-started" });
      const beforePlan = defaultContext(
        { ...config, childEnvironment: env },
        { phase, operation: "create", planPath: artifacts.plan, argv: manifestArgv, env },
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
      );
      failIf(
        beforePlan.stateLineage !== context.stateLineage ||
          beforePlan.stateSerial !== context.stateSerial,
        "binding-mismatch",
      );
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
            handleRunFailure(requireState(config), operationRunId, error);
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
        const manifest = readManifest(run);
        env = buildChildEnvironment(run.runDirectory, config.inheritedEnvironment);
        revalidate(run, "guard", manifest, env);
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
        try {
          JSON.parse(input);
        } catch {
          reject("terraform-show-json");
        }
        exclusiveText(run.artifacts.show, input, "show-json");
        writeCheckpoint(config, run.runDirectory, runId, phase, "show-json", {
          showSha256: sha256Bytes(input),
        });
        updateRun(state, runId, { lastCheckpoint: "show-json" });
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
        updateRun(state, runId, { status: "guarded", guardedAt: nowIso(config.now), lastCheckpoint: "guard-receipt" });
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
        const bindings = revalidate(run, "preflight", manifest, env);
        const verified = defaultPreflightVerifier(config, {
          operation: "preflight",
          phase,
          runId,
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
          const cleanup = requiredCleanup({ manifest, artifacts: run.artifacts });
          evidence = {
            cleanupManifestSha256: cleanup.cleanup.fileSha256,
            absenceReceiptSha256: cleanup.absence.fileSha256,
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
        validateRecoveryEvidenceArtifacts(phase, run.artifacts, preflightCheckpoint, manifest);
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
        readReceiptAtCheckpoint(
          run.artifacts.reconcile,
          checkpointNamed(checkpoints, "reconcile"),
          manifest,
          "reconcile",
          ["applied", "invalidated", "unknown"],
        );
      }
      const inspected = defaultLiveInspector(config, {
        operation: "reconcile",
        phase,
        runId,
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
        exclusiveJson(run.artifacts.reconcile, receipt, "reconcile-receipt");
        writeCheckpoint(config, run.runDirectory, runId, phase, "reconcile", {
          receiptSha256: sha256File(run.artifacts.reconcile),
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
        exclusiveJson(run.artifacts.reconcile, receipt, "reconcile-receipt");
        writeCheckpoint(config, run.runDirectory, runId, phase, "reconcile", {
          receiptSha256: sha256File(run.artifacts.reconcile),
          outcome,
          status: receipt.status,
        });
        updateRun(state, runId, { status: "invalidated", invalidatedAt: receipt.reconciledAt, lastCheckpoint: "reconcile" });
        saveState(config, state);
        return { runId, phase, status: "invalidated" };
      }
      if (!existsSync(run.artifacts.reconcile)) {
        const receipt = {
          ...receiptFor("reconcile", manifest, { status: "unknown" }),
          reconciledAt: nowIso(config.now),
        };
        ensureReceiptSize(receipt);
        exclusiveJson(run.artifacts.reconcile, receipt, "reconcile-receipt");
        writeCheckpoint(config, run.runDirectory, runId, phase, "reconcile", {
          receiptSha256: sha256File(run.artifacts.reconcile),
          outcome,
          status: receipt.status,
        });
        updateRun(state, runId, { lastCheckpoint: "reconcile" });
      } else {
        assertRegular(run.artifacts.reconcile, ARTIFACT_MODE, "reconcile-receipt");
      }
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
      const cleanup = readJson(old.artifacts.cleanup, "cleanup-manifest");
      const absence = readJson(old.artifacts.absence, "cleanup-absence");
      failIf(cleanup.runId !== oldRunId || absence.runId !== oldRunId, "cleanup-context");
      failIf(!isSha(cleanup.sha256) || !isSha(absence.sha256), "cleanup-context");
      failIf(
        cleanup.planSha256 !== oldManifest.planSha256 ||
          cleanup.bindingSha256 !== oldManifest.bindingSha256 ||
          absence.planSha256 !== oldManifest.planSha256 ||
          absence.bindingSha256 !== oldManifest.bindingSha256,
        "cleanup-context",
      );
      const cleanupArtifactSha256 = sha256File(old.artifacts.cleanup, JSON_MAX_BYTES);
      const absenceArtifactSha256 = sha256File(old.artifacts.absence, JSON_MAX_BYTES);
      const valid = defaultCleanupValidator(config, {
        phase,
        runId: oldRunId,
        manifest: oldManifest,
        cleanup,
        absence,
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
    assertStateForCreate(state, phase);
    checkInheritedEnvironment(config.inheritedEnvironment);
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
    const manifestArgv = config.processRunner === undefined ? exactCreateArgv(artifacts.planTemp) : planArgv;
    const planStartedAt = nowIso(config.now);
    writeCheckpoint(config, runDirectory, runId, phase, "plan-started", {
      argv: manifestArgv,
      createdAt: planStartedAt,
      });
      updateRun(state, runId, { lastCheckpoint: "plan-started" });
    const beforePlan = defaultContext(
      { ...config, childEnvironment: env },
      { phase, operation: "create", planPath: artifacts.plan, argv: manifestArgv, env },
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
    );
    failIf(
      beforePlan.stateLineage !== context.stateLineage ||
        beforePlan.stateSerial !== context.stateSerial,
      "binding-mismatch",
    );
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
        manifest,
        bindings,
        env,
        cwd: config.workdir,
        artifacts: run.artifacts,
        runDirectory: run.runDirectory,
      });
      failIf(parseStatus(terminal) !== "success", "terminal-receipts");
      failIf(!isObject(terminal) || !isSha(terminal.receiptSetSha256), "terminal-receipt-set");
      const expectedInventory = TERMINAL_RECEIPTS
        .map(([, filename]) => ({
          label: filename,
          sha256: sha256File(path.join(run.runDirectory, filename), JSON_MAX_BYTES),
        }))
        .sort((left, right) => left.label.localeCompare(right.label));
      failIf(!same(terminal.receiptInventory, expectedInventory), "terminal-receipt-inventory");
      failIf(hashJson(expectedInventory) !== terminal.receiptSetSha256, "terminal-receipt-set");
      const receipt = receiptFor("terminal", manifest, {
        result: "verified",
        receiptInventory: expectedInventory,
        receiptSetSha256: terminal.receiptSetSha256,
      });
      ensureReceiptSize(receipt);
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

  function execute(parsed) {
    failIf(!parsed, "usage");
    switch (parsed.operation) {
      case "init":
        return init();
      case "create":
        return create(parsed.phase);
      case "guard":
        return guard(parsed.phase, parsed.runId);
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
      default:
        reject("usage");
    }
  }

  return Object.freeze({
    config: Object.freeze({ ...config }),
    init,
    create,
    guard,
    preflight,
    apply,
    reconcile,
    supersede,
    finalize,
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
