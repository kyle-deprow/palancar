# Luna handoff — LiteLLM Container App Terraform wiring

## Objective

Extend the existing dev Container App workload Terraform so the relay can run
with an optional LiteLLM sidecar. This slice wires image digests, backend
selection, secret references, probes, and relay environment variables. It must
not create or set secret values.

## Files you may change

- `infra/modules/container-app-workload/main.tf`
- `infra/modules/container-app-workload/variables.tf`
- `infra/modules/container-app-workload/README.md`
- `infra/environments/dev/main.tf`
- `infra/environments/dev/variables.tf`
- `infra/environments/dev/terraform.tfvars.example`
- `infra/environments/dev/outputs.tf` only if a non-secret output is useful.

## Files you must not change

- `apps/**`
- `packages/**`
- `docs/**`
- `package*.json`
- Terraform state files, `.terraform/**`, generated plans, or commits.

## Required design

Add optional sidecar variables at the module and dev environment levels:

- `enable_litellm_sidecar`, default `false`
- `litellm_image_digest`, default `""`
- `litellm_backend`, enum `openrouter|azure`, default `openrouter`
- `litellm_upstream_model`, default `""`
- `openrouter_api_key_secret_url`, default `""`
- `litellm_master_key_secret_url`, default `""`
- `azure_api_base`, default `""`
- `azure_api_version`, default `""`
- `azure_api_key_secret_url`, default `""`
- `litellm_cpu`, default `0.25`
- `litellm_memory`, default `"0.5Gi"`

Keep existing relay workload behavior when `enable_litellm_sidecar=false`.
In that mode:

- no LiteLLM container;
- no Container App secrets for OpenRouter/Azure/LiteLLM;
- relay env must set `PALANCAR_GENERATION_PROVIDER=mock`;
- relay env must not include any `PALANCAR_LITELLM_*` variables.

When `enable_litellm_sidecar=true`:

- add Container App secret `litellm-master-key` from
  `litellm_master_key_secret_url`;
- in OpenRouter mode, add secret `openrouter-api-key` from
  `openrouter_api_key_secret_url`;
- in Azure mode, add secret `azure-api-key` from `azure_api_key_secret_url`;
- all secrets use Key Vault URL references and the runtime identity ARM ID;
- never expose secret values in Terraform variables, outputs, probes, or logs;
- add sidecar container named exactly `litellm`;
- sidecar image is `litellm_image_digest`;
- sidecar env:
  - `PALANCAR_LITELLM_BACKEND`
  - `PALANCAR_LITELLM_UPSTREAM_MODEL`
  - `LITELLM_MASTER_KEY` from secret ref `litellm-master-key`
  - OpenRouter: `OPENROUTER_API_KEY` from secret ref `openrouter-api-key`
  - Azure: `AZURE_API_BASE`, `AZURE_API_VERSION`, `AZURE_API_KEY` from secret
    ref `azure-api-key`
- sidecar probes:
  - startup HTTP GET `/health/liveliness` port `4000`, initial delay 10s,
    period 10s, timeout 3s, failure threshold 10
  - liveness HTTP GET `/health/liveliness` port `4000`, period 30s, timeout
    3s, failure threshold 3
  - readiness HTTP GET `/health/readiness` port `4000`, period 10s, timeout
    3s, failure threshold 3
- relay env additionally includes:
  - `PALANCAR_GENERATION_PROVIDER=litellm`
  - `PALANCAR_LITELLM_BASE_URL=http://127.0.0.1:4000`
  - `PALANCAR_LITELLM_MODEL=palancar-generation`
  - `PALANCAR_LITELLM_API_KEY` from secret ref `litellm-master-key`
  - `PALANCAR_LITELLM_EXPECTED_BACKEND=litellm_backend`
  - `PALANCAR_LITELLM_EXPECTED_UPSTREAM_MODEL=litellm_upstream_model`
  - `PALANCAR_LITELLM_METADATA_URL=http://127.0.0.1:4001`

## Preconditions / validation

Implement Terraform validations and/or lifecycle preconditions so:

- sidecar enabled requires nonempty immutable `litellm_image_digest`;
- sidecar enabled requires nonempty `litellm_master_key_secret_url`;
- sidecar enabled requires nonempty `litellm_upstream_model`;
- OpenRouter mode requires `litellm_upstream_model` starting `openrouter/`,
  requires `openrouter_api_key_secret_url`, and rejects all Azure API fields;
- Azure mode requires `litellm_upstream_model` starting `azure/`, requires
  `azure_api_base`, `azure_api_version`, `azure_api_key_secret_url`, and
  rejects `openrouter_api_key_secret_url`;
- sidecar disabled rejects all generation secret URLs and `litellm_image_digest`;
- Key Vault secret URL variables must be empty or HTTPS URLs.

Do not add Key Vault creation in this slice unless the current Terraform already
has an in-scope module for it. If Key Vault is absent, keep variables as secret
URL inputs and document that secret version creation remains a deployment step.

## Verification

Run and report exact commands/results:

```sh
/tmp/palancar-terraform-1.15.8/terraform fmt -check \
  infra/modules/container-app-workload \
  infra/environments/dev

/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev validate
```

If validate needs init, run:

```sh
/tmp/palancar-terraform-1.15.8/terraform -chdir=infra/environments/dev init
```

Do not run `terraform apply`. Do not create Azure resources.

## Completion report

Report changed files, verification output, and unresolved issues. End with
`DONE` only if complete.
