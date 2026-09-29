// Scripts for the sprite-local /v1/tasks activity API, reachable only from
// inside the VM via /.sprite/api.sock. POST creates {name, expire}; PUT
// renews {expire}; DELETE releases the named task. Nothing here creates one:
// the platform's holds are placed and renewed by the API (ADR-0038).

export interface ServiceStartScriptOptions {
    /** Argv to exec as the framework service process. */
    exec: string[]
    /** One-shot boot reporter spawned detached before the exec line. */
    report?: {
        scriptPath: string
        logPath: string
    }
}

export interface RuntimeReportScriptOptions {
    /** Absolute path of the report.env file sourced before every POST. */
    envPath: string
    /** Health-probe budget in seconds before giving up on the ready report. */
    probeBudgetSec: number
}

export interface RuntimeReportEnvFileOptions {
    url: string
    token: string
    runtimeId: string
    generation: string
    healthUrl: string
}

export interface KeepAliveCleanupOptions {
    taskName?: string
    taskPrefix: string
    stateDir: string
    startScriptPath?: string
    killStartScriptProcesses?: boolean
}

export const shellSingleQuote = (s: string): string =>
    `'${s.replace(/'/g, `'\\''`)}'`

const assertTaskIdentifier = (label: string, value: string): void => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
        throw new Error(
            `keep-alive ${label} must be a task identifier, got '${value}'`
        )
    }
}

const assertAbsolutePath = (label: string, value: string): void => {
    if (!value.startsWith('/') || /[\n\r\0]/.test(value)) {
        throw new Error(
            `keep-alive ${label} must be an absolute path, got '${value}'`
        )
    }
}

// There is no renewal loop for a trap to kill, and `exec` means stopService's
// TERM hits the framework process directly. No /v1/tasks calls, no pid files —
// the wake path is structurally incapable of registering a billing task.
export const buildServiceStartScript = (
    opts: ServiceStartScriptOptions
): string => {
    if (!opts.exec || opts.exec.length === 0) {
        throw new Error('service start script requires `exec` argv to wrap')
    }
    const execLine = opts.exec.map(shellSingleQuote).join(' ')
    const lines = ['#!/usr/bin/env bash', 'set -euo pipefail']
    if (opts.report) {
        assertAbsolutePath('reportScriptPath', opts.report.scriptPath)
        assertAbsolutePath('reportLogPath', opts.report.logPath)
        // Guarded + detached so the reporter can never block the boot or hold
        // stdio, and `exec` stays the last statement so stopService's TERM
        // keeps hitting the framework process. `>` truncates report.log per
        // boot. The whole [ -x ] && ... list is backgrounded, so a missing
        // reporter cannot trip set -e.
        lines.push(
            `[ -x ${shellSingleQuote(opts.report.scriptPath)} ] && setsid nohup bash ${shellSingleQuote(opts.report.scriptPath)} </dev/null >${shellSingleQuote(opts.report.logPath)} 2>&1 &`
        )
    }
    lines.push(`exec ${execLine}`, '')
    return lines.join('\n')
}

// One-shot boot reporter spawned from start.sh: POST starting, probe the
// local health endpoint within a bounded budget, POST ready. Plain outbound
// curl, NEVER sprite-env (local-socket-only) — and no /v1/tasks calls, so
// reporting can never register a billing task.
export const buildRuntimeReportScript = (
    opts: RuntimeReportScriptOptions
): string => {
    assertAbsolutePath('reportEnvPath', opts.envPath)
    if (!Number.isInteger(opts.probeBudgetSec) || opts.probeBudgetSec <= 0) {
        throw new Error(
            `report probeBudgetSec must be a positive integer, got '${opts.probeBudgetSec}'`
        )
    }
    return [
        '#!/usr/bin/env bash',
        '# Fail-silent by design: deliberately no `set -e`, and every path exits 0',
        '# — the reporter must never block, crash, or hold a service start.',
        `ENV_PATH=${shellSingleQuote(opts.envPath)}`,
        'POST_CODE=000',
        'POST_GENERATION=""',
        '',
        '# Re-source the env file on EVERY post: the wake path rotates the',
        '# generation (ensureLease rewrites report.env seconds after boot), and a',
        '# ready report carrying the pre-rotation value is rejected as stale.',
        'post() {',
        '    POST_CODE=000',
        '    POST_GENERATION=""',
        '    . "$ENV_PATH" 2>/dev/null || return 0',
        '    POST_GENERATION="$RUNTIME_REPORT_GENERATION"',
        `    POST_CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$RUNTIME_REPORT_URL" \\`,
        '        -H "Authorization: Bearer $RUNTIME_REPORT_TOKEN" \\',
        "        -H 'Content-Type: application/json' \\",
        `        -d "{\\"runtimeId\\":\\"$RUNTIME_REPORT_RUNTIME_ID\\",\\"generation\\":\\"$RUNTIME_REPORT_GENERATION\\",\\"event\\":\\"$1\\"}")`,
        '}',
        '',
        '# starting is best-effort — the ready report is the one that matters',
        'for attempt in 1 2; do',
        '    post starting',
        '    case "$POST_CODE" in 2*) break ;; esac',
        '    [ "$attempt" -lt 2 ] && sleep 2',
        'done',
        '',
        `deadline=$(( $(date +%s) + ${opts.probeBudgetSec} ))`,
        'probe_ok=0',
        'while [ "$(date +%s)" -lt "$deadline" ]; do',
        '    if curl -sf -m 5 -o /dev/null "$RUNTIME_REPORT_HEALTH_URL"; then',
        '        probe_ok=1',
        '        break',
        '    fi',
        '    sleep 2',
        'done',
        'if [ "$probe_ok" -ne 1 ]; then',
        `    echo "runtime report: health probe budget (${opts.probeBudgetSec}s) exhausted, ready not reported" >&2`,
        '    exit 0',
        'fi',
        '',
        '# 2xx terminal; 409 = stale generation (the re-source picks up a rotated',
        '# value, but the same generation rejected 3x will never be accepted);',
        '# 401/5xx/network retried — absorbs the bootstrap window before the',
        '# credentials row exists.',
        'conflict_count=0',
        'conflict_generation=""',
        'for attempt in 1 2 3 4 5; do',
        '    post ready',
        '    case "$POST_CODE" in',
        '        2*) exit 0 ;;',
        '        409)',
        '            if [ "$POST_GENERATION" = "$conflict_generation" ]; then',
        '                conflict_count=$((conflict_count + 1))',
        '            else',
        '                conflict_generation="$POST_GENERATION"',
        '                conflict_count=1',
        '            fi',
        '            if [ "$conflict_count" -ge 3 ]; then',
        '                echo "runtime report: ready rejected as stale generation, giving up" >&2',
        '                exit 0',
        '            fi',
        '            ;;',
        '    esac',
        '    [ "$attempt" -lt 5 ] && sleep 15',
        'done',
        'echo "runtime report: ready report attempts exhausted" >&2',
        'exit 0',
        ''
    ].join('\n')
}

export const buildRuntimeReportEnvFile = (
    opts: RuntimeReportEnvFileOptions
): string =>
    [
        `RUNTIME_REPORT_URL=${shellSingleQuote(opts.url)}`,
        `RUNTIME_REPORT_TOKEN=${shellSingleQuote(opts.token)}`,
        `RUNTIME_REPORT_RUNTIME_ID=${shellSingleQuote(opts.runtimeId)}`,
        `RUNTIME_REPORT_GENERATION=${shellSingleQuote(opts.generation)}`,
        `RUNTIME_REPORT_HEALTH_URL=${shellSingleQuote(opts.healthUrl)}`,
        ''
    ].join('\n')

export const buildKeepAliveCleanupScript = (
    opts: KeepAliveCleanupOptions
): string => {
    if (opts.taskName) assertTaskIdentifier('taskName', opts.taskName)
    assertTaskIdentifier('taskPrefix', opts.taskPrefix)
    assertAbsolutePath('stateDir', opts.stateDir)
    if (opts.startScriptPath) {
        assertAbsolutePath('startScriptPath', opts.startScriptPath)
    }
    return [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `export TASK_NAME=${shellSingleQuote(opts.taskName ?? '')}`,
        `export TASK_PREFIX=${shellSingleQuote(opts.taskPrefix)}`,
        `export STATE_DIR=${shellSingleQuote(opts.stateDir)}`,
        `export START_SCRIPT_PATH=${shellSingleQuote(opts.startScriptPath ?? '')}`,
        `export KILL_START_SCRIPT_PROCESSES=${opts.killStartScriptProcesses ? '1' : '0'}`,
        "python3 - <<'PY'",
        'import json, os, signal, subprocess, time',
        '',
        'task_name = os.environ.get("TASK_NAME", "")',
        'task_prefix = os.environ["TASK_PREFIX"]',
        'state_dir = os.environ["STATE_DIR"]',
        'start_script_path = os.environ.get("START_SCRIPT_PATH", "")',
        'kill_start_script_processes = os.environ.get("KILL_START_SCRIPT_PROCESSES") == "1"',
        'errors = []',
        'deleted = []',
        'killed = []',
        '',
        'def run(args):',
        '    return subprocess.run(args, text=True, capture_output=True)',
        '',
        'def list_tasks():',
        '    res = run(["sprite-env", "curl", "-s", "/v1/tasks"])',
        '    if res.returncode != 0:',
        '        errors.append({"op": "list", "stderr": res.stderr.strip()})',
        '        return []',
        '    try:',
        '        body = json.loads(res.stdout or "{}")',
        '    except Exception as exc:',
        '        errors.append({"op": "parse", "error": str(exc), "stdout": res.stdout})',
        '        return []',
        '    return [t.get("name", "") for t in body.get("tasks", []) if isinstance(t, dict)]',
        '',
        'def delete_task(name):',
        '    if not name:',
        '        return',
        '    res = run(["sprite-env", "curl", "-s", "-X", "DELETE", f"/v1/tasks/{name}"])',
        '    if res.returncode == 0:',
        '        deleted.append(name)',
        '    elif "404" in res.stderr or "not found" in res.stderr.lower():',
        '        return',
        '    else:',
        '        errors.append({"op": "delete", "task": name, "stderr": res.stderr.strip()})',
        '',
        'def kill_pid(pid):',
        '    if pid <= 1 or pid in {os.getpid(), os.getppid()}:',
        '        return',
        '    try:',
        '        os.kill(pid, signal.SIGTERM)',
        '        killed.append(pid)',
        '    except ProcessLookupError:',
        '        return',
        '    except Exception as exc:',
        '        errors.append({"op": "kill", "pid": pid, "error": str(exc)})',
        '',
        'path = os.path.join(state_dir, "app.pid")',
        'try:',
        '    with open(path, "r", encoding="utf-8") as fh:',
        '        kill_pid(int(fh.read().strip()))',
        'except FileNotFoundError:',
        '    pass',
        'except Exception as exc:',
        '    errors.append({"op": "pid_file", "path": path, "error": str(exc)})',
        '',
        'scan_targets = []',
        'if kill_start_script_processes:',
        '    scan_targets.append(os.path.join(state_dir, "report.sh"))',
        'if kill_start_script_processes and start_script_path:',
        '    scan_targets.append(start_script_path)',
        'for entry in os.listdir("/proc"):',
        '    if not entry.isdigit():',
        '        continue',
        '    pid = int(entry)',
        '    if pid in {os.getpid(), os.getppid()}:',
        '        continue',
        '    try:',
        '        with open(f"/proc/{pid}/cmdline", "rb") as fh:',
        '            cmdline = fh.read().replace(b"\\0", b" ").decode("utf-8", "replace")',
        '    except Exception:',
        '        continue',
        '    if any(target in cmdline for target in scan_targets):',
        '        kill_pid(pid)',
        '',
        'wanted = set()',
        'if task_name:',
        '    wanted.add(task_name)',
        'for name in list_tasks():',
        '    if name.startswith(task_prefix):',
        '        wanted.add(name)',
        'for name in sorted(wanted):',
        '    delete_task(name)',
        '',
        'time.sleep(0.2)',
        'remaining = [name for name in list_tasks() if name.startswith(task_prefix) or name in wanted]',
        'print(json.dumps({"deletedTasks": deleted, "remainingTasks": remaining, "killedPids": killed, "errors": errors}, sort_keys=True))',
        'PY',
        ''
    ].join('\n')
}

// One task in a `GET /v1/tasks` listing.
export interface SpriteTask {
    name: string
    startedAt: string | null
    expiresAt: string | null
}

// The listing `sprite-env curl -s /v1/tasks` prints, or null when the output
// is not one: `sprite-env curl` rejects `-f`, so a listing that parses is the
// only proof a task call went through.
export const parseTaskList = (stdout: string): SpriteTask[] | null => {
    let body: unknown
    try {
        body = JSON.parse(stdout.trim())
    } catch {
        return null
    }
    const tasks = (body as { tasks?: unknown } | null)?.tasks
    if (!Array.isArray(tasks)) return null
    return tasks.flatMap((task: Record<string, unknown> | null) =>
        typeof task?.name === 'string'
            ? [
                  {
                      name: task.name,
                      startedAt:
                          typeof task.started_at === 'string'
                              ? task.started_at
                              : null,
                      expiresAt:
                          typeof task.expires_at === 'string'
                              ? task.expires_at
                              : null
                  }
              ]
            : []
    )
}
