#!/bin/sh
set -eu

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME"

ENVFILE="$HERMES_HOME/.env"
CONFIG="$HERMES_HOME/config.yaml"

: "${API_SERVER_KEY:?API_SERVER_KEY is required}"
: "${HERMES_PRIMARY_MODEL_PROVIDER:?HERMES_PRIMARY_MODEL_PROVIDER is required}"
: "${HERMES_PRIMARY_MODEL_API_KEY:?HERMES_PRIMARY_MODEL_API_KEY is required}"

# Map our UI-level provider names to hermes' actual provider keys.
# hermes doesn't recognize "openai" as a provider name; any OpenAI-compatible
# HTTP endpoint (including the real OpenAI API, Azure OpenAI, LM Studio,
# vLLM, llama.cpp, Ollama, and compatible proxies) goes through "custom".
case "${HERMES_PRIMARY_MODEL_PROVIDER}" in
    openai) HERMES_MODEL_PROVIDER=custom ;;
    *)      HERMES_MODEL_PROVIDER="${HERMES_PRIMARY_MODEL_PROVIDER}" ;;
esac

{
    echo "API_SERVER_ENABLED=true"
    echo "API_SERVER_HOST=${API_SERVER_HOST:-0.0.0.0}"
    echo "API_SERVER_PORT=${API_SERVER_PORT:-8642}"
    echo "API_SERVER_KEY=${API_SERVER_KEY}"
    [ -n "${API_SERVER_CORS_ORIGINS:-}" ] && echo "API_SERVER_CORS_ORIGINS=${API_SERVER_CORS_ORIGINS}"
    [ -n "${HERMES_MATRIX_HOMESERVER:-}" ] && echo "MATRIX_HOMESERVER=${HERMES_MATRIX_HOMESERVER}"
    [ -n "${HERMES_MATRIX_ACCESS_TOKEN:-}" ] && echo "MATRIX_ACCESS_TOKEN=${HERMES_MATRIX_ACCESS_TOKEN}"
} > "$ENVFILE"

{
    echo "profile: ${HERMES_PROFILE:-default}"
    echo "model:"
    echo "  provider: ${HERMES_MODEL_PROVIDER}"
    if [ -n "${HERMES_PRIMARY_MODEL_NAME:-}" ]; then
        echo "  default: ${HERMES_PRIMARY_MODEL_NAME}"
    fi
    if [ -n "${HERMES_PRIMARY_MODEL_BASE_URL:-}" ]; then
        # OpenAI-compatible SDKs expect base_url to include the /v1 suffix so
        # chat.completions becomes <base>/chat/completions. Append it if the
        # user supplied a bare origin.
        _base_url="${HERMES_PRIMARY_MODEL_BASE_URL%/}"
        case "${_base_url}" in
            */v1|*/v1/) : ;;
            *) _base_url="${_base_url}/v1" ;;
        esac
        echo "  base_url: ${_base_url}"
    fi
    # For custom (OpenAI-compatible) providers, surface the api_key directly
    # in config.yaml so hermes picks it up. Built-in providers like openrouter
    # or anthropic read from provider-specific env vars instead.
    if [ "${HERMES_MODEL_PROVIDER}" = "custom" ]; then
        echo "  api_key: ${HERMES_PRIMARY_MODEL_API_KEY}"
    fi
    echo "platforms:"
    [ -n "${HERMES_TELEGRAM_BOT_TOKEN:-}" ] && echo "  telegram: { enabled: true }"
    [ -n "${HERMES_DISCORD_BOT_TOKEN:-}" ] && echo "  discord: { enabled: true }"
    [ -n "${HERMES_SLACK_APP_TOKEN:-}" ] && echo "  slack: { enabled: true }"
    [ -n "${HERMES_WHATSAPP_TOKEN:-}" ] && echo "  whatsapp: { enabled: true }"
    [ -n "${HERMES_SIGNAL_TOKEN:-}" ] && echo "  signal: { enabled: true }"
    [ -n "${HERMES_MATRIX_HOMESERVER:-}" ] && [ -n "${HERMES_MATRIX_ACCESS_TOKEN:-}" ] && echo "  matrix: { enabled: true }"
    [ -n "${HERMES_HOMEASSISTANT_TOKEN:-}" ] && echo "  home_assistant: { enabled: true }"
} > "$CONFIG"

case "${HERMES_PRIMARY_MODEL_PROVIDER}" in
    openrouter) export OPENROUTER_API_KEY="${HERMES_PRIMARY_MODEL_API_KEY}" ;;
    openai)     export OPENAI_API_KEY="${HERMES_PRIMARY_MODEL_API_KEY}" ;;
    anthropic)  export ANTHROPIC_API_KEY="${HERMES_PRIMARY_MODEL_API_KEY}" ;;
esac

[ -n "${HERMES_MATRIX_HOMESERVER:-}" ] && export MATRIX_HOMESERVER="${HERMES_MATRIX_HOMESERVER}"
[ -n "${HERMES_MATRIX_ACCESS_TOKEN:-}" ] && export MATRIX_ACCESS_TOKEN="${HERMES_MATRIX_ACCESS_TOKEN}"

exec mf-service-boot "$@"
