# Remaining implementation plan

Status: Active
Last updated: 2026-08-19

This document supplements `implementation-plan.md`; it does not replace the
accepted ADRs or relax their release gates. It records the remaining bounded
work, ownership fences, integration order, and verification needed to finish
the development deployment without building intermediate container images.

## Current isolated lanes

The following lanes have disjoint ownership and may run in parallel:

- Generated-language validation: `packages/generation/**`. Every production
  generation completion must pass an injected, calibrated validator for the
  English translation and every English/selected-target suggestion field.
- Telemetry export: the approved OTLP/HTTP JSON state machine files in
  `packages/telemetry/**`. The package remains transport-free; the relay owns
  managed-identity HTTP delivery and normalized settlement.
- Realtime evidence tool: `tools/realtime-spike/**`.
- Deterministic protocol replay: `tools/protocol-replay/**`.
- Observability resources: `infra/modules/observability/**`.

Each implementation receives an independent GPT-5.6 Sol review. Must-fix and
should-fix findings are returned to the original GPT-5.6 Luna xhigh owner, then
the affected lane is re-reviewed before integration.

## Expiry cleanup

Application owner: `tools/expiry-cleanup/**` only.

- Create a dedicated one-shot Node 22 workspace and immutable container image.
- Construct the existing Azure Table runtime store with
  `ManagedIdentityCredential({ clientId })` and call `cleanupExpired({ limit })`
  exactly once.
- Require the eight reviewed environment variables, validate them canonically,
  reject unknown `PALANCAR_EXPIRY_CLEANUP_*` variables, and expose no secret or
  provider detail in output.
- Enforce a 240-second process watchdog with an outer 300-second Azure replica
  timeout. Success and failure each have one exact, content-free output line.
- Do not modify the root lockfile; the orchestrator updates it once after all
  new workspaces exist.

Terraform owner: `infra/modules/expiry-cleanup-job/**` plus explicitly assigned
development environment propagation and plan-guard files.

- Use one `Microsoft.App/jobs@2026-01-01` AzAPI resource scheduled daily at
  03:00 UTC, with one replica, no retries, 0.25 CPU, 0.5 GiB, and no secrets.
- Use separate user-assigned image-pull and runtime identities. Runtime access
  is managed identity plus Azure Table data-plane RBAC only.
- Require a dedicated immutable ACR digest and extend deployment guards to
  reject deletion, replacement, mutable images, identity/secret drift, or
  relaxed scheduling/concurrency controls.

## Production relay integration

This is a serialized, Sol-designed cross-cutting lane after package interfaces
are stable. Its write set is `apps/relay/**`, the relay package metadata, and
the minimum required application-host configuration files.

- Compose `AzureRealtimeTranscriptionAdapter` for both `es` and `tr` using the
  relay runtime managed identity and canonical deployment configuration.
- Keep deterministic transcription and fixture-only language validation
  available only in the loopback local-mock composition.
- Fail closed when production transcription, calibrated target-language
  classification, or generated-language validation is absent or unready.
- Forward partial transcripts only after the ADR 0002 calibration profile is
  approved; a final target decision alone may invoke generation.
- Compose the existing LiteLLM/OpenRouter provider and mandatory generated-text
  validator without retaining prompts, transcripts, translations, or provider
  bodies in telemetry.
- Drive the transport-free telemetry exporter through a bounded host adapter
  using managed identity for Azure Monitor ingestion. Shutdown drains for at
  most the reviewed five-second window.

## Infrastructure integration

After relay and cleanup interfaces settle:

- Propagate immutable relay, LiteLLM proxy, and cleanup image digests through
  `infra/environments/dev`.
- Add the exact transcription, classifier/validator, and telemetry environment
  contracts without adding secrets to Terraform state.
- Wire observability and expiry-cleanup modules and extend the native plan
  guard/tests for every new resource and environment invariant.
- Keep OpenRouter as the current generation backend. Azure generation remains
  swappable but is not a deployment prerequisite.

## Serialized integration and verification

1. Complete and review every isolated lane.
2. Run `npm install --package-lock-only --ignore-scripts` once and inspect the
   lockfile diff for workspace linkage only.
3. Run every workspace test, typecheck, lint, and build from a clean install.
4. Run Terraform format, validation, native module tests, and development plan
   guards with Terraform 1.15.8.
5. Commit each reviewed cohesive slice; do not mix unrelated working-tree
   changes.
6. Build each image once from the final commit, push immutable digests, and
   apply the reviewed Azure development plan.
7. Run health/readiness, authenticated HTTPS ticket, authenticated WSS,
   Spanish/Turkish mocked-flow, OpenRouter generation, cleanup-job, and
   telemetry/alert smoke checks. Remove any temporary pairing/test state.
8. Run a final independent GPT-5.6 Sol adversarial readiness review and fix all
   release-critical findings.

## External release gates

The Azure model quota/support ticket, physical G2 evidence, and ADR 0002/0005
confirmation remain external evidence gates. Their absence must not weaken the
code paths or prevent deployment of mock-safe reviewed functionality, but the
application is not production-promoted until both languages pass the approved
latency, language-gate, and compute-host matrices.
