import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const validatorPath = join(appDirectory, "scripts", "validate-relay-origin.mjs");
const fixtureFiles = ["relay-origin.json", "app.json", "index.html", "vite.config.ts"] as const;
const temporaryDirectories: string[] = [];

const requiredIds = [
  "palancar-phone-app",
  "palancar-auth-status",
  "palancar-pairing-form",
  "palancar-pairing-code",
  "palancar-pairing-submit",
  "palancar-storage-actions",
  "palancar-storage-retry",
  "palancar-storage-reset",
  "palancar-enrolled-actions",
  "palancar-revoke-start",
  "palancar-revoke-confirm",
  "palancar-revoke-cancel",
] as const;

const buttonIds = [
  "palancar-pairing-submit",
  "palancar-storage-retry",
  "palancar-storage-reset",
  "palancar-revoke-start",
  "palancar-revoke-confirm",
  "palancar-revoke-cancel",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "palancar-relay-origin-"));
  temporaryDirectories.push(directory);
  await Promise.all(fixtureFiles.map((file) =>
    cp(join(appDirectory, file), join(directory, file))));
  return directory;
}

function runValidator(directory: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [validatorPath, directory], {
    encoding: "utf8",
  });
}

async function mutateFixture(
  file: (typeof fixtureFiles)[number],
  mutate: (source: string) => string,
): Promise<ReturnType<typeof spawnSync>> {
  const directory = await createFixture();
  const path = join(directory, file);
  await writeFile(path, mutate(await readFile(path, "utf8")), "utf8");
  return runValidator(directory);
}

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("G2 browser shell", () => {
  it("provides each required semantic control exactly once", async () => {
    const html = await readFile(join(appDirectory, "index.html"), "utf8");

    for (const id of requiredIds) {
      const matches = html.match(new RegExp(`\\bid=["']${escapeRegExp(id)}["']`, "g"));
      expect(matches, id).toHaveLength(1);
    }
    expect(html).toMatch(/<main\b[^>]*id="palancar-phone-app"/);
    expect(html).toMatch(/<h1\b[^>]*>Palancar Translate<\/h1>/);
    expect(html).toMatch(/id="palancar-auth-status"[^>]*role="status"/);
    expect(html).toMatch(/<form\b[^>]*id="palancar-pairing-form"[^>]*aria-labelledby=/);
    expect(html).toMatch(/<label\b[^>]*for="palancar-pairing-code"/);
    expect(html).toMatch(/<section\b[^>]*id="palancar-storage-actions"[^>]*aria-labelledby=/);
    expect(html).toMatch(/<section\b[^>]*id="palancar-enrolled-actions"[^>]*aria-labelledby=/);
  });

  it("keeps the password and actions safe before JavaScript starts", async () => {
    const html = await readFile(join(appDirectory, "index.html"), "utf8");
    const input = html.match(/<input\b[^>]*id="palancar-pairing-code"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).toContain('type="password"');
    expect(input).toContain('minlength="6"');
    expect(input).toContain('maxlength="6"');
    expect(input).toContain('pattern="^[0-9]{6}$"');
    expect(input).toContain('autocomplete="off"');
    expect(input).toContain('autocapitalize="off"');
    expect(input).toContain('autocorrect="off"');
    expect(input).toContain('spellcheck="false"');
    expect(input).not.toMatch(/\bname=/);
    expect(input).not.toMatch(/\bvalue=/);

    for (const id of buttonIds) {
      const button = html.match(new RegExp(
        `<button\\b[^>]*id=["']${escapeRegExp(id)}["'][^>]*>`,
      ))?.[0];
      expect(button, id).toBeDefined();
      expect(button, id).toMatch(/\btype="(?:button|submit)"/);
    }
    for (const id of [
      "palancar-pairing-form",
      "palancar-storage-actions",
      "palancar-enrolled-actions",
      "palancar-revoke-confirm",
      "palancar-revoke-cancel",
    ]) {
      expect(html.match(new RegExp(
        `<[^>]+\\bid=["']${escapeRegExp(id)}["'][^>]*>`,
      ))?.[0], id).toMatch(/\bhidden\b/);
    }
  });

  it("loads one external stylesheet and one external module without inline code", async () => {
    const html = await readFile(join(appDirectory, "index.html"), "utf8");
    expect(html.match(/<link\b[^>]*rel="stylesheet"[^>]*href="\/src\/phone-ui\.css"[^>]*>/g))
      .toHaveLength(1);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toMatch(/\btype="module"/);
    expect(scripts[0]?.[1]).toMatch(/\bsrc="\/src\/main\.ts"/);
    expect(scripts[0]?.[2]?.trim()).toBe("");
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

describe("relay origin validator", () => {
  it("accepts the repository shell, manifest, config, CSP, and Vite definition", async () => {
    const result = runValidator(appDirectory);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Validated relay origin: https://");
  });

  it.each([
    "http://relay.example.test",
    "https://user:secret@relay.example.test",
    "https://*.example.test",
    "https://relay.example.test/path",
  ])("rejects non-production or non-canonical config origin %s", async (relayOrigin) => {
    const result = await mutateFixture("relay-origin.json", () => JSON.stringify({
      mode: "production",
      relayOrigin,
    }));
    expect(result.status).not.toBe(0);
  });

  it("rejects non-production mode", async () => {
    const result = await mutateFixture("relay-origin.json", (source) => source.replace(
      '"mode": "production"',
      '"mode": "mock-development"',
    ));
    expect(result.status).not.toBe(0);
  });

  it("rejects manifest whitelist extras", async () => {
    const result = await mutateFixture("app.json", (source) => source.replace(
      /"whitelist": \[([^\]]+)\]/,
      '"whitelist": [$1, "https://evil.example.test"]',
    ));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("network whitelist must exactly equal");
  });

  it.each([
    " https://evil.example.test",
    " *",
    " 'unsafe-inline'",
    "; frame-ancestors 'none'",
  ])("rejects an extra or unsafe CSP source %s", async (extraSource) => {
    const result = await mutateFixture("index.html", (source) => source.replace(
      /(connect-src https:\/\/[^\s"]+ wss:\/\/[^\s"]+)/,
      `$1${extraSource}`,
    ));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Content-Security-Policy must exactly match");
  });

  it("rejects a wrong hard-coded Vite compile-time definition", async () => {
    const result = await mutateFixture("vite.config.ts", (source) => source.replace(
      "JSON.stringify(relayOrigin)",
      'JSON.stringify("https://evil.example.test")',
    ));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Effective Vite define must exactly contain");
  });

  it("rejects comment and dead-code decoys around a malicious effective definition", async () => {
    const result = await mutateFixture("vite.config.ts", (source) => source
      .replace(
        "export default {",
        `const deadConfig = false
  ? { define: { __PALANCAR_RELAY_ORIGIN__: JSON.stringify(relayOrigin) } }
  : undefined;
void deadConfig;

export default {`,
      )
      .replace(
        "    __PALANCAR_RELAY_ORIGIN__: JSON.stringify(relayOrigin),",
        `    /* __PALANCAR_RELAY_ORIGIN__: JSON.stringify(relayOrigin), */
    __PALANCAR_RELAY_ORIGIN__: JSON.stringify("https://evil.example.test"),`,
      ));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Effective Vite define must exactly contain");
  });

  it("rejects a later spread that overrides the canonical definition", async () => {
    const result = await mutateFixture("vite.config.ts", (source) => source.replace(
      "    __PALANCAR_RELAY_ORIGIN__: JSON.stringify(relayOrigin),",
      `    __PALANCAR_RELAY_ORIGIN__: JSON.stringify(relayOrigin),
    ...{
      __PALANCAR_RELAY_ORIGIN__: JSON.stringify("https://evil.example.test"),
    },`,
    ));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Effective Vite define must exactly contain");
  });
});
