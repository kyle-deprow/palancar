import { readFileSync } from "node:fs";
import type { ViteUserConfig } from "vitest/config";

interface RelayOriginConfig {
  readonly mode: "production";
  readonly relayOrigin: string;
}

function loadRelayOriginConfig(): RelayOriginConfig {
  const configPath = new URL("./relay-origin.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("relay-origin.json must contain an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "mode" || keys[1] !== "relayOrigin") {
    throw new TypeError("relay-origin.json must contain only mode and relayOrigin");
  }
  if (record.mode !== "production" || typeof record.relayOrigin !== "string") {
    throw new TypeError("relay-origin.json must configure a production relay origin");
  }
  let origin: URL;
  try {
    origin = new URL(record.relayOrigin);
  } catch {
    throw new TypeError("relay-origin.json must contain a valid relay origin");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== record.relayOrigin ||
    origin.username !== "" ||
    origin.password !== "" ||
    record.relayOrigin.includes("*")
  ) {
    throw new TypeError("relay-origin.json must contain a canonical credential-free HTTPS origin");
  }
  return { mode: "production", relayOrigin: record.relayOrigin };
}

const relayConfig = loadRelayOriginConfig();
const relayOrigin = relayConfig.relayOrigin;

export default {
  define: {
    __PALANCAR_RELAY_ORIGIN__: JSON.stringify(relayOrigin),
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
} satisfies ViteUserConfig;
