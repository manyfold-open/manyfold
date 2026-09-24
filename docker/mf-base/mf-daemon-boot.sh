#!/bin/sh
# Enrol and supervise the Pod's required chat runner. State lives on its PVC.
set -u

MF_BIN="${MF_BIN:-$HOME/.local/bin/mf}"
# Long enough that a daemon failing on something structural (a revoked token, an
# unreachable API) does not hot-loop against the control plane, short enough
# that a transient one is back within a turn's patience.
RESTART_DELAY_SECONDS="${MF_DAEMON_RESTART_DELAY_SECONDS:-10}"

hold() {
    echo "mf-daemon-boot: $1; runner unavailable" >&2
    exit 1
}

[ -x "$MF_BIN" ] || hold "$MF_BIN is not executable"

# MF_CONFIG_DIR must be on the PVC. The daemon uuid lives under it and the
# registration token binds to the first uuid it sees, so a config dir on the
# container filesystem would mint a new uuid on every restart and the pod would
# then be refused with "token already bound to a different daemon".
CONFIG_DIR="${MF_CONFIG_DIR:-$HOME/.manyfold}"
PROFILE="${MF_PROFILE:-podrunner}"
DAEMON_CONFIG="$CONFIG_DIR/profiles/$PROFILE/daemon/config.json"

child_pid=''
stop() {
    trap '' TERM INT
    if [ -n "$child_pid" ]; then
        kill -TERM "$child_pid" 2>/dev/null || true
        wait "$child_pid" 2>/dev/null || true
    fi
    exit 0
}
trap stop TERM INT
registration_attempt=0
registration_delay=10

# The credential is needed exactly once: to register. Every later boot starts
# from the config that registration wrote to the PVC — which also stores the
# API URL — so a boot whose environment has lost the token (a Secret rewritten
# by something that did not carry it over) must still bring the daemon up, or
# one credential update would switch the runner off for the life of the pod.
while [ ! -f "$DAEMON_CONFIG" ]; do
    [ -n "${MF_DAEMON_TOKEN:-}" ] || hold "no pod runner credential to register with"
    [ -n "${MF_API_URL:-}" ] || hold "no MF_API_URL to register against"
    echo "mf-daemon-boot: registering ${MF_DAEMON_HOST_NAME:-this pod}" >&2
    # Token on stdin, never argv: argv is world-readable through /proc.
    registration_attempt=$((registration_attempt + 1))
    printf '%s' "$MF_DAEMON_TOKEN" | "$MF_BIN" --api-url "$MF_API_URL" \
        daemon register --token - \
        ${MF_DAEMON_HOST_NAME:+--name "$MF_DAEMON_HOST_NAME"} \
        ${MF_DAEMON_WORKSPACE_ROOT:+--workspace-root "$MF_DAEMON_WORKSPACE_ROOT"} &
    child_pid=$!
    if wait "$child_pid"; then
        child_pid=''
        [ -f "$DAEMON_CONFIG" ] || hold "registration did not persist daemon config"
    else
        registration_status=$?
        child_pid=''
        # mf's stable exit codes: auth=3, not-found=4, validation/usage=5.
        # Retry network/server failures only, with a bounded backoff.
        case "$registration_status" in
            3|4|5) hold "registration rejected (exit $registration_status); fix the Pod credential or configuration" ;;
        esac
        [ "$registration_attempt" -lt 6 ] || hold "registration failed after $registration_attempt attempts"
        echo "mf-daemon-boot: registration failed (exit $registration_status); retrying in ${registration_delay}s" >&2
        sleep "$registration_delay" &
        child_pid=$!
        wait "$child_pid"
        child_pid=''
        registration_delay=$((registration_delay * 2))
        [ "$registration_delay" -le 120 ] || registration_delay=120
    fi
done

# Registered. The credential has done its one job and lives on in the daemon
# config on the PVC; drop it (and the host name that only registration reads)
# from this process's environment so the daemon — and every framework process
# it spawns for a turn — never inherits it. What a `kubectl exec` sees is the
# container's own env and is not ours to scrub here.
unset MF_DAEMON_TOKEN MF_DAEMON_HOST_NAME MF_DAEMON_WORKSPACE_ROOT

# Supervise the daemon: a crash is worth restarting (the buffered turn state is
# on the PVC and a reconnect resumes it), but never at the cost of the
# container. --api-url only when the environment still has it; the daemon
# config carries the one it registered with.
while :; do
    # shellcheck disable=SC2086
    "$MF_BIN" ${MF_API_URL:+--api-url "$MF_API_URL"} daemon start --foreground &
    child_pid=$!
    wait "$child_pid"
    echo "mf-daemon-boot: daemon exited ($?); restarting in ${RESTART_DELAY_SECONDS}s" >&2
    child_pid=''
    sleep "$RESTART_DELAY_SECONDS" &
    child_pid=$!
    wait "$child_pid"
    child_pid=''
done
