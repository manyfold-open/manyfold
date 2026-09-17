import { execFileSync, spawn } from 'node:child_process'
import {
    closeSync,
    existsSync,
    fstatSync,
    openSync,
    readFileSync,
    readSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { DaemonStreamKind } from '@manyfold/shared'
import {
    bufferDir,
    ExecStream,
    execStreams,
    lastSeq,
    markCrashed,
    readEventsFrom,
    readFinal,
    readMeta,
    recoverCrashedBuffers,
    updateMeta,
    type ExecBufferFinal,
    type ExecBufferMeta
} from './exec-buffer'

// Exec without pipes (ADR-0029 §4, the B1 slice). The child is started
// detached through a fixed /bin/sh wrapper; its stdin comes from a file
// written beforehand and its stdout / stderr append to log files in the
// exec directory, so nothing about the process depends on the daemon that
// spawned it: a daemon that restarts finds the files, checks the process is
// the very one it started, and picks the tail back up. The wrapper commits
// the exit code as one newline-terminated line in `exit`; the daemon only
// ever observes files.
//
// Gray release: off unless MF_DAEMON_EXEC_FILES says so, POSIX only, and
// (this slice) only for an exec that carries no auth lease, no temporary
// settings and no interactive stdin — those keep the pipe path until the
// next slices move them.

export const EXEC_FILES_FORMAT = 2
export const EXEC_FILES_ENV = 'MF_DAEMON_EXEC_FILES'

const STDIN_FILE = 'stdin'
const STDOUT_FILE = 'stdout.log'
const STDERR_FILE = 'stderr.log'
const EXIT_FILE = 'exit'

// One event never carries more than this many source bytes: a resume that
// replays from the events file and a websocket frame both stay bounded.
export const EXEC_EVENT_MAX_BYTES = 64 * 1024
const POLL_ACTIVE_MS = 30
const POLL_IDLE_MS = 250
const ACTIVE_WINDOW_MS = 2_000
const KILL_ESCALATE_MS = 5_000
const EXIT_CODE_TIMEOUT = 124
const EXIT_CODE_KILLED = 137

// Fixed text, never composed from a request: the exec directory and the
// argv arrive as positional parameters. The child is forked BEFORE the
// wrapper starts ignoring TERM, so it keeps the default disposition and a
// kill of the process group ends it while the wrapper survives to record
// its exit status (128+n for a signal). SIGKILL takes the wrapper too; the
// daemon then sees a gone group with no exit line and fills in 137 itself.
// A background job in a non-interactive shell gets /dev/null as stdin, so
// the stdin file is redirected explicitly on the child.
export const EXEC_WRAPPER_SCRIPT = [
    'd=$1',
    'shift',
    `"$@" <"$d/${STDIN_FILE}" >>"$d/${STDOUT_FILE}" 2>>"$d/${STDERR_FILE}" &`,
    'p=$!',
    "trap '' TERM INT HUP",
    'wait "$p"',
    'c=$?',
    `printf '%s\\n' "$c" >"$d/${EXIT_FILE}"`
].join('\n')

export const fileExecEnabled = (
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): boolean => {
    if (platform === 'win32') return false
    const raw = env[EXEC_FILES_ENV]?.trim().toLowerCase()
    return raw !== undefined && ['1', 'true', 'on', 'yes'].includes(raw)
}

export interface ExecOwnerIdentity {
    pid: number
    startTime: string | null
    bootId: string | null
}

export interface FileExecMeta extends ExecBufferMeta {
    format: typeof EXEC_FILES_FORMAT
    owner: ExecOwnerIdentity
    cwd: string
    deadlineAt?: string
    abortRequestedAt?: string
    timedOutAt?: string
    killedAt?: string
}

export const isFileExecMeta = (meta: ExecBufferMeta): meta is FileExecMeta =>
    meta.format === EXEC_FILES_FORMAT &&
    typeof (meta as FileExecMeta).owner?.pid === 'number'

// ---------------------------------------------------------------------------
// Process identity: a pid alone is recycled; with the process start time and
// the boot id it names exactly one process on exactly one boot, which is what
// makes "never signal a recycled pid" a rule rather than a hope.

let cachedBootId: string | null | undefined

export const currentBootId = (): string | null => {
    if (cachedBootId !== undefined) return cachedBootId
    cachedBootId = readBootId()
    return cachedBootId
}

const readBootId = (): string | null => {
    try {
        if (process.platform === 'linux')
            return readFileSync(
                '/proc/sys/kernel/random/boot_id',
                'utf8'
            ).trim()
        if (process.platform === 'darwin')
            return execFileSync('sysctl', ['-n', 'kern.boottime'], {
                encoding: 'utf8',
                timeout: 2_000
            }).trim()
    } catch {}
    return null
}

export const processStartTime = (pid: number): string | null => {
    try {
        if (process.platform === 'linux') {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
            // Field 22, counted after the parenthesised comm which may hold
            // spaces itself.
            const rest = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
            return rest[19] ?? null
        }
        const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 2_000
        }).trim()
        return out || null
    } catch {
        return null
    }
}

const processGroupAlive = (pgid: number): boolean => {
    try {
        process.kill(-pgid, 0)
        return true
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        // Darwin answers EPERM for a group still being reaped; only ESRCH
        // proves it gone.
        return code === 'EPERM'
    }
}

export const ownerIdentityMatches = (owner: ExecOwnerIdentity): boolean => {
    if (!owner.startTime || !owner.bootId) return false
    if (owner.bootId !== currentBootId()) return false
    if (!processGroupAlive(owner.pid)) return false
    return processStartTime(owner.pid) === owner.startTime
}

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
    try {
        process.kill(-pgid, signal)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
    }
}

// ---------------------------------------------------------------------------
// argv[0]: behind a wrapper, a missing binary would surface as sh's 127 in
// the exit file instead of a spawn error, so the daemon resolves the path
// itself and reports ENOENT the way the pipe path did.

export const resolveExecutable = (
    command: string,
    env: NodeJS.ProcessEnv,
    cwd: string
): string | null => {
    const executable = (candidate: string): boolean => {
        try {
            accessSync(candidate, fsConstants.X_OK)
            return statSync(candidate).isFile()
        } catch {
            return false
        }
    }
    if (command.includes('/')) {
        const abs = isAbsolute(command) ? command : resolve(cwd, command)
        return executable(abs) ? abs : null
    }
    for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (!dir) continue
        const candidate = join(dir, command)
        if (executable(candidate)) return candidate
    }
    return null
}

// ---------------------------------------------------------------------------
// Tailing: read what the logs gained since the last offset, emit only whole
// UTF-8 sequences (the rest is carried into the next read), never more than
// EXEC_EVENT_MAX_BYTES per event, each event stamped with where it came from.

const utf8CompleteLength = (buf: Buffer): number => {
    // Walk back at most three bytes for a lead byte whose sequence is cut.
    for (let back = 1; back <= 3 && back <= buf.length; back++) {
        const byte = buf[buf.length - back]
        if ((byte & 0xc0) === 0x80) continue
        const need =
            (byte & 0xe0) === 0xc0
                ? 2
                : (byte & 0xf0) === 0xe0
                  ? 3
                  : (byte & 0xf8) === 0xf0
                    ? 4
                    : 1
        return need > back ? buf.length - back : buf.length
    }
    return buf.length
}

class LogTail {
    private offset: number
    private carry: Buffer = Buffer.alloc(0)

    constructor(
        readonly path: string,
        readonly kind: DaemonStreamKind,
        startOffset: number
    ) {
        this.offset = startOffset
    }

    // Returns the chunks ready to publish; `final` flushes the carry as-is
    // (a transcript cut mid-character at EOF is still delivered).
    read(final: boolean): Array<{ data: string; off: number; len: number }> {
        let fd: number
        try {
            fd = openSync(this.path, 'r')
        } catch {
            return []
        }
        const out: Array<{ data: string; off: number; len: number }> = []
        try {
            const size = fstatSync(fd).size
            if (size < this.offset) {
                // Truncated under us (should not happen; the wrapper only
                // appends): start over rather than read garbage offsets.
                this.offset = 0
                this.carry = Buffer.alloc(0)
            }
            while (this.offset < size) {
                // The carry counts against the cap: an event is at most
                // EXEC_EVENT_MAX_BYTES of source, carry included.
                const want = Math.min(
                    EXEC_EVENT_MAX_BYTES - this.carry.length,
                    size - this.offset
                )
                const chunk = Buffer.alloc(want)
                const got = readSync(fd, chunk, 0, want, this.offset)
                if (got <= 0) break
                const bytes = Buffer.concat([
                    this.carry,
                    chunk.subarray(0, got)
                ])
                const carryStart = this.offset - this.carry.length
                const complete = utf8CompleteLength(bytes)
                this.offset += got
                if (complete > 0)
                    out.push({
                        data: bytes.subarray(0, complete).toString('utf8'),
                        off: carryStart,
                        len: complete
                    })
                this.carry = Buffer.from(bytes.subarray(complete))
            }
            if (final && this.carry.length > 0) {
                out.push({
                    data: this.carry.toString('utf8'),
                    off: this.offset - this.carry.length,
                    len: this.carry.length
                })
                this.carry = Buffer.alloc(0)
            }
        } finally {
            closeSync(fd)
        }
        return out
    }
}

// The wrapper commits the exit line as a whole; a file with no newline yet
// is a write in progress.
const readExitCode = (dir: string): number | null => {
    let raw: string
    try {
        raw = readFileSync(join(dir, EXIT_FILE), 'utf8')
    } catch {
        return null
    }
    const newline = raw.indexOf('\n')
    if (newline < 0) return null
    const code = Number(raw.slice(0, newline).trim())
    return Number.isInteger(code) ? code : null
}

// ---------------------------------------------------------------------------

export interface FileExecHandle {
    refId: string
    stream: ExecStream
    cancelled: boolean
    // Persist the abort, then kill the group (TERM, then KILL).
    abort: () => void
    done: Promise<ExecBufferFinal>
}

const fileExecs = new Map<string, FileExecHandle>()

export const fileExecRegistry = {
    get: (refId: string): FileExecHandle | undefined => fileExecs.get(refId),
    size: (): number => fileExecs.size,
    keys: (): string[] => [...fileExecs.keys()]
}

interface OwnArgs {
    refId: string
    dir: string
    stream: ExecStream
    pgid: number
    // Where the tails resume; zero for a fresh exec.
    offsets: { stdout: number; stderr: number }
    meta: FileExecMeta
    log: (message: string) => void
    // How the stream ends when the group is gone without an exit line and
    // the daemon never killed it (the wrapper itself died): a crash.
}

// Own a file exec — freshly spawned or adopted — until its exit line lands:
// poll the logs, honour the deadline, and complete the stream with the
// raw files removed. Registered so exec.cancel and the hello can find it.
const ownFileExec = (args: OwnArgs): FileExecHandle => {
    const { refId, dir, stream, pgid, log } = args
    const tails = [
        new LogTail(join(dir, STDOUT_FILE), 'stdout', args.offsets.stdout),
        new LogTail(join(dir, STDERR_FILE), 'stderr', args.offsets.stderr)
    ]
    let cancelled = Boolean(args.meta.abortRequestedAt)
    let timedOut = Boolean(args.meta.timedOutAt)
    let killedHard = Boolean(args.meta.killedAt)
    let lastDataAt = Date.now()
    let finished = false
    let pollTimer: NodeJS.Timeout | null = null
    let deadlineTimer: NodeJS.Timeout | null = null
    let escalateTimer: NodeJS.Timeout | null = null
    let resolveDone!: (final: ExecBufferFinal) => void
    const done = new Promise<ExecBufferFinal>((resolve) => {
        resolveDone = resolve
    })

    const publishAll = (final: boolean): boolean => {
        let any = false
        for (const tail of tails) {
            for (const chunk of tail.read(final)) {
                any = true
                try {
                    stream.publish(tail.kind, chunk.data, {
                        off: chunk.off,
                        len: chunk.len
                    })
                } catch (err) {
                    log(
                        `exec-files publish failed for ${refId}: ${(err as Error).message}`
                    )
                }
            }
        }
        return any
    }

    const clearTimers = (): void => {
        if (pollTimer) clearTimeout(pollTimer)
        if (deadlineTimer) clearTimeout(deadlineTimer)
        if (escalateTimer) clearTimeout(escalateTimer)
        pollTimer = deadlineTimer = escalateTimer = null
    }

    const finish = (
        exitCode: number,
        status: 'completed' | 'aborted'
    ): void => {
        if (finished) return
        finished = true
        clearTimers()
        publishAll(true)
        for (const name of [STDOUT_FILE, STDERR_FILE, STDIN_FILE])
            try {
                rmSync(join(dir, name), { force: true })
            } catch {}
        const final: ExecBufferFinal = cancelled
            ? { ok: false, payload: { exitCode }, error: 'cancelled' }
            : {
                  ok: true,
                  payload: {
                      exitCode: timedOut ? EXIT_CODE_TIMEOUT : exitCode
                  }
              }
        stream.complete(final, cancelled ? 'aborted' : status)
        fileExecs.delete(refId)
        resolveDone(final)
    }

    const crash = (reason: string): void => {
        if (finished) return
        finished = true
        clearTimers()
        publishAll(true)
        const final: ExecBufferFinal = {
            ok: false,
            payload: { exitCode: -1 },
            error: reason
        }
        stream.complete(final, 'crashed')
        fileExecs.delete(refId)
        resolveDone(final)
    }

    const killGroup = (): void => {
        try {
            signalGroup(pgid, 'SIGTERM')
        } catch (err) {
            log(
                `exec-files SIGTERM failed for ${refId}: ${(err as Error).message}`
            )
        }
        if (escalateTimer) return
        escalateTimer = setTimeout(() => {
            escalateTimer = null
            if (finished) return
            killedHard = true
            updateMeta(refId, { killedAt: new Date().toISOString() })
            try {
                signalGroup(pgid, 'SIGKILL')
            } catch (err) {
                log(
                    `exec-files SIGKILL failed for ${refId}: ${(err as Error).message}`
                )
            }
        }, KILL_ESCALATE_MS)
        escalateTimer.unref?.()
    }

    const poll = (): void => {
        pollTimer = null
        if (finished) return
        if (publishAll(false)) lastDataAt = Date.now()
        const exitCode = readExitCode(dir)
        if (exitCode !== null) {
            finish(exitCode, 'completed')
            return
        }
        if (!processGroupAlive(pgid)) {
            // Give the exit line one more poll to land: the wrapper writes
            // it right before exiting, and the group check can win the race.
            const settled = readExitCode(dir)
            if (settled !== null) finish(settled, 'completed')
            else if (killedHard || cancelled || timedOut)
                finish(EXIT_CODE_KILLED, 'completed')
            else crash('exec_wrapper_lost')
            return
        }
        const active = Date.now() - lastDataAt < ACTIVE_WINDOW_MS
        pollTimer = setTimeout(poll, active ? POLL_ACTIVE_MS : POLL_IDLE_MS)
    }

    const armDeadline = (): void => {
        if (!args.meta.deadlineAt) return
        const remaining = Date.parse(args.meta.deadlineAt) - Date.now()
        const fire = (): void => {
            deadlineTimer = null
            if (finished || timedOut) return
            timedOut = true
            updateMeta(refId, { timedOutAt: new Date().toISOString() })
            log(`exec-files deadline reached for ${refId}; killing its group`)
            killGroup()
        }
        if (remaining <= 0) fire()
        else deadlineTimer = setTimeout(fire, remaining)
    }

    const handle: FileExecHandle = {
        refId,
        stream,
        get cancelled() {
            return cancelled
        },
        abort: () => {
            if (finished) return
            if (!cancelled) {
                cancelled = true
                updateMeta(refId, {
                    abortRequestedAt: new Date().toISOString()
                })
            }
            killGroup()
        },
        done
    }
    fileExecs.set(refId, handle)
    armDeadline()
    // An abort or timeout persisted before the previous daemon died is
    // re-applied: the process may have ignored the first TERM.
    if (cancelled || timedOut) killGroup()
    pollTimer = setTimeout(poll, 0)
    return handle
}

// ---------------------------------------------------------------------------

export interface StartFileExecArgs {
    refId: string
    cmd: string[]
    cwd: string
    env: NodeJS.ProcessEnv
    stdin: string
    timeoutMs?: number
    stream: ExecStream
    log: (message: string) => void
}

export const startFileExec = (args: StartFileExecArgs): FileExecHandle => {
    const { refId, stream, log } = args
    const dir = bufferDir(refId)
    const executable = resolveExecutable(args.cmd[0], args.env, args.cwd)
    if (!executable) {
        const message = `spawn ${args.cmd[0]} ENOENT`
        try {
            stream.publish('stderr', `[spawn error] ${message}\n`)
        } catch {}
        const final: ExecBufferFinal = {
            ok: false,
            payload: { exitCode: -1 },
            error: message
        }
        stream.complete(final, 'completed')
        return {
            refId,
            stream,
            cancelled: false,
            abort: () => {},
            done: Promise.resolve(final)
        }
    }
    writeFileSync(join(dir, STDIN_FILE), args.stdin, { mode: 0o600 })
    for (const name of [STDOUT_FILE, STDERR_FILE])
        writeFileSync(join(dir, name), '', { mode: 0o600, flag: 'a' })
    const deadlineAt = args.timeoutMs
        ? new Date(Date.now() + args.timeoutMs).toISOString()
        : undefined
    const child = spawn(
        '/bin/sh',
        [
            '-c',
            EXEC_WRAPPER_SCRIPT,
            'mf-exec',
            dir,
            executable,
            ...args.cmd.slice(1)
        ],
        {
            cwd: args.cwd,
            env: args.env,
            detached: true,
            stdio: 'ignore'
        }
    )
    child.on('error', () => {})
    child.unref()
    const pid = child.pid
    if (!pid) {
        const final: ExecBufferFinal = {
            ok: false,
            payload: { exitCode: -1 },
            error: 'exec_spawn_setup_failed'
        }
        stream.complete(final, 'crashed')
        return {
            refId,
            stream,
            cancelled: false,
            abort: () => {},
            done: Promise.resolve(final)
        }
    }
    const owner: ExecOwnerIdentity = {
        pid,
        startTime: processStartTime(pid),
        bootId: currentBootId()
    }
    const meta: Partial<FileExecMeta> = {
        format: EXEC_FILES_FORMAT,
        owner,
        cwd: args.cwd,
        ...(deadlineAt ? { deadlineAt } : {})
    }
    updateMeta(refId, meta)
    return ownFileExec({
        refId,
        dir,
        stream,
        pgid: pid,
        offsets: { stdout: 0, stderr: 0 },
        meta: { ...(readMeta(refId) as FileExecMeta), ...meta } as FileExecMeta,
        log
    })
}

// ---------------------------------------------------------------------------
// After a restart: for every file exec the previous daemon left running, an
// exit line means it finished while nobody watched (drain and complete);
// a matching owner identity means it is still running (re-tail it, re-arm
// its deadline and any abort); anything else is a crash, and a pid that
// is alive but not ours is never signalled.

const tailOffsets = (refId: string): { stdout: number; stderr: number } => {
    const offsets = { stdout: 0, stderr: 0 }
    for (const event of readEventsFrom(refId, 0)) {
        if (event.off === undefined) continue
        const end = event.off + (event.len ?? Buffer.byteLength(event.data))
        if (event.kind === 'stdout')
            offsets.stdout = Math.max(offsets.stdout, end)
        else if (event.kind === 'stderr')
            offsets.stderr = Math.max(offsets.stderr, end)
    }
    return offsets
}

export const adoptFileExec = (
    refId: string,
    meta: FileExecMeta,
    log: (message: string) => void
): 'adopted' | 'completed' | 'crashed' => {
    if (readFinal(refId)) return 'completed'
    const dir = bufferDir(refId)
    const stream = new ExecStream({
        refId,
        method: meta.method,
        payload: meta.payload,
        adopt: { seq: lastSeq(refId) }
    })
    execStreams.set(refId, stream)
    const own = (): FileExecHandle =>
        ownFileExec({
            refId,
            dir,
            stream,
            pgid: meta.owner.pid,
            offsets: tailOffsets(refId),
            meta,
            log
        })
    // The raw logs go at completion; their absence with no final means the
    // previous daemon died between the drain and the final write.
    if (!existsSync(join(dir, STDOUT_FILE))) {
        stream.complete(
            {
                ok: false,
                payload: { exitCode: -1 },
                error: 'exec_completion_lost'
            },
            'crashed'
        )
        return 'crashed'
    }
    // Finished while nobody watched: the owner loop drains and completes it
    // on its first poll.
    if (readExitCode(dir) !== null) {
        own()
        return 'completed'
    }
    if (!ownerIdentityMatches(meta.owner)) {
        stream.complete(
            {
                ok: false,
                payload: { exitCode: -1 },
                error: 'daemon process crashed'
            },
            'crashed'
        )
        return 'crashed'
    }
    own()
    return 'adopted'
}

export const recoverFileExecs = (
    log: (message: string) => void
): { adopted: number; completed: number; crashed: number } => {
    const summary = { adopted: 0, completed: 0, crashed: 0 }
    const adoptable = (refId: string, meta: ExecBufferMeta): boolean => {
        if (!isFileExecMeta(meta)) return false
        try {
            const outcome = adoptFileExec(refId, meta, log)
            summary[outcome] += 1
            if (outcome === 'adopted')
                log(`exec-files adopted ${refId} pid=${meta.owner.pid}`)
        } catch (err) {
            log(
                `exec-files recovery failed for ${refId}: ${(err as Error).message}`
            )
            markCrashed(refId)
            summary.crashed += 1
        }
        return true
    }
    // recoverCrashedBuffers walks the directory and marks the pipe execs; the
    // file execs are decided here through the hook.
    recoverCrashedBuffers({ adoptable })
    return summary
}
