# Generation foundation - Luna fix 3 handoff

## Objective

Close the remaining Sol `NEEDS WORK` findings for `@palancar/generation` without changing the package architecture. The package currently passes local lint/typecheck/tests/build, but Sol found cache, public-error redaction, completed-cache retention, mock-validation, and test-coverage defects.

## Writable scope

- `packages/generation/**`

Do not edit root manifests, lockfiles, apps, telemetry, relay, Terraform, docs, or commits.

## Required fixes

1. Suggestion dedupe/cache key:
   - The `suggest()` pending key must include everything in the turn key plus the consumed `englishTranslation`.
   - Add a regression where the same accepted turn gets two distinct service-produced translations and `suggest()` calls the provider separately with matching suggestions for each English translation.
2. Public error redaction:
   - `GenerationError` must not retain raw provider/sink/user content in `cause` or any other inspectable property.
   - Provider failures must become typed public `GenerationError('provider-failure')` with content-free message and no raw `cause`.
   - Update tests that currently require retaining `cause`; they must assert the opposite, including `String(error)`, `JSON.stringify(error)`, `Object.keys(error)`, and direct `(error as { cause?: unknown }).cause`.
3. Completed-cache retention:
   - Do not keep resolved translation/suggestion promises after settlement. Dedupe only active concurrent calls.
   - Remove or bypass count-bounded completed-cache retention; pending maps may remain while in-flight and must delete on both success and failure.
   - Add explicit tests that sequential repeated translate/suggest calls after the first settles call the provider again, while concurrent in-flight calls still dedupe.
4. Deterministic mock input validation:
   - `DeterministicMockProvider.translate()` and `.suggest()` must validate incoming provider inputs before recording or returning.
   - Reject invalid UUIDs, epoch <= 0, bad segment ID, nonpositive revision, unsupported target, empty transcript/translation, invalid gate policy version, and missing fields.
   - Use content-free typed/mock configuration errors; do not record invalid inputs.
   - Add tests that invalid inputs reject and do not increment valid recorded input snapshots.
5. Hostile getter coverage:
   - Add invocation counters to hostile accessor tests proving getters were not invoked when descriptor validation rejects them.
   - Keep existing typed error/redaction assertions.
6. Diff-check note:
   - Since the package is currently untracked, `git diff --check -- packages/generation` can be vacuous. Run it anyway, and also run a real scoped whitespace check over tracked/untracked generation source/test files, such as `find packages/generation -path '*/dist' -prune -o -path '*/node_modules' -prune -o -type f -print | xargs grep -n '[[:blank:]]$'`, reporting the actual result.

## Verification

Run:

- `npm run lint -w @palancar/generation`
- `npm run typecheck -w @palancar/generation`
- `npm run test -w @palancar/generation`
- `npm run build -w @palancar/generation`
- `git diff --check -- packages/generation`
- the non-vacuous scoped whitespace check described above

## Completion report

List changed files, actual verification results, unresolved risks, and `DONE` as the final line only if complete.
