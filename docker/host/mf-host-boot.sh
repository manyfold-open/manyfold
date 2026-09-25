#!/bin/sh
# The main process of a Kubernetes pod host (ADR-0035): enrol the host's daemon
# once, then keep it running. The home directory is the pod's PVC, so the daemon
# runs the mf there — the copy `daemon.update` replaces — seeded from the
# image's copy on first boot or when the image carries a newer one, and restored
# from it when an update will not stay up.
set -u

MF_BIN="${MF_BIN:-$HOME/.local/bin/mf}"
IMAGE_MF="${MF_IMAGE_BIN:-/opt/manyfold/bin/mf}"
# Long enough that a daemon failing on something structural (a revoked token,
# an unreachable API) does not hot-loop against the control plane, short enough
# that a transient one is back within a turn's patience.
RESTART_DELAY_SECONDS="${MF_DAEMON_RESTART_DELAY_SECONDS:-10}"
# A daemon that exits this soon after it started, three times running, is not
# going to stay up; the boot then goes back to the image's copy.
FAST_EXIT_SECONDS="${MF_DAEMON_FAST_EXIT_SECONDS:-30}"

# This loop is the daemon's only supervisor and restarts it whenever it exits.
# The marker says so (startup method 'container'), which is what lets the daemon
# take `daemon.update` and restart by exiting.
export MF_DAEMON_SUPERVISOR=container
# MF_CONFIG_DIR must be on the PVC. The daemon uuid lives under it and the
# registration token binds to the first uuid it sees, so a config dir on the
# container filesystem would mint a new uuid on every restart and the pod would
# then be refused with "token already bound to a different daemon".
export MF_CONFIG_DIR="${MF_CONFIG_DIR:-$HOME/.manyfold}"
export MF_PROFILE="${MF_PROFILE:-podrunner}"
DAEMON_CONFIG="$MF_CONFIG_DIR/profiles/$MF_PROFILE/daemon/config.json"
MF_BIN_DIR=$(dirname "$MF_BIN")
case ":$PATH:" in
    *":$MF_BIN_DIR:"*) ;;
    *) PATH="$MF_BIN_DIR:$PATH"; export PATH ;;
esac

hold() {
    echo "mf-host-boot: $1; host unavailable" >&2
    exit 1
}

# The x.y.z an mf binary reports, or nothing when it does not run.
version_of() {
    "$1" --version 2>/dev/null \
        | sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' \
        | head -n 1
}

# True when x.y.z $1 is strictly higher than $2.
newer() {
    awk -v a="$1" -v b="$2" 'BEGIN {
        split(a, x, "."); split(b, y, ".")
        for (i = 1; i <= 3; i++) {
            if (x[i] + 0 > y[i] + 0) exit 0
            if (x[i] + 0 < y[i] + 0) exit 1
        }
        exit 1
    }'
}

image_version=''
[ -x "$IMAGE_MF" ] && image_version=$(version_of "$IMAGE_MF")

seed() {
    mkdir -p "$MF_BIN_DIR" || hold "cannot create $MF_BIN_DIR"
    staged="$MF_BIN.seed.$$"
    if ! { cp "$IMAGE_MF" "$staged" && chmod 755 "$staged" && mv -f "$staged" "$MF_BIN"; }; then
        rm -f "$staged"
        hold "cannot copy the image's mf to $MF_BIN"
    fi
    echo "mf-host-boot: $1; using the image's mf ${image_version:-(unknown version)}" >&2
}

if [ ! -x "$MF_BIN" ]; then
    [ -x "$IMAGE_MF" ] || hold "no mf at $MF_BIN or $IMAGE_MF"
    seed "first boot"
elif [ -n "$image_version" ]; then
    home_version=$(version_of "$MF_BIN")
    if [ -z "$home_version" ]; then
        seed "$MF_BIN does not run"
    elif newer "$image_version" "$home_version"; then
        seed "the image carries a newer mf than $home_version"
    fi
fi

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
# API URL — so a boot whose environment has lost the token must still bring the
# daemon up.
while [ ! -f "$DAEMON_CONFIG" ]; do
    [ -n "${MF_DAEMON_TOKEN:-}" ] || hold "no host credential to register with"
    [ -n "${MF_API_URL:-}" ] || hold "no MF_API_URL to register against"
    echo "mf-host-boot: registering ${MF_DAEMON_HOST_NAME:-this pod}" >&2
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
            3|4|5) hold "registration rejected (exit $registration_status); fix the host credential, configuration or mf version" ;;
        esac
        [ "$registration_attempt" -lt 6 ] || hold "registration failed after $registration_attempt attempts"
        echo "mf-host-boot: registration failed (exit $registration_status); retrying in ${registration_delay}s" >&2
        sleep "$registration_delay" &
        child_pid=$!
        wait "$child_pid"
        child_pid=''
        registration_delay=$((registration_delay * 2))
        [ "$registration_delay" -le 120 ] || registration_delay=120
    fi
done

# Registered. The credential has done its one job and lives on in the daemon
# config on the PVC; drop it (and what only registration reads) from this
# process's environment so the daemon — and every process it spawns — never
# inherits it.
unset MF_DAEMON_TOKEN MF_DAEMON_HOST_NAME MF_DAEMON_WORKSPACE_ROOT

# Keep the daemon running: an exit is a crash, or the restart that completes a
# self-update. Either way it starts again; one that keeps dying right after it
# starts goes back to the image's mf.
fast_exits=0
while :; do
    started=$(date +%s)
    # shellcheck disable=SC2086
    "$MF_BIN" ${MF_API_URL:+--api-url "$MF_API_URL"} daemon start --foreground &
    child_pid=$!
    wait "$child_pid"
    status=$?
    child_pid=''
    if [ $(($(date +%s) - started)) -lt "$FAST_EXIT_SECONDS" ]; then
        fast_exits=$((fast_exits + 1))
    else
        fast_exits=0
    fi
    if [ "$fast_exits" -ge 3 ] && [ -x "$IMAGE_MF" ] && ! cmp -s "$IMAGE_MF" "$MF_BIN"; then
        seed "the daemon exited $fast_exits times within ${FAST_EXIT_SECONDS}s of starting"
        fast_exits=0
    fi
    echo "mf-host-boot: daemon exited ($status); restarting in ${RESTART_DELAY_SECONDS}s" >&2
    sleep "$RESTART_DELAY_SECONDS" &
    child_pid=$!
    wait "$child_pid"
    child_pid=''
done
