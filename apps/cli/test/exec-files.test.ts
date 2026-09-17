import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exec without pipes (ADR-0029 §4, B1). Every test here runs a real
// /bin/sh child through the wrapper under a throwaway profile, so what is
// asserted is what a daemon would see: files, offsets, exit lines, and a
// process that outlives the daemon that spawned it. POSIX only, like the
// feature.

const home = mkdtempSync(join(tmpdir(), 'mf-exec-files-'))
process.env.HOME = home
process.env.MF_CONFIG_DIR = join(home, 'config')
process.env.MF_PROFILE = 'execfiles'

const {
    EXEC_EVENT_MAX_BYTES,
    EXEC_WRAPPER_SCRIPT,
    adoptFileExec,
    fileExecEnabled,
    fileExecRegistry,
    recoverFileExecs,
    resolveExecutable,
    startFileExec
} = await import('../src/daemon/exec-files')
const { ExecStream, execStreams, readEventsFrom, readFinal, readMeta } =
    await import('../src/daemon/exec-buffer')
const { daemonPaths } = await import('../src/daemon/config')
const { rpcHandler, setDeclaredWorkspaceRoot, daemonActivitySnapshot } =
    await import('../src/daemon/rpc')

const posix = process.platform !== 'win32'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let counter = 0
const nextRef = (label: string): string => `ref-${label}-${++counter}`

const startExec = (
    label: string,
    cmd: string[],
    opts: { timeoutMs?: number; stdin?: string; cwd?: string } = {}
) => {
    const refId = nextRef(label)
    const stream = new ExecStream({
        refId,
        method: 'exec.start',
        payload: { cmd }
    })
    execStreams.set(refId, stream)
    const events: Array<{ kind: string; data: string; seq: number }> = []
    stream.subscribe((kind, data, seq) => events.push({ kind, data, seq }), 0)
    const handle = startFileExec({
        refId,
        cmd,
        cwd: opts.cwd ?? home,
        env: process.env,
        stdin: opts.stdin ?? '',
        timeoutMs: opts.timeoutMs,
        stream,
        log: () => {}
    })
    return {
        refId,
        stream,
        events,
        handle,
        dir: join(daemonPaths.execDir, refId)
    }
}

test('the wrapper is fixed text that takes the exec dir and argv as positional parameters', () => {
    assert.match(EXEC_WRAPPER_SCRIPT, /^d=\$1\nshift\n/)
    assert.match(
        EXEC_WRAPPER_SCRIPT,
        /"\$@" <"\$d\/stdin" >>"\$d\/stdout\.log" 2>>"\$d\/stderr\.log" &/
    )
    // The child is forked before TERM is ignored, so the group kill reaches
    // it while the wrapper lives on to write the exit line.
    assert.ok(
        EXEC_WRAPPER_SCRIPT.indexOf('&\np=$!') <
            EXEC_WRAPPER_SCRIPT.indexOf("trap '' TERM")
    )
    assert.match(EXEC_WRAPPER_SCRIPT, /printf '%s\\n' "\$c" >"\$d\/exit"$/)
    assert.doesNotMatch(
        EXEC_WRAPPER_SCRIPT,
        /\$\{?[A-Z_]+\}?\//,
        'no interpolated paths'
    )
})

test('the gray-release switch is off by default, POSIX only', () => {
    assert.equal(fileExecEnabled({}, 'darwin'), false)
    assert.equal(fileExecEnabled({ MF_DAEMON_EXEC_FILES: '1' }, 'linux'), true)
    assert.equal(
        fileExecEnabled({ MF_DAEMON_EXEC_FILES: 'on' }, 'darwin'),
        true
    )
    assert.equal(
        fileExecEnabled({ MF_DAEMON_EXEC_FILES: 'maybe' }, 'darwin'),
        false
    )
    assert.equal(fileExecEnabled({ MF_DAEMON_EXEC_FILES: '1' }, 'win32'), false)
})

test(
    "argv[0] is resolved by the daemon so a missing binary is ENOENT, not the shell's 127",
    { skip: !posix },
    () => {
        const bin = join(home, 'bin')
        mkdirSync(bin, { recursive: true })
        writeFileSync(join(bin, 'tool'), '#!/bin/sh\necho tool\n', {
            mode: 0o755
        })
        writeFileSync(join(bin, 'plain'), 'not executable\n', { mode: 0o644 })
        const env = { PATH: `${bin}:/usr/bin:/bin` }
        assert.equal(resolveExecutable('tool', env, home), join(bin, 'tool'))
        assert.equal(resolveExecutable('plain', env, home), null)
        assert.equal(
            resolveExecutable('definitely-missing-binary', env, home),
            null
        )
        assert.equal(
            resolveExecutable('bin/tool', env, home),
            join(home, 'bin/tool')
        )
        assert.equal(resolveExecutable('/bin/sh', env, home), '/bin/sh')
    }
)

test(
    'a plain exec writes files, tails them into offset-stamped events and completes on the exit line',
    { skip: !posix },
    async () => {
        const run = startExec(
            'plain',
            [
                '/bin/sh',
                '-c',
                'printf out-a; printf err-1 >&2; printf out-b; read line; printf "%s" "$line"; exit 3'
            ],
            { stdin: 'from-stdin' }
        )
        assert.ok(fileExecRegistry.get(run.refId), 'registered while running')
        const final = await run.handle.done
        assert.deepEqual(final, { ok: true, payload: { exitCode: 3 } })
        assert.equal(run.stream.status, 'completed')
        assert.equal(fileExecRegistry.get(run.refId), undefined)
        const stdout = run.events
            .filter((e) => e.kind === 'stdout')
            .map((e) => e.data)
            .join('')
        const stderr = run.events
            .filter((e) => e.kind === 'stderr')
            .map((e) => e.data)
            .join('')
        assert.equal(stdout, 'out-aout-bfrom-stdin')
        assert.equal(stderr, 'err-1')
        // Offsets on disk are contiguous per stream and reproduce the numbering.
        const onDisk = readEventsFrom(run.refId, 0)
        let expectOut = 0
        for (const event of onDisk.filter((e) => e.kind === 'stdout')) {
            assert.equal(event.off, expectOut)
            assert.equal(event.len, Buffer.byteLength(event.data))
            expectOut += event.len!
        }
        assert.deepEqual(readFinal(run.refId), final)
        const meta = readMeta(run.refId) as unknown as Record<string, unknown>
        assert.equal(meta.format, 2)
        assert.equal(typeof (meta.owner as { pid: number }).pid, 'number')
        assert.equal(meta.cwd, home)
        assert.equal(meta.status, 'completed')
        // Raw files are gone with the completion; the event log stays.
        for (const name of ['stdin', 'stdout.log', 'stderr.log'])
            assert.equal(
                existsSync(join(run.dir, name)),
                false,
                `${name} removed`
            )
        assert.ok(existsSync(join(run.dir, 'events.ndjson')))
        assert.equal(readFileSync(join(run.dir, 'exit'), 'utf8'), '3\n')
    }
)

test(
    'a missing binary reports ENOENT the way the pipe path did',
    { skip: !posix },
    async () => {
        const run = startExec('enoent', ['definitely-missing-binary-xyz'])
        const final = await run.handle.done
        assert.equal(final.ok, false)
        assert.deepEqual(final.payload, { exitCode: -1 })
        assert.match(final.error ?? '', /ENOENT/)
        assert.ok(
            run.events.some(
                (e) => e.kind === 'stderr' && /spawn error/.test(e.data)
            )
        )
    }
)

test(
    'a child killed by a signal reports 128+n instead of 0',
    { skip: !posix },
    async () => {
        const run = startExec('signal', ['/bin/sh', '-c', 'kill -TERM $$'])
        const final = await run.handle.done
        assert.deepEqual(final, { ok: true, payload: { exitCode: 143 } })
    }
)

test(
    'an abort is persisted before the group is killed and the stream ends aborted',
    { skip: !posix },
    async () => {
        const run = startExec('abort', [
            '/bin/sh',
            '-c',
            'echo started; sleep 30'
        ])
        await sleep(300)
        const before = Date.now()
        run.handle.abort()
        const final = await run.handle.done
        assert.ok(
            Date.now() - before < 4_000,
            'TERM ended it before the KILL escalation'
        )
        assert.equal(final.ok, false)
        assert.equal(final.error, 'cancelled')
        assert.equal(run.stream.status, 'aborted')
        assert.ok(
            (readMeta(run.refId) as { abortRequestedAt?: string })
                .abortRequestedAt
        )
        assert.ok(run.events.some((e) => e.data.includes('started')))
    }
)

test(
    'a deadline is persisted and reports exit code 124',
    { skip: !posix },
    async () => {
        const run = startExec('deadline', ['/bin/sh', '-c', 'sleep 30'], {
            timeoutMs: 300
        })
        assert.ok((readMeta(run.refId) as { deadlineAt?: string }).deadlineAt)
        const final = await run.handle.done
        assert.deepEqual(final, { ok: true, payload: { exitCode: 124 } })
        assert.ok((readMeta(run.refId) as { timedOutAt?: string }).timedOutAt)
        assert.equal(run.stream.status, 'completed')
    }
)

test(
    'only whole UTF-8 sequences are emitted and one event never exceeds the cap',
    { skip: !posix },
    async () => {
        const run = startExec('utf8', [
            '/bin/sh',
            '-c',
            // A three-byte character split across two writes with a pause the
            // tailer is sure to poll inside, then a large burst.
            'printf "\\344\\270"; sleep 0.3; printf "\\255\\n"; head -c 200000 /dev/zero | tr "\\0" x'
        ])
        const final = await run.handle.done
        assert.deepEqual(final, { ok: true, payload: { exitCode: 0 } })
        const stdout = run.events.filter((e) => e.kind === 'stdout')
        const joined = stdout.map((e) => e.data).join('')
        assert.ok(
            joined.startsWith('中\n'),
            'the split character arrives whole'
        )
        assert.equal(joined.length, 2 + 200000)
        // Whether a poll landed inside the split or not, no event starts or
        // ends mid-character: each re-encodes to exactly the bytes it covers.
        for (const event of readEventsFrom(run.refId, 0).filter(
            (e) => e.kind === 'stdout'
        )) {
            assert.ok(event.len! <= EXEC_EVENT_MAX_BYTES)
            assert.equal(Buffer.byteLength(event.data), event.len)
            assert.doesNotMatch(event.data, /�/)
        }
    }
)

test(
    'an exec whose exit line landed while no daemon watched completes on recovery',
    { skip: !posix },
    async () => {
        const refId = nextRef('recover-exit')
        const dir = join(daemonPaths.execDir, refId)
        mkdirSync(dir, { recursive: true })
        writeFileSync(
            join(dir, 'meta.json'),
            JSON.stringify({
                refId,
                method: 'exec.start',
                payload: {},
                startedAt: new Date().toISOString(),
                status: 'running',
                format: 2,
                cwd: home,
                owner: { pid: 2 ** 22 - 1, startTime: 'gone', bootId: 'gone' }
            })
        )
        writeFileSync(join(dir, 'events.ndjson'), '')
        writeFileSync(join(dir, 'stdin'), '')
        writeFileSync(join(dir, 'stdout.log'), 'left behind\n')
        writeFileSync(join(dir, 'stderr.log'), '')
        writeFileSync(join(dir, 'exit'), '5\n')
        const outcome = recoverFileExecs(() => {})
        assert.equal(outcome.completed, 1)
        const stream = execStreams.get(refId)!
        await fileExecRegistry.get(refId)?.done
        assert.equal(stream.status, 'completed')
        assert.deepEqual(readFinal(refId), {
            ok: true,
            payload: { exitCode: 5 }
        })
        assert.deepEqual(
            readEventsFrom(refId, 0).map((e) => [e.kind, e.data, e.off]),
            [['stdout', 'left behind\n', 0]]
        )
        assert.equal(existsSync(join(dir, 'stdout.log')), false)
    }
)

test(
    "a live pid that is not the exec's own process is never adopted nor signalled",
    { skip: !posix },
    async () => {
        const refId = nextRef('recycled')
        const dir = join(daemonPaths.execDir, refId)
        mkdirSync(dir, { recursive: true })
        writeFileSync(
            join(dir, 'meta.json'),
            JSON.stringify({
                refId,
                method: 'exec.start',
                payload: {},
                startedAt: new Date().toISOString(),
                status: 'running',
                format: 2,
                cwd: home,
                // Our own pid is certainly alive; the start time is not ours.
                owner: {
                    pid: process.pid,
                    startTime: 'Thu Jan  1 00:00:00 1970',
                    bootId: 'another-boot'
                }
            })
        )
        writeFileSync(join(dir, 'events.ndjson'), '')
        writeFileSync(join(dir, 'stdin'), '')
        writeFileSync(join(dir, 'stdout.log'), '')
        writeFileSync(join(dir, 'stderr.log'), '')
        const outcome = recoverFileExecs(() => {})
        assert.equal(outcome.crashed, 1)
        assert.equal(readMeta(refId)?.status, 'crashed')
        assert.equal(readFinal(refId)?.error, 'daemon process crashed')
        assert.equal(fileExecRegistry.get(refId), undefined)
    }
)

test('a pipe exec left running by a dead daemon is still marked crashed', async () => {
    const refId = nextRef('pipe-crash')
    const dir = join(daemonPaths.execDir, refId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
        join(dir, 'meta.json'),
        JSON.stringify({
            refId,
            method: 'exec.start',
            payload: {},
            startedAt: new Date().toISOString(),
            status: 'running'
        })
    )
    writeFileSync(join(dir, 'events.ndjson'), '')
    recoverFileExecs(() => {})
    assert.equal(readMeta(refId)?.status, 'crashed')
})

test(
    'a daemon that dies mid-exec is replaced by one that adopts the running child and finishes its stream',
    { skip: !posix },
    async () => {
        const refId = nextRef('adopt')
        const cmd = [
            '/bin/sh',
            '-c',
            'echo first; sleep 1.2; echo second; exit 7'
        ]
        const fixture = fileURLToPath(
            new URL('./fixtures/exec-files-spawner.ts', import.meta.url)
        )
        // From the package dir so `tsx` resolves; the exec itself runs in home.
        // Bun runs the TypeScript fixture as is.
        const runner =
            typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
                ? [fixture]
                : ['--import', 'tsx', fixture]
        const spawner = spawn(
            process.execPath,
            [...runner, refId, JSON.stringify(cmd), '400'],
            {
                cwd: fileURLToPath(new URL('..', import.meta.url)),
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        )
        let out = ''
        let err = ''
        spawner.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
        spawner.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
        await new Promise<void>((resolve) =>
            spawner.once('exit', () => resolve())
        )
        assert.match(out, /"refId"/, `spawner failed: ${err}`)
        const left = JSON.parse(out.trim()) as { seq: number }
        assert.ok(
            left.seq >= 1,
            'the first daemon published the first line before dying'
        )
        const dir = join(daemonPaths.execDir, refId)
        const meta = readMeta(refId) as unknown as {
            status: string
            owner: { pid: number }
        }
        assert.equal(meta.status, 'running')
        assert.equal(
            existsSync(join(dir, 'exit')),
            false,
            'the child is still running'
        )
        // Adopt from the second daemon's point of view.
        const outcome = adoptFileExec(refId, meta as never, () => {})
        assert.equal(outcome, 'adopted')
        const stream = execStreams.get(refId)!
        assert.equal(
            stream.seq,
            left.seq,
            'seq numbering continues where the last daemon stopped'
        )
        const events: Array<[string, string, number]> = []
        stream.subscribe(
            (kind, data, seq) => events.push([kind, data, seq]),
            left.seq
        )
        const final = await fileExecRegistry.get(refId)!.done
        assert.deepEqual(final, { ok: true, payload: { exitCode: 7 } })
        assert.deepEqual(
            events
                .filter((e) => e[0] === 'stdout')
                .map((e) => e[1])
                .join(''),
            'second\n'
        )
        const onDisk = readEventsFrom(refId, 0).filter(
            (e) => e.kind === 'stdout'
        )
        assert.deepEqual(onDisk.map((e) => e.data).join(''), 'first\nsecond\n')
        assert.equal(onDisk[1].off, onDisk[0].off! + onDisk[0].len!)
    }
)

test(
    'rpc: the flag routes a plain exec to files, keeps auth/resources/stdin execs on pipes, and exec.start is idempotent by refId',
    { skip: !posix },
    async () => {
        setDeclaredWorkspaceRoot(join(home, 'workspaces'))
        const prior = process.env.MF_DAEMON_EXEC_FILES
        process.env.MF_DAEMON_EXEC_FILES = '1'
        try {
            const events: Array<[string, number | undefined]> = []
            const ctx = (refId: string) => ({
                refId,
                sendEvent: (kind: string, data: string, seq?: number) => {
                    events.push([`${kind}:${data}`, seq])
                },
                onCancel: () => {}
            })
            const refId = nextRef('rpc-files')
            const first = await rpcHandler(
                'exec.start',
                { cmd: ['/bin/echo', 'hello'] },
                ctx(refId) as never
            )
            assert.deepEqual(first, {
                ok: true,
                payload: { exitCode: 0 },
                error: undefined
            })
            assert.equal(readMeta(refId)?.format, 2)
            assert.ok(events.some((e) => e[0] === 'stdout:hello\n'))
            assert.equal(daemonActivitySnapshot().activeExecs, 0)
            // Same refId again: a replay, not a second echo.
            events.length = 0
            const again = await rpcHandler(
                'exec.start',
                { cmd: ['/bin/echo', 'twice'] },
                ctx(refId) as never
            )
            assert.deepEqual(again, {
                ok: true,
                payload: { exitCode: 0 },
                error: undefined
            })
            assert.ok(events.some((e) => e[0] === 'stdout:hello\n'))
            assert.ok(!events.some((e) => e[0] === 'stdout:twice\n'))
            // exec.input is refused for a file exec; exec.abort ends it.
            const longRef = nextRef('rpc-abort')
            const pending = rpcHandler(
                'exec.start',
                { cmd: ['/bin/sh', '-c', 'sleep 30'] },
                ctx(longRef) as never
            )
            await sleep(200)
            assert.deepEqual(
                await rpcHandler(
                    'exec.input',
                    { refId: longRef, data: 'x' },
                    ctx('in') as never
                ),
                { ok: false, error: 'stdin closed' }
            )
            assert.deepEqual(
                await rpcHandler(
                    'exec.abort',
                    { refId: longRef },
                    ctx('ab') as never
                ),
                { ok: true }
            )
            const aborted = await pending
            assert.equal(aborted.ok, false)
            assert.equal(aborted.error, 'cancelled')
            // keepStdinOpen stays on the pipe path (no format 2).
            const pipeRef = nextRef('rpc-pipe')
            const piped = rpcHandler(
                'exec.start',
                { cmd: ['/bin/cat'], keepStdinOpen: true },
                ctx(pipeRef) as never
            )
            await sleep(200)
            assert.equal(readMeta(pipeRef)?.format, undefined)
            await rpcHandler(
                'exec.eof',
                { refId: pipeRef },
                ctx('eof') as never
            )
            assert.equal((await piped).ok, true)
        } finally {
            if (prior === undefined) delete process.env.MF_DAEMON_EXEC_FILES
            else process.env.MF_DAEMON_EXEC_FILES = prior
            setDeclaredWorkspaceRoot(null)
        }
    }
)

// ---- ADR-0029 §4, B2: a profile lease and temporary settings ride along ----

const { execResourcesAt } = await import('../src/daemon/exec-resources')
const { restampProfileLock } = await import('../src/daemon/runtime-auth/lock')

const makeLock = (
    label: string,
    pid: number
): { lockDir: string; ownerPath: string } => {
    const lockDir = join(home, `lock-${label}-${++counter}`)
    mkdirSync(lockDir, { recursive: true, mode: 0o700 })
    const ownerPath = join(lockDir, 'owner.json')
    writeFileSync(
        ownerPath,
        JSON.stringify({ pid, label, acquiredAt: new Date().toISOString() })
    )
    return { lockDir, ownerPath }
}

test(
    'a fresh exec under a lease records the lock path, never the env, and releases the lock after draining',
    { skip: !posix },
    async () => {
        const lock = makeLock('fresh', process.pid)
        let released = 0
        const refId = nextRef('lease')
        const stream = new ExecStream({
            refId,
            method: 'exec.start',
            payload: {}
        })
        execStreams.set(refId, stream)
        const events: string[] = []
        const logs: string[] = []
        stream.subscribe((kind, data) => events.push(`${kind}:${data}`), 0)
        const handle = startFileExec({
            refId,
            cmd: ['/bin/sh', '-c', 'echo under-lease'],
            cwd: home,
            env: { ...process.env, SECRET_VENDOR_KEY: 'sk-do-not-persist' },
            stdin: '',
            stream,
            log: (message) => logs.push(message),
            auth: {
                lockDir: lock.lockDir,
                label: `exec:${refId}`,
                release: async () => {
                    released += 1
                    assert.ok(
                        events.join('').includes('under-lease'),
                        `the output is drained before the lease goes: ${JSON.stringify(events)}`
                    )
                    rmSync(lock.lockDir, { recursive: true, force: true })
                }
            }
        })
        const final = await handle.done
        assert.deepEqual(
            final,
            { ok: true, payload: { exitCode: 0 } },
            logs.join('\n')
        )
        assert.equal(released, 1)
        assert.equal(existsSync(lock.lockDir), false)
        const metaRaw = readFileSync(
            join(daemonPaths.execDir, refId, 'meta.json'),
            'utf8'
        )
        assert.ok(!metaRaw.includes('sk-do-not-persist'))
        assert.deepEqual(
            (readMeta(refId) as unknown as { auth: unknown }).auth,
            { lockDir: lock.lockDir, label: `exec:${refId}` }
        )
    }
)

test(
    'a lease release that fails turns the outcome into a crash, like the pipe path',
    { skip: !posix },
    async () => {
        const refId = nextRef('lease-fail')
        const stream = new ExecStream({
            refId,
            method: 'exec.start',
            payload: {}
        })
        execStreams.set(refId, stream)
        const handle = startFileExec({
            refId,
            cmd: ['/bin/sh', '-c', 'exit 0'],
            cwd: home,
            env: process.env,
            stdin: '',
            stream,
            log: () => {},
            auth: {
                lockDir: join(home, 'nowhere'),
                label: 'x',
                release: async () => {
                    throw new Error('disk gone')
                }
            }
        })
        const final = await handle.done
        assert.equal(final.error, 'auth_context_release_failed')
        assert.equal(stream.status, 'crashed')
    }
)

test(
    'temporary settings: the directory is drained and removed at completion, fresh or adopted',
    { skip: !posix },
    async () => {
        const fresh = join(home, `res-${++counter}`)
        mkdirSync(fresh, { recursive: true, mode: 0o700 })
        const refId = nextRef('resources')
        const stream = new ExecStream({
            refId,
            method: 'exec.start',
            payload: {}
        })
        execStreams.set(refId, stream)
        const handle = startFileExec({
            refId,
            cmd: [
                '/bin/sh',
                '-c',
                'echo x > "$MF_EXEC_TEMP_DIR/settings.json"; sleep 30 & exit 0'
            ],
            cwd: home,
            env: { ...process.env, MF_EXEC_TEMP_DIR: fresh },
            stdin: '',
            stream,
            log: () => {},
            resources: execResourcesAt(fresh)
        })
        const final = await handle.done
        assert.deepEqual(final, { ok: true, payload: { exitCode: 0 } })
        assert.equal(
            existsSync(fresh),
            false,
            'the directory is gone with its group'
        )
        assert.deepEqual(
            (readMeta(refId) as unknown as { resources: unknown }).resources,
            { directory: fresh }
        )

        // Adopted after the exit line landed: the directory still goes.
        const adoptedDir = join(home, `res-${++counter}`)
        mkdirSync(adoptedDir, { recursive: true, mode: 0o700 })
        const late = nextRef('resources-late')
        const dir = join(daemonPaths.execDir, late)
        mkdirSync(dir, { recursive: true })
        writeFileSync(
            join(dir, 'meta.json'),
            JSON.stringify({
                refId: late,
                method: 'exec.start',
                payload: {},
                startedAt: new Date().toISOString(),
                status: 'running',
                format: 2,
                cwd: home,
                owner: { pid: 2 ** 22 - 2, startTime: 'gone', bootId: 'gone' },
                resources: { directory: adoptedDir }
            })
        )
        for (const [name, body] of [
            ['events.ndjson', ''],
            ['stdin', ''],
            ['stdout.log', 'late\n'],
            ['stderr.log', ''],
            ['exit', '0\n']
        ])
            writeFileSync(join(dir, name), body)
        const outcome = recoverFileExecs(() => {})
        assert.equal(outcome.completed, 1)
        await fileExecRegistry.get(late)?.done
        assert.equal(existsSync(adoptedDir), false)
    }
)

test(
    'adoption re-stamps a lease whose holder died and releases it at the end',
    { skip: !posix },
    async () => {
        const refId = nextRef('adopt-lease')
        const lockDir = join(home, `lock-adopt-${++counter}`)
        const cmd = ['/bin/sh', '-c', 'echo one; sleep 1.2; echo two']
        const fixture = fileURLToPath(
            new URL('./fixtures/exec-files-spawner.ts', import.meta.url)
        )
        const runner =
            typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
                ? [fixture]
                : ['--import', 'tsx', fixture]
        const spawner = spawn(
            process.execPath,
            [
                ...runner,
                refId,
                JSON.stringify(cmd),
                '400',
                JSON.stringify({ lockDir })
            ],
            {
                cwd: fileURLToPath(new URL('..', import.meta.url)),
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        )
        let out = ''
        spawner.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
        await new Promise<void>((resolve) =>
            spawner.once('exit', () => resolve())
        )
        assert.match(out, /"refId"/)
        const before = JSON.parse(
            readFileSync(join(lockDir, 'owner.json'), 'utf8')
        ) as { pid: number }
        assert.equal(
            before.pid,
            spawner.pid,
            'the dead daemon still names itself'
        )
        const outcome = recoverFileExecs(() => {})
        assert.equal(outcome.adopted, 1)
        const after = JSON.parse(
            readFileSync(join(lockDir, 'owner.json'), 'utf8')
        ) as { pid: number; label: string }
        assert.equal(
            after.pid,
            process.pid,
            're-stamped with the adopting daemon before anything else runs'
        )
        assert.equal(after.label, `exec:${refId}`)
        // Nobody else can take the profile while the adopted exec runs.
        assert.equal(
            restampProfileLock(lockDir, 'intruder') ? 'stamped' : 'refused',
            'stamped',
            'the same pid may re-stamp'
        )
        const final = await fileExecRegistry.get(refId)!.done
        assert.deepEqual(final, { ok: true, payload: { exitCode: 0 } })
        assert.equal(
            existsSync(lockDir),
            false,
            'the lease is released with the exec'
        )
    }
)

test(
    'adoption refuses a lease that another live process holds and stops the exec instead',
    { skip: !posix },
    async () => {
        const refId = nextRef('adopt-lost-lease')
        const lockDir = join(home, `lock-lost-${++counter}`)
        const cmd = ['/bin/sh', '-c', 'sleep 30']
        const fixture = fileURLToPath(
            new URL('./fixtures/exec-files-spawner.ts', import.meta.url)
        )
        const runner =
            typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
                ? [fixture]
                : ['--import', 'tsx', fixture]
        const spawner = spawn(
            process.execPath,
            [
                ...runner,
                refId,
                JSON.stringify(cmd),
                '300',
                JSON.stringify({ lockDir })
            ],
            {
                cwd: fileURLToPath(new URL('..', import.meta.url)),
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        )
        await new Promise<void>((resolve) =>
            spawner.once('exit', () => resolve())
        )
        // Meanwhile someone alive took the profile.
        const intruder = spawn('/bin/sh', ['-c', 'sleep 30'], {
            stdio: 'ignore'
        })
        writeFileSync(
            join(lockDir, 'owner.json'),
            JSON.stringify({
                pid: intruder.pid,
                label: 'login',
                acquiredAt: new Date().toISOString()
            })
        )
        const execPid = (
            readMeta(refId) as unknown as { owner: { pid: number } }
        ).owner.pid
        try {
            const outcome = recoverFileExecs(() => {})
            assert.equal(outcome.crashed, 1)
            assert.equal(readFinal(refId)?.error, 'auth_lease_lost')
            await sleep(300)
            assert.throws(
                () => process.kill(execPid, 0),
                /ESRCH/,
                'our exec was stopped rather than left to collide'
            )
            assert.doesNotThrow(
                () => process.kill(intruder.pid!, 0),
                'the holder was never signalled'
            )
            assert.equal(
                (
                    JSON.parse(
                        readFileSync(join(lockDir, 'owner.json'), 'utf8')
                    ) as { pid: number }
                ).pid,
                intruder.pid,
                'the lease was left with its holder'
            )
        } finally {
            intruder.kill('SIGKILL')
        }
    }
)
