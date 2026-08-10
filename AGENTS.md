# Palancar agent instructions

Palancar is an Even Realities G2 application. The project is currently in its foundation phase; do not infer product behavior that has not been specified.

## Required G2 knowledge

Use the relevant local skills before designing or changing G2 behavior:

- `.agents/skills/g2-sdk-bridge/SKILL.md` for SDK contracts and bridge lifecycle.
- `.agents/skills/g2-display-ui/SKILL.md` for glasses layouts and display updates.
- `.agents/skills/g2-events-input/SKILL.md` for gestures, audio, IMU, status, and lifecycle.
- `.agents/skills/g2-dev-toolchain/SKILL.md` for manifests, networking, testing, and packaging.
- `.agents/skills/g2-simulator-automation/SKILL.md` for official simulator automation.

The `.codex/agents/g2-development.toml` specialist must apply these skills selectively and verify assumptions against the installed SDK.

## Source precedence

When sources disagree, prefer:

1. The installed `@evenrealities/even_hub_sdk` TypeScript declarations.
2. Current official documentation and release notes at `https://hub.evenrealities.com/docs`.
3. Results from physical G2 hardware on the declared Even App/firmware versions.
4. Results from the matching official simulator.
5. Example applications, including `../g2_openclaw`.

Do not copy G2 code blindly. `g2_openclaw` targets SDK 0.0.11 and contains stale assumptions and misspelled calls. Port behavior only after checking it against Palancar's installed SDK and product requirements.

## Initial platform baseline

- Node.js 22+
- `@evenrealities/even_hub_sdk` exactly `0.0.12`
- `@evenrealities/evenhub-cli` exactly `0.1.13`
- `@evenrealities/evenhub-simulator` `0.8.0`
- Even Hub edition `202601`

Pin production dependencies exactly. Treat SDK upgrades as deliberate migrations: inspect declarations and changelogs, update the manifest if needed, then test simulator, QR-sideloaded hardware, and a packaged build.

## Core guardrails

- Use `waitForEvenAppBridge()` and typed imports.
- Call `createStartUpPageContainer()` exactly once; use rebuild/upgrade calls afterwards.
- Design within the current 576×288 container contract and one event-capture target.
- Use `shutDownPageContainer(1)` for root-page exit confirmation.
- Keep secrets and third-party credentials on a backend.
- Declare only used permissions and maintain both the Even network whitelist and server CORS.
- Persist important state and recover from Android WebView suspension.
- Do not claim release readiness from simulator-only testing.
