import { auditAction } from '@manyfold/shared'
import type { AgentRuntimeSummary } from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { PatchStrategy, setHeaderOptions } from '@kubernetes/client-node'
import { auditLogs, type AgentRuntimeRow, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { resourceName } from '@/modules/agents/orchestration/k8s-resource-builder'

@Injectable()
export class K8sRuntimeSidecarService {
    private readonly log = new Logger(K8sRuntimeSidecarService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly k8s: KubernetesService,
        private readonly runtimes: AgentRuntimesService
    ) {}

    async setControlUi(
        callerUserId: string,
        runtimeId: string,
        enabled: boolean,
        isAdmin: boolean
    ): Promise<AgentRuntimeSummary> {
        const runtime = await this.loadRuntime(runtimeId, callerUserId, isAdmin)
        if (runtime.framework !== 'openclaw')
            throw new BadRequestException(
                'control UI toggle only supported for openclaw runtimes'
            )
        this.requireK8s(runtime)
        if (runtime.controlUiEnabled === enabled)
            return this.runtimes.toSummary(runtime)

        const primaryAgentId = this.requirePrimaryAgentId(runtime)
        const name = resourceName(primaryAgentId)
        const envSecretName = `${name}-env`
        const restartedAt = new Date().toISOString()
        const client = await this.k8s.getClient(runtime.clusterId)
        const apis = client.apis

        try {
            await apis.core.patchNamespacedSecret(
                {
                    name: envSecretName,
                    namespace: runtime.namespace!,
                    body: {
                        stringData: {
                            OPENCLAW_CONTROL_UI_ENABLED: enabled
                                ? 'true'
                                : 'false'
                        }
                    }
                },
                setHeaderOptions(
                    'Content-Type',
                    PatchStrategy.StrategicMergePatch
                )
            )
            await apis.apps.patchNamespacedDeployment(
                {
                    name,
                    namespace: runtime.namespace!,
                    body: {
                        spec: {
                            template: {
                                metadata: {
                                    annotations: {
                                        'nca.netmind.ai/restartedAt':
                                            restartedAt
                                    }
                                }
                            }
                        }
                    }
                },
                setHeaderOptions(
                    'Content-Type',
                    PatchStrategy.StrategicMergePatch
                )
            )
        } catch (err) {
            const reason = sanitizeReason(err)
            await this.audit(
                callerUserId,
                auditAction.AGENT_RUNTIME_CONTROL_UI_TOGGLE_FAILED,
                runtime.id,
                {
                    enabled,
                    reason,
                    runtimeId: runtime.id,
                    primaryAgentId,
                    ownerUserId: runtime.userId,
                    onBehalfOf: callerUserId !== runtime.userId
                }
            )
            throw new InternalServerErrorException({
                message: 'failed to toggle openclaw control UI',
                reason
            })
        }

        await this.runtimes.applyStatusPatch(runtime.id, {
            controlUiEnabled: enabled
        })
        await this.audit(
            callerUserId,
            auditAction.AGENT_RUNTIME_CONTROL_UI_TOGGLED,
            runtime.id,
            {
                enabled,
                runtimeId: runtime.id,
                primaryAgentId,
                ownerUserId: runtime.userId,
                onBehalfOf: callerUserId !== runtime.userId
            }
        )
        const refreshed = await this.runtimes.findById(runtime.id)
        if (!refreshed)
            throw new InternalServerErrorException(
                `runtime ${runtime.id} vanished during control UI toggle`
            )
        return this.runtimes.toSummary(refreshed)
    }

    private async loadRuntime(
        runtimeId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<AgentRuntimeRow> {
        const row = await this.runtimes.findById(runtimeId)
        if (!row || (!isAdmin && row.userId !== callerUserId))
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        return row
    }

    private requireK8s(runtime: AgentRuntimeRow): void {
        if (runtime.kind !== 'k8s' || !runtime.namespace)
            throw new InternalServerErrorException(
                `runtime ${runtime.id} is not a k8s runtime with a namespace`
            )
    }

    private requirePrimaryAgentId(runtime: AgentRuntimeRow): string {
        if (!runtime.primaryAgentId)
            throw new InternalServerErrorException(
                `runtime ${runtime.id} has no primaryAgentId; cannot compute k8s resource name`
            )
        return runtime.primaryAgentId
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
                `audit write failed: ${(err as Error).message} action=${action}`
            )
        }
    }
}

const sanitizeReason = (err: unknown): string => {
    const msg = (err as Error)?.message ?? 'unknown error'
    return msg.slice(0, 512).replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
}
