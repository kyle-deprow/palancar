import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const appDirectory = resolve(import.meta.dirname, "..");
const configPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(appDirectory, "relay-origin.json");

const parseJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const config = await parseJson(configPath);
const manifest = await parseJson(resolve(appDirectory, "app.json"));
const keys = Object.keys(config).sort();

if (keys.join(",") !== "mode,relayOrigin") {
  throw new Error("Relay origin config must contain only mode and relayOrigin");
}
if (config.mode !== "mock-development" && config.mode !== "production") {
  throw new Error("Relay origin mode must be mock-development or production");
}

const origin = new URL(config.relayOrigin);
if (origin.origin !== config.relayOrigin || origin.username || origin.password) {
  throw new Error("Relay origin must be a credential-free URL origin");
}
if (
  config.mode === "mock-development" &&
  config.relayOrigin !== "http://localhost:8787"
) {
  throw new Error("Mock development is pinned to http://localhost:8787");
}
if (config.mode === "production" && origin.protocol !== "https:") {
  throw new Error("Production relay origins must use HTTPS");
}
if (config.relayOrigin.includes("*")) {
  throw new Error("Relay origin wildcards are forbidden");
}

const networkPermission = manifest.permissions.find(
  (permission) => permission.name === "network",
);
if (
  !networkPermission ||
  networkPermission.whitelist.length !== 1 ||
  networkPermission.whitelist[0] !== config.relayOrigin
) {
  throw new Error("app.json network whitelist must equal the validated relay origin");
}

console.log(`Validated relay origin: ${config.relayOrigin}`);
