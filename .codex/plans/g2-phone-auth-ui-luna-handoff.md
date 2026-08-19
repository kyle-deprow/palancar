# G2 phone authentication UI — Luna handoff

## Objective

Implement the redacted phone-WebView authentication UI component and external stylesheet, independent of runtime/controller composition.

## Files you may change

- `apps/g2-client/src/phone-ui.ts` (new)
- `apps/g2-client/src/phone-ui.css` (new)
- `apps/g2-client/test/phone-ui.test.ts` (new)

## Files you must not change

- Every other file, including index.html, main, auth/state/runtime/transport, package files, docs, and lockfile. Do not commit.

## Expected DOM IDs

Bind pre-existing elements by these exact IDs and fail with generic `Phone authentication UI unavailable` if any are absent/wrong element capability:

- `palancar-phone-app`
- `palancar-auth-status`
- `palancar-pairing-form`
- `palancar-pairing-code`
- `palancar-pairing-submit`
- `palancar-storage-actions`
- `palancar-storage-retry`
- `palancar-storage-reset`
- `palancar-enrolled-actions`
- `palancar-revoke-start`
- `palancar-revoke-confirm`
- `palancar-revoke-cancel`

## Public API

Export redacted state:

```ts
export type PhoneAuthViewState =
  | { readonly status:"starting"|"checking"|"enrolling"|"revoking" }
  | { readonly status:"required"; readonly reason: AuthRequiredReason }
  | { readonly status:"ready" }
  | { readonly status:"storage-error" };

export interface PhoneAuthViewCallbacks {
  readonly onEnroll: (pairingCode: string) => void | Promise<void>;
  readonly onRetryStorage: () => void | Promise<void>;
  readonly onResetEnrollment: () => void | Promise<void>;
  readonly onRevoke: () => void | Promise<void>;
}

export interface PhoneAuthView {
  render(state: PhoneAuthViewState): void;
  dispose(): void;
}

export function createPhoneAuthView(options: {
  readonly document?: Document;
  readonly callbacks: PhoneAuthViewCallbacks;
}): PhoneAuthView;
```

Import only the redacted `AuthRequiredReason` type from auth/types and canonical pairing validator from contracts.

## Behavior

- On construction attach each listener exactly once; `dispose` removes all, clears/blurs input, hides/disables actions, is idempotent, and callbacks never fire afterward.
- Pairing form visible only for required; storage actions only storage-error; enrolled action only ready; revoke confirmation controls only after first revoke start while ready.
- Render uses fixed copy selected from state/reason. Never takes arbitrary server/user text. `aria-live` status updates remain concise and content-free.
- Required pairing input contract: no `name`; text; minlength/maxlength 26; exact canonical Crockford pattern; autocomplete off; autocapitalize characters; autocorrect off; spellcheck false. Assert/repair these safe attributes at construction.
- Submit accepts only exact canonical code. Never trim, uppercase, regroup, substitute, or echo it.
- On valid submit, synchronously copy the string into the callback argument, then clear input and blur it before invoking callback. Never place code in status, attributes, errors, promises, or retained component fields.
- Invalid submit does not call callback or expose value; show fixed safe validation copy and clear/blur input.
- Prevent double callback while one async callback is pending. Re-enable only if current rendered state permits it and view is active.
- Revoke requires two explicit button activations: first reveals fixed confirmation; confirm invokes callback once; cancel returns to ready controls. Rendering any other state cancels confirmation.
- Reset/retry/revoke have the same pending/double-submit safety and fixed error swallowing; callback rejection never surfaces raw error and leaves fixed safe status.
- `render` snapshots contain no credentials, pairing code, IDs, transcript, translation, or suggestions and are not retained by reference.

## Stylesheet

- External CSS only; no URL loads, fonts, images, generated user content, or animations.
- Phone-friendly high-contrast layout, minimum 44px controls, responsive width, hidden via `[hidden]`, visible focus, reduced-motion safe.
- Do not attempt glasses styling; this is WebView-only.

## Tests

Use minimal injected fake DOM objects or deterministic test doubles—do not add jsdom or dependencies. Cover element validation, attributes, every render state/reason, visibility/disabled/accessibility, exact code acceptance/rejection without normalization, clear+blur before callback, no code retention/exposure, async double-submit, callback rejection, two-step revoke/cancel, retry/reset, repeated render/listener exact-once, dispose, and canary absence from status/serialized view/errors.

## Verification

Run:

```bash
npm run test --workspace @palancar/g2-client -- --run test/phone-ui.test.ts
npm run typecheck --workspace @palancar/g2-client
npm run lint --workspace @palancar/g2-client
```

## Escalation

Stop if index.html/main or a dependency is required. Do not broaden scope.

## Completion report

List files/checks/risks. End `DONE` only if complete.
