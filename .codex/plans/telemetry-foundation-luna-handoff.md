# Telemetry foundation — Luna implementation handoff

## Objective

Create a small provider-neutral `@palancar/telemetry` package containing the canonical low-cardinality metric/event vocabulary and fail-closed redaction helpers for relay/client metadata. It must be impossible for arbitrary conversation text, audio, credentials, tickets, pairing codes, headers, URLs/query strings, prompts, or provider error messages to enter a sanitized telemetry record.

## Writable scope

- `packages/telemetry/**`

Do not edit any other file, root lock/manifests, apps, docs, Terraform, or commits. Other agents are active; preserve their edits.

## Required API

Export from `src/index.ts`:

- frozen metric name constants for session start/reject/end, utterance start/abort/complete, audio accepted/duplicate/rejected samples, transport reconnect/non-resumable, transcription first-partial/final latency, language decisions, translation latency/result, suggestion latency/result, provider failure, and state-store failure;
- literal union types for metric name and bounded enum attributes;
- `sanitizeTelemetry(input): SanitizedTelemetryRecord` that accepts unknown input but emits only an explicit allowlist;
- `createTelemetryRecord(input)` for typed callers;
- a `RedactedError`/error summarizer that emits only a stable internal category and generated/provided non-secret error ID, never `Error.message`, stack, cause, or enumerable custom fields.

The sanitized record may contain only:

- canonical metric/event name;
- UTC timestamp supplied by caller and validated against the contracts timestamp pattern;
- duration/sample/count numeric values that are finite nonnegative integers within safe integer range;
- protocol version, selected target (`es`/`tr`), gate decision enum, operation enum, outcome enum, provider ID/version from a strict token pattern and max length, deployment slot from a small enum, reconnect reason enum, and stable error category/error ID;
- correlation identifiers only as irreversible opaque hashes matching `sha256:<64 lowercase hex>`; raw UUIDs are forbidden.

Unknown keys are dropped recursively, not copied. Inputs containing a forbidden key name at any depth (`text`, `transcript`, `translation`, `suggestion`, `audio`, `pcm`, `prompt`, `content`, `authorization`, `cookie`, `ticket`, `token`, `secret`, `credential`, `pairing`, `code`, `url`, `uri`, `query`, `header`, `body`, `message`, `stack`, or `cause`, case-insensitively and including common suffix/prefix forms) must be rejected with a content-free typed error, not partially emitted. Symbols, accessors/getters, proxies that throw, cycles, arrays, functions, bigint, non-plain objects, and excessive nesting must fail closed with a content-free error. Do not invoke getters.

Validate all enum/token/number/hash/time values. Return a newly allocated deeply frozen record. Never mutate or freeze caller-owned input. Public error messages/categories must not include input values.

Provide a metadata-only in-memory sink with bounded capacity (default and maximum), immutable snapshots, explicit dropped-count accounting, and `clear()`. It must store only already-sanitized records and defensively copy them. It must never log or access environment/network state.

## Package conventions

- private ESM `0.1.0`, strict TypeScript, declarations, ESLint, Vitest;
- dependencies only on `@palancar/contracts` and `@palancar/language-registry` if needed;
- no `any`, telemetry vendor SDK, Node crypto, logging, timers, random generation, environment or network access.

## Tests

Cover every canonical name, both target languages, every enum, valid records, raw UUID rejection, invalid hashes/time/token/numbers, every forbidden-key family at nested depths/case variants, getter non-invocation, cycles/proxy/accessor/non-plain failures, unknown-key dropping, caller immutability, deep output freezing, error redaction, bounded sink/drop accounting/copy behavior, and absence of representative Spanish/Turkish/English conversation strings in serialized records/errors.

## Verification

Run equivalent workspace/local commands for lint, typecheck, tests, build, and `git diff --check -- packages/telemetry`. If root lock absence blocks workspace discovery, report it and use direct root tools. Do not edit the lockfile.

List changed files, actual results, and unresolved risks. End with `DONE` only if complete.
