import { Injectable, Logger } from '@nestjs/common'
import type { AgentRuntimeRow } from '@manyfold/db'
import {
    createClient as createSpritesClient,
    execSprite,
    shellSingleQuote,
    type ExecOptions,
    type ExecResult,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { PodExec, PodExecFactory } from '@/modules/k8s/pod-exec'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { resolveAgentPod } from './k8s-pod-resolver'

export interface FrameworkExecRunRequest {
    cmd: string[]
    env?: Record<string, string>
    stdin?: string
    timeoutMs: number
    dir?: string
}

export interface FrameworkExecRunResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface FrameworkExec {
    run(req: FrameworkExecRunRequest): Promise<FrameworkExecRunResult>
}

export class K8sFrameworkExec implements FrameworkExec {
    constructor(private readonly pod: PodExec) {}

    async run(req: FrameworkExecRunRequest): Promise<FrameworkExecRunResult> {
        return this.pod.run({
            cmd: req.cmd,
            stdin: req.stdin,
            timeoutMs: req.timeoutMs
        })
    }
}

export class DaemonFrameworkExec implements FrameworkExec {
    constructor(
        private readonly registry: DaemonRegistryService,
        private readonly daemonId: string
    ) {}

    async run(req: FrameworkExecRunRequest): Promise<FrameworkExecRunResult> {
        const stdoutChunks: string[] = []
        const stderrChunks: string[] = []
        const payload: Record<string, unknown> = {
            cmd: req.cmd,
            timeoutMs: req.timeoutMs
        }
        if (req.env) payload.env = req.env
        if (req.stdin !== undefined) payload.stdin = req.stdin
        if (req.dir) payload.dir = req.dir
        const stream = this.registry.streamRpc({
            daemonId: this.daemonId,
            method: 'exec.start',
            payload,
            timeoutMs: req.timeoutMs + 5_000,
            onEvent: (kind, data) => {
                if (kind === 'stdout') stdoutChunks.push(data)
                else if (kind === 'stderr') stderrChunks.push(data)
            }
        })
        const ack = await stream.result
        const exitCode =
            typeof ack?.exitCode === 'number' ? ack.exitCode : -1
        return {
            exitCode,
            stdout: stdoutChunks.join(''),
            stderr: stderrChunks.join('')
        }
    }
}

export type SpriteExecFn = (
    client: SpritesClient,
    spriteName: string,
    opts: ExecOptions,
    logger?: SpritesLogger
) => Promise<ExecResult>

export class SpritesFrameworkExec implements FrameworkExec {
    constructor(
        private readonly client: SpritesClient,
        private readonly spriteName: string,
        private readonly exec: SpriteExecFn,
        private readonly logger?: SpritesLogger
    ) {}

    async run(req: FrameworkExecRunRequest): Promise<FrameworkExecRunResult> {
        // Framework CLIs live on login-shell-only PATH entries (~/.local/bin,
        // venvs), so argv goes through `bash -lc` like every other sprite exec.
        const line = req.cmd.map(shellSingleQuote).join(' ')
        const res = await this.exec(
            this.client,
            this.spriteName,
            {
                cmd: ['bash', '-lc', line],
                ...(req.env ? { env: req.env } : {}),
                ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
                ...(req.dir ? { dir: req.dir } : {}),
                timeoutMs: req.timeoutMs
            },
            this.logger
        )
        return {
            exitCode: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr
        }
    }
}

@Injectable()
export class FrameworkExecResolver {
    constructor(
        private readonly k8s: KubernetesService,
        private readonly podExecFactory: PodExecFactory,
        private readonly registry: DaemonRegistryService,
        private readonly spritesAccounts: SpritesAccountsService
    ) {}

    async forRuntime(
        runtime: AgentRuntimeRow,
        primaryAgentId: string | null,
        logger?: Logger
    ): Promise<FrameworkExec> {
        if (runtime.kind === 'daemon') {
            if (!runtime.daemonId)
                throw new Error(
                    `runtime ${runtime.id} has kind=daemon but no daemonId`
                )
            return new DaemonFrameworkExec(this.registry, runtime.daemonId)
        }
        if (runtime.kind === 'k8s') {
            const pod = await resolveAgentPod(
                this.k8s,
                runtime,
                primaryAgentId
            )
            const podExec = this.podExecFactory.forClient(
                pod.client,
                pod.namespace,
                pod.podName,
                pod.containerName
            )
            return new K8sFrameworkExec(podExec)
        }
        if (runtime.kind === 'sprites') {
            if (!runtime.spriteName)
                throw new Error(
                    `runtime ${runtime.id} has kind=sprites but no spriteName`
                )
            if (!runtime.accountId)
                throw new Error(
                    `runtime ${runtime.id} has kind=sprites but no accountId`
                )
            const account = await this.spritesAccounts.getById(
                runtime.accountId
            )
            if (!account)
                throw new Error(
                    `sprites account ${runtime.accountId} not found for runtime ${runtime.id}`
                )
            const spritesLogger = spritesLoggerFor(logger)
            const client = createSpritesClient({
                token: this.spritesAccounts.decryptToken(account),
                accountSlug: account.slug,
                logger: spritesLogger
            })
            return new SpritesFrameworkExec(
                client,
                runtime.spriteName,
                this.execSprite.bind(this),
                spritesLogger
            )
        }
        throw new Error(
            `runtime ${runtime.id} has kind=${runtime.kind}; framework exec only supports k8s, daemon or sprites`
        )
    }

    protected execSprite(
        client: SpritesClient,
        spriteName: string,
        opts: ExecOptions,
        logger?: SpritesLogger
    ): Promise<ExecResult> {
        return execSprite(client, spriteName, opts, logger)
    }
}

const spritesLoggerFor = (log?: Logger): SpritesLogger | undefined =>
    log
        ? {
              debug: () => {},
              info: (m, meta) =>
                  log.log(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
              warn: (m, meta) =>
                  log.warn(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
              error: (m, meta) =>
                  log.error(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`)
          }
        : undefined
