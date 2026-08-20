import type {
    AgentProbeStatus,
    AgentStorageUsageItem,
    AgentStorageUsageResponse
} from '@manyfold/shared'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { Agent, AgentRuntimeRow, FileRoot } from '@manyfold/db'
import {
    createClient as createSpritesClient,
    execSprite,
    type ExecResult,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { AgentsService } from '@/modules/agents/agents.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'
import { resolveAgentPod } from '@/modules/agents/adapters/k8s-pod-resolver'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { HERMES_PORT } from '@/modules/agents/bootstrap/hermes-shared'
import { OPENCLAW_PORT } from '@/modules/agents/bootstrap/openclaw-shared'
import { NARRANEXUS_PORT } from '@/modules/agents/bootstrap/narranexus-k8s'

const DU_MISSING = '__NCA_MISSING__'
const DEFAULT_TIMEOUT_MS = 12_000

const SLEEPING_SPRITE_SKIP = {
    status: 'skipped' as AgentProbeStatus,
    message: 'Sprite is asleep; exec-based check skipped to avoid waking it.'
}

interface CommandResult {
    exitCode: number
    stdout: string
    stderr: string
}

export const redactDiagnosticText = (value: string): string =>
    value
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED_JWT]')
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
        .replace(
            /\b(OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|API_SERVER_KEY|OPENCLAW_GATEWAY_TOKEN)=\S+/gi,
            '$1=[REDACTED]'
        )
        .slice(0, 512)

export const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

export const parseDuKilobytes = (stdout: string): number | null => {
    if (stdout.includes(DU_MISSING)) return null
    const match = stdout.trim().match(/^(\d+)\s+/)
    if (!match) throw new Error(`unexpected du output: ${stdout.slice(0, 120)}`)
    return Number(match[1])
}

export const duKilobytesToBytes = (value: number | null): number =>
    value === null ? 0 : value * 1024

export const nestedConfigBytes = (
    configBytes: number,
    workspaceBytes: number,
    configPath: string | null,
    workspacePath: string | null
): number => {
    if (!configPath || !workspacePath) return configBytes
    const normalizedConfig = trimTrailingSlash(configPath)
    const normalizedWorkspace = trimTrailingSlash(workspacePath)
    if (
        normalizedWorkspace === normalizedConfig ||
        normalizedWorkspace.startsWith(`${normalizedConfig}/`)
    )
        return Math.max(0, configBytes - workspaceBytes)
    return configBytes
}

@Injectable()
export class AgentDiagnosticsService {
    private readonly log = new Logger(AgentDiagnosticsService.name)

    constructor(
        private readonly agents: AgentsService,
        private readonly runtimes: AgentRuntimesService,
        private readonly accounts: SpritesAccountsService,
        private readonly k8s: KubernetesService,
        private readonly podExecFactory: PodExecFactory,
        private readonly daemonRegistry: DaemonRegistryService
    ) {}

    async storageUsage(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentStorageUsageResponse> {
        const agent = await this.requireAgent(callerUserId, agentId, isAdmin)
        const checkedAt = new Date().toISOString()
        const targets = this.storageTargets(agent)
        // du is an exec: skip it instead of waking/billing a sleeping
        // service sprite (same rule as the exec-based health checks).
        if (await this.serviceSpriteAsleep(agent)) {
            const items = [
                asleepStorageItem(targets.workspace),
                targets.config
                    ? asleepStorageItem(targets.config)
                    : skippedStorageItem('config', 'Agent config/state', null)
            ]
            return { agentId: agent.id, checkedAt, items, totalBytes: 0 }
        }
        const workspace = await this.duItem(agent, targets.workspace)
        const config = targets.config
            ? await this.duItem(agent, targets.config)
            : skippedStorageItem('config', 'Agent config/state', null)
        const configBytes = nestedConfigBytes(
            config.bytes,
            workspace.bytes,
            config.path,
            workspace.path
        )
        const configItem =
            configBytes === config.bytes
                ? config
                : {
                      ...config,
                      bytes: configBytes,
                      message:
                          config.status === 'ok'
                              ? 'Measured config/state usage excluding nested workspace usage.'
                              : config.message
                  }
        const items = [workspace, configItem]
        return {
            agentId: agent.id,
            checkedAt,
            items,
            totalBytes: items.reduce((sum, item) => sum + item.bytes, 0)
        }
    }

    private async requireAgent(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<Agent> {
        const agent = await this.agents.findForCaller(
            agentId,
            callerUserId,
            isAdmin
        )
        if (!agent) throw new NotFoundException(`agent ${agentId} not found`)
        return agent
    }

    // True only for a service-framework sprite that exists but is not
    // running (warm/cold). not_found and control-plane errors return false
    // so the exec-based checks keep failing loudly as before — getSprite is
    // a control-plane read and never wakes the VM.
    private async serviceSpriteAsleep(agent: Agent): Promise<boolean> {
        try {
            const runtime = await this.runtimeFor(agent)
            if (runtime.kind !== 'sprites') return false
            if (!serviceHealthUrlFor(runtime.framework)) return false
            const client = await this.spriteClientFor(agent, runtime)
            const sprite = await client.getSprite(
                this.spriteNameFor(agent, runtime)
            )
            return sprite.status !== 'running'
        } catch {
            return false
        }
    }

    private storageTargets(agent: Agent): {
        workspace: Omit<
            AgentStorageUsageItem,
            'exists' | 'bytes' | 'status' | 'message'
        >
        config: Omit<
            AgentStorageUsageItem,
            'exists' | 'bytes' | 'status' | 'message'
        > | null
    } {
        const roots = rootsFor(agent)
        const workspaceRoot = roots.find((root) => root.id === 'workspace')
        const workspacePath = agent.workspacePath || workspaceRoot?.path || null
        const configRoot = roots.find((root) => root.id !== 'workspace')
        const configPath =
            configRoot?.path ??
            (agent.framework === 'openclaw' || agent.framework === 'hermes'
                ? agent.mountPath
                : null)
        return {
            workspace: {
                kind: 'workspace',
                label: 'Workspace',
                path: workspacePath
            },
            config: configPath
                ? {
                      kind: 'config',
                      label: configRoot?.label ?? 'Agent config/state',
                      path: configPath
                  }
                : null
        }
    }

    private async duItem(
        agent: Agent,
        target: Omit<
            AgentStorageUsageItem,
            'exists' | 'bytes' | 'status' | 'message'
        >
    ): Promise<AgentStorageUsageItem> {
        if (!target.path)
            return skippedStorageItem(target.kind, target.label, null)
        let result: CommandResult
        try {
            result = await this.runCommand(agent, {
                cmd: [
                    'bash',
                    '-lc',
                    `if [ -e ${shellQuote(target.path)} ]; then du -sk ${shellQuote(
                        target.path
                    )}; else echo ${DU_MISSING}; fi`
                ],
                timeoutMs: DEFAULT_TIMEOUT_MS
            })
        } catch (err) {
            return {
                ...target,
                exists: false,
                bytes: 0,
                status: 'failed',
                message: `Usage check unavailable: ${redactDiagnosticText(
                    (err as Error).message
                )}`
            }
        }
        if (result.exitCode !== 0)
            return {
                ...target,
                exists: false,
                bytes: 0,
                status: 'failed',
                message: `Usage check failed: ${redactDiagnosticText(
                    result.stderr || result.stdout || `exit ${result.exitCode}`
                )}`
            }
        let kib: number | null
        try {
            kib = parseDuKilobytes(result.stdout)
        } catch (err) {
            return {
                ...target,
                exists: false,
                bytes: 0,
                status: 'failed',
                message: `Usage check failed: ${redactDiagnosticText(
                    (err as Error).message
                )}`
            }
        }
        if (kib === null)
            return {
                ...target,
                exists: false,
                bytes: 0,
                status: 'warning',
                message: 'Directory does not exist.'
            }
        return {
            ...target,
            exists: true,
            bytes: duKilobytesToBytes(kib),
            status: 'ok',
            message: 'Usage measured.'
        }
    }

    private async runCommand(
        agent: Agent,
        input: { cmd: string[]; timeoutMs: number }
    ): Promise<CommandResult> {
        const runtime = await this.runtimeFor(agent)
        if (runtime.kind === 'sprites') {
            const client = await this.spriteClientFor(agent, runtime)
            const spriteName = this.spriteNameFor(agent, runtime)
            const result = await execSprite(
                client,
                spriteName,
                {
                    cmd: input.cmd,
                    stdin: '',
                    timeoutMs: input.timeoutMs
                },
                spritesLoggerFor(this.log)
            )
            return toCommandResult(result)
        }

        if (runtime.kind === 'daemon')
            return this.runDaemonCommand(agent, runtime, input)

        const pod = await resolveAgentPod(
            this.k8s,
            runtime,
            runtime.primaryAgentId ?? agent.id
        )
        const exec = this.podExecFactory.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
        return exec.run({ cmd: input.cmd, timeoutMs: input.timeoutMs })
    }

    private async runDaemonCommand(
        agent: Agent,
        runtime: AgentRuntimeRow,
        input: { cmd: string[]; timeoutMs: number }
    ): Promise<CommandResult> {
        const daemonId = this.daemonIdFor(agent, runtime)
        if (!daemonId)
            throw new Error(
                `daemon agent ${agent.id} runtime ${runtime.id} missing daemonId`
            )
        const stdoutChunks: string[] = []
        const stderrChunks: string[] = []
        const stream = this.daemonRegistry.streamRpc({
            daemonId,
            method: 'exec.start',
            payload: {
                cmd: input.cmd,
                env: {},
                timeoutMs: input.timeoutMs
            },
            timeoutMs: input.timeoutMs + 5_000,
            onEvent: (kind, data) => {
                if (kind === 'stdout') stdoutChunks.push(data)
                else if (kind === 'stderr') stderrChunks.push(data)
            }
        })
        const payload = await stream.result
        return {
            exitCode: Number(
                (payload as { exitCode?: number } | undefined)?.exitCode ?? 0
            ),
            stdout: stdoutChunks.join(''),
            stderr: stderrChunks.join('')
        }
    }

    private async spriteClientFor(
        agent: Agent,
        runtime?: AgentRuntimeRow
    ): Promise<SpritesClient> {
        const accountId = agent.accountId ?? runtime?.accountId
        if (!accountId)
            throw new Error(`sprites agent ${agent.id} missing accountId`)
        const account = await this.accounts.getById(accountId)
        if (!account) throw new Error(`sprites account ${accountId} not found`)
        return createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug,
            logger: spritesLoggerFor(this.log)
        })
    }

    private spriteNameFor(agent: Agent, runtime: AgentRuntimeRow): string {
        const spriteName = agent.spriteName ?? runtime.spriteName
        if (!spriteName)
            throw new Error(
                `sprites agent ${agent.id} runtime ${runtime.id} missing spriteName`
            )
        return spriteName
    }

    private daemonIdFor(agent: Agent, runtime: AgentRuntimeRow): string | null {
        return agent.daemonId ?? runtime.daemonId ?? null
    }

    private async runtimeFor(agent: Agent): Promise<AgentRuntimeRow> {
        if (!agent.runtimeId)
            throw new Error(`agent ${agent.id} has no linked runtime`)
        const runtime = await this.runtimes.findById(agent.runtimeId)
        if (!runtime) throw new Error(`runtime ${agent.runtimeId} not found`)
        return runtime
    }
}

const rootsFor = (agent: Agent): FileRoot[] =>
    Array.isArray(agent.fileRoots) ? agent.fileRoots : []

const skippedStorageItem = (
    kind: AgentStorageUsageItem['kind'],
    label: string,
    path: string | null
): AgentStorageUsageItem => ({
    kind,
    label,
    path,
    exists: false,
    bytes: 0,
    status: 'skipped',
    message: 'No directory configured.'
})

const asleepStorageItem = (
    target: Omit<AgentStorageUsageItem, 'exists' | 'bytes' | 'status' | 'message'>
): AgentStorageUsageItem => ({
    ...target,
    exists: false,
    bytes: 0,
    status: 'skipped',
    message: SLEEPING_SPRITE_SKIP.message
})

// The k8s deployments' readiness probes hit these same paths unauthenticated
// in production (hermes /v1/health, openclaw /healthz, narranexus /healthz) —
// the live diagnostics probe reuses that verified contract. Non-service
// frameworks return null and keep the plain sprite check.
const serviceHealthUrlFor = (framework: string): string | null => {
    switch (framework) {
        case 'hermes':
            return `http://127.0.0.1:${HERMES_PORT}/v1/health`
        case 'openclaw':
            return `http://127.0.0.1:${OPENCLAW_PORT}/healthz`
        case 'narranexus':
            return `http://127.0.0.1:${NARRANEXUS_PORT}/healthz`
        default:
            return null
    }
}

const toCommandResult = (result: ExecResult): CommandResult => ({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr
})

const spritesLoggerFor = (log: Logger): SpritesLogger => ({
    debug: () => {},
    info: (m, meta) => log.log(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    warn: (m, meta) => log.warn(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    error: (m, meta) =>
        log.error(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`)
})

const trimTrailingSlash = (value: string): string =>
    value === '/' ? value : value.replace(/\/+$/, '')
