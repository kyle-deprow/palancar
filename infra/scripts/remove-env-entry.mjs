#!/usr/bin/env node

import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW;
const READ_ONLY_FLAGS = constants.O_RDONLY | NOFOLLOW;
const TEMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | NOFOLLOW;
const LOCK_WRITE_FLAGS = constants.O_RDWR | NOFOLLOW;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRODUCTION_TARGET_PATH = "/home/dev/repos/palancar_ws/.env";
const PRODUCTION_TARGET_KEY = "OPENROUTER_API_KEY";
const HASH_RE = /^[0-9a-f]{64}$/;
const TEMP_ATTEMPTS = 64;
const TEMP_SAFE_MODE = 0o600;
const OPERATION_MODE = 0o700;
const LOCK_MODE = 0o600;
const KERNEL_LOCK_NAME = ".remove-env-entry.kernel.lock";
const OPERATION_RE = /^\.(.+)\.remove-env-entry-([0-9a-f]{32})\.op$/;
const INTERNAL_LOCK_FD_ENV = "REMOVE_ENV_ENTRY_LOCK_FD";
const INTERNAL_PARENT_LOCK_FD_ENV = "REMOVE_ENV_ENTRY_PARENT_LOCK_FD";
const PROCESS_TREE_FDS_ENV = "REMOVE_ENV_ENTRY_PROCESS_TREE_FDS";
const INTERNAL_NONCE_ENV = "REMOVE_ENV_ENTRY_NONCE";
const INTERNAL_LOCK_FD = 3;
const QUARANTINE_PREFIX = ".remove-env-entry-quarantine-";
const INITIAL_RECORD_NAME = ".remove-env-entry-initial";
const INITIAL_RECORD_VERSION = 1;
const MANIFEST_VERSION = 5;
const PUBLISHED_MARKER_NAME = "published";
const EXCHANGE_HELPER = "/usr/bin/python3";
const EXCHANGE_HELPER_REALPATH_RE = /^\/usr\/bin\/python3(?:\.[0-9]+)*$/;
const EXCHANGE_TIMEOUT_MS = 3000;
const PROCESS_TREE_GRACE_MS = 250;
const PROCESS_TREE_TIMEOUT_MS = 3000;
const RENAME_EXCHANGE = 2;
const RENAME_NOREPLACE = 1;
const MAX_TOMBSTONE_ENTRIES = 32;
const MAX_TOMBSTONE_BYTES = 128 * 1024;
// A successful publication has six records (initial, backup,
// candidate-created, candidate-metadata, prepared, and published).  Cleanup
// then seals candidate, backup, and published with nine records apiece
// (reserved, prepared, exchanged, source-unlinked, source-fsynced,
// tombstone-reserved, tombstone-prepared, tombstone-complete, private-unlinked,
// and complete).  That is 6 + (3 * 10) = 36 records.  Each tombstone's
// reservation is a separate durable state because its basename must be bound
// before its inode exists; the finite complete chain therefore requires 36.
// Keep this explicit cap independent from the directory-entry bound.
const MAX_MANIFEST_RECORDS = 36;
const CANDIDATE_PREPARATION_PHASES = new Set(["candidate-created", "candidate-metadata"]);
const CANDIDATE_POLICY = Object.freeze(["no-target-key", "no-removed-value"]);

// This string is fixed code.  Only non-secret basenames and identity values
// are supplied as argv, while the directory FDs are supplied as 3 and 4.
// The child has no inherited environment, stdin, or output channel.
const EXCHANGE_HELPER_CODE = [
  "import ctypes,hashlib,os,sys",
  "def fail(code): os._exit(code)",
  "def safe_name(value): return bool(value) and b'/' not in value and value not in (b'.',b'..')",
  "if len(sys.argv)==4 and sys.argv[1]=='publish':",
  " source=sys.argv[2].encode('utf-8')",
  " target=sys.argv[3].encode('utf-8')",
  " if not safe_name(source) or not safe_name(target): fail(64)",
  " libc=ctypes.CDLL(None,use_errno=True)",
  " renameat2=getattr(libc,'renameat2',None)",
  " if renameat2 is None: fail(70)",
  " renameat2.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]",
  " renameat2.restype=ctypes.c_int",
  " if renameat2(3,source,4,target," + String(RENAME_NOREPLACE) + ")!=0: fail(74)",
  " os._exit(0)",
"if len(sys.argv)==3:",
  " source=sys.argv[1].encode('utf-8')",
  " target=sys.argv[2].encode('utf-8')",
  " if not safe_name(source) or not safe_name(target): fail(64)",
  " libc=ctypes.CDLL(None,use_errno=True)",
  " renameat2=getattr(libc,'renameat2',None)",
  " if renameat2 is None: fail(70)",
  " renameat2.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]",
  " renameat2.restype=ctypes.c_int",
  " if renameat2(3,source,4,target," + String(RENAME_EXCHANGE) + ")!=0: fail(71)",
  " if os.environ.get('REMOVE_ENV_ENTRY_HELPER_CRASH')=='after-cleanup-exchange': os.kill(os.getpid(),9)",
  " os._exit(0)",
"if len(sys.argv) not in (13,19) or sys.argv[1]!='unlink': fail(64)",
  "name=sys.argv[2].encode('utf-8')",
  "quarantine=sys.argv[3].encode('utf-8')",
  "if not safe_name(name) or not safe_name(quarantine) or name==quarantine: fail(64)",
"try: expected_dev,expected_ino,expected_mode,expected_uid,expected_gid,expected_size,expected_nlink=map(int,sys.argv[4:11]); expected_digest=sys.argv[11]; sensitive=sys.argv[12]",
  "except Exception: fail(64)",
  "if expected_nlink < 1 or len(expected_digest)!=64 or any(c not in '0123456789abcdef' for c in expected_digest) or sensitive not in ('0','1') or (sensitive=='1' and expected_nlink!=1): fail(64)",
"if len(sys.argv)==19:",
" try: placeholder_dev,placeholder_ino,placeholder_mode,placeholder_uid,placeholder_gid,placeholder_size=map(int,sys.argv[13:19])",
" except Exception: fail(64)",
"else: placeholder_dev=placeholder_ino=placeholder_mode=placeholder_uid=placeholder_gid=placeholder_size=None",
  "def matches_owner(st): return st.st_dev==expected_dev and st.st_ino==expected_ino and st.st_uid==expected_uid and st.st_gid==expected_gid and st.st_nlink==expected_nlink and st.st_uid==os.getuid()",
  "def matches(st): return matches_owner(st) and (st.st_mode & 0o7777)==expected_mode and st.st_size==expected_size",
  "def same_state(left,right): return left.st_dev==right.st_dev and left.st_ino==right.st_ino and (left.st_mode & 0o7777)==(right.st_mode & 0o7777) and left.st_uid==right.st_uid and left.st_gid==right.st_gid and left.st_nlink==right.st_nlink and left.st_size==right.st_size",
  "def digest_fd(fd):",
  " h=hashlib.sha256(); total=0; os.lseek(fd,0,os.SEEK_SET)",
  " while True:",
  "  block=os.read(fd,65536)",
  "  if not block: break",
  "  total+=len(block); h.update(block)",
  " return total,h.hexdigest()",
  "try:",
  " fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=3)",
  " st=os.fstat(fd)",
  " if not matches(st): fail(72)",
  " total,digest=digest_fd(fd)",
  " if total!=expected_size or digest!=expected_digest: fail(72)",
" tombstone_flags=os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC",
" if len(sys.argv)==19: tombstone_fd=os.open(quarantine,tombstone_flags,dir_fd=3)",
" else: tombstone_fd=os.open(quarantine,tombstone_flags|os.O_CREAT|os.O_EXCL,0o600,dir_fd=3)",
" tombstone_state=os.fstat(tombstone_fd)",
" if len(sys.argv)==19 and (tombstone_state.st_dev!=placeholder_dev or tombstone_state.st_ino!=placeholder_ino or (tombstone_state.st_mode&0o7777)!=placeholder_mode or tombstone_state.st_uid!=placeholder_uid or tombstone_state.st_gid!=placeholder_gid or tombstone_state.st_size!=placeholder_size or tombstone_state.st_nlink!=1): fail(72)",
  " libc=ctypes.CDLL(None,use_errno=True)",
  " renameat2=getattr(libc,'renameat2',None)",
  " if renameat2 is None: fail(70)",
  " renameat2.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]",
  " renameat2.restype=ctypes.c_int",
" if renameat2(3,name,3,quarantine," + String(RENAME_EXCHANGE) + ")!=0: fail(71)",
" if os.environ.get('REMOVE_ENV_ENTRY_HELPER_CRASH')=='after-cleanup-exchange': os.kill(os.getpid(),9)",
" name_fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=3)",
" name_state=os.fstat(name_fd)",
" if not same_state(name_state,tombstone_state) or not same_state(os.fstat(tombstone_fd),tombstone_state): fail(72)",
" quarantined_fd=os.open(quarantine,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=3)",
" quarantined_state=os.fstat(quarantined_fd)",
" quarantined_total,quarantined_digest=digest_fd(quarantined_fd)",
" if not matches(quarantined_state) or quarantined_total!=expected_size or quarantined_digest!=expected_digest: fail(72)",
" original_state=os.fstat(fd)",
" original_total,original_digest=digest_fd(fd)",
" if not matches(original_state) or original_total!=expected_size or original_digest!=expected_digest: fail(72)",
" os.unlink(quarantine,dir_fd=3)",
" if os.environ.get('REMOVE_ENV_ENTRY_HELPER_CRASH')=='after-cleanup-first-unlink': os.kill(os.getpid(),9)",
" os.unlink(name,dir_fd=3)",
" if os.environ.get('REMOVE_ENV_ENTRY_HELPER_CRASH')=='after-cleanup-second-unlink': os.kill(os.getpid(),9)",
" os.close(name_fd); os.close(quarantined_fd); os.close(tombstone_fd); os.close(fd)",
  "except BaseException: fail(73)",
  "os._exit(0)",
].join("\n");

// The wrapper creates a new process group for the command and becomes a child
// subreaper before launching it.  A process group does not contain a daemon
// which calls setsid(), so timeout cleanup also walks the wrapper's complete
// /proc child tree and signals every process by pidfd where available.
const PROCESS_TREE_HELPER_CODE = [
  "import ctypes,errno,os,signal,subprocess,sys,time",
  "def write_all(fd,data):",
  " while data:",
  "  written=os.write(fd,data)",
  "  if written<=0: os._exit(70)",
  "  data=data[written:]",
  "def children_of(pid):",
  " try:",
  "  with open('/proc/'+str(pid)+'/task/'+str(pid)+'/children','rb') as stream: data=stream.read()",
  " except FileNotFoundError: return []",
  " except OSError: return None",
  " try: return [int(value) for value in data.split()]",
  " except ValueError: return None",
  "def descendants():",
  " root=os.getpid(); pending=[root]; seen={root}; result=set()",
  " while pending:",
  "  parent=pending.pop(); children=children_of(parent)",
  "  if children is None: return None",
  "  for pid in children:",
  "   if pid<=0 or pid in seen: continue",
  "   seen.add(pid); result.add(pid); pending.append(pid)",
  " return result",
  "def pidfd_for(pid):",
  " opener=getattr(os,'pidfd_open',None)",
  " if opener is None: return None",
  " try: return opener(pid,0)",
  " except OSError: return None",
  "def signal_processes(pids,signum):",
  " sender=getattr(signal,'pidfd_send_signal',None); targets=[]",
  " for pid in sorted(pids): targets.append((pid,pidfd_for(pid)))",
  " for pid,pidfd in targets:",
  "  try:",
  "   if pidfd is not None and sender is not None:",
  "    try: sender(pidfd,signum)",
  "    except OSError as error:",
  "     if error.errno not in (errno.EINVAL,errno.ENOSYS,errno.ESRCH): continue",
  "     if error.errno==errno.ESRCH: continue",
  "    else: continue",
  "   try: os.kill(pid,signum)",
  "   except OSError: pass",
  "  finally:",
  "   if pidfd is not None:",
  "    try: os.close(pidfd)",
  "    except OSError: pass",
  "def kill_group(pid):",
  " try: os.killpg(pid,signal.SIGKILL)",
  " except OSError: pass",
  "def reap_known(child,pids):",
  " try: child.poll()",
  " except BaseException: pass",
  " for pid in pids:",
  "  if pid==child.pid: continue",
  "  try: os.waitpid(pid,os.WNOHANG)",
  "  except (ChildProcessError,ProcessLookupError): pass",
  "def current_tree(child,include_root):",
  " pids=descendants()",
  " if pids is None: return None",
  " if not include_root: pids.discard(child.pid)",
  " return pids",
  "def terminate_tree(child,grace,include_root):",
  " if include_root:",
  "  try: os.killpg(child.pid,signal.SIGTERM)",
  "  except OSError: pass",
  " term_deadline=time.monotonic()+max(0.0,grace)",
  " while True:",
  "  pids=current_tree(child,include_root)",
  "  if pids is None: return False",
  "  reap_known(child,pids); pids=current_tree(child,include_root)",
  "  if pids is None: return False",
  "  if not pids: return True",
  "  signal_processes(pids,signal.SIGTERM)",
  "  if time.monotonic()>=term_deadline: break",
  "  time.sleep(min(0.01,max(0.0,term_deadline-time.monotonic())))",
  " if include_root and child.returncode is None: kill_group(child.pid)",
  " kill_deadline=time.monotonic()+max(0.25,grace)",
  " while True:",
  "  pids=current_tree(child,include_root)",
  "  if pids is None: return False",
  "  reap_known(child,pids); pids=current_tree(child,include_root)",
  "  if pids is None: return False",
  "  if not pids: return True",
  "  signal_processes(pids,signal.SIGKILL)",
  "  if time.monotonic()>=kill_deadline: break",
  "  time.sleep(min(0.01,max(0.0,kill_deadline-time.monotonic())))",
  " pids=current_tree(child,include_root)",
  " if pids is None: return False",
  " reap_known(child,pids)",
  " pids=current_tree(child,include_root)",
  " return pids is not None and not pids",
  "PR_SET_CHILD_SUBREAPER=36",
  "libc=ctypes.CDLL(None,use_errno=True); prctl=getattr(libc,'prctl',None)",
  "if prctl is None: os._exit(70)",
  "prctl.argtypes=[ctypes.c_int,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong]; prctl.restype=ctypes.c_int",
  "if prctl(PR_SET_CHILD_SUBREAPER,1,0,0,0)!=0: os._exit(70)",
  "timeout=float(sys.argv[1])/1000.0",
  "grace=float(sys.argv[2])/1000.0",
  "command=sys.argv[3:]",
  "if not command: os._exit(64)",
  "try:",
  " inherited=tuple(fd for fd in (int(x) for x in os.environ.get('REMOVE_ENV_ENTRY_PROCESS_TREE_FDS','').split(',') if x) if os.path.exists('/proc/self/fd/'+str(fd)))",
  " child=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=inherited,start_new_session=True,close_fds=True)",
  "except BaseException: os._exit(70)",
  "try:",
  " stdout,stderr=child.communicate(sys.stdin.buffer.read(),timeout=timeout)",
  "except subprocess.TimeoutExpired:",
  " try: contained=terminate_tree(child,grace,True)",
  " except BaseException: contained=False",
  " try: stdout,stderr=child.communicate(timeout=grace+0.5)",
  " except BaseException:",
  "  stdout,stderr=b'',b''",
  " if not contained: write_all(1,b''); write_all(2,b''); os._exit(125)",
  " write_all(1,b''); write_all(2,b''); os._exit(124)",
  "try: contained=terminate_tree(child,grace,False)",
  "except BaseException: contained=False",
  "if not contained: write_all(1,b''); write_all(2,b''); os._exit(125)",
  "write_all(1,stdout); write_all(2,stderr)",
  "code=child.returncode if child.returncode is not None else 125",
  "os._exit(code if code>=0 else 128-code)",
].join("\n");

let quarantineSequence = 0;

export const OPERATIONS = Object.freeze(["remove", "assert-absent"]);

const DEFAULT_FS = Object.freeze({
  closeSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeSync,
});

export class RemoveEnvEntryError extends Error {
  constructor(code, recoveryPath) {
    super(
      typeof recoveryPath === "string"
        ? `remove-env-entry operation failed; recovery path: ${recoveryPath}`
        : "remove-env-entry operation failed",
    );
    this.name = "RemoveEnvEntryError";
    this.code = code;
    if (typeof recoveryPath === "string") this.recoveryPath = recoveryPath;
  }
}

function failure(code, recoveryPath) {
  return new RemoveEnvEntryError(code, recoveryPath);
}

function normalizeFailure(error, code = "operation") {
  return error instanceof RemoveEnvEntryError ? error : failure(code);
}

function validateRequest(filePath, key) {
  if (
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    typeof key !== "string" ||
    !KEY_RE.test(key)
  ) {
    throw failure("usage");
  }
}

function validateProductionRequest(filePath, key) {
  if (
    filePath !== PRODUCTION_TARGET_PATH ||
    path.normalize(filePath) !== PRODUCTION_TARGET_PATH ||
    path.resolve(filePath) !== PRODUCTION_TARGET_PATH ||
    key !== PRODUCTION_TARGET_KEY
  ) {
    throw failure("usage");
  }
}

function isProductionRequest(filePath, key) {
  return typeof filePath === "string" && typeof key === "string" &&
    filePath === PRODUCTION_TARGET_PATH &&
    path.normalize(filePath) === PRODUCTION_TARGET_PATH &&
    path.resolve(filePath) === PRODUCTION_TARGET_PATH &&
    key === PRODUCTION_TARGET_KEY;
}

function isRegular(stat) {
  return stat !== null && typeof stat === "object" &&
    typeof stat.mode === "number" && (stat.mode & 0o170000) === 0o100000;
}

function isDirectory(stat) {
  return stat !== null && typeof stat === "object" &&
    typeof stat.mode === "number" && (stat.mode & 0o170000) === 0o040000;
}

function validateRegular(stat, code = "not-regular") {
  if (!isRegular(stat)) throw failure(code);
}

function validateDirectory(stat, code = "not-directory") {
  if (!isDirectory(stat)) throw failure(code);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function validateCurrentUser(stat, code = "unsafe-owner") {
  const uid = currentUid();
  if (uid !== undefined && stat?.uid !== uid) throw failure(code);
}

function validateParentDirectory(stat) {
  validateDirectory(stat, "unsafe-parent");
  validateCurrentUser(stat, "unsafe-parent");
  // A sticky writable directory is not accepted: this implementation has no
  // policy proving that all writers are safe.  The namespace is therefore
  // bound only in a current-user-owned directory without group/world write.
  if ((stat.mode & 0o022) !== 0) throw failure("unsafe-parent");
}

function validatePrivateDirectory(stat, code = "operation-directory") {
  validateDirectory(stat, code);
  validateCurrentUser(stat, code);
  if ((stat.mode & 0o7777) !== OPERATION_MODE) throw failure(code);
}

function validateLockStat(stat) {
  validateRegular(stat, "kernel-lock");
  validateCurrentUser(stat, "kernel-lock");
  if ((stat.mode & 0o077) !== 0 || (stat.mode & LOCK_MODE) !== LOCK_MODE) {
    throw failure("kernel-lock");
  }
}

function sameIdentity(left, right) {
  return typeof left?.dev === "number" && typeof left?.ino === "number" &&
    typeof left?.mode === "number" && typeof left?.uid === "number" &&
    typeof left?.gid === "number" && typeof left?.size === "number" &&
    typeof right?.dev === "number" && typeof right?.ino === "number" &&
    typeof right?.mode === "number" && typeof right?.uid === "number" &&
    typeof right?.gid === "number" && typeof right?.size === "number" &&
    left.dev === right.dev && left.ino === right.ino &&
    (left.mode & 0o7777) === (right.mode & 0o7777) &&
    left.uid === right.uid && left.gid === right.gid && left.size === right.size;
}

function sameDirectoryIdentity(left, right) {
  return typeof left?.dev === "number" && typeof left?.ino === "number" &&
    typeof left?.mode === "number" && typeof left?.uid === "number" &&
    typeof left?.gid === "number" && typeof right?.dev === "number" &&
    typeof right?.ino === "number" && typeof right?.mode === "number" &&
    typeof right?.uid === "number" && typeof right?.gid === "number" &&
    left.dev === right.dev && left.ino === right.ino &&
    (left.mode & 0o7777) === (right.mode & 0o7777) &&
    left.uid === right.uid && left.gid === right.gid;
}

function sameCreatedFile(left, right) {
  return typeof left?.dev === "number" && typeof left?.ino === "number" &&
    typeof right?.dev === "number" && typeof right?.ino === "number" &&
    left.dev === right.dev && left.ino === right.ino;
}

function closedObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedString(value, max = MAX_TOMBSTONE_BYTES) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validSafeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

const STABLE_STAT_FIELDS = Object.freeze(["mode", "uid", "gid", "size", "mtimeNs", "mtimeMs"]);

function sameStableState(left, right) {
  return sameIdentity(left, right) && STABLE_STAT_FIELDS.every((field) => {
    if (left?.[field] === undefined && right?.[field] === undefined) return true;
    return left?.[field] === right?.[field];
  });
}

function contentHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function closeTracked(fs, fd, code = "file-close") {
  if (fd === undefined) return undefined;
  try {
    fs.closeSync(fd);
    return undefined;
  } catch {
    return failure(code);
  }
}

function validateName(name) {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === ".." ||
      path.basename(name) !== name || name.includes("/")) throw failure("unsafe-path");
}

function childPath(directory, name) {
  validateName(name);
  return path.join(directory.path, name);
}

function displayChildPath(directory, name) {
  validateName(name);
  return path.join(directory.displayPath, name);
}

function readRegularFile(filePath, fs, keepOpen = false, code = "read") {
  let fd;
  let result;
  let error;
  try {
    const listed = fs.lstatSync(filePath);
    validateRegular(listed, code === "read" ? "not-regular" : code);
    validateCurrentUser(listed);
    fd = fs.openSync(filePath, READ_ONLY_FLAGS);
    const opened = fs.fstatSync(fd);
    validateRegular(opened);
    validateCurrentUser(opened);
    if (!sameIdentity(listed, opened)) throw failure("file-changed");
    const raw = fs.readFileSync(fd);
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const afterRead = fs.fstatSync(fd);
    validateRegular(afterRead);
    validateCurrentUser(afterRead);
    if (!sameStableState(opened, afterRead)) throw failure("file-changed");
    result = {
      bytes,
      mode: afterRead.mode & 0o7777,
      uid: afterRead.uid,
      gid: afterRead.gid,
      identity: afterRead,
      state: afterRead,
      nlink: linkCount(afterRead),
      contentHash: contentHash(bytes),
    };
  } catch (caught) {
    error = normalizeFailure(caught, code);
  }
  if (fd !== undefined && (error !== undefined || !keepOpen)) {
    const closeError = closeTracked(fs, fd);
    if (error === undefined && closeError !== undefined) error = closeError;
    fd = undefined;
  }
  if (error === undefined && keepOpen) {
    result.fd = fd;
    fd = undefined;
  }
  if (error !== undefined) throw error;
  return result;
}

function lineSpans(bytes, key) {
  const assignment = /^[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=/;
  const spans = [];
  let lineStart = 0;
  let quoted = null;
  let assignmentStart;
  let assignmentIsTarget = false;

  function scanQuotedValue(start, end, quote) {
    for (let index = start; index < end; index += 1) {
      const byte = bytes[index];
      if (byte === 0x5c) {
        index += 1;
        continue;
      }
      if (byte === quote) return null;
    }
    return quote;
  }

  function valueOpeningQuote(start, end) {
    let valueStart = start;
    while (valueStart < end && (bytes[valueStart] === 0x20 || bytes[valueStart] === 0x09)) valueStart += 1;
    const first = bytes[valueStart];
    return first === 0x22 || first === 0x27 ? { character: first, contentStart: valueStart + 1 } : null;
  }

  while (lineStart < bytes.length) {
    const newline = bytes.indexOf(0x0a, lineStart);
    const lineEnd = newline === -1 ? bytes.length : newline;
    let contentEnd = lineEnd;
    if (contentEnd > lineStart && bytes[contentEnd - 1] === 0x0d) contentEnd -= 1;
    const logicalEnd = newline === -1 ? bytes.length : newline + 1;

    if (quoted !== null) {
      quoted = scanQuotedValue(lineStart, contentEnd, quoted);
      if (quoted === null) {
        if (assignmentIsTarget) spans.push({ start: assignmentStart, end: logicalEnd });
        assignmentStart = undefined;
        assignmentIsTarget = false;
      }
    } else {
      const line = bytes.toString("utf8", lineStart, contentEnd);
      const match = assignment.exec(line);
      if (match !== null) {
        const valueStart = lineStart + match[0].length;
        const opening = valueOpeningQuote(valueStart, contentEnd);
        quoted = opening === null ? null : scanQuotedValue(opening.contentStart, contentEnd, opening.character);
        if (quoted === null && match[1] === key) spans.push({ start: lineStart, end: logicalEnd });
        else if (quoted !== null) {
          assignmentStart = lineStart;
          assignmentIsTarget = match[1] === key;
        }
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (quoted !== null && assignmentIsTarget) throw failure("malformed");
  return spans;
}

export function countAssignments(bytes, key) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (typeof key !== "string" || !KEY_RE.test(key)) return 0;
  return lineSpans(bytes, key).length;
}

function removeSpan(bytes, span) {
  return Buffer.concat([bytes.subarray(0, span.start), bytes.subarray(span.end)]);
}

function removedSecretNeedles(bytes, span) {
  const assignment = bytes.subarray(span.start, span.end);
  const equals = assignment.indexOf(0x3d);
  if (equals < 0) return [];
  let start = equals + 1;
  let end = assignment.length;
  while (start < end && (assignment[start] === 0x20 || assignment[start] === 0x09)) start += 1;
  while (end > start && (assignment[end - 1] === 0x0a || assignment[end - 1] === 0x0d)) end -= 1;
  if (start === end) return [];
  const raw = assignment.subarray(start, end);
  const needles = [Buffer.from(raw)];
  if ((raw[0] === 0x22 || raw[0] === 0x27) && raw[raw.length - 1] === raw[0] && raw.length > 1) {
    needles.push(Buffer.from(raw.subarray(1, raw.length - 1)));
  }
  return needles.filter((needle, index, all) => needle.length !== 0 &&
    all.findIndex((candidate) => candidate.equals(needle)) === index);
}

function candidateBytesSafe(bytes, key, secretNeedles = []) {
  try {
    if (lineSpans(bytes, key).length !== 0 ||
        (key !== PRODUCTION_TARGET_KEY && lineSpans(bytes, PRODUCTION_TARGET_KEY).length !== 0)) return false;
  } catch {
    return false;
  }
  return secretNeedles.every((needle) => !bytes.includes(needle));
}

function validateReplacementSource(stat) {
  if (!Number.isSafeInteger(stat.uid) || stat.uid < 0 || !Number.isSafeInteger(stat.gid) || stat.gid < 0) {
    throw failure("unsafe-owner");
  }
}

function validateInitialTarget(stat) {
  if (!Number.isSafeInteger(stat?.nlink) || stat.nlink !== 1) throw failure("hardlink");
}

function validateInitialTargetPath(target, fs) {
  let fd;
  try {
    const listed = fs.lstatSync(target.path);
    validateRegular(listed);
    validateCurrentUser(listed);
    validateInitialTarget(listed);
    fd = fs.openSync(target.path, READ_ONLY_FLAGS);
    const opened = fs.fstatSync(fd);
    validateRegular(opened);
    validateCurrentUser(opened);
    validateInitialTarget(opened);
    if (!sameIdentity(listed, opened)) throw failure("file-changed");
  } catch (caught) {
    throw normalizeFailure(caught, "hardlink");
  } finally {
    closeTracked(fs, fd);
  }
}

function writeAll(fs, fd, bytes, afterWrite) {
  let offset = 0;
  while (offset < bytes.length) {
    let written;
    try {
      written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    } catch {
      throw failure("temporary-write");
    }
    if (!Number.isSafeInteger(written) || written <= 0) throw failure("temporary-write");
    offset += written;
    if (typeof afterWrite === "function") afterWrite(offset, written);
  }
}

function bindParent(filePath, fs, useBoundPath) {
  const parentPath = path.dirname(filePath);
  const base = path.basename(filePath);
  validateName(base);
  let fd;
  try {
    fd = fs.openSync(parentPath, DIRECTORY_FLAGS);
    const listed = fs.lstatSync(parentPath);
    validateParentDirectory(listed);
    const opened = fs.fstatSync(fd);
    validateParentDirectory(opened);
    if (!sameDirectoryIdentity(listed, opened)) throw failure("unsafe-parent");
    return {
      path: useBoundPath ? `/proc/self/fd/${fd}` : parentPath,
      displayPath: parentPath,
      name: base,
      fd,
      identity: opened,
      isParent: true,
    };
  } catch (caught) {
    closeTracked(fs, fd, "parent-close");
    throw normalizeFailure(caught, "unsafe-parent");
  }
}

function revalidateDirectory(directory, fs, code = "unsafe-parent") {
  try {
    const descriptor = fs.fstatSync(directory.fd);
    if (directory.isParent) validateParentDirectory(descriptor);
    else validatePrivateDirectory(descriptor, code);
    if (!sameDirectoryIdentity(directory.identity, descriptor)) throw failure(code);
    const listed = fs.lstatSync(directory.displayPath);
    if (directory.isParent) validateParentDirectory(listed);
    else validatePrivateDirectory(listed, code);
    if (!sameDirectoryIdentity(directory.identity, listed)) throw failure(code);
  } catch (caught) {
    throw normalizeFailure(caught, code);
  }
}

function fsyncDirectory(directory, fs, options = {}) {
  if (directory.isParent) {
    try {
      revalidateDirectory(directory, fs, options.code ?? "directory-fsync");
      fs.fsyncSync(directory.fd);
      revalidateDirectory(directory, fs, options.code ?? "directory-fsync");
      return;
    } catch (caught) {
      throw normalizeFailure(caught, options.code ?? "directory-fsync");
    }
  }
  let fd;
  let error;
  try {
    revalidateDirectory(directory, fs, options.code ?? "directory-fsync");
    fd = fs.openSync(directory.path, DIRECTORY_FLAGS);
    const opened = fs.fstatSync(fd);
    if (!sameDirectoryIdentity(directory.identity, opened)) throw failure(options.code ?? "directory-fsync");
    fs.fsyncSync(fd);
  } catch (caught) {
    error = normalizeFailure(caught, options.code ?? "directory-fsync");
  }
  const closeError = closeTracked(fs, fd, options.closeCode ?? "directory-close");
  if (error === undefined && closeError !== undefined) error = closeError;
  if (error === undefined) {
    try {
      revalidateDirectory(directory, fs, options.code ?? "directory-fsync");
    } catch (caught) {
      error = normalizeFailure(caught, options.code ?? "directory-fsync");
    }
  }
  if (error !== undefined) throw error;
}

function safeOperationName(filePath, randomBytesFn) {
  const base = path.basename(filePath);
  let suffix;
  try {
    suffix = Buffer.from(randomBytesFn(16)).toString("hex");
  } catch {
    throw failure("operation-create");
  }
  if (!/^[0-9a-f]{32}$/.test(suffix)) throw failure("operation-create");
  return `.${base}.remove-env-entry-${suffix}.op`;
}

function createOperationDirectory(parent, filePath, fs, randomBytesFn) {
  for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt += 1) {
    const name = safeOperationName(filePath, randomBytesFn);
    const accessPath = path.join(parent.path, name);
    const displayPath = path.join(parent.displayPath, name);
    let created = false;
    let fd;
    let createdIdentity;
    try {
      revalidateDirectory(parent, fs);
      fs.mkdirSync(accessPath, OPERATION_MODE);
      created = true;
      const listed = fs.lstatSync(accessPath);
      validatePrivateDirectory(listed);
      createdIdentity = listed;
      fd = fs.openSync(accessPath, DIRECTORY_FLAGS);
      const opened = fs.fstatSync(fd);
      validatePrivateDirectory(opened);
      if (!sameDirectoryIdentity(listed, opened)) throw failure("operation-directory");
      return { path: accessPath, displayPath, name, fd, identity: opened, parent };
    } catch (caught) {
      if (!created && caught?.code === "EEXIST") continue;
      const normalized = normalizeFailure(caught, "operation-create");
      closeTracked(fs, fd);
      if (created) {
        try {
          if (fd !== undefined) fd = undefined;
          const current = fs.lstatSync(accessPath);
          if (!sameDirectoryIdentity(current, createdIdentity)) throw failure("operation-directory");
          // The operation name is not removed by pathname.  If creation
          // failed after publication of the name, leave the empty, bound
          // directory for the next read-only recovery pass.
          fsyncDirectory(parent, fs);
        } catch {
          normalized.recoveryPath = displayPath;
        }
      }
      throw normalized;
    }
  }
  throw failure("operation-collision");
}

function assertOperationDirectory(operation, fs) {
  revalidateDirectory(operation, fs, "operation-directory");
}

function createOwnedFile(directory, name, mode, fs) {
  const filePath = childPath(directory, name);
  const displayPath = displayChildPath(directory, name);
  let fd;
  let created = false;
  let identity;
  try {
    fd = fs.openSync(filePath, TEMP_FLAGS, mode);
    created = true;
    identity = fs.fstatSync(fd);
    validateRegular(identity, "temporary-create");
    validateCurrentUser(identity, "temporary-create");
    return { path: filePath, displayPath, name, directory, fd, identity, created: true };
  } catch (caught) {
    if (caught?.code === "EEXIST") {
      closeTracked(fs, fd);
      throw caught;
    }
    const normalized = normalizeFailure(caught, "temporary-create");
    closeTracked(fs, fd);
    if (created && identity === undefined) normalized.recoveryPath = directory.displayPath;
    throw normalized;
  }
}

function identityRecord(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
  };
}

function directoryIdentityRecord(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
  };
}

function validDirectoryIdentityRecord(value) {
  return closedObject(value, ["dev", "ino", "mode", "uid", "gid"]) &&
    validSafeInteger(value.dev) && validSafeInteger(value.ino) &&
    validSafeInteger(value.uid) && validSafeInteger(value.gid) &&
    validSafeInteger(value.mode) && value.mode <= 0o7777;
}

function sameDirectoryIdentityRecord(stat, record) {
  return validDirectoryIdentityRecord(record) && typeof stat?.dev === "number" &&
    typeof stat?.ino === "number" && typeof stat?.mode === "number" &&
    typeof stat?.uid === "number" && typeof stat?.gid === "number" &&
    stat.dev === record.dev && stat.ino === record.ino &&
    (stat.mode & 0o7777) === record.mode && stat.uid === record.uid &&
    stat.gid === record.gid;
}

function linkCount(stat) {
  return Number.isSafeInteger(stat?.nlink) && stat.nlink > 0 ? stat.nlink : undefined;
}

function sameLinkCount(stat, expected) {
  return Number.isSafeInteger(expected) && linkCount(stat) === expected;
}

function validIdentityRecord(value) {
  return closedObject(value, ["dev", "ino", "mode", "uid", "gid", "size"]) &&
    validSafeInteger(value.dev) && validSafeInteger(value.ino) &&
    validSafeInteger(value.uid) && validSafeInteger(value.gid) &&
    validSafeInteger(value.size) && validSafeInteger(value.mode) && value.mode <= 0o7777;
}

function sameIdentityRecord(stat, record) {
  return validIdentityRecord(record) && typeof stat?.dev === "number" &&
    typeof stat?.ino === "number" && typeof stat?.mode === "number" &&
    typeof stat?.uid === "number" && typeof stat?.gid === "number" &&
    typeof stat?.size === "number" && stat.dev === record.dev && stat.ino === record.ino &&
    (stat.mode & 0o7777) === record.mode && stat.uid === record.uid &&
    stat.gid === record.gid && stat.size === record.size;
}

function canonicalManifest(manifest) {
  return `${JSON.stringify(manifest)}\n`;
}

const EMPTY_DIGEST = contentHash(Buffer.alloc(0));
const CLEANUP_PHASES = new Set([
  "placeholder-reserved",
  "prepared",
  "exchanged",
  "source-unlinked",
  "source-fsynced",
  "private-unlinked",
  "complete",
]);

function validHash(value) {
  return typeof value === "string" && HASH_RE.test(value);
}

function validOperationName(value) {
  return boundedString(value, 255) && !value.includes("/") && OPERATION_RE.test(value);
}

function validEntryName(value) {
  return boundedString(value, 255) && !value.includes("/") && value !== "." && value !== "..";
}

function validDescriptor(value, name = undefined) {
  return closedObject(value, ["name", "identity", "nlink", "digest"]) &&
    (name === undefined ? validEntryName(value.name) : value.name === name) &&
    validIdentityRecord(value.identity) && validSafeInteger(value.nlink, 1) &&
    validHash(value.digest);
}

function validCandidatePolicy(value) {
  return Array.isArray(value) && value.length === CANDIDATE_POLICY.length &&
    value.every((item, index) => item === CANDIDATE_POLICY[index]);
}

function validCandidateDescriptor(value, allowLegacy = true) {
  if (allowLegacy && validDescriptor(value, "candidate")) return true;
  return closedObject(value, ["name", "identity", "nlink", "digest", "policy"]) &&
    value.name === "candidate" && validIdentityRecord(value.identity) &&
    validSafeInteger(value.nlink, 1) && validHash(value.digest) && validCandidatePolicy(value.policy);
}

function candidateDescriptor(candidate, digest = EMPTY_DIGEST) {
  return {
    name: "candidate",
    identity: identityRecord(candidate.identity),
    nlink: linkCount(candidate.identity),
    digest,
    policy: [...CANDIDATE_POLICY],
  };
}

function validOriginalDescriptor(value) {
  return closedObject(value, ["identity", "nlink", "digest"]) &&
    validIdentityRecord(value.identity) && value.nlink === 1 && validHash(value.digest);
}

function validInitialPlanEntry(value) {
  return closedObject(value, ["name", "identity", "nlink", "digest", "mode", "uid", "gid", "size"]) &&
    ["backup", "candidate"].includes(value.name) &&
    (value.identity === null || validIdentityRecord(value.identity)) &&
    validSafeInteger(value.nlink, 1) && validHash(value.digest) &&
    validSafeInteger(value.mode) && value.mode <= 0o7777 &&
    validSafeInteger(value.uid) && validSafeInteger(value.gid) && validSafeInteger(value.size);
}

function validInitialRecord(record) {
  return closedObject(record, [
    "version", "targetPath", "operationDirectory", "operationIdentity", "parentIdentity", "target", "entries",
  ]) && record.version === INITIAL_RECORD_VERSION && boundedString(record.targetPath) &&
    path.isAbsolute(record.targetPath) && validOperationName(record.operationDirectory) &&
    validDirectoryIdentityRecord(record.operationIdentity) && validDirectoryIdentityRecord(record.parentIdentity) &&
    closedObject(record.target, ["name", "identity", "nlink", "digest"]) && validEntryName(record.target.name) &&
    validIdentityRecord(record.target.identity) && record.target.nlink === 1 && validHash(record.target.digest) &&
    Array.isArray(record.entries) && record.entries.length === 2 &&
    record.entries.every(validInitialPlanEntry) &&
    new Set(record.entries.map((entry) => entry.name)).size === record.entries.length &&
    record.entries.some((entry) => entry.name === "backup" && entry.identity !== null && entry.nlink >= 2) &&
    record.entries.some((entry) => entry.name === "candidate" && entry.identity === null && entry.nlink === 1);
}

function validCleanupRecord(record) {
  if (!closedObject(record, ["entry", "phase", "sensitive", "source", "placeholder", "tombstone"]) ||
      !["candidate", "backup", PUBLISHED_MARKER_NAME].includes(record.entry) ||
      !CLEANUP_PHASES.has(record.phase) || typeof record.sensitive !== "boolean" ||
      !validDescriptor(record.source, record.entry) ||
      !closedObject(record.placeholder, ["name", "identity", "digest", "created"]) ||
      !boundedString(record.placeholder.name, 255) ||
      !record.placeholder.name.startsWith(QUARANTINE_PREFIX) ||
      !validHash(record.placeholder.digest) || record.placeholder.digest !== EMPTY_DIGEST ||
      typeof record.placeholder.created !== "boolean" ||
      (record.tombstone !== null && !validTombstoneRecord(record.tombstone))) return false;
  if (record.sensitive && record.source.nlink !== 1) return false;
  if (record.phase === "placeholder-reserved") {
    return record.placeholder.identity === null && record.placeholder.created === false;
  }
  return record.placeholder.created === true && validIdentityRecord(record.placeholder.identity);
}

function validEvidenceRecord(record) {
  return closedObject(record, ["entry", "phase", "foreign", "placeholder"]) &&
    validEntryName(record.entry) && ["reserved", "prepared", "exchanged"].includes(record.phase) &&
    closedObject(record.foreign, ["identity", "nlink", "digest"]) &&
    validIdentityRecord(record.foreign.identity) && validSafeInteger(record.foreign.nlink, 1) &&
    validHash(record.foreign.digest) &&
    closedObject(record.placeholder, ["name", "identity", "digest"]) &&
    boundedString(record.placeholder.name, 255) && record.placeholder.name.startsWith(QUARANTINE_PREFIX) &&
    validHash(record.placeholder.digest) && record.placeholder.digest === EMPTY_DIGEST &&
    ((record.phase === "reserved" && record.placeholder.identity === null) ||
      (record.phase !== "reserved" && validIdentityRecord(record.placeholder.identity)));
}

function validTombstoneRecord(record) {
  return closedObject(record, ["phase", "source", "quarantine", "sensitive"]) &&
    ["reserved", "prepared", "exchanged", "complete"].includes(record.phase) &&
    typeof record.sensitive === "boolean" && validDescriptor(record.source) &&
    closedObject(record.quarantine, ["name", "identity", "digest"]) &&
    validEntryName(record.quarantine.name) && record.quarantine.name.startsWith(QUARANTINE_PREFIX) &&
    validHash(record.quarantine.digest) && record.quarantine.digest === EMPTY_DIGEST &&
    ((record.phase === "reserved" && record.quarantine.identity === null) ||
      (record.phase !== "reserved" && validIdentityRecord(record.quarantine.identity) &&
        record.quarantine.identity.mode === TEMP_SAFE_MODE && record.quarantine.identity.size === 0)) &&
    (!record.sensitive || record.source.nlink === 1);
}


function validManifestRecord(record) {
  if (!closedObject(record, [
    "version", "sequence", "previousDigest", "phase", "targetPath", "operationDirectory", "operationIdentity", "parentIdentity",
    "initial", "exchange", "candidate", "backup", "original", "cleanup", "evidence",
  ]) || record.version !== MANIFEST_VERSION || !validSafeInteger(record.sequence) || !validHash(record.previousDigest) ||
      !["initial", "candidate-created", "candidate-metadata", "prepared", "published-exchange", "published"].includes(record.phase) ||
      !boundedString(record.targetPath) || !path.isAbsolute(record.targetPath) ||
      !validOperationName(record.operationDirectory) || !validDirectoryIdentityRecord(record.operationIdentity) ||
      !validDirectoryIdentityRecord(record.parentIdentity) ||
      !closedObject(record.exchange, ["source", "target"]) || record.exchange.source !== "candidate" ||
      !validEntryName(record.exchange.target) ||
      !validOriginalDescriptor(record.original) ||
      !Array.isArray(record.cleanup) || record.cleanup.length > MAX_MANIFEST_RECORDS ||
      !record.cleanup.every(validCleanupRecord) || !Array.isArray(record.evidence) ||
      record.evidence.length > MAX_MANIFEST_RECORDS || !record.evidence.every(validEvidenceRecord)) return false;

  const initialValid = record.initial !== null && closedObject(record.initial, ["name", "identity", "nlink", "digest"]) &&
    record.initial.name === INITIAL_RECORD_NAME && validIdentityRecord(record.initial.identity) &&
    record.initial.nlink === 1 && validHash(record.initial.digest);
  const candidateValid = record.candidate === null || validCandidateDescriptor(record.candidate);
  const backupValid = record.backup === null || validDescriptor(record.backup, "backup");
  if (!initialValid || !candidateValid || !backupValid) return false;
  if (record.phase === "initial") {
    if (record.candidate !== null || record.evidence.length !== 0) return false;
  } else if (record.candidate === null || record.backup === null) {
    return false;
  }
  if (CANDIDATE_PREPARATION_PHASES.has(record.phase) &&
      (!validCandidateDescriptor(record.candidate, false) || record.candidate.digest !== EMPTY_DIGEST ||
       record.candidate.identity.size !== 0 || record.candidate.nlink !== 1)) return false;
  if (record.backup !== null && record.backup.digest !== record.original.digest) return false;
  if (record.candidate !== null && record.candidate.digest === record.original.digest) return false;
  if (record.cleanup.some((item, index, all) => all.findIndex((candidate) => candidate.entry === item.entry) !== index) ||
      record.evidence.some((item, index, all) => all.findIndex((candidate) => candidate.placeholder.name === item.placeholder.name) !== index)) {
    return false;
  }
  return true;
}

function initialRecordFor(operation, target, original, plan) {
  return {
    version: INITIAL_RECORD_VERSION,
    targetPath: target.displayPath,
    operationDirectory: operation.name,
    operationIdentity: directoryIdentityRecord(operation.identity),
    parentIdentity: directoryIdentityRecord(operation.parent.identity),
    target: {
      name: target.name,
      identity: identityRecord(original.identity),
      nlink: original.nlink,
      digest: original.contentHash,
    },
    entries: plan,
  };
}

function initialPlanFor(original, replacementHash, replacementSize) {
  return [
    {
      name: "backup",
      identity: identityRecord(original.identity),
      nlink: original.nlink + 1,
      digest: original.contentHash,
      mode: original.mode,
      uid: original.uid,
      gid: original.gid,
      size: original.bytes.length,
    },
    {
      name: "candidate",
      identity: null,
      nlink: 1,
      digest: replacementHash,
      mode: original.mode,
      uid: original.uid,
      gid: original.gid,
      size: replacementSize,
    },
  ];
}

function createInitialRecord(operation, target, original, fs, options = {}) {
  let marker;
  try {
    assertOperationDirectory(operation, fs);
    if (fs.readdirSync(operation.path).length !== 0) throw failure("operation-directory");
    marker = createOwnedFile(operation, INITIAL_RECORD_NAME, TEMP_SAFE_MODE, fs);
    const record = initialRecordFor(operation, target, original, options.entryPlan);
    if (!validInitialRecord(record)) throw failure("initial-record");
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    fs.fchmodSync(marker.fd, TEMP_SAFE_MODE);
    crashAt(options, "before-initial-record-write");
    writeAll(fs, marker.fd, bytes);
    crashAt(options, "before-initial-record-fsync");
    fs.fsyncSync(marker.fd);
    crashAt(options, "after-initial-record-fsync");
    const finalized = fs.fstatSync(marker.fd);
    validateRegular(finalized, "initial-record");
    validateCurrentUser(finalized, "initial-record");
    if (!sameCreatedFile(marker.identity, finalized) || finalized.size !== bytes.length) {
      throw failure("initial-record");
    }
    marker.identity = finalized;
    marker.nlink = linkCount(finalized);
    marker.digest = contentHash(bytes);
    closeTracked(fs, marker.fd);
    marker.fd = undefined;
    fsyncDirectory(operation, fs);
    marker.record = record;
    crashAt(options, "after-initial-record-directory-fsync");
    return marker;
  } catch (caught) {
    closeTracked(fs, marker?.fd);
    if (marker?.created && marker.identity !== undefined) {
      const cleanupError = cleanupEntry(marker, operation, fs, { directCleanup: true });
      if (cleanupError !== undefined) throw cleanupError;
    }
    throw normalizeFailure(caught, "initial-record");
  }
}

function readInitialRecord(operation, target, fs) {
  const entry = {
    path: childPath(operation, INITIAL_RECORD_NAME),
    displayPath: displayChildPath(operation, INITIAL_RECORD_NAME),
    name: INITIAL_RECORD_NAME,
    directory: operation,
    created: true,
  };
  let read;
  try {
    read = readRegularFile(entry.path, fs, false, "recovery");
    const text = read.bytes.toString("utf8");
    if (!text.endsWith("\n")) throw failure("recovery", entry.displayPath);
    const record = JSON.parse(text.slice(0, -1));
    if (
      record?.version !== INITIAL_RECORD_VERSION ||
      record.targetPath !== target.displayPath ||
      record.operationDirectory !== operation.name ||
      !sameDirectoryIdentityRecord(operation.identity, record.operationIdentity) ||
      !sameDirectoryIdentityRecord(operation.parent.identity, record.parentIdentity) ||
      !validInitialRecord(record) ||
      record.target?.name !== target.name || record.target.nlink !== 1 ||
      !validIdentityRecord(record.target.identity) ||
      !HASH_RE.test(record.target.digest ?? "") ||
      (read.identity.mode & 0o7777) !== TEMP_SAFE_MODE ||
      read.nlink !== 1
    ) throw failure("recovery", entry.displayPath);
    entry.identity = read.identity;
    entry.digest = read.contentHash;
    entry.nlink = read.nlink;
    entry.record = record;
    return entry;
  } catch (caught) {
    throw normalizeFailure(caught, "recovery");
  }
}

function scanManifestRecords(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_TOMBSTONE_BYTES) {
    return { records: [], validOffset: 0, complete: false };
  }
  const records = [];
  let offset = 0;
  let validOffset = 0;
  let previousDigest = EMPTY_DIGEST;
  while (offset < bytes.length && records.length < MAX_MANIFEST_RECORDS) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline === -1) break;
    const lineBytes = bytes.subarray(offset, newline);
    if (lineBytes.length === 0) break;
    const line = lineBytes.toString("utf8");
    let record;
    try { record = JSON.parse(line); } catch { break; }
    if (!validManifestRecord(record) || canonicalManifest(record) !== `${line}\n` ||
        record.sequence !== records.length || record.previousDigest !== previousDigest) break;
    records.push(record);
    validOffset = newline + 1;
    previousDigest = contentHash(bytes.subarray(offset, validOffset));
    offset = validOffset;
  }
  return { records, validOffset, complete: validOffset === bytes.length && records.length > 0 };
}

function manifestRecords(bytes) {
  const scan = scanManifestRecords(bytes);
  if (!scan.complete) throw failure("recovery");
  return scan.records;
}

function strictManifestRecords(bytes, code = "temporary-cleanup") {
  const scan = scanManifestRecords(bytes);
  if (!scan.complete) throw failure(code);
  return scan.records;
}

function repairManifestSuffix(operation, manifestEntry, fs, code = "recovery") {
  let read;
  try {
    read = readRegularFile(manifestEntry.path, fs, false, code);
    let scan = scanManifestRecords(read.bytes);
    if (scan.records.length === 0) throw failure(code, manifestEntry.displayPath);
    if (!scan.complete) {
      let fd;
      let error;
      try {
        fd = fs.openSync(manifestEntry.path, LOCK_WRITE_FLAGS);
        const opened = fs.fstatSync(fd);
        validateRegular(opened, code);
        validateCurrentUser(opened, code);
        if (!sameCreatedFile(opened, read.identity)) throw failure(code, manifestEntry.displayPath);
        fs.ftruncateSync(fd, scan.validOffset);
        fs.fsyncSync(fd);
      } catch (caught) {
        error = normalizeFailure(caught, code);
      }
      const closeError = closeTracked(fs, fd, `${code}-close`);
      if (error === undefined && closeError !== undefined) error = closeError;
      if (error !== undefined) throw error;
      fsyncDirectory(operation, fs, { code });
      read = readRegularFile(manifestEntry.path, fs, false, code);
      scan = scanManifestRecords(read.bytes);
      if (!scan.complete) throw failure(code, manifestEntry.displayPath);
    }
    return { read, records: scan.records };
  } catch (caught) {
    throw normalizeFailure(caught, code);
  }
}

function cleanupRecordFor(entry, observed, placeholder, phase, manifest, sourceOverride, sensitiveOverride) {
  const source = sourceOverride ?? observed;
  const sharedWithBackup = entry.name === "candidate" &&
    sameIdentityRecord(source.identity, manifest?.backup?.identity) &&
    source.digest === manifest?.backup?.digest;
  const backupStillLinksTarget = entry.name === "backup" &&
    ["candidate-created", "candidate-metadata", "prepared"].includes(manifest?.phase);
  return {
    entry: entry.name,
    phase,
    sensitive: sensitiveOverride ?? (entry.name !== "manifest" && !sharedWithBackup && !backupStillLinksTarget),
    source: {
      name: entry.name,
      identity: identityRecord(source.identity),
      nlink: source.nlink,
      digest: source.digest,
    },
    placeholder: {
      name: placeholder.name,
      identity: placeholder.identity === undefined ? null : identityRecord(placeholder.identity),
      digest: placeholder.digest ?? EMPTY_DIGEST,
      created: placeholder.identity !== undefined,
    },
    tombstone: manifest?.cleanup?.find((item) => item.entry === entry.name)?.tombstone ?? null,
  };
}

function replaceCleanupRecord(manifest, record) {
  const cleanup = Array.isArray(manifest.cleanup) ? manifest.cleanup : [];
  return {
    ...manifest,
    cleanup: [...cleanup.filter((item) => item.entry !== record.entry), record],
  };
}

function appendManifestRecord(operation, manifestEntry, manifest, nextManifest, fs, options = {}) {
  const repaired = repairManifestSuffix(operation, manifestEntry, fs, "manifest");
  const records = repaired.records;
  if (JSON.stringify(records[records.length - 1]) !== JSON.stringify(manifest)) {
    throw failure("manifest", manifestEntry.displayPath);
  }
  manifestEntry.identity = repaired.read.identity;
  manifestEntry.digest = repaired.read.contentHash;
  const chainedManifest = {
    ...nextManifest,
    sequence: manifest.sequence + 1,
    previousDigest: contentHash(Buffer.from(canonicalManifest(manifest), "utf8")),
  };
  const bytes = Buffer.from(canonicalManifest(chainedManifest), "utf8");
  let fd = manifestEntry.fd;
  let opened = false;
  let error;
  try {
    if (fd === undefined) {
      verifyBoundPath(manifestEntry, manifestEntry.identity, manifestEntry.digest, fs);
      fd = fs.openSync(manifestEntry.path, APPEND_FLAGS);
      opened = true;
    }
    const before = fs.fstatSync(fd);
    validateRegular(before, "manifest");
    validateCurrentUser(before, "manifest");
    if (!sameCreatedFile(before, manifestEntry.identity)) throw failure("manifest");
    writeAll(fs, fd, bytes);
    if (options.cleanupManifestCrash === true) crashAt(options, "before-cleanup-manifest-fsync");
    fs.fsyncSync(fd);
    if (options.cleanupManifestCrash === true) crashAt(options, "after-cleanup-manifest-fsync");
    const after = fs.fstatSync(fd);
    validateRegular(after, "manifest");
    validateCurrentUser(after, "manifest");
    if (!sameCreatedFile(before, after)) throw failure("manifest");
    const read = readRegularFile(manifestEntry.path, fs, false, "manifest");
    if (!sameCreatedFile(read.identity, after)) throw failure("manifest");
    manifestEntry.identity = read.identity;
    manifestEntry.digest = read.contentHash;
    manifestEntry.manifest = chainedManifest;
    return chainedManifest;
  } catch (caught) {
    error = normalizeFailure(caught, "manifest");
  } finally {
    if (opened) {
      const closeError = closeTracked(fs, fd, "manifest-close");
      if (error === undefined && closeError !== undefined) error = closeError;
    }
  }
  throw error ?? failure("manifest");
}

function recordCleanupPhase(operation, manifestEntry, manifest, record, fs, options = {}) {
  const nextRecord = { ...record };
  const nextManifest = replaceCleanupRecord(manifest, nextRecord);
  return appendManifestRecord(operation, manifestEntry, manifest, nextManifest, fs, { ...options, cleanupManifestCrash: true });
}

function recordTombstonePhase(operation, manifestEntry, manifest, record, source, quarantine, phase, sensitive, fs, options = {}) {
  const tombstone = {
    phase,
    source: {
      name: source.name,
      identity: identityRecord(source.identity),
      nlink: source.nlink,
      digest: source.digest,
    },
    quarantine: {
      name: quarantine.name,
      identity: quarantine.identity === undefined || quarantine.identity === null
        ? null
        : identityRecord(quarantine.identity),
      digest: EMPTY_DIGEST,
    },
    sensitive,
  };
  return recordCleanupPhase(
    operation,
    manifestEntry,
    manifest,
    { ...record, tombstone },
    fs,
    options,
  );
}

function recordOperationPhase(operation, manifestEntry, manifest, phase, fs, options = {}) {
  return appendManifestRecord(
    operation,
    manifestEntry,
    manifest,
    { ...manifest, phase },
    fs,
    options,
  );
}

function recordCandidatePhase(operation, manifestEntry, manifest, phase, candidate, fs, options = {}) {
  return appendManifestRecord(
    operation,
    manifestEntry,
    manifest,
    { ...manifest, phase, candidate: candidateDescriptor(candidate) },
    fs,
    options,
  );
}

function evidenceRecordFor(entry, observed, placeholder, phase) {
  return {
    entry: entry.name,
    phase,
    foreign: {
      identity: identityRecord(observed.identity),
      nlink: observed.nlink,
      digest: observed.digest,
    },
    placeholder: {
      name: placeholder.name,
      identity: placeholder.identity === undefined ? null : identityRecord(placeholder.identity),
      digest: placeholder.digest ?? EMPTY_DIGEST,
    },
  };
}

function recordEvidencePhase(operation, manifestEntry, manifest, record, fs, options = {}) {
  const evidence = Array.isArray(manifest.evidence) ? manifest.evidence : [];
  const nextManifest = {
    ...manifest,
    evidence: [...evidence.filter((item) => item.placeholder.name !== record.placeholder.name), record],
  };
  return appendManifestRecord(operation, manifestEntry, manifest, nextManifest, fs, { ...options, cleanupManifestCrash: true });
}

function isKnownEvidencePlaceholder(observed, manifest) {
  return observed.present && (manifest?.evidence ?? []).some((record) =>
    record.placeholder.identity !== null &&
    sameIdentityRecord(observed.identity, record.placeholder.identity) &&
    observed.digest === record.placeholder.digest);
}

function createManifest(operation, target, original, candidate, backup, replacementHash, fs, options = {}, initialEntry) {
  const initial = candidate === undefined || backup === undefined;
  const manifest = {
    version: MANIFEST_VERSION,
    sequence: 0,
    previousDigest: EMPTY_DIGEST,
    phase: initial ? "initial" : "prepared",
    targetPath: target.displayPath,
    operationDirectory: operation.name,
    operationIdentity: directoryIdentityRecord(operation.identity),
    parentIdentity: directoryIdentityRecord(operation.parent.identity),
    initial: initialEntry === undefined
      ? null
      : {
        name: INITIAL_RECORD_NAME,
        identity: identityRecord(initialEntry.identity),
        nlink: initialEntry.nlink,
        digest: initialEntry.digest,
      },
    exchange: { source: "candidate", target: target.name },
    candidate: candidate === undefined ? null : candidateDescriptor(candidate, replacementHash),
    backup: backup === undefined
      ? null
      : { name: "backup", identity: identityRecord(backup.identity), nlink: linkCount(backup.identity), digest: original.contentHash },
    original: { identity: identityRecord(original.identity), nlink: linkCount(original.identity), digest: original.contentHash },
    cleanup: [],
    evidence: [],
  };
  const manifestPath = childPath(operation, "manifest");
  const existingStage = inspectOptionalPath(childPath(operation, ".manifest-stage"), fs);
  let stage;
  if (existingStage.present) {
    if (existingStage.read.bytes.length !== 0) {
      let stagedRecords;
      try { stagedRecords = manifestRecords(existingStage.read.bytes); } catch { throw failure("manifest"); }
      const staged = stagedRecords.at(-1);
      if (JSON.stringify(staged) !== JSON.stringify(manifest) ||
          staged.phase !== "initial" || staged.cleanup.length !== 0 || staged.evidence.length !== 0) {
        throw failure("manifest");
      }
    } else {
      validateEmptyTombstone(existingStage);
    }
    stage = {
      path: childPath(operation, ".manifest-stage"),
      displayPath: displayChildPath(operation, ".manifest-stage"),
      name: ".manifest-stage",
      directory: operation,
      created: true,
      identity: existingStage.identity,
      nlink: existingStage.nlink,
      fd: fs.openSync(childPath(operation, ".manifest-stage"), LOCK_WRITE_FLAGS),
    };
  } else {
    stage = createOwnedFile(operation, ".manifest-stage", TEMP_SAFE_MODE, fs);
  }
  const bytes = Buffer.from(canonicalManifest(manifest), "utf8");
  let published;
  let error;
  try {
    fs.fchmodSync(stage.fd, TEMP_SAFE_MODE);
    if (existingStage.present && existingStage.read.bytes.length !== 0) {
      fs.ftruncateSync(stage.fd, 0);
      fs.fsyncSync(stage.fd);
    }
    crashAt(options, "before-manifest-write");
    writeAll(fs, stage.fd, bytes);
    crashAt(options, "after-manifest-write");
    crashAt(options, "before-manifest-fsync");
    fs.fsyncSync(stage.fd);
    crashAt(options, "after-manifest-fsync");
    const finalized = fs.fstatSync(stage.fd);
    validateRegular(finalized, "manifest");
    validateCurrentUser(finalized, "manifest");
    if (!sameCreatedFile(stage.identity, finalized) || finalized.size !== bytes.length) throw failure("manifest");
    stage.identity = finalized;
    stage.digest = contentHash(bytes);
    verifyBoundPath(stage, stage.identity, stage.digest, fs, { fd: stage.fd });
    fsyncDirectory(operation, fs);
    crashAt(options, "before-manifest-publication");
    publishFile(operation, stage.name, "manifest", fs, options, "manifest-publication", stage);
    closeTracked(fs, stage.fd);
    stage.fd = undefined;
    published = {
      ...stage,
      path: manifestPath,
      displayPath: displayChildPath(operation, "manifest"),
      name: "manifest",
      fd: undefined,
    };
    const read = readRegularFile(manifestPath, fs, false, "manifest");
    if (!sameCreatedFile(read.identity, stage.identity) || read.contentHash !== stage.digest ||
        !read.bytes.equals(bytes)) throw failure("manifest");
    published.identity = read.identity;
    published.digest = read.contentHash;
    published.manifest = manifest;
    fsyncDirectory(operation, fs);
    crashAt(options, "after-manifest-publication");
    return published;
  } catch (caught) {
    error = normalizeFailure(caught, "manifest");
  }
  closeTracked(fs, stage.fd);
  if (error !== undefined) throw error;
  throw failure("manifest", manifestPath);
}

function createPublishedMarker(operation, fs, options = {}) {
  const marker = createOwnedFile(operation, PUBLISHED_MARKER_NAME, TEMP_SAFE_MODE, fs);
  try {
    fs.fsyncSync(marker.fd);
    marker.digest = contentHash(Buffer.alloc(0));
    closeTracked(fs, marker.fd);
    marker.fd = undefined;
    fsyncDirectory(operation, fs);
    return marker;
  } catch (caught) {
    closeTracked(fs, marker.fd);
    const cleanupError = cleanupEntry(marker, operation, fs, {
      ...options,
      directCleanup: true,
      manifestEntry: options.manifestEntry,
    });
    if (cleanupError !== undefined) throw cleanupError;
    throw normalizeFailure(caught, "publication-marker");
  }
}

function inspectOptionalPath(entryOrPath, fs) {
  const entry = typeof entryOrPath === "string" ? { path: entryOrPath } : entryOrPath;
  try {
    const listed = fs.lstatSync(entry.path);
    validateRegular(listed, "recovery");
    validateCurrentUser(listed, "recovery");
    const read = readRegularFile(entry.path, fs);
    if (!sameIdentity(listed, read.identity)) throw failure("recovery", entry.displayPath ?? entry.path);
    return { present: true, identity: read.identity, nlink: linkCount(read.identity), digest: read.contentHash, read };
  } catch (caught) {
    if (caught?.code === "ENOENT") return { present: false };
    throw normalizeFailure(caught, "recovery");
  }
}

function readManifest(operation, fs, expectedFilePath) {
  const manifestPath = childPath(operation, "manifest");
  const manifestEntry = {
    path: manifestPath,
    displayPath: displayChildPath(operation, "manifest"),
    name: "manifest",
    directory: operation,
    created: true,
  };
  let parsed;
  try {
    const repaired = repairManifestSuffix(operation, manifestEntry, fs, "recovery");
    const read = repaired.read;
    manifestEntry.identity = read.identity;
    manifestEntry.digest = read.contentHash;
    const records = repaired.records;
    parsed = records[records.length - 1];
  } catch (caught) {
    throw normalizeFailure(caught, "recovery");
  }
  const candidatePreparationPhase = CANDIDATE_PREPARATION_PHASES.has(parsed?.phase);
  const completePhase = ["prepared", "published-exchange", "published"].includes(parsed?.phase);
  const initialPhase = parsed?.phase === "initial";
  const initialBindingValid = parsed?.initial === null || (
    parsed?.initial?.name === INITIAL_RECORD_NAME &&
    validIdentityRecord(parsed.initial.identity) &&
    parsed.initial.nlink === 1 &&
    HASH_RE.test(parsed.initial.digest ?? "")
  );
  if (
    parsed?.version !== MANIFEST_VERSION ||
    (!completePhase && !candidatePreparationPhase && !initialPhase) ||
    parsed.targetPath !== expectedFilePath ||
    parsed.operationDirectory !== operation.name || parsed.exchange?.source !== "candidate" ||
    parsed.exchange?.target !== operation.parent.name ||
    !sameDirectoryIdentityRecord(operation.identity, parsed.operationIdentity) ||
    !sameDirectoryIdentityRecord(operation.parent.identity, parsed.parentIdentity) ||
    !initialBindingValid ||
    (initialPhase && parsed.initial === null) ||
    !HASH_RE.test(parsed.original?.digest ?? "") || !validIdentityRecord(parsed.original?.identity) ||
    parsed.original?.nlink !== 1 ||
    (candidatePreparationPhase && (!validCandidateDescriptor(parsed.candidate, false) ||
      parsed.candidate.digest !== EMPTY_DIGEST || parsed.candidate.identity.size !== 0 || parsed.candidate.nlink !== 1)) ||
    (completePhase && (!HASH_RE.test(parsed.candidate?.digest ?? "") ||
      !HASH_RE.test(parsed.backup?.digest ?? "") || parsed.candidate?.name !== "candidate" ||
      parsed.backup?.name !== "backup" || !validIdentityRecord(parsed.candidate?.identity) ||
      !validIdentityRecord(parsed.backup?.identity) ||
      !Number.isSafeInteger(parsed.candidate?.nlink) || parsed.candidate.nlink < 1 ||
      !Number.isSafeInteger(parsed.backup?.nlink) || parsed.backup.nlink < 1)) ||
    (initialPhase && (parsed.candidate !== null || parsed.evidence?.length !== 0)) ||
    (parsed.cleanup !== undefined && (!Array.isArray(parsed.cleanup) || parsed.cleanup.some((record) => !validCleanupRecord(record))))
    || (parsed.evidence !== undefined && (!Array.isArray(parsed.evidence) || parsed.evidence.some((record) => !validEvidenceRecord(record))))
  ) throw failure("recovery", operation.displayPath);
  if (completePhase && (parsed.original.digest !== parsed.backup.digest || parsed.original.digest === parsed.candidate.digest)) {
    throw failure("recovery", operation.displayPath);
  }
  return {
    manifest: {
      ...parsed,
      cleanup: Array.isArray(parsed.cleanup) ? parsed.cleanup : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    },
    manifestEntry,
  };
}

function verifyBoundPath(entry, expectedIdentity, expectedDigest, fs, options = {}) {
  if (options.fd !== undefined) {
    try {
      const state = fs.fstatSync(options.fd);
      validateRegular(state);
      validateCurrentUser(state);
      if (!sameIdentity(state, expectedIdentity)) throw failure("file-changed");
    } catch (caught) {
      throw normalizeFailure(caught, "file-changed");
    }
  }
  const read = readRegularFile(entry.path, fs);
  if (!sameIdentity(read.identity, expectedIdentity) || read.contentHash !== expectedDigest) {
    throw failure("file-changed", entry.displayPath ?? entry.path);
  }
  if (options.fd !== undefined) {
    const state = fs.fstatSync(options.fd);
    validateRegular(state);
    validateCurrentUser(state);
    if (!sameIdentity(state, expectedIdentity)) throw failure("file-changed");
  }
  return read;
}

function assertTargetUnchanged(target, original, fs) {
  try {
    const listed = fs.lstatSync(target.path);
    validateRegular(listed);
    validateCurrentUser(listed);
    if (!sameStableState(original.state, listed)) throw failure("file-changed");
    const descriptor = fs.fstatSync(original.fd);
    validateRegular(descriptor);
    validateCurrentUser(descriptor);
    if (!sameStableState(original.state, descriptor)) throw failure("file-changed");
    const current = readRegularFile(target.path, fs);
    if (!sameStableState(original.state, current.state) || current.contentHash !== original.contentHash) {
      throw failure("file-changed");
    }
    const finalDescriptor = fs.fstatSync(original.fd);
    const finalListed = fs.lstatSync(target.path);
    validateRegular(finalDescriptor);
    validateRegular(finalListed);
    validateCurrentUser(finalDescriptor);
    validateCurrentUser(finalListed);
    if (!sameStableState(original.state, finalDescriptor) || !sameStableState(original.state, finalListed)) {
      throw failure("file-changed");
    }
  } catch (caught) {
    throw normalizeFailure(caught, "file-changed");
  }
}

function verifyFinalPublishedTarget(target, expectedIdentity, expectedDigest, key, fs, secretNeedles = []) {
  const current = readRegularFile(target.path, fs, false, "file-changed");
  if (!sameIdentityRecord(current.identity, identityRecord(expectedIdentity)) ||
      current.contentHash !== expectedDigest) throw failure("file-changed", target.displayPath);
  if (!candidateBytesSafe(current.bytes, key, secretNeedles)) throw failure("assignment-present", target.displayPath);
  const listed = fs.lstatSync(target.path);
  validateRegular(listed, "file-changed");
  validateCurrentUser(listed);
  if (!sameIdentityRecord(listed, identityRecord(expectedIdentity))) throw failure("file-changed", target.displayPath);
}

function successCheckpoint(options, event) {
  if (typeof options.beforeSuccess !== "function") return;
  try {
    options.beforeSuccess(event);
  } catch (caught) {
    throw normalizeFailure(caught, "file-changed");
  }
}

function createBackup(target, original, operation, fs, options = {}) {
  const backup = {
    path: childPath(operation, "backup"),
    displayPath: displayChildPath(operation, "backup"),
    name: "backup",
    directory: operation,
    created: false,
  };
  try {
    fs.linkSync(target.path, backup.path);
    backup.created = true;
    backup.fd = fs.openSync(backup.path, READ_ONLY_FLAGS);
    const source = fs.fstatSync(original.fd);
    const linked = fs.fstatSync(backup.fd);
    validateRegular(source);
    validateRegular(linked);
    if (!sameIdentity(source, linked)) throw failure("file-changed");
    backup.identity = linked;
    backup.nlink = linkCount(linked);
    const bytes = fs.readFileSync(backup.fd);
    const after = fs.fstatSync(backup.fd);
    validateRegular(after);
    if (!sameStableState(linked, after)) throw failure("file-changed");
    backup.digest = contentHash(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    if (backup.digest !== original.contentHash) throw failure("file-changed");
    fsyncDirectory(operation, fs);
    crashAt(options, "after-backup-created");
    crashAt(options, "after-backup-fsync");
    return backup;
  } catch (caught) {
    closeTracked(fs, backup.fd);
    if (backup.created) {
      const cleanupError = cleanupEntry(backup, operation, fs, {
        ...options,
        directCleanup: true,
        manifestEntry: options.manifestEntry,
      });
      if (cleanupError !== undefined) throw cleanupError;
    }
    throw normalizeFailure(caught, "file-changed");
  }
}

function prepareCandidate(operation, candidate, original, replacement, fs, proof = {}, manifestEntry, options = {}) {
  try {
    // The descriptor was opened while it had a writable private mode.  Set
    // owner and the exact original mode before the first content write; this
    // also preserves read-only, setuid, and setgid modes on the new inode.
    fs.fchownSync(candidate.fd, original.uid, original.gid);
    crashAt(options, "after-candidate-chown");
    crashAt(options, "after-candidate-fchown");
    fs.fchmodSync(candidate.fd, original.mode);
    crashAt(options, "after-candidate-chmod");
    crashAt(options, "after-candidate-fchmod");
    const beforeWrite = fs.fstatSync(candidate.fd);
    validateRegular(beforeWrite, "temporary-finalize");
    if (beforeWrite.uid !== original.uid || beforeWrite.gid !== original.gid ||
        (beforeWrite.mode & 0o7777) !== original.mode) throw failure("temporary-finalize");
    candidate.identity = beforeWrite;
    manifestEntry.manifest = recordCandidatePhase(
      operation,
      manifestEntry,
      manifestEntry.manifest,
      "candidate-metadata",
      candidate,
      fs,
      options,
    );
    crashAt(options, "after-candidate-metadata");
    let writeCount = 0;
    writeAll(fs, candidate.fd, replacement, () => {
      writeCount += 1;
      crashAt(options, `after-candidate-write-${writeCount}`);
      crashAt(options, `after-candidate-partial-write-${writeCount}`);
      crashAt(options, "after-candidate-write");
    });
    fs.fsyncSync(candidate.fd);
    // A content write can clear setuid/setgid on Linux.  Restore the exact
    // mode after the write as well; the pre-write fchmod above is still
    // required so no content ever enters an incorrectly-permissioned inode.
    fs.fchmodSync(candidate.fd, original.mode);
    fs.fsyncSync(candidate.fd);
    crashAt(options, "after-candidate-fsync");
    const prepared = fs.fstatSync(candidate.fd);
    validateRegular(prepared, "temporary-finalize");
    validateCurrentUser(prepared, "temporary-finalize");
    if (!sameCreatedFile(candidate.identity, prepared) ||
        (prepared.mode & 0o7777) !== original.mode || prepared.uid !== original.uid ||
        prepared.gid !== original.gid || prepared.size !== replacement.length) throw failure("temporary-finalize");
    if (!candidateBytesSafe(replacement, proof.key, proof.secretNeedles)) throw failure("temporary-finalize");
    candidate.identity = prepared;
    candidate.digest = contentHash(replacement);
    return candidate;
  } catch (caught) {
    closeTracked(fs, candidate.fd);
    throw normalizeFailure(caught, "temporary-finalize");
  }
}

function assertManifestStable(manifestEntry, manifest, fs) {
  const read = verifyBoundPath(manifestEntry, manifestEntry.identity, manifestEntry.digest, fs);
  const records = manifestRecords(read.bytes);
  if (JSON.stringify(records[records.length - 1]) !== JSON.stringify(manifest)) {
    throw failure("recovery", manifestEntry.displayPath);
  }
}

function crashAt(options, point) {
  if (options.crashAt === point) process.kill(process.pid, "SIGKILL");
}

function verifyHelperBinary() {
  try {
    const resolved = realpathSync(EXCHANGE_HELPER);
    if (!EXCHANGE_HELPER_REALPATH_RE.test(resolved)) throw failure("exchange-helper");
    const stat = statSync(EXCHANGE_HELPER);
    validateRegular(stat, "exchange-helper");
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) {
      throw failure("exchange-helper");
    }
  } catch (caught) {
    throw normalizeFailure(caught, "exchange-helper");
  }
}

function spawnProcessTreeSync(command, options = {}) {
  if (!Array.isArray(command) || command.length === 0 ||
      (options.fd !== undefined && !Number.isSafeInteger(options.fd)) ||
      (options.inheritedFds !== undefined && (!Array.isArray(options.inheritedFds) ||
        options.inheritedFds.some((pair) => !Array.isArray(pair) || pair.length !== 2 ||
          !Number.isSafeInteger(pair[0]) || !Number.isSafeInteger(pair[1]))))) {
    throw failure("process-tree");
  }
  const timeoutMs = options.timeoutMs ?? PROCESS_TREE_TIMEOUT_MS;
  const graceMs = options.graceMs ?? PROCESS_TREE_GRACE_MS;
  const descriptors = new Map();
  if (options.fd !== undefined) descriptors.set(3, options.fd);
  for (const [target, source] of options.inheritedFds ?? []) descriptors.set(target, source);
  const helperEnv = {
    ...(options.env ?? Object.create(null)),
    [PROCESS_TREE_FDS_ENV]: [...descriptors.keys()].sort((left, right) => left - right).join(","),
  };
  const maxDescriptor = Math.max(2, ...descriptors.keys());
  const stdio = Array.from({ length: maxDescriptor + 1 }, () => "ignore");
  stdio[0] = "pipe";
  stdio[1] = "pipe";
  stdio[2] = "pipe";
  for (const [target, source] of descriptors) stdio[target] = source;
  let child;
  try {
    child = spawnSync(
      EXCHANGE_HELPER,
      ["-c", PROCESS_TREE_HELPER_CODE, String(timeoutMs), String(graceMs), ...command],
      {
        cwd: "/",
        env: helperEnv,
        encoding: options.encoding ?? "utf8",
        maxBuffer: options.maxBuffer ?? 1024,
        timeout: timeoutMs + graceMs + 1000,
        killSignal: "SIGKILL",
        input: options.input ?? "",
        stdio,
      },
    );
  } catch {
    throw failure("process-tree");
  }
  return child;
}

function exchangeDirectories(sourceDirectory, sourceName, targetDirectory, targetName, fs, options, kind) {
  validateName(sourceName);
  validateName(targetName);
  revalidateDirectory(sourceDirectory, fs, "exchange");
  revalidateDirectory(targetDirectory, fs, "exchange");
  if (typeof options.beforeExchange === "function") {
    try {
      options.beforeExchange({
        kind,
        sourcePath: displayChildPath(sourceDirectory, sourceName),
        targetPath: displayChildPath(targetDirectory, targetName),
      });
    } catch (caught) {
      throw normalizeFailure(caught, "exchange");
    }
    revalidateDirectory(sourceDirectory, fs, "exchange");
    revalidateDirectory(targetDirectory, fs, "exchange");
  }
  if (typeof options.exchangeFn === "function") {
    try {
      options.exchangeFn({ sourceDirectory, sourceName, targetDirectory, targetName, kind });
    } catch (caught) {
      throw normalizeFailure(caught, "exchange");
    }
  } else {
    verifyHelperBinary();
    let child;
    try {
      child = spawnSync(
        EXCHANGE_HELPER,
        ["-c", EXCHANGE_HELPER_CODE, sourceName, targetName],
        {
          cwd: "/",
          env: options.crashAt === "after-cleanup-helper" && kind === "cleanup"
            ? { REMOVE_ENV_ENTRY_HELPER_CRASH: "after-cleanup-exchange" }
            : Object.create(null),
          encoding: "buffer",
          maxBuffer: 1024,
          timeout: EXCHANGE_TIMEOUT_MS,
          killSignal: "SIGKILL",
          stdio: ["ignore", "ignore", "ignore", sourceDirectory.fd, targetDirectory.fd],
        },
      );
    } catch {
      throw failure("exchange");
    }
    if (child?.error !== undefined || child?.status !== 0 || child?.signal !== null ||
        child?.stdout !== null || child?.stderr !== null) throw failure("exchange");
  }
  revalidateDirectory(sourceDirectory, fs, "exchange");
  revalidateDirectory(targetDirectory, fs, "exchange");
}

function publishFile(directory, sourceName, targetName, fs, options = {}, kind = "manifest-publication", expectedEntry) {
  validateName(sourceName);
  validateName(targetName);
  revalidateDirectory(directory, fs, "manifest");
  if (typeof options.beforeExchange === "function") {
    try {
      options.beforeExchange({
        kind,
        sourcePath: displayChildPath(directory, sourceName),
        targetPath: displayChildPath(directory, targetName),
      });
    } catch (caught) {
      throw normalizeFailure(caught, "manifest");
    }
    revalidateDirectory(directory, fs, "manifest");
  }
  if (expectedEntry !== undefined) {
    verifyBoundPath(expectedEntry, expectedEntry.identity, expectedEntry.digest, fs, { fd: expectedEntry.fd });
  }
  verifyHelperBinary();
  let child;
  try {
    child = spawnSync(
      EXCHANGE_HELPER,
      ["-c", EXCHANGE_HELPER_CODE, "publish", sourceName, targetName],
      {
        cwd: "/",
        env: Object.create(null),
        encoding: "buffer",
        maxBuffer: 1024,
        timeout: EXCHANGE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        stdio: ["ignore", "ignore", "ignore", directory.fd, directory.fd],
      },
    );
  } catch {
    throw failure("manifest");
  }
  if (child?.error !== undefined || child?.status !== 0 || child?.signal !== null ||
      child?.stdout !== null || child?.stderr !== null) throw failure("manifest");
  revalidateDirectory(directory, fs, "manifest");
}

function removeWithHelper(directory, name, expectedIdentity, expectedDigest, expectedNlink, sensitive, fs, options = {}, recoveryPath) {
  validateName(name);
  if (!Number.isSafeInteger(expectedNlink) || expectedNlink < 1 || (sensitive && expectedNlink !== 1)) {
    throw failure("temporary-cleanup", recoveryPath);
  }
  if (options.placeholder === undefined || options.placeholder.identity === undefined ||
      options.placeholder.name === undefined || options.placeholder.directory !== directory) {
    throw failure("temporary-cleanup", recoveryPath);
  }
  const placeholder = options.placeholder;
  const quarantineName = placeholder.name;
  if (typeof options.beforeHelperUnlink === "function") {
    try {
      options.beforeHelperUnlink({
        name,
        sensitive,
        path: displayChildPath(directory, name),
        quarantinePath: displayChildPath(directory, quarantineName),
      });
    } catch (caught) {
      throw normalizeFailure(caught, "temporary-cleanup");
    }
    revalidateDirectory(directory, fs, "temporary-cleanup");
  }
  verifyHelperBinary();
  const record = identityRecord(expectedIdentity);
  let child;
  try {
    child = spawnSync(
      EXCHANGE_HELPER,
      [
        "-c",
        EXCHANGE_HELPER_CODE,
        "unlink",
        name,
        quarantineName,
        String(record.dev),
        String(record.ino),
        String(record.mode),
        String(record.uid),
        String(record.gid),
        String(record.size),
        String(expectedNlink),
        expectedDigest,
        sensitive ? "1" : "0",
        String(placeholder.identity.dev),
        String(placeholder.identity.ino),
        String(placeholder.identity.mode & 0o7777),
        String(placeholder.identity.uid),
        String(placeholder.identity.gid),
        String(placeholder.identity.size),
      ],
      {
        cwd: "/",
        env: [
          ["after-tombstone-helper", "after-cleanup-exchange"],
          ["after-cleanup-exchange", "after-cleanup-exchange"],
          ["after-cleanup-first-unlink", "after-cleanup-first-unlink"],
          ["after-cleanup-second-unlink", "after-cleanup-second-unlink"],
        ].reduce((environment, [point, value]) => options.crashAt === point
          ? { REMOVE_ENV_ENTRY_HELPER_CRASH: value }
          : environment, Object.create(null)),
        encoding: "buffer",
        maxBuffer: 1024,
        timeout: EXCHANGE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        stdio: ["ignore", "ignore", "ignore", directory.fd],
      },
    );
  } catch {
    throw failure("temporary-cleanup", recoveryPath);
  }
  if (child?.error !== undefined || child?.status !== 0 || child?.signal !== null ||
      child?.stdout !== null || child?.stderr !== null) {
    throw failure("temporary-cleanup", recoveryPath);
  }
}

function privateQuarantineName(label) {
  const sequence = quarantineSequence;
  quarantineSequence += 1;
  return `${QUARANTINE_PREFIX}${label}-${sequence.toString(16)}`;
}

function createPrivatePlaceholderNamed(operation, name, fs) {
  try {
    const placeholder = createOwnedFile(operation, name, TEMP_SAFE_MODE, fs);
    placeholder.digest = EMPTY_DIGEST;
    closeTracked(fs, placeholder.fd);
    placeholder.fd = undefined;
    fsyncDirectory(operation, fs);
    return placeholder;
  } catch (caught) {
    throw normalizeFailure(caught, "temporary-create");
  }
}

function tombstoneCrash(options, ...points) {
  for (const point of points) crashAt(options, point);
}

function prepareNewTombstone(
  operation,
  manifestEntry,
  manifest,
  reservedRecord,
  source,
  quarantineName,
  sensitive,
  fs,
  options = {},
  preparedRecord = reservedRecord,
) {
  let current = recordTombstonePhase(
    operation,
    manifestEntry,
    manifest,
    reservedRecord,
    source,
    { name: quarantineName, identity: null },
    "reserved",
    sensitive,
    fs,
    options,
  );
  manifestEntry.manifest = current;
  tombstoneCrash(options, "after-tombstone-reservation", "after-cleanup-tombstone-reservation");
  const placeholder = createPrivatePlaceholderNamed(operation, quarantineName, fs);
  tombstoneCrash(options, "after-tombstone-placeholder", "after-cleanup-tombstone-placeholder");
  current = recordTombstonePhase(
    operation,
    manifestEntry,
    current,
    preparedRecord(placeholder, current),
    source,
    placeholder,
    "prepared",
    sensitive,
    fs,
    options,
  );
  manifestEntry.manifest = current;
  tombstoneCrash(options, "after-tombstone-prepared", "after-cleanup-tombstone-prepared");
  return { current, placeholder };
}

function removeWithManifestTombstone(entry, operation, manifestEntry, manifest, observed, sensitive, fs, options = {}) {
  const quarantineName = privateQuarantineName(`unlink-${entry.name}`);
  const reservedRecord = cleanupRecordFor(
    entry,
    observed,
    { name: quarantineName, identity: undefined, digest: EMPTY_DIGEST },
    "placeholder-reserved",
    manifest,
    observed,
    sensitive,
  );
  let current;
  let placeholder;
  ({ current, placeholder } = prepareNewTombstone(
    operation,
    manifestEntry,
    manifest,
    reservedRecord,
    { ...observed, name: entry.name },
    quarantineName,
    sensitive,
    fs,
    options,
    (created, currentManifest) => cleanupRecordFor(
      entry,
      observed,
      created,
      "prepared",
      currentManifest,
      observed,
      sensitive,
    ),
  ));
  crashAt(options, "before-cleanup-unlink");
  removeWithHelper(
    operation,
    entry.name,
    observed.identity,
    observed.digest,
    observed.nlink,
    sensitive,
    fs,
    { ...options, placeholder },
    entry.displayPath,
  );
  crashAt(options, "after-cleanup-unlink");
  current = recordTombstonePhase(
    operation,
    manifestEntry,
    current,
    cleanupRecordFor(entry, observed, placeholder, "prepared", current, observed, sensitive),
    { ...observed, name: entry.name },
    placeholder,
    "complete",
    sensitive,
    fs,
    options,
  );
  manifestEntry.manifest = current;
  current = recordCleanupPhase(
    operation,
    manifestEntry,
    current,
    cleanupRecordFor(entry, observed, placeholder, "complete", current, observed, sensitive),
    fs,
    options,
  );
  manifestEntry.manifest = current;
  return current;
}

function removeWithRecordedTombstone(operation, manifestEntry, manifest, record, sourceName, source, quarantineName, quarantine, fs, options = {}) {
  const tombstone = record?.tombstone;
  const direct = tombstone !== null && tombstone !== undefined &&
    ["prepared", "exchanged"].includes(tombstone.phase) &&
    tombstone.source.name === sourceName && tombstone.quarantine.name === quarantineName &&
    sameIdentityRecord(source.identity, tombstone.source.identity) &&
    sameLinkCount(source.identity, tombstone.source.nlink) && source.digest === tombstone.source.digest &&
    sameIdentityRecord(quarantine.identity, tombstone.quarantine.identity) &&
    quarantine.digest === tombstone.quarantine.digest;
  const swapped = tombstone !== null && tombstone !== undefined &&
    ["prepared", "exchanged"].includes(tombstone.phase) &&
    tombstone.source.name === quarantineName && tombstone.quarantine.name === sourceName &&
    sameIdentityRecord(source.identity, tombstone.source.identity) &&
    sameLinkCount(source.identity, tombstone.source.nlink) && source.digest === tombstone.source.digest &&
    sameIdentityRecord(quarantine.identity, tombstone.quarantine.identity) &&
    quarantine.digest === tombstone.quarantine.digest;
  if (!direct && !swapped) {
    throw failure("recovery", operation.displayPath);
  }
  removeWithHelper(
    operation,
    sourceName,
    source.identity,
    source.digest,
    source.nlink,
    tombstone.sensitive,
    fs,
    {
      ...options,
      placeholder: {
        ...cleanupJournalPath(operation, quarantineName),
        identity: quarantine.identity,
        digest: quarantine.digest,
      },
      crashAt: undefined,
    },
    displayChildPath(operation, sourceName),
  );
  return record;
}

function removeWithRecoveryTombstone(operation, manifestEntry, manifest, record, sourceEntry, source, sensitive, fs, options = {}) {
  const quarantineName = privateQuarantineName(`recovery-${sourceEntry.name}`);
  let current;
  let placeholder;
  ({ current, placeholder } = prepareNewTombstone(
    operation,
    manifestEntry,
    manifest,
    record,
    { ...source, name: sourceEntry.name },
    quarantineName,
    sensitive,
    fs,
    options,
    () => record,
  ));
  crashAt(options, "before-cleanup-unlink");
  removeWithHelper(
    operation,
    sourceEntry.name,
    source.identity,
    source.digest,
    source.nlink,
    sensitive,
    fs,
    { ...options, placeholder },
    sourceEntry.displayPath,
  );
  crashAt(options, "after-cleanup-unlink");
  const currentRecord = current.cleanup.find((item) => item.entry === record.entry);
  current = recordTombstonePhase(
    operation,
    manifestEntry,
    current,
    currentRecord,
    { ...source, name: sourceEntry.name },
    placeholder,
    "complete",
    sensitive,
    fs,
    options,
  );
  manifestEntry.manifest = current;
  return current;
}

function inspectEntry(entry, fs) {
  return inspectOptionalPath(entry, fs);
}

function cleanupEntry(entry, operation, fs, options = {}) {
  if (!entry?.created) return undefined;
  let observed;
  try {
    observed = inspectEntry(entry, fs);
  } catch (caught) {
    return normalizeFailure(caught, "temporary-cleanup");
  }
  if (!observed.present) return undefined;
  // These are the durable, content-free recovery records.  They are
  // validated when the operation tombstone is sealed; never replace them
  // with an empty file just because cleanup is running.
  if (entry.name === "manifest" || entry.name === INITIAL_RECORD_NAME) return undefined;
  const expectedIdentity = entry.identity === undefined ? undefined : identityRecord(entry.identity);
  const expectedNlink = entry.nlink ?? linkCount(entry.identity);
  const expected = !entry.preserveOnly && expectedIdentity !== undefined &&
    sameIdentityRecord(observed.identity, expectedIdentity) &&
    sameLinkCount(observed.identity, expectedNlink) &&
    (entry.digest === undefined || observed.digest === entry.digest);
  const directCleanup = options.directCleanup === true || options.manifestEntry === undefined ||
    entry.name === "manifest" || options.directCleanupNames?.has(entry.name);
  if (entry.preserveOnly) return failure("temporary-cleanup", entry.displayPath);
  if (directCleanup && !expected) {
    if (expectedIdentity === undefined || !sameCreatedFile(observed.identity, expectedIdentity) ||
        !sameLinkCount(observed.identity, expectedNlink) ||
        (entry.name !== "manifest" && entry.digest !== undefined && observed.digest !== entry.digest)) {
      return failure("temporary-cleanup", entry.displayPath);
    }
  }
  if (!directCleanup && !expected && (expectedIdentity === undefined || !Number.isSafeInteger(expectedNlink) ||
      typeof entry.digest !== "string")) {
    return failure("temporary-cleanup", entry.displayPath);
  }

  // A direct cleanup is allowed to use the manifest cleanup journal only when
  // the manifest is a different, already-published file.  A pre-manifest
  // stage has no durable record which can survive an exchange of the stage
  // itself, so it is deliberately retained for the next recovery pass.
  const manifestEntry = options.manifestEntry;
  if (directCleanup) {
    if (manifestEntry === undefined || manifestEntry.manifest === undefined ||
        manifestEntry.path === entry.path || !["candidate", "backup", PUBLISHED_MARKER_NAME].includes(entry.name)) {
      return failure("temporary-cleanup", entry.displayPath);
    }
    try {
      const sensitiveDirect = entry.name !== "manifest" &&
        !(entry.name === "backup" && (manifestEntry === undefined ||
          ["initial", "candidate-created", "candidate-metadata", "prepared"].includes(manifestEntry.manifest?.phase)));
      removeWithManifestTombstone(
        entry,
        operation,
        manifestEntry,
        manifestEntry.manifest,
        observed,
        sensitiveDirect,
        fs,
        options,
      );
      crashAt(options, "before-cleanup-source-fsync");
      fsyncDirectory(operation, fs);
      crashAt(options, "after-cleanup-source-fsync");
      return undefined;
    } catch (caught) {
      return normalizeFailure(caught, "temporary-cleanup");
    }
  }

  let placeholder;
  let manifest = manifestEntry.manifest;
  try {
    if (manifest === undefined) throw failure("manifest");
    const expectedSource = expected
      ? observed
      : { identity: entry.identity, nlink: expectedNlink, digest: entry.digest };
    if (expectedSource.identity === undefined || typeof expectedSource.digest !== "string") {
      return failure("temporary-cleanup", entry.displayPath);
    }
    const sharedWithBackup = entry.name === "candidate" &&
      sameIdentityRecord(expectedSource.identity, manifest.backup?.identity) &&
      expectedSource.digest === manifest.backup?.digest;
    const backupStillLinksTarget = entry.name === "backup" &&
      ["candidate-created", "candidate-metadata", "prepared"].includes(manifest.phase);
    const sensitive = expected && entry.name !== "manifest" && !sharedWithBackup && !backupStillLinksTarget;
    const placeholderName = privateQuarantineName(entry.name);
    const reserved = cleanupRecordFor(
      entry,
      observed,
      { name: placeholderName, identity: undefined, digest: EMPTY_DIGEST },
      "placeholder-reserved",
      manifest,
      expectedSource,
      sensitive,
    );
    manifest = recordCleanupPhase(operation, manifestEntry, manifest, reserved, fs, options);
    crashAt(options, "after-cleanup-placeholder-reservation");
    crashAt(options, "before-cleanup-placeholder");
    placeholder = createPrivatePlaceholderNamed(operation, placeholderName, fs);
    crashAt(options, "after-cleanup-placeholder");
    const prepared = cleanupRecordFor(entry, observed, placeholder, "prepared", manifest, expectedSource, sensitive);
    manifest = recordCleanupPhase(operation, manifestEntry, manifest, prepared, fs, options);
    crashAt(options, "after-cleanup-manifest-record");

    crashAt(options, "before-cleanup-exchange");
    exchangeDirectories(entry.directory, entry.name, operation, placeholder.name, fs, options, "cleanup");
    manifest = recordCleanupPhase(
      operation,
      manifestEntry,
      manifest,
      cleanupRecordFor(entry, observed, placeholder, "exchanged", manifest, expectedSource, sensitive),
      fs,
      options,
    );
    crashAt(options, "after-cleanup-exchange");
    const sourceNow = inspectEntry(entry, fs);
    const privateNow = inspectEntry(placeholder, fs);
    if (!sourceNow.present || !privateNow.present ||
        !sameIdentityRecord(sourceNow.identity, identityRecord(placeholder.identity)) ||
        sourceNow.digest !== EMPTY_DIGEST ||
        !sameIdentityRecord(privateNow.identity, identityRecord(observed.identity)) ||
        privateNow.digest !== observed.digest) {
      return failure("temporary-cleanup", placeholder.displayPath);
    }
    if (!expected) return failure("temporary-cleanup", placeholder.displayPath);

    crashAt(options, "before-cleanup-source-unlink");
    crashAt(options, "before-cleanup-unlink");
    manifest = recordCleanupPhase(
      operation,
      manifestEntry,
      manifest,
      cleanupRecordFor(entry, observed, placeholder, "source-unlinked", manifest, expectedSource, sensitive),
      fs,
      options,
    );
    crashAt(options, "after-cleanup-source-unlink");
    crashAt(options, "after-cleanup-unlink");
    crashAt(options, "before-cleanup-source-fsync");
    fsyncDirectory(operation, fs);
    manifest = recordCleanupPhase(
      operation,
      manifestEntry,
      manifest,
      cleanupRecordFor(entry, observed, placeholder, "source-fsynced", manifest, expectedSource, sensitive),
      fs,
      options,
    );
    crashAt(options, "after-cleanup-source-fsync");

    const privateAfterSource = inspectEntry(placeholder, fs);
    if (!privateAfterSource.present ||
        !sameIdentityRecord(privateAfterSource.identity, identityRecord(observed.identity)) ||
        privateAfterSource.digest !== observed.digest) {
      return failure("temporary-cleanup", placeholder.displayPath);
    }
    const tombstoneName = privateQuarantineName("unlink");
    const reservedTombstoneRecord = cleanupRecordFor(
      entry,
      observed,
      placeholder,
      "source-fsynced",
      manifest,
      expectedSource,
      sensitive,
    );
    let tombstonePlaceholder;
    ({ current: manifest, placeholder: tombstonePlaceholder } = prepareNewTombstone(
      operation,
      manifestEntry,
      manifest,
      reservedTombstoneRecord,
      { ...privateAfterSource, name: placeholder.name },
      tombstoneName,
      sensitive,
      fs,
      options,
      () => reservedTombstoneRecord,
    ));
    crashAt(options, "before-cleanup-private-unlink");
    removeWithHelper(
      operation,
      placeholder.name,
      privateAfterSource.identity,
      privateAfterSource.digest,
      privateAfterSource.nlink,
      sensitive,
      fs,
      { ...options, placeholder: tombstonePlaceholder },
      placeholder.displayPath,
    );
    manifest = recordTombstonePhase(
      operation,
      manifestEntry,
      manifest,
      cleanupRecordFor(entry, observed, placeholder, "source-fsynced", manifest, expectedSource, sensitive),
      { ...privateAfterSource, name: placeholder.name },
      tombstonePlaceholder,
      "complete",
      sensitive,
      fs,
      options,
    );
    manifest = recordCleanupPhase(
      operation,
      manifestEntry,
      manifest,
      cleanupRecordFor(entry, observed, placeholder, "private-unlinked", manifest, expectedSource, sensitive),
      fs,
      options,
    );
    crashAt(options, "after-cleanup-private-unlink");
    crashAt(options, "before-cleanup-private-fsync");
    fsyncDirectory(operation, fs);
    manifest = recordCleanupPhase(
      operation,
      manifestEntry,
      manifest,
      cleanupRecordFor(entry, observed, placeholder, "complete", manifest, expectedSource, sensitive),
      fs,
      options,
    );
    crashAt(options, "after-cleanup-private-fsync");
    return undefined;
  } catch (caught) {
    return normalizeFailure(caught, "temporary-cleanup");
  }
}

function closeEntries(entries, fs) {
  let error;
  for (const entry of entries) {
    const closeError = closeTracked(fs, entry?.fd);
    if (error === undefined && closeError !== undefined) error = closeError;
  }
  return error;
}

function validateEmptyTombstone(observed, code = "temporary-cleanup") {
  if (!observed.present || !Buffer.isBuffer(observed.read?.bytes) || observed.read.bytes.length !== 0 ||
      observed.nlink !== 1 || (observed.identity.mode & 0o7777) !== TEMP_SAFE_MODE ||
      observed.identity.uid !== currentUid()) {
    throw failure(code);
  }
}

function validateRetainedOperation(operation, manifest, fs, code = "temporary-cleanup", proof = {}) {
  try {
    assertOperationDirectory(operation, fs);
    const operationMatch = OPERATION_RE.exec(operation.name);
    if (operationMatch === null || operationMatch[1] !== operation.parent.name ||
        !validOperationName(operation.name)) throw failure(code, operation.displayPath);
    if (!validManifestRecord(manifest)) throw failure(code, operation.displayPath);
    if (manifest.operationDirectory !== operation.name ||
        manifest.targetPath !== path.join(operation.parent.displayPath, operation.parent.name) ||
        !sameDirectoryIdentityRecord(operation.identity, manifest.operationIdentity) ||
        !sameDirectoryIdentityRecord(operation.parent.identity, manifest.parentIdentity)) {
      throw failure(code, operation.displayPath);
    }

    const listing = fs.readdirSync(operation.path);
    if (listing.length > MAX_TOMBSTONE_ENTRIES) throw failure(code, operation.displayPath);
    const manifestEntry = inspectEntry({
      path: childPath(operation, "manifest"),
      displayPath: displayChildPath(operation, "manifest"),
    }, fs);
    if (!manifestEntry.present || manifestEntry.nlink !== 1 ||
        (manifestEntry.identity.mode & 0o7777) !== TEMP_SAFE_MODE ||
        manifestEntry.identity.uid !== currentUid()) throw failure(code, manifestEntry.displayPath);
    const records = strictManifestRecords(manifestEntry.read.bytes, code);
    if (JSON.stringify(records[records.length - 1]) !== JSON.stringify(manifest)) throw failure(code, manifestEntry.displayPath);

    const initialEntry = inspectEntry({
      path: childPath(operation, INITIAL_RECORD_NAME),
      displayPath: displayChildPath(operation, INITIAL_RECORD_NAME),
    }, fs);
    if (!initialEntry.present || initialEntry.read.bytes.length > MAX_TOMBSTONE_BYTES || initialEntry.nlink !== 1 ||
        (initialEntry.identity.mode & 0o7777) !== TEMP_SAFE_MODE || initialEntry.identity.uid !== currentUid() ||
        !initialEntry.read.bytes.toString("utf8").endsWith("\n")) throw failure(code, initialEntry.displayPath);
    let initialRecord;
    try { initialRecord = JSON.parse(initialEntry.read.bytes.toString("utf8").slice(0, -1)); } catch { throw failure(code, initialEntry.displayPath); }
    if (!validInitialRecord(initialRecord) || `${JSON.stringify(initialRecord)}\n` !== initialEntry.read.bytes.toString("utf8") ||
        initialRecord.targetPath !== manifest.targetPath || initialRecord.operationDirectory !== operation.name ||
        !sameDirectoryIdentityRecord(operation.identity, initialRecord.operationIdentity) ||
        !sameDirectoryIdentityRecord(operation.parent.identity, initialRecord.parentIdentity) ||
        initialRecord.target.name !== operation.parent.name ||
        !sameIdentityRecord(initialRecord.target.identity, manifest.original.identity) ||
        initialRecord.target.digest !== manifest.original.digest ||
        !sameIdentityRecord(initialEntry.identity, manifest.initial.identity) ||
        initialEntry.digest !== manifest.initial.digest) throw failure(code, initialEntry.displayPath);

    const allowed = new Set(["manifest", INITIAL_RECORD_NAME, "candidate", "backup", PUBLISHED_MARKER_NAME]);
    for (const record of manifest.cleanup) {
      if (record.phase !== "complete") throw failure(code, operation.displayPath);
      allowed.add(record.source.entry);
      allowed.add(record.placeholder.name);
    }
    if (listing.some((name) => !allowed.has(name))) {
      const foreign = listing.find((name) => !allowed.has(name));
      throw failure(code, displayChildPath(operation, foreign));
    }
    for (const name of listing) {
      if (name === "manifest" || name === INITIAL_RECORD_NAME) continue;
      const observed = inspectEntry({
        path: childPath(operation, name),
        displayPath: displayChildPath(operation, name),
      }, fs);
      if (!observed.present) throw failure(code, displayChildPath(operation, name));
      if (name === "candidate" && observed.read.bytes.length !== 0) {
        if (manifest.phase !== "prepared" || manifest.candidate === null ||
            observed.read.bytes.length > MAX_TOMBSTONE_BYTES ||
            !sameIdentityRecord(observed.identity, manifest.candidate.identity) ||
            observed.digest !== manifest.candidate.digest ||
            !candidateBytesSafe(observed.read.bytes, proof.key, proof.secretNeedles)) {
          throw failure(code, observed.displayPath ?? displayChildPath(operation, name));
        }
      } else {
        validateEmptyTombstone(observed, code);
      }
    }
  } catch (caught) {
    throw normalizeFailure(caught, code);
  }
}

function removeOperationDirectory(operation, entries, fs, options = {}) {
  let error;
  const manifestEntry = options.manifestEntry ?? entries.find((entry) => entry?.name === "manifest");
  const cleanupOptions = { ...options, manifestEntry };
  try {
    assertOperationDirectory(operation, fs);
    const listing = fs.readdirSync(operation.path);
    if (listing.length > MAX_TOMBSTONE_ENTRIES) return failure("temporary-cleanup", operation.displayPath);
    const allowed = new Set([
      ...entries.map((entry) => entry?.name).filter(Boolean),
      ...new Set(options.directCleanupNames ?? []),
    ]);
    for (const name of listing) {
      if (name.startsWith(QUARANTINE_PREFIX)) continue;
      if (!allowed.has(name)) return failure("temporary-cleanup", operation.displayPath);
    }
  } catch (caught) {
    return normalizeFailure(caught, "temporary-cleanup");
  }
  for (const entry of entries) {
    const cleanupError = cleanupEntry(entry, operation, fs, cleanupOptions);
    if (cleanupError !== undefined) {
      error = cleanupError;
      break;
    }
  }
  const closeError = closeEntries(entries, fs);
  if (error === undefined && closeError !== undefined) error = closeError;
  if (error !== undefined) return error;
  try {
    assertOperationDirectory(operation, fs);
    crashAt(options, "before-cleanup-operation-fsync");
    fsyncDirectory(operation, fs);
    crashAt(options, "after-cleanup-operation-fsync");

    // The operation directory is itself a retained tombstone.  Its name is
    // never removed through a pathname after an FD check: that check cannot
    // bind a later pathname removal against a foreign replacement.
    if (options.skipRetainedValidation !== true) {
      validateRetainedOperation(operation, manifestEntry?.manifest, fs, "temporary-cleanup", options.retainedProof);
    }
    fsyncDirectory(operation.parent, fs);
    crashAt(options, "after-cleanup-parent-fsync");
    return undefined;
  } catch (caught) {
    return normalizeFailure(caught, "temporary-cleanup");
  }
}

function preserveByExchange(entry, operation, label, fs, options) {
  const observed = inspectEntry(entry, fs);
  if (!observed.present) throw failure("file-changed", entry.displayPath ?? entry.path);
  const manifestEntry = options?.manifestEntry;
  let manifest = manifestEntry?.manifest;
  const placeholderName = privateQuarantineName(label);
  if (manifestEntry !== undefined && manifest !== undefined) {
    manifest = recordEvidencePhase(
      operation,
      manifestEntry,
      manifest,
      evidenceRecordFor(
        entry,
        observed,
        { name: placeholderName, identity: undefined, digest: EMPTY_DIGEST },
        "reserved",
      ),
      fs,
      options,
    );
    manifestEntry.manifest = manifest;
  }
  const placeholder = createPrivatePlaceholderNamed(operation, placeholderName, fs);
  if (manifestEntry !== undefined && manifest !== undefined) {
    manifest = recordEvidencePhase(
      operation,
      manifestEntry,
      manifest,
      evidenceRecordFor(entry, observed, placeholder, "prepared"),
      fs,
      options,
    );
    manifestEntry.manifest = manifest;
  }
  exchangeDirectories(
    entry.directory,
    entry.name,
    operation,
    placeholder.name,
    fs,
    options,
    "preserve",
  );
  if (manifestEntry !== undefined && manifest !== undefined) {
    manifest = recordEvidencePhase(
      operation,
      manifestEntry,
      manifest,
      evidenceRecordFor(entry, observed, placeholder, "exchanged"),
      fs,
      options,
    );
    manifestEntry.manifest = manifest;
  }
  const sourceNow = inspectEntry(entry, fs);
  const privateNow = inspectEntry(placeholder, fs);
  if (!sourceNow.present || !privateNow.present || !sameCreatedFile(sourceNow.identity, placeholder.identity) ||
      !sameCreatedFile(privateNow.identity, observed.identity) || privateNow.digest !== observed.digest) {
    throw failure("file-changed", placeholder.displayPath);
  }
  fsyncDirectory(entry.directory, fs);
  fsyncDirectory(operation, fs);
  crashAt(options, "after-rollback-preserve");
  return { placeholder, observed };
}

function createTargetPlaceholder(target, operation, fs) {
  const placeholder = {
    path: target.path,
    displayPath: target.displayPath,
    name: target.name,
    directory: target.directory,
    created: true,
  };
  let fd;
  try {
    fd = fs.openSync(target.path, TEMP_FLAGS, TEMP_SAFE_MODE);
    placeholder.fd = fd;
    placeholder.identity = fs.fstatSync(fd);
    validateRegular(placeholder.identity, "file-changed");
    validateCurrentUser(placeholder.identity, "file-changed");
    fs.fchmodSync(fd, TEMP_SAFE_MODE);
    return placeholder;
  } catch (caught) {
    closeTracked(fs, fd);
    if (placeholder.created && placeholder.identity !== undefined) {
      const cleanupError = cleanupEntry(placeholder, operation, fs);
      if (cleanupError !== undefined) throw cleanupError;
    }
    throw normalizeFailure(caught, "file-changed");
  }
}

function restoreFromBackup(target, operation, manifest, fs, options = {}) {
  const backup = {
    path: childPath(operation, "backup"),
    displayPath: displayChildPath(operation, "backup"),
    name: "backup",
    directory: operation,
    created: true,
  };
  const candidate = {
    path: childPath(operation, "candidate"),
    displayPath: displayChildPath(operation, "candidate"),
    name: "candidate",
    directory: operation,
    created: true,
  };
  const targetEntry = { ...target, created: true };
  const quarantines = [];
  let backupRead;
  let displaced;
  let candidatePreserved = false;
  try {
    backupRead = inspectEntry(backup, fs);
    if (!backupRead.present || !sameCreatedFile(backupRead.identity, manifest.original.identity) ||
        (backupRead.identity.mode & 0o7777) !== manifest.original.identity.mode ||
        backupRead.identity.uid !== manifest.original.identity.uid ||
        backupRead.identity.gid !== manifest.original.identity.gid) {
      throw failure("file-changed", backup.displayPath);
    }
    // A same-inode writer can change the old inode at the exchange boundary.
    // Its current verified bytes are the only safe rollback value.
    backup.identity = backupRead.identity;
    backup.digest = backupRead.digest;

    const candidateRead = inspectEntry(candidate, fs);
    if (!candidateRead.present) throw failure("file-changed", candidate.displayPath);
    if (!sameIdentityRecord(candidateRead.identity, manifest.original.identity) ||
        candidateRead.digest !== backupRead.digest) {
      if (isKnownEvidencePlaceholder(candidateRead, options.manifestEntry?.manifest ?? manifest)) {
        candidatePreserved = true;
      } else {
      const preserved = preserveByExchange(candidate, operation, "foreign-candidate", fs, options);
      quarantines.push(preserved.placeholder);
      candidatePreserved = true;
      }
    }

    let currentTarget = inspectEntry(targetEntry, fs);
    const targetIsExpectedCandidate = currentTarget.present &&
      sameIdentityRecord(currentTarget.identity, manifest.candidate.identity) &&
      currentTarget.digest === manifest.candidate.digest;
    if (!targetIsExpectedCandidate) {
      if (currentTarget.present) {
        const preserved = preserveByExchange(targetEntry, operation, "foreign-target", fs, options);
        quarantines.push(preserved.placeholder);
        currentTarget = inspectEntry(targetEntry, fs);
      } else {
        const created = createTargetPlaceholder(target, operation, fs);
        closeTracked(fs, created.fd);
        created.fd = undefined;
        fsyncDirectory(target.directory, fs);
        currentTarget = inspectEntry(targetEntry, fs);
      }
    }
    if (!currentTarget.present) throw failure("file-changed", target.displayPath);

    crashAt(options, "before-rollback-rename");
    crashAt(options, "before-restore");
    exchangeDirectories(operation, "backup", target.directory, target.name, fs, options, "rollback");
    crashAt(options, "after-rollback-rename");
    crashAt(options, "after-restore");

    const restored = inspectEntry(targetEntry, fs);
    if (!restored.present || !sameIdentityRecord(restored.identity, identityRecord(backupRead.identity)) ||
        restored.digest !== backupRead.digest) throw failure("file-changed", target.displayPath);
    const displacedRead = inspectEntry(backup, fs);
    if (!displacedRead.present) throw failure("file-changed", backup.displayPath);
    displaced = { identity: displacedRead.identity, digest: displacedRead.digest };

    crashAt(options, "before-rollback-operation-fsync");
    fsyncDirectory(operation, fs);
    crashAt(options, "after-rollback-operation-fsync");
    crashAt(options, "before-rollback-parent-fsync");
    fsyncDirectory(target.directory, fs);
    crashAt(options, "after-rollback-parent-fsync");
    return { quarantines, backupRead, displaced, candidatePreserved };
  } catch (caught) {
    const normalized = normalizeFailure(caught, "file-changed");
    normalized.recoveryPath = normalized.recoveryPath ?? operation.displayPath;
    return normalized;
  } finally {
    closeTracked(fs, backup.fd);
    closeTracked(fs, targetEntry.fd);
  }
}

function manifestEntryFor(operation, manifestEntry) {
  return {
    ...manifestEntry,
    directory: operation,
    name: "manifest",
    created: true,
  };
}

function cleanupState(operation, fs, descriptors, options) {
  const entries = descriptors.map((entry) => ({ ...entry, directory: operation }));
  const directCleanupNames = new Set(options.directCleanupNames ?? []);
  directCleanupNames.add(INITIAL_RECORD_NAME);
  return removeOperationDirectory(operation, entries, fs, { ...options, directCleanupNames });
}

function descriptorEntry(operation, name, identity, digest, preserveOnly = false, expectedNlink = linkCount(identity)) {
  const record = identity === undefined ? identity : {
    dev: identity.dev,
    ino: identity.ino,
    mode: identity.mode & 0o7777,
    uid: identity.uid,
    gid: identity.gid,
    size: identity.size,
  };
  return {
    path: childPath(operation, name),
    displayPath: displayChildPath(operation, name),
    name,
    directory: operation,
    identity: record,
    nlink: expectedNlink,
    digest,
    created: true,
    preserveOnly,
  };
}

function retainedTombstoneEntry(name) {
  return { name, created: false };
}

function cleanupJournalPath(operation, name) {
  return {
    path: childPath(operation, name),
    displayPath: displayChildPath(operation, name),
    name,
    directory: operation,
    created: true,
  };
}

function recoveryCleanupObservation(observation, expectedIdentity, expectedNlink, expectedDigest) {
  return observation.present && sameIdentityRecord(observation.identity, expectedIdentity) &&
    sameLinkCount(observation.identity, expectedNlink) && observation.digest === expectedDigest;
}

function isRetainedEmptyTombstone(observation) {
  return observation.present && observation.digest === EMPTY_DIGEST && observation.nlink === 1 &&
    (observation.identity.mode & 0o7777) === TEMP_SAFE_MODE && observation.identity.uid === currentUid();
}

function recoverCleanupJournal(operation, manifestEntry, manifest, fs, options = {}) {
  let current = manifest;
  for (const originalRecord of current.cleanup ?? []) {
    let record = originalRecord;
    if (record.tombstone !== null && record.tombstone.phase !== "complete") {
      current = recoverTombstone(operation, manifestEntry, current, record, fs, options);
      record = current.cleanup.find((item) => item.entry === originalRecord.entry);
    }
    const sourceEntry = cleanupJournalPath(operation, record.source.name);
    const placeholderEntry = cleanupJournalPath(operation, record.placeholder.name);
    let placeholderRecord = record.placeholder;
    let placeholder = inspectEntry(placeholderEntry, fs);
    if (placeholderRecord.identity === null) throw failure("recovery", placeholderEntry.displayPath);

    const source = inspectEntry(sourceEntry, fs);
    placeholder = inspectEntry(placeholderEntry, fs);
    const sourceIdentity = record.source.identity;
    const privateIdentity = record.placeholder.identity;
    const matchesSource = (observed) => recoveryCleanupObservation(observed, sourceIdentity, record.source.nlink, record.source.digest);
    const matchesPlaceholder = (observed) => privateIdentity !== null &&
      recoveryCleanupObservation(observed, privateIdentity, 1, record.placeholder.digest);
    const sourceMayBeReplaced = ["source-unlinked", "source-fsynced", "private-unlinked", "complete"]
      .includes(record.phase);

    const removals = [];
    if (source.present) {
      if (matchesSource(source)) removals.push({ entry: sourceEntry, observed: source, sensitive: record.sensitive });
      else if (sourceMayBeReplaced && isRetainedEmptyTombstone(source)) {}
      else if (matchesPlaceholder(source)) removals.push({ entry: sourceEntry, observed: source, sensitive: false });
      else throw failure("recovery", sourceEntry.displayPath);
    }
    if (placeholder.present) {
      if (matchesSource(placeholder)) removals.push({ entry: placeholderEntry, observed: placeholder, sensitive: record.sensitive });
      else if (sourceMayBeReplaced && isRetainedEmptyTombstone(placeholder)) {}
      else if (matchesPlaceholder(placeholder)) removals.push({ entry: placeholderEntry, observed: placeholder, sensitive: false });
      else throw failure("recovery", placeholderEntry.displayPath);
    }
    if (removals.length === 2 && sameCreatedFile(removals[0].observed.identity, removals[1].observed.identity)) {
      throw failure("recovery", operation.displayPath);
    }
    for (const removal of removals) {
      current = removeWithRecoveryTombstone(
        operation,
        manifestEntry,
        current,
        record,
        removal.entry,
        removal.observed,
        removal.sensitive,
        fs,
        options,
      );
      record = current.cleanup.find((item) => item.entry === record.entry);
    }
    if (removals.length !== 0) {
      crashAt(options, "before-cleanup-source-fsync");
      fsyncDirectory(operation, fs);
      crashAt(options, "after-cleanup-source-fsync");
    }
    if (record.phase !== "complete" || removals.length !== 0 || record.placeholder.created === false) {
      const complete = {
        ...record,
        phase: "complete",
        placeholder: { ...record.placeholder, created: record.placeholder.created },
      };
      current = recordCleanupPhase(operation, manifestEntry, current, complete, fs, options);
      manifestEntry.manifest = current;
    }
  }
  return current;
}

function candidatePreparationIdentityMatches(observed, expected, phase, original) {
  if (!observed.present || !validCandidateDescriptor(expected, false) || !Number.isSafeInteger(expected.nlink) ||
      !sameCreatedFile(observed.identity, expected.identity) || observed.nlink !== expected.nlink ||
      observed.identity.uid !== currentUid()) return false;
  if (phase === "candidate-metadata") {
    const observedMode = observed.identity.mode & 0o7777;
    const recordedMode = expected.identity.mode & 0o7777;
    return [recordedMode, recordedMode & ~0o6000].includes(observedMode) &&
      observed.identity.uid === expected.identity.uid && observed.identity.gid === expected.identity.gid;
  }
  return [expected.identity.mode, original.identity.mode].includes(observed.identity.mode & 0o7777) &&
    [expected.identity.uid, original.identity.uid].includes(observed.identity.uid) &&
    [expected.identity.gid, original.identity.gid].includes(observed.identity.gid);
}

function recoverCandidatePreparation(operation, target, manifestEntry, manifest, initialEntry, fs, options = {}) {
  const cleanupSealed = ["candidate", "backup"].every((entry) =>
    (manifest.cleanup ?? []).some((record) => record.entry === entry && record.phase === "complete"),
  );
  if (cleanupSealed) {
    validateRetainedOperation(operation, manifest, fs, "recovery", options.retainedProof);
    return;
  }
  const currentTarget = inspectEntry(target, fs);
  if (!currentTarget.present ||
      !sameIdentityRecord(currentTarget.identity, manifest.original.identity) ||
      currentTarget.digest !== manifest.original.digest || typeof options.recoveryKey !== "string") {
    throw failure("recovery", operation.displayPath);
  }
  let spans;
  try { spans = lineSpans(currentTarget.read.bytes, options.recoveryKey); } catch { throw failure("recovery", operation.displayPath); }
  if (spans.length !== 1) throw failure("recovery", operation.displayPath);
  const secretNeedles = removedSecretNeedles(currentTarget.read.bytes, spans[0]);
  const completeCleanup = new Set(
    (manifest.cleanup ?? []).filter((record) => record.phase === "complete").map((record) => record.entry),
  );
  const candidate = inspectEntry({
    path: childPath(operation, "candidate"),
    displayPath: displayChildPath(operation, "candidate"),
  }, fs);
  const backup = inspectEntry({
    path: childPath(operation, "backup"),
    displayPath: displayChildPath(operation, "backup"),
  }, fs);
  const entries = [];
  if (candidate.present) {
    if (completeCleanup.has("candidate") && isRetainedEmptyTombstone(candidate)) {
      entries.push(retainedTombstoneEntry("candidate"));
    } else {
      if (!candidatePreparationIdentityMatches(candidate, manifest.candidate, manifest.phase, manifest.original) ||
          candidate.read.bytes.length > MAX_TOMBSTONE_BYTES ||
          !candidateBytesSafe(candidate.read.bytes, options.recoveryKey, secretNeedles)) {
        throw failure("recovery", candidate.displayPath);
      }
      entries.push(descriptorEntry(operation, "candidate", candidate.identity, candidate.digest, false, candidate.nlink));
    }
  } else if (!completeCleanup.has("candidate")) {
    throw failure("recovery", operation.displayPath);
  }
  if (backup.present) {
    if (completeCleanup.has("backup") && isRetainedEmptyTombstone(backup)) {
      entries.push(retainedTombstoneEntry("backup"));
    } else if (!sameIdentityRecord(backup.identity, manifest.backup.identity) ||
               backup.digest !== manifest.backup.digest ||
               !sameLinkCount(backup.identity, manifest.backup.nlink)) {
      throw failure("recovery", backup.displayPath);
    } else {
      entries.push(descriptorEntry(operation, "backup", backup.identity, backup.digest, false, backup.nlink));
    }
  } else if (!completeCleanup.has("backup")) {
    throw failure("recovery", operation.displayPath);
  }
  if (entries.length === 0) return;
  const error = cleanupState(operation, fs, [
    ...entries,
    manifestEntry,
    ...(initialEntry === undefined ? [] : [initialEntry]),
  ], {
    ...options,
    retainedProof: { key: options.recoveryKey, secretNeedles },
  });
  if (error !== undefined) throw error;
}

function recoverInitialOperation(operation, target, manifestEntry, manifest, initialEntry, fs, options = {}) {
  manifest = recoverCleanupJournal(operation, manifestEntry, manifest, fs, options);
  manifestEntry.manifest = manifest;
  const listing = fs.readdirSync(operation.path);
  const allowed = new Set(["manifest", INITIAL_RECORD_NAME, ".manifest-stage", "backup", "candidate"]);
  if (listing.some((name) => !allowed.has(name))) throw failure("recovery", operation.displayPath);
  if (initialEntry === undefined) throw failure("recovery", operation.displayPath);
  const plans = new Map(initialEntry.record.entries.map((entry) => [entry.name, entry]));
  const descriptors = [manifestEntry, initialEntry];
  for (const name of [".manifest-stage", "backup", "candidate"]) {
    if (!listing.includes(name)) continue;
    const observed = inspectEntry({
      path: childPath(operation, name),
      displayPath: displayChildPath(operation, name),
    }, fs);
    if (!observed.present || observed.identity.uid !== currentUid() ||
        (name !== "backup" && observed.nlink !== 1)) {
      throw failure("recovery", displayChildPath(operation, name));
    }
    if (name === ".manifest-stage") {
      if (observed.read.bytes.length !== 0) {
        const stageScan = scanManifestRecords(observed.read.bytes);
        if (!stageScan.complete || stageScan.records.at(-1)?.phase !== "initial") {
          throw failure("recovery", observed.displayPath ?? displayChildPath(operation, name));
        }
      }
    } else {
      const plan = plans.get(name);
      const candidateEmpty = name === "candidate" && plan?.identity === null &&
        observed.digest === EMPTY_DIGEST && observed.identity.size === 0 &&
        (observed.identity.mode & 0o7777) === TEMP_SAFE_MODE;
      const candidateFinal = name === "candidate" && plan?.identity === null &&
        observed.digest === plan?.digest && observed.identity.size === plan?.size &&
        (observed.identity.mode & 0o7777) === plan?.mode && observed.identity.uid === plan?.uid &&
        observed.identity.gid === plan?.gid;
      if (plan === undefined ||
          (name === "backup" && (observed.digest !== plan.digest ||
            (observed.identity.mode & 0o7777) !== plan.mode || observed.identity.uid !== plan.uid ||
            observed.identity.gid !== plan.gid || observed.identity.size !== plan.size ||
            plan.identity === null || !sameIdentityRecord(observed.identity, plan.identity) || observed.nlink < plan.nlink)) ||
          (name === "candidate" && !candidateEmpty && !candidateFinal)) {
        throw failure("recovery", observed.displayPath ?? displayChildPath(operation, name));
      }
    }
    descriptors.push(descriptorEntry(operation, name, observed.identity, observed.digest, false, observed.nlink));
  }
  const error = cleanupState(operation, fs, descriptors, {
    ...options,
    directCleanup: true,
    directCleanupNames: new Set(descriptors.map((entry) => entry.name)),
    skipRetainedValidation: false,
  });
  if (error !== undefined) throw error;
}

function recoverTombstone(operation, manifestEntry, manifest, record, fs, options = {}) {
  let current = manifest;
  let currentRecord = record;
  let tombstone = currentRecord.tombstone;
  if (tombstone === null || tombstone.phase === "complete") return current;
  const sourceEntry = cleanupJournalPath(operation, tombstone.source.name);
  const quarantineEntry = cleanupJournalPath(operation, tombstone.quarantine.name);
  let source = inspectEntry(sourceEntry, fs);
  let quarantine = inspectEntry(quarantineEntry, fs);

  if (tombstone.phase === "reserved") {
    const sourceMatches = source.present && recoveryCleanupObservation(
      source,
      tombstone.source.identity,
      tombstone.source.nlink,
      tombstone.source.digest,
    );
    if (!sourceMatches) throw failure("recovery", sourceEntry.displayPath);
    if (!quarantine.present) {
      createPrivatePlaceholderNamed(operation, tombstone.quarantine.name, fs);
      quarantine = inspectEntry(quarantineEntry, fs);
    }
    if (!isRetainedEmptyTombstone(quarantine)) throw failure("recovery", quarantineEntry.displayPath);
    const preparedRecord = currentRecord.placeholder.identity === null
      ? {
        ...currentRecord,
        phase: "prepared",
        placeholder: {
          ...currentRecord.placeholder,
          identity: identityRecord(quarantine.identity),
          created: true,
        },
      }
      : currentRecord;
    current = recordTombstonePhase(
      operation,
      manifestEntry,
      current,
      preparedRecord,
      { ...source, name: tombstone.source.name },
      { ...quarantine, name: tombstone.quarantine.name },
      "prepared",
      tombstone.sensitive,
      fs,
      options,
    );
    manifestEntry.manifest = current;
    currentRecord = current.cleanup.find((item) => item.entry === record.entry);
    tombstone = currentRecord.tombstone;
    source = inspectEntry(sourceEntry, fs);
    quarantine = inspectEntry(quarantineEntry, fs);
  }
  const sourceMatches = source.present && recoveryCleanupObservation(
    source,
    tombstone.source.identity,
    tombstone.source.nlink,
    tombstone.source.digest,
  );
  const quarantineMatches = quarantine.present && recoveryCleanupObservation(
    quarantine,
    tombstone.quarantine.identity,
    1,
    tombstone.quarantine.digest,
  );
  const sourceIsPlaceholder = source.present &&
    sameIdentityRecord(source.identity, tombstone.quarantine.identity) && source.digest === EMPTY_DIGEST;
  const quarantineIsSource = source.present && quarantine.present &&
    sameIdentityRecord(quarantine.identity, tombstone.source.identity) &&
    quarantine.digest === tombstone.source.digest;
  const sourceIsOnlyPlaceholder = sourceIsPlaceholder && !quarantine.present;
  if (sourceIsOnlyPlaceholder) {
    // The helper has already removed the verified source inode and crashed
    // before its second unlink.  The remaining inode is an identity-bound,
    // empty placeholder; retain it under the existing cleanup record rather
    // than attempting an unjournaled deletion.
    fsyncDirectory(operation, fs);
    const complete = { ...currentRecord, tombstone: { ...tombstone, phase: "complete" } };
    const next = recordCleanupPhase(operation, manifestEntry, current, complete, fs, options);
    manifestEntry.manifest = next;
    return next;
  }
  if (!source.present && !quarantine.present) {
    const complete = { ...currentRecord, tombstone: { ...tombstone, phase: "complete" } };
    const next = recordCleanupPhase(operation, manifestEntry, current, complete, fs, options);
    manifestEntry.manifest = next;
    return next;
  }
  if (sourceMatches && quarantineMatches) {
    removeWithRecordedTombstone(
      operation,
      manifestEntry,
      current,
      currentRecord,
      tombstone.source.name,
      source,
      tombstone.quarantine.name,
      quarantine,
      fs,
      options,
    );
  } else if (sourceIsPlaceholder && quarantineIsSource) {
    removeWithRecordedTombstone(
      operation,
      manifestEntry,
      current,
      currentRecord,
      tombstone.quarantine.name,
      quarantine,
      tombstone.source.name,
      source,
      fs,
      options,
    );
  } else {
    throw failure("recovery", operation.displayPath);
  }
  fsyncDirectory(operation, fs);
  const complete = { ...currentRecord, tombstone: { ...tombstone, phase: "complete" } };
  const next = recordCleanupPhase(operation, manifestEntry, current, complete, fs, options);
  manifestEntry.manifest = next;
  return next;
}

function recoverOperation(operation, target, fs, options = {}) {
  assertOperationDirectory(operation, fs);
  let { manifest, manifestEntry: rawManifestEntry } = readManifest(operation, fs, target.displayPath);
  const manifestEntry = manifestEntryFor(operation, rawManifestEntry);
  manifestEntry.manifest = manifest;
  const cleanupNames = new Set(manifest.cleanup.map((record) => record.entry));
  const cleanupSealed = ["candidate", "backup", PUBLISHED_MARKER_NAME].every((name) => cleanupNames.has(name));
  if (manifest.phase === "published" && cleanupSealed &&
      manifest.cleanup.every((record) => record.phase === "complete")) {
    validateRetainedOperation(operation, manifest, fs, "recovery");
    return;
  }
  const operationListing = fs.readdirSync(operation.path);
  const initialEntry = operationListing.includes(INITIAL_RECORD_NAME)
    ? readInitialRecord(operation, target, fs)
    : undefined;
  const withInitial = (entries) => initialEntry === undefined ? entries : [...entries, initialEntry];
  if (CANDIDATE_PREPARATION_PHASES.has(manifest.phase)) {
    manifest = recoverCleanupJournal(operation, manifestEntry, manifest, fs, options);
    manifestEntry.manifest = manifest;
    recoverCandidatePreparation(operation, target, manifestEntry, manifest, initialEntry, fs, options);
    return;
  }
  if (manifest.phase === "initial") {
    const currentTarget = inspectEntry(target, fs);
    const targetMatchesInitial = currentTarget.present &&
      sameIdentityRecord(currentTarget.identity, manifest.original.identity) &&
      currentTarget.digest === manifest.original.digest &&
      (initialEntry === undefined || (
        initialEntry.record.target.digest === manifest.original.digest &&
        sameIdentityRecord(initialEntry.record.target.identity, manifest.original.identity) &&
        manifest.initial?.identity?.ino === initialEntry.identity.ino &&
        manifest.initial?.digest === initialEntry.digest
      ));
    if (!targetMatchesInitial) {
      const metadataOnly = operationListing.every((name) => ["manifest", INITIAL_RECORD_NAME].includes(name));
      if (metadataOnly) return;
      throw failure("recovery", operation.displayPath);
    }
    recoverInitialOperation(operation, target, manifestEntry, manifest, initialEntry, fs, options);
    if (options.assertAbsentRecovery === true) {
      const current = inspectEntry(target, fs);
      if (current.present && lineSpans(current.read.bytes, options.recoveryKey).length !== 0) {
        throw failure("recovery", operation.displayPath);
      }
    }
    return;
  }
  if ((manifest.cleanup ?? []).some((record) => record.placeholder.identity === null &&
      record.tombstone?.phase !== "reserved") ||
      (manifest.evidence ?? []).some((record) => record.placeholder.identity === null)) {
    throw failure("recovery", operation.displayPath);
  }
  manifest = recoverCleanupJournal(operation, manifestEntry, manifest, fs, options);
  manifestEntry.manifest = manifest;
  const knownPlaceholders = new Set([
    ...(manifest.cleanup ?? []).map((record) => record.placeholder.name),
    ...(manifest.evidence ?? []).map((record) => record.placeholder.name),
  ]);
  for (const name of fs.readdirSync(operation.path)) {
    if (name.startsWith(QUARANTINE_PREFIX) && !knownPlaceholders.has(name)) {
      throw failure("recovery", operation.displayPath);
    }
  }
  const candidate = inspectEntry({ path: childPath(operation, "candidate"), displayPath: displayChildPath(operation, "candidate") }, fs);
  const backup = inspectEntry({ path: childPath(operation, "backup"), displayPath: displayChildPath(operation, "backup") }, fs);
  const publishedMarker = inspectEntry({ path: childPath(operation, PUBLISHED_MARKER_NAME), displayPath: displayChildPath(operation, PUBLISHED_MARKER_NAME) }, fs);
  if (publishedMarker.present && (publishedMarker.digest !== contentHash(Buffer.alloc(0)) ||
      (publishedMarker.identity.mode & 0o7777) !== TEMP_SAFE_MODE)) {
    throw failure("recovery", operation.displayPath);
  }
  const currentTarget = inspectEntry(target, fs);
  if (!currentTarget.present) throw failure("recovery", operation.displayPath);

  const targetOriginal = sameIdentityRecord(currentTarget.identity, manifest.original.identity) && currentTarget.digest === manifest.original.digest;
  const targetCandidate = sameIdentityRecord(currentTarget.identity, manifest.candidate.identity) && currentTarget.digest === manifest.candidate.digest;
  const candidateOriginal = candidate.present && sameIdentityRecord(candidate.identity, manifest.original.identity) && candidate.digest === manifest.original.digest;
  const candidateCandidate = candidate.present && sameIdentityRecord(candidate.identity, manifest.candidate.identity) && candidate.digest === manifest.candidate.digest;
  const backupOriginalInode = backup.present && sameCreatedFile(backup.identity, manifest.original.identity);
  const backupCandidate = backup.present && sameIdentityRecord(backup.identity, manifest.candidate.identity) && backup.digest === manifest.candidate.digest;
  const cleanupCompleted = manifest.cleanup.length !== 0 && manifest.cleanup.every((record) => record.phase === "complete");

  if (cleanupCompleted && !candidate.present && !backup.present && (targetOriginal || targetCandidate)) {
    const error = cleanupState(operation, fs, withInitial([manifestEntry]), options);
    if (error !== undefined) throw error;
    return;
  }

  if (targetOriginal && candidateCandidate && backupOriginalInode) {
    const error = cleanupState(operation, fs, withInitial([
      descriptorEntry(operation, "candidate", manifest.candidate.identity, manifest.candidate.digest, false, manifest.candidate.nlink),
      descriptorEntry(operation, "backup", backup.identity, backup.digest, false, backup.nlink),
      manifestEntry,
    ]), options);
    if (error !== undefined) throw error;
    return;
  }

  if (targetCandidate && backupOriginalInode && (candidateOriginal || publishedMarker.present)) {
    const candidateEntry = candidate.present && candidate.digest !== contentHash(Buffer.alloc(0))
      ? descriptorEntry(operation, "candidate", candidate.identity, candidate.digest, !candidateOriginal)
      : candidate.present ? retainedTombstoneEntry("candidate")
      : descriptorEntry(operation, "candidate", manifest.original.identity, manifest.original.digest, true);
    const error = cleanupState(operation, fs, withInitial([
      candidateEntry,
      descriptorEntry(operation, "backup", backup.identity, backup.digest, false, Math.max(1, backup.nlink - 1)),
      ...(publishedMarker.present
        ? [descriptorEntry(operation, PUBLISHED_MARKER_NAME, publishedMarker.identity, publishedMarker.digest)]
        : []),
      manifestEntry,
    ]), options);
    if (error !== undefined) throw error;
    return;
  }

  if (targetOriginal && candidateOriginal && backupOriginalInode) {
    const error = cleanupState(operation, fs, withInitial([
      descriptorEntry(operation, "candidate", candidate.identity, candidate.digest, false, candidate.nlink),
      descriptorEntry(operation, "backup", backup.identity, backup.digest, false, Math.max(1, backup.nlink - 1)),
      manifestEntry,
    ]), options);
    if (error !== undefined) throw error;
    return;
  }

  if (targetOriginal && backupCandidate) {
    const candidateEntry = candidate.present
      ? descriptorEntry(operation, "candidate", candidate.identity, candidate.digest, !candidateOriginal)
      : descriptorEntry(operation, "candidate", manifest.original.identity, manifest.original.digest, true);
    const error = cleanupState(operation, fs, withInitial([
      candidateEntry,
      descriptorEntry(operation, "backup", manifest.candidate.identity, manifest.candidate.digest, false, manifest.candidate.nlink),
      manifestEntry,
    ]), options);
    if (error !== undefined) throw error;
    return;
  }

  const retainedCleanupArtifacts = [candidate, backup, publishedMarker]
    .every((entry) => !entry.present || isRetainedEmptyTombstone(entry));
  if (cleanupCompleted && retainedCleanupArtifacts) return;

  if (!backupOriginalInode) throw failure("recovery", operation.displayPath);
  const restored = restoreFromBackup(target, operation, manifest, fs, { ...options, manifestEntry });
  if (restored instanceof RemoveEnvEntryError) throw restored;
  const candidateAfter = inspectEntry({ path: childPath(operation, "candidate"), displayPath: displayChildPath(operation, "candidate") }, fs);
  const backupAfter = inspectEntry({ path: childPath(operation, "backup"), displayPath: displayChildPath(operation, "backup") }, fs);
  const candidateEntry = candidateAfter.present && candidateAfter.digest !== contentHash(Buffer.alloc(0))
    ? descriptorEntry(operation, "candidate", candidateAfter.identity, candidateAfter.digest, false)
    : candidateAfter.present ? retainedTombstoneEntry("candidate")
    : descriptorEntry(operation, "candidate", manifest.original.identity, manifest.original.digest, true);
  const backupEntry = backupAfter.present
    ? descriptorEntry(operation, "backup", restored.displaced.identity, restored.displaced.digest, false)
    : descriptorEntry(operation, "backup", manifest.candidate.identity, manifest.candidate.digest, true);
  const cleanupError = cleanupState(
    operation,
    fs,
    withInitial([candidateEntry, backupEntry, manifestEntry]),
    options,
  );
  if (cleanupError !== undefined) throw cleanupError;
}

function recoverIncompleteOperation(operation, target, fs, options = {}) {
  const initialEntry = readInitialRecord(operation, target, fs);
  const initial = initialEntry.record;
  const currentTarget = inspectEntry(target, fs);
  if (!currentTarget.present ||
      !sameIdentityRecord(currentTarget.identity, initial.target.identity) ||
      currentTarget.digest !== initial.target.digest) {
    throw failure("recovery", operation.displayPath);
  }

  const listing = fs.readdirSync(operation.path);
  const allowed = new Set([INITIAL_RECORD_NAME, ".manifest-stage", "manifest"]);
  if (listing.some((name) => !allowed.has(name))) throw failure("recovery", operation.displayPath);

  const descriptors = [initialEntry];
  for (const name of [".manifest-stage", "manifest"]) {
    if (!listing.includes(name)) continue;
    const observed = inspectEntry({
      path: childPath(operation, name),
      displayPath: displayChildPath(operation, name),
    }, fs);
    if (!observed.present || observed.nlink !== 1 ||
        (observed.identity.mode & 0o7777) !== TEMP_SAFE_MODE) {
      throw failure("recovery", operation.displayPath);
    }
    if (name === "manifest" && observed.read.bytes.length !== 0) {
      throw failure("recovery", operation.displayPath);
    }
    if (name === ".manifest-stage" && observed.read.bytes.length !== 0) {
      let records;
      try { records = manifestRecords(observed.read.bytes); } catch { throw failure("recovery", operation.displayPath); }
      const record = records[records.length - 1];
      if (record?.version !== MANIFEST_VERSION || record.phase !== "initial" ||
          record.targetPath !== target.displayPath || record.operationDirectory !== operation.name ||
          !sameDirectoryIdentityRecord(operation.identity, record.operationIdentity) ||
          !sameDirectoryIdentityRecord(operation.parent.identity, record.parentIdentity) ||
          record.candidate !== null || record.backup !== null ||
          !sameIdentityRecord(initial.target.identity, record.original?.identity) ||
          record.original?.digest !== initial.target.digest) {
        throw failure("recovery", operation.displayPath);
      }
    }
  }

  const error = removeOperationDirectory(operation, descriptors, fs, {
    ...options,
    directCleanup: true,
    directCleanupNames: new Set([INITIAL_RECORD_NAME, ".manifest-stage", "manifest"]),
    skipRetainedValidation: true,
  });
  if (error !== undefined) throw error;
  return { operation, initialEntry };
}

function recoverSiblingOperations(parent, target, fs, options = {}) {
  let names;
  try {
    revalidateDirectory(parent, fs);
    names = fs.readdirSync(parent.path);
  } catch (caught) {
    throw normalizeFailure(caught, "recovery");
  }
  const base = path.basename(target.displayPath);
  const reusable = [];
  for (const name of names) {
    const match = OPERATION_RE.exec(name);
    if (match === null || match[1] !== base) continue;
    const operation = {
      path: path.join(parent.path, name),
      displayPath: path.join(parent.displayPath, name),
      name,
      parent,
      isParent: false,
    };
    let fd;
    try {
      const listed = fs.lstatSync(operation.path);
      validatePrivateDirectory(listed, "recovery");
      fd = fs.openSync(operation.path, DIRECTORY_FLAGS);
      const opened = fs.fstatSync(fd);
      validatePrivateDirectory(opened, "recovery");
      if (!sameDirectoryIdentity(listed, opened)) throw failure("recovery", operation.displayPath);
      operation.fd = fd;
      operation.identity = opened;
      const listing = fs.readdirSync(operation.path);
      const manifestPath = childPath(operation, "manifest");
      const emptyManifest = listing.includes("manifest") &&
        inspectEntry({ path: manifestPath, displayPath: displayChildPath(operation, "manifest") }, fs).read.bytes.length === 0;
      if (!listing.includes("manifest") || emptyManifest) {
        const recovered = recoverIncompleteOperation(operation, target, fs, options);
        reusable.push(recovered);
      } else {
        recoverOperation(operation, target, fs, options);
        operation.fd = undefined;
      }
    } catch (caught) {
      closeTracked(fs, fd);
      throw normalizeFailure(caught, "recovery");
    }
  }
  return reusable;
}

function hasSiblingOperation(parent, target, fs) {
  const base = path.basename(target.displayPath);
  return fs.readdirSync(parent.path).some((name) => {
    const match = OPERATION_RE.exec(name);
    return match !== null && match[1] === base;
  });
}

function assertAbsentInternal(target, key, fs) {
  const original = readRegularFile(target.path, fs, true);
  let error;
  try {
    if (lineSpans(original.bytes, key).length !== 0) throw failure("assignment-present");
    revalidateDirectory(target.directory, fs, "unsafe-parent");
    assertTargetUnchanged(target, original, fs);
    revalidateDirectory(target.directory, fs, "unsafe-parent");
    assertTargetUnchanged(target, original, fs);
  } catch (caught) {
    error = normalizeFailure(caught, "assert-absent");
  }
  const closeError = closeTracked(fs, original.fd);
  if (error === undefined && closeError !== undefined) error = closeError;
  if (error !== undefined) throw error;
}

function assertAbsentWithGate(filePath, key, options = {}, testGate) {
  validateRequest(filePath, key);
  if (testGate === undefined) {
    validateProductionRequest(filePath, key);
    if (options.fs !== undefined) throw failure("usage");
  }
  const injected = options.fs !== undefined;
  const fs = injected ? { ...DEFAULT_FS, ...options.fs } : DEFAULT_FS;
  let parent;
  try {
    parent = bindParent(filePath, fs, !injected || options.bindParent === true);
    const target = { path: childPath(parent, parent.name), displayPath: filePath, name: parent.name, directory: parent };
    recoverSiblingOperations(parent, target, fs, { ...options, assertAbsentRecovery: true, recoveryKey: key });
    revalidateDirectory(parent, fs, "unsafe-parent");
    assertAbsentInternal(target, key, fs);
  } catch (error) {
    throw normalizeFailure(error, "assert-absent");
  } finally {
    closeTracked(fs, parent?.fd, "parent-close");
  }
}

function removeEnvEntryWithGate(filePath, key, options = {}, testGate) {
  validateRequest(filePath, key);
  if (testGate === undefined) {
    validateProductionRequest(filePath, key);
    if (options.fs !== undefined) throw failure("usage");
  }
  const injected = options.fs !== undefined;
  const fs = injected ? { ...DEFAULT_FS, ...options.fs } : DEFAULT_FS;
  const randomBytesFn = options.randomBytesFn ?? randomBytes;
  let parent;
  try {
    parent = bindParent(filePath, fs, !injected || options.bindParent === true);
    const target = { path: childPath(parent, parent.name), displayPath: filePath, name: parent.name, directory: parent };
    if (!hasSiblingOperation(parent, target, fs)) validateInitialTargetPath(target, fs);
    const reusableOperations = recoverSiblingOperations(parent, target, fs, { ...options, recoveryKey: key });
    revalidateDirectory(parent, fs, "unsafe-parent");
    const original = readRegularFile(target.path, fs, true);
    let operation;
    let backup;
    let candidate;
    let manifestEntry;
    let initialEntry;
    let publishedMarker;
    let exchanged = false;
    let operationRemoved = false;
    let operationError;
    try {
      const spans = lineSpans(original.bytes, key);
      if (spans.length !== 1) throw failure(spans.length === 0 ? "assignment-absent" : "assignment-duplicate");
      const replacement = removeSpan(original.bytes, spans[0]);
      const secretNeedles = removedSecretNeedles(original.bytes, spans[0]);
      const replacementHash = contentHash(replacement);
      if (!candidateBytesSafe(replacement, key, secretNeedles)) throw failure("assignment-present");
      validateReplacementSource(original.state);
      validateInitialTarget(original.state);
      const reusable = reusableOperations.length === 1 ? reusableOperations[0] : undefined;
      if (reusable !== undefined) {
        operation = reusable.operation;
        initialEntry = reusable.initialEntry;
        assertOperationDirectory(operation, fs);
      } else {
        operation = createOperationDirectory(parent, filePath, fs, randomBytesFn);
        fsyncDirectory(parent, fs);
        assertOperationDirectory(operation, fs);
        initialEntry = createInitialRecord(operation, target, original, fs, {
          ...options,
          entryPlan: initialPlanFor(original, replacementHash, replacement.length),
        });
      }
      manifestEntry = createManifest(operation, target, original, undefined, undefined, replacementHash, fs, options, initialEntry);
      fsyncDirectory(operation, fs);
      backup = createBackup(target, original, operation, fs, { ...options, manifestEntry });
      manifestEntry.manifest = appendManifestRecord(
        operation,
        manifestEntry,
        manifestEntry.manifest,
        {
          ...manifestEntry.manifest,
          backup: { name: "backup", identity: identityRecord(backup.identity), nlink: linkCount(backup.identity), digest: original.contentHash },
        },
        fs,
        options,
      );
      crashAt(options, "after-backup-manifest");
      crashAt(options, "before-prepared");
      candidate = createOwnedFile(operation, "candidate", TEMP_SAFE_MODE, fs);
      manifestEntry.manifest = recordCandidatePhase(
        operation,
        manifestEntry,
        manifestEntry.manifest,
        "candidate-created",
        candidate,
        fs,
        options,
      );
      crashAt(options, "after-candidate-created-record");
      crashAt(options, "after-candidate-record");
      crashAt(options, "after-candidate-created");
      candidate = prepareCandidate(
        operation,
        candidate,
        original,
        replacement,
        fs,
        { key, secretNeedles },
        manifestEntry,
        options,
      );
      fsyncDirectory(operation, fs);
      crashAt(options, "after-candidate-directory-fsync");
      manifestEntry.manifest = appendManifestRecord(
        operation,
        manifestEntry,
        manifestEntry.manifest,
        {
          ...manifestEntry.manifest,
          phase: "prepared",
          candidate: candidateDescriptor(candidate, replacementHash),
        },
        fs,
        options,
      );
      crashAt(options, "after-prepared");
      fsyncDirectory(operation, fs);
      assertTargetUnchanged(target, original, fs);
      assertManifestStable(manifestEntry, manifestEntry.manifest, fs);
      verifyBoundPath(candidate, candidate.identity, replacementHash, fs, { fd: candidate.fd });
      verifyBoundPath(backup, backup.identity, original.contentHash, fs, { fd: backup.fd });
      crashAt(options, "before-exchange");
      crashAt(options, "before-rename");

      exchangeDirectories(operation, "candidate", parent, target.name, fs, options, "publication");
      exchanged = true;
      crashAt(options, "after-exchange");
      crashAt(options, "after-rename");

      const targetAfter = inspectEntry(target, fs);
      const candidateAfter = inspectEntry(candidate, fs);
      const backupAfter = inspectEntry(backup, fs);
      const candidateRecord = identityRecord(candidate.identity);
      const originalRecord = identityRecord(original.identity);
      const published = targetAfter.present && candidateAfter.present && backupAfter.present &&
        sameIdentityRecord(targetAfter.identity, candidateRecord) && targetAfter.digest === replacementHash &&
        sameIdentityRecord(candidateAfter.identity, originalRecord) && candidateAfter.digest === original.contentHash &&
        sameIdentityRecord(backupAfter.identity, originalRecord) && backupAfter.digest === original.contentHash;
      if (!published) {
        const restored = restoreFromBackup(
          target,
          operation,
          manifestEntry.manifest,
          fs,
          { ...options, manifestEntry },
        );
        if (restored instanceof RemoveEnvEntryError) throw restored;
        const candidateRestored = inspectEntry(candidate, fs);
        const rollbackEntries = [
          descriptorEntry(operation, "candidate", candidateRestored.identity, candidateRestored.digest, false),
          descriptorEntry(operation, "backup", restored.displaced.identity, restored.displaced.digest),
          manifestEntry,
        ];
        const cleanupError = cleanupState(operation, fs, rollbackEntries, options);
        if (cleanupError !== undefined) throw cleanupError;
        operation = undefined;
        throw failure("file-changed");
      }

      crashAt(options, "before-publication-operation-fsync");
      fsyncDirectory(operation, fs);
      crashAt(options, "after-publication-operation-fsync");
      crashAt(options, "before-publication-parent-fsync");
      fsyncDirectory(parent, fs);
      crashAt(options, "after-publication-parent-fsync");
      manifestEntry.manifest = recordOperationPhase(
        operation,
        manifestEntry,
        manifestEntry.manifest,
        "published",
        fs,
        options,
      );
      publishedMarker = createPublishedMarker(operation, fs, { ...options, manifestEntry });
      const cleanupError = cleanupState(operation, fs, [
      descriptorEntry(operation, "candidate", original.identity, original.contentHash, false, linkCount(backup.identity)),
      descriptorEntry(operation, "backup", original.identity, original.contentHash, false, 1),
      publishedMarker,
      manifestEntry,
      initialEntry,
      ], { ...options, retainedProof: { key, secretNeedles } });
      if (cleanupError !== undefined) throw cleanupError;
      operationRemoved = true;
      successCheckpoint(options, { kind: "publication", targetPath: filePath });
      revalidateDirectory(parent, fs, "unsafe-parent");
      verifyFinalPublishedTarget(target, candidate.identity, replacementHash, key, fs, secretNeedles);
      revalidateDirectory(parent, fs, "unsafe-parent");
      operation = undefined;
    } catch (caught) {
      operationError = normalizeFailure(caught, "remove");
      if (exchanged && !operationRemoved && operation !== undefined && operationError.recoveryPath === undefined) {
        operationError.recoveryPath = operation.displayPath;
      }
      if (operation !== undefined && !exchanged) {
        const preEntries = [];
        if (candidate !== undefined) preEntries.push(candidate);
        if (backup !== undefined) preEntries.push(backup);
        if (manifestEntry !== undefined) preEntries.push(manifestEntry);
        if (initialEntry !== undefined) preEntries.push(initialEntry);
        const cleanupError = removeOperationDirectory(operation, preEntries, fs, { ...options, directCleanup: true });
        if (cleanupError !== undefined) {
          operationError = failure(cleanupError.code ?? "temporary-cleanup", cleanupError.recoveryPath ?? operation.displayPath);
        } else {
          operation = undefined;
        }
      }
    }
    closeTracked(fs, original.fd);
    closeEntries([candidate, backup, manifestEntry, publishedMarker, initialEntry], fs);
    closeTracked(fs, operation?.fd);
    if (operationError !== undefined) throw operationError;
  } catch (error) {
    throw normalizeFailure(error, "remove");
  } finally {
    closeTracked(fs, parent?.fd, "parent-close");
  }
}

function parseAdapterCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 3) return undefined;
  const [operation, filePath, key] = argv;
  if (!OPERATIONS.includes(operation) || typeof filePath !== "string" || !path.isAbsolute(filePath) ||
      typeof key !== "string" || !KEY_RE.test(key)) return undefined;
  return { operation, filePath, key };
}

function parseProductionCli(argv) {
  const request = parseAdapterCli(argv);
  if (request === undefined || !isProductionRequest(request.filePath, request.key)) return undefined;
  return request;
}

function runCliWithGate(argv, options = {}, testGate) {
  const request = testGate === undefined ? parseProductionCli(argv) : parseAdapterCli(argv);
  if (request === undefined) return 2;
  try {
    if (request.operation === "remove") removeEnvEntryWithGate(request.filePath, request.key, options, testGate);
    else assertAbsentWithGate(request.filePath, request.key, options, testGate);
    return 0;
  } catch {
    return 1;
  }
}

export function createTestAdapter() {
  const testGate = Symbol("remove-env-entry-test-adapter");
  return Object.freeze({
    assertAbsent(filePath, key, options = {}) {
      return assertAbsentWithGate(filePath, key, options, testGate);
    },
    countAssignments,
    parseCli: parseAdapterCli,
    removeEnvEntry(filePath, key, options = {}) {
      return removeEnvEntryWithGate(filePath, key, options, testGate);
    },
    runCli(argv, options = {}) {
      return runCliWithGate(argv, options, testGate);
    },
    runLocked(argv, options = {}) {
      return runLockedCli(argv, options, testGate);
    },
    runProcessTree(command, options = {}) {
      verifyHelperBinary();
      return spawnProcessTreeSync(command, options);
    },
    strictManifestRecords,
  });
}

export function assertAbsent(filePath, key, options = {}) {
  return assertAbsentWithGate(filePath, key, options);
}

export function removeEnvEntry(filePath, key, options = {}) {
  return removeEnvEntryWithGate(filePath, key, options);
}

export function parseCli(argv) {
  return parseProductionCli(argv);
}

export function runCli(argv, options = {}) {
  return runCliWithGate(argv, options);
}

function kernelLockPath(filePath) {
  return path.join(path.dirname(filePath), KERNEL_LOCK_NAME);
}

function validateCliParent(filePath) {
  const parentPath = path.dirname(filePath);
  let fd;
  try {
    fd = openSync(parentPath, DIRECTORY_FLAGS);
    const listed = lstatSync(parentPath);
    validateParentDirectory(listed);
    const opened = fstatSync(fd);
    validateParentDirectory(opened);
    if (!sameDirectoryIdentity(listed, opened)) throw failure("unsafe-parent");
  } catch (caught) {
    throw normalizeFailure(caught, "unsafe-parent");
  } finally {
    closeTracked(DEFAULT_FS, fd, "parent-close");
  }
}

function openProtectedLock(lockPath, operation) {
  let fd;
  try {
    fd = openSync(lockPath, LOCK_WRITE_FLAGS);
  } catch (error) {
    if (operation === "assert-absent" || error?.code !== "ENOENT") throw error;
    fd = openSync(lockPath, LOCK_WRITE_FLAGS | constants.O_CREAT | constants.O_EXCL, LOCK_MODE);
  }
  try {
    const opened = fstatSync(fd);
    validateLockStat(opened);
    const listed = lstatSync(lockPath);
    validateLockStat(listed);
    if (!sameIdentity(opened, listed)) throw failure("kernel-lock");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function inheritedNonceIsValid() {
  try {
    const supplied = readFileSync(0, "utf8");
    if (!/^[0-9a-f]{64}$/.test(supplied)) return false;
    const expected = process.env[INTERNAL_NONCE_ENV];
    return expected === undefined || supplied === expected;
  } catch {
    return false;
  }
}

function procFdInfo(pid, fd) {
  try {
    const fields = new Map();
    for (const line of readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8").split("\n")) {
      const separator = line.indexOf(":");
      if (separator === -1) continue;
      fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
    const pos = Number(fields.get("pos"));
    const flagsText = fields.get("flags");
    const mountId = fields.get("mnt_id");
    const inode = Number(fields.get("ino"));
    const flags = typeof flagsText === "string" ? Number.parseInt(flagsText, 8) : Number.NaN;
    if (!Number.isSafeInteger(pos) || !Number.isSafeInteger(flags) || !Number.isSafeInteger(inode) ||
        typeof mountId !== "string") {
      throw failure("kernel-lock");
    }
    return { pos, flags, mountId, inode, lock: fields.get("lock") };
  } catch (caught) {
    throw normalizeFailure(caught, "kernel-lock");
  }
}

function procFlockInfo(value) {
  if (typeof value !== "string") return undefined;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 8 || !/^\d+:$/.test(fields[0]) || fields[1] !== "FLOCK" ||
      fields[2] !== "ADVISORY" || !["READ", "WRITE"].includes(fields[3]) ||
      !/^\d+$/.test(fields[4]) || !/^\S+:\d+$/.test(fields[5]) ||
      fields[6] !== "0" || fields[7] !== "EOF") {
    return undefined;
  }
  return { mode: fields[3], pid: Number(fields[4]), deviceInode: fields[5] };
}

function procDeviceToken(dev) {
  const numeric = Number(dev);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return undefined;
  const value = BigInt(numeric);
  const major = Number(((value >> 8n) & 0xfffn) | ((value >> 32n) & 0xfffff00n));
  const minor = Number((value & 0xffn) | ((value >> 12n) & 0xffffff00n));
  return `${major.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}`;
}

function validateInheritedLock(request, lockPath = kernelLockPath(request.filePath)) {
  const rawFd = process.env[INTERNAL_LOCK_FD_ENV];
  const fd = Number(rawFd);
  const parentFd = Number(process.env[INTERNAL_PARENT_LOCK_FD_ENV]);
  if (fd !== INTERNAL_LOCK_FD || parentFd === fd || !Number.isSafeInteger(parentFd) ||
      !Number.isSafeInteger(process.pid) || process.pid <= 1 || !Number.isSafeInteger(process.ppid) || process.ppid <= 1) {
    throw failure("kernel-lock");
  }
  if (!EXCHANGE_HELPER_REALPATH_RE.test(readlinkSync(`/proc/${process.ppid}/exe`))) throw failure("kernel-lock");
  const state = fstatSync(fd);
  validateLockStat(state);
  if (readlinkSync(`/proc/self/fd/${fd}`) !== lockPath) throw failure("kernel-lock");
  const parentFdPath = `/proc/${process.ppid}/fd/${parentFd}`;
  if (readlinkSync(`/proc/self/fd/${parentFd}`) !== lockPath || readlinkSync(parentFdPath) !== lockPath) {
    throw failure("kernel-lock");
  }
  const parentState = statSync(parentFdPath);
  validateLockStat(parentState);
  if (!sameIdentity(state, parentState)) throw failure("kernel-lock");
  const listed = lstatSync(lockPath);
  validateLockStat(listed);
  if (!sameIdentity(state, listed)) throw failure("kernel-lock");
  const childOFD = procFdInfo(process.pid, fd);
  const parentOFD = procFdInfo(process.ppid, parentFd);
  if (childOFD.inode !== state.ino || childOFD.mountId === "" ||
      parentOFD.inode !== state.ino || parentOFD.mountId !== childOFD.mountId) {
    throw failure("kernel-lock");
  }
  const childLock = procFlockInfo(childOFD.lock);
  if (childLock === undefined || childLock.mode !== "WRITE" || childLock.pid !== process.pid ||
      childLock.deviceInode !== `${procDeviceToken(state.dev)}:${state.ino}`) {
    throw failure("kernel-lock");
  }
  let records;
  try {
    records = readFileSync("/proc/locks", "utf8").split("\n").map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length >= 6 && fields[1] === "FLOCK");
  } catch {
    throw failure("kernel-lock");
  }
  const matching = records.filter((fields) => {
    const deviceInode = fields[5] ?? "";
    const device = deviceInode.slice(0, deviceInode.lastIndexOf(":"));
    const inode = deviceInode.slice(deviceInode.lastIndexOf(":") + 1);
    return fields[4] === String(process.pid) && device === procDeviceToken(state.dev) && inode === String(state.ino);
  });
  if (matching.length === 0 || !matching.some((fields) => fields[3] === "WRITE")) {
    throw failure("kernel-lock");
  }
  // /proc/locks identifies the owning PID and inode, but not the owning FD.
  // A child probe inheriting FD3 distinguishes the locked OFD from a foreign
  // locked duplicate (for example, unlocked FD3 plus locked FD4).
  let probe;
  try {
    probe = spawnSync(
      "/usr/bin/flock",
      ["-n", "-x", String(fd)],
      {
        cwd: "/",
        encoding: "buffer",
        timeout: EXCHANGE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        stdio: ["ignore", "ignore", "ignore", fd, parentFd],
      },
    );
  } catch {
    throw failure("kernel-lock");
  }
  if (probe?.error !== undefined || probe?.status !== 0 || probe?.signal !== null) {
    throw failure("kernel-lock");
  }
  return fd;
}

function runLockedCli(argv, options = {}, testGate) {
  const request = testGate === undefined ? parseCli(argv) : parseAdapterCli(argv);
  if (request === undefined) return 2;
  if (!inheritedNonceIsValid()) return 2;
  try {
    validateInheritedLock(request, options.lockPath);
    return testGate === undefined
      ? runCli([request.operation, request.filePath, request.key])
      : runCliWithGate([request.operation, request.filePath, request.key], options, testGate);
  } catch {
    return 1;
  }
}

function runProductionCli(argv) {
  const request = parseCli(argv);
  if (request === undefined) return 2;
  let lockFd;
  const lockPath = kernelLockPath(request.filePath);
  try {
    validateCliParent(request.filePath);
    lockFd = openProtectedLock(lockPath, request.operation);
  } catch {
    if (lockFd !== undefined) closeSync(lockFd);
    return 1;
  }
  const nonce = Buffer.from(randomBytes(32)).toString("hex");
  let child;
  try {
    verifyHelperBinary();
    // FD4 is the already validated lock file.  FD3 is intentionally free so
    // flock opens the path into FD3, then -F execs Node in the same process.
    // Node validates that exact inherited FD3 against the retained FD4.
    child = spawnProcessTreeSync(
      ["/usr/bin/flock", "-n", "-x", "-F", lockPath, process.execPath, SCRIPT_PATH, ...argv],
      {
        encoding: "utf8",
        inheritedFds: [[4, lockFd]],
        maxBuffer: 1024,
        timeoutMs: PROCESS_TREE_TIMEOUT_MS,
        graceMs: PROCESS_TREE_GRACE_MS,
        env: {
          ...process.env,
          [INTERNAL_LOCK_FD_ENV]: String(INTERNAL_LOCK_FD),
          [INTERNAL_PARENT_LOCK_FD_ENV]: "4",
          [INTERNAL_NONCE_ENV]: nonce,
        },
        input: nonce,
      },
    );
  } catch {
    closeSync(lockFd);
    return 1;
  }
  closeSync(lockFd);
  if (child.error !== undefined || child.status !== 0 || child.stdout !== "success\n" || child.stderr !== "") return 1;
  return 0;
}

function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH);
  } catch {
    try { return path.resolve(process.argv[1]) === SCRIPT_PATH; } catch { return false; }
  }
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const internal = process.env[INTERNAL_LOCK_FD_ENV] !== undefined || process.env[INTERNAL_NONCE_ENV] !== undefined;
  const exitCode = internal ? runLockedCli(argv) : runProductionCli(argv);
  if (exitCode === 0) process.stdout.write("success\n");
  else if (!internal) process.stderr.write(exitCode === 2 ? "remove-env-entry: usage error\n" : "remove-env-entry: operation failed\n");
  process.exitCode = exitCode;
}
