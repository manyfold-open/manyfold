import { createHash } from 'node:crypto'

export const WORKSPACE_OPERATION_PHASES = ['archive', 'restore'] as const
export type WorkspaceOperationPhase =
    (typeof WORKSPACE_OPERATION_PHASES)[number]

export const workspaceOperationRoot = (
    key: string,
    operationId: string
): string => {
    if (!/^[a-zA-Z0-9_-]+$/.test(operationId))
        throw new Error('invalid workspace operation id')
    const scope = createHash('sha256').update(key).digest('hex')
    return `/tmp/.manyfold-backup-operations/${scope}/${operationId}`
}

export const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

// kill(0) includes zombies, which a container's PID 1 may never reap. Treat a
// group as idle only when every visible member has exited; an unknown group
// remains busy. /proc avoids requiring procps in minimal Linux images.
const groupAliveScript = [
    'operation_group_alive() {',
    '  local wanted="$1" state parent group rest stat file snapshot matched=0',
    '  kill -0 -- "-$wanted" 2>/dev/null || return 1',
    '  if [ -d /proc/self ]; then',
    '    for file in /proc/[0-9]*/stat; do',
    '      read -r stat 2>/dev/null < "$file" || continue',
    '      rest=${stat##*) }',
    '      read -r state parent group rest <<< "$rest"',
    '      [ "$group" = "$wanted" ] || continue',
    '      matched=1',
    '      case "$state" in Z*|X*) ;; *) return 0 ;; esac',
    '    done',
    '  else',
    '    snapshot=$(ps -axo pgid=,stat= 2>/dev/null) || return 0',
    '    while read -r group state; do',
    '      [ "$group" = "$wanted" ] || continue',
    '      matched=1',
    '      case "$state" in Z*|X*) ;; *) return 0 ;; esac',
    '    done <<< "$snapshot"',
    '  fi',
    '  [ "$matched" -eq 0 ]',
    '}'
]

// A process group remains observable if the API connection or wrapper dies.
// Publish its id before checking cancellation: a recovering caller first writes
// the cancellation marker, then checks that group, closing the late-start race.
export const trackedWorkspaceScript = (
    root: string,
    phase: WorkspaceOperationPhase,
    script: string,
    maxSeconds = 600
): string => {
    if (!Number.isSafeInteger(maxSeconds) || maxSeconds <= 0)
        throw new Error('invalid workspace operation timeout')
    return [
        'set -euo pipefail',
        'umask 077',
        ...groupAliveScript,
        `operation_root=${shellQuote(root)}`,
        `phase_dir="$operation_root/${phase}"`,
        'mkdir -p "$operation_root"',
        'if ! mkdir "$phase_dir" 2>/dev/null; then',
        '  printf "%s\\n" "workspace operation phase was already started or cancelled" >&2',
        '  exit 75',
        'fi',
        'set -m',
        '(',
        '  attempts=0',
        '  while [ ! -f "$phase_dir/pid" ]; do',
        '    if [ -e "$phase_dir/cancelled" ] || [ "$attempts" -ge 100 ]; then exit 75; fi',
        '    attempts=$((attempts + 1))',
        '    sleep 0.1',
        '  done',
        '  if [ -e "$phase_dir/cancelled" ]; then exit 75; fi',
        '  trap \'code=$?; printf "%s\\n" "$code" > "$phase_dir/status"\' EXIT',
        `  bash -c ${shellQuote(script)}`,
        ') &',
        'operation_pid=$!',
        '(',
        '  seconds=0',
        `  while operation_group_alive "$operation_pid" && [ "$seconds" -lt ${maxSeconds} ]; do`,
        '    sleep 1',
        '    seconds=$((seconds + 1))',
        '  done',
        `  if [ "$seconds" -lt ${maxSeconds} ]; then exit 0; fi`,
        '  kill -TERM -- "-$operation_pid" 2>/dev/null || true',
        '  sleep 5',
        '  kill -KILL -- "-$operation_pid" 2>/dev/null || true',
        ') &',
        'watchdog_pid=$!',
        'printf "%s\\n" "$operation_pid" > "$phase_dir/pid.tmp"',
        'mv "$phase_dir/pid.tmp" "$phase_dir/pid"',
        'set +e',
        'wait "$operation_pid"',
        'operation_status=$?',
        'if ! operation_group_alive "$operation_pid"; then',
        '  kill -TERM -- "-$watchdog_pid" 2>/dev/null || true',
        'fi',
        'exit "$operation_status"'
    ].join('\n')
}

export const cancelWorkspaceOperationScript = (root: string): string =>
    [
        'set -euo pipefail',
        'umask 077',
        ...groupAliveScript,
        `operation_root=${shellQuote(root)}`,
        'active=0',
        ...WORKSPACE_OPERATION_PHASES.flatMap((phase) => [
            `phase_dir="$operation_root/${phase}"`,
            'mkdir -p "$phase_dir"',
            ': > "$phase_dir/cancelled"',
            'if [ -f "$phase_dir/pid" ]; then',
            '  operation_pid=$(cat "$phase_dir/pid")',
            '  case "$operation_pid" in ""|*[!0-9]*) exit 76 ;; esac',
            '  if [ "$operation_pid" -le 1 ]; then exit 76; fi',
            '  if operation_group_alive "$operation_pid"; then active=1; fi',
            'fi'
        ]),
        'printf "active=%s\\n" "$active"'
    ].join('\n')
