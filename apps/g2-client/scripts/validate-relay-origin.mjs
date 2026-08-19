import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfigFromFile } from "vite";

const defaultAppDirectory = resolve(import.meta.dirname, "..");

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readUtf8 = (path) => readFile(path, "utf8");

async function parseJson(path, label) {
  let source;
  try {
    source = await readUtf8(path);
  } catch (error) {
    throw new Error(`${label} could not be read`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON`, { cause: error });
  }
}

export function validateRelayConfig(value) {
  if (!isRecord(value)) {
    throw new Error("relay-origin.json must contain an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "mode" || keys[1] !== "relayOrigin") {
    throw new Error("relay-origin.json must contain only mode and relayOrigin");
  }
  if (value.mode !== "production" || typeof value.relayOrigin !== "string") {
    throw new Error("relay-origin.json must configure production mode and a relay origin");
  }

  let origin;
  try {
    origin = new URL(value.relayOrigin);
  } catch (error) {
    throw new Error("Relay origin must be a valid URL origin", { cause: error });
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== value.relayOrigin ||
    origin.username !== "" ||
    origin.password !== "" ||
    value.relayOrigin.includes("*")
  ) {
    throw new Error("Production relay origin must be canonical, credential-free, and HTTPS");
  }
  return Object.freeze({ mode: "production", relayOrigin: value.relayOrigin });
}

export function deriveWebSocketOrigin(relayOrigin) {
  const websocketOrigin = new URL(relayOrigin);
  websocketOrigin.protocol = "wss:";
  return websocketOrigin.origin;
}

export function expectedContentSecurityPolicy(relayOrigin) {
  const websocketOrigin = deriveWebSocketOrigin(relayOrigin);
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "worker-src 'none'",
    `connect-src ${relayOrigin} ${websocketOrigin}`,
  ].join("; ");
}

function validateManifest(manifest, relayOrigin) {
  if (!isRecord(manifest) || !Array.isArray(manifest.permissions)) {
    throw new Error("app.json must contain a permissions array");
  }
  const networkPermissions = manifest.permissions.filter(
    (permission) => isRecord(permission) && permission.name === "network",
  );
  if (networkPermissions.length !== 1) {
    throw new Error("app.json must contain exactly one network permission");
  }
  const whitelist = networkPermissions[0].whitelist;
  if (
    !Array.isArray(whitelist) ||
    whitelist.length !== 1 ||
    whitelist[0] !== relayOrigin
  ) {
    throw new Error("app.json network whitelist must exactly equal the relay origin");
  }
}

function attributeValue(tag, attributeName) {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escapedName}\\s*=\\s*(["'])(.*?)\\1`, "is"));
  return match?.[2];
}

function validateHtmlCsp(html, relayOrigin) {
  const metaTags = html.match(/<meta\b[^>]*>/gis) ?? [];
  const cspTags = metaTags.filter((tag) =>
    attributeValue(tag, "http-equiv")?.toLowerCase() === "content-security-policy");
  if (cspTags.length !== 1) {
    throw new Error("index.html must contain exactly one Content-Security-Policy meta tag");
  }
  const content = attributeValue(cspTags[0], "content");
  if (content !== expectedContentSecurityPolicy(relayOrigin)) {
    throw new Error("index.html Content-Security-Policy must exactly match the relay policy");
  }
}

async function validateEffectiveViteConfig(projectDirectory, relayOrigin) {
  let loaded;
  try {
    loaded = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isSsrBuild: false,
        isPreview: false,
      },
      resolve(projectDirectory, "vite.config.ts"),
      projectDirectory,
      "silent",
    );
  } catch (error) {
    throw new Error("vite.config.ts could not be loaded", { cause: error });
  }
  const define = loaded?.config?.define;
  if (!isRecord(define)) {
    throw new Error("Effective Vite config must define the relay origin");
  }
  const keys = Reflect.ownKeys(define);
  const descriptor = Object.getOwnPropertyDescriptor(
    define,
    "__PALANCAR_RELAY_ORIGIN__",
  );
  if (
    keys.length !== 1 ||
    keys[0] !== "__PALANCAR_RELAY_ORIGIN__" ||
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.value !== JSON.stringify(relayOrigin)
  ) {
    throw new Error(
      "Effective Vite define must exactly contain the configured relay origin",
    );
  }
}

export async function validateRelayOriginProject(appDirectory = defaultAppDirectory) {
  const projectDirectory = resolve(appDirectory);
  const config = validateRelayConfig(await parseJson(
    resolve(projectDirectory, "relay-origin.json"),
    "relay-origin.json",
  ));
  const manifest = await parseJson(resolve(projectDirectory, "app.json"), "app.json");
  const html = await readUtf8(resolve(projectDirectory, "index.html"));

  validateManifest(manifest, config.relayOrigin);
  validateHtmlCsp(html, config.relayOrigin);
  await validateEffectiveViteConfig(projectDirectory, config.relayOrigin);
  return Object.freeze({
    relayOrigin: config.relayOrigin,
    websocketOrigin: deriveWebSocketOrigin(config.relayOrigin),
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const appDirectory = process.argv[2] === undefined
    ? defaultAppDirectory
    : resolve(process.cwd(), process.argv[2]);
  const result = await validateRelayOriginProject(appDirectory);
  console.log(`Validated relay origin: ${result.relayOrigin}`);
}
