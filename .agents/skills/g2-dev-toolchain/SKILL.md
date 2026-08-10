---
name: g2-dev-toolchain
description: Configure, build, test, sideload, package, and upgrade an Even Hub G2 app. Use for Node/Vite setup, dependency pins, `app.json`, permissions and network whitelists, EvenHub CLI commands, QR testing, simulator setup, `.ehpk` packaging, or release-readiness checks.
---

# G2 development toolchain

Use repeatable, versioned builds and validate through progressively more realistic environments.

## Pin the initial Palancar baseline

- Node.js: 22 or newer. The current SDK engine also accepts Node 20.
- `@evenrealities/even_hub_sdk`: exactly `0.0.12`.
- `@evenrealities/evenhub-cli`: exactly `0.1.13` as a project dev dependency.
- `@evenrealities/evenhub-simulator`: `0.8.0` for the matching current simulator.
- TypeScript + Vite with a browser-only bundle.

Never use `latest` in committed dependencies. Before upgrading, read every intervening changelog, inspect the new `.d.ts`, update `min_sdk_version` only when justified, and rerun simulator plus real-device tests.

## Keep the app structure conventional

```text
palancar/
├── .agents/skills/
├── .codex/agents/
├── public/icon.png
├── src/main.ts
├── app.json
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

Use `npm` and commit `package-lock.json`. Build to `dist/`. Keep application and SDK code browser-compatible; no Node-only modules in the WebView bundle.

## Maintain a valid manifest

Use the current schema:

- `package_id`: lowercase reverse-domain identifier; each segment starts with a letter; no hyphens.
- `edition`: `"202601"` until an official migration changes it.
- `name`: at most 20 characters.
- `version`: three-part semver.
- `min_app_version`: required; initial baseline `"2.0.0"`.
- `min_sdk_version`: required and matched to the SDK features actually used.
- `entrypoint`: must exist inside `dist/`.
- `permissions`: array of objects with a non-empty `name` and `desc`.
- `supported_languages`: values from the current supported set.

Declare only capabilities the app uses. Supported permissions currently include `network`, `location`, `g2-microphone`, `phone-microphone`, `album`, and `camera`.

For `network`, list each allowed origin in `whitelist`. The whitelist is an Even-side permission gate, not a CORS bypass; the backend must also return valid browser CORS headers. Use HTTPS/WSS in production and never ship credentials in URLs or the bundle.

## Use standard commands

```bash
npm install
npm run dev
npx evenhub qr --url "http://<lan-ip>:5173"
npm run build
npx evenhub pack app.json dist -o palancar.ehpk
```

Use the machine's LAN IP for QR sideloading, not `localhost` or `0.0.0.0`. Keep development server exposure intentional and firewall-aware.

## Test in layers

1. Run type-checks and unit tests.
2. Run the current simulator for layout and event logic.
3. Use simulator headless automation for repeatable smoke tests.
4. QR-sideload to real G2 hardware for permissions, BLE behavior, fonts, audio, lifecycle, and timing.
5. Test a private `.ehpk` build.
6. Complete beta/production-equivalent checks before release.

The simulator is not a hardware emulator. Do not accept simulator-only evidence for visual QA, image-transfer behavior, device status, background suspension, BLE timing, or production permissions.

## Package safely

- Ensure `dist/index.html` matches `app.json.entrypoint`.
- Exclude secrets, source maps unless intentional, `.env` files, and local credentials.
- Add `dist/`, `node_modules/`, simulator screenshots, and `*.ehpk` to `.gitignore` unless a specific artifact policy says otherwise.
- Validate root double-press shows the system exit confirmation.
- Record the tested SDK, CLI, simulator, Even App, firmware, and hardware versions for releases.

Official references: [quickstart](https://hub.evenrealities.com/docs/get-started/quickstart/index), [packaging](https://hub.evenrealities.com/docs/ship/packaging), [CLI](https://hub.evenrealities.com/docs/reference/cli), [networking](https://hub.evenrealities.com/docs/build/networking), and [versioning](https://hub.evenrealities.com/docs/reference/versioning).
