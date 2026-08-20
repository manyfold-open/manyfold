import http from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { CliChannel } from '@/channel'
import type { DaemonStartupMethod } from '@manyfold/shared'

// Local control plane for `mf daemon`: the foreground daemon serves GET
// /health over a unix socket (named pipe on Windows) inside its state dir, so
// `daemon status` answers instantly without an API round-trip, `daemon start`
// can gate on real readiness instead of just a pidfile, and everything stays
// per-profile and permission-scoped (0700 dir) with no TCP port to collide on.

export interface DaemonLocalHealth {
    status: 'starting' | 'running'
    pid: number
    version: string
    channel: CliChannel
    profile: string
    daemonId: string
    apiUrl: string
    startedAt: string
    uptimeMs: number
    wsConnected: boolean
    activeExecs: number
    activePtys: number
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

export const startControlServer = async (opts: {
    socketPath: string
    getHealth: () => DaemonLocalHealth
}): Promise<() => Promise<void>> => {
    if (process.platform !== 'win32' && existsSync(opts.socketPath)) {
        const live = await queryDaemonHealth(opts.socketPath)
        if (live)
            throw new Error(
                `another daemon (pid=${live.pid}) is already serving ${opts.socketPath}`
            )
        await unlink(opts.socketPath).catch(() => {})
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

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(opts.socketPath, () => {
            server.removeListener('error', reject)
            resolve()
        })
    })
    if (process.platform !== 'win32')
        await chmod(opts.socketPath, 0o600).catch(() => {})

    return async (): Promise<void> => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        if (process.platform !== 'win32')
            await unlink(opts.socketPath).catch(() => {})
    }
}
