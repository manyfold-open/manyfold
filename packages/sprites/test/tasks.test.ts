import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildKeepAliveCleanupScript,
    buildKeepAliveLeaseScript,
    buildKeepAliveScript,
    buildRuntimeReportEnvFile,
    buildRuntimeReportScript,
    buildServiceStartScript
} from '../src/tasks'

test('buildKeepAliveScript embeds taskName, exec, and a renewal loop', () => {
    const script = buildKeepAliveScript({
        taskName: 'hermes-keepalive',
        ttl: '1h',
        exec: ['bash', '-lc', 'exec /home/sprite/.hermes/run.sh']
    })
    assert.match(script, /^#!\/usr\/bin\/env bash/)
    assert.match(script, /TASK_NAME='hermes-keepalive'/)
    assert.match(script, /POST \/v1\/tasks/)
    assert.match(script, /PUT "\/v1\/tasks\/\$TASK_NAME"/)
    assert.match(script, /DELETE "\/v1\/tasks\/\$TASK_NAME"/)
    assert.match(script, /trap cleanup EXIT/)
    assert.match(script, /sleep 900\b/) // default refresh = 1h / 4 = 900s
    // wrapped process runs as a child + wait (not `exec`), so the cleanup trap
    // survives to release the keep-alive task when the service is stopped
    assert.match(
        script,
        /'bash' '-lc' 'exec \/home\/sprite\/\.hermes\/run\.sh' &/
    )
    assert.match(script, /wait "\$APP_PID"/)
    assert.match(script, /trap 'exit 0' TERM/)
    assert.doesNotMatch(script, /trap 'exit 143' TERM/)
    assert.doesNotMatch(script, /^exec /m)
})

test('buildKeepAliveScript honors custom refreshIntervalSeconds', () => {
    const script = buildKeepAliveScript({
        taskName: 'oc',
        ttl: '5m',
        refreshIntervalSeconds: 60,
        exec: ['true']
    })
    assert.match(script, /sleep 60\b/)
})

test('buildKeepAliveScript clamps refresh to minimum 30s', () => {
    const script = buildKeepAliveScript({
        taskName: 't',
        ttl: '5m',
        refreshIntervalSeconds: 5,
        exec: ['true']
    })
    assert.match(script, /sleep 30\b/)
})

test('buildKeepAliveScript rejects unsafe taskName chars', () => {
    assert.throws(() =>
        buildKeepAliveScript({
            taskName: 'has space',
            ttl: '1h',
            exec: ['true']
        })
    )
    assert.throws(() =>
        buildKeepAliveScript({
            taskName: 'with$dollar',
            ttl: '1h',
            exec: ['true']
        })
    )
})

test('buildKeepAliveScript rejects malformed ttl', () => {
    assert.throws(() =>
        buildKeepAliveScript({
            taskName: 't',
            ttl: 'forever',
            exec: ['true']
        })
    )
    assert.throws(() =>
        buildKeepAliveScript({
            taskName: 't',
            ttl: '1y',
            exec: ['true']
        })
    )
})

test('buildKeepAliveScript rejects refresh >= ttl', () => {
    assert.throws(() =>
        buildKeepAliveScript({
            taskName: 't',
            ttl: '30s',
            refreshIntervalSeconds: 60,
            exec: ['true']
        })
    )
})

test('buildKeepAliveScript rejects empty exec', () => {
    assert.throws(() =>
        buildKeepAliveScript({ taskName: 't', ttl: '1h', exec: [] })
    )
})

test('buildKeepAliveScript shell-quotes exec args containing single quotes', () => {
    const script = buildKeepAliveScript({
        taskName: 't',
        ttl: '1h',
        exec: ['bash', '-c', "echo 'hi'"]
    })
    // single quotes inside single-quoted bash strings: '\'' pattern
    assert.match(script, /'echo '\\''hi'\\'''/)
})

test('buildKeepAliveScript json bodies do not interpolate taskName via shell', () => {
    const script = buildKeepAliveScript({
        taskName: 'fixedname',
        ttl: '1h',
        exec: ['true']
    })
    // create body should be a literal single-quoted JSON, not constructed from
    // the runtime $TASK_NAME variable
    assert.match(
        script,
        /POST \/v1\/tasks -d '\{"name":"fixedname","expire":"1h"\}'/
    )
})

// WHY: the wake path must be structurally incapable of registering a billing
// task — default-off is enforced at the script layer, not by caller discipline.
test('buildServiceStartScript execs the argv with no task, pid, or trap machinery', () => {
    const script = buildServiceStartScript({
        exec: ['bash', '-lc', 'exec /home/sprite/.hermes/run.sh']
    })
    assert.match(script, /^#!\/usr\/bin\/env bash/)
    assert.match(
        script,
        /^exec 'bash' '-lc' 'exec \/home\/sprite\/\.hermes\/run\.sh'$/m
    )
    assert.doesNotMatch(script, /\/v1\/tasks/)
    assert.doesNotMatch(script, /\.pid/)
    assert.doesNotMatch(script, /trap /)
    assert.throws(() => buildServiceStartScript({ exec: [] }))
})

// WHY: the reporter must never block or hold a service start, and `exec` must
// stay the LAST statement so stopService's TERM keeps hitting the framework
// process directly — the Phase 2 contract the report option must not erode.
test('buildServiceStartScript with report spawns the reporter guarded and detached before the exec line', () => {
    const script = buildServiceStartScript({
        exec: ['bash', '-lc', 'exec /home/sprite/.hermes/run.sh'],
        report: {
            scriptPath: '/home/sprite/.hermes/.nca/keepalive/report.sh',
            logPath: '/home/sprite/.hermes/.nca/keepalive/report.log'
        }
    })
    const spawnLine =
        "[ -x '/home/sprite/.hermes/.nca/keepalive/report.sh' ] && setsid nohup bash '/home/sprite/.hermes/.nca/keepalive/report.sh' </dev/null >'/home/sprite/.hermes/.nca/keepalive/report.log' 2>&1 &"
    assert.ok(
        script.includes(spawnLine),
        'spawn line must be guarded ([ -x ]) and detached (setsid nohup, </dev/null, trailing &)'
    )
    const statements = script.trimEnd().split('\n')
    assert.equal(
        statements[statements.length - 1],
        "exec 'bash' '-lc' 'exec /home/sprite/.hermes/run.sh'",
        'exec must remain the LAST statement (reporter must never hold stdio or shield the framework from TERM)'
    )
    assert.ok(
        script.indexOf(spawnLine) < script.indexOf('\nexec '),
        'reporter spawn must precede the exec line'
    )
})

// WHY: degraded rewrites (missing token or PUBLIC_API_BASE_URL) and the legacy
// fleet fall back to the no-report shape — those paths must not change wake
// behavior in any way, so the output stays byte-identical to Phase 2.
test('buildServiceStartScript without report is byte-identical to the Phase 2 output', () => {
    const script = buildServiceStartScript({
        exec: ['bash', '-lc', 'exec /home/sprite/.hermes/run.sh']
    })
    assert.equal(
        script,
        [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            "exec 'bash' '-lc' 'exec /home/sprite/.hermes/run.sh'",
            ''
        ].join('\n')
    )
})

// WHY: the wake path rotates the generation seconds after boot (ensureLease
// rewrites report.env); sourcing the env once at the top would make every
// wake's ready report carry the pre-rotation generation and be rejected as
// stale — the acceptance criterion 'service start produces a ready report'
// would fail on every wake.
test('buildRuntimeReportScript re-sources report.env inside the post helper, per attempt', () => {
    const script = buildRuntimeReportScript({
        envPath: '/home/sprite/.hermes/.nca/keepalive/report.env',
        probeBudgetSec: 120
    })
    const sourceLine = '. "$ENV_PATH"'
    assert.equal(
        script.split(sourceLine).length - 1,
        1,
        'env file must be sourced in exactly one place'
    )
    const postFn = /^post\(\) \{[\s\S]*?^\}/m.exec(script)?.[0] ?? ''
    assert.ok(
        postFn.includes(sourceLine),
        'env file must be sourced INSIDE post(), so each attempt re-reads a rotated generation'
    )
})

// WHY: the reporter is fail-silent by contract — it must never block, crash,
// or hold a service start, and outbound posts use plain curl because
// sprite-env is local-socket-only (and must never touch /v1/tasks billing).
test('buildRuntimeReportScript has no set -e, no sprite-env, and exits 0 on every path', () => {
    const script = buildRuntimeReportScript({
        envPath: '/x/report.env',
        probeBudgetSec: 120
    })
    assert.doesNotMatch(
        script,
        /^\s*set -e/m,
        'errexit would let a failed curl kill the reporter mid-sequence'
    )
    assert.doesNotMatch(script, /sprite-env/)
    assert.doesNotMatch(script, /\/v1\/tasks/)
    assert.match(script, /-H "Authorization: Bearer \$RUNTIME_REPORT_TOKEN"/)
    const exits = script.match(/\bexit \S+/g) ?? []
    assert.ok(exits.length > 0)
    for (const exit of exits) {
        assert.equal(exit, 'exit 0', 'every exit path must be exit 0')
    }
})

// WHY: starting is best-effort before the probe; ready may only be claimed
// after a live health probe succeeds within a bounded budget — startService
// returning means the process spawned, not that it serves traffic.
test('buildRuntimeReportScript posts starting, probes within the budget, then posts ready', () => {
    const script = buildRuntimeReportScript({
        envPath: '/x/report.env',
        probeBudgetSec: 90
    })
    const startingAt = script.indexOf('post starting')
    const probeAt = script.indexOf(
        'curl -sf -m 5 -o /dev/null "$RUNTIME_REPORT_HEALTH_URL"'
    )
    const readyAt = script.indexOf('post ready')
    assert.ok(startingAt >= 0, 'must post event=starting')
    assert.ok(probeAt >= 0, 'must probe the local health URL')
    assert.ok(readyAt >= 0, 'must post event=ready')
    assert.ok(startingAt < probeAt, 'starting must be posted before the probe loop')
    assert.ok(probeAt < readyAt, 'ready must be posted only after the probe loop')
    assert.match(
        script,
        /deadline=\$\(\( \$\(date \+%s\) \+ 90 \)\)/,
        'probe loop must be bounded by the configured budget'
    )
})

// WHY: a 409 means stale generation — the per-attempt re-source picks up a
// rotated value, but the SAME generation rejected repeatedly will never be
// accepted, so the reporter must give up after a bounded count instead of
// burning the full retry budget on a dead fence.
test('buildRuntimeReportScript gives up after bounded same-generation 409s', () => {
    const script = buildRuntimeReportScript({
        envPath: '/x/report.env',
        probeBudgetSec: 120
    })
    assert.match(script, /409\)/)
    assert.match(script, /if \[ "\$POST_GENERATION" = "\$conflict_generation" \]/)
    assert.match(script, /if \[ "\$conflict_count" -ge 3 \]/)
})

// WHY: report.env is shell-sourced on the sprite — every value (the bearer
// token especially) must round-trip through shellSingleQuote so an embedded
// quote can neither break the file nor inject shell.
test('buildRuntimeReportEnvFile emits all five RUNTIME_REPORT_* keys single-quoted', () => {
    const env = buildRuntimeReportEnvFile({
        url: 'https://api.example.com/api/internal/runtime-reports',
        token: "tok'en",
        runtimeId: 'rt_abc123',
        generation: 'a1b2c3d4e5f6',
        healthUrl: 'http://127.0.0.1:8642/v1/health'
    })
    assert.match(
        env,
        /^RUNTIME_REPORT_URL='https:\/\/api\.example\.com\/api\/internal\/runtime-reports'$/m
    )
    // single quote inside a single-quoted value: '\'' pattern
    assert.match(env, /^RUNTIME_REPORT_TOKEN='tok'\\''en'$/m)
    assert.match(env, /^RUNTIME_REPORT_RUNTIME_ID='rt_abc123'$/m)
    assert.match(env, /^RUNTIME_REPORT_GENERATION='a1b2c3d4e5f6'$/m)
    assert.match(
        env,
        /^RUNTIME_REPORT_HEALTH_URL='http:\/\/127\.0\.0\.1:8642\/v1\/health'$/m
    )
})

// WHY: concurrent spawns (toggle + reconcile Pass B in the same minute) must
// collapse to one renewer with renew.pid always pointing at the survivor.
test('buildKeepAliveLeaseScript flocks keepalive.lock and writes renew.pid after the lock', () => {
    const script = buildKeepAliveLeaseScript({
        taskName: 'nca-hermes-abcdef234567abcdef234567ab-gen123',
        taskPrefix: 'nca-hermes-abcdef234567abcdef234567ab-',
        ttl: '5m',
        refreshIntervalSeconds: 60,
        stateDir: '/home/sprite/.hermes/.nca/keepalive'
    })
    assert.match(script, /exec 9>"\$STATE_DIR\/keepalive\.lock"/)
    assert.match(script, /flock -n 9 \|\| exit 0/)
    assert.match(script, /printf '%s\\n' "\$\$" > "\$STATE_DIR\/renew\.pid"/)
    assert.ok(
        script.indexOf('flock -n 9') <
            script.indexOf(`"$$" > "$STATE_DIR/renew.pid"`)
    )
})

// WHY: the slot must be held promptly at spawn, and a TERM'd loop must never
// re-create the task after cleanup deleted it (trap runs when `wait` returns,
// before the next renewal).
test('buildKeepAliveLeaseScript holds the task synchronously and releases it on exit', () => {
    const script = buildKeepAliveLeaseScript({
        taskName: 'nca-openclaw-abc-gen',
        taskPrefix: 'nca-openclaw-abc-',
        ttl: '5m',
        refreshIntervalSeconds: 60,
        stateDir: '/tmp/keepalive'
    })
    assert.ok(
        script.indexOf('task_create || task_renew') <
            script.indexOf('while true; do')
    )
    assert.match(script, /sleep 60 & wait \$! \|\| true/)
    assert.match(script, /trap cleanup EXIT/)
    assert.match(script, /trap 'exit 0' TERM/)
    assert.match(script, /cleanup\(\) \{\n {4}task_delete\n {4}rm -f "\$STATE_DIR\/renew\.pid"\n\}/)
    assert.throws(() =>
        buildKeepAliveLeaseScript({
            taskName: 'nca-openclaw-abc-gen',
            taskPrefix: 'nca-openclaw-abc-',
            ttl: '5m',
            refreshIntervalSeconds: 300,
            stateDir: '/tmp/keepalive'
        })
    )
})

// WHY: lease-only cleanup is the toggle-off and legacy-convergence weapon and
// must never kill the live framework mid-turn.
test('buildKeepAliveCleanupScript killAppProcesses:false omits app.pid but still deletes tasks', () => {
    const leaseOnly = buildKeepAliveCleanupScript({
        taskName: 'nca-hermes-abc-gen',
        taskPrefix: 'nca-hermes-abc-',
        legacyTaskNames: ['hermes-keepalive'],
        stateDir: '/home/sprite/.hermes/.nca/keepalive',
        killAppProcesses: false,
        killStartScriptProcesses: false
    })
    assert.match(leaseOnly, /KILL_APP_PROCESSES=0/)
    assert.match(leaseOnly, /KILL_START_SCRIPT_PROCESSES=0/)
    assert.match(
        leaseOnly,
        /pid_files = \["renew\.pid"\] \+ \(\["app\.pid"\] if kill_app_processes else \[\]\)/
    )
    assert.match(leaseOnly, /LEGACY_TASKS_JSON='\["hermes-keepalive"\]'/)
    assert.match(leaseOnly, /name\.startswith\(task_prefix\)/)

    const full = buildKeepAliveCleanupScript({
        taskPrefix: 'nca-hermes-abc-',
        stateDir: '/home/sprite/.hermes/.nca/keepalive'
    })
    assert.match(full, /KILL_APP_PROCESSES=1/)
})

// WHY: a lost renew.pid must be structurally unable to orphan a renewer —
// the legacy fused start.sh's EXIT trap rm's renew.pid when stopService TERMs
// the parent shell, so pid-file kills alone would leave the v2 lease loop
// renewing (and billing) forever after a user-stop or framework crash.
test('buildKeepAliveCleanupScript always scans /proc for keepalive.sh, even lease-only', () => {
    const leaseOnly = buildKeepAliveCleanupScript({
        taskName: 'nca-hermes-abc-gen',
        taskPrefix: 'nca-hermes-abc-',
        stateDir: '/home/sprite/.hermes/.nca/keepalive',
        killAppProcesses: false,
        killStartScriptProcesses: false
    })
    assert.match(
        leaseOnly,
        /scan_targets = \[os\.path\.join\(state_dir, "keepalive\.sh"\)\]/
    )
    // The /proc walk is unconditional; only the start.sh target is gated.
    assert.match(
        leaseOnly,
        /if kill_start_script_processes and start_script_path:\n {4}scan_targets\.append\(start_script_path\)\nfor entry in os\.listdir\("\/proc"\)/
    )
    assert.match(
        leaseOnly,
        /if any\(target in cmdline for target in scan_targets\):/
    )
})

test('buildKeepAliveCleanupScript deletes current prefix and legacy tasks', () => {
    const script = buildKeepAliveCleanupScript({
        taskName: 'nca-narranexus-abc-gen',
        taskPrefix: 'nca-narranexus-abc-',
        legacyTaskNames: ['narranexus-keepalive'],
        stateDir: '/home/sprite/.narranexus/.nca/keepalive',
        startScriptPath: '/home/sprite/.narranexus/start.sh',
        killStartScriptProcesses: true
    })

    assert.match(script, /TASK_NAME='nca-narranexus-abc-gen'/)
    assert.match(script, /TASK_PREFIX='nca-narranexus-abc-'/)
    assert.match(script, /LEGACY_TASKS_JSON='\["narranexus-keepalive"\]'/)
    assert.match(
        script,
        /START_SCRIPT_PATH='\/home\/sprite\/\.narranexus\/start\.sh'/
    )
    assert.match(script, /KILL_START_SCRIPT_PROCESSES=1/)
    assert.match(script, /remainingTasks/)
    assert.match(script, /deletedTasks/)
    assert.match(script, /"404" in res\.stderr/)
    assert.match(script, /sprite-env", "curl", "-s", "-X", "DELETE"/)
})

// WHY: full cleanup (wake's pre-start cleanup, stop's final cleanup) must kill
// stale reporter probe loops, but lease-only cleanup (toggle-off, Pass A) must
// leave the current boot's reporter alone — the embedded python gates the
// report.sh scan on the same KILL_START_SCRIPT_PROCESSES flag.
test('buildKeepAliveCleanupScript scans for report.sh only under killStartScriptProcesses', () => {
    const full = buildKeepAliveCleanupScript({
        taskPrefix: 'nca-hermes-abc-',
        stateDir: '/home/sprite/.hermes/.nca/keepalive',
        killStartScriptProcesses: true
    })
    assert.match(full, /KILL_START_SCRIPT_PROCESSES=1/)
    assert.match(
        full,
        /if kill_start_script_processes:\n {4}scan_targets\.append\(os\.path\.join\(state_dir, "report\.sh"\)\)/,
        'report.sh must join scan_targets only inside the kill_start_script_processes branch'
    )
    // the flag gating the branch is the exported env var, so a lease-only
    // cleanup (flag 0) never scans for report.sh
    assert.match(
        full,
        /kill_start_script_processes = os\.environ\.get\("KILL_START_SCRIPT_PROCESSES"\) == "1"/
    )
    assert.doesNotMatch(
        full,
        /scan_targets = \[[^\]]*report\.sh/,
        'report.sh must never be in the unconditional base scan list'
    )

    const leaseOnly = buildKeepAliveCleanupScript({
        taskPrefix: 'nca-hermes-abc-',
        stateDir: '/home/sprite/.hermes/.nca/keepalive',
        killAppProcesses: false,
        killStartScriptProcesses: false
    })
    assert.match(leaseOnly, /KILL_START_SCRIPT_PROCESSES=0/)
})
