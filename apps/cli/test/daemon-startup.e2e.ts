import assert from 'node:assert/strict'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { WebSocketServer } from 'ws'
import { profilePaths } from '@manyfold/shared'
import { queryDaemonHealth } from '../src/daemon/control'
import { buildPlist, launchdLabelFor } from '../src/daemon/init-unit/darwin'

assert.equal(process.env.RUN_DAEMON_STARTUP_E2E, '1')
assert.equal(process.platform, 'darwin')
const binary = resolve(process.argv[2])
const reportDirectory = resolve(process.argv[3])
await mkdir(reportDirectory, { recursive: true })
const directory = await mkdtemp('/tmp/mf1277-')
const profile = 'qa1277-' + randomUUID().slice(0, 8)
const label = launchdLabelFor(profile)
const domain = `gui/${process.getuid!()}`
const target = `${domain}/${label}`
const paths = profilePaths(directory, profile)
const pidFile = join(directory, 'probe.pids')
const logFile = join(paths.daemonDir, 'daemon.log')
const shell = join(directory, 'zsh')
const bin = join(directory, '.local/bin')
const report: {
    profile: string
    label: string
    cases: string[]
    pass?: boolean
    cleaned?: boolean
} = { profile, label, cases: [] }
const exec = promisify(execFile)
const wait = async (
    predicate: () => Promise<boolean>,
    label: string,
    timeoutMs = 15000
) => {
    const until = Date.now() + timeoutMs
    while (!(await predicate())) {
        assert.ok(Date.now() < until, label)
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
}
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}
let connections = 0
let hellos = 0
const http = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ldt_fixture')
    request.resume()
    response.setHeader('Content-Type', 'application/json')
    response.end('{}')
})
const wss = new WebSocketServer({ server: http })
wss.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer ldt_fixture')
    connections++
    socket.on('message', (raw) => {
        const message = JSON.parse(String(raw))
        if (message.type === 'hello') {
            hellos++
            socket.send(
                JSON.stringify({
                    type: 'welcome',
                    daemonId: 'ldh_fixture',
                    serverTime: new Date().toISOString(),
                    runtimeIds: []
                })
            )
        }
        if (message.type === 'ping')
            socket.send(JSON.stringify({ type: 'pong' }))
    })
})
await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
const address = http.address()
assert.ok(address && typeof address === 'object')
await mkdir(paths.daemonDir, { recursive: true })
await mkdir(bin, { recursive: true })
for (const name of ['claude', 'codex', 'gemini', 'pi', 'openclaw', 'hermes'])
    await writeFile(join(bin, name), '#!/bin/sh\nprintf "fixture 1.0\\n"\n', {
        mode: 0o755
    })
await writeFile(
    shell,
    `#!/bin/sh
IFS= read -r first < "$MF_FIXTURE_LOG"
case "$first" in *"daemon starting "*) ;; *) exit 12 ;; esac
trap '' TERM
echo $$ >> "$MF_TEST_PROBE_PID_FILE"
/bin/sh -c 'trap "" TERM; echo $$ >> "$MF_TEST_PROBE_PID_FILE"; while :; do /bin/sleep 1; done' &
wait
`,
    { mode: 0o755 }
)
const env = {
    HOME: directory,
    PATH: `${bin}:/usr/bin:/bin`,
    SHELL: shell,
    MF_CONFIG_DIR: directory,
    MF_PROFILE: profile,
    MF_DAEMON_AUTO_UPDATE: '0',
    MF_FIXTURE_LOG: logFile,
    MF_TEST_PROBE_PID_FILE: pidFile,
    OPENCLAW_HOME: directory,
    NO_COLOR: '1'
}
const info = JSON.parse(
    execFileSync(binary, ['version', '--json'], { env, encoding: 'utf8' })
)
await writeFile(
    paths.daemonConfigPath,
    JSON.stringify({
        apiUrl: `http://127.0.0.1:${address.port}/api`,
        token: 'ldt_fixture',
        daemonId: 'ldh_fixture',
        daemonUuid: randomUUID(),
        profile,
        channel: info.bakedChannel,
        workspaceBaseDir: join(directory, 'workspaces')
    }),
    { mode: 0o600 }
)
const args = ['daemon', 'start', '--foreground']
let child: ReturnType<typeof spawn> | undefined
let childExited: Promise<unknown> | undefined
let launchdOwned = false
try {
    const started = Date.now()
    child = spawn(binary, args, { env, stdio: 'ignore' })
    childExited = new Promise((resolve) => child!.on('exit', resolve))
    await wait(
        async () => {
            const health = await queryDaemonHealth(
                join(paths.daemonDir, 'daemon.sock')
            )
            return (
                health?.status === 'running' &&
                connections === 1 &&
                hellos === 1
            )
        },
        'foreground did not become healthy and connect upstream',
        10000
    )
    assert.ok(Date.now() - started < 10000)
    assert.equal(connections, 1)
    assert.equal(hellos, 1)
    await assert.rejects(
        exec(binary, args, { env, timeout: 5000 }),
        (error: unknown) => {
            assert.match(
                (error as { stderr: string }).stderr,
                /already running/
            )
            return true
        }
    )
    assert.equal(connections, 1)
    assert.equal(hellos, 1)
    child.kill('SIGTERM')
    await childExited
    assert.equal(child.exitCode, 0)
    await writeFile(
        join(reportDirectory, 'foreground.log'),
        await readFile(logFile)
    )
    await rm(logFile)
    report.cases.push(
        'signed standalone foreground logs before a blocked shell, becomes healthy after timeout and preserves singleton ownership'
    )

    await assert.rejects(exec('launchctl', ['print', target]))
    const plist = join(directory, `${label}.plist`)
    await writeFile(
        plist,
        buildPlist({
            scope: 'user',
            programArgs: [
                '/usr/bin/env',
                ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
                binary,
                ...args
            ],
            home: directory,
            user: 'fixture',
            group: 'fixture',
            errLogPath: join(paths.daemonDir, 'daemon.err.log'),
            profile
        })
    )
    launchdOwned = true
    const launchdStarted = Date.now()
    const priorConnections = connections
    const priorHellos = hellos
    await exec('launchctl', ['bootstrap', domain, plist])
    await wait(
        async () => {
            const health = await queryDaemonHealth(
                join(paths.daemonDir, 'daemon.sock')
            )
            return (
                health?.status === 'running' &&
                connections === priorConnections + 1 &&
                hellos === priorHellos + 1
            )
        },
        'launchd fixture did not become healthy and connect upstream',
        10000
    )
    assert.ok(Date.now() - launchdStarted < 10000)
    assert.equal(connections, priorConnections + 1)
    assert.equal(hellos, priorHellos + 1)
    const health = await queryDaemonHealth(join(paths.daemonDir, 'daemon.sock'))
    assert.equal(health?.startupMethod, 'launchd-user')
    assert.equal(health?.profile, profile)
    await exec('launchctl', ['bootout', target])
    launchdOwned = false
    await wait(async () => !alive(health!.pid), 'launchd fixture did not exit')
    report.cases.push(
        'independent launchd profile reaches the local API after the blocked-shell fallback and exits cleanly'
    )
    const pids = (await readFile(pidFile, 'utf8'))
        .trim()
        .split('\n')
        .map(Number)
    assert.equal(pids.length, 4)
    await wait(
        async () => pids.every((pid) => !alive(pid)),
        'probe descendants survived'
    )
    const log = await readFile(logFile, 'utf8')
    assert.equal(log.match(/PATH probe timeout/g)?.length, 1)
    await writeFile(join(reportDirectory, 'launchd.log'), log)
    report.cases.push(
        'both owned shell process trees have no surviving descendants'
    )
    report.pass = true
} finally {
    if (launchdOwned)
        await exec('launchctl', ['bootout', target]).catch(() => {})
    if (child && child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
    await childExited
    await assert.rejects(exec('launchctl', ['print', target]))
    for (const socket of wss.clients) socket.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
    report.cleaned = true
    await writeFile(
        join(reportDirectory, 'result.json'),
        JSON.stringify(report, null, 2)
    )
}
console.log(JSON.stringify(report))
