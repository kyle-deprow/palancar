import { appendFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { ViteDevServer } from "vite";
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

const devHost = process.env.PALANCAR_DEV_HOST;

function palancarDiagnosticsPlugin() {
  return {
    name: "palancar-boot-diagnostics",
    apply: "serve" as const,
    transformIndexHtml: {
      order: "pre" as const,
      handler(html: string): string {
        // Dev only: allow same-origin diagnostic beacons. Vite never runs this
        // hook for `vite build`, so the production CSP is untouched.
        return html.replace("connect-src ", "connect-src 'self' ws: wss: ");
      },
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use((request, response, next) => {
        const routePath = request.url?.split("?", 1)[0];
        if (routePath !== "/__palancar-diag") {
          void appendFile(
            new URL("./palancar-diag.log", import.meta.url),
            `${JSON.stringify({ kind: "request", method: request.method, url: request.url, ua: request.headers["user-agent"], at: Date.now() })}\n`,
          ).catch(() => undefined);
          next();
          return;
        }
        if (request.method === "GET") {
          void readFile(new URL("./palancar-diag.log", import.meta.url), "utf8")
            .then((body) => { response.statusCode = 200; response.end(body); })
            .catch(() => { response.statusCode = 200; response.end(""); });
          return;
        }
        if (request.method !== "POST") {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        request.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16_384) {
            response.statusCode = 413;
            response.end();
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        request.on("end", () => {
          void appendFile(new URL("./palancar-diag.log", import.meta.url), `${Buffer.concat(chunks)}\n`)
            .then(() => { response.statusCode = 204; response.end(); })
            .catch(() => { response.statusCode = 500; response.end(); });
        });
      });
    },
  };
}

export default {
  plugins: [palancarDiagnosticsPlugin()] as NonNullable<ViteUserConfig["plugins"]>,
  server: {
    host: true,
    allowedHosts: ["dev-laptop.tail60fadb.ts.net"],
    ...(devHost === undefined ? {} : { hmr: { host: devHost } }),
  },
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
