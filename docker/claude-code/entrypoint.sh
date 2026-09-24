#!/bin/sh
set -eu

# Orchestrator injects WORKSPACE_DIR / WORKSPACE_PVC_ROOT / AGENT_ID; the defaults
# below resolve to ~/.manyfold/workspaces/<agent-id> for ad-hoc `docker run`.
PVC_ROOT="${WORKSPACE_PVC_ROOT:-$HOME/.manyfold}"
WORKSPACE="${WORKSPACE_DIR:-${PVC_ROOT}/workspaces/${AGENT_ID:-default}}"
STATE="$PVC_ROOT/state/claude"
LINK="$HOME/.claude"

mkdir -p "$WORKSPACE" "$STATE"

# ~/.claude must point at the PVC so session history (~/.claude/projects/**)
# survives pod restart.
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
    if [ ! -L "$LINK" ]; then
        cp -a "$LINK/." "$STATE/" 2>/dev/null || true
    fi
    rm -rf "$LINK"
fi
ln -s "$STATE" "$LINK"

exec "$@"
