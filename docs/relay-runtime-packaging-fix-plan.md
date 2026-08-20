# Relay runtime packaging fix

## Objective

Make the relay runtime image include every production dependency installed in
the relay workspace and make the container smoke test exercise the current
fail-closed local-mock startup contract.

## Ownership

The bounded implementation worker may edit only:

- `apps/relay/Dockerfile`
- `apps/relay/scripts/smoke-container.mjs`
- `apps/relay/scripts/smoke-container.test.mjs`

This plan is read-only to the worker. All other files, Git operations, Azure
resources, registries, secrets, and existing image tags are out of scope.

## Requirements

1. After `npm prune --omit=dev`, the runtime image must copy the relay
   workspace-local `node_modules` alongside the root production modules.
2. Ownership in the non-root runtime image must remain `node:node`.
3. The smoke harness must supply exactly the local-mock security, generation,
   transcription, and loopback-bind settings required by the current parser.
4. Because local-mock intentionally binds loopback, the harness must verify
   the image's built-in Docker health check instead of relying on host port
   publication.
5. The harness must retain deterministic timeout, failure, and container
   cleanup behavior and must not expose logs or secrets.
6. Inspect running state and health status atomically. Succeed only while the
   container is both running and healthy, and fail immediately once it is no
   longer running.
7. Bound every synchronous Docker health-status inspection by the remaining
   overall deadline so a stalled CLI or daemon cannot defeat the 30-second
   health limit. Other lifecycle commands retain their separate bounded
   timeouts; image compilation is intentionally outside the health deadline.
8. Preserve the no-argument local-build workflow and add a strict positional
   immutable image reference mode that skips the build and accepts only a
   digest-qualified image. This mode is used to smoke the exact published
   artifact.
9. Add focused Node tests for at least running-and-healthy success,
   exited-but-retaining-healthy rejection, stalled Docker invocation timeout,
   and immutable-reference validation. Tests must not invoke Docker.
10. Do not build or push an image, access Azure, read `.env`, or commit.

## Verification

- `node --check apps/relay/scripts/smoke-container.mjs`
- `node --test apps/relay/scripts/smoke-container.test.mjs`
- `npm run lint --workspace @palancar/relay`
- `npm run typecheck --workspace @palancar/relay`
- `npm test --workspace @palancar/relay`
- `git diff --check`
- Mechanical inspection proving the runtime copy source is produced by the
  pruned builder stage and the smoke environment matches `parseRelayHostConfig`.

## Completion

The fix is complete only after parent verification, a Sol review with status
`READY`, a new commit, one replacement relay build, and a successful smoke run
of that exact published digest.
