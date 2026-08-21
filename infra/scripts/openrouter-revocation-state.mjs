#!/usr/bin/env node

import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENV_PATH = "/home/dev/repos/palancar_ws/.env";
export const EVIDENCE_ROOT =
  "/home/dev/.local/state/palancar/azure-foundry-entra-cutover";
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const ENV_KEY = "OPENROUTER_API_KEY";

export const STATES = Object.freeze([
  "preflight-captured",
  "awaiting-user",
  "revoked",
  "local-removed",
]);
export const OPERATIONS = Object.freeze([
  "prepare",
  "resume",
  "mark-local-removed",
  "assert-complete",
]);

export const STATE_FILE_NAME = "openrouter-revocation-state.json";
export const RAW_RESPONSE_FILE_NAME = "openrouter-revocation-raw-response.json";
export const RECEIPT_FILE_NAME = "openrouter-revocation-receipt.json";
export const LOCK_FILE_NAME = "openrouter-revocation.lock";
export const STATE_PATH = path.join(EVIDENCE_ROOT, STATE_FILE_NAME);
export const RAW_RESPONSE_PATH = path.join(EVIDENCE_ROOT, RAW_RESPONSE_FILE_NAME);
export const RECEIPT_PATH = path.join(EVIDENCE_ROOT, RECEIPT_FILE_NAME);
export const LOCK_PATH = path.join(EVIDENCE_ROOT, LOCK_FILE_NAME);

const SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_ENV_BYTES = 1024 * 1024;
const MAX_RAW_RESPONSE_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const HTTP_TIMEOUT_MS = 15_000;
const DYNAMIC_RESPONSE_FIELDS = new Set([
  "created_at",
  "expires_at",
  "last_used_at",
  "limit",
  "limit_remaining",
  "limit_reset",
  "request_count",
  "timestamp",
  "updated_at",
  "usage",
]);
const TEMP_NAME_RE = /^.+\.tmp-(\d+)-([a-f0-9]{24})$/u;
const TEMP_MANIFEST_NAME_RE = /^openrouter-revocation-owned-temp-(\d+)-([a-f0-9]{24})\.json$/u;
const STATE_ENTRY_NAME_RE = /^openrouter-revocation-state\.json(?:\.seq-(\d{8}))?$/u;
const UID = typeof process.getuid === "function" ? process.getuid() : undefined;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
const CREATE_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0);

// This token makes it possible for the unit tests to use temporary paths and a
// fake HTTP client without making either capability available through argv or
// the production environment.
export const TEST_ADAPTER = Symbol("openrouter-revocation-test-adapter");

export class RevocationStateError extends Error {
  constructor(code) {
    super(code);
    this.name = "RevocationStateError";
    this.code = code;
  }
}

function fail(code) {
  throw new RevocationStateError(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function currentOwner(stat) {
  return UID === undefined || stat.uid === UID;
}

function modeOf(stat) {
  return stat.mode & 0o7777;
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameFileState(left, right) {
  return sameIdentity(left, right) &&
    left?.uid === right?.uid && left?.gid === right?.gid &&
    modeOf(left) === modeOf(right) && left?.size === right?.size;
}

function isSafeAncestor(stat) {
  if (!stat?.isDirectory?.()) return false;
  if (UID !== undefined && stat.uid !== UID && stat.uid !== 0) return false;
  const mode = modeOf(stat);
  if ((mode & 0o002) !== 0 && (mode & 0o1000) === 0) return false;
  if ((mode & 0o020) !== 0 && (mode & 0o1000) === 0) return false;
  return true;
}

function assertAncestorChain(filePath, { includeLeaf = false } = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    fail("unsafe-path");
  }
  const resolved = path.resolve(filePath);
  const parts = resolved.split(path.sep);
  let current = path.sep;
  for (let index = 1; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = lstatOrMissing(current);
    if (!stat) {
      if (includeLeaf && index === parts.length - 1) return;
      fail("unsafe-ancestor");
    }
    if (stat.isSymbolicLink() || !isSafeAncestor(stat)) fail("unsafe-ancestor");
  }
}

function lstatOrMissing(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    fail("filesystem-error");
  }
}

function assertDirectory(directoryPath, expectedMode = DIRECTORY_MODE) {
  assertAncestorChain(directoryPath);
  const stat = lstatOrMissing(directoryPath);
  if (!stat) fail("missing-evidence-root");
  if (!stat.isDirectory() || !currentOwner(stat) || modeOf(stat) !== expectedMode) {
    fail("unsafe-evidence-root");
  }
}

function ensureEvidenceRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) fail("unsafe-path");
  const resolved = path.resolve(root);
  const parts = resolved.split(path.sep);
  let current = path.sep;
  for (let index = 1; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const existing = lstatOrMissing(current);
    if (existing) {
      if (existing.isSymbolicLink() || !isSafeAncestor(existing)) {
        fail("unsafe-ancestor");
      }
      continue;
    }
    try {
      mkdirSync(current, { mode: DIRECTORY_MODE });
    } catch {
      fail("filesystem-error");
    }
    const created = lstatOrMissing(current);
    if (!created || created.isSymbolicLink() || !currentOwner(created) ||
      !created.isDirectory()) fail("unsafe-evidence-root");
    try {
      // mkdir's mode is affected by umask; the evidence root is never allowed
      // to inherit a less restrictive mode.
      chmodSync(current, DIRECTORY_MODE);
    } catch {
      fail("filesystem-error");
    }
  }
  assertDirectory(root);
}

function assertReadableFile(filePath, maxBytes, expectedMode = undefined) {
  assertAncestorChain(path.dirname(filePath));
  const stat = lstatOrMissing(filePath);
  if (!stat) fail("missing-file");
  if (stat.isSymbolicLink() || !stat.isFile() || !currentOwner(stat)) fail("unsafe-file");
  if (expectedMode !== undefined && modeOf(stat) !== expectedMode) {
    fail("unsafe-file");
  }
  if (stat.size > maxBytes) fail("file-too-large");
  let descriptor;
  try {
    descriptor = openSync(filePath, READ_FLAGS);
    const opened = fstatSync(descriptor);
    if (opened.isSymbolicLink?.() || !opened.isFile() || !currentOwner(opened) ||
      !sameFileState(stat, opened) ||
      (expectedMode !== undefined && modeOf(opened) !== expectedMode) ||
      opened.size > maxBytes) {
      fail("unsafe-file");
    }
    const text = readFileSync(descriptor, "utf8");
    const final = fstatSync(descriptor);
    if (!final.isFile() || !currentOwner(final) || !sameFileState(opened, final) ||
      final.size > maxBytes) {
      fail("file-changed");
    }
    return text;
  } catch (error) {
    if (error instanceof RevocationStateError) throw error;
    fail("filesystem-error");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        fail("filesystem-error");
      }
    }
  }
}

function fsyncDirectory(directoryPath) {
  let descriptor;
  try {
    assertDirectory(directoryPath);
    descriptor = openSync(directoryPath, DIRECTORY_FLAGS);
    fsyncSync(descriptor);
  } catch {
    fail("durability-error");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        fail("durability-error");
      }
    }
  }
}

function invokeHook(context, name) {
  const hook = context.hooks?.[name];
  if (hook) hook();
}

function writeAll(descriptor, content) {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(descriptor, buffer, offset, buffer.length - offset);
    if (!Number.isInteger(written) || written <= 0) fail("filesystem-error");
    offset += written;
  }
}

function contentDigest(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function temporaryPath(targetPath) {
  const token = randomBytes(12).toString("hex");
  return {
    path: `${targetPath}.tmp-${process.pid}-${token}`,
    token,
  };
}

function manifestPath(context, token) {
  return path.join(
    context.evidenceRoot,
    `openrouter-revocation-owned-temp-${process.pid}-${token}.json`,
  );
}

function createDurableManifest(context, targetPath, temporary, token, digest, size, kind) {
  const manifest = {
    schema: SCHEMA_VERSION,
    kind: "openrouter-revocation-temp-manifest",
    operation_kind: kind,
    target: path.basename(targetPath),
    temporary: path.basename(temporary),
    sha256: digest,
    size,
    pid: process.pid,
  };
  const manifestFile = manifestPath(context, token);
  let descriptor;
  try {
    descriptor = openSync(manifestFile, CREATE_FLAGS, FILE_MODE);
    fchmodSync(descriptor, FILE_MODE);
    invokeHook(context, `${kind}-manifest-opened`);
    writeAll(descriptor, canonicalJson(manifest));
    invokeHook(context, `${kind}-manifest-written`);
    fsyncSync(descriptor);
    invokeHook(context, `${kind}-manifest-fsynced`);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(context.evidenceRoot);
    const stat = lstatOrMissing(manifestFile);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || !currentOwner(stat) ||
      modeOf(stat) !== FILE_MODE) fail("temporary-manifest");
    const digest = contentDigest(canonicalJson(manifest));
    return { path: manifestFile, manifest, stat, sha256: digest.sha256, size: digest.bytes.byteLength };
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* recovery owns the durable manifest */ }
    }
    throw error instanceof RevocationStateError ? error : new RevocationStateError("temporary-manifest");
  }
}

function readDescriptorDigest(descriptor, maxBytes) {
  const opened = fstatSync(descriptor);
  if (!opened.isFile() || !currentOwner(opened) || modeOf(opened) !== FILE_MODE ||
    opened.size > maxBytes) fail("temporary-changed");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, opened.size)));
  let position = 0;
  while (position < opened.size) {
    const length = Math.min(buffer.byteLength, opened.size - position);
    const read = readSync(descriptor, buffer, 0, length, position);
    if (!Number.isInteger(read) || read <= 0) fail("temporary-changed");
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  const final = fstatSync(descriptor);
  if (!sameFileState(opened, final)) fail("temporary-changed");
  return { stat: final, size: position, sha256: hash.digest("hex") };
}

function readDescriptorContent(descriptor, maxBytes) {
  const opened = fstatSync(descriptor);
  if (!opened.isFile() || !currentOwner(opened) || modeOf(opened) !== FILE_MODE ||
    opened.size > maxBytes) fail("temporary-changed");
  const bytes = Buffer.alloc(opened.size);
  let position = 0;
  while (position < opened.size) {
    const read = readSync(descriptor, bytes, position, opened.size - position, position);
    if (!Number.isInteger(read) || read <= 0) fail("temporary-changed");
    position += read;
  }
  const final = fstatSync(descriptor);
  if (!sameFileState(opened, final)) fail("temporary-changed");
  return {
    stat: final,
    size: position,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function assertTemporaryContent(temporary, descriptor, expectedState, expectedDigest, expectedSize, context, maxBytes) {
  const listed = lstatOrMissing(temporary);
  if (!listed || listed.isSymbolicLink() || !listed.isFile() ||
    !currentOwner(listed) || modeOf(listed) !== FILE_MODE ||
    !sameIdentity(listed, expectedState) || listed.uid !== expectedState.uid ||
    listed.gid !== expectedState.gid) fail("temporary-changed");
  const opened = fstatSync(descriptor);
  if (!opened.isFile() || !currentOwner(opened) || modeOf(opened) !== FILE_MODE ||
    !sameIdentity(opened, expectedState) || opened.uid !== expectedState.uid ||
    opened.gid !== expectedState.gid || !sameIdentity(opened, listed)) {
    fail("temporary-changed");
  }
  const digest = readDescriptorDigest(descriptor, maxBytes);
  const after = lstatOrMissing(temporary);
  if (!after || !sameFileState(after, digest.stat) ||
    digest.size !== expectedSize || digest.sha256 !== expectedDigest) {
    fail("temporary-changed");
  }
  assertAncestorChain(context.evidenceRoot);
  return digest.stat;
}

function atomicRenameNoReplace(source, destination, context) {
  const parent = path.dirname(destination);
  if (path.dirname(source) !== parent || path.basename(source).includes(path.sep) ||
    path.basename(destination).includes(path.sep)) fail("unsafe-path");
  assertAncestorChain(parent);
  const script = [
    "import ctypes, os, sys",
    "libc = ctypes.CDLL(None, use_errno=True)",
    "fn = getattr(libc, 'renameat2', None)",
    "if fn is None: sys.exit(90)",
    "fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]",
    "fn.restype = ctypes.c_int",
    "if fn(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1) != 0:",
    "    sys.exit(17 if ctypes.get_errno() == 17 else 91)",
  ].join("\n");
  const result = spawnSync("/usr/bin/python3", [
    "-c", script, path.basename(source), path.basename(destination),
  ], {
    cwd: parent,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    timeout: 15_000,
    maxBuffer: 4096,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error?.code === "ETIMEDOUT") fail("publication-deadline");
  if (result.status === 17) fail("file-already-exists");
  if (result.status !== 0) fail("publication-error");
  invokeHook(context, "publication-committed");
}

function closeTemporary(descriptor) {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    fail("temporary-close");
  }
}

function unlinkTemporary(context, temporary, expectedState) {
  const listed = lstatOrMissing(temporary);
  if (!listed || listed.isSymbolicLink() || !listed.isFile() ||
    !currentOwner(listed) || modeOf(listed) !== FILE_MODE ||
    !sameIdentity(listed, expectedState)) fail("temporary-cleanup");
  invokeHook(context, "temporary-before-unlink");
  const current = lstatOrMissing(temporary);
  if (!current || current.isSymbolicLink() || !current.isFile() ||
    !currentOwner(current) || modeOf(current) !== FILE_MODE ||
    !sameIdentity(current, expectedState)) fail("temporary-cleanup");
  try {
    unlinkSync(temporary);
  } catch {
    fail("temporary-cleanup");
  }
  if (lstatOrMissing(temporary)) fail("temporary-cleanup");
}

function unlinkManifest(manifestFile, expectedState, expectedDigest, expectedSize) {
  const listed = lstatOrMissing(manifestFile);
  if (!listed || listed.isSymbolicLink() || !listed.isFile() || !currentOwner(listed) ||
    modeOf(listed) !== FILE_MODE || !sameFileState(listed, expectedState)) fail("temporary-cleanup");
  let descriptor;
  try {
    descriptor = openSync(manifestFile, READ_FLAGS);
    const digest = readDescriptorDigest(descriptor, MAX_JSON_BYTES);
    if (!sameFileState(listed, digest.stat) || digest.size !== expectedSize ||
      digest.sha256 !== expectedDigest) fail("temporary-cleanup");
    unlinkSync(manifestFile);
  } catch {
    fail("temporary-cleanup");
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { fail("temporary-cleanup"); }
    }
  }
  if (lstatOrMissing(manifestFile)) fail("temporary-cleanup");
}

function publishFile(targetPath, content, context, { exclusive = false, kind }) {
  const parentPath = path.dirname(targetPath);
  assertAncestorChain(parentPath);
  const parentState = lstatOrMissing(parentPath);
  if (!parentState || !isSafeAncestor(parentState)) fail("unsafe-ancestor");
  const destination = lstatOrMissing(targetPath);
  if (destination && (destination.isSymbolicLink() || !destination.isFile() || !currentOwner(destination) ||
    modeOf(destination) !== FILE_MODE)) {
    fail("unsafe-file");
  }
  if (exclusive && destination) fail("file-already-exists");

  const digest = contentDigest(content);
  const maxBytes = kind === "raw" ? MAX_RAW_RESPONSE_BYTES : MAX_JSON_BYTES;
  if (digest.bytes.byteLength > maxBytes) fail("file-too-large");
  const temporaryInfo = temporaryPath(targetPath);
  const temporary = temporaryInfo.path;
  let manifest;
  let descriptor;
  let temporaryState;
  let renamed = false;
  let originalError;
  try {
    manifest = createDurableManifest(
      context,
      targetPath,
      temporary,
      temporaryInfo.token,
      digest.sha256,
      digest.bytes.byteLength,
      kind,
    );
    descriptor = openSync(temporary, CREATE_FLAGS, FILE_MODE);
    fchmodSync(descriptor, FILE_MODE);
    temporaryState = fstatSync(descriptor);
    if (!temporaryState.isFile() || !currentOwner(temporaryState) ||
      modeOf(temporaryState) !== FILE_MODE) fail("unsafe-file");
    invokeHook(context, `${kind}-temp-opened`);
    writeAll(descriptor, content);
    invokeHook(context, `${kind}-temp-written`);
    fsyncSync(descriptor);
    invokeHook(context, `${kind}-temp-fsynced`);
    assertTemporaryContent(
      temporary,
      descriptor,
      temporaryState,
      digest.sha256,
      digest.bytes.byteLength,
      context,
      maxBytes,
    );
    // This hook deliberately runs while the source descriptor is still open.
    // A same-inode, same-size overwrite after fsync is rejected by the digest
    // check below instead of being published.
    invokeHook(context, `${kind}-temp-before-close`);
    invokeHook(context, `${kind}-before-rename`);
    if (kind === "state" && context.stateHasPrior) invokeHook(context, "state-before-append");
    assertTemporaryContent(
      temporary,
      descriptor,
      temporaryState,
      digest.sha256,
      digest.bytes.byteLength,
      context,
      maxBytes,
    );
    verifyPublicationGuards(context);
    const currentDestination = lstatOrMissing(targetPath);
    const currentParent = lstatOrMissing(parentPath);
    if (!sameIdentity(parentState, currentParent) || (exclusive ? currentDestination !== undefined :
      !sameFileState(destination, currentDestination))) {
      fail(exclusive ? "file-already-exists" : "destination-changed");
    }
    atomicRenameNoReplace(temporary, targetPath, context);
    renamed = true;
    if (kind === "state") context.stateAdvanced = true;
    const published = lstatOrMissing(targetPath);
    if (!published || published.isSymbolicLink() || !published.isFile() ||
      !currentOwner(published) || modeOf(published) !== FILE_MODE ||
      !sameIdentity(published, temporaryState)) fail("publication-error");
    invokeHook(context, `${kind}-after-rename`);
    if (kind === "state" && context.stateHasPrior) invokeHook(context, "state-after-append");
    fsyncDirectory(context.evidenceRoot);
    invokeHook(context, `${kind}-directory-fsynced`);
  } catch (error) {
    originalError = error;
    if (!renamed) {
      try {
        if (descriptor !== undefined) {
          closeTemporary(descriptor);
          descriptor = undefined;
        }
        if (temporaryState) unlinkTemporary(context, temporary, temporaryState);
        if (manifest) unlinkManifest(manifest.path, manifest.stat, manifest.sha256, manifest.size);
      } catch (cleanupError) {
        originalError = cleanupError;
      }
    }
    throw originalError;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The rename and directory fsync already made the publication
        // durable. A close failure must not turn an advanced state into an
        // ambiguous retry; the kernel will close the descriptor on exit.
        if (!originalError && !renamed) fail("temporary-close");
      }
    }
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function readJsonFile(filePath, maxBytes, expectedMode = FILE_MODE) {
  const text = assertReadableFile(filePath, maxBytes, expectedMode);
  try {
    return JSON.parse(text);
  } catch {
    fail("malformed-evidence");
  }
}

function validString(value, maxLength = 256) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTimestamp(value) {
  return validString(value, 64) && !Number.isNaN(Date.parse(value));
}

function validateMasked(masked) {
  if (!isObject(masked) || !exactKeys(masked, ["label", "expires_at", "limit"])) {
    fail("malformed-evidence");
  }
  if (masked.label !== "****") fail("malformed-evidence");
  if (masked.expires_at !== null &&
    (!validString(masked.expires_at, 128) || !validTimestamp(masked.expires_at))) {
    fail("malformed-evidence");
  }
  if (masked.limit !== null &&
    (typeof masked.limit !== "number" || !Number.isFinite(masked.limit) ||
      masked.limit < 0)) {
    fail("malformed-evidence");
  }
}

function isRawlessMaskedRecovery(previous, current) {
  return previous.state === "preflight-captured" && previous.raw === null &&
    current.state === "preflight-captured" && current.raw !== null;
}

function validateOptionalIdentifier(value) {
  return value === null || validString(value, 4096);
}

function validateSecurityIdentity(identity) {
  if (!isObject(identity) || !exactKeys(identity, [
    "key_fingerprint",
    "provider_key_fingerprint",
    "key_id",
    "local_mask",
    "endpoint",
    "endpoint_id",
    "account_id",
    "account_name",
    "provider_stable_sha256",
  ]) || !/^[a-f0-9]{64}$/u.test(identity.key_fingerprint) ||
    (identity.provider_key_fingerprint !== null &&
      !/^[a-f0-9]{64}$/u.test(identity.provider_key_fingerprint)) ||
    !validateOptionalIdentifier(identity.key_id) || identity.local_mask !== "****" ||
    identity.endpoint !== OPENROUTER_KEY_URL ||
    !validateOptionalIdentifier(identity.endpoint_id) ||
    !validateOptionalIdentifier(identity.account_id) ||
    !validateOptionalIdentifier(identity.account_name) ||
    !/^[a-f0-9]{64}$/u.test(identity.provider_stable_sha256)) {
    fail("malformed-evidence");
  }
}

function validInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateFileBinding(binding, { allowNull = false } = {}) {
  if (binding === null && allowNull) return;
  if (!isObject(binding) || !exactKeys(binding, [
    "sha256", "size", "uid", "gid", "mode", "dev", "ino",
  ]) || !/^[a-f0-9]{64}$/u.test(binding.sha256) ||
    !validInteger(binding.size) || !validInteger(binding.uid) ||
    !validInteger(binding.gid) || !validInteger(binding.dev) ||
    !validInteger(binding.ino) || binding.mode !== FILE_MODE) {
    fail("malformed-evidence");
  }
}

function validateEnvSnapshot(snapshot) {
  if (!isObject(snapshot) || !exactKeys(snapshot, [
    "path", "sha256", "size", "uid", "gid", "mode", "dev", "ino",
    "assignment_count", "removed_sha256", "removed_size",
  ]) || !path.isAbsolute(snapshot.path) || !validString(snapshot.path, 4096) ||
    !/^[a-f0-9]{64}$/u.test(snapshot.sha256) ||
    !/^[a-f0-9]{64}$/u.test(snapshot.removed_sha256) ||
    !validInteger(snapshot.size) || !validInteger(snapshot.removed_size) ||
    snapshot.uid !== UID && UID !== undefined || !validInteger(snapshot.uid) ||
    !validInteger(snapshot.gid) || !validInteger(snapshot.dev) ||
    !validInteger(snapshot.ino) || !validInteger(snapshot.mode) ||
    (snapshot.mode & 0o7777) !== snapshot.mode ||
    (snapshot.mode & ~0o600) !== 0 || snapshot.assignment_count !== 1) {
    fail("malformed-evidence");
  }
}

function validateRemovalIntent(intent) {
  if (!isObject(intent) || !exactKeys(intent, [
    "path", "original_sha256", "original_size", "uid", "gid", "mode",
    "dev", "ino", "removed_sha256", "removed_size", "assignment_count",
  ]) || !path.isAbsolute(intent.path) || !validString(intent.path, 4096) ||
    !/^[a-f0-9]{64}$/u.test(intent.original_sha256) ||
    !/^[a-f0-9]{64}$/u.test(intent.removed_sha256) ||
    !validInteger(intent.original_size) || !validInteger(intent.removed_size) ||
    !validInteger(intent.uid) || !validInteger(intent.gid) ||
    !validInteger(intent.dev) || !validInteger(intent.ino) ||
    !validInteger(intent.mode) || (intent.mode & 0o7777) !== intent.mode ||
    (intent.mode & ~0o600) !== 0 || intent.assignment_count !== 1) {
    fail("malformed-evidence");
  }
}

function validateState(state) {
  if (!isObject(state) || state.schema !== SCHEMA_VERSION ||
    state.kind !== "openrouter-revocation" || !STATES.includes(state.state) ||
    !validString(state.response_sha256, 64) ||
    !/^[a-f0-9]{64}$/u.test(state.response_sha256) ||
    !validString(state.key_sha256, 64) ||
    !/^[a-f0-9]{64}$/u.test(state.key_sha256) ||
    !validTimestamp(state.captured_at)) {
    fail("malformed-evidence");
  }
  validateMasked(state.masked);
  validateSecurityIdentity(state.security_identity);
  if (state.security_identity.key_fingerprint !== state.key_sha256 ||
    state.response_sha256 !== securityIdentityDigest(state.security_identity)) {
    fail("malformed-evidence");
  }
  validateEnvSnapshot(state.env);
  validateFileBinding(state.raw, { allowNull: true });
  const expected = [
    "schema",
    "kind",
    "state",
    "response_sha256",
    "key_sha256",
    "security_identity",
    "masked",
    "captured_at",
    "env",
    "raw",
  ];
  if (state.state === "revoked") expected.push("revoked_at", "removal_intent");
  if (state.state === "local-removed") {
    expected.push("revoked_at", "removal_intent", "local_removed_at");
  }
  if (!exactKeys(state, expected)) fail("malformed-evidence");
  if ((state.state === "revoked" || state.state === "local-removed") &&
    !validTimestamp(state.revoked_at)) fail("malformed-evidence");
  if (state.state === "local-removed" && !validTimestamp(state.local_removed_at)) {
    fail("malformed-evidence");
  }
  if (state.state === "revoked" || state.state === "local-removed") {
    validateRemovalIntent(state.removal_intent);
    if (state.removal_intent.path !== state.env.path ||
      state.removal_intent.original_sha256 !== state.env.sha256 ||
      state.removal_intent.original_size !== state.env.size ||
      state.removal_intent.removed_sha256 !== state.env.removed_sha256 ||
      state.removal_intent.removed_size !== state.env.removed_size ||
      state.removal_intent.uid !== state.env.uid ||
      state.removal_intent.gid !== state.env.gid ||
      state.removal_intent.mode !== state.env.mode ||
      state.removal_intent.dev !== state.env.dev ||
      state.removal_intent.ino !== state.env.ino) fail("malformed-evidence");
  }
  return state;
}

function validateReceipt(receipt) {
  if (!isObject(receipt) || !exactKeys(receipt, [
    "schema",
    "kind",
    "state",
    "http_status",
    "response_sha256",
    "recorded_at",
  ]) || receipt.schema !== SCHEMA_VERSION ||
    receipt.kind !== "openrouter-revocation" || receipt.state !== "revoked" ||
    receipt.http_status !== 401 ||
    !/^[a-f0-9]{64}$/u.test(receipt.response_sha256) ||
    !validTimestamp(receipt.recorded_at)) {
    fail("malformed-evidence");
  }
  return receipt;
}

function now(context) {
  const value = context.now ? context.now() : new Date().toISOString();
  if (!validTimestamp(value)) fail("invalid-clock");
  return value;
}

function parseEnvAssignments(text) {
  const assignments = [];
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*#/u.test(line) || /^\s*$/u.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)\s*$/u);
    if (!match) continue;
    let value = match[1].trim();
    if (value.length >= 2 && value[0] === "\"" && value.at(-1) === "\"") {
      try {
        value = JSON.parse(value);
      } catch {
        fail("malformed-env");
      }
    } else if (value.length >= 2 && value[0] === "'" && value.at(-1) === "'") {
      value = value.slice(1, -1).replaceAll("\\'", "'").replaceAll("\\\\", "\\");
    } else if (value.includes("\"") || value.includes("'")) {
      fail("malformed-env");
    }
    assignments.push(value);
  }
  return assignments;
}

function envModeIsRestrictive(mode) {
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o600 &&
    (mode & ~0o600) === 0;
}

function assignmentSpans(bytes, key) {
  const assignment = /^[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=/u;
  const spans = [];
  let lineStart = 0;
  let quote;
  let assignmentStart;
  let target = false;

  function scan(start, end, initialQuote = null) {
    let current = initialQuote;
    for (let index = start; index < end; index += 1) {
      if (bytes[index] === 0x5c) {
        index += 1;
        continue;
      }
      if (current === null) {
        if (bytes[index] === 0x22 || bytes[index] === 0x27) current = bytes[index];
      } else if (bytes[index] === current) {
        current = null;
      }
    }
    return current;
  }

  while (lineStart < bytes.length) {
    const newline = bytes.indexOf(0x0a, lineStart);
    const lineEnd = newline === -1 ? bytes.length : newline;
    const contentEnd = lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d
      ? lineEnd - 1 : lineEnd;
    const logicalEnd = newline === -1 ? bytes.length : newline + 1;
    if (quote !== undefined) {
      quote = scan(lineStart, contentEnd, quote);
      if (quote === null) {
        if (target) spans.push({ start: assignmentStart, end: logicalEnd });
        quote = undefined;
        assignmentStart = undefined;
        target = false;
      }
    } else {
      const line = bytes.toString("utf8", lineStart, contentEnd);
      const match = assignment.exec(line);
      if (match) {
        const valueStart = lineStart + match[0].length;
        const foundQuote = scan(valueStart, contentEnd);
        if (foundQuote === null && match[1] === key) {
          spans.push({ start: lineStart, end: logicalEnd });
        } else if (foundQuote !== null) {
          quote = foundQuote;
          assignmentStart = lineStart;
          target = match[1] === key;
        }
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return spans;
}

function readEnvFile(context, { allowMissing = false } = {}) {
  assertAncestorChain(path.dirname(context.envPath));
  const listed = lstatOrMissing(context.envPath);
  if (!listed) {
    if (allowMissing) return undefined;
    fail("missing-env");
  }
  if (listed.isSymbolicLink() || !listed.isFile() || !currentOwner(listed) ||
    !envModeIsRestrictive(modeOf(listed)) || listed.size > MAX_ENV_BYTES) {
    fail("unsafe-env");
  }
  let descriptor;
  let result;
  let error;
  try {
    descriptor = openSync(context.envPath, READ_FLAGS);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !currentOwner(opened) ||
      !envModeIsRestrictive(modeOf(opened)) || !sameFileState(listed, opened)) {
      fail("unsafe-env");
    }
    const bytes = Buffer.from(readFileSync(descriptor));
    const final = fstatSync(descriptor);
    if (!final.isFile() || !currentOwner(final) ||
      !envModeIsRestrictive(modeOf(final)) || !sameFileState(opened, final) ||
      bytes.byteLength !== final.size || bytes.byteLength > MAX_ENV_BYTES) {
      fail("env-changed");
    }
    const spans = assignmentSpans(bytes, ENV_KEY);
    const assignments = parseEnvAssignments(bytes.toString("utf8"));
    result = { bytes, stat: final, spans, assignments };
  } catch (caught) {
    error = caught instanceof RevocationStateError ? caught : new RevocationStateError("filesystem-error");
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch {
      if (!error) error = new RevocationStateError("file-close");
    }
  }
  if (error) throw error;
  return result;
}

function buildEnvSnapshot(context, envFile) {
  if (envFile.spans.length !== 1 || envFile.assignments.length !== 1 ||
    !validString(envFile.assignments[0], 4096)) fail("invalid-local-key");
  const removed = Buffer.concat([
    envFile.bytes.subarray(0, envFile.spans[0].start),
    envFile.bytes.subarray(envFile.spans[0].end),
  ]);
  return {
    path: context.envPath,
    sha256: createHash("sha256").update(envFile.bytes).digest("hex"),
    size: envFile.bytes.byteLength,
    uid: envFile.stat.uid,
    gid: envFile.stat.gid,
    mode: modeOf(envFile.stat),
    dev: envFile.stat.dev,
    ino: envFile.stat.ino,
    assignment_count: 1,
    removed_sha256: createHash("sha256").update(removed).digest("hex"),
    removed_size: removed.byteLength,
  };
}

function readCurrentKey(context) {
  const envFile = readEnvFile(context);
  if (envFile.spans.length !== 1 || envFile.assignments.length !== 1 ||
    !validString(envFile.assignments[0], 4096)) fail("invalid-local-key");
  return { key: envFile.assignments[0], envFile };
}

function keyDigest(key) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function securityIdentityDigest(identity) {
  validateSecurityIdentity(identity);
  return createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex");
}

function readAndVerifyCurrentKey(context, state) {
  const current = readCurrentKey(context);
  const snapshot = buildEnvSnapshot(context, current.envFile);
  if (keyDigest(current.key) !== state.key_sha256 ||
    JSON.stringify(snapshot) !== JSON.stringify(state.env)) fail("local-key-changed");
  return current.key;
}

function providerDataFromResponse(body) {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_RAW_RESPONSE_BYTES) {
    fail("invalid-provider-response");
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail("invalid-provider-response");
  }
  const data = isObject(parsed?.data) ? parsed.data : parsed;
  if (!isObject(data) || !Object.hasOwn(data, "label") ||
    !Object.hasOwn(data, "expires_at") || !Object.hasOwn(data, "limit")) {
    fail("invalid-provider-response");
  }
  if (!isObject(parsed?.data)) return data;
  const inherited = {};
  for (const name of [
    "account_id",
    "accountId",
    "account_name",
    "accountName",
    "endpoint_id",
    "endpointId",
  ]) {
    if (Object.hasOwn(parsed, name) && !Object.hasOwn(data, name)) {
      inherited[name] = parsed[name];
    }
  }
  return Object.keys(inherited).length === 0 ? data : { ...data, ...inherited };
}

function optionalProviderIdentifier(data, names) {
  const present = names.filter((name) => Object.hasOwn(data, name));
  if (present.length === 0) return null;
  const value = data[present[0]];
  if (value === null) return null;
  if (!validString(value, 4096)) fail("invalid-provider-response");
  for (const name of present.slice(1)) {
    if (data[name] !== value) fail("invalid-provider-response");
  }
  return value;
}

function localMaskForKey(key) {
  if (!validString(key, 4096)) fail("invalid-local-key");
  return "****";
}

function stableProviderProjection(value) {
  if (Array.isArray(value)) return value.map((entry) => stableProviderProjection(entry));
  if (!isObject(value)) return value;
  const projected = {};
  for (const name of Object.keys(value).sort()) {
    if (DYNAMIC_RESPONSE_FIELDS.has(name) || name === "label") continue;
    if (name === "key") {
      if (!validString(value[name], 4096)) fail("invalid-provider-response");
      projected[name] = keyDigest(value[name]);
    } else {
      projected[name] = stableProviderProjection(value[name]);
    }
  }
  return projected;
}

function securityIdentityFromResponse(body, key, endpoint) {
  const data = providerDataFromResponse(body);
  const providerKeyFingerprint = Object.hasOwn(data, "key")
    ? (validString(data.key, 4096) ? keyDigest(data.key) : fail("invalid-provider-response"))
    : null;
  const account = isObject(data.account) ? data.account : undefined;
  const accountData = account && Object.hasOwn(account, "id")
    ? { ...data, account_id: account.id }
    : typeof data.account === "string"
      ? { ...data, account_id: data.account }
      : data;
  const accountNameData = account && Object.hasOwn(account, "name")
    ? { ...data, account_name: account.name }
    : data;
  const accountId = optionalProviderIdentifier(
    accountData,
    ["account_id", "accountId"],
  );
  const accountName = optionalProviderIdentifier(
    accountNameData,
    ["account_name", "accountName"],
  );
  const stableFields = stableProviderProjection(data);
  const identity = {
    key_fingerprint: keyDigest(key),
    provider_key_fingerprint: providerKeyFingerprint,
    key_id: optionalProviderIdentifier(data, ["id", "key_id", "keyId"]),
    local_mask: localMaskForKey(key),
    endpoint,
    endpoint_id: optionalProviderIdentifier(data, ["endpoint_id", "endpointId"]),
    account_id: accountId,
    account_name: accountName,
    provider_stable_sha256: createHash("sha256")
      .update(canonicalJson(stableFields), "utf8")
      .digest("hex"),
  };
  validateSecurityIdentity(identity);
  if (providerKeyFingerprint !== null && providerKeyFingerprint !== keyDigest(key)) {
    fail("preflight-response-changed");
  }
  return identity;
}

function assertSecurityIdentityMatches(expected, actual, code = "preflight-response-changed") {
  validateSecurityIdentity(expected);
  validateSecurityIdentity(actual);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail(code);
}

function maskLabel(value) {
  if (!validString(value, 4096)) fail("invalid-provider-response");
  // Provider mask markers are data, not a security boundary. Do not copy any
  // label bytes, including apparent prefixes/suffixes, into local output.
  return "****";
}

function maskedFieldsFromResponse(body) {
  const data = providerDataFromResponse(body);
  const masked = {
    label: maskLabel(data.label),
    expires_at: data.expires_at === null ? null : data.expires_at,
    limit: data.limit === null ? null : data.limit,
  };
  validateMasked(masked);
  return masked;
}

async function readHttpBody(response) {
  if (Buffer.isBuffer(response.body)) {
    if (response.body.byteLength > MAX_RAW_RESPONSE_BYTES) {
      fail("provider-response-too-large");
    }
    return response.body.toString("utf8");
  }
  if (typeof response.body === "string") {
    if (Buffer.byteLength(response.body, "utf8") > MAX_RAW_RESPONSE_BYTES) {
      fail("provider-response-too-large");
    }
    return response.body;
  }
  if (typeof response.text !== "function") return "";
  let body;
  try {
    body = await response.text();
  } catch {
    fail("provider-request-failed");
  }
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_RAW_RESPONSE_BYTES) {
    fail("provider-response-too-large");
  }
  return body;
}

async function withDeadline(promise, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RevocationStateError("provider-deadline")), milliseconds);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function validateResponseMetadata(response) {
  if (!response || !Number.isInteger(response.status) || response.status < 100 ||
    response.status > 599 || response.url !== OPENROUTER_KEY_URL ||
    response.redirected !== false) fail("provider-endpoint");
}

async function requestKey(context, key) {
  const timeoutMs = context.httpTimeoutMs ?? HTTP_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("invalid-deadline");
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  if (context.httpGet) {
    try {
      const response = await withDeadline(context.httpGet({
        url: OPENROUTER_KEY_URL,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${key}`,
        },
        signal: undefined,
      }), remaining());
      validateResponseMetadata(response);
      return {
        status: response.status,
        body: await withDeadline(readHttpBody(response), remaining()),
        url: response.url,
      };
    } catch (error) {
      if (error instanceof RevocationStateError) throw error;
      fail("provider-request-failed");
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining());
  try {
    const response = await fetch(OPENROUTER_KEY_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
      redirect: "error",
    });
    validateResponseMetadata(response);
    return {
      status: response.status,
      body: await withDeadline(readHttpBody(response), remaining()),
      url: response.url,
    };
  } catch (error) {
    if (error instanceof RevocationStateError) throw error;
    fail(controller.signal.aborted ? "provider-deadline" : "provider-request-failed");
  } finally {
    clearTimeout(timeout);
  }
}

function pathsFor(options) {
  const evidenceRoot = options.evidenceRoot ?? EVIDENCE_ROOT;
  return {
    envPath: options.envPath ?? ENV_PATH,
    evidenceRoot,
    statePath: path.join(evidenceRoot, STATE_FILE_NAME),
    rawPath: path.join(evidenceRoot, RAW_RESPONSE_FILE_NAME),
    receiptPath: path.join(evidenceRoot, RECEIPT_FILE_NAME),
    lockPath: path.join(evidenceRoot, LOCK_FILE_NAME),
  };
}

function readOptionalJson(filePath, maxBytes) {
  const stat = lstatOrMissing(filePath);
  if (!stat) return undefined;
  return readJsonFile(filePath, maxBytes);
}

function stateEntryPaths(context) {
  const entries = [];
  for (const name of readdirSync(context.evidenceRoot)) {
    const match = STATE_ENTRY_NAME_RE.exec(name);
    if (!match) continue;
    entries.push({
      path: path.join(context.evidenceRoot, name),
      sequence: match[1] === undefined ? 0 : Number(match[1]),
    });
  }
  entries.sort((left, right) => left.sequence - right.sequence);
  return entries;
}

function readStateJournal(context, { required = true } = {}) {
  const entries = stateEntryPaths(context);
  if (entries.length === 0) {
    if (required) fail("missing-state");
    return undefined;
  }
  if (entries[0].sequence !== 0 || entries.some((entry, index) => entry.sequence !== index)) {
    fail("malformed-evidence");
  }
  const records = entries.map((entry) => {
    const text = assertReadableFile(entry.path, MAX_JSON_BYTES, FILE_MODE);
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
      fail("malformed-evidence");
    }
    try {
      return validateState(JSON.parse(text.slice(0, -1)));
    } catch (error) {
      if (error instanceof RevocationStateError) throw error;
      fail("malformed-evidence");
    }
  });
  const first = records[0];
  if (first.state !== "preflight-captured") fail("invalid-transition");
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    for (const field of [
      "response_sha256",
      "key_sha256",
      "security_identity",
      "captured_at",
      "env",
    ]) {
      if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) {
        fail("state-context-mismatch");
      }
    }
    if (JSON.stringify(previous.masked) !== JSON.stringify(current.masked) &&
      !isRawlessMaskedRecovery(previous, current)) {
      fail("state-context-mismatch");
    }
    if (previous.raw && current.raw && JSON.stringify(previous.raw) !== JSON.stringify(current.raw)) {
      fail("state-context-mismatch");
    }
    const allowed = (previous.state === "preflight-captured" &&
      (current.state === "preflight-captured" || current.state === "awaiting-user")) ||
      (previous.state === "awaiting-user" && current.state === "revoked") ||
      (previous.state === "revoked" && current.state === "local-removed");
    if (!allowed) fail("invalid-transition");
    if (previous.raw && !current.raw) fail("state-context-mismatch");
    if (current.state === "awaiting-user" && !current.raw) fail("malformed-evidence");
    if (current.state === "revoked" && !current.raw) fail("malformed-evidence");
    if (current.state === "local-removed" && !current.raw) fail("malformed-evidence");
  }
  return records;
}

function readState(context, { required = true } = {}) {
  const records = readStateJournal(context, { required });
  const state = records === undefined ? undefined : records.at(-1);
  if (state && state.env.path !== context.envPath) fail("state-context-mismatch");
  if (state) context.securityIdentity = state.security_identity;
  return state;
}

function readReceipt(context) {
  const receipt = readOptionalJson(context.receiptPath, MAX_JSON_BYTES);
  return receipt === undefined ? undefined : validateReceipt(receipt);
}

function rawBindingFromStat(stat, digest) {
  return {
    sha256: digest,
    size: stat.size,
    uid: stat.uid,
    gid: stat.gid,
    mode: modeOf(stat),
    dev: stat.dev,
    ino: stat.ino,
  };
}

function assertRaw(context, expectedHash, expectedBinding = null) {
  const listed = lstatOrMissing(context.rawPath);
  if (!listed) fail("missing-raw-response");
  if (listed.isSymbolicLink() || !listed.isFile() || !currentOwner(listed) ||
    modeOf(listed) !== FILE_MODE) fail("unsafe-file");
  const text = assertReadableFile(context.rawPath, MAX_RAW_RESPONSE_BYTES, FILE_MODE);
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  if (expectedHash !== null && digest !== expectedHash) fail("raw-response-mismatch");
  const final = lstatOrMissing(context.rawPath);
  if (!final || !sameFileState(listed, final)) fail("raw-response-changed");
  const binding = rawBindingFromStat(final, digest);
  if (expectedBinding && JSON.stringify(binding) !== JSON.stringify(expectedBinding)) {
    fail("raw-response-mismatch");
  }
  return { text, binding };
}

function rawExists(context) {
  return lstatOrMissing(context.rawPath) !== undefined;
}

function removeRaw(context, state) {
  const parentPath = path.dirname(context.rawPath);
  const parentState = lstatOrMissing(parentPath);
  if (!parentState || !isSafeAncestor(parentState)) fail("unsafe-ancestor");
  const stat = lstatOrMissing(context.rawPath);
  if (!stat) {
    fsyncDirectory(context.evidenceRoot);
    return;
  }
  if (!state.raw) fail("missing-raw-response");
  assertRaw(context, state.raw.sha256, state.raw);
  let descriptor;
  let unlinked = false;
  try {
    descriptor = openSync(context.rawPath, READ_FLAGS);
    const opened = fstatSync(descriptor);
    if (!sameFileState(stat, opened) || JSON.stringify(
      rawBindingFromStat(opened, state.raw.sha256),
    ) !== JSON.stringify(state.raw)) fail("raw-response-changed");
    // The descriptor remains open and is rechecked immediately before unlink;
    // a path substitution is therefore detected rather than deleted.
    invokeHook(context, "raw-before-unlink");
    const current = lstatOrMissing(context.rawPath);
    const currentFd = fstatSync(descriptor);
    if (!current || !sameFileState(stat, current) || !sameFileState(stat, currentFd) ||
      !sameIdentity(parentState, lstatOrMissing(parentPath))) {
      fail("raw-response-changed");
    }
    // Rehash the retained descriptor after the last pathname check. This
    // catches an in-place overwrite that preserves inode and size, which a
    // metadata-only binding cannot see.
    const digest = readDescriptorDigest(descriptor, MAX_RAW_RESPONSE_BYTES);
    const afterHashPath = lstatOrMissing(context.rawPath);
    if (!afterHashPath || !sameFileState(stat, afterHashPath) ||
      !sameIdentity(parentState, lstatOrMissing(parentPath)) ||
      !sameFileState(stat, digest.stat) || digest.size !== state.raw.size ||
      digest.sha256 !== state.raw.sha256) fail("raw-response-changed");
    unlinkSync(context.rawPath);
    unlinked = true;
  } catch (error) {
    if (error instanceof RevocationStateError) throw error;
    fail("filesystem-error");
  } finally {
    if (descriptor !== undefined) {
      try {
        invokeHook(context, "raw-before-close");
        closeSync(descriptor);
      } catch {
        // The raw pathname is already durably unlinked; a close/cleanup
        // failure must not make the caller replay a completed removal.
        try { closeSync(descriptor); } catch { if (!unlinked) fail("file-close"); }
        if (!unlinked) fail("file-close");
      }
    }
  }
  if (rawExists(context)) fail("raw-response-present");
  invokeHook(context, "raw-after-unlink");
  fsyncDirectory(context.evidenceRoot);
  invokeHook(context, "raw-directory-fsynced");
}

const RELEASED_LOCK_TOKENS = new Set();

function parseLockText(text) {
  const normalized = text.trim();
  const complete = /^(\d+) ([a-f0-9]{24})$/u.exec(normalized);
  if (complete) {
    const pid = Number(complete[1]);
    if (Number.isSafeInteger(pid) && pid > 0) return { pid, token: complete[2], complete: true };
  }
  // The final lock pathname is never written incrementally by this version.
  // Empty and old-format numeric partials are therefore recoverable remnants,
  // while arbitrary text remains a fail-closed malformed lock.
  if (normalized === "" || /^\d+(?: [a-f0-9]{0,23})?$/u.test(normalized)) {
    return { complete: false };
  }
  fail("malformed-lock");
}

function readLockRecord(descriptor, { changed = false } = {}) {
  let content;
  try {
    content = readDescriptorContent(descriptor, 128);
  } catch (error) {
    if (changed && error instanceof RevocationStateError &&
      error.code === "temporary-changed") {
      fail("lock-changed");
    }
    throw error;
  }
  const text = content.bytes.toString("utf8");
  if (Buffer.from(text, "utf8").byteLength !== content.size) {
    fail("lock-changed");
  }
  let owner;
  try {
    owner = parseLockText(text);
  } catch (error) {
    if (changed && error instanceof RevocationStateError && error.code === "malformed-lock") {
      fail("lock-changed");
    }
    throw error;
  }
  return {
    ...owner,
    content: text,
    sha256: content.sha256,
    size: content.size,
    stat: content.stat,
  };
}

function assertLockRecord(actual, expected) {
  if (actual.content !== expected.content || actual.sha256 !== expected.sha256 ||
    actual.size !== expected.size || actual.complete !== expected.complete ||
    (expected.complete &&
      (actual.pid !== expected.pid || actual.token !== expected.token))) {
    fail("lock-changed");
  }
}

function unlinkLockIdentity(context, stat, descriptor, expected, hookName) {
  const opened = readLockRecord(descriptor);
  if (!sameFileState(stat, opened.stat)) fail("lock-changed");
  assertLockRecord(opened, expected);
  if (hookName) invokeHook(context, hookName);
  // This is the last content read. It deliberately happens before the final
  // pathname identity check so a same-inode, same-size overwrite is preserved.
  const retained = readLockRecord(descriptor, { changed: true });
  if (!sameFileState(stat, retained.stat)) fail("lock-changed");
  assertLockRecord(retained, expected);
  const current = lstatOrMissing(context.lockPath);
  if (!current || !sameFileState(stat, current) ||
    !sameFileState(stat, retained.stat)) fail("lock-changed");
  unlinkSync(context.lockPath);
  if (lstatOrMissing(context.lockPath)) fail("lock-changed");
}

function staleLock(context) {
  const stat = lstatOrMissing(context.lockPath);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile() || !currentOwner(stat) ||
    modeOf(stat) !== FILE_MODE || stat.size > 128) fail("malformed-lock");
  let descriptor;
  try {
    descriptor = openSync(context.lockPath, READ_FLAGS);
    const owner = readLockRecord(descriptor);
    if (!sameFileState(stat, owner.stat)) fail("lock-changed");
    let stale = !owner.complete;
    if (owner.complete) {
      if (owner.pid === process.pid && RELEASED_LOCK_TOKENS.has(owner.token)) {
        stale = true;
      } else {
        try {
          process.kill(owner.pid, 0);
          stale = false;
        } catch (error) {
          if (error?.code !== "ESRCH") fail("operation-in-progress");
          stale = true;
        }
      }
    }
    if (!stale) return false;
    unlinkLockIdentity(context, stat, descriptor, owner, "lock-before-stale-unlink");
    fsyncDirectory(context.evidenceRoot);
    return true;
  } catch (error) {
    if (error instanceof RevocationStateError) throw error;
    fail("lock-error");
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { fail("lock-error"); }
    }
  }
}

function validateTempManifest(manifest, name) {
  if (!isObject(manifest) || !exactKeys(manifest, [
    "schema", "kind", "operation_kind", "target", "temporary", "sha256", "size", "pid",
  ]) || manifest.schema !== SCHEMA_VERSION ||
    manifest.kind !== "openrouter-revocation-temp-manifest" ||
    !["state", "raw", "receipt", "lock"].includes(manifest.operation_kind) ||
    !validString(manifest.target, 4096) || manifest.target.includes(path.sep) ||
    !validString(manifest.temporary, 4096) || manifest.temporary.includes(path.sep) ||
    !/^[a-f0-9]{64}$/u.test(manifest.sha256) || !validInteger(manifest.size) ||
    !validInteger(manifest.pid) || manifest.pid === 0) fail("temporary-cleanup");
  const maxBytes = manifest.operation_kind === "raw" ? MAX_RAW_RESPONSE_BYTES : MAX_JSON_BYTES;
  if (manifest.size > maxBytes) fail("temporary-cleanup");
  const fileMatch = TEMP_MANIFEST_NAME_RE.exec(name);
  const tempMatch = TEMP_NAME_RE.exec(manifest.temporary);
  if (!fileMatch || !tempMatch || fileMatch[2] !== tempMatch[2] ||
    Number(fileMatch[1]) !== manifest.pid || Number(tempMatch[1]) !== manifest.pid ||
    !manifest.temporary.startsWith(`${manifest.target}.tmp-`)) fail("temporary-cleanup");
  const expectedTarget = manifest.operation_kind === "raw" ? RAW_RESPONSE_FILE_NAME :
    manifest.operation_kind === "receipt" ? RECEIPT_FILE_NAME :
      manifest.operation_kind === "lock" ? LOCK_FILE_NAME : undefined;
  if ((expectedTarget && manifest.target !== expectedTarget) ||
    (manifest.operation_kind === "state" && !STATE_ENTRY_NAME_RE.test(manifest.target))) {
    fail("temporary-cleanup");
  }
  return manifest;
}

function cleanupManifest(context, manifestFile, manifest, manifestStat, manifestDigest, manifestSize) {
  const temporary = path.join(context.evidenceRoot, manifest.temporary);
  const stat = lstatOrMissing(temporary);
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isFile() || !currentOwner(stat) ||
      modeOf(stat) !== FILE_MODE) {
      fail("temporary-cleanup");
    }
    const maxBytes = manifest.operation_kind === "raw" ? MAX_RAW_RESPONSE_BYTES : MAX_JSON_BYTES;
    if (stat.size > maxBytes) fail("temporary-cleanup");
    let descriptor;
    try {
      descriptor = openSync(temporary, READ_FLAGS);
      const before = readDescriptorDigest(descriptor, maxBytes);
      if (!sameFileState(stat, before.stat) ||
        (before.sha256 !== manifest.sha256 && before.size >= manifest.size)) {
        fail("temporary-cleanup");
      }
      invokeHook(context, "recovery-before-temp-unlink");
      const current = lstatOrMissing(temporary);
      if (!current || !sameFileState(stat, current) || !sameFileState(stat, fstatSync(descriptor))) {
        fail("temporary-cleanup");
      }
      const after = readDescriptorDigest(descriptor, maxBytes);
      if (!sameFileState(stat, after.stat) ||
        (after.sha256 !== manifest.sha256 && after.size >= manifest.size)) {
        fail("temporary-cleanup");
      }
      unlinkSync(temporary);
      if (lstatOrMissing(temporary)) fail("temporary-cleanup");
    } catch (error) {
      if (error instanceof RevocationStateError) throw error;
      fail("temporary-cleanup");
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { fail("temporary-cleanup"); }
      }
    }
  }
  // Once the temporary has been renamed, the publication itself is immutable
  // and the target is validated by its normal reader. The manifest is only an
  // ownership record for the still-uncommitted temporary; checking the target
  // here would let an old manifest mask the precise state/raw/receipt error.
  const listedManifest = lstatOrMissing(manifestFile);
  if (!listedManifest || listedManifest.isSymbolicLink() || !listedManifest.isFile() ||
    !currentOwner(listedManifest) || modeOf(listedManifest) !== FILE_MODE ||
    !sameFileState(listedManifest, manifestStat)) fail("temporary-cleanup");
  let descriptor;
  try {
    descriptor = openSync(manifestFile, READ_FLAGS);
    const digest = readDescriptorDigest(descriptor, MAX_JSON_BYTES);
    if (!sameFileState(listedManifest, digest.stat) || digest.size !== manifestSize ||
      digest.sha256 !== manifestDigest) fail("temporary-cleanup");
    unlinkSync(manifestFile);
  } catch {
    fail("temporary-cleanup");
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { fail("temporary-cleanup"); }
    }
  }
  if (lstatOrMissing(manifestFile)) fail("temporary-cleanup");
}

function cleanupTemporaryFiles(context) {
  let removed = false;
  for (const name of readdirSync(context.evidenceRoot)) {
    if (!TEMP_MANIFEST_NAME_RE.test(name)) continue;
    const manifestFile = path.join(context.evidenceRoot, name);
    const stat = lstatOrMissing(manifestFile);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || !currentOwner(stat) ||
      modeOf(stat) !== FILE_MODE || stat.size > MAX_JSON_BYTES) fail("temporary-cleanup");
    const manifestText = assertReadableFile(manifestFile, MAX_JSON_BYTES, FILE_MODE);
    if (manifestText.length === 0) {
      // A crash at manifest-opened precedes creation of its temporary. The
      // exact owned-manifest namespace makes this empty remnant recoverable;
      // arbitrary .tmp files are never scanned here.
      const digest = contentDigest(manifestText);
      unlinkManifest(manifestFile, stat, digest.sha256, digest.bytes.byteLength);
      removed = true;
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(manifestText); } catch { fail("temporary-cleanup"); }
    const manifest = validateTempManifest(parsed, name);
    const digest = contentDigest(manifestText);
    cleanupManifest(context, manifestFile, manifest, stat, digest.sha256, digest.bytes.byteLength);
    removed = true;
  }
  if (removed) fsyncDirectory(context.evidenceRoot);
}

function acquireLock(context) {
  ensureEvidenceRoot(context.evidenceRoot);
  if (lstatOrMissing(context.lockPath) && !staleLock(context)) fail("operation-in-progress");
  const token = randomBytes(12).toString("hex");
  const payload = `${process.pid} ${token}\n`;
  publishFile(context.lockPath, payload, context, { exclusive: true, kind: "lock" });
  let descriptor;
  try {
    descriptor = openSync(context.lockPath, READ_FLAGS);
    const listed = lstatOrMissing(context.lockPath);
    const expected = readLockRecord(descriptor);
    if (!listed || !sameFileState(listed, expected.stat) || !expected.complete ||
      expected.pid !== process.pid || expected.token !== token) fail("lock-changed");
    context.lockDescriptor = descriptor;
    context.lockStat = listed;
    context.lockToken = token;
    context.lockExpected = expected;
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* the lock remains recoverable */ }
    }
    if (error instanceof RevocationStateError) throw error;
    fail("lock-error");
  }
}

function releaseLock(context, { skipHook = false } = {}) {
  const descriptor = context.lockDescriptor;
  if (descriptor === undefined) return;
  let unlinked = false;
  try {
    const stat = lstatOrMissing(context.lockPath);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || !currentOwner(stat) ||
      modeOf(stat) !== FILE_MODE || !sameFileState(stat, context.lockStat) ||
      !context.lockExpected) fail("lock-changed");
    unlinkLockIdentity(
      context,
      stat,
      descriptor,
      context.lockExpected,
      skipHook ? undefined : "lock-before-unlink",
    );
    unlinked = true;
    fsyncDirectory(context.evidenceRoot);
  } catch (error) {
    if (error instanceof RevocationStateError) throw error;
    fail("lock-error");
  } finally {
    context.lockDescriptor = undefined;
    context.lockExpected = undefined;
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { if (!unlinked) fail("lock-error"); }
    }
    if (!unlinked && context.lockToken) RELEASED_LOCK_TOKENS.add(context.lockToken);
  }
}

async function withLock(context, callback) {
  acquireLock(context);
  let result;
  let operationError;
  try {
    cleanupTemporaryFiles(context);
    result = await callback();
  } catch (error) {
    operationError = error;
  }
  let releaseError;
  try {
    releaseLock(context);
  } catch (error) {
    releaseError = error;
    // A one-shot release failure (for example, an injected crash probe) must
    // not leave a live same-process lock. The retry still checks inode
    // identity, so it cannot delete a substituted pathname.
    try { releaseLock(context, { skipHook: true }); } catch { /* stale recovery owns it */ }
  }
  if (operationError) throw operationError;
  if (releaseError && result === undefined) throw releaseError;
  return result;
}

function stateRecord(state, masked, responseSha256, keySha256, capturedAt, context, extra = {}) {
  const record = {
    schema: SCHEMA_VERSION,
    kind: "openrouter-revocation",
    state,
    response_sha256: responseSha256,
    key_sha256: keySha256,
    security_identity: extra.security_identity ?? context.securityIdentity,
    masked,
    captured_at: capturedAt,
    env: extra.env ?? context.envSnapshot,
    raw: extra.raw ?? null,
    ...extra,
  };
  if (!record.env) fail("missing-env-snapshot");
  validateState(record);
  return record;
}

function stateTargetPath(context) {
  const entries = stateEntryPaths(context);
  if (entries.length === 0) return context.statePath;
  const next = entries.at(-1).sequence + 1;
  if (next > 99_999_999) fail("state-too-large");
  return path.join(context.evidenceRoot, `openrouter-revocation-state.json.seq-${String(next).padStart(8, "0")}`);
}

function snapshotPublicationGuards(context) {
  return stateEntryPaths(context).map((entry) => {
    const stat = lstatOrMissing(entry.path);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || !currentOwner(stat) ||
      modeOf(stat) !== FILE_MODE) fail("state-changed");
    const text = assertReadableFile(entry.path, MAX_JSON_BYTES, FILE_MODE);
    return {
      path: entry.path,
      stat,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      size: Buffer.byteLength(text, "utf8"),
    };
  });
}

function verifyPublicationGuards(context) {
  for (const guard of context.publicationGuards ?? []) {
    const listed = lstatOrMissing(guard.path);
    if (!listed || listed.isSymbolicLink() || !listed.isFile() ||
      !currentOwner(listed) || modeOf(listed) !== FILE_MODE ||
      !sameFileState(listed, guard.stat)) fail("state-changed");
    let descriptor;
    try {
      descriptor = openSync(guard.path, READ_FLAGS);
      const digest = readDescriptorDigest(descriptor, MAX_JSON_BYTES);
      if (!sameFileState(listed, digest.stat) || digest.size !== guard.size ||
        digest.sha256 !== guard.sha256) fail("state-changed");
    } catch (error) {
      if (error instanceof RevocationStateError) throw error;
      fail("state-changed");
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { fail("state-changed"); }
      }
    }
  }
}

function publishState(context, record) {
  const target = stateTargetPath(context);
  context.publicationGuards = snapshotPublicationGuards(context);
  context.stateHasPrior = context.publicationGuards.length > 0;
  try {
    publishFile(target, canonicalJson(record), context, {
      exclusive: true,
      kind: "state",
    });
  } finally {
    context.publicationGuards = undefined;
    context.stateHasPrior = undefined;
  }
}

function publishRaw(context, raw) {
  publishFile(context.rawPath, raw, context, {
    exclusive: true,
    kind: "raw",
  });
  const published = lstatOrMissing(context.rawPath);
  if (!published) fail("missing-raw-response");
  const digest = createHash("sha256").update(raw, "utf8").digest("hex");
  return rawBindingFromStat(published, digest);
}

function publishReceipt(context, receipt) {
  publishFile(context.receiptPath, canonicalJson(receipt), context, {
    exclusive: true,
    kind: "receipt",
  });
}

function receiptFor(state, context) {
  const receipt = {
    schema: SCHEMA_VERSION,
    kind: "openrouter-revocation",
    state: "revoked",
    http_status: 401,
    response_sha256: state.response_sha256,
    recorded_at: now(context),
  };
  validateReceipt(receipt);
  return receipt;
}

function assertReceiptMatches(state, receipt) {
  if (!receipt || receipt.response_sha256 !== state.response_sha256) {
    fail("receipt-mismatch");
  }
}

function loadRawMasked(context, state, { allowMaskedRefresh = false } = {}) {
  const raw = assertRaw(context, state.raw?.sha256 ?? null, state.raw);
  const key = readAndVerifyCurrentKey(context, state);
  const identity = securityIdentityFromResponse(raw.text, key, OPENROUTER_KEY_URL);
  assertSecurityIdentityMatches(state.security_identity, identity, "raw-response-mismatch");
  const masked = maskedFieldsFromResponse(raw.text);
  if (!allowMaskedRefresh && JSON.stringify(masked) !== JSON.stringify(state.masked)) {
    fail("raw-response-mismatch");
  }
  return { binding: raw.binding, masked };
}

function removalIntentFor(env) {
  return {
    path: env.path,
    original_sha256: env.sha256,
    original_size: env.size,
    uid: env.uid,
    gid: env.gid,
    mode: env.mode,
    dev: env.dev,
    ino: env.ino,
    removed_sha256: env.removed_sha256,
    removed_size: env.removed_size,
    assignment_count: env.assignment_count,
  };
}

function assertLocalAbsent(context, state) {
  if (!state.removal_intent || state.removal_intent.path !== context.envPath) {
    fail("local-removal-not-authorized");
  }
  const current = readEnvFile(context, { allowMissing: true });
  if (!current) {
    // A durable revoked record is the pre-removal intent/snapshot. It is the
    // only condition under which crash-post-rename absence is accepted, and
    // pathname absence is safe only when the prepared transformed output was
    // exactly empty. Otherwise this could accept deletion of unrelated bytes.
    if (state.removal_intent.removed_size !== 0) fail("local-file-changed");
    return;
  }
  if (current.stat.uid !== state.env.uid || current.stat.gid !== state.env.gid ||
    modeOf(current.stat) !== state.env.mode) fail("local-file-changed");
  if (current.spans.length !== 0) fail("local-key-present");
  const digest = createHash("sha256").update(current.bytes).digest("hex");
  if (digest !== state.removal_intent.removed_sha256 ||
    current.bytes.byteLength !== state.removal_intent.removed_size) {
    fail("local-file-changed");
  }
}

function promoteAwaiting(context, state) {
  const awaiting = stateRecord(
    "awaiting-user",
    state.masked,
    state.response_sha256,
    state.key_sha256,
    state.captured_at,
    context,
    { env: state.env, raw: state.raw },
  );
  publishState(context, awaiting);
  return awaiting;
}

async function prepare(context) {
  let state = readState(context, { required: false });
  const receipt = readReceipt(context);
  if (receipt && !state) fail("orphaned-receipt");
  if (state?.state === "revoked" || state?.state === "local-removed") {
    fail("invalid-transition");
  }
  if (state?.state === "preflight-captured") {
    if (rawExists(context)) {
      const loaded = loadRawMasked(context, state, { allowMaskedRefresh: !state.raw });
      if (!state.raw) {
        state = stateRecord(
          "preflight-captured",
          loaded.masked,
          state.response_sha256,
          state.key_sha256,
          state.captured_at,
          context,
          {
            env: state.env,
            raw: loaded.binding,
            security_identity: state.security_identity,
          },
        );
        publishState(context, state);
      }
    } else {
      if (state.raw) fail("missing-raw-response");
      const key = readAndVerifyCurrentKey(context, state);
      const response = await requestKey(context, key);
      if (response.status !== 200) fail("preflight-not-accepted");
      const raw = response.body;
      const masked = maskedFieldsFromResponse(raw);
      const identity = securityIdentityFromResponse(raw, key, response.url);
      assertSecurityIdentityMatches(state.security_identity, identity);
      const rawBinding = publishRaw(context, raw);
      state = stateRecord(
        "preflight-captured",
        masked,
        state.response_sha256,
        state.key_sha256,
        state.captured_at,
        context,
        {
          env: state.env,
          raw: rawBinding,
          security_identity: state.security_identity,
        },
      );
      publishState(context, state);
    }
    state = promoteAwaiting(context, state);
  } else if (!state) {
    if (receipt) fail("orphaned-receipt");
    if (rawExists(context)) fail("orphaned-evidence");
    const current = readCurrentKey(context);
    const env = buildEnvSnapshot(context, current.envFile);
    context.envSnapshot = env;
    const response = await requestKey(context, current.key);
    if (response.status !== 200) fail("preflight-not-accepted");
    const raw = response.body;
    const masked = maskedFieldsFromResponse(raw);
    const identity = securityIdentityFromResponse(raw, current.key, response.url);
    context.securityIdentity = identity;
    const responseIdentityHash = securityIdentityDigest(identity);
    state = stateRecord(
      "preflight-captured",
      masked,
      responseIdentityHash,
      keyDigest(current.key),
      now(context),
      context,
      { env, raw: null, security_identity: identity },
    );
    publishState(context, state);
    const rawBinding = publishRaw(context, raw);
    state = stateRecord(
      "preflight-captured",
      masked,
      responseIdentityHash,
      state.key_sha256,
      state.captured_at,
      context,
      { env, raw: rawBinding, security_identity: identity },
    );
    publishState(context, state);
    state = promoteAwaiting(context, state);
  } else {
    loadRawMasked(context, state);
  }
  return { state: state.state, output: state.masked };
}

async function completeRevocation(context, state, receipt) {
  if (receipt) {
    assertReceiptMatches(state, receipt);
  } else {
    publishReceipt(context, receiptFor(state, context));
  }

  if (state.state === "awaiting-user") {
    const revoked = stateRecord(
      "revoked",
      state.masked,
      state.response_sha256,
      state.key_sha256,
      state.captured_at,
      context,
      {
        env: state.env,
        raw: state.raw,
        revoked_at: now(context),
        removal_intent: removalIntentFor(state.env),
      },
    );
    publishState(context, revoked);
    state = revoked;
  }
  if (state.state !== "revoked") fail("invalid-transition");
  const storedReceipt = readReceipt(context);
  assertReceiptMatches(state, storedReceipt);
  removeRaw(context, state);
  if (rawExists(context)) fail("raw-response-present");
  return state;
}

async function resume(context) {
  let state = readState(context);
  const receipt = readReceipt(context);
  if (state.state === "local-removed") {
    assertReceiptMatches(state, receipt);
    assertLocalAbsent(context, state);
    if (rawExists(context)) fail("raw-response-present");
    return { state: state.state };
  }
  if (state.state === "revoked") {
    assertReceiptMatches(state, receipt);
    removeRaw(context, state);
    if (rawExists(context)) fail("raw-response-present");
    return { state: state.state };
  }
  if (state.state !== "awaiting-user") fail("invalid-transition");
  if (receipt) {
    // The receipt is enough to finish a crash-recovery transition, but the
    // original local key is still required while the operation is awaiting
    // user confirmation. This prevents a different key from being accepted
    // merely because the raw 200 body was already lost.
    readAndVerifyCurrentKey(context, state);
    await completeRevocation(context, state, receipt);
    return { state: "revoked" };
  }

  if (!state.raw) fail("missing-raw-response");
  assertRaw(context, state.raw.sha256, state.raw);
  const key = readAndVerifyCurrentKey(context, state);
  const response = await requestKey(context, key);
  if (response.status === 200) {
    return { state: "awaiting-user" };
  }
  if (response.status !== 401) fail("revocation-not-proven");
  await completeRevocation(context, state, undefined);
  return { state: "revoked" };
}

async function markLocalRemoved(context) {
  const state = readState(context);
  const receipt = readReceipt(context);
  if (state.state === "local-removed") {
    assertReceiptMatches(state, receipt);
    assertLocalAbsent(context, state);
    if (rawExists(context)) fail("raw-response-present");
    return { state: state.state };
  }
  if (state.state !== "revoked") fail("invalid-transition");
  assertReceiptMatches(state, receipt);
  if (rawExists(context)) fail("raw-response-present");
  assertLocalAbsent(context, state);
  const localRemoved = stateRecord(
    "local-removed",
    state.masked,
    state.response_sha256,
    state.key_sha256,
    state.captured_at,
    context,
    {
      revoked_at: state.revoked_at,
      env: state.env,
      raw: state.raw,
      removal_intent: state.removal_intent,
      local_removed_at: now(context),
    },
  );
  publishState(context, localRemoved);
  return { state: localRemoved.state };
}

async function assertComplete(context) {
  const state = readState(context);
  const receipt = readReceipt(context);
  if (state.state !== "local-removed") fail("not-complete");
  assertReceiptMatches(state, receipt);
  assertLocalAbsent(context, state);
  if (rawExists(context)) fail("raw-response-present");
  return { state: state.state };
}

function contextFor(options = {}) {
  const usingTestAdapter = options.testAdapter === TEST_ADAPTER;
  if (!usingTestAdapter && (options.envPath !== undefined ||
    options.evidenceRoot !== undefined || options.httpGet !== undefined ||
    options.hooks !== undefined || options.now !== undefined ||
    options.httpTimeoutMs !== undefined)) {
    fail("test-adapter-required");
  }
  const paths = pathsFor(usingTestAdapter ? options : {});
  ensureEvidenceRoot(paths.evidenceRoot);
  assertAncestorChain(path.dirname(paths.envPath));
  return {
    ...paths,
    httpGet: usingTestAdapter ? options.httpGet : undefined,
    hooks: usingTestAdapter ? options.hooks : undefined,
    now: usingTestAdapter ? options.now : undefined,
    httpTimeoutMs: usingTestAdapter ? options.httpTimeoutMs : undefined,
  };
}

export async function runOperation(operation, options = {}) {
  if (!OPERATIONS.includes(operation)) fail("invalid-operation");
  const context = contextFor(options);
  return withLock(context, async () => {
    switch (operation) {
      case "prepare":
        return prepare(context);
      case "resume":
        return resume(context);
      case "mark-local-removed":
        return markLocalRemoved(context);
      case "assert-complete":
        return assertComplete(context);
      default:
        fail("invalid-operation");
    }
  });
}

export async function main(argv = process.argv.slice(2), options = {}) {
  if (!Array.isArray(argv) || argv.length !== 1 || !OPERATIONS.includes(argv[0])) {
    fail("invalid-operation");
  }
  return runOperation(argv[0], options);
}

function isMainModule() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH;
}

if (isMainModule()) {
  main()
    .then((result) => {
      if (result?.output !== undefined) {
        process.stdout.write(`${JSON.stringify(result.output)}\n`);
      }
    })
    .catch(() => {
      process.stderr.write("openrouter-revocation-state: failed\n");
      process.exitCode = 1;
    });
}
