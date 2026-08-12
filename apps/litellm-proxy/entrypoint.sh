#!/bin/sh
set -eu

fail() {
  echo "palancar-litellm: configuration error: $1" >&2
  exit 1
}

require_nonempty() {
  variable_name=$1
  eval "variable_value=\${$variable_name-}"
  [ -n "$variable_value" ] || fail "$variable_name is required"
}

reject_nonempty() {
  variable_name=$1
  eval "variable_value=\${$variable_name-}"
  [ -z "$variable_value" ] || fail "$variable_name is not allowed with $PALANCAR_LITELLM_BACKEND"
}

backend=${PALANCAR_LITELLM_BACKEND-}
upstream_model=${PALANCAR_LITELLM_UPSTREAM_MODEL-}

case "$backend" in
  openrouter|azure) ;;
  *) fail "PALANCAR_LITELLM_BACKEND must be openrouter or azure" ;;
esac

require_nonempty PALANCAR_LITELLM_UPSTREAM_MODEL
require_nonempty LITELLM_MASTER_KEY

case "$backend" in
  openrouter)
    case "$upstream_model" in
      openrouter/*) [ "$upstream_model" != "openrouter/" ] || fail "PALANCAR_LITELLM_UPSTREAM_MODEL must name an OpenRouter model" ;;
      *) fail "OpenRouter upstream model must start with openrouter/" ;;
    esac
    require_nonempty OPENROUTER_API_KEY
    reject_nonempty AZURE_API_BASE
    reject_nonempty AZURE_API_VERSION
    reject_nonempty AZURE_API_KEY
    reject_nonempty AZURE_AD_TOKEN
    reject_nonempty AZURE_API_TYPE
    reject_nonempty AZURE_ENDPOINT
    reject_nonempty AZURE_CLIENT_ID
    reject_nonempty AZURE_CLIENT_SECRET
    reject_nonempty AZURE_TENANT_ID
    reject_nonempty AZURE_OPENAI_API_KEY
    reject_nonempty AZURE_USERNAME
    reject_nonempty AZURE_PASSWORD
    provider_key=$OPENROUTER_API_KEY
    backend_fields=
    ;;
  azure)
    case "$upstream_model" in
      azure/*) [ "$upstream_model" != "azure/" ] || fail "PALANCAR_LITELLM_UPSTREAM_MODEL must name an Azure deployment" ;;
      *) fail "Azure upstream model must start with azure/" ;;
    esac
    require_nonempty AZURE_API_BASE
    require_nonempty AZURE_API_VERSION
    require_nonempty AZURE_API_KEY
    reject_nonempty OPENROUTER_API_KEY
    provider_key=$AZURE_API_KEY
    backend_fields=$(cat <<EOF
      api_base: __PALANCAR_AZURE_API_BASE__
      api_version: __PALANCAR_AZURE_API_VERSION__
EOF
)
    ;;
esac

export PALANCAR_RENDER_BACKEND="$backend"
export PALANCAR_RENDER_UPSTREAM_MODEL="$upstream_model"
export PALANCAR_RENDER_PROVIDER_KEY="$provider_key"
export PALANCAR_RENDER_MASTER_KEY="$LITELLM_MASTER_KEY"
export PALANCAR_RENDER_BACKEND_FIELDS="$backend_fields"
export PALANCAR_RENDER_AZURE_API_BASE=${AZURE_API_BASE-}
export PALANCAR_RENDER_AZURE_API_VERSION=${AZURE_API_VERSION-}

python - <<'PY'
import json
import os
from pathlib import Path

template = Path("/app/config.template.yaml").read_text(encoding="utf-8")

def value(name: str) -> str:
    return json.dumps(os.environ.get(name, ""))

config = (
    template
    .replace("__PALANCAR_BACKEND__", value("PALANCAR_RENDER_BACKEND"))
    .replace("__PALANCAR_UPSTREAM_MODEL__", value("PALANCAR_RENDER_UPSTREAM_MODEL"))
    .replace("__PALANCAR_PROVIDER_KEY__", value("PALANCAR_RENDER_PROVIDER_KEY"))
    .replace("__PALANCAR_MASTER_KEY__", value("PALANCAR_RENDER_MASTER_KEY"))
)

if os.environ["PALANCAR_RENDER_BACKEND"] == "azure":
    config = (
        config
        .replace("__PALANCAR_BACKEND_FIELDS__", os.environ.get("PALANCAR_RENDER_BACKEND_FIELDS", ""))
        .replace("__PALANCAR_AZURE_API_BASE__", value("PALANCAR_RENDER_AZURE_API_BASE"))
        .replace("__PALANCAR_AZURE_API_VERSION__", value("PALANCAR_RENDER_AZURE_API_VERSION"))
    )
else:
    config = config.replace("__PALANCAR_BACKEND_FIELDS__", "")

target = Path("/tmp/palancar-litellm.yaml")
target.write_text(config, encoding="utf-8")
target.chmod(0o600)
PY

python /app/metadata-server.mjs &
metadata_pid=$!

litellm --config /tmp/palancar-litellm.yaml --host 0.0.0.0 --port 4000 &
litellm_pid=$!

cleanup() {
  trap - EXIT INT TERM
  kill "$metadata_pid" 2>/dev/null || true
  kill "$litellm_pid" 2>/dev/null || true
  wait "$metadata_pid" 2>/dev/null || true
  wait "$litellm_pid" 2>/dev/null || true
}

trap cleanup EXIT
trap 'exit 143' INT TERM

exit_status=1
while :; do
  if ! kill -0 "$metadata_pid" 2>/dev/null; then
    if wait "$metadata_pid"; then exit_status=0; else exit_status=$?; fi
    break
  fi
  if ! kill -0 "$litellm_pid" 2>/dev/null; then
    if wait "$litellm_pid"; then exit_status=0; else exit_status=$?; fi
    break
  fi
  sleep 1
done

exit "$exit_status"
