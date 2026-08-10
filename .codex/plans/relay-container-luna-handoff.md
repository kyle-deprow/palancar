# Luna implementation handoff: relay container packaging

## Objective

Add production-shaped Docker packaging for the reviewed `@palancar/relay` host. This slice must produce a runnable local container image for the relay, with a pinned Node base image, non-root runtime, only runtime dependencies after pruning, and a smoke test against `/healthz`.

Do not add Terraform, Azure deployment, ACR push scripts, Foundry adapters, durable auth, or cleanup jobs in this slice.

## Files you may change

- `.dockerignore`
- `apps/relay/Dockerfile`
- `apps/relay/scripts/smoke-container.mjs`
- `apps/relay/package.json`
- `apps/relay/src/host.ts`

## Files and actions you must not change

- Do not edit root `package.json`, package-lock, relay source files other than `apps/relay/src/host.ts`, tests, infra, docs, or prior plan files.
- Do not commit.
- Do not push images to ACR or contact Azure.

## Required Dockerfile behavior

Create `apps/relay/Dockerfile` intended to be built from the repository root:

```sh
docker build -f apps/relay/Dockerfile -t palancar-relay:local .
```

Use a multi-stage Dockerfile:

1. `deps` / `builder` stage based on exactly:
   - `node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e`
2. `runtime` stage based on the same pinned image.

Build requirements:

- `WORKDIR /app`.
- Copy only manifests first for install caching:
  - `package.json`
  - `package-lock.json`
  - `apps/relay/package.json`
  - package manifests for relay runtime/build dependencies:
    - `packages/audio/package.json`
    - `packages/contracts/package.json`
    - `packages/generation/package.json`
    - `packages/language-registry/package.json`
    - `packages/transcription/package.json`
- Run `npm ci --ignore-scripts`.
- Copy only required source/config for the runtime dependency graph:
  - root `tsconfig.base.json`
  - `apps/relay/src`, `apps/relay/tsconfig*.json`
  - `packages/audio/src`, `packages/audio/tsconfig*.json`
  - `packages/contracts/src`, `packages/contracts/tsconfig*.json`
  - `packages/generation/src`, `packages/generation/tsconfig*.json`
  - `packages/language-registry/src`, `packages/language-registry/tsconfig*.json`
  - `packages/transcription/src`, `packages/transcription/tsconfig*.json`
- Build in dependency order:
  - `npm run build -w @palancar/contracts`
  - `npm run build -w @palancar/audio`
  - `npm run build -w @palancar/language-registry`
  - `npm run build -w @palancar/transcription`
  - `npm run build -w @palancar/generation`
  - `npm run build -w @palancar/relay`
- Prune dev dependencies after build with `npm prune --omit=dev --ignore-scripts`.

Runtime requirements:

- `NODE_ENV=production`.
- `PORT=8787`.
- `PALANCAR_RELAY_BIND_HOST=0.0.0.0`.
- `PALANCAR_GATE_POLICY_VERSION=1.0.0`.
- `EXPOSE 8787`.
- Run as non-root `node` user from the official image.
- Copy from builder only:
  - pruned `node_modules`
  - root `package.json` and `package-lock.json`
  - package `package.json` plus `dist` directories for `apps/relay` and the five internal runtime dependency packages.
- Entrypoint/CMD must run `node apps/relay/dist/main.js`.
- Add a Docker `HEALTHCHECK` that calls `http://127.0.0.1:${PORT}/healthz` with Node built-in `fetch`; it must not print secrets or env values.

## Required `.dockerignore`

Add root `.dockerignore` if absent. It must exclude at least:

- `.git`
- `.codex`
- `docs`
- `infra`
- `node_modules`
- `**/node_modules`
- `**/dist`
- `apps/g2-client/palancar.ehpk`
- `.env`
- `.env.*`
- Terraform state/plans: `*.tfstate`, `*.tfstate.*`, `*.tfplan`, `*.tfplan.*`, `*.plan`, `*.plan.*`
- local evidence/log/screenshot directories.

Do not exclude the package source/config files needed by the Dockerfile.

## Required smoke script

Add `apps/relay/scripts/smoke-container.mjs`.

Behavior:

- Use only Node built-ins (`node:child_process`, `node:http` or `fetch`, etc.).
- Resolve the repository root from `import.meta.url` because npm runs workspace scripts from `apps/relay`. Run all Docker commands with `cwd` set to the repository root.
- Build image `palancar-relay:local` using `docker build -f apps/relay/Dockerfile -t palancar-relay:local .` from the repository root.
- Run it detached with an ephemeral host port bound to container `8787` on `127.0.0.1`.
- Poll `GET /healthz` until it returns `200` and JSON `{ ok: true }`, with an overall timeout no longer than 30 seconds.
- Always stop/remove the container in `finally`.
- On failure, print generic diagnostic status only; do not dump full container logs by default.

Update `apps/relay/package.json` scripts:

- Add `"container:build": "docker build -f Dockerfile -t palancar-relay:local ../.."` only if run from `apps/relay` works.
- Add `"container:smoke": "node scripts/smoke-container.mjs"`.

If adding `container:build` from package context is awkward, omit it and document by script implementation; `container:smoke` is required.

## Required bind-address host change

Make the smallest change needed in `apps/relay/src/host.ts`:

- Add `bindHost` to `RelayHostConfig`.
- `parseRelayHostConfig` reads `PALANCAR_RELAY_BIND_HOST`, default `127.0.0.1`.
- Validate `bindHost` is exactly `127.0.0.1` or `0.0.0.0`.
- `server.listen(port, bindHost)` instead of hard-coded `127.0.0.1`.
- Existing tests should keep using default `127.0.0.1`; the Docker image sets `PALANCAR_RELAY_BIND_HOST=0.0.0.0`.
- Do not change ticket audience/origin behavior.

## Required verification

Run and report actual outputs:

- `npm run lint -w @palancar/relay`
- `npm run typecheck -w @palancar/relay`
- `npm run test -w @palancar/relay`
- `npm run build -w @palancar/relay`
- `npm run container:smoke -w @palancar/relay`
- `git diff --check -- .dockerignore apps/relay/Dockerfile apps/relay/scripts/smoke-container.mjs apps/relay/package.json apps/relay/src/host.ts`

## Completion report

List changed files, verification outputs, unresolved risks. End with `DONE` only if complete.
