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

The implementation and guards are present, but this document does not claim
that the live rollout or final evidence is complete.

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

## Lifecycle-controlled rollout

Enabled-relay changes are lifecycle-only. `dev-plan-lifecycle.mjs` owns the
saved plan, guard, diagnostic, preflight, apply, receipt, and phase-order
checks. Do not substitute a standalone Terraform plan or apply for an
enabled-relay phase.

Initialize once, then run each non-terminal phase in order:

```sh
node infra/scripts/dev-plan-lifecycle.mjs init

run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create model-bootstrap)"
node infra/scripts/dev-plan-lifecycle.mjs guard model-bootstrap "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs preflight model-bootstrap "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs apply model-bootstrap "$run_id"

run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create runtime-cutover)"
node infra/scripts/dev-plan-lifecycle.mjs guard runtime-cutover "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs diagnostic runtime-cutover "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs preflight runtime-cutover "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs apply runtime-cutover "$run_id"

run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create credential-cleanup)"
node infra/scripts/dev-plan-lifecycle.mjs guard credential-cleanup "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs preflight credential-cleanup "$run_id"
node infra/scripts/dev-plan-lifecycle.mjs apply credential-cleanup "$run_id"
```

The phase-to-guard contract is:

| Phase | Guard mode | Allowed transition |
| --- | --- | --- |
| `model-bootstrap` | `luna-model-bootstrap` | One canonical `gpt-5.6-luna` deployment create; transcription, relay, RBAC, outputs, and all other resources are no-op. |
| `runtime-cutover` | `azure-generation-cutover` | One relay Container App update to Azure-only generation; one container, zero secrets, and all other resources are no-op. |
| `credential-cleanup` | `azure-credential-cleanup` | One deletion of the runtime Key Vault Secrets User assignment; the app, deployments, and all other RBAC are no-op. |
| `terminal` | `final-rollout-complete` | Complete no-op plan with final checks and zero drift; verification only. |

If an apply exits ambiguously, run only the matching read-only reconciliation.
For runtime cutover this is:

```sh
node infra/scripts/dev-plan-lifecycle.mjs reconcile runtime-cutover <run-id>
```

Never replay an old plan after an ambiguous apply. A credential-cleanup plan
that expires after irreversible cleanup is recovered with the utility's
supported supersession flow:

```sh
node infra/scripts/dev-plan-lifecycle.mjs supersede credential-cleanup <old-run-id>
```

The replacement run receives its own guard and preflight. The terminal phase
has no `preflight` or `apply`:

```sh
terminal_run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create terminal)"
node infra/scripts/dev-plan-lifecycle.mjs guard terminal "$terminal_run_id"
node infra/scripts/dev-plan-lifecycle.mjs finalize terminal "$terminal_run_id"
node infra/scripts/dev-plan-lifecycle.mjs close terminal "$terminal_run_id"
```

`close` seals the protected rollout evidence root and is permitted only after
terminal finalization. The final guard and close are not evidence that has
already been produced; they are the last operator actions.

### Immutable runtime image contract

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

The lifecycle's remote ACR verifier is authoritative: it accepts only a
single Linux/amd64 OCI or Docker manifest and matching config, and rejects
ARM64 images, indexes, manifest lists, tags, and other mutable references.
It obtains ephemeral Azure CLI refresh and scoped registry access tokens in
memory for verification and never persists or exposes either token. The
protected verifier is also reviewed against the Azure CLI 2.83 `az acr
login --expose-token` JSON shape and the current ACR SAS blob-redirect
schema; revalidate those compatibility contracts before upgrading the Azure
CLI or changing registry behavior.

## Diagnostics and cleanup utilities

### Azure generation diagnostic

The runtime-cutover lifecycle operation is the operator entry point. It
validates the existing Container Apps Job, reserves durable intent, and starts
at most one execution for the run. The Job uses the guarded immutable relay
image, the Entra runtime identity, the exact no-argument diagnostic command,
and no secrets:

```sh
node infra/scripts/dev-plan-lifecycle.mjs diagnostic runtime-cutover <run-id>
```

The Job's inner command is:

```sh
node apps/relay/dist/azure-generation-diagnostic.js
```

The lifecycle supplies `AZURE_CLIENT_ID`,
`PALANCAR_AZURE_GENERATION_ENDPOINT`, and
`PALANCAR_AZURE_GENERATION_DEPLOYMENT` from the guarded plan. The executable
uses Entra and permits at most two sequential model attempts, each through a
fresh `GenerationService`, with retry limited to the two exact trusted,
correlation-matched complete language-validation evidence shapes. Any
malformed, missing, multiple, inconsistent, provider, timeout, cancellation,
or unknown evidence is terminal; attempt two is final and no third attempt is
allowed. `GenerationService` and the session do not retry. The executable
makes one bounded synthetic generation request per attempt and prints only
`azure-generation-diagnostic: passed` or a fixed failure stage. It exits `0`
on success and `20` on failure, with one 90-second watchdog. This is
diagnostic-process retry only; the lifecycle still makes one ACA Job start.
Intent, invoking, submission, execution, and receipt artifacts are durable and
resumable. A timeout or ambiguous start is reconciled against the Job execution
and never submitted again; runtime preflight requires the receipt bound to the
guarded image.

### Runtime Key Vault role toggle

This utility operates only on the protected ignored dev tfvars file and has
three production modes:

```sh
node infra/scripts/set-dev-runtime-secrets-role.mjs assert-enabled
node infra/scripts/set-dev-runtime-secrets-role.mjs disable
node infra/scripts/set-dev-runtime-secrets-role.mjs assert-disabled
```

Use `assert-enabled` before the runtime cutover. After the Azure-only runtime
is proven, disable the role and verify the disabled state before creating and
guarding the credential-cleanup run. Its lifecycle preflight checks the same
disabled state; lifecycle apply resumes the cleanup and requires absence
evidence.
There is no production `enable` command.

### Key Vault credential cleanup

The cleanup utility uses Entra-authenticated Azure reads and a protected,
run-bound operation. Its exact CLI is:

```sh
node infra/scripts/cleanup-key-vault-credentials.mjs start <run-id>
node infra/scripts/cleanup-key-vault-credentials.mjs resume <run-id>
node infra/scripts/cleanup-key-vault-credentials.mjs assert-absent <run-id>
```

Credential cleanup is fixed to the two retired secret names
`openrouter-api-key` and `litellm-master-key`; those names are documented here
only as historical cleanup targets. The lifecycle credential-cleanup
preflight creates the descriptor and starts/resumes the operation as needed.
Use the direct commands only with the matching lifecycle run and protected
receipts; do not invent a run ID or a target name.

### Local environment cleanup

After the revocation utility has proved provider-side revocation, and after
the Azure-only runtime is proven, remove the retired local credential with its
fixed production file/key pair:

```sh
node infra/scripts/remove-env-entry.mjs remove /home/dev/repos/palancar_ws/.env OPENROUTER_API_KEY
node infra/scripts/remove-env-entry.mjs assert-absent /home/dev/repos/palancar_ws/.env OPENROUTER_API_KEY
```

The key name is shown only in this historical cleanup command. The utility is
fail-closed for other paths or keys and maintains bounded recovery artifacts.

### Historical provider-revocation evidence

The retained revocation utility is a terminal prerequisite for the retired
provider credential. It captures preflight evidence, waits for user/provider
revocation, requires an HTTP 401 response before entering `revoked`, and then
requires the local environment removal proof before `local-removed` and
`assert-complete`:

```sh
node infra/scripts/openrouter-revocation-state.mjs prepare
node infra/scripts/openrouter-revocation-state.mjs resume
node infra/scripts/openrouter-revocation-state.mjs mark-local-removed
node infra/scripts/openrouter-revocation-state.mjs assert-complete
```

The provider and key names in this section are historical cleanup context only;
they are not runtime providers, fallbacks, sidecars, or active configuration.

## Checks

Useful non-mutating repository checks are:

```sh
terraform fmt -check -recursive infra
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

Run the lifecycle/guard and utility tests before any live phase. Keep all
plans, receipts, state, and live configuration outside Git.
