# Telemetry foundation - Luna test/fix handoff

## Current state

`packages/telemetry` exists and currently passes lint, typecheck, and build, but it has no tests and has not been reviewed. The package must satisfy the original telemetry handoff before Sol review or commit.

## Writable scope

- `packages/telemetry/**`

Do not edit root manifests, lockfiles, apps, generation, relay, Terraform, docs, or commits.

## Objective

Add focused Vitest coverage for the telemetry foundation and fix only package-local implementation defects exposed by those tests.

## Required tests

Cover:

- every canonical metric name exported in `TELEMETRY_METRIC_NAMES`;
- both target languages;
- every enum family exported by the package;
- valid sanitized records with hashed correlations only;
- raw UUID rejection for every correlation field;
- invalid hashes, timestamps, tokens, numbers, enum values, and error pairs;
- forbidden key families at top-level and nested depths, including case variants and prefix/suffix forms;
- getter/accessor non-invocation;
- cycles, proxies that throw, arrays, functions, bigint, symbols, non-plain objects, and excessive nesting fail closed;
- unknown safe keys are dropped recursively;
- caller-owned inputs are not mutated or frozen;
- returned records and sink snapshots are deeply frozen;
- `RedactedError`/`summarizeError` never read or expose `Error.message`, stack, cause, enumerable custom fields, or representative provider/conversation text;
- bounded in-memory sink capacity, dropped count, `clear()`, defensive copy behavior, and rejecting unsanitized records;
- serialized sanitized records/errors do not contain representative Spanish, Turkish, or English conversation strings.

## Implementation constraints

- Keep no `any`.
- Do not add dependencies.
- Do not use Node crypto, timers, random generation, environment, network, or logging.
- Public validation errors must remain content-free.

## Verification

Run:

- `npm run lint -w @palancar/telemetry`
- `npm run typecheck -w @palancar/telemetry`
- `npm run test -w @palancar/telemetry`
- `npm run build -w @palancar/telemetry`
- `git diff --check -- packages/telemetry`

## Completion report

List changed files, actual verification results, unresolved risks, and `DONE` as the final line only if complete.
