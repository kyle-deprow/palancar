# LiteLLM/OpenRouter generation pivot plan

Date: 2026-08-12

## Objective

Move Palancar generation inference behind a LiteLLM gateway interface so the
relay can use OpenRouter immediately while preserving a clean switch back to
Azure OpenAI/Foundry after the Azure `715-123420` deployment block is cleared.

The implementation must test against the real Azure relay Container App using
an OpenRouter-backed LiteLLM model before the feature is considered complete.

## Fixed decisions

- Relay-facing model alias: `palancar-generation`.
- OpenRouter upstream model: `openrouter/openai/gpt-5.6-luna`.
- Future Azure upstream model format: `azure/<deployment-name>`.
- Relay-to-LiteLLM base URL: `http://127.0.0.1:4000`.
- LiteLLM bind: `0.0.0.0:4000` inside the Container App replica. Container App
  ingress remains only on relay port `8787`; port `4000` is internal to the
  replica.
- LiteLLM image pin for initial implementation:
  `ghcr.io/berriai/litellm:v1.75.5-stable@sha256:751ba882360f8d62c63ceb0a5b628f897cee0e0b93b3596c81ff1228e6b77ce3`
  for linux/amd64.
- Key Vault Secrets User role definition ID:
  `4633458b-17de-408a-b874-0445c86b69e6`.
- Relay provider config is explicit in executable startup. No production or
  deployed executable start may silently default to mock. Tests use dependency
  injection or set `PALANCAR_GENERATION_PROVIDER=mock` explicitly.

## Primary external contracts

- LiteLLM is used as a proxy/gateway, not the Python SDK, because the relay is a
  TypeScript/Node service. LiteLLM exposes an OpenAI-compatible HTTP API.
- LiteLLM proxy config uses `model_list`; `model_name` is the app-facing name
  and `litellm_params.model` is the provider route.
- LiteLLM OpenRouter provider route is `openrouter/<openrouter model id>`.
- OpenRouter authenticates via bearer API key and exposes an
  OpenAI-compatible chat completions API.
- Azure OpenAI later uses the documented LiteLLM route
  `azure/<deployment-name>`, with endpoint, API version, and credential
  material supplied outside Git.

## Architecture

```text
Relay generation service
  |
  | HTTP POST http://127.0.0.1:4000/v1/chat/completions
  | Authorization: Bearer <LiteLLM master key>
  v
LiteLLM proxy sidecar in same Container App
  |
  | model_name: palancar-generation
  | litellm_params.model: env/PALANCAR_LITELLM_UPSTREAM_MODEL
  | provider credential: env/provider-specific secret
  v
OpenRouter now; Azure OpenAI later
```

The relay never receives the OpenRouter provider key. It only receives a
LiteLLM master key for localhost sidecar authentication. Both secrets are
stored in a dedicated Palancar workload Key Vault and injected into the
Container App through Key-Vault-backed Container App secret references.
Terraform stores only Key Vault secret URLs and identity references, not secret
values.

## Paid-backend smoke safety

The current Azure relay still uses development ticket issuance. A public,
unauthenticated ticket endpoint combined with a paid OpenRouter backend is
abuseable. Therefore this pivot deploys OpenRouter only as a short-lived smoke
revision. After smoke, every paid revision must have zero traffic, the
temporary OpenRouter inference key must be deleted and verified unusable with
HTTP `401`, and both exact Key Vault secret versions created for smoke must be
disabled.

### Paid smoke wrapper

Add `tools/openrouter-smoke/run-paid-smoke.mjs`. This is the only executable
that may deploy a paid OpenRouter revision.

Required environment:

- `OPENROUTER_MANAGEMENT_KEY`: OpenRouter management key with permission to
  create and delete API keys.
- `PALANCAR_RELAY_IMAGE_DIGEST`: new relay image digest.
- `PALANCAR_LITELLM_IMAGE_DIGEST`: new LiteLLM proxy image digest.
- `PALANCAR_KEY_VAULT_NAME`: workload Key Vault name.
- `PALANCAR_KEY_VAULT_RESOURCE_GROUP`: workload Key Vault resource group.

Wrapper sequence:

1. Arm an idempotent async cleanup trap before creating any OpenRouter key.
   Trap handles normal exit, thrown error, SIGINT, and SIGTERM.
2. Capture current Container App state:
   - all baseline revision names, active flags, and traffic weights from
     `az containerapp revision list --all`
   - current relay image digest from `az containerapp show`
   - complete relay container env relevant to generation
   - complete Container App secret-reference names relevant to generation
   - current generation provider
   The first implementation supports exactly one baseline shape:
   `PALANCAR_GENERATION_PROVIDER=mock`, no LiteLLM sidecar container, no
   OpenRouter secret reference, no LiteLLM master-key secret reference, and no
   relay LiteLLM environment variables. The wrapper structurally proves this
   from `az containerapp show` before creating an OpenRouter key and aborts
   otherwise.
3. Create a temporary OpenRouter inference key:
   - `POST https://openrouter.ai/api/v1/keys`
   - bearer: management key
   - body includes name, `limit: 1.00`, `limit_reset: null`, and `expires_at`
     no more than two hours in the future
4. Validate response:
   - plaintext key exists and is retained only in memory
   - hash exists and is stored for cleanup
   - `limit == 1.00`
   - `expires_at` is within two hours
5. Generate a random LiteLLM master key in memory.
6. Write Key Vault secret versions:
   - `az keyvault secret set --vault-name "$PALANCAR_KEY_VAULT_NAME" --name openrouter-api-key --value <temporary key>`
   - `az keyvault secret set --vault-name "$PALANCAR_KEY_VAULT_NAME" --name litellm-master-key --value <master key>`
   Record the returned versioned secret IDs for the paid plan and cleanup.
7. Create and inspect the paid workload saved plan.
8. Apply only the inspected paid workload saved plan.
9. Record paid revision names as the set of Container App revisions present
   after paid apply that were not present in the captured baseline. This set
   must be nonempty or the wrapper fails and enters cleanup.
10. Run `apps/relay/scripts/smoke-litellm-generation.mjs`.
11. Run cleanup.

Canonical cleanup sequence, best-effort and idempotent. Each step retries up to
three times with exponential backoff, records the exact failed step, and then
continues to later cleanup steps without exposing secrets:

1. Create/inspect/apply the restore saved plan.
2. Verify paid revisions. The previously recorded paid revision set must be
   nonempty. Paid revision names are computed by comparing the full
   `az containerapp revision list --all` result after paid apply against the
   full `--all` baseline captured before key creation. For every recorded paid
   revision name, run:

   ```sh
   az containerapp revision list \
     -g rg-palancar-dev-aeeacd8c \
     -n ca-palancar-dev-relay-aeeacd8c \
     --all \
     --query "[?name=='<paid revision name>'].{name:name,trafficWeight:trafficWeight,active:active}" \
     -o json
   ```

   The query must return exactly one result. That result must have
   `trafficWeight == 0`. If Azure marks `active == false`, that is acceptable
   only in addition to zero traffic.
3. Disable the exact Key Vault secret versions created for smoke:
   `az keyvault secret set-attributes --id <versioned secret id> --enabled false`.
   This applies to both the `openrouter-api-key` version and the
   `litellm-master-key` version.
4. Prove both exact versioned Key Vault secrets are disabled:

   ```sh
   az keyvault secret show --id <openrouter versioned secret id> --query attributes.enabled -o tsv
   az keyvault secret show --id <litellm master versioned secret id> --query attributes.enabled -o tsv
   ```

   Both commands must return `false`.
5. Delete the OpenRouter smoke key by hash:
   `DELETE https://openrouter.ai/api/v1/keys/{hash}`.
   If DELETE returns `404`, continue only to verification; do not treat `404`
   alone as success.
6. Verify the deleted smoke key returns `401` from
   `GET https://openrouter.ai/api/v1/key`. `403` is not accepted as proof of
   key deletion.
7. Verify the public relay `/readyz` no longer reports
   `generation.provider == "litellm"`.

Completion requires all three cleanup proofs: every recorded paid revision has
zero traffic, the deleted OpenRouter smoke key returns exactly `401` from
`GET https://openrouter.ai/api/v1/key`, and both recorded versioned Key Vault
secrets are disabled.

## `packages/generation` implementation

Add `src/litellm.ts`:

- `LiteLLMChatGenerationProvider` implements `GenerationProvider`.
- Config:
  - `baseUrl`: HTTP/HTTPS URL with no query/fragment; normalize trailing slash.
  - `apiKey`: nonempty string.
  - `model`: nonempty string, max 128.
  - `timeoutMs`: positive integer, default 15_000, max 60_000.
  - `maxResponseBytes`: positive integer, default 16_384, max 16_384.
  - `maxTokens`: positive integer, default 1_024, max 1_024.
  - optional provider-safe `id`/`version`.
- POST to `<baseUrl>/v1/chat/completions`.
- Headers:
  - `Authorization: Bearer <apiKey>`
  - `content-type: application/json`
- Body:
  - `model`
  - `stream: false`
  - no `temperature` unless local pinned-LiteLLM validation proves the selected
    OpenRouter model accepts it
  - `reasoning_effort: "none"` if the pinned LiteLLM/OpenRouter path passes it
    through correctly; otherwise omit provider-specific reasoning controls
  - `max_tokens`
  - `messages`
  - `response_format` strict JSON schema
- Exact response-format wire shape:

Translation:

```json
{
  "type": "json_schema",
  "json_schema": {
    "name": "palancar_translation",
    "strict": true,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["englishTranslation"],
      "properties": {
        "englishTranslation": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1024
        }
      }
    }
  }
}
```

Suggestions:

```json
{
  "type": "json_schema",
  "json_schema": {
    "name": "palancar_suggestions",
    "strict": true,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["suggestions"],
      "properties": {
        "suggestions": {
          "type": "array",
          "minItems": 2,
          "maxItems": 3,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["englishText", "selectedTargetText"],
            "properties": {
              "englishText": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1024
              },
              "selectedTargetText": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1024
              }
            }
          }
        }
      }
    }
  }
}
```
- Runtime validation after JSON parse is still required; schema support by the
  upstream provider is not trusted as the sole validator.
- `maxResponseBytes` default `16_384`; `maxTokens` default `1_024`. These caps
  may reject otherwise schema-valid maximum-length suggestion outputs and that
  is acceptable for v1 because the product requires concise suggestions.
- Defensive handling:
  - HTTP non-2xx -> generic provider failure.
  - network/timeout -> generic provider failure.
  - missing choices/message/content -> generic provider failure.
  - content over `maxResponseBytes` -> generic provider failure before parse.
  - malformed generated JSON -> generic provider failure under the current
    `GenerationService` contract.
  - finish reason must be `stop`.
  - refusals and tool calls are rejected.
  - no streaming.
- Redaction:
  - No thrown error includes API key, transcript text, translation text,
    suggestion text, prompt text, provider response body, or provider error
    body.

## `apps/relay` implementation

Add runtime generation config:

- `PALANCAR_GENERATION_PROVIDER=mock|litellm` is required by executable startup.
- Tests or callers that inject `generationService` can bypass environment
  parsing.
- `mock` creates the existing deterministic provider.
- `litellm` requires:
  - `PALANCAR_LITELLM_BASE_URL`
  - `PALANCAR_LITELLM_API_KEY`
  - `PALANCAR_LITELLM_MODEL`
  - optional `PALANCAR_LITELLM_TIMEOUT_MS`
- If required config is absent or malformed, startup fails with the existing
  generic `relay failed to start`.
- `/healthz` stays process-only: `{ "ok": true }`.
- `/readyz` returns content-free dependency state:

```json
{
  "ready": true,
  "generation": {
      "provider": "litellm",
      "providerId": "litellm-chat",
      "model": "palancar-generation",
      "backend": "openrouter",
      "upstreamModel": "openrouter/openai/gpt-5.6-luna",
      "upstreamReady": true
  }
}
```

For mock:

```json
{
  "ready": true,
  "generation": {
    "provider": "mock",
    "providerId": "deterministic-mock-generation",
    "model": "mock",
    "upstreamReady": true
  }
}
```

LiteLLM readiness proof:

- Relay calls `GET <baseUrl>/v1/models` with the LiteLLM master key.
- Response must be 2xx.
- Response must contain model id `palancar-generation`.
- Relay calls `GET <metadataUrl>/palancar/provider` against the sidecar metadata
  server.
- Metadata response must be 2xx and exactly match the relay's expected backend,
  upstream model, and alias:
  - `backend`
  - `upstreamModel`
  - `alias`
- `upstreamReady` is true only when both the authenticated `/v1/models` alias
  check and the unauthenticated local metadata route check pass.
- `/readyz` returns HTTP 503 with `ready:false` for timeout, authentication
  failure, non-2xx, malformed catalog, duplicate/missing aliases, alias
  mismatch, backend mismatch, or route mismatch.
- Readiness requests are bounded independently:
  - timeout: 2_000 ms
  - max response bytes: 16_384
  - strict parsed response shape for both `/v1/models` and metadata
  - tests cover non-2xx, timeout, malformed JSON, duplicate/missing aliases,
    unexpected backend metadata, alias mismatch, and upstream-model mismatch.

The smoke script must verify `/readyz.generation.provider == "litellm"` and
`model == "palancar-generation"` before sending audio frames.

## `apps/litellm-proxy` implementation

Add a minimal LiteLLM proxy image/config:

- `config.yaml`
  - fixed relay-facing alias `palancar-generation`
  - no raw request/response logging
  - no callbacks
  - no database
  - retry/fallback disabled or bounded to a single upstream attempt to avoid
    duplicate paid calls during smoke
- `entrypoint.sh`
  - validates `PALANCAR_LITELLM_BACKEND`.
  - renders backend-specific config from a committed template into `/tmp`.
  - OpenRouter mode requires:
    - `PALANCAR_LITELLM_UPSTREAM_MODEL`
    - `OPENROUTER_API_KEY`
  - Azure mode requires:
    - `PALANCAR_LITELLM_UPSTREAM_MODEL`
    - `AZURE_API_BASE`
    - `AZURE_API_VERSION`
    - exactly one supported Azure credential path. Initial implementation may
      support Azure API key via Key Vault; managed identity must remain disabled
      until validated with the pinned LiteLLM version.
  - mutual-exclusion validation prevents OpenRouter and Azure credential sets
    from both being active.
  - starts a content-free metadata server on `0.0.0.0:4001` serving
    `/palancar/provider`.
  - starts LiteLLM:
    `litellm --config /tmp/palancar-litellm.yaml --host 0.0.0.0 --port 4000`
- `Dockerfile`
  - base image is the fixed LiteLLM pin:
    `ghcr.io/berriai/litellm:v1.75.5-stable@sha256:751ba882360f8d62c63ceb0a5b628f897cee0e0b93b3596c81ff1228e6b77ce3`
  - copies template and entrypoint only.
  - includes the tiny metadata server script.

Local image validation must prove:

- starts database-free
- loads rendered config
- `GET /v1/models` requires/accepts master key
- `/v1/models` returns `palancar-generation`
- no database connection failure appears in logs

## `infra` implementation

### Key Vault

Add a dedicated workload Key Vault module/resource:

- name derived from existing prefix/environment/suffix.
- RBAC authorization enabled.
- public network access allowed for this dev smoke unless private networking is
  separately implemented.
- Terraform creates vault/RBAC only.
- Terraform does not write OpenRouter or LiteLLM secret values.
- Runtime identity gets Key Vault Secrets User at the vault scope for this dev
  smoke. Future hardening can move to secret-scoped RBAC.

### Container App workload sidecar

Extend `infra/modules/container-app-workload`:

- `enable_litellm_sidecar`
- `litellm_image_digest`
- `litellm_backend` enum `openrouter|azure`
- `litellm_upstream_model`
- `openrouter_api_key_secret_url`
- `litellm_master_key_secret_url`
- `azure_api_base`
- `azure_api_version`
- `azure_api_key_secret_url`
- `litellm_cpu`, default `0.25`
- `litellm_memory`, default `0.5Gi`

Preconditions when sidecar enabled:

- `litellm_image_digest` nonempty immutable digest.
- `litellm_master_key_secret_url` nonempty.
- OpenRouter backend requires only `openrouter_api_key_secret_url` and rejects
  Azure API fields.
- Azure backend requires `azure_api_base`, `azure_api_version`, and
  `azure_api_key_secret_url`, and rejects OpenRouter secret URL.

Container App secrets:

- `openrouter-api-key`: Key Vault reference in OpenRouter mode.
- `litellm-master-key`: Key Vault reference.
- `azure-api-key`: Key Vault reference in Azure mode.

Secrets use:

- `keyVaultUrl`
- runtime identity ARM ID

LiteLLM container:

- name: `litellm`
- image: `litellm_image_digest`
- resources: `litellm_cpu` / `litellm_memory`
- env:
  - `PALANCAR_LITELLM_BACKEND`
  - `PALANCAR_LITELLM_UPSTREAM_MODEL`
  - `LITELLM_MASTER_KEY` secret ref
  - provider-specific secret refs
- startup probe:
  - HTTP GET `/health/liveliness`
  - port `4000`
  - initial delay 10s, period 10s, timeout 3s, failure threshold 12
- liveness probe:
  - HTTP GET `/health/liveliness`
  - port `4000`
  - period 30s, timeout 3s, failure threshold 3
- readiness probe:
  - HTTP GET `/health/readiness`
  - port `4000`
  - period 10s, timeout 3s, failure threshold 3

Platform probes are unauthenticated health endpoints only. The LiteLLM master
key never appears in Terraform probe configuration. Relay `/readyz` remains the
authoritative authenticated `/v1/models` and metadata check.

Relay env when sidecar enabled:

- `PALANCAR_GENERATION_PROVIDER=litellm`
- `PALANCAR_LITELLM_BASE_URL=http://127.0.0.1:4000`
- `PALANCAR_LITELLM_MODEL=palancar-generation`
- `PALANCAR_LITELLM_API_KEY` secret ref from `litellm-master-key`
- `PALANCAR_LITELLM_EXPECTED_BACKEND`
- `PALANCAR_LITELLM_EXPECTED_UPSTREAM_MODEL`
- `PALANCAR_LITELLM_METADATA_URL=http://127.0.0.1:4001`

## Exact Terraform deployment design

Do not run broad `terraform apply` for this smoke; it would include blocked
Foundry deployment resources.

Use three reviewed saved plans:

1. Foundation/Key Vault target plan, if Key Vault/RBAC is not already applied:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev plan \
  -out=/tmp/palancar-kv.tfplan \
  -target=module.workload_key_vault \
  -target=module.identities_rbac.azurerm_role_assignment.runtime_key_vault_secrets_user
```

The JSON plan must show no
`azurerm_cognitive_deployment` resource changes and `0 destroy`.
Allowed addresses/actions:

- `module.workload_key_vault.*` create/update/read
- `module.identities_rbac.azurerm_role_assignment.runtime_key_vault_secrets_user`
  create/update/read

Reject the plan if any resource action contains `delete`, if any address
contains `azurerm_cognitive_deployment`, or if any address is outside the
allowlist.

Inspect command:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev show \
  -json /tmp/palancar-kv.tfplan > /tmp/palancar-kv.tfplan.json
jq -e '
  [ .resource_changes[]?
    | select(.change.actions != ["no-op"]) ] as $changes
  | all($changes[]; (.change.actions | index("delete") | not))
  and all($changes[]; (.address | contains("azurerm_cognitive_deployment") | not))
  and all($changes[];
    (.address | startswith("module.workload_key_vault."))
    or .address == "module.identities_rbac.azurerm_role_assignment.runtime_key_vault_secrets_user"
  )
' /tmp/palancar-kv.tfplan.json
```

Apply exactly the saved plan:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev apply \
  /tmp/palancar-kv.tfplan
```

2. Workload-only sidecar plan:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev plan \
  -out=/tmp/palancar-litellm-workload.tfplan \
  -target='module.container_app_workload[0]' \
  -var 'deploy_relay_workload=true' \
  -var 'relay_image_digest=<new relay digest>' \
  -var 'enable_litellm_sidecar=true' \
  -var 'litellm_image_digest=<new litellm proxy digest>' \
  -var 'litellm_backend=openrouter' \
  -var 'litellm_upstream_model=openrouter/openai/gpt-5.6-luna' \
  -var 'openrouter_api_key_secret_url=<kv secret url>' \
  -var 'litellm_master_key_secret_url=<kv secret url>' \
  -var 'azure_api_base=' \
  -var 'azure_api_version=' \
  -var 'azure_api_key_secret_url='
```

The JSON plan must show:

- no `azurerm_cognitive_deployment` changes
- no deletes
- only `module.container_app_workload[0]` and its contained
  `azapi_resource.this` update/read actions
- one Container App workload update

Inspect command:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev show \
  -json /tmp/palancar-litellm-workload.tfplan > /tmp/palancar-litellm-workload.tfplan.json
jq -e '
  [ .resource_changes[]?
    | select(.change.actions != ["no-op"]) ] as $changes
  | all($changes[]; (.change.actions | index("delete") | not))
  and all($changes[]; (.address | contains("azurerm_cognitive_deployment") | not))
  and ([ $changes[]
    | select(.address == "module.container_app_workload[0].azapi_resource.this")
    | select(.change.actions | index("update"))
  ] | length == 1)
  and all($changes[];
    .address == "module.container_app_workload[0].azapi_resource.this"
  )
' /tmp/palancar-litellm-workload.tfplan.json
```

Apply exactly the saved plan.

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev apply \
  /tmp/palancar-litellm-workload.tfplan
```

3. Workload-only restore plan, created after the paid apply:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev plan \
  -out=/tmp/palancar-litellm-restore.tfplan \
  -target='module.container_app_workload[0]' \
  -var 'deploy_relay_workload=true' \
  -var 'relay_image_digest=<captured non-paid relay digest>' \
  -var 'enable_litellm_sidecar=false' \
  -var 'litellm_image_digest=' \
  -var 'litellm_backend=openrouter' \
  -var 'litellm_upstream_model=openrouter/openai/gpt-5.6-luna' \
  -var 'openrouter_api_key_secret_url=' \
  -var 'litellm_master_key_secret_url=' \
  -var 'azure_api_base=' \
  -var 'azure_api_version=' \
  -var 'azure_api_key_secret_url='
```

The JSON restore plan must show:

- no `azurerm_cognitive_deployment` changes
- no resource action containing `delete`
- only `module.container_app_workload[0]` update/read actions
- the Container App template no longer contains the LiteLLM container, the
  OpenRouter secret reference, or `PALANCAR_GENERATION_PROVIDER=litellm`

Inspect command:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev show \
  -json /tmp/palancar-litellm-restore.tfplan > /tmp/palancar-litellm-restore.tfplan.json
jq -e '
  [ .resource_changes[]?
    | select(.change.actions != ["no-op"]) ] as $changes
  | all($changes[]; (.change.actions | index("delete") | not))
  and all($changes[]; (.address | contains("azurerm_cognitive_deployment") | not))
  and ([ $changes[]
    | select(.address == "module.container_app_workload[0].azapi_resource.this")
    | select(.change.actions | index("update"))
  ] | length == 1)
  and all($changes[];
    .address == "module.container_app_workload[0].azapi_resource.this"
  )
  and (
    [ $changes[]
      | select(.address == "module.container_app_workload[0].azapi_resource.this")
      | .change.after.body.properties.configuration.secrets
      | type == "array"
    ] | all
  )
  and (
    [ $changes[]
      | select(.address == "module.container_app_workload[0].azapi_resource.this")
      | .change.after.body.properties.template.containers
      | type == "array"
    ] | all
  )
  and (
    [ $changes[]
      | select(.address == "module.container_app_workload[0].azapi_resource.this")
      | .change.after.body.properties.template.containers[]?
      | select(.name == "relay")
      | .env
      | type == "array"
    ] | length == 1 and all
  )
  and (
    [ $changes[]
      | select(.address == "module.container_app_workload[0].azapi_resource.this")
      | .change.after.body.properties.configuration.secrets[]?.name
    ] as $secretNames
    | ($secretNames | index("openrouter-api-key") | not)
    and ($secretNames | index("litellm-master-key") | not)
    and ($secretNames | index("azure-api-key") | not)
  )
  and (
    [ $changes[]
      | select(.address == "module.container_app_workload[0].azapi_resource.this")
      | .change.after.body.properties.template.containers[]?.name
    ] == ["relay"]
  )
  and (
    [ $changes[]
      | select(.address == "module.container_app_workload[0].azapi_resource.this")
      | .change.after.body.properties.template.containers[]?
      | select(.name == "relay")
      | .env[]?
    ] as $relayEnv
    | ([ $relayEnv[] | select(.name == "PALANCAR_GENERATION_PROVIDER") ] | length == 1)
    and ([ $relayEnv[] | select(.name == "PALANCAR_GENERATION_PROVIDER" and .value == "mock") ] | length == 1)
    and ([ $relayEnv[] | select(.name | startswith("PALANCAR_LITELLM_")) ] | length == 0)
  )
' /tmp/palancar-litellm-restore.tfplan.json
```

Apply exactly the inspected saved restore plan.

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev apply \
  /tmp/palancar-litellm-restore.tfplan
```

Backend switching after the Azure ticket clears uses the same workload-only
saved-plan contract with unchanged relay/proxy image digests:

OpenRouter -> Azure:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev plan \
  -out=/tmp/palancar-litellm-azure-switch.tfplan \
  -target='module.container_app_workload[0]' \
  -var 'deploy_relay_workload=true' \
  -var 'relay_image_digest=<current relay digest>' \
  -var 'enable_litellm_sidecar=true' \
  -var 'litellm_image_digest=<current litellm proxy digest>' \
  -var 'litellm_backend=azure' \
  -var 'litellm_upstream_model=azure/<deployment-name>' \
  -var 'azure_api_base=<azure openai endpoint>' \
  -var 'azure_api_version=<api version>' \
  -var 'azure_api_key_secret_url=<kv secret url>' \
  -var 'openrouter_api_key_secret_url=' \
  -var 'litellm_master_key_secret_url=<kv secret url>'
```

Azure -> OpenRouter:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev plan \
  -out=/tmp/palancar-litellm-openrouter-switch.tfplan \
  -target='module.container_app_workload[0]' \
  -var 'deploy_relay_workload=true' \
  -var 'relay_image_digest=<current relay digest>' \
  -var 'enable_litellm_sidecar=true' \
  -var 'litellm_image_digest=<current litellm proxy digest>' \
  -var 'litellm_backend=openrouter' \
  -var 'litellm_upstream_model=openrouter/openai/gpt-5.6-luna' \
  -var 'openrouter_api_key_secret_url=<kv secret url>' \
  -var 'azure_api_base=' \
  -var 'azure_api_version=' \
  -var 'azure_api_key_secret_url=' \
  -var 'litellm_master_key_secret_url=<kv secret url>'
```

Switch-plan inspection uses the same workload-only `jq` gate as the paid plan,
with the plan filename changed.

Apply exactly one inspected saved switch plan, depending on the intended
direction. For OpenRouter -> Azure only:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev apply \
  /tmp/palancar-litellm-azure-switch.tfplan
```

For Azure -> OpenRouter only:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev apply \
  /tmp/palancar-litellm-openrouter-switch.tfplan
```

Both switch plans use the no-delete, no-Foundry, workload-only gates above.

## Smoke script

Add `apps/relay/scripts/smoke-litellm-generation.mjs`:

1. `GET /readyz`; require `generation.provider == "litellm"`,
   `generation.model == "palancar-generation"`, and `upstreamReady == true`.
2. Issue session ticket.
3. Connect WSS.
4. Send `session.start`.
5. Send `utterance.start`.
6. Send 18 deterministic PCM frames.
7. Send `utterance.commit`.
8. Wait for `translation.ready`.
9. Wait for `suggestions.ready` with exactly 2–3 suggestions.
10. Emit only content-free success/failure and provider identity.

No deployed test endpoint is allowed.

The paid wrapper, not this smoke script, owns temporary OpenRouter key creation,
Key Vault secret installation, Terraform deploy/restore, OpenRouter key
deletion, and `401` deletion verification.

## Local and full validation

Local:

```sh
npm run lint
npm run typecheck
npm run test
npm run build
```

LiteLLM container:

```sh
set -euo pipefail
docker build -f apps/litellm-proxy/Dockerfile -t palancar-litellm-proxy:local .
container_id="$(docker run -d -p 4000:4000 \
  -e PALANCAR_LITELLM_BACKEND=openrouter \
  -e PALANCAR_LITELLM_UPSTREAM_MODEL=openrouter/openai/gpt-5.6-luna \
  -e OPENROUTER_API_KEY=dummy-local-key \
  -e LITELLM_MASTER_KEY=dummy-master-key \
  palancar-litellm-proxy:local)"
trap 'docker rm -f "$container_id" >/dev/null 2>&1 || true' EXIT
ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:4000/health/readiness >/tmp/palancar-litellm-ready.json; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "LiteLLM readiness did not pass before timeout" >&2
  exit 1
fi
unauth_status="$(curl -sS -o /tmp/palancar-unauth-models.json -w '%{http_code}' \
  http://127.0.0.1:4000/v1/models || true)"
if [ "$unauth_status" != "401" ]; then
  echo "unauthenticated /v1/models returned $unauth_status, expected 401" >&2
  exit 1
fi
curl -fsS -H 'Authorization: Bearer dummy-master-key' \
  http://127.0.0.1:4000/v1/models > /tmp/palancar-auth-models.json
jq -e '.data | type == "array" and ([.[] | select(.id == "palancar-generation")] | length == 1)' \
  /tmp/palancar-auth-models.json
if docker logs "$container_id" 2>&1 | grep -Ei 'database|postgres|prisma|migration.*fail'; then
  echo "unexpected database-related LiteLLM log output" >&2
  exit 1
fi
```

No real OpenRouter call is required for local image validation.

## Sol review gates

- Review architecture before Luna implementation.
- Review code/infra diff before real deployment.
- Review any fixer output until status is `READY`.

## Luna implementation task boundaries

Use Luna only after Sol accepts the architecture and the orchestrator has
assigned a bounded write set.

Candidate slices:

1. `packages/generation` LiteLLM provider + unit tests.
2. `apps/relay` host env parsing/readiness + tests.
3. `apps/litellm-proxy` Docker/config/entrypoint.
4. Key Vault/RBAC Terraform.
5. Container App sidecar Terraform.
6. Smoke/deployment scripts.

Each Luna worker owns one slice only. Sol owns review only.

## Completion criteria

- Sol architecture review is `READY`.
- Luna implementation slices complete with local tests.
- Sol diff review is `READY`.
- Full workspace validation passes.
- Relay image and LiteLLM proxy image are built and pushed.
- Key Vault secrets are set outside Terraform after the user provides the
  OpenRouter key.
- Saved Terraform plans deploy the sidecar-backed relay to Azure with no
  Foundry deployment changes and no destroys.
- Deployed relay health/readiness pass.
- Real OpenRouter-backed model call through Azure relay succeeds.
- Every recorded paid revision has zero traffic, the OpenRouter smoke key
  returns exactly `401` after deletion, and both recorded versioned Key Vault
  secrets are disabled after smoke.
- Repo is clean with commits for code/infra/docs/evidence.
