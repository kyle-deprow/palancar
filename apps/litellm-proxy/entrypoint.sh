#!/bin/sh
set -eu

fail() {
  echo "palancar-litellm: configuration error: $1" >&2
  exit 1
}

backend=${PALANCAR_LITELLM_BACKEND-}

[ "$backend" = "openrouter" ] || fail "PALANCAR_LITELLM_BACKEND must be openrouter"

python3 - <<'PY'
import os
import sys


def fail(message: str) -> None:
    print(f"palancar-litellm: configuration error: {message}", file=sys.stderr)
    raise SystemExit(1)


def require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        fail(f"{name} is required")
    return value


upstream_model = require("PALANCAR_LITELLM_UPSTREAM_MODEL")
require("LITELLM_MASTER_KEY")
require("OPENROUTER_API_KEY")

allowed_openrouter = {"OPENROUTER_API_KEY"}
for name in os.environ:
    if name.startswith("AZURE_"):
        fail(f"{name} is not allowed with openrouter")
    if name.startswith("OPENROUTER_") and name not in allowed_openrouter:
        fail(f"{name} is not allowed with openrouter")
if not upstream_model.startswith("openrouter/") or upstream_model == "openrouter/":
    fail("PALANCAR_LITELLM_UPSTREAM_MODEL must name an OpenRouter model")
PY

exec litellm --config /app/config.openrouter.yaml --host 0.0.0.0 --port 4000
