import { spawnSync as defaultSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import * as https from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AZ_PATH = "/usr/bin/az";
const AZ_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 15_000;
const AUTH_JSON_MAX_BYTES = 256 * 1024;
const TOKEN_MAX_BYTES = 16 * 1024;
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const CONFIG_MAX_BYTES = 4 * 1024 * 1024;
const BLOB_LOCATION_MAX_BYTES = 16 * 1024;
const BLOB_SAS_VALUE_MAX_BYTES = 2 * 1024;
const MAX_LAYERS = 128;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_DESCRIPTOR_BYTES = 64 * 1024 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SERVER_RE = /^[a-z0-9]{5,50}\.azurecr\.io$/;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json";
const OCI_LAYER_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.oci.image.layer.v1.tar+zstd",
]);
const DOCKER_LAYER_MEDIA_TYPES = new Set([
  "application/vnd.docker.image.rootfs.diff.tar",
  "application/vnd.docker.image.rootfs.diff.tar.gzip",
  "application/vnd.docker.image.rootfs.diff.tar.zstd",
]);
const MANIFEST_MEDIA_TYPES = new Set([OCI_MANIFEST, DOCKER_MANIFEST]);
const BLOB_SAS_KEYS = new Set(["regid", "se", "sig", "ske", "skoid", "sks", "skt", "sktid", "skv", "sp", "spr", "sr", "sv"]);
const PLATFORM_CANONICAL_KEYS = new Set(["os", "architecture", "variant"]);
const PLATFORM_SIGNIFICANT_KEYS = new Set([
  "os", "architecture", "variant", "platform", "platforms", "osversion", "osfeatures",
  "os.version", "os.features", "architecturevariant",
]);

class VerificationError extends Error {
  constructor(code) {
    super(`image-platform-verification:${code}`);
    this.name = "VerificationError";
    this.code = code;
  }
}

function reject(code) {
  throw new VerificationError(code);
}

function failIf(condition, code) {
  if (condition) reject(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, code) {
  failIf(!isObject(value), code);
  const allowed = new Set(keys);
  failIf(Object.keys(value).some((key) => !allowed.has(key)), code);
  failIf(keys.some((key) => !Object.hasOwn(value, key)), code);
}

function assertNoDuplicateJsonKeys(source, code) {
  let index = 0;
  const skipWhitespace = () => {
    while (index < source.length && /[\u0009\u000a\u000d\u0020]/.test(source[index])) index += 1;
  };
  const scanString = () => {
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source.charCodeAt(index);
      if (character === 0x22) {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (character === 0x5c) {
        index += 2;
        continue;
      }
      failIf(character < 0x20, code);
      index += 1;
    }
    reject(code);
  };
  const scanValue = () => {
    skipWhitespace();
    const character = source[index];
    if (character === '"') {
      scanString();
      return;
    }
    if (character === "{") {
      scanObject();
      return;
    }
    if (character === "[") {
      scanArray();
      return;
    }
    const start = index;
    while (index < source.length && !/[\u0009\u000a\u000d\u0020,\]}]/.test(source[index])) index += 1;
    failIf(start === index, code);
  };
  const scanObject = () => {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (source[index] === "}") {
      index += 1;
      return;
    }
    while (true) {
      skipWhitespace();
      failIf(source[index] !== '"', code);
      const key = scanString();
      failIf(keys.has(key), code);
      keys.add(key);
      skipWhitespace();
      failIf(source[index] !== ":", code);
      index += 1;
      scanValue();
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      failIf(source[index] !== ",", code);
      index += 1;
    }
  };
  const scanArray = () => {
    index += 1;
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return;
    }
    while (true) {
      scanValue();
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      failIf(source[index] !== ",", code);
      index += 1;
    }
  };
  skipWhitespace();
  scanValue();
  skipWhitespace();
  failIf(index !== source.length, code);
}

function parseJson(body, code) {
  try {
    const source = body.toString("utf8");
    assertNoDuplicateJsonKeys(source, code);
    const value = JSON.parse(source);
    failIf(!isObject(value), code);
    return value;
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    reject(code);
  }
}

function boundedString(value, maxBytes, code, nonempty = true) {
  failIf(typeof value !== "string" || (nonempty && value.length === 0) || Buffer.byteLength(value, "utf8") > maxBytes, code);
  failIf(value.includes("\u0000"), code);
  return value;
}

function assertSubscription(value) {
  failIf(typeof value !== "string" || !UUID_RE.test(value), "input");
  return value;
}

function assertServer(value) {
  failIf(typeof value !== "string" || value !== value.toLowerCase() || !SERVER_RE.test(value), "input");
  return value;
}

function parseReference(server, reference) {
  const escaped = server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = typeof reference === "string"
    ? new RegExp(`^${escaped}/(palancar-relay|palancar-expiry-cleanup)@(sha256:[0-9a-f]{64})$`).exec(reference)
    : null;
  failIf(match === null, "reference");
  return { repository: match[1], digest: match[2], reference };
}

function sha256(body) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function responseHeaderEntries(headers, code) {
  failIf(headers === null || typeof headers !== "object", code);
  const entries = [];
  for (const [name, rawValue] of Object.entries(headers)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    failIf(values.length !== 1 || typeof values[0] !== "string", code);
    entries.push([name.toLowerCase(), values[0]]);
  }
  failIf(new Set(entries.map(([name]) => name)).size !== entries.length, code);
  failIf(entries.reduce((total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value), 0) > MAX_HEADER_BYTES, code);
  return new Map(entries);
}

function header(headers, name, code) {
  const value = headers.get(name.toLowerCase());
  failIf(value === undefined || value.length === 0, code);
  return value;
}

function optionalContentLength(headers, body, maxBytes, code) {
  const length = declaredContentLength(headers, maxBytes, code);
  if (length !== undefined) failIf(length !== body.length, code);
  return length;
}

function declaredContentLength(headers, maxBytes, code) {
  const raw = headers.get("content-length");
  if (raw === undefined) return undefined;
  failIf(!/^(?:0|[1-9][0-9]*)$/.test(raw), code);
  const length = Number(raw);
  failIf(!Number.isSafeInteger(length) || length > maxBytes, code);
  return length;
}

function bodyBuffer(value, maxBytes, code) {
  if (Buffer.isBuffer(value)) {
    failIf(value.length > maxBytes, code);
    return value;
  }
  if (value instanceof Uint8Array) {
    failIf(value.byteLength > maxBytes, code);
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    failIf(Buffer.byteLength(value, "utf8") > maxBytes, code);
    return Buffer.from(value, "utf8");
  }
  reject(code);
}

function boundedResponse(response, maxBytes, code) {
  failIf(!isObject(response) || !Number.isInteger(response.status), code);
  const body = bodyBuffer(response.body, maxBytes, code);
  const headers = responseHeaderEntries(response.headers ?? {}, code);
  optionalContentLength(headers, body, maxBytes, code);
  return { status: response.status, headers, body };
}

function requestUrl(url, server, code) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    reject(code);
  }
  failIf(parsed.protocol !== "https:" || parsed.hostname !== server || parsed.port !== "" || parsed.username || parsed.password, code);
  return parsed;
}

function defaultRequest({ method, url, headers, body, timeoutMs, maxBytes }, dependencies = {}) {
  const httpsRequest = dependencies.httpsRequest ?? https.request;
  const clock = dependencies.now ?? Date.now;
  const setTimer = dependencies.setTimeout ?? setTimeout;
  const clearTimer = dependencies.clearTimeout ?? clearTimeout;
  return new Promise((resolve, rejectRequest) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      rejectRequest(new VerificationError("http-request"));
      return;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      rejectRequest(new VerificationError("http-request"));
      return;
    }
    let settled = false;
    let req;
    let activeResponse;
    let responseEnded = false;
    let declaredLength;
    let deadlineTimer;
    const requestListeners = [];
    const responseListeners = [];
    const startedAt = clock();
    const removeListeners = (target, listeners) => {
      if (target === undefined || typeof target.removeListener !== "function") return;
      for (const [event, listener] of listeners) target.removeListener(event, listener);
    };
    const clearRequestTimeout = () => {
      if (req !== undefined && typeof req.setTimeout === "function") {
        try {
          req.setTimeout(0);
        } catch {
          // The request is already terminal.
        }
      }
    };
    const cleanup = () => {
      if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
      clearRequestTimeout();
      removeListeners(req, requestListeners);
      removeListeners(activeResponse, responseListeners);
    };
    const abortTransport = () => {
      if (activeResponse !== undefined && typeof activeResponse.destroy === "function") {
        try {
          activeResponse.destroy();
        } catch {
          // The response is already terminal.
        }
      }
      if (req !== undefined) {
        try {
          if (typeof req.destroy === "function") req.destroy();
          else if (typeof req.abort === "function") req.abort();
        } catch {
          // The request is already terminal.
        }
      }
    };
    const finish = (callback, value, abort = false) => {
      if (settled) return;
      settled = true;
      if (abort) abortTransport();
      cleanup();
      callback(value);
    };
    const rejectTransport = (code, abort = true) => finish(rejectRequest, new VerificationError(code), abort);
    const addRequestListener = (event, listener) => {
      req.once(event, listener);
      requestListeners.push([event, listener]);
    };
    const addResponseListener = (event, listener, repeated = false) => {
      if (repeated) activeResponse.on(event, listener);
      else activeResponse.once(event, listener);
      responseListeners.push([event, listener]);
    };
    const onResponse = (res) => {
      activeResponse = res;
      const chunks = [];
      let length = 0;
      const onData = (chunk) => {
        if (settled) return;
        let bytes;
        try {
          bytes = bodyBuffer(chunk, maxBytes, "http-response");
        } catch {
          rejectTransport("response-too-large");
          return;
        }
        length += bytes.length;
        if (length > maxBytes || (declaredLength !== undefined && length > declaredLength)) {
          rejectTransport("response-too-large");
          return;
        }
        chunks.push(bytes);
      };
      const onEnd = () => {
        if (settled) return;
        responseEnded = true;
        if (res.complete === false || (declaredLength !== undefined && length !== declaredLength)) {
          rejectTransport("http-response");
          return;
        }
        finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }, false);
      };
      const onAborted = () => rejectTransport("http-response");
      const onClose = () => {
        if (!responseEnded) rejectTransport("http-response");
      };
      const onError = () => rejectTransport("http-response");
      try {
        addResponseListener("data", onData, true);
        addResponseListener("end", onEnd);
        addResponseListener("aborted", onAborted);
        addResponseListener("close", onClose);
        addResponseListener("error", onError);
        const responseHeaders = responseHeaderEntries(res.headers, "http-response");
        declaredLength = declaredContentLength(responseHeaders, maxBytes, "http-response");
      } catch {
        rejectTransport("http-response");
      }
    };
    try {
      req = httpsRequest({
        protocol: "https:",
        hostname: parsed.hostname,
        port: parsed.port === "" ? 443 : Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        timeout: timeoutMs,
        maxHeaderSize: MAX_HEADER_BYTES,
      }, onResponse);
      if (settled) {
        if (!responseEnded) abortTransport();
        cleanup();
        return;
      }
      addRequestListener("timeout", () => rejectTransport("http-timeout"));
      addRequestListener("error", () => rejectTransport("http-request"));
      addRequestListener("abort", () => rejectTransport("http-request"));
      addRequestListener("close", () => {
        if (activeResponse === undefined) rejectTransport("http-request");
      });
      const remaining = Math.max(0, timeoutMs - (clock() - startedAt));
      deadlineTimer = setTimer(() => rejectTransport("http-timeout"), remaining);
      if (body !== undefined) req.write(body);
      req.end();
    } catch {
      rejectTransport("http-request");
    }
  });
}

async function boundedRequest(request, options, code) {
  let response;
  try {
    response = await request(options);
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    reject(code);
  }
  return boundedResponse(response, options.maxBytes, code);
}

function acquireAcrRefreshToken(subscription, server, spawnSync) {
  let result;
  try {
    result = spawnSync(AZ_PATH, [
      "acr", "login", "--name", server.slice(0, -".azurecr.io".length),
      "--expose-token", "--subscription", subscription, "--output", "json", "--only-show-errors",
    ], {
      encoding: "utf8",
      timeout: AZ_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: AUTH_JSON_MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    reject("az");
  }
  failIf(!isObject(result) || result.status !== 0 || result.error, "az");
  const stdout = boundedString(result.stdout, AUTH_JSON_MAX_BYTES, "az");
  boundedString(result.stderr ?? "", AUTH_JSON_MAX_BYTES, "az", false);
  const body = parseJson(Buffer.from(stdout, "utf8"), "az");
  assertExactKeys(body, ["loginServer", "username", "accessToken", "refreshToken"], "az");
  failIf(body.loginServer !== server || body.username !== ZERO_UUID, "az");
  const refreshToken = boundedString(body.refreshToken, TOKEN_MAX_BYTES, "az");
  const accessToken = boundedString(body.accessToken, TOKEN_MAX_BYTES, "az");
  failIf(accessToken !== refreshToken, "az");
  return refreshToken;
}

async function exchangeRefreshToken(server, repository, refreshToken, request) {
  const url = `https://${server}/oauth2/token`;
  requestUrl(url, server, "auth");
  const body = new URLSearchParams([
    ["grant_type", "refresh_token"],
    ["service", server],
    ["scope", `repository:${repository}:pull`],
    ["refresh_token", refreshToken],
  ]).toString();
  const response = await boundedRequest(request, {
    method: "POST",
    url,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
    timeoutMs: HTTP_TIMEOUT_MS,
    maxBytes: TOKEN_MAX_BYTES,
  }, "auth");
  failIf(response.status !== 200, "auth");
  failIf(response.headers.get("location") !== undefined, "auth");
  failIf(!/^application\/json(?:\s*;|\s*$)/i.test(header(response.headers, "content-type", "auth")), "auth");
  const tokenResponse = parseJson(response.body, "auth");
  assertExactKeys(tokenResponse, ["access_token"], "auth");
  return boundedString(tokenResponse.access_token, TOKEN_MAX_BYTES, "auth");
}

function assertDescriptor(value, expectedMediaTypes, positiveSize, code) {
  assertExactKeys(value, ["mediaType", "digest", "size"], code);
  failIf(!expectedMediaTypes.has(value.mediaType) || !DIGEST_RE.test(value.digest), code);
  failIf(!Number.isSafeInteger(value.size) || value.size < (positiveSize ? 1 : 0) || value.size > MAX_DESCRIPTOR_BYTES, code);
  return value;
}

function contentType(headers, expected, code) {
  const raw = header(headers, "content-type", code);
  const media = raw.split(";", 1)[0].trim();
  failIf(media !== expected, code);
}

function validateManifest(response, digest, code) {
  failIf(response.status !== 200 || response.headers.get("location") !== undefined, code);
  failIf(header(response.headers, "docker-content-digest", code) !== digest, code);
  failIf(sha256(response.body) !== digest, code);
  const manifest = parseJson(response.body, code);
  assertExactKeys(manifest, ["schemaVersion", "mediaType", "config", "layers"], code);
  failIf(manifest.schemaVersion !== 2 || !MANIFEST_MEDIA_TYPES.has(manifest.mediaType), code);
  contentType(response.headers, manifest.mediaType, code);
  const configMediaTypes = manifest.mediaType === OCI_MANIFEST ? new Set([OCI_CONFIG]) : new Set([DOCKER_CONFIG]);
  const layerMediaTypes = manifest.mediaType === OCI_MANIFEST ? OCI_LAYER_MEDIA_TYPES : DOCKER_LAYER_MEDIA_TYPES;
  const config = assertDescriptor(manifest.config, configMediaTypes, true, code);
  failIf(!Array.isArray(manifest.layers) || manifest.layers.length === 0 || manifest.layers.length > MAX_LAYERS, code);
  const layers = manifest.layers.map((layer) => assertDescriptor(layer, layerMediaTypes, true, code));
  return { mediaType: manifest.mediaType, config, layers };
}

function validateConfigPlatform(body, code) {
  const config = parseJson(body, code);
  for (const key of Object.keys(config)) {
    const lowerKey = key.toLowerCase();
    if (PLATFORM_SIGNIFICANT_KEYS.has(lowerKey) && !PLATFORM_CANONICAL_KEYS.has(key)) reject(code);
  }
  failIf(config.os !== "linux" || config.architecture !== "amd64", code);
  if (Object.hasOwn(config, "variant")) failIf(config.variant !== "" && config.variant !== null, code);
  return { os: "linux", architecture: "amd64", variant: null };
}

function validateConfigDirect(response, descriptor, code) {
  failIf(response.status !== 200 || response.headers.get("location") !== undefined, code);
  failIf(header(response.headers, "docker-content-digest", code) !== descriptor.digest, code);
  failIf(sha256(response.body) !== descriptor.digest, code);
  failIf(response.body.length !== descriptor.size, code);
  contentType(response.headers, descriptor.mediaType, code);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== undefined) failIf(Number(contentLength) !== descriptor.size, code);
  return validateConfigPlatform(response.body, code);
}

function validateBlobLocation(value, code) {
  boundedString(value, BLOB_LOCATION_MAX_BYTES, code);
  failIf(/[\u0000-\u0020\u007f]/.test(value), code);
  failIf(!/^https:\/\/[^/?#]+\//.test(value) || value.includes("\\"), code);
  const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
  failIf(authority === undefined || authority !== authority.toLowerCase() || authority.includes("@") || authority.includes(":"), code);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    reject(code);
  }
  failIf(parsed.protocol !== "https:" || parsed.hostname !== authority || parsed.port !== "" || parsed.username || parsed.password || parsed.hash, code);
  failIf(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+blob\.core\.windows\.net$/.test(authority), code);
  const rawPath = value.slice(value.indexOf(authority) + authority.length).split(/[?#]/, 1)[0];
  failIf(rawPath.length <= 1 || !rawPath.startsWith("/") || /%2f|%5c|%2e/i.test(rawPath), code);
  failIf(rawPath.split("/").some((segment) => segment === "." || segment === ".."), code);
  failIf(parsed.pathname.split("/").some((segment) => segment === "." || segment === ".."), code);
  const queryStart = value.indexOf("?");
  failIf(queryStart < 0, code);
  const rawQuery = value.slice(queryStart + 1);
  failIf(rawQuery.length === 0, code);
  const values = new Map();
  const keys = [];
  for (const field of rawQuery.split("&")) {
    const separator = field.indexOf("=");
    failIf(separator <= 0 || field.indexOf("=", separator + 1) !== -1, code);
    const encodedKey = field.slice(0, separator);
    const encodedValue = field.slice(separator + 1);
    failIf(encodedValue.length === 0, code);
    let key;
    try {
      key = decodeURIComponent(encodedKey);
    } catch {
      reject(code);
    }
    failIf(key !== encodedKey || !BLOB_SAS_KEYS.has(key), code);
    boundedString(key, BLOB_SAS_VALUE_MAX_BYTES, code);
    failIf(/[\u0000-\u001f\u007f]/.test(key), code);
    let decodedValue;
    try {
      decodedValue = decodeURIComponent(encodedValue);
    } catch {
      reject(code);
    }
    boundedString(decodedValue, BLOB_SAS_VALUE_MAX_BYTES, code);
    failIf(/[\u0000-\u001f\u007f]/.test(decodedValue), code);
    keys.push(key);
    values.set(key, decodedValue);
  }
  failIf(keys.length !== BLOB_SAS_KEYS.size || new Set(keys).size !== keys.length || values.get("spr") !== "https" || values.get("sp") !== "r" || values.get("sr") !== "b", code);
  return value;
}

function validateConfigRedirect(response, descriptor, code) {
  failIf(response.status !== 307, code);
  failIf(header(response.headers, "docker-content-digest", code) !== descriptor.digest, code);
  return validateBlobLocation(header(response.headers, "location", code), code);
}

function validateBlobConfig(response, descriptor, code) {
  failIf(response.status !== 200 || response.headers.get("location") !== undefined, code);
  const blobDigest = response.headers.get("docker-content-digest");
  if (blobDigest !== undefined) failIf(blobDigest !== descriptor.digest, code);
  contentType(response.headers, "application/octet-stream", code);
  const contentLength = header(response.headers, "content-length", code);
  failIf(Number(contentLength) !== descriptor.size || !/^(?:0|[1-9][0-9]*)$/.test(contentLength), code);
  failIf(sha256(response.body) !== descriptor.digest, code);
  return validateConfigPlatform(response.body, code);
}

function validateConfig(response, descriptor, code) {
  if (response.status === 307) return { redirect: validateConfigRedirect(response, descriptor, code) };
  return { platform: validateConfigDirect(response, descriptor, code) };
}

export async function verifyAcrImagePlatform(subscription, expectedAcrLoginServer, immutableReference, dependencies = {}) {
  const account = assertSubscription(subscription);
  const server = assertServer(expectedAcrLoginServer);
  const reference = parseReference(server, immutableReference);
  const spawnSync = dependencies.spawnSync ?? defaultSpawnSync;
  const request = dependencies.request ?? ((options) => defaultRequest(options, dependencies));
  const refreshToken = acquireAcrRefreshToken(account, server, spawnSync);
  const accessToken = await exchangeRefreshToken(server, reference.repository, refreshToken, request);
  const manifestUrl = `https://${server}/v2/${reference.repository}/manifests/${reference.digest}`;
  requestUrl(manifestUrl, server, "manifest");
  const manifestResponse = await boundedRequest(request, {
    method: "GET",
    url: manifestUrl,
    headers: {
      Accept: `${OCI_MANIFEST}, ${DOCKER_MANIFEST}`,
      Authorization: `Bearer ${accessToken}`,
    },
    timeoutMs: HTTP_TIMEOUT_MS,
    maxBytes: MANIFEST_MAX_BYTES,
  }, "manifest");
  const manifest = validateManifest(manifestResponse, reference.digest, "manifest");
  const configUrl = `https://${server}/v2/${reference.repository}/blobs/${manifest.config.digest}`;
  requestUrl(configUrl, server, "config");
  const configResponse = await boundedRequest(request, {
    method: "GET",
    url: configUrl,
    headers: {
      Accept: manifest.config.mediaType,
      Authorization: `Bearer ${accessToken}`,
    },
    timeoutMs: HTTP_TIMEOUT_MS,
    maxBytes: CONFIG_MAX_BYTES,
  }, "config");
  const configResult = validateConfig(configResponse, manifest.config, "config");
  let platform = configResult.platform;
  if (configResult.redirect !== undefined) {
    const blobResponse = await boundedRequest(request, {
      method: "GET",
      url: configResult.redirect,
      headers: { Accept: manifest.config.mediaType },
      timeoutMs: HTTP_TIMEOUT_MS,
      maxBytes: CONFIG_MAX_BYTES,
    }, "config");
    platform = validateBlobConfig(blobResponse, manifest.config, "config");
  }
  return {
    version: 1,
    reference: immutableReference,
    repository: reference.repository,
    manifestDigest: reference.digest,
    manifestMediaType: manifest.mediaType,
    configDigest: manifest.config.digest,
    configMediaType: manifest.config.mediaType,
    os: platform.os,
    architecture: platform.architecture,
    variant: platform.variant,
  };
}

export function defaultRequestForTests(options, dependencies = {}) {
  return defaultRequest(options, dependencies);
}

export async function runCliForTests(argv, dependencies = {}) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "verify") {
    return { status: 2, stdout: "", stderr: "image-platform-verification: failed\n" };
  }
  try {
    const descriptor = await verifyAcrImagePlatform(argv[1], argv[2], argv[3], dependencies);
    return { status: 0, stdout: `${JSON.stringify(descriptor)}\n`, stderr: "" };
  } catch (error) {
    void error;
    return { status: 1, stdout: "", stderr: "image-platform-verification: failed\n" };
  }
}

async function main(argv) {
  const result = await runCliForTests(argv);
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  return result.status;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  }).catch(() => {
    process.stderr.write("image-platform-verification: failed\n");
    process.exitCode = 1;
  });
}
