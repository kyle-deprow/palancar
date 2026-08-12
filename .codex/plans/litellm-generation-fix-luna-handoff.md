# Luna handoff — LiteLLM generation provider review fixes

## Objective

Fix Sol review findings for the existing LiteLLM generation provider slice.

## Files you may change

- `packages/generation/src/litellm.ts`
- `packages/generation/test/litellm-provider.test.ts`
- `.codex/plans/litellm-generation-luna-handoff.md`

## Files you must not change

- Any other file.
- Do not touch untracked future handoffs:
  - `.codex/plans/litellm-relay-host-luna-handoff.md`
  - `.codex/plans/litellm-proxy-luna-handoff.md`

## Required fixes

1. Accept successful response messages with `refusal: null` and/or
   `tool_calls: null`. Continue rejecting non-null refusal or tool calls.
   Add regression tests.
2. On non-2xx HTTP response, cancel the response body or abort the controller
   before throwing the generic provider failure.
3. Add tests for timeout/abort behavior.
4. Add tests for non-object response envelopes.
5. In `.codex/plans/litellm-generation-luna-handoff.md`, change “recommended
   default 15_000” to “default 15_000”.

## Verification

Run and report actual output:

```sh
npm run lint -w @palancar/generation
npm run typecheck -w @palancar/generation
npm run test -w @palancar/generation
```

## Completion report

Report changed files, verification output, unresolved issues. End with `DONE`
only if complete.
