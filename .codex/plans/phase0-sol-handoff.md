# Phase 0 architecture decision handoff (GPT-5.6 Sol)

## Role and output

Act as the architecture and security reviewer for Palancar. This is a read-only task: do not edit files, run Azure mutations, or commit. Read the two planning documents and the relevant repository guidance, then return a concrete decision memo that the parent agent can convert into ADRs and implementation handoffs.

End with exactly one of:

- `READY` if the proposed decisions below are internally coherent, secure enough for a deployed development system carrying real conversation audio, and implementable in the planned TypeScript/Azure architecture.
- `NEEDS WORK` followed by Must-Fix findings and corrected decisions.

## Required reading

- `AGENTS.md`
- `.agents/skills/g2-sdk-bridge/SKILL.md`
- `.agents/skills/g2-display-ui/SKILL.md`
- `.agents/skills/g2-events-input/SKILL.md`
- `.agents/skills/g2-dev-toolchain/SKILL.md`
- `.agents/skills/g2-simulator-automation/SKILL.md`
- `docs/implementation-plan.md`
- `docs/real-time-translation-plan.md`

## Fixed context

- Azure subscription is a Visual Studio Enterprise Subscription.
- East US 2 has confirmed quota for `gpt-4o-mini-transcribe-2025-12-15` and `gpt-5.6-luna-2026-07-09`.
- Client is an Even App WebView and cannot attach an arbitrary Authorization header to a browser WebSocket.
- No reusable Azure/model/backend secret may ship in source, `app.json`, the client bundle, URLs, or logs.
- Raw audio must not be persisted.
- First release: English wearer; selected target is Spanish (`es`) or Turkish (`tr`); mixed turns are rejected.
- Development compute candidate is one warm Azure Container Apps replica, but promotion depends on a compute ADR and measured WebSocket behavior.
- Terraform owns Azure infrastructure.

## Decisions to challenge and finalize

1. **Development user enrollment and authentication.** Use an operator-created, high-entropy, one-time pairing code with a short expiry. The WebView exchanges it over HTTPS for a revocable per-installation credential. Store only a hash of that credential server-side. The installation credential authenticates `POST /v1/session-tickets`; no static shared app secret exists. Specify browser storage choice, CSRF/origin controls, code issuance/consumption, revocation, rotation, and realistic production migration.
2. **WebSocket ticket transport.** Prefer a single-use opaque ticket in `Sec-WebSocket-Protocol` over a query string if the Even WebView/runtime accepts a protocol value and Azure Container Apps forwards it unchanged. Otherwise use a same-origin Secure/HttpOnly/SameSite cookie. Treat query-string tickets as prohibited unless an evidence test proves redaction at every logging layer. Specify atomic consumption, audience binding, lifetime, replay behavior, and reconnect/resume behavior.
3. **Minimal state store.** Select the least-complex Azure-backed store that can safely support pairing-code consumption, credential revocation, atomic ticket consumption, and rate-limit state on one warm replica without making correctness depend on process memory. Compare Azure Table Storage, Cosmos DB, Redis, or another justified choice; include Terraform implications and local-test substitute.
4. **Retention.** Raw audio: never persisted. Full transcripts/translations/suggestions: never persisted by the service in v1. Redacted operational telemetry: 30 days. Security/audit events containing identifiers but no conversation content: 30 days. Client retains only current UI/session state and last selected target; clear conversation content on session end/cold restart. Specify provider-side retention/abuse-monitoring caveats that require validation.
5. **Product limits.** Candidate values: 30-second utterance maximum, 30-minute session maximum, 5-minute inactivity timeout, one active utterance/session, one active session/installation, ticket lifetime 60 seconds, pairing code lifetime 10 minutes, credential idle expiry 30 days. Decide exact values and whether any are unsafe or impractical.
6. **Interaction semantics.** Explicit target selection before first listening; persist last selected target and always display it. Single press starts listening; second single press commits; server VAD is the only automatic segment owner when enabled; root double press invokes system exit. Decide response navigation/next-turn behavior without specializing Spanish over Turkish.
7. **Protocol v1 numeric limits.** Challenge/finalize 3,200 PCM bytes/frame, 16 KiB/control message, 8,000 unacknowledged 16 kHz samples (500 ms), ACK at least every 100 ms or on flow state change, reconnect replay only within retained 500 ms audio, and explicit abort otherwise. Include integer widths and close/error categories.
8. **Rate limits and abuse controls.** Give implementable per-installation/session limits for ticket issuance, concurrent sessions, audio ingress, utterance count/duration, generation calls, malformed messages, and reconnect attempts. Define deterministic rejection/close behavior.
9. **Compute decision gate.** Define a decisive local/Azure test matrix for Container Apps WebSocket forwarding, `Sec-WebSocket-Protocol`, idle behavior, graceful shutdown, deploy/revision behavior, latency, and query/header log redaction. State what result forces App Service or another host.
10. **Terraform sequencing.** Ensure remote-state bootstrap, identities, ACR/image, Container App revision, model deployments, RBAC, state store, observability, retention, budget, and evidence outputs have an acyclic and repeatable ownership/order plan.

## Requested output format

1. Final decision table with exact values and rationale.
2. Authentication and ticket sequence, including failure/replay paths.
3. State-store recommendation and data model.
4. Protocol/abuse limits table.
5. Terraform/deployment dependency order.
6. Acceptance tests required before any real conversation audio.
7. Must-Fix / Should-Fix / Nits.
8. Final `READY` or `NEEDS WORK` verdict.
