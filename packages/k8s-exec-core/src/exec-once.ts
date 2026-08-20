import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import {
    Exec,
    type KubeConfig,
    type V1Status
} from '@kubernetes/client-node'
import type { WebSocket } from 'ws'
import type { PodExecRequest, PodExecResult, PodExecTarget } from './types'

export interface ExecOnceLogger {
    warn?: (msg: string) => void
    debug?: (msg: string) => void
}

// `@kubernetes/client-node`'s WebSocket exec path does not consult the
// `tokenFile` authProvider that loadFromCluster() sets up; the WS upgrade
// would go out with no Authorization header and apiserver returns 403.
// Read the in-cluster SA token fresh on each call (cheap fs read, also
// handles SA token rotation transparently) and stamp it onto user.token.
const refreshInClusterToken = (kubeConfig: KubeConfig): void => {
    const user = kubeConfig.getCurrentUser()
    if (!user) return
    const tokenFile =
        (user.authProvider as { config?: { tokenFile?: string } } | undefined)
            ?.config?.tokenFile
    if (!tokenFile) return
    try {
        ;(user as { token?: string }).token = readFileSync(
            tokenFile,
            'utf8'
        ).trim()
    } catch {
        // leave user.token unchanged — caller will fail loudly on auth
    }
}

export async function execOnce(
    kubeConfig: KubeConfig,
    target: PodExecTarget,
    req: PodExecRequest,
    _logger?: ExecOnceLogger
): Promise<PodExecResult> {
    refreshInClusterToken(kubeConfig)
    const stdoutStream = new PassThrough()
    const stderrStream = new PassThrough()
    const stdinStream = new PassThrough()
    if (req.stdin !== undefined) stdinStream.end(req.stdin)
    else stdinStream.end()

    let stdout = ''
    let stderr = ''
    stdoutStream.on('data', (c) => {
        stdout +=
            typeof c === 'string' ? c : Buffer.isBuffer(c) ? c.toString('utf8') : ''
    })
    stderrStream.on('data', (c) => {
        stderr +=
            typeof c === 'string' ? c : Buffer.isBuffer(c) ? c.toString('utf8') : ''
    })

    let exitCode: number | null = null
    let settled = false
    let timedOut = false
    let upstream: WebSocket | undefined

    const timeoutMs = Math.max(1_000, req.timeoutMs)

    return new Promise<PodExecResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            if (settled) return
            timedOut = true
            try {
                upstream?.close()
            } catch {}
            settled = true
            reject(new Error(`pod exec timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        const finalize = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (exitCode === null) {
                reject(
                    new Error(
                        timedOut
                            ? `pod exec timed out after ${timeoutMs}ms`
                            : 'pod exec closed without status'
                    )
                )
                return
            }
            resolve({ exitCode, stdout, stderr })
        }

        const onStatus = (status: V1Status): void => {
            exitCode = parseExitCode(status)
        }

        const exec = new Exec(kubeConfig)
        exec.exec(
            target.namespace,
            target.pod,
            target.container,
            req.cmd,
            stdoutStream,
            stderrStream,
            stdinStream,
            false,
            onStatus
        )
            .then((ws) => {
                upstream = ws
                ws.on('close', finalize)
                ws.on('error', (err: Error) => {
                    if (settled) return
                    settled = true
                    clearTimeout(timer)
                    reject(err)
                })
            })
            .catch((err: unknown) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                reject(toError(err))
            })
    })
}

const EXIT_CODE_PATTERN = /exit code (\d+)/i

const parseExitCode = (status: V1Status): number => {
    if (status.status === 'Success') return 0
    const causes = status.details?.causes ?? []
    for (const cause of causes) {
        if (cause.reason === 'ExitCode' && cause.message) {
            const n = Number(cause.message)
            if (Number.isFinite(n)) return n
        }
        if (cause.message) {
            const m = cause.message.match(EXIT_CODE_PATTERN)
            if (m) return Number(m[1])
        }
    }
    if (status.message) {
        const m = status.message.match(EXIT_CODE_PATTERN)
        if (m) return Number(m[1])
    }
    return 1
}

const toError = (err: unknown): Error => {
    if (err instanceof Error) return err
    if (err && typeof err === 'object') {
        const obj = err as Record<string, unknown>
        const body =
            typeof obj.body === 'string'
                ? obj.body
                : obj.body
                  ? safeJson(obj.body)
                  : undefined
        const code = obj.statusCode ?? obj.code
        const reason = typeof obj.message === 'string' ? obj.message : null
        const parts = [
            reason,
            code !== undefined ? `(code ${String(code)})` : null,
            body ? `body=${body}` : null
        ].filter(Boolean)
        if (parts.length) return new Error(parts.join(' '))
        return new Error(safeJson(err))
    }
    return new Error(String(err))
}

const safeJson = (v: unknown): string => {
    try {
        return JSON.stringify(v)
    } catch {
        return String(v)
    }
}
