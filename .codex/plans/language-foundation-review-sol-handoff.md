# Language foundation review handoff (GPT-5.6 Sol)

## Role

Perform a read-only adversarial architecture, security, correctness, and maintainability review of the uncommitted language-foundation slice. Do not edit files, install packages, commit, or mutate Azure.

## Required reading

- `AGENTS.md`
- `.codex/plans/language-foundation-luna-handoff.md`
- `docs/implementation-plan.md`, especially Target-language registry and gate
- `docs/adr/0000-language-registry.md`
- Root `package.json`, lockfile/tooling files, and every file under:
  - `packages/language-registry/`
  - `packages/test-fixtures/`

This slice is G2-independent and does not design or change G2 behavior, so no
G2 implementation skill is required for this review.

## Review baseline

The parent independently ran and passed:

- `npm run lint`
- `npm run typecheck`
- `npm test` (18 tests: 12 registry, 6 conformance)
- `npm run build`
- Node 22 ESM imports for both public package names after build
- `git diff --check` for tracked edits; untracked candidate files were explicitly
  scanned for whitespace errors because an unstaged diff does not include them

Before the re-review, the parent will run `git diff --check` after staging with
intent-to-add, or `git diff --cached --check` after normal staging, so the
appropriate diff covers every candidate file.

TypeScript was deliberately corrected from the initially incompatible 7.0.2 to 6.0.3 because `typescript-eslint@8.66.0` declares support below TypeScript 6.1.

## Acceptance criteria

1. Root npm workspace/tooling is deterministic and suitable for upcoming `apps/*`, `packages/*`, and `tools/*` work without inventing unrelated architecture.
2. Spanish (`es`) and Turkish (`tr`) have symmetric registry data and tests; neither receives a privileged policy branch.
3. Only a final selected-target result at or above its registry threshold has `generationAllowed: true`.
4. Provisional, English, mixed, supported-unselected, unsupported, missing/invalid/low-confidence evidence never permits generation.
5. Unsupported selected targets are rejected before evidence is evaluated.
6. Registry policy and public state are immutable in practice, including nested arrays.
7. Controlled fixtures are typed and explicitly policy-only; they do not claim detector accuracy.
8. Tests actually cover the required policy matrix and cannot accidentally pass while one target lacks symmetric evidence.
9. Types and API names are consistent with the planning contract or any deviation is clearly justified.
10. No secret, generated build output, accidental broad ignore, unsafe dependency range, or packaging hazard was introduced.
11. The ADR accurately describes code and future extension requirements.

## Output

Return findings grouped as:

- Must-Fix
- Should-Fix
- Nits

Every finding must include file/path evidence, impact, and an exact recommended correction. Then end with exactly `READY` if there are no Must-Fix findings, otherwise `NEEDS WORK`.
