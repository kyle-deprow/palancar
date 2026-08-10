# ADR 0005: Provisional Azure Container Apps host

Status: Provisional; reviewed synthetic evidence gate required before promotion

Date: 2026-08-09

## Context

The relay needs warm, long-lived browser WebSockets, predictable ingress header
behavior, managed identities, graceful revision rollout, and low latency. Azure
Container Apps supports WebSockets, but documented HTTP ingress timeouts and
platform behavior do not by themselves prove a 30-minute audio session is safe.

## Decision

Deploy the first development relay candidate to Azure Container Apps in East US
2 with one warm replica, one maximum replica, and single revision mode. The
candidate is synthetic-only until it passes this ADR. An immutable image digest
is used so the same artifact can be tested on App Service or another host if the
candidate fails.

The Container App has separate pre-created user-assigned identities:

- Image-pull identity, with only `AcrPull`, lifecycle `None`, and unavailable to
  workload token requests.
- Runtime identity, lifecycle `Main`, explicitly selected by client ID, with only
  Storage Table Data Contributor on the dedicated workload-state account and
  approved model-inference permissions.

Readiness fails before drain and whenever mandatory state/model dependencies are
unavailable. Active provider/resampler state stays in one process; replica loss
must visibly abort the current turn rather than imply seamless recovery.

## Promotion matrix

| Test | Passing result |
|---|---|
| Subprotocol | Actual Even WebView sends both protocol values through Azure byte-for-byte; relay returns only `palancar.v1` |
| Origin | Actual WebView origin behavior is recorded and accepted only under ADR 0003 |
| Active protocol-v1 duration | 25 authenticated v1 sessions run synthetic PCM and repeated turns until expected termination at 30 minutes; no new turn is accepted at or after 29:30, and there is no unexplained closure or audio gap |
| Inactive protocol-v1 duration | A heartbeat-only v1 session closes at five minutes with `4408`; ping/pong never counts as user activity |
| Synthetic transport longevity | A separate non-protocol WebSocket transport probe sustains 25 active and idle sockets for 35 minutes; it is explicitly not a protocol-v1 session and is exempt from product inactivity and session-duration enforcement |
| Warm latency | At least 200 runs: client-to-relay p95 at most 100 milliseconds and relay processing p95 at most 40 milliseconds at 25 sockets |
| Graceful drain | No new sessions after readiness fails; every active turn commits or aborts explicitly |
| Revision deployment | Old revision remains usable until new readiness; disconnected clients return visibly to Ready/new-session within 15 seconds |
| Replica loss | Active turn aborts visibly and a new session epoch can be claimed without waiting on stale process state |
| Log redaction | Canary subprotocol ticket and conversation content are absent in every deployed mode/log level from ingress, app logs, traces, exceptions, diagnostics/evidence sinks, crash reports, Application Insights, and Log Analytics |
| State and identity | `SecurityState`/`RateState` point reads, ETag transactions, expiry cleanup, and outage behavior pass; runtime identity reaches only workload Table/model scopes, Table RBAC exists before readiness, and workload cannot obtain the ACR-pull identity |
| Trusted source | The host adapter derives source scope only from the tested platform peer/forwarded topology and ignores arbitrary client-supplied `X-Forwarded-For` values |
| Cost | Budget and alerts exist before model deployments and the warm workload; one warm replica, cleanup job, workload Tables, and observability fit the accepted development budget |

The candidate fails if ticket transport is unreliable, either protocol-v1
duration behavior is wrong, the separate 35-minute transport probe closes
unexpectedly, secret-bearing headers persist in logs, deployment creates silent
audio loss, warm latency exceeds the budget, state/identity/source isolation
fails, or one replica cannot sustain the target load. A failure triggers the
same matrix against App Service or another documented candidate using the same
digest, including revalidation of the trusted-source adapter.

## Terraform ownership and sequence

AzureRM owns a resource only when the pinned provider exposes every required
property. Otherwise AzAPI owns the entire resource; providers never split
ownership of one resource or patch each other's resource. This is especially
important for Container App identity lifecycle and Log Analytics immediate
30-day purge configuration.

| Resource | Terraform owner |
|---|---|
| Terraform-state Storage | AzureRM in the separate bootstrap stack |
| Budget, spending/anomaly alerts, and observability | AzureRM in the foundation apply |
| Workload-state Storage account, `SecurityState`, and `RateState` | AzureRM in the dedicated workload-state module |
| ACR, image-pull/runtime identities, and ACR/Table RBAC | AzureRM in the foundation apply |
| Container Apps environment | AzureRM in the foundation apply |
| Daily expiry-cleanup Container Apps Job | AzureRM when complete; otherwise whole-resource AzAPI ownership |
| Foundry account and model deployments | AzureRM, with whole-resource AzAPI only for a documented provider gap |
| Relay Container App | AzureRM when complete; otherwise whole-resource AzAPI ownership |

The foundation apply is dependency ordered. It first creates the resource group,
budget, spending/anomaly alerts, observability, and a dedicated workload-state
Storage account/module with shared-key access disabled and `SecurityState` and
`RateState` Tables; this account is separate from Terraform state storage. It
then creates ACR, the image-pull and runtime identities, `AcrPull`, runtime
Storage Table Data Contributor, the Container Apps environment, the managed
daily expiry-cleanup Container Apps Job, and only then the Foundry account/model
deployments. Image build and push happens outside Terraform. The workload apply
consumes the immutable relay digest only after budget/alerts, both Tables, Table
RBAC, cleanup, observability, model access, and all other dependencies are ready.
Readiness fails if the runtime cannot point-read and conditionally update both
Tables.
Promotion evidence records image digest, revisions, identity tests, latency,
socket outcomes, and redacted logs without exporting state or credentials.

## Consequences

Container Apps is not the selected production host merely because provisioning
succeeds. The app remains single-replica in development; cross-replica session
migration is deferred. The measured matrix, not preference, selects or rejects
the host.
