# Luna implementation handoff: G2 client foundation

Implement the Phase 2B mocked G2 client in `apps/g2-client/**`. This is a
bounded implementation against frozen protocol/audio contracts; do not design
or implement the real Azure relay, ticket exchange, translation provider, or
Terraform workload.

You are not alone. Preserve all unrelated files and Azure state. Do not commit
or mutate Azure.

## Required sources

Read completely before editing:

- all five `.agents/skills/g2-*/SKILL.md` files named in `AGENTS.md`
- `docs/implementation-plan.md` G2/verification sections
- ADRs 0001, 0003, 0004
- installed declarations after dependency install:
  `node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`
- `packages/contracts`, `packages/audio`, and `packages/language-registry`

Use installed SDK declarations as authoritative. Never cast through `any` or
invent bridge calls.

## Write scope

- `apps/g2-client/**`
- root `package-lock.json` only through npm install

Do not edit root package.json, other packages, docs, tools, infra, or plans.

## Toolchain and manifest

- Browser-only Vite/TypeScript/Vitest app; exact dependencies:
  `@evenrealities/even_hub_sdk` `0.0.12`, CLI `0.1.13`, simulator `0.8.0`, and
  exact current Vite compatible with Node 22/TypeScript 6. No `latest`/ranges.
- Manifest values: package `com.palancar.translate`, name `Palancar`, version
  `0.1.0`, edition `202601`, min app `2.0.0`, min SDK matching 0.0.12,
  `dist/index.html`, UI language `en`, only `network` and `g2-microphone`
  permissions with descriptions.
- For this mocked dev slice, whitelist only `http://localhost:8787`. Isolate it
  in a typed non-secret relay-origin config and add a script/check that can
  replace it later with exactly one reviewed HTTPS origin. Reject credentials,
  paths, queries, fragments, wildcard hosts, non-HTTPS production values, and
  unexpected keys. Do not claim the localhost manifest is release-ready.
- Add package-local `.gitignore` for dist, simulator captures, generated packs,
  source maps, `.env*`, and local production-origin artifacts.

## Required behavior

1. **Pure state machine**
   - States: Starting, TargetSelection, Ready, Listening, Finalizing,
     Translating, Results, Recovering, Error, Exited.
   - Spanish and Turkish are symmetric target choices. Restored target is only
     highlighted; a press explicitly confirms before any session start or mic.
   - Target-selection swipe cycles; press confirms. Ready press starts a mocked
     session then microphone only after `session.ready`. Listening press commits.
     Results swipe cycles 2–3 suggestions and press starts the next turn.
   - Final/translation/suggestion events bind to session/epoch/utterance and
     accepted final revision; stale events cannot update later turns.
   - English, supported-unselected, mixed, unsupported, and uncertain decisions
     visibly reject/abort and never reach generation/result state.

2. **Typed bridge lifecycle and input**
   - Call `waitForEvenAppBridge`, then exactly one
     `createStartUpPageContainer`. Check result before enabling glass actions.
   - One `onEvenHubEvent` boundary routes text/list/sys/audio events and source.
     Treat CLICK_EVENT and normalized `undefined` together only for otherwise
     valid press payloads. Route swipe top/bottom and double-click correctly.
   - Root double press calls `shutDownPageContainer(1)` without cleanup first.
     Cleanup on SYSTEM_EXIT/ABNORMAL_EXIT; retain/unsubscribe callbacks, stop
     audio, timers, display queue, and mocked transport idempotently.
   - Use `audioControl(true, AudioInputSource.Glasses)` only after startup,
     target confirmation, and mocked session-ready. Stop it on commit/abort/
     recovery/cleanup. Consume only `audioEvent.audioPcm`, copying arbitrary
     views and passing them into `ClientRetainedAudioQueue`.

3. **Transport boundary and mocked journey**
   - Define a typed browser transport interface for connect/start/resume,
     controls, binary send, close/events. Implement deterministic in-memory mock
     transport only; real fetch/WSS/ticket logic is a later slice.
   - Sender uses negotiated limits from mock `session.ready`, sends encoded
     frames in order, applies ACKs, handles `normal/pause/abort`, retains bounded
     replay, and visibly aborts on overflow/non-resumable recovery. No silent
     PCM drop and no unbounded callback queue.
   - Mock journey emits partial Spanish and Turkish separately, final,
     target-language decision, English translation, and exactly 2–3 bilingual
     suggestions. Never specialize behavior or tests to only one target.

4. **HUD and display scheduler**
   - Valid 576x288 layouts, no more than eight non-image containers/12 total,
     unique IDs/names <=16 characters, exactly one capture text/list container,
     consistent z-order policy, bounded text.
   - Present target/status, target-language transcript, English translation,
     and current bilingual suggestion with short labels and stable regions.
   - Startup page once; frequent content uses `textContainerUpgrade`, layout/type
     changes use rebuild. Serialize every display operation.
   - Implement latest-wins transcript scheduling at a configurable 175 ms
     default (within 150–200 ms). Never race BLE operations; surface failures.
   - Log stable `PALANCAR_G2_READY` only after successful startup container.

5. **Persistence/recovery/privacy**
   - Persist only last selected target and safe preferences through a typed
     storage adapter; clear conversation content on session end/cold start.
   - Foreground recovery reconnects/re-arms deliberately; socket loss stops mic
     immediately and either exact-resumes from a confirmed boundary or visibly
     aborts. No conversation/audio logging or persistence.

## Tests and verification

Test both Spanish and Turkish symmetrically, state transitions, confirmation
before session/mic, stale revisions, all gate rejections, arbitrary PCM views,
overflow/replay failure, pause/abort, source-aware click/undefined/swipes,
double-exit/cleanup ordering, one-shot startup failure, foreground recovery,
display bounds/counts/capture/text/z-order, latest-wins serialization, and
privacy canaries. Use fake timers where deterministic.

Run npm install, root lint/typecheck/test/build, package build, Node-side import
of pure modules, and `git diff --check`. Inspect CLI help and attempt
`npx evenhub pack app.json dist -o palancar.ehpk`; if simulator/pack cannot run,
report the exact evidence and do not fake success. Ensure generated package,
dist, screenshots, maps, and env files remain ignored. Report installed SDK/CLI/
simulator/Vite versions, changed files, tests, pack result, and limitations.
End DONE only when the mocked foundation is complete.
