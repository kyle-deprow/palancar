# G2 client bridge/scaffold — Sol review handoff

Perform a read-only adversarial review of the current G2 client bridge and project scaffold. Do not edit files.

## Scope

- `apps/g2-client/app.json`
- `apps/g2-client/relay-origin.json`
- `apps/g2-client/scripts/validate-relay-origin.mjs`
- `apps/g2-client/package.json`
- `apps/g2-client/tsconfig*.json`
- `apps/g2-client/vite.config.ts`
- `apps/g2-client/index.html`
- `apps/g2-client/src/bridge/**`
- `apps/g2-client/src/main.ts`
- `apps/g2-client/test/bridge.test.ts`
- relevant `package-lock.json` entries

Ignore concurrent `src/state/**` work. Display modules were separately Sol-reviewed READY; consider their startup conversion only where it affects the bridge.

## Required behavior

- Exact versions: SDK `0.0.12`, CLI `0.1.13`, simulator `0.8.0`, Vite `8.1.5`, Vitest `4.1.10`; root TypeScript `6.0.3` may be used explicitly while the CLI retains its isolated TypeScript 5 peer.
- `waitForEvenAppBridge()` precedes exactly one `createStartUpPageContainer()` attempt per WebView lifetime.
- Startup uses the validated Starting layout. A non-success SDK result or throw produces a typed failure with no automatic second startup attempt.
- The readiness marker is emitted only after successful startup and the one retained event subscription.
- System double-click from a valid physical source requests `shutDownPageContainer(1)` and does not clean up immediately because the wearer may cancel confirmation.
- `SYSTEM_EXIT_EVENT` and `ABNORMAL_EXIT_EVENT` unsubscribe/cleanup exactly once. Event serialization must not race shutdown.
- The browser entrypoint handles startup failure without logging secrets/content or producing unhandled rejection.
- The manifest follows the committed plan: package ID `com.palancar.translate`, version `0.1.0`, edition `202601`, min app `2.0.0`, min SDK `0.0.12`, entrypoint `index.html`, English UI, only network and g2-microphone permissions with descriptions.
- The development relay origin is exactly `http://localhost:8787`; production must be a single credential-free HTTPS origin with no wildcard. Manifest whitelist and reviewed origin artifact must match.
- Build produces `dist/index.html`; declaration build has real inputs and no source maps.
- No app bundle secret, credential, Azure endpoint assumption, or query-string ticket.

Use the local G2 SDK bridge, event/input, display, toolchain, and simulator skills as normative implementation guidance. Inspect installed SDK types where useful.

Run focused tests/typecheck/build and `npm ls` checks as needed. Attempt `npm run pack --workspace @palancar/g2-client` if the implementation is ready enough, and inspect the package archive for secrets, `.env`, and source maps without modifying tracked files.

Return findings ordered Must-Fix, Should-Fix, Nits with precise references. End with exactly `READY` or `NEEDS WORK`. `READY` means no Must-Fix or Should-Fix remains.
