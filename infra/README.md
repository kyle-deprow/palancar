# Palancar infrastructure

This directory contains the Terraform-managed Azure foundation and dev
workload. Terraform is pinned to `1.15.8`; provider versions are pinned by the
committed lock files. Azure CLI/Entra is the local authentication mechanism.
Never commit credentials, live variable files, backend files, state, or plan
artifacts.

## Implemented target state

- Azure Foundry is managed by Terraform with local authentication disabled.
- The enabled relay requires exactly two Foundry deployments:
  `gpt-4o-mini-transcribe` (`2025-12-15`, `GlobalStandard`, capacity `1`) and
  `gpt-5.6-luna` (`2026-07-09`, `GlobalStandard`, capacity `1013`). Both use
  `OpenAI` format and `NoAutoUpgrade`.
- Transcription uses the Azure Realtime deployment. Generation calls the
  `gpt-5.6-luna` deployment directly through Azure OpenAI. The relay uses its
  user-assigned managed identity and Entra tokens; no API key or proxy is part
  of the deployed runtime.
- The workload has one relay container and an empty Container Apps secrets
  collection. Terraform supplies the generation provider, generated Azure
  endpoint, deployment name, managed-identity client ID, and transcription
  settings.
- `development-provisional` is allowed only for the dev language boundary.
  Staging and production must use `deny-all`.

OpenRouter, LiteLLM, and their credential names are retired. Any occurrence in
this repository's operator flow is historical cleanup context only; they are
not runtime providers, sidecars, fallbacks, or active configuration.

The Terraform implementation is present; review the plan before applying
changes to the intended environment.

## Bootstrap and remote state

Authenticate to the intended Azure cloud and subscription with Entra, without
putting tenant or subscription values in the repository:

```sh
az login
az account set --subscription '<subscription-name-or-id>'
```

The bootstrap stack starts with local state and creates the protected state
storage. Initialize and validate it before applying:

```sh
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap plan -refresh=false -lock=false
terraform -chdir=infra/bootstrap apply
```

After the protected state containers exist, copy the ignored backend examples,
fill them from bootstrap outputs, and migrate/bootstrap remote state according
to those examples. Initialize dev directly against its ignored backend file:

```sh
terraform -chdir=infra/environments/dev init -backend-config=backend.hcl
terraform -chdir=infra/environments/dev validate
```

Do not paste backend values, resource IDs, endpoints, or secrets into this
document or committed Terraform examples.

## Runtime image contract

Build and push both runtime images from the repository root with the exact
reviewed amd64-only commands. Obtain the ephemeral Azure CLI expose-token JSON
and hand its access token to Docker over stdin using a private Docker config;
the expose-token JSON and access token stay in shell memory, while `docker
login` stores the credential only in that private temporary `DOCKER_CONFIG`:

```sh
set -eu
umask 077
ACR_LOGIN_SERVER=palancardevacraeeacd8c.azurecr.io
subscription_id="$(az account show --query id --output tsv --only-show-errors)"
node -e 'if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(process.argv[1] ?? "")) process.exit(1)' "$subscription_id"

metadata_dir="$(mktemp -d /tmp/palancar-acr-metadata.XXXXXX)"
case "$metadata_dir" in
  /tmp/palancar-acr-metadata.[A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-]) ;;
  *) printf '%s\n' 'unsafe metadata directory' >&2; exit 1 ;;
esac
trap 'rm -rf -- "$metadata_dir"' EXIT
DOCKER_CONFIG="$metadata_dir/docker-config"
mkdir -m 700 "$DOCKER_CONFIG"
export DOCKER_CONFIG

acr_login_json="$(az acr login \
  --name "${ACR_LOGIN_SERVER%.azurecr.io}" \
  --expose-token \
  --subscription "$subscription_id" \
  --output json \
  --only-show-errors)"
access_token="$(printf '%s' "$acr_login_json" | node -e '
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { text += chunk; });
  process.stdin.on("end", () => {
    try {
      const value = JSON.parse(text);
      if (typeof value.accessToken !== "string" || value.accessToken.length === 0) process.exit(1);
      process.stdout.write(value.accessToken);
    } catch {
      process.exit(1);
    }
  });
')"
unset acr_login_json
printf '%s' "$access_token" | docker login "$ACR_LOGIN_SERVER" \
  --username 00000000-0000-0000-0000-000000000000 \
  --password-stdin
unset access_token

relay_metadata="$metadata_dir/palancar-relay.json"
cleanup_metadata="$metadata_dir/palancar-expiry-cleanup.json"
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --push \
  --metadata-file "$relay_metadata" \
  --tag "$ACR_LOGIN_SERVER/palancar-relay:release" \
  --file apps/relay/Dockerfile .
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --push \
  --metadata-file "$cleanup_metadata" \
  --tag "$ACR_LOGIN_SERVER/palancar-expiry-cleanup:release" \
  --file tools/expiry-cleanup/Dockerfile .

relay_digest="$(node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8"))["containerimage.digest"]; if(typeof value!=="string" || !/^sha256:[a-f0-9]{64}$/.test(value)) process.exit(1); process.stdout.write(value)' "$relay_metadata")"
cleanup_digest="$(node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8"))["containerimage.digest"]; if(typeof value!=="string" || !/^sha256:[a-f0-9]{64}$/.test(value)) process.exit(1); process.stdout.write(value)' "$cleanup_metadata")"
printf 'relay_image_digest = "%s/palancar-relay@%s"\nexpiry_cleanup_image_digest = "%s/palancar-expiry-cleanup@%s"\n' \
  "$ACR_LOGIN_SERVER" "$relay_digest" "$ACR_LOGIN_SERVER" "$cleanup_digest"
```

Copy those immutable references into the protected private `terraform.tfvars`
file. The expose-token JSON and access token are passed only through shell
memory/stdin: the token is handed to Docker using the private `DOCKER_CONFIG`
and then unset. This uses the build metadata emitted by each exact push and
performs no second registry lookup, so a mutable tag cannot race digest
capture. The private Docker config and metadata directory may be removed after
the pins are recorded.

Before applying the immutable pins, run the preflight for each image:

```sh
node infra/scripts/verify-image-platform.mjs --subscription "$subscription_id" --image "$ACR_LOGIN_SERVER/palancar-relay@$relay_digest"
node infra/scripts/verify-image-platform.mjs --subscription "$subscription_id" --image "$ACR_LOGIN_SERVER/palancar-expiry-cleanup@$cleanup_digest"
```

The build host is aarch64 (ARM), while Azure Container Apps run linux/amd64.
A plain `docker build` can produce an arm64 image, and buildx provenance or
SBOM settings can publish an OCI index. The preflight checks the immutable
manifest and config in ACR so either mismatch is caught before deployment.

## Checks

Run these repository checks before applying infrastructure changes:

```sh
terraform fmt -check -recursive infra
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
node --test infra/scripts/verify-image-platform.test.mjs
```

For a change, update Terraform, review the plan, and apply it to the intended
environment.
