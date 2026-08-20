# Test-fixture language-boundary compatibility fix

## Objective

Restore root typechecking after the explicit provisional-language evidence and
required gate-boundary contracts were introduced, without changing fixture
decisions or weakening production-calibrated behavior.

## Approved edits

- In `packages/test-fixtures/src/index.ts`, constrain the private fixture
  input's optional `status` to
  `Exclude<LanguageClassificationStatus, 'calibrated' | 'provisional'>`.
  This makes the existing status branch construct only valid
  non-calibrated evidence under `exactOptionalPropertyTypes`. Do not cast and
  do not create provisional evidence in this fixture adapter.
- In both `evaluateLanguageGate` calls in
  `packages/test-fixtures/test/conformance.test.ts`, pass
  `boundaryMode: 'production-calibrated'`.
- Keep every expected decision and fixture payload unchanged. The fixture
  named `selected-target-provisional` describes a non-final transcript with
  calibrated controlled evidence; it is not ELD provisional evidence.
- Do not make `boundaryMode` optional, add a default, modify the registry or
  relay, or use `development-provisional` in this matrix.

## Ownership

The bounded worker may change only:

- `packages/test-fixtures/src/index.ts`
- `packages/test-fixtures/test/conformance.test.ts`

This plan is read-only to the worker. All other files are out of scope.

## Verification

```sh
npm run lint --workspace @palancar/test-fixtures
npm run typecheck --workspace @palancar/test-fixtures
npm run test --workspace @palancar/test-fixtures
npm run build --workspace @palancar/test-fixtures
git diff --check -- packages/test-fixtures
```

Completion requires all checks to pass and no fixture expectations to change.
