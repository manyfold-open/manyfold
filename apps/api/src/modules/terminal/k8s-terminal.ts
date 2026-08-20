import { PassThrough } from 'node:stream'
import {
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { Exec } from '@kubernetes/client-node'
import type { WebSocket as WsClient } from 'ws'
import type { Agent } from '@manyfold/db'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { resolveAgentPod } from '@/modules/agents/adapters/k8s-pod-resolver'

export interface K8sTerminalRequest {
    agent: Agent
    cols: number
    cwd?: string
    rows: number
    client: WsClient
    onClose: () => void
}

@Injectable()
export class K8sTerminal {
    private readonly log = new Logger(K8sTerminal.name)

    constructor(
        private readonly k8s: KubernetesService,
        private readonly runtimes: AgentRuntimesService
    ) {}

    async tunnel(req: K8sTerminalRequest): Promise<void> {
        const { agent, cols, cwd, rows, client, onClose } = req
        if (!agent.namespace)
            throw new NotFoundException('k8s agent missing namespace')

        const runtime = await this.runtimes.findById(agent.runtimeId)
        if (!runtime)
            throw new NotFoundException(
                `runtime ${agent.runtimeId} not found for agent ${agent.id}`
            )
        if (!runtime.primaryAgentId)
            throw new ServiceUnavailableException(
                `runtime ${runtime.id} has no primaryAgentId; terminal unavailable`
            )

        const pod = await resolveAgentPod(
            this.k8s,
            runtime,
            runtime.primaryAgentId
        ).catch((err) => {
            throw new ServiceUnavailableException((err as Error).message)
        })

        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()

        const cleanup = (code = 1000, reason = ''): void => {
            try {
                stdin.end()
            } catch {}
            try {
                stdout.destroy()
            } catch {}
            try {
                stderr.destroy()
            } catch {}
            try {
                if (client.readyState === client.OPEN)
                    client.close(code, reason)
            } catch {}
            onClose()
        }

        const forwardChunk = (chunk: Buffer | string): void => {
            if (client.readyState !== client.OPEN) return
            try {
                client.send(
                    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'),
                    { binary: true }
                )
            } catch {}
        }
        stdout.on('data', forwardChunk)
        stderr.on('data', forwardChunk)

        const cmd = buildK8sTerminalCommand(cwd ?? agent.mountPath)

        const exec = new Exec(pod.client.kubeConfig)
        let upstream: import('ws').WebSocket | undefined
        try {
            upstream = await exec.exec(
                pod.namespace,
                pod.podName,
                pod.containerName,
                cmd,
                stdout,
                stderr,
                stdin,
                true,
                (status) => {
                    const code = status.status === 'Success' ? 0 : 1
                    try {
                        if (client.readyState === client.OPEN)
                            client.send(
                                JSON.stringify({
                                    type: 'exit',
                                    exit_code: code,
                                    message: status.message
                                })
                            )
                    } catch {}
                    cleanup(1000, 'exit')
                }
            )
        } catch (err) {
            const message = (err as Error).message
            this.log.warn(`k8s.terminal.exec_failed ${message}`)
            try {
                client.send(JSON.stringify({ type: 'error', message }))
            } catch {}
            cleanup(1011, 'exec failed')
            return
        }

        this.log.debug(
            `k8s.terminal.open ns=${pod.namespace} pod=${pod.podName} container=${pod.containerName}`
        )

        sendResize(upstream, cols, rows)

        client.on('message', (data, isBinary) => {
            if (isBinary) {
                const buf = Buffer.isBuffer(data)
                    ? data
                    : Buffer.from(data as ArrayBuffer)
                if (buf.length === 0) return
                if (buf[0] === 0x00) {
                    stdin.write(buf.subarray(1))
                }
                return
            }
            try {
                const msg = JSON.parse(data.toString()) as {
                    type?: string
                    cols?: number
                    rows?: number
                }
                if (
                    msg.type === 'resize' &&
                    typeof msg.cols === 'number' &&
                    typeof msg.rows === 'number'
                ) {
                    sendResize(upstream, msg.cols, msg.rows)
                }
            } catch {}
        })

        client.on('close', () => cleanup(1000, 'client closed'))
        client.on('error', () => cleanup(1011, 'client error'))
    }
}

const sendResize = (
    ws: import('ws').WebSocket | undefined,
    cols: number,
    rows: number
): void => {
    if (!ws || ws.readyState !== ws.OPEN) return
    try {
        const payload = JSON.stringify({ Width: cols, Height: rows })
        const frame = Buffer.concat([
            Buffer.of(4),
            Buffer.from(payload, 'utf8')
        ])
        ws.send(frame, { binary: true })
    } catch {}
}

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

export const buildK8sTerminalCommand = (cwd: string): string[] => [
    'sh',
    '-c',
    `export TERM=xterm-256color LANG=C.UTF-8 COLORTERM=truecolor && cd ${shellQuote(cwd)} && (command -v bash >/dev/null && exec bash -il || exec sh -i)`
]
