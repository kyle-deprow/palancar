import { spawnSync as defaultSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const DOCKER_LIST = "application/vnd.docker.distribution.manifest.list.v2+json";
const ACCEPT = `${OCI_MANIFEST}, ${DOCKER_MANIFEST}`;
export async function verifyImagePlatform({
  subscription,
  image,
  fetchImpl = globalThis.fetch,
  spawnImpl = defaultSpawnSync,
} = {}) {
  if (typeof subscription !== "string" || subscription.length === 0) throw new Error("A subscription ID is required; pass --subscription <id>.");
  const match = typeof image === "string"
    ? /^(([a-z0-9][a-z0-9-]*)\.azurecr\.io)\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@(sha256:[0-9a-f]{64})$/.exec(image)
    : null;
  if (match === null) throw new Error("Malformed image reference; use <name>.azurecr.io/<repository>@sha256:<64 lowercase hex>.");
  const [, server, registryName, repository, digest] = match;
  if (typeof spawnImpl !== "function") throw new Error("Azure CLI is unavailable; install az and retry the preflight.");
  let login;
  try {
    login = spawnImpl("az", [
      "acr", "login", "--name", registryName,
      "--expose-token", "--subscription", subscription, "--output", "json", "--only-show-errors",
    ], { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("az acr login could not start; authenticate with Azure and retry.");
  }
  if (!login || login.error || login.status !== 0) throw new Error("az acr login failed; authenticate with Azure and retry.");
  let loginPayload;
  try {
    loginPayload = JSON.parse(Buffer.from(login.stdout ?? "").toString("utf8"));
  } catch {
    throw new Error("az acr login returned invalid JSON; authenticate with Azure and retry.");
  }
  const refreshToken = loginPayload?.refreshToken;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) throw new Error("az acr login did not return refreshToken; authenticate with Azure and retry.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is unavailable; use a supported Node.js runtime and retry.");
  let tokenResponse;
  try {
    tokenResponse = await fetchImpl(`https://${server}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        service: server,
        scope: `repository:${repository}:pull`,
        refresh_token: refreshToken,
      }).toString(),
    });
  } catch {
    throw new Error("ACR token exchange failed; check registry connectivity and retry.");
  }
  if (!tokenResponse || tokenResponse.status !== 200) throw new Error(`ACR token exchange returned HTTP ${tokenResponse?.status ?? "unknown"}; authenticate again and retry.`);
  let tokenPayload;
  try {
    tokenPayload = await tokenResponse.json();
  } catch {
    throw new Error("ACR token exchange returned invalid JSON; authenticate again and retry.");
  }
  const accessToken = tokenPayload?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) throw new Error("ACR token exchange did not return access_token; authenticate again and retry.");
  let manifestResponse;
  try {
    manifestResponse = await fetchImpl(`https://${server}/v2/${repository}/manifests/${digest}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: ACCEPT },
    });
  } catch {
    throw new Error("The registry manifest request failed; check registry connectivity and retry.");
  }
  if (!manifestResponse || manifestResponse.status !== 200) throw new Error(`The registry manifest request returned HTTP ${manifestResponse?.status ?? "unknown"}; verify the image reference and retry.`);
  let manifestBody;
  try {
    manifestBody = Buffer.from(await manifestResponse.arrayBuffer());
  } catch {
    throw new Error("The registry returned an unreadable manifest; retry the preflight.");
  }
  const manifestDigest = `sha256:${createHash("sha256").update(manifestBody).digest("hex")}`;
  if (manifestDigest !== digest) throw new Error("The manifest body digest does not match the requested digest; use the immutable digest returned by the image push.");
  let manifest;
  try {
    manifest = JSON.parse(manifestBody.toString("utf8"));
  } catch {
    throw new Error("The manifest body is not valid JSON; rebuild and push a valid image.");
  }
  if (manifest?.mediaType === OCI_INDEX || manifest?.mediaType === DOCKER_LIST) throw new Error("The reference points at a multi-platform index; rebuild with --provenance=false --sbom=false.");
  if (manifest?.mediaType !== OCI_MANIFEST && manifest?.mediaType !== DOCKER_MANIFEST) throw new Error("The manifest is not a single-image manifest; rebuild with --provenance=false --sbom=false.");
  const configDigest = manifest?.config?.digest;
  if (typeof configDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(configDigest)) throw new Error("The manifest has no valid config digest; rebuild and push a valid image.");
  let configResponse;
  try {
    configResponse = await fetchImpl(`https://${server}/v2/${repository}/blobs/${configDigest}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error("The registry config request failed; check registry connectivity and retry.");
  }
  if (!configResponse || configResponse.status !== 200) throw new Error(`The registry config request returned HTTP ${configResponse?.status ?? "unknown"}; verify registry access and retry.`);
  let configBody;
  try {
    configBody = Buffer.from(await configResponse.arrayBuffer());
  } catch {
    throw new Error("The registry returned an unreadable image config; retry the preflight.");
  }
  const actualConfigDigest = `sha256:${createHash("sha256").update(configBody).digest("hex")}`;
  if (actualConfigDigest !== configDigest) throw new Error("The config blob digest does not match the manifest; use the immutable image digest and retry.");
  let config;
  try {
    config = JSON.parse(configBody.toString("utf8"));
  } catch {
    throw new Error("The image config is not valid JSON; rebuild and push a valid image.");
  }
  const architecture = typeof config?.architecture === "string" ? config.architecture : JSON.stringify(config?.architecture) ?? "<missing>";
  if (config?.architecture !== "amd64") throw new Error(`The image config reports architecture ${JSON.stringify(architecture)}; rebuild with docker buildx build --platform linux/amd64.`);
  const os = typeof config?.os === "string" ? config.os : JSON.stringify(config?.os) ?? "<missing>";
  if (config?.os !== "linux") throw new Error(`The image config reports os ${JSON.stringify(os)}; rebuild with docker buildx build --platform linux/amd64.`);
  return `ok ${repository}@${digest} linux/amd64`;
}
async function runCli() {
  let subscription;
  let image;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--subscription" && flag !== "--image") {
      throw new Error(`Unknown flag ${flag}; use --subscription <id> --image <ref>.`);
    }
    if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
      throw new Error(`Missing value for ${flag}; use --subscription <id> --image <ref>.`);
    }
    if (flag === "--subscription") {
      if (subscription !== undefined) throw new Error("The --subscription flag was provided more than once; provide it once.");
      subscription = args[++index];
    } else {
      if (image !== undefined) throw new Error("The --image flag was provided more than once; provide it once.");
      image = args[++index];
    }
  }
  if (subscription === undefined || image === undefined) {
    throw new Error("Both --subscription <id> and --image <ref> are required.");
  }
  return verifyImagePlatform({ subscription, image });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then(
    (output) => process.stdout.write(`${output}\n`),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Image preflight failed; retry."}\n`);
      process.exitCode = 1;
    },
  );
}
