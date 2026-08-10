# Palancar deployment status — 2026-08-10

## Status

The unblocked implementation slice is complete and deployed for development:

- Shared protocol, language registry, audio, transcription interface,
  generation, telemetry, relay, G2 interaction state machine, G2 relay
  transport, and bridge-to-transport integration are implemented and reviewed.
- The Azure relay Container App is deployed and healthy.
- The G2 package is built against the Azure relay origin.
- Real Azure Foundry transcription/generation remains blocked by Azure service
  error `715-123420` during model deployment; this blocks Phase 3 realtime
  transcription selection and any true model-backed translation/suggestion
  path.

## Deployed Azure relay

- Resource group: `rg-palancar-dev-aeeacd8c`
- Container App: `ca-palancar-dev-relay-aeeacd8c`
- Latest ready revision: `ca-palancar-dev-relay-aeeacd8c--9wjvqrf`
- Provisioning state: `Succeeded`
- Running status: `Running`
- HTTPS origin:
  `https://ca-palancar-dev-relay-aeeacd8c.graysmoke-757a2980.eastus2.azurecontainerapps.io`
- WebSocket origin:
  `wss://ca-palancar-dev-relay-aeeacd8c.graysmoke-757a2980.eastus2.azurecontainerapps.io`
- Deployed image digest:
  `palancardevacraeeacd8c.azurecr.io/palancar-relay@sha256:d25d549019eb80a69b12db948a767dfaea8898ac85bb50cac2c857d59abb6479`

Health checks on 2026-08-10:

```text
GET /healthz -> {"ok":true}
GET /readyz  -> {"ready":true}
```

## G2 package

- Package ID: `com.palancar.translate`
- Version: `0.1.0`
- Entry point: `index.html`
- SDK: `@evenrealities/even_hub_sdk` `0.0.12`
- Network whitelist:
  `https://ca-palancar-dev-relay-aeeacd8c.graysmoke-757a2980.eastus2.azurecontainerapps.io`
- Built package: `apps/g2-client/palancar.ehpk`
- Package size: `62663` bytes

The `.ehpk` artifact is intentionally ignored by Git. The current package scan
found no matches for common secret/local-development markers such as Azure
secrets, private keys, connection strings, `.env`, `localhost`, or
`127.0.0.1`.

## Reviewed commits in this implementation slice

- `0155fc1` — reviewed relay core
- `538d294` — reviewed relay host
- `882b8e7` — reviewed relay container packaging
- `6668b0d` — reviewed relay Azure workload
- `b685670` — relay Container App identity-propagation retry fix
- `caa7eb9` — G2 package pointed at Azure relay
- `2d0b5fa` — reviewed G2 relay transport
- `9d788c6` — reviewed G2 bridge-to-relay-transport integration

## Validation

The final implementation pass completed:

```text
npm run lint
npm run typecheck
npm run test
npm run build
npm run pack -w @palancar/g2-client
```

All workspace tests passed in the final run:

- `@palancar/g2-client`: 125 tests
- `@palancar/relay`: 40 tests
- `@palancar/audio`: 25 tests
- `@palancar/contracts`: 10 tests
- `@palancar/generation`: 37 tests
- `@palancar/language-registry`: 12 tests
- `@palancar/telemetry`: 28 tests
- `@palancar/test-fixtures`: 26 tests
- `@palancar/transcription`: 45 tests

## Remaining blocker

The full product is not complete until Azure permits the required Foundry model
deployments. Terraform still expects only the two model deployments after the
foundation apply:

- `gpt-4o-mini-transcribe`, model version `2025-12-15`,
  `GlobalStandard` capacity `1`
- `gpt-5.6-luna`, model version `2026-07-09`,
  `GlobalStandard` capacity `1`

Azure rejected both with HTTP 400 service code `715-123420`. This is currently
treated as a service-side account/subscription deployment block pending Azure
Support confirmation. Do not repeatedly retry deployment or recreate resources
without Support direction.

Until this block is removed, the deployed relay can run health checks and
synthetic/mock protocol flows, but it cannot perform real model-backed
transcription, English translation, or response suggestion generation.

## Region retry evidence

At the user's request, a different-region retry was attempted on 2026-08-10 UTC
using a temporary OpenAI account in `westus3`:

- Temporary account:
  `palancarprobeopenaiwus3`
- Resource group:
  `rg-palancar-dev-aeeacd8c`
- Region:
  `westus3`
- Account provisioning:
  `Succeeded`
- Model availability check:
  `gpt-5.6-luna` version `2026-07-09` was listed; `gpt-4o-mini-transcribe`
  version `2025-12-15` was not listed for this temporary account.
- Deployment attempted:
  `gpt-5-6-luna` using model `gpt-5.6-luna`, version `2026-07-09`,
  `GlobalStandard` capacity `1`
- Result:
  Azure returned the same HTTP 400 service code `715-123420`.

This confirms the observed blocker is not specific to the original `eastus2`
resource. It follows the deployment request in at least one alternate region
where the target model is available.

The temporary `westus3` probe account was deleted after the failed deployment
attempt to avoid leaving unmanaged resources in the Terraform-managed
development resource group. The account may still appear in Azure's soft-delete
retention surface, but it is no longer listed as an active account in the
resource group.
