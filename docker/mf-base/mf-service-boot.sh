#!/bin/sh
set -u

mf-daemon-boot &
runner_pid=$!
(
    unset MF_DAEMON_TOKEN MF_DAEMON_HOST_NAME MF_DAEMON_WORKSPACE_ROOT MF_CONFIG_DIR MF_PROFILE
    exec "$@"
) &
gateway_pid=$!

stop() {
    trap '' TERM INT
    kill -TERM "$gateway_pid" "$runner_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
}
trap 'stop; exit 143' TERM
trap 'stop; exit 130' INT
wait "$gateway_pid"
result=$?
stop
exit "$result"
