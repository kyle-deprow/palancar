# Generated-language calibration implementation plan

## Objective

Accept proven-correct Spanish model output without weakening source-language gating, generated English/Turkish validation, mixed-language rejection, or production-calibrated semantics.

## Ownership and scope

The implementation worker may edit only:

- `packages/language-registry/src/types.ts`
- `packages/language-registry/src/registry.ts`
- `packages/language-registry/test/language-registry.test.ts`
- `apps/relay/src/provisional-language-boundary.ts`
- `apps/relay/test/provisional-language-boundary.test.ts`

This plan is read-only to the worker. Generation prompting, `GenerationService`, infrastructure, lifecycle evidence, credentials, and live Azure resources are out of scope.

## Required behavior

1. Keep an exact, deeply frozen generated-output target margin map in the development provisional profile: Spanish `0.01`, Turkish `0.04`.
2. Validate exactly the `es` and `tr` keys and threshold values in `[0,1]`; include the map in profile equality and symmetry.
3. Bump the provisional profile version and language-registry version for the exported calibration change.
4. Use the target-specific margin only for generated target-language full-text acceptance. Generated English, source/input classification, mixed/subwindow detection, score/reliability/length checks, and all production-calibrated paths retain their current behavior.
5. Bump the provisional boundary component version.
6. Add positive tests for the two observed correct Spanish margins and negative tests proving source Spanish, generated Turkish/English, wrong-top-language, unknown/unreliable, Catalan, Portuguese, mixed, and detector-error cases remain fail-closed.

## Verification

Run:

```sh
npm test --workspace @palancar/language-registry
npm test --workspace @palancar/relay -- --run test/provisional-language-boundary.test.ts
npm run typecheck --workspace @palancar/language-registry
npm run typecheck --workspace @palancar/relay
npm run build --workspace @palancar/language-registry
npm run build --workspace @palancar/relay
npm run lint --workspace @palancar/language-registry
npm run lint --workspace @palancar/relay
git diff --check
```

## Completion criteria

All checks pass, the write set is exact, Sol reports no must-fix findings, and both Spanish and Turkish live managed-identity canaries pass the unchanged generated-language validator.
