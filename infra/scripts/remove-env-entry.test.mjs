import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import {
  assertAbsent as productionAssertAbsent,
  countAssignments,
  createTestAdapter,
  parseCli as productionParseCli,
  removeEnvEntry as productionRemoveEnvEntry,
  runCli as productionRunCli,
} from "./remove-env-entry.mjs";

const SCRIPT_PATH = path.join(process.cwd(), "infra/scripts/remove-env-entry.mjs");
const SCRIPT_URL = pathToFileURL(SCRIPT_PATH).href;
const KEY = "OPENROUTER_API_KEY";
const testAdapter = createTestAdapter();
const assertAbsent = testAdapter.assertAbsent;
const parseCli = testAdapter.parseCli;
const removeEnvEntry = testAdapter.removeEnvEntry;
const runCli = testAdapter.runCli;
const roots = [];

after(() => {
  for (const root of roots) nodeFs.rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "palancar-remove-env-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function makeFile(root, name, bytes, mode = 0o600) {
  const filePath = path.join(root, name);
  writeFileSync(filePath, bytes);
  chmodSync(filePath, mode);
  return filePath;
}

function operationEntries(root) {
  return readdirSync(root).filter((entry) => entry.endsWith(".op"));
}

function assertRetainedTombstones(root, filePath, secret = undefined, expectedCount = 1) {
  const entries = operationEntries(root);
  assert.equal(entries.length, expectedCount);
  return entries.map((entry) => {
    const operation = path.join(root, entry);
    const operationStat = lstatSync(operation);
    assert.equal(operationStat.mode & 0o7777, 0o700);
    assert.equal(operationStat.uid, process.getuid());
    const names = readdirSync(operation);
    assert.equal(names.length <= 32, true);
    assert.equal(names.includes("manifest"), true);
    assert.equal(names.includes(".remove-env-entry-initial"), true);
    for (const name of names) {
      const artifact = path.join(operation, name);
      const stat = lstatSync(artifact);
      assert.equal(stat.mode & 0o7777, 0o600, name);
      assert.equal(stat.nlink, 1, name);
      const bytes = readFileSync(artifact);
      assert.equal(bytes.includes(Buffer.from(KEY)), false, name);
      if (name === "manifest" || name === ".remove-env-entry-initial") {
        assert.equal(bytes.length > 0, true, name);
      } else {
        assert.equal(bytes.length, 0, name);
        if (secret !== undefined) assert.equal(bytes.includes(Buffer.from(secret)), false, name);
      }
    }
    const manifest = JSON.parse(readFileSync(path.join(operation, "manifest"), "utf8").trim().split("\n").at(-1));
    assert.equal(manifest.targetPath, filePath);
    return operation;
  });
}

function assertRetainedTombstone(root, filePath, secret = undefined) {
  return assertRetainedTombstones(root, filePath, secret, 1)[0];
}

function assertNoUnknownQuarantine(operation) {
  const manifest = JSON.parse(readFileSync(path.join(operation, "manifest"), "utf8").trim().split("\n").at(-1));
  const known = new Set([
    ...manifest.cleanup.map((record) => record.placeholder.name),
    ...manifest.cleanup.map((record) => record.tombstone?.quarantine?.name).filter(Boolean),
    ...manifest.evidence.map((record) => record.placeholder.name),
  ]);
  for (const name of readdirSync(operation).filter((entry) => entry.startsWith(".remove-env-entry-quarantine-"))) {
    assert.equal(known.has(name), true, name);
  }
}

function fsAdapter(overrides = {}) {
  return {
    closeSync: nodeFs.closeSync,
    fchmodSync: nodeFs.fchmodSync,
    fchownSync: nodeFs.fchownSync,
    fstatSync: nodeFs.fstatSync,
    fsyncSync: nodeFs.fsyncSync,
    ftruncateSync: nodeFs.ftruncateSync,
    linkSync: nodeFs.linkSync,
    lstatSync: nodeFs.lstatSync,
    mkdirSync: nodeFs.mkdirSync,
    openSync: nodeFs.openSync,
    readFileSync: nodeFs.readFileSync,
    readdirSync: nodeFs.readdirSync,
    readlinkSync: nodeFs.readlinkSync,
    realpathSync: nodeFs.realpathSync,
    renameSync: nodeFs.renameSync,
    rmdirSync: nodeFs.rmdirSync,
    unlinkSync: nodeFs.unlinkSync,
    writeSync: nodeFs.writeSync,
    ...overrides,
  };
}

function createLock(root) {
  const lockPath = path.join(root, ".remove-env-entry.kernel.lock");
  closeSync(openSync(lockPath, "w", 0o600));
  chmodSync(lockPath, 0o600);
  return lockPath;
}

function assertNoSensitiveOutput(result, sensitive) {
  assert.equal(result.stdout.includes(sensitive), false);
  assert.equal(result.stderr.includes(sensitive), false);
}

test("production entrypoints accept only the raw and normalized production target and exact key", () => {
  const root = makeRoot();
  const fixture = makeFile(root, ".env", `${KEY}=fixture\n`);
  let touched = false;
  const fs = { lstatSync() { touched = true; throw new Error("must not touch fs"); } };
  assert.equal(productionParseCli(["remove", fixture, KEY]), undefined);
  assert.equal(productionParseCli(["remove", "/home/dev/repos/palancar_ws/.env", "OTHER_KEY"]), undefined);
  assert.deepEqual(productionParseCli(["remove", "/home/dev/repos/palancar_ws/.env", KEY]), {
    operation: "remove",
    filePath: "/home/dev/repos/palancar_ws/.env",
    key: KEY,
  });
  for (const lexicalPath of [
    "/home/dev/repos/palancar_ws/./.env",
    "/home/dev/repos/palancar_ws/sub/../.env",
    "/home/dev/repos/palancar_ws/.env/../.env",
  ]) {
    assert.equal(productionParseCli(["remove", lexicalPath, KEY]), undefined);
  }
  assert.equal(productionRunCli(["remove", fixture, KEY], { fs }), 2);
  assert.throws(() => productionRemoveEnvEntry(fixture, KEY, { fs }), (error) => error.code === "usage");
  assert.throws(() => productionAssertAbsent(fixture, KEY, { fs }), (error) => error.code === "usage");
  assert.equal(touched, false);
  assert.equal(readFileSync(fixture, "utf8"), `${KEY}=fixture\n`);
});

test("removes exactly one assignment and preserves every other byte", () => {
  const root = makeRoot();
  const filePath = makeFile(
    root,
    ".env",
    "# retained\r\n" +
      "KEEP=one\n" +
      `${KEY} = \"synthetic-secret\"\r\n` +
      "QUOTED=the text OPENROUTER_API_KEY=not-an-assignment\n" +
      "TRAIL=last",
  );
  const before = lstatSync(filePath);
  removeEnvEntry(filePath, KEY);
  assert.equal(
    readFileSync(filePath, "utf8"),
    "# retained\r\nKEEP=one\nQUOTED=the text OPENROUTER_API_KEY=not-an-assignment\nTRAIL=last",
  );
  const after = lstatSync(filePath);
  assert.notEqual(after.ino, before.ino);
  assert.equal(after.mode & 0o7777, 0o600);
  assert.equal(countAssignments(readFileSync(filePath), KEY), 0);
  assertRetainedTombstone(root, filePath, "synthetic-secret");
});

test("accepts exactly the manifest cap and rejects a canonical record beyond it", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  removeEnvEntry(filePath, KEY);

  const operation = path.join(root, operationEntries(root)[0]);
  const manifestPath = path.join(operation, "manifest");
  const validManifest = readFileSync(manifestPath);
  const records = validManifest.toString("utf8").trimEnd().split("\n");
  assert.equal(records.length, 36);
  assert.equal(testAdapter.strictManifestRecords(validManifest).length, 36);

  const appendLinkedClone = (bytes) => {
    const lines = bytes.toString("utf8").trimEnd().split("\n");
    const lastLine = lines.at(-1);
    const lastRecord = JSON.parse(lastLine);
    const nextRecord = {
      ...lastRecord,
      sequence: lastRecord.sequence + 1,
      previousDigest: createHash("sha256").update(`${lastLine}\n`).digest("hex"),
    };
    return Buffer.concat([bytes, Buffer.from(`${JSON.stringify(nextRecord)}\n`, "utf8")]);
  };
  let atCap = validManifest;
  while (testAdapter.strictManifestRecords(atCap).length < 36) {
    atCap = appendLinkedClone(atCap);
  }
  assert.equal(testAdapter.strictManifestRecords(atCap).length, 36);

  const overCap = appendLinkedClone(atCap);
  assert.throws(() => testAdapter.strictManifestRecords(overCap), (error) => error.code === "temporary-cleanup");
});

test("assignment grammar handles multiline quotes and rejects an unterminated target quote", () => {
  const bytes = Buffer.from(
    "OUTER=\"first line\n" +
      `${KEY}=inside another value\n` +
      "last line\"\n" +
      `${KEY}=\"target first line\n` +
      "target last line\"\n" +
      "KEEP=one\n",
  );
  assert.equal(countAssignments(bytes, KEY), 1);
  const root = makeRoot();
  const filePath = makeFile(root, ".env", bytes);
  removeEnvEntry(filePath, KEY);
  assert.equal(readFileSync(filePath, "utf8"), "OUTER=\"first line\nOPENROUTER_API_KEY=inside another value\nlast line\"\nKEEP=one\n");

  const malformed = makeFile(root, "malformed.env", `${KEY}="unterminated\nKEEP=one\n`);
  assert.throws(() => removeEnvEntry(malformed, KEY), (error) => error.code === "malformed");
  assert.throws(() => assertAbsent(malformed, KEY), (error) => error.code === "malformed");
});

test("missing and duplicate assignments fail without mutation", () => {
  for (const content of [
    "KEEP=value\n",
    `${KEY}=first\n${KEY}=second\nKEEP=value\n`,
  ]) {
    const root = makeRoot();
    const filePath = makeFile(root, ".env", content);
    const before = readFileSync(filePath);
    const identity = lstatSync(filePath);
    assert.throws(() => removeEnvEntry(filePath, KEY));
    assert.deepEqual(readFileSync(filePath), before);
    assert.equal(lstatSync(filePath).ino, identity.ino);
    assert.deepEqual(operationEntries(root), []);
  }
});

test("manifest-less sibling recovery preserves foreign inodes and link counts", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=target\n`);
  const operation = path.join(root, `..env.remove-env-entry-${"f".repeat(32)}.op`);
  mkdirSync(operation, 0o700);
  const foreign = makeFile(operation, "candidate", "FOREIGN-SIBLING\n");
  const foreignBefore = lstatSync(foreign);
  assert.throws(() => removeEnvEntry(filePath, KEY), (error) => error.code === "recovery");
  const foreignAfter = lstatSync(foreign);
  assert.equal(foreignAfter.ino, foreignBefore.ino);
  assert.equal(foreignAfter.nlink, foreignBefore.nlink);
  assert.equal(readFileSync(foreign, "utf8"), "FOREIGN-SIBLING\n");
  assert.equal(readFileSync(filePath, "utf8"), `${KEY}=target\n`);
});

test("durable initial SIGKILLs recover only the bound empty operation and repeat safely", () => {
  for (const crashAt of [
    "after-initial-record-directory-fsync",
    "before-manifest-write",
    "after-manifest-fsync",
    "after-backup-created",
    "after-backup-fsync",
    "after-backup-manifest",
    "before-prepared",
    "after-candidate-created",
    "after-candidate-chown",
    "after-candidate-fchown",
    "after-candidate-chmod",
    "after-candidate-fchmod",
    "after-candidate-write",
    "after-candidate-partial-write-1",
    "after-candidate-fsync",
    "after-candidate-directory-fsync",
    "after-prepared",
  ]) {
    const root = makeRoot();
    const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`, 0o6750);
    const partialWrite = crashAt === "after-candidate-partial-write-1";
    const fsOption = partialWrite
      ? ", fs: { writeSync(fd, bytes, offset, length) { return nodeFs.writeSync(fd, bytes, offset, Math.min(2, length)); } }"
      : "";
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as nodeFs from "node:fs"; import(${JSON.stringify(SCRIPT_URL)}).then(({createTestAdapter}) => createTestAdapter().removeEnvEntry(${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}, {crashAt: ${JSON.stringify(crashAt)}${fsOption}}));`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.signal, "SIGKILL", crashAt);
    assert.equal(readFileSync(filePath, "utf8"), `KEEP=one\n${KEY}=target\n`);
    const operation = path.join(root, operationEntries(root)[0]);
    const operationNames = readdirSync(operation);
    const hasBackup = [
      "after-backup-created", "after-backup-fsync", "after-backup-manifest", "before-prepared",
      "after-candidate-created", "after-candidate-chown", "after-candidate-fchown",
      "after-candidate-chmod", "after-candidate-fchmod", "after-candidate-write",
      "after-candidate-partial-write-1", "after-candidate-fsync", "after-candidate-directory-fsync", "after-prepared",
    ].includes(crashAt);
    const hasCandidate = [
      "after-candidate-created", "after-candidate-chown", "after-candidate-fchown",
      "after-candidate-chmod", "after-candidate-fchmod", "after-candidate-write",
      "after-candidate-partial-write-1", "after-candidate-fsync", "after-candidate-directory-fsync", "after-prepared",
    ].includes(crashAt);
    assert.equal(operationNames.includes("backup"), hasBackup, crashAt);
    assert.equal(operationNames.includes("candidate"), hasCandidate, crashAt);
    assert.doesNotThrow(() => removeEnvEntry(filePath, KEY), crashAt);
    assert.doesNotThrow(() => assertAbsent(filePath, KEY), crashAt);
    assertRetainedTombstones(root, filePath, "target", hasBackup ? 2 : 1);
  }
});

test("null cleanup placeholders are ambiguity and never adopted", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(SCRIPT_URL)}).then(({createTestAdapter}) => createTestAdapter().removeEnvEntry(${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}, {crashAt: "after-cleanup-placeholder-reservation"}));`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.signal, "SIGKILL");
  const before = readFileSync(filePath);
  assert.throws(() => removeEnvEntry(filePath, KEY), (error) => error.code === "recovery");
  assert.deepEqual(readFileSync(filePath), before);
});

test("pre-existing target hardlinks are rejected before any operation is created", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=target\n`);
  const alias = path.join(root, "alias.env");
  nodeFs.linkSync(filePath, alias);
  const before = lstatSync(filePath);
  assert.equal(before.nlink, 2);
  assert.throws(() => removeEnvEntry(filePath, KEY), (error) => error.code === "hardlink");
  assert.equal(lstatSync(filePath).ino, before.ino);
  assert.equal(lstatSync(filePath).nlink, 2);
  assert.equal(readFileSync(alias, "utf8"), `${KEY}=target\n`);
  assert.deepEqual(operationEntries(root), []);
});

test("racing hardlinks fail closed before sensitive cleanup and preserve the alias", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=target\n`);
  const alias = path.join(root, "alias.env");
  let linked = false;
  let caught;
  try {
    removeEnvEntry(filePath, KEY, {
      beforeHelperUnlink({ sensitive, name, path: helperPath }) {
        if (!linked && sensitive && name.startsWith(".remove-env-entry-quarantine-")) {
          linked = true;
          nodeFs.linkSync(helperPath, alias);
        }
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(linked, true);
  assert.equal(Boolean(caught?.recoveryPath), true);
  assert.equal(readFileSync(alias, "utf8"), `${KEY}=target\n`);
  assert.equal(lstatSync(alias).nlink >= 2, true);
});

test("assert-absent is read-only and revalidates descriptor, path, and content", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", "KEEP=value\n");
  const before = lstatSync(filePath);
  const fs = fsAdapter({
    fchmodSync() { throw new Error("assert-absent must not chmod"); },
    fchownSync() { throw new Error("assert-absent must not chown"); },
    fsyncSync() { throw new Error("assert-absent must not fsync"); },
    linkSync() { throw new Error("assert-absent must not link"); },
    mkdirSync() { throw new Error("assert-absent must not mkdir"); },
    renameSync() { throw new Error("assert-absent must not rename"); },
    rmdirSync() { throw new Error("assert-absent must not rmdir"); },
    unlinkSync() { throw new Error("assert-absent must not unlink"); },
    writeSync() { throw new Error("assert-absent must not write"); },
  });
  assert.doesNotThrow(() => assertAbsent(filePath, KEY, { fs }));
  const after = lstatSync(filePath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(operationEntries(root), []);

  writeFileSync(filePath, `${KEY}=present\n`);
  assert.throws(() => assertAbsent(filePath, KEY), (error) => error.code === "assignment-present");
});

test("symlinks and directories are refused before reading or writing", () => {
  const root = makeRoot();
  const target = makeFile(root, "target.env", `${KEY}=value\n`);
  const link = path.join(root, "link.env");
  symlinkSync(target, link);
  assert.throws(() => removeEnvEntry(link, KEY));
  assert.throws(() => assertAbsent(link, KEY));
  const directory = path.join(root, "directory.env");
  mkdirSync(directory, 0o700);
  assert.throws(() => removeEnvEntry(directory, KEY), (error) => error.code === "not-regular");
  assert.throws(() => assertAbsent(directory, KEY), (error) => error.code === "not-regular");
  assert.equal(readFileSync(target, "utf8"), `${KEY}=value\n`);
});

test("publication uses one atomic RENAME_EXCHANGE from the private operation directory", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  const exchanges = [];
  const fs = fsAdapter({
    renameSync() { throw new Error("publication must not use rename"); },
  });
  removeEnvEntry(filePath, KEY, { fs, beforeExchange(event) { if (event.kind === "publication") exchanges.push(event); } });
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].sourcePath.endsWith("/candidate"), true);
  assert.equal(exchanges[0].targetPath, filePath);
  assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n");
  assertRetainedTombstone(root, filePath, "target");
});

test("a candidate pathname substitution is rejected and the foreign inode is never unlinked", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  let swapped = false;
  const fs = fsAdapter({
    lstatSync(candidate) {
      if (!swapped && candidate.endsWith("/candidate")) {
        swapped = true;
        nodeFs.unlinkSync(candidate);
        nodeFs.writeFileSync(candidate, "FOREIGN-CANDIDATE\n", { mode: 0o600 });
      }
      return nodeFs.lstatSync(candidate);
    },
  });
  let caught;
  try {
    removeEnvEntry(filePath, KEY, { fs });
  } catch (error) {
    caught = error;
  }
  assert.equal(["file-changed", "temporary-cleanup"].includes(caught.code), true);
  assert.equal(readFileSync(filePath, "utf8"), `KEEP=one\n${KEY}=target\n`);
  assert.equal(Boolean(caught.recoveryPath), true);
  const operation = caught.recoveryPath.endsWith(".op")
    ? caught.recoveryPath
    : path.dirname(caught.recoveryPath);
  assert.equal(readdirSync(operation).includes("candidate"), true);
  assert.equal(readFileSync(path.join(operation, "candidate"), "utf8"), "FOREIGN-CANDIDATE\n");
});

test("a late candidate substitution is quarantined before the verified backup is restored", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  const fs = fsAdapter();
  let caught;
  try {
    removeEnvEntry(filePath, KEY, {
      fs,
      beforeExchange({ kind, sourcePath, targetPath }) {
        if (kind === "publication" && sourcePath.endsWith("/candidate") && targetPath === filePath) {
          nodeFs.unlinkSync(sourcePath);
          nodeFs.writeFileSync(sourcePath, "FOREIGN-INSTALLED\n", { mode: 0o600 });
        }
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(readFileSync(filePath, "utf8"), `KEEP=one\n${KEY}=target\n`);
  assert.equal(Boolean(caught?.recoveryPath), true);
  const operation = caught.recoveryPath.endsWith(".op")
    ? caught.recoveryPath
    : path.dirname(caught.recoveryPath);
  const foreignEntry = readdirSync(operation).find((entry) => entry.startsWith(".remove-env-entry-quarantine-foreign-target-"));
  assert.notEqual(foreignEntry, undefined);
  assert.equal(readFileSync(path.join(operation, foreignEntry), "utf8"), "FOREIGN-INSTALLED\n");
});

test("candidate mode and digest are revalidated immediately after publication", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  const fs = fsAdapter();
  let caught;
  try {
    removeEnvEntry(filePath, KEY, {
      fs,
      beforeExchange({ kind, sourcePath, targetPath }) {
        if (kind === "publication" && sourcePath.endsWith("/candidate") && targetPath === filePath) {
          nodeFs.chmodSync(sourcePath, 0o640);
        }
      },
    });
  } catch (error) { caught = error; }
  assert.equal(Boolean(caught?.recoveryPath), true);
  assert.equal(readFileSync(filePath, "utf8"), `KEEP=one\n${KEY}=target\n`);
  assert.equal(existsSync(filePath), true);
  const operation = caught.recoveryPath.endsWith(".op")
    ? caught.recoveryPath
    : path.dirname(caught.recoveryPath);
  const foreign = readdirSync(operation).find((entry) => entry.startsWith(".remove-env-entry-quarantine-foreign-target-"));
  assert.notEqual(foreign, undefined);
  assert.equal(readFileSync(path.join(operation, foreign), "utf8"), "KEEP=one\n");
});

test("an exchanged foreign destination is preserved at a private path", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  const fs = fsAdapter();
  let caught;
  try {
    removeEnvEntry(filePath, KEY, {
      fs,
      beforeExchange({ kind, targetPath }) {
        if (kind === "publication" && targetPath === filePath) {
          nodeFs.unlinkSync(filePath);
          nodeFs.writeFileSync(filePath, "FOREIGN-INSTALLED\n", { mode: 0o600 });
        }
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(readFileSync(filePath, "utf8"), `KEEP=one\n${KEY}=target\n`);
  assert.equal(Boolean(caught?.recoveryPath), true);
  const operation = caught.recoveryPath.endsWith(".op")
    ? caught.recoveryPath
    : path.dirname(caught.recoveryPath);
  const foreignEntries = readdirSync(operation).filter((entry) => entry.startsWith(".remove-env-entry-quarantine-foreign-candidate-"));
  assert.equal(foreignEntries.length, 1);
  assert.equal(readFileSync(path.join(operation, foreignEntries[0]), "utf8"), "FOREIGN-INSTALLED\n");
});

test("a same-inode write at the rename boundary is restored without loss", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  const fs = fsAdapter();
  assert.throws(
    () => removeEnvEntry(filePath, KEY, {
      fs,
      beforeExchange({ kind, targetPath }) {
        if (kind === "publication" && targetPath === filePath) nodeFs.writeFileSync(filePath, "KEEP=concurrent\n");
      },
    }),
    (error) => ["file-changed", "temporary-cleanup"].includes(error.code),
  );
  assert.equal(readFileSync(filePath, "utf8"), "KEEP=concurrent\n");
  if (operationEntries(root).length !== 0) {
    const operation = path.join(root, operationEntries(root)[0]);
    assert.equal(readdirSync(operation).some((entry) => entry.startsWith(".remove-env-entry-quarantine-foreign-candidate-")), true);
  }
});

test("pre-rename failures clean only operation-owned entries", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  const before = readFileSync(filePath);
  const fs = fsAdapter();
  assert.throws(() => removeEnvEntry(filePath, KEY, {
    fs,
    beforeExchange({ kind }) { if (kind === "publication") throw new Error("exchange failure"); },
  }));
  assert.deepEqual(readFileSync(filePath), before);
  assertRetainedTombstone(root, filePath, "target");
});

test("cleanup substitution uses an exclusive placeholder exchange and never deletes the foreign inode", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  const fs = fsAdapter();
  let caught;
  try {
    removeEnvEntry(filePath, KEY, {
      fs,
      beforeExchange({ kind, sourcePath }) {
        if (kind === "cleanup" && sourcePath.endsWith("/candidate")) {
          nodeFs.unlinkSync(sourcePath);
          nodeFs.writeFileSync(sourcePath, "FOREIGN-CLEANUP\n", { mode: 0o600 });
        }
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n");
  assert.equal(Boolean(caught?.recoveryPath), true);
  const operation = caught.recoveryPath.endsWith(".op")
    ? caught.recoveryPath
    : path.dirname(caught.recoveryPath);
  const foreignEntry = readdirSync(operation).find((entry) => entry.startsWith(".remove-env-entry-quarantine-candidate-"));
  assert.notEqual(foreignEntry, undefined);
  assert.equal(readFileSync(path.join(operation, foreignEntry), "utf8"), "FOREIGN-CLEANUP\n");
});

test("manifest fsync failure preserves the bound recovery artifact", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=target\n`);
  let failed = false;
  const fs = fsAdapter({
    fsyncSync(fd) {
      let descriptorPath = "";
      try { descriptorPath = nodeFs.readlinkSync(`/proc/self/fd/${fd}`); } catch {}
      if (!failed && descriptorPath.endsWith("/manifest")) {
        failed = true;
        throw new Error("manifest fsync");
      }
      return nodeFs.fsyncSync(fd);
    },
  });
  assert.throws(() => removeEnvEntry(filePath, KEY, { fs }), (error) => ["manifest", "temporary-cleanup"].includes(error.code));
  assert.equal(readFileSync(filePath, "utf8"), `${KEY}=target\n`);
  assert.equal(operationEntries(root).length, 1);
  assert.throws(() => assertAbsent(filePath, KEY), (error) => error.code === "recovery");
});

test("partial writes and every candidate/manifest fsync ordering failure remain pre-rename safe", () => {
  const partialRoot = makeRoot();
  const partialPath = makeFile(partialRoot, ".env", `KEEP=one\n${KEY}=target\n`);
  const partialFs = fsAdapter({
    writeSync(fd, bytes, offset, length) {
      return nodeFs.writeSync(fd, bytes, offset, Math.min(2, length));
    },
  });
  removeEnvEntry(partialPath, KEY, { fs: partialFs });
  assert.equal(readFileSync(partialPath, "utf8"), "KEEP=one\n");

  const journalRoot = makeRoot();
  const journalPath = makeFile(journalRoot, ".env", `${KEY}=target\n`);
  removeEnvEntry(journalPath, KEY);
  const journalOperation = path.join(journalRoot, operationEntries(journalRoot)[0]);
  const manifestPath = path.join(journalOperation, "manifest");
  const validManifest = readFileSync(manifestPath);
  writeFileSync(manifestPath, Buffer.concat([validManifest, Buffer.from('{"partial"', "utf8")]));
  const truncated = [];
  const recoveryFs = fsAdapter({
    ftruncateSync(fd, length) {
      const descriptorPath = nodeFs.readlinkSync(`/proc/self/fd/${fd}`);
      truncated.push(descriptorPath);
      assert.equal(descriptorPath, manifestPath);
      return nodeFs.ftruncateSync(fd, length);
    },
  });
  assert.doesNotThrow(() => assertAbsent(journalPath, KEY, { fs: recoveryFs }));
  assert.deepEqual(truncated, [manifestPath]);
  assert.deepEqual(readFileSync(manifestPath), validManifest);

  for (const failingFsync of [1, 2, 3, 4]) {
    const root = makeRoot();
    const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
    let fsyncs = 0;
    const fs = fsAdapter({
      fsyncSync(fd) {
        fsyncs += 1;
        if (fsyncs === failingFsync) throw new Error(`fsync ${failingFsync}`);
        return nodeFs.fsyncSync(fd);
      },
    });
    assert.throws(() => removeEnvEntry(filePath, KEY, { fs }));
    assert.equal(readFileSync(filePath, "utf8"), `KEEP=one\n${KEY}=target\n`);
    assert.equal(existsSync(filePath), true);
  }
});

test("candidate preparation failures retain bounded operation artifacts", () => {
  for (const stage of ["fchmodSync", "fchownSync", "writeSync"]) {
    const root = makeRoot();
    const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
    const fs = fsAdapter({
      [stage]() {
        throw new Error(`${stage} failure`);
      },
    });
    assert.throws(() => removeEnvEntry(filePath, KEY, { fs }));
    assert.equal(readFileSync(filePath, "utf8"), `KEEP=one\n${KEY}=target\n`);
    if (stage === "fchownSync") {
      assertRetainedTombstones(root, filePath, "target");
    } else {
      const entries = operationEntries(root);
      assert.equal(entries.length, 1);
      const operation = path.join(root, entries[0]);
      assert.equal(lstatSync(operation).mode & 0o7777, 0o700);
      assert.deepEqual(readdirSync(operation), [".remove-env-entry-initial"]);
      const initial = readFileSync(path.join(operation, ".remove-env-entry-initial"));
      assert.equal(initial.length <= 128 * 1024, true);
      if (initial.length !== 0) assert.doesNotThrow(() => JSON.parse(initial));
    }
  }
});

test("bound parent leaves no private operation directory after publication", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=target\n`);
  assert.doesNotThrow(() => removeEnvEntry(filePath, KEY));
  assertRetainedTombstone(root, filePath, "target");
});

test("stale operation directories recover both sides of a SIGKILL boundary", () => {
  for (const crashAt of ["before-rename", "after-rename"]) {
    const root = makeRoot();
    const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(SCRIPT_URL)}).then(({createTestAdapter}) => createTestAdapter().removeEnvEntry(${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}, {crashAt: ${JSON.stringify(crashAt)}}));`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.signal, "SIGKILL", crashAt);
    if (crashAt === "before-rename") {
      removeEnvEntry(filePath, KEY);
    } else {
      assert.throws(() => removeEnvEntry(filePath, KEY), (error) => error.code === "assignment-absent");
    }
    assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n");
    assertRetainedTombstones(root, filePath, "target", crashAt === "before-rename" ? 2 : 1);
  }
});

test("fsync covers operation, quarantine, publication parent, and recovery parent", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=target\n`);
  const syncedPaths = [];
  const fs = fsAdapter({
    fsyncSync(fd) {
      try { syncedPaths.push(nodeFs.readlinkSync(`/proc/self/fd/${fd}`)); } catch {}
      return nodeFs.fsyncSync(fd);
    },
  });
  removeEnvEntry(filePath, KEY, { fs });
  assert.equal(syncedPaths.some((entry) => entry === root), true);
  assert.equal(syncedPaths.some((entry) => entry.endsWith(".op")), true);

  const recoveryRoot = makeRoot();
  const recoveryPath = makeFile(recoveryRoot, ".env", `${KEY}=target\n`);
  const crashed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(SCRIPT_URL)}).then(({createTestAdapter}) => createTestAdapter().removeEnvEntry(${JSON.stringify(recoveryPath)}, ${JSON.stringify(KEY)}, {crashAt: "after-rename"}));`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(crashed.signal, "SIGKILL");
  const recoverySyncedPaths = [];
  const recoveryFs = fsAdapter({
    fsyncSync(fd) {
      try { recoverySyncedPaths.push(nodeFs.readlinkSync(`/proc/self/fd/${fd}`)); } catch {}
      return nodeFs.fsyncSync(fd);
    },
  });
  assert.throws(
    () => removeEnvEntry(recoveryPath, KEY, { fs: recoveryFs }),
    (error) => error.code === "assignment-absent",
  );
  assert.equal(recoverySyncedPaths.some((entry) => entry === recoveryRoot), true);
  assert.equal(recoverySyncedPaths.some((entry) => entry.endsWith(".op")), true);
  assert.equal(existsSync(recoveryPath), true);
});

test("SIGKILL at each rollback point preserves a present target and recovery restores the verified backup", () => {
  for (const point of [
    "after-rollback-preserve",
    "before-rollback-rename",
    "after-rollback-rename",
    "after-restore",
  ]) {
    const root = makeRoot();
    const filePath = makeFile(root, ".env", `${KEY}=target\n`);
    const childCode =
      `import * as nodeFs from "node:fs";` +
      `import { createTestAdapter } from ${JSON.stringify(SCRIPT_URL)};` +
      `const { removeEnvEntry } = createTestAdapter();` +
      `let substituted = false;` +
      `removeEnvEntry(${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}, {crashAt: ${JSON.stringify(point)},` +
      `beforeExchange({kind, targetPath}) { if (kind === "publication" && !substituted && targetPath === ${JSON.stringify(filePath)}) {` +
      `substituted = true; nodeFs.unlinkSync(targetPath); nodeFs.writeFileSync(targetPath, "FOREIGN-ROLLBACK\\n", {mode: 0o600}); } }});`;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], { encoding: "utf8" });
    assert.equal(crashed.signal, "SIGKILL", point);
    assert.equal(existsSync(filePath), true, point);

    let recoveryError;
    try { removeEnvEntry(filePath, KEY); } catch (error) { recoveryError = error; }
    assert.equal(existsSync(filePath), true, point);
    assert.equal(readFileSync(filePath, "utf8"), `${KEY}=target\n`, point);
    assert.equal(Boolean(recoveryError?.recoveryPath), true, point);
    const operation = recoveryError.recoveryPath.endsWith(".op")
      ? recoveryError.recoveryPath
      : path.dirname(recoveryError.recoveryPath);
    const preserved = readdirSync(operation).filter((entry) => entry.startsWith(".remove-env-entry-quarantine-"));
    assert.equal(preserved.some((entry) => readFileSync(path.join(operation, entry), "utf8") === "FOREIGN-ROLLBACK\n"), true, point);
  }
});

test("the helper-backed exchange swaps the inode while preserving exact restrictive metadata", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`, 0o0400);
  const before = lstatSync(filePath);
  removeEnvEntry(filePath, KEY);
  const after = lstatSync(filePath);
  assert.notEqual(after.ino, before.ino);
  assert.equal(after.mode & 0o7777, 0o0400);
  assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n");
  assertRetainedTombstone(root, filePath, "target");
});

test("destination substitution during helper exchange is preserved privately and rollback is durable", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=target\n`);
  let substituted = false;
  let caught;
  try {
    removeEnvEntry(filePath, KEY, {
      beforeExchange({ kind, targetPath }) {
        if (kind === "publication" && !substituted) {
          substituted = true;
          nodeFs.unlinkSync(targetPath);
          nodeFs.writeFileSync(targetPath, "FOREIGN-DESTINATION\n", { mode: 0o600 });
        }
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, "temporary-cleanup");
  assert.equal(readFileSync(filePath, "utf8"), `${KEY}=target\n`);
  const operation = caught.recoveryPath.endsWith(".op")
    ? caught.recoveryPath
    : path.dirname(caught.recoveryPath);
  const preserved = readdirSync(operation).find((entry) => entry.startsWith(".remove-env-entry-quarantine-foreign-candidate-"));
  assert.notEqual(preserved, undefined);
  assert.equal(readFileSync(path.join(operation, preserved), "utf8"), "FOREIGN-DESTINATION\n");
});

test("SIGKILL immediately after exchange is recovered from the durable manifest", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(SCRIPT_URL)}).then(({createTestAdapter}) => createTestAdapter().removeEnvEntry(${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}, {crashAt: "after-exchange"}));`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.signal, "SIGKILL");
  assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n");
  assert.throws(() => removeEnvEntry(filePath, KEY), (error) => error.code === "assignment-absent");
  assertRetainedTombstone(root, filePath, "target");
});

test("parent binding rejects group-writable and symlinked parent namespaces", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=value\n`);
  chmodSync(root, 0o770);
  assert.throws(() => removeEnvEntry(filePath, KEY), (error) => error.code === "unsafe-parent");
  assert.throws(() => assertAbsent(filePath, KEY), (error) => error.code === "unsafe-parent");

  const safeRoot = makeRoot();
  const linkedParent = path.join(safeRoot, "linked");
  symlinkSync(root, linkedParent);
  const throughLink = path.join(linkedParent, ".env");
  assert.throws(() => removeEnvEntry(throughLink, KEY));
  assert.equal(readFileSync(filePath, "utf8"), `${KEY}=value\n`);
});

test("candidate owner and exact mode are set before its first content write", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`, 0o0400);
  const events = [];
  const fs = fsAdapter({
    fchownSync(fd, uid, gid) {
      events.push(["chown", uid, gid]);
      return nodeFs.fchownSync(fd, uid, gid);
    },
    fchmodSync(fd, mode) {
      events.push(["chmod", mode & 0o7777]);
      return nodeFs.fchmodSync(fd, mode);
    },
    writeSync(...args) {
      let descriptorPath = "";
      try { descriptorPath = nodeFs.readlinkSync(`/proc/self/fd/${args[0]}`); } catch {}
      events.push(["write", descriptorPath]);
      return nodeFs.writeSync(...args);
    },
  });
  removeEnvEntry(filePath, KEY, { fs });
  const firstWrite = events.findIndex(([kind, descriptorPath]) => kind === "write" && descriptorPath.endsWith("/candidate"));
  const ownerSet = events.findIndex(([kind]) => kind === "chown");
  const exactMode = events.findIndex(([kind, mode]) => kind === "chmod" && mode === 0o0400);
  assert.equal(ownerSet >= 0 && ownerSet < firstWrite, true);
  assert.equal(exactMode >= 0 && exactMode < firstWrite, true);
});

test("post-publication, rollback, cleanup, and recovery fsync failures remain recoverable", () => {
  const run = (content, options, expectedAfterFailure, recover) => {
    const root = makeRoot();
    const filePath = makeFile(root, ".env", content);
    let failed = false;
    const fs = fsAdapter({
      fsyncSync(fd) {
        let descriptorPath = "";
        try { descriptorPath = nodeFs.readlinkSync(`/proc/self/fd/${fd}`); } catch {}
        if (!failed && options.shouldFail(descriptorPath)) {
          failed = true;
          throw new Error("injected fsync failure");
        }
        return nodeFs.fsyncSync(fd);
      },
    });
    let caught;
    try { removeEnvEntry(filePath, KEY, { fs, beforeExchange: options.beforeExchange }); } catch (error) { caught = error; }
    assert.equal(Boolean(caught?.recoveryPath), true);
    assert.equal(readFileSync(filePath, "utf8"), expectedAfterFailure);
    recover(filePath);
  };

  const publicationState = {};
  run(`KEEP=one\n${KEY}=target\n`, {
    shouldFail(descriptorPath) { return publicationState.publication && !publicationState.cleanup && !descriptorPath.includes(".op"); },
    beforeExchange({ kind }) { if (kind === "publication") publicationState.publication = true; },
  }, "KEEP=one\n", (filePath) => {
    try { removeEnvEntry(filePath, KEY); } catch {}
    assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n");
  });

  const rollbackState = {};
  run(`KEEP=one\n${KEY}=target\n`, {
    shouldFail(descriptorPath) { return rollbackState.publication && descriptorPath.includes(".op"); },
    beforeExchange({ kind, targetPath }) {
      if (kind === "publication") {
        rollbackState.publication = true;
        nodeFs.unlinkSync(targetPath);
        nodeFs.writeFileSync(targetPath, "FOREIGN-FSYNC\n", { mode: 0o600 });
      }
    },
  }, "KEEP=one\n", (filePath) => {
    try { removeEnvEntry(filePath, KEY); } catch {}
    assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n");
  });

  const cleanupState = {};
  run(`KEEP=one\n${KEY}=target\n`, {
    shouldFail(descriptorPath) { return cleanupState.cleanup && descriptorPath.includes(".op"); },
    beforeExchange({ kind }) { if (kind === "cleanup") cleanupState.cleanup = true; },
  }, "KEEP=one\n", (filePath) => {
    try { removeEnvEntry(filePath, KEY); } catch {}
    assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n");
  });

  const recoveryRoot = makeRoot();
  const recoveryPath = makeFile(recoveryRoot, ".env", `KEEP=one\n${KEY}=target\n`);
  const crashed = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import(${JSON.stringify(SCRIPT_URL)}).then(({createTestAdapter}) => createTestAdapter().removeEnvEntry(${JSON.stringify(recoveryPath)}, ${JSON.stringify(KEY)}, {crashAt: "after-exchange"}));`],
    { encoding: "utf8" },
  );
  assert.equal(crashed.signal, "SIGKILL");
  let recoveryFailed = false;
  const recoveryFs = fsAdapter({
    fsyncSync(fd) {
      if (!recoveryFailed) {
        recoveryFailed = true;
        throw new Error("recovery fsync failure");
      }
      return nodeFs.fsyncSync(fd);
    },
  });
  assert.throws(() => removeEnvEntry(recoveryPath, KEY, { fs: recoveryFs }));
  try { removeEnvEntry(recoveryPath, KEY); } catch {}
  assert.equal(readFileSync(recoveryPath, "utf8"), "KEEP=one\n");
});

test("production CLI rejects fixture paths before lock creation while the adapter handles fixtures", () => {
  const root = makeRoot();
  const removable = makeFile(root, "remove.env", `${KEY}=synthetic-secret\n`);
  const removeResult = spawnSync(process.execPath, [SCRIPT_PATH, "remove", removable, KEY], { encoding: "utf8" });
  assert.equal(removeResult.status, 2);
  assert.equal(readFileSync(removable, "utf8"), `${KEY}=synthetic-secret\n`);
  assert.equal(existsSync(path.join(root, ".remove-env-entry.kernel.lock")), false);
  assert.equal(runCli(["remove", removable, KEY]), 0);
  assert.equal(readFileSync(removable, "utf8"), "");

  const absentRoot = makeRoot();
  const absent = makeFile(absentRoot, "absent.env", "KEEP=synthetic-secret\n");
  const noLock = spawnSync(process.execPath, [SCRIPT_PATH, "assert-absent", absent, KEY], { encoding: "utf8" });
  assert.equal(noLock.status, 2);
  assert.equal(existsSync(path.join(absentRoot, ".remove-env-entry.kernel.lock")), false);
});

test("static public lock markers cannot enter the production path", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=synthetic\n`);
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--remove-env-entry-locked", "remove", filePath, KEY],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(filePath, "utf8"), `${KEY}=synthetic\n`);
});

test("locked mode rejects direct marker/env/stdin forgery before fixture access", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=synthetic\n`);
  const lockPath = createLock(root);
  const nonce = "a".repeat(64);
  const directFd = openSync(lockPath, "r");
  let direct;
  try {
    direct = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "remove", filePath, KEY],
      {
        encoding: "utf8",
        input: nonce,
        env: {
          ...process.env,
          REMOVE_ENV_ENTRY_LOCK_FD: "3",
          REMOVE_ENV_ENTRY_NONCE: nonce,
        },
        stdio: ["pipe", "pipe", "pipe", directFd],
      },
    );
  } finally {
    closeSync(directFd);
  }
  assert.notEqual(direct.status, 0);
  assert.equal(readFileSync(filePath, "utf8"), `${KEY}=synthetic\n`);

  const external = spawnSync(
    "/usr/bin/flock",
    [lockPath, process.execPath, SCRIPT_PATH, "remove", filePath, KEY],
    {
      encoding: "utf8",
      input: nonce,
      env: { ...process.env, REMOVE_ENV_ENTRY_LOCK_FD: "3" },
    },
  );
  assert.equal(external.status, 2);
  assert.equal(readFileSync(filePath, "utf8"), `${KEY}=synthetic\n`);
});

test("internal lock validation never becomes a fixture adapter", () => {
  const root = makeRoot();
  const lockPath = createLock(root);
  const nonce = "b".repeat(64);
  const env = {
    ...process.env,
    REMOVE_ENV_ENTRY_LOCK_FD: "3",
    REMOVE_ENV_ENTRY_NONCE: nonce,
  };
  const runLocked = (lockMode, operation, filePath) => spawnSync(
    "/usr/bin/flock",
    [lockMode, lockPath, process.execPath, SCRIPT_PATH, operation, filePath, KEY],
    { encoding: "utf8", input: nonce, env },
  );

  const removePath = makeFile(root, "shared-remove.env", `${KEY}=value\n`);
  const sharedRemove = runLocked("-s", "remove", removePath);
  assert.notEqual(sharedRemove.status, 0);
  assert.equal(readFileSync(removePath, "utf8"), `${KEY}=value\n`);

  const absentPath = makeFile(root, "shared-absent.env", "KEEP=value\n");
  assert.equal(runLocked("-s", "assert-absent", absentPath).status, 2);
  assert.equal(runLocked("-x", "assert-absent", absentPath).status, 2);

  const unlocked = spawnSync(
    "/usr/bin/flock",
    ["-u", lockPath, process.execPath, SCRIPT_PATH, "assert-absent", absentPath, KEY],
    { encoding: "utf8", input: nonce, env },
  );
  assert.equal(unlocked.status, 2);
  assert.equal(readFileSync(absentPath, "utf8"), "KEEP=value\n");
});

test("private flock concurrency is held on the inherited pinned descriptor", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.equal(source.includes("[\"/usr/bin/flock\", \"-n\", \"-x\", \"-F\", lockPath"), true);
  assert.equal(source.includes("inheritedFds: [[4, lockFd]]"), true);
  assert.equal(source.includes("/proc/locks"), true);
  assert.equal(source.includes("start_new_session=True"), true);
  assert.equal(source.includes("os.killpg(pid,signal.SIGKILL)"), true);
  const root = makeRoot();
  const filePath = makeFile(root, ".env", "KEEP=value\n");
  const lockPath = createLock(root);
  const nonce = "00000001" + "a".repeat(56);
  const lockFd = openSync(lockPath, "r+");
  const childCode =
    `import { createTestAdapter } from ${JSON.stringify(SCRIPT_URL)};` +
    `const result = createTestAdapter().runLocked(["assert-absent", ${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}], {lockPath: ${JSON.stringify(lockPath)}});` +
    "process.stdout.write(`inherited-lock-validation:${result}\\n`);" +
    "process.exit(result);";
  let result;
  try {
    result = testAdapter.runProcessTree(
      ["/usr/bin/flock", "-n", "-x", "-F", lockPath, process.execPath, "--input-type=module", "-e", childCode],
      {
        inheritedFds: [[4, lockFd]],
        env: {
          ...process.env,
          REMOVE_ENV_ENTRY_LOCK_FD: "3",
          REMOVE_ENV_ENTRY_PARENT_LOCK_FD: "4",
          REMOVE_ENV_ENTRY_NONCE: nonce,
        },
        input: nonce,
      },
    );
  } finally {
    closeSync(lockFd);
  }
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "inherited-lock-validation:0\n");
  assert.equal(readFileSync(filePath, "utf8"), "KEEP=value\n");
});

test("unlocked FD3 with a locked duplicate FD4 is rejected before mutation", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=synthetic\n`);
  const lockPath = createLock(root);
  const unlockedFd = openSync(lockPath, "r+");
  const lockedFd = openSync(lockPath, "r+");
  const nonce = "d".repeat(64);
  const childCode =
    `import { createTestAdapter } from ${JSON.stringify(SCRIPT_URL)};` +
    `const result = createTestAdapter().runLocked(["remove", ${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}], {lockPath: ${JSON.stringify(lockPath)}});` +
    "process.stdout.write(`inherited-lock-validation:${result}\\n`);" +
    "process.exit(result);";
  const lockPython =
    "import fcntl,os,sys;" +
    "fcntl.flock(4, fcntl.LOCK_EX | fcntl.LOCK_NB);" +
    "os.execv(sys.argv[1], sys.argv[1:]);";
  let result;
  try {
    result = testAdapter.runProcessTree(
      ["/usr/bin/python3", "-c", lockPython, process.execPath, "--input-type=module", "-e", childCode],
      {
        inheritedFds: [[3, unlockedFd], [4, lockedFd]],
        env: {
          ...process.env,
          REMOVE_ENV_ENTRY_LOCK_FD: "3",
          REMOVE_ENV_ENTRY_PARENT_LOCK_FD: "4",
          REMOVE_ENV_ENTRY_NONCE: nonce,
        },
        input: nonce,
      },
    );
  } finally {
    closeSync(unlockedFd);
    closeSync(lockedFd);
  }
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "inherited-lock-validation:1\n");
  assert.equal(readFileSync(filePath, "utf8"), `${KEY}=synthetic\n`);
  assert.deepEqual(operationEntries(root), []);
});

test("shared FD3 is rejected by inherited lock validation", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", "KEEP=value\n");
  const lockPath = createLock(root);
  const lockFd = openSync(lockPath, "r+");
  const nonce = "e".repeat(64);
  const childCode =
    `import { createTestAdapter } from ${JSON.stringify(SCRIPT_URL)};` +
    `const result = createTestAdapter().runLocked(["assert-absent", ${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}], {lockPath: ${JSON.stringify(lockPath)}});` +
    "process.stdout.write(`inherited-lock-validation:${result}\\n`);" +
    "process.exit(result);";
  let result;
  try {
    result = testAdapter.runProcessTree(
      ["/usr/bin/flock", "-n", "-s", "-F", lockPath, process.execPath, "--input-type=module", "-e", childCode],
      {
        inheritedFds: [[4, lockFd]],
        env: {
          ...process.env,
          REMOVE_ENV_ENTRY_LOCK_FD: "3",
          REMOVE_ENV_ENTRY_PARENT_LOCK_FD: "4",
          REMOVE_ENV_ENTRY_NONCE: nonce,
        },
        input: nonce,
      },
    );
  } finally {
    closeSync(lockFd);
  }
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "inherited-lock-validation:1\n");
  assert.equal(readFileSync(filePath, "utf8"), "KEEP=value\n");
  assert.deepEqual(operationEntries(root), []);
});

test("lock mode validation requires owner read/write coverage and no group/world permissions", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", "KEEP=value\n");
  const lockPath = createLock(root);
  for (const mode of [0o400, 0o640, 0o604]) {
    chmodSync(lockPath, mode);
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "assert-absent", filePath, KEY], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(readFileSync(filePath, "utf8"), "KEEP=value\n");
  }
  chmodSync(lockPath, 0o600);
  const success = spawnSync(process.execPath, [SCRIPT_PATH, "assert-absent", filePath, KEY], { encoding: "utf8" });
  assert.equal(success.status, 2);
});

test("target ownership is required for remove and assert-absent at every stat boundary", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=value\n`);
  const uid = process.getuid();
  assert.notEqual(uid, undefined);
  for (const boundary of ["lstatSync", "fstatSync"]) {
    const fs = fsAdapter({
      [boundary](...args) {
        const stat = nodeFs[boundary](...args);
        if (args[0] === filePath || (boundary === "fstatSync" && stat.uid === uid)) {
          return { ...stat, uid: uid + 1 };
        }
        return stat;
      },
    });
    assert.throws(() => removeEnvEntry(filePath, KEY, { fs }), (error) => ["unsafe-owner", "unsafe-parent"].includes(error.code));
    assert.throws(() => assertAbsent(filePath, KEY, { fs }), (error) => ["unsafe-owner", "unsafe-parent"].includes(error.code));
    assert.equal(readFileSync(filePath, "utf8"), `${KEY}=value\n`);
  }
});

test("target permission and special bits are preserved", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`, 0o6750);
  removeEnvEntry(filePath, KEY);
  assert.equal(lstatSync(filePath).mode & 0o7777, 0o6750);
  assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n");
});

test("CLI rejects fixture paths without exposing key or value", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=synthetic-secret-value\n`);
  const cliLink = path.join(root, "remove-env-entry");
  symlinkSync(SCRIPT_PATH, cliLink);
  const result = spawnSync(process.execPath, [cliLink, "remove", filePath, KEY], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assertNoSensitiveOutput(result, "synthetic-secret-value");
  assert.equal(runCli(["remove", filePath, KEY]), 0);
  assert.equal(readFileSync(filePath, "utf8"), "");
  assert.equal(runCli(["remove", "relative.env", KEY]), 2);
  assert.deepEqual(parseCli(["remove", filePath, KEY]), { operation: "remove", filePath, key: KEY });

  const duplicate = makeFile(root, "duplicate.env", `${KEY}=one\n${KEY}=two\n`);
  const failed = spawnSync(process.execPath, [SCRIPT_PATH, "remove", duplicate, KEY], { encoding: "utf8" });
  assert.equal(failed.status, 2);
  assertNoSensitiveOutput(failed, KEY);
  assertNoSensitiveOutput(failed, "one");
  assertNoSensitiveOutput(failed, "two");
});

test("a cooperating exclusive kernel lock blocks remove", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=synthetic\n`);
  const lockPath = createLock(root);
  const readyPath = path.join(root, "ready");
  const holderCode =
    `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "ready");` +
    "setTimeout(() => {}, 5000);";
  const holder = spawn(
    "/usr/bin/flock",
    [lockPath, "sh", "-c", `node -e ${JSON.stringify(holderCode)}; sleep 5`],
    { stdio: "ignore" },
  );
  try {
    const deadline = Date.now() + 1500;
    while (!existsSync(readyPath) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    assert.equal(existsSync(readyPath), true);
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "remove", filePath, KEY], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(readFileSync(filePath, "utf8"), `${KEY}=synthetic\n`);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("every cleanup exchange, unlink, and fsync crash boundary resumes through assert-absent", () => {
  for (const crashAt of [
    "before-cleanup-manifest-fsync",
    "after-cleanup-manifest-fsync",
    "after-cleanup-placeholder-reservation",
    "before-cleanup-placeholder",
    "after-cleanup-placeholder",
    "after-cleanup-manifest-record",
    "before-cleanup-exchange",
    "after-cleanup-helper",
    "after-cleanup-exchange",
    "before-cleanup-source-unlink",
    "before-cleanup-unlink",
    "after-cleanup-source-unlink",
    "after-cleanup-unlink",
    "before-cleanup-source-fsync",
    "after-cleanup-source-fsync",
    "before-cleanup-private-unlink",
    "after-tombstone-reservation",
    "after-tombstone-placeholder",
    "after-tombstone-prepared",
    "after-cleanup-first-unlink",
    "after-cleanup-second-unlink",
    "after-cleanup-private-unlink",
    "before-cleanup-private-fsync",
    "after-cleanup-private-fsync",
    "before-cleanup-operation-fsync",
    "after-cleanup-operation-fsync",
    "after-cleanup-parent-fsync",
  ]) {
    const root = makeRoot();
    const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(SCRIPT_URL)}).then(({createTestAdapter}) => createTestAdapter().removeEnvEntry(${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}, {crashAt: ${JSON.stringify(crashAt)}}));`,
      ],
      { encoding: "utf8" },
    );
    if (["after-cleanup-helper", "after-cleanup-first-unlink", "after-cleanup-second-unlink"].includes(crashAt)) {
      assert.equal(child.signal, null, crashAt);
      assert.equal(child.status, 1, crashAt);
    } else {
      assert.equal(child.signal, "SIGKILL", crashAt);
    }
    const ambiguous = new Set([
      "before-cleanup-manifest-fsync",
      "after-cleanup-manifest-fsync",
      "after-cleanup-placeholder-reservation",
      "before-cleanup-placeholder",
      "after-cleanup-placeholder",
    ]);
    if (ambiguous.has(crashAt)) {
      assert.throws(() => assertAbsent(filePath, KEY), (error) => error.code === "recovery", crashAt);
    } else {
      assert.doesNotThrow(() => assertAbsent(filePath, KEY), crashAt);
    }
    if (!ambiguous.has(crashAt)) {
      assert.doesNotThrow(() => assertAbsent(filePath, KEY), `${crashAt}-again`);
    } else {
      assert.throws(() => assertAbsent(filePath, KEY), (error) => error.code === "recovery", `${crashAt}-again`);
    }
    assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n", crashAt);
    assert.equal(operationEntries(root).length, 1, crashAt);
    assertNoUnknownQuarantine(path.join(root, operationEntries(root)[0]));
    if (crashAt.startsWith("after-tombstone-")) assertNoSensitiveOutput(child, "target");
  }
});

test("direct tombstone reservation boundaries recover without adopting unknown names", () => {
  for (const crashAt of ["after-tombstone-reservation", "after-tombstone-placeholder", "after-tombstone-prepared"]) {
    const root = makeRoot();
    const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as nodeFs from "node:fs"; import(${JSON.stringify(SCRIPT_URL)}).then(({createTestAdapter}) => createTestAdapter().removeEnvEntry(${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}, {crashAt: ${JSON.stringify(crashAt)}, fs: { fsyncSync(fd) { let descriptorPath = ""; try { descriptorPath = nodeFs.readlinkSync("/proc/self/fd/" + fd); } catch {} if (descriptorPath.endsWith("/published")) throw new Error("marker fsync"); return nodeFs.fsyncSync(fd); } }}));`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.signal, "SIGKILL", crashAt);
    assertNoSensitiveOutput(child, "target");
    assert.doesNotThrow(() => assertAbsent(filePath, KEY), crashAt);
    assert.doesNotThrow(() => assertAbsent(filePath, KEY), `${crashAt}-again`);
    assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n", crashAt);
    assertNoUnknownQuarantine(path.join(root, operationEntries(root)[0]));
  }
});

test("recovery tombstone reservation boundaries are idempotent and exact", () => {
  for (const crashAt of ["after-tombstone-reservation", "after-tombstone-placeholder", "after-tombstone-prepared"]) {
    const root = makeRoot();
    const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
    const initialCrash = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(SCRIPT_URL)}).then(({createTestAdapter}) => createTestAdapter().removeEnvEntry(${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}, {crashAt: "after-cleanup-source-fsync"}));`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(initialCrash.signal, "SIGKILL");
    const recoveryCrash = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(SCRIPT_URL)}).then(({createTestAdapter}) => createTestAdapter().assertAbsent(${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}, {crashAt: ${JSON.stringify(crashAt)}}));`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(recoveryCrash.signal, "SIGKILL", crashAt);
    assertNoSensitiveOutput(initialCrash, "target");
    assertNoSensitiveOutput(recoveryCrash, "target");
    assert.doesNotThrow(() => assertAbsent(filePath, KEY), crashAt);
    assert.doesNotThrow(() => assertAbsent(filePath, KEY), `${crashAt}-again`);
    assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n", crashAt);
    assertNoUnknownQuarantine(path.join(root, operationEntries(root)[0]));
  }
});

test("production recovery entrypoint rejects fixture paths even under flock", () => {
  for (const lockMode of ["-s", "-x"]) {
    const root = makeRoot();
    const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
    const crashed = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(SCRIPT_URL)}).then(({createTestAdapter}) => createTestAdapter().removeEnvEntry(${JSON.stringify(filePath)}, ${JSON.stringify(KEY)}, {crashAt: "after-cleanup-exchange"}));`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(crashed.signal, "SIGKILL", lockMode);
    const lockPath = createLock(root);
    const nonce = "c".repeat(64);
    const result = spawnSync(
      "/usr/bin/flock",
      [lockMode, lockPath, process.execPath, SCRIPT_PATH, "assert-absent", filePath, KEY],
      {
        encoding: "utf8",
        input: nonce,
        env: { ...process.env, REMOVE_ENV_ENTRY_LOCK_FD: "3", REMOVE_ENV_ENTRY_NONCE: nonce },
      },
    );
    assert.equal(result.status, 2, lockMode);
    assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n", lockMode);
    assert.equal(operationEntries(root).length, 1, lockMode);
    assertNoSensitiveOutput(result, KEY);
  }
});

test("the helper rechecks a cleanup inode after a pathname substitution and preserves the foreign file", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  let substituted = false;
  let caught;
  try {
    removeEnvEntry(filePath, KEY, {
      beforeHelperUnlink({ name, sensitive, path: helperPath }) {
        if (!substituted && name.startsWith(".remove-env-entry-quarantine-candidate-") && sensitive === false) {
          substituted = true;
          nodeFs.unlinkSync(helperPath);
          nodeFs.writeFileSync(helperPath, "FOREIGN-HELPER\n", { mode: 0o600 });
        }
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(substituted, true);
  assert.equal(caught?.code, "temporary-cleanup");
  assert.equal(readFileSync(filePath, "utf8"), "KEEP=one\n");
  const operation = caught.recoveryPath.endsWith(".op")
    ? caught.recoveryPath
    : path.dirname(caught.recoveryPath);
  const foreign = ["candidate", ...readdirSync(operation).filter((entry) => entry.startsWith(".remove-env-entry-quarantine-"))]
    .map((entry) => path.join(operation, entry))
    .find((entry) => existsSync(entry) && readFileSync(entry, "utf8") === "FOREIGN-HELPER\n");
  assert.notEqual(foreign, undefined);
  assert.equal(lstatSync(foreign).nlink, 1);
  assert.equal(operationEntries(root).length, 1);
});

test("a pre-existing helper quarantine name is never adopted or unlinked", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `KEEP=one\n${KEY}=target\n`);
  let quarantinePath;
  let caught;
  try {
    removeEnvEntry(filePath, KEY, {
      beforeHelperUnlink({ name, sensitive, quarantinePath: candidateQuarantine }) {
        if (quarantinePath === undefined && name.startsWith(".remove-env-entry-quarantine-candidate-") && sensitive === false) {
          quarantinePath = candidateQuarantine;
          nodeFs.writeFileSync(quarantinePath, "FOREIGN-QUARANTINE\n", { mode: 0o600 });
        }
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(typeof quarantinePath, "string");
  assert.equal(caught?.code, "temporary-cleanup");
  assert.equal(readFileSync(quarantinePath, "utf8"), "FOREIGN-QUARANTINE\n");
  assert.equal(lstatSync(quarantinePath).nlink, 1);
});

test("displayed parent replacement immediately before success is rejected", () => {
  const root = makeRoot();
  const moved = `${root}-moved`;
  roots.push(moved);
  const filePath = makeFile(root, ".env", `${KEY}=target\n`);
  let replaced = false;
  let caught;
  try {
    removeEnvEntry(filePath, KEY, {
      beforeSuccess() {
        if (replaced) return;
        replaced = true;
        nodeFs.renameSync(root, moved);
        nodeFs.mkdirSync(root, 0o700);
        nodeFs.writeFileSync(path.join(root, ".env"), "FOREIGN-PARENT\n", { mode: 0o600 });
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(replaced, true);
  assert.equal(caught?.code, "unsafe-parent");
  assert.equal(readFileSync(path.join(root, ".env"), "utf8"), "FOREIGN-PARENT\n");
  assert.equal(readFileSync(path.join(moved, ".env"), "utf8"), "");
});

test("destination replacement during parent fsync is preserved and final target validation fails", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=target\n`);
  let armed = false;
  let replaced = false;
  const fs = fsAdapter({
    fsyncSync(fd) {
      let descriptorPath = "";
      try { descriptorPath = nodeFs.readlinkSync(`/proc/self/fd/${fd}`); } catch {}
      if (armed && !replaced && descriptorPath === root) {
        replaced = true;
        nodeFs.unlinkSync(filePath);
        nodeFs.writeFileSync(filePath, `${KEY}=FOREIGN-FSYNC\n`, { mode: 0o600 });
      }
      return nodeFs.fsyncSync(fd);
    },
  });
  let caught;
  try {
    removeEnvEntry(filePath, KEY, {
      fs,
      beforeExchange({ kind }) { if (kind === "publication") armed = true; },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(replaced, true);
  assert.equal(caught?.code, "file-changed");
  assert.equal(readFileSync(filePath, "utf8"), `${KEY}=FOREIGN-FSYNC\n`);
  assert.equal(operationEntries(root).length, 1);
});

test("retained cleanup uses bounded exchanges and never invokes pathname deletion", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.equal((source.match(/timeout: EXCHANGE_TIMEOUT_MS/g) ?? []).length >= 2, true);
  assert.equal((source.match(/Object\.create\(null\)/g) ?? []).length >= 2, true);
  assert.equal(source.includes("os.open(name,os.O_RDONLY|os.O_NOFOLLOW"), true);
  assert.equal(source.includes('renameat2(3,name,3,quarantine," + String(RENAME_EXCHANGE) + ")'), true);
  assert.equal(source.includes("unlinkSync("), false);
  assert.equal(source.includes("rmdirSync("), false);
  assert.equal(source.includes("fs.ftruncateSync(fd, scan.validOffset)"), true);
  assert.equal(source.includes("ftruncateSync(candidate"), false);
  assert.equal(source.includes("ftruncateSync(backup"), false);
  assert.equal(source.includes("ftruncateSync(target"), false);
  assert.equal(source.includes("zeros=b'\\0'"), false);

  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=synthetic-secret\n`);
  removeEnvEntry(filePath, KEY);
  assert.equal(readFileSync(filePath, "utf8"), "");
  assertRetainedTombstone(root, filePath, "synthetic-secret");
});

test("foreign late helper substitution preserves the foreign inode and link count", () => {
  const root = makeRoot();
  const filePath = makeFile(root, ".env", `${KEY}=target\n`);
  let substituted = false;
  let caught;
  try {
    removeEnvEntry(filePath, KEY, {
      beforeHelperUnlink({ name, path: helperPath }) {
        if (!substituted && name.startsWith(".remove-env-entry-quarantine-published-")) {
          substituted = true;
          nodeFs.unlinkSync(helperPath);
          nodeFs.writeFileSync(helperPath, "FOREIGN-LATE\n", { mode: 0o600 });
        }
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(substituted, true);
  assert.equal(caught?.code, "temporary-cleanup");
  assert.equal(readFileSync(filePath, "utf8"), "");
  const operation = caught.recoveryPath.endsWith(".op")
    ? caught.recoveryPath
    : path.dirname(caught.recoveryPath);
  const foreign = ["published", ...readdirSync(operation).filter((entry) => entry.startsWith(".remove-env-entry-quarantine-"))]
    .map((entry) => path.join(operation, entry))
    .find((entry) => existsSync(entry) && readFileSync(entry, "utf8") === "FOREIGN-LATE\n");
  assert.notEqual(foreign, undefined);
  assert.equal(lstatSync(foreign).nlink, 1);
  assert.equal(readdirSync(operation).some((entry) => entry === "manifest"), true);
});

test("process-tree helper forwards success output with an unbuffered write loop", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.equal(source.includes("def write_all(fd,data):"), true);
  assert.equal(source.includes("write_all(1,stdout); write_all(2,stderr)"), true);
  const result = testAdapter.runProcessTree(
    [process.execPath, "-e", "process.stdout.write('success\\n');"],
    { timeoutMs: 1000, graceMs: 50, maxBuffer: 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "success\n");
  assert.equal(result.stderr, "");
});

test("process-tree timeout contains a double-fork setsid grandchild and releases the lock", () => {
  const root = makeRoot();
  const lockPath = createLock(root);
  const filePath = makeFile(root, ".env", `${KEY}=synthetic\n`);
  const started = path.join(root, "grandchild-started");
  const lockFd = openSync(lockPath, "r+");
  const childCode = [
    "import os,time",
    `marker=${JSON.stringify(started)}`,
    `target=${JSON.stringify(filePath)}`,
    "if os.fork():",
    " time.sleep(5)",
    " os._exit(0)",
    "os.setsid()",
    "if os.fork(): os._exit(0)",
    "if os.readlink('/proc/self/fd/3') != " + JSON.stringify(lockPath) + ": os._exit(71)",
    "fd=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC,0o600)",
    "os.close(fd)",
    "time.sleep(0.4)",
    "with open(target,'w') as stream: stream.write('MUTATED')",
    "time.sleep(5)",
  ].join("\n");
  let result;
  try {
    result = testAdapter.runProcessTree(
      ["/usr/bin/flock", "-n", "-x", "-F", lockPath, "/usr/bin/python3", "-c", childCode],
      {
        inheritedFds: [[4, lockFd]],
        env: { ...process.env },
        timeoutMs: 200,
        graceMs: 50,
        maxBuffer: 1024,
      },
    );
  } finally {
    closeSync(lockFd);
  }
  assert.equal(result.status, 124);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(existsSync(started), true);
  assert.equal(lstatSync(started).size, 0);
  assert.equal(readFileSync(filePath, "utf8"), `${KEY}=synthetic\n`);
  const reacquired = spawnSync("/usr/bin/flock", ["-n", "-x", lockPath, "true"], { encoding: "utf8" });
  assert.equal(reacquired.status, 0, reacquired.stderr);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 550);
  assert.equal(readFileSync(filePath, "utf8"), `${KEY}=synthetic\n`);
});
