import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { defaultRequestForTests, runCliForTests } from "./verify-acr-image-platform.mjs";

const SUBSCRIPTION = "00000000-0000-4000-8000-000000000001";
const SERVER = "palancardev.azurecr.io";
const REFRESH_TOKEN = "refresh-token-never-leaves-the-transport";
const ACCESS_TOKEN = "registry-access-token-never-leaves-the-transport";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";
const DOCKER_LAYER = "application/vnd.docker.image.rootfs.diff.tar.gzip";
const BLOB_LOCATION = "https://palancardev.blob.core.windows.net/acrconfig/configblob?regid=palancardev&se=2030-01-01T00%3A00%3A00Z&sig=signature%2Bvalue&ske=2030-01-01T00%3A00%3A00Z&skoid=00000000-0000-0000-0000-000000000001&sks=2020-01-01T00%3A00%3A00Z&skt=2020-01-01T00%3A00%3A00Z&sktid=00000000-0000-0000-0000-000000000002&skv=2022-11-02&sp=r&spr=https&sr=b&sv=2022-11-02";

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function response(status, body, headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    status,
    body: bytes,
    headers: {
      "Content-Length": String(bytes.length),
      ...headers,
    },
  };
}

function makeImage({ kind = "oci", repository = "palancar-relay", manifestMutator = undefined, configBody = undefined } = {}) {
  const manifestMediaType = kind === "oci" ? OCI_MANIFEST : DOCKER_MANIFEST;
  const configMediaType = kind === "oci" ? OCI_CONFIG : DOCKER_CONFIG;
  const layerMediaType = kind === "oci" ? OCI_LAYER : DOCKER_LAYER;
  const actualConfigBody = configBody === undefined
    ? Buffer.from(JSON.stringify({
        architecture: "amd64",
        os: "linux",
        variant: "",
        rootfs: { type: "layers", diff_ids: [] },
      }), "utf8")
    : Buffer.isBuffer(configBody) ? configBody : Buffer.from(configBody, "utf8");
  const configDigest = digest(actualConfigBody);
  const baseManifest = {
    schemaVersion: 2,
    mediaType: manifestMediaType,
    config: { mediaType: configMediaType, digest: configDigest, size: actualConfigBody.length },
    layers: [{ mediaType: layerMediaType, digest: `sha256:${"1".repeat(64)}`, size: 123 }],
  };
  const manifest = manifestMutator === undefined ? baseManifest : manifestMutator(structuredClone(baseManifest));
  const manifestBody = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestDigest = digest(manifestBody);
  return {
    repository,
    manifestBody,
    manifestDigest,
    configBody: actualConfigBody,
    configDigest,
    configMediaType,
    reference: `${SERVER}/${repository}@${manifestDigest}`,
  };
}

function imageManifestObject(image) {
  return JSON.parse(image.manifestBody.toString("utf8"));
}

function refreshImageManifest(image, manifest) {
  image.manifestBody = Buffer.from(JSON.stringify(manifest), "utf8");
  image.manifestDigest = digest(image.manifestBody);
  image.reference = `${SERVER}/${image.repository}@${image.manifestDigest}`;
}

function refreshImageConfig(image, body) {
  image.configBody = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  image.configDigest = digest(image.configBody);
  const manifest = imageManifestObject(image);
  manifest.config.digest = image.configDigest;
  manifest.config.size = image.configBody.length;
  refreshImageManifest(image, manifest);
}

function redactRequest(request) {
  const headers = { ...request.headers };
  if (headers.Authorization !== undefined) headers.Authorization = "Bearer <redacted>";
  if (headers.authorization !== undefined) headers.authorization = "Bearer <redacted>";
  let body = request.body;
  if (typeof body === "string") body = body.replace(/(refresh_token=)[^&]*/g, "$1<redacted>");
  const url = request.url.includes(".blob.core.windows.net/") ? "<signed-url-redacted>" : request.url;
  return { method: request.method, url, headers, body };
}

function makeHarness(image = makeImage()) {
  const routes = { token: undefined, manifest: undefined, config: undefined, blob: undefined };
  const rawRequests = [];
  const visibleRequests = [];
  const spawnCalls = [];
  const azResult = {
    status: 0,
    stdout: JSON.stringify({
      loginServer: SERVER,
      username: "00000000-0000-0000-0000-000000000000",
      accessToken: REFRESH_TOKEN,
      refreshToken: REFRESH_TOKEN,
    }),
    stderr: "",
  };
  const spawnSync = (command, argv, options) => {
    spawnCalls.push({ command, argv: [...argv], options: { ...options } });
    return azResult;
  };
  const request = async (requestOptions) => {
    rawRequests.push(requestOptions);
    visibleRequests.push(redactRequest(requestOptions));
    const url = new URL(requestOptions.url);
    if (url.pathname === "/oauth2/token") {
      return routes.token ?? response(200, JSON.stringify({ access_token: ACCESS_TOKEN }), { "Content-Type": "application/json" });
    }
    if (url.pathname === `/v2/${image.repository}/manifests/${image.manifestDigest}`) {
      return routes.manifest ?? response(200, image.manifestBody, {
        "Content-Type": JSON.parse(image.manifestBody.toString("utf8")).mediaType,
        "Docker-Content-Digest": image.manifestDigest,
      });
    }
    if (url.pathname === `/v2/${image.repository}/blobs/${image.configDigest}`) {
      return routes.config ?? response(200, image.configBody, {
        "Content-Type": image.configMediaType,
        "Docker-Content-Digest": image.configDigest,
      });
    }
    if (url.hostname.endsWith(".blob.core.windows.net")) {
      if (routes.blob !== undefined) return routes.blob;
      throw new Error("unexpected blob request");
    }
    throw new Error("unexpected request");
  };
  return {
    image,
    routes,
    azResult,
    rawRequests,
    visibleRequests,
    spawnCalls,
    spawnSync,
    request,
    setManifestObject(mutator) {
      refreshImageManifest(image, mutator(imageManifestObject(image)));
    },
    setManifestBody(body, headers = {}) {
      image.manifestBody = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
      image.manifestDigest = digest(image.manifestBody);
      image.reference = `${SERVER}/${image.repository}@${image.manifestDigest}`;
      routes.manifest = response(200, image.manifestBody, {
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
        "Docker-Content-Digest": image.manifestDigest,
        ...headers,
      });
    },
    setConfigBody(body) {
      refreshImageConfig(image, body);
    },
  };
}

async function run(harness, reference = harness.image.reference, overrides = {}) {
  return runCliForTests(
    ["verify", SUBSCRIPTION, SERVER, reference],
    { spawnSync: harness.spawnSync, request: overrides.request ?? harness.request },
  );
}

function assertFailure(result) {
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "image-platform-verification: failed\n");
}

class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.socketTimeout = undefined;
    this.writes = [];
    this.ended = false;
  }

  setTimeout(value) {
    this.socketTimeout = value;
  }

  write(value) {
    this.writes.push(value);
  }

  end() {
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeResponse extends EventEmitter {
  constructor(headers = {}, complete = true) {
    super();
    this.statusCode = 200;
    this.headers = headers;
    this.complete = complete;
    this.destroyed = false;
  }

  destroy() {
    this.destroyed = true;
  }
}

function makeFakeTimers() {
  let nextId = 1;
  const active = new Map();
  const cleared = [];
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      active.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      active.delete(id);
    },
    fire(id) {
      const timer = active.get(id);
      assert.notEqual(timer, undefined);
      active.delete(id);
      timer.callback();
    },
    get active() {
      return active;
    },
    cleared,
  };
}

function makeTransportScenario() {
  const timers = makeFakeTimers();
  const request = new FakeRequest();
  let respond;
  const httpsRequest = (options, callback) => {
    request.options = options;
    respond = callback;
    return request;
  };
  const begin = (maxBytes = 8, timeoutMs = 100) => defaultRequestForTests({
    method: "GET",
    url: "https://palancardev.azurecr.io/v2/palancar-relay/test",
    headers: {},
    timeoutMs,
    maxBytes,
  }, {
    httpsRequest,
    now: () => 0,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { timers, request, respond: (value) => respond(value), begin };
}

test("verifies deterministic OCI and Docker v2 Linux AMD64 descriptors for both protected repositories", async () => {
  for (const kind of ["oci", "docker"]) {
    for (const repository of ["palancar-relay", "palancar-expiry-cleanup"]) {
      const harness = makeHarness(makeImage({ kind, repository }));
    const result = await run(harness);
    const manifestType = kind === "oci" ? OCI_MANIFEST : DOCKER_MANIFEST;
    const configType = kind === "oci" ? OCI_CONFIG : DOCKER_CONFIG;
    assert.deepEqual(result, {
      status: 0,
      stdout: `${JSON.stringify({
        version: 1,
        reference: harness.image.reference,
        repository,
        manifestDigest: harness.image.manifestDigest,
        manifestMediaType: manifestType,
        configDigest: harness.image.configDigest,
        configMediaType: configType,
        os: "linux",
        architecture: "amd64",
        variant: null,
      })}\n`,
      stderr: "",
    });
    assert.equal(harness.rawRequests.length, 3);
    assert.deepEqual(harness.spawnCalls[0].argv, [
      "acr", "login", "--name", "palancardev", "--expose-token", "--subscription", SUBSCRIPTION,
      "--output", "json", "--only-show-errors",
    ]);
    assert.equal(harness.spawnCalls[0].command, "/usr/bin/az");
    assert.equal(harness.spawnCalls[0].options.timeout, 30_000);
    assert.equal(harness.spawnCalls[0].options.maxBuffer, 256 * 1024);
    assert.equal(harness.rawRequests[0].method, "POST");
    assert.equal(harness.rawRequests[0].headers.Authorization, undefined);
    assert.equal(harness.rawRequests[0].headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.match(harness.rawRequests[0].body, /grant_type=refresh_token/);
    assert.match(harness.rawRequests[0].body, new RegExp(`scope=repository%3A${repository}%3Apull`));
    assert.equal(harness.rawRequests[1].headers.Accept, `${OCI_MANIFEST}, ${DOCKER_MANIFEST}`);
    assert.equal(harness.rawRequests[1].headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(harness.rawRequests[2].headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    }
  }
});

test("follows one safe ACR config redirect without forwarding credentials or exposing the SAS URL", async () => {
  const harness = makeHarness();
  harness.routes.config = response(307, "", {
    "Docker-Content-Digest": harness.image.configDigest,
    Location: BLOB_LOCATION,
  });
  harness.routes.blob = response(200, harness.image.configBody, {
    "Content-Type": "application/octet-stream",
  });
  const result = await run(harness);
  assert.equal(result.status, 0);
  assert.equal(harness.rawRequests.length, 4);
  assert.equal(harness.rawRequests[2].headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(harness.rawRequests[3].headers, { Accept: harness.image.configMediaType });
  assert.equal(harness.rawRequests[3].headers.Authorization, undefined);
  assert.equal(harness.rawRequests[3].headers.Cookie, undefined);
  assert.equal(harness.rawRequests[3].url, BLOB_LOCATION);
  assert.equal(JSON.stringify(harness.visibleRequests).includes("blob.core.windows.net"), false);
  assert.equal(JSON.stringify(harness.visibleRequests).includes("signature%2Bvalue"), false);
  assert.equal(result.stdout.includes("signature"), false);
});

test("redacts tokens from all visible verifier results and metadata", async () => {
  const harness = makeHarness();
  const result = await run(harness);
  const visible = JSON.stringify({ result, requests: harness.visibleRequests, spawnCalls: harness.spawnCalls });
  assert.equal(visible.includes(REFRESH_TOKEN), false);
  assert.equal(visible.includes(ACCESS_TOKEN), false);
  assert.equal(result.stdout.includes(REFRESH_TOKEN), false);
  assert.equal(result.stdout.includes(ACCESS_TOKEN), false);
  assert.equal(result.stderr, "");

  harness.routes.config = response(500, REFRESH_TOKEN, { Location: "https://signed.example/blob" });
  const failure = await run(harness);
  assertFailure(failure);
  assert.equal(failure.stderr.includes(REFRESH_TOKEN), false);
  assert.equal(failure.stderr.includes(ACCESS_TOKEN), false);
});

test("rejects malformed immutable references before Azure authentication", async () => {
  const references = [
    `${SERVER}/palancar-relay:latest`,
    `${SERVER}/palancar-relay@sha256:${"A".repeat(64)}`,
    `${SERVER}/palancar-relay@sha256:${"a".repeat(63)}`,
    `${SERVER}/palancar-other@sha256:${"a".repeat(64)}`,
    `${SERVER}/palancar-relay@sha256:${"a".repeat(64)}/extra`,
    `${SERVER}/palancar-relay/../palancar-relay@sha256:${"a".repeat(64)}`,
    `https://${SERVER}/palancar-relay@sha256:${"a".repeat(64)}`,
    `${SERVER}/palancar-relay%2Fextra@sha256:${"a".repeat(64)}`,
    ` ${SERVER}/palancar-relay@sha256:${"a".repeat(64)}`,
  ];
  for (const reference of references) {
    const harness = makeHarness();
    const result = await run(harness, reference);
    assertFailure(result);
    assert.equal(harness.spawnCalls.length, 0, reference);
  }
  for (const [server, reference] of [
    ["PALANCARD.EV.azurecr.io", `${SERVER}/palancar-relay@sha256:${"a".repeat(64)}`],
    ["other.azurecr.io", `${SERVER}/palancar-relay@sha256:${"a".repeat(64)}`],
    [SERVER, `other.azurecr.io/palancar-relay@sha256:${"a".repeat(64)}`],
  ]) {
    const harness = makeHarness();
    const result = await runCliForTests(["verify", SUBSCRIPTION, server, reference], {
      spawnSync: harness.spawnSync,
      request: harness.request,
    });
    assertFailure(result);
    assert.equal(harness.spawnCalls.length, 0);
  }
});

test("rejects Azure CLI authentication shape, status, and bounds", async () => {
  const cases = [
    ["nonzero status", (h) => { h.azResult.status = 1; }],
    ["malformed JSON", (h) => { h.azResult.stdout = "{"; }],
    ["foreign login server", (h) => { h.azResult.stdout = h.azResult.stdout.replace(SERVER, "other.azurecr.io"); }],
    ["wrong user", (h) => { h.azResult.stdout = h.azResult.stdout.replace("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001"); }],
    ["mismatched token", (h) => { h.azResult.stdout = h.azResult.stdout.replace(REFRESH_TOKEN, "different-token"); }],
    ["unknown key", (h) => { h.azResult.stdout = `${h.azResult.stdout.slice(0, -1)},"extra":true}`; }],
    ["oversized output", (h) => { h.azResult.stdout = "x".repeat(256 * 1024 + 1); }],
    ["empty refresh token", (h) => { h.azResult.stdout = h.azResult.stdout.replace(`"${REFRESH_TOKEN}"`, "\"\""); }],
  ];
  for (const [label, mutate] of cases) {
    const harness = makeHarness();
    mutate(harness);
    assertFailure(await run(harness), label);
  }
});

test("rejects token exchange failures, challenges, redirects, and malformed tokens", async () => {
  const cases = [
    ["status", response(401, JSON.stringify({ error: "unauthorized" }), { "Content-Type": "application/json" })],
    ["redirect", response(302, "", { Location: "https://signed.example/token" })],
    ["wrong content type", response(200, JSON.stringify({ access_token: ACCESS_TOKEN }), { "Content-Type": "text/plain" })],
    ["malformed JSON", response(200, "{", { "Content-Type": "application/json" })],
    ["unknown key", response(200, JSON.stringify({ access_token: ACCESS_TOKEN, token_type: "Bearer" }), { "Content-Type": "application/json" })],
    ["empty token", response(200, JSON.stringify({ access_token: "" }), { "Content-Type": "application/json" })],
  ];
  for (const [label, route] of cases) {
    const harness = makeHarness();
    harness.routes.token = route;
    assertFailure(await run(harness), label);
    assert.equal(harness.rawRequests.length, 1, label);
  }
});

test("rejects manifest indexes, lists, artifacts, schema, media, and digest failures", async () => {
  const images = [
    ["OCI index", makeImage({ manifestMutator: () => ({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] }) })],
    ["Docker list", makeImage({ manifestMutator: () => ({ schemaVersion: 2, mediaType: "application/vnd.docker.distribution.manifest.list.v2+json", manifests: [] }) })],
    ["artifact", makeImage({ manifestMutator: (manifest) => ({ ...manifest, mediaType: "application/vnd.oci.artifact.manifest.v1+json" }) })],
    ["wrong schema", makeImage({ manifestMutator: (manifest) => ({ ...manifest, schemaVersion: 1 }) })],
    ["missing media", makeImage({ manifestMutator: (manifest) => { delete manifest.mediaType; return manifest; } })],
    ["manifests collection", makeImage({ manifestMutator: (manifest) => ({ ...manifest, manifests: [] }) })],
  ];
  for (const [label, image] of images) assertFailure(await run(makeHarness(image)), label);

  const headerMismatch = makeHarness();
  headerMismatch.routes.manifest = response(200, headerMismatch.image.manifestBody, {
    "Content-Type": OCI_MANIFEST,
    "Docker-Content-Digest": `sha256:${"f".repeat(64)}`,
  });
  assertFailure(await run(headerMismatch), "manifest header digest");

  const bodyMismatch = makeHarness();
  bodyMismatch.routes.manifest = response(200, Buffer.concat([bodyMismatch.image.manifestBody, Buffer.from(" ")]), {
    "Content-Type": OCI_MANIFEST,
    "Docker-Content-Digest": bodyMismatch.image.manifestDigest,
  });
  assertFailure(await run(bodyMismatch), "manifest body digest");

  const lengthMismatch = makeHarness();
  lengthMismatch.routes.manifest = response(200, lengthMismatch.image.manifestBody, {
    "Content-Type": OCI_MANIFEST,
    "Docker-Content-Digest": lengthMismatch.image.manifestDigest,
    "Content-Length": "1",
  });
  assertFailure(await run(lengthMismatch), "manifest content length");

  const mediaHeaderMismatch = makeHarness();
  mediaHeaderMismatch.routes.manifest = response(200, mediaHeaderMismatch.image.manifestBody, {
    "Content-Type": "application/json",
    "Docker-Content-Digest": mediaHeaderMismatch.image.manifestDigest,
  });
  assertFailure(await run(mediaHeaderMismatch), "manifest content type");

  const malformed = makeHarness();
  malformed.setManifestBody("{");
  assertFailure(await run(malformed), "manifest JSON");
});

test("rejects manifest descriptor, layer, and bounded-shape failures", async () => {
  const cases = [
    ["config extra key", (manifest) => { manifest.config.extra = true; }],
    ["config bad digest", (manifest) => { manifest.config.digest = "sha256:bad"; }],
    ["config bad size", (manifest) => { manifest.config.size = -1; }],
    ["config wrong media", (manifest) => { manifest.config.mediaType = "application/octet-stream"; }],
    ["empty layers", (manifest) => { manifest.layers = []; }],
    ["too many layers", (manifest) => { manifest.layers = Array.from({ length: 129 }, () => ({ ...manifest.layers[0] })); }],
    ["layer bad digest", (manifest) => { manifest.layers[0].digest = "sha256:bad"; }],
    ["layer bad size", (manifest) => { manifest.layers[0].size = "123"; }],
    ["layer zero size", (manifest) => { manifest.layers[0].size = 0; }],
    ["layer wrong media", (manifest) => { manifest.layers[0].mediaType = "application/octet-stream"; }],
    ["layer extra key", (manifest) => { manifest.layers[0].annotations = {}; }],
    ["manifest extra key", (manifest) => { manifest.extra = null; }],
  ];
  for (const [label, mutate] of cases) {
    const image = makeImage({ manifestMutator: (manifest) => {
      mutate(manifest);
      return manifest;
    } });
    assertFailure(await run(makeHarness(image)), label);
  }
});

test("rejects config platform, digest, media, JSON, status, size, and redirect failures", async () => {
  const configCases = [
    ["ARM64", { architecture: "arm64" }],
    ["Windows", { os: "windows" }],
    ["variant", { variant: "v8" }],
    ["platform", { platform: "linux/amd64" }],
    ["platforms", { platforms: [] }],
    ["os version", { osVersion: "10.0" }],
    ["os features", { osFeatures: ["sse4"] }],
    ["OCI os.version", { "os.version": "10.0" }],
    ["OCI os.features", { "os.features": ["sse4"] }],
    ["architecture variant", { architectureVariant: "v8" }],
    ["missing os", { os: undefined }],
    ["missing architecture", { architecture: undefined }],
  ];
  for (const [label, fields] of configCases) {
    const image = makeImage({ configBody: JSON.stringify({ architecture: "amd64", os: "linux", ...fields }) });
    if (fields.os === undefined) {
      const body = { architecture: "amd64" };
      const h = makeHarness();
      h.setConfigBody(JSON.stringify(body));
      assertFailure(await run(h), label);
    } else if (fields.architecture === undefined) {
      const h = makeHarness();
      h.setConfigBody(JSON.stringify({ os: "linux" }));
      assertFailure(await run(h), label);
    } else {
      assertFailure(await run(makeHarness(image)), label);
    }
  }

  for (const key of [
    "OS", "Architecture", "Variant", "Platform", "Platforms", "OS.Version", "OS.Features",
    "OSVersion", "OSFeatures", "ArchitectureVariant",
  ]) {
    const image = makeImage({ configBody: JSON.stringify({
      architecture: "amd64",
      os: "linux",
      [key]: "shadow",
    }) });
    assertFailure(await run(makeHarness(image)), `platform key shadow ${key}`);
  }

  const duplicatePlatformKey = makeHarness();
  duplicatePlatformKey.setConfigBody("{\"architecture\":\"amd64\",\"os\":\"linux\",\"os\":\"linux\"}");
  assertFailure(await run(duplicatePlatformKey), "duplicate platform JSON key");

  const escapedDuplicatePlatformKey = makeHarness();
  escapedDuplicatePlatformKey.setConfigBody("{\"architecture\":\"amd64\",\"os\":\"linux\",\"\\u006f\\u0073\":\"linux\"}");
  assertFailure(await run(escapedDuplicatePlatformKey), "escaped duplicate platform JSON key");

  const digestHeader = makeHarness();
  digestHeader.routes.config = response(200, digestHeader.image.configBody, {
    "Content-Type": digestHeader.image.configMediaType,
    "Docker-Content-Digest": `sha256:${"e".repeat(64)}`,
  });
  assertFailure(await run(digestHeader), "config header digest");

  const bodyDigest = makeHarness();
  bodyDigest.routes.config = response(200, Buffer.concat([bodyDigest.image.configBody, Buffer.from(" ")]), {
    "Content-Type": bodyDigest.image.configMediaType,
    "Docker-Content-Digest": bodyDigest.image.configDigest,
  });
  assertFailure(await run(bodyDigest), "config body digest");

  const typeMismatch = makeHarness();
  typeMismatch.routes.config = response(200, typeMismatch.image.configBody, {
    "Content-Type": "application/json",
    "Docker-Content-Digest": typeMismatch.image.configDigest,
  });
  assertFailure(await run(typeMismatch), "config media");

  const lengthMismatch = makeHarness();
  lengthMismatch.routes.config = response(200, lengthMismatch.image.configBody, {
    "Content-Type": lengthMismatch.image.configMediaType,
    "Docker-Content-Digest": lengthMismatch.image.configDigest,
    "Content-Length": "1",
  });
  assertFailure(await run(lengthMismatch), "config size");

  const missingContentLength = makeHarness();
  missingContentLength.setManifestObject((manifest) => {
    manifest.config.size += 1;
    return manifest;
  });
  missingContentLength.routes.config = response(200, missingContentLength.image.configBody, {
    "Content-Type": missingContentLength.image.configMediaType,
    "Docker-Content-Digest": missingContentLength.image.configDigest,
  });
  delete missingContentLength.routes.config.headers["Content-Length"];
  assertFailure(await run(missingContentLength), "descriptor size without content length");

  const directWithoutContentLength = makeHarness();
  directWithoutContentLength.routes.config = response(200, directWithoutContentLength.image.configBody, {
    "Content-Type": directWithoutContentLength.image.configMediaType,
    "Docker-Content-Digest": directWithoutContentLength.image.configDigest,
  });
  delete directWithoutContentLength.routes.config.headers["Content-Length"];
  assert.equal((await run(directWithoutContentLength)).status, 0);

  const malformed = makeHarness();
  malformed.setConfigBody("{");
  assertFailure(await run(malformed), "config JSON");

  const status = makeHarness();
  status.routes.config = response(503, "busy", { "Content-Type": "text/plain" });
  assertFailure(await run(status), "config status");

  const redirect = makeHarness();
  redirect.routes.config = response(302, "", {
    Location: "https://blob.example/signed?sig=secret",
    "Content-Type": "text/plain",
  });
  assertFailure(await run(redirect), "config redirect");
  assert.equal(redirect.rawRequests.length, 3);
  assert.equal(redirect.rawRequests.every((request) => new URL(request.url).hostname === SERVER), true);
});

test("accepts only the bounded Azure Blob config redirect contract", async () => {
  const makeRedirectHarness = (location, extraHeaders = {}) => {
    const harness = makeHarness();
    const headers = {
      "Docker-Content-Digest": harness.image.configDigest,
      ...extraHeaders,
    };
    if (location !== undefined) headers.Location = location;
    harness.routes.config = response(307, "", headers);
    return harness;
  };

  const invalidLocations = [
    ["missing location", undefined],
    ["HTTP", BLOB_LOCATION.replace("https://", "http://")],
    ["uppercase host", BLOB_LOCATION.replace("palancardev.blob", "PALANCARDEV.blob")],
    ["foreign host", BLOB_LOCATION.replace("palancardev.blob.core.windows.net", "evil.example")],
    ["bare blob suffix", BLOB_LOCATION.replace("palancardev.blob.core.windows.net", "blob.core.windows.net")],
    ["port", BLOB_LOCATION.replace("https://palancardev.blob.core.windows.net", "https://palancardev.blob.core.windows.net:443")],
    ["credentials", BLOB_LOCATION.replace("https://palancardev.blob.core.windows.net", "https://user:pass@palancardev.blob.core.windows.net")],
    ["fragment", `${BLOB_LOCATION}#fragment`],
    ["space", BLOB_LOCATION.replace("configblob", "config blob")],
    ["control", BLOB_LOCATION.replace("configblob", "config\tblob")],
    ["root path", BLOB_LOCATION.replace("/acrconfig/configblob", "")],
    ["dot path", BLOB_LOCATION.replace("/acrconfig/configblob", "/./configblob")],
    ["traversal path", BLOB_LOCATION.replace("/acrconfig/configblob", "/acrconfig/../configblob")],
    ["encoded slash", BLOB_LOCATION.replace("acrconfig/configblob", "acrconfig%2Fconfigblob")],
    ["encoded backslash", BLOB_LOCATION.replace("acrconfig/configblob", "acrconfig%5Cconfigblob")],
    ["encoded dot", BLOB_LOCATION.replace("acrconfig/configblob", "acrconfig%2Econfigblob")],
    ["missing SAS field", BLOB_LOCATION.replace("&skv=2022-11-02", "")],
    ["extra SAS field", `${BLOB_LOCATION}&extra=x`],
    ["duplicate SAS field", `${BLOB_LOCATION}&sp=r`],
    ["empty SAS value", BLOB_LOCATION.replace("sig=signature%2Bvalue", "sig=")],
    ["decoded SAS control", BLOB_LOCATION.replace("signature%2Bvalue", "signature%0Avalue")],
    ["bad spr", BLOB_LOCATION.replace("spr=https", "spr=http")],
    ["bad sp", BLOB_LOCATION.replace("sp=r", "sp=rw")],
    ["bad sr", BLOB_LOCATION.replace("sr=b", "sr=c")],
    ["encoded SAS key", BLOB_LOCATION.replace("&sp=r", "&%73p=r")],
    ["malformed query field", `${BLOB_LOCATION}&malformed`],
    ["oversized SAS value", BLOB_LOCATION.replace("signature%2Bvalue", "x".repeat(2_049))],
  ];
  for (const [label, location] of invalidLocations) {
    const harness = makeRedirectHarness(location);
    assertFailure(await run(harness), label);
    assert.equal(harness.rawRequests.length, 3, label);
  }

  for (const status of [200, 301, 302, 308]) {
    const harness = makeRedirectHarness(BLOB_LOCATION);
    harness.routes.config = response(status, harness.image.configBody, {
      "Content-Type": harness.image.configMediaType,
      "Docker-Content-Digest": harness.image.configDigest,
      Location: BLOB_LOCATION,
    });
    assertFailure(await run(harness), `initial status ${status}`);
    assert.equal(harness.rawRequests.length, 3, `initial status ${status}`);
  }

  const missingRedirectDigest = makeRedirectHarness(BLOB_LOCATION);
  delete missingRedirectDigest.routes.config.headers["Docker-Content-Digest"];
  assertFailure(await run(missingRedirectDigest), "missing redirect digest");
  assert.equal(missingRedirectDigest.rawRequests.length, 3);

  const wrongRedirectDigest = makeRedirectHarness(BLOB_LOCATION, {
    "Docker-Content-Digest": `sha256:${"f".repeat(64)}`,
  });
  assertFailure(await run(wrongRedirectDigest), "wrong redirect digest");
  assert.equal(wrongRedirectDigest.rawRequests.length, 3);

  const secondRedirect = makeRedirectHarness(BLOB_LOCATION);
  secondRedirect.routes.blob = response(307, "", { Location: BLOB_LOCATION });
  assertFailure(await run(secondRedirect), "second redirect");
  assert.equal(secondRedirect.rawRequests.length, 4);

  const blobCases = [
    ["status", response(401, secondRedirect.image.configBody, { "Content-Type": "application/octet-stream" })],
    ["content type", response(200, secondRedirect.image.configBody, { "Content-Type": "application/json" })],
    ["content length", response(200, secondRedirect.image.configBody, {
      "Content-Type": "application/octet-stream",
      "Content-Length": "1",
    })],
    ["body digest", response(200, Buffer.concat([secondRedirect.image.configBody, Buffer.from(" ")]), {
      "Content-Type": "application/octet-stream",
    })],
    ["digest header", response(200, secondRedirect.image.configBody, {
      "Content-Type": "application/octet-stream",
      "Docker-Content-Digest": `sha256:${"f".repeat(64)}`,
    })],
    ["location header", response(200, secondRedirect.image.configBody, {
      "Content-Type": "application/octet-stream",
      Location: BLOB_LOCATION,
    })],
  ];
  for (const [label, blob] of blobCases) {
    const harness = makeRedirectHarness(BLOB_LOCATION);
    harness.routes.blob = blob;
    assertFailure(await run(harness), `blob ${label}`);
    assert.equal(harness.rawRequests.length, 4, `blob ${label}`);
  }

  const forwarded = makeRedirectHarness(BLOB_LOCATION);
  forwarded.routes.blob = response(200, forwarded.image.configBody, { "Content-Type": "application/octet-stream" });
  const seenBlobHeaders = [];
  const result = await run(forwarded, forwarded.image.reference, {
    request: async (requestOptions) => {
      if (new URL(requestOptions.url).hostname.endsWith(".blob.core.windows.net")) {
        seenBlobHeaders.push(requestOptions.headers);
        assert.deepEqual(requestOptions.headers, { Accept: forwarded.image.configMediaType });
      }
      return forwarded.request(requestOptions);
    },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(seenBlobHeaders, [{ Accept: forwarded.image.configMediaType }]);
  assert.equal(JSON.stringify(forwarded.visibleRequests).includes("signature%2Bvalue"), false);
});

test("rejects HTTP timeout and oversized streaming responses without disclosure", async () => {
  const timeout = makeHarness();
  const timeoutResult = await run(timeout, timeout.image.reference, {
    request: async () => {
      throw new Error("network timeout with secret token");
    },
  });
  assertFailure(timeoutResult);
  assert.equal(timeoutResult.stderr.includes("secret token"), false);

  const oversizedManifest = makeHarness();
  oversizedManifest.routes.manifest = response(200, Buffer.alloc(4 * 1024 * 1024 + 1, 65), {
    "Content-Type": OCI_MANIFEST,
    "Docker-Content-Digest": oversizedManifest.image.manifestDigest,
  });
  assertFailure(await run(oversizedManifest), "manifest oversize");

  const oversizedConfig = makeHarness();
  oversizedConfig.routes.config = response(200, Buffer.alloc(4 * 1024 * 1024 + 1, 65), {
    "Content-Type": oversizedConfig.image.configMediaType,
    "Docker-Content-Digest": oversizedConfig.image.configDigest,
  });
  assertFailure(await run(oversizedConfig), "config oversize");
});

test("default transport rejects malformed and oversized declared lengths immediately and cleans up", async () => {
  for (const [label, contentLength] of [["malformed", "not-a-length"], ["oversized", "9"]]) {
    const scenario = makeTransportScenario();
    const promise = scenario.begin(8);
    const streamed = new FakeResponse({ "content-length": contentLength });
    scenario.respond(streamed);
    assert.equal(streamed.destroyed, true, label);
    await assert.rejects(promise, label);
    assert.equal(scenario.request.destroyed, true, label);
    assert.equal(scenario.timers.active.size, 0, label);
    assert.equal(scenario.request.listenerCount("error"), 0, label);
    assert.equal(streamed.listenerCount("data"), 0, label);
  }
});

test("default transport rejects chunk overflow, aborts, premature closes, and incomplete responses", async () => {
  const overflow = makeTransportScenario();
  const overflowPromise = overflow.begin(4);
  const overflowResponse = new FakeResponse();
  overflow.respond(overflowResponse);
  overflowResponse.emit("data", Buffer.alloc(5));
  assert.equal(overflowResponse.destroyed, true);
  await assert.rejects(overflowPromise);

  const aborted = makeTransportScenario();
  const abortedPromise = aborted.begin();
  const abortedResponse = new FakeResponse();
  aborted.respond(abortedResponse);
  abortedResponse.emit("aborted");
  await assert.rejects(abortedPromise);

  const premature = makeTransportScenario();
  const prematurePromise = premature.begin();
  const prematureResponse = new FakeResponse({}, false);
  premature.respond(prematureResponse);
  prematureResponse.emit("close");
  await assert.rejects(prematurePromise);

  const incomplete = makeTransportScenario();
  const incompletePromise = incomplete.begin();
  const incompleteResponse = new FakeResponse({}, false);
  incomplete.respond(incompleteResponse);
  incompleteResponse.emit("end");
  await assert.rejects(incompletePromise);

  const responseError = makeTransportScenario();
  const responseErrorPromise = responseError.begin();
  const erroredResponse = new FakeResponse();
  responseError.respond(erroredResponse);
  erroredResponse.emit("error", new Error("synthetic response error"));
  await assert.rejects(responseErrorPromise);

  for (const scenario of [overflow, aborted, premature, incomplete, responseError]) {
    assert.equal(scenario.request.destroyed, true);
    assert.equal(scenario.timers.active.size, 0);
    assert.equal(scenario.request.listenerCount("error"), 0);
  }
});

test("default transport enforces an absolute slow-drip deadline and request failures settle once", async () => {
  const slow = makeTransportScenario();
  const slowPromise = slow.begin(8, 100);
  const slowResponse = new FakeResponse();
  slow.respond(slowResponse);
  slowResponse.emit("data", Buffer.from("a"));
  const deadlineId = [...slow.timers.active.keys()][0];
  slow.timers.fire(deadlineId);
  await assert.rejects(slowPromise);
  assert.equal(slow.request.destroyed, true);
  assert.equal(slow.timers.active.size, 0);
  assert.equal(slow.timers.cleared.includes(deadlineId), true);

  const requestError = makeTransportScenario();
  const requestErrorPromise = requestError.begin();
  requestError.request.emit("error", new Error("synthetic transport error"));
  await assert.rejects(requestErrorPromise);
  assert.equal(requestError.request.destroyed, true);
  assert.equal(requestError.timers.active.size, 0);
  assert.equal(requestError.request.listenerCount("error"), 0);

  const requestAbort = makeTransportScenario();
  const requestAbortPromise = requestAbort.begin();
  requestAbort.request.emit("abort");
  await assert.rejects(requestAbortPromise);
  assert.equal(requestAbort.request.destroyed, true);
  assert.equal(requestAbort.timers.active.size, 0);
  assert.equal(requestAbort.request.listenerCount("abort"), 0);

  const requestTimeout = makeTransportScenario();
  const requestTimeoutPromise = requestTimeout.begin();
  requestTimeout.request.emit("timeout");
  await assert.rejects(requestTimeoutPromise);
  assert.equal(requestTimeout.request.destroyed, true);
  assert.equal(requestTimeout.timers.active.size, 0);
  assert.equal(requestTimeout.request.listenerCount("timeout"), 0);

  const successful = makeTransportScenario();
  const successfulPromise = successful.begin();
  const successfulResponse = new FakeResponse({ "content-length": "3" });
  successful.respond(successfulResponse);
  successfulResponse.emit("data", Buffer.from("a"));
  successfulResponse.emit("data", Buffer.from("bc"));
  successfulResponse.emit("end");
  const result = await successfulPromise;
  assert.equal(result.body.toString(), "abc");
  assert.equal(successful.timers.active.size, 0);
  assert.equal(successful.timers.cleared.length, 1);
  assert.equal(successful.request.socketTimeout, 0);
  assert.equal(successful.request.listenerCount("error"), 0);
  assert.equal(successfulResponse.listenerCount("data"), 0);
});
