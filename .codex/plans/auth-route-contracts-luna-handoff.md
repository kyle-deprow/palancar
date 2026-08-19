# Authentication route request contracts — Luna handoff

## Objective

Add the two closed empty-object request contracts required for credential rotation begin and confirmation, with validators and symmetric controlled fixtures.

## Files you may change

- `packages/contracts/src/auth.ts`
- `packages/contracts/src/validation.ts`
- `packages/contracts/test/contracts.test.ts`
- `packages/test-fixtures/src/protocol.ts`
- `packages/test-fixtures/test/protocol-conformance.test.ts`

## Files you must not change

- Every other repository file. Do not edit relay/security/client/package files or commit.

## Required exports

In `auth.ts`, export:

```ts
export const CredentialRotationRequestSchema = Type.Object({}, { additionalProperties: false });
export type CredentialRotationRequest = Static<typeof CredentialRotationRequestSchema>;
export const CredentialRotationConfirmationRequestSchema = Type.Object({}, { additionalProperties: false });
export type CredentialRotationConfirmationRequest = Static<typeof CredentialRotationConfirmationRequestSchema>;
```

In `validation.ts`, export exact boolean predicates and throwing assertions:

- `isCredentialRotationRequest`
- `assertCredentialRotationRequest`
- `isCredentialRotationConfirmationRequest`
- `assertCredentialRotationConfirmationRequest`

Use the repository's existing schema helpers and content-free `ContractValidationError` convention.

In controlled fixtures export deeply frozen exact empty objects:

- `CREDENTIAL_ROTATION_REQUEST`
- `CREDENTIAL_ROTATION_CONFIRMATION_REQUEST`

## Requirements

- Each request accepts exactly a plain schema object with zero enumerable fields under TypeBox semantics.
- Reject `null`, arrays, strings, numbers, symbols represented through unknown values, and objects with any own field including credential/secret aliases.
- Assertion results preserve/reference the valid fixture exactly as existing assertions do.
- Tests cover schemas, predicates, assertions, additional properties, and ensure credential canary property values never appear in serialized thrown error or stack.
- Keep all existing response schemas and semantics unchanged.
- Follow current quote/format conventions in each package and preserve strict typecheck/lint.

## Verification

Run and report:

```bash
npm run test --workspace @palancar/contracts
npm run test --workspace @palancar/test-fixtures
npm run typecheck --workspace @palancar/contracts
npm run typecheck --workspace @palancar/test-fixtures
npm run lint --workspace @palancar/contracts
npm run lint --workspace @palancar/test-fixtures
```

## Escalation

Stop if an out-of-scope change is required. Do not broaden the API.

## Completion report

List changed files and actual checks. End with `DONE` only when complete.
