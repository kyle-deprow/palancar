# Luna handoff: G2 client scaffold

Implement only the toolchain, manifest, typed bridge lifecycle, static display
layouts/validation, serialized display scheduler, and minimal boot/exit path in
`apps/g2-client/**`. State machine, audio sender, transport, translation events,
and persistence are a later task. Preserve unrelated work; no commit/Azure.

Read the broad `g2-client-foundation-luna-handoff.md`, all five G2 skills, and
SDK 0.0.12 declarations, but complete only this narrowed scope.

- Correct package TypeScript to exact `6.0.3`; exact SDK/CLI/simulator pins stay
  `0.0.12`/`0.1.13`/`0.8.0`. Use an exact Vite version compatible with Node 22
  and TS6. Run npm install to update root lock.
- Create strict browser Vite config, HTML/main entry, package `.gitignore`, and
  valid dev `app.json`: required identity/version fields, English UI, only
  network + g2-microphone permissions, localhost:8787 dev whitelist, real
  `dist/index.html` entrypoint. Add validator that rejects wildcard,
  credentials/path/query/fragment/unknown keys and non-HTTPS production origin.
- Implement typed `waitForEvenAppBridge` boot with exactly one startup create,
  checked success/failure, one event subscription, stable `PALANCAR_G2_READY`
  only after success, root valid double-click calling
  `shutDownPageContainer(1)` without cleanup first, cleanup on system/abnormal
  exit, retained unsubscribe, and idempotent shutdown. No `any`/invented APIs.
- Implement immutable 576x288 layouts for Starting, TargetSelection, Ready,
  Listening, Finalizing, Translating, Results, Recovering, Error. Content may be
  static placeholders, but Spanish and Turkish target labels must both exist.
  At most 8 non-image/12 total, unique ID/name <=16, bounds/text limits, exactly
  one capture target, consistent z-order. Present stable regions for target,
  source transcript, English translation, bilingual suggestion/status.
- Implement serialized latest-wins text update scheduler with configurable
  175ms default, cancellation/cleanup, and checked bridge results. Rebuild only
  for layout/type change; frequent updates use text upgrades.
- Tests: manifest/origin, every layout invariant, exact-once startup success and
  failure, valid double exit ordering, system/abnormal cleanup, CLICK enum zero
  handling only for valid payload, serialized/latest-wins/failure scheduler,
  and no unsupported bridge calls/privacy strings.
- Build/test/typecheck/lint, Node import pure modules, `git diff --check`, inspect
  CLI help, attempt pack, verify output artifacts ignored. Do not run simulator
  yet. Report actual versions/results/files and end DONE.
