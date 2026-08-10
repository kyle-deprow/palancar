---
name: g2-simulator-automation
description: Run and automate the official EvenHub Simulator for G2 UI and interaction checks. Use for simulator launch, headless HTTP control, input injection, framebuffer or WebView screenshots, console inspection, CI smoke tests, and diagnosing simulator-versus-hardware discrepancies.
---

# G2 simulator automation

Use the official simulator `0.8.0` HTTP control plane. Do not port the custom `g2_openclaw` Vite `/_dev` API into Palancar unless the product independently needs an app-level test API.

## Start explicitly

Run the Palancar Vite server, then launch:

```bash
evenhub-simulator http://localhost:5173 --automation-port 9898
```

Keep automation bound to `127.0.0.1`. Supervise the simulator process and terminate only that exact child/PID during cleanup; do not use broad `pkill` patterns.

## Wait for readiness

Input sent before the first event-capturing container exists is silently dropped.

1. Log a stable Palancar readiness marker after successful `createStartUpPageContainer`.
2. Poll `GET /api/console` without `since_id` first, then poll `GET /api/console?since_id=<last-id>` with the latest non-negative ID until the marker appears. A negative `since_id` is invalid.
3. Allow at least roughly four seconds for startup, but prefer the marker over fixed sleeps.
4. Preserve startup logs before clearing the console buffer.

## Use the native endpoints

- `GET /api/ping`: health check.
- `GET /api/screenshot/glasses`: 576×288 RGBA framebuffer PNG.
- `GET /api/screenshot/webview`: host WebView PNG.
- `GET /api/console?since_id=N`: incremental console/error/fetch log capture.
- `DELETE /api/console`: clear logs after startup evidence is saved.
- `POST /api/input` with `{ "action": "click" | "double_click" | "up" | "down" }`: inject input.

Consult `evenhub-simulator --help` and the official docs before relying on any additional endpoint or option.

## Assert behavior, not file size

- Decode glasses screenshots as RGBA.
- Use alpha (`alpha > 0`) to count lit pixels; RGB alone cannot distinguish the green foreground/background representation reliably.
- Compare relevant regions or semantic states instead of whole-image byte sizes.
- Read console entries for uncaught errors, rejected promises, failed fetches, and SDK validation failures.
- Capture before/after frames around each injected action.

Minimum smoke journey:

1. Boot and observe the readiness marker.
2. Assert the framebuffer has lit pixels and no boot errors.
3. Inject the primary press and verify the intended state/display change.
4. Inject root double press and verify the system exit-confirmation display appears.
5. Save logs and screenshots as test artifacts on failure.

## Respect simulator limits

- Treat the simulator as layout and logic tooling, not a hardware emulator.
- Do not trust it for pixel-perfect fonts/greyscale, BLE timing, hardware image limits or compressed transfer, real status events, production permissions, or background lifecycle.
- The simulator uses host audio and emits 100 ms PCM events (3,200 bytes at 16 kHz S16LE mono); application audio code must still be chunk-agnostic.
- Validate release-critical behavior on physical glasses and in production-equivalent builds.

Official reference: [EvenHub Simulator](https://hub.evenrealities.com/docs/test/simulator).
