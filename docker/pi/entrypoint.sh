#!/bin/sh
set -eu

PVC_ROOT="${WORKSPACE_PVC_ROOT:-$HOME/.manyfold}"
WORKSPACE="${WORKSPACE_DIR:-${PVC_ROOT}/workspaces/${AGENT_ID:-default}}"
STATE="$PVC_ROOT/state/pi"
LINK="$HOME/.pi"

mkdir -p "$WORKSPACE" "$STATE/agent"

# ~/.pi must point at the PVC so pi's settings and its session files survive
# pod restart. Nothing a credential decides lives there: the key rides each exec
# and a gateway endpoint goes into the platform view the exec builds under
# ~/.manyfold/pi (oss apps/api .../credentials/pi-agent-dir.ts).
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
    if [ ! -L "$LINK" ]; then
        cp -a "$LINK/." "$STATE/" 2>/dev/null || true
    fi
    rm -rf "$LINK"
fi
ln -s "$STATE" "$LINK"

# Written once, never overwritten: a user editing settings on the pod keeps
# their edits.
if [ ! -f "$LINK/agent/settings.json" ]; then
    printf '{\n  "quietStartup": true\n}\n' > "$LINK/agent/settings.json"
fi

exec "$@"
