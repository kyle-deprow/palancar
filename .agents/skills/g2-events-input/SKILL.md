---
name: g2-events-input
description: Implement Even G2 and R1 input, microphone, IMU, device-status, and lifecycle handling with the current SDK. Use for `onEvenHubEvent`, `OsEventTypeList`, event capture, gesture routing, audio PCM, input-source distinctions, cleanup, or background recovery.
---

# G2 events and input

Use one typed event boundary and route by payload, source, and application state.

## Subscribe and clean up

```ts
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'

const unsubscribe = bridge.onEvenHubEvent(event => {
  const eventType =
    event.textEvent?.eventType ??
    event.listEvent?.eventType ??
    event.sysEvent?.eventType

  if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
    // Handle press. Some host payloads normalize enum value 0 to undefined.
  }
})
```

Retain every unsubscribe function. Stop audio, IMU, location updates, timers, and sockets when their owning feature is torn down.

## Route current event types

SDK `0.0.12` defines:

- `CLICK_EVENT = 0`
- `SCROLL_TOP_EVENT = 1`
- `SCROLL_BOTTOM_EVENT = 2`
- `DOUBLE_CLICK_EVENT = 3`
- `FOREGROUND_ENTER_EVENT = 4`
- `FOREGROUND_EXIT_EVENT = 5`
- `ABNORMAL_EXIT_EVENT = 6`
- `SYSTEM_EXIT_EVENT = 7`
- `IMU_DATA_REPORT = 8`

Event routing depends on the active capture container:

- With text capture, swipes arrive as `textEvent`, while single and double presses arrive as `sysEvent`.
- With list capture, firmware handles swipe navigation internally; a single press arrives as `listEvent`, while a double press arrives as `sysEvent`.
- Lifecycle and IMU data use `sysEvent`; microphone buffers use `audioEvent`.

- Handle `CLICK_EVENT` and `undefined` together because zero can be lost during host normalization.
- Treat top/bottom scroll values as firmware navigation or boundary events, not key-down/key-up events.
- Use `eventSource` when behavior must distinguish right temple, left temple, and R1 ring. Do not claim the sources are indistinguishable.
- Track list selection in app state and tolerate missing optional event fields.
- Do not interpret an entirely empty or malformed event as a press unless real-device evidence establishes that behavior.

## Make exit behavior review-safe

- Map root-page double press to `await bridge.shutDownPageContainer(1)`.
- Use immediate mode `0` only on an internal page after the user already confirmed exit.
- Do not unsubscribe or stop hardware before requesting mode `1`: the user can cancel the system dialog. Clean up after `SYSTEM_EXIT_EVENT` or `ABNORMAL_EXIT_EVENT` instead.
- Handle `SYSTEM_EXIT_EVENT` and abnormal termination as cleanup signals.

## Capture audio correctly

```ts
import { AudioInputSource } from '@evenrealities/even_hub_sdk'

await bridge.audioControl(true, AudioInputSource.Glasses)

const unsubscribe = bridge.onEvenHubEvent(event => {
  if (!event.audioEvent) return
  const pcm = event.audioEvent.audioPcm // Uint8Array
  const source = event.audioEvent.source
  consumePcm(pcm, source)
})

await bridge.audioControl(false)
unsubscribe()
```

- Declare `g2-microphone` for glasses audio and `phone-microphone` for phone audio.
- Create the startup page before opening the glasses microphone.
- Treat audio as 16 kHz, signed 16-bit little-endian, mono.
- Process arbitrary chunk boundaries. Do not hardcode obsolete 40-byte hardware packets.
- Copy a typed-array slice before transferring its `ArrayBuffer` when byte offset or length may not cover the whole backing buffer.
- Backpressure or batch network sends; do not let audio callbacks grow an unbounded queue.

## Handle other device streams

- Use `imuControl(true, ImuReportPace.*)` and accept `IMU_DATA_REPORT` through `sysEvent.imuData`; pacing values are protocol codes, not Hz.
- Use `onDeviceStatusChanged` for battery, wearing, charging, and connection state. The simulator hardcodes status and does not emit these changes.
- Use `onLaunchSource` if launch behavior differs between the app menu and glasses menu.

## Survive backgrounding

- Persist important state eagerly to `localStorage`.
- Assume Android can reclaim the WebView and drop in-memory state, WebSockets, audio, and location streams.
- Rehydrate state and reconnect/re-arm required streams on foreground or cold launch.
- Do not assume iOS behavior proves Android behavior.

## Verify interactions

- Unit-test state-dependent press and double-press behavior.
- Test text and list capture paths.
- Test source-aware behavior for temple and ring events when used.
- Exercise simulator click, double-click, up, and down actions.
- Verify microphone permissions, packet handling, background recovery, and exit flow on physical G2 hardware.

Official references: [device APIs](https://hub.evenrealities.com/docs/build/device-apis), [background lifecycle](https://hub.evenrealities.com/docs/build/background-lifecycle), and [page lifecycle](https://hub.evenrealities.com/docs/build/page-lifecycle).
