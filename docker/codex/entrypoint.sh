#!/bin/sh
set -eu

PVC_ROOT="${WORKSPACE_PVC_ROOT:-$HOME/.manyfold}"
WORKSPACE="${WORKSPACE_DIR:-${PVC_ROOT}/workspaces/${AGENT_ID:-default}}"
STATE="$PVC_ROOT/state/codex"
LINK="$HOME/.codex"

mkdir -p "$WORKSPACE" "$STATE"

# ~/.codex must point at the PVC so `codex login --with-api-key` and any later
# session state survive pod restart.
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
    if [ ! -L "$LINK" ]; then
        cp -a "$LINK/." "$STATE/" 2>/dev/null || true
    fi
    rm -rf "$LINK"
fi
ln -s "$STATE" "$LINK"

# Render codex config.toml with the base URL the orchestrator planned. The
# orchestrator writes CODEX_BASE_URL into the Secret; we materialise it into
# the on-disk config that `codex` reads.
if [ -n "${CODEX_BASE_URL:-}" ]; then
    cat > "$LINK/config.toml" <<CFG
model_provider = "OpenAI"
model = "${CODEX_MODEL:-gpt-5.5}"
disable_response_storage = true
network_access = "enabled"
[model_providers.OpenAI]
name = "OpenAI"
base_url = "${CODEX_BASE_URL}"
wire_api = "responses"
requires_openai_auth = true
CFG
fi

exec "$@"
