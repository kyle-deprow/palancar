import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifyImagePlatform } from "./verify-image-platform.mjs";

const SUBSCRIPTION = "00000000-0000-4000-8000-000000000001";
const SERVER = "palancardev.azurecr.io";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

function digest(body) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function response(status, body) {
  return {
    status,
    async json() {
      return JSON.parse(body);
    },
    async arrayBuffer() {
      return Uint8Array.from(Buffer.from(body, "utf8")).buffer;
    },
  };
}

function fixture({ repository = "palancar-relay", manifestMediaType = OCI_MANIFEST, architecture = "amd64", os = "linux" } = {}) {
  const configBody = JSON.stringify({ architecture, os, rootfs: { type: "layers", diff_ids: [] } });
  const configDigest = digest(configBody);
  const manifestBody = JSON.stringify({
    schemaVersion: 2,
    mediaType: manifestMediaType,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: Buffer.byteLength(configBody),
    },
    layers: [],
  });
  const manifestDigest = digest(manifestBody);
  return {
    configBody,
    configDigest,
    manifestBody,
    manifestDigest,
    repository,
    reference: `${SERVER}/${repository}@${manifestDigest}`,
  };
}

function harness(image, { configBody = image.configBody, tokenStatus = 200, login = {}, manifestDigest = image.manifestDigest } = {}) {
  const calls = [];
  const spawnCalls = [];
  const spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args: [...args], options });
    return {
      status: login.status ?? 0,
      stdout: login.stdout ?? JSON.stringify({ refreshToken: "refresh-token" }),
      stderr: "",
    };
  };
  const tokenUrl = `https://${SERVER}/oauth2/token`;
  const manifestUrl = `https://${SERVER}/v2/${image.repository}/manifests/${manifestDigest}`;
  const configUrl = `https://${SERVER}/v2/${image.repository}/blobs/${image.configDigest}`;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === tokenUrl) {
      return response(tokenStatus, JSON.stringify({ access_token: "access-token" }));
    }
    if (url === manifestUrl) return response(200, image.manifestBody);
    if (url === configUrl) return response(200, configBody);
    throw new Error(`unexpected URL ${url}`);
  };
  return { calls, fetchImpl, spawnImpl, spawnCalls };
}

async function verify(image, options = {}) {
  const fake = harness(image, options);
  const result = await verifyImagePlatform({
    subscription: SUBSCRIPTION,
    image: options.image ?? image.reference,
    fetchImpl: fake.fetchImpl,
    spawnImpl: options.spawnImpl ?? fake.spawnImpl,
  });
  return { fake, result };
}

test("happy path resolves for a Linux amd64 OCI image", async () => {
  const image = fixture();
  const { fake, result } = await verify(image);
  assert.match(result, /linux\/amd64/);
  assert.deepEqual(fake.calls.map(({ url }) => url), [
    `https://${SERVER}/oauth2/token`,
    `https://${SERVER}/v2/palancar-relay/manifests/${image.manifestDigest}`,
    `https://${SERVER}/v2/palancar-relay/blobs/${image.configDigest}`,
  ]);
  assert.deepEqual(fake.spawnCalls[0].args, [
    "acr", "login", "--name", "palancardev", "--expose-token", "--subscription", SUBSCRIPTION,
    "--output", "json", "--only-show-errors",
  ]);
  assert.equal(fake.calls[0].options.method, "POST");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(fake.calls[0].options.body)), {
    grant_type: "refresh_token",
    service: SERVER,
    scope: "repository:palancar-relay:pull",
    refresh_token: "refresh-token",
  });
  assert.equal(fake.calls[0].options.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(fake.calls[1].options.headers.Authorization, "Bearer access-token");
  assert.match(fake.calls[1].options.headers.Accept, /application\/vnd\.oci\.image\.manifest\.v1\+json/);
  assert.match(fake.calls[1].options.headers.Accept, /application\/vnd\.docker\.distribution\.manifest\.v2\+json/);
  assert.doesNotMatch(fake.calls[1].options.headers.Accept, /application\/vnd\.oci\.image\.index\.v1\+json/);
  assert.doesNotMatch(fake.calls[1].options.headers.Accept, /application\/vnd\.docker\.distribution\.manifest\.list\.v2\+json/);
  assert.equal(fake.calls[2].options.headers.Authorization, "Bearer access-token");
});

test("accepts a Docker v2 manifest", async () => {
  const image = fixture({ manifestMediaType: DOCKER_MANIFEST });
  const { result } = await verify(image);
  assert.match(result, /linux\/amd64/);
});

test("propagates a second repository through scope and blob requests", async () => {
  const repository = "palancar-expiry-cleanup";
  const image = fixture({ repository });
  const { fake } = await verify(image);
  assert.equal(new URLSearchParams(fake.calls[0].options.body).get("scope"), `repository:${repository}:pull`);
  assert.equal(fake.calls[1].url, `https://${SERVER}/v2/${repository}/manifests/${image.manifestDigest}`);
  assert.equal(fake.calls[2].url, `https://${SERVER}/v2/${repository}/blobs/${image.configDigest}`);
});

test("rejects an OCI index as a multi-platform image", async () => {
  const image = fixture({ manifestMediaType: OCI_INDEX });
  await assert.rejects(verify(image), /reference points at a multi-platform index.*--provenance=false --sbom=false/);
});

test("rejects an arm64 config", async () => {
  const image = fixture({ architecture: "arm64" });
  await assert.rejects(verify(image), /arm64.*docker buildx build --platform linux\/amd64/);
});

test("rejects a non-Linux config", async () => {
  const image = fixture({ os: "windows" });
  await assert.rejects(verify(image), /windows/);
});

test("rejects a manifest body whose digest does not match the reference", async () => {
  const image = fixture();
  const manifestDigest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(verify(image, { image: `${SERVER}/palancar-relay@${manifestDigest}`, manifestDigest }), /manifest body digest does not match/);
});

test("rejects a config blob whose digest does not match the manifest", async () => {
  const image = fixture();
  const fake = harness(image, { configBody: JSON.stringify({ architecture: "amd64", os: "linux" }) });
  await assert.rejects(verifyImagePlatform({
    subscription: SUBSCRIPTION,
    image: image.reference,
    fetchImpl: fake.fetchImpl,
    spawnImpl: fake.spawnImpl,
  }), /config blob digest does not match/);
});

test("rejects a non-zero az acr login", async () => {
  const image = fixture();
  await assert.rejects(verify(image, { spawnImpl: () => ({ status: 1, stdout: "", stderr: "login failed" }) }), /az acr login failed/);
});

test("rejects an unauthorized token exchange", async () => {
  const image = fixture();
  await assert.rejects(verify(image, { tokenStatus: 401 }), /ACR token exchange returned HTTP 401/);
});

test("rejects a malformed image reference", async () => {
  const image = fixture();
  const fake = harness(image);
  await assert.rejects(verifyImagePlatform({
    subscription: SUBSCRIPTION,
    image: "not-an-image",
    fetchImpl: fake.fetchImpl,
    spawnImpl: fake.spawnImpl,
  }), /Malformed image reference/);
});
