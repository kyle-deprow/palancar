---
name: g2-sdk-bridge
description: Integrate and verify the Even Realities EvenHub JavaScript bridge for G2 apps. Use for `@evenrealities/even_hub_sdk` setup, bridge lifecycle, page-container calls, storage, networking boundaries, SDK upgrades, or questions about which APIs and types actually exist.
---

# G2 SDK bridge

Build against the installed SDK contract, not remembered examples.

## Establish the contract first

1. Read `package.json`, `package-lock.json`, and `app.json`.
2. Run `npm list @evenrealities/even_hub_sdk` when dependencies are installed.
3. Inspect the installed package's `dist/index.d.ts` for exact signatures and field names.
4. Consult the official [Even Hub documentation](https://hub.evenrealities.com/docs) and npm changelog for the installed version.
5. Keep `app.json.min_sdk_version` aligned with the first SDK version required by the code.

The initial Palancar baseline is exactly SDK `0.0.12`. Re-audit this skill before changing that pin. The SDK is pre-1.0 and additive public surface can arrive in `0.0.x` releases.

Treat evidence in this order: installed TypeScript declarations, official current docs and changelog, real-hardware behavior, simulator behavior, then examples from other repositories. Never copy undocumented calls or cast through `any` merely because another app does.

## Use the correct architecture

- Run Palancar logic in the phone's Even Realities App WebView: Chromium on Android, WKWebView on iOS.
- Treat the glasses as a Bluetooth-connected display and input peripheral; no Palancar JavaScript runs on the glasses.
- Use ordinary browser `fetch`, WebSocket, and storage APIs for application networking and state.
- Use `EvenAppBridge` only for Even-host and glasses capabilities.
- Keep secrets on a backend. Released `.ehpk` contents are extractable.

## Initialize once

Prefer the readiness helper:

```ts
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

const bridge = await waitForEvenAppBridge()
```

Do not construct bridge instances. Use `EvenAppBridge.getInstance()` only after readiness is already guaranteed.

## Use the supported lifecycle

1. Call `createStartUpPageContainer(...)` exactly once.
2. Check for `StartUpPageCreateResult.success` before enabling glasses-dependent actions.
3. Use `textContainerUpgrade(...)` for text-only changes.
4. Use `rebuildPageContainer(...)` when the layout or container types change.
5. Create image placeholders first, then call `updateImageRawData(...)` sequentially.
6. Exit the root page with `shutDownPageContainer(1)` so the system confirmation UI appears. Use mode `0` only after an internal-page confirmation.

Current public bridge methods include:

- Page/display: `createStartUpPageContainer`, `rebuildPageContainer`, `textContainerUpgrade`, `updateImageRawData`, `shutDownPageContainer`.
- Events/device: `onEvenHubEvent`, `onDeviceStatusChanged`, `onLaunchSource`, `getDeviceInfo`, `getUserInfo`.
- Audio/IMU: `audioControl`, `imuControl`.
- Phone capabilities: `getAppLocation`, continuous location methods, album selection, and camera capture.
- Host storage: `setLocalStorage` and `getLocalStorage`.

Do not invent APIs such as `setLayout`, `setPageFlip`, `sendData`, `setNotification`, key-down/key-up events, or a `ContainerData` model. They are not in SDK `0.0.12`.

## Distinguish current spellings

- Use `borderRadius` with SDK `0.0.12`; the older `borderRdaius` spelling is stale.
- Use the bridge method `shutDownPageContainer`. `ShutDownContaniner` is only a legacy misspelled exported model class.
- Use `audioEvent.audioPcm`, a `Uint8Array`; do not depend on undocumented `onMicData` helpers.
- Use typed SDK imports and avoid `any` unless the installed declarations prove a runtime capability is missing from types and the task explicitly accepts that risk.

## Verify changes

- Type-check and run unit tests.
- Exercise startup result handling and cleanup paths.
- Test layouts and event logic in the current simulator.
- Confirm timing, permissions, background behavior, and critical interaction paths on real G2 hardware before release.

Official references: [architecture](https://hub.evenrealities.com/docs/get-started/architecture), [page lifecycle](https://hub.evenrealities.com/docs/build/page-lifecycle), [device APIs](https://hub.evenrealities.com/docs/build/device-apis), and [versioning](https://hub.evenrealities.com/docs/reference/versioning).
