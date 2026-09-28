import { isRuntimeUsable, type AgentContextDocStatus } from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException
} from '@nestjs/common'
import { type Agent, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { runDaemonBash, daemonConfigRead, daemonConfigWrite } from '@/modules/daemon/daemon-fs'
import { DaemonConfigDeliveryService, DaemonConfigDeliveryError, readDaemonConfigSnapshot, type DaemonConfigSnapshot, type DaemonConfigDeliveryOptions } from '@/modules/daemon/daemon-config-delivery.service'
import { toAgentConnectionInfo } from '@/modules/connections/connections.service'
import { posix } from 'node:path'
import {
    AgentContextDocService,
    MANYFOLD_CONTEXT_VERSION,
    contextDocInstructionFile,
    buildPlatformContextDoc,
    buildReferenceBlock,
    MANYFOLD_CONTEXT_START,
    MANYFOLD_CONTEXT_END
} from '@/modules/agent-self/agent-context-doc.service'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'
import {
    HostDaemonAccess,
    HostDaemonOfflineError
} from '@/modules/agents/adapters/host-daemon-access'

type AgentContext = RuntimeContext & { agent: Agent }

// What AgentContextDocService.write recorded into agents.extras on its last
// successful install — the DB is the source of truth for the status card so it
// works without waking a cold sprite.
const readRecord = (
    agent: Agent
): { version: number | null; generatedAt: string | null } => {
    const cd = (
        agent.extras as {
            contextDoc?: { version?: number; generatedAt?: string }
        } | null
    )?.contextDoc
    return {
        version: typeof cd?.version === 'number' ? cd.version : null,
        generatedAt: typeof cd?.generatedAt === 'string' ? cd.generatedAt : null
    }
}

// Read/install/refresh an agent's AGENTS.manyfold.md. Status is DB-backed
// (cold-safe); install/on-change writes to the machine through its daemon,
// whatever provisioned it (ADR-0037 R6).
@Injectable()
export class AgentContextDocManageService {
    private readonly log = new Logger(AgentContextDocManageService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimeContext: RuntimeContextService,
        private readonly contextDoc: AgentContextDocService,
        private readonly daemonRegistry: DaemonRegistryService,
        private readonly delivery: DaemonConfigDeliveryService,
        // Appended last + @Optional so positional test construction keeps
        // working; absent, a refresh never wakes a sleeping sandbox.
        @Optional() private readonly hostAccess?: HostDaemonAccess
    ) {}

    async getStatus(
        userId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentContextDocStatus> {
        const ctx = await this.requireAgent(userId, agentId, isAdmin)
        const { agent } = ctx
        if (!this.isSupported(ctx))
            return {
                supported: false,
                installed: false,
                version: null,
                generatedAt: null,
                currentVersion: MANYFOLD_CONTEXT_VERSION,
                upToDate: false,
                agentRunning: false
            }
        const { version, generatedAt } = readRecord(agent)
        const installed = version !== null
        return {
            supported: true,
            installed,
            version,
            generatedAt,
            currentVersion: MANYFOLD_CONTEXT_VERSION,
            upToDate: installed && version === MANYFOLD_CONTEXT_VERSION && this.delivered(await readDaemonConfigSnapshot(this.db, agent.id)),
            agentRunning: isRuntimeUsable(ctx.availability)
        }
    }

    async refresh(
        userId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentContextDocStatus> {
        const ctx = await this.requireAgent(userId, agentId, isAdmin)
        if (!this.isSupported(ctx))
            throw new BadRequestException(
                'the context doc is only available for coding-framework agents on a machine'
            )
        // Writing needs a reachable machine: an installed runtime on a ready
        // host. The user asked for this write, so a hosted machine that has
        // gone to sleep is woken for it and held until the doc is delivered
        // (the automatic pushes below never wake one); a local machine must
        // have its daemon connected.
        if (!isRuntimeUsable(ctx.availability))
            throw new BadRequestException(
                'start the agent before installing its context doc'
            )
        const { host } = ctx
        if (host?.kind === 'hosted' && this.hostAccess)
            await this.hostAccess
                .withHost(
                    {
                        host,
                        daemon: ctx.daemon,
                        placement: ctx.placement,
                        agentId: ctx.agent.id,
                        reason: 'context-doc'
                    },
                    () => this.refreshDaemon(ctx.agent)
                )
                .catch((err: unknown) => {
                    if (!(err instanceof HostDaemonOfflineError)) throw err
                    throw new ServiceUnavailableException({
                        code: 'SANDBOX_DAEMON_OFFLINE',
                        message: `${host.name} is not reachable (${err.reason})`,
                        hostId: host.id
                    })
                })
        else await this.refreshDaemon(ctx.agent)
        return this.getStatus(userId, agentId, isAdmin)
    }

    // Best-effort push for an agent whose doc may be missing or stale — after
    // a connection change, or for an agent just added to a running sandbox
    // (the caller already authorized the agent). Only writes for a usable
    // agent; never throws.
    async refreshOnChange(agent: Agent): Promise<void> {
        try {
            const ctx = await this.runtimeContext.forAgent(agent.id)
            if (!ctx?.agent) return
            const current = ctx as AgentContext
            if (!this.isSupported(current) || !isRuntimeUsable(ctx.availability))
                return
            await this.refreshDaemon(agent)
        } catch (err) {
            if (err instanceof DaemonConfigDeliveryError) {
                this.log.warn('daemon configuration context refresh deferred')
                return
            }
            this.log.warn(
                `context doc on-change refresh failed for ${agent.id}: ${(err as Error).message}`
            )
        }
    }

    private isSupported(ctx: AgentContext): boolean {
        return (
            ctx.placement !== 'external' &&
            contextDocInstructionFile(ctx.agent.framework) !== undefined
        )
    }

    delivered(snapshot: DaemonConfigSnapshot): boolean {
        const record = snapshot.agent.extras.contextDoc as
            { version?: number; revision?: string } | undefined
        const delivery = snapshot.agent.extras.contextDocDelivery as
            { status?: string } | undefined
        return (
            record?.version === MANYFOLD_CONTEXT_VERSION &&
            record.revision ===
                snapshot.revision('context', MANYFOLD_CONTEXT_VERSION) &&
            (!delivery || delivery.status === 'delivered')
        )
    }

    async refreshDaemon(
        agent: Agent,
        options: DaemonConfigDeliveryOptions = {}
    ): Promise<void> {
        if (contextDocInstructionFile(agent.framework) === undefined) return
        await this.delivery.deliver(
            agent,
            async (snapshot, attempt) => {
                if (options.automatic && this.delivered(snapshot)) return
                const current = snapshot.agent
                const daemonId = snapshot.host.id
                const workspacePath = current.workspacePath ?? current.mountPath
                const instruction = contextDocInstructionFile(current.framework)
                if (!workspacePath || !instruction)
                    throw new DaemonConfigDeliveryError('unsupported')
                const revision = snapshot.revision(
                    'context',
                    MANYFOLD_CONTEXT_VERSION
                )
                const generatedAt = new Date().toISOString()
                const connections = snapshot.connections
                    .filter(
                        (row) =>
                            !row.revokedAt &&
                            current.extras[`${row.provider}ConnectionId`] ===
                                row.id
                    )
                    .map(toAgentConnectionInfo)
                let delivered = false
                let message =
                    'Configuration delivery failed; reconnect or retry the push.'
                if (options.automatic && !attempt.protectedWrites)
                    message =
                        'Upgrade the daemon CLI for automatic configuration delivery.'
                else if (attempt.protectedWrites) {
                    try {
                        const docPath = posix.join(
                            workspacePath,
                            'AGENTS.manyfold.md'
                        )
                        const previousDoc = await daemonConfigRead(
                            this.daemonRegistry,
                            daemonId,
                            docPath,
                            attempt
                        )
                        const doc = buildPlatformContextDoc({
                            agentId: current.id,
                            connections,
                            generatedAt
                        })
                        await daemonConfigWrite(
                            this.daemonRegistry,
                            daemonId,
                            docPath,
                            doc,
                            previousDoc,
                            revision,
                            attempt
                        )
                        const instructionPath = posix.join(
                            workspacePath,
                            instruction
                        )
                        const previous = await daemonConfigRead(
                            this.daemonRegistry,
                            daemonId,
                            instructionPath,
                            attempt
                        )
                        await daemonConfigWrite(
                            this.daemonRegistry,
                            daemonId,
                            instructionPath,
                            mergeContextReference(
                                previous ?? '',
                                buildReferenceBlock(current.framework)
                            ),
                            previous,
                            revision,
                            attempt
                        )
                        delivered = true
                    } catch {
                        this.log.warn(
                            'daemon configuration context write failed'
                        )
                    }
                } else
                    delivered = await this.contextDoc.write({
                        agentId: current.id,
                        framework: current.framework,
                        workspacePath,
                        connections,
                        generatedAt,
                        record: false,
                        safeErrors: true,
                        targetLabel: 'daemon configuration',
                        run: (script, timeoutMs) =>
                            runDaemonBash(
                                this.daemonRegistry,
                                daemonId,
                                script,
                                timeoutMs,
                                attempt
                            )
                    })
                const published = await attempt.publish(
                    snapshot,
                    'context',
                    {
                        ...(delivered
                            ? {
                                  contextDoc: {
                                      version: MANYFOLD_CONTEXT_VERSION,
                                      generatedAt,
                                      revision
                                  }
                              }
                            : {}),
                        contextDocDelivery: {
                            status: delivered ? 'delivered' : 'failed',
                            ...(delivered ? {} : { message }),
                            at: generatedAt
                        }
                    },
                    MANYFOLD_CONTEXT_VERSION
                )
                if (!published) throw new DaemonConfigDeliveryError('changed')
                if (!delivered)
                    throw new DaemonConfigDeliveryError(
                        options.automatic && !attempt.protectedWrites
                            ? 'unsupported'
                            : 'failed'
                    )
            },
            options
        )
    }

    private async requireAgent(
        userId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentContext> {
        const ctx = await this.runtimeContext.forAgent(agentId)
        if (!ctx?.agent || (ctx.agent.userId !== userId && !isAdmin))
            throw new NotFoundException(`agent ${agentId} not found`)
        return ctx as AgentContext
    }
}

export const mergeContextReference = (current: string, block: string): string => {
    const start = current.indexOf(MANYFOLD_CONTEXT_START)
    const end = current.indexOf(MANYFOLD_CONTEXT_END)
    if (start < 0 && end < 0) return `${current}${current.endsWith('\n') || !current ? '' : '\n'}\n${block}\n`
    if (start < 0 || end < start || current.indexOf(MANYFOLD_CONTEXT_START, start + MANYFOLD_CONTEXT_START.length) >= 0) throw new DaemonConfigDeliveryError('failed')
    return current.slice(0, start) + block + current.slice(end + MANYFOLD_CONTEXT_END.length)
}
