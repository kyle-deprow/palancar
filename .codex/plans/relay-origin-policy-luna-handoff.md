# Relay browser origin policy — Luna handoff

## Objective

Implement a pure, strict parser and evaluator for the relay's browser HTTP CORS and WebSocket Origin policy. Host integration is deliberately out of scope.

## Files you may change

- `apps/relay/src/origin-policy.ts` (new)
- `apps/relay/test/origin-policy.test.ts` (new)

## Files you must not change

- Every other file in the repository, including `host.ts`, package files, Terraform, and docs.
- Do not commit.

## Required public contract

```ts
export interface BrowserOriginPolicy {
  readonly allowedOrigins: readonly string[];
  readonly allowNullOrigin: boolean;
}

export type BrowserOriginDecision =
  | { readonly kind: "originless" }
  | { readonly kind: "allowed"; readonly origin: string }
  | { readonly kind: "rejected" };

export function parseBrowserOriginPolicy(env: NodeJS.ProcessEnv): BrowserOriginPolicy;
export function evaluateBrowserOrigin(
  policy: BrowserOriginPolicy,
  originHeader: string | undefined,
): BrowserOriginDecision;
```

## Requirements

- Parse only `PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON` and `PALANCAR_ALLOW_NULL_BROWSER_ORIGIN`.
- Missing allowed-origins JSON means an empty list. Otherwise it must be a JSON array with 0–32 unique strings.
- Each allowed origin must be a canonical lower-case-host `https://` origin with no username, password, path beyond `/`, query, fragment, trailing slash in the configured string, wildcard, whitespace, default port, or duplicate. Reject `http`, `ws`, `wss`, `file`, opaque, and `null` values.
- `PALANCAR_ALLOW_NULL_BROWSER_ORIGIN` accepts exactly lowercase `true` or `false`; missing means false. Reject all other strings.
- Any invalid configuration throws `TypeError` with exact message `Invalid browser origin policy configuration.` and no raw input/cause.
- Returned policy and its origin array are frozen.
- Evaluation semantics:
  - missing Origin header => `{kind:"originless"}` (allowed for trusted operations tooling; bearer/ticket checks remain separate);
  - exact configured origin => `{kind:"allowed", origin}`;
  - literal `null` => allowed only when policy flag is true and then returned as `{kind:"allowed", origin:"null"}`;
  - every other header, including comma/multiple values, mixed case, whitespace, trailing slash, or a serialized lookalike => rejected.
- Evaluation must not parse or normalize the request header; exact equality is intentional.
- Test every rule, immutability, and that canary invalid input does not appear in thrown error serialization or stack.

## Verification

Run and report actual output from:

```bash
npm run test --workspace @palancar/relay -- --run test/origin-policy.test.ts
npm run typecheck --workspace @palancar/relay
npm run lint --workspace @palancar/relay
```

## Escalation

If the exact contract requires an out-of-scope edit, stop and report it. Do not integrate into the host.

## Completion report

List changed files, checks, and unresolved risks. End with `DONE` only if complete.
