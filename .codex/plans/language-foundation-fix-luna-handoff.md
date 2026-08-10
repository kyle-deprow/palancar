# Language foundation fix handoff (GPT-5.6 Luna xhigh)

## Scope and ownership

You are the implementation worker for this review-fix pass. You are not alone in the repository; preserve all unrelated work and do not revert other edits. Do not commit or mutate Azure.

You may edit only:

- `package.json`
- `package-lock.json` (only via `npm install`)
- `.codex/plans/language-foundation-review-sol-handoff.md` for the stale skill/baseline wording
- `packages/language-registry/**`
- `packages/test-fixtures/**`
- `docs/adr/0000-language-registry.md` only if behavior changes require it

Read the original implementation handoff, Sol review handoff, and current files before editing.

## Must-fix findings

1. **Invalid confidence must never authorize generation.** A confidence is sufficient only if it is finite, in the closed interval `[0, 1]`, and at or above the selected target threshold. Add symmetric tests proving values above 1, below 0, `NaN`, positive infinity, and negative infinity all yield `uncertain` with generation disabled.
2. **Complete workspace globs.** Root workspaces must be exactly `apps/*`, `packages/*`, and `tools/*`, in that order. Regenerate the lockfile.
3. **Truthful Node engine.** Pin root engine to `>=22.13.0 <23` and regenerate the lockfile.
4. **Usable package exports.** Both packages must export runtime JavaScript from `./dist/index.js` and declarations from `./dist/index.d.ts`; no package runtime export may point to TypeScript source. Add dependency-aware lifecycle orchestration so a clean `npm ci` followed independently by root lint, typecheck, test, or build works. In particular, `@palancar/test-fixtures` must build `@palancar/language-registry` before commands that resolve its public package export. Keep orchestration narrow and avoid a new build framework.
5. **Genuinely symmetric conformance fixtures.** Provide an aligned policy matrix for each selected registry target, including:
   - final selected target at/above threshold -> exact `target`, generation true
   - provisional selected target -> exact `provisional`, generation false
   - low-confidence selected target -> exact `uncertain`, generation false
   - English -> exact `english`, generation false
   - mixed -> exact `mixed`, generation false
   - unsupported detected language -> exact `unsupported`, generation false
   - missing language/confidence -> exact `uncertain`, generation false
   - every other enabled target -> exact `supported_unselected`, generation false

   Tests must validate fixture selection metadata rather than silently overwrite it. Spanish and Turkish need aligned target/provisional/low-confidence text evidence; genuinely shared negative evidence may be generated per selected target with explicit expected decisions. Invalid confidence boundary tests may live in the registry test suite but must run for both selected targets.

## Should-fix findings

- Update `.codex/plans/language-foundation-review-sol-handoff.md` to remove the nonexistent aggregate G2 skill requirement and state this slice is G2-independent.
- Correct the whitespace baseline wording: untracked files were explicitly scanned, rather than claiming `git diff --check` covered them. The parent will stage with intent-to-add or stage normally before the re-review so `git diff --check --cached` covers the whole candidate slice.

## Required verification

Run and report all:

1. `npm install`
2. `npm run lint`
3. `npm run typecheck`
4. `npm test`
5. `npm run build`
6. After build, a Node 22 ESM import probe for both public package names that confirms real runtime exports work.
7. `git diff --check`

Also reason explicitly about clean-clone command behavior: no command may rely on ignored `dist/` directories left over from an earlier run. Return changed paths, test counts, any residual risk, and `DONE` only when all criteria pass.

## Final re-review cleanup

Sol returned `READY` with two non-blocking corrections that must also be closed:

1. In `.codex/plans/language-foundation-review-sol-handoff.md`, state accurately: after intent-to-add, run `git diff --check`; after normal staging, run `git diff --cached --check`.
2. Strengthen the unsupported-selected-target ordering test with typed `LanguageEvidence` whose property getters throw if evidence is inspected. Assert `evaluateLanguageGate` still throws the unsupported-target `RangeError`, proving selection is rejected before any evidence access.

Run lint, typecheck, tests, and `git diff --check` again. Do not commit.
