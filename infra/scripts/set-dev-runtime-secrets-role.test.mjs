import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import {
  PROTECTED_TFVARS_PATH,
  SUPPORTED_MODES,
  TARGET_ASSIGNMENT,
  inspectAssignments,
  runCli,
  runModeForTests,
} from "./set-dev-runtime-secrets-role.mjs";

const SCRIPT_PATH = path.join(
  process.cwd(),
  "infra/scripts/set-dev-runtime-secrets-role.mjs",
);
const TEST_ROOT = mkdtempSync(path.join(tmpdir(), "palancar-runtime-secrets-"));

after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function writeProtected(name, contents, mode = 0o600) {
  const filePath = path.join(TEST_ROOT, name);
  const fd = openSync(filePath, "wx", mode);
  try {
    const bytes = Buffer.isBuffer(contents)
      ? contents
      : Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
  } finally {
    closeSync(fd);
  }
  chmodSync(filePath, mode);
  return filePath;
}

function readBytes(filePath) {
  return readFileSync(filePath);
}

function inodeIdentity(filePath) {
  const stat = statSync(filePath);
  return { dev: stat.dev, ino: stat.ino };
}

function filesWithBytes(bytes) {
  return recursiveFiles().filter((filePath) => readBytes(filePath).equals(bytes));
}

function temporaryNames() {
  return readdirSync(TEST_ROOT).filter((name) => name.startsWith(".") && name.endsWith(".tmp"));
}

function recursiveEntries(root = TEST_ROOT) {
  const entries = [];
  for (const name of readdirSync(root)) {
    const filePath = path.join(root, name);
    const stat = lstatSync(filePath);
    entries.push(filePath);
    if (stat.isDirectory()) entries.push(...recursiveEntries(filePath));
  }
  return entries;
}

function recursiveFiles(root = TEST_ROOT) {
  return recursiveEntries(root).filter((filePath) => !lstatSync(filePath).isDirectory());
}

function foreignBytes() {
  return recursiveFiles()
    .filter((filePath) =>
      filePath
        .split(path.sep)
        .some((part) => /\.foreign$|\.quarantine$/u.test(part)),
    )
    .map((filePath) => readBytes(filePath));
}

function assertNoOperationDirectories() {
  assert.deepEqual(
    recursiveEntries().filter((filePath) => path.basename(filePath).endsWith(".op")),
    [],
  );
}

function operationArtifactPaths() {
  return recursiveEntries().filter((filePath) => {
    const name = path.basename(filePath);
    return (
      name.endsWith(".op") ||
      name.endsWith(".quarantine") ||
      name.endsWith(".bak") ||
      name === "manifest" ||
      name === "recovery" ||
      name.endsWith(".tmp")
    );
  });
}

function assertNoNewOperationArtifacts(before) {
  const prior = new Set(before);
  const artifacts = operationArtifactPaths().filter((filePath) => !prior.has(filePath));
  assert.deepEqual(artifacts, []);
}

let exchangeSequence = 0;

function exchangeEntries({ sourceDirectory, sourceName, targetDirectory, targetName }) {
  const source = path.join(sourceDirectory.path, sourceName);
  const target = path.join(targetDirectory.path, targetName);
  const temporary = path.join(
    sourceDirectory.path,
    `.test-exchange-${process.pid}-${exchangeSequence++}`,
  );
  renameSync(source, temporary);
  renameSync(target, source);
  renameSync(temporary, target);
}

function assertOperationFails(mode, filePath, options) {
  assert.throws(
    () => runModeForTests(mode, filePath, options),
    (error) => error?.message === "protected tfvars operation failed",
  );
}

test("the protected path and mode vocabulary are fixed", () => {
  assert.equal(
    PROTECTED_TFVARS_PATH,
    path.join(process.cwd(), "infra/environments/dev/terraform.tfvars"),
  );
  assert.equal(TARGET_ASSIGNMENT, "enable_runtime_secrets_user_assignment");
  assert.deepEqual([...SUPPORTED_MODES], [
    "assert-enabled",
    "disable",
    "assert-disabled",
  ]);
  assert.equal(runCli([]), 2);
  assert.equal(runCli(["assert-enabled", "extra"]), 2);
  assert.equal(runCli(["--mode=assert-enabled"]), 2);
  assert.equal(runCli(["unknown"]), 2);
});

test("enabled accepts the effective default and disable appends one false assignment", () => {
  const original = Buffer.from(
    "# no explicit role assignment\nvalue = \"sentinel-runtime-value\"\n",
    "utf8",
  );
  const filePath = writeProtected("default.tfvars", original);
  const before = statSync(filePath);

  assert.equal(runModeForTests("assert-enabled", filePath), 0);
  assertOperationFails("assert-disabled", filePath);
  assert.equal(runModeForTests("disable", filePath), 0);

  const expected = Buffer.concat([
    original,
    Buffer.from(`${TARGET_ASSIGNMENT} = false\n`, "ascii"),
  ]);
  assert.deepEqual(readBytes(filePath), expected);
  assert.equal(inspectAssignments(expected).disabled, true);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.uid, before.uid);
  assert.equal(afterStat.gid, before.gid);
  assert.equal(afterStat.mode & 0o7777, before.mode & 0o7777);
  assert.deepEqual(temporaryNames(), []);
});

test("a UTF-8 BOM is recognized without changing any non-target bytes", () => {
  const original = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`${TARGET_ASSIGNMENT} /* keep */ = true\r\nvalue = "café"\n`, "utf8"),
  ]);
  const filePath = writeProtected("bom.tfvars", original);
  assert.deepEqual(inspectAssignments(original), {
    count: 1,
    values: ["true"],
    enabled: true,
    disabled: false,
  });
  assert.equal(runModeForTests("disable", filePath), 0);
  const expected = Buffer.concat([
    original.subarray(0, original.indexOf(Buffer.from("true", "ascii"))),
    Buffer.from("false", "ascii"),
    original.subarray(original.indexOf(Buffer.from("true", "ascii")) + 4),
  ]);
  assert.deepEqual(readBytes(filePath), expected);
  assert.equal(readBytes(filePath)[0], 0xef);
});

test("disable changes only the target literal and preserves all other bytes", () => {
  const original = Buffer.from(
    "# enable_runtime_secrets_user_assignment = false\r\n" +
      "quoted = \"enable_runtime_secrets_user_assignment = true\"\n" +
      "nested = {\n" +
      "  enable_runtime_secrets_user_assignment = false\n" +
      "}\n" +
      "heredoc = <<EOF\n" +
      "enable_runtime_secrets_user_assignment = true\n" +
      "EOF\n" +
      "enable_runtime_secrets_user_assignment /* between */ = /* value */ true // keep\r\n" +
      "unicode = \"café\"\n",
    "utf8",
  );
  const filePath = writeProtected("explicit.tfvars", original, 0o400);
  const before = statSync(filePath);

  const parsed = inspectAssignments(original);
  assert.deepEqual(parsed.values, ["true"]);
  assert.equal(parsed.enabled, true);
  assert.equal(runModeForTests("disable", filePath), 0);

  const targetOffset = original.indexOf(Buffer.from("true // keep", "ascii"));
  const expected = Buffer.concat([
    original.subarray(0, targetOffset),
    Buffer.from("false", "ascii"),
    original.subarray(targetOffset + 4),
  ]);
  assert.deepEqual(readBytes(filePath), expected);
  assert.equal(inspectAssignments(expected).disabled, true);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.uid, before.uid);
  assert.equal(afterStat.gid, before.gid);
  assert.equal(afterStat.mode & 0o7777, 0o400);
  assert.deepEqual(temporaryNames(), []);
});

test("all assertions are read-only and require the exact state", () => {
  const trueFile = writeProtected(
    "true.tfvars",
    `${TARGET_ASSIGNMENT}=true\nsecret = \"do-not-print\"\n`,
  );
  const falseFile = writeProtected(
    "false.tfvars",
    `${TARGET_ASSIGNMENT} = false\nsecret = \"do-not-print\"\n`,
  );
  const trueBefore = readBytes(trueFile);
  const falseBefore = readBytes(falseFile);

  assert.equal(runModeForTests("assert-enabled", trueFile), 0);
  assertOperationFails("assert-disabled", trueFile);
  assertOperationFails("disable", falseFile);
  assert.equal(runModeForTests("assert-disabled", falseFile), 0);
  assert.deepEqual(readBytes(trueFile), trueBefore);
  assert.deepEqual(readBytes(falseFile), falseBefore);
});

test("duplicate, malformed, and non-root assignments fail closed", () => {
  const cases = [
    `${TARGET_ASSIGNMENT} = true\n${TARGET_ASSIGNMENT} = true\n`,
    `${TARGET_ASSIGNMENT} = \"true\"\n`,
    `${TARGET_ASSIGNMENT} = trueish\n`,
    `${TARGET_ASSIGNMENT} = 1\n`,
    `object = {\n  ${TARGET_ASSIGNMENT} = true\n}\n`,
  ];
  for (const [index, contents] of cases.entries()) {
    const filePath = writeProtected(`malformed-${index}.tfvars`, contents);
    const parsed = inspectAssignments(Buffer.from(contents, "utf8"));
    assert.equal(parsed.enabled, index === 4);
    assertOperationFails("assert-disabled", filePath);
    if (index !== 4) assertOperationFails("assert-enabled", filePath);
    if (index === 4) {
      assert.equal(runModeForTests("disable", filePath), 0);
      assert.equal(inspectAssignments(readBytes(filePath)).disabled, true);
    } else {
      assertOperationFails("disable", filePath);
    }
  }
});

test("only a complete standalone boolean literal is accepted", () => {
  const cases = [
    `${TARGET_ASSIGNMENT} = true || false\n`,
    `${TARGET_ASSIGNMENT} = false ? true : false\n`,
    `${TARGET_ASSIGNMENT} = true\n  && false\n`,
    `${TARGET_ASSIGNMENT} = false /* trailing */ true\n`,
  ];
  for (const [index, contents] of cases.entries()) {
    const filePath = writeProtected(`expression-${index}.tfvars`, contents);
    assert.deepEqual(inspectAssignments(Buffer.from(contents)), {
      count: 1,
      values: ["invalid"],
      enabled: false,
      disabled: false,
    });
    assertOperationFails("assert-enabled", filePath);
    assertOperationFails("assert-disabled", filePath);
    assertOperationFails("disable", filePath);
  }
});

test("comments, strings, and heredocs do not create assignments", () => {
  const contents =
    "# enable_runtime_secrets_user_assignment = false\n" +
    "line = \"enable_runtime_secrets_user_assignment = true\"\n" +
    "value = <<-EOT\n" +
    "\tenable_runtime_secrets_user_assignment = false\n" +
    "EOT\n";
  const filePath = writeProtected("non-assignment.tfvars", contents);
  assert.deepEqual(inspectAssignments(Buffer.from(contents)), {
    count: 0,
    values: [],
    enabled: true,
    disabled: false,
  });
  assert.equal(runModeForTests("assert-enabled", filePath), 0);
  assertOperationFails("assert-disabled", filePath);
});

test("space-indented valid heredoc terminators expose following assignments", () => {
  const contents =
    "description = <<EOT\n" +
    `  ${TARGET_ASSIGNMENT} = true\n` +
    "    EOT\n" +
    "indented = <<-EOT2\n" +
    `  ${TARGET_ASSIGNMENT} = true\n` +
    "    EOT2 \t\n" +
    `${TARGET_ASSIGNMENT} = false\n`;
  const filePath = writeProtected("space-indented-heredoc.tfvars", contents);
  assert.deepEqual(inspectAssignments(Buffer.from(contents)), {
    count: 1,
    values: ["false"],
    enabled: false,
    disabled: true,
  });
  assert.equal(runModeForTests("assert-disabled", filePath), 0);
  assertOperationFails("assert-enabled", filePath);
  assertOperationFails("disable", filePath);
});

test("unterminated lexical structures fail before any modification", () => {
  const cases = [
    `${TARGET_ASSIGNMENT} = true\n/* unterminated\n`,
    `${TARGET_ASSIGNMENT} = true\nvalue = "unterminated\n`,
    `object = {\n  value = "x"\n`,
    `values = [\n  "x"\n`,
    `call = (\n  true\n`,
    "description = <<EOT\nbody\n",
    "orphan = true\n}\n",
  ];
  for (const [index, contents] of cases.entries()) {
    const filePath = writeProtected(`unterminated-${index}.tfvars`, contents);
    const before = readBytes(filePath);
    assert.throws(
      () => inspectAssignments(before),
      (error) => error?.message === "protected tfvars operation failed",
    );
    assertOperationFails("disable", filePath);
    assert.deepEqual(readBytes(filePath), before);
  }
});

test("symlinks, non-regular files, and exposed modes are rejected", () => {
  const source = writeProtected("symlink-source.tfvars", "secret = \"x\"\n");
  const symlink = path.join(TEST_ROOT, "symlink.tfvars");
  symlinkSync(source, symlink);
  assert.equal(lstatSync(symlink).isSymbolicLink(), true);
  assert.equal(readlinkSync(symlink), source);
  assertOperationFails("assert-enabled", symlink);

  const directory = path.join(TEST_ROOT, "directory.tfvars");
  mkdirSync(directory, { mode: 0o700 });
  assertOperationFails("assert-enabled", directory);

  const exposed = writeProtected("exposed.tfvars", "secret = \"x\"\n", 0o640);
  assertOperationFails("assert-enabled", exposed);
  assertOperationFails("disable", exposed);

  const wrongOwner = writeProtected(
    "wrong-owner.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  let injectedOwner = false;
  assertOperationFails("assert-enabled", wrongOwner, {
    fs: {
      lstatSync(filePath, options) {
        const stat = lstatSync(filePath, options);
        if (!injectedOwner && filePath === wrongOwner) {
          injectedOwner = true;
          return new Proxy(stat, {
            get(target, property, receiver) {
              if (property === "uid") return BigInt(target.uid) + 1n;
              return Reflect.get(target, property, receiver);
            },
          });
        }
        return stat;
      },
    },
  });
});

test("same-inode same-size content races fail closed", () => {
  const original = Buffer.from(`${TARGET_ASSIGNMENT} = true\n`, "ascii");
  const filePath = writeProtected("same-size-race.tfvars", original);
  const targetOffset = original.indexOf(Buffer.from("true", "ascii"));
  const before = statSync(filePath);
  let targetFd;
  let targetFstatCount = 0;
  let baseline;
  let mutated = false;

  assertOperationFails("disable", filePath, {
    fs: {
      lstatSync(candidate, options) {
        const stat = lstatSync(candidate, options);
        if (mutated && candidate === filePath) return baseline;
        return stat;
      },
      fstatSync(fd, options) {
        const stat = fstatSync(fd, options);
        if (targetFd === undefined) targetFd = fd;
        if (fd !== targetFd) return stat;
        targetFstatCount += 1;
        if (targetFstatCount === 3) baseline = stat;
        if (targetFstatCount === 4 && !mutated) {
          const mutationFd = openSync(filePath, "r+");
          try {
            writeSync(
              mutationFd,
              Buffer.from("nope", "ascii"),
              0,
              4,
              targetOffset,
            );
          } finally {
            closeSync(mutationFd);
          }
          mutated = true;
          return baseline;
        }
        if (mutated) return baseline;
        return stat;
      },
    },
  });

  const after = statSync(filePath);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.deepEqual(readBytes(filePath).subarray(targetOffset, targetOffset + 4), Buffer.from("nope"));
});

test("target pathname substitution during final validation fails closed", () => {
  const filePath = writeProtected(
    "target-substitution.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const substitutePath = writeProtected(
    "target-substitute-source.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const displacedPath = `${filePath}.displaced`;
  let targetLstatCount = 0;

  assertOperationFails("disable", filePath, {
    fs: {
      lstatSync(candidate, options) {
        const stat = lstatSync(candidate, options);
        if (candidate === filePath && ++targetLstatCount === 2) {
          renameSync(filePath, displacedPath);
          renameSync(substitutePath, filePath);
        }
        return stat;
      },
    },
  });
  assert.deepEqual(readBytes(filePath), Buffer.from(`${TARGET_ASSIGNMENT} = true\n`));
  assert.equal(lstatSync(displacedPath).isFile(), true);
  rmSync(displacedPath, { force: true });
});

test("publication uses one candidate-to-target rename and never renames the target away", () => {
  const filePath = writeProtected(
    "single-publication.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const original = readBytes(filePath);
  let targetAwayRenames = 0;
  let publicationRenames = 0;
  let candidatePath;
  let operationPath;
  let operationMode;

  assert.equal(runModeForTests("disable", filePath, {
    fs: {
      exchangeSync(args) {
        const source = path.join(args.sourceDirectory.path, args.sourceName);
        const destination = path.join(args.targetDirectory.path, args.targetName);
        if (source === filePath) targetAwayRenames += 1;
        if (destination === filePath) {
          publicationRenames += 1;
          candidatePath = source;
          operationPath = path.dirname(source);
          operationMode = statSync(operationPath).mode & 0o777;
        }
        return exchangeEntries(args);
      },
    },
  }), 0);
  assert.equal(targetAwayRenames, 0);
  assert.equal(publicationRenames, 1);
  assert.equal(path.basename(candidatePath).endsWith(".tmp"), true);
  assert.equal(operationMode, 0o700);
  assert.notEqual(candidatePath, filePath);
  assert.notDeepEqual(readBytes(filePath), original);
  assert.deepEqual(temporaryNames(), []);
});

test("late candidate substitution is detected and verified original content is restored", () => {
  const filePath = writeProtected(
    "late-candidate-substitution.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const original = readBytes(filePath);
  let candidatePath;
  let substituted = false;

  assertOperationFails("disable", filePath, {
    fs: {
      exchangeSync(args) {
        const source = path.join(args.sourceDirectory.path, args.sourceName);
        const destination = path.join(args.targetDirectory.path, args.targetName);
        if (!substituted && destination === filePath) {
          substituted = true;
          candidatePath = source;
          renameSync(source, `${source}.moved`);
          const foreignFd = openSync(source, "wx", 0o600);
          try {
            writeSync(foreignFd, Buffer.from("foreign candidate\n", "ascii"));
          } finally {
            closeSync(foreignFd);
          }
        }
        return exchangeEntries(args);
      },
    },
  });
  assert.equal(substituted, true);
  assert.deepEqual(readBytes(filePath), original);
  assert.ok(recursiveFiles().some((file) => readBytes(file).toString("ascii").includes("= false")));
  assert.equal(candidatePath.endsWith(".tmp"), true);
  assert.deepEqual(temporaryNames(), []);
  assert.ok(foreignBytes().some((bytes) => bytes.equals(Buffer.from("foreign candidate\n", "ascii"))));
  assertNoOperationDirectories();
});

test("replaced private operation entries are rejected and foreign content is not unlinked", () => {
  const filePath = writeProtected(
    "temporary-substitution.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const original = readBytes(filePath);
  let candidatePath;
  let foreignPath;
  let foreignIdentity;
  let foreignNlink;
  let substituted = false;

  assertOperationFails("disable", filePath, {
    fs: {
      lstatSync(candidate, options) {
        if (!substituted && path.basename(candidate).startsWith("candidate-")) {
          candidatePath = candidate;
          renameSync(candidate, `${candidate}.moved`);
          foreignPath = candidate;
          const foreignFd = openSync(candidate, "wx", 0o600);
          try {
            writeSync(foreignFd, Buffer.from("foreign private entry\n", "ascii"));
          } finally {
            closeSync(foreignFd);
          }
          const foreignStat = statSync(foreignPath);
          foreignIdentity = { dev: foreignStat.dev, ino: foreignStat.ino };
          foreignNlink = foreignStat.nlink;
          substituted = true;
        }
        return lstatSync(candidate, options);
      },
    },
  });
  assert.equal(substituted, true);
  assert.deepEqual(readBytes(filePath), original);
  assert.ok(foreignBytes().some((bytes) => bytes.equals(Buffer.from("foreign private entry\n", "ascii"))));
  assert.ok(recursiveFiles().some((candidate) => {
    try {
      const identity = inodeIdentity(candidate);
      return identity.dev === foreignIdentity.dev && identity.ino === foreignIdentity.ino;
    } catch {
      return false;
    }
  }));
  assert.equal(foreignNlink, 1);
  assert.ok(recursiveFiles().some((file) => readBytes(file).toString("ascii").includes("= false")));
  assert.equal(path.dirname(candidatePath), path.dirname(foreignPath));
  assertNoOperationDirectories();
});

test("immediate operation-directory substitution preserves the foreign directory identity and nlink", () => {
  const filePath = writeProtected(
    "operation-directory-substitution.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  let substituted = false;
  let foreignIdentity;
  let foreignNlink;
  assertOperationFails("disable", filePath, {
    fs: {
      lstatSync(candidate, options) {
        if (!substituted && path.basename(candidate).endsWith(".op")) {
          substituted = true;
          renameSync(candidate, `${candidate}.created`);
          mkdirSync(candidate, { mode: 0o700 });
          const foreignStat = statSync(candidate);
          foreignIdentity = { dev: foreignStat.dev, ino: foreignStat.ino };
          foreignNlink = foreignStat.nlink;
        }
        return lstatSync(candidate, options);
      },
    },
  });
  assert.equal(substituted, true);
  const preserved = recursiveEntries().find((candidate) => {
    try {
      const identity = inodeIdentity(candidate);
      return identity.dev === foreignIdentity.dev && identity.ino === foreignIdentity.ino;
    } catch {
      return false;
    }
  });
  assert.ok(preserved);
  assert.equal(statSync(preserved).nlink, foreignNlink);
  for (const name of readdirSync(TEST_ROOT)) {
    if (name.includes("operation-directory-substitution")) {
      rmSync(path.join(TEST_ROOT, name), { recursive: true, force: true });
    }
  }
});

test("operation-directory substitution inside mkdirSync never deletes the foreign inode", () => {
  const filePath = writeProtected(
    "operation-directory-mkdir-hook.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  let substituted = false;
  let foreignIdentity;
  let foreignNlink;
  assertOperationFails("disable", filePath, {
    fs: {
      mkdirSync(candidate, options) {
        const result = mkdirSync(candidate, options);
        if (!substituted && path.basename(candidate).endsWith(".op")) {
          substituted = true;
          renameSync(candidate, `${candidate}.created`);
          mkdirSync(candidate, { mode: 0o700 });
          const foreign = statSync(candidate);
          foreignIdentity = { dev: foreign.dev, ino: foreign.ino };
          foreignNlink = foreign.nlink;
        }
        return result;
      },
    },
  });
  assert.equal(substituted, true);
  const preserved = recursiveEntries().find((candidate) => {
    try {
      const identity = inodeIdentity(candidate);
      return identity.dev === foreignIdentity.dev && identity.ino === foreignIdentity.ino;
    } catch {
      return false;
    }
  });
  assert.ok(preserved);
  assert.equal(statSync(preserved).nlink, foreignNlink);
  for (const name of readdirSync(TEST_ROOT)) {
    if (name.includes("operation-directory-mkdir-hook")) {
      rmSync(path.join(TEST_ROOT, name), { recursive: true, force: true });
    }
  }
});

test("cleanup refuses to unlink a replaced private entry after a write failure", () => {
  const filePath = writeProtected(
    "cleanup-replacement.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  let replaced = false;
  assertOperationFails("disable", filePath, {
    fs: {
      writeSync(fd, ...args) {
        let descriptorPath = "";
        try { descriptorPath = readlinkSync(`/proc/self/fd/${fd}`); } catch {}
        if (path.basename(descriptorPath).startsWith("candidate-")) {
          const error = new Error("synthetic write failure");
          error.code = "EIO";
          throw error;
        }
        return writeSync(fd, ...args);
      },
      lstatSync(candidate, options) {
        if (!replaced && path.basename(candidate).startsWith("candidate-")) {
          replaced = true;
          rmSync(candidate, { force: true });
          const foreignFd = openSync(candidate, "wx", 0o600);
          try {
            writeSync(foreignFd, Buffer.from("foreign recovery\n", "ascii"));
          } finally {
            closeSync(foreignFd);
          }
        }
        return lstatSync(candidate, options);
      },
    },
  });
  assert.equal(replaced, true);
  assert.ok(foreignBytes().some((bytes) => bytes.equals(Buffer.from("foreign recovery\n", "ascii"))));
  assertNoOperationDirectories();
});

test("cleanup no-replace recovery preserves a foreign swap at the move boundary", () => {
  const filePath = writeProtected(
    "cleanup-no-replace.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  let swapped = false;
  assertOperationFails("disable", filePath, {
    fs: {
      writeSync(fd, ...args) {
        let descriptorPath = "";
        try { descriptorPath = readlinkSync(`/proc/self/fd/${fd}`); } catch {}
        if (path.basename(descriptorPath).startsWith("candidate-")) {
          const error = new Error("synthetic write failure");
          error.code = "EIO";
          throw error;
        }
        return writeSync(fd, ...args);
      },
      exchangeSync(args) {
        const source = path.join(args.sourceDirectory.path, args.sourceName);
        const destination = path.join(args.targetDirectory.path, args.targetName);
        if (!swapped && path.basename(source).startsWith("candidate-") && destination.includes(".quarantine")) {
          swapped = true;
          renameSync(source, `${source}.moved`);
          const fd = openSync(source, "wx", 0o600);
          try {
            writeSync(fd, Buffer.from("foreign no-replace cleanup\n", "ascii"));
          } finally {
            closeSync(fd);
          }
        }
        return exchangeEntries(args);
      },
    },
  });
  assert.equal(swapped, true);
  assert.deepEqual(readBytes(filePath), Buffer.from(`${TARGET_ASSIGNMENT} = true\n`, "ascii"));
  assert.ok(foreignBytes().some((bytes) => bytes.equals(Buffer.from("foreign no-replace cleanup\n", "ascii"))));
  assertNoOperationDirectories();
});

test("candidate path substitution before final validation is never committed or unlinked", () => {
  const filePath = writeProtected(
    "bound-candidate-swap.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const original = readBytes(filePath);
  let swapped = false;

  assertOperationFails("disable", filePath, {
    fs: {
      lstatSync(candidate, options) {
        if (!swapped && path.basename(candidate).startsWith("candidate-")) {
          swapped = true;
          renameSync(candidate, `${candidate}.moved`);
          const foreignFd = openSync(candidate, "wx", 0o600);
          try {
            writeSync(foreignFd, Buffer.from("foreign bound temp\n", "ascii"));
          } finally {
            closeSync(foreignFd);
          }
        }
        return lstatSync(candidate, options);
      },
    },
  });
  assert.equal(swapped, true);
  assert.deepEqual(readBytes(filePath), original);
  assert.ok(foreignBytes().some((bytes) => bytes.equals(Buffer.from("foreign bound temp\n", "ascii"))));
  assert.ok(recursiveFiles().some((file) => readBytes(file).equals(Buffer.from(`${TARGET_ASSIGNMENT} = false\n`, "ascii"))));
  assertNoOperationDirectories();
});

test("descriptor-bound candidate substitution cannot leave foreign target content installed", () => {
  const filePath = writeProtected(
    "late-candidate-substitution-2.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  let candidatePath;
  let injected = false;
  assertOperationFails("disable", filePath, {
    fs: {
      exchangeSync(args) {
        const source = path.join(args.sourceDirectory.path, args.sourceName);
        const destination = path.join(args.targetDirectory.path, args.targetName);
        if (!injected && destination === filePath) {
          injected = true;
          candidatePath = source;
          renameSync(source, `${source}.moved`);
          const foreignFd = openSync(source, "wx", 0o600);
          try {
            writeSync(foreignFd, Buffer.from("foreign temp\n", "ascii"));
          } finally {
            closeSync(foreignFd);
          }
        }
        return exchangeEntries(args);
      },
    },
  });
  assert.equal(injected, true);
  assert.equal(candidatePath.endsWith(".tmp"), true);
  assert.ok(recursiveFiles().some((file) => readBytes(file).toString("ascii").includes("= false")));
  assert.ok(foreignBytes().some((bytes) => bytes.equals(Buffer.from("foreign temp\n", "ascii"))));
  assert.deepEqual(
    inspectAssignments(readBytes(filePath)),
    { count: 1, values: ["true"], enabled: true, disabled: false },
  );
  assertNoOperationDirectories();
});

test("composed candidate and restoration substitutions preserve both foreign inodes", () => {
  const filePath = writeProtected(
    "composed-substitution.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const original = readBytes(filePath);
  let candidateInjected = false;
  let restorationInjected = false;

  assertOperationFails("disable", filePath, {
    fs: {
      exchangeSync(args) {
        const source = path.join(args.sourceDirectory.path, args.sourceName);
        const destination = path.join(args.targetDirectory.path, args.targetName);
        const basename = path.basename(source);
        if (!candidateInjected && destination === filePath && basename.startsWith("candidate-")) {
          candidateInjected = true;
          const moved = `${source}.candidate-moved`;
          renameSync(source, moved);
          const foreignFd = openSync(source, "wx", 0o600);
          try {
            writeSync(foreignFd, Buffer.from("foreign candidate composition\n", "ascii"));
          } finally {
            closeSync(foreignFd);
          }
        } else if (!restorationInjected && destination === filePath && basename.startsWith("restore-")) {
          restorationInjected = true;
          const moved = `${source}.restore-moved`;
          renameSync(source, moved);
          const foreignFd = openSync(source, "wx", 0o600);
          try {
            writeSync(foreignFd, Buffer.from("foreign restoration composition\n", "ascii"));
          } finally {
            closeSync(foreignFd);
          }
        }
        return exchangeEntries(args);
      },
    },
  });
  assert.equal(candidateInjected, true);
  assert.equal(restorationInjected, true);
  assert.deepEqual(readBytes(filePath), original);
  assert.ok(foreignBytes().some((bytes) => bytes.equals(Buffer.from("foreign candidate composition\n", "ascii"))));
  assert.ok(foreignBytes().some((bytes) => bytes.equals(Buffer.from("foreign restoration composition\n", "ascii"))));
  assertNoOperationDirectories();
});

test("SIGKILL at the publication boundary leaves the protected path old or new", () => {
  const moduleUrl = pathToFileURL(SCRIPT_PATH).href;
  const original = Buffer.from(`${TARGET_ASSIGNMENT} = true\n`, "ascii");
  const replacement = Buffer.from(`${TARGET_ASSIGNMENT} = false\n`, "ascii");

  for (const [name, boundary, expected] of [
    ["before", "before", original],
    ["after", "after", replacement],
  ]) {
    const filePath = writeProtected(`sigkill-${name}.tfvars`, original);
    const childScript = `
      const { runModeForTests } = await import(${JSON.stringify(moduleUrl)});
      const target = ${JSON.stringify(filePath)};
      const boundary = ${JSON.stringify(boundary)};
      runModeForTests("disable", target, {
        fs: {
          beforeExchangeSync({ kind }) {
            if (boundary === "before" && kind === "publication") {
              process.kill(process.pid, "SIGKILL");
            }
          },
          afterExchangeSync({ kind }) {
            if (boundary === "after" && kind === "publication") {
              process.kill(process.pid, "SIGKILL");
            }
          },
        },
      });
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.signal, "SIGKILL", boundary);
    const installed = readBytes(filePath);
    assert.ok(installed.equals(original) || installed.equals(replacement));
    assert.deepEqual(installed, expected);
    assert.equal(
      runModeForTests(boundary === "before" ? "assert-enabled" : "assert-disabled", filePath),
      0,
    );
    assertNoOperationDirectories();
  }
});

test("SIGKILL during initial candidate write or fsync is recoverable", () => {
  const moduleUrl = pathToFileURL(SCRIPT_PATH).href;
  const original = Buffer.from(`${TARGET_ASSIGNMENT} = true\n`, "ascii");
  for (const [name, event] of [
    ["first-write", "first-write"],
    ["partial-write", "partial-write"],
    ["candidate-fsync", "candidate-fsync"],
  ]) {
    const filePath = writeProtected(`sigkill-initial-${name}.tfvars`, original);
    const childScript = `
      import {
        fsyncSync as realFsyncSync,
        readlinkSync,
        writeSync as realWriteSync,
      } from "node:fs";
      const { runModeForTests } = await import(${JSON.stringify(moduleUrl)});
      const target = ${JSON.stringify(filePath)};
      const event = ${JSON.stringify(event)};
      let fired = false;
      runModeForTests("disable", target, {
        fs: {
          writeSync(fd, bytes, offset, length) {
            let descriptorPath = "";
            try { descriptorPath = readlinkSync("/proc/self/fd/" + fd); } catch {}
            if (
              !fired &&
              descriptorPath.includes("/candidate-") &&
              event !== "candidate-fsync"
            ) {
              fired = true;
              if (event === "partial-write") {
                realWriteSync(fd, bytes, offset, Math.max(1, Math.min(length, 2)));
              }
              if (event !== "candidate-fsync") process.kill(process.pid, "SIGKILL");
            }
            return realWriteSync(fd, bytes, offset, length);
          },
          fsyncSync(fd) {
            let descriptorPath = "";
            try { descriptorPath = readlinkSync("/proc/self/fd/" + fd); } catch {}
            if (!fired && descriptorPath.includes("/candidate-")) {
              fired = true;
              process.kill(process.pid, "SIGKILL");
            }
            return realFsyncSync(fd);
          },
        },
      });
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.signal, "SIGKILL", event);
    assert.equal(child.stdout, "", event);
    assert.equal(child.stderr, "", event);
    assert.equal(runModeForTests("assert-enabled", filePath), 0, event);
    assertOperationFails("assert-disabled", filePath);
    assertNoOperationDirectories();
  }
});

test("durable intent recovers a foreign candidate after post-rename SIGKILL", () => {
  const moduleUrl = pathToFileURL(SCRIPT_PATH).href;
  const filePath = writeProtected(
    "recover-candidate.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const original = readBytes(filePath);
  const childScript = `
    import {
      closeSync as realCloseSync,
      openSync as realOpenSync,
      renameSync as realRenameSync,
      writeSync as realWriteSync,
    } from "node:fs";
    const { runModeForTests } = await import(${JSON.stringify(moduleUrl)});
    const target = ${JSON.stringify(filePath)};
    runModeForTests("disable", target, {
      fs: {
        afterExchangeSync({ targetDirectory, targetName, kind }) {
          const destination = targetDirectory.path + "/" + targetName;
          if (kind === "publication" && destination === target) {
            realRenameSync(destination, destination + ".published-moved");
            const fd = realOpenSync(destination, "wx", 0o600);
            realWriteSync(fd, Buffer.from("foreign candidate after kill\\n"));
            realCloseSync(fd);
            process.kill(process.pid, "SIGKILL");
          }
        },
      },
    });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.signal, "SIGKILL");
  const foreign = Buffer.from("foreign candidate after kill\n");
  const foreignPath = filesWithBytes(foreign).find((candidate) => candidate === filePath);
  assert.ok(foreignPath);
  const foreignIdentity = inodeIdentity(foreignPath);
  const operationName = readdirSync(TEST_ROOT).find(
    (candidate) => candidate.startsWith(`.${path.basename(filePath)}.`) && candidate.endsWith(".op"),
  );
  assert.ok(operationName);
  const operationPath = path.join(TEST_ROOT, operationName);
  const backupName = readdirSync(operationPath).find((candidate) => candidate.startsWith("backup-"));
  assert.ok(backupName);
  const backupPath = path.join(operationPath, backupName);
  const backupBytes = readBytes(backupPath);
  const backupIdentity = inodeIdentity(backupPath);
  const tampered = Buffer.alloc(backupBytes.length, 0x58);
  const tamperFd = openSync(backupPath, "r+");
  writeSync(tamperFd, tampered, 0, tampered.length, 0);
  fsyncSync(tamperFd);
  closeSync(tamperFd);
  assertOperationFails("assert-enabled", filePath);
  assert.deepEqual(inodeIdentity(backupPath), backupIdentity);
  assert.deepEqual(readBytes(filePath), foreign);
  const restoreFd = openSync(backupPath, "r+");
  writeSync(restoreFd, backupBytes, 0, backupBytes.length, 0);
  fsyncSync(restoreFd);
  closeSync(restoreFd);
  assertOperationFails("assert-enabled", filePath);
  assert.deepEqual(readBytes(filePath), original);
  assert.ok(filesWithBytes(foreign).some((candidate) => {
    const identity = inodeIdentity(candidate);
    return identity.dev === foreignIdentity.dev && identity.ino === foreignIdentity.ino;
  }));
  assertNoOperationDirectories();
});

test("recovery rejects same-inode backup mutation after the authenticated read", () => {
  const moduleUrl = pathToFileURL(SCRIPT_PATH).href;
  const filePath = writeProtected(
    "recover-backup-hook.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const foreign = Buffer.from("foreign candidate from backup hook\n", "ascii");
  const childScript = `
    import {
      closeSync as realCloseSync,
      openSync as realOpenSync,
      renameSync as realRenameSync,
      writeSync as realWriteSync,
    } from "node:fs";
    const { runModeForTests } = await import(${JSON.stringify(moduleUrl)});
    const target = ${JSON.stringify(filePath)};
    runModeForTests("disable", target, {
      fs: {
        afterExchangeSync({ targetDirectory, targetName, kind }) {
          const destination = targetDirectory.path + "/" + targetName;
          if (kind === "publication" && destination === target) {
            realRenameSync(destination, destination + ".published-moved");
            const fd = realOpenSync(destination, "wx", 0o600);
            realWriteSync(fd, Buffer.from(${JSON.stringify(foreign.toString("utf8"))}));
            realCloseSync(fd);
            process.kill(process.pid, "SIGKILL");
          }
        },
      },
    });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.signal, "SIGKILL");
  assert.deepEqual(readBytes(filePath), foreign);

  const operationName = readdirSync(TEST_ROOT).find(
    (candidate) => candidate.startsWith(`.${path.basename(filePath)}.`) && candidate.endsWith(".op"),
  );
  assert.ok(operationName);
  const operationPath = path.join(TEST_ROOT, operationName);
  const backupName = readdirSync(operationPath).find((candidate) => candidate.startsWith("backup-"));
  assert.ok(backupName);
  const backupPath = path.join(operationPath, backupName);
  const backupIdentity = inodeIdentity(backupPath);
  let backupOpenCount = 0;
  assertOperationFails("assert-enabled", filePath, {
    fs: {
      openSync(candidate, ...args) {
        const fd = openSync(candidate, ...args);
        if (path.basename(candidate) === backupName && ++backupOpenCount === 2) {
          const mutationFd = openSync(candidate, "r+");
          try {
            const changed = Buffer.alloc(foreign.length, 0x58);
            writeSync(mutationFd, changed, 0, changed.length, 0);
            fsyncSync(mutationFd);
          } finally {
            closeSync(mutationFd);
          }
        }
        return fd;
      },
    },
  });
  assert.equal(backupOpenCount, 2);
  assert.deepEqual(inodeIdentity(backupPath), backupIdentity);
  assert.deepEqual(readBytes(filePath), foreign);
  assert.ok(existsSync(operationPath));
  for (const name of readdirSync(TEST_ROOT)) {
    if (name.includes("recover-backup-hook")) {
      rmSync(path.join(TEST_ROOT, name), { recursive: true, force: true });
    }
  }
});

test("durable restore intent composes candidate and restoration SIGKILL recovery", () => {
  const moduleUrl = pathToFileURL(SCRIPT_PATH).href;
  const filePath = writeProtected(
    "recover-restoration.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const original = readBytes(filePath);
  const childScript = `
    import {
      closeSync as realCloseSync,
      openSync as realOpenSync,
      renameSync as realRenameSync,
      writeSync as realWriteSync,
    } from "node:fs";
    const { runModeForTests } = await import(${JSON.stringify(moduleUrl)});
    const target = ${JSON.stringify(filePath)};
    let candidateSubstituted = false;
    runModeForTests("disable", target, {
      fs: {
        exchangeSync({ sourceDirectory, sourceName, targetDirectory, targetName }) {
          const source = sourceDirectory.path + "/" + sourceName;
          const destination = targetDirectory.path + "/" + targetName;
          if (!candidateSubstituted && destination === target && source.includes("candidate-")) {
            candidateSubstituted = true;
            realRenameSync(source, source + ".candidate-moved");
            const fd = realOpenSync(source, "wx", 0o600);
            realWriteSync(fd, Buffer.from("foreign candidate composition kill\\n"));
            realCloseSync(fd);
          }
          if (destination === target && source.includes("restore-")) {
            realRenameSync(source, source + ".restore-moved");
            const fd = realOpenSync(source, "wx", 0o600);
            realWriteSync(fd, Buffer.from("foreign restoration composition kill\\n"));
            realCloseSync(fd);
            realRenameSync(source, source + ".test-exchange");
            realRenameSync(destination, source);
            const result = realRenameSync(source + ".test-exchange", destination);
            process.kill(process.pid, "SIGKILL");
            return result;
          }
          realRenameSync(source, source + ".test-exchange");
          realRenameSync(destination, source);
          return realRenameSync(source + ".test-exchange", destination);
        },
      },
    });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.signal, "SIGKILL");
  const operationPath = path.join(
    TEST_ROOT,
    readdirSync(TEST_ROOT).find(
      (name) => name.startsWith(`.${path.basename(filePath)}.`) && name.endsWith(".op"),
    ),
  );
  const intentName = readdirSync(operationPath).find((name) => name.startsWith("restore-intent-"));
  const intentPath = path.join(operationPath, intentName);
  const validIntent = readBytes(intentPath);
  const malformedFd = openSync(intentPath, "w");
  writeSync(malformedFd, Buffer.from("{ malformed json\n", "ascii"));
  closeSync(malformedFd);
  const opened = new Set();
  const closed = new Set();
  assertOperationFails("assert-enabled", filePath, {
    fs: {
      openSync(...args) {
        const fd = openSync(...args);
        opened.add(fd);
        return fd;
      },
      closeSync(fd) {
        closed.add(fd);
        return closeSync(fd);
      },
    },
  });
  assert.deepEqual([...opened].filter((fd) => !closed.has(fd)), []);
  const restoreFd = openSync(intentPath, "w");
  writeSync(restoreFd, validIntent);
  closeSync(restoreFd);
  assertOperationFails("assert-enabled", filePath);
  assert.deepEqual(readBytes(filePath), original);
  assert.ok(foreignBytes().some((bytes) => bytes.equals(Buffer.from("foreign candidate composition kill\n"))));
  assert.ok(foreignBytes().some((bytes) => bytes.equals(Buffer.from("foreign restoration composition kill\n"))));
  assertNoOperationDirectories();
});

test("a concurrent original mutation at final rename is restored without stale success", () => {
  const filePath = writeProtected(
    "rename-window-mutation.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const concurrent = Buffer.from(`${TARGET_ASSIGNMENT} = concurrent-value\n`, "ascii");
  const original = readBytes(filePath);
  assert.throws(
    () => runModeForTests("disable", filePath, {
      fs: {
        exchangeSync(args) {
          const source = path.join(args.sourceDirectory.path, args.sourceName);
          const destination = path.join(args.targetDirectory.path, args.targetName);
          if (destination === filePath && source.includes("candidate-")) {
            const fd = openSync(filePath, "r+");
            try {
              writeSync(fd, concurrent, 0, concurrent.length, 0);
            } finally {
              closeSync(fd);
            }
          }
          return exchangeEntries(args);
        },
      },
    }),
    /protected tfvars operation failed/,
  );
  assert.notDeepEqual(concurrent, original);
  assert.deepEqual(readBytes(filePath), concurrent);
  assertNoOperationDirectories();
});

test("operation-directory creation failures remove only the exact created directory", () => {
  const priorArtifacts = operationArtifactPaths();
  for (const [name, override] of [
    ["open", {
      openSync(candidate, ...args) {
        if (path.basename(candidate).endsWith(".op")) {
          const error = new Error("synthetic operation open failure");
          error.code = "EIO";
          throw error;
        }
        return openSync(candidate, ...args);
      },
    }],
    ["fchmod", {
      fchmodSync(fd, mode) {
        let descriptorPath = "";
        try { descriptorPath = readlinkSync(`/proc/self/fd/${fd}`); } catch {}
        if (descriptorPath.endsWith(".op")) {
          const error = new Error("synthetic operation fchmod failure");
          error.code = "EIO";
          throw error;
        }
        return fchmodSync(fd, mode);
      },
    }],
    ["validation", {
      seen: 0,
      lstatSync(candidate, options) {
        const stat = lstatSync(candidate, options);
        if (path.basename(candidate).endsWith(".op") && ++this.seen === 1) {
          const error = new Error("synthetic first post-mkdir lstat failure");
          error.code = "EIO";
          throw error;
        }
        return stat;
      },
    }],
  ]) {
    const filePath = writeProtected(
      `operation-directory-failure-${name}.tfvars`,
      `${TARGET_ASSIGNMENT} = true\n`,
    );
    assertOperationFails("disable", filePath, { fs: override });
    if (name === "open") {
      const preserved = readdirSync(TEST_ROOT).find(
        (candidate) => candidate.startsWith(`.${path.basename(filePath)}.`) && candidate.endsWith(".op"),
      );
      assert.ok(preserved);
      rmSync(path.join(TEST_ROOT, preserved), { recursive: true, force: true });
    } else {
      assertNoNewOperationArtifacts(priorArtifacts);
    }
  }
});

test("temporary creation retries exclusive collisions and uses protected flags", () => {
  const filePath = writeProtected(
    "exclusive-flags.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  let collision = true;
  let temporaryFlags;
  assert.equal(runModeForTests("disable", filePath, {
    fs: {
      openSync(candidate, flags, mode) {
        if (
          path.basename(candidate).startsWith("candidate-") &&
          path.basename(candidate).endsWith(".tmp") &&
          !path.basename(candidate).includes(".quarantine")
        ) {
          temporaryFlags = flags;
          if (collision) {
            collision = false;
            const error = new Error("synthetic collision");
            error.code = "EEXIST";
            throw error;
          }
        }
        return openSync(candidate, flags, mode);
      },
    },
  }), 0);
  assert.equal(collision, false);
  assert.notEqual(temporaryFlags & constants.O_RDWR, 0);
  assert.notEqual(temporaryFlags & constants.O_CREAT, 0);
  assert.notEqual(temporaryFlags & constants.O_EXCL, 0);
  for (const flag of [constants.O_NOFOLLOW, constants.O_CLOEXEC]) {
    if (flag) assert.notEqual(temporaryFlags & flag, 0);
  }
});

test("operation directories bind before chmod and never leak nested .op paths", () => {
  const filePath = writeProtected(
    "operation-directory-bind.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  let operationFlags;
  let pathChmodAttempted = false;
  assert.equal(runModeForTests("disable", filePath, {
    fs: {
      openSync(candidate, flags, mode) {
        if (path.basename(candidate).endsWith(".op")) operationFlags = flags;
        return openSync(candidate, flags, mode);
      },
      chmodSync(candidate, mode) {
        if (path.basename(candidate).endsWith(".op")) pathChmodAttempted = true;
        return chmodSync(candidate, mode);
      },
    },
  }), 0);
  assert.equal(pathChmodAttempted, false);
  assert.notEqual(operationFlags & constants.O_DIRECTORY, 0);
  if (constants.O_NOFOLLOW) assert.notEqual(operationFlags & constants.O_NOFOLLOW, 0);
  assertNoOperationDirectories();
});

test("partial temporary writes are completed before fsync and rename", () => {
  const filePath = writeProtected(
    "partial-write.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  let writes = 0;
  assert.equal(runModeForTests("disable", filePath, {
    fs: {
      writeSync(fd, bytes, offset, length) {
        writes += 1;
        return writeSync(fd, bytes, offset, Math.min(length, 2));
      },
    },
  }), 0);
  assert.ok(writes > 1);
  assert.equal(inspectAssignments(readBytes(filePath)).disabled, true);
});

test("temporary metadata is set before content and fsync precedes rename", () => {
  const filePath = writeProtected(
    "metadata-order.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const events = [];
  const descriptorNames = new Map();
  assert.equal(runModeForTests("disable", filePath, {
    fs: {
      openSync(candidate, ...args) {
        const fd = openSync(candidate, ...args);
        descriptorNames.set(fd, path.basename(candidate));
        events.push({ type: "open", fd, name: path.basename(candidate) });
        return fd;
      },
      fchownSync(...args) {
        events.push({ type: "chown", fd: args[0], name: descriptorNames.get(args[0]) });
        return fchownSync(...args);
      },
      fchmodSync(...args) {
        events.push({ type: "chmod", fd: args[0], name: descriptorNames.get(args[0]) });
        return fchmodSync(...args);
      },
      writeSync(...args) {
        events.push({ type: "write", fd: args[0], name: descriptorNames.get(args[0]) });
        return writeSync(...args);
      },
      fsyncSync(...args) {
        events.push({ type: "fsync", fd: args[0], name: descriptorNames.get(args[0]) });
        return fsyncSync(...args);
      },
      exchangeSync(args) {
        events.push({
          type: "exchange",
          source: path.join(args.sourceDirectory.path, args.sourceName),
          destination: path.join(args.targetDirectory.path, args.targetName),
        });
        return exchangeEntries(args);
      },
    },
  }), 0);
  const candidateOpen = events.find(
    (event) => event.type === "open" && event.name.startsWith("candidate-"),
  );
  assert.ok(candidateOpen);
  const candidateWrite = events.findIndex(
    (event) => event.type === "write" && event.fd === candidateOpen.fd,
  );
  assert.ok(candidateWrite >= 0);
  for (const event of events) {
    if (
      (event.type === "chown" || event.type === "chmod") &&
      event.fd === candidateOpen.fd
    ) {
      assert.ok(events.indexOf(event) < candidateWrite);
    }
  }
  const candidateFsync = events.findIndex(
    (event) => event.type === "fsync" && event.fd === candidateOpen.fd,
  );
  const publication = events.findIndex(
    (event) => event.type === "exchange" && event.destination === filePath,
  );
  const lastFsync = events.reduce(
    (last, event, index) => (event.type === "fsync" ? index : last),
    -1,
  );
  assert.ok(candidateFsync > candidateWrite);
  assert.ok(publication > candidateFsync);
  assert.ok(lastFsync > publication);
});

test("every descriptor opened by a successful replacement is closed", () => {
  const filePath = writeProtected(
    "descriptor-cleanup.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  const opened = new Set();
  const closed = new Set();
  assert.equal(runModeForTests("disable", filePath, {
    fs: {
      openSync(...args) {
        const fd = openSync(...args);
        opened.add(fd);
        return fd;
      },
      closeSync(fd) {
        closed.add(fd);
        return closeSync(fd);
      },
    },
  }), 0);
  assert.deepEqual([...opened].filter((fd) => !closed.has(fd)), []);
});

test("a close failure cannot be reported as a successful replacement", () => {
  const filePath = writeProtected(
    "close-failure.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  let closeCalls = 0;
  assertOperationFails("disable", filePath, {
    fs: {
      closeSync(fd) {
        closeCalls += 1;
        closeSync(fd);
        if (closeCalls === 1) {
          const error = new Error("synthetic close failure");
          error.code = "EIO";
          throw error;
        }
      },
    },
  });
  assert.equal(closeCalls > 0, true);
  assertNoOperationDirectories();
});

test("disable closes the target descriptor on precondition and parser failures", () => {
  for (const [name, contents] of [
    ["precondition", `${TARGET_ASSIGNMENT} = false\n`],
    ["parser", `${TARGET_ASSIGNMENT} = true\n/* unterminated\n`],
  ]) {
    const filePath = writeProtected(`descriptor-failure-${name}.tfvars`, contents);
    const opened = new Set();
    const closed = new Set();
    assertOperationFails("disable", filePath, {
      fs: {
        openSync(...args) {
          const fd = openSync(...args);
          opened.add(fd);
          return fd;
        },
        closeSync(fd) {
          closed.add(fd);
          return closeSync(fd);
        },
      },
    });
    assert.deepEqual([...opened].filter((fd) => !closed.has(fd)), []);
  }
});

test("non-ENOENT temporary cleanup failures are surfaced after descriptor cleanup", () => {
  const filePath = writeProtected(
    "unlink-failure.tfvars",
    `${TARGET_ASSIGNMENT} = true\n`,
  );
  let unlinkAttempted = false;
  assertOperationFails("disable", filePath, {
    fs: {
      exchangeSync(args) {
        if (args.kind === "cleanup" && args.sourceName.startsWith("backup-")) {
          unlinkAttempted = true;
          const error = new Error("synthetic cleanup failure");
          error.code = "EIO";
          throw error;
        }
        return exchangeEntries(args);
      },
    },
  });
  assert.equal(unlinkAttempted, true);
});

test("pre-rename failures close and safely recover private operation entries", () => {
  const priorArtifacts = operationArtifactPaths();
  for (const [name, fsOverride] of [
    ["write", {
      writeSync(fd, ...args) {
        let descriptorPath = "";
        try { descriptorPath = readlinkSync(`/proc/self/fd/${fd}`); } catch {}
        if (path.basename(descriptorPath).startsWith("candidate-")) {
          const error = new Error("synthetic write failure");
          error.code = "EIO";
          throw error;
        }
        return writeSync(fd, ...args);
      },
    }],
    ["file-fsync", {
      fsyncSync() {
        const error = new Error("synthetic file fsync failure");
        error.code = "EIO";
        throw error;
      },
    }],
    ["exchange", {
      exchangeSync() {
        const error = new Error("synthetic exchange failure");
        error.code = "EIO";
        throw error;
      },
    }],
  ]) {
    const filePath = writeProtected(`failure-${name}.tfvars`, `${TARGET_ASSIGNMENT} = true\n`);
    const original = readBytes(filePath);
    assertOperationFails("disable", filePath, { fs: fsOverride });
    assert.deepEqual(readBytes(filePath), original);
    assertNoNewOperationArtifacts(priorArtifacts);
  }
});

test("production locking is exact-FD, exclusive, bounded, and closed", () => {
  const lockPath = path.join(
    path.dirname(PROTECTED_TFVARS_PATH),
    ".terraform.tfvars.lock",
  );
  const lockPreexisted = existsSync(lockPath);
  const protectedBytes = readBytes(PROTECTED_TFVARS_PATH);
  let lockCreatedByTest = false;

  const flockNode = (lockFd, mode = "-x", stdio = ["ignore", "pipe", "pipe"]) =>
    spawnSync(
      "/usr/bin/flock",
      [
        "-n",
        mode,
        "-F",
        `/proc/${process.pid}/fd/${lockFd}`,
        "/usr/bin/node",
        SCRIPT_PATH,
        "--locked",
        "assert-enabled",
      ],
      { encoding: "utf8", stdio },
    );

  try {
    if (!lockPreexisted) {
      const initialized = runCli(["assert-enabled"]);
      lockCreatedByTest = existsSync(lockPath);
      assert.equal(initialized, 0);
    }
    assert.deepEqual(readBytes(PROTECTED_TFVARS_PATH), protectedBytes);

    const exclusiveFd3 = openSync(lockPath, "r+");
    const valid = flockNode(exclusiveFd3);
    closeSync(exclusiveFd3);
    assert.equal(valid.status, 0);
    assert.equal(valid.stdout, "");
    assert.equal(valid.stderr, "");

    const unlockedFd3 = openSync(lockPath, "r+");
    const exclusiveSource = openSync(lockPath, "r+");
    const separateFd4 = flockNode(exclusiveSource, "-x", [
      "ignore",
      "pipe",
      "pipe",
      unlockedFd3,
    ]);
    closeSync(unlockedFd3);
    closeSync(exclusiveSource);
    assert.equal(separateFd4.status, 1);
    assert.equal(separateFd4.stdout, "");
    assert.equal(separateFd4.stderr, "protected tfvars operation failed\n");

    const sharedFd3 = openSync(lockPath, "r+");
    const shared = flockNode(sharedFd3, "-s");
    closeSync(sharedFd3);
    assert.equal(shared.status, 1);
    assert.equal(shared.stdout, "");
    assert.equal(shared.stderr, "protected tfvars operation failed\n");

    const timeoutSource = openSync(lockPath, "r+");
    const timedOut = spawnSync(
      "/usr/bin/flock",
      [
        "-n",
        "-x",
        "-F",
        `/proc/${process.pid}/fd/${timeoutSource}`,
        "/usr/bin/node",
        "-e",
        "setTimeout(() => {}, 60_000)",
      ],
      {
        encoding: "utf8",
        timeout: 250,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    closeSync(timeoutSource);
    assert.equal(timedOut.signal, "SIGKILL");
    assert.equal(timedOut.stdout, "");
    assert.equal(timedOut.stderr, "");

    const reacquireSource = openSync(lockPath, "r+");
    const reacquired = spawnSync(
      "/usr/bin/flock",
      [
        "-n",
        "-x",
        "-F",
        `/proc/${process.pid}/fd/${reacquireSource}`,
        "/usr/bin/true",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    closeSync(reacquireSource);
    assert.equal(reacquired.status, 0);
    assert.equal(reacquired.stdout, "");
    assert.equal(reacquired.stderr, "");

    const success = spawnSync(process.execPath, [SCRIPT_PATH, "assert-enabled"], {
      encoding: "utf8",
    });
    assert.equal(success.status, 0);
    assert.equal(success.stdout, "");
    assert.equal(success.stderr, "");

    const usage = spawnSync(process.execPath, [SCRIPT_PATH, "unknown"], {
      encoding: "utf8",
    });
    assert.equal(usage.status, 2);
    assert.equal(usage.stdout, "");
    assert.equal(usage.stderr, "protected tfvars usage error\n");

    const failure = spawnSync(process.execPath, [SCRIPT_PATH, "assert-disabled"], {
      encoding: "utf8",
    });
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, "");
    assert.equal(failure.stderr, "protected tfvars operation failed\n");
  } finally {
    assert.deepEqual(readBytes(PROTECTED_TFVARS_PATH), protectedBytes);
    if (lockCreatedByTest) rmSync(lockPath);
  }
});
