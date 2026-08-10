# ADR 0004: Conversation data and telemetry retention

Status: Accepted for development; provider handling must be verified before real audio

Date: 2026-08-09

## Context

Speech, transcripts, translations, and suggested replies can contain personal or
sensitive conversation content. Palancar needs enough operational evidence to
debug latency, abuse, cost, and authentication without creating conversation
history. Azure model providers have their own abuse-monitoring behavior, which
is distinct from application-controlled storage.

## Decision

Palancar v1 is a zero-conversation-retention service:

- Raw audio is memory-only and is never written to a file, database, blob,
  queue, trace, log, crash report, or evidence artifact.
- Full or partial transcripts, translations, suggestions, prompts, and model
  context are memory-only and are never persisted by the client or relay.
- Bounded conversational context exists only during the active session and is
  cleared on session end, inactivity, abnormal/system exit, process loss, and
  client cold launch.
- Client persistent state is limited to installation authentication metadata and
  the last selected target language. Every app session requires explicit target
  confirmation before listening.

Operational telemetry may contain only event names, opaque correlation IDs,
coarse language code, policy/model/config version, durations, byte/sample/token
counts, status categories, and redacted error codes. Audio and conversation
content are prohibited in every deployed mode and log level, including traces,
exceptions, diagnostics, evidence sinks, security/audit events, and crash
reports. Security/audit events may contain installation or operator identifiers
but no credential material or conversation content. Debug flags cannot weaken
this prohibition.

Log Analytics, Application Insights, and security/audit telemetry retain data
for exactly 30 days. Infrastructure sets 30-day retention and immediate purge at
30 days rather than relying on a configuration that can retain data into day 31.
No deployed configuration can enable request/response bodies or arbitrary
provider payloads. Synthetic, non-conversation fixtures used by isolated tests
are explicitly labeled and stored separately from deployed telemetry and
evidence paths.

## Provider boundary

Palancar's promise describes storage controlled by this application. It does not
claim that Azure's mandatory service metadata or model abuse-monitoring systems
are application storage or have zero retention.

Before real conversation audio or text is sent, evidence must capture the exact
resource, region, deployment type, model/version, API version, content-logging
capability, and current Microsoft data-handling terms. Foundry model prompts and
responses can be selected for abuse review unless the subscription/resource is
approved for modified abuse monitoring. If approved, the resource capability
must show `ContentLogging=false`. Stored completions and request/response body
logging remain disabled.

The realtime transcription endpoint is validated independently from text-model
documentation. Azure Speech fallback may be used only with optional audio and
transcription logging disabled; real-time Speech documentation describes input
processing in server memory without at-rest storage in that configuration.

If current provider handling is not accepted for the intended conversation, the
system stays synthetic-only until modified monitoring is approved or another
provider passes the same review.

## Verification

- Automated redaction tests use canary credentials, tickets, transcript text,
  translations, and suggestions and require zero matches in application logs,
  ingress logs, Application Insights, Log Analytics, exceptions, browser
  history, bundles, `.ehpk`, images, Terraform outputs, diagnostics, traces,
  crash reports, and evidence artifacts at every deployed log level/mode.
- Telemetry schemas use allow-listed fields; arbitrary objects, headers, query
  strings, prompts, responses, and provider payloads cannot be logged.
- Client teardown and cold-launch tests prove all conversation UI/context is
  cleared while the last target choice remains.
- Terraform validation and an Azure query prove exact 30-day retention and
  immediate purge behavior.
- A dated provider evidence record is required before every new model/version or
  API deployment receives real content.

## Consequences

Palancar cannot provide conversation history, cross-session memory, or replay of
a lost turn in v1. Debugging relies on metrics, typed state transitions, and
synthetic reproduction. Adding durable conversation content requires a new ADR,
explicit consent and deletion semantics, encryption/access controls, and a
revised provider/privacy review.
