# Luna fix handoff: relay host Sol review findings

## Objective

Fix the two Sol-reviewed relay host blockers without redesigning the host.

## Files you may change

- `apps/relay/src/host.ts`
- `apps/relay/src/main.ts`
- `apps/relay/test/relay-host.test.ts`

## Files and actions you must not change

- Do not edit package manifests, lockfiles, core relay files, protocol files, docs, infra, generated dist, or other tests.
- Do not commit.

## Required fixes

1. **Stop/upgrade race**
   - `createRelayHost().stop()` must not race with an upgrade waiting on asynchronous `prepareStreamUpgrade()` / ticket consumption.
   - Add a `stopping` gate:
     - when stop starts, prevent future upgrades from being accepted;
     - if an upgrade finishes after stopping begins, reject/destroy it and do not call `handleUpgrade`.
   - Track pending upgrade promises/sockets sufficiently so `stop()` waits for in-flight upgrade decisions to settle or destroys their sockets.
   - A pending upgrade socket must not create an untracked WebSocket after `stop()` has resolved.
   - Add a test with a delayed `TicketConsumer.consume` / custom `DevelopmentTicketStore` equivalent:
     - start upgrade;
     - call `host.stop()` while consume is unresolved;
     - resolve consume;
     - assert stop resolves, no WebSocket opens, and the client observes close or unexpected response.

2. **Startup config errors**
   - `apps/relay/src/main.ts` must catch exceptions from `parseRelayHostConfig(process.env)` and `createRelayHost(...)`.
   - Invalid env/config must write only generic `relay failed to start\n` to stderr, no stack trace and no raw env value, then exit nonzero.
   - Add a subprocess test that runs the built or source entrypoint with an invalid/canary `PALANCAR_RELAY_ORIGIN`, asserts nonzero exit, stderr contains the generic failure line, and stderr/stdout do not contain the canary.
   - Keep normal startup behavior unchanged.

## Verification

Run and report actual outputs:

- `npm run lint -w @palancar/relay`
- `npm run typecheck -w @palancar/relay`
- `npm run test -w @palancar/relay`
- `npm run build -w @palancar/relay`
- `git diff --check -- apps/relay/src/host.ts apps/relay/src/main.ts apps/relay/test/relay-host.test.ts`

## Completion report

List changed files, verification outputs, unresolved risks. End with `DONE` only if complete.
