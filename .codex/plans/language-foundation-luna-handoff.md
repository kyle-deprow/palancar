# Luna implementation handoff: language foundation

## Assignment

- Model: GPT-5.6 Luna
- Reasoning: xhigh
- Objective: Implement the first cloud-independent Palancar increment: npm workspace configuration, equal registry-driven Spanish/Turkish target support, a deterministic finalized-transcript language gate using controlled evidence, fixtures/tests, and ADR 0000.
- Done when: All required files exist, exact dependencies are locked, lint/typecheck/test/build pass, and the final report lists real command output and ends with `DONE`.

You are not alone in the repository. Do not revert or modify files outside the write scope. Existing planning documents are read-only inputs.

## Required inputs

Read completely before editing:

- `/home/dev/repos/palancar_ws/palancar/AGENTS.md`
- `/home/dev/repos/palancar_ws/palancar/docs/implementation-plan.md`
- `/home/dev/repos/palancar_ws/palancar/docs/real-time-translation-plan.md`

## Files you may create or change

- `/home/dev/repos/palancar_ws/palancar/package.json`
- `/home/dev/repos/palancar_ws/palancar/package-lock.json`
- `/home/dev/repos/palancar_ws/palancar/tsconfig.base.json`
- `/home/dev/repos/palancar_ws/palancar/eslint.config.mjs`
- `/home/dev/repos/palancar_ws/palancar/.gitignore`
- `/home/dev/repos/palancar_ws/palancar/packages/language-registry/**`
- `/home/dev/repos/palancar_ws/palancar/packages/test-fixtures/**`
- `/home/dev/repos/palancar_ws/palancar/docs/adr/0000-language-registry.md`

## Files/actions out of scope

- Do not edit `AGENTS.md`, `.agents/**`, `.codex/**`, existing planning documents, apps, tools, infra, or any future package.
- Do not create protocol-v1 schemas, Azure code, G2 bridge code, a real language detector, translation code, or audio handling.
- Do not run Azure commands, git commands, or commit.

## Workspace requirements

- Use npm workspaces and Node.js 22. The root package is private.
- Pin exact versions; do not use `^`, `~`, tags, or ranges for committed dependencies.
- Use these exact root development versions unless npm proves incompatibility and you stop to report it:
  - `typescript`: `6.0.3`
  - `vitest`: `4.1.10`
  - `eslint`: `10.8.1`
  - `typescript-eslint`: `8.66.0`
- Provide root scripts: `lint`, `typecheck`, `test`, and `build`, operating across workspaces with `--if-present` where appropriate.
- Strict TypeScript, ESM, no emitted JS during typecheck, and no `any`.
- Ignore `node_modules`, package build output, coverage, `.env*`, Terraform local/generated files and plans, simulator screenshots, `*.ehpk`, and local evidence artifacts. Do not ignore committed source fixtures or `.terraform.lock.hcl`.

## Registry contract

Implement an immutable/read-only registry with exactly these initial target entries:

- Spanish: code `es`, display name `Spanish`, candidate transcription hint `es`, confidence threshold `0.80`, mixed policy `reject`.
- Turkish: code `tr`, display name `Turkish`, candidate transcription hint `tr`, confidence threshold `0.80`, mixed policy `reject`.

Required exported concepts:

- `TargetLanguage = 'es' | 'tr'`.
- `LanguageDefinition` matching the implementation plan.
- `LanguageEvidence` with `detectedLanguage`, optional `confidence`, `text`, `detectorVersion`, and source `transcription-metadata | text-classifier | controlled-fixture`.
- A result that distinguishes `provisional`, `target`, `mixed`, `english`, `supported_unselected`, `unsupported`, and `uncertain`, and always contains `generationAllowed`.
- Generic registry lookup/list helpers. Core gate code must not branch on Spanish versus Turkish; it may compare selected/detected registry codes generically.

## Gate behavior

- A provisional revision always returns `provisional` and `generationAllowed: false`.
- A final selected-target result at or above that target's threshold returns `target` and `generationAllowed: true`.
- Final English returns `english` and false.
- Final evidence for the other enabled target returns `supported_unselected` and false.
- Final mixed evidence returns `mixed` and false.
- A missing language or confidence below the selected registry threshold returns `uncertain` and false.
- Another confidently detected language returns `unsupported` and false.
- Reject a selected target that is not in the registry.
- Do not log or mutate evidence text.

## Controlled fixtures and tests

- `packages/test-fixtures` exports typed, controlled `LanguageEvidence` fixture cases; it does not claim detector accuracy.
- Include final Spanish, Turkish, English, mixed, unsupported, low-confidence, missing-language, and provisional target cases.
- Symmetric tests run Spanish-selected and Turkish-selected behavior:
  - each selected target accepts itself;
  - each rejects English, mixed, and the other supported target;
  - partial selected-target evidence never allows generation;
  - low/missing confidence/language is uncertain;
  - unsupported target selection throws/rejects;
  - registry output cannot be mutated through its public API.
- Avoid brittle assertions on implementation-private structure.

## ADR requirements

ADR 0000 records:

- one selected target per session from a registry;
- no Spanish/Turkish branches in gate code;
- v1 mixed-language rejection;
- transcription hints are advisory and cannot authorize generation;
- controlled fixtures test policy only; detector accuracy is deferred to the physical-G2 spike;
- extension rule: every enabled target receives the same conformance suite and independent measured thresholds.

## Verification

Run from `/home/dev/repos/palancar_ws/palancar` and report actual results:

```text
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

Also run `git diff --check` without staging or committing.

## Escalation

Stop and report instead of guessing if an exact dependency cannot install on Node 22, a required behavior conflicts with the planning documents, or a required file outside the write scope must change.

## Completion report

List changed files, implementation summary, exact verification results, and unresolved issues. End with `DONE` only when everything above passes.
