import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import {
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { profilePaths, type DaemonWsFrame } from '@manyfold/shared'
import { type WebSocket, WebSocketServer } from 'ws'
import { queryDaemonHealth } from '../src/daemon/control'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 20000
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'foreground fixture timed out')
        await delay(10)
    }
}
interface Process {
    child: ChildProcess
    ready: boolean
    done: boolean
    output: string
    error: string
    exited: Promise<void>
}

const fixture = async (shellBody?: string) => {
    const dir = await mkdtemp('/tmp/mf-fg-')
    const bin = join(dir, 'bin')
    const workspace = join(dir, 'workspace')
    await mkdir(bin)
    await mkdir(workspace)
    await writeFile(join(workspace, 'kept.txt'), 'original workspace')
    for (const name of ['claude', 'codex', 'gemini', 'openclaw', 'hermes']) {
        await writeFile(
            join(bin, name),
            '#!/bin/sh\nprintf "fixture 1.0\\n"\n',
            { mode: 0o755 }
        )
    }
    const shell = join(bin, 'shell')
    await writeFile(
        shell,
        shellBody ?? '#!/bin/sh\nprintf "%s" "$MF_FIXTURE_PATH"\n',
        {
            mode: 0o755
        }
    )
    const heartbeats: ServerResponse[] = []
    const http = createServer((req, res) => {
        assert.equal(req.headers.authorization, 'Bearer ldt_fixture')
        req.resume()
        if (req.url === '/api/daemon/heartbeat') {
            heartbeats.push(res)
            return
        }
        res.writeHead(404).end()
    })
    const wss = new WebSocketServer({ server: http })
    const sockets: WebSocket[] = []
    const frames: DaemonWsFrame[] = []
    wss.on('connection', (socket, request) => {
        assert.equal(request.url, '/api/daemon/ws')
        assert.equal(request.headers.authorization, 'Bearer ldt_fixture')
        sockets.push(socket)
        socket.on('message', (raw) => {
            const frame = JSON.parse(String(raw)) as DaemonWsFrame
            frames.push(frame)
            if (frame.type === 'hello')
                socket.send(
                    JSON.stringify({
                        type: 'welcome',
                        daemonId: 'ldh_fixture',
                        serverTime: new Date().toISOString(),
                        runtimeIds: []
                    })
                )
            if (frame.type === 'ping')
                socket.send(JSON.stringify({ type: 'pong' }))
        })
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    assert.ok(address && typeof address === 'object')
    const paths = profilePaths(dir, 'qa')
    await mkdir(dirname(paths.daemonConfigPath), { recursive: true })
    await writeFile(
        paths.daemonConfigPath,
        JSON.stringify({
            apiUrl: `http://127.0.0.1:${address.port}/api`,
            token: 'ldt_fixture',
            daemonId: 'ldh_fixture',
            daemonUuid: randomUUID(),
            profile: 'qa',
            channel: 'stable',
            workspaceBaseDir: workspace
        }),
        { mode: 0o600 }
    )
    const processes: Process[] = []
    const launch = () => {
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--import',
                './test/md-text-loader.mjs',
                fileURLToPath(
                    new URL(
                        './fixtures/daemon-foreground-worker.ts',
                        import.meta.url
                    )
                )
            ],
            {
                cwd: fileURLToPath(new URL('..', import.meta.url)),
                env: {
                    PATH: `${bin}:/usr/bin:/bin`,
                    SHELL: shell,
                    MF_FIXTURE_PATH: `${bin}:/usr/bin:/bin`,
                    MF_FIXTURE_PIDS: join(dir, 'probe.pids'),
                    MF_FIXTURE_LOG: join(paths.daemonDir, 'daemon.log'),
                    MF_CONFIG_DIR: dir,
                    MF_PROFILE: 'qa',
                    MF_DAEMON_AUTO_UPDATE: '0',
                    OPENCLAW_HOME: dir,
                    NO_COLOR: '1'
                },
                stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            }
        )
        const value: Process = {
            child,
            ready: false,
            done: false,
            output: '',
            error: '',
            exited: Promise.resolve()
        }
        value.exited = new Promise((resolve) =>
            child.once('exit', () => {
                value.done = true
                resolve()
            })
        )
        child.on('message', () => {
            value.ready = true
        })
        child.stdout!.on('data', (data: Buffer) => {
            value.output += data.toString()
        })
        child.stderr!.on('data', (data: Buffer) => {
            value.error += data.toString()
        })
        processes.push(value)
        return value
    }
    const start = async (count: number) => {
        const group = Array.from({ length: count }, launch)
        await until(() => group.every((p) => p.ready || p.done))
        assert.ok(
            group.every((p) => p.ready),
            group.map((p) => p.error).join('\n')
        )
        for (const p of group) p.child.send('start')
        return group
    }
    const cleanup = async () => {
        for (const p of processes) if (!p.done) p.child.kill('SIGKILL')
        await Promise.all(processes.map((p) => p.exited))
        for (const socket of sockets) socket.terminate()
        for (const response of heartbeats)
            if (!response.writableEnded) response.end('{}')
        await new Promise<void>((resolve) => wss.close(() => resolve()))
        http.closeAllConnections()
        await new Promise<void>((resolve) => http.close(() => resolve()))
        await rm(dir, { recursive: true, force: true })
    }
    return {
        dir,
        paths,
        workspace,
        frames,
        sockets,
        heartbeats,
        processes,
        launch,
        start,
        cleanup
    }
}

test(
    'foreground logs before a blocked probe and reaches the local API after killing its shell tree',
    { skip: process.platform === 'win32' },
    async () => {
        const h = await fixture(`#!/bin/sh
IFS= read -r first < "$MF_FIXTURE_LOG"
case "$first" in *"daemon starting "*) ;; *) exit 12 ;; esac
trap '' TERM
echo $$ > "$MF_FIXTURE_PIDS"
/bin/sh -c 'trap "" TERM; echo $$ >> "$MF_FIXTURE_PIDS"; while :; do /bin/sleep 1; done' &
wait
`)
        try {
            const started = Date.now()
            const [owner] = await h.start(1)
            await until(
                () =>
                    h.frames.some((frame) => frame.type === 'hello') &&
                    h.heartbeats.length > 0
            )
            assert.ok(Date.now() - started < 10_000)
            assert.match(
                owner.output,
                /PATH probe timeout; retaining current PATH/
            )
            assert.ok(
                owner.output.indexOf('daemon starting ') <
                    owner.output.indexOf('PATH probe timeout')
            )
            const pids = (await readFile(join(h.dir, 'probe.pids'), 'utf8'))
                .trim()
                .split('\n')
                .map(Number)
            assert.equal(pids.length, 2)
            await until(() =>
                pids.every((pid) => {
                    try {
                        process.kill(pid, 0)
                        return false
                    } catch {
                        return true
                    }
                })
            )
            h.heartbeats[0]
                .writeHead(200, { 'content-type': 'application/json' })
                .end('{}')
            await until(() => owner.output.includes('daemon running pid='))
            owner.child.kill('SIGTERM')
            await until(() => owner.done)
            assert.equal(owner.child.exitCode, 0, owner.error)
        } finally {
            await h.cleanup()
        }
    }
)

test(
    'foreground contention preserves one connection and an ongoing RPC, then recovers after SIGKILL',
    { skip: process.platform === 'win32' },
    async () => {
        const h = await fixture()
        try {
            const group = await h.start(2)
            await until(
                () =>
                    h.frames.some((f) => f.type === 'hello') &&
                    group.some((p) => p.done) &&
                    h.heartbeats.length > 0
            )
            assert.equal(group.filter((p) => p.done).length, 1)
            assert.equal(group.find((p) => p.done)!.child.exitCode, 1)
            assert.match(group.find((p) => p.done)!.error, /already running/)
            const first = group.find((p) => !p.done)!
            const hello = h.frames.find((f) => f.type === 'hello')!
            const pidPath = join(h.paths.daemonDir, 'daemon.pid')
            const socketPath = join(h.paths.daemonDir, 'daemon.sock')
            assert.ok(hello.clientProcess)
            assert.equal(hello.clientProcess.pid, first.child.pid)
            assert.equal(
                (await readFile(pidPath, 'utf8')).trim(),
                String(first.child.pid)
            )
            const health = await queryDaemonHealth(socketPath)
            assert.equal(health?.pid, first.child.pid)
            assert.equal(
                health?.clientInstanceId,
                hello.clientProcess.instanceId
            )
            const late = h.launch()
            await until(() => late.ready || late.done)
            assert.ok(late.ready, late.error)
            h.sockets[0].send(
                JSON.stringify({
                    type: 'push',
                    refId: 'held-rpc',
                    method: 'exec.start',
                    payload: {
                        cmd: [
                            process.execPath,
                            '-e',
                            'console.log("holding"); setTimeout(() => console.log("finished"), 1200)'
                        ],
                        dir: h.workspace,
                        timeoutMs: 5000
                    }
                })
            )
            await until(() =>
                h.frames.some(
                    (f) =>
                        f.type === 'event' && String(f.data).includes('holding')
                )
            )
            late.child.send('start')
            await until(() => late.done)
            await late.exited
            assert.equal(late.child.exitCode, 1)
            await until(() =>
                h.frames.some((f) => f.type === 'ack' && f.refId === 'held-rpc')
            )
            assert.equal(
                h.frames
                    .filter((f) => f.type === 'ack')
                    .find((f) => f.refId === 'held-rpc')?.ok,
                true
            )
            assert.ok(
                h.frames.some(
                    (f) =>
                        f.type === 'event' &&
                        String(f.data).includes('finished')
                )
            )
            assert.equal(h.sockets.length, 1)
            assert.equal(h.frames.filter((f) => f.type === 'hello').length, 1)
            assert.equal(h.heartbeats.length, 1)
            assert.equal(
                await readFile(join(h.workspace, 'kept.txt'), 'utf8'),
                'original workspace'
            )

            first.child.kill('SIGKILL')
            await first.exited
            const next = await h.start(2)
            await until(
                () =>
                    h.frames.filter((f) => f.type === 'hello').length === 2 &&
                    next.some((p) => p.done) &&
                    h.heartbeats.length === 2
            )
            const owner = next.find((p) => !p.done)!
            assert.equal(next.filter((p) => !p.done).length, 1)
            assert.equal(
                (await readFile(pidPath, 'utf8')).trim(),
                String(owner.child.pid)
            )
            assert.equal(
                (await queryDaemonHealth(socketPath))?.pid,
                owner.child.pid
            )
            h.heartbeats[1]
                .writeHead(200, { 'content-type': 'application/json' })
                .end('{}')
            await until(() => owner.output.includes('daemon running pid='))
            owner.child.kill('SIGTERM')
            await until(() => owner.done)
            await owner.exited
            assert.equal(owner.child.exitCode, 0, owner.error)
            await assert.rejects(readFile(pidPath), { code: 'ENOENT' })
        assert.deepEqual(await readdir(`${pidPath}.locks`), ['lock'])
        assert.deepEqual(await readdir(`${socketPath}.locks`), ['lock'])
        } finally {
            await h.cleanup()
        }
    }
)

test(
    'foreground hard-stops on a live control socket before any WS or heartbeat',
    { skip: process.platform === 'win32' },
    async () => {
        const h = await fixture()
        const socketPath = join(h.paths.daemonDir, 'daemon.sock')
        const listener = createSocketServer((socket) =>
            socket.on('data', () => {})
        )
        try {
            await new Promise<void>((resolve) =>
                listener.listen(socketPath, resolve)
            )
            const [p] = await h.start(1)
            await until(() => p.done)
            await p.exited
            assert.equal(p.child.exitCode, 1)
            assert.match(p.error, /already serving/)
            assert.equal(h.sockets.length, 0)
            assert.equal(h.heartbeats.length, 0)
            await assert.rejects(
                readFile(join(h.paths.daemonDir, 'daemon.pid')),
                { code: 'ENOENT' }
            )
            assert.ok(listener.listening)
        } finally {
            await new Promise<void>((resolve) =>
                listener.close(() => resolve())
            )
            await h.cleanup()
        }
    }
)
