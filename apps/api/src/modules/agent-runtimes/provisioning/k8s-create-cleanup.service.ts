import { ApiException } from '@kubernetes/client-node'
import {
    ConflictException,
    Inject,
    Injectable,
    ServiceUnavailableException
} from '@nestjs/common'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    hostDaemons,
    serviceLeases,
    runtimeHosts,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow,
    type RuntimeProvider
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { redactCredentialText } from '@/common/telemetry/redact-credentials'
import { HostsService } from '@/modules/hosts/hosts.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'
import {
    K8S_CREATE_CLEANUP_PENDING,
    K8S_CREATE_INITIAL_AGENT,
    k8sCreateInProgress,
    k8sCreateLeaseName,
    lockK8sCreateLease
} from './k8s-create-ownership'
export {
    K8S_CREATE_CLEANUP_PENDING,
    K8S_CREATE_INITIAL_AGENT
} from './k8s-create-ownership'

export const describeK8sCreateError = (error: unknown): string => {
    if (error instanceof ApiException)
        return `ApiException: Kubernetes API HTTP ${error.code}`
    if (error instanceof Error)
        return redactCredentialText(`${error.name}: ${error.message}`).slice(
            0,
            512
        )
    return 'Unknown error'
}

const recovery = (runtimeId: string) => ({
    runtimeId,
    recoveryUrl: `/settings/runtimes/${runtimeId}`
})

export class K8sCreateCleanupPendingError extends ServiceUnavailableException {
    constructor(runtimeId: string, original: string, cleanup: string) {
        super({
            code: 'RUNTIME_CREATE_CLEANUP_PENDING',
            message: `Agent creation failed and container cleanup is incomplete. Open Settings > Runtimes (${runtimeId}) and retry Delete before creating another container on this cluster.`,
            ...recovery(runtimeId),
            creationError: original,
            cleanupError: cleanup
        })
    }
}

// The cleanup of a fresh self-serve container create that failed (ADR-0035):
// the runtime it was for reads `failed` + `create_cleanup_pending` until the
// host it made is confirmed gone, and a retry runs the same cleanup again.
@Injectable()
export class K8sCreateCleanupService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: HostsService,
        private readonly clients: HostProviderClients,
        private readonly providers: SandboxProviderRegistry
    ) {}

    async assertProviderAvailable(
        userId: string,
        providerId: string
    ): Promise<void> {
        const [pending] = await this.db
            .select({ id: agentRuntimes.id })
            .from(agentRuntimes)
            .innerJoin(runtimeHosts, eq(runtimeHosts.id, agentRuntimes.hostId))
            .where(
                and(
                    eq(agentRuntimes.userId, userId),
                    eq(runtimeHosts.providerId, providerId),
                    eq(agentRuntimes.currentPhase, K8S_CREATE_CLEANUP_PENDING)
                )
            )
            .limit(1)
        if (pending)
            throw new ConflictException({
                code: 'RUNTIME_CREATE_CLEANUP_PENDING',
                message: `A failed container on this cluster still needs cleanup. Open Settings > Runtimes (${pending.id}) and retry Delete.`,
                ...recovery(pending.id)
            })
    }

    async rollback(args: {
        runtimeId: string
        userId: string
        agentId: string
        error: unknown
        host: RuntimeHostRow
        provider: RuntimeProvider
        requestsSettled?: boolean
    }): Promise<void> {
        const failureReason = describeK8sCreateError(args.error)
        try {
            // Commit this marker before external cleanup; a lost process still
            // leaves a visible, owned runtime that explicit DELETE can retry.
            const runtime = await this.db.transaction(async (tx) => {
                await tx.execute(
                    sql`select set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true)`
                )
                await tx
                    .select({ id: agentRuntimes.id })
                    .from(agentRuntimes)
                    .where(eq(agentRuntimes.id, args.runtimeId))
                    .for('update')
                const lease = await lockK8sCreateLease(tx, args.runtimeId)
                if (lease && lease.holderId !== args.agentId)
                    throw new Error('fresh container creation ownership lost')
                if (args.requestsSettled && lease?.holderId === args.agentId)
                    await tx
                        .delete(serviceLeases)
                        .where(
                            eq(
                                serviceLeases.name,
                                k8sCreateLeaseName(args.runtimeId)
                            )
                        )
                const [row] = await tx
                    .update(agentRuntimes)
                    .set({
                        status: 'failed',
                        currentPhase: K8S_CREATE_CLEANUP_PENDING,
                        failureReason,
                        updatedAt: new Date()
                    })
                    .where(
                        and(
                            eq(agentRuntimes.id, args.runtimeId),
                            eq(agentRuntimes.userId, args.userId),
                            eq(agentRuntimes.hostId, args.host.id),
                            eq(
                                agentRuntimes.currentPhase,
                                K8S_CREATE_INITIAL_AGENT
                            ),
                            eq(agentRuntimes.status, 'installing')
                        )
                    )
                    .returning()
                return row
            })
            if (!runtime)
                throw new Error(
                    'fresh runtime ownership changed; automatic cleanup refused'
                )
            await this.cleanup(runtime, args.agentId, args.host, args.provider)
        } catch (cleanupError) {
            // This runs after the cleanup transaction has released its lock.
            await this.db
                .update(agentRuntimes)
                .set({
                    failureReason: `${failureReason}; cleanup: ${describeK8sCreateError(cleanupError)}`,
                    updatedAt: new Date()
                })
                .where(
                    and(
                        eq(agentRuntimes.id, args.runtimeId),
                        eq(agentRuntimes.userId, args.userId),
                        eq(
                            agentRuntimes.currentPhase,
                            K8S_CREATE_CLEANUP_PENDING
                        )
                    )
                )
                .catch(() => undefined)
            throw new K8sCreateCleanupPendingError(
                args.runtimeId,
                failureReason,
                describeK8sCreateError(cleanupError)
            )
        }
    }

    async retry(runtime: AgentRuntimeRow): Promise<void> {
        const host = runtime.hostId
            ? await this.hosts.findById(runtime.hostId)
            : null
        if (
            !host ||
            host.providerRef?.kind !== 'k8s' ||
            (runtime.currentPhase !== K8S_CREATE_CLEANUP_PENDING &&
                runtime.currentPhase !== K8S_CREATE_INITIAL_AGENT)
        )
            throw new ConflictException(
                'runtime is not awaiting create cleanup'
            )
        try {
            if (runtime.currentPhase === K8S_CREATE_INITIAL_AGENT) {
                runtime = await this.db.transaction(async (tx) => {
                    await tx.execute(
                        sql`select set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true)`
                    )
                    const [current] = await tx
                        .select()
                        .from(agentRuntimes)
                        .where(eq(agentRuntimes.id, runtime.id))
                        .for('update')
                    if (
                        !current ||
                        current.currentPhase !== K8S_CREATE_INITIAL_AGENT
                    )
                        throw new ConflictException(
                            'runtime creation state changed; retry Delete'
                        )
                    const lease = await lockK8sCreateLease(tx, runtime.id)
                    if (lease?.active) throw k8sCreateInProgress()
                    const [failed] = await tx
                        .update(agentRuntimes)
                        .set({
                            status: 'failed',
                            currentPhase: K8S_CREATE_CLEANUP_PENDING,
                            failureReason:
                                'Container creation owner exited or expired; explicit cleanup requested',
                            updatedAt: new Date()
                        })
                        .where(eq(agentRuntimes.id, runtime.id))
                        .returning()
                    return failed
                })
            }
            const provider = await this.clients.providerForHost(host)
            await this.cleanup(runtime, undefined, host, provider)
        } catch (error) {
            if (error instanceof ConflictException) throw error
            throw new K8sCreateCleanupPendingError(
                runtime.id,
                redactCredentialText(
                    runtime.failureReason ?? 'Agent creation failed'
                ).slice(0, 1024),
                describeK8sCreateError(error)
            )
        }
    }

    private async cleanup(
        runtime: AgentRuntimeRow,
        ownedAgentId: string | undefined,
        host: RuntimeHostRow,
        provider: RuntimeProvider
    ): Promise<void> {
        const adapter = this.providers.for(provider.kind)
        // Under a fresh generation: a bring-up still running for this host
        // finds its calls refused rather than racing the destroy.
        const generation = await this.hosts.bumpGeneration(host.id)
        await this.db.transaction(async (tx) => {
            const signal = AbortSignal.timeout(30_000)
            await tx.execute(
                sql`select set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true), set_config('idle_in_transaction_session_timeout', '35000', true)`
            )
            const [current] = await tx
                .select()
                .from(agentRuntimes)
                .where(
                    and(
                        eq(agentRuntimes.id, runtime.id),
                        eq(agentRuntimes.userId, runtime.userId)
                    )
                )
                .for('update')
            if (!current) return
            if (
                current.currentPhase !== K8S_CREATE_CLEANUP_PENDING ||
                current.status !== 'failed' ||
                current.hostId !== host.id
            )
                throw new ConflictException('runtime cleanup ownership changed')
            // The pod host this create made for the runtime (ADR-0035). Locked
            // first: a framework added to it meanwhile has to either commit
            // before this cleanup (and be seen as a sibling below) or fail on
            // the host it referenced.
            const [lockedHost] = await tx
                .select()
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, host.id))
                .for('update')
            if (!lockedHost) return
            signal.throwIfAborted()
            const lease = await lockK8sCreateLease(tx, runtime.id)
            if (lease?.active) throw k8sCreateInProgress()
            await tx
                .delete(serviceLeases)
                .where(eq(serviceLeases.name, k8sCreateLeaseName(runtime.id)))
            signal.throwIfAborted()
            const attached = await tx
                .select({ id: agents.id, runtimeId: agents.runtimeId })
                .from(agents)
                .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
                .where(eq(agentRuntimes.hostId, host.id))
            if (
                ownedAgentId &&
                attached.some(
                    (agent) =>
                        agent.id !== ownedAgentId ||
                        agent.runtimeId !== current.id
                )
            )
                throw new ConflictException(
                    'another agent attached; automatic container cleanup refused'
                )
            // Another framework added to the fresh host in the meantime keeps
            // the host: only this runtime goes.
            const siblings = await tx
                .select({ id: agentRuntimes.id })
                .from(agentRuntimes)
                .where(
                    and(
                        eq(agentRuntimes.hostId, host.id),
                        ne(agentRuntimes.id, current.id)
                    )
                )
                .for('update')
            if (siblings.length > 0) {
                await tx
                    .delete(agentRuntimes)
                    .where(eq(agentRuntimes.id, current.id))
                return
            }
            await this.hosts.patch(host.id, { status: 'deleting' }, tx)
            await adapter.destroy({
                host: lockedHost,
                provider,
                generation,
                fence: { assertActive: async () => {}, signal }
            })
            signal.throwIfAborted()
            // Same transaction: a second DB connection would wait on the FK
            // locks held here and could leave the host untracked on failure.
            // The host's bound tokens cascade with it.
            await tx
                .delete(agentRuntimes)
                .where(
                    inArray(agentRuntimes.id, [
                        current.id,
                        ...siblings.map((s) => s.id)
                    ])
                )
            await tx.delete(hostDaemons).where(eq(hostDaemons.hostId, host.id))
            await tx
                .delete(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.id, host.id),
                        eq(runtimeHosts.kind, 'hosted')
                    )
                )
            signal.throwIfAborted()
        })
    }
}
