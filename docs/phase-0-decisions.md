# Palancar Phase 0 decisions

Status: Accepted for implementation

Date: 2026-08-09

Review status: GPT-5.6 Sol `READY` after adversarial fix/re-review loop

## Cloud baseline

- Subscription: Visual Studio Enterprise Subscription
  (`a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1`).
- Tenant: `c69da7c1-f194-493b-9697-5b4bc8b56f37`.
- Region: East US 2.
- Environment and naming prefix: `palancar-dev` / `palancar` with deterministic
  globally unique suffixes where Azure requires them.
- Confirmed available candidate deployments:
  `gpt-4o-mini-transcribe-2025-12-15` and `gpt-5.6-luna-2026-07-09`.
- Infrastructure: Terraform with AzureRM ownership preferred and whole-resource
  AzAPI ownership only for provider gaps.
- Compute: one-warm-replica Container Apps candidate under ADR 0005.
- Durable runtime security state: a dedicated workload-state Terraform module
  creates a workload Azure Storage account with shared-key access disabled,
  `SecurityState` and `RateState` Tables, runtime Storage Table Data Contributor,
  and a managed daily expiry-cleanup Container Apps Job. Table RBAC precedes
  workload readiness. This account is separate from Terraform state storage.
- Budget alerts are mandatory before model or warm-compute deployment. The exact
  dollar thresholds are environment variables and are recorded in each reviewed
  plan because Visual Studio credit balances can change.

Model quota and provider registration were verified read-only before this
decision. CI federation and custom DNS remain optional until a repository/zone
is selected; local Azure CLI identity is the development apply identity.

## Product behavior

- Wearer language is English. `TargetSelection` sits between Starting and Ready.
  The last Spanish/Turkish choice is restored only as the highlighted option;
  wording is “press to confirm, swipe to change.” Confirmation occurs before
  session start or microphone access and is never inferred from restoration.
  The selected target remains visible in Ready and Listening.
- A single press in Ready starts listening. A single press in Listening commits.
  When enabled, server VAD is the only automatic segment owner. Backend periodic
  commits and server VAD never run concurrently.
- In Results, swipe cycles the two or three suggestions and press starts the next
  listening turn. Root double press invokes Even's system exit confirmation.
- Spanish and Turkish use the same state machine, UI structure, protocol, gate,
  and conformance policy. Only registry data, language evidence, and rendered
  strings differ.
- `mixed`, `english`, `unsupported`, `uncertain`, and `supported_unselected` turns
  produce no translation or suggestion request. Probable target partials may be
  displayed; only an accepted final target revision can cross generation.
  The client sends `gatePolicyVersion`; the server owns v1 mixed policy `reject`.

## Session and usage limits

| Boundary | Value |
|---|---:|
| Utterance | 30 seconds / 480,000 input samples |
| Session | 30 minutes |
| No new turn | At or after 29 minutes 30 seconds |
| User inactivity | 5 minutes |
| Active utterances | 1 per session |
| Active sessions | 1 per installation |
| Ticket lifetime | 60 seconds, single-use |
| Pairing-code lifetime | 10 minutes, single-use |
| Credential idle/absolute expiry | 30 / 90 days |
| Utterance starts | 12 per minute; 120 per session |
| Accepted generated turns | 6 per minute; 60 per session |
| Logical model attempts | 12 per minute; 120 per session including retries |
| Control messages | 20 per second with burst 40 |
| Original audio rate | Token bucket per installation/session: refill 16,000 samples/second; capacity 8,000 |

The audio, acknowledgement, reconnect, and close-code limits are authoritative
in ADR 0001. Enrollment, ticket, and unauthenticated limits are authoritative in
ADR 0003.

## Retention and privacy

Palancar stores no raw audio or conversation content in any deployed mode, log
level, trace, exception, diagnostic/evidence sink, or crash report. The relay
and client keep only current-session content in memory. The client persists only
installation authentication metadata and the last target choice. Redacted
operational and security telemetry is retained exactly 30 days. Synthetic
non-conversation fixtures are explicitly separate. Azure provider abuse
monitoring is a separate boundary that must be accepted and evidenced before
real content, as defined in ADR 0004.

## Phase 0 completion and deferrals

Phase 0 is complete for the development foundation: operator pairing is the
selected development enrollment flow; the local Azure CLI identity is the apply
identity; Azure-provided ingress is the initial endpoint; subscription, region,
provider, quota, and candidate-model preflight passed; product interaction and
duration limits are frozen; and zero application-content retention is decided.

Production CIAM, CI workload-identity federation, custom DNS, and private
networking are explicitly deferred. They do not block Terraform foundation or
authenticated synthetic client/relay implementation.

## Phase 4 pre-real-audio entry gates

The following must pass before real conversation audio:

1. Physical Even WebView origin, IndexedDB, CORS, lifecycle, subprotocol, and
   packaging evidence.
2. Concurrent one-time pairing and ticket consumption race tests against Azure
   Tables, including restart/outage and fake-clock expiry tests.
3. Canary secret/content scans across source, bundle, `.ehpk`, image, browser
   history, ingress, application telemetry, and exceptions.
4. ADR 0005 active-v1 30-minute termination, heartbeat-only v1 five-minute
   `4408`, separate exempt 35-minute transport longevity, latency, rollout,
   restart, state/identity/source, and redaction matrix.
5. Dated provider data-handling evidence for exact transcription and Luna
   deployments with all optional content/body logging disabled.
6. Protocol golden/fuzz tests, queue/backpressure/replay tests, and stale-event
   protection.

Physical speech collection and the statistically sized transcription comparison
remain Phase 3. The mini-transcribe model is still a candidate until ADR 0002
selects it or Azure Speech from measured Spanish and Turkish evidence.

Physical origin, subprotocol forwarding, and IndexedDB evidence are Phase 4
entry evidence. Their absence does not block the Terraform foundation or
authenticated synthetic implementation, which must remain synthetic-only until
these gates pass.
