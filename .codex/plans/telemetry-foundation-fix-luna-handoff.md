# Telemetry foundation - Luna security fix handoff

## Objective

Close the Sol telemetry `NEEDS WORK` findings without changing the public package goal. The package must fail closed with content-free typed errors even for malicious proxies, avoid traversal denial of service, enforce bounded sink capacity at runtime, and enforce sanitized-record provenance.

## Writable scope

- `packages/telemetry/**`

Do not edit root manifests, lockfiles, apps, generation, relay, Terraform, docs, or commits.

## Required fixes

1. Proxy/raw-error fail-closed behavior:
   - No untrusted thrown value may escape from sanitizer or sink paths.
   - Avoid `instanceof` checks against untrusted thrown values in catch blocks. Treat all caught values as unsafe and throw a fresh `TelemetryValidationError` with a content-free reason.
   - Wrap `Array.isArray`, `Object.getPrototypeOf`, `Object.getOwnPropertySymbols`, `Object.getOwnPropertyNames`, `Object.getOwnPropertyDescriptor`, `Object.getOwnPropertyDescriptors`, `Object.isFrozen`, `Object.freeze`, and other reflective calls that can touch proxies.
   - Revoked proxies and proxies whose traps throw must produce `TelemetryValidationError` without exposing trap messages.
2. Traversal work budget:
   - Add a visited/inspected object set for the whole input graph so shared DAG nodes are inspected once.
   - Add a conservative total object/property work budget. Exceeding it fails closed with a content-free validation error.
   - Preserve cycle detection.
3. Sink capacity:
   - Store capacity in a private field or define the public `capacity` property as nonwritable/nonconfigurable.
   - `add()` must use the trusted private/fixed value, not a mutable public field.
   - Add test proving attempted runtime mutation cannot bypass capacity/drop accounting.
4. Sanitized-record provenance:
   - Brand records returned by `sanitizeTelemetry`/`createTelemetryRecord` with private module-local provenance that is not serializable.
   - `InMemoryTelemetrySink.add()` must reject a frozen, structurally valid hand-crafted object that was never sanitized by this module.
   - Defensively copy and rebrand records stored/snapshotted by the sink.
5. Null-prototype outputs:
   - Sanitized records and snapshots should not inherit mutable `Object.prototype`.
   - Define own data properties explicitly. Prevent inherited setters/toJSON from affecting copying or serialization.
   - Ensure `RedactedError`/summary serialization remains content-free even with prototype pollution attempts.
6. Tests:
   - Add tests for malicious thrown proxies in sanitizer and sink paths, revoked proxies, reflective trap failures, shared DAG work amplification, runtime capacity mutation, hand-crafted frozen record rejection, null-prototype sanitized records/snapshots, and prototype-polluted `toJSON`/setter attempts.
   - Keep existing tests passing.

## Verification

Run:

- `npm run lint -w @palancar/telemetry`
- `npm run typecheck -w @palancar/telemetry`
- `npm run test -w @palancar/telemetry`
- `npm run build -w @palancar/telemetry`
- `git diff --check -- packages/telemetry`

## Completion report

List changed files, actual verification results, unresolved risks, and `DONE` as the final line only if complete.
