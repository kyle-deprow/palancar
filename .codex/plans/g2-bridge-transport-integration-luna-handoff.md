# G2 bridge + relay transport integration Luna handoff

## Objective

Wire the reviewed relay transport into the existing G2 bridge runtime so G2/R1 gestures drive the client state machine, the glasses microphone streams PCM to the relay transport, and the existing five text display regions show target, transcription, translation, and suggestions.

This is the development-auth/synthetic-backend vertical slice. Do not add operator pairing, production credential storage, resume, IndexedDB, or provider selection in this slice.

## Files you may change

- `/home/dev/repos/palancar_ws/palancar/apps/g2-client/src/bridge/runtime.ts`
- `/home/dev/repos/palancar_ws/palancar/apps/g2-client/test/bridge.test.ts`

If absolutely needed for exports/types only:

- `/home/dev/repos/palancar_ws/palancar/apps/g2-client/src/bridge/index.ts`

## Files you must not change

- Relay, Terraform, packages, manifests, validator, package-lock, build artifacts, `.ehpk`, or any docs outside this handoff.
- Do not change state reducer behavior in this slice.
- Do not modify transport implementation unless type integration is impossible; if it is impossible, stop and report why.

## Existing contracts to use

- `G2BridgeRuntime` currently boots the startup page, handles system exit/double-click, and exposes `snapshot`, `boot()`, `cleanup()`, and `whenEventsIdle()`.
- `RelayTransport` in `../transport/index.js` exposes:
  - `startSession(targetLanguage)`
  - `startUtterance(utteranceId)`
  - `pushPcm(pcm)`
  - `commitUtterance()`
  - `cancelUtterance()`
  - `endSession(reason?)`
  - `close()`
- `reduceClientState` emits effects for:
  - `persist-target`
  - `start-session`
  - `start-audio`
  - `stop-audio`
  - `start-utterance`
  - `commit-utterance`
  - `end-session`
- G2 SDK audio is `bridge.audioControl(true, AudioInputSource.Glasses)` and audio arrives as `event.audioEvent.audioPcm`.
- Keep `createStartUpPageContainer()` exactly once; use `textContainerUpgrade()` for text updates.

## Required runtime behavior

1. Extend `G2BridgePort` minimally to include:
   - `textContainerUpgrade`
   - `audioControl`
   - existing methods stay unchanged.
2. Add dependency injection options for tests:
   - `createTransport`
   - `idGenerator`
   - `relayOrigin`
   - `storage` or equivalent target persistence adapter
   - display debounce override if needed for deterministic tests.
3. Default relay origin must be:

```text
https://ca-palancar-dev-relay-aeeacd8c.graysmoke-757a2980.eastus2.azurecontainerapps.io
```

4. On successful bridge startup:
   - create the existing Starting page exactly once;
   - subscribe to EvenHub events exactly once;
   - dispatch `startup.ready`;
   - update display text to the resulting state.
5. Event routing:
   - Root double-click from valid temple/ring sources keeps existing `shutDownPageContainer(1)` behavior.
   - `SYSTEM_EXIT_EVENT` and `ABNORMAL_EXIT_EVENT` clean up.
   - Single press (`CLICK_EVENT` or undefined normalized system/text/list event type) dispatches `press`. If current state is session-ready `Ready`, include a generated v4 utterance ID.
   - Top/bottom scroll events dispatch `swipe.previous`/`swipe.next` for target selection and results cycling.
   - Audio events copy `audioPcm` to a fresh `Uint8Array` and call active transport `pushPcm`; ignore audio when mic is not open.
6. Effects:
   - `persist-target`: save target best-effort.
   - `start-session`: create a `RelayTransport` with callbacks that dispatch server events into the reducer. Start session asynchronously; transport errors should not throw out of event handling. For this slice, fatal transport failures may dispatch local `fatal`; recoverable transport errors may be surfaced as fatal only if there is no state-machine event available, but do not throw.
   - For a batch containing both `start-audio` and `start-utterance`, run `start-utterance` before opening audio so microphone callbacks cannot beat the active relay utterance.
   - `start-audio`: call `audioControl(true, AudioInputSource.Glasses)`, set audio-open only on success, and report failure through state `fatal`.
   - `stop-audio`: call `audioControl(false)` and clear audio-open.
   - `commit-utterance`: call transport `commitUtterance`.
   - `end-session`: call transport `endSession`.
   - Cleanup must close transport, stop audio if open, unsubscribe events, and reject/stop pending display work without throwing duplicate cleanup errors.
7. Display:
   - Use the existing five text regions: `status`, `target`, `source`, `english`, `suggestion`.
   - Keep text concise and bounded for G2 display.
   - Show:
     - TargetSelection: highlighted Spanish/Turkish and “press to confirm, swipe to change”
     - Ready: confirmed target and optional message
     - Listening/Finalizing: target-language transcript text
     - Translating: final transcript and English translation when available
     - Results: final transcript, English translation, selected suggestion as `English → target`
     - Error/Recovering status messages
   - Use `textContainerUpgrade()` sequentially; no page rebuilds after startup in this slice.
8. Snapshot:
   - Preserve existing fields.
   - Add enough fields for tests/debugging: current state name, target, sessionReady, audioOpen, displayUpdateCount or last display content if useful.
   - Return immutable/defensive data.

## Tests

Update bridge tests with fakes. Cover at least:

1. Startup still calls create once, subscribes once, then upgrades display to TargetSelection.
2. Target swipe/press starts one relay session for the selected language and persists the target.
3. After fake transport emits `session.ready`, Ready press generates a v4 utterance ID, calls `startUtterance`, opens glasses audio, and streams copied PCM.
4. Listening press stops audio before commit and calls `commitUtterance`.
5. Fake transport transcript/translation/suggestions events update display text through the state machine.
6. Results swipe changes selected suggestion display.
7. System exit and abnormal exit clean up transport/audio/subscription.
8. Root double-click still calls `shutDownPageContainer(1)` without immediate cleanup when user cancels.

## Required Sol review fixes

Apply the following fixes without broadening scope:

1. Do not await `transport.startSession()` from the serialized event queue. A stalled ticket request/WebSocket connect must not block later gestures or system/abnormal-exit cleanup. Start it in the background, record/handle rejection, and ensure cleanup can close/abort the pending transport.
2. `#stopAudio()` must not clear `#audioOpen` before a confirmed successful close. Treat `audioControl(false)` returning `false` as failure. Preserve audio-open state so cleanup can retry if a normal stop fails.
3. Prevent recursive display-failure loops. If `textContainerUpgrade()` fails, latch the display fault or otherwise avoid repeatedly scheduling fatal/display retries from terminal `Error` no-op reductions. `whenEventsIdle()` must settle after the failure and surface the error.
4. If `createStartUpPageContainer()` fails, record Error state without scheduling later `textContainerUpgrade()` calls, because no valid startup container exists.
5. Raw audio events must not enqueue unbounded PCM buffers behind the serialized event tail. Copy PCM at the callback boundary and route it through a bounded or synchronous audio path directly to the active transport.
6. Tighten display scheduling enough to avoid accumulating full snapshots while display upgrades are already in progress. Keep only the latest pending state and skip unchanged regions.
7. Fix or preserve tests for:
   - startup-display failure;
   - audio open failure;
   - audio close failure preserving cleanup retry;
   - transport start rejection without blocking cleanup;
   - shared operation log proving stop-audio happens before commit;
   - concurrent successful `boot()`;
   - repeated cleanup/system exits;
   - invalid double-click sources;
   - shutdown success followed by queued system exit.

## Verification

Run:

```bash
npm run lint -w @palancar/g2-client
npm run test -w @palancar/g2-client
npm run typecheck -w @palancar/g2-client
npm run build -w @palancar/g2-client
git diff --check -- apps/g2-client/src/bridge/runtime.ts apps/g2-client/test/bridge.test.ts apps/g2-client/src/bridge/index.ts
```

## Completion report

Return:

- changed files
- concise implementation summary
- exact verification output
- unresolved issues, if any
- final line `DONE` only if complete
