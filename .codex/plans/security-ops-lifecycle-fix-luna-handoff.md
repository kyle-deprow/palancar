# Luna agent handoff: security operations socket lifecycle hardening

## Assignment

- Profile: `gpt-5.6-luna` at `xhigh` through the implementation-worker role.
- Objective: Make every live smoke socket deadline-bound and continuously monitored, while preserving one-credential/two-ticket behavior and content-free output.
- Done when: no timeout can leave a smoke operation running, no socket error/close gap can become an unhandled EventEmitter error, canonical Azure Table endpoints accept an optional slash, exact URLs/methods and negotiated versions are tested, and all focused checks pass.

## Scope

- Inspect/use: `tools/security-ops/src/index.ts`, `tools/security-ops/test/security-ops.test.ts`, the current contracts/constants, and the latest Sol findings in the parent prompt.
- Do not inspect/change: `.env`, Terraform, security-state source/tests, generated `dist`, package manifests, lockfiles, cloud resources, or any file outside the two listed files. Do not make network/cloud calls.
- Write permission: exactly `tools/security-ops/src/index.ts` and `tools/security-ops/test/security-ops.test.ts`.

## Method and evidence

- Requirements:
  1. Eliminate uncancelled outer `withTimeout(smokeTarget(...))` wrappers. Each `smokeTarget` must own one total `GENERATION_TIMEOUT_MS` deadline from socket creation through normal close. Deadline expiry must reject with `SecurityOpsError`, terminate the exact socket, remove all lifetime listeners/timers, and be awaited by the caller before the next operation or final rejection.
  2. Install session-lifetime `error` and `close` listeners immediately after socket construction. Every phase wait, including the 100 ms inter-frame delay, must race the persistent failure signal. There must never be a listener gap in which a socket `error` is unhandled. Before the expected protocol close, transition the monitor so `closeSocket` alone validates code 1000; still ensure errors are handled. Dispose listeners/timer in `finally`.
  3. Preserve ack-relative 100 ms pacing, exactly 18 x 1,600-sample frames, one pairing redemption, one credential, and two sequential single-use tickets.
  4. Add deterministic tests proving an `error` during the inter-frame delay and an unexpected `close` during that delay reject content-free without uncaught EventEmitter errors; prove total-deadline expiry terminates the socket and leaves no lifetime listeners/timers. Use fake timers or injected deterministic hooks without broadening public configuration.
  5. `parseSecurityOpsConfig` must accept canonical Azure Table endpoints with or without one trailing slash and return/store `url.origin`; reject paths, query, fragment, credentials, ports, double slash, and non-Table hosts. Test both accepted forms and normalized equality.
  6. HTTP fakes must assert exact pairing redemption and session-ticket URLs, method POST, redirect policy, headers, and bodies—not route only by request count.
  7. Validate `session.ready` returns the exact current `LANGUAGE_REGISTRY_VERSION`, `GATE_POLICY_VERSION`, and effective limits no greater than/equal to the exact requested limits used by this smoke. Update fake registry version to the imported current constant. Fail closed on mismatches and add mutation tests.
  8. Preserve all event correlation, duplicate rejection, protocol selection, schema validation, TTY restrictions, Azure context checks, secret/content redaction, and fixed public failure text.
- Required checks from repository root: `npm run lint --workspace @palancar/security-ops`, `npm run typecheck --workspace @palancar/security-ops`, `npm test --workspace @palancar/security-ops`, `npm run build --workspace @palancar/security-ops`, and `git diff --check`.
- Evidence to return: changed symbols/tests, exact check outputs, and unresolved risks.
- Stop and escalate if: a public protocol change, dependency/package change, or file outside the two-file scope is needed.

## Response format

1. Result
2. Evidence with file/symbol references
3. Checks run and actual outcomes
4. Blockers/uncertainty
5. Final `DONE` only if complete
