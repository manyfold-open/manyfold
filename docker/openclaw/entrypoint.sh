#!/bin/sh
set -eu

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME}"
CONFIG_DIR="$OPENCLAW_HOME/.openclaw"
WORKSPACE_DIR="${OPENCLAW_AGENT_WORKSPACE:-$CONFIG_DIR/workspace}"
mkdir -p "$CONFIG_DIR" "$WORKSPACE_DIR"

: "${OPENCLAW_GATEWAY_TOKEN:?OPENCLAW_GATEWAY_TOKEN is required}"
: "${OPENCLAW_PRIMARY_MODEL_PROVIDER:?OPENCLAW_PRIMARY_MODEL_PROVIDER is required}"
: "${OPENCLAW_PRIMARY_MODEL_API_KEY:?OPENCLAW_PRIMARY_MODEL_API_KEY is required}"
: "${OPENCLAW_PRIMARY_MODEL_NAME:?OPENCLAW_PRIMARY_MODEL_NAME is required}"

case "${OPENCLAW_PRIMARY_MODEL_PROVIDER}" in
    openai)
        DEFAULT_BASE="https://api.openai.com/v1"
        WIRE_API="openai-completions"
        ;;
    openrouter)
        DEFAULT_BASE="https://openrouter.ai/api/v1"
        WIRE_API="openai-completions"
        ;;
    anthropic)
        DEFAULT_BASE="https://api.anthropic.com/v1"
        WIRE_API="anthropic-messages"
        ;;
    *)
        DEFAULT_BASE=""
        WIRE_API="openai-completions"
        ;;
esac

BASE_URL="${OPENCLAW_PRIMARY_MODEL_BASE_URL:-$DEFAULT_BASE}"
BASE_URL="${BASE_URL%/}"
case "${BASE_URL}" in
    */v1|*/v1/) : ;;
    "")
        echo "no base_url resolvable for provider ${OPENCLAW_PRIMARY_MODEL_PROVIDER}" >&2
        exit 1
        ;;
    *) BASE_URL="${BASE_URL}/v1" ;;
esac

case "${OPENCLAW_CONTROL_UI_ENABLED:-true}" in
    true|1|yes) CONTROL_UI_ENABLED=true ;;
    *) CONTROL_UI_ENABLED=false ;;
esac

CONFIG="$CONFIG_DIR/openclaw.json"
cat > "$CONFIG" <<JSON
{
  "gateway": {
    "mode": "local",
    "port": ${OPENCLAW_GATEWAY_PORT:-18789},
    "bind": "custom",
    "customBindHost": "0.0.0.0",
    "auth": { "mode": "token", "token": "${OPENCLAW_GATEWAY_TOKEN}" },
    "remote": { "token": "${OPENCLAW_GATEWAY_TOKEN}" },
    "controlUi": {
      "enabled": ${CONTROL_UI_ENABLED},
      "allowInsecureAuth": true,
      "allowedOrigins": ["*"],
      "dangerouslyDisableDeviceAuth": true
    },
    "trustedProxies": ["127.0.0.1", "::1"],
    "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
  },
  "discovery": {
    "mdns": { "mode": "off" }
  },
  "tools": {
    "profile": "full",
    "elevated": { "enabled": true },
    "exec": { "host": "gateway", "security": "full", "ask": "off" }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "primary": {
        "baseUrl": "${BASE_URL}",
        "apiKey": "${OPENCLAW_PRIMARY_MODEL_API_KEY}",
        "api": "${WIRE_API}",
        "models": [
          { "id": "${OPENCLAW_PRIMARY_MODEL_NAME}", "name": "${OPENCLAW_PRIMARY_MODEL_NAME}" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "sandbox": { "mode": "off" },
      "model": { "primary": "primary/${OPENCLAW_PRIMARY_MODEL_NAME}" },
      "workspace": "${WORKSPACE_DIR}",
      "timeoutSeconds": ${OPENCLAW_AGENT_TIMEOUT_SECONDS:-180}
    }
  }
}
JSON

if [ "${OPENCLAW_WARMUP_ENABLED:-true}" = "true" ]; then
    (
        PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
        BUDGET=$((${OPENCLAW_WARMUP_BUDGET_SECONDS:-120}))
        ELAPSED=0
        while [ "$ELAPSED" -lt "$BUDGET" ]; do
            if curl -sf -o /dev/null -m 3 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
                break
            fi
            sleep 2
            ELAPSED=$((ELAPSED + 2))
        done
        [ "$ELAPSED" -ge "$BUDGET" ] && exit 0
        # Eat the lazy plugin-install / channel-startup cost before the user's
        # first real chat. A single chat triggers most lazy plugins openclaw
        # would auto-install on demand (acpx channel, browser, document-extract,
        # microsoft, web-readability, etc. seen in prod). This call is fire-
        # and-forget — its outcome doesn't gate pod readiness.
        curl -sS -m 240 \
            -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
            -H "Content-Type: application/json" \
            -d '{"model":"openclaw","messages":[{"role":"user","content":"warmup ping"}],"stream":true,"max_tokens":8}' \
            "http://127.0.0.1:${PORT}/v1/chat/completions" >/dev/null 2>&1 || true
    ) &
fi

exec mf-service-boot "$@"
