FROM --platform=linux/amd64 ghcr.io/berriai/litellm:v1.94.0@sha256:fa88aab52bfcf894f964b855f31be0ef83cba9f5be5d94bbc46f78fcdeb4d46b

WORKDIR /app

COPY apps/litellm-proxy/entrypoint.sh /app/entrypoint.sh
COPY apps/litellm-proxy/config.openrouter.yaml /app/config.openrouter.yaml

EXPOSE 4000

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
