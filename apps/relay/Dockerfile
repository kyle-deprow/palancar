FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/relay/package.json apps/relay/package.json
COPY packages/audio/package.json packages/audio/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/generation/package.json packages/generation/package.json
COPY packages/language-registry/package.json packages/language-registry/package.json
COPY packages/security-state/package.json packages/security-state/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
COPY packages/transcription/package.json packages/transcription/package.json

RUN npm ci --ignore-scripts

FROM deps AS builder

COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/relay/src apps/relay/src
COPY apps/relay/tsconfig*.json apps/relay/
COPY packages/audio/src packages/audio/src
COPY packages/audio/tsconfig*.json packages/audio/
COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/tsconfig*.json packages/contracts/
COPY packages/generation/src packages/generation/src
COPY packages/generation/tsconfig*.json packages/generation/
COPY packages/language-registry/src packages/language-registry/src
COPY packages/language-registry/tsconfig*.json packages/language-registry/
COPY packages/security-state/src packages/security-state/src
COPY packages/security-state/tsconfig*.json packages/security-state/
COPY packages/telemetry/src packages/telemetry/src
COPY packages/telemetry/tsconfig*.json packages/telemetry/
COPY packages/transcription/src packages/transcription/src
COPY packages/transcription/tsconfig*.json packages/transcription/

RUN npm run build -w @palancar/contracts \
  && npm run build -w @palancar/audio \
  && npm run build -w @palancar/language-registry \
  && npm run build -w @palancar/transcription \
  && npm run build -w @palancar/generation \
  && npm run build -w @palancar/security-state \
  && npm run build -w @palancar/telemetry \
  && npm run build -w @palancar/relay

RUN npm prune --omit=dev --ignore-scripts

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    PALANCAR_RELAY_BIND_HOST=0.0.0.0 \
    PALANCAR_GATE_POLICY_VERSION=1.0.0

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/relay/node_modules apps/relay/node_modules
COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/apps/relay/package.json apps/relay/package.json
COPY --from=builder --chown=node:node /app/apps/relay/dist apps/relay/dist
COPY --from=builder --chown=node:node /app/packages/audio/package.json packages/audio/package.json
COPY --from=builder --chown=node:node /app/packages/audio/dist packages/audio/dist
COPY --from=builder --chown=node:node /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=builder --chown=node:node /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder --chown=node:node /app/packages/generation/package.json packages/generation/package.json
COPY --from=builder --chown=node:node /app/packages/generation/dist packages/generation/dist
COPY --from=builder --chown=node:node /app/packages/language-registry/package.json packages/language-registry/package.json
COPY --from=builder --chown=node:node /app/packages/language-registry/dist packages/language-registry/dist
COPY --from=builder --chown=node:node /app/packages/security-state/package.json packages/security-state/package.json
COPY --from=builder --chown=node:node /app/packages/security-state/dist packages/security-state/dist
COPY --from=builder --chown=node:node /app/packages/telemetry/package.json packages/telemetry/package.json
COPY --from=builder --chown=node:node /app/packages/telemetry/dist packages/telemetry/dist
COPY --from=builder --chown=node:node /app/packages/transcription/package.json packages/transcription/package.json
COPY --from=builder --chown=node:node /app/packages/transcription/dist packages/transcription/dist

USER node

EXPOSE 8787

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=6 CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(async (response) => { if (!response.ok || (await response.json()).ok !== true) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "apps/relay/dist/main.js"]
