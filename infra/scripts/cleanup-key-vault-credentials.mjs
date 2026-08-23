#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "../..");
const WORKING_DIRECTORY = path.join(REPOSITORY_ROOT, "infra/environments/dev");
const UID = typeof process.getuid === "function" ? process.getuid() : undefined;

export const EVIDENCE_ROOT =
  "/home/dev/.local/state/palancar/azure-foundry-entra-cutover";
export const AZ_PATH = "/usr/bin/az";
export const TERRAFORM_PATH = "/home/dev/.local/bin/terraform-1.15.8";
export const TERRAFORM_SHA256 =
  "00f55981f5215594c418cd6b20f44fa4c99f9126650602e65d533d131005ea81";
const GIT_PATH = "/usr/bin/git";
// Must equal dev-plan-lifecycle.mjs REVIEWED_DEPENDENCIES["credential-cleanup"]
// minus its leading dev-plan-lifecycle.mjs entry (bound via lifecycleSha256):
// the lifecycle manifest's dependencyBlobs is that slice, in order.
const LIVE_DEPENDENCY_PATHS = Object.freeze([
  "infra/scripts/verify-acr-image-platform.mjs",
  "infra/scripts/assert-dev-plan.mjs",
  "infra/scripts/fixtures/luna-model-bootstrap.plan-fixture.json",
  "infra/scripts/fixtures/azure-generation-cutover.plan-fixture.json",
  "infra/scripts/fixtures/azure-credential-cleanup.plan-fixture.json",
  "infra/scripts/fixtures/final-rollout-transition.plan-fixture.json",
]);
export const BACKEND_SHA256 =
  "171c599d84b399299b6bed79a730396ff9500df2f43c906f193db647d194fb22";
export const TARGET_SECRET_NAMES = Object.freeze([
  "openrouter-api-key",
  "litellm-master-key",
]);
export const DESCRIPTOR_FILENAME = "vault-descriptor.json";
export const OPERATION_MANIFEST_FILENAME = "cleanup-manifest.json";
export const OPERATION_MANIFEST_VERSION_FILENAME_RE = /^cleanup-manifest-(\d{6})\.json$/u;
export const ABSENCE_RECEIPT_FILENAME = "cleanup-absence-receipt.json";
export const STATE_ANCHOR_FILENAME = "cleanup-state-anchor.json";
export const STATE_FILENAME_RE = /^cleanup-state-(\d{6})\.json$/u;
const STATE_ANCHOR_SEQUENCE_RE = /^cleanup-state-anchor-(\d{6})\.json$/u;
const JOURNAL_HEAD_SEQUENCE_RE = /^cleanup-journal-head-(\d{6})\.json$/u;
const OPERATION_HEAD_ANCHOR_SEQUENCE_RE = /^cleanup-operation-head-(\d{6})\.json$/u;
const OPERATION_HEAD_INTENT_SEQUENCE_RE = /^cleanup-operation-head-intent-(\d{6})\.json$/u;
export const MUTATION_INTENT_FILENAME_RE = /^cleanup-mutation-intent-(\d{6})\.json$/u;
const MUTATION_COMMITMENT_FILENAME_RE = /^cleanup-mutation-commitment-(\d{6})\.json$/u;
export const JOURNAL_COMMITMENT_DIRECTORY_NAME = ".cleanup-journal-commitments";
export const JOURNAL_COMMITMENT_FILENAME_RE = /^cleanup-journal-commitment-(\d{6})\.json$/u;

export const TOKEN_TIMEOUT_MS = 15_000;
export const HTTP_TIMEOUT_MS = 15_000;
export const INVOCATION_DEADLINE_MS = 180_000;
export const MUTATION_ATTEMPT_LIMIT = 3;
export const CUMULATIVE_ELAPSED_LIMIT_MS = 15 * 60 * 1000;
export const RETRY_BACKOFF_MS = 5_000;
export const CONVERGENCE_POLL_MS = 5_000;
export const AZURE_VAULT_API_VERSION = "7.4";
export const AZURE_MANAGEMENT_API_VERSION = "2023-07-01";
export const AZURE_MANAGEMENT_RESOURCE = "https://management.azure.com/";
export const AZURE_VAULT_RESOURCE = "https://vault.azure.net";
export const AZURE_KEY_VAULT_SERVICE_APPLICATION_ID =
  "cfa8b339-82a2-471a-a3c9-0fc0be7a4093";
export const AZURE_CLOUD_DESCRIPTORS = Object.freeze({
  AzureCloud: Object.freeze({
    keyVaultResource: AZURE_VAULT_RESOURCE,
    keyVaultServiceApplicationId: AZURE_KEY_VAULT_SERVICE_APPLICATION_ID,
    keyVaultAudiences: Object.freeze([
      AZURE_VAULT_RESOURCE,
      AZURE_KEY_VAULT_SERVICE_APPLICATION_ID,
    ]),
    keyVaultDnsSuffix: "vault.azure.net",
  }),
});
export const OUTER_SIGNAL_GRACE_MS = 1_000;
export const PREFLIGHT_RECEIPT_FILENAME = "preflight-receipt.json";
export const PREFLIGHT_VERIFIER_ID = "palancar.azure-key-vault-cleanup.runtime-preflight.v1";
export const PREFLIGHT_VERIFIER_ARTIFACT = "infra/scripts/cleanup-key-vault-credentials.mjs";
export const PREFLIGHT_MAX_AGE_MS = 2 * 60 * 1000;

const ARTIFACT_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACR_LOGIN_SERVER_RE = /^[a-z0-9]{5,50}\.azurecr\.io$/u;
const ACCOUNT_ID_RE = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.CognitiveServices\/accounts\/([^/?#]+)$/u;
const RUNTIME_IDENTITY_ID_RE = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[^/]+$/u;
const IMAGE_REFERENCE_RE = /^([a-z0-9]{5,50}\.azurecr\.io)\/(palancar-relay|palancar-expiry-cleanup)@(sha256:[a-f0-9]{64})$/u;
const SECRET_NAME_RE = /^[A-Za-z0-9-]{1,127}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const STATES = Object.freeze(["start-inventory-validated", "attempting", "unknown", "complete"]);
const ACCEPTED_DELETE_STATUS = new Set([200, 202, 204]);
const MAX_HTTP_BODY_BYTES = 256 * 1024;
// Must exceed the live Terraform state (already ~194 KiB and growing with
// each relay revision); matches the lifecycle's 8 MiB bounded-JSON reads.
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_INVENTORY_PAGES = 64;
const MAX_INVENTORY_ITEMS = 4096;
const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;
const INTERNAL_LOCKED_MARKER = "--__palancar-cleanup-locked-b1b";
const TEST_LOCKS = new Set();
const PRODUCTION_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  AZURE_CONFIG_DIR: "/home/dev/.azure",
  // Shared with dev-plan-lifecycle.mjs LIFECYCLE_CACHE_ROOT: without
  // XDG_CACHE_HOME the Azure CLI's deviceid cache resolves HOME to the
  // literal string "None" and lands inside the Terraform workdir, which
  // this utility then rejects as a dirty worktree.
  XDG_CACHE_HOME: "/home/dev/.local/state/palancar/azure-foundry-entra-cutover-cache",
});

const DESCRIPTOR_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "planSha256", "bindingSha256",
  "contextSha256", "vaultResourceId", "vaultUri", "subscription", "tenant",
  "cloud", "callerIdentity", "targetNames", "startState",
]);
const DESCRIPTOR_SUPERSESSION_KEYS = Object.freeze([
  ...DESCRIPTOR_KEYS,
  "supersession",
]);
const CREATE_KEYS = Object.freeze([
  "version", "runId", "phase", "createdAt", "processExit", "planSha256",
  "argv", "bindings", "bindingSha256",
]);
const CREATE_SUPERSESSION_KEYS = Object.freeze([...CREATE_KEYS, "supersession"]);
const BINDING_KEYS = Object.freeze([
  "planSha256", "terraformSha256", "lifecycleSha256", "guardSha256",
  "dependencyBlobs", "repositoryCommit", "cwd", "phase", "argv", "backend",
  "backendSha256", "backendConfigurationSha256", "workspace", "stateLineage",
  "stateSerial", "liveRevision", "runtimeIdentityId", "runtimeIdentityClientId",
  "runtimeIdentityPrincipalId", "accountId", "runtimeOpenAiRoleAssignmentId",
  "azureContextHash", "callerHash", "guard", "acrLoginServer", "imagePlatforms",
]);
const IMAGE_DESCRIPTOR_KEYS = Object.freeze([
  "version", "reference", "repository", "manifestDigest", "manifestMediaType",
  "configDigest", "configMediaType", "os", "architecture", "variant",
]);
const IMAGE_MANIFEST_MEDIA_TYPES = Object.freeze({
  "application/vnd.oci.image.manifest.v1+json": "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json": "application/vnd.docker.container.image.v1+json",
});
const DEPENDENCY_KEYS = Object.freeze(["path", "blob", "sha256"]);
const BACKEND_KEYS = Object.freeze([
  "container_name", "key", "resource_group_name", "storage_account_name",
  "subscription_id", "tenant_id", "type", "use_azuread_auth", "use_cli",
]);
const GUARD_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "planSha256", "bindingSha256",
  "createdAt", "guard", "showSha256", "guardArgv", "stdinSha256", "result",
]);
const PREFLIGHT_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "planSha256", "bindingSha256", "contextSha256",
  "createdAt", "deadlineAt", "result", "verifierId", "verifierArtifact", "verifierSha256", "runtimeIdentity",
  "vaultResourceId", "vaultUri", "targetNames", "receiptSha256",
]);
const OPERATION_KEYS = Object.freeze([
  "version", "type", "status", "operation", "runId", "phase", "planSha256",
  "bindingSha256", "createdAt", "repositoryCommit", "contextSha256",
  "runtimeSecretReferences", "utilitySha256", "vaultResourceId", "supersession", "sha256",
  "journalCommitmentPath", "sequence", "previousManifestSha256",
]);
const OPERATION_HEAD_KEYS = Object.freeze([
  ...OPERATION_KEYS, "manifestFilename", "manifestSha256", "previousHeadSha256", "headSha256",
]);
const OPERATION_HEAD_ANCHOR_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "sequence", "manifestSha256", "headSha256",
  "previousAnchorSha256", "intentSha256", "anchorSha256",
]);
const OPERATION_HEAD_INTENT_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "sequence", "manifestSha256", "previousHeadSha256",
  "previousAnchorSha256", "intentSha256",
]);
const STATE_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "sequence", "status", "attempts",
  "cumulativeElapsedMs", "attemptStartedAt", "operationStartedAt",
  "accountingCursor", "retryNotBefore", "absenceReceiptSha256",
  "manifestSha256", "inventory", "inventorySha256", "previousStateSha256", "stateSha256",
  "mutationTailSequence", "mutationTailSha256",
  "preflightReceiptSha256", "preflightVerifierId", "preflightVerifierSha256",
]);
const STATE_ANCHOR_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "stateSequence", "stateSha256",
  "stateFileSha256", "manifestSha256", "anchorSha256",
  "absenceReceiptSha256",
  "mutationTailSequence", "mutationTailSha256",
  "preflightReceiptSha256", "preflightVerifierId", "preflightVerifierSha256",
]);
const JOURNAL_HEAD_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "stateSequence", "stateSha256",
  "stateFileSha256", "manifestSha256", "previousHeadSha256", "headSha256",
  "absenceReceiptSha256",
  "mutationTailSequence", "mutationTailSha256",
  "preflightReceiptSha256", "preflightVerifierId", "preflightVerifierSha256",
]);
const JOURNAL_COMMITMENT_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "latestSequence", "stateSha256",
  "stateFileSha256", "anchorSha256", "headSha256", "manifestSha256",
  "absenceReceiptSha256",
  "mutationTailSequence", "mutationTailSha256",
  "previousCommitmentSha256", "commitmentSha256",
  "preflightReceiptSha256", "preflightVerifierId", "preflightVerifierSha256",
]);
const MUTATION_INTENT_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "sequence", "target", "action",
  "contextSha256", "stateSequence", "stateSha256", "journalCommitmentSha256",
  "preflightReceiptSha256", "preflightVerifierId", "preflightVerifierSha256",
  "preflightCreatedAt", "preflightDeadlineAt", "createdAt", "previousIntentSha256",
  "intentSha256",
]);
const MUTATION_COMMITMENT_KEYS = Object.freeze([
  "version", "type", "runId", "phase", "sequence", "intent", "intentSha256", "intentFileSha256",
  "previousCommitmentSha256", "commitmentSha256",
]);
const ABSENCE_KEYS = Object.freeze([
  "version", "type", "status", "operation", "runId", "phase", "planSha256",
  "bindingSha256", "createdAt", "repositoryCommit", "contextSha256",
  "inventory", "supersession", "preflightReceiptSha256", "preflightVerifierId",
  "preflightVerifierSha256", "mutationTailSequence", "mutationTailSha256", "sha256",
]);
const INVENTORY_KEYS = Object.freeze(["activeNames", "deletedNames", "targetStates"]);
const TARGET_STATE_KEYS = Object.freeze(["name", "activeCount", "deletedCount", "state"]);

export class CleanupError extends Error {
  constructor(code) {
    super(String(code).replace(/[^a-z0-9._-]/giu, "-"));
    this.name = "CleanupError";
    this.code = this.message;
  }
}

function reject(code) {
  throw new CleanupError(code);
}

function failIf(condition, code) {
  if (condition) reject(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, code) {
  failIf(!isObject(value), code);
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  failIf(JSON.stringify(actual) !== JSON.stringify(allowed), code);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value) {
  return sha256Bytes(canonicalJson(value));
}

function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

function fileMode(stat) {
  return stat.mode & 0o777;
}

function assertDirectory(directory, code, mode = DIRECTORY_MODE) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    reject(`${code}-missing`);
  }
  failIf(stat.isSymbolicLink() || !stat.isDirectory(), `${code}-directory`);
  failIf(UID !== undefined && stat.uid !== UID, `${code}-owner`);
  failIf(fileMode(stat) !== mode, `${code}-mode`);
  return stat;
}

function assertRegular(filePath, code, mode = ARTIFACT_MODE) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    reject(`${code}-missing`);
  }
  failIf(stat.isSymbolicLink() || !stat.isFile(), `${code}-file`);
  failIf(UID !== undefined && stat.uid !== UID, `${code}-owner`);
  failIf(fileMode(stat) !== mode, `${code}-mode`);
  return stat;
}

function assertOwnedRegular(filePath, code) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    reject(`${code}-missing`);
  }
  failIf(stat.isSymbolicLink() || !stat.isFile(), `${code}-file`);
  failIf(UID !== undefined && stat.uid !== UID, `${code}-owner`);
  return stat;
}

function fsyncDirectory(directory) {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeFully(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function fault(config, event, details = {}) {
  const callback = config.faultAt;
  if (typeof callback === "function") callback({ event, ...details });
  if (typeof callback === "string" && callback === event) reject(`fault-${event}`);
}

function sameDirectoryDescriptor(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.isDirectory() && after.isDirectory();
}

// A temporary-file rename is not no-replace on POSIX: rename replaces a target
// created by a racing process.  A hard-link publication is atomic and fails on
// EEXIST, so the target can never be replaced.  The directory descriptor and
// inode are checked before and after publication to close the path race.
function exclusiveBytes(config, filePath, bytes, code) {
  const parent = path.dirname(filePath);
  assertDirectory(parent, `${code}-parent`);
  const parentFd = openSync(parent, "r");
  let parentStat;
  let temporary;
  let fd;
  let published = false;
  try {
    parentStat = fstatSync(parentFd);
    failIf(!sameDirectoryDescriptor(parentStat, lstatSync(parent)), `${code}-parent-race`);
    failIf(existsSync(filePath), `${code}-exists`);
    temporary = path.join(
      parent,
      `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    fault(config, "before-temp-open", { filePath });
    fd = openSync(temporary, "wx", ARTIFACT_MODE);
    fchmodSync(fd, ARTIFACT_MODE);
    const temporaryStat = fstatSync(fd);
    failIf(!temporaryStat.isFile() || fileMode(temporaryStat) !== ARTIFACT_MODE, `${code}-temporary`);
    fault(config, "after-temp-open", { filePath });
    writeFully(fd, bytes);
    fault(config, "before-file-fsync", { filePath });
    fsyncSync(fd);
    fault(config, "after-file-fsync", { filePath });
    fault(config, "before-rename", { filePath });
    // linkSync is the no-replace publication primitive.  It does not follow a
    // target symlink and cannot overwrite an existing descriptor.
    failIf(!sameDirectoryDescriptor(parentStat, lstatSync(parent)), `${code}-parent-race`);
    linkSync(temporary, filePath);
    published = true;
    const targetStat = lstatSync(filePath);
    const linkedStat = fstatSync(fd);
    failIf(
      targetStat.isSymbolicLink() || !targetStat.isFile() ||
      targetStat.dev !== linkedStat.dev || targetStat.ino !== linkedStat.ino,
      `${code}-descriptor`,
    );
    fault(config, "after-rename", { filePath });
    closeSync(fd);
    fd = undefined;
    unlinkSync(temporary);
    temporary = undefined;
    fsyncDirectory(parent);
    fault(config, "after-directory-fsync", { filePath });
    const afterParent = fstatSync(parentFd);
    failIf(!sameDirectoryDescriptor(parentStat, afterParent) || !sameDirectoryDescriptor(parentStat, lstatSync(parent)), `${code}-parent-race`);
    assertRegular(filePath, code);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the durable-write error.
      }
    }
    if (temporary !== undefined) {
      try {
        unlinkSync(temporary);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
    if (published) {
      try {
        fsyncDirectory(parent);
      } catch {
        // Preserve the original error.
      }
    }
    throw error;
  } finally {
    closeSync(parentFd);
  }
}

function exclusiveJson(config, filePath, value, code) {
  exclusiveBytes(config, filePath, Buffer.from(`${canonicalJson(value)}\n`, "utf8"), code);
}

// Version files are immutable.  The head is the only replaceable pathname and
// is a small, self-hashed pointer.  Its replacement is atomic and durable;
// after a crash recovery can therefore select either the old complete head or
// the new complete head, never a truncated manifest.
function replaceJsonAtomically(config, filePath, value, code) {
  const parent = path.dirname(filePath);
  assertDirectory(parent, `${code}-parent`);
  const parentFd = openSync(parent, "r");
  let temporary;
  let fd;
  try {
    const parentStat = fstatSync(parentFd);
    failIf(!sameDirectoryDescriptor(parentStat, lstatSync(parent)), `${code}-parent-race`);
    const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
    temporary = path.join(
      parent,
      `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    fault(config, "before-manifest-head-temp-open", { filePath });
    fd = openSync(temporary, "wx", ARTIFACT_MODE);
    fchmodSync(fd, ARTIFACT_MODE);
    writeFully(fd, bytes);
    fault(config, "after-manifest-head-write", { filePath });
    fsyncSync(fd);
    fault(config, "after-manifest-head-fsync", { filePath });
    closeSync(fd);
    fd = undefined;
    failIf(!sameDirectoryDescriptor(parentStat, lstatSync(parent)), `${code}-parent-race`);
    if (existsSync(filePath)) {
      const existing = lstatSync(filePath);
      failIf(existing.isSymbolicLink() || !existing.isFile() || fileMode(existing) !== ARTIFACT_MODE, `${code}-file`);
    }
    fault(config, "before-manifest-head-rename", { filePath });
    renameSync(temporary, filePath);
    temporary = undefined;
    fault(config, "after-manifest-head-rename", { filePath });
    fsyncDirectory(parent);
    fault(config, "after-manifest-head-directory-fsync", { filePath });
    assertRegular(filePath, code);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary !== undefined) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    closeSync(parentFd);
  }
}

function readJson(filePath, code) {
  let text;
  try {
    const stat = assertRegular(filePath, code);
    failIf(stat.size > MAX_HTTP_BODY_BYTES, `${code}-too-large`);
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof CleanupError) throw error;
    reject(`${code}-read`);
  }
  try {
    const value = JSON.parse(text);
    failIf(!isObject(value), `${code}-object`);
    return value;
  } catch (error) {
    if (error instanceof CleanupError) throw error;
    reject(`${code}-json`);
  }
}

function assertRunId(runId) {
  failIf(typeof runId !== "string" || !RUN_ID_RE.test(runId), "invalid-run-id");
}

export function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 2) return undefined;
  const [operation, runId] = argv;
  if (!["start", "resume", "assert-absent"].includes(operation)) return undefined;
  if (!RUN_ID_RE.test(runId)) return undefined;
  return { operation, runId };
}

function runDirectory(config, runId) {
  assertRunId(runId);
  const directory = path.join(config.root, runId);
  failIf(path.dirname(directory) !== config.root, "run-path");
  assertDirectory(directory, "run-directory");
  return directory;
}

function artifactPath(directory, filename) {
  const result = path.join(directory, filename);
  failIf(path.dirname(result) !== directory, "artifact-path");
  return result;
}

function validateTargetNames(names, code) {
  failIf(
    !Array.isArray(names) || names.length !== TARGET_SECRET_NAMES.length ||
      names.some((name, index) => name !== TARGET_SECRET_NAMES[index]),
    code,
  );
}

function assertFiniteInteger(value, code, minimum = 0) {
  failIf(!Number.isSafeInteger(value) || value < minimum, code);
}

function assertTimestamp(value, code) {
  failIf(!Number.isFinite(value), code);
}

function assertIsoTimestamp(value, code) {
  failIf(typeof value !== "string" || !Number.isFinite(Date.parse(value)), code);
}

function validateSupersession(value, code = "supersession") {
  if (value === undefined || value === null) return null;
  exactKeys(value, ["oldRunId", "cleanupManifestSha256", "absenceReceiptSha256", "contextSha256"], `${code}-schema`);
  assertRunId(value.oldRunId);
  failIf(!isSha256(value.cleanupManifestSha256) || !isSha256(value.absenceReceiptSha256) || !isSha256(value.contextSha256), `${code}-hash`);
  return {
    oldRunId: value.oldRunId,
    cleanupManifestSha256: value.cleanupManifestSha256,
    absenceReceiptSha256: value.absenceReceiptSha256,
    contextSha256: value.contextSha256,
  };
}

function descriptorValues(raw, runId) {
  exactKeys(raw, raw?.supersession === undefined ? DESCRIPTOR_KEYS : DESCRIPTOR_SUPERSESSION_KEYS, "descriptor-schema");
  failIf(raw.version !== 1 || raw.type !== "credential-cleanup-vault-descriptor", "descriptor-type");
  failIf(raw.runId !== runId || raw.phase !== "credential-cleanup", "descriptor-context");
  failIf(!isSha256(raw.planSha256), "descriptor-plan-hash");
  failIf(!isSha256(raw.bindingSha256) || raw.contextSha256 !== raw.bindingSha256, "descriptor-context-hash");
  failIf(!GUID_RE.test(raw.subscription) || !GUID_RE.test(raw.tenant), "descriptor-identity");
  const cloudDescriptor = AZURE_CLOUD_DESCRIPTORS[raw.cloud];
  failIf(cloudDescriptor === undefined, "descriptor-cloud");
  exactKeys(raw.callerIdentity, ["userType", "objectId"], "descriptor-caller");
  failIf(raw.callerIdentity.userType !== "user" || !GUID_RE.test(raw.callerIdentity.objectId), "descriptor-caller");
  const resourceMatch = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.KeyVault\/vaults\/([^/]+)$/u.exec(raw.vaultResourceId ?? "");
  failIf(!resourceMatch || resourceMatch[1] !== raw.subscription || !SECRET_NAME_RE.test(resourceMatch[3]), "descriptor-vault-id");
  failIf(typeof raw.vaultUri !== "string" || !raw.vaultUri.endsWith("/"), "descriptor-vault-uri");
  let parsedUri;
  try {
    parsedUri = new URL(raw.vaultUri);
  } catch {
    reject("descriptor-vault-uri");
  }
  failIf(
    parsedUri.protocol !== "https:" || parsedUri.username || parsedUri.password ||
      parsedUri.port || parsedUri.search || parsedUri.hash || parsedUri.pathname !== "/" ||
      parsedUri.hostname !== `${resourceMatch[3].toLowerCase()}.${cloudDescriptor.keyVaultDnsSuffix}`,
    "descriptor-vault-uri",
  );
  validateTargetNames(raw.targetNames, "descriptor-targets");
  failIf(raw.startState !== "start", "descriptor-start-state");
  return {
    raw,
    runId,
    planSha256: raw.planSha256,
    bindingSha256: raw.bindingSha256,
    contextSha256: raw.contextSha256,
    vaultResourceId: raw.vaultResourceId,
    vaultUri: raw.vaultUri,
    subscription: raw.subscription,
    tenant: raw.tenant,
    cloud: raw.cloud,
    cloudDescriptor,
    callerIdentity: { ...raw.callerIdentity },
    vaultName: resourceMatch[3],
    supersession: validateSupersession(raw.supersession),
  };
}

function exactCreateArgv(planPath) {
  return ["plan", "-refresh=true", "-input=false", "-lock=true", "-lock-timeout=5m", `-out=${planPath}`];
}

function exactCreateArgvs(planPath) {
  return [
    exactCreateArgv(planPath),
    exactCreateArgv(path.join(path.dirname(planPath), ".plan.tfplan.tmp")),
  ];
}

function exactGuardArgv() {
  return ["--mode=azure-credential-cleanup"];
}

function validateBackend(backend, descriptor) {
  exactKeys(backend, BACKEND_KEYS, "context-backend-schema");
  failIf(
    backend.type !== "azurerm" || backend.use_azuread_auth !== true || backend.use_cli !== true ||
      typeof backend.container_name !== "string" || typeof backend.key !== "string" ||
      typeof backend.resource_group_name !== "string" || typeof backend.storage_account_name !== "string" ||
      backend.subscription_id !== descriptor.subscription || backend.tenant_id !== descriptor.tenant,
    "context-backend",
  );
}

function validateImagePlatformBinding(value, acrLoginServer) {
  exactKeys(value, ["version", "verifierSha256", "images"], "context-image-platform-schema");
  failIf(
    value.version !== 1 || !isSha256(value.verifierSha256) || !Array.isArray(value.images) ||
      value.images.length !== 2,
    "context-image-platform",
  );
  const seen = new Set();
  for (const descriptor of value.images) {
    exactKeys(descriptor, IMAGE_DESCRIPTOR_KEYS, "context-image-descriptor-schema");
    const match = typeof descriptor.reference === "string" ? IMAGE_REFERENCE_RE.exec(descriptor.reference) : null;
    failIf(match === null, "context-image-descriptor");
    const [, host, repository, digest] = match;
    failIf(
      seen.has(repository) ||
        descriptor.version !== 1 ||
        host !== acrLoginServer ||
        descriptor.repository !== repository ||
        descriptor.manifestDigest !== digest ||
        typeof descriptor.configDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(descriptor.configDigest) ||
        typeof descriptor.manifestMediaType !== "string" ||
        !Object.hasOwn(IMAGE_MANIFEST_MEDIA_TYPES, descriptor.manifestMediaType) ||
        descriptor.configMediaType !== IMAGE_MANIFEST_MEDIA_TYPES[descriptor.manifestMediaType] ||
        descriptor.os !== "linux" ||
        descriptor.architecture !== "amd64" ||
        descriptor.variant !== null,
      "context-image-descriptor",
    );
    seen.add(repository);
  }
  failIf(
    value.images[0].repository !== "palancar-expiry-cleanup" ||
      value.images[1].repository !== "palancar-relay",
    "context-image-platform",
  );
}

function validateLifecycleBindings(bindings, descriptor) {
  failIf(
    typeof bindings.runtimeIdentityId !== "string" || !RUNTIME_IDENTITY_ID_RE.test(bindings.runtimeIdentityId) ||
      typeof bindings.runtimeIdentityClientId !== "string" ||
      !UUID_RE.test(bindings.runtimeIdentityClientId) ||
      typeof bindings.runtimeIdentityPrincipalId !== "string" ||
      !UUID_RE.test(bindings.runtimeIdentityPrincipalId),
    "context-runtime-identity",
  );
  const accountMatch = typeof bindings.accountId === "string" ? ACCOUNT_ID_RE.exec(bindings.accountId) : null;
  failIf(
    accountMatch === null ||
      !UUID_RE.test(accountMatch[1]) ||
      accountMatch[1] !== descriptor.subscription,
    "context-account",
  );
  const roleAssignmentPrefix = `${bindings.accountId}/providers/Microsoft.Authorization/roleAssignments/`;
  failIf(
    typeof bindings.runtimeOpenAiRoleAssignmentId !== "string" ||
      !bindings.runtimeOpenAiRoleAssignmentId.startsWith(roleAssignmentPrefix) ||
      !UUID_RE.test(bindings.runtimeOpenAiRoleAssignmentId.slice(roleAssignmentPrefix.length)),
    "context-runtime-openai-role",
  );
  failIf(
    typeof bindings.acrLoginServer !== "string" || !ACR_LOGIN_SERVER_RE.test(bindings.acrLoginServer),
    "context-acr-login-server",
  );
  validateImagePlatformBinding(bindings.imagePlatforms, bindings.acrLoginServer);
}

function validateBindings(bindings, descriptor, manifest) {
  exactKeys(bindings, BINDING_KEYS, "context-schema");
  failIf(bindings.planSha256 !== manifest.planSha256 || bindings.phase !== "credential-cleanup", "context-binding");
  failIf(!isSha256(bindings.terraformSha256) || !isSha256(bindings.lifecycleSha256) || !isSha256(bindings.guardSha256), "context-code-hash");
  failIf(!COMMIT_RE.test(bindings.repositoryCommit), "context-commit");
  failIf(bindings.cwd !== WORKING_DIRECTORY || bindings.workspace !== "default", "context-working-directory");
  failIf(!Array.isArray(bindings.argv) || JSON.stringify(bindings.argv) !== JSON.stringify(manifest.argv), "context-argv");
  failIf(typeof bindings.stateLineage !== "string" || bindings.stateLineage.length === 0, "context-state-lineage");
  assertFiniteInteger(bindings.stateSerial, "context-state-serial");
  failIf(bindings.liveRevision !== null && typeof bindings.liveRevision !== "string", "context-live-revision");
  failIf(!isSha256(bindings.backendSha256) || bindings.backendConfigurationSha256 !== bindings.backendSha256, "context-backend-hash");
  validateBackend(bindings.backend, descriptor);
  failIf(bindings.backendSha256 !== BACKEND_SHA256 || bindings.backendSha256 !== sha256Bytes(`${canonicalJson(bindings.backend)}\n`), "context-backend-hash");
  failIf(bindings.guard !== "azure-credential-cleanup", "context-guard");
  const expectedAzureHash = sha256Json({ cloud: descriptor.cloud, subscription: descriptor.subscription, tenant: descriptor.tenant });
  const expectedCallerHash = sha256Json({
    cloud: descriptor.cloud,
    subscription: descriptor.subscription,
    tenant: descriptor.tenant,
    userType: descriptor.callerIdentity.userType,
    objectId: descriptor.callerIdentity.objectId,
  });
  failIf(bindings.azureContextHash !== expectedAzureHash || bindings.callerHash !== expectedCallerHash, "context-identity-hash");
  failIf(!Array.isArray(bindings.dependencyBlobs), "context-dependencies");
  for (const dependency of bindings.dependencyBlobs) {
    exactKeys(dependency, DEPENDENCY_KEYS, "context-dependency-schema");
    failIf(typeof dependency.path !== "string" || !/^[^/].*[^/]$/u.test(dependency.path) || !/^[0-9a-f]{40}$/u.test(dependency.blob) || !isSha256(dependency.sha256), "context-dependency");
  }
  validateLifecycleBindings(bindings, descriptor);
  failIf(manifest.bindingSha256 !== sha256Json(bindings), "context-binding-hash");
}

function validateCreateManifest(raw, descriptor, planPath) {
  const keys = raw?.supersession === undefined ? CREATE_KEYS : CREATE_SUPERSESSION_KEYS;
  exactKeys(raw, keys, "create-manifest-schema");
  failIf(raw.version !== 1 || raw.runId !== descriptor.runId || raw.phase !== "credential-cleanup", "create-manifest-context");
  assertIsoTimestamp(raw.createdAt, "create-manifest-time");
  failIf(raw.processExit !== 0 || !isSha256(raw.planSha256), "create-manifest-result");
  failIf(!exactCreateArgvs(planPath).some((argv) => JSON.stringify(raw.argv) === JSON.stringify(argv)), "create-manifest-argv");
  failIf(!isSha256(raw.bindingSha256), "create-manifest-binding");
  validateBindings(raw.bindings, descriptor, raw);
  if (raw.supersession !== undefined) validateSupersession(raw.supersession, "create-manifest-supersession");
  failIf(canonicalJson(raw.supersession ?? null) !== canonicalJson(descriptor.supersession), "create-manifest-supersession");
  failIf(raw.planSha256 !== descriptor.planSha256 || raw.bindingSha256 !== descriptor.bindingSha256, "create-manifest-context");
  return raw;
}

function validateGuardReceipt(raw, descriptor, manifest) {
  exactKeys(raw, GUARD_KEYS, "guard-receipt-schema");
  failIf(
    raw.version !== 1 || raw.type !== "guard" || raw.runId !== descriptor.runId ||
      raw.phase !== "credential-cleanup" || raw.planSha256 !== manifest.planSha256 ||
      raw.bindingSha256 !== manifest.bindingSha256 || raw.createdAt !== manifest.createdAt ||
      raw.guard !== "azure-credential-cleanup" || JSON.stringify(raw.guardArgv) !== JSON.stringify(exactGuardArgv()) ||
      !isSha256(raw.showSha256) || raw.stdinSha256 !== raw.showSha256 || raw.result !== "passed",
    "guard-receipt-schema",
  );
  return raw;
}

function validatePreflightReceipt(raw, descriptor, manifest) {
  exactKeys(raw, PREFLIGHT_KEYS, "preflight-receipt-schema");
  failIf(
      raw.version !== 2 || raw.type !== "runtime-preflight" || raw.runId !== descriptor.runId ||
      raw.phase !== "credential-cleanup" || raw.planSha256 !== manifest.planSha256 ||
      raw.bindingSha256 !== manifest.bindingSha256 || raw.contextSha256 !== descriptor.contextSha256 ||
      raw.result !== "passed" || raw.verifierId !== PREFLIGHT_VERIFIER_ID ||
      raw.verifierArtifact !== PREFLIGHT_VERIFIER_ARTIFACT ||
      !isSha256(raw.verifierSha256) || raw.verifierSha256 !== sha256File(SCRIPT_PATH) ||
      raw.vaultResourceId !== descriptor.vaultResourceId || raw.vaultUri !== descriptor.vaultUri,
    "preflight-receipt-schema",
  );
  exactKeys(raw.runtimeIdentity, ["cloud", "subscription", "tenant", "userType", "objectId"], "preflight-runtime-identity");
  failIf(
    raw.runtimeIdentity.cloud !== descriptor.cloud ||
      raw.runtimeIdentity.subscription !== descriptor.subscription ||
      raw.runtimeIdentity.tenant !== descriptor.tenant ||
      raw.runtimeIdentity.userType !== descriptor.callerIdentity.userType ||
      raw.runtimeIdentity.objectId !== descriptor.callerIdentity.objectId,
    "preflight-runtime-identity",
  );
  validateTargetNames(raw.targetNames, "preflight-targets");
  assertIsoTimestamp(raw.createdAt, "preflight-receipt-time");
  assertIsoTimestamp(raw.deadlineAt, "preflight-receipt-deadline");
  const unsigned = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "receiptSha256"));
  failIf(!isSha256(raw.receiptSha256) || raw.receiptSha256 !== sha256Json(unsigned), "preflight-receipt-hash");
  const createdAt = Date.parse(raw.createdAt);
  const deadlineAt = Date.parse(raw.deadlineAt);
  failIf(deadlineAt <= createdAt || deadlineAt - createdAt > PREFLIGHT_MAX_AGE_MS, "preflight-receipt-deadline");
  return {
    raw,
    receiptSha256: raw.receiptSha256,
    verifierId: raw.verifierId,
    verifierSha256: raw.verifierSha256,
    createdAt,
    deadlineAt,
  };
}

function readLifecycleContext(config, directory, descriptor, { rejectPreflight = false } = {}) {
  const planPath = artifactPath(directory, "plan.tfplan");
  assertRegular(planPath, "plan");
  failIf(sha256File(planPath) !== descriptor.planSha256, "plan-hash");
  const createPath = artifactPath(directory, "create-manifest.json");
  const manifest = validateCreateManifest(readJson(createPath, "create-manifest"), descriptor, planPath);
  const guardPath = artifactPath(directory, "guard-receipt.json");
  const guard = validateGuardReceipt(readJson(guardPath, "guard-receipt"), descriptor, manifest);
  const preflightPath = artifactPath(directory, PREFLIGHT_RECEIPT_FILENAME);
  let preflight;
  if (existsSync(preflightPath)) {
    if (rejectPreflight) reject("start-after-preflight");
    preflight = validatePreflightReceipt(readJson(preflightPath, "preflight-receipt"), descriptor, manifest);
    const planTime = Date.parse(manifest.createdAt);
    const preflightTime = preflight.createdAt;
    const wallNow = config.wallNow();
    failIf(!Number.isFinite(planTime) || !Number.isFinite(preflightTime), "preflight-time");
    failIf(preflightTime <= planTime || preflight.createdAt === manifest.createdAt, "preflight-order");
    failIf(!Number.isFinite(wallNow) || preflightTime > wallNow || wallNow - preflightTime > PREFLIGHT_MAX_AGE_MS || preflight.deadlineAt <= wallNow, "preflight-expired");
  }
  return {
    planPath,
    manifest,
    guard,
    preflight,
    guardReceiptSha256: sha256File(guardPath),
  };
}

function validateOperationManifest(raw, context) {
  exactKeys(raw, OPERATION_KEYS, "operation-manifest-schema");
  const descriptor = context.descriptor;
  const lifecycleManifest = context.lifecycle.manifest;
  const expectedSupersession = descriptor.supersession;
  assertOwnedRegular(SCRIPT_PATH, "utility");
  failIf(
      raw.version !== 3 || raw.type !== "cleanup" || !["prepared", "completed"].includes(raw.status) || raw.operation !== "credential-cleanup" ||
      raw.runId !== descriptor.runId ||
      raw.phase !== "credential-cleanup" || raw.planSha256 !== descriptor.planSha256 ||
      raw.bindingSha256 !== descriptor.bindingSha256 || raw.contextSha256 !== descriptor.contextSha256 ||
      raw.createdAt !== lifecycleManifest.createdAt ||
      raw.repositoryCommit !== lifecycleManifest.bindings.repositoryCommit ||
      !Array.isArray(raw.runtimeSecretReferences) || raw.runtimeSecretReferences.length !== 0 ||
      !isSha256(raw.utilitySha256) || raw.utilitySha256 !== sha256File(SCRIPT_PATH) ||
      raw.vaultResourceId !== descriptor.vaultResourceId ||
      raw.journalCommitmentPath !== journalCommitmentRelativePath(descriptor.runId) ||
      !Number.isSafeInteger(raw.sequence) || raw.sequence < 0 ||
      (raw.sequence === 0 ? raw.previousManifestSha256 !== null : !isSha256(raw.previousManifestSha256)) ||
      canonicalJson(raw.supersession) !== canonicalJson(expectedSupersession) ||
      !isSha256(raw.sha256) || raw.sha256 !== sha256Json(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "sha256"))),
    "operation-manifest-context",
  );
  validateSupersession(raw.supersession, "operation-manifest-supersession");
  return raw;
}

function operationVersionPath(directory, sequence) {
  return artifactPath(directory, `cleanup-manifest-${String(sequence).padStart(6, "0")}.json`);
}

function operationHeadValue(operation, manifestSha256, previousHeadSha256) {
  const head = {
    ...operation,
    manifestFilename: path.basename(operationVersionPath("/", operation.sequence)),
    manifestSha256,
    previousHeadSha256,
    headSha256: null,
  };
  head.headSha256 = sha256Json(Object.fromEntries(Object.entries(head).filter(([key]) => key !== "headSha256")));
  return head;
}

function operationHeadAnchorPath(config, runId, sequence) {
  return path.join(
    journalCommitmentDirectory(config, runId),
    `cleanup-operation-head-${String(sequence).padStart(6, "0")}.json`,
  );
}

function validateOperationHeadIntent(value, context, filePath, previousAnchorPath, allowMissingVersion = false) {
  exactKeys(value, OPERATION_HEAD_INTENT_KEYS, "operation-head-intent-schema");
  const sequence = Number(value.sequence);
  failIf(
    value.version !== 1 || value.type !== "key-vault-cleanup-operation-head-intent" ||
      value.runId !== context.descriptor.runId || value.phase !== "credential-cleanup" ||
      !Number.isSafeInteger(sequence) || sequence < 0 ||
      !isSha256(value.manifestSha256) ||
      (sequence === 0 ? value.previousHeadSha256 !== null : !isSha256(value.previousHeadSha256)) ||
      (sequence === 0 ? value.previousAnchorSha256 !== null : value.previousAnchorSha256 !== sha256File(previousAnchorPath)) ||
      !isSha256(value.intentSha256) ||
      value.intentSha256 !== sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "intentSha256"))),
    "operation-head-intent-context",
  );
  const versionPath = operationVersionPath(context.directory, sequence);
  if (existsSync(versionPath)) failIf(value.manifestSha256 !== sha256File(versionPath), "operation-head-intent-context");
  else failIf(!allowMissingVersion, "operation-head-intent-manifest");
  return value;
}

function validateOperationHeadAnchor(value, context, filePath, previousPath, intentPath) {
  exactKeys(value, OPERATION_HEAD_ANCHOR_KEYS, "operation-head-anchor-schema");
  const sequence = Number(value.sequence);
  failIf(
    value.version !== 1 || value.type !== "key-vault-cleanup-operation-head-anchor" ||
      value.runId !== context.descriptor.runId || value.phase !== "credential-cleanup" ||
      !Number.isSafeInteger(sequence) || sequence < 0 ||
      !isSha256(value.manifestSha256) || value.manifestSha256 !== sha256File(operationVersionPath(context.directory, sequence)) ||
      !isSha256(value.headSha256) || !isSha256(value.intentSha256) || value.intentSha256 !== sha256File(intentPath) ||
      (sequence === 0
        ? value.previousAnchorSha256 !== null
        : value.previousAnchorSha256 !== sha256File(previousPath)) ||
      !isSha256(value.anchorSha256) ||
      value.anchorSha256 !== sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "anchorSha256"))),
    "operation-head-anchor-context",
  );
  const match = OPERATION_HEAD_ANCHOR_SEQUENCE_RE.exec(path.basename(filePath));
  failIf(!match || Number(match[1]) !== sequence, "operation-head-anchor-sequence");
  return value;
}

function readOperationHeadAnchors(config, context) {
  const directory = journalCommitmentDirectory(config, context.descriptor.runId);
  if (!existsSync(directory)) return { anchors: [], intents: [] };
  assertDirectory(directory, "journal-commitment-directory");
  const entries = readdirSync(directory, { withFileTypes: true });
  const anchors = [];
  const intents = [];
  for (const entry of entries) {
    const anchorMatch = OPERATION_HEAD_ANCHOR_SEQUENCE_RE.exec(entry.name);
    const intentMatch = OPERATION_HEAD_INTENT_SEQUENCE_RE.exec(entry.name);
    if (anchorMatch) {
      failIf(entry.isSymbolicLink() || !entry.isFile(), "operation-head-anchor-file");
      anchors.push({
        sequence: Number(anchorMatch[1]),
        filePath: path.join(directory, entry.name),
        value: readJson(path.join(directory, entry.name), "operation-head-anchor"),
      });
    } else if (intentMatch) {
      failIf(entry.isSymbolicLink() || !entry.isFile(), "operation-head-intent-file");
      intents.push({
        sequence: Number(intentMatch[1]),
        filePath: path.join(directory, entry.name),
        value: readJson(path.join(directory, entry.name), "operation-head-intent"),
      });
    }
  }
  anchors.sort((left, right) => left.sequence - right.sequence);
  intents.sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < intents.length; index += 1) {
    const current = intents[index];
    failIf(current.sequence !== index, "operation-head-intent-history");
    const previousAnchorPath = index === 0 ? undefined : anchors[index - 1]?.filePath;
    failIf(index > anchors.length || (index > 0 && previousAnchorPath === undefined), "operation-head-intent-history");
    validateOperationHeadIntent(
      current.value,
      context,
      current.filePath,
      previousAnchorPath,
      index === anchors.length,
    );
    if (index === 0) failIf(current.value.previousHeadSha256 !== null, "operation-head-intent-history");
    else failIf(current.value.previousHeadSha256 !== anchors[index - 1].value.headSha256, "operation-head-intent-history");
  }
  for (let index = 0; index < anchors.length; index += 1) {
    const current = anchors[index];
    failIf(current.sequence !== index, "operation-head-anchor-history");
    failIf(index >= intents.length, "operation-head-anchor-history");
    validateOperationHeadAnchor(
      current.value,
      context,
      current.filePath,
      index === 0 ? undefined : anchors[index - 1].filePath,
      intents[index].filePath,
    );
    failIf(current.value.manifestSha256 !== intents[index].value.manifestSha256, "operation-head-anchor-history");
  }
  failIf(intents.length > anchors.length + 1, "operation-head-intent-pending");
  if (intents.length === anchors.length + 1) {
    failIf(intents.at(-1).sequence !== anchors.length, "operation-head-intent-pending");
  }
  return { anchors, intents };
}

function publishOperationHeadIntent(config, context, operation, previousHeadSha256) {
  const directory = ensureJournalCommitmentDirectory(config, context.descriptor.runId);
  const records = readOperationHeadAnchors(config, context);
  const sequence = operation.sequence;
  const existing = records.intents.find((entry) => entry.sequence === sequence);
  if (existing !== undefined) {
    const expectedManifestSha256 = sha256Bytes(`${canonicalJson(operation)}\n`);
    failIf(existing.value.manifestSha256 !== expectedManifestSha256, "operation-head-intent-conflict");
    failIf(existing.value.previousHeadSha256 !== previousHeadSha256, "operation-head-intent-conflict");
    return existing;
  }
  const previousAnchorSha256 = sequence === 0
    ? null
    : sha256File(records.anchors.at(-1)?.filePath ?? reject("operation-head-intent-history"));
  failIf(sequence !== records.intents.length, "operation-head-intent-history");
  failIf(sequence === 0 ? previousHeadSha256 !== null : !isSha256(previousHeadSha256), "operation-head-intent-history");
  const value = {
    version: 1,
    type: "key-vault-cleanup-operation-head-intent",
    runId: context.descriptor.runId,
    phase: "credential-cleanup",
    sequence,
    manifestSha256: sha256Bytes(`${canonicalJson(operation)}\n`),
    previousHeadSha256,
    previousAnchorSha256,
    intentSha256: null,
  };
  value.intentSha256 = sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "intentSha256")));
  const filePath = path.join(directory, `cleanup-operation-head-intent-${String(sequence).padStart(6, "0")}.json`);
  if (existsSync(filePath)) {
    failIf(canonicalJson(readJson(filePath, "operation-head-intent")) !== canonicalJson(value), "operation-head-intent-conflict");
  } else {
    exclusiveJson(config, filePath, value, "operation-head-intent");
  }
  return { filePath, value };
}

function publishOperationHeadAnchor(config, context, operation, headValue, intent) {
  ensureJournalCommitmentDirectory(config, context.descriptor.runId);
  const records = readOperationHeadAnchors(config, context);
  const sequence = operation.sequence;
  failIf(sequence !== records.anchors.length, "operation-head-anchor-history");
  failIf(intent.value.manifestSha256 !== sha256File(operationVersionPath(context.directory, sequence)), "operation-head-anchor-context");
  const value = {
    version: 1,
    type: "key-vault-cleanup-operation-head-anchor",
    runId: context.descriptor.runId,
    phase: "credential-cleanup",
    sequence,
    manifestSha256: sha256File(operationVersionPath(context.directory, sequence)),
    headSha256: sha256Bytes(`${canonicalJson(headValue)}\n`),
    previousAnchorSha256: sequence === 0 ? null : sha256File(records.anchors.at(-1).filePath),
    intentSha256: sha256File(intent.filePath),
    anchorSha256: null,
  };
  value.anchorSha256 = sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "anchorSha256")));
  const filePath = operationHeadAnchorPath(config, context.descriptor.runId, sequence);
  if (existsSync(filePath)) {
    failIf(canonicalJson(readJson(filePath, "operation-head-anchor")) !== canonicalJson(value), "operation-head-anchor-conflict");
  } else {
    exclusiveJson(config, filePath, value, "operation-head-anchor");
  }
  return value;
}

function reconcileOperationHeadPublication(config, context, headPath, headRaw, records) {
  const latestAnchor = records.anchors.at(-1);
  if (latestAnchor === undefined) {
    failIf(headRaw.sequence !== 0 || records.intents.length !== 1, "operation-head-anchor-missing");
    const intent = records.intents[0];
    failIf(intent.value.manifestSha256 !== headRaw.manifestSha256, "operation-head-anchor-pending");
    publishOperationHeadAnchor(
      config,
      context,
      Object.fromEntries(OPERATION_KEYS.map((key) => [key, headRaw[key]])),
      headRaw,
      intent,
    );
    return;
  }
  failIf(headRaw.sequence < latestAnchor.sequence, "operation-head-rollback");
  if (headRaw.sequence === latestAnchor.sequence) {
    failIf(sha256File(headPath) !== latestAnchor.value.headSha256, "operation-head-rollback");
    return;
  }
  failIf(headRaw.sequence !== latestAnchor.sequence + 1, "operation-head-pending");
  failIf(records.intents.length !== records.anchors.length + 1, "operation-head-pending");
  const intent = records.intents.at(-1);
  failIf(intent.value.manifestSha256 !== headRaw.manifestSha256, "operation-head-pending");
  failIf(intent.value.previousHeadSha256 !== latestAnchor.value.headSha256, "operation-head-pending");
  publishOperationHeadAnchor(
    config,
    context,
    Object.fromEntries(OPERATION_KEYS.map((key) => [key, headRaw[key]])),
    headRaw,
    intent,
  );
}

function validateOperationHead(raw, context, headPath, versionPath) {
  exactKeys(raw, OPERATION_HEAD_KEYS, "operation-manifest-head-schema");
  const operation = Object.fromEntries(OPERATION_KEYS.map((key) => [key, raw[key]]));
  validateOperationManifest(operation, context);
  const immutableManifest = readJson(versionPath, "operation-manifest");
  validateOperationManifest(immutableManifest, context);
  failIf(canonicalJson(operation) !== canonicalJson(immutableManifest), "operation-manifest-head-reference");
  failIf(
    sha256File(versionPath) !== sha256Bytes(`${canonicalJson(immutableManifest)}\n`),
    "operation-manifest-version-integrity",
  );
  failIf(raw.manifestFilename !== path.basename(versionPath), "operation-manifest-head-context");
  failIf(raw.manifestSha256 !== sha256File(versionPath), "operation-manifest-head-context");
  failIf(!isSha256(raw.headSha256) || raw.headSha256 !== sha256Json(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "headSha256"))), "operation-manifest-head-integrity");
  const expectedPreviousHead = operation.sequence === 0 ? null : raw.previousHeadSha256;
  failIf(operation.sequence === 0 ? expectedPreviousHead !== null : !isSha256(expectedPreviousHead), "operation-manifest-head-history");
  assertRegular(headPath, "operation-manifest-head");
  return operation;
}

function assertOperationHeadExternallyAnchored(config, context) {
  const headPath = artifactPath(context.directory, OPERATION_MANIFEST_FILENAME);
  assertRegular(headPath, "operation-manifest-head");
  const headRaw = readJson(headPath, "operation-manifest-head");
  const sequence = Number.isSafeInteger(headRaw.sequence) ? headRaw.sequence : -1;
  failIf(sequence < 0, "operation-head-unanchored");
  const versionPath = operationVersionPath(context.directory, sequence);
  const operation = validateOperationHead(headRaw, context, headPath, versionPath);
  const records = readOperationHeadAnchors(config, context);
  const anchor = records.anchors.at(-1);
  failIf(anchor === undefined || anchor.sequence !== operation.sequence, "operation-head-unanchored");
  failIf(
    anchor.value.manifestSha256 !== sha256File(versionPath) ||
      anchor.value.headSha256 !== sha256File(headPath),
    "operation-head-unanchored",
  );
}

function readOperationHistory(config, context) {
  const headRecords = readOperationHeadAnchors(config, context);
  const entries = readdirSync(context.directory, { withFileTypes: true });
  const versions = [];
  for (const entry of entries) {
    const match = OPERATION_MANIFEST_VERSION_FILENAME_RE.exec(entry.name);
    if (match) {
      failIf(entry.isSymbolicLink() || !entry.isFile(), "operation-manifest-version-file");
      const filePath = operationVersionPath(context.directory, Number(match[1]));
      versions.push({ sequence: Number(match[1]), filePath, value: readJson(filePath, "operation-manifest") });
    } else if (entry.name.startsWith("cleanup-manifest-") && !entry.name.startsWith("cleanup-manifest.json")) {
      reject("operation-manifest-version-name");
    }
  }
  versions.sort((left, right) => left.sequence - right.sequence);
  const headPath = artifactPath(context.directory, OPERATION_MANIFEST_FILENAME);
  if (!existsSync(headPath)) {
    failIf(headRecords.anchors.length > 0, "operation-head-anchor-missing");
    failIf(versions.length > 1 || (versions.length === 1 && versions[0].sequence !== 0), "operation-manifest-head-missing");
    if (versions.length === 0) return undefined;
    validateOperationManifest(versions[0].value, context);
    return { operation: versions[0].value, operationPath: versions[0].filePath, headPath, head: undefined };
  }
  const headRaw = readJson(headPath, "operation-manifest-head");
  const headSequence = Number.isSafeInteger(headRaw.sequence) ? headRaw.sequence : -1;
  failIf(headSequence < 0, "operation-manifest-head-context");
  const version = versions.find((candidate) => candidate.sequence === headSequence);
  failIf(version === undefined, "operation-manifest-head-missing");
  const operation = validateOperationHead(headRaw, context, headPath, version.filePath);
  const latestJournalCommitment = readJournalCommitments(config, context.descriptor.runId);
  if (latestJournalCommitment !== undefined) {
    failIf(
      latestJournalCommitment.value.manifestSha256 !== headRaw.manifestSha256,
      "operation-head-rollback",
    );
    failIf(
      headRecords.anchors.at(-1)?.sequence !== headSequence,
      "operation-head-rollback",
    );
  }
  reconcileOperationHeadPublication(config, context, headPath, headRaw, headRecords);
  for (let index = 0; index <= headSequence; index += 1) {
    const candidate = versions.find((entry) => entry.sequence === index);
    failIf(candidate === undefined, "operation-manifest-history");
    validateOperationManifest(candidate.value, context);
    failIf(candidate.value.sequence !== index, "operation-manifest-history");
    if (index === 0) failIf(candidate.value.previousManifestSha256 !== null, "operation-manifest-history");
    else failIf(candidate.value.previousManifestSha256 !== sha256File(versions.find((entry) => entry.sequence === index - 1).filePath), "operation-manifest-history");
  }
  const pending = versions.filter((candidate) => candidate.sequence > headSequence);
  failIf(pending.length > 1 || (pending.length === 1 && pending[0].sequence !== headSequence + 1), "operation-manifest-ambiguity");
  if (pending.length === 1) {
    validateOperationManifest(pending[0].value, context);
    failIf(pending[0].value.previousManifestSha256 !== sha256File(version.filePath), "operation-manifest-history");
  }
  return { operation, operationPath: version.filePath, headPath, head: headRaw };
}

function publishOperationVersion(config, context, operation) {
  const versionPath = operationVersionPath(context.directory, operation.sequence);
  const previousHeadSha256 = existsSync(artifactPath(context.directory, OPERATION_MANIFEST_FILENAME))
    ? sha256File(artifactPath(context.directory, OPERATION_MANIFEST_FILENAME))
    : null;
  const intent = publishOperationHeadIntent(config, context, operation, previousHeadSha256);
  if (existsSync(versionPath)) {
    const existing = readJson(versionPath, "operation-manifest");
    failIf(canonicalJson(existing) !== canonicalJson(operation), "operation-manifest-version-conflict");
  } else {
    exclusiveJson(config, versionPath, operation, "operation-manifest-version");
  }
  assertRegular(versionPath, "operation-manifest-version");
  failIf(sha256File(versionPath) !== sha256Bytes(`${canonicalJson(operation)}\n`), "operation-manifest-version-hash");
  failIf(intent.value.manifestSha256 !== sha256File(versionPath), "operation-head-intent-context");
  return versionPath;
}

function publishOperationHead(config, context, operation, versionPath) {
  const headPath = artifactPath(context.directory, OPERATION_MANIFEST_FILENAME);
  let previousHeadSha256 = null;
  if (existsSync(headPath)) {
    const previous = readJson(headPath, "operation-manifest-head");
    exactKeys(previous, OPERATION_HEAD_KEYS, "operation-manifest-head-schema");
    previousHeadSha256 = sha256File(headPath);
    failIf(operation.sequence !== previous.sequence + 1, "operation-manifest-history");
  } else {
    failIf(operation.sequence !== 0, "operation-manifest-history");
  }
  failIf(path.basename(versionPath) !== `cleanup-manifest-${String(operation.sequence).padStart(6, "0")}.json`, "operation-manifest-head-context");
  const value = operationHeadValue(operation, sha256File(versionPath), previousHeadSha256);
  if (existsSync(headPath)) replaceJsonAtomically(config, headPath, value, "operation-manifest-head");
  else exclusiveJson(config, headPath, value, "operation-manifest-head");
  const records = readOperationHeadAnchors(config, context);
  const intent = records.intents.find((entry) => entry.sequence === operation.sequence);
  failIf(intent === undefined, "operation-head-intent-missing");
  publishOperationHeadAnchor(config, context, operation, value, intent);
  return value;
}

function readDescriptor(config, directory, runId) {
  const descriptorPath = artifactPath(directory, DESCRIPTOR_FILENAME);
  const descriptor = descriptorValues(readJson(descriptorPath, "descriptor"), runId);
  return { ...descriptor, descriptorPath };
}

function validateContext(config, runId, requireManifest, options = {}) {
  const directory = runDirectory(config, runId);
  const descriptor = readDescriptor(config, directory, runId);
  const lifecycle = readLifecycleContext(config, directory, descriptor, options);
  if (!requireManifest) return { directory, descriptor, lifecycle };
  const operationHistory = readOperationHistory(config, { directory, descriptor, lifecycle });
  failIf(operationHistory === undefined, "operation-manifest-missing");
  if (operationHistory.head === undefined) {
    publishOperationHead(config, { directory }, operationHistory.operation, operationHistory.operationPath);
    return validateContext(config, runId, true, options);
  }
  return {
    directory,
    descriptor,
    lifecycle,
    operation: operationHistory.operation,
    operationPath: operationHistory.operationPath,
    operationHeadPath: operationHistory.headPath,
    operationHead: operationHistory.head,
  };
}

function readRuntimePreflight(config, context, deadline) {
  assertWithinDeadline(config, deadline);
  const receiptPath = artifactPath(context.directory, PREFLIGHT_RECEIPT_FILENAME);
  const receipt = validatePreflightReceipt(
    readJson(receiptPath, "preflight-receipt"),
    context.descriptor,
    context.lifecycle.manifest,
  );
  const wallNow = config.wallNow();
  failIf(!Number.isFinite(wallNow), "preflight-clock");
  failIf(receipt.createdAt > wallNow || wallNow - receipt.createdAt > PREFLIGHT_MAX_AGE_MS, "preflight-expired");
  failIf(receipt.deadlineAt <= wallNow, "preflight-expired");
  failIf(receipt.verifierSha256 !== context.operation.utilitySha256, "preflight-verifier-binding");
  failIf(receipt.deadlineAt - wallNow < Math.min(CONVERGENCE_POLL_MS, remaining(config, deadline)), "preflight-deadline");
  return receipt;
}

function preflightFields(receipt) {
  if (receipt === undefined || receipt === null) {
    return {
      preflightReceiptSha256: null,
      preflightVerifierId: null,
      preflightVerifierSha256: null,
    };
  }
  return {
    preflightReceiptSha256: receipt.receiptSha256,
    preflightVerifierId: receipt.verifierId,
    preflightVerifierSha256: receipt.verifierSha256,
  };
}

function liveBindingValue(value) {
  if (isObject(value?.bindings)) return value.bindings;
  if (isObject(value?.context)) return value.context;
  return value;
}

function parseBackendText(text) {
  failIf(typeof text !== "string", "live-backend");
  const values = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([a-z][a-z0-9_]*)\s*=\s*(.+)$/u.exec(trimmed);
    failIf(!match || Object.hasOwn(values, match[1]), "live-backend");
    const [, key, rawValue] = match;
    if (rawValue === "true" || rawValue === "false") values[key] = rawValue === "true";
    else {
      failIf(!/^"(?:[^"\\]|\\.)*"$/u.test(rawValue), "live-backend");
      try {
        values[key] = JSON.parse(rawValue);
      } catch {
        reject("live-backend");
      }
    }
  }
  exactKeys(values, BACKEND_KEYS.filter((key) => key !== "type"), "live-backend");
  const backend = {
    ...values,
    type: "azurerm",
  };
  validateBackend(backend, {
    subscription: backend.subscription_id,
    tenant: backend.tenant_id,
  });
  failIf(sha256Bytes(`${canonicalJson(backend)}\n`) !== BACKEND_SHA256, "live-backend-hash");
  return backend;
}

function contextRemaining(request) {
  failIf(request.signal?.aborted, "invocation-deadline");
  if (request.deadline === undefined) return TOKEN_TIMEOUT_MS;
  const clock = typeof request.clock === "function" ? request.clock : () => Date.now();
  const value = request.deadline - clock();
  failIf(value <= 0, "invocation-deadline");
  return value;
}

const PRODUCTION_ALLOWED_CWDS = Object.freeze([
  "/",
  REPOSITORY_ROOT,
  WORKING_DIRECTORY,
]);

function validateProductionCwd(cwd) {
  failIf(
    typeof cwd !== "string" || !path.isAbsolute(cwd) || path.normalize(cwd) !== cwd ||
      !PRODUCTION_ALLOWED_CWDS.includes(cwd),
    "process-cwd",
  );
  let stat;
  try {
    stat = lstatSync(cwd);
  } catch {
    reject("process-cwd");
  }
  failIf(stat.isSymbolicLink() || !stat.isDirectory(), "process-cwd");
  return cwd;
}

async function productionReadCommand(request, command, argv, cwd, processRunner = productionProcess) {
  validateProductionCwd(cwd);
  const timeoutMs = Math.min(TOKEN_TIMEOUT_MS, contextRemaining(request));
  const result = await processRunner({
    command,
    argv,
    cwd,
    env: { ...PRODUCTION_ENV },
    stdio: ["ignore", "pipe", "ignore"],
    timeoutMs,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    signal: request.signal,
  });
  const stdout = parseCommandResult(result, "live-context-command");
  failIf(Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT_BYTES, "live-context-output");
  return stdout;
}

function stateOutputValue(state, name, required = true) {
  const entry = state?.outputs?.[name];
  if (entry === undefined && !required) return null;
  failIf(!isObject(entry) || !Object.hasOwn(entry, "value"), "live-state-output");
  return entry.value;
}

async function readProductionContext(request, evidenceRoot, processRunner) {
  assertRunId(request?.runId);
  assertDirectory(evidenceRoot, "evidence-root");
  const directory = path.join(evidenceRoot, request.runId);
  const lifecyclePath = artifactPath(directory, "create-manifest.json");
  const lifecycleManifest = readJson(lifecyclePath, "create-manifest");
  const bound = lifecycleManifest.bindings;
  const descriptorPath = artifactPath(directory, DESCRIPTOR_FILENAME);
  const descriptor = descriptorValues(readJson(descriptorPath, "descriptor"), request.runId);
  const read = (command, argv, cwd) => productionReadCommand(request, command, argv, cwd, processRunner);
  const status = await read(
    GIT_PATH,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    REPOSITORY_ROOT,
  );
  failIf(status !== "", "live-worktree-dirty");
  const repositoryCommit = (await read(GIT_PATH, ["rev-parse", "HEAD"], REPOSITORY_ROOT)).trim();
  failIf(!COMMIT_RE.test(repositoryCommit), "live-commit");
  const dependencies = [];
  for (const dependencyPathValue of LIVE_DEPENDENCY_PATHS) {
    const dependencyPath = path.join(REPOSITORY_ROOT, dependencyPathValue);
    assertOwnedRegular(dependencyPath, "live-dependency");
    dependencies.push({
      path: dependencyPathValue,
      blob: (await read(GIT_PATH, ["rev-parse", `HEAD:${dependencyPathValue}`], REPOSITORY_ROOT)).trim(),
      sha256: sha256File(dependencyPath),
    });
  }
  const terraformStat = lstatSync(TERRAFORM_PATH);
  failIf(terraformStat.isSymbolicLink() || !terraformStat.isFile() || (UID !== undefined && terraformStat.uid !== UID), "terraform-file");
  const terraformSha256 = sha256File(TERRAFORM_PATH);
  failIf(terraformSha256 !== TERRAFORM_SHA256, "terraform-hash");
  assertOwnedRegular(path.join(REPOSITORY_ROOT, "infra/scripts/dev-plan-lifecycle.mjs"), "live-code");
  assertOwnedRegular(path.join(REPOSITORY_ROOT, "infra/scripts/assert-dev-plan.mjs"), "live-code");
  const lifecycleSha256 = sha256File(path.join(REPOSITORY_ROOT, "infra/scripts/dev-plan-lifecycle.mjs"));
  const guardSha256 = sha256File(path.join(REPOSITORY_ROOT, "infra/scripts/assert-dev-plan.mjs"));
  const backend = parseBackendText(readFileSync(path.join(WORKING_DIRECTORY, "backend.hcl"), "utf8"));
  const backendSha256 = sha256Bytes(`${canonicalJson(backend)}\n`);
  const workspace = (await read(TERRAFORM_PATH, ["workspace", "show"], WORKING_DIRECTORY)).trim();
  const state = JSON.parse(await read(TERRAFORM_PATH, ["state", "pull"], WORKING_DIRECTORY));
  failIf(typeof state.lineage !== "string" || state.lineage.length === 0 || !Number.isSafeInteger(state.serial) || state.serial < 0, "live-state");
  const liveVaultResourceId = stateOutputValue(state, "key_vault_id");
  const liveVaultUri = stateOutputValue(state, "key_vault_uri");
  failIf(liveVaultResourceId !== descriptor.vaultResourceId || liveVaultUri !== descriptor.vaultUri, "live-vault");
  const liveRevision = stateOutputValue(state, "relay_latest_revision_name", false);
  failIf(liveRevision !== null && typeof liveRevision !== "string", "live-revision");
  const account = JSON.parse(await read(AZ_PATH, ["account", "show", "--output", "json"], "/"));
  const caller = JSON.parse(await read(AZ_PATH, ["ad", "signed-in-user", "show", "--output", "json"], "/"));
  const cloud = account.environmentName;
  const subscription = account.id;
  const tenant = account.tenantId;
  const objectId = caller.id ?? caller.objectId;
  failIf(cloud !== descriptor.cloud || subscription !== descriptor.subscription || tenant !== descriptor.tenant || objectId !== descriptor.callerIdentity.objectId, "live-identity");
  const azureContextHash = sha256Json({ cloud, subscription, tenant });
  const callerHash = sha256Json({ cloud, subscription, tenant, userType: account?.user?.type, objectId });
  return {
    ...bound,
    backend,
    backendSha256,
    backendConfigurationSha256: backendSha256,
    terraformSha256,
    lifecycleSha256,
    guardSha256,
    dependencyBlobs: dependencies,
    repositoryCommit,
    cwd: WORKING_DIRECTORY,
    workspace,
    stateLineage: state.lineage,
    stateSerial: state.serial,
    liveRevision,
    azureContextHash,
    callerHash,
  };
}

export async function productionContextReader(request) {
  return readProductionContext(request, EVIDENCE_ROOT, productionProcess);
}

export async function productionContextReaderForTests(request, options = {}) {
  failIf(!isObject(options), "test-context-reader-options");
  const processRunner = options.processRunner ?? productionProcess;
  failIf(typeof processRunner !== "function", "test-context-reader-runner");
  const evidenceRoot = options.root ?? EVIDENCE_ROOT;
  failIf(
    typeof evidenceRoot !== "string" || !path.isAbsolute(evidenceRoot) || path.normalize(evidenceRoot) !== evidenceRoot,
    "test-context-reader-root",
  );
  return readProductionContext(request, evidenceRoot, processRunner);
}

async function revalidateLiveContext(config, context, deadline) {
  const bound = context.lifecycle.manifest.bindings;
  const request = {
    phase: "credential-cleanup",
    runId: context.descriptor.runId,
    planSha256: context.descriptor.planSha256,
    bindingSha256: context.descriptor.bindingSha256,
    deadline,
    clock: config.now,
  };
  const controller = new AbortController();
  const initial = config.contextReader({ ...request, signal: controller.signal });
  const live = initial !== null && initial !== undefined && typeof initial.then === "function"
    ? await boundedPromise(config, () => initial, Math.min(TOKEN_TIMEOUT_MS, remaining(config, deadline)), "context-timeout", deadline, controller)
    : initial;
  const candidate = liveBindingValue(live);
  failIf(!isObject(candidate), "live-context-schema");
  // The lifecycle binding is the shared context schema.  Comparing the whole
  // closed object covers repository/code/dependency hashes, backend identity,
  // workspace/state lineage+serial, live revision, Azure cloud/account, and
  // caller identity in one operation before each access.
  failIf(canonicalJson(candidate) !== canonicalJson(bound), "live-context-drift");
}

function statePath(directory, sequence) {
  return artifactPath(directory, `cleanup-state-${String(sequence).padStart(6, "0")}.json`);
}

function stateHash(state) {
  const unsigned = { ...state };
  delete unsigned.stateSha256;
  return sha256Json(unsigned);
}

function mutationTailForCommitments(commitments) {
  const latest = commitments.at(-1);
  return latest === undefined
    ? { sequence: -1, sha256: null }
    : { sequence: latest.sequence, sha256: latest.value.intentFileSha256 };
}

function validateMutationTailShape(value, code) {
  failIf(!Number.isSafeInteger(value.mutationTailSequence) || value.mutationTailSequence < -1, `${code}-sequence`);
  if (value.mutationTailSequence === -1) {
    failIf(value.mutationTailSha256 !== null, `${code}-genesis`);
  } else {
    failIf(!isSha256(value.mutationTailSha256), `${code}-hash`);
  }
}

function validateMutationTailAgainstHistory(value, commitments, code) {
  validateMutationTailShape(value, code);
  if (value.mutationTailSequence === -1) return;
  const tail = commitments[value.mutationTailSequence];
  failIf(tail === undefined || tail.sequence !== value.mutationTailSequence, `${code}-history`);
  failIf(tail.value.intentFileSha256 !== value.mutationTailSha256, `${code}-history`);
}

function validateMutationTailTransition(previous, current) {
  failIf(current.mutationTailSequence < previous.mutationTailSequence, "mutation-tail-history");
  if (current.mutationTailSequence === previous.mutationTailSequence) {
    failIf(current.mutationTailSha256 !== previous.mutationTailSha256, "mutation-tail-history");
  }
}

function stateAnchorPath(directory, sequence) {
  return sequence === 0
    ? artifactPath(directory, STATE_ANCHOR_FILENAME)
    : artifactPath(directory, `cleanup-state-anchor-${String(sequence).padStart(6, "0")}.json`);
}

function validateStateAnchor(value, context, state, stateFilePath, anchorPath) {
  exactKeys(value, STATE_ANCHOR_KEYS, "state-anchor-schema");
  failIf(
    value.version !== 1 || value.type !== "key-vault-cleanup-state-anchor" ||
      value.runId !== context.descriptor.runId || value.phase !== "credential-cleanup" ||
      value.stateSequence !== state.sequence || value.stateSha256 !== state.stateSha256 ||
      value.manifestSha256 !== sha256File(context.operationPath) ||
      value.stateFileSha256 !== sha256File(stateFilePath) ||
      value.absenceReceiptSha256 !== state.absenceReceiptSha256 ||
      value.mutationTailSequence !== state.mutationTailSequence ||
      value.mutationTailSha256 !== state.mutationTailSha256 ||
      value.preflightReceiptSha256 !== state.preflightReceiptSha256 ||
      value.preflightVerifierId !== state.preflightVerifierId ||
      value.preflightVerifierSha256 !== state.preflightVerifierSha256 ||
      !isSha256(value.anchorSha256) ||
      value.anchorSha256 !== sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "anchorSha256"))),
    "state-anchor-context",
  );
  const match = path.basename(anchorPath).match(STATE_ANCHOR_SEQUENCE_RE);
  failIf(state.sequence > 0 && (!match || Number(match[1]) !== state.sequence), "state-anchor-sequence");
  failIf(state.sequence === 0 && path.basename(anchorPath) !== STATE_ANCHOR_FILENAME, "state-anchor-sequence");
}

function journalHeadPath(directory, sequence) {
  return artifactPath(directory, `cleanup-journal-head-${String(sequence).padStart(6, "0")}.json`);
}

function journalCommitmentDirectory(config, runId) {
  assertRunId(runId);
  const directory = path.join(config.root, JOURNAL_COMMITMENT_DIRECTORY_NAME, runId);
  failIf(path.dirname(directory) !== path.join(config.root, JOURNAL_COMMITMENT_DIRECTORY_NAME), "journal-commitment-path");
  return directory;
}

function journalCommitmentRelativePath(runId) {
  assertRunId(runId);
  return `${JOURNAL_COMMITMENT_DIRECTORY_NAME}/${runId}`;
}

function ensureJournalCommitmentDirectory(config, runId) {
  const parent = path.join(config.root, JOURNAL_COMMITMENT_DIRECTORY_NAME);
  if (!existsSync(parent)) mkdirSync(parent, { mode: DIRECTORY_MODE });
  assertDirectory(parent, "journal-commitment-parent");
  const directory = journalCommitmentDirectory(config, runId);
  if (!existsSync(directory)) mkdirSync(directory, { mode: DIRECTORY_MODE });
  assertDirectory(directory, "journal-commitment-directory");
  return directory;
}

function validateJournalCommitment(value, runId, sequence, filePath, previousFilePath) {
  exactKeys(value, JOURNAL_COMMITMENT_KEYS, "journal-commitment-schema");
  failIf(
    value.version !== 1 || value.type !== "key-vault-cleanup-journal-commitment" ||
      value.runId !== runId || value.phase !== "credential-cleanup" ||
      value.latestSequence !== sequence ||
      !isSha256(value.stateSha256) || !isSha256(value.stateFileSha256) ||
      !isSha256(value.anchorSha256) || !isSha256(value.headSha256) ||
      !isSha256(value.manifestSha256) ||
      (value.absenceReceiptSha256 !== null && !isSha256(value.absenceReceiptSha256)) ||
      (!Number.isSafeInteger(value.mutationTailSequence) || value.mutationTailSequence < -1) ||
      (value.mutationTailSequence === -1
        ? value.mutationTailSha256 !== null
        : !isSha256(value.mutationTailSha256)) ||
      (previousFilePath === undefined
        ? value.previousCommitmentSha256 !== null
        : value.previousCommitmentSha256 !== sha256File(previousFilePath)) ||
      !isSha256(value.commitmentSha256) ||
      (value.preflightReceiptSha256 !== null && !isSha256(value.preflightReceiptSha256)) ||
      (value.preflightReceiptSha256 === null
        ? value.preflightVerifierId !== null || value.preflightVerifierSha256 !== null
        : value.preflightVerifierId !== PREFLIGHT_VERIFIER_ID) ||
      (value.preflightVerifierSha256 !== null && !isSha256(value.preflightVerifierSha256)) ||
      value.commitmentSha256 !== sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "commitmentSha256"))),
    "journal-commitment-context",
  );
}

function readJournalCommitments(config, runId) {
  const history = readJournalCommitmentHistory(config, runId);
  return history.at(-1);
}

function readJournalCommitmentHistory(config, runId) {
  const parent = path.join(config.root, JOURNAL_COMMITMENT_DIRECTORY_NAME);
  if (existsSync(parent)) assertDirectory(parent, "journal-commitment-parent");
  const directory = journalCommitmentDirectory(config, runId);
  if (!existsSync(directory)) return [];
  assertDirectory(directory, "journal-commitment-directory");
  const entries = readdirSync(directory, { withFileTypes: true });
  const commitments = [];
  for (const entry of entries) {
    const match = JOURNAL_COMMITMENT_FILENAME_RE.exec(entry.name);
    if (!match) {
      failIf(
          !OPERATION_HEAD_ANCHOR_SEQUENCE_RE.test(entry.name) &&
          !OPERATION_HEAD_INTENT_SEQUENCE_RE.test(entry.name) &&
          !MUTATION_INTENT_FILENAME_RE.test(entry.name) &&
          !MUTATION_COMMITMENT_FILENAME_RE.test(entry.name),
        "journal-commitment-name",
      );
      continue;
    }
    failIf(entry.isSymbolicLink() || !entry.isFile(), "journal-commitment-file");
    const filePath = path.join(directory, entry.name);
    const sequence = Number(match[1]);
    const value = readJson(filePath, "journal-commitment");
    commitments.push({ filePath, sequence, value });
  }
  commitments.sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < commitments.length; index += 1) {
    const current = commitments[index];
    failIf(current.sequence !== index, "journal-commitment-history");
    validateJournalCommitment(
      current.value,
      runId,
      current.sequence,
      current.filePath,
      index === 0 ? undefined : commitments[index - 1].filePath,
    );
  }
  return commitments;
}

function validateMutationIntentShape(value, context, previousIntentSha256) {
  exactKeys(value, MUTATION_INTENT_KEYS, "mutation-intent-schema");
  const sequence = Number(value.sequence);
  failIf(
    value.version !== 1 || value.type !== "key-vault-cleanup-mutation-intent" ||
      value.runId !== context.descriptor.runId || value.phase !== "credential-cleanup" ||
      !Number.isSafeInteger(sequence) || sequence < 0 ||
      !TARGET_SECRET_NAMES.includes(value.target) || !["delete", "purge"].includes(value.action) ||
      value.contextSha256 !== context.descriptor.contextSha256 ||
      !Number.isSafeInteger(value.stateSequence) || value.stateSequence < 0 || !isSha256(value.stateSha256) ||
      !isSha256(value.journalCommitmentSha256) ||
      !isSha256(value.preflightReceiptSha256) || value.preflightVerifierId !== PREFLIGHT_VERIFIER_ID ||
      !isSha256(value.preflightVerifierSha256) || value.preflightVerifierSha256 !== context.operation.utilitySha256 ||
      !Number.isFinite(Date.parse(value.preflightCreatedAt)) || !Number.isFinite(Date.parse(value.preflightDeadlineAt)) ||
      Date.parse(value.preflightDeadlineAt) <= Date.parse(value.preflightCreatedAt) ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      (previousIntentSha256 === undefined
        ? value.previousIntentSha256 !== null
        : value.previousIntentSha256 !== previousIntentSha256) ||
      !isSha256(value.intentSha256) ||
      value.intentSha256 !== sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "intentSha256"))),
    "mutation-intent-context",
  );
  return value;
}

function validateMutationCommitment(value, context, filePath, previousFilePath, previousValue) {
  exactKeys(value, MUTATION_COMMITMENT_KEYS, "mutation-commitment-schema");
  exactKeys(value.intent, MUTATION_INTENT_KEYS, "mutation-commitment-intent-schema");
  const sequence = Number(value.sequence);
  failIf(
    value.version !== 1 || value.type !== "key-vault-cleanup-mutation-commitment" ||
      value.runId !== context.descriptor.runId || value.phase !== "credential-cleanup" ||
      !Number.isSafeInteger(sequence) || sequence < 0 || value.intent.sequence !== sequence ||
      !isSha256(value.intentSha256) || value.intentSha256 !== value.intent.intentSha256 ||
      !isSha256(value.intentFileSha256) || value.intentFileSha256 !== sha256Bytes(`${canonicalJson(value.intent)}\n`) ||
      (previousFilePath === undefined
        ? value.previousCommitmentSha256 !== null
        : value.previousCommitmentSha256 !== sha256File(previousFilePath)) ||
      !isSha256(value.commitmentSha256) ||
      value.commitmentSha256 !== sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "commitmentSha256"))),
    "mutation-commitment-context",
  );
  validateMutationIntentShape(
    value.intent,
    context,
    previousValue === undefined ? undefined : previousValue.intentFileSha256,
  );
  if (previousValue !== undefined) {
    failIf(value.intent.previousIntentSha256 !== previousValue.intentFileSha256, "mutation-commitment-history");
  }
  const match = MUTATION_COMMITMENT_FILENAME_RE.exec(path.basename(filePath));
  failIf(!match || Number(match[1]) !== sequence, "mutation-commitment-sequence");
  return value;
}

function readMutationCommitmentHistory(config, context) {
  const directory = journalCommitmentDirectory(config, context.descriptor.runId);
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true });
  const commitments = [];
  for (const entry of entries) {
    const match = MUTATION_COMMITMENT_FILENAME_RE.exec(entry.name);
    if (!match) continue;
    failIf(entry.isSymbolicLink() || !entry.isFile(), "mutation-commitment-file");
    const filePath = path.join(directory, entry.name);
    commitments.push({
      sequence: Number(match[1]),
      filePath,
      value: readJson(filePath, "mutation-commitment"),
    });
  }
  commitments.sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < commitments.length; index += 1) {
    const current = commitments[index];
    failIf(current.sequence !== index, "mutation-commitment-history");
    validateMutationCommitment(
      current.value,
      context,
      current.filePath,
      index === 0 ? undefined : commitments[index - 1].filePath,
      index === 0 ? undefined : commitments[index - 1].value,
    );
  }
  return commitments;
}

function readMutationIntents(config, context) {
  const directory = journalCommitmentDirectory(config, context.descriptor.runId);
  if (!existsSync(directory)) return [];
  let commitments = readMutationCommitmentHistory(config, context);
  const journalCommitments = readJournalCommitmentHistory(config, context.descriptor.runId);
  const entries = readdirSync(directory, { withFileTypes: true });
  const intents = [];
  for (const entry of entries) {
    const match = MUTATION_INTENT_FILENAME_RE.exec(entry.name);
    if (!match) continue;
    failIf(entry.isSymbolicLink() || !entry.isFile(), "mutation-intent-file");
    const filePath = path.join(directory, entry.name);
    intents.push({
      sequence: Number(match[1]),
      filePath,
      value: readJson(filePath, "mutation-intent"),
    });
  }
  intents.sort((left, right) => left.sequence - right.sequence);
  if (commitments.length > intents.length) {
    failIf(commitments.length !== intents.length + 1, "mutation-intent-pending");
    const pending = commitments.at(-1);
    failIf(
      journalCommitments.some(
        (candidate) => candidate.value.mutationTailSequence === pending.sequence &&
          candidate.value.mutationTailSha256 === pending.value.intentFileSha256,
      ),
      "mutation-intent-deleted",
    );
    const pendingPath = path.join(directory, `cleanup-mutation-intent-${String(pending.sequence).padStart(6, "0")}.json`);
    if (!existsSync(pendingPath)) exclusiveJson(config, pendingPath, pending.value.intent, "mutation-intent-reconcile");
    commitments = readMutationCommitmentHistory(config, context);
    intents.push({ sequence: pending.sequence, filePath: pendingPath, value: readJson(pendingPath, "mutation-intent") });
  }
  failIf(intents.length !== commitments.length, "mutation-intent-journal");
  for (let index = 0; index < intents.length; index += 1) {
    failIf(intents[index].sequence !== index, "mutation-intent-history");
    validateMutationIntentShape(
      intents[index].value,
      context,
      index === 0 ? undefined : sha256File(intents[index - 1].filePath),
    );
    const journalCommitment = journalCommitments.find(
      (candidate) => sha256File(candidate.filePath) === intents[index].value.journalCommitmentSha256,
    );
    if (journalCommitment !== undefined) {
      validateMutationTailAgainstHistory(
        journalCommitment.value,
        commitments,
        "mutation-intent-journal-tail",
      );
    }
    failIf(
      journalCommitment === undefined ||
        journalCommitment.sequence !== intents[index].value.stateSequence ||
        journalCommitment.value.stateSha256 !== intents[index].value.stateSha256 ||
        journalCommitment.value.mutationTailSequence >= intents[index].sequence ||
        commitments[index].value.intentSha256 !== intents[index].value.intentSha256 ||
        commitments[index].value.intentFileSha256 !== sha256File(intents[index].filePath) ||
        canonicalJson(commitments[index].value.intent) !== canonicalJson(intents[index].value),
      "mutation-intent-journal",
    );
  }
  return intents;
}

function publishMutationIntent(config, context, state, target, action, preflight) {
  const commitments = readJournalCommitmentHistory(config, context.descriptor.runId);
  const latest = commitments.at(-1);
  failIf(latest === undefined || latest.sequence !== state.sequence || latest.value.stateSha256 !== state.stateSha256, "mutation-intent-journal");
  const existingIntents = readMutationIntents(config, context);
  const mutationCommitments = readMutationCommitmentHistory(config, context);
  const existing = existingIntents.at(-1);
  const sequence = existing === undefined ? 0 : existing.sequence + 1;
  const previousFilePath = existing?.filePath;
  const value = {
    version: 1,
    type: "key-vault-cleanup-mutation-intent",
    runId: context.descriptor.runId,
    phase: "credential-cleanup",
    sequence,
    target,
    action,
    contextSha256: context.descriptor.contextSha256,
    stateSequence: state.sequence,
    stateSha256: state.stateSha256,
    journalCommitmentSha256: sha256File(latest.filePath),
    preflightReceiptSha256: preflight.receiptSha256,
    preflightVerifierId: preflight.verifierId,
    preflightVerifierSha256: preflight.verifierSha256,
    preflightCreatedAt: preflight.raw.createdAt,
    preflightDeadlineAt: preflight.raw.deadlineAt,
    createdAt: new Date(config.wallNow()).toISOString(),
    previousIntentSha256: previousFilePath === undefined ? null : sha256File(previousFilePath),
    intentSha256: null,
  };
  value.intentSha256 = sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "intentSha256")));
  const directory = ensureJournalCommitmentDirectory(config, context.descriptor.runId);
  const filePath = path.join(directory, `cleanup-mutation-intent-${String(sequence).padStart(6, "0")}.json`);
  const commitmentPath = path.join(directory, `cleanup-mutation-commitment-${String(sequence).padStart(6, "0")}.json`);
  const commitment = {
    version: 1,
    type: "key-vault-cleanup-mutation-commitment",
    runId: context.descriptor.runId,
    phase: "credential-cleanup",
    sequence,
    intent: value,
    intentSha256: value.intentSha256,
    intentFileSha256: sha256Bytes(`${canonicalJson(value)}\n`),
    previousCommitmentSha256: mutationCommitments.length === 0 ? null : sha256File(mutationCommitments.at(-1).filePath),
    commitmentSha256: null,
  };
  commitment.commitmentSha256 = sha256Json(Object.fromEntries(Object.entries(commitment).filter(([key]) => key !== "commitmentSha256")));
  exclusiveJson(config, commitmentPath, commitment, "mutation-commitment");
  exclusiveJson(config, filePath, value, "mutation-intent");
  const published = readMutationIntents(config, context).at(-1);
  failIf(published === undefined || published.value.intentSha256 !== value.intentSha256, "mutation-intent-publication");
  return { filePath, value };
}

function validateJournalCommitmentCheckpoint(commitment, context, state, anchorPath, headPath, mutationCommitments) {
  failIf(commitment === undefined, "journal-commitment-missing");
  validateMutationTailAgainstHistory(commitment.value, mutationCommitments, "journal-commitment-tail");
  failIf(
    commitment.sequence !== state.sequence ||
      commitment.value.latestSequence !== state.sequence ||
      commitment.value.stateSha256 !== state.stateSha256 ||
      commitment.value.stateFileSha256 !== sha256File(statePath(context.directory, state.sequence)) ||
      commitment.value.anchorSha256 !== sha256File(anchorPath) ||
      commitment.value.headSha256 !== sha256File(headPath) ||
      commitment.value.manifestSha256 !== sha256File(context.operationPath) ||
      commitment.value.absenceReceiptSha256 !== state.absenceReceiptSha256 ||
      commitment.value.mutationTailSequence !== state.mutationTailSequence ||
      commitment.value.mutationTailSha256 !== state.mutationTailSha256 ||
      commitment.value.preflightReceiptSha256 !== state.preflightReceiptSha256 ||
      commitment.value.preflightVerifierId !== state.preflightVerifierId ||
      commitment.value.preflightVerifierSha256 !== state.preflightVerifierSha256,
    "journal-commitment-tail",
  );
}

function validateJournalTailCommitment(config, context, state, anchorPath, headPath, mutationCommitments) {
  const latest = readJournalCommitments(config, context.descriptor.runId);
  validateJournalCommitmentCheckpoint(latest, context, state, anchorPath, headPath, mutationCommitments);
  return latest;
}

function validateJournalHead(value, context, state, stateFilePath, headPath, previousHeadPath) {
  exactKeys(value, JOURNAL_HEAD_KEYS, "journal-head-schema");
  failIf(
    value.version !== 1 || value.type !== "key-vault-cleanup-journal-head" ||
      value.runId !== context.descriptor.runId || value.phase !== "credential-cleanup" ||
      value.stateSequence !== state.sequence || value.stateSha256 !== state.stateSha256 ||
      value.stateFileSha256 !== sha256File(stateFilePath) ||
      value.manifestSha256 !== sha256File(context.operationPath) ||
      value.absenceReceiptSha256 !== state.absenceReceiptSha256 ||
      value.mutationTailSequence !== state.mutationTailSequence ||
      value.mutationTailSha256 !== state.mutationTailSha256 ||
      (state.sequence === 0 ? value.previousHeadSha256 !== null : value.previousHeadSha256 !== sha256File(previousHeadPath)) ||
      value.preflightReceiptSha256 !== state.preflightReceiptSha256 ||
      value.preflightVerifierId !== state.preflightVerifierId ||
      value.preflightVerifierSha256 !== state.preflightVerifierSha256 ||
      !isSha256(value.headSha256) ||
      value.headSha256 !== sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "headSha256"))),
    "journal-head-context",
  );
  const match = JOURNAL_HEAD_SEQUENCE_RE.exec(path.basename(headPath));
  failIf(!match || Number(match[1]) !== state.sequence, "journal-head-sequence");
}

function validateStateShape(value, context, filePath, previousFilePath) {
  exactKeys(value, STATE_KEYS, "state-schema");
  failIf(value.version !== 1 || value.type !== "key-vault-cleanup-state" || value.runId !== context.descriptor.runId || value.phase !== "credential-cleanup", "state-context");
  assertFiniteInteger(value.sequence, "state-sequence");
  failIf(!STATES.includes(value.status), "state-status");
  assertFiniteInteger(value.attempts, "state-attempts");
  failIf(value.attempts > MUTATION_ATTEMPT_LIMIT, "state-attempts");
  assertFiniteInteger(value.cumulativeElapsedMs, "state-elapsed");
  failIf(value.cumulativeElapsedMs > CUMULATIVE_ELAPSED_LIMIT_MS, "state-elapsed");
  for (const [field, code] of [["operationStartedAt", "state-operation-time"], ["accountingCursor", "state-accounting-time"]]) assertTimestamp(value[field], code);
  for (const [field, code] of [["attemptStartedAt", "state-attempt-time"], ["retryNotBefore", "state-retry-time"]]) {
    failIf(value[field] !== null && !Number.isFinite(value[field]), code);
  }
  if (value.absenceReceiptSha256 !== null) failIf(!isSha256(value.absenceReceiptSha256), "state-absence-hash");
  if (value.absenceReceiptSha256 !== null) {
    const receiptPath = artifactPath(context.directory, ABSENCE_RECEIPT_FILENAME);
    assertRegular(receiptPath, "absence-receipt");
    failIf(sha256File(receiptPath) !== value.absenceReceiptSha256, "absence-receipt-linkage");
    const receipt = validateAbsenceReceipt(readJson(receiptPath, "absence-receipt"), context);
    failIf(
      receipt.mutationTailSequence !== value.mutationTailSequence ||
        receipt.mutationTailSha256 !== value.mutationTailSha256,
      "absence-receipt-linkage",
    );
  }
  validateTerminalInventory(value.inventory, "state-inventory");
  failIf(value.inventorySha256 !== sha256Json(value.inventory), "state-inventory-hash");
  failIf(value.manifestSha256 !== sha256File(context.operationPath), "state-manifest-hash");
  validateMutationTailShape(value, "state-mutation-tail");
  failIf(value.preflightReceiptSha256 === null
    ? value.preflightVerifierId !== null || value.preflightVerifierSha256 !== null
    : !isSha256(value.preflightReceiptSha256) || value.preflightVerifierId !== PREFLIGHT_VERIFIER_ID || value.preflightVerifierSha256 !== context.operation.utilitySha256, "state-preflight-verifier");
  if (previousFilePath === undefined) failIf(value.previousStateSha256 !== null, "state-history");
  else failIf(value.previousStateSha256 !== sha256File(previousFilePath), "state-history");
  failIf(!isSha256(value.stateSha256) || value.stateSha256 !== stateHash(value), "state-integrity");
  if (filePath !== undefined) {
    const match = STATE_FILENAME_RE.exec(path.basename(filePath));
    failIf(!match || Number(match[1]) !== value.sequence, "state-sequence");
  }
}

function validateStateTransition(previous, current) {
  if (current.sequence === 0) {
    failIf(current.mutationTailSequence !== -1 || current.mutationTailSha256 !== null, "mutation-tail-history");
    if (current.status === "complete") {
      failIf(current.status !== "complete" || current.attempts !== 0 || current.attemptStartedAt !== null || current.retryNotBefore !== null || !isSha256(current.absenceReceiptSha256) || current.previousStateSha256 !== null, "state-transition");
      failIf(current.inventory.targetStates.some((item) => item.state !== "absent"), "state-terminal-inventory");
    } else {
      failIf(current.status !== "start-inventory-validated" || current.attempts !== 0 || current.attemptStartedAt !== null || current.retryNotBefore !== null || current.absenceReceiptSha256 !== null || current.previousStateSha256 !== null, "state-transition");
      failIf(current.inventory.targetStates.some((item) => item.state !== "active"), "state-start-inventory");
    }
    return;
  }
  validateMutationTailTransition(previous, current);
  failIf(previous.status === "complete", "state-terminal");
  if (current.status === "attempting") {
    failIf(!["start-inventory-validated", "attempting", "unknown"].includes(previous.status) || current.attempts !== previous.attempts + 1 || current.attemptStartedAt === null || current.retryNotBefore !== null || current.absenceReceiptSha256 !== null, "state-transition");
  } else if (current.status === "unknown") {
    failIf(previous.status !== "attempting" || current.attempts !== previous.attempts || current.attemptStartedAt !== null || current.retryNotBefore === null || current.absenceReceiptSha256 !== null, "state-transition");
    failIf(current.retryNotBefore < current.accountingCursor + RETRY_BACKOFF_MS, "state-backoff");
  } else if (current.status === "complete") {
    failIf(!["start-inventory-validated", "attempting", "unknown"].includes(previous.status) || current.attempts !== previous.attempts || current.attemptStartedAt !== null || current.retryNotBefore !== null || !isSha256(current.absenceReceiptSha256), "state-transition");
  } else {
    reject("state-transition");
  }
  failIf(current.cumulativeElapsedMs < previous.cumulativeElapsedMs, "state-elapsed");
}

function reconcileJournalPublication(config, context) {
  const latestCommitment = readJournalCommitments(config, context.descriptor.runId);
  const committedSequence = latestCommitment?.sequence ?? -1;
  const entries = readdirSync(context.directory, { withFileTypes: true });
  const states = entries
    .map((entry) => {
      const match = STATE_FILENAME_RE.exec(entry.name);
      return match === null ? undefined : { entry, sequence: Number(match[1]), filePath: artifactPath(context.directory, entry.name) };
    })
    .filter((value) => value !== undefined)
    .sort((left, right) => left.sequence - right.sequence);
  if (states.length === 0 || states.at(-1).sequence <= committedSequence) return;
  failIf(states.at(-1).sequence !== committedSequence + 1 || states.length !== committedSequence + 2, "state-history");
  const candidate = states.at(-1);
  failIf(candidate.entry.isSymbolicLink() || !candidate.entry.isFile(), "state-symlink");
  const previousPath = committedSequence < 0 ? undefined : statePath(context.directory, committedSequence);
  const previous = committedSequence < 0 ? undefined : readJson(previousPath, "state");
  const current = readJson(candidate.filePath, "state");
  validateStateShape(current, context, candidate.filePath, previousPath);
  if (previous !== undefined) validateStateTransition(previous, current);

  const headPath = journalHeadPath(context.directory, candidate.sequence);
  const previousHeadPath = candidate.sequence === 0 ? undefined : journalHeadPath(context.directory, candidate.sequence - 1);
  if (existsSync(headPath)) {
    validateJournalHead(readJson(headPath, "journal-head"), context, current, candidate.filePath, headPath, previousHeadPath);
  } else {
    writeJournalHead(config, context, current);
  }
  const anchorPath = stateAnchorPath(context.directory, candidate.sequence);
  if (existsSync(anchorPath)) {
    validateStateAnchor(readJson(anchorPath, "state-anchor"), context, current, candidate.filePath, anchorPath);
  } else {
    writeStateAnchor(config, context, current);
  }
  const committed = readJournalCommitments(config, context.descriptor.runId);
  if (committed === undefined || committed.sequence < candidate.sequence) writeJournalCommitment(config, context, current);
}

function readStateFiles(config, context) {
  reconcileJournalPublication(config, context);
  readMutationIntents(config, context);
  const mutationCommitments = readMutationCommitmentHistory(config, context);
  const journalCommitments = readJournalCommitmentHistory(config, context.descriptor.runId);
  const entries = readdirSync(context.directory, { withFileTypes: true });
  const states = [];
  const anchors = new Map();
  const journalHeads = new Map();
  for (const entry of entries) {
    if (entry.name === STATE_ANCHOR_FILENAME) {
      failIf(entry.isSymbolicLink(), "state-anchor-symlink");
      failIf(anchors.has(0), "state-history");
      anchors.set(0, artifactPath(context.directory, entry.name));
      continue;
    }
    const match = STATE_FILENAME_RE.exec(entry.name);
    const anchorMatch = STATE_ANCHOR_SEQUENCE_RE.exec(entry.name);
    if (anchorMatch) {
      failIf(entry.isSymbolicLink(), "state-anchor-symlink");
      failIf(Number(anchorMatch[1]) === 0 || anchors.has(Number(anchorMatch[1])), "state-history");
      anchors.set(Number(anchorMatch[1]), artifactPath(context.directory, entry.name));
      continue;
    }
    const headMatch = JOURNAL_HEAD_SEQUENCE_RE.exec(entry.name);
    if (headMatch) {
      failIf(entry.isSymbolicLink(), "journal-head-symlink");
      journalHeads.set(Number(headMatch[1]), artifactPath(context.directory, entry.name));
      continue;
    }
    if (!match && entry.name.startsWith("cleanup-state-")) reject("state-name");
    if (!JOURNAL_HEAD_SEQUENCE_RE.test(entry.name) && entry.name.startsWith("cleanup-journal-head-")) reject("journal-head-name");
    if (!match) continue;
    failIf(entry.isSymbolicLink(), "state-symlink");
    const filePath = artifactPath(context.directory, entry.name);
    const value = readJson(filePath, "state");
    states.push({ filePath, value });
  }
  states.sort((left, right) => left.value.sequence - right.value.sequence);
  for (let index = 0; index < states.length; index += 1) {
    failIf(states[index].value.sequence !== index, "state-sequence");
    validateMutationTailAgainstHistory(states[index].value, mutationCommitments, "state-mutation-tail");
    validateStateShape(states[index].value, context, states[index].filePath, index === 0 ? undefined : states[index - 1].filePath);
    if (index > 0) validateStateTransition(states[index - 1].value, states[index].value);
  }
  if (states.length === 0 && (anchors.size > 0 || journalHeads.size > 0)) reject("state-history");
  if (states.length > 0) {
    failIf(anchors.size !== states.length, "state-history");
    failIf(journalHeads.size !== states.length, "state-history");
    for (let index = 0; index < states.length; index += 1) {
      const anchorPath = anchors.get(index);
      failIf(anchorPath === undefined, "state-history");
      const anchor = readJson(anchorPath, "state-anchor");
      validateStateAnchor(anchor, context, states[index].value, states[index].filePath, anchorPath);
      const headPath = journalHeads.get(index);
      failIf(headPath === undefined, "state-history");
      const previousHeadPath = index === 0 ? undefined : journalHeads.get(index - 1);
      failIf(index > 0 && previousHeadPath === undefined, "state-history");
      const head = readJson(headPath, "journal-head");
      validateJournalHead(head, context, states[index].value, states[index].filePath, headPath, previousHeadPath);
      validateJournalCommitmentCheckpoint(
        journalCommitments[index],
        context,
        states[index].value,
        anchorPath,
        headPath,
        mutationCommitments,
      );
    }
    const tailIndex = states.length - 1;
    validateJournalTailCommitment(
      config,
      context,
      states[tailIndex].value,
      anchors.get(tailIndex),
      journalHeads.get(tailIndex),
      mutationCommitments,
    );
  } else if (journalCommitments.length > 0) {
    reject("state-history");
  }
  if (states.length > 0 && states.at(-1).value.status === "complete") {
    failIf(states.length !== states.findIndex((entry) => entry.value.status === "complete") + 1, "state-terminal");
  }
  if (states.length === 0) {
    return {
      version: 1,
      type: "key-vault-cleanup-state",
      runId: context.descriptor.runId,
      phase: "credential-cleanup",
      sequence: -1,
      status: "prepared",
      attempts: 0,
      cumulativeElapsedMs: 0,
      attemptStartedAt: null,
      operationStartedAt: 0,
      accountingCursor: 0,
      retryNotBefore: null,
      absenceReceiptSha256: null,
      manifestSha256: sha256File(context.operationPath),
      inventory: null,
      inventorySha256: null,
      previousStateSha256: null,
      preflightReceiptSha256: null,
      preflightVerifierId: null,
      preflightVerifierSha256: null,
      stateSha256: null,
    };
  }
  return states.at(-1).value;
}

function writeStateAnchor(config, context, state) {
  const anchorPath = stateAnchorPath(context.directory, state.sequence);
  failIf(existsSync(anchorPath), "state-anchor-exists");
  const stateFilePath = statePath(context.directory, state.sequence);
  const value = {
    version: 1,
    type: "key-vault-cleanup-state-anchor",
    runId: context.descriptor.runId,
    phase: "credential-cleanup",
    stateSequence: state.sequence,
    stateSha256: state.stateSha256,
    stateFileSha256: sha256File(stateFilePath),
    manifestSha256: sha256File(context.operationPath),
    absenceReceiptSha256: state.absenceReceiptSha256,
    mutationTailSequence: state.mutationTailSequence,
    mutationTailSha256: state.mutationTailSha256,
    preflightReceiptSha256: state.preflightReceiptSha256,
    preflightVerifierId: state.preflightVerifierId,
    preflightVerifierSha256: state.preflightVerifierSha256,
    anchorSha256: null,
  };
  value.anchorSha256 = sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "anchorSha256")));
  exclusiveJson(config, anchorPath, {
    ...value,
  }, "state-anchor");
}

function writeJournalHead(config, context, state) {
  const headPath = journalHeadPath(context.directory, state.sequence);
  failIf(existsSync(headPath), "journal-head-exists");
  const previousHeadPath = state.sequence === 0 ? undefined : journalHeadPath(context.directory, state.sequence - 1);
  if (previousHeadPath !== undefined) assertRegular(previousHeadPath, "journal-head-previous");
  const stateFilePath = statePath(context.directory, state.sequence);
  const value = {
    version: 1,
    type: "key-vault-cleanup-journal-head",
    runId: context.descriptor.runId,
    phase: "credential-cleanup",
    stateSequence: state.sequence,
    stateSha256: state.stateSha256,
    stateFileSha256: sha256File(stateFilePath),
    manifestSha256: sha256File(context.operationPath),
    absenceReceiptSha256: state.absenceReceiptSha256,
    mutationTailSequence: state.mutationTailSequence,
    mutationTailSha256: state.mutationTailSha256,
    preflightReceiptSha256: state.preflightReceiptSha256,
    preflightVerifierId: state.preflightVerifierId,
    preflightVerifierSha256: state.preflightVerifierSha256,
    previousHeadSha256: previousHeadPath === undefined ? null : sha256File(previousHeadPath),
    headSha256: null,
  };
  value.headSha256 = sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "headSha256")));
  exclusiveJson(config, headPath, value, "journal-head");
}

function writeJournalCommitment(config, context, state) {
  const directory = ensureJournalCommitmentDirectory(config, context.descriptor.runId);
  const filePath = path.join(directory, `cleanup-journal-commitment-${String(state.sequence).padStart(6, "0")}.json`);
  failIf(existsSync(filePath), "journal-commitment-exists");
  const previousFilePath = state.sequence === 0
    ? undefined
    : path.join(directory, `cleanup-journal-commitment-${String(state.sequence - 1).padStart(6, "0")}.json`);
  if (previousFilePath !== undefined) assertRegular(previousFilePath, "journal-commitment-previous");
  const anchorPath = stateAnchorPath(context.directory, state.sequence);
  const headPath = journalHeadPath(context.directory, state.sequence);
  const value = {
    version: 1,
    type: "key-vault-cleanup-journal-commitment",
    runId: context.descriptor.runId,
    phase: "credential-cleanup",
    latestSequence: state.sequence,
    stateSha256: state.stateSha256,
    stateFileSha256: sha256File(statePath(context.directory, state.sequence)),
    anchorSha256: sha256File(anchorPath),
    headSha256: sha256File(headPath),
    manifestSha256: sha256File(context.operationPath),
    absenceReceiptSha256: state.absenceReceiptSha256,
    mutationTailSequence: state.mutationTailSequence,
    mutationTailSha256: state.mutationTailSha256,
    preflightReceiptSha256: state.preflightReceiptSha256,
    preflightVerifierId: state.preflightVerifierId,
    preflightVerifierSha256: state.preflightVerifierSha256,
    previousCommitmentSha256: previousFilePath === undefined ? null : sha256File(previousFilePath),
    commitmentSha256: null,
  };
  value.commitmentSha256 = sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "commitmentSha256")));
  exclusiveJson(config, filePath, value, "journal-commitment");
  return { filePath, value };
}

function writeState(config, context, previous, patch) {
  const mutationTail = mutationTailForCommitments(readMutationCommitmentHistory(config, context));
  const next = {
    version: 1,
    type: "key-vault-cleanup-state",
    runId: context.descriptor.runId,
    phase: "credential-cleanup",
    sequence: previous.sequence + 1,
    status: patch.status,
    attempts: patch.attempts,
    cumulativeElapsedMs: patch.cumulativeElapsedMs,
    attemptStartedAt: patch.attemptStartedAt ?? null,
    operationStartedAt: patch.operationStartedAt ?? previous.operationStartedAt,
    accountingCursor: patch.accountingCursor ?? config.now(),
    retryNotBefore: patch.retryNotBefore ?? null,
    absenceReceiptSha256: patch.absenceReceiptSha256 ?? null,
    manifestSha256: sha256File(context.operationPath),
    inventory: patch.inventory ?? previous.inventory,
    inventorySha256: null,
    previousStateSha256: previous.sequence < 0 ? null : sha256File(statePath(context.directory, previous.sequence)),
    mutationTailSequence: mutationTail.sequence,
    mutationTailSha256: mutationTail.sha256,
    ...preflightFields(patch.preflight ?? (previous.preflightReceiptSha256 === null ? null : {
      receiptSha256: previous.preflightReceiptSha256,
      verifierId: previous.preflightVerifierId,
      verifierSha256: previous.preflightVerifierSha256,
    })),
    stateSha256: null,
  };
  assertFiniteInteger(next.attempts, "state-attempts");
  failIf(next.attempts > MUTATION_ATTEMPT_LIMIT, "attempt-ceiling");
  assertFiniteInteger(next.cumulativeElapsedMs, "state-elapsed");
  failIf(next.cumulativeElapsedMs > CUMULATIVE_ELAPSED_LIMIT_MS, "elapsed-ceiling");
  validateTerminalInventory(next.inventory, "state-inventory");
  next.inventorySha256 = sha256Json(next.inventory);
  next.stateSha256 = stateHash(next);
  exclusiveJson(config, statePath(context.directory, next.sequence), next, "state");
  writeJournalHead(config, context, next);
  try {
    writeStateAnchor(config, context, next);
  } catch (error) {
    // A fault after the anchor's no-replace publication but before the caller
    // observes success still leaves a complete triple.  Commit that durable
    // triple before propagating the fault; a process kill cannot reach this
    // recovery path and therefore remains fail-closed.
    try {
      const anchorPath = stateAnchorPath(context.directory, next.sequence);
      if (existsSync(anchorPath)) {
        validateStateAnchor(
          readJson(anchorPath, "state-anchor"),
          context,
          next,
          statePath(context.directory, next.sequence),
          anchorPath,
        );
        writeJournalCommitment(config, context, next);
      }
    } catch {
      // Preserve the publication fault and fail closed if the triple is not
      // complete enough for an external commitment.
    }
    throw error;
  }
  writeJournalCommitment(config, context, next);
  return next;
}

function currentElapsed(state, now) {
  failIf(!Number.isFinite(now) || now < state.accountingCursor, "clock-regression");
  return state.cumulativeElapsedMs + (now - state.accountingCursor);
}

function assertMutationBudget(state, now) {
  failIf(currentElapsed(state, now) >= CUMULATIVE_ELAPSED_LIMIT_MS, "elapsed-ceiling");
}

function assertWithinDeadline(config, deadline) {
  failIf(config.now() >= deadline, "invocation-deadline");
}

function remaining(config, deadline) {
  const value = deadline - config.now();
  failIf(value <= 0, "invocation-deadline");
  return value;
}

function requireRemaining(config, deadline, minimum = 1, code = "invocation-deadline") {
  const value = deadline - config.now();
  failIf(value < minimum, code);
  return value;
}

async function sleep(config, milliseconds, deadline) {
  assertWithinDeadline(config, deadline);
  failIf(remaining(config, deadline) < milliseconds, "invocation-deadline");
  const controller = new AbortController();
  let timer;
  let settled = false;
  const operation = Promise.resolve().then(() => config.sleep(milliseconds, controller.signal));
  await new Promise((resolve, rejectPromise) => {
    timer = config.setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      rejectPromise(new CleanupError("invocation-deadline"));
    }, remaining(config, deadline));
    operation.then(
      () => {
        if (settled) return;
        settled = true;
        config.clearTimeout(timer);
        resolve();
      },
      (error) => {
        if (settled) return;
        settled = true;
        config.clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
  assertWithinDeadline(config, deadline);
}

function boundedPromise(config, operation, milliseconds, code, deadline = undefined, externalController = undefined) {
  return new Promise((resolve, rejectPromise) => {
    const controller = externalController ?? new AbortController();
    let settled = false;
    const timeout = deadline === undefined ? milliseconds : Math.min(milliseconds, Math.max(0, deadline - config.now()));
    if (timeout <= 0) {
      controller.abort();
      rejectPromise(new CleanupError("invocation-deadline"));
      return;
    }
    const timer = config.setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      rejectPromise(new CleanupError(deadline !== undefined && deadline - config.now() <= 0 ? "invocation-deadline" : code));
    }, timeout);
    Promise.resolve().then(() => operation(controller.signal)).then(
      (value) => {
        if (settled) return;
        if (deadline !== undefined && deadline - config.now() <= 0) {
          settled = true;
          controller.abort();
          config.clearTimeout(timer);
          rejectPromise(new CleanupError("invocation-deadline"));
          return;
        }
        settled = true;
        config.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        config.clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function decodeJwtClaims(token) {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isObject(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

function validateToken(token, context, resource, code, now) {
  failIf(typeof token !== "string" || token.length === 0, `${code}-missing`);
  const claims = decodeJwtClaims(token);
  failIf(!claims, `${code}-claims`);
  failIf(claims.tid !== context.descriptor.tenant || claims.oid !== context.descriptor.callerIdentity.objectId || claims.idtyp !== "user", `${code}-identity`);
  const expectedAudiences = resource === context.descriptor.cloudDescriptor.keyVaultResource
    ? context.descriptor.cloudDescriptor.keyVaultAudiences
    : resource === AZURE_MANAGEMENT_RESOURCE
      ? [AZURE_MANAGEMENT_RESOURCE]
      : [];
  failIf(typeof claims.aud !== "string" || !expectedAudiences.includes(claims.aud), `${code}-audience`);
  failIf(!Number.isFinite(claims.exp) || claims.exp <= Math.floor(now / 1000), `${code}-expired`);
  return token;
}

function parseCommandResult(result, code) {
  failIf(!isObject(result) || result.timedOut === true || result.status === null, `${code}-timeout`);
  const status = Number.isInteger(result.exitCode) ? result.exitCode : result.status;
  failIf(status !== 0, `${code}-failed`);
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
  failIf(typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT_BYTES, `${code}-output`);
  return stdout;
}

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may already have exited.
    }
  }
}

export function productionProcess(request) {
  return new Promise((resolve, rejectProcess) => {
    let child;
    try {
      validateProductionCwd(request.cwd);
    } catch (error) {
      rejectProcess(error);
      return;
    }
    try {
      child = spawn(request.command, request.argv, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch {
      resolve({ status: null, timedOut: true, stdout: "" });
      return;
    }
    const chunks = [];
    let length = 0;
    let timedOut = false;
    const outputLimit = Number.isSafeInteger(request.maxOutputBytes) && request.maxOutputBytes > 0
      ? request.maxOutputBytes
      : MAX_COMMAND_OUTPUT_BYTES;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, request.timeoutMs);
    const abort = () => {
      timedOut = true;
      killProcessTree(child);
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length <= outputLimit) chunks.push(chunk);
      else killProcessTree(child);
    });
    child.on("error", () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      resolve({ status: null, timedOut: true, stdout: "" });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      resolve({ status, signal, timedOut, stdout: Buffer.concat(chunks).toString("utf8") });
    });
    if (request.signal?.aborted) abort();
  });
}

async function acquireToken(config, context, resource, deadline) {
  assertWithinDeadline(config, deadline);
  requireRemaining(config, deadline);
  await revalidateLiveContext(config, context, deadline);
  let result;
  try {
    result = await boundedPromise(config, (signal) => {
      const request = {
        command: AZ_PATH,
        argv: ["account", "get-access-token", "--resource", resource, "--output", "json"],
        env: { ...PRODUCTION_ENV },
        cwd: "/",
        timeoutMs: Math.min(TOKEN_TIMEOUT_MS, remaining(config, deadline)),
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        phase: "credential-cleanup",
        signal,
      };
      failIf(request.command !== AZ_PATH || JSON.stringify(request.argv).includes(context.descriptor.vaultName) || JSON.stringify(request.argv).includes(TARGET_SECRET_NAMES[0]), "token-command");
      return config.processRunner(request);
    }, Math.min(TOKEN_TIMEOUT_MS, remaining(config, deadline)), "token-timeout", deadline);
  } catch (error) {
    if (error instanceof CleanupError) throw error;
    reject("token-failed");
  }
  assertWithinDeadline(config, deadline);
  const stdout = parseCommandResult(result, "token");
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    reject("token-json");
  }
  const token = parsed.accessToken ?? parsed.token;
  return validateToken(token, context, resource, "token", config.now());
}

// Test-only isolated probe: the caller must print only its boolean verdict.
// The access token remains inside this process and is never returned.
export async function productionAudienceProbeForTests() {
  const command = async (argv) => {
    const result = await productionProcess({
      command: AZ_PATH,
      argv,
      cwd: "/",
      env: { ...PRODUCTION_ENV },
      timeoutMs: TOKEN_TIMEOUT_MS,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    });
    return JSON.parse(parseCommandResult(result, "audience-probe"));
  };
  const account = await command(["account", "show", "--output", "json"]);
  const caller = await command(["ad", "signed-in-user", "show", "--output", "json"]);
  const cloud = account.environmentName;
  const cloudDescriptor = AZURE_CLOUD_DESCRIPTORS[cloud];
  failIf(cloudDescriptor === undefined, "audience-probe-cloud");
  const objectId = caller.id ?? caller.objectId;
  const context = {
    descriptor: {
      runId: "production-audience-probe",
      cloud,
      cloudDescriptor,
      tenant: account.tenantId,
      callerIdentity: { userType: account?.user?.type, objectId },
    },
    lifecycle: { manifest: { bindings: {} } },
  };
  const tokenResult = await productionProcess({
    command: AZ_PATH,
    argv: ["account", "get-access-token", "--resource", cloudDescriptor.keyVaultResource, "--output", "json"],
    cwd: "/",
    env: { ...PRODUCTION_ENV },
    timeoutMs: TOKEN_TIMEOUT_MS,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  });
  const tokenOutput = parseCommandResult(tokenResult, "audience-probe-token");
  let tokenValue;
  try {
    const parsed = JSON.parse(tokenOutput);
    tokenValue = parsed.accessToken ?? parsed.token;
  } catch {
    reject("audience-probe-token-json");
  }
  validateToken(tokenValue, context, cloudDescriptor.keyVaultResource, "audience-probe-token", Date.now());
  return true;
}

function productionHttps(request) {
  return new Promise((resolve, rejectRequest) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      rejectRequest(new CleanupError("https-url"));
      return;
    }
    const emptyResponse = request.responseMode === "empty";
    const headers = { Authorization: `Bearer ${request.token}` };
    if (!emptyResponse) headers.Accept = "application/json";
    const req = https.request(url, {
      method: request.method,
      headers,
      timeout: request.timeoutMs,
      agent: false,
    }, (response) => {
      if (emptyResponse) {
        // DELETE responses are content-free protocol acknowledgements.  Once
        // status and headers are available, destroy the stream immediately.
        // Azure may return a 200 Deleted Secret Bundle; no body listener,
        // buffer, resume, or body read is permitted on this path.
        response.on("error", () => {});
        const result = { statusCode: response.statusCode, headers: response.headers };
        response.destroy();
        resolve(result);
        return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length <= MAX_HTTP_BODY_BYTES) chunks.push(chunk);
        else req.destroy(new CleanupError("https-body-too-large"));
      });
      response.on("end", () => {
        if (length <= MAX_HTTP_BODY_BYTES) resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("timeout", () => req.destroy(new CleanupError("https-timeout")));
    req.on("error", (error) => rejectRequest(error instanceof CleanupError ? error : new CleanupError("https-failed")));
    request.signal?.addEventListener("abort", () => req.destroy(new CleanupError("https-timeout")), { once: true });
    req.end();
  });
}

async function httpRequest(config, request, deadline, code, context) {
  assertWithinDeadline(config, deadline);
  requireRemaining(config, deadline);
  await revalidateLiveContext(config, context, deadline);
  const url = new URL(request.url);
  failIf(url.protocol !== "https:" || url.username || url.password || url.hash, `${code}-url`);
  failIf(!["GET", "DELETE"].includes(request.method), `${code}-method`);
  const emptyResponse = request.method === "DELETE";
  failIf(emptyResponse && request.body !== undefined, `${code}-request-body`);
  const vaultUri = new URL(context.descriptor.vaultUri);
  const managementUri = new URL(AZURE_MANAGEMENT_RESOURCE);
  if (code === "arm") {
    failIf(
      url.protocol !== "https:" || url.origin !== managementUri.origin ||
        url.pathname !== context.descriptor.vaultResourceId ||
        [...url.searchParams.keys()].filter((key) => key === "api-version").length !== 1 ||
        url.searchParams.get("api-version") !== AZURE_MANAGEMENT_API_VERSION ||
        [...url.searchParams.keys()].some((key) => key !== "api-version"),
      `${code}-url`,
    );
  } else {
    failIf(url.protocol !== "https:" || url.origin !== vaultUri.origin, `${code}-url`);
    failIf(url.searchParams.get("api-version") !== AZURE_VAULT_API_VERSION, `${code}-version`);
    const queryKeys = [...url.searchParams.keys()];
    failIf(
      queryKeys.filter((key) => key === "api-version").length !== 1 ||
        queryKeys.some((key) => !["api-version", "maxresults", "$skiptoken"].includes(key)) ||
        queryKeys.filter((key) => key === "maxresults").length > 1 ||
        queryKeys.filter((key) => key === "$skiptoken").length > 1,
      `${code}-query`,
    );
    if (code === "active" || code === "deleted") {
      const collection = code === "active" ? "secrets" : "deletedsecrets";
      failIf(url.pathname !== `/${collection}`, `${code}-path`);
    } else {
      failIf(!/^\/(?:secrets|deletedsecrets)\/[A-Za-z0-9-]{1,127}$/u.test(url.pathname), `${code}-path`);
      failIf(url.searchParams.has("maxresults") || url.searchParams.has("$skiptoken"), `${code}-query`);
    }
  }
  const boundedRequest = {
    ...request,
    responseMode: emptyResponse ? "empty" : "json",
    timeoutMs: Math.min(HTTP_TIMEOUT_MS, remaining(config, deadline)),
  };
  let result;
  try {
    result = await boundedPromise(config, async (signal) => {
      // Re-read the protected preflight/context immediately before a mutation
      // adapter is allowed to send the DELETE.  This second check is
      // intentionally inside the bounded operation, after all preparation.
      if (emptyResponse) {
        const fresh = validateContext(config, context.descriptor.runId, true);
        await revalidateLiveContext(config, fresh, deadline);
        const preflight = readRuntimePreflight(config, fresh, deadline);
        failIf(request.preflightReceiptSha256 !== preflight.receiptSha256 || request.preflightVerifierId !== preflight.verifierId || request.preflightVerifierSha256 !== preflight.verifierSha256, `${code}-preflight-binding`);
        const intentPath = path.join(
          journalCommitmentDirectory(config, fresh.descriptor.runId),
          `cleanup-mutation-intent-${String(request.mutationIntentSequence).padStart(6, "0")}.json`,
        );
        const intents = readMutationIntents(config, fresh);
        const intent = intents.find((candidate) => candidate.sequence === request.mutationIntentSequence);
        failIf(intent === undefined || sha256File(intent.filePath) !== request.mutationIntentSha256, `${code}-mutation-intent`);
        failIf(
          intent.filePath !== intentPath ||
            intent.value.target !== request.mutationTarget || intent.value.action !== request.mutationAction ||
            intent.value.contextSha256 !== fresh.descriptor.contextSha256 ||
            intent.value.preflightReceiptSha256 !== preflight.receiptSha256 ||
            intent.value.preflightVerifierId !== preflight.verifierId ||
            intent.value.preflightVerifierSha256 !== preflight.verifierSha256 ||
            intent.value.preflightCreatedAt !== preflight.raw.createdAt ||
            intent.value.preflightDeadlineAt !== preflight.raw.deadlineAt,
          `${code}-mutation-intent`,
        );
        // The live reread is deliberately followed by a second freshness
        // check: either operation may advance the shared wall clock.
        validateContext(config, context.descriptor.runId, true);
      }
      assertWithinDeadline(config, deadline);
      requireRemaining(config, deadline, emptyResponse ? CONVERGENCE_POLL_MS + 1 : 1);
      return config.httpRequest({ ...boundedRequest, signal });
    }, boundedRequest.timeoutMs, `${code}-timeout`, deadline);
  } catch (error) {
    if (error instanceof CleanupError) throw error;
    reject(`${code}-failed`);
  }
  assertWithinDeadline(config, deadline);
  failIf(!isObject(result) || result.timedOut === true || !Number.isInteger(result.statusCode), `${code}-result`);
  if (emptyResponse) {
    // Deliberately do not inspect result.body or payload metadata.  The
    // production adapter destroys the response after status+headers, and test
    // adapters may expose a body getter; mutation bodies are never read.
    return result;
  }
  failIf(typeof result.body !== "string", `${code}-result`);
  failIf(Buffer.byteLength(result.body) > MAX_HTTP_BODY_BYTES, `${code}-body-too-large`);
  return result;
}

function extractInventoryName(item, kind, context) {
  const activeKeys = ["id", "attributes", "contentType", "tags", "managed"];
  const deletedKeys = ["recoveryId", "deletedDate", "scheduledPurgeDate", "id", "attributes", "tags", "contentType", "managed"];
  const keys = kind === "active" ? activeKeys : deletedKeys;
  const required = kind === "active" ? ["id", "attributes"] : ["recoveryId", "deletedDate", "scheduledPurgeDate", "attributes"];
  failIf(!isObject(item), `${kind}-inventory-item`);
  failIf(Object.keys(item).some((key) => !keys.includes(key)) || required.some((key) => !Object.hasOwn(item, key)), `${kind}-inventory-item`);
  const attributes = item.attributes;
  failIf(!isObject(attributes), `${kind}-inventory-metadata`);
  const attributeKeys = ["enabled", "created", "updated", "recoveryLevel", "recoverableDays", "exp", "nbf"];
  failIf(Object.keys(attributes).some((key) => !attributeKeys.includes(key)) || typeof attributes.enabled !== "boolean", `${kind}-inventory-metadata`);
  for (const key of ["created", "updated", "recoverableDays", "exp", "nbf"]) {
    if (attributes[key] !== undefined) assertFiniteInteger(attributes[key], `${kind}-inventory-metadata`);
  }
  if (attributes.recoveryLevel !== undefined) failIf(typeof attributes.recoveryLevel !== "string", `${kind}-inventory-metadata`);
  if (item.tags !== undefined) {
    failIf(!isObject(item.tags) || Object.values(item.tags).some((value) => typeof value !== "string"), `${kind}-inventory-metadata`);
  }
  if (item.contentType !== undefined) failIf(typeof item.contentType !== "string", `${kind}-inventory-metadata`);
  if (item.managed !== undefined) failIf(typeof item.managed !== "boolean", `${kind}-inventory-metadata`);
  const parseId = (value, collection, code) => {
    failIf(typeof value !== "string", code);
    let parsed;
    try { parsed = new URL(value); } catch { reject(code); }
    const expected = new URL(context.descriptor.vaultUri);
    failIf(parsed.protocol !== "https:" || parsed.origin !== expected.origin || parsed.search || parsed.hash || parsed.username || parsed.password, `${kind}-inventory-context`);
    const match = new RegExp(`^/${collection}/([^/]+)$`, "u").exec(parsed.pathname);
    failIf(!match || !SECRET_NAME_RE.test(match[1]), `${kind}-inventory-id`);
    return match[1];
  };
  const name = parseId(kind === "active" ? item.id : item.recoveryId, kind === "active" ? "secrets" : "deletedsecrets", `${kind}-inventory-context`);
  if (kind === "deleted" && item.id !== undefined) {
    failIf(parseId(item.id, "secrets", "deleted-inventory-context") !== name, "deleted-inventory-context");
  }
  for (const key of ["deletedDate", "scheduledPurgeDate"]) {
    if (kind === "deleted") assertFiniteInteger(item[key], `${kind}-inventory-metadata`);
  }
  return name;
}

function parseInventoryPage(result, kind, context) {
  failIf(result.statusCode !== 200, `${kind}-inventory-unavailable`);
  let body;
  try {
    body = JSON.parse(result.body);
  } catch {
    reject(`${kind}-inventory-json`);
  }
  exactKeys(body, ["value", "nextLink"], `${kind}-inventory-schema`);
  failIf(!Array.isArray(body.value) || (body.nextLink !== null && typeof body.nextLink !== "string"), `${kind}-inventory-schema`);
  const names = body.value.map((item) => extractInventoryName(item, kind, context));
  return { names, nextLink: body.nextLink };
}

function validateInventoryNextLink(nextLink, kind, context) {
  let parsed;
  try {
    parsed = new URL(nextLink);
  } catch {
    reject(`${kind}-inventory-schema`);
  }
  const vaultUri = new URL(context.descriptor.vaultUri);
  const collection = kind === "active" ? "secrets" : "deletedsecrets";
  const keys = [...parsed.searchParams.keys()];
  failIf(
    parsed.protocol !== "https:" || parsed.origin !== vaultUri.origin || parsed.username ||
      parsed.password || parsed.hash || parsed.pathname !== `/${collection}` ||
      keys.filter((key) => key === "api-version").length !== 1 ||
      parsed.searchParams.get("api-version") !== AZURE_VAULT_API_VERSION ||
      keys.some((key) => !["api-version", "maxresults", "$skiptoken"].includes(key)) ||
      keys.filter((key) => key === "maxresults").length > 1 ||
      keys.filter((key) => key === "$skiptoken").length > 1 ||
      (parsed.searchParams.has("maxresults") && !/^\d+$/u.test(parsed.searchParams.get("maxresults"))) ||
      (parsed.searchParams.has("$skiptoken") && parsed.searchParams.get("$skiptoken") === ""),
    `${kind}-inventory-schema`,
  );
  return parsed.href;
}

async function readInventoryKind(config, context, token, deadline, kind) {
  const collection = kind === "active" ? "secrets" : "deletedsecrets";
  let nextUrl = `${context.descriptor.vaultUri}${collection}?api-version=${AZURE_VAULT_API_VERSION}&maxresults=25`;
  const visited = new Set();
  const names = [];
  let pageCount = 0;
  let bodyBytes = 0;
  while (nextUrl !== null) {
    assertWithinDeadline(config, deadline);
    requireRemaining(config, deadline, 1, `${kind}-inventory-deadline`);
    failIf(visited.has(nextUrl), `${kind}-inventory-pagination-cycle`);
    visited.add(nextUrl);
    pageCount += 1;
    failIf(pageCount > MAX_INVENTORY_PAGES, `${kind}-inventory-pagination-limit`);
    const response = await httpRequest(config, {
      method: "GET",
      url: nextUrl,
      token,
    }, deadline, kind, context);
    assertWithinDeadline(config, deadline);
    failIf(typeof response.body !== "string", `${kind}-inventory-result`);
    bodyBytes += Buffer.byteLength(response.body);
    failIf(bodyBytes > MAX_INVENTORY_BYTES, `${kind}-inventory-too-large`);
    const page = parseInventoryPage(response, kind, context);
    names.push(...page.names);
    failIf(names.length > MAX_INVENTORY_ITEMS, `${kind}-inventory-item-limit`);
    nextUrl = page.nextLink === null ? null : validateInventoryNextLink(page.nextLink, kind, context);
  }
  failIf(new Set(names).size !== names.length, `${kind}-inventory-duplicate`);
  return new Set(names);
}

async function readInventory(config, context, token, deadline) {
  const active = await readInventoryKind(config, context, token, deadline, "active");
  assertWithinDeadline(config, deadline);
  const deleted = await readInventoryKind(config, context, token, deadline, "deleted");
  for (const name of active) failIf(deleted.has(name), "inventory-both-active-and-deleted");
  return { active, deleted };
}

function targetState(inventory, name) {
  const active = inventory.active.has(name);
  const deleted = inventory.deleted.has(name);
  failIf(active && deleted, "inventory-both-active-and-deleted");
  return active ? "active" : deleted ? "deleted" : "absent";
}

function assertStartInventory(inventory) {
  for (const name of TARGET_SECRET_NAMES) failIf(targetState(inventory, name) !== "active", "start-inventory");
}

function assertAbsentInventory(inventory) {
  for (const name of TARGET_SECRET_NAMES) failIf(targetState(inventory, name) !== "absent", "secret-not-absent");
}

function terminalInventory(inventory) {
  const targetStates = TARGET_SECRET_NAMES.map((name) => {
    const state = targetState(inventory, name);
    return { name, activeCount: state === "active" ? 1 : 0, deletedCount: state === "deleted" ? 1 : 0, state };
  });
  return {
    activeNames: targetStates.filter((item) => item.activeCount === 1).map((item) => item.name),
    deletedNames: targetStates.filter((item) => item.deletedCount === 1).map((item) => item.name),
    targetStates,
  };
}

function validateTerminalInventory(inventory, code = "absence-inventory") {
  exactKeys(inventory, INVENTORY_KEYS, `${code}-schema`);
  validateTargetNames(inventory.targetStates.map((item) => item.name), `${code}-targets`);
  for (const names of [inventory.activeNames, inventory.deletedNames]) {
    failIf(!Array.isArray(names) || names.some((name) => !TARGET_SECRET_NAMES.includes(name)) || new Set(names).size !== names.length, `${code}-names`);
  }
  for (const item of inventory.targetStates) {
    exactKeys(item, TARGET_STATE_KEYS, `${code}-state`);
    failIf(!["active", "deleted", "absent"].includes(item.state) || ![0, 1].includes(item.activeCount) || ![0, 1].includes(item.deletedCount), `${code}-state`);
    failIf(item.activeCount + item.deletedCount > 1 || (item.state === "active" && item.activeCount !== 1) || (item.state === "deleted" && item.deletedCount !== 1) || (item.state === "absent" && (item.activeCount !== 0 || item.deletedCount !== 0)), `${code}-state`);
  }
  failIf(JSON.stringify(inventory.activeNames) !== JSON.stringify(inventory.targetStates.filter((item) => item.activeCount === 1).map((item) => item.name)) || JSON.stringify(inventory.deletedNames) !== JSON.stringify(inventory.targetStates.filter((item) => item.deletedCount === 1).map((item) => item.name)), `${code}-state`);
}

function validateAbsenceReceipt(raw, context) {
  exactKeys(raw, ABSENCE_KEYS, "absence-receipt-schema");
  const operation = context.operation;
  failIf(
    operation.status !== "completed" ||
    raw.version !== 3 || raw.type !== "absence" || raw.status !== "absent" || raw.operation !== "credential-cleanup" ||
      raw.runId !== context.descriptor.runId || raw.phase !== "credential-cleanup" ||
      raw.planSha256 !== context.descriptor.planSha256 ||
      raw.bindingSha256 !== context.descriptor.bindingSha256 || raw.contextSha256 !== context.descriptor.contextSha256 ||
      raw.createdAt !== operation.createdAt || raw.repositoryCommit !== operation.repositoryCommit ||
      canonicalJson(raw.supersession) !== canonicalJson(operation.supersession) ||
      raw.preflightReceiptSha256 === null || !isSha256(raw.preflightReceiptSha256) ||
      raw.preflightVerifierId !== PREFLIGHT_VERIFIER_ID || raw.preflightVerifierSha256 !== operation.utilitySha256 ||
      !isSha256(raw.sha256) || raw.sha256 !== sha256Json(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "sha256"))),
    "absence-receipt-context",
  );
  assertIsoTimestamp(raw.createdAt, "absence-receipt-time");
  exactKeys(raw.inventory, ["keyVault", "runtimeSecretReferences"], "absence-receipt-inventory-schema");
  failIf(raw.inventory.keyVault !== "absent" || raw.inventory.runtimeSecretReferences !== 0, "absence-receipt-not-absent");
  validateMutationTailShape(raw, "absence-mutation-tail");
  validateSupersession(raw.supersession, "absence-receipt-supersession");
  return raw;
}

function readAbsenceReceipt(context) {
  return readAbsenceReceiptWithExpectedHash(context, undefined);
}

function readAbsenceReceiptWithExpectedHash(context, expectedReceiptSha256) {
  const receiptPath = artifactPath(context.directory, ABSENCE_RECEIPT_FILENAME);
  const receipt = validateAbsenceReceipt(readJson(receiptPath, "absence-receipt"), context);
  const receiptSha256 = sha256File(receiptPath);
  if (expectedReceiptSha256 !== undefined && expectedReceiptSha256 !== null) {
    failIf(receiptSha256 !== expectedReceiptSha256, "absence-receipt-linkage");
  }
  return {
    receipt,
    receiptPath,
    receiptSha256,
    preflight: {
      receiptSha256: receipt.preflightReceiptSha256,
      verifierId: receipt.preflightVerifierId,
      verifierSha256: receipt.preflightVerifierSha256,
    },
  };
}

function writeAbsenceReceipt(config, context, inventory, suppliedPreflight = undefined) {
  assertAbsentInventory(inventory);
  const receiptPath = artifactPath(context.directory, ABSENCE_RECEIPT_FILENAME);
  if (existsSync(receiptPath)) return readAbsenceReceiptWithExpectedHash(context, undefined);
  const mutationTail = mutationTailForCommitments(readMutationCommitmentHistory(config, context));
  const preflight = suppliedPreflight ?? readRuntimePreflight(config, context, config.now() + CONVERGENCE_POLL_MS + 1);
  const value = {
    version: 3,
    type: "absence",
    status: "absent",
    operation: "credential-cleanup",
    runId: context.descriptor.runId,
    phase: "credential-cleanup",
    planSha256: context.descriptor.planSha256,
    bindingSha256: context.descriptor.bindingSha256,
    createdAt: context.operation.createdAt,
    repositoryCommit: context.operation.repositoryCommit,
    contextSha256: context.descriptor.contextSha256,
    inventory: { keyVault: "absent", runtimeSecretReferences: 0 },
    supersession: context.operation.supersession,
    preflightReceiptSha256: preflight.receiptSha256,
    preflightVerifierId: preflight.verifierId,
    preflightVerifierSha256: preflight.verifierSha256,
    mutationTailSequence: mutationTail.sequence,
    mutationTailSha256: mutationTail.sha256,
    sha256: null,
  };
  value.sha256 = sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256")));
  exclusiveJson(config, receiptPath, value, "absence-receipt");
  return readAbsenceReceipt(context);
}

async function validateAzureAndInventory(config, context, deadline) {
  const managementToken = await acquireToken(config, context, AZURE_MANAGEMENT_RESOURCE, deadline);
  const armResponse = await httpRequest(config, {
    method: "GET",
    url: `https://management.azure.com${context.descriptor.vaultResourceId}?api-version=${AZURE_MANAGEMENT_API_VERSION}`,
    token: managementToken,
  }, deadline, "arm", context);
  failIf(armResponse.statusCode !== 200, "arm-context");
  let arm;
  try {
    arm = JSON.parse(armResponse.body);
  } catch {
    reject("arm-context-json");
  }
  failIf(!isObject(arm) || arm.id !== context.descriptor.vaultResourceId || arm.type !== "Microsoft.KeyVault/vaults" || !isObject(arm.properties) || arm.properties.tenantId !== context.descriptor.tenant || arm.properties.vaultUri !== context.descriptor.vaultUri, "arm-context");
  const vaultToken = await acquireToken(config, context, context.descriptor.cloudDescriptor.keyVaultResource, deadline);
  const inventory = await readInventory(config, context, vaultToken, deadline);
  return { inventory, vaultToken };
}

async function pollAfterMutation(config, context, token, name, expected, deadline) {
  for (;;) {
    requireRemaining(config, deadline, CONVERGENCE_POLL_MS + 1, "convergence-deadline");
    await sleep(config, CONVERGENCE_POLL_MS, deadline);
    const inventory = await readInventory(config, context, token, deadline);
    const state = targetState(inventory, name);
    if (expected === "deleted-or-absent" && state !== "active") return inventory;
    if (expected === "absent" && state === "absent") return inventory;
  }
}

async function mutateTarget(config, context, state, token, name, action, deadline) {
  // A mutation is not safely startable unless this invocation still has room
  // for its mandatory convergence poll; otherwise the DELETE could succeed
  // without a bounded confirmation window.
  requireRemaining(config, deadline, CONVERGENCE_POLL_MS + 1);
  context = validateContext(config, context.descriptor.runId, true);
  await revalidateLiveContext(config, context, deadline);
  const preflight = readRuntimePreflight(config, context, deadline);
  failIf(
    state.preflightReceiptSha256 !== preflight.receiptSha256 ||
      state.preflightVerifierId !== preflight.verifierId ||
      state.preflightVerifierSha256 !== preflight.verifierSha256,
    `${action}-preflight-chain`,
  );
  const intent = publishMutationIntent(config, context, state, name, action, preflight);
  // Re-check the immutable operation reference and its external head anchor
  // after publishing the mutation intent and immediately before DELETE.
  // Paired self-rehashes of a divergent head and anchor therefore never
  // become a mutation permission.
  assertOperationHeadExternallyAnchored(config, context);
  const collection = action === "delete" ? "secrets" : "deletedsecrets";
  const result = await httpRequest(config, {
    method: "DELETE",
    url: `${context.descriptor.vaultUri}${collection}/${name}?api-version=${AZURE_VAULT_API_VERSION}`,
    token,
    preflightReceiptSha256: preflight.receiptSha256,
    preflightVerifierId: preflight.verifierId,
    preflightVerifierSha256: preflight.verifierSha256,
    mutationIntentSequence: intent.value.sequence,
    mutationIntentSha256: sha256File(intent.filePath),
    mutationTarget: name,
    mutationAction: action,
  }, deadline, `${action}-request`, context);
  assertWithinDeadline(config, deadline);
  failIf(!ACCEPTED_DELETE_STATUS.has(result.statusCode), `${action}-rejected`);
  fault(config, "after-mutation-request", { action, name });
  return pollAfterMutation(config, context, token, name, action === "delete" ? "deleted-or-absent" : "absent", deadline);
}

function validatePriorSupersession(config, context) {
  const supersession = context.operation.supersession;
  if (supersession === null) return;
  const oldDirectory = runDirectory(config, supersession.oldRunId);
  const oldOperationHeadPath = artifactPath(oldDirectory, OPERATION_MANIFEST_FILENAME);
  const oldReceiptPath = artifactPath(oldDirectory, ABSENCE_RECEIPT_FILENAME);
  failIf(sha256File(oldOperationHeadPath) !== supersession.cleanupManifestSha256, "supersession-manifest-hash");
  failIf(sha256File(oldReceiptPath) !== supersession.absenceReceiptSha256, "supersession-absence-hash");
  const oldHead = readJson(oldOperationHeadPath, "supersession-manifest");
  exactKeys(oldHead, OPERATION_HEAD_KEYS, "supersession-manifest-schema");
  const oldOperation = Object.fromEntries(OPERATION_KEYS.map((key) => [key, oldHead[key]]));
  const oldOperationPath = artifactPath(oldDirectory, oldHead.manifestFilename);
  failIf(oldHead.manifestSha256 !== sha256File(oldOperationPath), "supersession-manifest-hash");
  const oldContext = {
    descriptor: {
      runId: oldOperation.runId,
      planSha256: oldOperation.planSha256,
      bindingSha256: oldOperation.bindingSha256,
      contextSha256: oldOperation.contextSha256,
    },
    operation: oldOperation,
    operationPath: oldOperationPath,
    directory: oldDirectory,
  };
  const oldState = readStateFiles(config, oldContext);
  const oldReceipt = readAbsenceReceiptWithExpectedHash(oldContext, oldState.absenceReceiptSha256).receipt;
  failIf(oldReceipt.contextSha256 !== supersession.contextSha256, "supersession-context-hash");
}

function allTargetsAbsent(inventory) {
  return TARGET_SECRET_NAMES.every((name) => targetState(inventory, name) === "absent");
}

function finalizeOperationManifest(config, context) {
  failIf(context.operation.status !== "prepared", "operation-manifest-status");
  const value = {
    ...context.operation,
    version: 3,
    status: "completed",
    sequence: context.operation.sequence + 1,
    previousManifestSha256: sha256File(context.operationPath),
    sha256: null,
  };
  value.sha256 = sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256")));
  const versionPath = publishOperationVersion(config, context, value);
  publishOperationHead(config, context, value, versionPath);
  return validateContext(config, context.descriptor.runId, true);
}

async function startOperation(config, runId) {
  const invocationStarted = config.now();
  const context = validateContext(config, runId, false);
  if (context.lifecycle.preflight !== undefined && context.descriptor.supersession === null) reject("start-after-preflight");
  const operationPath = artifactPath(context.directory, OPERATION_MANIFEST_FILENAME);
  failIf(existsSync(operationPath), "already-started");
  failIf(existsSync(journalCommitmentDirectory(config, runId)), "state-before-start");
  for (const entry of readdirSync(context.directory, { withFileTypes: true })) {
    failIf(
      STATE_FILENAME_RE.test(entry.name) || entry.name === STATE_ANCHOR_FILENAME ||
      STATE_ANCHOR_SEQUENCE_RE.test(entry.name) || JOURNAL_HEAD_SEQUENCE_RE.test(entry.name),
      "state-before-start",
    );
  }
  const operation = {
    version: 3,
    type: "cleanup",
    status: "prepared",
    operation: "credential-cleanup",
    runId,
    phase: "credential-cleanup",
    planSha256: context.descriptor.planSha256,
    bindingSha256: context.descriptor.bindingSha256,
    createdAt: context.lifecycle.manifest.createdAt,
    repositoryCommit: context.lifecycle.manifest.bindings.repositoryCommit,
    contextSha256: context.descriptor.contextSha256,
    supersession: context.descriptor.supersession,
    runtimeSecretReferences: [],
    utilitySha256: sha256File(SCRIPT_PATH),
    vaultResourceId: context.descriptor.vaultResourceId,
    journalCommitmentPath: journalCommitmentRelativePath(runId),
    sequence: 0,
    previousManifestSha256: null,
    sha256: null,
  };
  operation.sha256 = sha256Json(Object.fromEntries(Object.entries(operation).filter(([key]) => key !== "sha256")));
  // Publish an immutable prepared version first, then atomically commit the
  // fixed head pointer.  A crash leaves either a complete old head or a
  // complete new head; no reader ever consumes a partially rewritten JSON.
  const versionPath = publishOperationVersion(config, context, operation);
  publishOperationHead(config, context, operation, versionPath);
  let operationContext = validateContext(config, runId, true);
  const deadline = invocationStarted + INVOCATION_DEADLINE_MS;
  requireRemaining(config, deadline);
  const { inventory } = await validateAzureAndInventory(config, operationContext, deadline);
  assertWithinDeadline(config, deadline);
  requireRemaining(config, deadline);
  if (operation.supersession !== null) {
    if (!allTargetsAbsent(inventory)) reject("terminal-recreation");
    operationContext = finalizeOperationManifest(config, operationContext);
    validatePriorSupersession(config, operationContext);
    const absence = writeAbsenceReceipt(config, operationContext, inventory);
    const now = config.now();
    const prepared = readStateFiles(config, operationContext);
    failIf(prepared.sequence >= 0, "state-before-start");
    writeState(config, operationContext, prepared, {
      status: "complete",
      attempts: 0,
      cumulativeElapsedMs: Math.max(0, now - invocationStarted),
      accountingCursor: now,
      operationStartedAt: invocationStarted,
      inventory: terminalInventory(inventory),
      absenceReceiptSha256: absence.receiptSha256,
      preflight: absence.preflight,
    });
  } else {
    assertStartInventory(inventory);
    operationContext = finalizeOperationManifest(config, operationContext);
    const now = config.now();
    const prepared = readStateFiles(config, operationContext);
    failIf(prepared.sequence >= 0, "state-before-start");
    writeState(config, operationContext, prepared, {
      status: "start-inventory-validated",
      attempts: 0,
      cumulativeElapsedMs: Math.max(0, now - invocationStarted),
      accountingCursor: now,
      operationStartedAt: invocationStarted,
      inventory: terminalInventory(inventory),
    });
  }
  return { status: "started", runId };
}

async function assertAbsentOperation(config, runId) {
  const started = config.now();
  const context = validateContext(config, runId, true);
  const state = readStateFiles(config, context);
  const terminal = existsSync(artifactPath(context.directory, ABSENCE_RECEIPT_FILENAME));
  if (terminal) readAbsenceReceiptWithExpectedHash(context, state.absenceReceiptSha256);
  const { inventory } = await validateAzureAndInventory(config, context, started + INVOCATION_DEADLINE_MS);
  if (terminal && !allTargetsAbsent(inventory)) reject("terminal-recreation");
  assertAbsentInventory(inventory);
  return { status: "absent", runId };
}

async function reconcileTerminalReceipt(config, context, state, deadline, invocationStarted) {
  const absence = readAbsenceReceiptWithExpectedHash(
    context,
    state.absenceReceiptSha256 === null ? undefined : state.absenceReceiptSha256,
  );
  const { inventory } = await validateAzureAndInventory(config, context, deadline);
  if (!allTargetsAbsent(inventory)) reject("terminal-recreation");
  if (state.status === "complete") return { status: "absent", runId: context.descriptor.runId };
  failIf(state.status === "prepared" && context.operation.status !== "completed", "state-history");
  const completionNow = config.now();
  const cumulativeElapsedMs = state.sequence < 0
    ? Math.max(0, completionNow - invocationStarted)
    : currentElapsed(state, completionNow);
  failIf(cumulativeElapsedMs >= CUMULATIVE_ELAPSED_LIMIT_MS, "elapsed-ceiling");
  writeState(config, context, state, {
    status: "complete",
    attempts: state.attempts,
    cumulativeElapsedMs,
    accountingCursor: completionNow,
    inventory: terminalInventory(inventory),
    absenceReceiptSha256: absence.receiptSha256,
    preflight: absence.preflight,
  });
  return { status: "absent", runId: context.descriptor.runId };
}

async function resumeOperation(config, runId) {
  const invocationStarted = config.now();
  let context = validateContext(config, runId, true);
  let state = readStateFiles(config, context);
  const deadline = state.sequence < 0
    ? invocationStarted + INVOCATION_DEADLINE_MS
    : Math.min(invocationStarted + INVOCATION_DEADLINE_MS, state.operationStartedAt + CUMULATIVE_ELAPSED_LIMIT_MS);
  // A valid receipt is authoritative even if the state tail was lost after
  // publication, but the external immutable journal-head chain is checked
  // first so paired state/anchor tail deletion cannot reset history.
  if (existsSync(artifactPath(context.directory, ABSENCE_RECEIPT_FILENAME))) {
    return reconcileTerminalReceipt(config, context, state, deadline, invocationStarted);
  }
  if (state.sequence < 0) {
    failIf(context.operation.status !== "prepared", "state-history");
    // A prepared manifest is not permission to infer partial progress.  This
    // invocation may only re-run and durably record the exact start proof.
    const validated = await validateAzureAndInventory(config, context, deadline);
    assertStartInventory(validated.inventory);
    context = finalizeOperationManifest(config, context);
    const now = config.now();
    state = writeState(config, context, state, {
      status: "start-inventory-validated",
      attempts: 0,
      cumulativeElapsedMs: Math.max(0, now - invocationStarted),
      accountingCursor: now,
      operationStartedAt: invocationStarted,
      inventory: terminalInventory(validated.inventory),
    });
    return { status: state.status, runId };
  }
  if (state.status === "complete") reject("absence-receipt-missing");
  if (state.attempts >= MUTATION_ATTEMPT_LIMIT) {
    // The ceiling is a mutation ceiling, not a read/reconcile ceiling.  A
    // fresh token and inventory may still prove convergence and authorize the
    // terminal receipt, but no DELETE is reachable from this branch.
    assertMutationBudget(state, config.now());
    context = validateContext(config, runId, true);
    const reconciled = await validateAzureAndInventory(config, context, deadline);
    assertMutationBudget(state, config.now());
    if (!allTargetsAbsent(reconciled.inventory)) reject("attempt-ceiling");
    const completionNow = config.now();
    const cumulativeElapsedMs = currentElapsed(state, completionNow);
    failIf(cumulativeElapsedMs >= CUMULATIVE_ELAPSED_LIMIT_MS, "elapsed-ceiling");
    const absence = writeAbsenceReceipt(config, context, reconciled.inventory);
    writeState(config, context, state, {
      status: "complete",
      attempts: state.attempts,
      cumulativeElapsedMs,
      accountingCursor: completionNow,
      inventory: terminalInventory(reconciled.inventory),
      absenceReceiptSha256: absence.receiptSha256,
      preflight: absence.preflight,
    });
    return { status: "absent", runId };
  }
  const retryAt = state.status === "unknown"
    ? state.retryNotBefore
    : state.status === "attempting"
      ? state.attemptStartedAt + RETRY_BACKOFF_MS
      : null;
  if (retryAt !== null) {
    const waitMs = Math.max(0, retryAt - config.now());
    if (waitMs > 0) await sleep(config, waitMs, deadline);
    context = validateContext(config, runId, true);
  }
  assertMutationBudget(state, config.now());
  // This is deliberately after backoff.  The token and inventory used for the
  // decision below are always newly acquired/read for this invocation.
  const refreshed = await validateAzureAndInventory(config, context, deadline);
  let inventory = refreshed.inventory;
  assertWithinDeadline(config, deadline);
  requireRemaining(config, deadline);
  if (allTargetsAbsent(inventory)) {
    const absence = writeAbsenceReceipt(config, context, inventory);
    const now = config.now();
    writeState(config, context, state, {
      status: "complete",
      attempts: state.attempts,
      cumulativeElapsedMs: currentElapsed(state, now),
      accountingCursor: now,
      inventory: terminalInventory(inventory),
      absenceReceiptSha256: absence.receiptSha256,
      preflight: absence.preflight,
    });
    return { status: "absent", runId };
  }
  const now = config.now();
  assertMutationBudget(state, now);
  const attemptPreflight = readRuntimePreflight(config, context, deadline);
  // Increment and publish before the first mutation.  Recovery from a durable
  // attempting state increments again, so a crashed attempt always consumes
  // budget and can never be replayed for free.
  state = writeState(config, context, state, {
    status: "attempting",
    attempts: state.attempts + 1,
    cumulativeElapsedMs: currentElapsed(state, now),
    accountingCursor: now,
    attemptStartedAt: now,
    inventory: terminalInventory(inventory),
    preflight: attemptPreflight,
  });
  const token = refreshed.vaultToken;
  try {
    for (const name of TARGET_SECRET_NAMES) {
      context = validateContext(config, runId, true);
      for (;;) {
        const stateForTarget = targetState(inventory, name);
        if (stateForTarget === "absent") break;
        assertWithinDeadline(config, deadline);
        if (stateForTarget === "active") inventory = await mutateTarget(config, context, state, token, name, "delete", deadline);
        else if (stateForTarget === "deleted") inventory = await mutateTarget(config, context, state, token, name, "purge", deadline);
        else reject("inventory-state");
        context = validateContext(config, runId, true);
        await revalidateLiveContext(config, context, deadline);
      }
    }
    assertAbsentInventory(inventory);
    const completionNow = config.now();
    const cumulativeElapsedMs = currentElapsed(state, completionNow);
    failIf(cumulativeElapsedMs >= CUMULATIVE_ELAPSED_LIMIT_MS, "elapsed-ceiling");
    const absence = writeAbsenceReceipt(config, context, inventory);
    writeState(config, context, state, { status: "complete", attempts: state.attempts, cumulativeElapsedMs, accountingCursor: completionNow, inventory: terminalInventory(inventory), absenceReceiptSha256: absence.receiptSha256, preflight: absence.preflight });
    return { status: "absent", runId };
  } catch (error) {
    const failureNow = config.now();
    const elapsed = currentElapsed(state, failureNow);
    if (failureNow < deadline && elapsed < CUMULATIVE_ELAPSED_LIMIT_MS) {
      try {
        writeState(config, context, state, { status: "unknown", attempts: state.attempts, cumulativeElapsedMs: elapsed, accountingCursor: failureNow, retryNotBefore: failureNow + RETRY_BACKOFF_MS, inventory: inventory?.active instanceof Set ? terminalInventory(inventory) : state.inventory });
      } catch {
        // The durable attempting checkpoint remains the safe recovery record.
      }
    }
    throw error;
  }
}

function kernelLockPath(config) {
  return path.join(path.dirname(config.root), `${path.basename(config.root)}.kernel.lock`);
}

function ensureKernelLockFile(config) {
  const lockPath = kernelLockPath(config);
  const parent = path.dirname(lockPath);
  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch {
    reject("kernel-lock-parent");
  }
  failIf(parentStat.isSymbolicLink() || !parentStat.isDirectory(), "kernel-lock-parent");
  failIf(UID !== undefined && parentStat.uid !== UID, "kernel-lock-parent-owner");
  failIf(fileMode(parentStat) !== DIRECTORY_MODE, "kernel-lock-parent-mode");
  let fd;
  try {
    fd = openSync(lockPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, ARTIFACT_MODE);
  } catch {
    reject("kernel-lock-create");
  }
  try {
    fchmodSync(fd, ARTIFACT_MODE);
    const descriptorStat = fstatSync(fd);
    const pathStat = lstatSync(lockPath);
    failIf(pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino, "kernel-lock-descriptor");
    let token = readFileSync(`/proc/self/fd/${fd}`, "utf8").trim();
    if (token.length === 0) {
      token = randomBytes(32).toString("hex");
      ftruncateSync(fd, 0);
      writeFully(fd, Buffer.from(`${token}\n`, "utf8"));
      fsyncSync(fd);
      fsyncDirectory(parent);
    }
    failIf(!/^[0-9a-f]{64}$/u.test(token), "kernel-lock-token");
    return { lockPath, lockFd: fd, token, descriptorStat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

async function withLock(config, callback) {
  const lockKey = path.resolve(config.root);
  if (TEST_LOCKS.has(lockKey)) reject("lock-contention");
  TEST_LOCKS.add(lockKey);
  try {
    return await callback();
  } finally {
    TEST_LOCKS.delete(lockKey);
  }
}

function createConfig(options, production) {
  if (production) {
    failIf(arguments.length !== 2, "production-options");
    return {
      root: EVIDENCE_ROOT,
      now: () => Date.now(),
      sleep: (milliseconds, signal) => new Promise((resolve, rejectSleep) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          rejectSleep(new CleanupError("invocation-deadline"));
        }, { once: true });
      }),
      setTimeout,
      clearTimeout,
      processRunner: (request) => productionProcess(request),
      httpRequest: (request) => productionHttps(request),
      contextReader: productionContextReader,
      wallNow: () => Date.now(),
      faultAt: undefined,
    };
  }
  failIf(!isObject(options), "test-options");
  const lowLevel = options.lowLevel ?? {};
  failIf(!isObject(lowLevel), "test-low-level");
  const root = path.resolve(options.root);
  failIf(!path.isAbsolute(root), "test-root");
  return {
    root,
    now: lowLevel.clock?.now ?? (() => Date.now()),
    sleep: lowLevel.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    setTimeout: lowLevel.setTimeout ?? setTimeout,
    clearTimeout: lowLevel.clearTimeout ?? clearTimeout,
    processRunner: lowLevel.processRunner,
    httpRequest: lowLevel.httpRequest ?? lowLevel.httpsRequest,
    contextReader: lowLevel.contextReader ?? (lowLevel.liveContext === undefined ? undefined : () => lowLevel.liveContext),
    wallNow: lowLevel.wallNow ?? lowLevel.clock?.now ?? (() => Date.now()),
    faultAt: lowLevel.faultAt ?? lowLevel.checkpointFault,
  };
}

function ensureConfig(config) {
  assertDirectory(config.root, "evidence-root");
  failIf(typeof config.processRunner !== "function", "process-runner");
  failIf(typeof config.httpRequest !== "function", "http-runner");
  failIf(typeof config.contextReader !== "function", "context-reader");
}

function createCleanupInternal(options, production) {
  const config = createConfig(options, production);
  ensureConfig(config);
  return Object.freeze({
    config: Object.freeze({ ...config }),
    start: (runId) => withLock(config, () => startOperation(config, runId)),
    resume: (runId) => withLock(config, () => resumeOperation(config, runId)),
    assertAbsent: (runId) => withLock(config, () => assertAbsentOperation(config, runId)),
    execute: (parsed) => {
      if (!parsed) return Promise.reject(new CleanupError("usage"));
      if (parsed.operation === "start") return withLock(config, () => startOperation(config, parsed.runId));
      if (parsed.operation === "resume") return withLock(config, () => resumeOperation(config, parsed.runId));
      if (parsed.operation === "assert-absent") return withLock(config, () => assertAbsentOperation(config, parsed.runId));
      return Promise.reject(new CleanupError("usage"));
    },
  });
}

export function createCleanup() {
  failIf(arguments.length !== 0, "production-options");
  return createCleanupInternal({}, true);
}

export function createCleanupForTests(options = {}) {
  return createCleanupInternal(options, false);
}

export async function runCliForTests(argv, options = {}) {
  const parsed = parseCli(argv);
  if (!parsed) return 2;
  try {
    await createCleanupForTests(options).execute(parsed);
    return 0;
  } catch {
    return 1;
  }
}

async function runLockedCli(argv) {
  const parsed = parseCli(argv);
  if (!parsed) return 2;
  try {
    await createCleanup().execute(parsed);
    process.stdout.write("success\n");
    return 0;
  } catch (error) {
    process.stderr.write(`cleanup-key-vault-credentials: rejected ${error instanceof CleanupError ? error.code : "internal-error"}\n`);
    return 1;
  }
}

function inheritedLockIsValid() {
  const fd = Number(process.env.PALANCAR_CLEANUP_LOCK_FD);
  const token = process.env.PALANCAR_CLEANUP_LOCK_TOKEN;
  if (fd !== 3 || !/^[0-9a-f]{64}$/u.test(token ?? "")) return false;
  const lockPath = kernelLockPath({ root: EVIDENCE_ROOT });
  let descriptorStat;
  let pathStat;
  let parentStat;
  let fileToken;
  try {
    if (process.ppid <= 1 || readlinkSync(`/proc/${process.ppid}/exe`) !== "/usr/bin/flock") return false;
    const parentArgv = readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0").filter(Boolean);
    if (parentArgv[0] !== "/usr/bin/flock" || !parentArgv.includes("-n") || !parentArgv.includes("-x") || parentArgv.indexOf(lockPath) < 0) return false;
    descriptorStat = fstatSync(fd);
    const selfLink = readlinkSync(`/proc/self/fd/${fd}`);
    const parentFdPath = `/proc/${process.ppid}/fd/${fd}`;
    const parentLink = readlinkSync(parentFdPath);
    if (selfLink !== lockPath || parentLink !== lockPath) return false;
    parentStat = statSync(parentFdPath);
    pathStat = lstatSync(lockPath);
    fileToken = readFileSync(`/proc/self/fd/${fd}`, "utf8").trim();
  } catch {
    return false;
  }
  return descriptorStat.isFile() && parentStat.isFile() && !pathStat.isSymbolicLink() && pathStat.isFile() &&
    (UID === undefined || pathStat.uid === UID) && fileMode(pathStat) === ARTIFACT_MODE &&
    descriptorStat.dev === parentStat.dev && descriptorStat.ino === parentStat.ino &&
    descriptorStat.dev === pathStat.dev && descriptorStat.ino === pathStat.ino && fileToken === token;
}

export function runOuterFlock(lock, argv, executable = process.execPath, executableArgs = undefined) {
  return new Promise((resolve) => {
    let child;
    const signalHandlers = new Map();
    let signalTimer;
    let timer;
    let pendingSignal;
    let forwardedSignal;
    let forcedKill = false;
    let childClosed = false;
    let settled = false;
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let timedOut = false;
    const collect = (target, chunk, length) => {
      const next = length + chunk.length;
      if (next <= MAX_COMMAND_OUTPUT_BYTES) target.push(chunk);
      return next;
    };
    const closeOutput = () => {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    };
    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
      signalHandlers.clear();
      if (signalTimer !== undefined) clearTimeout(signalTimer);
      signalTimer = undefined;
    };
    const forwardSignal = (signal) => {
      if (settled) return;
      if (child === undefined) {
        pendingSignal = signal;
        return;
      }
      forwardedSignal = signal;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process group may have exited between the signal and fallback.
        }
      }
      if (signalTimer === undefined) {
        signalTimer = setTimeout(() => {
          forcedKill = true;
          if (!settled) killProcessTree(child);
          if (childClosed && !settled) {
            settled = true;
            clearTimeout(timer);
            closeOutput();
            removeSignalHandlers();
            resolve({
              status: null,
              signal: "SIGKILL",
              timedOut: false,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
            });
          }
        }, OUTER_SIGNAL_GRACE_MS);
      }
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => forwardSignal(signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    try {
      child = spawn("/usr/bin/flock", [
        "-n", "-x", lock.lockPath, executable,
        ...(executableArgs ?? [SCRIPT_PATH, INTERNAL_LOCKED_MARKER, ...argv]),
      ], {
        cwd: "/",
        env: { ...PRODUCTION_ENV, PALANCAR_CLEANUP_LOCK_FD: "3", PALANCAR_CLEANUP_LOCK_TOKEN: lock.token },
        detached: true,
        stdio: ["ignore", "pipe", "pipe", lock.lockFd],
      });
    } catch (error) {
      settled = true;
      removeSignalHandlers();
      resolve({ error, status: null, stdout: "", stderr: "" });
      return;
    }
    child.stdout.on("data", (chunk) => { stdoutLength = collect(stdout, chunk, stdoutLength); });
    child.stderr.on("data", (chunk) => { stderrLength = collect(stderr, chunk, stderrLength); });
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, INVOCATION_DEADLINE_MS);
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      removeSignalHandlers();
      killProcessTree(child);
      closeOutput();
      resolve({ error, status: null, stdout: "", stderr: "" });
    });
    child.on("close", (status, signal) => {
      childClosed = true;
      if (forwardedSignal !== undefined && signalTimer !== undefined && !forcedKill) return;
      settled = true;
      clearTimeout(timer);
      removeSignalHandlers();
      closeOutput();
      resolve({
        status: timedOut ? null : status,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (pendingSignal !== undefined) {
      const signal = pendingSignal;
      pendingSignal = undefined;
      forwardSignal(signal);
    }
  });
}

export async function runCli(argv) {
  if (argv[0] === INTERNAL_LOCKED_MARKER) {
    if (!inheritedLockIsValid()) {
      process.stderr.write("cleanup-key-vault-credentials: rejected lock-failed\n");
      return 1;
    }
    return runLockedCli(argv.slice(1));
  }
  const parsed = parseCli(argv);
  if (!parsed) return 2;
  let lock;
  try {
    const config = createConfig({}, true);
    ensureConfig(config);
    lock = ensureKernelLockFile(config);
  } catch (error) {
    process.stderr.write(`cleanup-key-vault-credentials: rejected ${error instanceof CleanupError ? error.code : "internal-error"}\n`);
    return 1;
  }
  let child;
  try {
    child = await runOuterFlock(lock, argv);
  } finally {
    closeSync(lock.lockFd);
  }
  if (child.error || child.status === null || child.timedOut) {
    process.stderr.write("cleanup-key-vault-credentials: rejected lock-failed\n");
    return 1;
  }
  if (child.stdout !== "") process.stdout.write(child.stdout);
  if (child.stderr?.length > 0) {
    process.stderr.write(child.stderr);
  } else if (child.status === 1) {
    // flock returns 1 without executing the child when another process owns
    // the descriptor.  A real child failure has already supplied stderr.
    process.stderr.write("cleanup-key-vault-credentials: rejected lock-contention\n");
  }
  return child.status;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
