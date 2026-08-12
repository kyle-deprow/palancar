FROM ghcr.io/berriai/litellm:v1.75.5-stable@sha256:751ba882360f8d62c63ceb0a5b628f897cee0e0b93b3596c81ff1228e6b77ce3

WORKDIR /app

COPY apps/litellm-proxy/entrypoint.sh /app/entrypoint.sh
COPY apps/litellm-proxy/metadata-server.mjs /app/metadata-server.mjs
COPY apps/litellm-proxy/config.template.yaml /app/config.template.yaml

EXPOSE 4000 4001

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
