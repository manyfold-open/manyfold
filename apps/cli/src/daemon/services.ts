import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, statSync } from 'node:fs'
import {
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import type {
    DaemonServiceSpec,
    DaemonServiceState,
    DaemonServiceStatus
} from '@manyfold/shared'

// The long-running processes of the service frameworks on a pod host
// (ADR-0035 §6) — what a sprite's Services API does for a sprite. Each spec
// lives on the home volume, so a pod restart brings every wanted service
// back; each process runs in its own process group, detached from the
// daemon, so a daemon restart (a self-update) does not take it down, and the
// next daemon adopts it by its pid file.

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const TICK_MS = 5_000
const STOP_GRACE_MS = 10_000
const MAX_BACKOFF_MS = 60_000
// A run this long counts as having stayed up: the backoff starts over.
const STABLE_RUN_MS = 60_000
const HEALTH_TIMEOUT_MS = 2_000
const LOG_ROTATE_BYTES = 10 * 1024 * 1024

interface StoredSpec {
    spec: Omit<DaemonServiceSpec, 'env'>
    desired: 'running' | 'stopped'
}

interface PidRecord {
    pid: number
    // /proc starttime: a pid the kernel reused for another process after a
    // pod restart must not be adopted as the service.
    startTicks: string | null
    startedAt: string
}

interface Live {
    pid: number | null
    startTicks: string | null
    startedAt: string | null
    restarts: number
    lastExit: string | null
    nextStartAt: number
}

export interface ServiceSupervisorOptions {
    dir: string
    log: (line: string) => void
    // Tests drive the clock.
    now?: () => number
}

// `state` and starttime from /proc/<pid>/stat; null when there is no such
// process. Fields after the command name, whose parentheses may nest.
const procStat = (
    pid: number
): { state: string; startTicks: string } | null => {
    let raw: string
    try {
        raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch {
        return null
    }
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    return { state: fields[0] ?? '', startTicks: fields[19] ?? '' }
}

const alive = (pid: number, startTicks: string | null): boolean => {
    const stat = procStat(pid)
    if (stat) return stat.state !== 'Z' && (!startTicks || stat.startTicks === startTicks)
    // No /proc (not Linux): the signal probe is all there is.
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

// The daemon's own environment minus what only the daemon needs: a service
// keeps the image's PATH, mise and npm settings, and gets its spec's env on
// top.
const serviceEnv = (env: Record<string, string>): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env))
        if (!key.startsWith('MF_')) base[key] = value
    return { ...base, ...env }
}

export class ServiceSupervisor {
    private readonly live = new Map<string, Live>()
    private readonly locks = new Map<string, Promise<unknown>>()
    private timer: ReturnType<typeof setInterval> | null = null
    private readonly now: () => number

    constructor(private readonly opts: ServiceSupervisorOptions) {
        this.now = opts.now ?? Date.now
    }

    private path(name: string, ext: string): string {
        return join(this.opts.dir, `${name}.${ext}`)
    }

    private serial<T>(name: string, work: () => Promise<T>): Promise<T> {
        const prev = this.locks.get(name) ?? Promise.resolve()
        const next = prev.then(work, work)
        this.locks.set(
            name,
            next.catch(() => undefined)
        )
        return next
    }

    private liveOf(name: string): Live {
        let entry = this.live.get(name)
        if (!entry) {
            entry = {
                pid: null,
                startTicks: null,
                startedAt: null,
                restarts: 0,
                lastExit: null,
                nextStartAt: 0
            }
            this.live.set(name, entry)
        }
        return entry
    }

    private async readStored(name: string): Promise<StoredSpec | null> {
        try {
            return JSON.parse(
                await readFile(this.path(name, 'json'), 'utf8')
            ) as StoredSpec
        } catch {
            return null
        }
    }

    private async writeStored(name: string, stored: StoredSpec): Promise<void> {
        const target = this.path(name, 'json')
        await writeFile(`${target}.tmp`, JSON.stringify(stored), {
            mode: 0o600
        })
        await rename(`${target}.tmp`, target)
    }

    // Starts the loop and takes over what a previous daemon left running.
    async resume(): Promise<void> {
        await mkdir(this.opts.dir, { recursive: true, mode: 0o700 })
        for (const file of await readdir(this.opts.dir)) {
            if (!file.endsWith('.json')) continue
            const name = file.slice(0, -'.json'.length)
            if (!NAME.test(name)) continue
            const record = await this.readPid(name)
            if (record && alive(record.pid, record.startTicks)) {
                const entry = this.liveOf(name)
                entry.pid = record.pid
                entry.startTicks = record.startTicks
                entry.startedAt = record.startedAt
                this.opts.log(`service ${name}: adopted pid ${record.pid}`)
            }
        }
        await this.reconcile()
        this.timer = setInterval(() => void this.reconcile(), TICK_MS)
        this.timer.unref?.()
    }

    stopLoop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    async upsert(spec: DaemonServiceSpec): Promise<void> {
        if (!NAME.test(spec.name))
            throw new Error(`invalid service name: ${spec.name}`)
        if (!Array.isArray(spec.command) || spec.command.length === 0)
            throw new Error('service command is required')
        if (!spec.dir?.startsWith('/'))
            throw new Error('service dir must be absolute')
        await this.serial(spec.name, async () => {
            await mkdir(this.opts.dir, { recursive: true, mode: 0o700 })
            const { env, ...rest } = spec
            const previous = await this.readStored(spec.name)
            const envPath = this.path(spec.name, 'env')
            await writeFile(`${envPath}.tmp`, JSON.stringify(env ?? {}), {
                mode: 0o600
            })
            await rename(`${envPath}.tmp`, envPath)
            await this.writeStored(spec.name, {
                spec: rest,
                desired: previous?.desired ?? 'stopped'
            })
        })
    }

    async start(name: string): Promise<DaemonServiceStatus> {
        return this.serial(name, async () => {
            const stored = await this.requireStored(name)
            await this.writeStored(name, { ...stored, desired: 'running' })
            const entry = this.liveOf(name)
            entry.restarts = 0
            entry.nextStartAt = 0
            if (!entry.pid || !alive(entry.pid, entry.startTicks))
                await this.spawnService(name, stored, false)
            return this.statusOf(name, 'running')
        })
    }

    async stop(name: string): Promise<DaemonServiceStatus> {
        return this.serial(name, async () => {
            const stored = await this.requireStored(name)
            await this.writeStored(name, { ...stored, desired: 'stopped' })
            await this.kill(name)
            return this.statusOf(name, 'stopped')
        })
    }

    async remove(name: string): Promise<void> {
        await this.serial(name, async () => {
            await this.kill(name)
            for (const ext of ['json', 'env', 'pid'])
                await rm(this.path(name, ext), { force: true })
            this.live.delete(name)
        })
    }

    async list(): Promise<DaemonServiceStatus[]> {
        let files: string[]
        try {
            files = await readdir(this.opts.dir)
        } catch {
            return []
        }
        const out: DaemonServiceStatus[] = []
        for (const file of files.sort()) {
            if (!file.endsWith('.json')) continue
            const name = file.slice(0, -'.json'.length)
            const stored = await this.readStored(name)
            if (!stored) continue
            const status = this.statusOf(name, stored.desired)
            out.push({
                ...status,
                healthy:
                    status.state === 'running'
                        ? await this.health(stored.spec)
                        : null
            })
        }
        return out
    }

    private async requireStored(name: string): Promise<StoredSpec> {
        if (!NAME.test(name)) throw new Error(`invalid service name: ${name}`)
        const stored = await this.readStored(name)
        if (!stored) throw new Error(`no such service: ${name}`)
        return stored
    }

    private statusOf(
        name: string,
        desired: StoredSpec['desired']
    ): DaemonServiceStatus {
        const entry = this.liveOf(name)
        const running = entry.pid !== null && alive(entry.pid, entry.startTicks)
        const state: DaemonServiceState = running
            ? 'running'
            : desired === 'running'
              ? 'restarting'
              : 'stopped'
        return {
            name,
            state,
            pid: running ? entry.pid : null,
            startedAt: running ? entry.startedAt : null,
            restarts: entry.restarts,
            lastExit: entry.lastExit,
            healthy: null
        }
    }

    private async health(
        spec: StoredSpec['spec']
    ): Promise<boolean | null> {
        if (!spec.port || !spec.healthPath) return null
        try {
            const res = await fetch(
                `http://127.0.0.1:${spec.port}${spec.healthPath}`,
                { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }
            )
            return res.status < 500
        } catch {
            return false
        }
    }

    // One pass of the loop: start what should run and does not.
    async reconcile(): Promise<void> {
        let files: string[]
        try {
            files = await readdir(this.opts.dir)
        } catch {
            return
        }
        for (const file of files) {
            if (!file.endsWith('.json')) continue
            const name = file.slice(0, -'.json'.length)
            if (!NAME.test(name)) continue
            await this.serial(name, async () => {
                const stored = await this.readStored(name)
                if (stored?.desired !== 'running') return
                const entry = this.liveOf(name)
                if (entry.pid && alive(entry.pid, entry.startTicks)) return
                if (entry.pid) {
                    entry.lastExit ??= 'exited'
                    entry.pid = null
                }
                if (this.now() < entry.nextStartAt) return
                await this.spawnService(name, stored, true)
            }).catch((err: Error) =>
                this.opts.log(`service ${name}: ${err.message}`)
            )
        }
    }

    private async spawnService(
        name: string,
        stored: StoredSpec,
        afterExit: boolean
    ): Promise<void> {
        const entry = this.liveOf(name)
        // A service that keeps dying waits longer each time, up to a minute;
        // one that stayed up starts the count over.
        const ranFor = entry.startedAt
            ? this.now() - Date.parse(entry.startedAt)
            : 0
        if (ranFor >= STABLE_RUN_MS) entry.restarts = 0
        if (afterExit) entry.restarts += 1
        let env: Record<string, string> = {}
        try {
            env = JSON.parse(
                await readFile(this.path(name, 'env'), 'utf8')
            ) as Record<string, string>
        } catch {}
        const logPath = this.path(name, 'log')
        try {
            if (statSync(logPath).size > LOG_ROTATE_BYTES)
                await rename(logPath, `${logPath}.1`)
        } catch {}
        const out = openSync(logPath, 'a', 0o600)
        const [command, ...args] = stored.spec.command
        const child = spawn(command, args, {
            cwd: stored.spec.dir,
            env: serviceEnv(env),
            detached: true,
            stdio: ['ignore', out, out]
        })
        closeSync(out)
        const pid = await new Promise<number | null>((resolve) => {
            child.once('spawn', () => resolve(child.pid ?? null))
            child.once('error', (err) => {
                entry.lastExit = `spawn failed: ${err.message}`
                resolve(null)
            })
        })
        entry.nextStartAt =
            this.now() +
            Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(entry.restarts, 6))
        if (pid === null) return
        child.once('exit', (code, signal) => {
            if (entry.pid !== pid) return
            entry.lastExit = signal ? `signal ${signal}` : `exit ${code}`
            entry.pid = null
        })
        child.unref()
        entry.pid = pid
        entry.startTicks = procStat(pid)?.startTicks ?? null
        entry.startedAt = new Date(this.now()).toISOString()
        entry.lastExit = null
        const record: PidRecord = {
            pid,
            startTicks: entry.startTicks,
            startedAt: entry.startedAt
        }
        await writeFile(this.path(name, 'pid'), JSON.stringify(record), {
            mode: 0o600
        })
        this.opts.log(`service ${name}: started pid ${pid}`)
    }

    private async readPid(name: string): Promise<PidRecord | null> {
        try {
            return JSON.parse(
                await readFile(this.path(name, 'pid'), 'utf8')
            ) as PidRecord
        } catch {
            return null
        }
    }

    private async kill(name: string): Promise<void> {
        const entry = this.liveOf(name)
        const record = entry.pid
            ? { pid: entry.pid, startTicks: entry.startTicks }
            : await this.readPid(name)
        if (record && alive(record.pid, record.startTicks)) {
            // The whole group: a gateway's own children go with it.
            const signal = (sig: NodeJS.Signals): void => {
                try {
                    process.kill(-record.pid, sig)
                } catch {
                    try {
                        process.kill(record.pid, sig)
                    } catch {}
                }
            }
            signal('SIGTERM')
            const deadline = this.now() + STOP_GRACE_MS
            while (alive(record.pid, record.startTicks) && this.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 100))
            if (alive(record.pid, record.startTicks)) signal('SIGKILL')
        }
        entry.pid = null
        entry.startTicks = null
        entry.startedAt = null
        await rm(this.path(name, 'pid'), { force: true })
    }
}
