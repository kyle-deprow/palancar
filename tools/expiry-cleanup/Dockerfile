FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/security-state/package.json packages/security-state/package.json
COPY tools/expiry-cleanup/package.json tools/expiry-cleanup/package.json

RUN npm ci --ignore-scripts

FROM deps AS builder

COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/security-state/src packages/security-state/src
COPY packages/security-state/tsconfig*.json packages/security-state/
COPY tools/expiry-cleanup/src tools/expiry-cleanup/src
COPY tools/expiry-cleanup/tsconfig*.json tools/expiry-cleanup/

RUN npm run build -w @palancar/security-state \
  && npm run build -w @palancar/expiry-cleanup

RUN npm prune --omit=dev --ignore-scripts

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e AS runtime

WORKDIR /app

COPY --from=builder --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=builder --chown=65532:65532 /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=65532:65532 /app/packages/security-state/package.json packages/security-state/package.json
COPY --from=builder --chown=65532:65532 /app/packages/security-state/dist packages/security-state/dist
COPY --from=builder --chown=65532:65532 /app/tools/expiry-cleanup/package.json tools/expiry-cleanup/package.json
COPY --from=builder --chown=65532:65532 /app/tools/expiry-cleanup/dist tools/expiry-cleanup/dist

USER 65532:65532

ENTRYPOINT ["/nodejs/bin/node"]
CMD ["tools/expiry-cleanup/dist/main.js"]
