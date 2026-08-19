# Luna agent handoff: security operations pacing and credential reuse

## Assignment

- Profile: `luna_xhigh`
- Objective: Make the live two-language security smoke deterministic under the relay's durable audio and pairing quotas.
- Done when: the smoke uses one pairing redemption, obtains one fresh ticket per target from that credential, never catches up audio frames after a slow acknowledgement, removes character-set language guessing, and focused tests/lint/typecheck/build all pass.

## Scope

- Inspect/use: `tools/security-ops/src/index.ts`, `tools/security-ops/test/security-ops.test.ts`, contracts imported by those files, and the Sol findings in the task prompt.
- Do not inspect/change: `.env`, Terraform files, Azure resources, generated `dist`, package manifests/lockfiles, or any file outside `tools/security-ops/src/index.ts` and `tools/security-ops/test/security-ops.test.ts`. Do not make network or live Azure/OpenRouter calls.
- Write permission: exactly `tools/security-ops/src/index.ts` and `tools/security-ops/test/security-ops.test.ts`.

## Method and evidence

- Required behavior:
  1. Split installation-credential redemption from ticket issuance. The smoke command must issue/redeem exactly one pairing credential, then request a separate single-use session ticket immediately before each sequential `es` and `tr` target session.
  2. Pace every audio frame after the first by at least 100 ms measured from the preceding frame acknowledgement. Never catch up relative to a timestamp captured before setup or a delayed acknowledgement. Keep exactly 18 frames of 1,600 samples.
  3. Remove `targetTextLooksSelected` and its use. Continue validating nonempty, distinct English/target suggestion fields and all event correlation/language-decision fields.
  4. Preserve fixed content-free public errors and bounded output.
  5. Update fakes so response sequencing is one pairing redemption followed by two ticket requests; assert exactly three HTTP requests, one pairing issue, one redemption, two tickets, and both targets.
  6. Add deterministic delayed-ack timing evidence that would fail the old catch-up schedule and proves no third 8,000-sample reservation falls inside the same strict rolling one-second interval. Model asynchronous final events and at least one irrelevant partial without exposing content in command output. Preserve duplicate rejection coverage.
  7. Do not loosen protocol correlations, message schema validation, close validation, timeouts, or secret handling.
- Required checks: `npm run lint --workspace @palancar/security-ops`, `npm run typecheck --workspace @palancar/security-ops`, `npm test --workspace @palancar/security-ops`, and `npm run build --workspace @palancar/security-ops` from repository root.
- Evidence to return: changed symbols/files, test names added or changed, exact test/check results, and any unresolved risk.
- Stop and escalate if: satisfying the requirements needs changes outside the two owned files, protocol/interface design changes, or access to secrets/live services.

## Response format

1. Result: status
2. Evidence: concise bullets with file/symbol references
3. Checks run: commands and outcomes
4. Blockers or uncertainty: none or explicit details
5. Final line `DONE` only if all requirements and checks are complete
