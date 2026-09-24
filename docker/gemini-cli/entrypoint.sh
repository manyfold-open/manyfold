#!/bin/sh
set -eu

PVC_ROOT="${WORKSPACE_PVC_ROOT:-$HOME/.manyfold}"
WORKSPACE="${WORKSPACE_DIR:-${PVC_ROOT}/workspaces/${AGENT_ID:-default}}"
STATE="$PVC_ROOT/state/gemini"
LINK="$HOME/.gemini"

mkdir -p "$WORKSPACE" "$STATE"

if [ -e "$LINK" ] || [ -L "$LINK" ]; then
    if [ ! -L "$LINK" ]; then
        cp -a "$LINK/." "$STATE/" 2>/dev/null || true
    fi
    rm -rf "$LINK"
fi
ln -s "$STATE" "$LINK"

exec "$@"
