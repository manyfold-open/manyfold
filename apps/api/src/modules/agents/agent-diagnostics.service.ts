import type {
    AgentProbeStatus,
    AgentStorageUsageItem,
    AgentStorageUsageResponse
} from '@manyfold/shared'
import {
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import type { Agent, FileRoot, RuntimeHostRow } from '@manyfold/db'
import { AgentsService } from '@/modules/agents/agents.service'
import { FrameworkExecResolver } from '@/modules/agents/adapters/framework-exec'
import { spritesRef } from '@/modules/agent-runtimes/host-ref'
import type { RuntimeContext } from '@/modules/hosts/runtime-context.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { HostStorageService } from './host-storage/host-storage.service'
import { MEASUREMENT_FORMAT_VERSION } from './host-storage/measurement-observation'
import {
    frameworkHome,
    workspacePathFor
} from './host-storage/agent-storage-paths'
import { resolvedStoragePath } from './host-storage/storage-attribution'

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

type AgentContext = RuntimeContext & { agent: Agent }

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
): number | null => {
    if (!configPath || !workspacePath) return configBytes
    const normalizedConfig = resolvedStoragePath(configPath, null)
    const normalizedWorkspace = resolvedStoragePath(workspacePath, null)
    if (!normalizedConfig || !normalizedWorkspace) return null
    if (normalizedWorkspace === normalizedConfig)
        return workspaceBytes === configBytes ? 0 : null
    if (normalizedConfig.startsWith(`${normalizedWorkspace}/`))
        return configBytes <= workspaceBytes ? 0 : null
    if (
        normalizedWorkspace.startsWith(`${normalizedConfig}/`)
    )
        return workspaceBytes <= configBytes ? configBytes - workspaceBytes : null
    return configBytes
}

@Injectable()
export class AgentDiagnosticsService {
    private readonly log = new Logger(AgentDiagnosticsService.name)

    constructor(
        private readonly agents: AgentsService,
        private readonly execResolver: FrameworkExecResolver,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly spriteStorage: HostStorageService
    ) {}

    // Measures, then reports. A sandbox's paths are measured with the rest of
    // the sandbox, waking it if it sleeps, and only after the wake is admitted
    // like every other one (the quota and the running write happen there).
    // Any other machine is measured by the report itself.
    async refreshStorageUsage(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentStorageUsageResponse> {
        const ctx = await this.requireAgent(callerUserId, agentId, isAdmin)
        const sandbox = sandboxOf(ctx)
        if (sandbox) {
            await this.runtimeAccess.reserveActiveSlot({
                userId: ctx.agent.userId,
                hostId: sandbox.id
            })
            if (!(await this.spriteStorage.measureHostNow(sandbox.id)))
                throw new ServiceUnavailableException(
                    'The sandbox could not be measured; the last reading is kept.'
                )
        }
        return this.storageUsage(callerUserId, agentId, isAdmin)
    }

    async storageUsage(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentStorageUsageResponse> {
        const ctx = await this.requireAgent(callerUserId, agentId, isAdmin)
        const { agent } = ctx
        const checkedAt = new Date().toISOString()
        const targets = this.storageTargets(agent)
        const cachedHost =
            ctx.host?.kind === 'hosted' && ctx.host.userId === agent.userId
                ? ctx.host
                : null
        // The power state is the provider's observation; a sleeping machine
        // is never woken for a measurement. A local machine measures only
        // while its daemon is there to run the command.
        const presence: 'running' | 'asleep' | 'unavailable' = cachedHost
            ? cachedHost.powerState === 'running'
                ? 'running'
                : cachedHost.powerState === 'suspended' ||
                    cachedHost.powerState === 'stopped'
                  ? 'asleep'
                  : 'unavailable'
            : ctx.host && ctx.daemonOnline
              ? 'running'
              : 'unavailable'
        const asleep = presence === 'asleep'
        const cachedSandbox: AgentStorageUsageResponse['cachedSandbox'] = cachedHost ? {
            scope: 'sandbox', unit: 'bytes', hostId: cachedHost.id,
            storageBytes: cachedHost.storageBytes,
            storageMeasuredAt: cachedHost.storageMeasuredAt?.toISOString() ?? null,
            storageFreshness: !cachedHost.storageMeasuredAt || !cachedHost.storageBreakdown ? 'unknown' : presence !== 'running' || Date.now() - cachedHost.storageMeasuredAt.getTime() >= 5 * 60 * 1000 ? 'stale' : 'fresh',
            asleep
        } : null
        const scope = { scope: 'agent-paths' as const, unit: 'bytes' as const, asleep, cachedSandbox }
        // A sandbox's paths are measured with the sandbox, and that reading
        // stays on the agent: reporting it never execs, asleep or awake.
        if (sandboxOf(ctx)) {
            const { items, measuredAt } = sandboxPathItems(agent)
            return { ...scope, agentId: agent.id, checkedAt, measuredAt, items, totalBytes: totalOf(items) }
        }
        // du is an exec: skip it instead of waking/billing a sleeping
        // sprite, including coding frameworks.
        if (presence !== 'running') {
            const message = asleep ? SLEEPING_SPRITE_SKIP.message : 'Sandbox status is unavailable; measurement skipped without waking it.'
            const items = [
                asleepStorageItem(targets.workspace, message),
                targets.config
                    ? asleepStorageItem(targets.config, message)
                    : skippedStorageItem('config', 'Agent config/state', null)
            ]
            return { ...scope, agentId: agent.id, checkedAt, measuredAt: null, items, totalBytes: null }
        }
        const workspace = await this.duItem(ctx, targets.workspace)
        const config = targets.config
            ? await this.duItem(ctx, targets.config)
            : skippedStorageItem('config', 'Agent config/state', null)
        const configBytes = config.bytes === null || workspace.bytes === null ? config.bytes : nestedConfigBytes(
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
                          configBytes === null
                              ? 'Path measurements changed or overlap inconsistently; attribution is unavailable.'
                              : config.status === 'ok'
                              ? 'Measured config/state usage excluding overlapping workspace usage.'
                              : config.message
                  }
        const items = [workspace, configItem]
        return {
            ...scope,
            agentId: agent.id,
            checkedAt,
            measuredAt: checkedAt,
            items,
            totalBytes: totalOf(items)
        }
    }

    private async requireAgent(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentContext> {
        const ctx = await this.agents.contextForCaller(
            agentId,
            callerUserId,
            isAdmin
        )
        if (!ctx) throw new NotFoundException(`agent ${agentId} not found`)
        return ctx
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
        const serviceConfig = agent.framework === 'openclaw' || agent.framework === 'hermes'
        const configPath = serviceConfig ? agent.mountPath : configRoot?.path ?? null
        return {
            workspace: {
                kind: 'workspace',
                label: 'Workspace',
                path: workspacePath
            },
            config: configPath
                ? {
                      kind: 'config',
                      label: serviceConfig ? 'Agent config/state' : configRoot?.label ?? 'Agent config/state',
                      path: configPath
                  }
                : null
        }
    }

    private async duItem(
        ctx: AgentContext,
        target: Omit<
            AgentStorageUsageItem,
            'exists' | 'bytes' | 'status' | 'message'
        >
    ): Promise<AgentStorageUsageItem> {
        if (!target.path)
            return skippedStorageItem(target.kind, target.label, null)
        let result: CommandResult
        try {
            result = await this.runCommand(ctx, {
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
                bytes: null,
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
                bytes: null,
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
                bytes: null,
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

    // One command on the agent's machine through its host daemon, whatever
    // provisioned the machine (ADR-0037 R6).
    private async runCommand(
        ctx: AgentContext,
        input: { cmd: string[]; timeoutMs: number }
    ): Promise<CommandResult> {
        const exec = await this.execResolver.forRuntime(ctx.runtime, this.log)
        return exec.run({ cmd: input.cmd, timeoutMs: input.timeoutMs })
    }
}

const rootsFor = (agent: Agent): FileRoot[] =>
    Array.isArray(agent.fileRoots) ? agent.fileRoots : []

// The agent's sandbox when it is a sprite of the agent's own account: the one
// kind of machine whose storage is measured, and kept, per sandbox.
const sandboxOf = (ctx: AgentContext): RuntimeHostRow | null =>
    ctx.host?.kind === 'hosted' &&
    spritesRef(ctx.host) &&
    ctx.host.userId === ctx.agent.userId
        ? ctx.host
        : null

// A sandbox's paths as its last measurement read them. Only a reading in the
// format this build writes counts; anything else is not measured yet.
const sandboxPathItems = (
    agent: Agent
): { items: AgentStorageUsageItem[]; measuredAt: string | null } => {
    const breakdown = agent.storageBreakdown
    const measured =
        !!breakdown &&
        !!agent.storageMeasuredAt &&
        breakdown.formatVersion === MEASUREMENT_FORMAT_VERSION &&
        typeof breakdown.workspaceBytes === 'number'
    const item = (
        target: Omit<AgentStorageUsageItem, 'exists' | 'bytes' | 'status' | 'message'>,
        bytes: number | null | undefined
    ): AgentStorageUsageItem =>
        !measured
            ? { ...target, exists: false, bytes: null, status: 'skipped', message: 'Not measured yet.' }
            : typeof bytes !== 'number'
              ? { ...target, exists: false, bytes: null, status: 'warning', message: 'The last measurement could not read this path.' }
              : { ...target, exists: true, bytes, status: 'ok', message: 'Usage measured.' }
    const home = frameworkHome(agent)
    return {
        measuredAt: measured ? agent.storageMeasuredAt!.toISOString() : null,
        items: [
            item(
                { kind: 'workspace', label: 'Workspace', path: workspacePathFor(agent) },
                breakdown?.workspaceBytes
            ),
            home
                ? item(
                      { kind: 'config', label: home.label ?? 'Agent config/state', path: home.path },
                      breakdown?.homeBytes
                  )
                : skippedStorageItem('config', 'Agent config/state', null)
        ]
    }
}

const totalOf = (items: AgentStorageUsageItem[]): number | null =>
    items.some((item) => item.bytes === null)
        ? null
        : items.reduce((sum, item) => sum + (item.bytes ?? 0), 0)

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
    target: Omit<AgentStorageUsageItem, 'exists' | 'bytes' | 'status' | 'message'>,
    message = SLEEPING_SPRITE_SKIP.message
): AgentStorageUsageItem => ({
    ...target,
    exists: false,
    bytes: null,
    status: 'skipped',
    message
})
