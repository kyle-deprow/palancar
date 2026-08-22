#!/usr/bin/env node

import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const PROTECTED_TFVARS_PATH = path.resolve(
  path.dirname(SCRIPT_PATH),
  "../environments/dev/terraform.tfvars",
);
export const TARGET_ASSIGNMENT =
  "enable_runtime_secrets_user_assignment";
export const SUPPORTED_MODES = Object.freeze([
  "assert-enabled",
  "disable",
  "assert-disabled",
]);

const TARGET_BYTES = Buffer.from(TARGET_ASSIGNMENT, "ascii");
const TRUE_BYTES = Buffer.from("true", "ascii");
const FALSE_BYTES = Buffer.from("false", "ascii");
const PRIVATE_MODE_MAX = 0o600;
const OPERATION_DIRECTORY_MODE = 0o700;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const BIGINT_STAT_OPTIONS = Object.freeze({ bigint: true });
const INTERNAL_ERROR = "protected tfvars operation failed";
const USAGE_ERROR = "protected tfvars usage error";
const INTERNAL_LOCKED_MARKER = "--locked";
const KERNEL_LOCK_NAME = ".terraform.tfvars.lock";
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const O_CLOEXEC = fs.constants.O_CLOEXEC ?? 0;
const READ_FLAGS = fs.constants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC;
const WRITE_FLAGS =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  O_NOFOLLOW |
  O_CLOEXEC;
const MANIFEST_NAME = "manifest";
const INITIAL_RECOVERY_NAME = "recovery";
const MANIFEST_VERSION = 1;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const EXCHANGE_HELPER = "/usr/bin/python3";
const EXCHANGE_HELPER_REALPATH_RE = /^\/usr\/bin\/python3(?:\.[0-9]+)*$/u;
const EXCHANGE_TIMEOUT_MS = 3000;
const LOCK_TIMEOUT_MS = 3000;
const RENAME_EXCHANGE = 2;
const FLOCK_PATH = "/usr/bin/flock";
const NODE_PATH = "/usr/bin/node";
const LOCK_FD = 3;

// Fixed code; only non-secret basenames are supplied as argv.  The directory
// descriptors are supplied as fd 3 and fd 4 and the child has no environment
// or output channel.  Deletion is done only after an atomic exchange into a
// helper-created quarantine entry.  If the exchanged inode is not the inode
// bound by fd 4, the helper leaves both names in place and fails closed.
const EXCHANGE_HELPER_CODE = [
  "import ctypes,os,sys",
  "if len(sys.argv) not in (3,5): os._exit(64)",
  "operation=sys.argv[1].encode('utf-8')",
  "name=sys.argv[2].encode('utf-8')",
  "if operation==b'remove-bound-exchange':",
  "  if len(sys.argv)!=5: os._exit(64)",
  "  kind=sys.argv[2].encode('utf-8')",
  "  entry_name=sys.argv[3].encode('utf-8')",
  "  quarantine=sys.argv[4].encode('utf-8')",
  "  if kind not in (b'file',b'directory') or not entry_name or not quarantine or b'/' in entry_name or b'/' in quarantine or entry_name in (b'.',b'..') or quarantine in (b'.',b'..') or entry_name==quarantine: os._exit(64)",
  "  libc=ctypes.CDLL(None,use_errno=True)",
  "  renameat2=getattr(libc,'renameat2',None)",
  "  if renameat2 is None: os._exit(70)",
  "  renameat2.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]",
  "  renameat2.restype=ctypes.c_int",
  "  placeholder=-1",
  "  quarantined=-1",
  "  try:",
  "    if kind==b'file': placeholder=os.open(quarantine,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=3)",
  "    else:",
  "      os.mkdir(quarantine,0o700,dir_fd=3)",
  "      placeholder=os.open(quarantine,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=3)",
  "    if renameat2(3,entry_name,3,quarantine," + String(RENAME_EXCHANGE) + ")!=0: os._exit(71)",
  "    quarantined=os.open(quarantine,os.O_RDONLY|os.O_DIRECTORY*int(kind==b'directory')|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=3)",
  "    bound=os.fstat(4)",
  "    exchanged=os.fstat(quarantined)",
  "    if (exchanged.st_dev,exchanged.st_ino)!=(bound.st_dev,bound.st_ino) or (kind==b'file' and not os.path.isfile('/proc/self/fd/'+str(quarantined))) or (kind==b'directory' and not os.path.isdir('/proc/self/fd/'+str(quarantined))): os._exit(73)",
  "    if kind==b'file': os.unlink(quarantine,dir_fd=3)",
  "    else: os.rmdir(quarantine,dir_fd=3)",
  "    if kind==b'file': os.unlink(entry_name,dir_fd=3)",
  "    else: os.rmdir(entry_name,dir_fd=3)",
  "  except (OSError,ValueError): os._exit(72)",
  "  finally:",
  "    if quarantined>=0: os.close(quarantined)",
  "    if placeholder>=0: os.close(placeholder)",
  "  os._exit(0)",
  "source=operation",
  "target=name",
  "if not source or not target or b'/' in source or b'/' in target or source in (b'.',b'..') or target in (b'.',b'..'): os._exit(64)",
  "libc=ctypes.CDLL(None,use_errno=True)",
  "renameat2=getattr(libc,'renameat2',None)",
  "if renameat2 is None: os._exit(70)",
  "renameat2.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]",
  "renameat2.restype=ctypes.c_int",
  "if renameat2(3,source,4,target," + String(RENAME_EXCHANGE) + ")!=0: os._exit(71)",
  "os._exit(0)",
].join("\n");

const DIRECTORY_CREATION_HELPER_CODE = [
  "import os,sys",
  "if len(sys.argv)!=2: os._exit(64)",
  "name=sys.argv[1].encode('utf-8')",
  "if not name or b'/' in name or name in (b'.',b'..'): os._exit(64)",
  "fd=-1",
  "try:",
  "  os.mkdir(name,0o700,dir_fd=3)",
  "  raw_fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=3)",
  "  if raw_fd!=4: os.dup2(raw_fd,4); os.close(raw_fd)",
  "  fd=4",
  "  os.write(1,b'1')",
  "  os.read(0,1)",
  "except (OSError,ValueError): os._exit(71)",
  "finally:",
  "  if fd>=0: os.close(fd)",
  "os._exit(0)",
].join("\n");

const REAL_FS = fs;

class ProtectedTfvarsError extends Error {
  constructor() {
    super(INTERNAL_ERROR);
    this.name = "ProtectedTfvarsError";
  }
}

function fail() {
  throw new ProtectedTfvarsError();
}

function isIdentifierByte(byte) {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x5f ||
    byte === 0x2d
  );
}

function isIdentifierStartByte(byte) {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f
  );
}

function isWhitespaceByte(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function skipLineComment(source, offset) {
  let cursor = offset;
  while (cursor < source.length && source[cursor] !== 0x0a) cursor += 1;
  return cursor;
}

function skipBlockComment(source, offset) {
  const end = source.indexOf(Buffer.from("*/"), offset + 2);
  return end === -1 ? null : end + 2;
}

function skipQuotedString(source, offset) {
  let cursor = offset + 1;
  while (cursor < source.length) {
    if (source[cursor] === 0x5c) {
      cursor += Math.min(2, source.length - cursor);
      continue;
    }
    if (source[cursor] === source[offset]) return cursor + 1;
    cursor += 1;
  }
  return null;
}

function findLineEnd(source, offset) {
  const lineEnd = source.indexOf(0x0a, offset);
  return lineEnd === -1 ? source.length : lineEnd;
}

function skipHeredoc(source, offset) {
  const headerEnd = findLineEnd(source, offset);
  let header = source.subarray(offset, headerEnd).toString("utf8");
  if (header.endsWith("\r")) header = header.slice(0, -1);
  const match = /^<<(-)?[ \t]*([A-Za-z_][A-Za-z0-9_-]*)[ \t]*$/.exec(
    header,
  );
  if (match === null) return undefined;

  const delimiter = match[2];
  let cursor = headerEnd === source.length ? source.length : headerEnd + 1;
  while (cursor < source.length) {
    const lineEnd = findLineEnd(source, cursor);
    let line = source.subarray(cursor, lineEnd).toString("utf8");
    if (line.endsWith("\r")) line = line.slice(0, -1);
    line = line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    if (line === delimiter) {
      return lineEnd === source.length ? source.length : lineEnd + 1;
    }
    cursor = lineEnd === source.length ? source.length : lineEnd + 1;
  }
  return null;
}

function skipTrivia(source, offset) {
  let cursor = offset;
  while (cursor < source.length) {
    if (isWhitespaceByte(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source[cursor] === 0x23) {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (
      source[cursor] === 0x2f &&
      source[cursor + 1] === 0x2f
    ) {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (
      source[cursor] === 0x2f &&
      source[cursor + 1] === 0x2a
    ) {
      cursor = skipBlockComment(source, cursor);
      if (cursor === null) fail();
      continue;
    }
    break;
  }
  return cursor;
}

function hasStandaloneLiteralTail(source, offset) {
  let cursor = offset;
  let crossedLine = false;
  while (cursor < source.length) {
    if (isWhitespaceByte(source[cursor])) {
      if (source[cursor] === 0x0a) crossedLine = true;
      cursor += 1;
      continue;
    }
    if (
      source[cursor] === 0x23 ||
      (source[cursor] === 0x2f && source[cursor + 1] === 0x2f)
    ) {
      cursor = skipLineComment(source, cursor);
      crossedLine = true;
      continue;
    }
    if (source[cursor] === 0x2f && source[cursor + 1] === 0x2a) {
      const commentEnd = skipBlockComment(source, cursor);
      if (commentEnd === null) fail();
      if (
        source.indexOf(0x0a, cursor) !== -1 &&
        source.indexOf(0x0a, cursor) < commentEnd
      ) {
        crossedLine = true;
      }
      cursor = commentEnd;
      continue;
    }
    break;
  }
  if (cursor === source.length) return true;
  if (!crossedLine) return false;
  return isIdentifierStartByte(source[cursor]);
}

function statBigInt(stat, field) {
  const value = stat?.[field];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  fail();
}

function sameStatField(left, right, field) {
  return statBigInt(left, field) === statBigInt(right, field);
}

function sameIdentity(left, right) {
  return sameStatField(left, right, "dev") && sameStatField(left, right, "ino");
}

function sameTargetSnapshot(left, right) {
  return (
    sameIdentity(left, right) &&
    sameStatField(left, right, "uid") &&
    sameStatField(left, right, "gid") &&
    sameStatField(left, right, "mode") &&
    sameStatField(left, right, "size") &&
    sameStatField(left, right, "mtimeNs") &&
    sameStatField(left, right, "ctimeNs")
  );
}

function permissionMode(stat) {
  return Number(statBigInt(stat, "mode") & 0o7777n);
}

function validateProtectedStat(stat, uid) {
  if (!stat.isFile() || statBigInt(stat, "uid") !== BigInt(uid)) fail();
  const mode = permissionMode(stat);
  if (mode > PRIVATE_MODE_MAX || (mode & 0o077) !== 0) fail();
}

function currentUid() {
  if (typeof process.getuid !== "function") fail();
  return process.getuid();
}

function closeQuietly(api, fd) {
  if (fd === undefined || fd === null || fd < 0) return true;
  try {
    api.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function readFdContent(api, fd, sizeStat) {
  const size = statBigInt(sizeStat, "size");
  if (size < 0n || size > MAX_SAFE_INTEGER_BIGINT) fail();
  const length = Number(size);
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = api.readSync(fd, bytes, offset, length - offset, offset);
    if (!Number.isInteger(read) || read <= 0) fail();
    offset += read;
  }
  return bytes;
}

function readFdSnapshot(api, fd, uid) {
  const before = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
  validateProtectedStat(before, uid);
  const bytes = readFdContent(api, fd, before);
  const after = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
  validateProtectedStat(after, uid);
  if (!sameTargetSnapshot(before, after)) fail();
  return { bytes, stat: after, digest: contentDigest(bytes) };
}

function readProtectedFile(filePath, api, keepOpen) {
  const uid = currentUid();
  let listed;
  let fd = -1;
  try {
    listed = api.lstatSync(filePath, BIGINT_STAT_OPTIONS);
    if (listed.isSymbolicLink()) fail();
    validateProtectedStat(listed, uid);

    fd = api.openSync(filePath, READ_FLAGS);
    const opened = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
    validateProtectedStat(opened, uid);
    if (!sameTargetSnapshot(listed, opened)) fail();

    const snapshot = readFdSnapshot(api, fd, uid);
    if (!sameTargetSnapshot(opened, snapshot.stat)) fail();

    if (keepOpen) {
      return {
        bytes: snapshot.bytes,
        fd,
        stat: snapshot.stat,
        digest: snapshot.digest,
      };
    }
    if (!closeQuietly(api, fd)) fail();
    fd = -1;
    return { bytes: snapshot.bytes, stat: snapshot.stat, digest: snapshot.digest };
  } catch (error) {
    if (!closeQuietly(api, fd)) fail();
    if (error instanceof ProtectedTfvarsError) throw error;
    fail();
  }
}

function byteEquals(source, offset, value) {
  if (offset + value.length > source.length) return false;
  return source.subarray(offset, offset + value.length).equals(value);
}

function parseTargetAssignments(source) {
  if (!Buffer.isBuffer(source)) fail();

  const assignments = [];
  let cursor =
    source.length >= 3 &&
    source[0] === 0xef &&
    source[1] === 0xbb &&
    source[2] === 0xbf
      ? 3
      : 0;
  const delimiters = [];
  let lineHasCode = false;

  while (cursor < source.length) {
    const byte = source[cursor];

    if (byte === 0x0a) {
      cursor += 1;
      lineHasCode = false;
      continue;
    }
    if (byte === 0x20 || byte === 0x09 || byte === 0x0d) {
      cursor += 1;
      continue;
    }
    if (byte === 0x23) {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (byte === 0x2f && source[cursor + 1] === 0x2f) {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (byte === 0x2f && source[cursor + 1] === 0x2a) {
      const commentEnd = skipBlockComment(source, cursor);
      if (commentEnd === null) fail();
      const lastNewline = source.lastIndexOf(0x0a, commentEnd - 1);
      if (lastNewline >= cursor) lineHasCode = false;
      cursor = commentEnd;
      continue;
    }
    if (byte === 0x22 || byte === 0x27) {
      const stringEnd = skipQuotedString(source, cursor);
      if (stringEnd === null) fail();
      const lastNewline = source.lastIndexOf(0x0a, stringEnd - 1);
      lineHasCode = lastNewline >= cursor;
      cursor = stringEnd;
      continue;
    }
    if (byte === 0x3c && source[cursor + 1] === 0x3c) {
      const heredocEnd = skipHeredoc(source, cursor);
      if (heredocEnd === null) fail();
      if (heredocEnd === undefined) fail();
      lineHasCode = false;
      cursor = heredocEnd;
      continue;
    }
    if (byte === 0x7b || byte === 0x5b || byte === 0x28) {
      delimiters.push(byte);
      lineHasCode = true;
      cursor += 1;
      continue;
    }
    if (byte === 0x7d || byte === 0x5d || byte === 0x29) {
      const expectedOpen = byte === 0x7d ? 0x7b : byte === 0x5d ? 0x5b : 0x28;
      if (delimiters.pop() !== expectedOpen) fail();
      lineHasCode = true;
      cursor += 1;
      continue;
    }
    if (!isIdentifierStartByte(byte)) {
      lineHasCode = true;
      cursor += 1;
      continue;
    }

    const wordStart = cursor;
    cursor += 1;
    while (cursor < source.length && isIdentifierByte(source[cursor])) {
      cursor += 1;
    }
    const word = source.subarray(wordStart, cursor);
    const isTarget =
      delimiters.length === 0 &&
      !lineHasCode &&
      word.length === TARGET_BYTES.length &&
      word.equals(TARGET_BYTES);
    if (!isTarget) {
      lineHasCode = true;
      continue;
    }

    let valueCursor = skipTrivia(source, cursor);
    if (source[valueCursor] !== 0x3d) {
      lineHasCode = true;
      continue;
    }
    valueCursor = skipTrivia(source, valueCursor + 1);
    const valueStart = valueCursor;
    let value;
    if (byteEquals(source, valueCursor, TRUE_BYTES)) {
      const end = valueCursor + 4;
      value =
        (end === source.length || !isIdentifierByte(source[end])) &&
        hasStandaloneLiteralTail(source, end)
          ? "true"
          : "invalid";
      valueCursor = end;
    } else if (byteEquals(source, valueCursor, FALSE_BYTES)) {
      const end = valueCursor + 5;
      value =
        (end === source.length || !isIdentifierByte(source[end])) &&
        hasStandaloneLiteralTail(source, end)
          ? "false"
          : "invalid";
      valueCursor = end;
    } else {
      value = "invalid";
      while (
        valueCursor < source.length &&
        !isWhitespaceByte(source[valueCursor]) &&
        source[valueCursor] !== 0x23 &&
        !(source[valueCursor] === 0x2f && source[valueCursor + 1] === 0x2f) &&
        !(source[valueCursor] === 0x2f && source[valueCursor + 1] === 0x2a)
      ) {
        valueCursor += 1;
      }
    }
    assignments.push({ value, valueStart, valueEnd: valueCursor });
    lineHasCode = true;
  }

  if (delimiters.length !== 0) fail();
  return assignments;
}

export function inspectAssignments(source) {
  const assignments = parseTargetAssignments(
    Buffer.isBuffer(source) ? source : Buffer.from(source),
  );
  return Object.freeze({
    count: assignments.length,
    values: Object.freeze(assignments.map(({ value }) => value)),
    enabled:
      assignments.length === 0 ||
      (assignments.length === 1 && assignments[0].value === "true"),
    disabled:
      assignments.length === 1 && assignments[0].value === "false",
  });
}

function isEnabled(assignments) {
  return (
    assignments.length === 0 ||
    (assignments.length === 1 && assignments[0].value === "true")
  );
}

function isDisabled(assignments) {
  return assignments.length === 1 && assignments[0].value === "false";
}

function assertDisabledBytes(source) {
  if (!isDisabled(parseTargetAssignments(source))) fail();
}

function replacementBytes(source, assignments) {
  if (assignments.length === 0) {
    const separator = source.length === 0 || source[source.length - 1] === 0x0a
      ? Buffer.alloc(0)
      : Buffer.from("\n", "ascii");
    return Buffer.concat([
      source,
      separator,
      Buffer.from(`${TARGET_ASSIGNMENT} = false\n`, "ascii"),
    ]);
  }
  if (assignments.length !== 1 || assignments[0].value !== "true") fail();
  const { valueStart, valueEnd } = assignments[0];
  return Buffer.concat([
    source.subarray(0, valueStart),
    Buffer.from("false", "ascii"),
    source.subarray(valueEnd),
  ]);
}

function writeAll(api, fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = api.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) fail();
    offset += written;
  }
}

function contentDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function statMetadata(stat) {
  return Object.freeze({
    uid: statBigInt(stat, "uid"),
    gid: statBigInt(stat, "gid"),
    mode: permissionMode(stat),
    size: statBigInt(stat, "size"),
  });
}

function sameMetadata(stat, expected) {
  return (
    statBigInt(stat, "uid") === expected.uid &&
    statBigInt(stat, "gid") === expected.gid &&
    permissionMode(stat) === expected.mode &&
    statBigInt(stat, "size") === expected.size
  );
}

function sameProtectedMetadata(stat, expected) {
  return (
    statBigInt(stat, "uid") === expected.uid &&
    statBigInt(stat, "gid") === expected.gid &&
    permissionMode(stat) === expected.mode
  );
}

function identityRecord(stat) {
  return Object.freeze({
    dev: statBigInt(stat, "dev").toString(),
    ino: statBigInt(stat, "ino").toString(),
    uid: statBigInt(stat, "uid").toString(),
    gid: statBigInt(stat, "gid").toString(),
    mode: permissionMode(stat).toString(),
    size: statBigInt(stat, "size").toString(),
  });
}

function validIdentityRecord(record) {
  if (record === null || typeof record !== "object") return false;
  for (const field of ["dev", "ino", "uid", "gid", "mode", "size"]) {
    if (typeof record[field] !== "string" || !/^\d+$/u.test(record[field])) {
      return false;
    }
  }
  try {
    const mode = BigInt(record.mode);
    return mode <= 0o7777n && (mode & 0o077n) === 0n;
  } catch {
    return false;
  }
}

function sameIdentityRecord(stat, record) {
  return (
    validIdentityRecord(record) &&
    statBigInt(stat, "dev") === BigInt(record.dev) &&
    statBigInt(stat, "ino") === BigInt(record.ino) &&
    statBigInt(stat, "uid") === BigInt(record.uid) &&
    statBigInt(stat, "gid") === BigInt(record.gid) &&
    permissionMode(stat) === Number(BigInt(record.mode)) &&
    statBigInt(stat, "size") === BigInt(record.size)
  );
}

function sameManifestFileIdentity(stat, record) {
  return (
    validIdentityRecord(record) &&
    statBigInt(stat, "dev") === BigInt(record.dev) &&
    statBigInt(stat, "ino") === BigInt(record.ino) &&
    statBigInt(stat, "uid") === BigInt(record.uid) &&
    statBigInt(stat, "gid") === BigInt(record.gid) &&
    permissionMode(stat) === Number(BigInt(record.mode))
  );
}

function metadataFromIdentity(record) {
  if (!validIdentityRecord(record)) fail();
  return Object.freeze({
    uid: BigInt(record.uid),
    gid: BigInt(record.gid),
    mode: Number(BigInt(record.mode)),
    size: BigInt(record.size),
  });
}

function canonicalManifest(manifest) {
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

function safeEntryName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    path.basename(name) === name &&
    !name.includes(path.sep)
  );
}

function stopDirectoryCreator(child) {
  try {
    child.stdin?.end();
  } catch {
    // The helper is being terminated below.
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The helper may have exited after publishing its descriptor.
  }
  try {
    child.unref();
  } catch {
    // There is no remaining child handle to release.
  }
}

function createDirectoryAt(api, parentFd, name) {
  if (!Number.isInteger(parentFd) || parentFd < 0 || !safeEntryName(name)) fail();
  verifyExchangeHelper();
  let child;
  let boundFd = -1;
  try {
    child = spawn(
      EXCHANGE_HELPER,
      ["-c", DIRECTORY_CREATION_HELPER_CODE, name],
      {
        cwd: "/",
        env: Object.create(null),
        stdio: ["pipe", "pipe", "ignore", parentFd],
      },
    );
    child.on("error", () => {});
    const readyFd = child.stdout?._handle?.fd;
    if (!Number.isInteger(readyFd) || readyFd < 0) fail();
    const ready = Buffer.alloc(1);
    let readyBytes = 0;
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < EXCHANGE_TIMEOUT_MS; attempt += 1) {
      try {
        readyBytes = REAL_FS.readSync(readyFd, ready, 0, 1, null);
        break;
      } catch (error) {
        if (error?.code !== "EAGAIN") throw error;
        Atomics.wait(waitBuffer, 0, 0, 1);
      }
    }
    if (readyBytes !== 1 || ready[0] !== 0x31) {
      fail();
    }
    child.stdout.destroy();
    boundFd = REAL_FS.openSync(
      `/proc/${child.pid}/fd/4`,
      fs.constants.O_RDONLY | O_DIRECTORY | O_CLOEXEC,
    );
    const identity = REAL_FS.fstatSync(boundFd, BIGINT_STAT_OPTIONS);
    if (!identity.isDirectory()) fail();
    return { fd: boundFd, identity };
  } catch (error) {
    if (!closeQuietly(REAL_FS, boundFd)) fail();
    if (error instanceof ProtectedTfvarsError) throw error;
    fail();
  } finally {
    if (child !== undefined) stopDirectoryCreator(child);
  }
}

function bindCreatedDirectory(api, parent, name, uid) {
  const directoryPath = path.join(parent.path, name);
  let createdFd = -1;
  let pathFd = -1;
  let createdStat;
  try {
    const created = createDirectoryAt(api, parent.fd, name);
    createdFd = created.fd;
    createdStat = created.identity;
    // This recursive mkdir is only a pathname existence check.  Creation is
    // already complete through mkdirat(2); the descriptor comparison below
    // makes a substitution that occurs inside this call fail closed.
    api.mkdirSync(directoryPath, {
      mode: OPERATION_DIRECTORY_MODE,
      recursive: true,
    });
    pathFd = api.openSync(
      directoryPath,
      fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
    );
    const listed = api.lstatSync(directoryPath, BIGINT_STAT_OPTIONS);
    const opened = api.fstatSync(pathFd, BIGINT_STAT_OPTIONS);
    if (
      !listed.isDirectory() ||
      !opened.isDirectory() ||
      !sameIdentity(createdStat, opened) ||
      !sameIdentity(createdStat, listed) ||
      statBigInt(createdStat, "uid") !== BigInt(uid) ||
      statBigInt(opened, "uid") !== BigInt(uid) ||
      statBigInt(listed, "uid") !== BigInt(uid) ||
      permissionMode(createdStat) !== OPERATION_DIRECTORY_MODE ||
      permissionMode(opened) !== OPERATION_DIRECTORY_MODE ||
      permissionMode(listed) !== OPERATION_DIRECTORY_MODE
    ) {
      fail();
    }
    if (!closeQuietly(api, pathFd)) fail();
    pathFd = -1;
    return {
      name,
      path: directoryPath,
      fd: createdFd,
      identity: createdStat,
    };
  } catch (error) {
    let pathnameStillBound = false;
    if (createdFd >= 0 && pathFd >= 0) {
      try {
        pathnameStillBound = sameIdentity(
          REAL_FS.lstatSync(directoryPath, BIGINT_STAT_OPTIONS),
          createdStat,
        );
      } catch {
        pathnameStillBound = false;
      }
    }
    if (pathnameStillBound) {
      try {
        removeBoundDirectoryEntry(api, parent, name, createdFd, "directory");
        try {
          fsyncDirectoryFd(api, parent.fd);
        } catch {
          // The directory is already removed.
        }
      } catch {
        // Preserve a substituted directory and fail closed.
      }
    }
    closeQuietly(api, pathFd);
    closeQuietly(api, createdFd);
    if (error instanceof ProtectedTfvarsError) throw error;
    fail();
  }
}

function makeOperationDirectory(api, filePath) {
  const directoryPath = path.dirname(filePath);
  let parentFd = -1;
  try {
    parentFd = api.openSync(
      directoryPath,
      fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
    );
  } catch {
    fail();
  }
  let parentIdentity;
  try {
    parentIdentity = api.fstatSync(parentFd, BIGINT_STAT_OPTIONS);
    const listedParent = api.lstatSync(directoryPath, BIGINT_STAT_OPTIONS);
    if (
      !parentIdentity.isDirectory() ||
      !listedParent.isDirectory() ||
      !sameIdentity(parentIdentity, listedParent) ||
      statBigInt(parentIdentity, "uid") !== BigInt(currentUid())
    ) {
      fail();
    }
  } catch (error) {
    if (!closeQuietly(api, parentFd)) fail();
    if (error instanceof ProtectedTfvarsError) throw error;
    fail();
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const operationPath = path.join(
      directoryPath,
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.op`,
    );
    const operationName = path.basename(operationPath);
    let createdFd = -1;
    let pathFd = -1;
    let operation;
    try {
      const created = bindCreatedDirectory(
        api,
        { path: directoryPath, fd: parentFd },
        operationName,
        currentUid(),
      );
      createdFd = created.fd;
      operation = {
        parentPath: directoryPath,
        parentFd,
        parentIdentity,
        parentName: path.basename(directoryPath),
        createdName: operationName,
        path: operationPath,
        isOperation: true,
        identity: created.identity,
        fd: -1,
        entries: [],
        created: true,
      };
      pathFd = api.openSync(
        operationPath,
        fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
      );
      const opened = api.fstatSync(pathFd, BIGINT_STAT_OPTIONS);
      const listed = api.lstatSync(operationPath, BIGINT_STAT_OPTIONS);
      if (
        !opened.isDirectory() ||
        !listed.isDirectory() ||
        !sameIdentity(opened, operation.identity) ||
        !sameIdentity(listed, operation.identity) ||
        statBigInt(opened, "uid") !== BigInt(currentUid()) ||
        statBigInt(listed, "uid") !== BigInt(currentUid()) ||
        permissionMode(opened) !== OPERATION_DIRECTORY_MODE ||
        permissionMode(listed) !== OPERATION_DIRECTORY_MODE
      ) {
        fail();
      }
      if (!closeQuietly(api, pathFd)) fail();
      pathFd = -1;
      operation.fd = createdFd;
      createdFd = -1;
      api.fchmodSync(operation.fd, OPERATION_DIRECTORY_MODE);
      return operation;
    } catch (error) {
      closeQuietly(api, pathFd);
      if (operation?.fd >= 0 && operation.identity !== undefined) {
        try {
          removeBoundDirectoryEntry(
            api,
            { path: operation.parentPath, fd: operation.parentFd },
            operation.createdName,
            operation.fd,
            "directory",
          );
          try {
            fsyncDirectoryFd(api, operation.parentFd);
          } catch {
            // The directory is already removed.
          }
        } catch {
          // Preserve a substituted entry and fail closed.
        }
      }
      closeQuietly(api, createdFd);
      if (operation?.fd >= 0) closeQuietly(api, operation.fd);
      if (error?.code === "EEXIST") continue;
      if (!closeQuietly(api, parentFd)) fail();
      if (error instanceof ProtectedTfvarsError) throw error;
      fail();
    }
  }
  closeQuietly(api, parentFd);
  fail();
}

function operationEntryPath(operation, stem, fixedName = undefined) {
  const name = fixedName ?? `${stem}-${randomUUID()}.tmp`;
  if (!safeEntryName(name)) fail();
  return { name, path: path.join(operation.path, name) };
}

function validateOperationDirectory(api, operation, uid) {
  const listed = api.lstatSync(operation.path, BIGINT_STAT_OPTIONS);
  const opened = api.fstatSync(operation.fd, BIGINT_STAT_OPTIONS);
  if (
    !listed.isDirectory() ||
    !opened.isDirectory() ||
    statBigInt(listed, "uid") !== BigInt(uid) ||
    statBigInt(opened, "uid") !== BigInt(uid) ||
    permissionMode(listed) !== OPERATION_DIRECTORY_MODE ||
    permissionMode(opened) !== OPERATION_DIRECTORY_MODE ||
    !sameIdentity(listed, opened)
  ) {
    fail();
  }
}

function validateEntryPath(operation, entry) {
  if (
    path.dirname(entry.path) !== operation.path ||
    path.basename(entry.path) !== entry.name
  ) {
    fail();
  }
}

function readEntryDigest(api, entry, options = {}) {
  const snapshot = readFdSnapshot(api, entry.fd, currentUid());
  if (
    !sameProtectedMetadata(snapshot.stat, entry.expected) ||
    (!options.allowSizeChange && statBigInt(snapshot.stat, "size") !== entry.expected.size)
  ) {
    fail();
  }
  if (options.digest !== undefined && snapshot.digest !== options.digest) fail();
  return snapshot;
}

function verifyBoundOperationEntry(api, operation, entry, uid, options = {}) {
  validateOperationDirectory(api, operation, uid);
  validateEntryPath(operation, entry);
  const listed = api.lstatSync(entry.path, BIGINT_STAT_OPTIONS);
  if (listed.isSymbolicLink()) fail();
  validateProtectedStat(listed, uid);
  const opened = api.fstatSync(entry.fd, BIGINT_STAT_OPTIONS);
  validateProtectedStat(opened, uid);
  if (
    !sameIdentity(listed, opened) ||
    !sameProtectedMetadata(listed, entry.expected) ||
    (!options.allowSizeChange && statBigInt(listed, "size") !== entry.expected.size)
  ) {
    fail();
  }
  const snapshot = readEntryDigest(api, entry, {
    allowSizeChange: options.allowSizeChange,
    digest: Object.hasOwn(options, "digest") ? options.digest : entry.digest,
  });
  if (!sameTargetSnapshot(listed, snapshot.stat)) fail();
  return snapshot;
}

function openOperationEntry(
  api,
  operation,
  stem,
  mode,
  expected,
  bytes,
  uid,
  options = {},
) {
  let entryPath;
  let fd = -1;
  let entry;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    entryPath = operationEntryPath(operation, stem, options.name);
    try {
      fd = api.openSync(entryPath.path, WRITE_FLAGS, mode);
      break;
    } catch (error) {
      if (error?.code === "EEXIST" && options.name === undefined) continue;
      fail();
    }
  }
  if (fd < 0 || entryPath === undefined) fail();
  try {
    entry = {
      name: entryPath.name,
      path: entryPath.path,
      fd,
      expected,
      digest: contentDigest(bytes),
      identity: undefined,
      kind: options.kind ?? stem,
      ready: false,
    };
    operation.entries.push(entry);

    const initial = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
    if (!initial.isFile()) fail();
    // Bind cleanup to the inode created by O_EXCL before any metadata or
    // content operation can fail.
    entry.identity = initial;
    if (
      statBigInt(initial, "uid") !== expected.uid ||
      statBigInt(initial, "gid") !== expected.gid
    ) {
      api.fchownSync(fd, Number(expected.uid), Number(expected.gid));
    }
    api.fchmodSync(fd, expected.mode);
    writeAll(api, fd, bytes);
    api.fsyncSync(fd);
    const prepared = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
    if (
      !prepared.isFile() ||
      !sameMetadata(prepared, expected) ||
      statBigInt(prepared, "size") !== BigInt(bytes.length)
    ) {
      fail();
    }
    entry.identity = prepared;
    verifyBoundOperationEntry(api, operation, entry, uid);
    entry.ready = true;
    return entry;
  } catch (error) {
    if (entry === undefined && !closeQuietly(api, fd)) fail();
    if (error instanceof ProtectedTfvarsError) throw error;
    fail();
  }
}

function createRestoreIntent(
  api,
  operation,
  filePath,
  restore,
  backupSnapshot,
  targetMetadata,
  uid,
) {
  const intent = Object.freeze({
    version: MANIFEST_VERSION,
    targetPath: filePath,
    restore: {
      name: restore.name,
      identity: identityRecord(restore.identity),
      digest: backupSnapshot.digest,
    },
  });
  const bytes = canonicalManifest(intent);
  const entry = openOperationEntry(
    api,
    operation,
    "restore-intent",
    PRIVATE_MODE_MAX,
    {
      uid: BigInt(uid),
      gid: targetMetadata.gid,
      mode: PRIVATE_MODE_MAX,
      size: BigInt(bytes.length),
    },
    bytes,
    uid,
    { kind: "restore-intent" },
  );
  entry.restoreIntent = intent;
  if (operation.restoreIntents === undefined) operation.restoreIntents = [];
  operation.restoreIntents.push({ entry, intent });
  fsyncDirectoryFd(api, operation.fd);
  fsyncDirectoryFd(api, operation.parentFd);
  return entry;
}

function openCandidate(api, operation, mode, expected, replacement, uid) {
  return openOperationEntry(
    api,
    operation,
    "candidate",
    mode,
    expected,
    replacement,
    uid,
  );
}

function createOperationManifest(
  api,
  operation,
  filePath,
  target,
  candidate,
  backup,
  targetMetadata,
  uid,
) {
  const manifest = Object.freeze({
    version: MANIFEST_VERSION,
    phase: "prepared",
    targetPath: filePath,
    operationDirectory: path.basename(operation.path),
    original: {
      identity: identityRecord(target.stat),
      digest: target.digest,
    },
    candidate: {
      name: candidate.name,
      identity: identityRecord(candidate.identity),
      digest: candidate.digest,
    },
    backup: {
      name: backup.name,
      identity: identityRecord(backup.identity),
      digest: backup.digest,
    },
  });
  const bytes = canonicalManifest(manifest);
  const entry = openOperationEntry(
    api,
    operation,
    MANIFEST_NAME,
    PRIVATE_MODE_MAX,
    {
      uid: BigInt(uid),
      gid: targetMetadata.gid,
      mode: PRIVATE_MODE_MAX,
      size: BigInt(bytes.length),
    },
    bytes,
    uid,
    { name: MANIFEST_NAME },
  );
  operation.manifest = manifest;
  operation.manifestEntry = entry;
  fsyncDirectoryFd(api, operation.fd);
  fsyncDirectoryFd(api, operation.parentFd);
  return manifest;
}

function createInitialRecoveryRecord(
  api,
  operation,
  filePath,
  target,
  targetMetadata,
  uid,
) {
  const record = Object.freeze({
    version: MANIFEST_VERSION,
    phase: "initial",
    targetPath: filePath,
    operationDirectory: path.basename(operation.path),
    original: {
      identity: identityRecord(target.stat),
      digest: target.digest,
    },
  });
  const bytes = canonicalManifest(record);
  const entry = openOperationEntry(
    api,
    operation,
    INITIAL_RECOVERY_NAME,
    PRIVATE_MODE_MAX,
    {
      uid: BigInt(uid),
      gid: targetMetadata.gid,
      mode: PRIVATE_MODE_MAX,
      size: BigInt(bytes.length),
    },
    bytes,
    uid,
    { name: INITIAL_RECOVERY_NAME, kind: "initial-recovery" },
  );
  operation.initialRecovery = record;
  operation.initialRecoveryEntry = entry;
  fsyncDirectoryFd(api, operation.fd);
  fsyncDirectoryFd(api, operation.parentFd);
  return record;
}

function verifyTargetStillOpen(
  api,
  filePath,
  targetFd,
  targetStat,
  targetBytes,
  uid,
) {
  const listed = api.lstatSync(filePath, BIGINT_STAT_OPTIONS);
  if (listed.isSymbolicLink()) fail();
  validateProtectedStat(listed, uid);
  const opened = api.fstatSync(targetFd, BIGINT_STAT_OPTIONS);
  validateProtectedStat(opened, uid);
  if (
    !sameTargetSnapshot(targetStat, listed) ||
    !sameTargetSnapshot(targetStat, opened)
  ) {
    fail();
  }

  const first = readFdSnapshot(api, targetFd, uid);
  const listedAfter = api.lstatSync(filePath, BIGINT_STAT_OPTIONS);
  if (listedAfter.isSymbolicLink()) fail();
  validateProtectedStat(listedAfter, uid);
  const openedAfter = api.fstatSync(targetFd, BIGINT_STAT_OPTIONS);
  validateProtectedStat(openedAfter, uid);
  if (
    !sameTargetSnapshot(targetStat, listedAfter) ||
    !sameTargetSnapshot(targetStat, openedAfter) ||
    !sameTargetSnapshot(first.stat, openedAfter)
  ) {
    fail();
  }

  const second = readFdSnapshot(api, targetFd, uid);
  if (
    !first.bytes.equals(second.bytes) ||
    !first.bytes.equals(targetBytes) ||
    !second.bytes.equals(targetBytes)
  ) {
    fail();
  }
}

function bindTargetBackup(
  api,
  operation,
  filePath,
  targetFd,
  targetBytes,
  targetMetadata,
  uid,
) {
  let entryPath;
  let fd = -1;
  let linked = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `backup-${randomUUID()}.bak`;
    entryPath = {
      name,
      path: path.join(operation.path, name),
    };
    try {
      api.linkSync(filePath, entryPath.path);
      linked = true;
      break;
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      fail();
    }
  }
  if (!linked || entryPath === undefined) fail();

  const backup = {
    name: entryPath.name,
    path: entryPath.path,
    fd: -1,
    expected: targetMetadata,
    digest: contentDigest(targetBytes),
    identity: undefined,
    ready: false,
    kind: "backup",
  };
  operation.entries.push(backup);
  try {
    fd = api.openSync(entryPath.path, READ_FLAGS);
    backup.fd = fd;
    const listed = api.lstatSync(entryPath.path, BIGINT_STAT_OPTIONS);
    const opened = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
    const target = api.fstatSync(targetFd, BIGINT_STAT_OPTIONS);
    validateProtectedStat(listed, uid);
    validateProtectedStat(opened, uid);
    if (
      !sameIdentity(listed, opened) ||
      !sameIdentity(opened, target) ||
      !sameProtectedMetadata(opened, targetMetadata)
    ) {
      fail();
    }
    backup.identity = opened;
    const snapshot = readFdSnapshot(api, fd, uid);
    if (
      !snapshot.bytes.equals(targetBytes) ||
      snapshot.digest !== backup.digest
    ) {
      fail();
    }
    const boundTarget = api.fstatSync(targetFd, BIGINT_STAT_OPTIONS);
    if (!sameIdentity(boundTarget, opened)) fail();
    backup.boundTargetStat = boundTarget;
    backup.ready = true;
    return backup;
  } catch (error) {
    if (error instanceof ProtectedTfvarsError) throw error;
    fail();
  }
}

function verifyInstalledEntry(
  api,
  filePath,
  candidate,
  replacement,
  expected,
  uid,
) {
  let fd = -1;
  try {
    const listed = api.lstatSync(filePath, BIGINT_STAT_OPTIONS);
    if (listed.isSymbolicLink()) fail();
    validateProtectedStat(listed, uid);
    fd = api.openSync(filePath, READ_FLAGS);
    const opened = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
    if (
      !sameTargetSnapshot(listed, opened) ||
      !sameMetadata(opened, expected) ||
      !sameIdentity(opened, api.fstatSync(candidate.fd, BIGINT_STAT_OPTIONS))
    ) {
      fail();
    }
    const snapshot = readFdSnapshot(api, fd, uid);
    const candidateSnapshot = readFdSnapshot(api, candidate.fd, uid);
    if (snapshot.digest !== candidate.digest) fail();
    if (snapshot.digest !== contentDigest(replacement)) fail();
    assertDisabledBytes(snapshot.bytes);
    if (!snapshot.bytes.equals(replacement) || !candidateSnapshot.bytes.equals(replacement)) fail();
    if (!sameTargetSnapshot(snapshot.stat, candidateSnapshot.stat)) fail();
    return snapshot;
  } finally {
    if (!closeQuietly(api, fd)) fail();
  }
}

function fsyncDirectory(api, directoryPath) {
  let fd = -1;
  try {
    fd = api.openSync(
      directoryPath,
      fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
    );
    api.fsyncSync(fd);
  } catch {
    fail();
  } finally {
    if (!closeQuietly(api, fd)) fail();
  }
}

function fsyncDirectoryFd(api, directoryFd) {
  if (!Number.isInteger(directoryFd) || directoryFd < 0) fail();
  try {
    api.fsyncSync(directoryFd);
  } catch {
    fail();
  }
}

function removeDirectoryEntryAt(
  api,
  directory,
  name,
  kind,
  boundFd = undefined,
) {
  if (
    directory === undefined ||
    !Number.isInteger(directory.fd) ||
    directory.fd < 0 ||
    !safeEntryName(name) ||
    (kind !== "file" && kind !== "directory") ||
    !Number.isInteger(boundFd) ||
    boundFd < 0
  ) {
    fail();
  }
  const quarantineName = `${name}-${process.pid}-${randomUUID()}.remove`;
  if (!safeEntryName(quarantineName)) fail();
  verifyExchangeHelper();
  let child;
  try {
    child = spawnSync(
      EXCHANGE_HELPER,
      [
        "-c",
        EXCHANGE_HELPER_CODE,
        "remove-bound-exchange",
        kind,
        name,
        quarantineName,
      ],
      {
        cwd: "/",
        env: Object.create(null),
        encoding: "buffer",
        maxBuffer: 1024,
        timeout: EXCHANGE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        stdio: [
          "ignore",
          "ignore",
          "ignore",
          directory.fd,
          boundFd,
        ],
      },
    );
  } catch {
    fail();
  }
  if (
    child?.error !== undefined ||
    child?.status !== 0 ||
    child?.signal !== null ||
    child?.stdout !== null ||
    child?.stderr !== null
  ) {
    fail();
  }
}

function removeBoundDirectoryEntry(api, directory, name, boundFd, kind) {
  if (!Number.isInteger(boundFd) || boundFd < 0) fail();
  const bound = api.fstatSync(boundFd, BIGINT_STAT_OPTIONS);
  if (kind === "file" && !bound.isFile()) fail();
  if (kind === "directory" && !bound.isDirectory()) fail();
  removeDirectoryEntryAt(api, directory, name, kind, boundFd);
}

function validateExchangeDirectory(api, directory, uid, requireOperation = false) {
  if (
    directory === undefined ||
    typeof directory.path !== "string" ||
    !Number.isInteger(directory.fd) ||
    directory.fd < 0
  ) {
    fail();
  }
  const listed = api.lstatSync(directory.path, BIGINT_STAT_OPTIONS);
  const opened = api.fstatSync(directory.fd, BIGINT_STAT_OPTIONS);
  if (
    !listed.isDirectory() ||
    !opened.isDirectory() ||
    statBigInt(listed, "uid") !== BigInt(uid) ||
    statBigInt(opened, "uid") !== BigInt(uid) ||
    !sameIdentity(listed, opened)
  ) {
    fail();
  }
  if (requireOperation) {
    if (
      permissionMode(listed) !== OPERATION_DIRECTORY_MODE ||
      permissionMode(opened) !== OPERATION_DIRECTORY_MODE
    ) {
      fail();
    }
  }
}

function verifyExchangeHelper() {
  try {
    const resolved = fs.realpathSync(EXCHANGE_HELPER);
    if (!EXCHANGE_HELPER_REALPATH_RE.test(resolved)) fail();
    const stat = fs.statSync(EXCHANGE_HELPER, BIGINT_STAT_OPTIONS);
    if (
      !stat.isFile() ||
      statBigInt(stat, "uid") !== 0n ||
      (permissionMode(stat) & 0o022) !== 0 ||
      (permissionMode(stat) & 0o111) === 0
    ) {
      fail();
    }
  } catch (error) {
    if (error instanceof ProtectedTfvarsError) throw error;
    fail();
  }
}

function exchangeEntries(
  api,
  sourceDirectory,
  sourceName,
  targetDirectory,
  targetName,
  uid,
  kind,
) {
  if (!safeEntryName(sourceName) || !safeEntryName(targetName)) fail();
  validateExchangeDirectory(api, sourceDirectory, uid, sourceDirectory.isOperation === true);
  validateExchangeDirectory(api, targetDirectory, uid, targetDirectory.isOperation === true);
  if (typeof api.beforeExchangeSync === "function") {
    try {
      api.beforeExchangeSync({
        sourceDirectory,
        sourceName,
        targetDirectory,
        targetName,
        kind,
      });
    } catch (error) {
      if (error instanceof ProtectedTfvarsError) throw error;
      fail();
    }
  }
  if (typeof api.exchangeSync === "function") {
    try {
      api.exchangeSync({
        sourceDirectory,
        sourceName,
        targetDirectory,
        targetName,
        kind,
      });
    } catch (error) {
      if (error instanceof ProtectedTfvarsError) throw error;
      fail();
    }
  } else {
    verifyExchangeHelper();
    let child;
    try {
      child = spawnSync(
        EXCHANGE_HELPER,
        ["-c", EXCHANGE_HELPER_CODE, sourceName, targetName],
        {
          cwd: "/",
          env: Object.create(null),
          encoding: "buffer",
          maxBuffer: 1024,
          timeout: EXCHANGE_TIMEOUT_MS,
          killSignal: "SIGKILL",
          stdio: [
            "ignore",
            "ignore",
            "ignore",
            sourceDirectory.fd,
            targetDirectory.fd,
          ],
        },
      );
    } catch {
      fail();
    }
    if (
      child?.error !== undefined ||
      child?.status !== 0 ||
      child?.signal !== null ||
      child?.stdout !== null ||
      child?.stderr !== null
    ) {
      fail();
    }
  }
  if (typeof api.afterExchangeSync === "function") {
    try {
      api.afterExchangeSync({
        sourceDirectory,
        sourceName,
        targetDirectory,
        targetName,
        kind,
      });
    } catch (error) {
      if (error instanceof ProtectedTfvarsError) throw error;
      fail();
    }
  }
  validateExchangeDirectory(api, sourceDirectory, uid, sourceDirectory.isOperation === true);
  validateExchangeDirectory(api, targetDirectory, uid, targetDirectory.isOperation === true);
}

function parentDirectoryBinding(operation) {
  return {
    path: operation.parentPath,
    fd: operation.parentFd,
    identity: operation.parentIdentity,
    isOperation: false,
  };
}

function createTargetPlaceholder(api, operation, filePath, expected, uid) {
  let fd = -1;
  let identity;
  try {
    fd = api.openSync(filePath, WRITE_FLAGS, Number(expected.mode));
    identity = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
    validateProtectedStat(identity, uid);
    api.fchmodSync(fd, Number(expected.mode));
    const finalized = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
    if (!sameProtectedMetadata(finalized, expected)) fail();
    const listed = api.lstatSync(filePath, BIGINT_STAT_OPTIONS);
    if (!sameIdentity(listed, finalized) || !sameProtectedMetadata(listed, expected)) {
      fail();
    }
    return {
      name: path.basename(filePath),
      path: filePath,
      fd,
      identity: finalized,
      created: true,
    };
  } catch (error) {
    if (fd >= 0 && identity !== undefined) {
      try {
        removeBoundDirectoryEntry(
          api,
          { path: operation.parentPath, fd: operation.parentFd },
          path.basename(filePath),
          fd,
          "file",
        );
        try {
          fsyncDirectoryFd(api, operation.parentFd);
        } catch {
          // The placeholder is already removed.
        }
      } catch {
        closeQuietly(api, fd);
        fail();
      }
    }
    if (!closeQuietly(api, fd)) fail();
    if (error?.code === "EEXIST") return undefined;
    if (error instanceof ProtectedTfvarsError) throw error;
    fail();
  }
}

function ensureExchangeTarget(api, operation, filePath, expected, uid) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const listed = api.lstatSync(filePath, BIGINT_STAT_OPTIONS);
      if (listed.isSymbolicLink()) fail();
      validateProtectedStat(listed, uid);
      return { identity: listed, placeholder: undefined };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (error instanceof ProtectedTfvarsError) throw error;
        fail();
      }
      const placeholder = createTargetPlaceholder(api, operation, filePath, expected, uid);
      if (placeholder !== undefined) {
        return { identity: placeholder.identity, placeholder };
      }
    }
  }
  fail();
}

function restoreVerifiedOriginal(
  api,
  operation,
  filePath,
  backup,
  targetFd,
  targetMetadata,
  uid,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const backupSnapshot = verifyBoundOperationEntry(
      api,
      operation,
      backup,
      uid,
      { allowSizeChange: true, digest: backup.digest },
    );
    const restoreMetadata = Object.freeze({
      uid: targetMetadata.uid,
      gid: targetMetadata.gid,
      mode: targetMetadata.mode,
      size: BigInt(backupSnapshot.bytes.length),
    });
    const restore = openOperationEntry(
      api,
      operation,
      "restore",
      restoreMetadata.mode,
      restoreMetadata,
      backupSnapshot.bytes,
      uid,
      { kind: "restore" },
    );
    createRestoreIntent(
      api,
      operation,
      filePath,
      restore,
      backupSnapshot,
      targetMetadata,
      uid,
    );
    let targetPlaceholder;
    let targetPlaceholderDirectory;
    let targetPlaceholderName = path.basename(filePath);
    try {
      verifyBoundOperationEntry(
        api,
        operation,
        backup,
        uid,
        { allowSizeChange: true, digest: backup.digest },
      );
      verifyBoundOperationEntry(api, operation, restore, uid);
      fsyncDirectoryFd(api, operation.fd);
      const targetBefore = ensureExchangeTarget(
        api,
        operation,
        filePath,
        targetMetadata,
        uid,
      );
      targetPlaceholder = targetBefore.placeholder;
      targetPlaceholderDirectory = operation;
      exchangeEntries(
        api,
        operation,
        restore.name,
        parentDirectoryBinding(operation),
        path.basename(filePath),
        uid,
        "restoration",
      );
      targetPlaceholderName = restore.name;
      fsyncDirectoryFd(api, operation.parentFd);
      let installedFd = -1;
      let displacedFd = -1;
      try {
        installedFd = api.openSync(filePath, READ_FLAGS);
        displacedFd = api.openSync(restore.path, READ_FLAGS);
        const listed = api.fstatSync(installedFd, BIGINT_STAT_OPTIONS);
        const displaced = api.fstatSync(displacedFd, BIGINT_STAT_OPTIONS);
        const opened = api.fstatSync(restore.fd, BIGINT_STAT_OPTIONS);
        if (
          !listed.isFile() ||
          !sameIdentity(listed, opened) ||
          !sameMetadata(listed, restoreMetadata) ||
          !sameIdentity(displaced, targetBefore.identity)
        ) {
          throw new ProtectedTfvarsError();
        }
      } finally {
        if (!closeQuietly(api, installedFd)) fail();
        if (!closeQuietly(api, displacedFd)) fail();
      }
      const snapshot = readFdSnapshot(api, restore.fd, uid);
      const backupAfter = verifyBoundOperationEntry(
        api,
        operation,
        backup,
        uid,
        { allowSizeChange: true, digest: backup.digest },
      );
      if (
        !snapshot.bytes.equals(backupAfter.bytes) ||
        snapshot.digest !== backupAfter.digest ||
        snapshot.digest !== backup.digest
      ) {
        throw new ProtectedTfvarsError();
      }
      if (targetPlaceholder !== undefined) {
        removeBoundDirectoryEntry(
          api,
          targetPlaceholderDirectory,
          targetPlaceholderName,
          targetPlaceholder.fd,
          "file",
        );
        try {
          fsyncDirectoryFd(api, targetPlaceholderDirectory.fd);
        } catch {
          // The placeholder is already removed.
        }
        if (!closeQuietly(api, targetPlaceholder.fd)) fail();
      }
      targetPlaceholder = undefined;
      return;
    } catch (error) {
      if (targetPlaceholder !== undefined) {
        try {
          removeBoundDirectoryEntry(
            api,
            targetPlaceholderDirectory,
            targetPlaceholderName,
            targetPlaceholder.fd,
            "file",
          );
          try {
            fsyncDirectoryFd(api, targetPlaceholderDirectory.fd);
          } catch {
            // The placeholder is already removed.
          }
        } catch {
          // Preserve a substituted foreign entry and fail closed.
        }
        if (!closeQuietly(api, targetPlaceholder.fd)) fail();
        targetPlaceholder = undefined;
      }
      if (attempt === 2) {
        if (error instanceof ProtectedTfvarsError) throw error;
        fail();
      }
    }
  }
  fail();
}

function cleanupOperationEntry(api, operation, entry, uid) {
  validateOperationDirectory(api, operation, uid);
  validateEntryPath(operation, entry);
  let listed;
  try {
    listed = api.lstatSync(entry.path, BIGINT_STAT_OPTIONS);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  if (listed.isSymbolicLink()) return false;
  const boundEntry = entry.cleanupFd === undefined
    ? entry
    : { ...entry, fd: entry.cleanupFd };
  try {
    if (entry.ready) {
      verifyBoundOperationEntry(api, operation, boundEntry, uid, {
        allowSizeChange: entry.kind === "backup",
      });
    } else {
      const opened = api.fstatSync(boundEntry.fd, BIGINT_STAT_OPTIONS);
      validateProtectedStat(opened, uid);
      if (
        !sameIdentity(listed, opened) ||
        entry.identity === undefined ||
        !sameIdentity(listed, entry.identity) ||
        !sameStatField(listed, entry.expected, "uid") ||
        !sameStatField(listed, entry.expected, "gid") ||
        permissionMode(listed) !== entry.expected.mode
      ) {
        return false;
      }
    }
  } catch {
    return false;
  }

  const expected = !entry.preserveOnly &&
    entry.identity !== undefined &&
    sameIdentity(listed, entry.identity) &&
    (!entry.ready || entry.digest === undefined ||
      readFdSnapshot(api, boundEntry.fd, uid).digest === entry.digest);
  if (!expected) return false;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const placeholder = createPrivateFilePlaceholder(api, operation, entry.name, uid);
    let quarantinedFd = -1;
    if (placeholder === undefined) continue;
    try {
      exchangeEntries(
        api,
        operation,
        entry.name,
        operation,
        placeholder.name,
        uid,
        "cleanup",
      );
      quarantinedFd = api.openSync(placeholder.path, READ_FLAGS);
      const quarantined = api.fstatSync(quarantinedFd, BIGINT_STAT_OPTIONS);
      const opened = api.fstatSync(placeholder.fd, BIGINT_STAT_OPTIONS);
      validateProtectedStat(quarantined, uid);
      validateProtectedStat(opened, uid);
      if (!sameIdentity(opened, placeholder.identity) || !sameIdentity(quarantined, listed)) {
        return false;
      }
      if (entry.ready) {
        const snapshot = readEntryDigest(api, boundEntry, {
          allowSizeChange: entry.kind === "backup",
        });
        if (
          !sameIdentity(quarantined, snapshot.stat) ||
          snapshot.digest !== entry.digest
        ) {
          return false;
        }
      }
      removeBoundDirectoryEntry(api, operation, placeholder.name, quarantinedFd, "file");
      try {
        fsyncDirectoryFd(api, operation.fd);
      } catch {
        // Removal is complete even when the directory fsync fails.
      }
      removeBoundDirectoryEntry(api, operation, entry.name, placeholder.fd, "file");
      try {
        fsyncDirectoryFd(api, operation.fd);
      } catch {
        // Removal is complete even when the directory fsync fails.
      }
      closeQuietly(api, quarantinedFd);
      quarantinedFd = -1;
      if (!closeQuietly(api, placeholder.fd)) return false;
      return true;
    } catch {
      return false;
    } finally {
      closeQuietly(api, quarantinedFd);
      closeQuietly(api, placeholder.fd);
    }
  }
  return false;
}

function createPrivateFilePlaceholder(api, operation, label, uid) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const entryPath = operationEntryPath(
      operation,
      `${label}-${process.pid}-${randomUUID()}.quarantine`,
    );
    let fd = -1;
    let identity;
    try {
      fd = api.openSync(entryPath.path, WRITE_FLAGS, PRIVATE_MODE_MAX);
      identity = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
      validateProtectedStat(identity, uid);
      api.fchmodSync(fd, PRIVATE_MODE_MAX);
      const finalized = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
      if (!finalized.isFile() || statBigInt(finalized, "size") !== 0n) fail();
      const listed = api.lstatSync(entryPath.path, BIGINT_STAT_OPTIONS);
      if (
        !listed.isFile() ||
        !sameIdentity(listed, finalized) ||
        !sameProtectedMetadata(listed, statMetadata(finalized))
      ) {
        fail();
      }
      return { ...entryPath, fd, identity: finalized };
    } catch (error) {
      if (fd >= 0 && identity !== undefined) {
        try {
          removeBoundDirectoryEntry(api, operation, entryPath.name, fd, "file");
          try {
            fsyncDirectoryFd(api, operation.fd);
          } catch {
            // The entry is already removed; report durability failure only.
          }
        } catch {
          closeQuietly(api, fd);
          fail();
        }
      }
      if (!closeQuietly(api, fd)) fail();
      if (error?.code === "EEXIST") continue;
      if (error instanceof ProtectedTfvarsError) throw error;
      fail();
    }
  }
  fail();
}

function quarantineOperationDirectory(api, operation, uid) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const quarantinePath = path.join(
      path.dirname(operation.path),
      `.${path.basename(operation.path)}.${process.pid}.${randomUUID()}.quarantine`,
    );
    const quarantineName = path.basename(quarantinePath);
    let placeholderFd = -1;
    let exchanged = false;
    try {
      const placeholder = bindCreatedDirectory(
        api,
        { path: operation.parentPath, fd: operation.parentFd },
        quarantineName,
        uid,
      );
      placeholderFd = placeholder.fd;
      const placeholderIdentity = placeholder.identity;
      try {
        api.fsyncSync(placeholderFd);
      } catch {
        // Continue cleanup; the operation will still fail closed if the
        // directory cannot be durably synchronized.
      }
      try {
        fsyncDirectoryFd(api, operation.parentFd);
      } catch {
        // Continue cleanup after a durability-only failure.
      }
      const parent = parentDirectoryBinding(operation);
      exchangeEntries(
        api,
        parent,
        path.basename(operation.path),
        parent,
        quarantineName,
        uid,
        "operation-quarantine",
      );
      exchanged = true;
      const sourceNow = api.fstatSync(placeholderFd, BIGINT_STAT_OPTIONS);
      const privateNow = api.fstatSync(operation.fd, BIGINT_STAT_OPTIONS);
      if (
        !sameIdentity(sourceNow, placeholderIdentity) ||
        !sameIdentity(privateNow, operation.identity)
      ) {
        fail();
      }
      removeBoundDirectoryEntry(
        api,
        { path: operation.parentPath, fd: operation.parentFd },
        path.basename(operation.path),
        placeholderFd,
        "directory",
      );
      if (!closeQuietly(api, placeholderFd)) fail();
      placeholderFd = -1;
      try {
        fsyncDirectoryFd(api, operation.parentFd);
      } catch {
        // The placeholder is already removed.
      }
    } catch (error) {
      if (exchanged && placeholderFd >= 0) {
        try {
          removeBoundDirectoryEntry(
            api,
            { path: operation.parentPath, fd: operation.parentFd },
            path.basename(operation.path),
            placeholderFd,
            "directory",
          );
        } catch {
          // Preserve the entry if its identity no longer matches.
        }
      } else if (!exchanged) {
        try {
          if (placeholderFd >= 0) {
            removeBoundDirectoryEntry(
              api,
              { path: operation.parentPath, fd: operation.parentFd },
              quarantineName,
              placeholderFd,
              "directory",
            );
          }
        } catch {
          // Preserve an unbound or substituted directory rather than risking
          // deletion of a foreign inode.
        }
      }
      closeQuietly(api, placeholderFd);
      if (error?.code === "EEXIST") continue;
      return false;
    }
    const oldPath = operation.path;
    operation.path = quarantinePath;
    for (const entry of operation.entries) {
      entry.path = path.join(quarantinePath, entry.name);
    }
    return oldPath !== quarantinePath;
  }
  return false;
}

function cleanupOperationInPlace(api, operation, uid) {
  let failed = false;
  try {
    validateOperationDirectory(api, operation, uid);
    for (const entry of operation.entries) {
      if (entry.preserveOnly) continue;
      const boundEntry = entry.cleanupFd === undefined
        ? entry
        : { ...entry, fd: entry.cleanupFd };
      try {
        validateEntryPath(operation, entry);
        const listed = api.lstatSync(entry.path, BIGINT_STAT_OPTIONS);
        const opened = api.fstatSync(boundEntry.fd, BIGINT_STAT_OPTIONS);
        if (
          listed.isSymbolicLink() ||
          !sameIdentity(listed, opened) ||
          entry.identity === undefined ||
          !sameIdentity(opened, entry.identity)
        ) {
          failed = true;
          continue;
        }
        if (entry.ready) {
          verifyBoundOperationEntry(api, operation, boundEntry, uid, {
            allowSizeChange: entry.kind === "backup",
          });
        }
        removeBoundDirectoryEntry(api, operation, entry.name, boundEntry.fd, "file");
        try {
          fsyncDirectoryFd(api, operation.fd);
        } catch {
          // The entry is already removed.
        }
      } catch {
        failed = true;
      }
    }
    if (!failed && api.readdirSync(operation.path).length === 0) {
      removeBoundDirectoryEntry(
        api,
        { path: operation.parentPath, fd: operation.parentFd },
        path.basename(operation.path),
        operation.fd,
        "directory",
      );
      try {
        fsyncDirectoryFd(api, operation.parentFd);
      } catch {
        // The operation directory is already removed.
      }
      return true;
    }
  } catch {
    failed = true;
  }
  return false;
}

function cleanupOperation(api, operation, uid) {
  if (operation === undefined) return false;
  let cleanupFailed = false;
  try {
    if (!quarantineOperationDirectory(api, operation, uid)) {
      return !cleanupOperationInPlace(api, operation, uid);
    }
    validateOperationDirectory(api, operation, uid);
    for (const entry of operation.entries) {
      try {
        if (!cleanupOperationEntry(api, operation, entry, uid)) {
          cleanupFailed = true;
        }
      } catch {
        cleanupFailed = true;
      }
    }
    if (!cleanupFailed) {
      const remaining = api.readdirSync(operation.path);
      if (remaining.length !== 0) {
        cleanupFailed = true;
      } else {
        removeBoundDirectoryEntry(
          api,
          { path: operation.parentPath, fd: operation.parentFd },
          path.basename(operation.path),
          operation.fd,
          "directory",
        );
        try {
          fsyncDirectoryFd(api, operation.parentFd);
        } catch {
          cleanupFailed = true;
        }
      }
    }
  } catch {
    cleanupFailed = true;
  }
  return cleanupFailed;
}

function readOptionalProtectedFile(api, filePath) {
  let listed;
  try {
    listed = api.lstatSync(filePath, BIGINT_STAT_OPTIONS);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (listed.isSymbolicLink()) fail();
  const read = readProtectedFile(filePath, api, false);
  if (!sameTargetSnapshot(listed, read.stat)) fail();
  return read;
}

function validateManifest(manifest, operation, filePath) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.version !== MANIFEST_VERSION ||
    manifest.phase !== "prepared" ||
    manifest.targetPath !== filePath ||
    manifest.operationDirectory !== path.basename(operation.path) ||
    !manifest.original ||
    !manifest.candidate ||
    !manifest.backup ||
    !validIdentityRecord(manifest.original.identity) ||
    !validIdentityRecord(manifest.candidate.identity) ||
    !validIdentityRecord(manifest.backup.identity) ||
    !DIGEST_RE.test(manifest.original.digest ?? "") ||
    !DIGEST_RE.test(manifest.candidate.digest ?? "") ||
    !DIGEST_RE.test(manifest.backup.digest ?? "") ||
    !safeEntryName(manifest.candidate.name) ||
    !safeEntryName(manifest.backup.name) ||
    manifest.candidate.name === MANIFEST_NAME ||
    manifest.backup.name === MANIFEST_NAME ||
    manifest.original.digest !== manifest.backup.digest ||
    manifest.original.digest === manifest.candidate.digest
  ) {
    fail();
  }
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000")
  );
}

function validateInitialRecoveryRecord(record, operation, filePath) {
  if (
    !hasExactKeys(record, [
      "version",
      "phase",
      "targetPath",
      "operationDirectory",
      "original",
    ]) ||
    record.version !== MANIFEST_VERSION ||
    record.phase !== "initial" ||
    record.targetPath !== filePath ||
    record.operationDirectory !== path.basename(operation.path) ||
    !hasExactKeys(record.original, ["identity", "digest"]) ||
    !hasExactKeys(record.original.identity, [
      "dev",
      "ino",
      "uid",
      "gid",
      "mode",
      "size",
    ]) ||
    !validIdentityRecord(record.original.identity) ||
    !DIGEST_RE.test(record.original.digest ?? "")
  ) {
    fail();
  }
}

function readInitialRecoveryRecord(api, operation, filePath) {
  const recoveryPath = path.join(operation.path, INITIAL_RECOVERY_NAME);
  const read = readProtectedFile(recoveryPath, api, true);
  const entry = {
    name: INITIAL_RECOVERY_NAME,
    path: recoveryPath,
    fd: read.fd,
    expected: statMetadata(read.stat),
    digest: read.digest,
    identity: read.stat,
    ready: true,
    kind: "initial-recovery",
  };
  operation.entries.push(entry);
  let record;
  try {
    record = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    fail();
  }
  validateInitialRecoveryRecord(record, operation, filePath);
  operation.initialRecovery = record;
  operation.initialRecoveryEntry = entry;
  return record;
}

function initialRecoveryEntryName(name) {
  return (
    (name.startsWith("candidate-") && name.endsWith(".tmp")) ||
    (name.startsWith("backup-") && name.endsWith(".bak"))
  );
}

function registerInitialRecoveryEntries(api, operation, uid) {
  for (const name of api.readdirSync(operation.path)) {
    if (name === INITIAL_RECOVERY_NAME) continue;
    if (!initialRecoveryEntryName(name)) fail();
    const entryPath = path.join(operation.path, name);
    if (!safeEntryName(name) || path.dirname(entryPath) !== operation.path) {
      fail();
    }
    let fd = -1;
    try {
      fd = api.openSync(entryPath, READ_FLAGS);
      const stat = api.fstatSync(fd, BIGINT_STAT_OPTIONS);
      validateProtectedStat(stat, uid);
      const entry = {
        name,
        path: entryPath,
        fd,
        expected: statMetadata(stat),
        identity: stat,
        ready: false,
        kind: name.startsWith("backup-") ? "backup" : "candidate",
      };
      operation.entries.push(entry);
    } catch (error) {
      if (!closeQuietly(api, fd)) fail();
      if (error instanceof ProtectedTfvarsError) throw error;
      fail();
    }
  }
}

function recoverInitialOperation(api, operation, filePath, uid, record) {
  const target = readOptionalProtectedFile(api, filePath);
  if (
    target === undefined ||
    !sameIdentityRecord(target.stat, record.original.identity) ||
    target.digest !== record.original.digest
  ) {
    fail();
  }
  registerInitialRecoveryEntries(api, operation, uid);
  if (cleanupOperation(api, operation, uid)) fail();
}

function readOperationManifest(api, operation, filePath) {
  const manifestPath = path.join(operation.path, MANIFEST_NAME);
  const read = readProtectedFile(manifestPath, api, true);
  const entry = {
    name: MANIFEST_NAME,
    path: manifestPath,
    fd: read.fd,
    expected: statMetadata(read.stat),
    digest: read.digest,
    identity: read.stat,
    ready: true,
    kind: "manifest",
  };
  operation.entries.push(entry);
  let manifest;
  try {
    manifest = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    fail();
  }
  validateManifest(manifest, operation, filePath);
  return manifest;
}

function openRecoveryEntry(api, operation, descriptor, kind, uid, allowSizeChange = false) {
  const entryPath = path.join(operation.path, descriptor.name);
  if (!safeEntryName(descriptor.name) || path.dirname(entryPath) !== operation.path) {
    fail();
  }
  const read = readProtectedFile(entryPath, api, true);
  if (
    !sameManifestFileIdentity(read.stat, descriptor.identity) ||
    (!allowSizeChange && !sameIdentityRecord(read.stat, descriptor.identity)) ||
    read.digest !== descriptor.digest
  ) {
    if (!closeQuietly(api, read.fd)) fail();
    fail();
  }
  const entry = {
    name: descriptor.name,
    path: entryPath,
    fd: read.fd,
    expected: metadataFromIdentity(descriptor.identity),
    digest: read.digest,
    identity: read.stat,
    ready: true,
    kind,
  };
  operation.entries.push(entry);
  return entry;
}

function readRestoreIntents(api, operation, filePath) {
  const intents = [];
  for (const name of api.readdirSync(operation.path)) {
    if (!name.startsWith("restore-intent-") || !name.endsWith(".tmp")) continue;
    const intentPath = path.join(operation.path, name);
    let entry;
    try {
      const listed = api.lstatSync(intentPath, BIGINT_STAT_OPTIONS);
      const read = readProtectedFile(intentPath, api, true);
      entry = {
        name,
        path: intentPath,
        fd: read.fd,
        expected: statMetadata(read.stat),
        digest: read.digest,
        identity: read.stat,
        ready: true,
        kind: "restore-intent",
      };
      // Register before JSON parsing/schema validation so every failure path
      // has an owned descriptor to close.
      operation.entries.push(entry);
      if (!sameTargetSnapshot(listed, read.stat)) fail();
      const intent = JSON.parse(read.bytes.toString("utf8"));
      if (
        intent?.version !== MANIFEST_VERSION ||
        intent.targetPath !== filePath ||
        !intent.restore ||
        intent.restore.name !== undefined && !safeEntryName(intent.restore.name) ||
        !safeEntryName(intent.restore.name ?? "") ||
        !validIdentityRecord(intent.restore.identity) ||
        !DIGEST_RE.test(intent.restore.digest ?? "")
      ) {
        fail();
      }
      entry.restoreIntent = intent;
      intents.push(intent);
    } catch (error) {
      if (entry !== undefined) {
        closeQuietly(api, entry.fd);
        const index = operation.entries.indexOf(entry);
        if (index >= 0) operation.entries.splice(index, 1);
      }
      if (error instanceof ProtectedTfvarsError) throw error;
      fail();
    }
  }
  operation.restoreIntents = intents.map((intent, index) => ({
    intent,
    entry: operation.entries[operation.entries.length - intents.length + index],
  }));
  return intents;
}

function recoverOperation(api, operation, filePath, uid) {
  const initialRecovery = readInitialRecoveryRecord(
    api,
    operation,
    filePath,
  );
  let manifestPresent = true;
  try {
    api.lstatSync(path.join(operation.path, MANIFEST_NAME), BIGINT_STAT_OPTIONS);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    manifestPresent = false;
  }
  if (!manifestPresent) {
    recoverInitialOperation(api, operation, filePath, uid, initialRecovery);
    return;
  }

  let manifest;
  try {
    manifest = readOperationManifest(api, operation, filePath);
  } catch {
    const entry = operation.entries.at(-1);
    if (entry?.kind === "manifest") {
      operation.entries.pop();
      if (!closeQuietly(api, entry.fd)) fail();
    }
    recoverInitialOperation(api, operation, filePath, uid, initialRecovery);
    return;
  }
  const candidatePath = path.join(operation.path, manifest.candidate.name);
  const backupPath = path.join(operation.path, manifest.backup.name);
  if (
    path.dirname(candidatePath) !== operation.path ||
    path.dirname(backupPath) !== operation.path
  ) {
    fail();
  }

  const candidateRead = readOptionalProtectedFile(api, candidatePath);
  if (candidateRead !== undefined) {
    const candidateMatchesCandidate =
      sameIdentityRecord(candidateRead.stat, manifest.candidate.identity) &&
      candidateRead.digest === manifest.candidate.digest;
    const candidateMatchesOriginal =
      sameManifestFileIdentity(candidateRead.stat, manifest.original.identity) &&
      candidateRead.digest === manifest.original.digest;
    const candidateDescriptor =
      candidateMatchesCandidate
        ? manifest.candidate
        : candidateMatchesOriginal
          ? { ...manifest.original, name: manifest.candidate.name }
          : undefined;
    if (candidateDescriptor !== undefined) {
      // Re-open with a bound descriptor so cleanup cannot unlink a later
      // pathname substitution.
      openRecoveryEntry(api, operation, candidateDescriptor, "candidate", uid);
    }
  }

  const backupRead = readOptionalProtectedFile(api, backupPath);
  if (backupRead === undefined) fail();
  if (!sameManifestFileIdentity(backupRead.stat, manifest.backup.identity)) fail();
  if (backupRead.digest !== manifest.backup.digest) fail();
  const backup = openRecoveryEntry(
    api,
    operation,
    manifest.backup,
    "backup",
    uid,
    true,
  );
  const backupSnapshot = verifyBoundOperationEntry(
    api,
    operation,
    backup,
    uid,
    { allowSizeChange: true, digest: manifest.backup.digest },
  );
  if (backupSnapshot.digest !== manifest.backup.digest) fail();

  const intents = readRestoreIntents(api, operation, filePath);
  const target = readOptionalProtectedFile(api, filePath);
  if (target === undefined) fail();
  const targetDigest = target.digest;

  const targetIsOriginal =
    sameManifestFileIdentity(target.stat, manifest.original.identity) &&
    targetDigest === backup.digest;
  const targetIsCandidate =
    sameIdentityRecord(target.stat, manifest.candidate.identity) &&
    targetDigest === manifest.candidate.digest;
  const targetIsRestored = intents.some(
    (intent) =>
      sameIdentityRecord(target.stat, intent.restore.identity) &&
      targetDigest === intent.restore.digest &&
      intent.restore.digest === backup.digest,
  );
  if (
    targetIsOriginal ||
    (targetIsCandidate && backup.digest === manifest.original.digest) ||
    targetIsRestored
  ) {
    if (cleanupOperation(api, operation, uid)) fail();
    return;
  }

  restoreVerifiedOriginal(
    api,
    operation,
    filePath,
    backup,
    backup.fd,
    metadataFromIdentity(manifest.original.identity),
    uid,
  );
  if (cleanupOperation(api, operation, uid)) fail();
}

function recoverSiblingOperations(api, filePath, uid) {
  const parentPath = path.dirname(filePath);
  const prefix = `.${path.basename(filePath)}.`;
  let names;
  try {
    names = api.readdirSync(parentPath);
  } catch {
    fail();
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".op")) continue;
    const operationPath = path.join(parentPath, name);
    const operation = {
      parentPath,
      parentFd: -1,
      parentIdentity: undefined,
      path: operationPath,
      isOperation: true,
      identity: undefined,
      fd: -1,
      entries: [],
      created: false,
    };
    try {
      operation.parentFd = api.openSync(
        parentPath,
        fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
      );
      operation.parentIdentity = api.fstatSync(operation.parentFd, BIGINT_STAT_OPTIONS);
      const listed = api.lstatSync(operationPath, BIGINT_STAT_OPTIONS);
      if (!listed.isDirectory()) fail();
      operation.identity = listed;
      operation.fd = api.openSync(
        operationPath,
        fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
      );
      const opened = api.fstatSync(operation.fd, BIGINT_STAT_OPTIONS);
      if (
        !opened.isDirectory() ||
        !sameIdentity(listed, opened) ||
        permissionMode(opened) !== OPERATION_DIRECTORY_MODE ||
        statBigInt(opened, "uid") !== BigInt(uid)
      ) {
        fail();
      }
      recoverOperation(api, operation, filePath, uid);
    } catch (error) {
      if (error instanceof ProtectedTfvarsError) throw error;
      fail();
    } finally {
      for (const entry of operation.entries) closeQuietly(api, entry.fd);
      closeQuietly(api, operation.fd);
      closeQuietly(api, operation.parentFd);
    }
  }
}

function targetPathIsVerifiedOriginal(api, filePath, targetFd, targetBytes, uid) {
  try {
    const listed = api.lstatSync(filePath, BIGINT_STAT_OPTIONS);
    if (listed.isSymbolicLink()) return false;
    validateProtectedStat(listed, uid);
    const opened = api.fstatSync(targetFd, BIGINT_STAT_OPTIONS);
    if (!sameIdentity(listed, opened)) return false;
    const snapshot = readFdSnapshot(api, targetFd, uid);
    return snapshot.bytes.equals(targetBytes);
  } catch {
    return false;
  }
}

function restorePublishedOriginalAfterValidationFailure(
  api,
  operation,
  filePath,
  candidate,
  targetFd,
  uid,
) {
  try {
    const candidatePath = api.lstatSync(candidate.path, BIGINT_STAT_OPTIONS);
    const targetPath = api.lstatSync(filePath, BIGINT_STAT_OPTIONS);
    const original = api.fstatSync(targetFd, BIGINT_STAT_OPTIONS);
    const replacement = api.fstatSync(candidate.fd, BIGINT_STAT_OPTIONS);
    if (
      candidatePath.isSymbolicLink() ||
      targetPath.isSymbolicLink() ||
      !sameIdentity(candidatePath, original) ||
      !sameIdentity(targetPath, replacement)
    ) {
      return false;
    }
    exchangeEntries(
      api,
      operation,
      candidate.name,
      parentDirectoryBinding(operation),
      path.basename(filePath),
      uid,
      "failed-publication-restoration",
    );
    fsyncDirectoryFd(api, operation.parentFd);
    return true;
  } catch {
    return false;
  }
}

function atomicallyReplace(api, filePath, target, replacement) {
  const uid = currentUid();
  const directoryPath = path.dirname(filePath);
  const targetMetadata = statMetadata(target.stat);
  const replacementMetadata = Object.freeze({
    uid: targetMetadata.uid,
    gid: targetMetadata.gid,
    mode: targetMetadata.mode,
    size: BigInt(replacement.length),
  });
  let operation;
  let candidate;
  let backup;
  let committed = false;
  let verified = false;
  let failure;

  try {
    verifyTargetStillOpen(api, filePath, target.fd, target.stat, target.bytes, uid);
    operation = makeOperationDirectory(api, filePath);
    createInitialRecoveryRecord(
      api,
      operation,
      filePath,
      target,
      targetMetadata,
      uid,
    );
    candidate = openCandidate(
      api,
      operation,
      targetMetadata.mode,
      replacementMetadata,
      replacement,
      uid,
    );
    verifyTargetStillOpen(api, filePath, target.fd, target.stat, target.bytes, uid);
    backup = bindTargetBackup(
      api,
      operation,
      filePath,
      target.fd,
      target.bytes,
      targetMetadata,
      uid,
    );
    target.stat = backup.boundTargetStat;
    verifyTargetStillOpen(api, filePath, target.fd, target.stat, target.bytes, uid);

    verifyBoundOperationEntry(api, operation, backup, uid);
    verifyBoundOperationEntry(api, operation, candidate, uid);
    createOperationManifest(
      api,
      operation,
      filePath,
      target,
      candidate,
      backup,
      targetMetadata,
      uid,
    );
    verifyBoundOperationEntry(api, operation, backup, uid);
    verifyBoundOperationEntry(api, operation, candidate, uid);
    verifyBoundOperationEntry(api, operation, operation.manifestEntry, uid);
    fsyncDirectory(api, directoryPath);
    try {
      exchangeEntries(
        api,
        operation,
        candidate.name,
        parentDirectoryBinding(operation),
        path.basename(filePath),
        uid,
        "publication",
      );
      committed = true;
    } catch (error) {
      if (!targetPathIsVerifiedOriginal(api, filePath, target.fd, target.bytes, uid)) {
        committed = true;
      }
      throw error;
    }
    const targetDigest = target.digest;
    // The original inode is now preserved at candidate and backup.  Both
    // sides must agree with the bytes that were read before publication.
    const backupAfterPublication = verifyBoundOperationEntry(
      api,
      operation,
      backup,
      uid,
      { allowSizeChange: true, digest: backup.digest },
    );
    if (backupAfterPublication.digest !== targetDigest) fail();
    const candidatePath = api.lstatSync(candidate.path, BIGINT_STAT_OPTIONS);
    const originalFdStat = api.fstatSync(target.fd, BIGINT_STAT_OPTIONS);
    if (
      candidatePath.isSymbolicLink() ||
      !sameIdentity(candidatePath, originalFdStat) ||
      !sameProtectedMetadata(candidatePath, targetMetadata)
    ) {
      fail();
    }
    const candidatePathSnapshot = readFdSnapshot(api, target.fd, uid);
    if (
      !candidatePathSnapshot.bytes.equals(target.bytes) ||
      candidatePathSnapshot.digest !== targetDigest
    ) {
      fail();
    }
    fsyncDirectory(api, directoryPath);
    verifyInstalledEntry(
      api,
      filePath,
      candidate,
      replacement,
      replacementMetadata,
      uid,
    );
    const backupAtCommit = verifyBoundOperationEntry(
      api,
      operation,
      backup,
      uid,
      { allowSizeChange: true, digest: backup.digest },
    );
    if (backupAtCommit.digest !== targetDigest) fail();
    candidate.cleanupFd = target.fd;
    candidate.expected = targetMetadata;
    candidate.identity = target.stat;
    candidate.digest = targetDigest;
    candidate.kind = "published-original";
    verified = true;
  } catch (error) {
    failure = error instanceof ProtectedTfvarsError
      ? error
      : new ProtectedTfvarsError();
    if (committed && !verified && backup !== undefined) {
      try {
        const restoredPublishedOriginal =
          restorePublishedOriginalAfterValidationFailure(
            api,
            operation,
            filePath,
            candidate,
            target.fd,
            uid,
          );
        if (restoredPublishedOriginal) {
          backup.digest = readFdSnapshot(api, backup.fd, uid).digest;
        } else {
          restoreVerifiedOriginal(
            api,
            operation,
            filePath,
            backup,
            target.fd,
            targetMetadata,
            uid,
          );
        }
      } catch {
        failure = new ProtectedTfvarsError();
      }
    }
  } finally {
    const cleanupFailed = cleanupOperation(api, operation, uid);
    const closed = new Set();
    let closeFailed = false;
    if (candidate?.fd !== undefined) {
      closed.add(candidate.fd);
      if (!closeQuietly(api, candidate.fd)) closeFailed = true;
    }
    if (operation !== undefined) {
      for (const entry of operation.entries) {
        if (
          entry.fd !== target.fd &&
          entry.fd !== operation.fd &&
          !closed.has(entry.fd)
        ) {
          closed.add(entry.fd);
          if (!closeQuietly(api, entry.fd)) closeFailed = true;
        }
      }
    }
    if (!closeQuietly(api, operation?.fd)) closeFailed = true;
    if (operation?.parentFd !== undefined && operation.parentFd !== operation.fd) {
      if (!closeQuietly(api, operation.parentFd)) closeFailed = true;
    }
    if (cleanupFailed || closeFailed) failure = new ProtectedTfvarsError();
  }
  if (failure !== undefined) throw failure;
}

function runMode(mode, filePath, api) {
  if (!SUPPORTED_MODES.includes(mode)) fail();
  recoverSiblingOperations(api, filePath, currentUid());
  const target = readProtectedFile(filePath, api, mode === "disable");
  try {
    const assignments = parseTargetAssignments(target.bytes);
    if (mode === "assert-enabled") {
      if (!isEnabled(assignments)) fail();
      return 0;
    }
    if (mode === "assert-disabled") {
      if (!isDisabled(assignments)) fail();
      return 0;
    }
    if (!isEnabled(assignments)) fail();
    const replacement = replacementBytes(target.bytes, assignments);
    assertDisabledBytes(replacement);
    atomicallyReplace(api, filePath, target, replacement);
    return 0;
  } finally {
    if (!closeQuietly(api, target.fd)) fail();
  }
}

export function runModeForTests(mode, filePath, options = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) fail();
  return runMode(mode, filePath, { ...REAL_FS, ...(options.fs ?? {}) });
}

function kernelLockPath(filePath) {
  return path.join(path.dirname(filePath), KERNEL_LOCK_NAME);
}

function validateKernelLockStat(stat, uid) {
  if (!stat.isFile() || statBigInt(stat, "uid") !== BigInt(uid)) fail();
  if (permissionMode(stat) !== PRIVATE_MODE_MAX) fail();
}

function openKernelLock(lockPath) {
  const uid = currentUid();
  let fd = -1;
  try {
    fd = REAL_FS.openSync(
      lockPath,
      fs.constants.O_RDWR | O_NOFOLLOW | O_CLOEXEC,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") fail();
    try {
      fd = REAL_FS.openSync(
        lockPath,
        fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          O_NOFOLLOW |
          O_CLOEXEC,
        PRIVATE_MODE_MAX,
      );
    } catch {
      fail();
    }
  }
  try {
    const opened = REAL_FS.fstatSync(fd, BIGINT_STAT_OPTIONS);
    const listed = REAL_FS.lstatSync(lockPath, BIGINT_STAT_OPTIONS);
    validateKernelLockStat(opened, uid);
    validateKernelLockStat(listed, uid);
    if (!sameIdentity(opened, listed)) fail();
    return fd;
  } catch (error) {
    if (!closeQuietly(REAL_FS, fd)) fail();
    if (error instanceof ProtectedTfvarsError) throw error;
    fail();
  }
}

function linuxDeviceName(stat) {
  const device = statBigInt(stat, "dev");
  const major = ((device >> 8n) & 0xfffn).toString(16).padStart(2, "0");
  const minor = (
    (device & 0xffn) |
    ((device >> 12n) & 0xfff00n)
  ).toString(16).padStart(2, "0");
  return `${major}:${minor}`;
}

function processHasIdentity(pid, expected) {
  try {
    const entries = REAL_FS.readdirSync(`/proc/${pid}/fd`);
    return entries.some((entry) => {
      if (!/^\d+$/u.test(entry)) return false;
      try {
        return sameIdentity(
          REAL_FS.statSync(`/proc/${pid}/fd/${entry}`, BIGINT_STAT_OPTIONS),
          expected,
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function inheritedKernelLockOwnsExclusive(descriptor) {
  try {
    const device = linuxDeviceName(descriptor);
    const inode = statBigInt(descriptor, "ino").toString();
    const fdInfoLocks = REAL_FS.readFileSync(
      `/proc/self/fdinfo/${LOCK_FD}`,
      "utf8",
    )
      .split("\n")
      .filter((line) => line.startsWith("lock:"));
    const fdInfoFields = fdInfoLocks[0]?.trim().split(/\s+/u) ?? [];
    if (
      fdInfoLocks.length !== 1 ||
      fdInfoFields.length < 7 ||
      fdInfoFields[2] !== "FLOCK" ||
      fdInfoFields[4] !== "WRITE" ||
      fdInfoFields[5] !== String(process.pid) ||
      fdInfoFields[6] !== `${device}:${inode}`
    ) {
      return false;
    }
    const locks = REAL_FS.readFileSync("/proc/locks", "utf8");
    const matches = locks.split("\n").filter((line) => {
      const fields = line.trim().split(/\s+/u);
      if (
        fields.length < 8 ||
        fields[1] !== "FLOCK" ||
        fields[5] !== `${device}:${inode}`
      ) {
        return false;
      }
      return true;
    });
    return (
      matches.length === 1 &&
      matches[0].trim().split(/\s+/u)[3] === "WRITE" &&
      matches[0].trim().split(/\s+/u)[4] === String(process.pid)
    );
  } catch {
    return false;
  }
}

function inheritedKernelLockHasOnlyFd3(descriptor) {
  try {
    const entries = REAL_FS.readdirSync("/proc/self/fd");
    return entries.every((entry) => {
      if (!/^\d+$/u.test(entry) || Number(entry) === LOCK_FD) return true;
      try {
        return !sameIdentity(
          REAL_FS.statSync(`/proc/self/fd/${entry}`, BIGINT_STAT_OPTIONS),
          descriptor,
        );
      } catch {
        return true;
      }
    });
  } catch {
    return false;
  }
}

function inheritedKernelLockIsValid() {
  const lockPath = kernelLockPath(PROTECTED_TFVARS_PATH);
  const lockFd = LOCK_FD;
  try {
    const uid = currentUid();
    if (
      !Number.isSafeInteger(process.ppid) ||
      process.ppid <= 1 ||
      REAL_FS.readlinkSync("/proc/self/exe") !== NODE_PATH ||
      path.basename(REAL_FS.realpathSync(`/proc/${process.ppid}/exe`)) !== "node"
    ) {
      return false;
    }
    const selfLink = REAL_FS.readlinkSync(`/proc/self/fd/${lockFd}`);
    if (selfLink !== lockPath) return false;
    const descriptor = REAL_FS.fstatSync(lockFd, BIGINT_STAT_OPTIONS);
    const descriptorPath = REAL_FS.statSync(
      `/proc/self/fd/${lockFd}`,
      BIGINT_STAT_OPTIONS,
    );
    const listed = REAL_FS.lstatSync(lockPath, BIGINT_STAT_OPTIONS);
    validateKernelLockStat(descriptor, uid);
    validateKernelLockStat(descriptorPath, uid);
    validateKernelLockStat(listed, uid);
    if (
      !sameIdentity(descriptor, descriptorPath) ||
      !sameIdentity(descriptor, listed) ||
      !processHasIdentity(process.ppid, descriptor) ||
      !inheritedKernelLockHasOnlyFd3(descriptor)
    ) {
      return false;
    }
    return inheritedKernelLockOwnsExclusive(descriptor);
  } catch {
    return false;
  }
}

function runLockedCli(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv[0] !== INTERNAL_LOCKED_MARKER ||
    !SUPPORTED_MODES.includes(argv[1]) ||
    !inheritedKernelLockIsValid()
  ) {
    return 1;
  }
  try {
    return runMode(argv[1], PROTECTED_TFVARS_PATH, REAL_FS);
  } catch {
    return 1;
  }
}

function runProductionCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || !SUPPORTED_MODES.includes(argv[0])) {
    return 2;
  }
  const lockPath = kernelLockPath(PROTECTED_TFVARS_PATH);
  let lockFd = -1;
  let result = 1;
  try {
    lockFd = openKernelLock(lockPath);
    // The util-linux fd-only form cannot exec a command.  Referencing the
    // validated parent descriptor lets its command form open the same inode
    // as child fd 3, without inheriting a second lock descriptor.
    const inheritedLockSource = `/proc/${process.pid}/fd/${lockFd}`;
    const child = spawnSync(
      FLOCK_PATH,
      [
        "-n",
        "-x",
        "-F",
        inheritedLockSource,
        NODE_PATH,
        SCRIPT_PATH,
        INTERNAL_LOCKED_MARKER,
        argv[0],
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 1024,
        timeout: LOCK_TIMEOUT_MS,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (
      child.error !== undefined ||
      child.status !== 0 ||
      child.signal !== null ||
      child.stdout !== "" ||
      child.stderr !== ""
    ) {
      result = 1;
    } else {
      result = 0;
    }
  } catch {
    result = 1;
  } finally {
    if (!closeQuietly(REAL_FS, lockFd)) result = 1;
  }
  return result;
}

export function runCli(argv) {
  if (Array.isArray(argv) && argv[0] === INTERNAL_LOCKED_MARKER) {
    return runLockedCli(argv);
  }
  return runProductionCli(argv);
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === SCRIPT_PATH
  );
}

if (isMainModule()) {
  const exitCode = runCli(process.argv.slice(2));
  if (exitCode === 2) process.stderr.write(`${USAGE_ERROR}\n`);
  if (exitCode === 1) process.stderr.write(`${INTERNAL_ERROR}\n`);
  process.exitCode = exitCode;
}
