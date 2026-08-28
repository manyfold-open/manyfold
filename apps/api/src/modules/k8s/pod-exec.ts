import { PassThrough, Readable } from 'node:stream'
import { Injectable } from '@nestjs/common'
import { Exec, type V1Status } from '@kubernetes/client-node'
import type { WebSocket } from 'ws'
import type { K8sClient } from '@/modules/k8s/kubernetes.service'
import { GatewayExecClient } from '@/modules/k8s/gateway-exec.client'

export interface PodExecStreamRequest {
    cmd: string[]
    timeoutMs: number
    stdin?: string | Buffer
}

export interface PodExecRunResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface PodExecStreamHandle {
    stdout: AsyncIterable<string>
    stderr: AsyncIterable<string>
    result: Promise<PodExecRunResult>
    abort(): void
}

export interface PodExecInteractiveRequest {
    cmd: string[]
    timeoutMs: number
}

export interface PodExecInteractiveHandle {
    stdout: AsyncIterable<string>
    stderr: AsyncIterable<string>
    stdin: { write(data: Buffer | string): void; end(): void }
    result: Promise<PodExecRunResult>
    abort(): void
}

export class PodExec {
    private readonly exec: Exec

    constructor(
        private readonly gateway: GatewayExecClient,
        client: K8sClient,
        readonly namespace: string,
        readonly podName: string,
        readonly containerName: string
    ) {
        this.exec = new Exec(client.kubeConfig)
    }

    async run(req: PodExecStreamRequest): Promise<PodExecRunResult> {
        const stdin =
            req.stdin === undefined
                ? undefined
                : Buffer.isBuffer(req.stdin)
                  ? req.stdin.toString('utf8')
                  : req.stdin
        return this.gateway.exec(
            {
                namespace: this.namespace,
                pod: this.podName,
                container: this.containerName
            },
            { cmd: req.cmd, stdin, timeoutMs: req.timeoutMs }
        )
    }

    stream(req: PodExecStreamRequest): PodExecStreamHandle {
        const core = this.streamCore(req.cmd, req.timeoutMs)
        if (req.stdin !== undefined) core.stdinWrite(req.stdin)
        core.stdinEnd()
        return {
            stdout: core.stdout,
            stderr: core.stderr,
            result: core.result,
            abort: core.abort
        }
    }

    // Interactive stdio for client-driven protocols (ACP): stdin stays open
    // and is written per frame. Goes through the direct Exec websocket, never
    // the gateway - the gateway's POST /exec takes stdin as one up-front
    // string. Same open-PassThrough shape as terminal/k8s-terminal.ts, minus
    // the tty (channels must stay split for JSON-RPC).
    streamInteractive(req: PodExecInteractiveRequest): PodExecInteractiveHandle {
        const core = this.streamCore(req.cmd, req.timeoutMs)
        return {
            stdout: core.stdout,
            stderr: core.stderr,
            stdin: { write: core.stdinWrite, end: core.stdinEnd },
            result: core.result,
            abort: core.abort
        }
    }

    // One socket/settle lifecycle for both entry points - the state machine
    // is subtle enough that two copies would drift on the next fix. Only the
    // stdin discipline differs: stream() delivers its payload and EOFs before
    // output starts, streamInteractive keeps the pipe open for JSON-RPC.
    private streamCore(cmd: string[], timeoutMsRaw: number) {
        const stdoutStream = new PassThrough()
        const stderrStream = new PassThrough()
        const stdinStream = new PassThrough()

        let exitCode: number | null = null
        let settled = false
        let timedOut = false
        let stdinEnded = false
        let upstream: WebSocket | undefined

        let resolveResult!: (v: PodExecRunResult) => void
        let rejectResult!: (e: Error) => void
        const result = new Promise<PodExecRunResult>((resolve, reject) => {
            resolveResult = resolve
            rejectResult = reject
        })

        const timeoutMs = Math.max(1_000, timeoutMsRaw)
        const timer = setTimeout(() => {
            if (settled) return
            timedOut = true
            try {
                upstream?.close()
            } catch {}
            settleFail(new Error(`pod exec timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        const endStdin = (): void => {
            if (stdinEnded) return
            stdinEnded = true
            try {
                stdinStream.end()
            } catch {}
        }

        const finalize = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            endStdin()
            try {
                stdoutStream.end()
            } catch {}
            try {
                stderrStream.end()
            } catch {}
            if (exitCode === null) {
                rejectResult(
                    new Error(
                        timedOut
                            ? `pod exec timed out after ${timeoutMs}ms`
                            : 'pod exec closed without status'
                    )
                )
                return
            }
            resolveResult({ exitCode, stdout: '', stderr: '' })
        }

        const settleFail = (err: Error): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            endStdin()
            try {
                stdoutStream.destroy()
            } catch {}
            try {
                stderrStream.destroy()
            } catch {}
            rejectResult(err)
        }

        const onStatus = (status: V1Status): void => {
            exitCode = parseExitCode(status)
            // socket close handler runs finalize
        }

        this.exec
            .exec(
                this.namespace,
                this.podName,
                this.containerName,
                cmd,
                stdoutStream,
                stderrStream,
                stdinStream,
                false,
                onStatus
            )
            .then((ws) => {
                upstream = ws
                // An abort or timeout that raced the exec handshake has
                // already settled - nothing else will ever close this socket,
                // so close it here or the exec session leaks until the
                // in-container timeout.
                if (settled) {
                    try {
                        ws.close()
                    } catch {}
                    return
                }
                ws.on('close', finalize)
                ws.on('error', (err: Error) => settleFail(err))
            })
            .catch((err: unknown) => settleFail(toError(err)))

        return {
            stdout: readableToAsyncStrings(stdoutStream),
            stderr: readableToAsyncStrings(stderrStream),
            stdinWrite: (data: Buffer | string): void => {
                if (settled || stdinEnded) return
                try {
                    stdinStream.write(data)
                } catch {}
            },
            stdinEnd: endStdin,
            result,
            // stdin EOF first: closing the websocket alone does not reliably
            // kill the remote child, while `hermes acp` (like any stdio
            // JSON-RPC server) exits on EOF. Settle before close - a close
            // event that beats settleFail would finalize as 'closed without
            // status' and lose the abort. The close itself waits one tick:
            // the EOF frame flushes through the stream pipeline
            // asynchronously, and a same-tick close drops it.
            abort: (): void => {
                endStdin()
                settleFail(new Error('pod exec aborted'))
                setImmediate(() => {
                    try {
                        upstream?.close()
                    } catch {}
                })
            }
        }
    }

}

@Injectable()
export class PodExecFactory {
    constructor(private readonly gateway: GatewayExecClient) {}

    forClient(
        client: K8sClient,
        namespace: string,
        podName: string,
        containerName: string
    ): PodExec {
        return new PodExec(
            this.gateway,
            client,
            namespace,
            podName,
            containerName
        )
    }
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

const readableToAsyncStrings = (stream: Readable): AsyncIterable<string> => ({
    [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
            if (typeof chunk === 'string') yield chunk
            else if (Buffer.isBuffer(chunk)) yield chunk.toString('utf8')
        }
    }
})

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
