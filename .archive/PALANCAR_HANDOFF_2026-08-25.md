# Palancar handoff — 2026-08-25

> **SUPERSEDED 2026-08-28.** The guarded dev-plan lifecycle described below no
> longer exists: `infra/scripts/` was reduced to a single image preflight in
> commit `eddb629`, and the evidence store at `~/.local/state/palancar/` was
> deleted. The terminal phase was never run and now cannot be; the OpenRouter
> revocation blocker was closed by decision, not by evidence. Do not attempt the
> lifecycle commands in this document. Retained as a record of how the migration
> was executed.


Continuation of `PALANCAR_HANDOFF_2026-08-22.md` and `AUDIT_2026-08-22.md`.
Read those first for app architecture, the fix-series history, and the
guarded-lifecycle design. This document covers what changed since, the exact
current state, and the one remaining blocker.

## TL;DR for the next agent

- The app is shipped and working: G2 client (`apps/g2-client/palancar.ehpk`),
  Entra-only relay on Azure Container Apps, server-VAD ASR, calibrated ELD
  gates. Real-speech smoke tests: ALL PASS (see AUDIT doc).
- Migration lifecycle state is **`credentials-and-RBAC-cleaned`**
  (stateSerial 136). Run `mt6glni8-33ef9921811424b323c038a9`
  (credential-cleanup) is **applied**. All prior credential-cleanup runs are
  invalidated — that is expected; do not touch them.
- The ONLY remaining lifecycle work is the **terminal phase**, and it is
  **blocked on the user** (OpenRouter key revocation evidence). Everything
  you need to run it is in "Terminal phase" below.
- HEAD is `21be2a1`, pushed to `https://github.com/kyle-deprow/palancar.git`
  (main). Worktree clean except this file. All suites green:
  cleanup 60, lifecycle 143, guard 136.

## Check before ANY live operation

- **az context drifts.** The user's machine flips between subscriptions.
  Palancar is subscription `a7255fdc-572a-4ea3-9d7e-ecb7ee5a87f1`, tenant
  `c69da7c1-f194-493b-9697-5b4bc8b56f37`. As of this writing `az account show`
  points at SpineSenseAI (wrong). Ask the user to `az login`/`az account set`
  back to Palancar — last time they preferred to do it themselves.
- Terraform is pinned: `/home/dev/.local/bin/terraform-1.15.8`.
- Evidence store: `/home/dev/.local/state/palancar/azure-foundry-entra-cutover/`
  with kernel lock `…/azure-foundry-entra-cutover.kernel.lock`. Never delete
  or rewrite anything in it; never commit it.

## What was done this session (2026-08-24/25)

Goal: finish the stuck credential-cleanup run (`mt6glni8…`, status was
"unknown") and advance the journal. `cleanup-key-vault-credentials.mjs resume`
already returned success; `dev-plan-lifecycle.mjs reconcile` kept failing with
`reconcile-unknown`. Root causes were two live-shape drifts, found by
instrumenting the inspector (the lifecycle swallows inspection errors — see
"Debugging the lifecycle" below):

1. `736b711` — az CLI 2.61+ (host has 2.83.0) adds `expires_on` (epoch
   seconds) to `az account get-access-token` output. `parseAccessToken`'s
   strict key allow-list rejected every real token with code `entra-token`.
   Fixed: optional field, fail-closed unless positive integer.
2. `21be2a1` — ARM returns the container app's `userAssignedIdentities` map
   key with `resourcegroups` lowercased; terraform outputs record
   `resourceGroups`. `runtimePrincipalId`'s exact-match lookup failed with
   `reconcile-credential-rbac`. Fixed: normalize both sides with the existing
   `identityKey()` helper (also fixes the latent same bug in
   `verifyTerminalRbac`, which the terminal phase will exercise).

Also discovered and fixed in passing: `280ebc3` changed
`dev-plan-lifecycle.mjs` without repinning the fixture hash, leaving the
cleanup suite red at HEAD (41 failures, `live-context-drift`). Both new
commits repin it.

After the fixes, reconcile returned **success**: reconcile receipt
`reconcile-receipt-000004.json` (status applied), checkpoint
`000021-global-state-advancement`, state advanced to
`credentials-and-RBAC-cleaned`.

Both retired Key Vault secrets were previously deleted AND purged; the
runtime role assignment is deleted; `/home/dev/repos/palancar_ws/.env` is now
empty (0 bytes) — this matters below.

## Terminal phase — the remaining work

Flow (docs/final-rollout-guard-plan.md, "guard-only until receipts are
ready"):

```sh
terminal_run_id="$(node infra/scripts/dev-plan-lifecycle.mjs create terminal)"
node infra/scripts/dev-plan-lifecycle.mjs guard terminal "$terminal_run_id"
node infra/scripts/dev-plan-lifecycle.mjs finalize terminal "$terminal_run_id"
node infra/scripts/dev-plan-lifecycle.mjs close terminal "$terminal_run_id"
```

Constraints discovered by reading `finalize` / `terminalPredecessorEvidence`
(`dev-plan-lifecycle.mjs` ~4402, ~8785, ~10421):

1. **Terminal plans expire 30 minutes after create** (`PLAN_MAX_AGE_MS`).
   Do NOT pre-stage create/guard while anything else is pending; run all four
   steps in one sitting once the prerequisites exist.
2. **Finalize hard-requires complete OpenRouter revocation evidence**
   (`validateRevocationEvidence(config, {requireComplete:true})`): a receipt
   file `openrouter-revocation-receipt.json` in the evidence root with
   state "revoked", http_status 401, bound to a state chain
   `preflight-captured → awaiting-user → revoked → local-removed`. There is
   no bypass.
3. **Finalize also requires `terminal-live-receipt.json` in the terminal run
   directory** (type "live", status "passed", operation "terminal-live",
   protected-receipt shape). NOTHING in the repo writes this file — tests
   hand-write it; docs treat it as operator-produced evidence. Expect to
   resolve this gap when you get there: either a reviewed helper that
   performs the live verification and writes the receipt, or a documented
   operator procedure. Look at `dev-plan-lifecycle.test.mjs:2821` for the
   exact shape (`protectedReceipt(...)`) and `assertExactReceipt` /
   `defaultTerminalReceiptProvider` (~8785) for what finalize validates
   (it independently re-verifies live state: revision topology, Key Vault
   absence, deployments, terminal RBAC).

### The blocker: OpenRouter revocation

Utility: `infra/scripts/openrouter-revocation-state.mjs`
(`prepare → resume → mark-local-removed → assert-complete`).

- `prepare` requires `/home/dev/repos/palancar_ws/.env` to contain EXACTLY
  one `OPENROUTER_API_KEY=` assignment, and probes OpenRouter expecting
  HTTP 200 (key must still be ACTIVE). The .env is currently empty, so
  `prepare` fails with `invalid-local-key` — the .env line was removed
  during cleanup before revocation evidence was captured (out of the
  documented order).
- `resume` then requires HTTP 401 (user has revoked the key in the
  OpenRouter dashboard between the two calls).
- `mark-local-removed` / `assert-complete` require local absence proof
  (the utility itself manages the .env removal — see
  `docs/final-rollout-guard-plan.md` lines ~118-135; `remove-env-entry.mjs`
  is the fixed local cleanup command in that sequence).

**User decision pending** (asked 2026-08-25, no answer yet):

- If the user still has the key AND it is still active: they re-add
  `OPENROUTER_API_KEY=<value>` as the only line in
  `/home/dev/repos/palancar_ws/.env`, you run `prepare`, they revoke in the
  dashboard, you run `resume`, then `mark-local-removed`, `assert-complete`,
  then the four terminal lifecycle steps within 30 minutes.
- If the key is already revoked or lost: `prepare`'s 200-probe can never
  pass. Admitting "already-revoked" evidence needs a reviewed change to the
  revocation utility and/or terminal validators — get explicit user
  sign-off on that scope before writing any code.

Never print or commit the key value, and never write it anywhere except the
user placing it in .env themselves (or with their explicit instruction).

## Debugging the lifecycle (hard-won; also in agent memory)

- **Always invoke with the absolute script path.** The cleanup utility's
  `inheritedLockIsValid` checks the parent argv for the absolute
  `LIFECYCLE_SCRIPT_PATH`; invoking `node infra/scripts/dev-plan-lifecycle.mjs …`
  with a relative path makes every embedded cleanup child fail as
  `cleanup-resume`.
- **The production wrapper swallows error codes** ("rejected operation").
  Get the real code by running the locked child directly:

  ```sh
  /usr/bin/flock -n -x /home/dev/.local/state/palancar/azure-foundry-entra-cutover.kernel.lock \
    /usr/bin/node /home/dev/repos/palancar_ws/palancar/infra/scripts/dev-plan-lifecycle.mjs \
    --__palancar-internal-locked-b1b <operation> <phase> <runId>
  ```

  `openrouter-revocation-state.mjs` also prints only "failed"; import
  `runOperation` via `node --input-type=module -e` and print `e.code`.
- **`defaultLiveInspector` swallows inspection failures** (`safelyInspect`
  → outcome "unknown" → `reconcile-unknown`). Debug pattern: copy the
  lifecycle to the scratchpad, patch `REPOSITORY_ROOT` and
  `CLEANUP_UTILITY_PATH` to absolute paths, log the caught error inside
  `safelyInspect`, stub the resume call, and `process.exit(9)` before any
  receipt write. Never let a debug copy write receipts or advance state.
- **Every edit to `dev-plan-lifecycle.mjs` must repin**
  `CURRENT_CODE_BINDINGS.lifecycleSha256` in
  `cleanup-key-vault-credentials.test.mjs` (~line 92) to the sha256 of the
  new file, in the SAME commit. The cleanup suite validates against the
  committed blob, so it only goes green post-commit; 41 failures with
  `live-context-drift` at `revalidateLiveContext` = stale pin.
- More live-shape drift is likely in the terminal phase (it exercises
  `verifyTerminalDeployments`, `verifyTerminalRbac`, `liveReadOnlyChecks`
  for the first time against real Azure). Use the debug-inspector pattern
  before changing any validator, and fix via the Luna/Sol loop.

## Working conventions in force

- Implementation via Luna, review via Sol (invocation details in agent
  memory `luna-sol-codex-invocation`): `codex exec -m gpt-5.6-luna
  -c model_reasoning_effort="xhigh" -s workspace-write …` for coding
  ("Do NOT commit"), `-m gpt-5.6-sol -s read-only` for adversarial review
  with READY/ISSUES verdicts. The parent agent runs tests and makes all
  commits. Always background codex (600s foreground cap kills it mid-work).
- Test suites: `node --test infra/scripts/<name>.test.mjs` for
  `cleanup-key-vault-credentials` (60), `dev-plan-lifecycle` (143),
  `assert-dev-plan` (136). All must be green before commit/push.
- Commits: conventional style, trailer
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never force-push;
  recover mistakes with `git reset --soft origin/main` + a new commit.
- GitHub push protection triggers on the fixture placeholder keys if those
  files are touched (agent memory `github-push-protection-palancar`).
- Never print/commit secrets, .env values, Key Vault values, tfvars
  contents, tokens, or plan JSON with sensitive data. Do not commit ignored
  artifacts (terraform.tfvars, .ehpk, evidence store). Never delete or
  rewrite the migration journal.

## After the terminal phase (in order)

1. Roll the expiry-cleanup job to the fixed image via a reviewed plan (it
   still runs the pre-fix image).
2. Clean the stale openrouter/litellm variable lines out of
   terraform.tfvars via a reviewed no-op plan.
3. User-side, no agent action: physical G2 hardware testing with
   `palancar.ehpk`; Azure cost optimizations were already analyzed and
   reported (see conversation history 2026-08-24 if needed — nothing
   pending in the repo).
