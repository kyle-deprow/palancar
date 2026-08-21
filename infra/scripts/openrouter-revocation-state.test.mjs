import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import {
  ENV_KEY,
  RECEIPT_FILE_NAME,
  RAW_RESPONSE_FILE_NAME,
  STATE_FILE_NAME,
  TEST_ADAPTER,
  OPENROUTER_KEY_URL,
  main,
  runOperation,
} from "./openrouter-revocation-state.mjs";

const KEY = "sk-or-v1-test-key-that-must-never-be-printed";
const RAW_LABEL = "sk-or-v1-unmasked-label-that-must-never-be-printed";
const RAW_RESPONSE = JSON.stringify({
  data: {
    label: RAW_LABEL,
    expires_at: "2026-12-31T23:59:59Z",
    limit: 12.5,
    id: "key-id-must-not-be-output",
    usage: 9.25,
    key: KEY,
  },
});
const MASKED_RESPONSE = JSON.stringify({
  data: {
    label: "sk-or-v1-****abcd",
    expires_at: null,
    limit: null,
  },
});
const CRASH_RESPONSE = JSON.stringify({
  data: { label: "child-unmasked-label", expires_at: null, limit: null },
});
const FIXED_NOW = "2026-08-21T15:00:00.000Z";

function makeHarness({
  body = RAW_RESPONSE,
  status = 200,
  env = `${ENV_KEY}=${KEY}\n`,
  responseUrl = OPENROUTER_KEY_URL,
  redirected = false,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "palancar-openrouter-revocation-"));
  const evidenceRoot = path.join(root, "evidence");
  const envPath = path.join(root, ".env");
  mkdirSync(evidenceRoot, { mode: 0o700 });
  writeFileSync(envPath, env, { mode: 0o600 });
  const requests = [];
  let responseBody = body;
  let responseStatus = status;
  let responseEndpoint = responseUrl;
  let responseRedirected = redirected;
  const hooks = {};

  const run = (operation, extra = {}) => runOperation(operation, {
    testAdapter: TEST_ADAPTER,
    envPath,
    evidenceRoot,
    now: () => FIXED_NOW,
    hooks,
    httpGet: async (request) => {
      requests.push(request);
      return {
        status: responseStatus,
        body: responseBody,
        url: responseEndpoint,
        redirected: responseRedirected,
      };
    },
    ...extra,
  });

  return {
    root,
    evidenceRoot,
    envPath,
    requests,
    hooks,
    run,
    setResponse(statusValue, bodyValue = "", metadata = {}) {
      responseStatus = statusValue;
      responseBody = bodyValue;
      responseEndpoint = metadata.url ?? responseEndpoint;
      responseRedirected = metadata.redirected ?? responseRedirected;
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function filePath(harness, name) {
  return path.join(harness.evidenceRoot, name);
}

function mode(filePathValue) {
  return lstatSync(filePathValue).mode & 0o777;
}

function failOnce(harness, hookName) {
  let armed = true;
  harness.hooks[hookName] = () => {
    if (armed) {
      armed = false;
      throw new Error(`injected crash at ${hookName}`);
    }
  };
}

function tempFiles(harness) {
  return readdirSync(harness.evidenceRoot).filter((name) => name.includes(".tmp-"));
}

function mutateStagedTemp(harness, targetName) {
  const name = readdirSync(harness.evidenceRoot)
    .find((candidate) => candidate.startsWith(`${targetName}.tmp-`) ||
      (targetName === STATE_FILE_NAME && candidate.startsWith(`${targetName}.seq-`) && candidate.includes(".tmp-")));
  assert.ok(name, `missing staged ${targetName} temporary`);
  const target = filePath(harness, name);
  const bytes = Buffer.from(readFileSync(target));
  assert.ok(bytes.byteLength > 0);
  bytes[0] ^= 0x01;
  writeFileSync(target, bytes, { mode: 0o600 });
}

function stateEntryNames(harness) {
  return readdirSync(harness.evidenceRoot)
    .filter((name) => name === STATE_FILE_NAME || name.startsWith(`${STATE_FILE_NAME}.seq-`))
    .sort((left, right) => {
      const sequence = (name) => name === STATE_FILE_NAME ? 0 : Number(name.slice(-8));
      return sequence(left) - sequence(right);
    });
}

function publishedState(harness) {
  const names = readdirSync(harness.evidenceRoot)
    .filter((name) => name === STATE_FILE_NAME || name.startsWith(`${STATE_FILE_NAME}.seq-`))
    .sort((left, right) => {
      const sequence = (name) => name === STATE_FILE_NAME ? 0 : Number(name.slice(-8));
      return sequence(left) - sequence(right);
    });
  return JSON.parse(readFileSync(path.join(harness.evidenceRoot, names.at(-1)), "utf8"));
}

function crashChild(harness, operation, hookName, status = 200) {
  const moduleUrl = pathToFileURL(
    path.resolve("infra/scripts/openrouter-revocation-state.mjs"),
  ).href;
  const script = `
    const { runOperation, TEST_ADAPTER, OPENROUTER_KEY_URL } = await import(${JSON.stringify(moduleUrl)});
    await runOperation(${JSON.stringify(operation)}, {
      testAdapter: TEST_ADAPTER,
      envPath: ${JSON.stringify(harness.envPath)},
      evidenceRoot: ${JSON.stringify(harness.evidenceRoot)},
      now: () => ${JSON.stringify(FIXED_NOW)},
      httpGet: async () => ({ status: ${status}, body: ${JSON.stringify(CRASH_RESPONSE)}, url: OPENROUTER_KEY_URL, redirected: false }),
      hooks: { ${JSON.stringify(hookName)}: () => process.kill(process.pid, "SIGKILL") },
    });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("prepare captures the raw 200 response durably and emits only three masked fields", async () => {
  const harness = makeHarness();
  try {
    const result = await harness.run("prepare");
    assert.equal(result.state, "awaiting-user");
    assert.deepEqual(result.output, {
      label: "****",
      expires_at: "2026-12-31T23:59:59Z",
      limit: 12.5,
    });
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].url, "https://openrouter.ai/api/v1/key");
    assert.equal(harness.requests[0].headers.Authorization, `Bearer ${KEY}`);
    assert.deepEqual(Object.keys(result.output), ["label", "expires_at", "limit"]);
    assert.equal(JSON.stringify(result.output).includes(KEY), false);
    assert.equal(JSON.stringify(result.output).includes(RAW_LABEL), false);
    assert.equal(mode(filePath(harness, RAW_RESPONSE_FILE_NAME)), 0o600);
    assert.equal(mode(filePath(harness, STATE_FILE_NAME)), 0o600);
    assert.equal(readFileSync(filePath(harness, RAW_RESPONSE_FILE_NAME), "utf8"), RAW_RESPONSE);
    assert.equal(publishedState(harness).state, "awaiting-user");
  } finally {
    harness.close();
  }
});

test("prepare ignores provider mask markers and never exposes extra response fields", async () => {
  const harness = makeHarness({ body: MASKED_RESPONSE });
  try {
    const result = await harness.run("prepare");
    assert.deepEqual(result.output, {
      label: "****",
      expires_at: null,
      limit: null,
    });
    assert.equal(Object.keys(result.output).length, 3);
  } finally {
    harness.close();
  }
});

test("state advances are immutable create-only sequence entries, not an in-place append", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    const entries = stateEntryNames(harness);
    assert.ok(entries.length >= 3);
    const identities = entries.map((name) => lstatSync(filePath(harness, name)).ino);
    assert.equal(new Set(identities).size, entries.length);
    for (const name of entries) {
      const text = readFileSync(filePath(harness, name), "utf8");
      assert.equal(text.endsWith("\n"), true);
      assert.equal(text.slice(0, -1).includes("\n"), false);
      assert.equal(JSON.parse(text.slice(0, -1)).kind, "openrouter-revocation");
    }
    const first = readFileSync(filePath(harness, entries[0]), "utf8");
    await harness.run("prepare");
    assert.equal(readFileSync(filePath(harness, entries[0]), "utf8"), first);
  } finally {
    harness.close();
  }
});

test("same-inode, same-size staged mutations cannot publish corrupt raw, receipt, or state", async () => {
  const rawHarness = makeHarness();
  try {
    rawHarness.hooks["raw-before-rename"] = () => mutateStagedTemp(rawHarness, RAW_RESPONSE_FILE_NAME);
    await assert.rejects(rawHarness.run("prepare"), { code: "temporary-changed" });
    assert.equal(existsSync(filePath(rawHarness, RAW_RESPONSE_FILE_NAME)), false);
    assert.equal(publishedState(rawHarness).state, "preflight-captured");
  } finally {
    rawHarness.close();
  }

  const receiptHarness = makeHarness();
  try {
    await receiptHarness.run("prepare");
    receiptHarness.setResponse(401);
    receiptHarness.hooks["receipt-before-rename"] = () => mutateStagedTemp(receiptHarness, RECEIPT_FILE_NAME);
    await assert.rejects(receiptHarness.run("resume"), { code: "temporary-changed" });
    assert.equal(existsSync(filePath(receiptHarness, RECEIPT_FILE_NAME)), false);
    assert.equal(publishedState(receiptHarness).state, "awaiting-user");
  } finally {
    receiptHarness.close();
  }

  const stateHarness = makeHarness();
  try {
    stateHarness.hooks["state-before-rename"] = () => mutateStagedTemp(stateHarness, STATE_FILE_NAME);
    await assert.rejects(stateHarness.run("prepare"), { code: "temporary-changed" });
    assert.equal(existsSync(filePath(stateHarness, STATE_FILE_NAME)), false);
    assert.equal(existsSync(filePath(stateHarness, RAW_RESPONSE_FILE_NAME)), false);
  } finally {
    stateHarness.close();
  }
});

test("resume on 200 stays awaiting-user without changing durable evidence", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    const stateBefore = readFileSync(filePath(harness, STATE_FILE_NAME), "utf8");
    const rawBefore = readFileSync(filePath(harness, RAW_RESPONSE_FILE_NAME), "utf8");
    harness.setResponse(200, JSON.stringify({ data: { label: "different", expires_at: null, limit: 1 } }));
    const result = await harness.run("resume");
    assert.equal(result.state, "awaiting-user");
    assert.equal(result.output, undefined);
    assert.equal(harness.requests.length, 2);
    assert.equal(readFileSync(filePath(harness, STATE_FILE_NAME), "utf8"), stateBefore);
    assert.equal(readFileSync(filePath(harness, RAW_RESPONSE_FILE_NAME), "utf8"), rawBefore);
    assert.equal(existsSync(filePath(harness, RECEIPT_FILE_NAME)), false);
  } finally {
    harness.close();
  }
});

test("resume on 401 writes a content-free receipt, advances to revoked, and removes raw evidence", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    harness.setResponse(401, JSON.stringify({ error: "do not retain this response" }));
    const result = await harness.run("resume");
    assert.equal(result.state, "revoked");
    assert.equal(existsSync(filePath(harness, RAW_RESPONSE_FILE_NAME)), false);
    const receiptText = readFileSync(filePath(harness, RECEIPT_FILE_NAME), "utf8");
    const receipt = JSON.parse(receiptText);
    assert.equal(mode(filePath(harness, RECEIPT_FILE_NAME)), 0o600);
    assert.deepEqual(Object.keys(receipt).sort(), [
      "http_status",
      "kind",
      "recorded_at",
      "response_sha256",
      "schema",
      "state",
    ]);
    assert.equal(receipt.http_status, 401);
    assert.equal(receipt.state, "revoked");
    assert.equal(receiptText.includes(KEY), false);
    assert.equal(receiptText.includes(RAW_RESPONSE), false);
    assert.equal(receiptText.includes("do not retain"), false);
  } finally {
    harness.close();
  }
});

test("non-200/non-401 resume fails closed and preserves awaiting-user evidence", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    const before = readFileSync(filePath(harness, STATE_FILE_NAME), "utf8");
    harness.setResponse(429, "provider body must not escape");
    await assert.rejects(harness.run("resume"), { code: "revocation-not-proven" });
    assert.equal(readFileSync(filePath(harness, STATE_FILE_NAME), "utf8"), before);
    assert.equal(existsSync(filePath(harness, RECEIPT_FILE_NAME)), false);
    assert.equal(existsSync(filePath(harness, RAW_RESPONSE_FILE_NAME)), true);
  } finally {
    harness.close();
  }
});

test("mark-local-removed requires local absence, then assert-complete is read-only and idempotent", async () => {
  const harness = makeHarness({ env: `OTHER=value\n${ENV_KEY}=${KEY}\n` });
  try {
    await harness.run("prepare");
    harness.setResponse(401);
    await harness.run("resume");
    await assert.rejects(harness.run("mark-local-removed"), { code: "local-key-present" });
    writeFileSync(harness.envPath, "OTHER=value\n", { mode: 0o600 });
    const result = await harness.run("mark-local-removed");
    assert.equal(result.state, "local-removed");
    const stateBefore = readFileSync(filePath(harness, STATE_FILE_NAME), "utf8");
    assert.deepEqual(await harness.run("assert-complete"), { state: "local-removed" });
    assert.deepEqual(await harness.run("mark-local-removed"), { state: "local-removed" });
    assert.equal(readFileSync(filePath(harness, STATE_FILE_NAME), "utf8"), stateBefore);
  } finally {
    harness.close();
  }
});

test("duplicate local assignments, symlinked .env, and invalid operations fail closed", async () => {
  const harness = makeHarness({ env: `${ENV_KEY}=one\n${ENV_KEY}=two\n` });
  try {
    await assert.rejects(harness.run("prepare"), { code: "invalid-local-key" });
    await assert.rejects(main([]), { code: "invalid-operation" });
    await assert.rejects(main(["prepare", "resume"]), { code: "invalid-operation" });

    const target = path.join(harness.root, "env-target");
    writeFileSync(target, "OTHER=value\n", { mode: 0o600 });
    writeFileSync(harness.envPath, `${ENV_KEY}=${KEY}\n`, { mode: 0o600 });
    await harness.run("prepare");
    harness.setResponse(401);
    await harness.run("resume");
    writeFileSync(harness.envPath, "", { mode: 0o600 });
    await harness.run("mark-local-removed");
    unlinkSync(harness.envPath);
    symlinkSync(target, harness.envPath);
    await assert.rejects(harness.run("assert-complete"), { code: "unsafe-env" });
  } finally {
    harness.close();
  }
});

test("a failed pre-rename publication closes and unlinks its temporary file", async () => {
  const harness = makeHarness();
  try {
    failOnce(harness, "raw-before-rename");
    await assert.rejects(harness.run("prepare"));
    assert.equal(publishedState(harness).state, "preflight-captured");
    assert.equal(existsSync(filePath(harness, RAW_RESPONSE_FILE_NAME)), false);
    assert.deepEqual(tempFiles(harness), []);
    delete harness.hooks["raw-before-rename"];
    assert.equal((await harness.run("prepare")).state, "awaiting-user");
  } finally {
    harness.close();
  }
});

test("a crash after state rename resumes from preflight-captured", async () => {
  const harness = makeHarness();
  try {
    failOnce(harness, "state-after-rename");
    await assert.rejects(harness.run("prepare"));
    assert.equal(publishedState(harness).state, "preflight-captured");
    assert.equal(tempFiles(harness).length, 0);
    delete harness.hooks["state-after-rename"];
    assert.equal((await harness.run("prepare")).state, "awaiting-user");
    assert.equal(harness.requests.length, 2);
  } finally {
    harness.close();
  }
});

test("raw-less 200 recovery refreshes masked dynamics and preserves recovery idempotence", async () => {
  const initial = JSON.parse(RAW_RESPONSE);
  initial.data.account_id = "account-stable";
  const harness = makeHarness({ body: JSON.stringify(initial) });
  try {
    failOnce(harness, "state-after-rename");
    await assert.rejects(harness.run("prepare"));
    delete harness.hooks["state-after-rename"];

    const recovered = JSON.parse(JSON.stringify(initial));
    recovered.data.expires_at = "2027-01-31T23:59:59Z";
    recovered.data.limit = 24.75;
    recovered.data.usage = 11.75;
    recovered.data.updated_at = "2026-08-21T15:01:00.000Z";
    recovered.data.label = "provider-mask-changed";
    harness.setResponse(200, JSON.stringify(recovered));
    const result = await harness.run("prepare");
    assert.equal(result.state, "awaiting-user");
    assert.deepEqual(result.output, {
      label: "****",
      expires_at: recovered.data.expires_at,
      limit: recovered.data.limit,
    });
    assert.deepEqual(await harness.run("prepare"), result);
    assert.deepEqual(await harness.run("resume"), { state: "awaiting-user" });
    assert.equal(harness.requests.length, 3);
    const state = publishedState(harness);
    assert.deepEqual(state.masked, result.output);
    assert.equal(readFileSync(filePath(harness, RAW_RESPONSE_FILE_NAME), "utf8"), JSON.stringify(recovered));
    assert.equal(state.security_identity.key_fingerprint.length, 64);
    assert.equal(state.security_identity.provider_key_fingerprint.length, 64);
    assert.equal(state.security_identity.key_id, "key-id-must-not-be-output");
    assert.equal(state.security_identity.local_mask, "****");
    assert.equal(state.security_identity.endpoint, OPENROUTER_KEY_URL);
    assert.equal(state.security_identity.account_id, "account-stable");
    assert.notEqual(state.raw.sha256, state.response_sha256);
  } finally {
    harness.close();
  }
});

test("raw-less 200 recovery rejects changed key, key id, and account identity", async () => {
  for (const change of ["key", "id", "account_id"]) {
    const initial = JSON.parse(RAW_RESPONSE);
    initial.data.account_id = "account-stable";
    const harness = makeHarness({ body: JSON.stringify(initial) });
    try {
      failOnce(harness, "state-after-rename");
      await assert.rejects(harness.run("prepare"));
      delete harness.hooks["state-after-rename"];
      const changed = JSON.parse(JSON.stringify(initial));
      changed.data[change] = change === "key" ? "a-different-provider-key" : "changed";
      harness.setResponse(200, JSON.stringify(changed));
      await assert.rejects(harness.run("prepare"), { code: "preflight-response-changed" });
      assert.equal(existsSync(filePath(harness, RAW_RESPONSE_FILE_NAME)), false);
      assert.equal(publishedState(harness).state, "preflight-captured");
    } finally {
      harness.close();
    }
  }
});

test("resume refuses to recheck a different local key", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    writeFileSync(harness.envPath, `${ENV_KEY}=a-different-key\n`, { mode: 0o600 });
    harness.setResponse(401);
    await assert.rejects(harness.run("resume"), { code: "local-key-changed" });
    assert.equal(harness.requests.length, 1);
    assert.equal(publishedState(harness).state, "awaiting-user");
    assert.equal(existsSync(filePath(harness, RAW_RESPONSE_FILE_NAME)), true);
  } finally {
    harness.close();
  }
});

test("crashes at receipt/state/raw-removal checkpoints are recovered without a second provider request", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    harness.setResponse(401);
    failOnce(harness, "receipt-after-rename");
    await assert.rejects(harness.run("resume"));
    assert.equal(publishedState(harness).state, "awaiting-user");
    assert.equal(existsSync(filePath(harness, RECEIPT_FILE_NAME)), true);
    delete harness.hooks["receipt-after-rename"];

    failOnce(harness, "state-after-append");
    await assert.rejects(harness.run("resume"));
    assert.equal(publishedState(harness).state, "revoked");
    assert.equal(existsSync(filePath(harness, RAW_RESPONSE_FILE_NAME)), true);
    delete harness.hooks["state-after-rename"];

    failOnce(harness, "raw-after-unlink");
    await assert.rejects(harness.run("resume"));
    assert.equal(existsSync(filePath(harness, RAW_RESPONSE_FILE_NAME)), false);
    delete harness.hooks["raw-after-unlink"];
    assert.deepEqual(await harness.run("resume"), { state: "revoked" });
    assert.equal(harness.requests.length, 2);
  } finally {
    harness.close();
  }
});

test("the operation lock is exclusive and leaves no lock after a normal operation", async () => {
  const harness = makeHarness();
  try {
    const lockPath = path.join(harness.evidenceRoot, "openrouter-revocation.lock");
    writeFileSync(lockPath, "held\n", { mode: 0o600 });
    await assert.rejects(harness.run("assert-complete"), { code: "malformed-lock" });
    unlinkSync(lockPath);
    await assert.rejects(harness.run("assert-complete"), { code: "missing-state" });
    assert.equal(existsSync(lockPath), false);
    writeFileSync(lockPath, "", { mode: 0o600 });
    await assert.rejects(harness.run("assert-complete"), { code: "missing-state" });
    assert.equal(existsSync(lockPath), false);
    writeFileSync(lockPath, "99999999\n", { mode: 0o600 });
    await assert.rejects(harness.run("assert-complete"), { code: "missing-state" });
    assert.equal(existsSync(lockPath), false);
  } finally {
    harness.close();
  }
});

test("lock release rehashes the retained descriptor and preserves a same-inode overwrite", async () => {
  const harness = makeHarness();
  try {
    let before;
    harness.hooks["lock-before-unlink"] = () => {
      const lockPath = filePath(harness, "openrouter-revocation.lock");
      before = readFileSync(lockPath);
      const changed = Buffer.from(before);
      changed[0] ^= 0x01;
      writeFileSync(lockPath, changed, { mode: 0o600 });
    };
    await assert.rejects(harness.run("assert-complete"), { code: "missing-state" });
    const lockPath = filePath(harness, "openrouter-revocation.lock");
    assert.equal(existsSync(lockPath), true);
    assert.notDeepEqual(readFileSync(lockPath), before);
  } finally {
    harness.close();
  }
});

test("stale lock cleanup rehashes the retained descriptor and preserves a same-inode overwrite", async () => {
  const harness = makeHarness();
  try {
    const lockPath = filePath(harness, "openrouter-revocation.lock");
    const payload = "99999999 0123456789abcdef01234567\n";
    writeFileSync(lockPath, payload, { mode: 0o600 });
    let before;
    harness.hooks["lock-before-stale-unlink"] = () => {
      before = readFileSync(lockPath);
      const changed = Buffer.from(before);
      changed[0] ^= 0x01;
      writeFileSync(lockPath, changed, { mode: 0o600 });
    };
    await assert.rejects(harness.run("assert-complete"), { code: "lock-changed" });
    assert.equal(existsSync(lockPath), true);
    assert.notDeepEqual(readFileSync(lockPath), before);
  } finally {
    harness.close();
  }
});

test("a release failure after a durable result is deterministic and does not replay the operation", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    const entriesBefore = stateEntryNames(harness).length;
    failOnce(harness, "lock-before-unlink");
    assert.equal((await harness.run("resume")).state, "awaiting-user");
    assert.equal(stateEntryNames(harness).length, entriesBefore);
    assert.equal((await harness.run("resume")).state, "awaiting-user");
    assert.equal(stateEntryNames(harness).length, entriesBefore);
    assert.equal(existsSync(filePath(harness, "openrouter-revocation.lock")), false);
  } finally {
    harness.close();
  }
});

test("fixed production paths cannot be replaced through the test adapter gate", async () => {
  await assert.rejects(
    runOperation("assert-complete", { evidenceRoot: "/tmp/forged-root" }),
    { code: "test-adapter-required" },
  );
});

test("a foreign endpoint or redirect cannot prove a 401 revocation", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    harness.setResponse(401, "foreign", { url: "https://attacker.invalid/api/v1/key" });
    await assert.rejects(harness.run("resume"), { code: "provider-endpoint" });
    harness.setResponse(401, "redirected", { url: OPENROUTER_KEY_URL, redirected: true });
    await assert.rejects(harness.run("resume"), { code: "provider-endpoint" });
    assert.equal(existsSync(filePath(harness, RECEIPT_FILE_NAME)), false);
    assert.equal(publishedState(harness).state, "awaiting-user");
  } finally {
    harness.close();
  }
});

test("the complete provider request, including body consumption, has a deadline", async () => {
  const harness = makeHarness();
  try {
    await assert.rejects(
      harness.run("prepare", {
        httpTimeoutMs: 20,
        httpGet: async () => new Promise(() => {}),
      }),
      { code: "provider-deadline" },
    );
    assert.deepEqual(tempFiles(harness), []);
    assert.equal(existsSync(filePath(harness, STATE_FILE_NAME)), false);
  } finally {
    harness.close();
  }
});

test(".env mode and every evidence ancestor are checked before sensitive access", async () => {
  const harness = makeHarness();
  try {
    chmodSync(harness.envPath, 0o640);
    await assert.rejects(harness.run("prepare"), { code: "unsafe-env" });
    chmodSync(harness.envPath, 0o600);
    chmodSync(harness.evidenceRoot, 0o755);
    await assert.rejects(harness.run("assert-complete"), { code: "unsafe-evidence-root" });
    chmodSync(harness.evidenceRoot, 0o700);

    const linkedParent = path.join(harness.root, "linked-parent");
    const realParent = path.join(harness.root, "real-parent");
    mkdirSync(realParent, { mode: 0o700 });
    symlinkSync(realParent, linkedParent);
    await assert.rejects(
      runOperation("prepare", {
        testAdapter: TEST_ADAPTER,
        envPath: path.join(linkedParent, ".env"),
        evidenceRoot: harness.evidenceRoot,
        now: () => FIXED_NOW,
        hooks: {},
        httpGet: async () => ({ status: 200, body: RAW_RESPONSE, url: OPENROUTER_KEY_URL, redirected: false }),
      }),
      { code: "unsafe-ancestor" },
    );
  } finally {
    harness.close();
  }
});

test("mark-local-removed accepts only the exact byte-preserving utility result", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    harness.setResponse(401);
    await harness.run("resume");
    writeFileSync(harness.envPath, "OTHER=arbitrary\n", { mode: 0o600 });
    await assert.rejects(harness.run("mark-local-removed"), { code: "local-file-changed" });
    unlinkSync(harness.envPath);
    assert.equal((await harness.run("mark-local-removed")).state, "local-removed");
    writeFileSync(harness.envPath, "OTHER=arbitrary\n", { mode: 0o600 });
    await assert.rejects(harness.run("assert-complete"), { code: "local-file-changed" });
  } finally {
    harness.close();
  }
});

test("missing .env is accepted only when the prepared transformed output is empty", async () => {
  const harness = makeHarness({ env: `OTHER=value\n${ENV_KEY}=${KEY}\n` });
  try {
    await harness.run("prepare");
    harness.setResponse(401);
    await harness.run("resume");
    unlinkSync(harness.envPath);
    await assert.rejects(harness.run("mark-local-removed"), { code: "local-file-changed" });
    writeFileSync(harness.envPath, "OTHER=value\n", { mode: 0o600 });
    assert.equal((await harness.run("mark-local-removed")).state, "local-removed");
  } finally {
    harness.close();
  }
});

test("raw unlink is bound to the original descriptor and never deletes a substitute", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    harness.setResponse(401);
    await harness.run("resume", {
      hooks: {
        "raw-before-unlink": () => {
          renameSync(filePath(harness, RAW_RESPONSE_FILE_NAME), path.join(harness.root, "original-raw"));
          writeFileSync(filePath(harness, RAW_RESPONSE_FILE_NAME), "substitute", { mode: 0o600 });
        },
      },
    }).then(() => assert.fail("substitute must fail closed"), (error) => {
      assert.equal(error.code, "raw-response-changed");
    });
    assert.equal(readFileSync(filePath(harness, RAW_RESPONSE_FILE_NAME), "utf8"), "substitute");
    assert.equal(existsSync(path.join(harness.root, "original-raw")), true);
  } finally {
    harness.close();
  }
});

test("raw unlink rehashes the retained descriptor immediately before deletion", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    harness.setResponse(401);
    harness.hooks["raw-before-unlink"] = () => {
      const raw = Buffer.from(readFileSync(filePath(harness, RAW_RESPONSE_FILE_NAME)));
      raw[0] ^= 0x01;
      writeFileSync(filePath(harness, RAW_RESPONSE_FILE_NAME), raw, { mode: 0o600 });
    };
    await assert.rejects(harness.run("resume"), { code: "raw-response-changed" });
    assert.equal(existsSync(filePath(harness, RAW_RESPONSE_FILE_NAME)), true);
  } finally {
    harness.close();
  }
});

test("receipt plus state evidence recovers after raw loss without accepting a different key", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    harness.setResponse(401);
    failOnce(harness, "receipt-after-rename");
    await assert.rejects(harness.run("resume"));
    unlinkSync(filePath(harness, RAW_RESPONSE_FILE_NAME));
    assert.deepEqual(await harness.run("resume"), { state: "revoked" });
    assert.equal(harness.requests.length, 2);
  } finally {
    harness.close();
  }

  const changedHarness = makeHarness();
  try {
    await changedHarness.run("prepare");
    changedHarness.setResponse(401);
    failOnce(changedHarness, "receipt-after-rename");
    await assert.rejects(changedHarness.run("resume"));
    writeFileSync(changedHarness.envPath, `${ENV_KEY}=different-key\n`, { mode: 0o600 });
    unlinkSync(filePath(changedHarness, RAW_RESPONSE_FILE_NAME));
    await assert.rejects(changedHarness.run("resume"), { code: "local-key-changed" });
  } finally {
    changedHarness.close();
  }
});

test("no-replace publication rejects a destination race without overwriting it", async () => {
  const harness = makeHarness();
  try {
    harness.hooks["raw-before-rename"] = () => {
      writeFileSync(filePath(harness, RAW_RESPONSE_FILE_NAME), "foreign", { mode: 0o600 });
    };
    await assert.rejects(harness.run("prepare"), { code: "file-already-exists" });
    assert.equal(readFileSync(filePath(harness, RAW_RESPONSE_FILE_NAME), "utf8"), "foreign");
    assert.equal(publishedState(harness).state, "preflight-captured");
  } finally {
    harness.close();
  }
});

test("recovery removes only manifest-owned temporaries and preserves foreign pattern matches", async () => {
  const harness = makeHarness();
  try {
    const foreignName = `${RAW_RESPONSE_FILE_NAME}.tmp-999999-0123456789abcdef01234567`;
    const foreignPath = filePath(harness, foreignName);
    writeFileSync(foreignPath, "foreign-remnant", { mode: 0o600 });
    await harness.run("prepare");
    assert.equal(readFileSync(foreignPath, "utf8"), "foreign-remnant");
    assert.equal(tempFiles(harness).includes(foreignName), true);
  } finally {
    harness.close();
  }
});

test("state and lock pathname substitutions are rejected without deleting the original", async () => {
  const stateHarness = makeHarness();
  try {
    stateHarness.hooks["state-before-append"] = () => {
      renameSync(filePath(stateHarness, STATE_FILE_NAME), path.join(stateHarness.root, "original-state"));
      writeFileSync(filePath(stateHarness, STATE_FILE_NAME), "foreign-state\n", { mode: 0o600 });
    };
    await assert.rejects(stateHarness.run("prepare"), { code: "state-changed" });
    assert.equal(existsSync(path.join(stateHarness.root, "original-state")), true);
    assert.equal(readFileSync(filePath(stateHarness, STATE_FILE_NAME), "utf8"), "foreign-state\n");
  } finally {
    stateHarness.close();
  }

  const lockHarness = makeHarness();
  try {
    await lockHarness.run("prepare");
    lockHarness.hooks["lock-before-unlink"] = () => {
      renameSync(path.join(lockHarness.evidenceRoot, "openrouter-revocation.lock"), path.join(lockHarness.root, "original-lock"));
      writeFileSync(path.join(lockHarness.evidenceRoot, "openrouter-revocation.lock"), "foreign-lock\n", { mode: 0o600 });
    };
    assert.equal((await lockHarness.run("resume")).state, "awaiting-user");
    assert.equal(existsSync(path.join(lockHarness.root, "original-lock")), true);
    assert.equal(readFileSync(path.join(lockHarness.evidenceRoot, "openrouter-revocation.lock"), "utf8"), "foreign-lock\n");
  } finally {
    lockHarness.close();
  }
});

test("malformed state and mode evidence fail closed", async () => {
  const harness = makeHarness();
  try {
    await harness.run("prepare");
    writeFileSync(filePath(harness, STATE_FILE_NAME), "not-json\n", { mode: 0o600 });
    await assert.rejects(harness.run("assert-complete"), { code: "malformed-evidence" });
    await harness.run("prepare").catch(() => {});
    chmodSync(filePath(harness, STATE_FILE_NAME), 0o640);
    await assert.rejects(harness.run("assert-complete"), { code: "unsafe-file" });
  } finally {
    harness.close();
  }
});

test("pre-rename close and cleanup failures are surfaced and recovery removes only bound temps", async () => {
  const closeHarness = makeHarness();
  try {
    failOnce(closeHarness, "state-temp-before-close");
    await assert.rejects(closeHarness.run("prepare"));
    assert.equal(existsSync(filePath(closeHarness, STATE_FILE_NAME)), false);
    assert.deepEqual(tempFiles(closeHarness), []);
  } finally {
    closeHarness.close();
  }

  const cleanupHarness = makeHarness();
  try {
    cleanupHarness.hooks["state-before-rename"] = () => {
      throw new Error("pre-rename failure");
    };
    cleanupHarness.hooks["temporary-before-unlink"] = () => {
      throw new Error("unlink failure");
    };
    await assert.rejects(cleanupHarness.run("prepare"));
    assert.equal(existsSync(filePath(cleanupHarness, STATE_FILE_NAME)), false);
    assert.equal(tempFiles(cleanupHarness).length, 1);
    delete cleanupHarness.hooks["temporary-before-unlink"];
    delete cleanupHarness.hooks["state-before-rename"];
    assert.equal((await cleanupHarness.run("prepare")).state, "awaiting-user");
    assert.deepEqual(tempFiles(cleanupHarness), []);
  } finally {
    cleanupHarness.close();
  }
});

test("true crashes at every prepare publication checkpoint recover without normal release", async () => {
  const checkpoints = [
    "lock-manifest-opened", "lock-manifest-written", "lock-manifest-fsynced",
    "lock-temp-opened", "lock-temp-written", "lock-temp-fsynced",
    "lock-temp-before-close", "lock-before-rename", "lock-after-rename",
    "lock-directory-fsynced", "state-manifest-opened", "state-manifest-written",
    "state-manifest-fsynced",
    "state-temp-opened", "state-temp-written", "state-temp-fsynced",
    "state-temp-before-close", "state-before-rename", "state-after-rename",
    "state-directory-fsynced", "raw-temp-opened", "raw-temp-written",
    "raw-temp-fsynced", "raw-temp-before-close", "raw-before-rename",
    "raw-after-rename", "raw-directory-fsynced", "state-before-append",
    "state-after-append", "state-directory-fsynced", "publication-committed",
  ];
  for (const checkpoint of checkpoints) {
    const harness = makeHarness({ body: CRASH_RESPONSE });
    try {
      const child = crashChild(harness, "prepare", checkpoint);
      assert.equal(child.signal, "SIGKILL", checkpoint);
      assert.equal((await harness.run("prepare")).state, "awaiting-user");
      assert.deepEqual(tempFiles(harness), [], checkpoint);
    } finally {
      harness.close();
    }
  }
});

test("true crashes at receipt, state, and raw-removal checkpoints recover safely", async () => {
  const checkpoints = [
    "receipt-manifest-opened", "receipt-manifest-written", "receipt-manifest-fsynced",
    "receipt-temp-opened", "receipt-temp-written", "receipt-temp-fsynced",
    "receipt-temp-before-close", "receipt-before-rename", "receipt-after-rename",
    "receipt-directory-fsynced", "state-manifest-opened", "state-manifest-written",
    "state-manifest-fsynced", "state-temp-opened", "state-temp-written",
    "state-temp-fsynced", "state-temp-before-close", "state-before-append",
    "state-after-append", "state-directory-fsynced", "raw-before-unlink",
    "raw-before-close", "raw-after-unlink", "raw-directory-fsynced",
  ];
  for (const checkpoint of checkpoints) {
    const harness = makeHarness();
    try {
      await harness.run("prepare");
      const child = crashChild(harness, "resume", checkpoint, 401);
      assert.equal(child.signal, "SIGKILL", checkpoint);
      harness.setResponse(401);
      assert.deepEqual(await harness.run("resume"), { state: "revoked" });
      assert.equal(existsSync(filePath(harness, RAW_RESPONSE_FILE_NAME)), false);
    } finally {
      harness.close();
    }
  }
});

test("true crashes while publishing local-removed recover after exact local removal", async () => {
  const checkpoints = [
    "state-manifest-opened", "state-manifest-written", "state-manifest-fsynced",
    "state-temp-opened", "state-temp-written", "state-temp-fsynced",
    "state-temp-before-close", "state-before-append", "state-after-append",
    "state-directory-fsynced",
  ];
  for (const checkpoint of checkpoints) {
    const harness = makeHarness();
    try {
      await harness.run("prepare");
      harness.setResponse(401);
      await harness.run("resume");
      writeFileSync(harness.envPath, "", { mode: 0o600 });
      const child = crashChild(harness, "mark-local-removed", checkpoint);
      assert.equal(child.signal, "SIGKILL", checkpoint);
      assert.deepEqual(await harness.run("mark-local-removed"), { state: "local-removed" });
      assert.deepEqual(await harness.run("assert-complete"), { state: "local-removed" });
    } finally {
      harness.close();
    }
  }
});
