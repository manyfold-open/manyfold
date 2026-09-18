import http from 'node:http'
import { createHash } from 'node:crypto'
import { chmod, lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import type { CliChannel } from '@/channel'
import type { DaemonStartupMethod } from '@manyfold/shared'
import { acquireProcessLock, ProcessLockBusyError } from './process-lock'

// Local control plane for `mf daemon`: the foreground daemon serves GET
// /health over a unix socket (named pipe on Windows) inside its state dir, so
// `daemon status` answers instantly without an API round-trip, `daemon start`
// can gate on real readiness instead of just a pidfile, and everything stays
// per-profile and permission-scoped (0700 dir) with no TCP port to collide on.

export interface DaemonLocalHealth {
    status: 'starting' | 'running'
    pid: number
    clientInstanceId?: string
    version: string
    channel: CliChannel
    profile: string
    daemonId: string
    apiUrl: string
    startedAt: string
    uptimeMs: number
    wsConnected: boolean
    activeExecs: number
    // Of activeExecs, how many would outlive a restart of this daemon
    // (detached file execs on an installation that keeps them; ADR-0029 §4).
    adoptableExecs?: number
    execsSurviveRestart?: boolean
    activePtys: number
    // Terminals this daemon owns (ADR-0029 §6) and how many have a viewer.
    ownedTerminals?: number
    attachedTerminals?: number
    updatePending: boolean
    autoUpdate: boolean
    startupMethod: DaemonStartupMethod
    logPath: string
}

export const controlSocketPathFor = (baseDir: string): string =>
    process.platform === 'win32'
        ? `\\\\.\\pipe\\mf-daemon-${createHash('sha256')
              .update(baseDir)
              .digest('hex')
              .slice(0, 12)}`
        : join(baseDir, 'daemon.sock')

const isHealthLike = (value: unknown): value is DaemonLocalHealth =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DaemonLocalHealth).pid === 'number' &&
    ((value as DaemonLocalHealth).status === 'starting' ||
        (value as DaemonLocalHealth).status === 'running')

export const queryDaemonHealth = (
    socketPath: string,
    timeoutMs = 1_000
): Promise<DaemonLocalHealth | null> =>
    new Promise((resolve) => {
        const req = http.request(
            { socketPath, path: '/health', method: 'GET', timeout: timeoutMs },
            (res) => {
                let body = ''
                res.setEncoding('utf8')
                res.on('data', (chunk: string) => {
                    body += chunk
                })
                res.on('end', () => {
                    if (res.statusCode !== 200) return resolve(null)
                    try {
                        const parsed = JSON.parse(body) as unknown
                        resolve(isHealthLike(parsed) ? parsed : null)
                    } catch {
                        resolve(null)
                    }
                })
                res.on('error', () => resolve(null))
            }
        )
        req.on('timeout', () => req.destroy())
        req.on('error', () => resolve(null))
        req.end()
    })

export const waitForDaemonHealth = async (
    socketPath: string,
    opts: {
        timeoutMs: number
        until?: (health: DaemonLocalHealth) => boolean
    }
): Promise<DaemonLocalHealth | null> => {
    const until = opts.until ?? ((h): boolean => h.status === 'running')
    const deadline = Date.now() + opts.timeoutMs
    let last: DaemonLocalHealth | null = null
    for (;;) {
        const health = await queryDaemonHealth(socketPath)
        if (health) {
            last = health
            if (until(health)) return health
        }
        if (Date.now() >= deadline) return last
        await new Promise((resolve) => setTimeout(resolve, 250))
    }
}

const socketAcceptsConnections = (socketPath: string): Promise<boolean> =>
    new Promise((resolve, reject) => {
        const socket = createConnection({ path: socketPath })
        socket.setTimeout(1000)
        socket.once('connect', () => {
            socket.destroy()
            resolve(true)
        })
        socket.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT')
                resolve(false)
            else reject(err)
        })
        socket.once('timeout', () => {
            socket.destroy()
            reject(
                new Error(
                    'control socket probe timed out; refusing to replace it'
                )
            )
        })
    })

export const startControlServer = async (opts: {
    socketPath: string
    getHealth: () => DaemonLocalHealth
}): Promise<() => Promise<void>> => {
    let lock
    try {
        lock = await acquireProcessLock(
            process.platform === 'win32'
                ? join(
                      tmpdir(),
                      `mf-control-${createHash('sha256').update(opts.socketPath).digest('hex')}.locks`
                  )
                : `${opts.socketPath}.locks`
        )
    } catch (err) {
        if (err instanceof ProcessLockBusyError)
            throw new Error(
                `another daemon (pid=${err.pid}) is already serving ${opts.socketPath}`
            )
        throw err
    }
    try {
        const close = await bindControlServer(opts)
        let closing: Promise<void> | null = null
        return () =>
            (closing ??= (async () => {
                try {
                    await close()
                } finally {
                    await lock.release()
                }
            })())
    } catch (err) {
        await lock.release()
        throw err
    }
}

const bindControlServer = async (opts: {
    socketPath: string
    getHealth: () => DaemonLocalHealth
}): Promise<() => Promise<void>> => {
    if (process.platform !== 'win32') {
        const existing = await lstat(opts.socketPath).catch(
            (err: NodeJS.ErrnoException) => {
                if (err.code === 'ENOENT') return null
                throw err
            }
        )
        if (existing) {
            if (!existing.isSocket())
                throw new Error(
                    `control socket path is not a socket: ${opts.socketPath}`
                )
            if (await socketAcceptsConnections(opts.socketPath))
                throw new Error(
                    `another process is already serving ${opts.socketPath}`
                )
            await unlink(opts.socketPath).catch(
                (err: NodeJS.ErrnoException) => {
                    if (err.code !== 'ENOENT') throw err
                }
            )
        }
    }

    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url?.split('?')[0] === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(opts.getHealth()))
            return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
    })

    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(opts.socketPath, () => {
                server.removeListener('error', reject)
                resolve()
            })
        })
    } catch (err) {
        server.close()
        throw err
    }
    if (process.platform !== 'win32')
        await chmod(opts.socketPath, 0o600).catch(() => {})

    return async (): Promise<void> => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
}
