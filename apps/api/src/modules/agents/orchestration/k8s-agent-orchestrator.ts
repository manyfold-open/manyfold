import { auditAction } from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, auditLogs, type Agent, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'

// Removes a non-primary agent from its k8s runtime. Pod hosts and their
// framework runtimes are created by K8sContainerProvisioner (ADR-0035); a
// runtime's primary agent goes with the runtime.
@Injectable()
export class K8sAgentOrchestrator {
    private readonly log = new Logger(K8sAgentOrchestrator.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimes: AgentRuntimesService,
        private readonly adapterRegistry: AgentAdapterRegistry
    ) {}

    async deleteNonPrimary(row: Agent, actorUserId: string): Promise<void> {
        if (!row.runtimeId)
            throw new InternalServerErrorException(
                `agent ${row.id} has no runtimeId`
            )
        const runtime = await this.runtimes.findById(row.runtimeId)
        if (!runtime)
            throw new NotFoundException(
                `runtime ${row.runtimeId} not found for agent ${row.id}`
            )
        const adapter = this.adapterRegistry.get(row.framework)
        await this.audit(
            actorUserId,
            auditAction.AGENT_DELETE_STARTED,
            row.id,
            {
                framework: row.framework,
                runtime: 'k8s',
                nonPrimary: true,
                ownerUserId: row.userId,
                onBehalfOf: actorUserId !== row.userId
            }
        )
        try {
            await adapter.removeAgent({
                runtime,
                agent: row,
                primaryAgentId: runtime.primaryAgentId ?? null
            })
        } catch (err) {
            const reason = sanitizeReason(err)
            await this.audit(
                actorUserId,
                auditAction.AGENT_DELETE_FAILED,
                row.id,
                {
                    framework: row.framework,
                    runtime: 'k8s',
                    reason,
                    ownerUserId: row.userId,
                    onBehalfOf: actorUserId !== row.userId
                }
            )
            throw new InternalServerErrorException({
                message: 'framework removeAgent failed',
                reason
            })
        }
        await this.db.delete(agents).where(eq(agents.id, row.id))
        await this.audit(
            actorUserId,
            auditAction.AGENT_DELETE_SUCCEEDED,
            row.id,
            {
                framework: row.framework,
                runtime: 'k8s',
                nonPrimary: true,
                ownerUserId: row.userId,
                onBehalfOf: actorUserId !== row.userId
            }
        )
    }

    private async audit(
        actorId: string,
        action: string,
        subject: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject,
                meta
            })
        } catch (err) {
            this.log.warn(
                `audit write failed action=${action} err=${(err as Error).message}`
            )
        }
    }
}

const sanitizeReason = (err: unknown): string => {
    const message = (err as Error)?.message ?? 'unknown error'
    return message
        .slice(0, 512)
        .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
        .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED_JWT]')
}
