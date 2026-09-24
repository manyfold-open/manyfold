import type { AgentContextDocStatus } from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { createClient, type SpritesClient } from '@manyfold/sprites'
import { agents, type Agent, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { runDaemonBash, daemonConfigRead, daemonConfigWrite } from '@/modules/daemon/daemon-fs'
import { DaemonConfigDeliveryService, DaemonConfigDeliveryError, readDaemonConfigSnapshot, type DaemonConfigSnapshot, type DaemonConfigDeliveryOptions } from '@/modules/daemon/daemon-config-delivery.service'
import { toAgentConnectionInfo } from '@/modules/connections/connections.service'
import { posix } from 'node:path'
import {
    AgentContextDocService,
    MANYFOLD_CONTEXT_VERSION,
    contextDocInstructionFile,
    spriteContextDocRunner,
    buildPlatformContextDoc,
    buildReferenceBlock,
    MANYFOLD_CONTEXT_START,
    MANYFOLD_CONTEXT_END
} from '@/modules/agent-self/agent-context-doc.service'

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
// (cold-safe); install/on-change writes to the live sprite.
@Injectable()
export class AgentContextDocManageService {
    private readonly log = new Logger(AgentContextDocManageService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly contextDoc: AgentContextDocService,
        private readonly daemonRegistry: DaemonRegistryService,
        private readonly delivery: DaemonConfigDeliveryService
    ) {}

    async getStatus(
        userId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentContextDocStatus> {
        const agent = await this.requireAgent(userId, agentId, isAdmin)
        if (!this.isSupported(agent))
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
            upToDate: installed && version === MANYFOLD_CONTEXT_VERSION && (agent.runtime !== 'daemon' || this.delivered(await readDaemonConfigSnapshot(this.db, agent.id))),
            agentRunning: agent.status === 'running'
        }
    }

    async refresh(
        userId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentContextDocStatus> {
        const agent = await this.requireAgent(userId, agentId, isAdmin)
        if (!this.isSupported(agent))
            throw new BadRequestException(
                'the context doc is only available for coding-framework agents on sandbox or self-owned computer runtimes'
            )
        // Writing needs a live workspace. A running sprite agent whose VM has
        // idled to warm/cold is fine — exec resumes it; a daemon agent's
        // `running` status is presence-derived, so it means the computer is
        // reachable (#781).
        if (agent.status !== 'running')
            throw new BadRequestException(
                'start the agent before installing its context doc'
            )
        await this.writeDoc(agent)
        return this.getStatus(userId, agentId, isAdmin)
    }

    // Best-effort push for an agent whose doc may be missing or stale — after
    // a connection change, or for an agent just added to a running sandbox
    // (the caller already authorized the agent). Only writes for a running
    // agent; never throws.
    async refreshOnChange(agent: Agent): Promise<void> {
        if (!this.isSupported(agent) || agent.status !== 'running') return
        try {
            await this.writeDoc(agent)
        } catch (err) {
            if (agent.runtime === 'daemon') { this.log.warn('daemon configuration context refresh deferred'); return }
            this.log.warn(
                `context doc on-change refresh failed for ${agent.id}: ${(err as Error).message}`
            )
        }
    }

    private isSupported(agent: Agent): boolean {
        return (
            (agent.runtime === 'sprites' || agent.runtime === 'daemon') &&
            contextDocInstructionFile(agent.framework) !== undefined
        )
    }

    private async writeDoc(agent: Agent): Promise<void> {
        if (agent.runtime === 'daemon') {
            await this.refreshDaemon(agent)
            return
        }
        if (!agent.spriteName || !agent.mountPath) return
        await this.contextDoc.write({
            agentId: agent.id,
            framework: agent.framework,
            workspacePath: agent.mountPath,
            run: spriteContextDocRunner(
                await this.spriteClientFor(agent),
                agent.spriteName
            ),
            targetLabel: agent.spriteName
        })
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
        if (!this.isSupported(agent)) return
        await this.delivery.deliver(
            agent,
            async (snapshot, attempt) => {
                if (options.automatic && this.delivered(snapshot)) return
                const current = snapshot.agent
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
                            current.daemonId!,
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
                            current.daemonId!,
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
                            current.daemonId!,
                            instructionPath,
                            attempt
                        )
                        await daemonConfigWrite(
                            this.daemonRegistry,
                            current.daemonId!,
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
                                current.daemonId!,
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
    ): Promise<Agent> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent || (agent.userId !== userId && !isAdmin))
            throw new NotFoundException(`agent ${agentId} not found`)
        return agent
    }

    private async spriteClientFor(agent: Agent): Promise<SpritesClient> {
        if (!agent.accountId)
            throw new BadRequestException('agent has no sprites account')
        const account = await this.accounts.getById(agent.accountId)
        if (!account)
            throw new NotFoundException('sprites account not found for agent')
        return createClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
    }
}

export const mergeContextReference = (current: string, block: string): string => {
    const start = current.indexOf(MANYFOLD_CONTEXT_START)
    const end = current.indexOf(MANYFOLD_CONTEXT_END)
    if (start < 0 && end < 0) return `${current}${current.endsWith('\n') || !current ? '' : '\n'}\n${block}\n`
    if (start < 0 || end < start || current.indexOf(MANYFOLD_CONTEXT_START, start + MANYFOLD_CONTEXT_START.length) >= 0) throw new DaemonConfigDeliveryError('failed')
    return current.slice(0, start) + block + current.slice(end + MANYFOLD_CONTEXT_END.length)
}
