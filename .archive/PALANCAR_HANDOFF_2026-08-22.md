# Palancar project handoff

Date: 2026-08-22 (America/Chicago)

Handoff status: implementation intentionally stopped at the user's request.

Repository: `/home/dev/repos/palancar_ws/palancar`

Branch: `main`

Implementation baseline: `47aa5b39ea73a0d789fe3da7b065745193ed24d6`.
The handoff itself is committed immediately after that baseline.

This document is a durable operational handoff, not a new architecture decision.
Accepted ADRs, current source code, current Terraform, and verified live Azure
state take precedence if they conflict with an older planning document.

## Executive summary

Palancar is an Even Realities G2 application for an English-speaking wearer to
understand and respond to a selected target language in near real time. The
first supported targets are Spanish and Turkish, implemented through a shared
language registry rather than language-specific branches.

The product and most of its backend are implemented. The G2 client, streaming
audio protocol, authenticated relay, Azure Realtime transcription adapter,
strict selected-language gate, Azure Luna generation, response suggestions,
durable security state, telemetry, and Terraform infrastructure all exist.

Azure is already running a healthy, direct-Entra relay with no LiteLLM sidecar.
Both required Foundry deployments are healthy. The remaining functional gap is
that Azure is still running the relay image from the first direct-Entra cutover,
while the repository and a newer ACR image contain the selected-target
transcription hint needed to make Spanish and Turkish recognition more reliable.
That newer image has not been promoted.

The final cleanup also remains incomplete: the retired OpenRouter/LiteLLM Key
Vault secrets, the relay runtime's temporary Key Vault Secrets User assignment,
and the local `OPENROUTER_API_KEY` entry still exist. They are not used by the
current relay runtime, but they must not be removed until the updated Azure-only
runtime has been promoted and proven.

The prior implementation effort became overengineered around deployment
evidence. Three untracked files totaling 1,400 lines attempt to add another
rollout journal on top of the existing lifecycle and plan guard. That work was
interrupted, was never reviewed or deployed, and should be considered an
abandoned draft by default.

## Mission and product objective

The intended wearer experience is:

1. Launch Palancar in Even Hub and explicitly select Spanish or Turkish.
2. Press the R1 ring or configured glasses input to begin one listening turn.
3. Stream G2 microphone audio and show target-language partial transcription.
4. Finalize the utterance and show its English translation.
5. Show two or three likely responses, each in English and the selected target
   language.
6. Swipe through suggestions and press to begin the next turn.

The initial product is a visual aid. G2 has no speaker, so Palancar does not
speak the response. The wearer reads and says the selected response.

The app must be as close to real time as practical. The initial product target
recorded in planning is a useful target-language partial visible on physical G2
within 1.5 seconds p95 from speech onset. This has not yet been proven on
physical hardware.

## Product rules that must remain true

- Wearer language is English (`en`). Target language is selected per session.
- Spanish (`es`) and Turkish (`tr`) have equal status in the first release.
- Core flow must be registry-driven, not specialized around Spanish.
- Only an authoritative final transcript accepted as the selected target
  language may enter translation and response generation.
- English, another supported-but-unselected language, mixed language, unknown
  language, and uncertain evidence fail closed before generation.
- Partials may be displayed but never trigger generation.
- The mono G2 microphone cannot identify speakers. The interaction model uses
  an explicit listening turn; it does not claim speaker diarization.
- No Azure or model credential may be shipped in the G2 bundle.
- Paid/deployed operation must use Azure Table-backed security and rate state;
  it must not silently fall back to memory or Azurite.
- Interrupted sessions restart fresh. Retained audio or model work must not be
  replayed after reconnect.

## Current architecture

```text
R1 ring / G2 input
        |
        v
Even App WebView on phone
  apps/g2-client
  - G2 bridge and interaction state
  - bounded PCM queue and backpressure
  - authenticated WSS protocol
  - glasses and phone rendering
        |
        | PCM16 + protocol-v1 control
        v
Azure Container Apps relay
  apps/relay
  - authentication/session control
  - durable grants/rate state
  - audio orchestration
  - selected-target language gate
  - telemetry and lifecycle
        |
        +--> Azure Realtime / gpt-4o-mini-transcribe
        |      partials + authoritative final transcript
        |
        +--> Azure OpenAI / gpt-5.6-luna
               English translation
               2-3 English + target-language responses
```

All deployed model inference is intended to remain inside the user's Azure
subscription and use Entra managed identity. OpenRouter and LiteLLM are retired
runtime paths, retained only in historical migration guards/tests and cleanup
utilities.

## Real-time audio and transcription design

G2 provides 16 kHz, signed 16-bit little-endian, mono PCM as variable-sized
`Uint8Array` chunks through the Even SDK. Chunk boundaries are arbitrary and
must not be treated as phrase or model boundaries.

The client uses a bounded queue, coalesces small frames, maintains absolute
sample offsets, and applies network backpressure. The relay acknowledges audio
at a paced rate. On explicit turn stop, retained audio is flushed and the turn
is committed before microphone shutdown.

The Azure Realtime path owns a stateful 16 kHz to 24 kHz resampler for each
active utterance. Audio is appended continuously to a warm provider session.
Only one component may own utterance segmentation/commit behavior at a time;
server VAD and backend commits must not both independently own the same turn.

Azure partial transcript events are forwarded immediately for display. An
authoritative final event is classified and gated. Translation and suggestions
are one cancellable, structured Luna operation only after the final passes the
selected-target gate.

The latest repository change adds the selected target as an Azure transcription
language hint:

- automatic mode remains available where appropriate;
- selected-target mode sends the exact model and ISO-639-1 language;
- the server/session validates the echoed language exactly;
- the relay resolves the canonical target once for the accepted session and
  reuses it for every utterance;
- the implementation is generic for both `es` and `tr`.

This hint improves ASR focus but is not the security boundary. The strict final
language gate remains the security/cost boundary.

## Codebase map and implementation status

### G2 client — implemented

`apps/g2-client` contains:

- Even SDK bridge lifecycle and startup-page behavior;
- target selection, ready, listening, translating, results, reconnect, and
  error states;
- ring/glasses input handling;
- microphone capture and bounded audio transport;
- authentication/enrollment controller and phone UI;
- serialized glasses display updates;
- HTTPS/WSS relay-origin validation;
- Vite build and Even Hub packaging.

The G2 baseline is Node 22, `@evenrealities/even_hub_sdk` exactly `0.0.12`,
Even Hub CLI `0.1.13`, and simulator `0.8.0`. The generated
`apps/g2-client/palancar.ehpk` exists locally and is intentionally ignored by
Git. Do not claim release readiness from the package or simulator alone; the
latest flow still needs physical G2 testing.

### Relay — implemented in source, newer image not deployed

`apps/relay` contains:

- HTTP health/readiness and authenticated WebSocket hosting;
- session and utterance lifecycle;
- browser-origin enforcement;
- durable authentication, audio grants, rate limits, and replay prevention;
- Azure Realtime transcription composition;
- selected-target gating;
- direct Azure Luna generation through managed identity;
- telemetry, diagnostic, and shutdown behavior.

Commit `d219fe5` binds transcription to the selected session target. It is
reviewed and tested but not live in Azure.

### Shared packages — implemented

- `packages/contracts`: protocol-v1, auth, audio/control schemas, validation.
- `packages/audio`: PCM framing, queueing, offsets, relay flow, resampling.
- `packages/azure-auth`: shared managed-identity token source.
- `packages/transcription`: mock and Azure Realtime adapters, parser, selected
  target hint, managed-identity auth, evidence.
- `packages/language-registry`: registry, classifier, selected-target gate.
- `packages/generation`: direct Azure OpenAI provider, structured translation
  and suggestions, accepted-output contract, fail-closed language validation.
- `packages/security-state`: Azure Table state, atomic/ETag operations, grants,
  rate state, and bounded audio accounting.
- `packages/telemetry`: bounded OTLP JSON export and metric contracts.
- `packages/test-fixtures`: shared Spanish/Turkish and protocol fixtures.

`packages/generation/src/litellm.ts` no longer exists in tracked source. Some
historical telemetry IDs and guard/test fixtures still mention LiteLLM; they do
not establish an active provider path.

### Infrastructure — implemented, cleanup incomplete

Terraform in `infra/environments/dev` and `infra/modules` manages:

- resource group, budget, action group, and alerts;
- Log Analytics and Application Insights;
- ACR;
- separate image-pull and runtime managed identities;
- dedicated workload-state Tables;
- Container Apps environment and one warm relay replica;
- scheduled expiry-cleanup Container Apps Job;
- Key Vault and migration-era credential access;
- Azure Foundry account and both model deployments;
- model, Table, telemetry, and image-pull RBAC.

The production relay topology is one relay container with no proxy sidecar,
0.25 CPU / 0.5 GiB, `minReplicas=1`, `maxReplicas=1`, single revision, and 100%
latest-revision traffic.

## Azure live state at handoff

Read-only checks were performed on 2026-08-22 around 20:36 America/Chicago.

- Azure CLI account: enabled `Visual Studio Enterprise Subscription`.
- Region: `eastus2`.
- Relay Container App: provisioning succeeded and running.
- Latest and latest-ready revision: `ca-palancar-dev-relay-aeeacd8c--0000018`.
- Traffic: 100% to latest revision.
- Scale: exactly one warm replica allowed (`min=1`, `max=1`).
- Containers: exactly one container named `relay`; no LiteLLM sidecar.
- `/healthz`: `{"ok":true}`.
- `/readyz`: HTTP 200 with `{"ready":true}`.
- The live relay image does **not** equal the desired image pinned in the
  ignored `infra/environments/dev/terraform.tfvars`.
- Foundry `gpt-4o-mini-transcribe` version `2025-12-15`: succeeded, capacity 1.
- Foundry `gpt-5.6-luna` version `2026-07-09`: succeeded, capacity 1013
  (approximately the user's requested 1M TPM deployment).

Do not copy resource IDs, client IDs, endpoints, image digests, or connection
strings into new tracked documents. Resolve them from Terraform outputs and the
ignored live variable file when needed.

The image desired by `terraform.tfvars` was built from commit `d219fe5`, pushed
to the existing ACR as a single Linux/amd64 immutable image, and passed the
remote platform verifier. Its digest is deliberately not repeated here.

## Migration and deployment state

The guarded Entra migration journal is under:

`/home/dev/.local/state/palancar/azure-foundry-entra-cutover`

It is private mode-0600/0700 evidence and must not be committed or casually
edited. Its current global state is:

`runtime-applied` at sequence 94.

Successful lifecycle runs are:

- model bootstrap: `mt2lf4q9-a5178b18c114d88b0c518740`, applied;
- direct-Entra runtime cutover: `mt4zfq8g-c4503a65000f57b397e0530b`, applied.

There are many invalidated runtime-cutover attempts. They are historical
evidence of strict plan/provider/live-schema mismatches and plan expiry, not
active work. Do not delete or rewrite the journal.

The migration has **not** advanced to:

- `credentials-and-RBAC-cleaned`;
- `terminal-verified`.

A post-cutover Terraform saved plan currently exists at:

`/tmp/palancar-post-cutover-plan.eB6AXu/rollout.tfplan`

Its JSON view is beside it. The committed plan guard accepted it as exactly one
Container App image update with the rest of the infrastructure no-op, and a Sol
review found no guard gaps. However, this plan is an ephemeral `/tmp` artifact,
was created at 19:47 local time, and is stale for a new handoff. **Do not apply
it. Create and review a fresh saved plan from the current state.**

## Exact unfinished work

### 1. Promote the selected-target relay image

The critical path is small:

1. Confirm a clean intended source tree after resolving the three untracked
   draft files.
2. Confirm the desired relay digest in the ignored live tfvars still points to
   the image built from `d219fe5` or rebuild from the chosen successor commit.
3. Re-run the remote ACR image-platform verifier.
4. Create a fresh, refreshed, complete Terraform saved plan.
5. Feed its JSON to the committed
   `post-cutover-relay-image-rollout` guard.
6. Independently review that the plan has exactly one Container App update,
   changing only the relay image and computed revision output.
7. Apply that exact fresh binary once.
8. Confirm a distinct healthy revision, one replica, 100% traffic, and no
   unexpected active revisions.

Commit `47aa5b3` is the committed guard for this narrow image rollout. Its mode
is `post-cutover-relay-image-rollout`.

### 2. Run real Spanish and Turkish smoke tests

After promotion, test both languages symmetrically through real Azure
transcription and Luna generation using Entra auth. Required assertions:

- target-language partials arrive in useful time;
- final target transcript is accepted;
- English translation is accurate enough for the scenario;
- two or three suggestions are produced;
- every suggestion has English and the selected target-language text;
- English, mixed, and supported-but-unselected inputs do not reach Luna;
- disconnect/cancel does not replay audio or regenerate;
- telemetry records stage timing and rejection reasons without transcript or
  credential leakage.

The earlier live Spanish smoke used an eSpeak fixture. ASR hallucinated/mixed
languages and the strict language gate rejected the turn before Luna. That was
a functional smoke failure, not a fail-open security failure. The selected
target hint was implemented in response. TTS fixtures are not sufficient proof;
use real Spanish and Turkish speakers and, ultimately, the physical G2 mic.

### 3. Complete legacy credential cleanup

Current read-only inventory confirms:

- Key Vault still has `openrouter-api-key` and `litellm-master-key`;
- the runtime identity still has one Key Vault Secrets User assignment;
- `/home/dev/repos/palancar_ws/.env` still contains an
  `OPENROUTER_API_KEY` assignment.

No secret values were read or recorded in this handoff.

Only after the new Entra-only revision is proven:

1. verify no active Container App revision references retired secrets or
   LiteLLM/OpenRouter settings;
2. disable and prove disabled the runtime Key Vault role using the existing
   guarded utility;
3. remove both Key Vault secrets through the existing credential-cleanup flow;
4. apply the reviewed Terraform credential-cleanup plan that removes only the
   temporary runtime Secrets User assignment;
5. complete provider-side OpenRouter revocation evidence if required;
6. remove the local `.env` entry using `remove-env-entry.mjs` without displaying
   its value;
7. run the terminal no-op inventory/plan verification and close the lifecycle.

Read `infra/README.md` and `docs/azure-foundry-entra-cutover-plan.md` before
performing these steps. Do not run cleanup from memory or improvise destructive
commands.

### 4. Validate on physical G2 hardware

The latest end-to-end app has not been accepted on physical G2 hardware. The
successor must test:

- launch/cold resume;
- explicit Spanish and Turkish selection;
- ring/temple press behavior;
- microphone permission and audio continuity;
- partial/final display latency and flicker;
- truncation/paging of translation and suggestions;
- reconnect and fresh-session behavior;
- `.ehpk` sideload/package behavior on the pinned Even versions.

## Current tests and reviews

Fresh targeted verification at handoff:

- transcription: 205/205 tests passed;
- relay: 735/735 tests passed;
- committed Terraform plan guard: 133/133 tests passed.

The latest Sol reviews reported READY for:

- `b0aab9f` selected-target transcription configuration;
- `d219fe5` relay/session binding to the selected target;
- `47aa5b3` post-cutover image guard, including the genuine provider-shaped
  plan and a broad mutation matrix.

These targeted results do not certify the three untracked draft files. No full
workspace lint/typecheck/build/test pass was rerun during this handoff because
implementation was stopped and the affected committed slices already passed
their targeted suites. A successor should run the normal workspace gates after
resolving the worktree and before a new image build.

## Worktree and artifact inventory

Tracked HEAD is `47aa5b3`. There is no configured Git remote or upstream in
this checkout.

The only visible untracked files are:

- `infra/scripts/post-cutover-relay-rollout-evidence.mjs` — 327 lines;
- `infra/scripts/post-cutover-relay-rollout.mjs` — 837 lines;
- `infra/scripts/post-cutover-relay-rollout.test.mjs` — 236 lines.

These files were produced by an interrupted Luna worker after the user raised
the overengineering concern. They add another hash-chained evidence system and
rollout lifecycle over the already committed plan guard. They are not committed,
reviewed, deployed, or required by Terraform. Recommended default: inspect once
for any uniquely useful idea, then discard all three and use the narrower
committed guard plus a fresh saved plan. Do not silently commit them.

Important ignored/private artifacts include:

- `infra/environments/dev/terraform.tfvars` — live desired inputs and image
  digests; never commit;
- `infra/environments/dev/.terraform` and backend configuration/state access;
- `apps/g2-client/palancar.ehpk` — generated package;
- `/home/dev/.local/state/palancar/...` — lifecycle evidence;
- `/tmp/palancar-post-cutover-plan.eB6AXu` — stale saved plan; do not apply;
- `/home/dev/repos/palancar_ws/.env` — contains a legacy key; never print or
  commit.

## Important recent commits

The most relevant recent chain is:

- `af7d45d` — manage Luna Foundry deployment;
- `0254d51` — add guarded development plan lifecycle;
- `86d8b20` — direct Azure Luna provider with Entra auth;
- `1df270b` — shared Entra auth for generation;
- `64a7fa6` — Entra-only relay infrastructure modules;
- `9fb0257` — Terraform relay cutover to Azure generation;
- `ec293bc` — remove retired proxy runtime;
- `8437ec2` — guarded credential cleanup utilities;
- `73bbafc` — complete guarded Azure-generation rollout machinery;
- `e315636` — correct Azure OpenAI token audience;
- `398ecdc` — bind revision-retention transition;
- `b0aab9f` — selected-target transcription hint;
- `d219fe5` — relay binds transcription to selected target;
- `47aa5b3` — narrow post-cutover relay-image plan guard.

Earlier OpenRouter/LiteLLM commits are historical context and should not be
treated as the target architecture.

## Documentation precedence and known staleness

Start with:

1. `AGENTS.md` for G2 knowledge and source precedence.
2. `docs/adr/0000-language-registry.md`.
3. `docs/adr/0001-protocol-v1.md`.
4. `docs/adr/0003-client-authentication.md`.
5. `docs/adr/0004-data-retention.md`.
6. `docs/adr/0005-compute-host.md`.
7. `infra/README.md` for current Azure target and cleanup commands.
8. `docs/azure-foundry-entra-cutover-plan.md` for the migration contract.
9. Current source and tests at HEAD.

Treat the following carefully:

- `docs/real-time-translation-plan.md` still describes LiteLLM/OpenRouter in
  portions of the original architecture. That is stale.
- `docs/implementation-plan.md` contains multiple historical decisions and may
  conflict with the final Entra-only architecture.
- `docs/remaining-implementation-plan.md` is marked active but predates much of
  the completed work.
- `docs/evidence/deployment-status-2026-08-10.md` records the old Azure model
  deployment blocker. That blocker was later cleared; both models now exist.
- `infra/scripts/assert-dev-plan.mjs` intentionally contains historical guard
  modes and hard-coded development topology. The presence of old OpenRouter or
  LiteLLM strings there does not mean the runtime still uses them.
- The ignored live `terraform.tfvars` still has at least one obsolete LiteLLM
  input line. Current Terraform does not use that as the relay runtime path, but
  the successor should clean stale variables only through a reviewed no-op plan,
  not while promoting the image.

## Lessons learned

### Keep deployment scope proportional

The final remaining application change is a single immutable image promotion.
Building a second append-only journal, custom lock protocol, and reconciliation
state machine for that one dev Container App update added far more code and
review burden than product value. The committed exact Terraform plan guard is
already strong enough to constrain the change. Prefer a fresh plan, one guard,
one independent review, one apply, and direct live verification.

### Separate product readiness from evidence-system completeness

The implementation spent many cycles making the deployment guard accept every
benign Azure/Terraform provider normalization. That protected safety, but it
also obscured the product's simple remaining gap. Keep a visible checklist of
source state, built image, desired tfvars image, live image, smoke result, and
cleanup state.

### Avoid repurposing a completed migration lifecycle

The Entra model/bootstrap and provider cutover lifecycle successfully reached
`runtime-applied`. A later routine image update should not pretend to be another
provider migration. Preserve the original evidence and use the smallest safe
post-cutover rollout path.

### Use the target language twice, for different reasons

The selected target should guide Azure ASR so recognition is focused, but ASR
configuration is not an authorization decision. Independently classify and
gate the authoritative final transcript before any expensive or user-visible
generation.

### Do not overfit to one language or one synthetic voice

Spanish exposed the ASR issue first, but the solution must cover both Spanish
and Turkish through the registry. eSpeak is useful for deterministic transport
smoke tests, not for proving real conversational ASR quality.

### Physical hardware is the final latency authority

Simulator, server fixtures, and direct model tests cannot prove Bluetooth,
phone WebView suspension, G2 microphone characteristics, display flicker, or
ring interaction. Keep those claims explicitly unproven until hardware tests.

### Keep secrets out of evidence

Use managed identity for Azure. Inventory secret names/status only. Never copy
the parent `.env`, Key Vault values, tokens, connection strings, or raw private
plan JSON into tracked handoff material.

### Subagent use preference

The user's explicit preference is:

- GPT-5.6 Luna xhigh for narrowly scoped, fully specified implementation and
  mechanical fixing;
- GPT-5.6 Sol for architecture, adversarial review, ambiguous debugging, and
  final review;
- implement/review/fix loops, with small commits after reviewed slices.

Both subagents from the interrupted session were closed during this handoff.
No agent is expected to continue mutating the repository.

## Recommended successor approach

The successor should resist reopening architecture. A compact path is:

1. Read this handoff, `AGENTS.md`, the ADRs, `infra/README.md`, and the Entra
   cutover plan.
2. Inspect the three untracked files and decide explicitly to discard or adopt
   them. Default to discard.
3. Run `git status`, targeted tests, workspace lint/typecheck/build/test, and
   `terraform validate` without changing Azure.
4. Verify current Azure and tfvars image mismatch read-only.
5. Generate and independently review a fresh exact one-image saved plan.
6. Apply once, verify the new revision, and run Spanish and Turkish real-audio
   smoke tests.
7. Complete the existing credential-cleanup and terminal flows.
8. Rebuild/package the G2 app if needed and complete physical hardware tests.
9. Update or replace stale planning docs with a short current-state document.

Do not start by adding another orchestration layer.

## Read-only orientation commands

Run from the repository root unless noted:

```sh
git status --short --branch
git log --oneline -20
npm test --workspace @palancar/transcription -- --reporter=dot
npm test --workspace @palancar/relay -- --reporter=dot
node --test infra/scripts/assert-dev-plan.test.mjs
terraform -chdir=infra/environments/dev validate
terraform -chdir=infra/environments/dev output -json | jq 'keys'
az account show --query '{subscriptionName:name,state:state}' -o json
```

Use Terraform outputs to resolve resource names for additional read-only Azure
queries. Do not print sensitive outputs wholesale. Do not run `terraform apply`,
credential cleanup, Key Vault deletion, role removal, or local key removal until
a fresh plan and live preconditions have been reviewed.

## Definition of complete

Palancar is not complete until all of the following are true:

- the selected-target transcription image is live;
- Spanish and Turkish both pass real Azure end-to-end tests;
- non-target and mixed utterances are proven not to invoke Luna;
- translation and two or three bilingual response suggestions render on G2;
- latency and interaction pass physical G2 testing;
- Azure remains one warm relay container with Entra-only model access;
- no active revision references LiteLLM/OpenRouter or legacy secrets;
- retired Key Vault secrets, temporary Key Vault RBAC, provider key, and local
  key entry are removed with evidence;
- Terraform reaches a reviewed terminal no-op state;
- the repository is clean, tests pass, and current documentation matches the
  deployed architecture.

## Final handoff statement

Implementation has stopped safely. Azure was left healthy and unchanged during
this handoff. The repository was left at the reviewed committed HEAD with the
three interrupted untracked draft files preserved for successor inspection.
The next useful action is not more architecture: it is a fresh, narrow image
promotion followed by real Spanish/Turkish smoke tests and controlled legacy
credential cleanup.
